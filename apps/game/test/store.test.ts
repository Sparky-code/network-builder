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
