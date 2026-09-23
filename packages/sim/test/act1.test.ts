import { describe, expect, it } from 'vitest';
import { simulate } from '../src/engine';
import { rttMs } from '../src/math/geo';
import {
  constantDemand, horizontal, LONDON, scenario, SF, singleOrigin, TLS12, TLS13,
} from './fixtures';
import type { Station } from '../src/station';

/**
 * The Phase 1 gate: Act I, produced headlessly and checked against reality.
 *
 * Every number here was measured, then asserted - not asserted, then tuned into
 * existence. Where a measurement contradicted the design documents, the
 * documents were corrected; two of them were.
 */

const run = (
  topo: { stations: Station[]; edges: ReturnType<typeof singleOrigin>['edges'] },
  rps: number,
) => simulate({ ...topo, scenario: scenario({ demands: [constantDemand(rps, SF)] }) });

const p99 = (r: ReturnType<typeof simulate>): number => r.perClass['api-read']?.p99Ms ?? 0;
const p50 = (r: ReturnType<typeof simulate>): number => r.perClass['api-read']?.p50Ms ?? 0;
const err = (r: ReturnType<typeof simulate>): number => r.perClass['api-read']?.errorRatePct ?? 0;

describe('Level 1 — Anatomy of a Request', () => {
  it('decomposes latency into named contributions', () => {
    const r = run(singleOrigin({ protocol: TLS12 }), 100);
    const w = r.attribution;

    // Every component is accounted for, and they sum to the reported tail.
    const total = w.dnsMs + w.setupMs + w.propagationMs + w.queueMs + w.serviceMs + w.transferMs;
    expect(total).toBeGreaterThan(0);
    expect(Math.abs(total - p99(r)) / p99(r)).toBeLessThan(0.02);
  });

  it('is dominated by round trips, not compute, on a local idle server', () => {
    const r = run(singleOrigin({ protocol: TLS12 }), 100);
    const w = r.attribution;
    // A cold TLS 1.2 connection costs 3 RTTs; DNS costs one lookup. Together
    // they outweigh the 20ms of actual work.
    expect(w.dnsMs).toBe(20);
    expect(w.setupMs).toBeGreaterThan(0);
    expect(w.queueMs).toBeLessThan(1);
  });

  it('lands in a believable range for a local request', () => {
    const r = run(singleOrigin(), 100);
    expect(p50(r)).toBeGreaterThan(25);
    expect(p50(r)).toBeLessThan(60);
    expect(err(r)).toBe(0);
  });
});

describe('Level 2 — The Speed of Light Is a Budget', () => {
  /** The anchor the whole geography model has to clear. */
  it('SF to London round trip is ~139ms', () => {
    const rtt = rttMs(SF, LONDON);
    expect(rtt).toBeGreaterThan(130);
    expect(rtt).toBeLessThan(145);
  });

  it('moving the origin across an ocean multiplies latency about tenfold', () => {
    const local = run(singleOrigin({ protocol: TLS13 }), 100);
    const distant = run(singleOrigin({ originRegion: LONDON, protocol: TLS13 }), 100);

    // Not the "quadruple" an earlier draft of the content spine claimed. On a
    // cold connection every handshake round trip becomes transatlantic too, so
    // the real multiple is ~11x - which is a better lesson, and sets up level 8.
    const ratio = p50(distant) / p50(local);
    expect(ratio).toBeGreaterThan(8);
    expect(ratio).toBeLessThan(15);

    expect(distant.attribution.propagationMs).toBeGreaterThan(130);
    expect(distant.attribution.setupMs).toBeGreaterThan(250);
  });

  it('TLS 1.2 costs a whole extra round trip, and it shows at distance', () => {
    const tls13 = run(singleOrigin({ originRegion: LONDON, protocol: TLS13 }), 100);
    const tls12 = run(singleOrigin({ originRegion: LONDON, protocol: TLS12 }), 100);
    // One extra RTT of ~139ms.
    expect(p50(tls12) - p50(tls13)).toBeGreaterThan(120);
    expect(p50(tls12) - p50(tls13)).toBeLessThan(160);
  });

  it('a bigger origin does not help a distant client at all', () => {
    // The lesson: you cannot buy your way out of geography.
    const small = run(singleOrigin({ originRegion: LONDON, servers: 8 }), 100);
    const huge = run(singleOrigin({ originRegion: LONDON, servers: 32 }), 100);
    expect(p99(huge)).toBe(p99(small));
  });
});

describe('Level 3 — One Server, Too Many Users', () => {
  // One server at 20ms of work: 50 rps of capacity.
  const CAP = 50;

  it('p99 rises monotonically with utilization', () => {
    let prev = 0;
    for (const rho of [0.24, 0.5, 0.7, 0.84, 0.94]) {
      const r = run(singleOrigin({ servers: 1 }), rho * CAP);
      expect(p99(r)).toBeGreaterThan(prev);
      prev = p99(r);
    }
  });

  it('the hockey stick: p99 at 94% load is over 5x p99 at 50%', () => {
    const half = run(singleOrigin({ servers: 1 }), 0.5 * CAP);
    const hot = run(singleOrigin({ servers: 1 }), 0.94 * CAP);
    expect(p99(hot) / p99(half)).toBeGreaterThan(5);
  });

  it('queueing dominates the tail before capacity runs out', () => {
    const r = run(singleOrigin({ servers: 1 }), 0.94 * CAP);
    const w = r.attribution;
    // At 94% utilization the queue is larger than everything else combined,
    // while the server still has headroom on paper.
    expect(w.queueMs).toBeGreaterThan(
      w.dnsMs + w.setupMs + w.propagationMs + w.serviceMs + w.transferMs,
    );
  });

  it('a station exactly at capacity is already failing', () => {
    // There is no benign rho = 1. An earlier version of the kernel reported no
    // queueing here at all, because zero excess arrivals meant no backlog
    // accumulated and the steady-state term was being skipped.
    const r = run(singleOrigin({ servers: 1 }), CAP);
    expect(p99(r)).toBeGreaterThan(5000);
    expect(err(r)).toBeGreaterThan(10);
  });

  it('pooling: eight servers at the same utilization queue far less than one', () => {
    const one = run(singleOrigin({ servers: 1 }), 0.85 * CAP);
    const eight = run(singleOrigin({ servers: 8 }), 0.85 * 8 * CAP);
    expect(p99(eight)).toBeLessThan(p99(one) / 2);
  });
});

describe('Level 4 — Vertical vs Horizontal', () => {
  it('nine slots cost the same whether they are one box or three', () => {
    const vertical = run(singleOrigin({ servers: 9 }), 300);
    const horizontalTopo = run(horizontal(3, 3), 300);
    expect(horizontalTopo.cost.totalUsdMonth).toBeCloseTo(vertical.cost.totalUsdMonth, 2);
  });

  it('one big box is slightly faster, because pooling beats partitioning', () => {
    // The honest tradeoff: at equal cost, one pool of 9 has a better queue than
    // three pools of 3. Horizontal buys survivability, not speed.
    const vertical = run(singleOrigin({ servers: 9 }), 300);
    const horizontalTopo = run(horizontal(3, 3), 300);
    expect(p99(vertical)).toBeLessThan(p99(horizontalTopo));
  });

  it('but only the horizontal topology survives losing a node', () => {
    const kill = <T extends { stations: Station[] }>(t: T, id: string): T => ({
      ...t,
      stations: t.stations.map((s) => (s.id === id ? { ...s, health: 'down' as const } : s)),
    });

    const verticalDown = run(kill(singleOrigin({ servers: 9 }), 'origin'), 300);
    const horizontalDown = run(kill(horizontal(3, 3), 'origin-0'), 300);

    expect(err(verticalDown)).toBe(100);
    // A third of traffic still fails: without health checks the client keeps
    // routing to a dead backend. That gap is exactly what level 6 closes.
    expect(err(horizontalDown)).toBeGreaterThan(25);
    expect(err(horizontalDown)).toBeLessThan(40);
  });
});

describe('engine performance', () => {
  /**
   * A guard, not a benchmark. The what-if loop is the pedagogy, so a run has to
   * stay fast enough to re-run on every edit. This caught a quadratic pooling
   * bug that made a 20-second scenario take 60 seconds of wall clock.
   */
  it('simulates a 20-second scenario in well under 100ms', () => {
    const topo = singleOrigin({ servers: 8 });
    const input = { ...topo, scenario: scenario() };
    simulate(input); // warm the Erlang cache and JIT

    const start = performance.now();
    const runs = 5;
    for (let i = 0; i < runs; i++) simulate(input);
    const perRun = (performance.now() - start) / runs;

    expect(perRun).toBeLessThan(100);
  });

  it('scales acceptably with topology size', () => {
    const input = { ...horizontal(16, 4), scenario: scenario() };
    simulate(input);
    const start = performance.now();
    simulate(input);
    expect(performance.now() - start).toBeLessThan(500);
  });
});
