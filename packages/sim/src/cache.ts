/**
 * TTL cache hit ratio, from the exact renewal result rather than by simulating
 * individual objects.
 *
 * For an object requested at rate lambda_i behind a TTL of T seconds, exactly
 * one request per TTL window misses:
 *
 *   missRate_i = lambda_i / (1 + lambda_i * T)
 *
 * Bucketing a Zipf population into log-spaced popularity groups makes the whole
 * calculation O(buckets) per tick instead of O(objects).
 *
 * Three lessons fall out of this formula with no extra engineering:
 *   1. hit ratio improves with traffic volume - more requests amortise the miss;
 *   2. splitting traffic across n PoPs *lowers* per-PoP hit ratio, because each
 *      sees lambda/n and so amortises fewer misses per window;
 *   3. an origin shield fixes (2) by re-aggregating the miss stream.
 */

const BUCKET_COUNT = 48;

interface PopulationBuckets {
  /** Objects represented by each bucket. */
  readonly counts: Float64Array;
  /** Share of total request rate landing on ONE object in each bucket. */
  readonly shares: Float64Array;
}

const cache = new Map<string, PopulationBuckets>();

/**
 * Log-spaced buckets over Zipf ranks 1..N.
 *
 * Log spacing matters: Zipf is dominated by the head, so uniform bucketing
 * would lump the few hot objects that drive hit ratio in with thousands of
 * cold ones and wash out the effect the player is meant to see.
 */
export function zipfBuckets(count: number, alpha: number): PopulationBuckets {
  const key = `${count}:${alpha}`;
  const hit = cache.get(key);
  if (hit !== undefined) return hit;

  const edges: number[] = [];
  const logN = Math.log(count);
  for (let b = 0; b <= BUCKET_COUNT; b++) {
    edges.push(Math.exp((logN * b) / BUCKET_COUNT));
  }

  const counts = new Float64Array(BUCKET_COUNT);
  const weights = new Float64Array(BUCKET_COUNT);
  let total = 0;

  for (let b = 0; b < BUCKET_COUNT; b++) {
    const lo = Math.max(1, Math.ceil(edges[b] ?? 1));
    const hi = Math.min(count, Math.floor(edges[b + 1] ?? count));
    const n = Math.max(0, hi - lo + 1);
    if (n === 0) continue;
    // Geometric-mean rank represents the bucket.
    const rank = Math.sqrt(lo * hi);
    const w = Math.pow(rank, -alpha);
    counts[b] = n;
    weights[b] = w;
    total += n * w;
  }

  const shares = new Float64Array(BUCKET_COUNT);
  if (total > 0) {
    for (let b = 0; b < BUCKET_COUNT; b++) shares[b] = (weights[b] ?? 0) / total;
  }

  const built = { counts, shares };
  cache.set(key, built);
  return built;
}

export interface CacheInput {
  /** Total cacheable request rate arriving at THIS cache. */
  readonly arrivalRps: number;
  readonly ttlSeconds: number;
  readonly objectCount: number;
  readonly zipfAlpha: number;
  /** 0..1 fill level. Effective hit ratio scales by this after a purge. */
  readonly warmth?: number;
  /**
   * Multiplier on effective key cardinality. A tracking query string appended
   * to every URL raises this and collapses hit ratio - level 12.
   */
  readonly keyCardinalityFactor?: number;
}

export interface CacheResult {
  readonly hitRatio: number;
  readonly missRps: number;
  readonly hitRps: number;
}

export function cacheHitRatio(input: CacheInput): CacheResult {
  const {
    arrivalRps, ttlSeconds, objectCount, zipfAlpha,
    warmth = 1, keyCardinalityFactor = 1,
  } = input;

  if (arrivalRps <= 0) return { hitRatio: 0, missRps: 0, hitRps: 0 };
  if (ttlSeconds <= 0) {
    return { hitRatio: 0, missRps: arrivalRps, hitRps: 0 };
  }

  const { counts, shares } = zipfBuckets(objectCount, zipfAlpha);

  /*
   * Key cardinality fragments each logical object into K cache entries, each
   * receiving lambda_i / K. Substituting into the renewal result, the K falls
   * out as a divisor on the TTL term:
   *
   *   sum_b (n_b * K) * (lambda_i/K) / (1 + (lambda_i/K) * T)
   *     = sum_b n_b * lambda_i / (1 + lambda_i * T / K)
   *
   * The distinction matters. Re-running Zipf over an inflated population would
   * re-concentrate the head and understate the damage - a tracking parameter on
   * every URL should drive hit ratio toward zero, not toward 0.5.
   */
  const k = Math.max(1, keyCardinalityFactor);

  let missRps = 0;
  for (let b = 0; b < counts.length; b++) {
    const n = counts[b] ?? 0;
    if (n === 0) continue;
    // Per-object arrival rate in this bucket, before fragmentation.
    const lambdaI = arrivalRps * (shares[b] ?? 0);
    if (lambdaI <= 0) continue;
    missRps += n * (lambdaI / (1 + (lambdaI * ttlSeconds) / k));
  }

  missRps = Math.min(arrivalRps, missRps);
  const rawHit = 1 - missRps / arrivalRps;
  const hitRatio = Math.max(0, Math.min(1, rawHit * warmth));

  return {
    hitRatio,
    missRps: arrivalRps * (1 - hitRatio),
    hitRps: arrivalRps * hitRatio,
  };
}

/**
 * Origin-facing rate once request collapsing is taken into account.
 *
 * The amplification factor (1 + lambda_i * L) explodes exactly when an object
 * is hot and the origin is slow - the moment you can least afford it. Two lines
 * of code for one of the best lessons in the game.
 */
export function stampedeAmplification(
  missRps: number,
  originLatencySec: number,
  collapsing: boolean,
): number {
  if (collapsing || missRps <= 0 || originLatencySec <= 0) return missRps;
  return missRps * (1 + missRps * originLatencySec);
}

/** Warmth relaxes toward 1 with a time constant of roughly one TTL. */
export function relaxWarmth(warmth: number, ttlSeconds: number, dtSeconds: number): number {
  if (ttlSeconds <= 0) return 1;
  const k = 1 - Math.exp(-dtSeconds / ttlSeconds);
  return Math.min(1, warmth + (1 - warmth) * k);
}
