import type { NodeId, Region, RegionId } from '@nb/schema';
import type { SimEdge, Station } from './station';
import { rttMs, transferMs } from './math/geo';

/**
 * Graph structure, resolved once per topology.
 *
 * Every iteration order here is derived from a sorted id list, never from Map
 * or Set insertion order. That is what makes the shuffled-input identity test
 * pass, and a plain repeat-run test would not catch a violation.
 */

export interface SimGraph {
  readonly stations: ReadonlyMap<NodeId, Station>;
  /** Sorted station ids. The canonical iteration order for all arithmetic. */
  readonly order: readonly NodeId[];
  readonly edges: readonly SimEdge[];
  readonly outbound: ReadonlyMap<NodeId, readonly SimEdge[]>;
  readonly inbound: ReadonlyMap<NodeId, readonly SimEdge[]>;
  readonly entries: readonly NodeId[];
}

export function buildGraph(stations: readonly Station[], edges: readonly SimEdge[]): SimGraph {
  const byId = new Map<NodeId, Station>();
  for (const s of stations) byId.set(s.id, s);

  const sortedIds = [...byId.keys()].sort();
  const sortedEdges = [...edges].sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));

  const outbound = new Map<NodeId, SimEdge[]>();
  const inbound = new Map<NodeId, SimEdge[]>();
  for (const id of sortedIds) {
    outbound.set(id, []);
    inbound.set(id, []);
  }
  for (const e of sortedEdges) {
    outbound.get(e.from)?.push(e);
    inbound.get(e.to)?.push(e);
  }

  const entries = sortedIds.filter((id) => (inbound.get(id)?.length ?? 0) === 0);
  const order = topologicalOrder(sortedIds, outbound, inbound);

  return { stations: byId, order, edges: sortedEdges, outbound, inbound, entries };
}

/**
 * Kahn's algorithm over the sorted id list, so ties break deterministically.
 *
 * Cycles are not an error: retry back-edges are legitimate. Any node left
 * unresolved is appended in sorted order, and the engine reads its inbound flow
 * from the previous tick, which is both physically correct and
 * order-independent.
 */
export function topologicalOrder(
  sortedIds: readonly NodeId[],
  outbound: ReadonlyMap<NodeId, readonly SimEdge[]>,
  inbound: ReadonlyMap<NodeId, readonly SimEdge[]>,
): readonly NodeId[] {
  const indegree = new Map<NodeId, number>();
  for (const id of sortedIds) indegree.set(id, inbound.get(id)?.length ?? 0);

  const ready = sortedIds.filter((id) => (indegree.get(id) ?? 0) === 0);
  const result: NodeId[] = [];
  const seen = new Set<NodeId>();

  while (ready.length > 0) {
    ready.sort();
    const id = ready.shift();
    if (id === undefined || seen.has(id)) continue;
    seen.add(id);
    result.push(id);
    for (const e of outbound.get(id) ?? []) {
      const next = (indegree.get(e.to) ?? 0) - 1;
      indegree.set(e.to, next);
      if (next === 0 && !seen.has(e.to)) ready.push(e.to);
    }
  }

  for (const id of sortedIds) if (!seen.has(id)) result.push(id);
  return result;
}

export interface Route {
  readonly hops: readonly NodeId[];
  readonly edges: readonly SimEdge[];
  /** Share of entry traffic taking this route. Routes from one entry sum to 1. */
  readonly share: number;
  readonly entry: NodeId;
}

const MAX_ROUTES = 256;

/**
 * Enumerate simple paths from each entry to each terminal station.
 *
 * Capped, because a dense graph has combinatorially many paths and the game's
 * topologies are small by design. Hitting the cap means the topology is more
 * tangled than any level should require.
 */
export function enumerateRoutes(g: SimGraph): readonly Route[] {
  const routes: Route[] = [];

  for (const entry of g.entries) {
    const found: { hops: NodeId[]; edges: SimEdge[]; weight: number }[] = [];

    const walk = (node: NodeId, hops: NodeId[], edges: SimEdge[], weight: number): void => {
      if (found.length >= MAX_ROUTES) return;
      const station = g.stations.get(node);
      const out = g.outbound.get(node) ?? [];

      // A terminal station, or a dead end, ends the route.
      if (station?.routing.kind === 'terminal' || out.length === 0) {
        found.push({ hops: [...hops], edges: [...edges], weight });
        return;
      }

      // A cache-split station terminates the hit fraction here and forwards the
      // miss fraction, so it is both an endpoint and a waypoint.
      if (station?.routing.kind === 'cache-split') {
        found.push({ hops: [...hops], edges: [...edges], weight });
      }

      const totalWeight = out.reduce((acc, e) => acc + e.weight, 0) || 1;
      for (const e of out) {
        if (hops.includes(e.to)) continue; // no revisits: keeps paths simple
        walk(e.to, [...hops, e.to], [...edges, e], (weight * e.weight) / totalWeight);
      }
    };

    walk(entry, [entry], [], 1);

    const totalWeight = found.reduce((acc, f) => acc + f.weight, 0) || 1;
    for (const f of found) {
      routes.push({ hops: f.hops, edges: f.edges, share: f.weight / totalWeight, entry });
    }
  }

  return routes;
}

/** Per-edge deterministic latency contributions, resolved once per topology. */
export interface EdgeCost {
  readonly propagationMs: number;
  readonly setupMs: number;
  readonly transferMs: number;
}

export function edgeCost(
  edge: SimEdge,
  g: SimGraph,
  regions: ReadonlyMap<RegionId, Region>,
  responseBytes: number,
): EdgeCost {
  const from = g.stations.get(edge.from);
  const to = g.stations.get(edge.to);
  const a = from ? regions.get(from.regionId) : undefined;
  const b = to ? regions.get(to.regionId) : undefined;

  const rtt = a && b ? rttMs(a, b) : 0;
  const p = edge.protocol;
  const handshakes = p.handshakeRtts + (p.requiresClientCert === true ? 1 : 0);

  return {
    // One-way for the request leg; the response leg is counted by the next hop
    // or by the terminal, so a round trip is never double-charged.
    propagationMs: rtt,
    setupMs: (1 - p.connectionReuse) * handshakes * rtt,
    transferMs: transferMs(responseBytes, edge.bandwidthMbps),
  };
}
