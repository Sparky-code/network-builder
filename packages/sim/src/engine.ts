import type {
  ClassMetrics, Demand, LatencyWaterfall, MetricsFrame, NodeId, Region, RegionId,
  RunResult, TrafficClass,
} from '@nb/schema';
import {
  buildGraph, edgeCost, enumerateRoutes, firstTierCaches,
  type Route, type SimGraph,
} from './graph';
import { buildKernel, type LatencyKernel } from './kernel';
import { departureCv2, mergeCv2 } from './math/erlang';
import { sampleRoute } from './probes';
import { pool, pooledQuantile, pooledTailFraction, type WeightedPopulation } from './pooled';
import { cacheHitRatio, relaxWarmth } from './cache';
import { applyControllers, capacityRps, serveTick, type SimEdge, type Station } from './station';
import { rateAt } from './rate';
import { computeCost, DEFAULT_COST_RATES, type CostRates } from './cost';
import { hashString } from './rng';
import { ENGINE_VERSION } from './version';

export interface Scenario {
  readonly durationSec: number;
  /** Discarded from grading, so cache warm-up and queue fill do not count against the player. */
  readonly warmupSec: number;
  readonly tickHz: number;
  readonly seed: number;
  readonly classes: readonly TrafficClass[];
  readonly demands: readonly Demand[];
  readonly regions: readonly Region[];
  /**
   * Cold DNS lookup, charged once at route start. A constant in Phase 1;
   * Act IV replaces it with real resolver behaviour and TTL staleness.
   */
  readonly dnsLookupMs?: number;
  readonly costRates?: CostRates;
}

export interface SimInput {
  readonly stations: readonly Station[];
  readonly edges: readonly SimEdge[];
  readonly scenario: Scenario;
}

interface NodeAccum {
  utilizationSum: number;
  utilizationTicks: number;
  backlogPeak: number;
  offeredReqs: number;
  droppedReqs: number;
  rejectedReqs: number;
  completedReqs: number;
}

const DEFAULT_DNS_MS = 20;

export function simulate(input: SimInput): RunResult {
  const { scenario } = input;
  const dt = 1 / scenario.tickHz;
  const totalTicks = Math.max(1, Math.round(scenario.durationSec * scenario.tickHz));
  const warmupTicks = Math.round(scenario.warmupSec * scenario.tickHz);
  // Sample routes twice per simulated second; percentiles do not need per-tick resolution.
  const sampleEvery = Math.max(1, Math.round(scenario.tickHz / 2));

  // Stations are mutated across ticks, so work on copies and leave the caller's
  // input untouched. This is what lets the same topology be re-run safely.
  const stations = input.stations.map((s) => ({ ...s }));
  const graph = buildGraph(stations, input.edges);
  const routes = enumerateRoutes(graph);
  const regions = new Map<RegionId, Region>(scenario.regions.map((r) => [r.id, r]));
  const dnsMs = scenario.dnsLookupMs ?? DEFAULT_DNS_MS;

  const classes = scenario.classes;
  const nClasses = classes.length;
  const classIdx = new Map(classes.map((c, i) => [c.id, i]));

  const isEntry = new Set<NodeId>(graph.entries);
  // Which caches a request meets first. Everything behind them is a mid tier.
  const isFirstTierCache = firstTierCaches(graph);

  const nodeAccum = new Map<NodeId, NodeAccum>();
  for (const id of graph.order) {
    nodeAccum.set(id, {
      utilizationSum: 0, utilizationTicks: 0, backlogPeak: 0,
      offeredReqs: 0, droppedReqs: 0, rejectedReqs: 0, completedReqs: 0,
    });
  }

  // Latency populations, accumulated post-warmup and pooled at the end.
  const popsByClass = new Map<number, WeightedPopulation[]>();
  const popsByRegion = new Map<RegionId, WeightedPopulation[]>();
  let heaviestWeight = -1;
  let heaviestWaterfall: LatencyWaterfall = {
    dnsMs: 0, setupMs: 0, propagationMs: 0, queueMs: 0, serviceMs: 0, transferMs: 0,
  };

  const frames: MetricsFrame[] = [];
  // Carried between sampling points so every tick emits a frame without
  // recomputing percentiles it does not have new data for.
  let lastP50 = 0;
  let lastP95 = 0;
  let lastP99 = 0;
  let edgeEgressBytes = 0;
  let originEgressBytes = 0;
  let totalRequests = 0;
  let gradedSeconds = 0;
  let runOffered = 0;
  let runCompleted = 0;
  let runLost = 0;
  let hitAcc = 0;
  let edgeHitAcc = 0;
  let edgeArrivalAcc = 0;

  for (let tick = 0; tick < totalTicks; tick++) {
    const tSec = tick * dt;
    const graded = tick >= warmupTicks;

    // --- offered demand, per class, per entry region -----------------------
    const arrivals = new Map<NodeId, Float64Array>();
    const inboundStreams = new Map<NodeId, { rate: number; cv2: number }[]>();
    for (const id of graph.order) {
      arrivals.set(id, new Float64Array(nClasses));
      inboundStreams.set(id, []);
    }

    const classRate = new Float64Array(nClasses);
    for (const demand of scenario.demands) {
      const ci = classIdx.get(demand.classId);
      if (ci === undefined) continue;
      const rate = rateAt(demand.profile, tSec, scenario.durationSec);
      const totalWeight = demand.originRegions.reduce((a, r) => a + r.weight, 0) || 1;
      for (const origin of demand.originRegions) {
        const regionRate = (rate * origin.weight) / totalWeight;
        const entriesHere = graph.entries.filter(
          (id) => graph.stations.get(id)?.regionId === origin.regionId,
        );
        if (entriesHere.length === 0) continue;
        const per = regionRate / entriesHere.length;
        for (const id of entriesHere) {
          const v = arrivals.get(id);
          if (v !== undefined) v[ci] = (v[ci] ?? 0) + per;
        }
        classRate[ci] = (classRate[ci] ?? 0) + regionRate;
      }
    }

    for (const id of graph.entries) {
      // Organic arrivals are Poisson: Ca2 = 1.
      const v = arrivals.get(id);
      let total = 0;
      for (let c = 0; c < nClasses; c++) total += v?.[c] ?? 0;
      inboundStreams.get(id)?.push({ rate: total, cv2: 1 });
    }

    // --- propagate flow in topological order ------------------------------
    const kernels = new Map<NodeId, LatencyKernel>();
    let tickOffered = 0;
    let tickCompleted = 0;
    let tickDropped = 0;
    let tickRejected = 0;

    for (const id of graph.order) {
      const station = graph.stations.get(id);
      const arrival = arrivals.get(id);
      if (station === undefined || arrival === undefined) continue;

      let arrivalTotal = 0;
      for (let c = 0; c < nClasses; c++) arrivalTotal += arrival[c] ?? 0;

      const ca2 = mergeCv2(inboundStreams.get(id) ?? [{ rate: arrivalTotal, cv2: 1 }]);
      const served = serveTick(station, arrivalTotal, dt);

      const accum = nodeAccum.get(id);
      if (accum !== undefined && graded) {
        const cap = capacityRps(station);
        accum.utilizationSum += cap > 0 ? arrivalTotal / cap : 0;
        accum.utilizationTicks += 1;
        accum.backlogPeak = Math.max(accum.backlogPeak, served.newBacklogReqs);
        accum.offeredReqs += arrivalTotal * dt;
        accum.droppedReqs += served.droppedReqs;
        accum.rejectedReqs += served.rejectedReqs;
        accum.completedReqs += served.completedReqs;
      }

      // Kernel reflects the queue as it stands entering this tick.
      kernels.set(
        id,
        buildKernel({
          servers: station.servers,
          serviceMeanMs: station.serviceMeanMs,
          serviceCv2: station.serviceCv2,
          arrivalRps: arrivalTotal,
          arrivalCv2: ca2,
          backlogReqs: station.backlogReqs,
        }),
      );

      station.backlogReqs = served.newBacklogReqs;

      // Controllers run at the end of a station's tick, so any capacity change
      // takes effect from the NEXT tick. That ordering is what makes autoscaler
      // lag real rather than an artefact of where the call sits.
      if (station.controllers.length > 0) {
        const cap = capacityRps(station);
        const util = Number.isFinite(cap) && cap > 0 ? arrivalTotal / cap : 0;
        const next = applyControllers(station, {
          utilization: util, simTimeSec: tSec, dtSeconds: dt,
        });
        station.servers = next.servers;
        station.utilizationEwma = next.utilizationEwma;
        station.observedSec = next.observedSec;
        station.pendingServers = next.pendingServers;
        station.pendingReadyAtSec = next.pendingReadyAtSec;
        station.lastScaleAtSec = next.lastScaleAtSec;
      }

      if (graded) {
        // Offered is counted at entries and completed at terminals, so a
        // multi-hop route is not counted once per hop. Losses are genuinely
        // per-station and do sum.
        if (isEntry.has(id)) tickOffered += arrivalTotal * dt;
        if (station.routing.kind === 'terminal') tickCompleted += served.completedReqs;
        tickDropped += served.droppedReqs;
        tickRejected += served.rejectedReqs;
      }

      // --- route completions downstream ----------------------------------
      const completedRps = dt > 0 ? served.completedReqs / dt : 0;
      const scale = arrivalTotal > 0 ? completedRps / arrivalTotal : 0;
      const forwarded = new Float64Array(nClasses);

      const routing = station.routing;
      if (routing.kind === 'cache-split') {
        station.warmth = relaxWarmth(station.warmth, routing.ttlSeconds, dt);
        for (let c = 0; c < nClasses; c++) {
          const cls = classes[c];
          const rate = (arrival[c] ?? 0) * scale;
          if (cls === undefined || rate <= 0) continue;
          if (!cls.cacheable || cls.objectPopulation === undefined) {
            forwarded[c] = rate;
            continue;
          }
          const r = cacheHitRatio({
            arrivalRps: rate,
            ttlSeconds: routing.ttlSeconds,
            objectCount: cls.objectPopulation.count,
            zipfAlpha: cls.objectPopulation.zipfAlpha,
            warmth: station.warmth,
            ...(routing.keyCardinalityFactor !== undefined
              ? { keyCardinalityFactor: routing.keyCardinalityFactor }
              : {}),
          });
          forwarded[c] = r.missRps;
          if (graded) {
            // Every tier's hits count toward offload; only the first tier's
            // count toward the latency number, and only the first tier sees the
            // whole request population.
            hitAcc += r.hitRps * dt;
            if (isFirstTierCache.has(id)) {
              edgeHitAcc += r.hitRps * dt;
              edgeArrivalAcc += rate * dt;
            }
            edgeEgressBytes += r.hitRps * dt * cls.responseBytes;
          }
        }
      } else if (routing.kind === 'terminal') {
        for (let c = 0; c < nClasses; c++) {
          const cls = classes[c];
          if (cls === undefined) continue;
          if (graded) originEgressBytes += (arrival[c] ?? 0) * scale * dt * cls.responseBytes;
        }
      } else {
        for (let c = 0; c < nClasses; c++) forwarded[c] = (arrival[c] ?? 0) * scale;
      }

      const out = graph.outbound.get(id) ?? [];
      if (out.length > 0 && routing.kind !== 'terminal') {
        const totalWeight = out.reduce((a, e) => a + e.weight, 0) || 1;
        const rho = capacityRps(station) > 0 ? arrivalTotal / capacityRps(station) : 0;
        const cd2 = departureCv2(rho, station.servers, ca2, station.serviceCv2);
        for (const e of out) {
          const share = routing.kind === 'fanout' ? 1 : e.weight / totalWeight;
          const target = arrivals.get(e.to);
          let fwdTotal = 0;
          for (let c = 0; c < nClasses; c++) {
            const amount = (forwarded[c] ?? 0) * share;
            if (target !== undefined) target[c] = (target[c] ?? 0) + amount;
            fwdTotal += amount;
          }
          if (fwdTotal > 0) inboundStreams.get(e.to)?.push({ rate: fwdTotal, cv2: cd2 });
        }
      }
    }

    if (graded) {
      gradedSeconds += dt;
      runOffered += tickOffered;
      runCompleted += tickCompleted;
      runLost += tickDropped + tickRejected;
      for (let c = 0; c < nClasses; c++) totalRequests += (classRate[c] ?? 0) * dt;
    }

    // --- sample routes ----------------------------------------------------
    if (graded && tick % sampleEvery === 0) {
      const thisPoint: WeightedPopulation[] = [];
      for (const route of routes) {
        for (let c = 0; c < nClasses; c++) {
          const cls = classes[c];
          const rate = classRate[c] ?? 0;
          if (cls === undefined || rate <= 0) continue;

          const hopKernels = routeKernels(route, graph, kernels, regions, cls.responseBytes, dnsMs);
          if (hopKernels.length === 0) continue;

          const sample = sampleRoute(hopKernels);
          const weight = route.share * rate;
          const wp: WeightedPopulation = { values: sample.latencyMs, weight };

          thisPoint.push(wp);

          const byClass = popsByClass.get(c) ?? [];
          byClass.push(wp);
          popsByClass.set(c, byClass);

          const entryStation = graph.stations.get(route.entry);
          if (entryStation !== undefined) {
            const byRegion = popsByRegion.get(entryStation.regionId) ?? [];
            byRegion.push(wp);
            popsByRegion.set(entryStation.regionId, byRegion);
          }

          if (weight > heaviestWeight) {
            heaviestWeight = weight;
            heaviestWaterfall = sample.waterfallAt(0.99);
          }
        }
      }

      // Pool only this sampling point. Pooling the whole accumulated history
      // on every tick makes a run quadratic in its own length, which is how
      // a "sub-30ms" engine turned into 60 seconds.
      const p = pool(thisPoint);
      lastP50 = pooledQuantile(p, 0.5);
      lastP95 = pooledQuantile(p, 0.95);
      lastP99 = pooledQuantile(p, 0.99);
    }

    if (graded) {
      frames.push({
        tick,
        simTimeSec: tSec,
        offeredRps: dt > 0 ? tickOffered / dt : 0,
        completedRps: dt > 0 ? tickCompleted / dt : 0,
        erroredRps: dt > 0 ? tickRejected / dt : 0,
        droppedRps: dt > 0 ? tickDropped / dt : 0,
        p50Ms: lastP50,
        p95Ms: lastP95,
        p99Ms: lastP99,
        cacheHitRatioEdge: edgeArrivalAcc > 0 ? edgeHitAcc / edgeArrivalAcc : 0,
        cacheHitRatioTotal: edgeArrivalAcc > 0 ? hitAcc / edgeArrivalAcc : 0,
      });
    }
  }

  // --- aggregate ----------------------------------------------------------
  const perClass: Record<string, ClassMetrics> = {};
  for (let c = 0; c < nClasses; c++) {
    const cls = classes[c];
    if (cls === undefined) continue;
    perClass[cls.id] = metricsFor(popsByClass.get(c) ?? [], cls, {
      offeredReqs: runOffered, lostReqs: runLost, gradedSeconds,
    });
  }

  const perRegion: Record<string, ClassMetrics> = {};
  for (const regionKey of [...popsByRegion.keys()].sort()) {
    const first = classes[0];
    if (first === undefined) continue;
    perRegion[regionKey] = metricsFor(popsByRegion.get(regionKey) ?? [], first, {
      offeredReqs: runOffered, lostReqs: runLost, gradedSeconds,
    });
  }

  const perNode: Record<string, { utilization: number; backlogPeak: number; dropRatePct: number }> = {};
  for (const id of graph.order) {
    const a = nodeAccum.get(id);
    if (a === undefined) continue;
    perNode[id] = {
      utilization: a.utilizationTicks > 0 ? a.utilizationSum / a.utilizationTicks : 0,
      backlogPeak: a.backlogPeak,
      dropRatePct: a.offeredReqs > 0 ? (a.droppedReqs / a.offeredReqs) * 100 : 0,
    };
  }

  const cost = computeCost(
    graph.stations,
    {
      edgeEgressBytes, originEgressBytes, totalRequests,
      cacheStorageBytes: 0, simulatedSeconds: gradedSeconds,
    },
    scenario.costRates ?? DEFAULT_COST_RATES,
  );

  return {
    engineVersion: ENGINE_VERSION,
    inputHash: hashInput(input),
    perClass,
    perRegion,
    perNode,
    cacheHitRatioEdge: edgeArrivalAcc > 0 ? edgeHitAcc / edgeArrivalAcc : 0,
    cacheHitRatioTotal: edgeArrivalAcc > 0 ? hitAcc / edgeArrivalAcc : 0,
    attribution: heaviestWaterfall,
    frames,
    cost,
  };
}

function routeKernels(
  route: Route,
  graph: SimGraph,
  kernels: ReadonlyMap<NodeId, LatencyKernel>,
  regions: ReadonlyMap<RegionId, Region>,
  responseBytes: number,
  dnsMs: number,
): readonly LatencyKernel[] {
  const out: LatencyKernel[] = [];
  for (let h = 0; h < route.hops.length; h++) {
    const id = route.hops[h];
    if (id === undefined) continue;
    const base = kernels.get(id);
    if (base === undefined) continue;

    // Hop 0 is the client: it pays DNS, and has no inbound edge.
    if (h === 0) {
      out.push({ ...base, fixedMs: dnsMs, fixed: { ...base.fixed, dnsMs } });
      continue;
    }

    const edge = route.edges[h - 1];
    if (edge === undefined) {
      out.push(base);
      continue;
    }
    const c = edgeCost(edge, graph, regions, responseBytes);
    const fixedMs = c.propagationMs + c.setupMs + c.transferMs;
    out.push({
      ...base,
      fixedMs,
      fixed: {
        dnsMs: 0,
        setupMs: c.setupMs,
        propagationMs: c.propagationMs,
        transferMs: c.transferMs,
      },
    });
  }
  return out;
}

function metricsFor(
  pops: readonly WeightedPopulation[],
  cls: TrafficClass,
  totals: { offeredReqs: number; lostReqs: number; gradedSeconds: number },
): ClassMetrics {
  const p = pool(pops);
  const { offeredReqs: offered, lostReqs, gradedSeconds } = totals;
  const timeoutRate = pooledTailFraction(p, cls.clientTimeoutMs);
  const failed = offered > 0 ? Math.min(1, lostReqs / offered) : 0;

  return {
    p50Ms: round4(pooledQuantile(p, 0.5)),
    p95Ms: round4(pooledQuantile(p, 0.95)),
    p99Ms: round4(pooledQuantile(p, 0.99)),
    throughputRps: round4(gradedSeconds > 0 ? offered / gradedSeconds : 0),
    // Timeouts are errors the client sees; drops and rejections are errors the
    // system admits to. Both count, and the game reports them separately too.
    errorRatePct: round4(Math.min(100, (failed + timeoutRate) * 100)),
    timeoutRatePct: round4(timeoutRate * 100),
  };
}

/**
 * Round graded metrics to 4 significant figures before any threshold
 * comparison. IEEE-754 guarantees +,-,*,/ and sqrt are bit-identical across JS
 * engines, but Math.log/exp/pow are not specified to be, and the latency
 * kernels use both.
 */
export function round4(n: number): number {
  if (!Number.isFinite(n) || n === 0) return n;
  const mag = Math.ceil(Math.log10(Math.abs(n)));
  const f = 10 ** (4 - mag);
  return Math.round(n * f) / f;
}

function hashInput(input: SimInput): string {
  const shape = JSON.stringify({
    stations: input.stations
      .map((s) => [s.id, s.regionId, s.servers, s.serviceMeanMs, s.serviceCv2, s.routing])
      .sort(),
    edges: input.edges
      .map((e) => [e.id, e.from, e.to, e.weight, e.protocol.id])
      .sort(),
    seed: input.scenario.seed,
    duration: input.scenario.durationSec,
    tickHz: input.scenario.tickHz,
    demands: input.scenario.demands,
    version: ENGINE_VERSION,
  });
  return hashString(shape);
}
