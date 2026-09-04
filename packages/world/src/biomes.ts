/**
 * Climat et biomes du globe.
 *
 * Trois champs sont calculés par case, dans cet ordre :
 *
 * 1. **Élévation** dans [0, 1] : un fBm basse fréquence (le « biais
 *    continental », qui décide où sont les masses de terre) mélangé à un fBm
 *    plus fin (le relief), puis **renormalisé par quantile** sur l'ensemble
 *    du globe (voir `normalizeElevations`). Sous `SEA_LEVEL`, la case est de
 *    l'eau.
 * 2. **Température** en °C : une courbe de latitude, moins un gradient
 *    d'altitude, plus un bruit faible.
 * 3. **Humidité** dans [0, 1] : un fBm indépendant, étiré pour couvrir
 *    l'intervalle utile.
 *
 * Puis une table de décision température × humidité × élévation donne le
 * biome. Voir `docs/world.md` pour la calibration et les raisons des seuils.
 */

import {
  type TileGeometry,
  type Vec3,
  geodesicGrid,
} from "./geometry.js";
import { fbm } from "./noise.js";
import { deriveSeed } from "./rng.js";

/** Biomes du globe. Les valeurs numériques font partie du format réseau. */
export enum Biome {
  Ocean = 0,
  Ice = 1,
  Tundra = 2,
  BorealForest = 3,
  TemperateForest = 4,
  Grassland = 5,
  Desert = 6,
  Savanna = 7,
  Jungle = 8,
  Mountain = 9,
}

/** Noms lisibles, pour le HUD et les journaux. */
export const BIOME_NAMES: Readonly<Record<Biome, string>> = {
  [Biome.Ocean]: "océan",
  [Biome.Ice]: "banquise",
  [Biome.Tundra]: "toundra",
  [Biome.BorealForest]: "forêt boréale",
  [Biome.TemperateForest]: "forêt tempérée",
  [Biome.Grassland]: "prairie",
  [Biome.Desert]: "désert",
  [Biome.Savanna]: "savane",
  [Biome.Jungle]: "jungle",
  [Biome.Mountain]: "montagne",
};

/* ------------------------------------------------------------------ */
/* Sels de dérivation des sous-seeds : un champ de bruit indépendant   */
/* par grandeur physique, tous dérivés du seed de monde.               */
/* ------------------------------------------------------------------ */

const SALT_CONTINENTS = 0x1001;
const SALT_RELIEF = 0x1002;
const SALT_TEMPERATURE = 0x1003;
const SALT_MOISTURE = 0x1004;

/* ------------------------------------------------------------------ */
/* Calibration. Mesurée à n = 4 (2 562 cases) sur 24 seeds ; les       */
/* valeurs et les mesures sont reportées dans docs/world.md.           */
/* ------------------------------------------------------------------ */

/** Fréquence du fBm continental : basse, pour des continents de la taille d'un quart de globe. */
export const CONTINENT_FREQUENCY = 1.15;
/** Octaves du fBm continental. */
export const CONTINENT_OCTAVES = 4;
/** Fréquence du fBm de relief. */
export const RELIEF_FREQUENCY = 3.6;
/** Octaves du fBm de relief. */
export const RELIEF_OCTAVES = 5;
/** Poids du biais continental dans l'élévation (le reste va au relief). */
export const CONTINENT_WEIGHT = 0.62;
/** Étirement de l'élévation brute autour de 0,5 : le fBm est trop concentré sans lui. */
export const ELEVATION_CONTRAST = 2.35;

/**
 * Niveau de la mer, en unités d'élévation normalisée. Ce n'est pas un seuil
 * calibré sur le bruit : la normalisation par quantile place exactement
 * `WATER_TARGET` des cases en dessous, donc la valeur est fixée à 0,5 par
 * simple commodité de lecture.
 */
export const SEA_LEVEL = 0.5;

/**
 * Part de cases sous le niveau de la mer, imposée par la normalisation. La
 * conversion des mers polaires en banquise en retire ensuite quelques
 * points : le biome `Ocean` représente 56 à 63 % des cases à n = 4 selon
 * le seed (médiane 59 %). Voir
 * `docs/world.md`, section « Calibration des biomes ».
 */
export const WATER_TARGET = 0.64;

/**
 * Seuil de montagne, exprimé en hauteur de terre normalisée (0 au niveau de
 * la mer, 1 au point le plus haut du globe). Calibré pour ~6 % de cases de
 * montagne à n = 4.
 */
export const MOUNTAIN_HEIGHT = 0.62;

/** Température à l'équateur au niveau de la mer, en °C. */
export const EQUATOR_TEMPERATURE = 32;
/** Température au pôle au niveau de la mer, en °C. */
export const POLE_TEMPERATURE = -30;
/** Exposant de la courbe de latitude : > 1 élargit la ceinture chaude. */
export const LATITUDE_EXPONENT = 1.35;
/** Refroidissement total du niveau de la mer au sommet, en °C. */
export const ALTITUDE_LAPSE = 26;
/** Amplitude du bruit de température, en °C (crête à crête : le double). */
export const TEMPERATURE_NOISE = 4;
/** Fréquence du bruit de température. */
export const TEMPERATURE_FREQUENCY = 2.4;

/** Fréquence du fBm d'humidité. */
export const MOISTURE_FREQUENCY = 2.1;
/** Octaves du fBm d'humidité. */
export const MOISTURE_OCTAVES = 4;
/** Étirement de l'humidité autour de 0,5. */
export const MOISTURE_CONTRAST = 2.2;

/** Sous cette température, l'océan gèle et devient franchissable (banquise). */
export const SEA_ICE_TEMPERATURE = -10;
/** Sous cette température, la terre est une calotte de glace. */
export const ICE_TEMPERATURE = -8;
/** Limite toundra / forêt boréale, en °C. */
export const TUNDRA_TEMPERATURE = 1;
/** Limite forêt boréale / zone tempérée, en °C. */
export const BOREAL_TEMPERATURE = 10;
/** Limite zone tempérée / zone tropicale, en °C. */
export const TROPICAL_TEMPERATURE = 20;

/** Humidité minimale pour qu'une toundra devienne forêt boréale. */
export const BOREAL_MOISTURE = 0.38;
/** Humidité minimale pour une forêt tempérée. */
export const TEMPERATE_FOREST_MOISTURE = 0.6;
/** Humidité minimale pour une prairie (en dessous : désert froid). */
export const GRASSLAND_MOISTURE = 0.32;
/** Humidité minimale pour une jungle. */
export const JUNGLE_MOISTURE = 0.62;
/** Humidité minimale pour une savane (en dessous : désert chaud). */
export const SAVANNA_MOISTURE = 0.34;

/** Une case du globe : géométrie, climat et biome. */
export interface Tile extends TileGeometry {
  /** Biome retenu par la table de décision. */
  readonly biome: Biome;
  /** Élévation dans [0, 1]. `SEA_LEVEL` sépare l'eau de la terre. */
  readonly elevation: number;
  /** Température moyenne annuelle, en °C. */
  readonly temperature: number;
  /** Humidité dans [0, 1]. */
  readonly moisture: number;
}

/** Un globe généré : le seed, sa subdivision et ses cases. */
export interface World {
  readonly seed: number;
  readonly subdivisions: number;
  readonly tiles: readonly Tile[];
}

function clamp01(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Étire un champ dans [0, 1] autour de 0,5, puis borne. */
function contrast(value: number, factor: number): number {
  return clamp01(0.5 + (value - 0.5) * factor);
}

/**
 * Élévation **brute** d'une case, dans [0, 1] : mélange du biais continental
 * et du relief. Sa moyenne varie fortement d'un seed à l'autre (le fBm
 * continental n'a qu'une quinzaine de motifs indépendants sur tout le
 * globe), c'est pourquoi le niveau de la mer n'est pas un seuil fixe sur
 * cette valeur mais un quantile — voir `normalizeElevations`.
 */
export function rawElevationAt(center: Vec3, seed: number): number {
  const continentSeed = deriveSeed(seed, SALT_CONTINENTS);
  const reliefSeed = deriveSeed(seed, SALT_RELIEF);
  const continents = fbm(
    center[0] * CONTINENT_FREQUENCY,
    center[1] * CONTINENT_FREQUENCY,
    center[2] * CONTINENT_FREQUENCY,
    CONTINENT_OCTAVES,
    continentSeed,
  );
  const relief = fbm(
    center[0] * RELIEF_FREQUENCY,
    center[1] * RELIEF_FREQUENCY,
    center[2] * RELIEF_FREQUENCY,
    RELIEF_OCTAVES,
    reliefSeed,
  );
  const raw = CONTINENT_WEIGHT * continents + (1 - CONTINENT_WEIGHT) * relief;
  return contrast(raw, ELEVATION_CONTRAST);
}

/** Hauteur de terre normalisée : 0 au niveau de la mer, 1 au point le plus haut du globe. */
export function landHeight(elevation: number): number {
  return elevation <= SEA_LEVEL ? 0 : (elevation - SEA_LEVEL) / (1 - SEA_LEVEL);
}

/**
 * Renormalise un champ d'élévation brute pour que la part d'eau soit
 * exactement `WATER_TARGET`, quel que soit le seed.
 *
 * Pourquoi : avec un seuil constant sur le bruit, la part d'océan mesurée à
 * n = 4 va de 21 % à 73 % selon le seed — le fBm continental est basse
 * fréquence, donc sa moyenne sur la sphère est elle-même une variable
 * aléatoire de forte variance. Un joueur ne doit pas tomber sur un monde
 * presque entièrement noyé ou presque sans mer.
 *
 * La correction est une transformation monotone : on prend le quantile
 * `WATER_TARGET` du champ comme niveau de la mer, puis on étire linéairement
 * les deux moitiés vers [0, `SEA_LEVEL`) et [`SEA_LEVEL`, 1]. L'ordre des
 * cases par altitude est conservé, donc la géographie (où sont les
 * continents, où sont les crêtes) reste entièrement dictée par le bruit ;
 * seule l'échelle change. Le résultat reste une fonction déterministe de
 * `(subdivisions, seed)`.
 */
export function normalizeElevations(raw: readonly number[]): number[] {
  const count = raw.length;
  if (count === 0) {
    return [];
  }
  const sorted = [...raw].sort((a, b) => a - b);
  const waterCount = Math.min(count - 1, Math.max(1, Math.floor(WATER_TARGET * count)));
  const seaLevelRaw = sorted[waterCount] as number;
  const lowest = sorted[0] as number;
  const highest = sorted[count - 1] as number;
  const belowSpan = seaLevelRaw - lowest;
  const aboveSpan = highest - seaLevelRaw;

  return raw.map((value) => {
    if (value < seaLevelRaw) {
      return belowSpan > 0 ? (SEA_LEVEL * (value - lowest)) / belowSpan : 0;
    }
    return aboveSpan > 0
      ? SEA_LEVEL + ((1 - SEA_LEVEL) * (value - seaLevelRaw)) / aboveSpan
      : SEA_LEVEL;
  });
}

/** Température d'une case, en °C. */
export function temperatureAt(center: Vec3, lat: number, elevation: number, seed: number): number {
  const l = Math.abs(lat) / 90;
  const latitudeTerm = (POLE_TEMPERATURE - EQUATOR_TEMPERATURE) * l ** LATITUDE_EXPONENT;
  const noiseSeed = deriveSeed(seed, SALT_TEMPERATURE);
  const noise = fbm(
    center[0] * TEMPERATURE_FREQUENCY,
    center[1] * TEMPERATURE_FREQUENCY,
    center[2] * TEMPERATURE_FREQUENCY,
    3,
    noiseSeed,
  );
  return (
    EQUATOR_TEMPERATURE +
    latitudeTerm -
    ALTITUDE_LAPSE * landHeight(elevation) +
    (noise - 0.5) * 2 * TEMPERATURE_NOISE
  );
}

/** Humidité d'une case, dans [0, 1]. */
export function moistureAt(center: Vec3, seed: number): number {
  const moistureSeed = deriveSeed(seed, SALT_MOISTURE);
  const raw = fbm(
    center[0] * MOISTURE_FREQUENCY,
    center[1] * MOISTURE_FREQUENCY,
    center[2] * MOISTURE_FREQUENCY,
    MOISTURE_OCTAVES,
    moistureSeed,
  );
  return contrast(raw, MOISTURE_CONTRAST);
}

/**
 * Table de décision température × humidité × élévation.
 *
 * L'ordre des tests est significatif :
 *
 * ```
 * élévation < SEA_LEVEL ─┬─ T < -10 °C ─────────────── banquise (Ice)
 *                        └─ sinon ──────────────────── océan (Ocean)
 *
 * terre ─┬─ hauteur >= 0,6 ────────────────────────── montagne (Mountain)
 *        ├─ T < -8 °C ─────────────────────────────── calotte (Ice)
 *        ├─ T < 2 °C ──────────────────────────────── toundra (Tundra)
 *        ├─ T < 8 °C  ─┬─ humidité >= 0,42 ────────── forêt boréale
 *        │             └─ sinon ───────────────────── toundra
 *        ├─ T < 20 °C ─┬─ humidité >= 0,60 ────────── forêt tempérée
 *        │             ├─ humidité >= 0,32 ────────── prairie
 *        │             └─ sinon ───────────────────── désert (froid)
 *        └─ T >= 20 °C ┬─ humidité >= 0,62 ────────── jungle
 *                      ├─ humidité >= 0,34 ────────── savane
 *                      └─ sinon ───────────────────── désert (chaud)
 * ```
 *
 * La montagne passe avant le climat : au-dessus du seuil, la case est de la
 * roche quel que soit l'endroit du globe. Comme le gradient d'altitude retire
 * au plus `ALTITUDE_LAPSE * MOUNTAIN_HEIGHT` = 15,6 °C, une case non
 * montagneuse de l'équateur reste au-dessus de 12 °C : il n'y a jamais de
 * glace à l'équateur.
 */
export function classifyBiome(elevation: number, temperature: number, moisture: number): Biome {
  if (elevation < SEA_LEVEL) {
    return temperature < SEA_ICE_TEMPERATURE ? Biome.Ice : Biome.Ocean;
  }
  if (landHeight(elevation) >= MOUNTAIN_HEIGHT) {
    return Biome.Mountain;
  }
  if (temperature < ICE_TEMPERATURE) {
    return Biome.Ice;
  }
  if (temperature < TUNDRA_TEMPERATURE) {
    return Biome.Tundra;
  }
  if (temperature < BOREAL_TEMPERATURE) {
    return moisture >= BOREAL_MOISTURE ? Biome.BorealForest : Biome.Tundra;
  }
  if (temperature < TROPICAL_TEMPERATURE) {
    if (moisture >= TEMPERATE_FOREST_MOISTURE) {
      return Biome.TemperateForest;
    }
    return moisture >= GRASSLAND_MOISTURE ? Biome.Grassland : Biome.Desert;
  }
  if (moisture >= JUNGLE_MOISTURE) {
    return Biome.Jungle;
  }
  return moisture >= SAVANNA_MOISTURE ? Biome.Savanna : Biome.Desert;
}

/**
 * Génère un globe complet. Fonction pure de `(subdivisions, seed)` : même
 * couple, même monde (aux réserves de `docs/world.md` sur les fonctions
 * transcendantes des différents moteurs JS).
 *
 * Deux passes, parce que la normalisation de l'élévation a besoin de la
 * distribution complète : d'abord l'élévation brute de chaque case, ensuite
 * le climat et le biome sur l'élévation normalisée.
 */
export function generateWorld(subdivisions: number, seed: number): World {
  const grid = geodesicGrid(subdivisions);
  const normalizedSeed = seed | 0;
  const elevations = normalizeElevations(
    grid.map((geometry) => rawElevationAt(geometry.center, normalizedSeed)),
  );
  const tiles: Tile[] = grid.map((geometry, index) => {
    const elevation = elevations[index] as number;
    const temperature = temperatureAt(geometry.center, geometry.lat, elevation, normalizedSeed);
    const moisture = moistureAt(geometry.center, normalizedSeed);
    return {
      ...geometry,
      biome: classifyBiome(elevation, temperature, moisture),
      elevation,
      temperature,
      moisture,
    };
  });
  return { seed: normalizedSeed, subdivisions, tiles };
}

/** Part de cases d'un biome donné, dans [0, 1]. Utile pour la calibration. */
export function biomeShare(world: World, biome: Biome): number {
  let count = 0;
  for (const tile of world.tiles) {
    if (tile.biome === biome) {
      count += 1;
    }
  }
  return count / world.tiles.length;
}
