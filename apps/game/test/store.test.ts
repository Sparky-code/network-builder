import { beforeEach, describe, expect, it } from 'vitest';
import { store } from '../src/game/state';

/**
 * Run-to-run comparison, at the store level.
 *
 * The retention rules are subtle enough to be worth pinning: the previous run
 * must survive a topology edit (comparing across an edit is the whole point),
 * but must not survive a reset (there is nothing to compare a fresh level to).
 */

describe('previous run retention', () => {
  beforeEach(() => { store.reset(); });

  it('has nothing to compare before the first run', () => {
    const s = store.getSnapshot();
    expect(s.result).toBeNull();
    expect(s.previousResult).toBeNull();
  });

  it('still has nothing to compare after only one run', () => {
    store.run();
    const s = store.getSnapshot();
    expect(s.result).not.toBeNull();
    expect(s.previousResult).toBeNull();
  });

  it('keeps the first run as the baseline for the second', () => {
    store.run();
    const first = store.getSnapshot().result;
    store.run();
    const s = store.getSnapshot();
    expect(s.previousResult).toBe(first);
    expect(s.result).not.toBe(first);
  });

  it('survives a topology edit, which is when the comparison matters most', () => {
    store.run();
    const first = store.getSnapshot().result;

    store.updateConfig('origin', { servers: 14 });
    const afterEdit = store.getSnapshot();
    // The current result is discarded - it describes a topology that no longer
    // exists - but the baseline is not.
    expect(afterEdit.result).toBeNull();
    expect(afterEdit.previousResult).toBe(first);

    store.run();
    expect(store.getSnapshot().previousResult).toBe(first);
  });

  it('chains across several runs, always comparing to the one just before', () => {
    store.run();
    const a = store.getSnapshot().result;
    store.run();
    const b = store.getSnapshot().result;
    store.run();
    const s = store.getSnapshot();
    expect(s.previousResult).toBe(b);
    expect(s.previousResult).not.toBe(a);
  });

  it('a reset clears both: a fresh level has nothing to compare against', () => {
    store.run();
    store.run();
    expect(store.getSnapshot().previousResult).not.toBeNull();
    store.reset();
    const s = store.getSnapshot();
    expect(s.result).toBeNull();
    expect(s.previousResult).toBeNull();
  });
});

/**
 * A level needs a beginning and an end.
 *
 * Playtest finding: the brief sat in a side rail from the first frame, and
 * earning three stars changed a character in a list. Neither read as a moment.
 */
describe('level phases', () => {
  beforeEach(() => { store.reset(); });

  it('a reset drops the player straight into building, not back into the brief', () => {
    // Reset is "start this attempt again", not "re-read the problem".
    expect(store.getSnapshot().phase).toBe('playing');
  });

  it('start moves from briefing to playing', () => {
    store.start();
    expect(store.getSnapshot().phase).toBe('playing');
  });

  it('completing does nothing without a result to accept', () => {
    store.complete();
    expect(store.getSnapshot().phase).toBe('playing');
  });

  it('records a best run, and keeps the cheaper one at equal stars', () => {
    // Expensive but passing.
    store.updateConfig('origin', { servers: 24 });
    store.run();
    store.complete();
    const expensive = store.getSnapshot().best;
    expect(expensive).not.toBeNull();

    store.keepPlaying();
    // Same stars, less money: this should replace it.
    store.updateConfig('origin', { servers: 14 });
    store.run();
    store.complete();
    const cheaper = store.getSnapshot().best;

    if (expensive !== null && cheaper !== null && cheaper.stars === expensive.stars) {
      expect(cheaper.costUsdMonth).toBeLessThan(expensive.costUsdMonth);
    }
  });

  it('a best score survives a reset — it is a record, not part of the attempt', () => {
    store.updateConfig('origin', { servers: 14 });
    store.run();
    store.complete();
    const best = store.getSnapshot().best;
    expect(best).not.toBeNull();
    store.reset();
    expect(store.getSnapshot().best).toEqual(best);
  });
});
