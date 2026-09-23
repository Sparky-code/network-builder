import { describe, expect, it } from 'vitest';
import { cacheHitRatio, relaxWarmth, stampedeAmplification } from '../src/cache';

const POP = { objectCount: 10_000, zipfAlpha: 0.9 };

/**
 * These are the Act III and Act IV lessons as assertions. Each one is a claim a
 * level makes in prose; if tuning ever makes one false, this file fails by name
 * rather than shipping a level that teaches something untrue.
 */
describe('TTL cache renewal', () => {
  it('hit ratio improves with traffic volume', () => {
    // More requests per TTL window amortise the one mandatory miss.
    const low = cacheHitRatio({ arrivalRps: 10, ttlSeconds: 60, ...POP });
    const mid = cacheHitRatio({ arrivalRps: 1000, ttlSeconds: 60, ...POP });
    const high = cacheHitRatio({ arrivalRps: 20_000, ttlSeconds: 60, ...POP });

    expect(low.hitRatio).toBeLessThan(mid.hitRatio);
    expect(mid.hitRatio).toBeLessThan(high.hitRatio);
  });

  it('hit ratio improves with TTL, monotonically', () => {
    let prev = -1;
    for (const ttl of [1, 5, 30, 60, 300, 3600]) {
      const r = cacheHitRatio({ arrivalRps: 2000, ttlSeconds: ttl, ...POP });
      expect(r.hitRatio).toBeGreaterThan(prev);
      prev = r.hitRatio;
    }
  });

  it('a TTL of zero means every request misses', () => {
    const r = cacheHitRatio({ arrivalRps: 5000, ttlSeconds: 0, ...POP });
    expect(r.hitRatio).toBe(0);
    expect(r.missRps).toBe(5000);
  });

  it('reaches the 85-95% band published for well-tuned CDNs', () => {
    // Anchor from the reference table. Object population is the lever that puts
    // a cache in the industry band: 100k objects at 5k rps behind a 5-minute
    // TTL lands at ~95%, which is where a well-run site actually sits.
    const realistic = cacheHitRatio({
      arrivalRps: 5000, ttlSeconds: 300, objectCount: 100_000, zipfAlpha: 0.9,
    });
    expect(realistic.hitRatio).toBeGreaterThan(0.85);
    expect(realistic.hitRatio).toBeLessThan(0.96);

    // A small hot catalogue exceeding 99% is correct, not a bug: the reference
    // table records 99+% for static and video workloads.
    const smallCatalogue = cacheHitRatio({ arrivalRps: 5000, ttlSeconds: 300, ...POP });
    expect(smallCatalogue.hitRatio).toBeGreaterThan(0.99);

    // A large long-tail catalogue should fall out of the band downward.
    const longTail = cacheHitRatio({
      arrivalRps: 5000, ttlSeconds: 300, objectCount: 10_000_000, zipfAlpha: 0.9,
    });
    expect(longTail.hitRatio).toBeLessThan(0.7);
  });

  /** Level 12: a query parameter in the cache key destroys hit ratio. */
  it('key cardinality collapse degrades hit ratio monotonically', () => {
    const at = (k: number): number =>
      cacheHitRatio({ arrivalRps: 5000, ttlSeconds: 300, ...POP, keyCardinalityFactor: k })
        .hitRatio;

    // Each factor-of-ten of extra cardinality costs real hit ratio.
    const series = [1, 10, 100, 1000, 5000].map(at);
    for (let i = 1; i < series.length; i++) {
      expect(series[i]!).toBeLessThan(series[i - 1]!);
    }

    expect(at(1)).toBeGreaterThan(0.99);
    expect(at(100)).toBeLessThan(0.8);
    expect(at(5000)).toBeLessThan(0.35);

    // A key unique per request - a cache-busting timestamp - is a cache that
    // does nothing at all.
    expect(at(1e7)).toBeLessThan(0.05);
  });

  /**
   * Level 17, and the most counterintuitive result in the game: adding PoPs to
   * lower latency *raises* origin load, because each PoP sees lambda/n and so
   * amortises fewer misses per TTL window.
   */
  it('splitting traffic across more PoPs lowers per-PoP hit ratio', () => {
    const total = 10_000;
    let prevHit = 1;
    let prevOriginRps = 0;

    for (const pops of [1, 2, 4, 8, 16]) {
      const perPop = cacheHitRatio({ arrivalRps: total / pops, ttlSeconds: 300, ...POP });
      const originRps = perPop.missRps * pops;

      expect(perPop.hitRatio).toBeLessThan(prevHit);
      expect(originRps).toBeGreaterThan(prevOriginRps);
      prevHit = perPop.hitRatio;
      prevOriginRps = originRps;
    }
  });

  /** Level 15: the shield re-aggregates the miss stream and undoes that. */
  it('an origin shield restores what PoP fragmentation cost', () => {
    const total = 10_000;
    const pops = 16;
    const perPop = cacheHitRatio({ arrivalRps: total / pops, ttlSeconds: 300, ...POP });
    const missToShield = perPop.missRps * pops;

    const shield = cacheHitRatio({ arrivalRps: missToShield, ttlSeconds: 300, ...POP });
    const originWithShield = shield.missRps;

    expect(originWithShield).toBeLessThan(missToShield);

    // Edge hit ratio is unchanged by the shield; total hit ratio improves. Two
    // numbers with different jobs - the level 15 lesson.
    const edgeHit = perPop.hitRatio;
    const totalHit = 1 - originWithShield / total;
    expect(totalHit).toBeGreaterThan(edgeHit);
  });

  /** The reference table's economics claim. */
  it('90% to 95% hit ratio halves origin load', () => {
    const arrivalRps = 10_000;
    const at90 = arrivalRps * (1 - 0.9);
    const at95 = arrivalRps * (1 - 0.95);
    expect(at90 / at95).toBeCloseTo(2, 10);
  });
});

describe('stampede amplification', () => {
  it('collapsing removes the (1 + lambda*L) factor', () => {
    const missRps = 50;
    const originLatencySec = 0.2;
    const without = stampedeAmplification(missRps, originLatencySec, false);
    const with_ = stampedeAmplification(missRps, originLatencySec, true);

    expect(with_).toBe(missRps);
    expect(without).toBeCloseTo(missRps * (1 + missRps * originLatencySec), 8);
    expect(without / with_).toBeGreaterThan(10);
  });

  it('amplification is worst exactly when the object is hot and the origin slow', () => {
    const cold = stampedeAmplification(5, 0.05, false) / 5;
    const hot = stampedeAmplification(200, 0.5, false) / 200;
    expect(hot).toBeGreaterThan(cold * 10);
  });
});

describe('warmth', () => {
  it('relaxes toward 1 over roughly one TTL', () => {
    const ttl = 60;
    let w = 0;
    for (let t = 0; t < ttl; t += 1) w = relaxWarmth(w, ttl, 1);
    // One time constant reaches ~63%.
    expect(w).toBeGreaterThan(0.6);
    expect(w).toBeLessThan(0.7);
  });

  it('a cold cache serves a proportionally lower hit ratio', () => {
    const warm = cacheHitRatio({ arrivalRps: 5000, ttlSeconds: 300, ...POP, warmth: 1 });
    const cold = cacheHitRatio({ arrivalRps: 5000, ttlSeconds: 300, ...POP, warmth: 0.3 });
    expect(cold.hitRatio).toBeLessThan(warm.hitRatio);
    expect(cold.missRps).toBeGreaterThan(warm.missRps);
  });
});
