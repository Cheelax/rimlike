/**
 * Format de transport du globe : `WorldWire`.
 *
 * Le serveur monde génère le globe une fois, puis sert cet objet aux clients.
 * Les clients ne régénèrent **jamais** le monde eux-mêmes : la génération
 * emploie `Math.sin`, `Math.cos`, `Math.asin` et `Math.atan2`, dont les
 * derniers bits ne sont pas normalisés en JavaScript (voir `docs/world.md`,
 * « Déterminisme et ses limites »).
 *
 * Choix de format : tout est en tableaux de nombres plats, sans objet par
 * case, pour rester compact en JSON et se recopier directement dans des
 * tableaux typés côté client.
 *
 * - `centers` : 3 nombres par case, dans l'ordre des identifiants.
 * - `neighbors` : 6 nombres par case, avec **-1** en 6ᵉ position pour les
 *   12 pentagones. Une longueur fixe évite un second tableau d'offsets.
 * - `polygons` : sommets aplatis, découpés par `polygonOffsets`
 *   (`tileCount + 1` bornes, en nombre de sommets et non de flottants).
 * - `biomes` : un octet par case, la valeur de l'enum `Biome`.
 *
 * `lat`, `lon` et `area` ne sont **pas** transportés : ils se recalculent
 * exactement à partir de `centers` et `polygons`, et représenteraient 3
 * nombres de plus par case.
 *
 * Les grandeurs géométriques et climatiques passent par des `Float32Array`
 * avant d'être converties : la précision simple suffit largement pour un
 * globe (6 × 10⁻⁸ sur un vecteur unitaire) et c'est la forme sous laquelle le
 * client les remettra de toute façon.
 *
 * Attention à un piège de taille : convertir un `Float32Array` en nombres
 * JavaScript donne des flottants double précision dont l'écriture décimale la
 * plus courte fait 17 chiffres (`0.5257311463356018`). Les valeurs sont donc
 * arrondies à `WIRE_PRECISION` chiffres significatifs avant d'entrer dans le
 * JSON, ce qui divise sa taille par près de deux sans perdre de précision
 * utile.
 */

import {
  type Tile,
  type World,
  Biome,
  classifyBiome,
} from "./biomes.js";
import { type Vec3, sphericalPolygonArea, toLatLon } from "./geometry.js";

/** Version du format. Incrémentée à tout changement incompatible. */
export const WORLD_WIRE_VERSION = 1;

/** Emplacements de voisin par case dans `WorldWire.neighbors`. */
export const NEIGHBOR_SLOTS = 6;

/** Valeur de remplissage de la 6ᵉ place de voisin des pentagones. */
export const NO_NEIGHBOR = -1;

/**
 * Chiffres significatifs conservés dans le JSON. Sept chiffres, c'est la
 * précision d'un `Float32` (erreur relative <= 5 × 10⁻⁷) pour une écriture
 * décimale deux fois plus courte que celle d'un double.
 */
export const WIRE_PRECISION = 7;

/** Arrondit un flottant à `WIRE_PRECISION` chiffres significatifs. */
function round(value: number): number {
  return value === 0 ? 0 : Number(value.toPrecision(WIRE_PRECISION));
}

/** Convertit un tableau typé de flottants en nombres JSON courts. */
function floatArray(values: Float32Array): number[] {
  const out: number[] = new Array(values.length);
  for (let i = 0; i < values.length; i += 1) {
    out[i] = round(values[i] as number);
  }
  return out;
}

/** Globe sous forme transportable : uniquement des tableaux de nombres. */
export interface WorldWire {
  readonly version: number;
  readonly seed: number;
  readonly subdivisions: number;
  readonly tileCount: number;
  /** 3 × `tileCount` : centres unitaires. */
  readonly centers: number[];
  /** `tileCount` : valeurs de `Biome`. */
  readonly biomes: number[];
  /** `tileCount` : élévations dans [0, 1]. */
  readonly elevation: number[];
  /** `tileCount` : températures en °C. */
  readonly temperature: number[];
  /** `tileCount` : humidités dans [0, 1]. */
  readonly moisture: number[];
  /** 6 × `tileCount` : voisins, `NO_NEIGHBOR` pour la place vide des pentagones. */
  readonly neighbors: number[];
  /** `tileCount` + 1 : bornes de `polygons`, en nombre de sommets. */
  readonly polygonOffsets: number[];
  /** 3 × (nombre total de sommets) : sommets des polygones aplatis. */
  readonly polygons: number[];
}

/** Sérialise un globe vers sa forme transportable. */
export function serializeWorld(world: World): WorldWire {
  const tiles = world.tiles;
  const count = tiles.length;

  const centers = new Float32Array(count * 3);
  const biomes = new Uint8Array(count);
  const elevation = new Float32Array(count);
  const temperature = new Float32Array(count);
  const moisture = new Float32Array(count);
  const neighbors = new Int32Array(count * NEIGHBOR_SLOTS).fill(NO_NEIGHBOR);
  const polygonOffsets = new Int32Array(count + 1);

  let vertexCount = 0;
  for (let i = 0; i < count; i += 1) {
    vertexCount += tiles[i].polygon.length;
  }
  const polygons = new Float32Array(vertexCount * 3);

  let vertex = 0;
  for (let i = 0; i < count; i += 1) {
    const tile = tiles[i];
    centers[i * 3] = tile.center[0];
    centers[i * 3 + 1] = tile.center[1];
    centers[i * 3 + 2] = tile.center[2];
    biomes[i] = tile.biome;
    elevation[i] = tile.elevation;
    temperature[i] = tile.temperature;
    moisture[i] = tile.moisture;

    const slots = tile.neighbors.length;
    if (slots > NEIGHBOR_SLOTS) {
      throw new RangeError(`la case ${i} a ${slots} voisins, ${NEIGHBOR_SLOTS} au maximum`);
    }
    for (let k = 0; k < slots; k += 1) {
      neighbors[i * NEIGHBOR_SLOTS + k] = tile.neighbors[k];
    }

    polygonOffsets[i] = vertex;
    for (const point of tile.polygon) {
      polygons[vertex * 3] = point[0];
      polygons[vertex * 3 + 1] = point[1];
      polygons[vertex * 3 + 2] = point[2];
      vertex += 1;
    }
  }
  polygonOffsets[count] = vertex;

  return {
    version: WORLD_WIRE_VERSION,
    seed: world.seed,
    subdivisions: world.subdivisions,
    tileCount: count,
    centers: floatArray(centers),
    biomes: Array.from(biomes),
    elevation: floatArray(elevation),
    temperature: floatArray(temperature),
    moisture: floatArray(moisture),
    neighbors: Array.from(neighbors),
    polygonOffsets: Array.from(polygonOffsets),
    polygons: floatArray(polygons),
  };
}

function expect(condition: boolean, message: string): void {
  if (!condition) {
    throw new RangeError(`WorldWire invalide : ${message}`);
  }
}

/**
 * Reconstruit un globe depuis sa forme transportable. `lat`, `lon` et `area`
 * sont recalculés ; le biome est relu tel quel, sans repasser par
 * `classifyBiome`, pour que le serveur reste seul juge du climat.
 */
export function deserializeWorld(wire: WorldWire): World {
  expect(wire.version === WORLD_WIRE_VERSION, `version ${wire.version} au lieu de ${WORLD_WIRE_VERSION}`);
  const count = wire.tileCount;
  expect(Number.isInteger(count) && count > 0, "tileCount doit être un entier > 0");
  expect(wire.centers.length === count * 3, "longueur de centers");
  expect(wire.biomes.length === count, "longueur de biomes");
  expect(wire.elevation.length === count, "longueur de elevation");
  expect(wire.temperature.length === count, "longueur de temperature");
  expect(wire.moisture.length === count, "longueur de moisture");
  expect(wire.neighbors.length === count * NEIGHBOR_SLOTS, "longueur de neighbors");
  expect(wire.polygonOffsets.length === count + 1, "longueur de polygonOffsets");
  expect(wire.polygons.length === (wire.polygonOffsets[count] as number) * 3, "longueur de polygons");

  const tiles: Tile[] = [];
  for (let i = 0; i < count; i += 1) {
    const center: Vec3 = [
      wire.centers[i * 3] as number,
      wire.centers[i * 3 + 1] as number,
      wire.centers[i * 3 + 2] as number,
    ];

    const neighbors: number[] = [];
    for (let k = 0; k < NEIGHBOR_SLOTS; k += 1) {
      const id = wire.neighbors[i * NEIGHBOR_SLOTS + k] as number;
      if (id !== NO_NEIGHBOR) {
        expect(id >= 0 && id < count, `voisin ${id} de la case ${i} hors du monde`);
        neighbors.push(id);
      }
    }
    expect(neighbors.length === 5 || neighbors.length === 6, `la case ${i} a ${neighbors.length} voisins`);

    const start = wire.polygonOffsets[i] as number;
    const end = wire.polygonOffsets[i + 1] as number;
    expect(end >= start, `offsets de polygone décroissants à la case ${i}`);
    const polygon: Vec3[] = [];
    for (let v = start; v < end; v += 1) {
      polygon.push([
        wire.polygons[v * 3] as number,
        wire.polygons[v * 3 + 1] as number,
        wire.polygons[v * 3 + 2] as number,
      ]);
    }

    const biome = wire.biomes[i] as number;
    expect(biome in Biome, `biome ${biome} inconnu à la case ${i}`);

    const { lat, lon } = toLatLon(center);
    tiles.push({
      id: i,
      center,
      lat,
      lon,
      neighbors,
      polygon,
      area: sphericalPolygonArea(polygon),
      biome: biome as Biome,
      elevation: wire.elevation[i] as number,
      temperature: wire.temperature[i] as number,
      moisture: wire.moisture[i] as number,
    });
  }

  return { seed: wire.seed, subdivisions: wire.subdivisions, tiles };
}

/**
 * Recalcule le biome d'une case depuis son climat. Sert à vérifier qu'un
 * `WorldWire` reçu est cohérent avec la table de décision locale — un client
 * dont le paquet est d'une version différente le verra ici.
 */
export function reclassify(tile: Tile): Biome {
  return classifyBiome(tile.elevation, tile.temperature, tile.moisture);
}
