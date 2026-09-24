import { Cloud, Database, Network, Server, Shield, Users } from 'lucide-react';
import { CATALOG } from '@nb/catalog';
import { LEVEL } from './level';
import { store } from './state';

const ICONS: Record<string, typeof Server> = {
  client: Users,
  origin: Server,
  database: Database,
  'load-balancer': Network,
  'cdn-pop': Cloud,
  'origin-shield': Shield,
};

/** The payload a palette item carries while being dragged onto the canvas. */
export const DRAG_TYPE = 'application/x-nb-component';

/**
 * Only components the level has unlocked. A palette showing everything would
 * make every level look like every other level and hide the arc entirely.
 *
 * Items are dragged onto the canvas so a component lands where the player put
 * it. Clicking still works, for the keyboard and for anyone who would rather
 * not drag - it places into the first clear space instead of a fixed
 * coordinate, which used to stack two origins exactly on top of each other.
 */
export function Palette() {
  const available = LEVEL.unlocked
    .map((id) => CATALOG.get(id as never))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  return (
    <div className="palette">
      {available.map((type) => {
        const Icon = ICONS[type.id as string] ?? Server;
        return (
          <button
            key={type.id}
            type="button"
            className="palette-item"
            draggable
            onDragStart={(e) => {
              e.dataTransfer.setData(DRAG_TYPE, type.id as string);
              e.dataTransfer.effectAllowed = 'copy';
            }}
            onClick={() => store.addNode(type.id as string, store.nextFreePosition())}
            title={`Drag onto the canvas, or click to place ${type.label}`}
          >
            <span className="palette-icon" aria-hidden="true">
              <Icon size={17} strokeWidth={1.9} />
            </span>
            <span className="palette-name">{type.label}</span>
            <span className="palette-summary">{type.summary}</span>
          </button>
        );
      })}
    </div>
  );
}
