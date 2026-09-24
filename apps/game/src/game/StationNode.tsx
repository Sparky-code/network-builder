import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { useEffect, useRef, useState } from 'react';
import {
  Cloud, Database, Minus, Network, Plus, Server, Settings, Shield, Trash2, Users,
} from 'lucide-react';
import { store } from './state';
import type { ComponentType } from '@nb/catalog';

/**
 * A station on the canvas.
 *
 * Each component type gets its own icon and accent so the topology is readable
 * as a shape at a glance, before any label is read — which matters once a
 * diagram has a dozen boxes in it.
 *
 * State is never carried by colour alone: an error also changes the border to
 * dashed and adds an icon, and saturation shows as a fill level as well as a
 * hue.
 *
 * The queue tank (`.station-queue`) is the backlog visual: an accumulating
 * quantity, not the utilization percentage the thin bottom bar already shows.
 * Its fill height, its peak marker and its live count are all written
 * imperatively from PacketOverlay's rAF loop, never from React props - see
 * that file for why. It only renders for component types that can actually
 * queue (have a finite `queueLimitPerServer`); a load balancer or cache never
 * accumulates a backlog, so it never gets a tank.
 */

const ICONS: Record<string, typeof Server> = {
  client: Users,
  origin: Server,
  database: Database,
  'load-balancer': Network,
  'cdn-pop': Cloud,
  'origin-shield': Shield,
};

export interface StationNodeData extends Record<string, unknown> {
  readonly type: ComponentType;
  readonly metric: string;
  readonly detail: string;
  readonly hasError: boolean;
  readonly hasWarning: boolean;
  /** Present when this component exposes a slot count the player can change. */
  readonly servers: number | null;
  /** A traffic source cannot be removed; without it there is nothing to serve. */
  readonly removable: boolean;
}

/**
 * Controls live on the block, behind a gear.
 *
 * Two playtest findings shaped this. First, a component could only be removed
 * from the side panel - select it here, act on it there. Second, revealing the
 * controls on hover alone left them undiscovered: nothing on the block said
 * they existed, so nobody went looking.
 *
 * A gear is always visible and says "there is something here"; the controls
 * themselves stay out of the diagram until asked for.
 */
function StationControls({ id, data }: { id: string; data: StationNodeData }) {
  const [open, setOpen] = useState(false);
  const wrapRef = useRef<HTMLDivElement | null>(null);

  // Dismiss on a click anywhere else, and on Escape. A panel that can only be
  // closed by the control that opened it is a trap on a canvas you are
  // constantly clicking around.
  useEffect(() => {
    if (!open) return;
    const onPointer = (e: PointerEvent): void => {
      if (!wrapRef.current?.contains(e.target as Node)) setOpen(false);
    };
    const onKey = (e: KeyboardEvent): void => { if (e.key === 'Escape') setOpen(false); };
    // Capture phase: the canvas stops propagation on its own handlers.
    document.addEventListener('pointerdown', onPointer, true);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('pointerdown', onPointer, true);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  // React Flow starts a node drag on pointer down, which swallows the click.
  const stop = {
    onMouseDown: (e: React.MouseEvent) => e.stopPropagation(),
    onPointerDown: (e: React.PointerEvent) => e.stopPropagation(),
  };
  const setServers = (n: number): void =>
    store.updateConfig(id, { servers: Math.max(1, Math.min(64, n)) });

  const editable = data.servers !== null || data.removable;
  if (!editable) return null;

  return (
    <div className="station-gear-wrap" ref={wrapRef} {...stop}>
      <button
        type="button"
        className="station-gear"
        aria-label={`Edit ${data.type.label}`}
        aria-expanded={open}
        title="Edit"
        {...stop}
        onClick={(e) => {
          e.stopPropagation();
          // Opening the settings selects the block, which is what raises it.
          // Reaching for a control should bring the thing you are editing to
          // the front, not leave it underneath its neighbour.
          if (!open) store.select(id);
          setOpen(!open);
        }}
      >
        <Settings size={13} strokeWidth={2} />
      </button>

      {open && (
        <div className="station-panel" role="group" aria-label={`${data.type.label} settings`}>
          {data.servers !== null && (
            <div className="station-field">
              <span className="station-field-label">
                Service slots
                <span className="muted"> · {data.servers * 50} rps</span>
              </span>
              <div className="station-stepper">
                <button
                  type="button" aria-label="Fewer slots" disabled={data.servers <= 1} {...stop}
                  onClick={(e) => { e.stopPropagation(); setServers((data.servers ?? 1) - 1); }}
                >
                  <Minus size={13} strokeWidth={2.4} />
                </button>
                <input
                  type="range" min={1} max={32} value={data.servers}
                  aria-label="Service slots"
                  {...stop}
                  onChange={(e) => setServers(Number(e.target.value))}
                />
                <button
                  type="button" aria-label="More slots" {...stop}
                  onClick={(e) => { e.stopPropagation(); setServers((data.servers ?? 1) + 1); }}
                >
                  <Plus size={13} strokeWidth={2.4} />
                </button>
                <span className="station-stepper-value">{data.servers}</span>
              </div>
            </div>
          )}

          {data.removable && (
            <button
              type="button" className="station-remove" {...stop}
              onClick={(e) => { e.stopPropagation(); store.removeNode(id); }}
            >
              <Trash2 size={13} strokeWidth={2.2} />
              Remove {data.type.label}
            </button>
          )}
        </div>
      )}
    </div>
  );
}

function StationNodeInner({ data, selected, id }: NodeProps) {
  const d = data as StationNodeData;

  const Icon = ICONS[d.type.id as string] ?? Server;
  const inPort = d.type.ports.find((p) => p.direction === 'in');
  const outPort = d.type.ports.find((p) => p.direction === 'out');
  const state = d.hasError ? 'error' : d.hasWarning ? 'warning' : 'ok';
  const queues = d.type.simTemplate.queueLimitPerServer !== undefined;

  return (
    <div
      data-station={id}
      data-state={state}
      data-tier={d.type.cost.tier}
      data-selected={selected ? 'true' : 'false'}
      className="station"
    >
      <StationControls id={id} data={d} />
      {inPort !== undefined && (
        <Handle type="target" position={Position.Left} className="station-handle" />
      )}

      <div className="station-icon" aria-hidden="true">
        <Icon size={17} strokeWidth={1.9} />
      </div>

      <div className="station-body">
        <div className="station-label">{d.type.label}</div>
        <div className="station-meta">
          {d.metric !== '' && <span className="station-metric">{d.metric}</span>}
          {d.detail !== '' && <span className="station-detail">{d.detail}</span>}
          {/* Populated imperatively, per frame, from the real backlog count -
              never from a React prop. Empty and collapsed until there is one. */}
          {queues && <span className="station-queue-count" aria-hidden="true" />}
        </div>
      </div>

      {queues && (
        <div className="station-queue" aria-hidden="true">
          {/* High-water mark: stays in place as the fill recedes below it,
              so a player can still see how deep the queue got after it drains. */}
          <div className="station-queue-peak" />
          <div className="station-queue-fill" />
        </div>
      )}

      {/* Written imperatively from the rAF loop. A shape or a hue can say that a
          state exists; only a word says which one. */}
      <span className="station-status" aria-live="polite" />

      {state !== 'ok' && (
        <span
          className="station-flag"
          role="img"
          aria-label={state === 'error' ? 'Has an error' : 'Has a warning'}
        >
          {state === 'error' ? '✕' : '!'}
        </span>
      )}

      {/* Written imperatively from the rAF loop; never a React-owned value. */}
      <div className="station-load" aria-hidden="true">
        <div className="station-load-fill" />
      </div>

      {outPort !== undefined && (
        <Handle type="source" position={Position.Right} className="station-handle" />
      )}
    </div>
  );
}

export const StationNode = memo(StationNodeInner);
