import { describe, expect, it } from 'vitest';
import { simulate } from '../src/engine';
import { client, edge, origin, scenario, SF, API_READ } from './fixtures';

/**
 * B4's engine half: backlog is an integrator, not a formula.
 *
 * `station.ts` documents the claim - breaking is fast, recovering is slow -
 * but nothing enforced it. If a future change replaced the queue state with a
 * closed-form utilization lookup, latency and drops could still look
 * plausible while this asymmetry silently vanished, because a formula
 * recomputes instantly at both ends of an overload instead of lagging on the
 * way down. That is exactly what these tests exist to catch.
 */

const BASE_RPS = 250;
const PEAK_RPS = 620;
const SPIKE_AT_SEC = 10;
const SPIKE_DURATION_SEC = 8;
const TOTAL_DURATION_SEC = 30;
const WARMUP_SEC = 4;

// 8 servers at 20ms/req is 400rps of capacity. The peak (620) overloads it by
// 220rps; the base rate (250) sits comfortably under it, so what happens after
// the spike is recovery, not a second overload.
function runSpike() {
  return simulate({
    stations: [client('client', SF), origin('origin', SF, 8, 20)],
    edges: [edge('e1', 'client', 'origin')],
    scenario: scenario({
      durationSec: TOTAL_DURATION_SEC,
      warmupSec: WARMUP_SEC,
      demands: [{
        classId: API_READ.id,
        originRegions: [{ regionId: SF.id, weight: 1 }],
        profile: {
          kind: 'spike', baseRps: BASE_RPS, peakRps: PEAK_RPS,
          atSec: SPIKE_AT_SEC, durationSec: SPIKE_DURATION_SEC,
        },
      }],
    }),
  });
}

function backlogSeries(result: ReturnType<typeof runSpike>): readonly number[] {
  return result.frames.map((f) => f.stations['origin']?.backlogReqs ?? 0);
}

describe('backlog integrator asymmetry (B4)', () => {
  it('is quiet before the spike, rises during it, and falls once it ends', () => {
    const backlog = backlogSeries(runSpike());

    expect(backlog[0]).toBeCloseTo(0, 5);
    const peak = Math.max(...backlog);
    expect(peak).toBeGreaterThan(0);
    // A real recovery, not a plateau at the queue limit for the rest of the run.
    expect(backlog[backlog.length - 1]).toBeLessThan(peak);
  });

  it('takes far longer to drain the backlog than it took to build it', () => {
    const result = runSpike();
    const frames = result.frames;
    const at = (i: number) => frames[i]?.stations['origin']?.backlogReqs ?? 0;

    const buildStart = frames.findIndex((_, i) => at(i) > 0.01);
    expect(buildStart).toBeGreaterThan(-1);

    let peakIdx = buildStart;
    let peak = at(buildStart);
    for (let i = buildStart; i < frames.length; i++) {
      if (at(i) > peak) { peak = at(i); peakIdx = i; }
    }

    let drainIdx = -1;
    for (let i = peakIdx; i < frames.length; i++) {
      if (at(i) < 0.01) { drainIdx = i; break; }
    }
    // The run has to be long enough to actually witness the recovery, or this
    // test would not be testing what it claims to.
    expect(drainIdx).toBeGreaterThan(-1);

    const buildTicks = peakIdx - buildStart;
    const drainTicks = drainIdx - peakIdx;

    expect(buildTicks).toBeGreaterThan(0);
    expect(drainTicks).toBeGreaterThan(buildTicks);
    // Not just "more ticks" - an integrator drains at the margin between base
    // load and capacity, which is far thinner than the margin that built it.
    // A closed-form utilization lookup would recover in ~1 tick regardless of
    // how fast the backlog grew, so this ratio is the asymmetry, not noise.
    expect(drainTicks).toBeGreaterThan(buildTicks * 2);
  });

  it('sheds requests once the queue is full, rather than queueing without bound', () => {
    const result = runSpike();
    const anyDropped = result.frames.some((f) => (f.stations['origin']?.droppedRps ?? 0) > 0);
    expect(anyDropped).toBe(true);

    // Before the queue fills, backlog absorbs the overload with no drops -
    // the integrator has to actually fill before shedding starts.
    const firstDropIdx = result.frames.findIndex((f) => (f.stations['origin']?.droppedRps ?? 0) > 0);
    const firstBacklogIdx = result.frames.findIndex((f) => (f.stations['origin']?.backlogReqs ?? 0) > 0.01);
    expect(firstDropIdx).toBeGreaterThan(firstBacklogIdx);
  });
});
