import type { EdgeId, NodeId, ProtocolProfile, RegionId } from '@nb/schema';

/**
 * Everything the player can place is a Station.
 *
 * `@nb/sim` deliberately knows nothing about CDNs, pods or WAFs. Those live in
 * `@nb/catalog`, which maps game concepts onto these primitives. That boundary
 * is what keeps Acts V and VI additive rather than a second engine.
 */

/** Admission: how offered flow is reduced before it is served. */
export type AdmissionSpec =
  | { readonly kind: 'none' }
  /** Token bucket, keyed per identity. Level 35. */
  | { readonly kind: 'rate-limit'; readonly capacityRps: number; readonly burst: number }
  /** Shed load beyond a utilization target rather than queueing it. */
  | { readonly kind: 'shed-above'; readonly utilizationTarget: number }
  /** Inspect and drop a fraction of each class. Level 34. */
  | { readonly kind: 'filter'; readonly dropFractionByClass: readonly number[] };

/** Routing: how admitted flow is divided across outgoing edges. */
export type RoutingSpec =
  | { readonly kind: 'terminal' }
  | { readonly kind: 'weighted' }
  /** Hit fraction terminates here; the miss stream goes upstream. Acts III-IV. */
  | { readonly kind: 'cache-split'; readonly ttlSeconds: number;
      readonly keyCardinalityFactor?: number; readonly collapsing: boolean }
  /** Wait on all downstream edges. Produces tail-at-scale amplification. */
  | { readonly kind: 'fanout' };

/**
 * Controllers mutate station state between ticks.
 *
 * The union is empty in Phase 1 by design: Act I needs no controllers, and the
 * HPA spike in Phase 2 is what proves this seam absorbs autoscaling before any
 * content depends on it. The *field* exists now because commitment #1 says
 * `servers` is controller-driven state and retrofitting that is a rewrite.
 */
export type ControllerSpec = never;

export interface Station {
  readonly id: NodeId;
  readonly regionId: RegionId;

  /** Concurrent service slots. Mutable state, not config - commitment #1. */
  servers: number;
  readonly serviceMeanMs: number;
  /** Squared coefficient of variation of service time. The variance lever. */
  readonly serviceCv2: number;
  /** Requests beyond this are shed rather than queued. */
  readonly queueLimit: number;
  /** CPU charged per handshake this station terminates. */
  readonly cryptoCpuMs: number;

  readonly admission: readonly AdmissionSpec[];
  readonly routing: RoutingSpec;
  readonly controllers: readonly ControllerSpec[];

  // --- per-tick state, double-buffered by the engine ---
  backlogReqs: number;
  health: 'healthy' | 'degraded' | 'down';
  warmth: number;
}

export interface SimEdge {
  readonly id: EdgeId;
  readonly from: NodeId;
  readonly to: NodeId;
  readonly weight: number;
  readonly protocol: ProtocolProfile;
  readonly bandwidthMbps: number;
}

export function makeStation(init: {
  id: NodeId;
  regionId: RegionId;
  servers: number;
  serviceMeanMs: number;
  serviceCv2?: number;
  queueLimit?: number;
  cryptoCpuMs?: number;
  admission?: readonly AdmissionSpec[];
  routing?: RoutingSpec;
}): Station {
  return {
    id: init.id,
    regionId: init.regionId,
    servers: init.servers,
    serviceMeanMs: init.serviceMeanMs,
    serviceCv2: init.serviceCv2 ?? 0.5,
    queueLimit: init.queueLimit ?? Number.POSITIVE_INFINITY,
    cryptoCpuMs: init.cryptoCpuMs ?? 0,
    admission: init.admission ?? [{ kind: 'none' }],
    routing: init.routing ?? { kind: 'terminal' },
    controllers: [],
    backlogReqs: 0,
    health: 'healthy',
    warmth: 1,
  };
}

/**
 * Service capacity in requests per second.
 *
 * A station with no service time is instantaneous, not incapable. Reading
 * `serviceMeanMs <= 0` as zero capacity silently backlogs every request at the
 * traffic source and starves the rest of the graph.
 */
export function capacityRps(s: Station): number {
  if (s.health === 'down') return 0;
  if (s.serviceMeanMs <= 0) return Number.POSITIVE_INFINITY;
  return s.servers / (s.serviceMeanMs / 1000);
}

export function utilization(s: Station, arrivalRps: number): number {
  const cap = capacityRps(s);
  return cap > 0 ? arrivalRps / cap : Number.POSITIVE_INFINITY;
}

/**
 * Apply admission policies. Returns the admitted rate and what was rejected.
 *
 * Rejection is not the same as error: a rate limiter returning 429 and an
 * overloaded queue dropping requests are different lessons, so the engine
 * tracks them separately.
 */
export function admit(s: Station, offeredRps: number): { admittedRps: number; rejectedRps: number } {
  let admitted = offeredRps;
  for (const a of s.admission) {
    switch (a.kind) {
      case 'none':
        break;
      case 'rate-limit':
        admitted = Math.min(admitted, a.capacityRps);
        break;
      case 'shed-above': {
        const ceiling = capacityRps(s) * a.utilizationTarget;
        admitted = Math.min(admitted, ceiling);
        break;
      }
      case 'filter':
        // Class-aware filtering is applied by the engine, which holds the flow
        // vector; at station level this is a no-op.
        break;
    }
  }
  admitted = Math.max(0, Math.min(admitted, offeredRps));
  return { admittedRps: admitted, rejectedRps: offeredRps - admitted };
}

/**
 * Serve one tick's worth of work at a station.
 *
 * Works in requests rather than rates so conservation is exact:
 *
 *   offered = completed + rejected + dropped + (newBacklog - oldBacklog)
 *
 * Because backlog is an integrator rather than a formula, three correct
 * behaviours fall out for free: latency climbs progressively instead of
 * jumping, queue depth is a real state variable the animation can show, and
 * recovery takes time proportional to accumulated backlog rather than snapping
 * back the instant load drops. Breaking is fast; recovering is slow.
 */
export interface ServeResult {
  readonly completedReqs: number;
  readonly rejectedReqs: number;
  readonly droppedReqs: number;
  readonly newBacklogReqs: number;
}

export function serveTick(s: Station, offeredRps: number, dtSeconds: number): ServeResult {
  const offeredReqs = offeredRps * dtSeconds;

  // A down station refuses connections; it does not accumulate a queue on
  // behalf of a process that is not running.
  if (s.health === 'down') {
    return {
      completedReqs: 0,
      rejectedReqs: offeredReqs,
      droppedReqs: 0,
      newBacklogReqs: 0,
    };
  }

  const { admittedRps } = admit(s, offeredRps);
  const admittedReqs = admittedRps * dtSeconds;
  const rejectedReqs = offeredReqs - admittedReqs;

  const capacityReqs = capacityRps(s) * dtSeconds;
  const available = s.backlogReqs + admittedReqs;
  const completedReqs = Math.min(available, capacityReqs);

  let newBacklogReqs = available - completedReqs;
  let droppedReqs = 0;
  if (newBacklogReqs > s.queueLimit) {
    droppedReqs = newBacklogReqs - s.queueLimit;
    newBacklogReqs = s.queueLimit;
  }

  return { completedReqs, rejectedReqs, droppedReqs, newBacklogReqs };
}
