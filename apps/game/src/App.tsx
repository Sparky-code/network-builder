import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Background, Controls, ReactFlow, ReactFlowProvider,
  type Connection, type Edge, type Node, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Play, Repeat, RotateCcw, Sun, Moon } from 'lucide-react';
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

/**
 * Playback is compressed to a roughly fixed wall-clock length. The ratio to
 * simulated time is deliberately not 1:1 - what a player needs to see is the
 * *shape* of the transient and the asymmetry between its halves, both of which
 * survive compression, and neither of which survives a 65-second wait.
 */
const PLAYBACK_SECONDS = 11;
/** 10Hz: the rate React is allowed to re-render at during playback. */
const TICK_MS = 100;

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
  const finished = frames > 0 && state.playhead >= frames - 1;

  // Bumping this restarts the effect below without a new run - the only way
  // to ask for a second playback of the same result.
  const [replayToken, setReplayToken] = useState(0);

  // Playback advances the playhead over a finished run once, then holds on
  // the last frame instead of looping. The simulation is already complete
  // and deterministic before anything is drawn, so this is presentation, not
  // a live simulation - but a build-then-drain transient that loops back to
  // the calm baseline mid-recovery never resolves, which is exactly the
  // asymmetry this game is trying to show. Holding at the end and offering an
  // explicit Replay control makes "it's still working through the backlog"
  // and "it's done recovering" two states a player can actually tell apart.
  useEffect(() => {
    if (state.result === null || frames === 0) return;
    // Advance several frames per step so a run always takes about the same
    // wall-clock time regardless of its simulated length. One frame per step
    // would make this level's 26-second graded window take 65 seconds to
    // watch, which no player will sit through ten times - and iterating ten
    // times cheaply is itself a requirement (gate criterion D3).
    //
    // Frame data therefore steps at 10Hz while the canvas keeps animating at
    // 60fps from whichever frame is current, which is the split the rendering
    // architecture was designed around.
    const step = Math.max(1, Math.round(frames / (PLAYBACK_SECONDS * 1000 / TICK_MS)));
    const id = window.setInterval(() => {
      const s = store.getSnapshot();
      if (s.result === null) return;
      const next = s.playhead + step;
      if (next >= s.result.frames.length - 1) {
        // Land exactly on the final frame: holding one step short would leave
        // the queue looking permanently part-drained.
        store.setPlayhead(s.result.frames.length - 1);
        window.clearInterval(id);
        return;
      }
      store.setPlayhead(next);
    }, TICK_MS);
    return () => window.clearInterval(id);
  }, [state.result, frames, replayToken]);

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

          {finished && (
            <button
              type="button"
              className="ghost-button"
              onClick={() => { store.setPlayhead(0); setReplayToken((t) => t + 1); }}
            >
              <Repeat size={15} />
              Replay
            </button>
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
