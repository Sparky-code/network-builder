import type { ClassId, NodeId, RegionId } from './ids';

export interface ClassMetrics {
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly throughputRps: number;
  readonly errorRatePct: number;
  readonly timeoutRatePct: number;
}

export interface NodeMetrics {
  readonly utilization: number;
  readonly backlogPeak: number;
  readonly dropRatePct: number;
}

/**
 * Named latency contributions, in ms, at the reported percentile.
 *
 * Required, not polish. The project's largest risk is a player who cannot
 * answer "why did p99 move from 90 to 340?" — this is the answer.
 */
export interface LatencyWaterfall {
  readonly dnsMs: number;
  readonly setupMs: number;
  readonly propagationMs: number;
  readonly queueMs: number;
  readonly serviceMs: number;
  readonly transferMs: number;
}

export interface CostBreakdown {
  readonly computeUsdMonth: number;
  readonly egressUsdMonth: number;
  readonly cacheStorageUsdMonth: number;
  readonly requestsUsdMonth: number;
  readonly totalUsdMonth: number;
}

/**
 * Per-station state at one tick.
 *
 * The engine models backlog as an integrator — work accumulates when arrivals
 * exceed capacity and drains at capacity afterwards, so breaking is fast and
 * recovering is slow. That asymmetry is the most teachable behaviour the
 * simulation has, and until now the presentation layer had no access to it:
 * `NodeMetrics.backlogPeak` is a single number for the whole run, which cannot
 * show a queue growing.
 */
export interface StationFrame {
  /** Requests queued at this station, at this tick. Not a ratio — a quantity. */
  readonly backlogReqs: number;
  readonly utilization: number;
  readonly droppedRps: number;
}

/** One emitted frame per simulated tick. */
export interface MetricsFrame {
  readonly tick: number;
  readonly simTimeSec: number;
  readonly offeredRps: number;
  readonly completedRps: number;
  readonly erroredRps: number;
  readonly droppedRps: number;
  readonly p50Ms: number;
  readonly p95Ms: number;
  readonly p99Ms: number;
  readonly cacheHitRatioEdge: number;
  readonly cacheHitRatioTotal: number;
  /**
   * Per-station state, keyed by node id.
   *
   * This is the only per-node time series the engine emits. Frame count is
   * bounded by the graded window (a few hundred) and topologies are small by
   * design, so a record per frame is cheap and far easier to consume than
   * parallel typed arrays.
   */
  readonly stations: Readonly<Record<string, StationFrame>>;
}

export interface RunResult {
  readonly engineVersion: string;
  /** hash(topology, scenario, seed, engineVersion). Scores compare only within a version. */
  readonly inputHash: string;

  readonly perClass: Readonly<Record<string, ClassMetrics>>;
  readonly perRegion: Readonly<Record<string, ClassMetrics>>;
  readonly perNode: Readonly<Record<string, NodeMetrics>>;

  /** Drives user-visible latency. */
  readonly cacheHitRatioEdge: number;
  /** Drives origin offload and egress cost. A different number with a different job. */
  readonly cacheHitRatioTotal: number;

  readonly attribution: LatencyWaterfall;
  readonly frames: readonly MetricsFrame[];
  readonly cost: CostBreakdown;
}

export type ClassMetricsRecord = Readonly<Record<ClassId & string, ClassMetrics>>;
export type RegionMetricsRecord = Readonly<Record<RegionId & string, ClassMetrics>>;
export type NodeMetricsRecord = Readonly<Record<NodeId & string, NodeMetrics>>;
