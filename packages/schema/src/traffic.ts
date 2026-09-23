import type { ClassId, RegionId } from './ids';

/**
 * Traffic classes exist from level 1 — day-one commitment #2.
 *
 * Without them a cache cannot be modelled honestly (a CDN fronting 100%
 * dynamic traffic should get ~0% hits), nor a WAF that correctly identifies
 * only part of an attack.
 */
export interface TrafficClass {
  readonly id: ClassId;
  readonly cacheable: boolean;
  /** Object population the class draws from. Absent means uncacheable/singleton. */
  readonly objectPopulation?: {
    readonly count: number;
    /** Zipf exponent. ~0.8-1.0 is typical for web object popularity. */
    readonly zipfAlpha: number;
  };
  readonly responseBytes: number;
  /** CPU cost at a terminal origin, in ms. */
  readonly originCpuMs: number;
  readonly clientTimeoutMs: number;
  readonly retryPolicy: {
    readonly maxAttempts: number;
    readonly backoffMs: number;
    /** Cap on retries as a fraction of organic load. Prevents unbounded storms. */
    readonly budgetFraction: number;
  };
  readonly slo?: { readonly p99Ms: number; readonly errorRatePct: number };
}

export type RateProfile =
  | { readonly kind: 'constant'; readonly rps: number }
  | { readonly kind: 'ramp'; readonly fromRps: number; readonly toRps: number }
  | { readonly kind: 'spike'; readonly baseRps: number; readonly peakRps: number;
      readonly atSec: number; readonly durationSec: number }
  | { readonly kind: 'diurnal'; readonly meanRps: number; readonly amplitude: number;
      readonly periodSec: number };

export interface Demand {
  readonly classId: ClassId;
  readonly originRegions: readonly { readonly regionId: RegionId; readonly weight: number }[];
  readonly profile: RateProfile;
}

export interface Region {
  readonly id: RegionId;
  readonly label: string;
  readonly lat: number;
  readonly lon: number;
}

/**
 * Flow is a vector over traffic classes, never a scalar — day-one commitment #4.
 * Index order is the scenario's class order, held in `ClassIndex`.
 */
export type FlowVector = Float64Array;

export interface ClassIndex {
  readonly classes: readonly TrafficClass[];
  readonly indexOf: ReadonlyMap<ClassId, number>;
}

export function makeClassIndex(classes: readonly TrafficClass[]): ClassIndex {
  const indexOf = new Map<ClassId, number>();
  classes.forEach((c, i) => indexOf.set(c.id, i));
  return { classes, indexOf };
}
