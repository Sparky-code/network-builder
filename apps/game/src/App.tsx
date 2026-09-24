import { useEffect, useMemo, useState, useSyncExternalStore } from 'react';
import {
  Background, Controls, ReactFlow, ReactFlowProvider, useReactFlow,
  type Connection, type Edge, type Node, type NodeChange,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { Check, Lightbulb, Moon, Play, Repeat, RotateCcw, Sun, Trophy } from 'lucide-react';
import { CATALOG, compile, hasErrors, validate } from '@nb/catalog';
import { simulate } from '@nb/sim';
import { useTheme } from './hooks/use-theme';
import { grade, nodeTypeOf, store, type GameState, type Grade } from './game/state';
import { LEVEL } from './game/level';
import { StationNode, type StationNodeData } from './game/StationNode';
import { TrafficEdge } from './game/TrafficEdge';
import { PacketOverlay } from './game/PacketOverlay';
import { Hud } from './game/Hud';
import { DRAG_TYPE, Palette } from './game/Palette';
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
  // Converts a cursor position into canvas coordinates, so a component is
  // created where it was dropped rather than at a constant.
  const { screenToFlowPosition } = useReactFlow();

  const nodes = useMemo<Node<StationNodeData>[]>(() => state.topology.nodes.map((n) => {
    const type = nodeTypeOf(state, n.id as string);
    const id = n.id as string;
    return {
      id,
      type: 'station',
      position: state.positions[id] ?? { x: 0, y: 0 },
      selected: state.selected === id,
      // A selected block sits above its neighbours. Without this, opening a
      // block's settings could render the panel *behind* an adjacent block -
      // you could see the control you were trying to use, underneath something
      // else.
      zIndex: state.selected === id ? 10 : 1,
      data: {
        type: type as NonNullable<typeof type>,
        servers: typeof n.config['servers'] === 'number' ? n.config['servers'] : null,
        // A traffic source is where requests come from; removing it leaves
        // nothing to simulate.
        removable: (type?.id as string | undefined) !== 'client',
        ...describe(state, id),
        hasError: state.diagnostics.some(
          (d) => d.severity === 'error' && d.nodeIds.includes(id)),
        hasWarning: state.diagnostics.some(
          (d) => d.severity === 'warning' && d.nodeIds.includes(id)),
      },
    };
  }), [state]);

  // A finished run settles the wires. Green only when it actually passed -
  // a solid green line over a failing topology would be a lie.
  const frameCount = state.result?.frames.length ?? 0;
  const settled = frameCount > 0 && state.playhead >= frameCount - 1;
  const healthy = (state.result?.perClass['api-read']?.errorRatePct ?? 100) <= 1;

  const edges = useMemo<Edge[]>(() => state.topology.edges.map((e) => ({
    id: e.id as string,
    type: 'traffic',
    source: e.from.nodeId as string,
    target: e.to.nodeId as string,
    data: { settled, healthy },
  })), [state.topology.edges, settled, healthy]);

  return (
    <ReactFlow
      nodes={nodes}
      edges={edges}
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes(DRAG_TYPE)) return;
        e.preventDefault();
        e.dataTransfer.dropEffect = 'copy';
      }}
      onDrop={(e) => {
        const typeId = e.dataTransfer.getData(DRAG_TYPE);
        if (typeId === '') return;
        e.preventDefault();
        // The drop point is the cursor; the node is anchored top-left, so
        // offset by half the box to land under the pointer rather than
        // beside it.
        const p = screenToFlowPosition({ x: e.clientX, y: e.clientY });
        store.addNode(typeId, { x: p.x - 104, y: p.y - 33 });
      }}
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

/**
 * Help you ask for, one rung at a time.
 *
 * Asked for rather than given, because a hint on screen from the first frame is
 * the answer with extra steps. Escalating rather than single, because one hint
 * is either too weak to help or strong enough to finish the level for you.
 */
function HintLadder() {
  const [shown, setShown] = useState(0);
  const total = LEVEL.hints.length;

  if (shown === 0) {
    return (
      <button type="button" className="hint-ask" onClick={() => setShown(1)}>
        <Lightbulb size={14} strokeWidth={2} />
        Stuck? Get a hint
      </button>
    );
  }

  return (
    <div className="hint-stack">
      {LEVEL.hints.slice(0, shown).map((h, i) => (
        <p key={i} className="hint-step">
          <span className="hint-rung">{i + 1}/{total}</span>
          <span className="muted">{h}</span>
        </p>
      ))}
      {shown < total && (
        <button type="button" className="hint-ask" onClick={() => setShown(shown + 1)}>
          <Lightbulb size={14} strokeWidth={2} />
          Still stuck? Tell me more
        </button>
      )}
    </div>
  );
}

/**
 * The brief, as a moment rather than a rail.
 *
 * A problem you are handed reads differently from one that was always on the
 * side of the screen. After accepting it the same text stays available in the
 * left rail, so nothing is lost by dismissing it.
 */
function BriefingModal() {
  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="brief-title">
      <div className="modal modal-wide">
        <div className="eyebrow">Act {LEVEL.act} · Level {LEVEL.number}</div>
        <h2 id="brief-title">{LEVEL.title}</h2>
        <p className="brief-text">{LEVEL.brief}</p>

        <div className="modal-objectives">
          <div className="panel-heading">To pass</div>
          <ul className="objective-list">
            {LEVEL.objectives.map((o) => (
              <li key={o.id}>
                <span className="objective-mark" aria-hidden="true">○</span>
                <strong>{o.label}</strong>
                <span className="muted">{o.detail}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="modal-actions">
          <button type="button" className="primary-button" onClick={store.start} autoFocus>
            <Play size={15} strokeWidth={2.4} />
            Start building
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * What the other shape would have done, measured.
 *
 * A level whose lesson is a tradeoff teaches only half of it if the player sees
 * only the half they built. Shown after the attempt rather than during it, and
 * only for the shape they did not choose - telling someone about the design
 * they are already looking at is not a reveal.
 *
 * The numbers come from running it through the same engine as their own run, so
 * this is a comparison rather than a claim.
 */
function TheOtherWay({ state }: { state: GameState }) {
  const comparison = useMemo(() => {
    const mine = state.result?.perClass['api-read'];
    if (mine === undefined) return null;

    // The shape they did not build is the one worth showing.
    const other = LEVEL.alternatives.find((a) => !a.matches(state.topology));
    if (other === undefined) return null;

    const result = simulate({ ...compile(other.topology, CATALOG), scenario: LEVEL.scenario });
    const theirs = validate(state.topology, CATALOG)
      .some((d) => d.code === 'single-point-of-failure');
    const otherSpof = validate(other.topology, CATALOG)
      .some((d) => d.code === 'single-point-of-failure');

    return {
      other,
      mine: { p99: mine.p99Ms, cost: state.result?.cost.totalUsdMonth ?? 0, spof: theirs },
      theirs: {
        p99: result.perClass['api-read']?.p99Ms ?? 0,
        cost: result.cost.totalUsdMonth,
        spof: otherSpof,
      },
    };
  }, [state.result, state.topology]);

  if (comparison === null) return null;
  const { other, mine, theirs } = comparison;

  return (
    <div className="other-way">
      <div className="panel-heading">The other way</div>
      <table className="compare">
        <thead>
          <tr>
            <th />
            <th>What you built</th>
            <th>{other.label}</th>
          </tr>
        </thead>
        <tbody>
          <tr>
            <th scope="row">p99</th>
            <td data-better={mine.p99 <= theirs.p99}>{Math.round(mine.p99)}ms</td>
            <td data-better={theirs.p99 < mine.p99}>{Math.round(theirs.p99)}ms</td>
          </tr>
          <tr>
            <th scope="row">Cost</th>
            <td data-better={mine.cost <= theirs.cost}>${Math.round(mine.cost)}</td>
            <td data-better={theirs.cost < mine.cost}>${Math.round(theirs.cost)}</td>
          </tr>
          <tr>
            <th scope="row">Survives a machine</th>
            <td data-better={!mine.spof}>{mine.spof ? 'No' : 'Yes'}</td>
            <td data-better={!theirs.spof}>{theirs.spof ? 'No' : 'Yes'}</td>
          </tr>
        </tbody>
      </table>
      <p className="muted">
        <strong>{other.label}</strong> buys you {other.buys.charAt(0).toLowerCase()}
        {other.buys.slice(1)} It costs you {other.costsYou.charAt(0).toLowerCase()}
        {other.costsYou.slice(1)}
      </p>
    </div>
  );
}

/** Passing is an event, not a character changing colour in a list. */
function CompleteModal({ state, grading }: { state: GameState; grading: Grade | null }) {
  const m = state.result?.perClass['api-read'];
  const cost = state.result?.cost.totalUsdMonth ?? 0;
  const best = state.best;
  const beatable = best !== null && best.costUsdMonth < cost;

  return (
    <div className="scrim" role="dialog" aria-modal="true" aria-labelledby="done-title">
      <div className="modal modal-wide">
        <div className="modal-trophy" aria-hidden="true"><Trophy size={22} strokeWidth={1.8} /></div>
        <div className="eyebrow">Level {LEVEL.number} complete</div>
        <h2 id="done-title">{LEVEL.title}</h2>

        <div className="grade-stars modal-stars" aria-label={`${grading?.stars ?? 0} of 3`}>
          {[0, 1, 2].map((i) => (
            <span key={i} className="grade-star" data-earned={i < (grading?.stars ?? 0)}>★</span>
          ))}
        </div>

        <div className="modal-figures">
          <div><span className="muted">p99</span><strong>{Math.round(m?.p99Ms ?? 0)}ms</strong></div>
          <div><span className="muted">errors</span><strong>{(m?.errorRatePct ?? 0).toFixed(1)}%</strong></div>
          <div><span className="muted">cost</span><strong>${Math.round(cost)}/mo</strong></div>
        </div>

        {/* A solved level still needs something to beat. */}
        <p className="muted">
          {best === null || best.costUsdMonth >= cost
            ? 'This is your cheapest passing design so far. A leaner one exists — the budget is not the floor.'
            : `Your best so far is $${Math.round(best.costUsdMonth)}/mo${beatable ? '' : ''}. Same stars for less money is the next thing to chase.`}
        </p>

        <TheOtherWay state={state} />

        <div className="modal-actions">
          <button type="button" className="ghost-button" onClick={store.keepPlaying}>
            Keep tuning
          </button>
          <button type="button" className="primary-button" onClick={store.keepPlaying}>
            <Check size={15} strokeWidth={2.4} />
            Done
          </button>
        </div>
      </div>
    </div>
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
          <HintLadder />
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

          {grading !== null && grading.stars === 3 && state.phase === 'playing' && (
            <button type="button" className="complete-button" onClick={store.complete}>
              <Trophy size={15} strokeWidth={2.2} />
              Complete level
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

      {state.phase === 'briefing' && <BriefingModal />}
      {state.phase === 'complete' && <CompleteModal state={state} grading={grading} />}

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
