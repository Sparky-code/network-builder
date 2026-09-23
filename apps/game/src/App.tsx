import { useEffect, useMemo, useSyncExternalStore } from 'react';
import {
  Background, Controls, ReactFlow, ReactFlowProvider,
  type Connection, type Edge, type Node, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Play, RotateCcw, Sun, Moon } from 'lucide-react';
import { hasErrors } from '@nb/catalog';
import { useTheme } from './hooks/use-theme';
import { grade, nodeTypeOf, store, type GameState } from './game/state';
import { LEVEL } from './game/level';
import { StationNode, type StationNodeData } from './game/StationNode';
import { TrafficEdge } from './game/TrafficEdge';
import { PacketOverlay } from './game/PacketOverlay';
import { Hud } from './game/Hud';
import { Palette } from './game/Palette';
import { Inspector } from './game/Inspector';
import './game/game.css';

const nodeTypes = { station: StationNode };
const edgeTypes = { traffic: TrafficEdge };

/** The headline number for a station, and the context that makes it mean something. */
function describe(state: GameState, id: string): { metric: string; detail: string } {
  const node = state.topology.nodes.find((n) => n.id === id);
  const servers = node?.config['servers'];
  const util = state.result?.perNode[id]?.utilization;

  if (typeof servers === 'number') {
    return {
      metric: `${servers} slots`,
      // Short enough to sit beside the metric in a 208px box. The inspector
      // carries the long form.
      detail: util !== undefined && util > 0
        ? `${Math.round(util * 100)}% used`
        : `${servers * 50} rps`,
    };
  }
  if (util !== undefined && util > 0) {
    return { metric: `${Math.round(util * 100)}% used`, detail: '' };
  }
  return { metric: '', detail: '' };
}

function Canvas({ state }: { state: GameState }) {
  const nodes = useMemo<Node<StationNodeData>[]>(() => state.topology.nodes.map((n) => {
    const type = nodeTypeOf(state, n.id as string);
    const id = n.id as string;
    return {
      id,
      type: 'station',
      position: state.positions[id] ?? { x: 0, y: 0 },
      selected: state.selected === id,
      data: {
        type: type as NonNullable<typeof type>,
        ...describe(state, id),
        hasError: state.diagnostics.some(
          (d) => d.severity === 'error' && d.nodeIds.includes(id)),
        hasWarning: state.diagnostics.some(
          (d) => d.severity === 'warning' && d.nodeIds.includes(id)),
      },
    };
  }), [state]);

  const edges = useMemo<Edge[]>(() => state.topology.edges.map((e) => ({
    id: e.id as string,
    type: 'traffic',
    source: e.from.nodeId as string,
    target: e.to.nodeId as string,
  })), [state.topology.edges]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      nodeTypes={nodeTypes}
      edgeTypes={edgeTypes}
      fitView
      deleteKeyCode={['Backspace', 'Delete']}
      minZoom={0.4}
      maxZoom={1.6}
      proOptions={{ hideAttribution: true }}
      onNodesChange={(changes: NodeChange[]) => {
        for (const c of changes) {
          if (c.type === 'position' && c.position !== undefined) {
            store.moveNode(c.id, c.position);
          }
          if (c.type === 'select') store.select(c.selected ? c.id : null);
        }
      }}
      onEdgesDelete={(deleted) => { for (const e of deleted) store.removeEdge(e.id); }}
      onConnect={(c: Connection) => {
        if (c.source !== null && c.target !== null) store.connect(c.source, c.target);
      }}
      isValidConnection={(c) => {
        const source = 'source' in c ? c.source : null;
        const target = 'target' in c ? c.target : null;
        if (source === null || target === null) return false;
        // Illegal connections are refused during the drag, with the reason
        // surfaced on drop - a mistake is the best moment to teach.
        return store.checkConnection(source, target).ok;
      }}
      onPaneClick={() => store.select(null)}
    >
      <Background gap={24} size={1} />
      <Controls showInteractive={false} />
      <PacketOverlay
        topology={state.topology}
        positions={state.positions}
        result={state.result}
        playhead={state.playhead}
      />
    </ReactFlow>
  );
}

export default function App() {
  const state = useSyncExternalStore(store.subscribe, store.getSnapshot);
  const { theme, toggleTheme } = useTheme();
  const grading = useMemo(() => grade(state), [state]);
  const blocked = hasErrors(state.diagnostics);
  const frames = state.result?.frames.length ?? 0;

  // Playback advances the playhead over a finished run. The simulation is
  // already complete and deterministic before anything is drawn; this is
  // presentation, not a live simulation.
  useEffect(() => {
    if (state.result === null || frames === 0) return;
    const id = window.setInterval(() => {
      const s = store.getSnapshot();
      if (s.result === null) return;
      store.setPlayhead((s.playhead + 1) % s.result.frames.length);
    }, 100);
    return () => window.clearInterval(id);
  }, [state.result, frames]);

  const errors = state.diagnostics.filter((d) => d.severity === 'error');
  const warnings = state.diagnostics.filter((d) => d.severity === 'warning');

  return (
    <div className="app">
      <header className="app-header">
        <div>
          <div className="eyebrow">Act {LEVEL.act} · Level {LEVEL.number}</div>
          <h1>{LEVEL.title}</h1>
        </div>
        <button
          type="button" className="ghost-button" onClick={toggleTheme}
          aria-label={`Switch to ${theme === 'dark' ? 'light' : 'dark'} theme`}
        >
          {theme === 'dark' ? <Sun size={15} /> : <Moon size={15} />}
          {theme === 'dark' ? 'Light' : 'Dark'}
        </button>
      </header>

      <aside className="app-left">
        <section className="panel">
          <div className="panel-heading">The situation</div>
          <p className="brief-text">{LEVEL.brief}</p>
          <p className="muted hint">{LEVEL.hint}</p>
        </section>
        <section className="panel">
          <div className="panel-heading">Add a component</div>
          <Palette />
        </section>
        <section className="panel">
          <div className="panel-heading">Selected</div>
          <Inspector state={state} />
        </section>
      </aside>

      <main className="app-canvas">
        <ReactFlowProvider>
          <Canvas state={state} />
        </ReactFlowProvider>

        <div className="runbar">
          <button
            type="button"
            className="primary-button"
            disabled={blocked || state.running}
            onClick={store.run}
          >
            <Play size={15} strokeWidth={2.4} />
            {state.running ? 'Running…' : 'Send traffic'}
          </button>
          <button type="button" className="ghost-button" onClick={store.reset}>
            <RotateCcw size={15} />
            Reset
          </button>

          {frames > 0 && (
            <label className="scrubber">
              <span className="scrubber-time">
                {(state.result?.frames[state.playhead]?.simTimeSec ?? 0).toFixed(1)}s
              </span>
              <input
                type="range" min={0} max={frames - 1} value={Math.max(0, state.playhead)}
                onChange={(e) => store.setPlayhead(Number(e.target.value))}
                aria-label="Playback position"
              />
            </label>
          )}

          <div className="runbar-status">
            {blocked
              ? <span className="status status-bad">{errors[0]?.message ?? 'Fix the errors first'}</span>
              : warnings.length > 0
                ? <span className="status status-warn">{warnings[0]?.message}</span>
                : <span className="status status-ok">Ready</span>}
          </div>
        </div>
      </main>

      <aside className="app-right">
        <Hud state={state} grading={grading} />
      </aside>

      {state.lastError !== null && (
        <div className="toast" role="status">
          <span>{state.lastError}</span>
          <button type="button" className="ghost-button" onClick={store.clearError}>
            Dismiss
          </button>
        </div>
      )}
    </div>
  );
}
