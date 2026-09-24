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
  /*
   * Each station is charged what it declares.
   *
   * This previously applied one flat per-server rate to every station and
   * ignored the catalog's cost specs entirely, which made a load balancer,
   * a CDN PoP and an origin shield all free - so no level could ever teach
   * whether a shield was worth paying for. The origin was correct only by
   * coincidence, its price happening to match the global default.
   *
   * `usdPerServerMonth` on the rate card is now a fallback for stations that
   * declare no price of their own, so a bare `makeStation` still bills.
   */
  let computeUsdMonth = 0;
  for (const id of [...stations.keys()].sort()) {
    const st = stations.get(id);
    if (st === undefined) continue;
    // Infinite-server stations are traffic sources and pass-through tiers, not
    // capacity anyone pays for by the slot. They can still carry a fixed fee.
    if (Number.isFinite(st.servers)) {
      const perServer = st.costPerServerMonth > 0
        ? st.costPerServerMonth
        : rates.usdPerServerMonth;
      computeUsdMonth += st.servers * perServer;
    }
    computeUsdMonth += st.costFixedMonth;
  }

  // Scale the measured window up to a month.
  const scale = agg.simulatedSeconds > 0 ? SECONDS_PER_MONTH / agg.simulatedSeconds : 0;

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
