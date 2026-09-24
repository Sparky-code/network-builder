import {
  edgeId, nodeId, protocolId,
  type ComponentTypeId, type EdgeId, type PortRef, type RunResult, type Topology,
} from '@nb/schema';
import { simulate } from '@nb/sim';
import {
  CATALOG, canConnect, compile, hasErrors, validate,
  type ComponentType, type Diagnostic,
} from '@nb/catalog';
import { LEVEL } from './level';

/**
 * A tiny external store, read through `useSyncExternalStore`.
 *
 * React is deliberately not the owner of per-frame state. It renders the graph
 * and the HUD; packet motion and the playhead are driven imperatively so that
 * animation costs no React work at all.
 */

export interface Position { x: number; y: number }

export interface GameState {
  readonly topology: Topology;
  readonly positions: Readonly<Record<string, Position>>;
  readonly selected: string | null;
  readonly diagnostics: readonly Diagnostic[];
  readonly result: RunResult | null;
  /**
   * The run before this one, kept so a player can see what their change did.
   *
   * Deliberately survives topology edits, unlike `result`. Comparing across an
   * edit is the entire point: "I added a load balancer, what moved?" is the
   * question the game exists to answer, and it cannot be asked if the baseline
   * is discarded the moment the topology changes.
   */
  readonly previousResult: RunResult | null;
  readonly running: boolean;
  /** Index into result.frames during playback, or -1 when idle. */
  readonly playhead: number;
  readonly lastError: string | null;
}

type Listener = () => void;

const STARTING_POSITIONS: Record<string, Position> = {
  users: { x: 40, y: 180 },
  origin: { x: 420, y: 180 },
};

function initialState(): GameState {
  const topology = LEVEL.startingTopology;
  return {
    topology,
    positions: { ...STARTING_POSITIONS },
    selected: null,
    diagnostics: validate(topology, CATALOG),
    result: null,
    previousResult: null,
    running: false,
    playhead: -1,
    lastError: null,
  };
}

class Store {
  private state: GameState = initialState();
  private listeners = new Set<Listener>();

  subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  };

  getSnapshot = (): GameState => this.state;

  private set(patch: Partial<GameState>): void {
    this.state = { ...this.state, ...patch };
    for (const l of this.listeners) l();
  }

  private revalidate(topology: Topology, extra: Partial<GameState> = {}): void {
    this.set({
      topology,
      diagnostics: validate(topology, CATALOG),
      // An edit invalidates the current run - showing metrics for a topology
      // that no longer exists is worse than showing none - but it is also the
      // moment that run becomes worth comparing against. Demoting rather than
      // discarding is what makes "I changed one thing, what moved?" answerable;
      // clearing it outright loses the baseline in exactly the case the
      // comparison exists for.
      result: null,
      previousResult: this.state.result ?? this.state.previousResult,
      playhead: -1,
      ...extra,
    });
  }

  reset = (): void => {
    this.state = initialState();
    for (const l of this.listeners) l();
  };

  select = (id: string | null): void => this.set({ selected: id });

  addNode = (typeId: string, position: Position): void => {
    const type = CATALOG.get(typeId as ComponentTypeId);
    if (type === undefined) return;

    const base = typeId.replace(/[^a-z0-9]+/g, '-');
    let n = 1;
    let id = `${base}-${n}`;
    const taken = new Set(this.state.topology.nodes.map((x) => x.id as string));
    while (taken.has(id)) { n += 1; id = `${base}-${n}`; }

    const defaults = type.configSchema.safeParse({});
    const topology: Topology = {
      nodes: [...this.state.topology.nodes, {
        id: nodeId(id),
        typeId: type.id,
        regionId: LEVEL.scenario.regions[0]?.id ?? ('us-west' as never),
        config: (defaults.success ? defaults.data : {}) as Topology['nodes'][number]['config'],
      }],
      edges: this.state.topology.edges,
    };
    this.set({ positions: { ...this.state.positions, [id]: position } });
    this.revalidate(topology, { selected: id });
  };

  removeNode = (id: string): void => {
    const topology: Topology = {
      nodes: this.state.topology.nodes.filter((n) => n.id !== id),
      edges: this.state.topology.edges.filter(
        (e) => e.from.nodeId !== id && e.to.nodeId !== id,
      ),
    };
    const positions = { ...this.state.positions };
    delete positions[id];
    this.set({ positions, selected: null });
    this.revalidate(topology);
  };

  removeEdge = (id: string): void => {
    this.revalidate({
      nodes: this.state.topology.nodes,
      edges: this.state.topology.edges.filter((e) => e.id !== id),
    });
  };

  moveNode = (id: string, position: Position): void => {
    // Layout is not part of the topology, so moving a node changes nothing the
    // simulator can see and must not invalidate a completed run.
    this.set({ positions: { ...this.state.positions, [id]: position } });
  };

  /** Ports are resolved by protocol; the editor never asks the player to pick one. */
  resolvePorts = (fromId: string, toId: string): { from: PortRef; to: PortRef } | null => {
    const nodeType = (id: string): ComponentType | undefined => {
      const node = this.state.topology.nodes.find((n) => n.id === id);
      return node === undefined ? undefined : CATALOG.get(node.typeId);
    };
    const outs = (nodeType(fromId)?.ports ?? []).filter((p) => p.direction === 'out');
    const ins = (nodeType(toId)?.ports ?? []).filter((p) => p.direction === 'in');
    for (const o of outs) {
      for (const i of ins) {
        if (o.protocol === i.protocol) {
          return {
            from: { nodeId: nodeId(fromId), portId: o.id },
            to: { nodeId: nodeId(toId), portId: i.id },
          };
        }
      }
    }
    const o = outs[0];
    const i = ins[0];
    if (o === undefined || i === undefined) return null;
    return {
      from: { nodeId: nodeId(fromId), portId: o.id },
      to: { nodeId: nodeId(toId), portId: i.id },
    };
  };

  /** Asked during a drag, so an illegal connection is refused with a reason. */
  checkConnection = (fromId: string, toId: string): ReturnType<typeof canConnect> => {
    const ports = this.resolvePorts(fromId, toId);
    if (ports === null) {
      return { ok: false, code: 'unknown-port', message: 'These cannot be connected.' };
    }
    return canConnect(CATALOG, this.state.topology, ports.from, ports.to);
  };

  connect = (fromId: string, toId: string): void => {
    const check = this.checkConnection(fromId, toId);
    if (!check.ok) {
      this.set({ lastError: check.message });
      return;
    }
    const ports = this.resolvePorts(fromId, toId);
    if (ports === null) return;

    // Only [A-Za-z0-9_-]: these ids become DOM attributes and React Flow
    // selector lookups, where '>' and '#' silently break element targeting.
    const safe = (v: string): string => v.replace(/[^A-Za-z0-9_-]+/g, '_');
    const id: EdgeId = edgeId(
      `e-${this.state.topology.edges.length}-${safe(fromId)}-${safe(toId)}`,
    );
    this.revalidate({
      nodes: this.state.topology.nodes,
      edges: [...this.state.topology.edges, {
        id, from: ports.from, to: ports.to,
        config: { protocolId: protocolId('http2-tls13') },
      }],
    }, { lastError: null });
  };

  updateConfig = (id: string, patch: Record<string, unknown>): void => {
    this.revalidate({
      nodes: this.state.topology.nodes.map((n) =>
        n.id === id
          ? { ...n, config: { ...n.config, ...patch } as typeof n.config }
          : n),
      edges: this.state.topology.edges,
    });
  };

  run = (): void => {
    const { topology } = this.state;
    if (hasErrors(validate(topology, CATALOG))) return;
    this.set({ running: true, lastError: null });
    try {
      const compiled = compile(topology, CATALOG);
      const result = simulate({ ...compiled, scenario: LEVEL.scenario });
      // The run is complete and deterministic before anything is drawn.
      // Playback is presentation over a finished result, not a live simulation.
      this.set({
        result,
        // The run being replaced becomes the baseline for the next comparison.
        previousResult: this.state.result ?? this.state.previousResult,
        running: false,
        playhead: 0,
      });
    } catch (e) {
      this.set({
        running: false,
        lastError: e instanceof Error ? e.message : 'The simulation failed.',
      });
    }
  };

  setPlayhead = (i: number): void => {
    if (this.state.result === null) return;
    const max = this.state.result.frames.length - 1;
    this.set({ playhead: Math.max(0, Math.min(max, i)) });
  };

  clearError = (): void => this.set({ lastError: null });
}

export const store = new Store();

export function nodeTypeOf(state: GameState, id: string): ComponentType | undefined {
  const node = state.topology.nodes.find((n) => n.id === id);
  return node === undefined ? undefined : CATALOG.get(node.typeId);
}

export interface Grade {
  readonly stars: number;
  readonly sloMet: boolean;
  readonly underBudget: boolean;
  readonly resilient: boolean;
}

/** Star grading: SLO met, under budget, no single point of failure. */
export function grade(state: GameState): Grade | null {
  const { result, diagnostics } = state;
  if (result === null) return null;
  const p99 = result.perClass['api-read']?.p99Ms ?? Number.POSITIVE_INFINITY;
  const errors = result.perClass['api-read']?.errorRatePct ?? 100;

  const sloMet = p99 <= LEVEL.sloP99Ms && errors <= 1;
  const underBudget = result.cost.totalUsdMonth <= LEVEL.budgetUsdMonth;
  const resilient = !diagnostics.some((d) => d.code === 'single-point-of-failure');

  return {
    stars: [sloMet, underBudget, resilient].filter(Boolean).length,
    sloMet, underBudget, resilient,
  };
}
