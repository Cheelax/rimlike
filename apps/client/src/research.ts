/**
 * Recherche technologique (`crates/sim/src/research.rs`) : logique pure, sans
 * sim ni rendu — décodage de `research_state()` et calculs affichés par
 * `ResearchPanel` et le HUD (`App.tsx`).
 *
 * Rien n'est verrouillé : chaque technologie n'apporte qu'un bonus une fois
 * acquise, jamais une condition pour construire ou fabriquer quoi que ce soit.
 */

/**
 * Contrat avec `sim::research::Tech` : `value` = index de l'enum, dans
 * l'ordre attendu par `Command::SetResearch` (voir `encodeSetResearch`).
 * Les coûts en points (2 000, 2 500, 2 500, 3 000, 3 000) viennent du sim via
 * `research_state()` : ils ne sont pas dupliqués ici.
 */
export interface TechInfo {
  readonly value: number;
  readonly name: string;
  readonly description: string;
}

export const TECHS: readonly TechInfo[] = [
  { value: 0, name: "Agriculture", description: "cultures : rendement +25 %" },
  { value: 1, name: "Médecine", description: "soins et cicatrisation des pansements 50 % plus vite" },
  { value: 2, name: "Conservation", description: "péremption des vivres divisée par deux" },
  { value: 3, name: "Archerie", description: "portée de tir 10 cases, dégâts +25 %" },
  { value: 4, name: "Maçonnerie", description: "bâtir en pierre 25 % plus vite" },
];

/** 255 : aucune recherche en cours (`sim-wasm::research_state`, champ `current`). */
const NO_RESEARCH = 255;

/** Trois entiers par technologie dans `research_state()` : avancement, coût, acquise. */
const RESEARCH_STRIDE = 3;

/** Une ligne de `ResearchState.techs`, dans l'ordre de `TECHS`. */
export interface TechState {
  /** Index de `sim::research::Tech`, comme `TechInfo.value`. */
  readonly tech: number;
  readonly progress: number;
  readonly cost: number;
  readonly done: boolean;
}

export interface ResearchState {
  /** Technologie en cours de recherche, `null` si aucune (`current` = 255 côté sim). */
  readonly current: number | null;
  readonly techs: readonly TechState[];
}

/**
 * Décode `research_state()` (`sim-wasm`, 16 entiers : `[courante,
 * (avancement, coût, acquise) × 5]`) en une structure lisible. Un tampon trop
 * court (sim pas encore démarré, ou pas assez de technologies dedans) rend
 * les lignes qu'il peut plutôt que de planter ; un tampon vide rend un état
 * vide, `current` compris.
 */
export function decodeResearch(buffer: ArrayLike<number>): ResearchState {
  const raw = buffer.length > 0 ? buffer[0] : NO_RESEARCH;
  const techs: TechState[] = [];
  for (let tech = 0; tech < TECHS.length; tech++) {
    const o = 1 + tech * RESEARCH_STRIDE;
    if (o + RESEARCH_STRIDE > buffer.length) break;
    techs.push({ tech, progress: buffer[o], cost: buffer[o + 1], done: buffer[o + 2] !== 0 });
  }
  return { current: raw === NO_RESEARCH ? null : raw, techs };
}

/**
 * Pourcentage d'avancement d'une technologie, entier borné à 0..100. `cost`
 * nul, négatif ou non fini (tampon pas encore reçu) donne 0 plutôt que de
 * diviser par zéro.
 */
export function researchPercent(progress: number, cost: number): number {
  if (!Number.isFinite(progress) || !Number.isFinite(cost) || cost <= 0) return 0;
  return Math.max(0, Math.min(100, Math.round((progress / cost) * 100)));
}
