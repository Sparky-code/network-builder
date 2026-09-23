import { rng } from '../src/rng';
import { invNorm } from '../src/math/invnorm';

/**
 * A token-level discrete-event simulator, used ONLY as a test oracle.
 *
 * This is deliberately not shipped. It exists so the fluid engine can be checked
 * against an independent model that makes none of its approximations: every
 * request is a distinct entity, FCFS, with real interarrival and service draws.
 *
 * Writing it is how we earn the right not to ship one - see ADR 0001.
 */

export interface DesStage {
  readonly servers: number;
  readonly serviceMeanMs: number;
  readonly serviceCv2: number;
  readonly dist: 'lognormal' | 'exponential';
}

function exponential(mean: number, u: number): number {
  return -mean * Math.log(1 - u);
}

function lognormal(mean: number, cv2: number, u: number): number {
  if (cv2 <= 0) return mean;
  const s2 = Math.log(1 + cv2);
  return Math.exp(Math.log(mean) - s2 / 2 + Math.sqrt(s2) * invNorm(u));
}

function serviceDraw(stage: DesStage, u: number): number {
  return stage.dist === 'exponential'
    ? exponential(stage.serviceMeanMs, u)
    : lognormal(stage.serviceMeanMs, stage.serviceCv2, u);
}

/**
 * Simulate a tandem FCFS queueing network with Poisson arrivals.
 * Returns sorted end-to-end sojourn times in ms, warmup discarded.
 */
export function runDes(opts: {
  stages: readonly DesStage[];
  arrivalRps: number;
  requests: number;
  seed: number;
  warmupFraction?: number;
}): Float64Array {
  const { stages, arrivalRps, requests, seed } = opts;
  const warmup = Math.floor(requests * (opts.warmupFraction ?? 0.2));
  const meanInterarrivalMs = 1000 / arrivalRps;

  // Per-stage server availability times.
  const free: Float64Array[] = stages.map((s) => new Float64Array(s.servers));

  const sojourns = new Float64Array(requests - warmup);
  let arrival = 0;

  for (let n = 0; n < requests; n++) {
    arrival += exponential(meanInterarrivalMs, rng(seed, 'des-arrival', 0, n));
    let t = arrival;

    for (let si = 0; si < stages.length; si++) {
      const stage = stages[si];
      const avail = free[si];
      if (stage === undefined || avail === undefined) continue;

      // Earliest-free server: exact FCFS for M/G/c.
      let best = 0;
      let bestTime = avail[0] ?? 0;
      for (let k = 1; k < avail.length; k++) {
        const f = avail[k] ?? 0;
        if (f < bestTime) { bestTime = f; best = k; }
      }

      const start = Math.max(t, bestTime);
      const service = serviceDraw(stage, rng(seed, `des-service-${si}`, 0, n));
      avail[best] = start + service;
      t = start + service;
    }

    if (n >= warmup) sojourns[n - warmup] = t - arrival;
  }

  sojourns.sort();
  return sojourns;
}

export function desQuantile(sorted: Float64Array, q: number): number {
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

/**
 * 95% confidence interval for a quantile, by the binomial order-statistic
 * method. This is what turns "close enough" into a falsifiable claim.
 */
export function quantileCI(sorted: Float64Array, q: number): { lo: number; hi: number } {
  const n = sorted.length;
  const sd = Math.sqrt(n * q * (1 - q));
  const loIdx = Math.max(0, Math.floor(n * q - 1.96 * sd));
  const hiIdx = Math.min(n - 1, Math.ceil(n * q + 1.96 * sd));
  return { lo: sorted[loIdx] ?? 0, hi: sorted[hiIdx] ?? 0 };
}
