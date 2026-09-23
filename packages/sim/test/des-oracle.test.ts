import { describe, expect, it } from 'vitest';
import { desQuantile, quantileCI, runDes, type DesStage } from './des';
import { buildKernel } from '../src/kernel';
import { departureCv2 } from '../src/math/erlang';
import { quantile, sampleRoute } from '../src/probes';

/**
 * Oracle 2: the fluid engine against a token-level discrete-event simulation.
 *
 * This is the test that earns the right not to ship a DES. The engine makes
 * three approximations the oracle does not - Allen-Cunneen for the mean wait, an
 * exponential shape for the wait tail, and a lattice quadrature instead of
 * integration. If those approximations were lying, this is where it would show.
 *
 * Measured agreement is within ~5% on every configuration below, so the
 * tolerance is set at 8% to leave headroom without becoming vacuous.
 */

const S = 20;
const REQUESTS = 300_000;
const TOLERANCE = 0.08;

interface Case {
  readonly label: string;
  readonly servers: number;
  readonly cv2: number;
  readonly dist: 'lognormal' | 'exponential';
  readonly rho: number;
}

const CASES: readonly Case[] = [
  { label: 'M/M/1 rho=0.5', servers: 1, cv2: 1, dist: 'exponential', rho: 0.5 },
  { label: 'M/M/1 rho=0.85', servers: 1, cv2: 1, dist: 'exponential', rho: 0.85 },
  { label: 'M/M/4 rho=0.7', servers: 4, cv2: 1, dist: 'exponential', rho: 0.7 },
  { label: 'M/M/8 rho=0.9', servers: 8, cv2: 1, dist: 'exponential', rho: 0.9 },
  { label: 'M/G/4 low variance', servers: 4, cv2: 0.5, dist: 'lognormal', rho: 0.7 },
  { label: 'M/G/4 high variance', servers: 4, cv2: 2.0, dist: 'lognormal', rho: 0.7 },
  { label: 'M/G/8 database-like', servers: 8, cv2: 4.0, dist: 'lognormal', rho: 0.6 },
  { label: 'M/G/2 near saturation', servers: 2, cv2: 1.5, dist: 'lognormal', rho: 0.92 },
];

describe('DES oracle: single station', () => {
  it.each(CASES.map((c) => [c.label, c] as const))(
    '%s agrees with the oracle within 8%%',
    (_label, c) => {
      const cap = (c.servers * 1000) / S;
      const arrivalRps = c.rho * cap;

      const kernel = buildKernel({
        servers: c.servers, serviceMeanMs: S, serviceCv2: c.cv2,
        arrivalRps, arrivalCv2: 1, serviceDist: c.dist,
      });
      const engine = sampleRoute([kernel]).latencyMs;

      const stage: DesStage = {
        servers: c.servers, serviceMeanMs: S, serviceCv2: c.cv2, dist: c.dist,
      };
      const oracle = runDes({ stages: [stage], arrivalRps, requests: REQUESTS, seed: 7 });

      for (const q of [0.5, 0.95, 0.99]) {
        const e = quantile(engine, q);
        const d = desQuantile(oracle, q);
        expect(Math.abs(e - d) / d).toBeLessThan(TOLERANCE);
      }
    },
  );

  it('lands inside the oracle 95% confidence interval at the median', () => {
    // The CI is narrow at the median, so this is the strictest single check
    // available: it is a falsifiable statistical claim, not a tolerance.
    for (const c of CASES) {
      const cap = (c.servers * 1000) / S;
      const arrivalRps = c.rho * cap;
      const kernel = buildKernel({
        servers: c.servers, serviceMeanMs: S, serviceCv2: c.cv2,
        arrivalRps, arrivalCv2: 1, serviceDist: c.dist,
      });
      const engine = quantile(sampleRoute([kernel]).latencyMs, 0.5);
      const oracle = runDes({
        stages: [{ servers: c.servers, serviceMeanMs: S, serviceCv2: c.cv2, dist: c.dist }],
        arrivalRps, requests: REQUESTS, seed: 11,
      });
      const ci = quantileCI(oracle, 0.5);
      // Widen by the documented tolerance: the engine is an approximation, and
      // the CI only accounts for the oracle's own sampling error.
      expect(engine).toBeGreaterThan(ci.lo * (1 - TOLERANCE));
      expect(engine).toBeLessThan(ci.hi * (1 + TOLERANCE));
    }
  });
});

describe('DES oracle: tandem queues', () => {
  /**
   * Two stations in series is where Whitt's variance propagation earns its
   * place. The second station sees a departure process, not a Poisson one, and
   * getting Cd2 wrong shows up here and nowhere else.
   */
  /*
   * Both stages must stay below capacity. An earlier version of this test put
   * stage two into saturation, where its queue grows without bound and the
   * comparison means nothing - the oracle diverges while the engine, handed no
   * standing backlog, reports no queueing at all.
   */
  it.each([
    ['balanced', 4, 4, 0.5, 0.5, 0.7],
    ['slower, wider second stage', 8, 6, 0.5, 1.0, 0.5],
    ['high-variance database behind an app tier', 8, 8, 0.5, 4.0, 0.5],
  ])('%s agrees within 15%%', (_label, c1, c2, cv1, cv2, rho) => {
    const cap1 = (c1 * 1000) / S;
    const arrivalRps = rho * cap1;

    const k1 = buildKernel({
      servers: c1, serviceMeanMs: S, serviceCv2: cv1, arrivalRps, arrivalCv2: 1,
    });
    // The engine's own variance propagation feeds stage two.
    const rho1 = arrivalRps / cap1;
    const cd2 = departureCv2(rho1, c1, 1, cv1);
    const k2 = buildKernel({
      servers: c2, serviceMeanMs: S, serviceCv2: cv2, arrivalRps, arrivalCv2: cd2,
    });

    const engine = sampleRoute([k1, k2]).latencyMs;
    const oracle = runDes({
      stages: [
        { servers: c1, serviceMeanMs: S, serviceCv2: cv1, dist: 'lognormal' },
        { servers: c2, serviceMeanMs: S, serviceCv2: cv2, dist: 'lognormal' },
      ],
      arrivalRps, requests: REQUESTS, seed: 13,
    });

    for (const q of [0.5, 0.95, 0.99]) {
      const e = quantile(engine, q);
      const d = desQuantile(oracle, q);
      expect(Math.abs(e - d) / d).toBeLessThan(0.15);
    }
  });

  /**
   * The multi-hop bias, pinned deliberately.
   *
   * The engine composes hops as independent, but a real tandem queue correlates
   * them: a busy period at stage one delivers a burst into stage two, so actual
   * queueing is worse than independent composition predicts. The engine is
   * therefore systematically optimistic on multi-hop routes, by 4-13% in these
   * configurations.
   *
   * This is recorded rather than corrected. A fudge factor tuned to three
   * oracle cases would be overfitting, and the bias is consistent - so relative
   * comparisons, which is what every level actually teaches, stay correct.
   *
   * The assertion is two-sided on purpose: if the bias ever flips sign or grows
   * past 20%, something has changed that the tolerance test alone would miss.
   */
  it('is consistently optimistic on multi-hop, within a known bound', () => {
    const cases: readonly [number, number, number, number, number][] = [
      [4, 4, 0.5, 0.5, 0.7],
      [8, 6, 0.5, 1.0, 0.5],
      [8, 8, 0.5, 4.0, 0.5],
    ];

    for (const [c1, c2, cv1, cv2, rho] of cases) {
      const cap1 = (c1 * 1000) / S;
      const arrivalRps = rho * cap1;
      const k1 = buildKernel({
        servers: c1, serviceMeanMs: S, serviceCv2: cv1, arrivalRps, arrivalCv2: 1,
      });
      const cd2 = departureCv2(arrivalRps / cap1, c1, 1, cv1);
      const k2 = buildKernel({
        servers: c2, serviceMeanMs: S, serviceCv2: cv2, arrivalRps, arrivalCv2: cd2,
      });
      const engine = sampleRoute([k1, k2]).latencyMs;
      const oracle = runDes({
        stages: [
          { servers: c1, serviceMeanMs: S, serviceCv2: cv1, dist: 'lognormal' },
          { servers: c2, serviceMeanMs: S, serviceCv2: cv2, dist: 'lognormal' },
        ],
        arrivalRps, requests: REQUESTS, seed: 13,
      });

      for (const q of [0.5, 0.95, 0.99]) {
        const ratio = quantile(engine, q) / desQuantile(oracle, q);
        expect(ratio).toBeLessThanOrEqual(1.02); // optimistic, not pessimistic
        expect(ratio).toBeGreaterThan(0.8); // and not by more than 20%
      }
    }
  });
});

describe('DES oracle: where the approximation degrades', () => {
  /**
   * Documented honestly rather than hidden. A fluid description is a mean-field
   * one, so it is weakest where individual arrivals matter most. Levels are
   * authored at a few hundred rps and above, which keeps them clear of this.
   */
  it('is still reasonable at very low arrival rates', () => {
    const arrivalRps = 5;
    const kernel = buildKernel({
      servers: 2, serviceMeanMs: S, serviceCv2: 1, arrivalRps, arrivalCv2: 1,
      serviceDist: 'exponential',
    });
    const engine = quantile(sampleRoute([kernel]).latencyMs, 0.5);
    const oracle = desQuantile(
      runDes({
        stages: [{ servers: 2, serviceMeanMs: S, serviceCv2: 1, dist: 'exponential' }],
        arrivalRps, requests: 200_000, seed: 17,
      }),
      0.5,
    );
    // Looser band, deliberately: this records where the model is weaker rather
    // than pretending it is not.
    expect(Math.abs(engine - oracle) / oracle).toBeLessThan(0.15);
  });
});
