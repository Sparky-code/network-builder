import { describe, expect, it } from 'vitest';
import { classId, regionId, type Demand, type Region, type TrafficClass } from '@nb/schema';
import { simulate, type Scenario } from '@nb/sim';
import { CATALOG, compile, hasErrors, topo, validate } from '../src/index';

/**
 * Golden snapshots over reference topologies.
 *
 * These do not assert that any number is *correct* - the analytic and DES
 * oracles do that. They assert that numbers do not move without someone
 * noticing, which is the failure mode that quietly breaks fifteen levels when a
 * constant is retuned for balance.
 *
 * A diff here is not automatically a bug. It is a question: did you mean to
 * change this?
 */

const SF: Region = { id: regionId('us-west'), label: 'San Francisco', lat: 37.77, lon: -122.42 };
const LONDON: Region = { id: regionId('eu-west'), label: 'London', lat: 51.51, lon: -0.13 };

const STATIC_ASSET: TrafficClass = {
  id: classId('static-asset'),
  cacheable: true,
  objectPopulation: { count: 100_000, zipfAlpha: 0.9 },
  responseBytes: 64_000,
  originCpuMs: 5,
  clientTimeoutMs: 3000,
  retryPolicy: { maxAttempts: 2, backoffMs: 50, budgetFraction: 0.1 },
};

const demand = (rps: number): Demand => ({
  classId: STATIC_ASSET.id,
  originRegions: [{ regionId: SF.id, weight: 1 }],
  profile: { kind: 'constant', rps },
});

const scenarioFor = (rps: number): Scenario => ({
  durationSec: 20,
  warmupSec: 4,
  tickHz: 25,
  seed: 1,
  classes: [STATIC_ASSET],
  demands: [demand(rps)],
  regions: [SF, LONDON],
});

/** A stable, reviewable digest. Frames are excluded: hundreds of rows, no signal. */
function digest(result: ReturnType<typeof simulate>) {
  const round = (n: number, dp = 3): number => Number(n.toFixed(dp));
  return {
    perClass: Object.fromEntries(
      Object.entries(result.perClass).map(([k, v]) => [k, {
        p50Ms: round(v.p50Ms, 1), p95Ms: round(v.p95Ms, 1), p99Ms: round(v.p99Ms, 1),
        throughputRps: round(v.throughputRps, 1),
        errorRatePct: round(v.errorRatePct, 2),
      }]),
    ),
    perNode: Object.fromEntries(
      Object.entries(result.perNode).sort(([a], [b]) => (a < b ? -1 : 1)).map(([k, v]) => [k, {
        utilization: round(v.utilization), dropRatePct: round(v.dropRatePct, 2),
      }]),
    ),
    cacheHitRatioEdge: round(result.cacheHitRatioEdge),
    cacheHitRatioTotal: round(result.cacheHitRatioTotal),
    costUsdMonth: result.cost.totalUsdMonth,
  };
}

interface Reference {
  readonly name: string;
  readonly rps: number;
  readonly topology: ReturnType<typeof topo>;
}

const REFERENCES: readonly Reference[] = [
  {
    name: 'act1-single-origin',
    rps: 200,
    topology: topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'us-west' },
      ],
      [{ from: 'client', to: 'origin' }],
    ),
  },
  {
    name: 'act1-distant-origin',
    rps: 200,
    topology: topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'eu-west' },
      ],
      [{ from: 'client', to: 'origin' }],
    ),
  },
  {
    name: 'act2-load-balanced',
    rps: 600,
    topology: topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'lb', type: 'load-balancer', region: 'us-west' },
        { id: 'origin-a', type: 'origin', region: 'us-west' },
        { id: 'origin-b', type: 'origin', region: 'us-west' },
        { id: 'origin-c', type: 'origin', region: 'us-west' },
      ],
      [
        { from: 'client', to: 'lb' },
        { from: 'lb', to: 'origin-a' },
        { from: 'lb', to: 'origin-b' },
        { from: 'lb', to: 'origin-c' },
      ],
    ),
  },
  {
    name: 'act2-database-bottleneck',
    rps: 400,
    topology: topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'us-west', config: { servers: 32 } },
        { id: 'db', type: 'database', region: 'us-west' },
      ],
      [{ from: 'client', to: 'origin' }, { from: 'origin', to: 'db' }],
    ),
  },
  {
    name: 'act3-edge-cache',
    rps: 2000,
    topology: topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'pop', type: 'cdn-pop', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'eu-west' },
      ],
      [{ from: 'client', to: 'pop' }, { from: 'pop', to: 'origin' }],
    ),
  },
  {
    name: 'act3-shielded-multi-pop',
    rps: 4000,
    topology: topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'pop-a', type: 'cdn-pop', region: 'us-west' },
        { id: 'pop-b', type: 'cdn-pop', region: 'eu-west' },
        { id: 'shield', type: 'origin-shield', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'eu-west', config: { servers: 32 } },
      ],
      [
        { from: 'client', to: 'pop-a' },
        { from: 'client', to: 'pop-b' },
        { from: 'pop-a', to: 'shield' },
        { from: 'pop-b', to: 'shield' },
        { from: 'shield', to: 'origin' },
      ],
    ),
  },
];

describe('golden reference topologies', () => {
  it.each(REFERENCES.map((r) => [r.name, r] as const))('%s is valid', (_name, ref) => {
    // A reference topology that does not validate is a broken fixture, and its
    // snapshot would be meaningless.
    expect(hasErrors(validate(ref.topology, CATALOG))).toBe(false);
  });

  it.each(REFERENCES.map((r) => [r.name, r] as const))('%s matches its snapshot', (name, ref) => {
    const { stations, edges } = compile(ref.topology, CATALOG);
    const result = simulate({ stations, edges, scenario: scenarioFor(ref.rps) });
    expect(digest(result)).toMatchSnapshot(name);
  });

  it('is reproducible: the same reference twice gives identical digests', () => {
    for (const ref of REFERENCES) {
      const compiled = compile(ref.topology, CATALOG);
      const a = simulate({ ...compiled, scenario: scenarioFor(ref.rps) });
      const b = simulate({ ...compiled, scenario: scenarioFor(ref.rps) });
      expect(digest(b)).toEqual(digest(a));
    }
  });
});

/**
 * Lesson claims, checked against the engine.
 *
 * This is the `demonstrations` mechanism from the architecture doc in embryo:
 * each assertion is the claim a level makes in prose. If tuning ever makes one
 * false, CI fails by name rather than shipping a level that teaches something
 * untrue.
 */
describe('lesson claims', () => {
  const run = (topology: ReturnType<typeof topo>, rps: number) => {
    const compiled = compile(topology, CATALOG);
    return simulate({ ...compiled, scenario: scenarioFor(rps) });
  };

  const TWO_POPS = topo(
    [
      { id: 'client', type: 'client', region: 'us-west' },
      { id: 'pop-a', type: 'cdn-pop', region: 'us-west' },
      { id: 'pop-b', type: 'cdn-pop', region: 'eu-west' },
      { id: 'origin', type: 'origin', region: 'eu-west', config: { servers: 32 } },
    ],
    [
      { from: 'client', to: 'pop-a' },
      { from: 'client', to: 'pop-b' },
      { from: 'pop-a', to: 'origin' },
      { from: 'pop-b', to: 'origin' },
    ],
  );

  const TWO_POPS_SHIELDED = topo(
    [
      { id: 'client', type: 'client', region: 'us-west' },
      { id: 'pop-a', type: 'cdn-pop', region: 'us-west' },
      { id: 'pop-b', type: 'cdn-pop', region: 'eu-west' },
      { id: 'shield', type: 'origin-shield', region: 'us-west' },
      { id: 'origin', type: 'origin', region: 'eu-west', config: { servers: 32 } },
    ],
    [
      { from: 'client', to: 'pop-a' },
      { from: 'client', to: 'pop-b' },
      { from: 'pop-a', to: 'shield' },
      { from: 'pop-b', to: 'shield' },
      { from: 'shield', to: 'origin' },
    ],
  );

  /** Level 15: "a shield raises total hit ratio while edge hit ratio is unchanged". */
  it('a shield raises total hit ratio without changing edge hit ratio', () => {
    const bare = run(TWO_POPS, 4000);
    const shielded = run(TWO_POPS_SHIELDED, 4000);

    // The number that drives user-visible latency is untouched: a request that
    // hits at the edge never learns the shield exists.
    expect(shielded.cacheHitRatioEdge).toBeCloseTo(bare.cacheHitRatioEdge, 3);

    // The number that drives origin offload and egress cost improves sharply.
    expect(shielded.cacheHitRatioTotal).toBeGreaterThan(bare.cacheHitRatioTotal + 0.05);
    expect(shielded.cacheHitRatioTotal).toBeGreaterThan(shielded.cacheHitRatioEdge);
  });

  /** Level 15, the other half: the shield is what actually protects the origin. */
  it('a shield lowers origin utilization', () => {
    const bare = run(TWO_POPS, 4000);
    const shielded = run(TWO_POPS_SHIELDED, 4000);
    expect(shielded.perNode['origin']?.utilization ?? 1)
      .toBeLessThan(bare.perNode['origin']?.utilization ?? 0);
  });

  /** Level 17: more PoPs lower per-PoP hit ratio, which is the setup for level 15. */
  it('splitting traffic across PoPs lowers edge hit ratio', () => {
    const onePop = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        { id: 'pop-a', type: 'cdn-pop', region: 'us-west' },
        { id: 'origin', type: 'origin', region: 'eu-west', config: { servers: 32 } },
      ],
      [{ from: 'client', to: 'pop-a' }, { from: 'pop-a', to: 'origin' }],
    );
    const single = run(onePop, 4000);
    const split = run(TWO_POPS, 4000);
    expect(split.cacheHitRatioEdge).toBeLessThan(single.cacheHitRatioEdge);
  });

  /** Level 12: a cache key that varies per request is a cache that does nothing. */
  it('key cardinality collapse destroys hit ratio', () => {
    const polluted = topo(
      [
        { id: 'client', type: 'client', region: 'us-west' },
        {
          id: 'pop-a', type: 'cdn-pop', region: 'us-west',
          config: { keyCardinalityFactor: 1_000_000 },
        },
        { id: 'origin', type: 'origin', region: 'eu-west', config: { servers: 64 } },
      ],
      [{ from: 'client', to: 'pop-a' }, { from: 'pop-a', to: 'origin' }],
    );
    expect(run(polluted, 4000).cacheHitRatioEdge).toBeLessThan(0.1);
  });
});
