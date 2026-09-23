import { describe, expect, it } from 'vitest';
import { nodeId } from '@nb/schema';
import { simulate, type SimInput } from '../src/engine';
import type { SimEdge, Station } from '../src/station';
import { horizontal, scenario, singleOrigin, SF } from './fixtures';

/**
 * The shuffled-input identity test.
 *
 * This ranks first in the test strategy because a plain repeat-run test does not
 * catch what it catches. Running the same object twice will agree even if the
 * engine iterates a Map; permuting the inputs will not. Any dependence on
 * insertion order shows up here as a numeric difference.
 */

function permute<T>(xs: readonly T[], rotate: number): T[] {
  const a = [...xs];
  for (let i = 0; i < rotate; i++) a.push(a.shift() as T);
  return a.reverse();
}

/** Rename every node, preserving structure, to defeat any id-order luck. */
function rename(input: SimInput, prefix: string): SimInput {
  const map = new Map<string, string>();
  input.stations.forEach((s, i) => map.set(s.id, `${prefix}${String(100 - i)}`));
  const stations: Station[] = input.stations.map((s) => ({
    ...s, id: nodeId(map.get(s.id) ?? s.id),
  }));
  const edges: SimEdge[] = input.edges.map((e) => ({
    ...e,
    from: nodeId(map.get(e.from) ?? e.from),
    to: nodeId(map.get(e.to) ?? e.to),
  }));
  return { ...input, stations, edges };
}

function fingerprint(r: ReturnType<typeof simulate>): string {
  // Node keys are renamed between runs, so compare node metrics as a sorted
  // multiset of values rather than by key.
  const nodes = Object.values(r.perNode)
    .map((n) => `${n.utilization}|${n.backlogPeak}|${n.dropRatePct}`)
    .sort();
  return JSON.stringify({
    perClass: r.perClass,
    perRegion: r.perRegion,
    nodes,
    hitEdge: r.cacheHitRatioEdge,
    hitTotal: r.cacheHitRatioTotal,
    attribution: r.attribution,
    frames: r.frames.map((f) => [f.p50Ms, f.p95Ms, f.p99Ms, f.completedRps]),
  });
}

describe('determinism', () => {
  it('is bit-identical across repeated runs', () => {
    const input: SimInput = { ...singleOrigin(), scenario: scenario() };
    expect(fingerprint(simulate(input))).toBe(fingerprint(simulate(input)));
  });

  it('does not mutate the caller input', () => {
    const input: SimInput = { ...singleOrigin({ servers: 4 }), scenario: scenario() };
    const before = JSON.stringify(input.stations);
    simulate(input);
    expect(JSON.stringify(input.stations)).toBe(before);
  });

  it('is bit-identical under permuted station and edge order', () => {
    const base = horizontal(4, 3);
    const s = scenario({ demands: [{ classId: scenario().classes[0]!.id,
      originRegions: [{ regionId: SF.id, weight: 1 }],
      profile: { kind: 'constant', rps: 400 } }] });

    const a = simulate({ ...base, scenario: s });
    const b = simulate({
      stations: permute(base.stations, 2),
      edges: permute(base.edges, 3),
      scenario: s,
    });

    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('is bit-identical under renamed node ids', () => {
    const base = horizontal(3, 4);
    const s = scenario();
    const a = simulate({ ...base, scenario: s });
    const b = simulate(rename({ ...base, scenario: s }, 'z-'));
    expect(fingerprint(b)).toBe(fingerprint(a));
  });

  it('is bit-identical under permutation AND renaming together', () => {
    const base = horizontal(5, 2);
    const s = scenario();
    const a = simulate({ ...base, scenario: s });
    const shuffled = rename(
      { stations: permute(base.stations, 3), edges: permute(base.edges, 1), scenario: s },
      'q-',
    );
    expect(fingerprint(shuffled === undefined ? a : simulate(shuffled))).toBe(fingerprint(a));
  });

  it('stamps an engine version and a stable input hash', () => {
    const input: SimInput = { ...singleOrigin(), scenario: scenario() };
    const a = simulate(input);
    const b = simulate(input);
    expect(a.engineVersion).toMatch(/^\d+\.\d+\.\d+$/);
    expect(a.inputHash).toBe(b.inputHash);

    // A different topology must hash differently, or cached runs would collide.
    const other = simulate({ ...singleOrigin({ servers: 16 }), scenario: scenario() });
    expect(other.inputHash).not.toBe(a.inputHash);
  });

  it('route probes do not consume the RNG', () => {
    // Probes are compiled constants, so changing the seed must not move any
    // latency number. If this fails, grading has become seed-dependent.
    const a = simulate({ ...singleOrigin(), scenario: scenario({ seed: 1 }) });
    const b = simulate({ ...singleOrigin(), scenario: scenario({ seed: 999 }) });
    expect(b.perClass['api-read']?.p99Ms).toBe(a.perClass['api-read']?.p99Ms);
  });
});
