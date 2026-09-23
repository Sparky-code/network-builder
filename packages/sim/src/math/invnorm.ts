/**
 * Inverse standard normal CDF, Acklam's rational approximation.
 *
 * Absolute relative error below 1.15e-9 across the full open interval, which is
 * far tighter than anything the game's numbers are reported to. Needed because
 * the lognormal service component of a latency kernel must be *invertible* in
 * closed form — see kernel.ts.
 */

const A = [
  -3.969683028665376e1, 2.209460984245205e2, -2.759285104469687e2,
  1.383577518672690e2, -3.066479806614716e1, 2.506628277459239,
] as const;
const B = [
  -5.447609879822406e1, 1.615858368580409e2, -1.556989798598866e2,
  6.680131188771972e1, -1.328068155288572e1,
] as const;
const C = [
  -7.784894002430293e-3, -3.223964580411365e-1, -2.400758277161838,
  -2.549732539343734, 4.374664141464968, 2.938163982698783,
] as const;
const D = [
  7.784695709041462e-3, 3.224671290700398e-1, 2.445134137142996,
  3.754408661907416,
] as const;

const P_LOW = 0.02425;
const P_HIGH = 1 - P_LOW;

export function invNorm(p: number): number {
  if (!(p > 0) || !(p < 1)) {
    // Clamp rather than throw: probe sets and RNG are half-open by
    // construction, so this only guards against caller arithmetic drift.
    if (p <= 0) p = Number.EPSILON;
    else if (p >= 1) p = 1 - Number.EPSILON;
  }

  if (p < P_LOW) {
    const q = Math.sqrt(-2 * Math.log(p));
    return (
      ((((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
        ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1))
    );
  }

  if (p > P_HIGH) {
    const q = Math.sqrt(-2 * Math.log(1 - p));
    return (
      -((((((C[0] * q + C[1]) * q + C[2]) * q + C[3]) * q + C[4]) * q + C[5]) /
        ((((D[0] * q + D[1]) * q + D[2]) * q + D[3]) * q + 1))
    );
  }

  const q = p - 0.5;
  const r = q * q;
  return (
    ((((((A[0] * r + A[1]) * r + A[2]) * r + A[3]) * r + A[4]) * r + A[5]) * q) /
    (((((B[0] * r + B[1]) * r + B[2]) * r + B[3]) * r + B[4]) * r + 1)
  );
}
