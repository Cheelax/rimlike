import { ITEM_NAMES, ITEM_COLORS } from "../render/terrain";
import { Icon } from "./Icon";
export function StockPanel({ stored, freshness, onClose }: { stored: readonly number[]; freshness: readonly number[]; onClose(): void }) {
  return <section className="stock-panel" aria-label="Réserves de la colonie">
    <div className="panel-title">Réserves<button className="panel-close" onClick={onClose} aria-label="Fermer les réserves"><Icon name="close" size={18} /></button></div>
    <p className="help">Toutes les ressources rangées dans les zones de stockage.</p>
    <ul className="stock-list">{ITEM_NAMES.map((name, kind) => <li key={kind}><span className="resource-dot" style={{ background: `#${(ITEM_COLORS[kind] ?? 0xaaa).toString(16).padStart(6, "0")}` }} /><span className="stock-name">{name}{freshness[kind] >= 0 && <small>Fraîcheur : {Math.round(freshness[kind] / 10)} %</small>}</span><strong>{stored[kind] ?? 0}</strong></li>)}</ul>
  </section>;
}
