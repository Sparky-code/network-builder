import type { EdgeId, NodeId, ProtocolProfile, RegionId } from '@nb/schema';

/**
 * Everything the player can place is a Station.
 *
 * `@nb/sim` deliberately knows nothing about CDNs, pods or WAFs. Those live in
 * `@nb/catalog`, which maps game concepts onto these primitives. That boundary
 * is what keeps Acts V and VI additive rather than a second engine.
 */

/** Admission: how offered flow is reduced before it is served. */
export type AdmissionSpec =
  | { readonly kind: 'none' }
  /** Token bucket, keyed per identity. Level 35. */
  | { readonly kind: 'rate-limit'; readonly capacityRps: number; readonly burst: number }
  /** Shed load beyond a utilization target rather than queueing it. */
  | { readonly kind: 'shed-above'; readonly utilizationTarget: number }
  /** Inspect and drop a fraction of each class. Level 34. */
  | { readonly kind: 'filter'; readonly dropFractionByClass: readonly number[] };

/** Routing: how admitted flow is divided across outgoing edges. */
export type RoutingSpec =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'weighted' }
  /** Hit fraction terminates here; the miss stream goes upstream. Acts III-IV. */
  | { readonly kind: 'cache-split'; readonly ttlSeconds: number;
      readonly keyCardinalityFactor?: number; readonly collapsing: boolean }
  /** Wait on all downstream edges. Produces tail-at-scale amplification. */
  | { readonly kind: 'fanout' };

/**
 * Controllers mutate station state between ticks.
 *
 * This is the seam that decides whether Acts V and VI are content or a second
 * engine. An HPA is not a new kind of simulation - it is a function that adjusts
 * `servers` with deliberate lag, which is exactly what commitment #1 reserved
 * space for.
 */
export type ControllerSpec = {
  readonly kind: 'hpa';
  readonly minServers: number;
  readonly maxServers: number;
  readonly targetUtilization: number;
  /** Averaging window for the observed metric. Half of the response lag. */
  readonly metricWindowSec: number;
  /** Time for a new replica to become ready. The other half. */
  readonly podStartSec: number;
  /** Minimum interval between scaling decisions. What stops flapping. */
  readonly cooldownSec: number;
};

export interface Station {
  readonly id: NodeId;
  readonly regionId: RegionId;

  /** Concurrent service slots. Mutable state, not config - commitment #1. */
  servers: number;
  readonly serviceMeanMs: number;
  /** Squared coefficient of variation of service time. The variance lever. */
  readonly serviceCv2: number;
  /** Requests beyond this are shed rather than queued. */
  readonly queueLimit: number;
  /** CPU charged per handshake this station terminates. */
  readonly cryptoCpuMs: number;

  readonly admission: readonly AdmissionSpec[];
  readonly routing: RoutingSpec;
  readonly controllers: readonly ControllerSpec[];

  // --- per-tick state, double-buffered by the engine ---
  backlogReqs: number;
  health: 'healthy' | 'degraded' | 'down';
  warmth: number;

  // --- controller state ---
  /** Smoothed utilization. A controller reacts to this, never to one tick. */
  utilizationEwma: number;
  /** Seconds of metric observed. A controller may not act before it has data. */
  observedSec: number;
  /** Replica count decided but not yet in service. */
  pendingServers: number;
  pendingReadyAtSec: number;
  lastScaleAtSec: number;
}

export interface SimEdge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly weight: number;
  readonly protocol: ProtocolProfile;
  readonly bandwidthMbps: number;
}

export function makeStation(init: {
  id: NodeId;
  regionId: RegionId;
  servers: number;
  serviceMeanMs: number;
  serviceCv2?: number;
  queueLimit?: number;
  cryptoCpuMs?: number;
  admission?: readonly AdmissionSpec[];
  routing?: RoutingSpec;
  controllers?: readonly ControllerSpec[];
}): Station {
  return {
    id: init.id,
    regionId: init.regionId,
    servers: init.servers,
    serviceMeanMs: init.serviceMeanMs,
    serviceCv2: init.serviceCv2 ?? 0.5,
    queueLimit: init.queueLimit ?? Number.POSITIVE_INFINITY,
    cryptoCpuMs: init.cryptoCpuMs ?? 0,
    admission: init.admission ?? [{ kind: 'none' }],
    routing: init.routing ?? { kind: 'terminal' },
    controllers: init.controllers ?? [],
    backlogReqs: 0,
    health: 'healthy',
    warmth: 1,
    utilizationEwma: 0,
    observedSec: 0,
    pendingServers: 0,
    pendingReadyAtSec: 0,
    lastScaleAtSec: Number.NEGATIVE_INFINITY,
  };
}

export interface ControllerContext {
  /** This tick's observed utilization at the station. */
  readonly utilization: number;
  readonly simTimeSec: number;
  readonly dtSeconds: number;
}

export interface ControllerResult {
  readonly servers: number;
  readonly utilizationEwma: number;
  readonly observedSec: number;
  readonly pendingServers: number;
  readonly pendingReadyAtSec: number;
  readonly lastScaleAtSec: number;
}

/**
 * Advance a station's controllers by one tick.
 *
 * Pure: reads the station and context, returns the new values. The engine
 * assigns them, so nothing here reads its own writes.
 *
 * The lesson this encodes is that autoscaling is not free. Response lag is
 * `metricWindowSec + podStartSec` and the player feels it as a window of
 * errors during a spike - which is why headroom, not a faster HPA, is usually
 * the right answer.
 */
export function applyControllers(s: Station, ctx: ControllerContext): ControllerResult {
  let servers = s.servers;
  let utilizationEwma = s.utilizationEwma;
  let observedSec = s.observedSec;
  let pendingServers = s.pendingServers;
  let pendingReadyAtSec = s.pendingReadyAtSec;
  let lastScaleAtSec = s.lastScaleAtSec;

  for (const c of s.controllers) {
    if (c.kind !== 'hpa') continue;

    const observed = Number.isFinite(ctx.utilization) ? ctx.utilization : 0;

    if (observedSec <= 0) {
      // Seed from the first observation rather than blending up from zero.
      // Starting at zero means the controller's first act is to conclude there
      // is no load and scale straight to the floor - which it did, shedding
      // capacity on tick one before it had measured anything.
      utilizationEwma = observed;
    } else {
      // Exponential moving average over the metric window. A controller that
      // reacted to a single tick would oscillate violently.
      const alpha = ctx.dtSeconds / Math.max(ctx.dtSeconds, c.metricWindowSec);
      utilizationEwma += alpha * (observed - utilizationEwma);
    }
    observedSec += ctx.dtSeconds;

    // A scheduled change becomes real only once the replicas are ready.
    if (pendingServers > 0 && ctx.simTimeSec >= pendingReadyAtSec) {
      servers = pendingServers;
      pendingServers = 0;
    }

    if (pendingServers > 0) continue;
    // No decision before a full metric window has been observed. This is half
    // of the response lag the player is meant to feel.
    if (observedSec < c.metricWindowSec) continue;
    if (ctx.simTimeSec - lastScaleAtSec < c.cooldownSec) continue;

    const desiredRaw = Math.ceil((servers * utilizationEwma) / c.targetUtilization);
    const desired = Math.max(c.minServers, Math.min(c.maxServers, desiredRaw));
    if (desired === servers) continue;

    pendingServers = desired;
    // Scaling up waits for pods to start; scaling down is immediate, because
    // removing capacity needs nothing to boot.
    pendingReadyAtSec = ctx.simTimeSec + (desired > servers ? c.podStartSec : 0);
    lastScaleAtSec = ctx.simTimeSec;
  }

  return {
    servers, utilizationEwma, observedSec, pendingServers, pendingReadyAtSec, lastScaleAtSec,
  };
}

/**
 * Service capacity in requests per second.
 *
 * A station with no service time is instantaneous, not incapable. Reading
 * `serviceMeanMs <= 0` as zero capacity silently backlogs every request at the
 * traffic source and starves the rest of the graph.
 */
export function capacityRps(s: Station): number {
  if (s.health === 'down') return 0;
  if (s.serviceMeanMs <= 0) return Number.POSITIVE_INFINITY;
  return s.servers / (s.serviceMeanMs / 1000);
}

export function utilization(s: Station, arrivalRps: number): number {
  const cap = capacityRps(s);
  return cap > 0 ? arrivalRps / cap : Number.POSITIVE_INFINITY;
}

/**
 * Apply admission policies. Returns the admitted rate and what was rejected.
 *
 * Rejection is not the same as error: a rate limiter returning 429 and an
 * overloaded queue dropping requests are different lessons, so the engine
 * tracks them separately.
 */
export function admit(s: Station, offeredRps: number): { admittedRps: number; rejectedRps: number } {
  let admitted = offeredRps;
  for (const a of s.admission) {
    switch (a.kind) {
      case 'none':
        break;
      case 'rate-limit':
        admitted = Math.min(admitted, a.capacityRps);
        break;
      case 'shed-above': {
        const ceiling = capacityRps(s) * a.utilizationTarget;
        admitted = Math.min(admitted, ceiling);
        break;
      }
      case 'filter':
        // Class-aware filtering is applied by the engine, which holds the flow
        // vector; at station level this is a no-op.
        break;
    }
  }
  admitted = Math.max(0, Math.min(admitted, offeredRps));
  return { admittedRps: admitted, rejectedRps: offeredRps - admitted };
}

/**
 * Serve one tick's worth of work at a station.
 *
 * Works in requests rather than rates so conservation is exact:
 *
 *   offered = completed + rejected + dropped + (newBacklog - oldBacklog)
 *
 * Because backlog is an integrator rather than a formula, three correct
 * behaviours fall out for free: latency climbs progressively instead of
 * jumping, queue depth is a real state variable the animation can show, and
 * recovery takes time proportional to accumulated backlog rather than snapping
 * back the instant load drops. Breaking is fast; recovering is slow.
 */
export interface ServeResult {
  readonly completedReqs: number;
  readonly rejectedReqs: number;
  readonly droppedReqs: number;
  readonly newBacklogReqs: number;
}

export function serveTick(s: Station, offeredRps: number, dtSeconds: number): ServeResult {
  const offeredReqs = offeredRps * dtSeconds;

  // A down station refuses connections; it does not accumulate a queue on
  // behalf of a process that is not running.
  if (s.health === 'down') {
    return {
      completedReqs: 0,
      rejectedReqs: offeredReqs,
      droppedReqs: 0,
      newBacklogReqs: 0,
    };
  }

  const { admittedRps } = admit(s, offeredRps);
  const admittedReqs = admittedRps * dtSeconds;
  const rejectedReqs = offeredReqs - admittedReqs;

  const capacityReqs = capacityRps(s) * dtSeconds;
  const available = s.backlogReqs + admittedReqs;
  const completedReqs = Math.min(available, capacityReqs);

  let newBacklogReqs = available - completedReqs;
  let droppedReqs = 0;
  if (newBacklogReqs > s.queueLimit) {
    droppedReqs = newBacklogReqs - s.queueLimit;
    newBacklogReqs = s.queueLimit;
  }

  return { completedReqs, rejectedReqs, droppedReqs, newBacklogReqs };
}
