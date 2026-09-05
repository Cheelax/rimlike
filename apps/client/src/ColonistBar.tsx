/**
 * Barre des colons : une pastille par colon de la colonie (faction 0),
 * purement présentationnelle comme `CaravanPanel` et `CraftingPanel`. `App.tsx`
 * la construit à chaque battement du HUD (500 ms) directement depuis les
 * tampons du `frame` — jamais un second état qui dériverait.
 */

import { moodIcon, TRAIT_LABELS } from "./render/terrain";

export interface ColonistBadge {
  readonly id: number;
  readonly name: string;
  /** Première lettre du nom, en majuscule ; « ? » si le nom est vide. */
  readonly initial: string;
  /** Couleur de faction (`render/Renderer.ts::PAWN_COLORS`), en `#rrggbb`. */
  readonly color: string;
  /** Pourcentage 0-100, dérivé de `pawn::HP_MAX`. */
  readonly hp: number;
  /** Drapeau `PAWN_FLAGS.DOWNED`. */
  readonly downed: boolean;
  /** Drapeau `PAWN_FLAGS.SLEEPING`. */
  readonly sleeping: boolean;
  /** Malade (`sim-wasm::pawn_sick` > 0), rafraîchi par `rpc("pawnSick", id)`. */
  readonly sick: boolean;
  /** Pourcentage 0-100 (`Pawn::mood`), pour l'icône d'humeur. */
  readonly mood: number;
  /** Libellé du job courant (`JOB_LABELS`), pour l'infobulle. */
  readonly job: string;
  /** Traits de caractère (`sim::Trait`, 0 à 11), 0 à 2 valeurs, pour l'infobulle. */
  readonly traits: readonly number[];
}

export interface ColonistBarProps {
  readonly colonists: readonly ColonistBadge[];
  /** Ids actuellement sélectionnés (`selection.ts`), pour surligner leurs pastilles. */
  readonly selection: readonly number[];
  /**
   * Clic : sélectionne le colon, comme un clic sur son pawn dans la scène.
   * Maj + clic (`additive`) l'ajoute à la sélection en cours, ou l'en retire.
   */
  readonly onSelect: (id: number, additive: boolean) => void;
  /** Double clic : centre la caméra sur lui (`Renderer.focusOn`). */
  readonly onFocus: (id: number) => void;
}

export function ColonistBar({ colonists, selection, onSelect, onFocus }: ColonistBarProps) {
  if (colonists.length === 0) return null;
  return (
    <div className="colonist-bar">
      {colonists.map((c) => (
        <button
          key={c.id}
          className={`colonist-badge${selection.includes(c.id) ? " selected" : ""}`}
          style={{ borderColor: c.color }}
          onClick={(e) => onSelect(c.id, e.shiftKey)}
          onDoubleClick={() => onFocus(c.id)}
          title={`${c.name || `Colon ${c.id}`} · ${c.job}${
            c.traits.length > 0 ? ` · ${c.traits.map((t) => TRAIT_LABELS[t] ?? "?").join(", ")}` : ""
          }`}
        >
          <span className="colonist-initial" style={{ background: c.color }}>
            {c.initial}
          </span>
          <span className="colonist-mood">{moodIcon(c.mood)}</span>
          {c.downed && <span className="colonist-dot downed" />}
          {c.sleeping && <span className="colonist-dot sleeping" />}
          {c.sick && <span className="colonist-dot sick" />}
          <span className="colonist-hp-track">
            <span className="colonist-hp-fill" style={{ width: `${Math.max(0, Math.min(100, c.hp))}%` }} />
          </span>
        </button>
      ))}
    </div>
  );
}
