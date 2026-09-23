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
  // A constant overload just pins the queue at its ceiling forever - nothing
  // builds and nothing drains, so there is no backlog to see. A spike gives
  // the starting topology (8 slots, 400rps capacity) a comfortable 250rps
  // baseline it survives, then ten seconds in, eight seconds at 620rps it
  // cannot absorb: enough over 400 to overflow its queue and start dropping,
  // but under the 700-750rps a correct answer provides, so a real solution
  // rides through it. Numbers measured against the reference solutions below.
  profile: { kind: 'spike', baseRps: 250, peakRps: 620, atSec: 10, durationSec: 8 },
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
    'Two hundred and fifty requests a second is comfortable. Ten seconds in, traffic '
    + 'spikes past six hundred for eight seconds, and one origin server cannot keep up '
    + '- watch what happens to its queue during that spike, and how much longer it takes '
    + 'to work through afterwards. You can make that server bigger, or put several behind '
    + 'a load balancer. A slot costs the same either way. Only one of these survives '
    + 'losing a machine.',
  hint:
    'One pool of fourteen slots queues slightly better than three pools of five - pooling '
    + 'beats partitioning, so the big box is genuinely a little faster. What splitting '
    + 'buys you is surviving a machine, and that is the third star.',
  scenario: {
    durationSec: 30,
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
      label: 'Under $1,300/month',
      detail: 'Traffic costs the same either way; the slots you add do not.',
    },
    {
      id: 'resilient',
      label: 'No single point of failure',
      detail: 'Losing one machine should not lose everything.',
    },
  ],
  sloP99Ms: 200,
  budgetUsdMonth: 1300,
  unlocked: ['origin', 'load-balancer'],
};
