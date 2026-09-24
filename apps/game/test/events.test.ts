import { describe, expect, it } from 'vitest';
import { CATALOG, compile } from '@nb/catalog';
import { simulate } from '@nb/sim';
import { LEVEL } from '../src/game/level';
import { deriveEvents, eventsUpTo } from '../src/game/events';

/**
 * The narration has to match the run it describes.
 *
 * Derived from frames rather than instrumented separately, precisely so these
 * two cannot drift - but the ordering claims are worth pinning, because they
 * encode the lesson: overload comes before shedding, and recovery is a phase of
 * its own rather than a return to normal.
 */
const run = () => simulate({ ...compile(LEVEL.startingTopology, CATALOG), scenario: LEVEL.scenario });

describe('run narration', () => {
  it('reports the origin overloading, shedding, then recovering', () => {
    const kinds = deriveEvents(run()).filter((e) => e.nodeId === 'origin').map((e) => e.kind);
    expect(kinds).toContain('overload');
    expect(kinds).toContain('shedding');
    expect(kinds).toContain('recovering');
    expect(kinds).toContain('settled');
  });

  it('overloads before it sheds — the queue has to fill first', () => {
    const e = deriveEvents(run());
    const overload = e.findIndex((x) => x.kind === 'overload');
    const shed = e.findIndex((x) => x.kind === 'shedding');
    expect(overload).toBeGreaterThanOrEqual(0);
    expect(shed).toBeGreaterThan(overload);
  });

  it('settles only after it stops shedding', () => {
    const e = deriveEvents(run());
    const shed = e.findIndex((x) => x.kind === 'shedding');
    const settled = e.findIndex((x) => x.kind === 'settled');
    expect(settled).toBeGreaterThan(shed);
  });

  it('every event carries a number a player can act on', () => {
    for (const e of deriveEvents(run())) {
      expect(e.headline.length).toBeGreaterThan(0);
      expect(e.detail.length).toBeGreaterThan(20);
      expect(e.atSec).toBeGreaterThanOrEqual(0);
    }
  });

  it('reveals in step with playback rather than all at once', () => {
    const e = deriveEvents(run());
    expect(eventsUpTo(e, 0).length).toBeLessThan(e.length);
    expect(eventsUpTo(e, 1e9).length).toBe(e.length);
  });

  it('a healthy topology narrates nothing alarming', () => {
    const healthy = simulate({
      ...compile(
        { ...LEVEL.startingTopology,
          nodes: LEVEL.startingTopology.nodes.map((n) =>
            n.id === 'origin' ? { ...n, config: { ...n.config, servers: 18 } } : n) },
        CATALOG),
      scenario: LEVEL.scenario,
    });
    expect(deriveEvents(healthy).some((e) => e.severity === 'alarm')).toBe(false);
  });
});

describe('the feed can be rendered without corrupting itself', () => {
  it('no two events in one frame share a node and a kind', () => {
    // A React list keyed on frame+node+kind silently corrupts when two entries
    // collide - the row renders twice, out of order. This is the regression:
    // `shedding-ended` and `recovering` both fire the moment a spike ends.
    const events = deriveEvents(run());
    const keys = events.map((e) => `${e.frame}-${e.nodeId}-${e.kind}`);
    expect(keys).toEqual([...new Set(keys)]);
  });

  it('is in chronological order', () => {
    const times = deriveEvents(run()).map((e) => e.atSec);
    expect(times).toEqual([...times].sort((a, b) => a - b));
  });

  it('distinguishes ending the shedding from finishing the recovery', () => {
    const kinds = deriveEvents(run()).map((e) => e.kind);
    expect(kinds).toContain('shedding-ended');
    expect(kinds).toContain('recovering');
    expect(kinds).toContain('settled');
  });
});
