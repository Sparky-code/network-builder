import type { CostBreakdown, NodeId } from '@nb/schema';
import type { Station } from './station';

/**
 * Cost is post-processing, not simulation.
 *
 * Keeping it a pure function over run aggregates means "what if traffic
 * doubled?" can be answered without re-simulating. It also keeps the tick loop
 * free of pricing, which changes for reasons that have nothing to do with
 * queueing theory.
 */

export interface CostRates {
  /** Per service slot per month. */
  readonly usdPerServerMonth: number;
  /** Egress leaving an edge-tier station. Cheaper than origin egress - a lesson. */
  readonly usdPerGbEdge: number;
  readonly usdPerGbOrigin: number;
  readonly usdPerMillionRequests: number;
  readonly usdPerGbCacheMonth: number;
}

export const DEFAULT_COST_RATES: CostRates = {
  usdPerServerMonth: 30,
  usdPerGbEdge: 0.02,
  usdPerGbOrigin: 0.09,
  usdPerMillionRequests: 0.4,
  usdPerGbCacheMonth: 0.02,
};

export interface CostAggregates {
  /** Bytes served to clients from edge-tier stations. */
  readonly edgeEgressBytes: number;
  /** Bytes leaving the origin tier. */
  readonly originEgressBytes: number;
  readonly totalRequests: number;
  readonly cacheStorageBytes: number;
  readonly simulatedSeconds: number;
}

const SECONDS_PER_MONTH = 30 * 24 * 3600;
const BYTES_PER_GB = 1024 ** 3;

export function computeCost(
  stations: ReadonlyMap<NodeId, Station>,
  agg: CostAggregates,
  rates: CostRates = DEFAULT_COST_RATES,
): CostBreakdown {
  let servers = 0;
  for (const id of [...stations.keys()].sort()) {
    const n = stations.get(id)?.servers ?? 0;
    // Infinite-server stations are traffic sources and clients, not capacity
    // anyone pays for. Summing them yields a bill of Infinity.
    if (Number.isFinite(n)) servers += n;
  }

  // Scale the measured window up to a month.
  const scale = agg.simulatedSeconds > 0 ? SECONDS_PER_MONTH / agg.simulatedSeconds : 0;

  const computeUsdMonth = servers * rates.usdPerServerMonth;
  const egressUsdMonth =
    ((agg.edgeEgressBytes / BYTES_PER_GB) * rates.usdPerGbEdge +
      (agg.originEgressBytes / BYTES_PER_GB) * rates.usdPerGbOrigin) *
    scale;
  const requestsUsdMonth =
    (agg.totalRequests / 1_000_000) * rates.usdPerMillionRequests * scale;
  const cacheStorageUsdMonth =
    (agg.cacheStorageBytes / BYTES_PER_GB) * rates.usdPerGbCacheMonth;

  const round = (n: number): number => Math.round(n * 100) / 100;

  return {
    computeUsdMonth: round(computeUsdMonth),
    egressUsdMonth: round(egressUsdMonth),
    cacheStorageUsdMonth: round(cacheStorageUsdMonth),
    requestsUsdMonth: round(requestsUsdMonth),
    totalUsdMonth: round(
      computeUsdMonth + egressUsdMonth + cacheStorageUsdMonth + requestsUsdMonth,
    ),
  };
}
