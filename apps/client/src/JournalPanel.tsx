/**
 * Panneau « Journal » (touche N) : les événements reçus depuis le début de la
 * session, les plus récents en haut, avec un filtre menaces/colonie.
 *
 * Purement présentationnel : `App.tsx` accumule les entrées dans un `useRef`
 * depuis la boucle qui alimente déjà les toasts (`sim.events()`), jamais un
 * second lecteur. `text` est figé au moment de la réception (`eventLabel` avec
 * les `names` d'alors), pas recalculé ici. `kind` et `arg`, eux, voyagent pour
 * que `resolveTarget` (`eventFocus.ts` via `App.tsx`) recalcule la cible d'un
 * clic à **chaque rendu** : un pawn mort depuis la réception redevient `null`
 * sans qu'on ait besoin de le suivre ici (mission « clic sur un événement » §3).
 */

import { eventCategory, formatEventTime, type EventCategory } from "./render/terrain";
import type { EventTarget } from "./eventFocus";

export interface JournalEntry {
  readonly seq: number;
  readonly tick: number;
  readonly kind: number;
  readonly arg: number;
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
  /**
   * Cible d'une entrée (`eventFocus.ts`), recalculée à chaque rendu — donc à
   * chaque ouverture ou rafraîchissement du panneau, jamais figée à la
   * réception : un colon mort ou parti depuis n'affiche plus le repère et ne
   * répond plus au clic.
   */
  readonly resolveTarget: (kind: number, arg: number) => EventTarget;
  /** Recentre la caméra sur la cible d'une entrée et sélectionne le pawn visé, le cas échéant. */
  readonly onActivate: (kind: number, arg: number) => void;
}

const FILTERS: { id: JournalFilter; label: string }[] = [
  { id: "all", label: "Tout" },
  { id: "threat", label: "Menaces" },
  { id: "colony", label: "Colonie" },
];

export function JournalPanel({
  entries,
  ticksPerDay,
  filter,
  onFilterChange,
  onClose,
  resolveTarget,
  onActivate,
}: JournalPanelProps) {
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
        {shown.map((e) => {
          const target = resolveTarget(e.kind, e.arg);
          return (
            <li
              key={e.seq}
              className={target ? "clickable" : undefined}
              role={target ? "button" : undefined}
              tabIndex={target ? 0 : undefined}
              onClick={target ? () => onActivate(e.kind, e.arg) : undefined}
              onKeyDown={
                target
                  ? (ev) => {
                      if (ev.key === "Enter" || ev.key === " ") onActivate(e.kind, e.arg);
                    }
                  : undefined
              }
            >
              <span className="journal-time">{formatEventTime(e.tick, ticksPerDay)}</span> · {e.text}
              {target && <span className="journal-target">⌖</span>}
            </li>
          );
        })}
      </ul>
      <button className="wide" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}
