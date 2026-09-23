import type { PortRef, Topology } from '@nb/schema';
import type {
  Catalog, CapabilityTag, ComponentType, ConnectionCheck, Diagnostic, Port,
} from './types';

/**
 * One validator, three consumers.
 *
 * The editor calls `canConnect` during a drag to grey out invalid handles and
 * show the reason; the runner calls `validate` to block a run on any error; the
 * grader folds warnings into the score. No rule knowledge lives in the UI.
 */

function typeOf(catalog: Catalog, topology: Topology, nodeId: string): ComponentType | undefined {
  const node = topology.nodes.find((n) => n.id === nodeId);
  return node === undefined ? undefined : catalog.get(node.typeId);
}

function portOf(type: ComponentType | undefined, portId: string): Port | undefined {
  return type?.ports.find((p) => p.id === portId);
}

function degreeOf(topology: Topology, ref: PortRef, direction: 'in' | 'out'): number {
  return topology.edges.filter((e) => {
    const side = direction === 'out' ? e.from : e.to;
    return side.nodeId === ref.nodeId && side.portId === ref.portId;
  }).length;
}

function missingCapabilities(
  provides: readonly CapabilityTag[] | undefined,
  requires: readonly CapabilityTag[] | undefined,
): readonly CapabilityTag[] {
  if (requires === undefined || requires.length === 0) return [];
  const have = new Set(provides ?? []);
  return requires.filter((r) => !have.has(r));
}

/**
 * Is this connection legal?
 *
 * Legality is emergent rather than enumerated. A cache cannot connect to a
 * database because the cache's out-port speaks `http` and the database's
 * in-port speaks `sql` - a rule nobody wrote down, which arrives with an
 * explanation attached.
 */
export function canConnect(
  catalog: Catalog,
  topology: Topology,
  from: PortRef,
  to: PortRef,
): ConnectionCheck {
  if (from.nodeId === to.nodeId) {
    return { ok: false, code: 'self-connection', message: 'A component cannot connect to itself.' };
  }

  const fromType = typeOf(catalog, topology, from.nodeId);
  const toType = typeOf(catalog, topology, to.nodeId);
  if (fromType === undefined || toType === undefined) {
    return { ok: false, code: 'unknown-component', message: 'Unknown component type.' };
  }

  const fromPort = portOf(fromType, from.portId);
  const toPort = portOf(toType, to.portId);
  if (fromPort === undefined || toPort === undefined) {
    return { ok: false, code: 'unknown-port', message: 'That connection point does not exist.' };
  }
  if (fromPort.direction !== 'out' || toPort.direction !== 'in') {
    return {
      ok: false,
      code: 'unknown-port',
      message: 'Connections run from an output to an input.',
    };
  }

  if (fromPort.protocol !== toPort.protocol) {
    return {
      ok: false,
      code: 'protocol-mismatch',
      message:
        `${fromType.label} speaks ${fromPort.protocol} here, but ${toType.label} `
        + `expects ${toPort.protocol}.`,
      ...(toType.learnMoreId !== undefined ? { learnMoreId: toType.learnMoreId } : {}),
    };
  }

  const missing = missingCapabilities(fromPort.provides, toPort.accepts);
  if (missing.length > 0) {
    return {
      ok: false,
      code: 'missing-capability',
      message: `${toType.label} requires traffic that is ${missing.join(' and ')}.`,
      ...(toType.learnMoreId !== undefined ? { learnMoreId: toType.learnMoreId } : {}),
    };
  }

  const duplicate = topology.edges.some(
    (e) =>
      e.from.nodeId === from.nodeId && e.from.portId === from.portId
      && e.to.nodeId === to.nodeId && e.to.portId === to.portId,
  );
  if (duplicate) {
    return { ok: false, code: 'duplicate-edge', message: 'These are already connected.' };
  }

  if (degreeOf(topology, from, 'out') >= fromPort.maxDegree) {
    return {
      ok: false,
      code: 'degree-exceeded',
      message: `${fromType.label} accepts at most ${fromPort.maxDegree} outgoing connections here.`,
    };
  }
  if (degreeOf(topology, to, 'in') >= toPort.maxDegree) {
    return {
      ok: false,
      code: 'degree-exceeded',
      message: `${toType.label} accepts at most ${toPort.maxDegree} incoming connections here.`,
    };
  }

  return { ok: true };
}

/**
 * Graph-level rules that ports cannot express.
 *
 * A named registry referenced by string id from catalog and level data, rather
 * than a rule DSL invented up front and regretted later.
 */
export type RuleId =
  | 'reachability'
  | 'no-http-cycle'
  | 'single-point-of-failure'
  | 'degree-minimums';

export const GRAPH_RULES: Readonly<
  Record<RuleId, (t: Topology, c: Catalog) => readonly Diagnostic[]>
> = {
  /** Every entry point must be able to reach something that terminates. */
  reachability: (t, c) => {
    const out = new Map<string, string[]>();
    for (const n of t.nodes) out.set(n.id, []);
    for (const e of t.edges) out.get(e.from.nodeId)?.push(e.to.nodeId);

    const hasInbound = new Set(t.edges.map((e) => e.to.nodeId));
    const entries = t.nodes.filter((n) => !hasInbound.has(n.id));

    if (t.nodes.length > 0 && entries.length === 0) {
      return [{
        severity: 'error', code: 'no-entry-point',
        message: 'Nothing sends traffic into this topology.',
        nodeIds: [], edgeIds: [],
        hint: 'Add a Users component, or remove the connection making this a loop.',
      }];
    }

    const diagnostics: Diagnostic[] = [];
    for (const entry of entries) {
      const seen = new Set<string>();
      const stack: string[] = [entry.id];
      let terminates = false;
      while (stack.length > 0) {
        const id = stack.pop();
        if (id === undefined || seen.has(id)) continue;
        seen.add(id);
        const type = typeOf(c, t, id);
        if (type?.simTemplate.routing.kind === 'terminal') terminates = true;
        for (const next of out.get(id) ?? []) stack.push(next);
      }
      if (!terminates) {
        diagnostics.push({
          severity: 'error', code: 'unreachable-origin',
          message: 'Traffic from here never reaches anything that can answer it.',
          nodeIds: [entry.id], edgeIds: [],
          hint: 'Every path has to end at an origin or a database.',
          learnMoreId: 'request/anatomy',
        });
      }
    }
    return diagnostics;
  },

  /** HTTP request paths must not loop. Retry back-edges are not modelled as edges. */
  'no-http-cycle': (t) => {
    const out = new Map<string, string[]>();
    for (const n of t.nodes) out.set(n.id, []);
    for (const e of t.edges) out.get(e.from.nodeId)?.push(e.to.nodeId);

    const visiting = new Set<string>();
    const done = new Set<string>();
    const cycles: string[][] = [];

    const visit = (id: string, path: readonly string[]): void => {
      if (done.has(id)) return;
      if (visiting.has(id)) { cycles.push([...path, id]); return; }
      visiting.add(id);
      for (const next of out.get(id) ?? []) visit(next, [...path, id]);
      visiting.delete(id);
      done.add(id);
    };
    for (const n of [...t.nodes].sort((a, b) => (a.id < b.id ? -1 : 1))) visit(n.id, []);

    return cycles.map((cycle) => ({
      severity: 'error' as const, code: 'http-cycle' as const,
      message: 'These components form a loop, so a request would never finish.',
      nodeIds: cycle, edgeIds: [],
    }));
  },

  /** A warning, not an error: it affects the grade without blocking the run. */
  'single-point-of-failure': (t, c) => {
    const inboundCount = new Map<string, number>();
    for (const e of t.edges) {
      inboundCount.set(e.to.nodeId, (inboundCount.get(e.to.nodeId) ?? 0) + 1);
    }
    const diagnostics: Diagnostic[] = [];
    for (const node of t.nodes) {
      const type = c.get(node.typeId);
      if (type === undefined) continue;
      if (type.simTemplate.routing.kind !== 'terminal') continue;
      // A single terminal serving all inbound traffic has no redundancy.
      const siblings = t.edges.filter((e) =>
        t.edges.some((o) => o.to.nodeId === node.id && o.from.nodeId === e.from.nodeId),
      );
      const upstreams = new Set(siblings.map((e) => e.from.nodeId));
      let redundant = false;
      for (const up of upstreams) {
        const fanout = t.edges.filter((e) => e.from.nodeId === up).length;
        if (fanout > 1) redundant = true;
      }
      if ((inboundCount.get(node.id) ?? 0) > 0 && !redundant) {
        diagnostics.push({
          severity: 'warning', code: 'single-point-of-failure',
          message: `${type.label} is the only thing serving this traffic.`,
          nodeIds: [node.id], edgeIds: [],
          hint: 'Losing it takes everything down. More than one would not.',
          learnMoreId: 'request/vertical-horizontal',
        });
      }
    }
    return diagnostics;
  },

  /** Ports that require at least one connection must have one. */
  'degree-minimums': (t, c) => {
    const diagnostics: Diagnostic[] = [];
    for (const node of t.nodes) {
      const type = c.get(node.typeId);
      if (type === undefined) continue;
      for (const port of type.ports) {
        const degree = degreeOf(t, { nodeId: node.id, portId: port.id } as PortRef, port.direction);
        if (degree < port.minDegree) {
          diagnostics.push({
            severity: 'error', code: 'degree-unmet',
            message: `${type.label} needs at least ${port.minDegree} connection on ${port.id}.`,
            nodeIds: [node.id], edgeIds: [],
            ...(type.learnMoreId !== undefined ? { learnMoreId: type.learnMoreId } : {}),
          });
        }
      }
    }
    return diagnostics;
  },
};

export const DEFAULT_RULES: readonly RuleId[] = [
  'reachability', 'no-http-cycle', 'degree-minimums', 'single-point-of-failure',
];

/** Full validation. Errors block a run; warnings affect the grade. */
export function validate(
  topology: Topology,
  catalog: Catalog,
  rules: readonly RuleId[] = DEFAULT_RULES,
): readonly Diagnostic[] {
  const diagnostics: Diagnostic[] = [];

  for (const node of topology.nodes) {
    const type = catalog.get(node.typeId);
    if (type === undefined) {
      diagnostics.push({
        severity: 'error', code: 'unknown-component',
        message: `Unknown component type "${node.typeId}".`,
        nodeIds: [node.id], edgeIds: [],
      });
      continue;
    }
    const parsed = type.configSchema.safeParse(node.config);
    if (!parsed.success) {
      diagnostics.push({
        severity: 'error', code: 'invalid-config',
        message: `${type.label}: ${parsed.error.issues[0]?.message ?? 'invalid configuration'}.`,
        nodeIds: [node.id], edgeIds: [],
      });
    }
  }

  // Each edge is re-checked against the topology minus itself, so an existing
  // edge is not reported as a duplicate or a degree overflow of its own making.
  for (const edge of topology.edges) {
    const without: Topology = {
      nodes: topology.nodes,
      edges: topology.edges.filter((e) => e.id !== edge.id),
    };
    const check = canConnect(catalog, without, edge.from, edge.to);
    if (!check.ok) {
      diagnostics.push({
        severity: 'error', code: check.code, message: check.message,
        nodeIds: [edge.from.nodeId, edge.to.nodeId], edgeIds: [edge.id],
        ...(check.learnMoreId !== undefined ? { learnMoreId: check.learnMoreId } : {}),
      });
    }
  }

  for (const rule of rules) diagnostics.push(...GRAPH_RULES[rule](topology, catalog));

  return diagnostics;
}

export const hasErrors = (d: readonly Diagnostic[]): boolean =>
  d.some((x) => x.severity === 'error');
