import { describe, expect, it } from 'vitest';
import { hashString, rng } from '../src/rng';

describe('purpose-keyed RNG', () => {
  it('is a pure function of its arguments', () => {
    for (let i = 0; i < 50; i++) {
      expect(rng(7, 'demand', 3, i)).toBe(rng(7, 'demand', 3, i));
    }
  });

  it('stays in [0, 1)', () => {
    for (let i = 0; i < 5000; i++) {
      const u = rng(1, 'x', i, i * 7);
      expect(u).toBeGreaterThanOrEqual(0);
      expect(u).toBeLessThan(1);
    }
  });

  /**
   * The rule that actually protects grading: a visual effect consuming draws
   * from 'viz' must not be able to shift anything under 'route-sample'.
   */
  it('different purposes are independent streams', () => {
    const viz: number[] = [];
    const route: number[] = [];
    for (let i = 0; i < 200; i++) {
      viz.push(rng(42, 'viz', 1, i));
      route.push(rng(42, 'route-sample', 1, i));
    }
    expect(viz).not.toEqual(route);

    // And drawing more from one does not perturb the other.
    for (let i = 0; i < 10_000; i++) rng(42, 'viz', 1, i);
    for (let i = 0; i < 200; i++) {
      expect(rng(42, 'route-sample', 1, i)).toBe(route[i]);
    }
  });

  it('is roughly uniform', () => {
    const buckets = new Float64Array(10);
    const n = 100_000;
    for (let i = 0; i < n; i++) {
      const b = Math.floor(rng(3, 'uniformity', 0, i) * 10);
      buckets[b] = (buckets[b] ?? 0) + 1;
    }
    for (const b of buckets) {
      expect(Math.abs(b - n / 10) / (n / 10)).toBeLessThan(0.05);
    }
  });

  it('different seeds give different streams', () => {
    const a = Array.from({ length: 100 }, (_, i) => rng(1, 'p', 0, i));
    const b = Array.from({ length: 100 }, (_, i) => rng(2, 'p', 0, i));
    expect(a).not.toEqual(b);
  });
});

describe('hashString', () => {
  it('is stable and collision-resistant enough for input hashes', () => {
    expect(hashString('abc')).toBe(hashString('abc'));
    expect(hashString('abc')).not.toBe(hashString('abd'));
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(hashString(`topology-${i}`));
    expect(seen.size).toBe(10_000);
  });
});
