/**
 * Queueing theory: Erlang B/C and the Allen-Cunneen M/G/c correction.
 *
 * These produce the single most important intuition in the game — the
 * 1/(1-rho) term means p99 explodes long before capacity runs out. A station
 * at 85% utilization is not "15% away from trouble".
 */

/**
 * Erlang B by the numerically stable recursion:
 *   B(0,a) = 1;  B(n,a) = a*B(n-1,a) / (n + a*B(n-1,a))
 *
 * O(c), and stable for c into the thousands — the closed form overflows.
 */
export function erlangB(c: number, a: number): number {
  if (c <= 0) return 1;
  let b = 1;
  for (let n = 1; n <= c; n++) {
    const ab = a * b;
    b = ab / (n + ab);
  }
  return b;
}

/**
 * Memoised on (c, quantized a).
 *
 * The recursion is O(c), and the tick loop calls it once per station per tick
 * with slowly-varying arguments. Without this cache a station with many service
 * slots dominates the entire run - which it did, until it was measured.
 */
const erlangCache = new Map<string, number>();
const CACHE_LIMIT = 200_000;

/** 4 significant figures: finer than anything the game reports. */
function quantize(a: number): number {
  if (a === 0) return 0;
  const mag = Math.ceil(Math.log10(Math.abs(a)));
  const f = 10 ** (4 - mag);
  return Math.round(a * f) / f;
}

/**
 * Erlang C — the probability an arrival has to wait at all.
 *
 * Only meaningful for rho < 1. Callers handle saturation with the backlog
 * integrator instead (see station.ts), because a steady-state formula has
 * nothing to say once arrivals exceed service capacity.
 *
 * An infinite-server station never queues: a client is a traffic source, not a
 * queue, and asking Erlang about it is a category error as well as a million
 * wasted iterations.
 */
export function erlangC(c: number, a: number): number {
  if (!Number.isFinite(c)) return 0;
  const rho = a / c;
  if (rho >= 1) return 1;
  if (rho <= 0) return 0;

  const qa = quantize(a);
  const key = `${c}:${qa}`;
  const hit = erlangCache.get(key);
  if (hit !== undefined) return hit;

  const b = erlangB(c, qa);
  const denom = 1 - qa / c * (1 - b);
  const value = denom <= 0 ? 1 : Math.min(1, b / denom);

  if (erlangCache.size >= CACHE_LIMIT) erlangCache.clear();
  erlangCache.set(key, value);
  return value;
}

/**
 * Mean waiting time (excluding service), Allen-Cunneen:
 *
 *   Wq = C*S / (c*(1-rho)) * (Ca2 + Cs2)/2
 *
 * The variance term is what lets a database at 60% utilization queue worse
 * than an app server at 85%. Utilization alone does not predict latency.
 *
 * Reduces to the exact M/M/1 result when c=1 and Ca2=Cs2=1.
 */
export function meanWaitMs(
  c: number,
  serviceMeanMs: number,
  arrivalRps: number,
  ca2: number,
  cs2: number,
): number {
  if (!Number.isFinite(c)) return 0;
  const a = (arrivalRps * serviceMeanMs) / 1000;
  const rho = a / c;
  if (rho >= 1) return Number.POSITIVE_INFINITY;
  const cWait = erlangC(c, a);
  return ((cWait * serviceMeanMs) / (c * (1 - rho))) * ((ca2 + cs2) / 2);
}

/**
 * Departure-process variance (Whitt / QNA):
 *   Cd2 = 1 + (1 - rho^2)(Ca2 - 1) + (rho^2/sqrt(c))(Cs2 - 1)
 *
 * Roughly fifteen lines of algebra across this file and merge/split below, and
 * it is what makes downstream numbers believable rather than arbitrary.
 */
export function departureCv2(rho: number, c: number, ca2: number, cs2: number): number {
  const r2 = Math.min(1, rho) ** 2;
  return Math.max(0, 1 + (1 - r2) * (ca2 - 1) + (r2 / Math.sqrt(c)) * (cs2 - 1));
}

/** Superposition of independent streams: rate-weighted mean of their Cd2. */
export function mergeCv2(streams: readonly { rate: number; cv2: number }[]): number {
  let totalRate = 0;
  let acc = 0;
  for (const s of streams) {
    totalRate += s.rate;
    acc += s.rate * s.cv2;
  }
  if (totalRate <= 0) return 1;
  return Math.max(0, acc / totalRate);
}

/** Bernoulli split with probability p: Cd2_p = p*Cd2 + (1 - p). */
export function splitCv2(cv2: number, p: number): number {
  return Math.max(0, p * cv2 + (1 - p));
}
