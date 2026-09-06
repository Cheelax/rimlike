import { Icon } from "./ui/Icon";
/**
 * Le panneau « Recherche » : six technologies (`crates/sim/src/research.rs`).
 * Les cinq premières n'apportent qu'un bonus une fois acquises, aucune ne
 * verrouille quoi que ce soit ; la sixième (Métallurgie) fait exception et
 * déverrouille la forge (voir `research.ts::TECH_METALLURGY`, `App.tsx`
 * grise l'outil Forge tant qu'elle n'est pas acquise). Purement
 * présentationnel, comme `CraftingPanel` : il reçoit l'état décodé du dernier
 * `frame` (`research.ts::decodeResearch`) et laisse `App.tsx` encoder et
 * émettre `SetResearch`. Sans établi de recherche (`Feature::ResearchBench`)
 * sur la carte, ni colon dont la priorité Rechercher est active, rien
 * n'avance quel que soit le choix : une note le rappelle, comme
 * `CraftingPanel` le fait pour le poste de fabrication.
 */

import { researchPercent, TECHS } from "./research";
import type { ResearchState } from "./research";

export interface ResearchPanelProps {
  /** État décodé de `frame.researchState` (`research.ts::decodeResearch`). */
  readonly state: ResearchState;
  /** Faux si aucun `Feature::ResearchBench` n'existe encore sur la carte. */
  readonly hasResearchBench: boolean;
  /** Clic sur une technologie non acquise. */
  readonly onSelect: (tech: number) => void;
  /** Bouton « Arrêter » : équivaut à `onSelect(255)`, mais nommé pour se lire au clic. */
  readonly onStop: () => void;
  readonly onClose: () => void;
}

export function ResearchPanel({ state, hasResearchBench, onSelect, onStop, onClose }: ResearchPanelProps) {
  return (
    <div className="research-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Recherche<button className="panel-close" aria-label="Fermer : Recherche" onClick={onClose}><Icon name="close" size={18} /></button></div>
      <div className="help">
        Il faut un établi de recherche et un colon dont la priorité Rechercher est active.
      </div>
      {!hasResearchBench && <div className="help">Aucun établi de recherche</div>}
      <ul className="research-list">
        {TECHS.map((tech) => {
          const info = state.techs.find((t) => t.tech === tech.value) ?? null;
          const done = info?.done ?? false;
          const current = state.current === tech.value;
          const pct = info ? researchPercent(info.progress, info.cost) : 0;
          return (
            <li key={tech.value} className={`research-row${current ? " current" : ""}${done ? " done" : ""}`}>
              <button
                className="research-name"
                disabled={done}
                onClick={() => onSelect(tech.value)}
                title={tech.description}
              >
                {tech.name}
                {current ? " · en cours" : ""}
              </button>
              <div className="help">{tech.description}</div>
              {done ? (
                <div className="research-done">acquise</div>
              ) : (
                <div className="research-progress">
                  <span className="bar-track">
                    <span className="bar-fill" style={{ width: `${pct}%` }} />
                  </span>
                  <span className="research-percent">
                    {info ? `${info.progress} / ${info.cost}` : "0 / 0"} · {pct} %
                  </span>
                </div>
              )}
            </li>
          );
        })}
      </ul>
      <button className="wide" disabled={state.current === null} onClick={onStop}>
        Arrêter
      </button>
      <button className="wide" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}
