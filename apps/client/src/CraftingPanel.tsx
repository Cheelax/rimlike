/**
 * Le panneau « Fabrication » : un objectif de stock par arme ou par habit,
 * borné à 0..20 côté affichage (`render/terrain.ts::clampCraftTarget` — le
 * sim, lui, accepte n'importe quel entier, voir `Command::SetCraftTarget`).
 * Les habits passent par la même commande que les armes : le sim ne fait pas
 * la différence, seul `recipe_for` sait si un genre a une recette.
 *
 * Purement présentationnel, comme `CaravanPanel` : il reçoit le stock et les
 * objectifs courants du dernier `frame` et rend des rappels ; c'est `App.tsx`
 * qui encode `SetCraftTarget` et l'émet. Sans poste de fabrication
 * (`Feature::CraftingSpot`) sur la carte, personne ne fabrique quel que soit
 * l'objectif (`crates/sim/src/craft.rs`) : une note le rappelle.
 */

import { clampCraftTarget, ITEM_NAMES } from "./render/terrain";

/**
 * Contrat avec `sim::ItemKind` : les cinq genres avec une recette
 * (`crates/sim/src/craft.rs::RECIPES`), armes puis habits — même ordre que le
 * sim, qui fabrique les armes en premier à stock partagé.
 */
const CRAFTABLE_KINDS = [6, 7, 8, 14, 15] as const;

export interface CraftingPanelProps {
  /** Stock rangé par genre, index = `items::ItemKind` (le `stored` du `frame`). */
  readonly stored: readonly number[];
  /** Objectifs courants, index = `items::ItemKind` (le `craftTargets` du `frame`). */
  readonly targets: readonly number[];
  /** Faux si aucun `Feature::CraftingSpot` n'existe encore sur la carte. */
  readonly hasCraftingSpot: boolean;
  readonly onSetTarget: (kind: number, target: number) => void;
  readonly onClose: () => void;
}

export function CraftingPanel({ stored, targets, hasCraftingSpot, onSetTarget, onClose }: CraftingPanelProps) {
  return (
    <div className="craft-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Fabrication</div>
      {!hasCraftingSpot && <div className="help">nécessite un poste de fabrication</div>}
      <ul className="craft-list">
        {CRAFTABLE_KINDS.map((kind) => {
          const target = targets[kind] ?? 0;
          return (
            <li key={kind} className="craft-row">
              <span className="craft-name">{ITEM_NAMES[kind]}</span>
              <span className="help">en stock {stored[kind] ?? 0}</span>
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
