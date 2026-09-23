import { describe, expect, it } from 'vitest';
import { makeStation, serveTick } from '../src/station';
import { nodeId, regionId } from '@nb/schema';
import { simulate } from '../src/engine';
import { horizontal, scenario, SF, singleOrigin } from './fixtures';

/**
 * Flow conservation: nothing may be invented or silently lost.
 *
 *   offered = completed + rejected + dropped + (newBacklog - oldBacklog)
 *
 * This is the cheapest test in the suite and it catches the class of bug that is
 * hardest to spot by eye - a leak that quietly makes error rates look better
 * than they are.
 */
describe('station-level conservation', () => {
  const station = (opts: Partial<Parameters<typeof makeStation>[0]> = {}) =>
    makeStation({
      id: nodeId('s'), regionId: regionId('r'),
      servers: 4, serviceMeanMs: 20, queueLimit: 100, ...opts,
    });

  it.each([
    ['under capacity', 100],
    ['at capacity', 200],
    ['over capacity', 600],
    ['far over capacity', 5000],
  ])('conserves flow %s', (_label, offeredRps) => {
    const s = station();
    const dt = 0.04;
    for (let i = 0; i < 200; i++) {
      const before = s.backlogReqs;
      const r = serveTick(s, offeredRps, dt);
      const offered = offeredRps * dt;
      const accounted =
        r.completedReqs + r.rejectedReqs + r.droppedReqs + (r.newBacklogReqs - before);
      expect(Math.abs(accounted - offered)).toBeLessThan(1e-9);
      s.backlogReqs = r.newBacklogReqs;
    }
  });

  it('never exceeds the queue limit', () => {
    const s = station({ queueLimit: 50 });
    for (let i = 0; i < 500; i++) {
      const r = serveTick(s, 10_000, 0.04);
      expect(r.newBacklogReqs).toBeLessThanOrEqual(50 + 1e-9);
      s.backlogReqs = r.newBacklogReqs;
    }
  });

  it('backlog never goes negative when load disappears', () => {
    const s = station();
    for (let i = 0; i < 50; i++) s.backlogReqs = serveTick(s, 5000, 0.04).newBacklogReqs;
    expect(s.backlogReqs).toBeGreaterThan(0);
    for (let i = 0; i < 500; i++) s.backlogReqs = serveTick(s, 0, 0.04).newBacklogReqs;
    expect(s.backlogReqs).toBe(0);
  });

  /**
   * Recovery is slower than collapse, because backlog is an integrator. That
   * asymmetry is itself a lesson, so it gets an assertion.
   */
  it('takes longer to drain a backlog than to build it', () => {
    const s = station();
    const dt = 0.04;
    let ticksToBuild = 0;
    while (s.backlogReqs < 40 && ticksToBuild < 10_000) {
      s.backlogReqs = serveTick(s, 4000, dt).newBacklogReqs;
      ticksToBuild++;
    }
    let ticksToDrain = 0;
    // Drain at a load just under capacity, as a real recovery would.
    while (s.backlogReqs > 0.01 && ticksToDrain < 100_000) {
      s.backlogReqs = serveTick(s, 150, dt).newBacklogReqs;
      ticksToDrain++;
    }
    expect(ticksToDrain).toBeGreaterThan(ticksToBuild);
  });
});

describe('engine-level conservation', () => {
  it('completed plus errored plus dropped never exceeds offered', () => {
    for (const rps of [50, 500, 5000]) {
      const r = simulate({
        ...singleOrigin({ servers: 8 }),
        scenario: scenario({
          demands: [{
            classId: scenario().classes[0]!.id,
            originRegions: [{ regionId: SF.id, weight: 1 }],
            profile: { kind: 'constant', rps },
          }],
        }),
      });
      for (const f of r.frames) {
        expect(f.completedRps + f.erroredRps + f.droppedRps).toBeLessThanOrEqual(
          f.offeredRps + 1e-6,
        );
      }
    }
  });

  it('reports no traffic when there is no demand', () => {
    const r = simulate({
      ...horizontal(3, 4),
      scenario: scenario({ demands: [] }),
    });
    for (const f of r.frames) {
      expect(f.offeredRps).toBe(0);
      expect(f.completedRps).toBe(0);
    }
    expect(r.perClass['api-read']?.throughputRps).toBe(0);
  });
});
