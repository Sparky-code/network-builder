import { describe, expect, it } from 'vitest';
import { CATALOG, compile, hasErrors, topo, validate } from '@nb/catalog';
import { simulate } from '@nb/sim';
import { LEVEL } from '../src/game/level';

/**
 * Level solvability.
 *
 * A level that cannot be beaten, or that is beaten by doing nothing, is the
 * classic way a content-driven game dies. Both ends are asserted here: the
 * starting topology must fail, and a reference solution must pass.
 */

const run = (topology: ReturnType<typeof topo>) => {
  const compiled = compile(topology, CATALOG);
  const result = simulate({ ...compiled, scenario: LEVEL.scenario });
  const m = result.perClass['api-read'];
  return {
    p99: m?.p99Ms ?? Infinity,
    errors: m?.errorRatePct ?? 100,
    cost: result.cost.totalUsdMonth,
    spof: validate(topology, CATALOG).some((d) => d.code === 'single-point-of-failure'),
  };
};

/** One big box at 14 slots: meets the SLO, under budget, but one failure from zero. */
const VERTICAL = topo(
  [
    { id: 'users', type: 'client', region: 'us-west' },
    { id: 'origin', type: 'origin', region: 'us-west', config: { servers: 14 } },
  ],
  [{ from: 'users', to: 'origin' }],
);

/** Three boxes of five behind a load balancer: slightly slower, but survivable. */
const HORIZONTAL = topo(
  [
    { id: 'users', type: 'client', region: 'us-west' },
    { id: 'lb', type: 'load-balancer', region: 'us-west' },
    { id: 'a', type: 'origin', region: 'us-west', config: { servers: 5 } },
    { id: 'b', type: 'origin', region: 'us-west', config: { servers: 5 } },
    { id: 'c', type: 'origin', region: 'us-west', config: { servers: 5 } },
  ],
  [
    { from: 'users', to: 'lb' },
    { from: 'lb', to: 'a' }, { from: 'lb', to: 'b' }, { from: 'lb', to: 'c' },
  ],
);

describe('the vertical slice level', () => {
  it('its starting topology is valid but does not pass', () => {
    // Valid means runnable. The player is not blocked; they are just losing.
    expect(hasErrors(validate(LEVEL.startingTopology, CATALOG))).toBe(false);
    const start = run(LEVEL.startingTopology);
    expect(start.p99).toBeGreaterThan(LEVEL.sloP99Ms);
  });

  it('is solvable vertically, for two stars', () => {
    const r = run(VERTICAL);
    expect(r.p99).toBeLessThanOrEqual(LEVEL.sloP99Ms);
    expect(r.errors).toBeLessThanOrEqual(1);
    expect(r.cost).toBeLessThanOrEqual(LEVEL.budgetUsdMonth);
    // The third star is withheld: one box is one failure away from nothing.
    expect(r.spof).toBe(true);
  });

  it('is solvable horizontally, for three stars', () => {
    const r = run(HORIZONTAL);
    expect(r.p99).toBeLessThanOrEqual(LEVEL.sloP99Ms);
    expect(r.errors).toBeLessThanOrEqual(1);
    expect(r.cost).toBeLessThanOrEqual(LEVEL.budgetUsdMonth);
    expect(r.spof).toBe(false);
  });

  it('rewards the vertical design with lower latency, and the horizontal one with resilience', () => {
    // The honest tradeoff the level is built on: one pool queues better than
    // several smaller ones - pooling beats partitioning, so the single box is
    // genuinely a little faster. What horizontal buys is surviving a machine.
    const v = run(VERTICAL);
    const h = run(HORIZONTAL);
    expect(v.p99).toBeLessThan(h.p99);
    expect(v.spof).toBe(true);
    expect(h.spof).toBe(false);
  });

  it('cannot be beaten by brute force within the budget', () => {
    // If the budget did not bind, there would be no decision to make.
    const overspend = topo(
      [
        { id: 'users', type: 'client', region: 'us-west' },
        { id: 'lb', type: 'load-balancer', region: 'us-west' },
        { id: 'a', type: 'origin', region: 'us-west', config: { servers: 32 } },
        { id: 'b', type: 'origin', region: 'us-west', config: { servers: 32 } },
      ],
      [{ from: 'users', to: 'lb' }, { from: 'lb', to: 'a' }, { from: 'lb', to: 'b' }],
    );
    expect(run(overspend).cost).toBeGreaterThan(LEVEL.budgetUsdMonth);
  });
});
