/**
 * Counter-based, stateless pseudo-randomness.
 *
 * This is the highest-leverage determinism rule in the engine. With a single
 * shared mutable stream, adding a visual effect that consumes one random number
 * silently shifts every graded number downstream of it — a bug that is nearly
 * impossible to attribute weeks later.
 *
 * Here every draw is a pure function of (seed, purpose, tick, index), so
 * `purpose: 'viz'` cannot perturb `purpose: 'demand-jitter'` by construction
 * rather than by discipline.
 *
 * Note: route probes do not use this at all. They are compiled constants —
 * see probes.ts.
 */

const MASK64 = (1n << 64n) - 1n;
const GOLDEN = 0x9e3779b97f4a7c15n;
const MIX1 = 0xbf58476d1ce4e5b9n;
const MIX2 = 0x94d049bb133111ebn;

function splitmix64(x: bigint): bigint {
  let z = (x + GOLDEN) & MASK64;
  z = ((z ^ (z >> 30n)) * MIX1) & MASK64;
  z = ((z ^ (z >> 27n)) * MIX2) & MASK64;
  return (z ^ (z >> 31n)) & MASK64;
}

/** FNV-1a over the purpose label, so purposes are named rather than numbered. */
function hashPurpose(purpose: string): bigint {
  let h = 0x811c9dc5;
  for (let i = 0; i < purpose.length; i++) {
    h ^= purpose.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return BigInt(h);
}

const purposeCache = new Map<string, bigint>();

function purposeKey(purpose: string): bigint {
  let k = purposeCache.get(purpose);
  if (k === undefined) {
    k = hashPurpose(purpose);
    purposeCache.set(purpose, k);
  }
  return k;
}

/**
 * A uniform in [0, 1). Deterministic in its arguments and nothing else.
 *
 * Uses the top 53 bits so the result is exactly representable, giving
 * bit-identical output across JS engines (integer ops and division by a power
 * of two are IEEE-754 exact).
 */
export function rng(seed: number, purpose: string, tick: number, index: number): number {
  const mixed =
    (BigInt(seed >>> 0) ^ (purposeKey(purpose) << 17n) ^ (BigInt(tick) << 33n) ^ BigInt(index)) &
    MASK64;
  return Number(splitmix64(mixed) >> 11n) / 2 ** 53;
}

/** Stable 32-bit hash of a string, for `inputHash`. Not cryptographic. */
export function hashString(s: string): string {
  let h1 = 0xdeadbeef;
  let h2 = 0x41c6ce57;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    h1 = Math.imul(h1 ^ c, 2654435761) >>> 0;
    h2 = Math.imul(h2 ^ c, 1597334677) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, '0') + (h2 >>> 0).toString(16).padStart(8, '0');
}
