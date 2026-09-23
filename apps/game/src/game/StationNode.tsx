import { memo } from 'react';
import { Handle, Position, type NodeProps } from '@xyflow/react';
import { Cloud, Database, Network, Server, Shield, Users } from 'lucide-react';
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
}

function StationNodeInner({ data, selected, id }: NodeProps) {
  const d = data as StationNodeData;
  const Icon = ICONS[d.type.id as string] ?? Server;
  const inPort = d.type.ports.find((p) => p.direction === 'in');
  const outPort = d.type.ports.find((p) => p.direction === 'out');
  const state = d.hasError ? 'error' : d.hasWarning ? 'warning' : 'ok';

  return (
    <div
      data-station={id}
      data-state={state}
      data-tier={d.type.cost.tier}
      data-selected={selected ? 'true' : 'false'}
      className="station"
    >
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
        </div>
      </div>

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
