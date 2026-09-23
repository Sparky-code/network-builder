import type { LatencyKernel } from './kernel';
import { invServiceMs, invWaitMs } from './kernel';
import type { LatencyWaterfall } from '@nb/schema';

/**
 * A fixed stratified probe set for composing kernels along a route.
 *
 * This is the quiet keystone of the engine. Convolving histograms would be
 * O(bins^2) per route and too slow; drawing random samples would be fast but
 * would make percentiles jump discontinuously under small topology changes,
 * so a player who adds one replica would see p99 move for reasons unrelated
 * to their change.
 *
 * A Kronecker lattice gives both properties at once:
 *   - deterministic: these are compiled constants and never touch the RNG, so
 *     nothing elsewhere in the engine can perturb a graded number;
 *   - smooth: each dimension is perfectly equidistributed, so percentiles move
 *     continuously as inputs move.
 */

/**
 * 1024 rather than 256. At 256 probes the p99 order statistic sits about 2.5
 * samples from the top, which is too coarse to resolve the tail the game grades
 * on. 1024 puts ~10 samples above p99 and still costs only a few ms per run.
 */
export const PROBE_COUNT = 1024;

/** Two uniforms (wait, service) per hop. */
export const MAX_HOPS = 16;
const DIMS = MAX_HOPS * 2;

/** First DIMS primes; irrational sqrt gives a well-distributed lattice. */
const PRIMES = [
  2, 3, 5, 7, 11, 13, 17, 19, 23, 29, 31, 37, 41, 43, 47, 53,
  59, 61, 67, 71, 73, 79, 83, 89, 97, 101, 103, 107, 109, 113, 127, 131,
] as const;

/**
 * PROBE_COUNT x DIMS uniforms in [0,1), laid out row-major by probe.
 * Built once at module load; never mutated.
 */
const LATTICE: Float64Array = (() => {
  const t = new Float64Array(PROBE_COUNT * DIMS);
  for (let d = 0; d < DIMS; d++) {
    const alpha = Math.sqrt(PRIMES[d] ?? 2) % 1;
    for (let i = 0; i < PROBE_COUNT; i++) {
      // Half-open: the 0.5 offset keeps us away from both 0 and 1, where the
      // inverse CDFs are unbounded.
      const u = (0.5 + (i + 1) * alpha) % 1;
      t[i * DIMS + d] = u === 0 ? Number.EPSILON : u;
    }
  }
  return t;
})();

export function probeUniform(probe: number, dim: number): number {
  return LATTICE[probe * DIMS + (dim % DIMS)] ?? 0.5;
}

export interface RouteSample {
  /** Sorted end-to-end latencies, one per probe. */
  readonly latencyMs: Float64Array;
  /** Category breakdown of the probe that landed nearest each reported quantile. */
  readonly waterfallAt: (q: number) => LatencyWaterfall;
}

/**
 * Compose kernels along one route into a sorted latency population.
 *
 * Each probe walks every hop, drawing its wait and service uniforms from
 * distinct lattice dimensions so the hops stay independent.
 */
export function sampleRoute(kernels: readonly LatencyKernel[]): RouteSample {
  const hops = Math.min(kernels.length, MAX_HOPS);
  const total = new Float64Array(PROBE_COUNT);

  // Per-probe attribution, kept so the waterfall reports a real sample rather
  // than an average of unlike things.
  const dns = new Float64Array(PROBE_COUNT);
  const setup = new Float64Array(PROBE_COUNT);
  const prop = new Float64Array(PROBE_COUNT);
  const transfer = new Float64Array(PROBE_COUNT);
  const queue = new Float64Array(PROBE_COUNT);
  const service = new Float64Array(PROBE_COUNT);

  for (let h = 0; h < hops; h++) {
    const k = kernels[h];
    if (k === undefined) continue;
    const dWait = h * 2;
    const dSvc = h * 2 + 1;
    for (let i = 0; i < PROBE_COUNT; i++) {
      const w = invWaitMs(k, probeUniform(i, dWait));
      const s = invServiceMs(k, probeUniform(i, dSvc));
      queue[i] = (queue[i] ?? 0) + w;
      service[i] = (service[i] ?? 0) + s;
      dns[i] = (dns[i] ?? 0) + k.fixed.dnsMs;
      setup[i] = (setup[i] ?? 0) + k.fixed.setupMs;
      prop[i] = (prop[i] ?? 0) + k.fixed.propagationMs;
      transfer[i] = (transfer[i] ?? 0) + k.fixed.transferMs;
      total[i] = (total[i] ?? 0) + k.fixedMs + w + s;
    }
  }

  // Sort an index permutation so attribution stays aligned with its latency.
  const order = Array.from({ length: PROBE_COUNT }, (_, i) => i);
  order.sort((x, y) => (total[x] ?? 0) - (total[y] ?? 0) || x - y);

  const sorted = new Float64Array(PROBE_COUNT);
  for (let i = 0; i < PROBE_COUNT; i++) sorted[i] = total[order[i] ?? 0] ?? 0;

  const waterfallAt = (q: number): LatencyWaterfall => {
    const i = order[quantileIndex(q)] ?? 0;
    return {
      dnsMs: dns[i] ?? 0,
      setupMs: setup[i] ?? 0,
      propagationMs: prop[i] ?? 0,
      queueMs: queue[i] ?? 0,
      serviceMs: service[i] ?? 0,
      transferMs: transfer[i] ?? 0,
    };
  };

  return { latencyMs: sorted, waterfallAt };
}

export function quantileIndex(q: number): number {
  const i = Math.ceil(q * PROBE_COUNT) - 1;
  return Math.min(PROBE_COUNT - 1, Math.max(0, i));
}

/** Read a quantile from an already-sorted population. */
export function quantile(sorted: Float64Array, q: number): number {
  if (sorted.length === 0) return 0;
  return sorted[Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1))] ?? 0;
}

/** Fraction of the population at or beyond a threshold — used for timeout rates. */
export function tailFraction(sorted: Float64Array, thresholdMs: number): number {
  let lo = 0;
  let hi = sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((sorted[mid] ?? 0) < thresholdMs) lo = mid + 1;
    else hi = mid;
  }
  return (sorted.length - lo) / sorted.length;
}
