/**
 * Source unique de l'aide des raccourcis (`HelpPanel.tsx`, touche `?`/`F1`) :
 * `SHORTCUTS` est construit à partir de `TOOLS` (la barre d'outils,
 * `tools.ts`) et de `KEY` (les lettres des bascules de panneaux, aussi lues
 * par le gestionnaire de `keydown` dans `App.tsx`) — jamais recopié à la
 * main, pour que l'aide ne puisse pas diverger des vrais raccourcis.
 *
 * `Q`/`E` (rotation caméra), `1`/`2`/`3` (vitesse), `Échap` et `Espace`
 * restent des littéraux ici comme dans `App.tsx` : ce sont des conventions
 * d'interface stables, pas des bascules de panneau susceptibles de changer de
 * lettre au fil des phases (contrairement à `TOOLS` et `KEY`, seuls sujets à
 * divergence réelle).
 */

import { TOOLS } from "./tools";

/** Lettres des bascules de panneaux, réutilisées telles quelles dans le gestionnaire de `keydown` de `App.tsx`. */
export const KEY = {
  material: "T",
  work: "J",
  craft: "K",
  research: "R",
  journal: "N",
  heat: "I",
  caravan: "V",
  selectAll: "A",
  help: "?",
  helpAlt: "F1",
} as const;

export type ShortcutGroup = "caméra" | "sélection" | "outils" | "panneaux" | "partie";

export interface ShortcutEntry {
  /** Touche ou combinaison, à afficher comme un `<kbd>` (`HelpPanel.tsx`). Plusieurs touches
   *  indépendantes pour une même ligne se séparent par « / » entouré d'espaces
   *  (« Q / E ») ; un « / » collé aux lettres (« Ctrl/Cmd ») fait partie d'une
   *  seule touche composée et ne se découpe pas (voir `shortcuts.test.ts`). */
  keys: string;
  action: string;
  group: ShortcutGroup;
}

export const SHORTCUTS: ShortcutEntry[] = [
  // --- Caméra ---
  { keys: "Flèches", action: "Déplacer la caméra", group: "caméra" },
  { keys: "Q / E", action: "Tourner la caméra par pas de 90°", group: "caméra" },
  // --- Sélection ---
  { keys: `Ctrl/Cmd + ${KEY.selectAll}`, action: "Sélectionner tous les colons de la colonie", group: "sélection" },
  {
    keys: "Échap",
    action: "Ferme un panneau ouvert (aide, options…), sinon quitte l'outil en cours, sinon désélectionne",
    group: "sélection",
  },
  // --- Outils (`TOOLS`, barre d'outils) ---
  ...TOOLS.filter((t) => t.key !== "").map((t) => ({ keys: t.key, action: t.label, group: "outils" as const })),
  { keys: KEY.material, action: "Changer le matériau de construction (bois / pierre)", group: "outils" },
  // --- Panneaux ---
  { keys: KEY.work, action: "Panneau Travail (priorités)", group: "panneaux" },
  { keys: KEY.craft, action: "Panneau Fabrication (armes et habits)", group: "panneaux" },
  { keys: KEY.research, action: "Panneau Recherche technologique", group: "panneaux" },
  { keys: KEY.journal, action: "Journal des événements", group: "panneaux" },
  { keys: KEY.heat, action: "Bascule l'affichage des températures (Chaleur)", group: "panneaux" },
  { keys: KEY.caravan, action: "Panneau Caravane (colonies du monde partagé)", group: "panneaux" },
  { keys: `${KEY.help} / ${KEY.helpAlt}`, action: "Cette aide", group: "panneaux" },
  // --- Partie ---
  { keys: "Espace", action: "Pause (solo uniquement)", group: "partie" },
  { keys: "1 / 2 / 3", action: "Vitesse de jeu ×1 / ×2 / ×3 (solo uniquement)", group: "partie" },
];

/** Clé `localStorage` du rappel de première partie (voir `App.tsx`). */
const SEEN_KEY = "rimlike.help.seen.v1";

/**
 * Lecture protégée, comme `settings.ts` : mode privé ou stockage bloqué
 * retombent sur « jamais vu » plutôt que de jeter.
 */
export function hasSeenHelp(): boolean {
  try {
    return localStorage.getItem(SEEN_KEY) !== null;
  } catch {
    return false;
  }
}

/** Écriture protégée : le rappel réapparaîtrait à la prochaine partie si le stockage est indisponible. */
export function markHelpSeen(): void {
  try {
    localStorage.setItem(SEEN_KEY, "1");
  } catch {
    /* stockage indisponible : tant pis, ce n'est qu'un rappel */
  }
}
