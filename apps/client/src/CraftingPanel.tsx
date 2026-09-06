/**
 * Le panneau « Fabrication » : un objectif de stock par arme, par habit ou
 * par lingot, borné à 0..20 côté affichage (`render/terrain.ts::clampCraftTarget`
 * — le sim, lui, accepte n'importe quel entier, voir `Command::SetCraftTarget`).
 * Habits et lingots passent par la même commande que les armes : le sim ne
 * fait pas la différence, seul `recipe_for` sait si un genre a une recette.
 *
 * Purement présentationnel, comme `CaravanPanel` : il reçoit le stock et les
 * objectifs courants du dernier `frame` et rend des rappels ; c'est `App.tsx`
 * qui encode `SetCraftTarget` et l'émet. Sans poste de fabrication
 * (`Feature::CraftingSpot`) sur la carte, personne ne taille rien quel que
 * soit l'objectif (`crates/sim/src/craft.rs`) ; le lingot se travaille à part,
 * à la forge (`Feature::Forge`), d'où sa propre note.
 */

import { clampCraftTarget, ITEM_NAMES } from "./render/terrain";

/**
 * Contrat avec `sim::ItemKind` : les sept genres avec une recette
 * (`crates/sim/src/craft.rs::RECIPES`), armes puis habits puis métal — même
 * ordre que le sim, qui fabrique les armes en premier à stock partagé, le
 * lingot avant l'épée qu'il alimente.
 */
const CRAFTABLE_KINDS = [6, 7, 8, 14, 15, 17, 18] as const;

/**
 * Nom affiché au pluriel pour les deux genres du métal : `ITEM_NAMES` les
 * garde au singulier (« métal », « épée », contrat du HUD stock), mais la
 * ligne d'objectif se lit comme celle d'une arme (« Gourdins », « Épées »).
 */
const CRAFT_NAMES: Readonly<Record<number, string>> = { 17: "lingots", 18: "épées" };

/** Rappel de recette pour les deux genres du métal, à la suite du stock en cours. */
const CRAFT_RECIPE_HINT: Readonly<Record<number, string>> = {
  17: "à la forge, 3 minerais",
  18: "4 lingots",
};

export interface CraftingPanelProps {
  /** Stock rangé par genre, index = `items::ItemKind` (le `stored` du `frame`). */
  readonly stored: readonly number[];
  /** Objectifs courants, index = `items::ItemKind` (le `craftTargets` du `frame`). */
  readonly targets: readonly number[];
  /** Faux si aucun `Feature::CraftingSpot` n'existe encore sur la carte. */
  readonly hasCraftingSpot: boolean;
  /** Faux si aucun `Feature::Forge` n'existe encore sur la carte (compté comme `hasCraftingSpot`). */
  readonly hasForge: boolean;
  readonly onSetTarget: (kind: number, target: number) => void;
  readonly onClose: () => void;
}

export function CraftingPanel({
  stored,
  targets,
  hasCraftingSpot,
  hasForge,
  onSetTarget,
  onClose,
}: CraftingPanelProps) {
  return (
    <div className="craft-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Fabrication</div>
      {!hasCraftingSpot && <div className="help">nécessite un poste de fabrication</div>}
      {!hasForge && <div className="help">Lingots : nécessite une forge</div>}
      <ul className="craft-list">
        {CRAFTABLE_KINDS.map((kind) => {
          const target = targets[kind] ?? 0;
          const hint = CRAFT_RECIPE_HINT[kind];
          return (
            <li key={kind} className="craft-row">
              <span className="craft-name">{CRAFT_NAMES[kind] ?? ITEM_NAMES[kind]}</span>
              <span className="help">
                en stock {stored[kind] ?? 0}
                {hint ? ` · ${hint}` : ""}
              </span>
              <span className="craft-target">
                <button disabled={target <= 0} onClick={() => onSetTarget(kind, clampCraftTarget(target - 1))}>
                  −
                </button>
                <span className="craft-target-value">{target}</span>
                <button disabled={target >= 20} onClick={() => onSetTarget(kind, clampCraftTarget(target + 1))}>
                  +
                </button>
              </span>
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
