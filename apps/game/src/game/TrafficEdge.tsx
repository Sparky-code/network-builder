import { memo } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { X } from 'lucide-react';
import { store } from './state';

/**
 * A connection you can actually remove.
 *
 * The first version relied on React Flow's default "select the edge and press
 * Backspace", which is invisible unless you already know it exists — so the only
 * discoverable way to change a wire was to delete both components and rebuild.
 * A visible affordance on hover fixes that; the keyboard path still works for
 * anyone who prefers it.
 */
function TrafficEdgeInner({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected,
}: EdgeProps) {
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  return (
    <>
      <BaseEdge id={id} path={path} className="traffic-edge" />
      {/* A wide invisible stroke: a 2px line is a cruel hit target. */}
      <path d={path} className="traffic-edge-hit" fill="none" />
      <EdgeLabelRenderer>
        <div
          className="edge-actions"
          data-selected={selected ? 'true' : 'false'}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
        >
          <button
            type="button"
            className="edge-delete"
            title="Disconnect"
            aria-label="Disconnect these components"
            /* React Flow begins a pane interaction on mousedown, which
               swallows the click before it lands. Both handlers are needed. */
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); store.removeEdge(id); }}
          >
            <X size={13} strokeWidth={2.5} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const TrafficEdge = memo(TrafficEdgeInner);
