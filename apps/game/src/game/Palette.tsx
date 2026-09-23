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

/**
 * Only components the level has unlocked. A palette showing everything would
 * make every level look like every other level and hide the arc entirely.
 */
export function Palette() {
  const available = LEVEL.unlocked
    .map((id) => CATALOG.get(id as never))
    .filter((c): c is NonNullable<typeof c> => c !== undefined);

  return (
    <div className="palette">
      {available.map((type, i) => {
        const Icon = ICONS[type.id as string] ?? Server;
        return (
          <button
            key={type.id}
            type="button"
            className="palette-item"
            onClick={() => store.addNode(type.id as string, { x: 300, y: 320 + i * 110 })}
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
