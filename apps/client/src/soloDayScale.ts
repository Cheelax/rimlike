/**
 * Choix de l'échelle du jour de la prochaine partie solo, sans DOM ni
 * dépendance au sim — le même modèle que `soloBiome.ts`, et pour la même
 * raison : c'est un réglage de l'accueil, mémorisé d'une partie à l'autre.
 *
 * Deux valeurs seulement, parce qu'il n'y a que deux intentions :
 *
 * - **le monde** (`WORLD_DAY_SCALE`, 30) : le rythme du multijoueur, le même
 *   jeu partout — un jour de jeu en 2 h réelles, une saison en 30 h, une année
 *   en 5 jours (`docs/PLAN.md` §6). C'est le défaut : le solo n'est pas un
 *   autre jeu que le monde partagé.
 * - **partie rapide** (1) : le rythme d'origine du sim, un jour de jeu en
 *   quatre minutes réelles. Une option, pas le défaut.
 *
 * Une sauvegarde solo porte son échelle : elle est dans le snapshot du sim
 * (`docs/time.md`), donc « Charger » rejoue à l'échelle de la partie chargée,
 * pas à celle qui est cochée ici.
 */
import { DEFAULT_DAY_SCALE, WORLD_DAY_SCALE } from "@rimlike/protocol";

export const SOLO_DAY_SCALES = [WORLD_DAY_SCALE, DEFAULT_DAY_SCALE] as const;

export type SoloDayScale = (typeof SOLO_DAY_SCALES)[number];
export const DEFAULT_SOLO_DAY_SCALE: SoloDayScale = WORLD_DAY_SCALE;
const KEY = "rimlike.solo.dayScale.v1";

/** Libellé de chaque choix, pour le sélecteur de l'accueil. */
export const SOLO_DAY_SCALE_LABELS: Readonly<Record<SoloDayScale, string>> = {
  [WORLD_DAY_SCALE]: "Monde (jour de 2 h)",
  [DEFAULT_DAY_SCALE]: "Partie rapide (jour de 4 min)",
};

export function isSoloDayScale(value: unknown): value is SoloDayScale {
  return SOLO_DAY_SCALES.some((scale) => scale === value);
}

/** Stockage absent, JSON illisible ou valeur inconnue : l'échelle du monde. */
export function loadSoloDayScale(): SoloDayScale {
  try {
    const raw = localStorage.getItem(KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return isSoloDayScale(value) ? value : DEFAULT_SOLO_DAY_SCALE;
  } catch {
    return DEFAULT_SOLO_DAY_SCALE;
  }
}

export function saveSoloDayScale(scale: SoloDayScale): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(isSoloDayScale(scale) ? scale : DEFAULT_SOLO_DAY_SCALE));
  } catch {
    /* stockage indisponible : le choix reste valable pour cette session */
  }
}
