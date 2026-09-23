import { describe, expect, it } from 'vitest';
import { erlangB, erlangC, meanWaitMs } from '../src/math/erlang';
import { buildKernel, invKernel } from '../src/kernel';
import { PROBE_COUNT, probeUniform, quantile } from '../src/probes';

/**
 * Oracle 1: textbook queueing theory.
 *
 * These are closed-form identities, not tolerances-by-taste. If the engine
 * disagrees with M/M/1 it is wrong, and no amount of UI rescues it.
 */
describe('analytic oracle: M/M/1', () => {
  const S = 20; // ms mean service
  const mu = 1000 / S; // 50 rps

  it.each([0.3, 0.5, 0.7, 0.85, 0.95])('P(wait) equals rho at rho=%s', (rho) => {
    const a = rho; // c=1, so offered load in erlangs == rho
    expect(erlangC(1, a)).toBeCloseTo(rho, 10);
  });

  it.each([0.3, 0.5, 0.7, 0.85, 0.95])('mean wait matches rho*S/(1-rho) at rho=%s', (rho) => {
    const lambda = rho * mu;
    const expected = (rho * S) / (1 - rho);
    expect(meanWaitMs(1, S, lambda, 1, 1)).toBeCloseTo(expected, 8);
  });

  it('erlangB reduces to a/(1+a) for a single server', () => {
    for (const a of [0.1, 0.5, 1, 2, 5]) {
      expect(erlangB(1, a)).toBeCloseTo(a / (1 + a), 12);
    }
  });

  /**
   * The exact M/M/1 sojourn is Exp(mu - lambda), so the q-quantile is
   * -ln(1-q)/(mu-lambda). This holds only with exponential service, which is
   * why the kernel exposes serviceDist: production stations use lognormal, and
   * this oracle uses exponential to get an exact check on the composition.
   */
  it.each([0.5, 0.7, 0.9])('sojourn quantiles match -ln(1-q)/(mu-lambda) at rho=%s', (rho) => {
    const lambda = rho * mu;
    const k = buildKernel({
      servers: 1, serviceMeanMs: S, serviceCv2: 1,
      arrivalRps: lambda, arrivalCv2: 1, serviceDist: 'exponential',
    });

    const samples = new Float64Array(PROBE_COUNT);
    for (let i = 0; i < PROBE_COUNT; i++) {
      samples[i] = invKernel(k, probeUniform(i, 0), probeUniform(i, 1));
    }
    samples.sort();

    const rateHz = (mu - lambda) / 1000; // per ms
    for (const q of [0.5, 0.9, 0.99]) {
      const expected = -Math.log(1 - q) / rateHz;
      const actual = quantile(samples, q);
      // 6% band: the lattice is a quadrature rule, not an exact integrator.
      expect(Math.abs(actual - expected) / expected).toBeLessThan(0.06);
    }
  });
});

describe('analytic oracle: M/M/c', () => {
  /** Erlang C published values, to four decimals. */
  it.each([
    [2, 1.0, 0.3333],
    [3, 2.0, 0.4444],
    [5, 3.0, 0.2362],
    [10, 8.0, 0.4092],
  ])('erlangC(c=%i, a=%f) = %f', (c, a, expected) => {
    expect(erlangC(c, a)).toBeCloseTo(expected, 3);
  });

  it('adding servers strictly lowers the probability of waiting', () => {
    let prev = 1;
    for (const c of [1, 2, 3, 4, 8, 16]) {
      const p = erlangC(c, 0.9 * c > 1 ? 0.9 : 0.9);
      expect(p).toBeLessThanOrEqual(prev + 1e-12);
      prev = p;
    }
  });
});

describe('the hockey stick', () => {
  /**
   * The single most important intuition in the game: p99 explodes long before
   * capacity runs out. A station at 85% is not "15% away from trouble".
   */
  it('mean wait grows superlinearly in rho', () => {
    const S = 20;
    const mu = 1000 / S;
    const w50 = meanWaitMs(1, S, 0.5 * mu, 1, 1);
    const w85 = meanWaitMs(1, S, 0.85 * mu, 1, 1);
    const w95 = meanWaitMs(1, S, 0.95 * mu, 1, 1);

    expect(w85 / w50).toBeGreaterThan(5);
    expect(w95 / w85).toBeGreaterThan(3);
  });

  it('service-time variance can beat utilization, within a range', () => {
    // Level 9's lesson, as an assertion: a database at 60% with Cv2=4 queues
    // worse than an app server at 80% with Cv2=0.5.
    const S = 20;
    const mu = 1000 / S;
    const db = meanWaitMs(1, S, 0.6 * mu, 1, 4.0);
    const appAt80 = meanWaitMs(1, S, 0.8 * mu, 1, 0.5);
    expect(db).toBeGreaterThan(appAt80);

    // But the effect is bounded, and an earlier draft of the docs claimed more
    // than is true. By rho=0.85 the low-variance station is worse again, so the
    // level has to be authored inside the range where the lesson holds.
    const appAt85 = meanWaitMs(1, S, 0.85 * mu, 1, 0.5);
    expect(appAt85).toBeGreaterThan(db);
  });
});
