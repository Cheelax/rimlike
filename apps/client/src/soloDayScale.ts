/**
 * Choix de l'échelle du jour de la prochaine partie solo, sans DOM ni
 * dépendance au sim — le même modèle que `soloBiome.ts`, et pour la même
 * raison : c'est un réglage de l'accueil, mémorisé d'une partie à l'autre.
 *
 * Deux valeurs seulement, parce qu'il n'y a que deux intentions :
 *
 * - **partie rapide** (1) : le rythme d'origine du sim, un jour de jeu en
 *   quatre minutes réelles. C'est le défaut depuis le 2026-11-09 : au rythme du
 *   monde, une première partie solo s'ennuie avant le premier raid (un mur en
 *   75 s, une récolte en 3 h ; `docs/PLAN.md`, journal du 2026-11-09).
 * - **le monde** (`WORLD_DAY_SCALE`, 30) : le rythme du multijoueur — un jour
 *   de jeu en 2 h réelles, une saison en 30 h, une année en 5 jours
 *   (`docs/PLAN.md` §6). Une option, pour éprouver en solo le jeu du monde.
 *
 * Une sauvegarde solo porte son échelle : elle est dans le snapshot du sim
 * (`docs/time.md`), donc « Charger » rejoue à l'échelle de la partie chargée,
 * pas à celle qui est cochée ici.
 */
import { DEFAULT_DAY_SCALE, WORLD_DAY_SCALE } from "@rimlike/protocol";

export const SOLO_DAY_SCALES = [DEFAULT_DAY_SCALE, WORLD_DAY_SCALE] as const;

export type SoloDayScale = (typeof SOLO_DAY_SCALES)[number];
export const DEFAULT_SOLO_DAY_SCALE: SoloDayScale = DEFAULT_DAY_SCALE;
const KEY = "rimlike.solo.dayScale.v1";

/** Libellé de chaque choix, pour le sélecteur de l'accueil. */
export const SOLO_DAY_SCALE_LABELS: Readonly<Record<SoloDayScale, string>> = {
  [DEFAULT_DAY_SCALE]: "Partie rapide (jour de 4 min)",
  [WORLD_DAY_SCALE]: "Monde (jour de 2 h)",
};

export function isSoloDayScale(value: unknown): value is SoloDayScale {
  return SOLO_DAY_SCALES.some((scale) => scale === value);
}

/** Stockage absent, JSON illisible ou valeur inconnue : la partie rapide. */
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
