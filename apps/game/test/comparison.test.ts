import { describe, expect, it } from 'vitest';
import type { LatencyWaterfall } from '@nb/schema';
import { biggestMover } from '../src/game/Hud';

/**
 * The sign convention, pinned.
 *
 * A negative delta means the contribution got smaller, which means the run got
 * faster, which is an improvement. Inverting this would point the player at
 * whichever part of the request they had just fixed - the exact opposite of
 * the advice the caption claims to give.
 */

const wf = (p: Partial<LatencyWaterfall>): LatencyWaterfall => ({
  dnsMs: 0, setupMs: 0, propagationMs: 0, queueMs: 0, serviceMs: 0, transferMs: 0, ...p,
});

describe('biggest mover between two runs', () => {
  it('is null when nothing moved', () => {
    const w = wf({ queueMs: 400, serviceMs: 20 });
    expect(biggestMover(w, w)).toBeNull();
  });

  it('reports a reduction as a negative delta', () => {
    const before = wf({ queueMs: 400, serviceMs: 20 });
    const after = wf({ queueMs: 12, serviceMs: 20 });
    const m = biggestMover(before, after);
    expect(m?.label).toBe('Queueing');
    expect(m?.deltaMs).toBeLessThan(0);
    expect(m?.deltaMs).toBeCloseTo(-388, 6);
  });

  it('reports an increase as a positive delta', () => {
    const m = biggestMover(wf({ queueMs: 12 }), wf({ queueMs: 400 }));
    expect(m?.deltaMs).toBeGreaterThan(0);
  });

  it('picks the largest absolute move, not the largest value', () => {
    // Server work is much bigger in both runs, but barely moved. Queueing is
    // smaller and moved a lot - that is the one worth naming.
    const before = wf({ serviceMs: 900, queueMs: 200 });
    const after = wf({ serviceMs: 910, queueMs: 20 });
    expect(biggestMover(before, after)?.label).toBe('Queueing');
  });

  it('still reports a contribution that fell to zero', () => {
    // Paired by position rather than by presence, so a contribution that
    // disappears is a finding rather than an omission.
    const m = biggestMover(wf({ queueMs: 350 }), wf({ queueMs: 0 }));
    expect(m?.label).toBe('Queueing');
    expect(m?.deltaMs).toBeCloseTo(-350, 6);
  });

  it('ignores sub-millisecond noise', () => {
    expect(biggestMover(wf({ dnsMs: 20 }), wf({ dnsMs: 20.2 }))).toBeNull();
  });
});
