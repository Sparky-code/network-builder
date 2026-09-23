import {
  edgeId, nodeId, protocolId, regionId,
  type ComponentTypeId, type ProtocolProfile, type Topology,
} from '@nb/schema';
import { makeStation, type RoutingSpec, type SimEdge, type Station } from '@nb/sim';
import type { Catalog } from './types';
import { DEFAULT_PROTOCOL, PROTOCOLS } from './protocols';
import { CATALOG } from './components';

/**
 * Compile a player's topology into simulation input.
 *
 * This is the whole reason `@nb/catalog` exists as a separate layer: the engine
 * stays free of domain nouns, and every game concept is translated in exactly
 * one place.
 */

export interface CompileOptions {
  /** Link bandwidth, applied uniformly. Act IV varies it per link. */
  readonly bandwidthMbps?: number;
}

export interface CompiledTopology {
  readonly stations: readonly Station[];
  readonly edges: readonly SimEdge[];
}

const DEFAULT_BANDWIDTH_MBPS = 1000;

function asNumber(v: unknown, fallback: number): number {
  return typeof v === 'number' && Number.isFinite(v) ? v : fallback;
}

function asBoolean(v: unknown, fallback: boolean): boolean {
  return typeof v === 'boolean' ? v : fallback;
}

export function compile(
  topology: Topology,
  catalog: Catalog,
  options: CompileOptions = {},
): CompiledTopology {
  const bandwidthMbps = options.bandwidthMbps ?? DEFAULT_BANDWIDTH_MBPS;
  const stations: Station[] = [];

  for (const node of topology.nodes) {
    const type = catalog.get(node.typeId);
    if (type === undefined) continue;

    const template = type.simTemplate;
    const config: Record<string, unknown> = { ...node.config };

    const servers = template.servers === 'infinite'
      ? Number.POSITIVE_INFINITY
      : asNumber(config['servers'], template.servers);

    const serviceMeanMs = asNumber(config['serviceMeanMs'], template.serviceMeanMs);

    // Player config overrides the template's routing parameters where the
    // component exposes them - a TTL dial is a routing parameter, not a knob
    // bolted onto the side of one.
    let routing: RoutingSpec = template.routing;
    if (routing.kind === 'cache-split') {
      const keyCardinalityFactor = asNumber(config['keyCardinalityFactor'], 1);
      routing = {
        kind: 'cache-split',
        ttlSeconds: asNumber(config['ttlSeconds'], routing.ttlSeconds),
        collapsing: asBoolean(config['collapsing'], routing.collapsing),
        ...(keyCardinalityFactor !== 1 ? { keyCardinalityFactor } : {}),
      };
    }

    stations.push(makeStation({
      id: node.id,
      regionId: node.regionId,
      servers,
      serviceMeanMs,
      serviceCv2: template.serviceCv2,
      queueLimit: Number.isFinite(servers) && template.queueLimitPerServer !== undefined
        ? servers * template.queueLimitPerServer
        : Number.POSITIVE_INFINITY,
      cryptoCpuMs: template.cryptoCpuMs ?? 0,
      ...(template.admission !== undefined ? { admission: template.admission } : {}),
      routing,
    }));
  }

  const edges: SimEdge[] = topology.edges.map((e) => {
    const protocol: ProtocolProfile = PROTOCOLS.get(e.config.protocolId) ?? DEFAULT_PROTOCOL;
    return {
      id: e.id,
      from: e.from.nodeId,
      to: e.to.nodeId,
      weight: e.config.weight ?? 1,
      protocol,
      bandwidthMbps,
    };
  });

  return { stations, edges };
}

/**
 * Convenience for tests and fixtures: build a topology without the ceremony.
 *
 * Ports are resolved from the catalog by matching protocols, rather than
 * guessed from node names. An earlier version inferred them from the id, which
 * silently produced edges referencing ports that did not exist - the validator
 * caught it, which is the validator working, but the helper should not have
 * been generating invalid topologies in the first place.
 */
export function topo(
  nodes: readonly {
    id: string; type: string; region: string; config?: Record<string, unknown>;
  }[],
  links: readonly {
    from: string; to: string; fromPort?: string; toPort?: string;
    protocol?: string; weight?: number;
  }[],
  catalog: Catalog = CATALOG,
): Topology {
  const typeOfNode = new Map(nodes.map((n) => [n.id, catalog.get(n.type as ComponentTypeId)]));

  const resolve = (link: (typeof links)[number]): { fromPort: string; toPort: string } => {
    if (link.fromPort !== undefined && link.toPort !== undefined) {
      return { fromPort: link.fromPort, toPort: link.toPort };
    }
    const fromType = typeOfNode.get(link.from);
    const toType = typeOfNode.get(link.to);
    const outs = (fromType?.ports ?? []).filter((p) => p.direction === 'out');
    const ins = (toType?.ports ?? []).filter((p) => p.direction === 'in');

    // The unique protocol-compatible pair, when there is one.
    for (const o of outs) {
      for (const i of ins) {
        if (o.protocol === i.protocol) {
          return { fromPort: link.fromPort ?? o.id, toPort: link.toPort ?? i.id };
        }
      }
    }
    // No compatible pair: emit the first of each so the validator can report the
    // real problem rather than an invented one about missing ports.
    return {
      fromPort: link.fromPort ?? outs[0]?.id ?? 'out',
      toPort: link.toPort ?? ins[0]?.id ?? 'in',
    };
  };

  return {
    nodes: nodes.map((n) => ({
      id: nodeId(n.id),
      typeId: n.type as ComponentTypeId,
      regionId: regionId(n.region),
      config: (n.config ?? {}) as Topology['nodes'][number]['config'],
    })),
    edges: links.map((l, i) => {
      const { fromPort, toPort } = resolve(l);
      return {
        // Only [A-Za-z0-9_-]. These ids reach the DOM and selector-based
        // lookups in the editor, where '>' and '#' are actively hostile.
        id: edgeId(`e-${i}-${safeId(l.from)}-${safeId(l.to)}`),
        from: { nodeId: nodeId(l.from), portId: fromPort },
        to: { nodeId: nodeId(l.to), portId: toPort },
        config: {
          protocolId: protocolId(l.protocol ?? DEFAULT_PROTOCOL.id),
          ...(l.weight !== undefined ? { weight: l.weight } : {}),
        },
      };
    }),
  };
}

const safeId = (v: string): string => v.replace(/[^A-Za-z0-9_-]+/g, '_');
