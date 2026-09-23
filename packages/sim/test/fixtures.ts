import {
  classId, edgeId, nodeId, protocolId, regionId,
  type Demand, type ProtocolProfile, type Region, type TrafficClass,
} from '@nb/schema';
import { makeStation, type SimEdge, type Station } from '../src/station';
import type { Scenario } from '../src/engine';

/** Real coordinates: the geography has to be checkable against reality. */
export const SF: Region = { id: regionId('us-west'), label: 'San Francisco', lat: 37.77, lon: -122.42 };
export const LONDON: Region = { id: regionId('eu-west'), label: 'London', lat: 51.51, lon: -0.13 };
export const REGIONS = [SF, LONDON];

export const TLS13: ProtocolProfile = {
  id: protocolId('http2-tls13'),
  handshakeRtts: 2, // TCP 1 + TLS 1.3 1
  connectionReuse: 0,
  cryptoCpuMs: 1,
};

export const TLS12: ProtocolProfile = {
  id: protocolId('http1-tls12'),
  handshakeRtts: 3, // TCP 1 + TLS 1.2 2
  connectionReuse: 0,
  cryptoCpuMs: 2,
};

export const API_READ: TrafficClass = {
  id: classId('api-read'),
  cacheable: false,
  responseBytes: 4096,
  originCpuMs: 20,
  clientTimeoutMs: 2000,
  retryPolicy: { maxAttempts: 1, backoffMs: 0, budgetFraction: 0 },
  slo: { p99Ms: 200, errorRatePct: 1 },
};

export const STATIC_ASSET: TrafficClass = {
  id: classId('static-asset'),
  cacheable: true,
  objectPopulation: { count: 10_000, zipfAlpha: 0.9 },
  responseBytes: 64_000,
  originCpuMs: 5,
  clientTimeoutMs: 3000,
  retryPolicy: { maxAttempts: 2, backoffMs: 50, budgetFraction: 0.1 },
};

/**
 * A client is a traffic source, not a queue: infinite servers, no service time.
 * Giving it a large finite server count instead is both physically wrong and,
 * because the Erlang recursion is O(c), ruinously slow.
 */
export function client(id: string, region: Region): Station {
  return makeStation({
    id: nodeId(id),
    regionId: region.id,
    servers: Number.POSITIVE_INFINITY,
    serviceMeanMs: 0,
    serviceCv2: 0,
    routing: { kind: 'weighted' },
  });
}

/** An origin: `servers` worker slots, each taking `serviceMeanMs` per request. */
export function origin(id: string, region: Region, servers: number, serviceMeanMs = 20): Station {
  return makeStation({
    id: nodeId(id),
    regionId: region.id,
    servers,
    serviceMeanMs,
    serviceCv2: 0.5,
    // A real server has a bounded accept queue. 50k deep would absorb any
    // outage for the length of a level and report no errors at all.
    queueLimit: servers * 100,
    routing: { kind: 'terminal' },
  });
}

export function edge(
  id: string, from: string, to: string,
  protocol: ProtocolProfile = TLS13, weight = 1,
): SimEdge {
  return {
    id: edgeId(id),
    from: nodeId(from),
    to: nodeId(to),
    weight,
    protocol,
    bandwidthMbps: 1000,
  };
}

export function constantDemand(rps: number, region: Region, cls = API_READ): Demand {
  return {
    classId: cls.id,
    originRegions: [{ regionId: region.id, weight: 1 }],
    profile: { kind: 'constant', rps },
  };
}

export function scenario(overrides: Partial<Scenario> = {}): Scenario {
  return {
    durationSec: 20,
    warmupSec: 4,
    tickHz: 25,
    seed: 1,
    classes: [API_READ],
    demands: [constantDemand(100, SF)],
    regions: REGIONS,
    ...overrides,
  };
}

/** Level 1-3 shape: one client, one origin. */
export function singleOrigin(opts: {
  clientRegion?: Region;
  originRegion?: Region;
  servers?: number;
  serviceMeanMs?: number;
  protocol?: ProtocolProfile;
} = {}): { stations: Station[]; edges: SimEdge[] } {
  const c = opts.clientRegion ?? SF;
  const o = opts.originRegion ?? SF;
  return {
    stations: [client('client', c), origin('origin', o, opts.servers ?? 8, opts.serviceMeanMs ?? 20)],
    edges: [edge('e1', 'client', 'origin', opts.protocol ?? TLS13)],
  };
}

/** Level 4 shape: a client fanning out across n origins behind weighted routing. */
export function horizontal(n: number, serversEach: number, region = SF): {
  stations: Station[]; edges: SimEdge[];
} {
  const stations: Station[] = [client('client', region)];
  const edges: SimEdge[] = [];
  for (let i = 0; i < n; i++) {
    stations.push(origin(`origin-${i}`, region, serversEach));
    edges.push(edge(`e-${i}`, 'client', `origin-${i}`));
  }
  return { stations, edges };
}
