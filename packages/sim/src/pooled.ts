/**
 * Weighted pooling of route latency populations.
 *
 * Different routes carry different shares of traffic, so their samples cannot
 * simply be concatenated. Pooling with weights keeps the reported percentile a
 * property of the whole system rather than of whichever route happened to be
 * enumerated first.
 */

export interface WeightedPopulation {
  readonly values: Float64Array;
  readonly weight: number;
}

export interface PooledPopulation {
  readonly sorted: Float64Array;
  readonly cumulative: Float64Array;
  readonly totalWeight: number;
}

export function pool(populations: readonly WeightedPopulation[]): PooledPopulation {
  let n = 0;
  for (const p of populations) if (p.weight > 0) n += p.values.length;

  const pairs = new Float64Array(n * 2);
  let i = 0;
  for (const p of populations) {
    if (p.weight <= 0) continue;
    const per = p.weight / p.values.length;
    for (let j = 0; j < p.values.length; j++) {
      pairs[i * 2] = p.values[j] ?? 0;
      pairs[i * 2 + 1] = per;
      i++;
    }
  }

  const order = Array.from({ length: n }, (_, k) => k);
  order.sort((a, b) => (pairs[a * 2] ?? 0) - (pairs[b * 2] ?? 0) || a - b);

  const sorted = new Float64Array(n);
  const cumulative = new Float64Array(n);
  let acc = 0;
  for (let k = 0; k < n; k++) {
    const idx = order[k] ?? 0;
    sorted[k] = pairs[idx * 2] ?? 0;
    acc += pairs[idx * 2 + 1] ?? 0;
    cumulative[k] = acc;
  }

  return { sorted, cumulative, totalWeight: acc };
}

export function pooledQuantile(p: PooledPopulation, q: number): number {
  if (p.sorted.length === 0 || p.totalWeight <= 0) return 0;
  const target = q * p.totalWeight;
  let lo = 0;
  let hi = p.cumulative.length - 1;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((p.cumulative[mid] ?? 0) < target) lo = mid + 1;
    else hi = mid;
  }
  return p.sorted[lo] ?? 0;
}

/** Weighted fraction of the population at or beyond a threshold. */
export function pooledTailFraction(p: PooledPopulation, thresholdMs: number): number {
  if (p.sorted.length === 0 || p.totalWeight <= 0) return 0;
  let lo = 0;
  let hi = p.sorted.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if ((p.sorted[mid] ?? 0) < thresholdMs) lo = mid + 1;
    else hi = mid;
  }
  if (lo >= p.sorted.length) return 0;
  const below = lo > 0 ? (p.cumulative[lo - 1] ?? 0) : 0;
  return (p.totalWeight - below) / p.totalWeight;
}
