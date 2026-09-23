import { useEffect, useRef } from 'react';
import { getBezierPath, Position, useStore, useStoreApi } from '@xyflow/react';
import { rng } from '@nb/sim';
import { CATALOG } from '@nb/catalog';
import type { RunResult } from '@nb/schema';
import type { Topology } from '@nb/schema';

/**
 * Packet animation, drawn on a canvas that sits over the React Flow pane.
 *
 * Three rules, from ADR 0003, and all three exist because the naive version is
 * structurally hard to undo once it is baked into every node component:
 *
 *   1. Packets are never React components and never SVG elements. Hundreds of
 *      animated SVG nodes destroy paint and layout.
 *   2. Edge geometry is sampled into a lookup table on topology change, never
 *      per frame.
 *   3. The viewport transform is read imperatively inside the frame loop, so
 *      panning and zooming cost no React work at all.
 */

/* Must match .station in game.css: packets attach to the box edges. */
const STATION_W = 208;
const STATION_H = 66;
const MAX_PACKETS = 2000;
const LUT_SAMPLES = 64;
/** Beyond this, dots stop being countable and density has to stand in. */
const VISIBLE_RPS_CAP = 240;

interface EdgeGeometry {
  readonly id: string;
  readonly lut: Float64Array;
  readonly targetId: string;
  /** Share of total offered traffic on this edge. */
  readonly share: number;
}

interface Props {
  readonly topology: Topology;
  readonly positions: Readonly<Record<string, { x: number; y: number }>>;
  readonly result: RunResult | null;
  readonly playhead: number;
}

/** Sample a bezier into an (x,y) lookup table, once per topology change. */
function buildLut(sx: number, sy: number, tx: number, ty: number): Float64Array {
  const [d] = getBezierPath({
    sourceX: sx, sourceY: sy, sourcePosition: Position.Right,
    targetX: tx, targetY: ty, targetPosition: Position.Left,
  });
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('d', d);
  const total = path.getTotalLength();
  const lut = new Float64Array(LUT_SAMPLES * 2);
  for (let i = 0; i < LUT_SAMPLES; i++) {
    const p = path.getPointAtLength((i / (LUT_SAMPLES - 1)) * total);
    lut[i * 2] = p.x;
    lut[i * 2 + 1] = p.y;
  }
  return lut;
}

/** Flow share per edge, by walking outward from entry nodes. */
function edgeShares(topology: Topology): Map<string, number> {
  const out = new Map<string, string[]>();
  for (const n of topology.nodes) out.set(n.id as string, []);
  for (const e of topology.edges) out.get(e.from.nodeId as string)?.push(e.id as string);

  const inbound = new Set(topology.edges.map((e) => e.to.nodeId as string));
  const entries = topology.nodes.filter((n) => !inbound.has(n.id as string));

  const shares = new Map<string, number>();
  const visit = (node: string, share: number, depth: number): void => {
    if (depth > 16) return;
    const edges = out.get(node) ?? [];
    if (edges.length === 0) return;
    const each = share / edges.length;
    for (const id of edges) {
      shares.set(id, (shares.get(id) ?? 0) + each);
      const edge = topology.edges.find((e) => (e.id as string) === id);
      if (edge !== undefined) visit(edge.to.nodeId as string, each, depth + 1);
    }
  };
  for (const entry of entries) visit(entry.id as string, 1 / Math.max(1, entries.length), 0);
  return shares;
}

/**
 * The backlog ceiling for a station, in requests - the same number the engine
 * clamps `backlogReqs` against before it starts shedding (`station.ts`).
 *
 * Used to scale the queue-depth visual. Anchoring the scale to the station's
 * real shedding threshold, rather than a made-up constant, means a full tank
 * means something: it is the exact moment requests start getting rejected.
 * Types with no `queueLimitPerServer` (client, load balancer, caches) never
 * queue, so they have no ceiling and no tank is drawn for them.
 */
function queueLimitOf(topology: Topology): Map<string, number> {
  const limits = new Map<string, number>();
  for (const n of topology.nodes) {
    const type = CATALOG.get(n.typeId);
    const perServer = type?.simTemplate.queueLimitPerServer;
    if (type === undefined || perServer === undefined) continue;
    const templateServers = type.simTemplate.servers === 'infinite'
      ? Number.POSITIVE_INFINITY
      : type.simTemplate.servers;
    const cfgServers = n.config['servers'];
    const servers = typeof cfgServers === 'number' && Number.isFinite(cfgServers)
      ? cfgServers
      : templateServers;
    if (Number.isFinite(servers) && servers > 0) {
      limits.set(n.id as string, servers * perServer);
    }
  }
  return limits;
}

export function PacketOverlay({ topology, positions, result, playhead }: Props) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const storeApi = useStoreApi();
  const width = useStore((s) => s.width);
  const height = useStore((s) => s.height);

  // Live values the frame loop reads without re-subscribing.
  const geometryRef = useRef<EdgeGeometry[]>([]);
  const runRef = useRef<{ result: RunResult | null; playhead: number }>({ result, playhead });
  runRef.current = { result, playhead };

  // Queue capacity per station, in requests. Sampled on topology change, like
  // edge geometry - it depends on component type and server count, not on
  // anything that changes per frame.
  const queueLimitsRef = useRef<Map<string, number>>(new Map());
  useEffect(() => {
    queueLimitsRef.current = queueLimitOf(topology);
  }, [topology]);

  // Running high-water mark of backlog, per station, at every frame of the
  // run - computed once per result rather than tracked live, so scrubbing the
  // playhead backwards shows the correct peak-so-far instead of one left over
  // from a forward play that never happened. This is the "persistent trace of
  // the peak": once the fill recedes below it during drain, the gap between
  // the two is a player-visible measure of how much recovery is still owed.
  const peakSeriesRef = useRef<Map<string, Float32Array>>(new Map());
  useEffect(() => {
    const series = new Map<string, Float32Array>();
    if (result !== null) {
      const ids = new Set<string>();
      for (const f of result.frames) for (const id of Object.keys(f.stations)) ids.add(id);
      const running = new Map<string, number>();
      for (const id of ids) series.set(id, new Float32Array(result.frames.length));
      result.frames.forEach((f, i) => {
        for (const id of ids) {
          const cur = f.stations[id]?.backlogReqs ?? 0;
          const next = Math.max(running.get(id) ?? 0, cur);
          running.set(id, next);
          series.get(id)![i] = next;
        }
      });
    }
    peakSeriesRef.current = series;
  }, [result]);

  useEffect(() => {
    const geometry: EdgeGeometry[] = [];
    const shares = edgeShares(topology);
    for (const e of topology.edges) {
      const a = positions[e.from.nodeId as string];
      const b = positions[e.to.nodeId as string];
      if (a === undefined || b === undefined) continue;
      geometry.push({
        id: e.id as string,
        lut: buildLut(a.x + STATION_W, a.y + STATION_H / 2, b.x, b.y + STATION_H / 2),
        targetId: e.to.nodeId as string,
        share: shares.get(e.id as string) ?? 0,
      });
    }
    geometryRef.current = geometry;
  }, [topology, positions]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (canvas === null) return;
    const ctx = canvas.getContext('2d');
    if (ctx === null) return;

    const reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    // Parallel typed arrays with a free list: no allocation in the hot loop.
    const t = new Float32Array(MAX_PACKETS);
    const speed = new Float32Array(MAX_PACKETS);
    const edgeIdx = new Uint16Array(MAX_PACKETS);
    const fate = new Uint8Array(MAX_PACKETS); // 0 alive, 1 dropped
    const alive = new Uint8Array(MAX_PACKETS);
    const free: number[] = [];
    for (let i = MAX_PACKETS - 1; i >= 0; i--) free.push(i);

    const accumulators = new Float64Array(64);
    let raf = 0;
    let last = 0;
    let frameNo = 0;
    let spawnCounter = 0;

    const styles = getComputedStyle(document.documentElement);
    const inkOk = styles.getPropertyValue('--color-primary').trim() || '#3b82f6';
    const inkBad = styles.getPropertyValue('--color-danger').trim() || '#ef4444';

    const frame = (now: number): void => {
      raf = requestAnimationFrame(frame);
      const dt = last === 0 ? 0 : Math.min(0.05, (now - last) / 1000);
      last = now;
      frameNo += 1;

      // Read the viewport imperatively. Subscribing to it would re-render React
      // on every pan and zoom, which is exactly what this overlay avoids.
      const [tx, ty, zoom] = storeApi.getState().transform;

      ctx.setTransform(1, 0, 0, 1, 0, 0);
      ctx.clearRect(0, 0, canvas.width, canvas.height);
      ctx.setTransform(zoom, 0, 0, zoom, tx, ty);

      const geometry = geometryRef.current;
      const { result: r, playhead: ph } = runRef.current;
      const frameData = r !== null && ph >= 0 ? r.frames[ph] : undefined;

      if (frameData !== undefined && !reduceMotion) {
        const offered = frameData.completedRps;
        const dropFraction = frameData.offeredRps > 0
          ? (frameData.droppedRps + frameData.erroredRps) / frameData.offeredRps
          : 0;

        for (let g = 0; g < geometry.length && g < accumulators.length; g++) {
          const geo = geometry[g];
          if (geo === undefined) continue;
          // Above the cap, dots stop being countable, so density stands in for
          // rate and the readout carries the number.
          const visible = Math.min(VISIBLE_RPS_CAP, offered * geo.share);
          accumulators[g] = (accumulators[g] ?? 0) + visible * dt;
          let n = Math.floor(accumulators[g] ?? 0);
          accumulators[g] = (accumulators[g] ?? 0) - n;
          while (n-- > 0) {
            const slot = free.pop();
            if (slot === undefined) break;
            alive[slot] = 1;
            t[slot] = 0;
            edgeIdx[slot] = g;
            // Transit slows as the receiving station saturates, because the
            // utilization driving it is the simulation's, not a flourish.
            // Per-tick station data reflects this instant, not the run's
            // average, so a packet visibly slows down as the spike lands.
            const util = frameData.stations[geo.targetId]?.utilization
              ?? r?.perNode[geo.targetId]?.utilization ?? 0;
            speed[slot] = 1 / (0.45 + Math.min(2.5, util) * 0.5);
            // Purpose-keyed, so nothing drawn here can perturb a graded number.
            // The 'viz' stream is independent of every stream the engine uses.
            spawnCounter += 1;
            fate[slot] = rng(1, 'viz', frameNo, spawnCounter) < dropFraction ? 1 : 0;
          }
        }
      }

      ctx.lineCap = 'round';
      for (let i = 0; i < MAX_PACKETS; i++) {
        if (alive[i] === 0) continue;
        const next = (t[i] ?? 0) + (speed[i] ?? 1) * dt;
        if (next >= 1) { alive[i] = 0; free.push(i); continue; }
        t[i] = next;

        const geo = geometry[edgeIdx[i] ?? 0];
        if (geo === undefined) { alive[i] = 0; free.push(i); continue; }

        // A dropped packet stops partway and fades, rather than arriving.
        const dropped = fate[i] === 1;
        const travel = dropped ? Math.min(next, 0.62) : next;
        const s = travel * (LUT_SAMPLES - 1);
        const i0 = Math.floor(s);
        const frac = s - i0;
        const i1 = Math.min(LUT_SAMPLES - 1, i0 + 1);
        const x = (geo.lut[i0 * 2] ?? 0) * (1 - frac) + (geo.lut[i1 * 2] ?? 0) * frac;
        const y = (geo.lut[i0 * 2 + 1] ?? 0) * (1 - frac) + (geo.lut[i1 * 2 + 1] ?? 0) * frac;

        ctx.globalAlpha = dropped && next > 0.62 ? Math.max(0, 1 - (next - 0.62) * 4) : 0.85;
        ctx.fillStyle = dropped ? inkBad : inkOk;
        ctx.beginPath();
        ctx.arc(x, y, dropped ? 3.4 : 2.6, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;

      // Node-internal visuals bypass React entirely: the saturation bar and
      // the queue tank are CSS custom properties written straight to the
      // element. At 60fps this is the difference between a smooth canvas and
      // a re-render storm.
      if (r !== null) {
        const limits = queueLimitsRef.current;
        const peaks = peakSeriesRef.current;
        for (const el of document.querySelectorAll<HTMLElement>('[data-station]')) {
          const id = el.dataset['station'];
          if (id === undefined) continue;
          const st = frameData?.stations[id];

          // Utilization: this tick's load against capacity, when the frame
          // has it - the run-wide average otherwise (e.g. before a run).
          const util = st?.utilization ?? r.perNode[id]?.utilization ?? 0;
          el.style.setProperty('--util', String(Math.min(1, util)));
          el.dataset['saturated'] = util >= 0.85 ? 'true' : 'false';

          // Backlog: an accumulating quantity, not a ratio. The tank's fill
          // fraction is scaled against the station's real shedding ceiling,
          // so 100% is not an arbitrary cap - it is the instant the door
          // starts turning requests away, and the plateau there is the
          // saturate-and-shed phase, distinct from build and drain.
          const backlog = st?.backlogReqs ?? 0;
          const limit = limits.get(id) ?? Number.POSITIVE_INFINITY;
          const backlogFrac = Number.isFinite(limit) && limit > 0
            ? Math.min(1, backlog / limit) : 0;
          const peakVal = peaks.get(id)?.[Math.max(0, ph)] ?? 0;
          const peakFrac = Number.isFinite(limit) && limit > 0
            ? Math.min(1, peakVal / limit) : 0;
          el.style.setProperty('--backlog-frac', String(backlogFrac));
          el.style.setProperty('--backlog-peak-frac', String(peakFrac));
          el.dataset['queueState'] = (st?.droppedRps ?? 0) > 0
            ? 'shedding' : backlog > 0 ? 'queued' : 'idle';

          const countEl = el.querySelector<HTMLElement>('.station-queue-count');
          if (countEl !== null) {
            countEl.textContent = backlog >= 1 ? `${Math.round(backlog)} queued` : '';
          }
        }
      } else {
        // No run to draw: leave nothing stale from a previous one on a
        // reused DOM node (React Flow keeps nodes with the same id mounted).
        for (const el of document.querySelectorAll<HTMLElement>('[data-station]')) {
          el.style.setProperty('--util', '0');
          el.style.setProperty('--backlog-frac', '0');
          el.style.setProperty('--backlog-peak-frac', '0');
          el.dataset['saturated'] = 'false';
          el.dataset['queueState'] = 'idle';
          const countEl = el.querySelector<HTMLElement>('.station-queue-count');
          if (countEl !== null) countEl.textContent = '';
        }
      }
    };

    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [storeApi]);

  return (
    <canvas
      ref={canvasRef}
      className="packet-overlay"
      width={Math.max(1, Math.floor(width))}
      height={Math.max(1, Math.floor(height))}
      aria-hidden="true"
    />
  );
}
