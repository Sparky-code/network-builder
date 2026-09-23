import { componentTypeId } from '@nb/schema';
import { z } from 'zod';
import type { Catalog, ComponentType } from './types';

/**
 * The six component types Acts I-III need.
 *
 * Deliberately not a DNS resolver: the engine charges DNS as a flat cost at
 * route start, and making it placeable would add a box to level 1 that teaches
 * nothing the waterfall does not already show. Act IV replaces that constant
 * with real resolver behaviour, and a component arrives with it.
 */

const serverCount = z.number().int().min(1).max(512);

const CLIENT: ComponentType = {
  id: componentTypeId('client'),
  label: 'Users',
  act: 1,
  summary: 'Where requests come from. Placed in a region; latency is measured from here.',
  ports: [
    { id: 'out', direction: 'out', protocol: 'http', minDegree: 1, maxDegree: 8 },
  ],
  simTemplate: {
    // A traffic source is not a queue. Modelling it as one with a large finite
    // server count is both physically wrong and, because the Erlang recursion
    // is O(c), ruinously slow.
    servers: 'infinite',
    serviceMeanMs: 0,
    serviceCv2: 0,
    routing: { kind: 'weighted' },
  },
  cost: { usdPerServerMonth: 0, usdFixedMonth: 0, tier: 'edge' },
  configSchema: z.object({}).strict(),
  learnMoreId: 'request/anatomy',
};

const ORIGIN: ComponentType = {
  id: componentTypeId('origin'),
  label: 'Origin server',
  act: 1,
  summary: 'Runs your application. Every request it serves costs CPU time.',
  ports: [
    { id: 'in', direction: 'in', protocol: 'http', minDegree: 1, maxDegree: 16 },
    { id: 'db', direction: 'out', protocol: 'sql', minDegree: 0, maxDegree: 1 },
  ],
  simTemplate: {
    servers: 8,
    serviceMeanMs: 20,
    // Application work is moderately predictable.
    serviceCv2: 0.5,
    queueLimitPerServer: 100,
    routing: { kind: 'terminal' },
  },
  cost: { usdPerServerMonth: 30, usdFixedMonth: 0, tier: 'origin' },
  configSchema: z.object({
    servers: serverCount.default(8),
    serviceMeanMs: z.number().min(0.1).max(5000).default(20),
  }).strict(),
  learnMoreId: 'request/service-time',
};

const DATABASE: ComponentType = {
  id: componentTypeId('database'),
  label: 'Database',
  act: 2,
  summary:
    'Shared state. Its service time varies far more than an app server, so it queues '
    + 'badly at utilizations that would be comfortable elsewhere.',
  ports: [
    { id: 'in', direction: 'in', protocol: 'sql', minDegree: 1, maxDegree: 32 },
  ],
  simTemplate: {
    // Connection pool size, not machines.
    servers: 16,
    serviceMeanMs: 5,
    // The variance lever. A database at 60% utilization with Cv2=4 queues worse
    // than an app server at 80% with Cv2=0.5 - level 9's whole lesson.
    serviceCv2: 4.0,
    queueLimitPerServer: 50,
    routing: { kind: 'terminal' },
  },
  cost: { usdPerServerMonth: 12, usdFixedMonth: 120, tier: 'origin' },
  configSchema: z.object({
    servers: serverCount.default(16),
    serviceMeanMs: z.number().min(0.1).max(5000).default(5),
  }).strict(),
  learnMoreId: 'site/variance',
};

const LOAD_BALANCER: ComponentType = {
  id: componentTypeId('load-balancer'),
  label: 'Load balancer',
  act: 2,
  summary: 'Spreads requests across healthy backends. Cheap to traverse, easy to forget.',
  ports: [
    { id: 'in', direction: 'in', protocol: 'http', minDegree: 1, maxDegree: 8 },
    { id: 'out', direction: 'out', protocol: 'http', minDegree: 1, maxDegree: 32 },
  ],
  simTemplate: {
    servers: 'infinite',
    serviceMeanMs: 0.2,
    serviceCv2: 0.1,
    routing: { kind: 'weighted' },
  },
  cost: { usdPerServerMonth: 0, usdFixedMonth: 25, tier: 'edge' },
  configSchema: z.object({
    algorithm: z.enum(['round-robin', 'least-connections']).default('round-robin'),
  }).strict(),
  learnMoreId: 'site/load-balancing',
};

const CDN_POP: ComponentType = {
  id: componentTypeId('cdn-pop'),
  label: 'Edge cache (PoP)',
  act: 3,
  summary:
    'Caches responses close to users. Hits never travel further; misses continue '
    + 'upstream. More PoPs lower latency and lower each PoP hit ratio.',
  ports: [
    { id: 'in', direction: 'in', protocol: 'http', minDegree: 1, maxDegree: 8 },
    { id: 'miss', direction: 'out', protocol: 'http', minDegree: 1, maxDegree: 4 },
  ],
  simTemplate: {
    servers: 'infinite',
    serviceMeanMs: 1,
    serviceCv2: 0.2,
    routing: { kind: 'cache-split', ttlSeconds: 300, collapsing: false },
  },
  cost: { usdPerServerMonth: 0, usdFixedMonth: 40, tier: 'edge' },
  configSchema: z.object({
    ttlSeconds: z.number().min(0).max(86_400).default(300),
    keyCardinalityFactor: z.number().min(1).max(1e7).default(1),
    collapsing: z.boolean().default(false),
  }).strict(),
  learnMoreId: 'caching/hit-ratio',
};

const ORIGIN_SHIELD: ComponentType = {
  id: componentTypeId('origin-shield'),
  label: 'Origin shield',
  act: 3,
  summary:
    'A second cache tier that every PoP misses through. Re-aggregates the miss '
    + 'stream, so it raises total hit ratio without changing edge hit ratio - at '
    + 'the cost of one extra hop on every miss.',
  ports: [
    { id: 'in', direction: 'in', protocol: 'http', minDegree: 1, maxDegree: 64 },
    { id: 'miss', direction: 'out', protocol: 'http', minDegree: 1, maxDegree: 2 },
  ],
  simTemplate: {
    servers: 'infinite',
    serviceMeanMs: 1,
    serviceCv2: 0.2,
    routing: { kind: 'cache-split', ttlSeconds: 600, collapsing: true },
  },
  cost: { usdPerServerMonth: 0, usdFixedMonth: 90, tier: 'edge' },
  configSchema: z.object({
    ttlSeconds: z.number().min(0).max(86_400).default(600),
    collapsing: z.boolean().default(true),
  }).strict(),
  learnMoreId: 'caching/origin-shield',
};

export const COMPONENT_TYPES: readonly ComponentType[] = [
  CLIENT, LOAD_BALANCER, ORIGIN, DATABASE, CDN_POP, ORIGIN_SHIELD,
];

export const CATALOG: Catalog = new Map(COMPONENT_TYPES.map((c) => [c.id, c]));

export { CLIENT, LOAD_BALANCER, ORIGIN, DATABASE, CDN_POP, ORIGIN_SHIELD };
