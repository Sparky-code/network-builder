import { CATALOG } from '@nb/catalog';
import { nodeTypeOf, store, type GameState } from './state';

/** Configuration for the selected component, and the only way to delete one. */
export function Inspector({ state }: { state: GameState }) {
  const id = state.selected;
  if (id === null) {
    return <p className="muted">Click a component on the canvas to configure it.</p>;
  }

  const type = nodeTypeOf(state, id);
  const node = state.topology.nodes.find((n) => n.id === id);
  if (type === undefined || node === undefined) return null;

  const servers = typeof node.config['servers'] === 'number'
    ? node.config['servers']
    : undefined;

  return (
    <div className="inspector">
      <div className="inspector-title">{type.label}</div>
      <p className="muted inspector-summary">{type.summary}</p>

      {servers !== undefined && (
        <label className="field">
          <span className="field-label">
            Service slots: <strong>{servers}</strong>
            <span className="muted"> — {servers * 50} rps of capacity</span>
          </span>
          <input
            type="range"
            min={1}
            max={32}
            value={servers}
            onChange={(e) => store.updateConfig(id, { servers: Number(e.target.value) })}
          />
        </label>
      )}

      {CATALOG.get(node.typeId)?.act === 1 && node.typeId === 'client' ? null : (
        <button type="button" className="danger-button" onClick={() => store.removeNode(id)}>
          Remove
        </button>
      )}
    </div>
  );
}
