import type { Region } from '@nb/schema';

/**
 * Geography as a latency budget.
 *
 * Distance is the one cost a player cannot buy their way out of, which is what
 * motivates the entire edge-network act. Level 2 exists purely to make this
 * visible: move the client, change nothing else, watch latency quadruple.
 */

/** Light in fiber: ~2/3 c. 200 km/ms one-way. */
export const KM_PER_MS = 200;

/**
 * Real fiber does not follow great circles — it follows cable routes and
 * terrestrial rights of way. 1.4-1.8x is the usual observed range.
 */
export const DETOUR_FACTOR = 1.6;

/** Last-mile, switching and serialisation floor, one-way. */
export const LOCAL_FLOOR_MS = 0.5;

const EARTH_RADIUS_KM = 6371;
const DEG = Math.PI / 180;

export function haversineKm(
  a: { lat: number; lon: number },
  b: { lat: number; lon: number },
): number {
  const dLat = (b.lat - a.lat) * DEG;
  const dLon = (b.lon - a.lon) * DEG;
  const sinLat = Math.sin(dLat / 2);
  const sinLon = Math.sin(dLon / 2);
  const h =
    sinLat * sinLat + Math.cos(a.lat * DEG) * Math.cos(b.lat * DEG) * sinLon * sinLon;
  return 2 * EARTH_RADIUS_KM * Math.asin(Math.min(1, Math.sqrt(h)));
}

export function oneWayMs(a: Region, b: Region): number {
  return (haversineKm(a, b) / KM_PER_MS) * DETOUR_FACTOR + LOCAL_FLOOR_MS;
}

/**
 * Round-trip time between two regions.
 *
 * Sanity anchor: SF to London is ~8,600 km, giving ~43ms ideal one-way, ~69ms
 * with detour, ~139ms RTT. That matches real-world measurement, and it is the
 * bar every constant in this engine has to clear.
 */
export function rttMs(a: Region, b: Region): number {
  return 2 * oneWayMs(a, b);
}

/** Serialisation time for a payload on a link of given bandwidth. */
export function transferMs(bytes: number, bandwidthMbps: number): number {
  if (bandwidthMbps <= 0) return 0;
  return (bytes * 8) / (bandwidthMbps * 1000);
}
