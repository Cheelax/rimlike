/** Choix de la prochaine carte solo, sans DOM ni dépendance au sim. */
import { Biome } from "@rimlike/world";

export const SOLO_BIOMES = [
  Biome.Ice,
  Biome.Tundra,
  Biome.BorealForest,
  Biome.TemperateForest,
  Biome.Grassland,
  Biome.Desert,
  Biome.Savanna,
  Biome.Jungle,
  Biome.Mountain,
] as const;

export type SoloBiome = (typeof SOLO_BIOMES)[number];
export const DEFAULT_SOLO_BIOME: SoloBiome = Biome.TemperateForest;
const KEY = "rimlike.solo.biome.v1";

export function isSoloBiome(value: unknown): value is SoloBiome {
  return SOLO_BIOMES.some((biome) => biome === value);
}

/** Stockage absent, JSON illisible, océan ou valeur inconnue : forêt tempérée. */
export function loadSoloBiome(): SoloBiome {
  try {
    const raw = localStorage.getItem(KEY);
    const value: unknown = raw === null ? null : JSON.parse(raw);
    return isSoloBiome(value) ? value : DEFAULT_SOLO_BIOME;
  } catch {
    return DEFAULT_SOLO_BIOME;
  }
}

export function saveSoloBiome(biome: SoloBiome): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(isSoloBiome(biome) ? biome : DEFAULT_SOLO_BIOME));
  } catch {
    /* stockage indisponible : le choix reste valable pour cette session */
  }
}
