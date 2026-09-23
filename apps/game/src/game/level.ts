import { classId, regionId, type Demand, type Region, type TrafficClass } from '@nb/schema';
import type { Scenario } from '@nb/sim';
import { topo } from '@nb/catalog';

/**
 * The vertical slice's level.
 *
 * Act I level 4, "Vertical vs Horizontal": nine service slots as one box or as
 * three. It is the first level that requires the player to *build* rather than
 * only observe, which is what makes it the right one to prove the whole loop
 * against.
 */

export const SF: Region = {
  id: regionId('us-west'), label: 'San Francisco', lat: 37.77, lon: -122.42,
};
export const LONDON: Region = {
  id: regionId('eu-west'), label: 'London', lat: 51.51, lon: -0.13,
};
export const REGIONS = [SF, LONDON];

export const API_READ: TrafficClass = {
  id: classId('api-read'),
  cacheable: false,
  responseBytes: 4096,
  originCpuMs: 20,
  clientTimeoutMs: 2000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, budgetFraction: 0 },
  slo: { p99Ms: 200, errorRatePct: 1 },
};

const demand: Demand = {
  classId: API_READ.id,
  originRegions: [{ regionId: SF.id, weight: 1 }],
  profile: { kind: 'constant', rps: 600 },
};

export interface Objective {
  readonly id: string;
  readonly label: string;
  readonly detail: string;
}

export interface Level {
  readonly id: string;
  readonly act: number;
  readonly number: number;
  readonly title: string;
  readonly brief: string;
  readonly hint: string;
  readonly scenario: Scenario;
  readonly startingTopology: ReturnType<typeof topo>;
  readonly objectives: readonly Objective[];
  readonly sloP99Ms: number;
  readonly budgetUsdMonth: number;
  readonly unlocked: readonly string[];
}

export const LEVEL: Level = {
  id: 'request/vertical-horizontal',
  act: 1,
  number: 4,
  title: 'Vertical vs Horizontal',
  brief:
    'Six hundred requests a second are arriving and one origin server cannot keep up — '
    + 'most of them are failing. You can make that server bigger, or put several behind a '
    + 'load balancer. A slot costs the same either way. Only one of these survives losing '
    + 'a machine.',
  hint:
    'One pool of fifteen slots queues slightly better than three pools of five — pooling '
    + 'beats partitioning, so the big box is genuinely a little faster. What splitting '
    + 'buys you is surviving a machine, and that is the third star.',
  scenario: {
    durationSec: 20,
    warmupSec: 4,
    tickHz: 25,
    seed: 1,
    classes: [API_READ],
    demands: [demand],
    regions: REGIONS,
  },
  startingTopology: topo(
    [
      { id: 'users', type: 'client', region: 'us-west' },
      { id: 'origin', type: 'origin', region: 'us-west', config: { servers: 8 } },
    ],
    [{ from: 'users', to: 'origin' }],
  ),
  objectives: [
    { id: 'slo', label: 'p99 under 200ms', detail: 'The tail is what users actually feel.' },
    {
      id: 'budget',
      label: 'Under $1,700/month',
      detail: 'Traffic costs the same either way; the slots you add do not.',
    },
    {
      id: 'resilient',
      label: 'No single point of failure',
      detail: 'Losing one machine should not lose everything.',
    },
  ],
  sloP99Ms: 200,
  budgetUsdMonth: 1700,
  unlocked: ['origin', 'load-balancer'],
};
