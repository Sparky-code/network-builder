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
  /**
   * Escalating help, revealed one rung at a time.
   *
   * A single hint is either too weak to help or strong enough to be the answer.
   * Asking once should point at where to look; asking three times has earned
   * the move. Free, and untracked - costing hints is a decision deferred until
   * the curriculum is long enough for it to mean anything.
   *
   * Phase 4 replaces this hand-authored array with hints derived from the
   * player's actual run - see docs/content-spine.md. Until then these are
   * static, which is a known weakness rather than a design.
   */
  readonly hints: readonly string[];
  readonly scenario: Scenario;
  readonly startingTopology: ReturnType<typeof topo>;
  readonly objectives: readonly Objective[];
  readonly sloP99Ms: number;
  readonly budgetUsdMonth: number;
  readonly unlocked: readonly string[];
  /**
   * The shapes this level is a comparison between.
   *
   * Shown at the end, measured against what the player actually built, and
   * only for the shape they did not build. A level whose lesson is a tradeoff
   * teaches nothing if the player only ever sees one side of it - they can
   * finish with two stars having never learned what the third was about.
   *
   * Deliberately not a hint and not an answer key: it appears after the
   * attempt, it is framed as "the other way", and its numbers come from
   * running it through the same engine rather than from a claim in prose.
   */
  readonly alternatives: readonly LevelAlternative[];
}

export interface LevelAlternative {
  readonly id: string;
  readonly label: string;
  /** What choosing this shape buys, in one line. */
  readonly buys: string;
  /** What it costs you, in one line. Every shape gives something up. */
  readonly costsYou: string;
  readonly topology: ReturnType<typeof topo>;
  /** True when the player's own topology is this shape. */
  readonly matches: (t: ReturnType<typeof topo>) => boolean;
}

const originCount = (t: ReturnType<typeof topo>): number =>
  t.nodes.filter((n) => (n.typeId as string) === 'origin').length;

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
  hints: [
    // Nudge: where to look, not what to do.
    'Watch the origin during the spike. The queue tells you whether it is keeping up, '
    + 'and the event feed names the moment it stops.',
    // Specific: the quantity and the gap.
    'During the peak, 620 requests a second arrive. Each service slot handles 50, so '
    + 'eight slots serve 400 — everything above that queues, then gets refused.',
    // The move, and the tradeoff the level is actually about.
    'Fourteen slots clears the peak. So do three origins of five behind a load balancer, '
    + 'for almost the same money — a single pool queues slightly better, but only the '
    + 'split one survives losing a machine, and that is the third star.',
  ],
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
  alternatives: [
    {
      id: 'vertical',
      label: 'One larger server',
      buys: 'Slightly lower latency. One pool of fourteen slots queues better than '
          + 'three pools of five, because a free slot anywhere can take any request.',
      costsYou: 'Everything, when that machine dies. There is nowhere for its traffic to go.',
      topology: topo(
        [
          { id: 'users', type: 'client', region: 'us-west' },
          { id: 'origin', type: 'origin', region: 'us-west', config: { servers: 14 } },
        ],
        [{ from: 'users', to: 'origin' }],
      ),
      matches: (t) => originCount(t) === 1,
    },
    {
      id: 'horizontal',
      label: 'Several servers behind a load balancer',
      buys: 'Surviving a machine. Losing one origin costs you a third of your capacity, '
          + 'not all of it.',
      costsYou: 'A little latency, and the price of the load balancer. Three small pools '
              + 'queue slightly worse than one large one.',
      topology: topo(
        [
          { id: 'users', type: 'client', region: 'us-west' },
          { id: 'lb', type: 'load-balancer', region: 'us-west' },
          { id: 'a', type: 'origin', region: 'us-west', config: { servers: 5 } },
          { id: 'b', type: 'origin', region: 'us-west', config: { servers: 5 } },
          { id: 'c', type: 'origin', region: 'us-west', config: { servers: 5 } },
        ],
        [
          { from: 'users', to: 'lb' },
          { from: 'lb', to: 'a' }, { from: 'lb', to: 'b' }, { from: 'lb', to: 'c' },
        ],
      ),
      matches: (t) => originCount(t) > 1,
    },
  ],
};
