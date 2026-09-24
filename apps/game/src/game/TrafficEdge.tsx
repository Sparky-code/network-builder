import { memo, useState } from 'react';
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from '@xyflow/react';
import { Unlink } from 'lucide-react';
import { store } from './state';

/**
 * A connection, and the control that removes it.
 *
 * The first attempt put a permanently half-visible 17px circle on every wire.
 * It read as decoration, it was too small to aim at, and it cluttered a diagram
 * whose whole job is being legible - so it failed the criterion it was written
 * for. This version inverts that: nothing is drawn until you approach the wire,
 * and then the control is unambiguous and large enough to hit.
 *
 * The hover target is a 24px-wide invisible stroke along the whole edge rather
 * than the button itself, so the control appears when you move toward the wire,
 * not only when you happen to cross a small disc at its midpoint.
 */
function TrafficEdgeInner({
  id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, selected, data,
}: EdgeProps) {
  const settled = data?.['settled'] === true;
  const healthy = data?.['healthy'] === true;
  const [hovered, setHovered] = useState(false);
  const [path, labelX, labelY] = getBezierPath({
    sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition,
  });

  const shown = hovered || selected === true;

  return (
    <>
      <BaseEdge
        id={id} path={path} className="traffic-edge"
        data-armed={shown}
        data-settled={settled ? (healthy ? 'healthy' : 'strained') : 'no'}
      />
      {/* Wide invisible stroke: a 2px line is a cruel hit target. */}
      <path
        d={path}
        className="traffic-edge-hit"
        fill="none"
        onMouseEnter={() => setHovered(true)}
        onMouseLeave={() => setHovered(false)}
      />
      <EdgeLabelRenderer>
        <div
          className="edge-control"
          data-shown={shown}
          style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
        >
          <button
            type="button"
            className="edge-disconnect"
            title="Disconnect"
            aria-label="Disconnect these components"
            /* React Flow begins a pane interaction on pointer down and would
               swallow the click before it lands. */
            onMouseDown={(e) => e.stopPropagation()}
            onPointerDown={(e) => e.stopPropagation()}
            onClick={(e) => { e.stopPropagation(); e.preventDefault(); store.removeEdge(id); }}
          >
            <Unlink size={14} strokeWidth={2.2} />
          </button>
        </div>
      </EdgeLabelRenderer>
    </>
  );
}

export const TrafficEdge = memo(TrafficEdgeInner);
