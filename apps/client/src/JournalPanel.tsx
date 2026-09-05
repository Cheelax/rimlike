/**
 * Panneau « Journal » (touche N) : les événements reçus depuis le début de la
 * session, les plus récents en haut, avec un filtre menaces/colonie.
 *
 * Purement présentationnel : `App.tsx` accumule les entrées dans un `useRef`
 * depuis la boucle qui alimente déjà les toasts (`sim.events()`), jamais un
 * second lecteur. `text` est figé au moment de la réception (`eventLabel` avec
 * les `names` d'alors), pas recalculé ici.
 */

import { eventCategory, formatEventTime, type EventCategory } from "./render/terrain";

export interface JournalEntry {
  readonly seq: number;
  readonly tick: number;
  readonly kind: number;
  readonly text: string;
}

export type JournalFilter = "all" | EventCategory;

export interface JournalPanelProps {
  /** Du plus ancien au plus récent (comme reçu) ; le panneau affiche l'inverse. */
  readonly entries: readonly JournalEntry[];
  readonly ticksPerDay: number;
  readonly filter: JournalFilter;
  readonly onFilterChange: (filter: JournalFilter) => void;
  readonly onClose: () => void;
}

const FILTERS: { id: JournalFilter; label: string }[] = [
  { id: "all", label: "Tout" },
  { id: "threat", label: "Menaces" },
  { id: "colony", label: "Colonie" },
];

export function JournalPanel({ entries, ticksPerDay, filter, onFilterChange, onClose }: JournalPanelProps) {
  const shown = (filter === "all" ? entries : entries.filter((e) => eventCategory(e.kind) === filter))
    .slice()
    .reverse();
  return (
    <div className="journal-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Journal</div>
      <div className="journal-filters">
        {FILTERS.map((f) => (
          <button key={f.id} className={f.id === filter ? "active" : ""} onClick={() => onFilterChange(f.id)}>
            {f.label}
          </button>
        ))}
      </div>
      <ul className="journal-list">
        {shown.length === 0 && <li className="empty">Rien à montrer</li>}
        {shown.map((e) => (
          <li key={e.seq}>
            <span className="journal-time">{formatEventTime(e.tick, ticksPerDay)}</span> · {e.text}
          </li>
        ))}
      </ul>
      <button className="wide" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}
