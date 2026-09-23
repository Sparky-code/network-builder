import { describe, expect, it } from 'vitest';
import { simulate } from '../src/engine';
import { applyControllers, makeStation } from '../src/station';
import { nodeId, regionId } from '@nb/schema';
import { autoscaledOrigin, client, edge, scenario, SF, API_READ } from './fixtures';

/**
 * The Phase 2 gate: does the Station abstraction absorb autoscaling?
 *
 * ADR 0002 claims Acts V and VI are re-parameterisations of one abstraction
 * rather than a second engine. That claim is cheap to assert and expensive to
 * discover is false, so it is tested here - immediately after the engine works,
 * rather than in month four with four acts of content already written against
 * it.
 *
 * The answer is yes: an HPA is a function that adjusts `servers` with lag. It
 * needed one seam (`applyControllers`, called at the end of a station's tick)
 * and no new simulation primitive.
 */

const spikeScenario = (peakRps: number, baseRps = 200) =>
  scenario({
    durationSec: 180,
    warmupSec: 20,
    tickHz: 10,
    demands: [{
      classId: API_READ.id,
      originRegions: [{ regionId: SF.id, weight: 1 }],
      profile: { kind: 'spike', baseRps, peakRps, atSec: 60, durationSec: 60 },
    }],
  });

const run = (origin: ReturnType<typeof autoscaledOrigin>, peakRps: number) =>
  simulate({
    stations: [client('client', SF), origin],
    edges: [edge('e1', 'client', 'origin')],
    scenario: spikeScenario(peakRps),
  });

describe('HPA as a controller on the existing abstraction', () => {
  it('scales up under sustained load and keeps serving', () => {
    // 800 rps against a start of 6 servers (300 rps of capacity). The HPA has to
    // roughly triple capacity, and the run has to finish having served traffic.
    const result = run(autoscaledOrigin({ servers: 6, minServers: 2 }), 800);
    expect(result.perClass['api-read']?.throughputRps ?? 0).toBeGreaterThan(200);
    expect(result.perNode['origin']?.utilization ?? 0).toBeGreaterThan(0);
    // Without scaling, a 6-server origin at 800 rps would never recover; the
    // topology has to end the run in better shape than it entered the spike.
    const tail = result.frames.slice(-20);
    const tailErrors = tail.reduce((a, f) => a + f.droppedRps + f.erroredRps, 0) / tail.length;
    expect(tailErrors).toBeLessThan(50);
  });

  it('responds with a lag of about metricWindow + podStart', () => {
    // Directly exercising the controller is clearer than inferring lag from
    // aggregate metrics, and it is the quantity the lesson names.
    const station = makeStation({
      id: nodeId('s'), regionId: regionId('r'),
      servers: 4, serviceMeanMs: 20,
      controllers: [{
        kind: 'hpa', minServers: 2, maxServers: 64, targetUtilization: 0.7,
        metricWindowSec: 15, podStartSec: 20, cooldownSec: 10,
      }],
    });

    const dt = 0.1;
    let t = 0;
    let scaledAt = -1;
    const startServers = station.servers;

    // Hold utilization at 1.4x target and watch when capacity actually changes.
    for (let i = 0; i < 2000; i++) {
      const r = applyControllers(station, { utilization: 1.0, simTimeSec: t, dtSeconds: dt });
      station.servers = r.servers;
      station.utilizationEwma = r.utilizationEwma;
      station.observedSec = r.observedSec;
      station.pendingServers = r.pendingServers;
      station.pendingReadyAtSec = r.pendingReadyAtSec;
      station.lastScaleAtSec = r.lastScaleAtSec;
      if (scaledAt < 0 && station.servers !== startServers) scaledAt = t;
      t += dt;
    }

    expect(scaledAt).toBeGreaterThan(0);
    // The EWMA has to climb through the metric window before the decision, then
    // pods have to start. Neither half is optional, and their sum is the lesson.
    expect(scaledAt).toBeGreaterThan(20);
    expect(scaledAt).toBeLessThan(15 + 20 + 25);
  });

  it('cooldown prevents flapping', () => {
    const station = makeStation({
      id: nodeId('s'), regionId: regionId('r'),
      servers: 8, serviceMeanMs: 20,
      controllers: [{
        kind: 'hpa', minServers: 2, maxServers: 64, targetUtilization: 0.7,
        metricWindowSec: 5, podStartSec: 5, cooldownSec: 30,
      }],
    });

    const dt = 0.1;
    let t = 0;
    let changes = 0;
    let prev = station.servers;

    // Oscillate demand hard. Without a cooldown this would thrash.
    for (let i = 0; i < 3000; i++) {
      const util = Math.sin(t / 3) > 0 ? 1.4 : 0.2;
      const r = applyControllers(station, { utilization: util, simTimeSec: t, dtSeconds: dt });
      station.servers = r.servers;
      station.utilizationEwma = r.utilizationEwma;
      station.observedSec = r.observedSec;
      station.pendingServers = r.pendingServers;
      station.pendingReadyAtSec = r.pendingReadyAtSec;
      station.lastScaleAtSec = r.lastScaleAtSec;
      if (station.servers !== prev) { changes++; prev = station.servers; }
      t += dt;
    }

    // 300 simulated seconds at a 30s cooldown allows at most ~10 changes.
    expect(changes).toBeLessThanOrEqual(11);
  });

  it('respects min and max bounds', () => {
    const station = makeStation({
      id: nodeId('s'), regionId: regionId('r'),
      servers: 10, serviceMeanMs: 20,
      controllers: [{
        kind: 'hpa', minServers: 3, maxServers: 12, targetUtilization: 0.7,
        metricWindowSec: 2, podStartSec: 1, cooldownSec: 1,
      }],
    });
    const dt = 0.1;
    let t = 0;
    const step = (util: number) => {
      const r = applyControllers(station, { utilization: util, simTimeSec: t, dtSeconds: dt });
      station.servers = r.servers;
      station.utilizationEwma = r.utilizationEwma;
      station.observedSec = r.observedSec;
      station.pendingServers = r.pendingServers;
      station.pendingReadyAtSec = r.pendingReadyAtSec;
      station.lastScaleAtSec = r.lastScaleAtSec;
      t += dt;
    };
    for (let i = 0; i < 1500; i++) step(3.0);
    expect(station.servers).toBeLessThanOrEqual(12);
    for (let i = 0; i < 1500; i++) step(0.01);
    expect(station.servers).toBeGreaterThanOrEqual(3);
  });

  /**
   * The lesson level 29 is built on: headroom beats a faster autoscaler.
   *
   * During the response lag there is no amount of HPA tuning that conjures
   * capacity which does not yet exist. A floor does. Note that "headroom" has to
   * mean a raised `minServers`, not merely a large starting count - otherwise
   * the autoscaler sheds it during the quiet period before the spike, which is
   * its own worthwhile lesson and a trap this test originally fell into.
   */
  it('headroom reduces spike errors far more than a faster HPA does', () => {
    const fastHpa = run(
      autoscaledOrigin({
        servers: 6, minServers: 2, metricWindowSec: 2, podStartSec: 20, cooldownSec: 2,
      }),
      800,
    );
    const withHeadroom = run(
      autoscaledOrigin({
        servers: 24, minServers: 24, metricWindowSec: 15, podStartSec: 20, cooldownSec: 10,
      }),
      800,
    );

    const fast = fastHpa.perClass['api-read'];
    const headroom = withHeadroom.perClass['api-read'];

    // A tightly tuned autoscaler still loses most of the spike: 800 rps needs 16
    // servers and it starts with 6, so for the whole response lag it is short.
    expect(fast?.errorRatePct ?? 0).toBeGreaterThan(40);
    expect(fast?.p99Ms ?? 0).toBeGreaterThan(10_000);

    // Capacity that already exists needs no lag at all.
    expect(headroom?.errorRatePct ?? 1).toBeLessThan(1);
    expect(headroom?.p99Ms ?? 1e9).toBeLessThan(200);
  });

  it('a station with no controllers is completely unaffected', () => {
    // The seam must be inert when unused, or every Act I level pays for Act V.
    const withNone = simulate({
      stations: [client('client', SF), makeStation({
        id: nodeId('origin'), regionId: SF.id, servers: 8, serviceMeanMs: 20,
        routing: { kind: 'terminal' },
      })],
      edges: [edge('e1', 'client', 'origin')],
      scenario: spikeScenario(600),
    });
    expect(withNone.perNode['origin']?.utilization).toBeGreaterThan(0);
    expect(withNone.engineVersion).toBeDefined();
  });
});
