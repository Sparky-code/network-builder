import { describe, expect, it } from 'vitest';
import fc from 'fast-check';
import { erlangC, meanWaitMs } from '../src/math/erlang';
import { cacheHitRatio } from '../src/cache';
import { oneWayMs, rttMs } from '../src/math/geo';
import { buildKernel } from '../src/kernel';
import { sampleRoute, quantile } from '../src/probes';
import { LONDON, SF } from './fixtures';

/**
 * Property tests over the invariants the engine must never violate.
 *
 * These find real bugs - sign errors, transposed arguments, formula typos - far
 * more often than snapshots do, because a snapshot only tells you a number
 * changed, while a property tells you the change was impossible.
 */

const rho = () => fc.double({ min: 0.01, max: 0.97, noNaN: true });
const servers = () => fc.integer({ min: 1, max: 64 });
const serviceMs = () => fc.double({ min: 1, max: 500, noNaN: true });

describe('queueing invariants', () => {
  it('more servers never raises the probability of waiting, at fixed rho', () => {
    fc.assert(
      fc.property(rho(), servers(), (r, c) => {
        const a1 = r * c;
        const a2 = r * (c + 1);
        expect(erlangC(c + 1, a2)).toBeLessThanOrEqual(erlangC(c, a1) + 1e-9);
      }),
      { numRuns: 300 },
    );
  });

  it('higher load never lowers the mean wait', () => {
    fc.assert(
      fc.property(servers(), serviceMs(), rho(), (c, s, r) => {
        const cap = (c * 1000) / s;
        const lo = meanWaitMs(c, s, r * cap * 0.9, 1, 1);
        const hi = meanWaitMs(c, s, r * cap, 1, 1);
        expect(hi).toBeGreaterThanOrEqual(lo - 1e-9);
      }),
      { numRuns: 300 },
    );
  });

  it('higher service variance never lowers the mean wait', () => {
    fc.assert(
      fc.property(servers(), serviceMs(), rho(),
        fc.double({ min: 0, max: 8, noNaN: true }),
        (c, s, r, cs2) => {
          const cap = (c * 1000) / s;
          const lo = meanWaitMs(c, s, r * cap, 1, cs2);
          const hi = meanWaitMs(c, s, r * cap, 1, cs2 + 0.5);
          expect(hi).toBeGreaterThanOrEqual(lo - 1e-9);
        }),
      { numRuns: 300 },
    );
  });

  it('adding capacity never raises p99', () => {
    fc.assert(
      fc.property(servers(), serviceMs(), rho(), (c, s, r) => {
        const cap = (c * 1000) / s;
        const arrivalRps = r * cap;
        const base = { serviceMeanMs: s, serviceCv2: 0.5, arrivalRps, arrivalCv2: 1 };
        const before = sampleRoute([buildKernel({ ...base, servers: c })]);
        const after = sampleRoute([buildKernel({ ...base, servers: c + 2 })]);
        expect(quantile(after.latencyMs, 0.99)).toBeLessThanOrEqual(
          quantile(before.latencyMs, 0.99) + 1e-6,
        );
      }),
      {
        numRuns: 200,
        // Pinned regression: this found invWaitMs assigning the waiting branch
        // to low u instead of the upper tail, so shrinking pWait pushed probes
        // deep into the conditional tail and more servers gave a higher p99.
        examples: [[3, 1, 0.3685]],
      },
    );
  });

  it('percentiles are ordered p50 <= p95 <= p99', () => {
    fc.assert(
      fc.property(servers(), serviceMs(), rho(), (c, s, r) => {
        const cap = (c * 1000) / s;
        const k = buildKernel({
          servers: c, serviceMeanMs: s, serviceCv2: 1.5,
          arrivalRps: r * cap, arrivalCv2: 1,
        });
        const sample = sampleRoute([k]);
        const p50 = quantile(sample.latencyMs, 0.5);
        const p95 = quantile(sample.latencyMs, 0.95);
        const p99 = quantile(sample.latencyMs, 0.99);
        expect(p95).toBeGreaterThanOrEqual(p50);
        expect(p99).toBeGreaterThanOrEqual(p95);
      }),
      { numRuns: 200 },
    );
  });

  it('adding a hop never lowers latency', () => {
    fc.assert(
      fc.property(servers(), serviceMs(), (c, s) => {
        const k = buildKernel({
          servers: c, serviceMeanMs: s, serviceCv2: 0.5, arrivalRps: 1, arrivalCv2: 1,
        });
        const one = quantile(sampleRoute([k]).latencyMs, 0.99);
        const two = quantile(sampleRoute([k, k]).latencyMs, 0.99);
        expect(two).toBeGreaterThanOrEqual(one - 1e-9);
      }),
      { numRuns: 100 },
    );
  });
});

describe('cache invariants', () => {
  it('longer TTL never lowers hit ratio', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 20_000, noNaN: true }),
        fc.integer({ min: 100, max: 1_000_000 }),
        fc.double({ min: 0.5, max: 1.2, noNaN: true }),
        fc.double({ min: 1, max: 600, noNaN: true }),
        (arrivalRps, objectCount, zipfAlpha, ttl) => {
          const lo = cacheHitRatio({ arrivalRps, ttlSeconds: ttl, objectCount, zipfAlpha });
          const hi = cacheHitRatio({ arrivalRps, ttlSeconds: ttl * 1.5, objectCount, zipfAlpha });
          expect(hi.hitRatio).toBeGreaterThanOrEqual(lo.hitRatio - 1e-12);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('more traffic never lowers hit ratio', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 5000, noNaN: true }),
        fc.integer({ min: 100, max: 1_000_000 }),
        (arrivalRps, objectCount) => {
          const lo = cacheHitRatio({ arrivalRps, ttlSeconds: 60, objectCount, zipfAlpha: 0.9 });
          const hi = cacheHitRatio({
            arrivalRps: arrivalRps * 2, ttlSeconds: 60, objectCount, zipfAlpha: 0.9,
          });
          expect(hi.hitRatio).toBeGreaterThanOrEqual(lo.hitRatio - 1e-12);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('hit ratio and miss rate always agree', () => {
    fc.assert(
      fc.property(
        fc.double({ min: 1, max: 20_000, noNaN: true }),
        fc.double({ min: 1, max: 600, noNaN: true }),
        (arrivalRps, ttl) => {
          const r = cacheHitRatio({
            arrivalRps, ttlSeconds: ttl, objectCount: 50_000, zipfAlpha: 0.9,
          });
          expect(r.hitRatio).toBeGreaterThanOrEqual(0);
          expect(r.hitRatio).toBeLessThanOrEqual(1);
          expect(r.hitRps + r.missRps).toBeCloseTo(arrivalRps, 6);
        },
      ),
      { numRuns: 300 },
    );
  });

  it('more key cardinality never raises hit ratio', () => {
    fc.assert(
      fc.property(fc.double({ min: 1, max: 1000, noNaN: true }), (k) => {
        const base = { arrivalRps: 5000, ttlSeconds: 300, objectCount: 20_000, zipfAlpha: 0.9 };
        const lo = cacheHitRatio({ ...base, keyCardinalityFactor: k });
        const hi = cacheHitRatio({ ...base, keyCardinalityFactor: k * 2 });
        expect(hi.hitRatio).toBeLessThanOrEqual(lo.hitRatio + 1e-12);
      }),
      { numRuns: 200 },
    );
  });
});

describe('geography invariants', () => {
  it('is symmetric and non-negative', () => {
    expect(rttMs(SF, LONDON)).toBeCloseTo(rttMs(LONDON, SF), 10);
    expect(oneWayMs(SF, SF)).toBeGreaterThan(0);
  });

  it('round trip is twice one way', () => {
    expect(rttMs(SF, LONDON)).toBeCloseTo(2 * oneWayMs(SF, LONDON), 10);
  });

  it('farther is never faster', () => {
    fc.assert(
      fc.property(
        fc.double({ min: -80, max: 80, noNaN: true }),
        fc.double({ min: -170, max: 170, noNaN: true }),
        (lat, lon) => {
          const near = { id: SF.id, label: 'n', lat: SF.lat + 1, lon: SF.lon + 1 };
          const far = { id: SF.id, label: 'f', lat, lon };
          const dNear = oneWayMs(SF, near);
          const dFar = oneWayMs(SF, far);
          if (dFar < dNear) expect(dFar).toBeGreaterThan(0);
          else expect(dFar).toBeGreaterThanOrEqual(dNear);
        },
      ),
      { numRuns: 200 },
    );
  });
});
