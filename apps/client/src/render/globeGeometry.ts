/**
 * Le globe en tampons plats : une seule `BufferGeometry` pour toutes les
 * cases, sans dépendance à Three.js.
 *
 * Pourquoi ce module est pur : le mappage triangle → case est ce qui rend le
 * survol et le clic possibles (`intersection.faceIndex` → `tileOfTriangle`).
 * Le sortir du moteur de rendu le rend testable sous Node, sans WebGL
 * (`test/globeGeometry.test.ts`).
 *
 * Triangulation **en éventail** par case, comme prévu dans `docs/world.md` §7 :
 * les cases du dual d'une géodésique sont convexes, donc un polygone à k
 * sommets donne k − 2 triangles sans avoir à passer par son centre. Les
 * sommets ne sont **pas** partagés entre cases : chaque case porte sa propre
 * couleur plate, ce qui donne des frontières nettes et un seul appel de dessin.
 * Total : (N − 12) × 4 + 12 × 3 = 4 N − 12 triangles.
 */

import { Biome, landHeight, type Tile, type Vec3, type World } from "@rimlike/world";

/** Rayon du globe rendu, en unités de scène. */
export const GLOBE_RADIUS = 1;

/**
 * Relief : une case de terre est poussée jusqu'à 2 % au-dessus du rayon, à
 * proportion de sa hauteur au-dessus du niveau de la mer (`landHeight`, qui
 * vaut 0 sur l'eau et 1 au point le plus haut du globe). 2 % suffit à faire
 * lire les massifs en lumière rasante sans déformer la sphère ni ouvrir de
 * fentes visibles entre deux cases voisines.
 */
export const RELIEF_SCALE = 0.02;

/**
 * Palette des biomes, en **sRGB** (les entiers `0xRRGGBB` qu'on lit à l'œil).
 *
 * Choisie pour rester lisible sur un fond sombre et pour que deux biomes
 * voisins dans la table de décision de `packages/world` ne se confondent pas :
 * les verts vont du bleuté (boréal) au saturé (jungle) en passant par le franc
 * (tempéré) et le clair (prairie) ; les jaunes séparent le sable du désert de
 * l'ocre de la savane. `BIOME_COLORS` est une affaire de rendu : le paquet
 * monde ne fournit que `BIOME_NAMES` (`docs/world.md` §7).
 */
export const BIOME_COLORS: Readonly<Record<Biome, number>> = {
  [Biome.Ocean]: 0x14395e,
  [Biome.Ice]: 0xe4eef5,
  [Biome.Tundra]: 0xa8b0a0,
  [Biome.BorealForest]: 0x2d5a45,
  [Biome.TemperateForest]: 0x3f8f4f,
  [Biome.Grassland]: 0x8fb857,
  [Biome.Desert]: 0xe0c882,
  [Biome.Savanna]: 0xc9a94e,
  [Biome.Jungle]: 0x1c7a3c,
  [Biome.Mountain]: 0x8d8779,
};

/** Ce que `buildGlobeGeometry` produit : de quoi remplir une `BufferGeometry`. */
export interface GlobeGeometryData {
  /** 3 flottants par sommet, 3 sommets par triangle. */
  readonly positions: Float32Array;
  /** Même longueur que `positions` : la couleur du sommet, en espace linéaire. */
  readonly colors: Float32Array;
  /** Case d'origine de chaque triangle. Longueur = nombre de triangles. */
  readonly tileOfTriangle: Uint32Array;
}

export interface GlobeGeometryOptions {
  /** Rayon de la sphère. Défaut : `GLOBE_RADIUS`. */
  readonly radius?: number;
  /** Amplitude du relief. `0` donne une sphère parfaitement lisse. */
  readonly relief?: number;
}

/**
 * sRGB → linéaire. Three.js suppose depuis r152 que l'attribut `color` d'une
 * géométrie est déjà dans l'espace de travail (linéaire) : une palette écrite
 * en sRGB doit donc être convertie ici, sinon tout le globe est délavé.
 */
export function srgbToLinear(channel: number): number {
  return channel <= 0.04045 ? channel / 12.92 : ((channel + 0.055) / 1.055) ** 2.4;
}

/** Couleur linéaire d'un biome, trois canaux dans [0, 1]. */
export function biomeColor(biome: Biome): readonly [number, number, number] {
  const hex = BIOME_COLORS[biome] ?? 0xff00ff;
  return [
    srgbToLinear(((hex >> 16) & 0xff) / 255),
    srgbToLinear(((hex >> 8) & 0xff) / 255),
    srgbToLinear((hex & 0xff) / 255),
  ];
}

/**
 * Rayon auquel dessiner une case : le niveau de la mer pour l'eau et la
 * banquise, jusqu'à `radius × (1 + relief)` pour le point le plus haut.
 */
export function tileRadius(tile: Tile, radius = GLOBE_RADIUS, relief = RELIEF_SCALE): number {
  return radius * (1 + relief * landHeight(tile.elevation));
}

/** Vecteur unitaire × `scale`. Les coins du monde sont unitaires à 10⁻⁹ près. */
function scaled(v: Vec3, scale: number): [number, number, number] {
  const norm = Math.hypot(v[0], v[1], v[2]) || 1;
  const k = scale / norm;
  return [v[0] * k, v[1] * k, v[2] * k];
}

/**
 * Les triangles d'une seule case, en éventail, à son rayon de relief. Sert aux
 * calques du moteur de rendu (survol, sélection, colonies), qui ne redessinent
 * qu'une poignée de cases.
 */
export function buildTileFan(tile: Tile, radius: number, relief = RELIEF_SCALE): Float32Array {
  const r = tileRadius(tile, radius, relief);
  const corners = tile.polygon.map((corner) => scaled(corner, r));
  const positions = new Float32Array((corners.length - 2) * 9);
  let at = 0;
  for (let i = 1; i + 1 < corners.length; i += 1) {
    positions.set(corners[0]!, at);
    positions.set(corners[i]!, at + 3);
    positions.set(corners[i + 1]!, at + 6);
    at += 9;
  }
  return positions;
}

/**
 * Le globe entier en trois tampons. Fonction pure : mêmes cases, mêmes octets.
 *
 * `tileOfTriangle[i]` est la case du i-ème triangle, donc du `faceIndex` que
 * renvoie un raycast sur une géométrie non indexée — c'est tout ce qu'il faut
 * pour transformer un pixel en case.
 */
export function buildGlobeGeometry(world: World, options: GlobeGeometryOptions = {}): GlobeGeometryData {
  const radius = options.radius ?? GLOBE_RADIUS;
  const relief = options.relief ?? RELIEF_SCALE;

  let triangles = 0;
  for (const tile of world.tiles) {
    triangles += Math.max(0, tile.polygon.length - 2);
  }

  const positions = new Float32Array(triangles * 9);
  const colors = new Float32Array(triangles * 9);
  const tileOfTriangle = new Uint32Array(triangles);

  let vertexAt = 0;
  let triangleAt = 0;
  for (const tile of world.tiles) {
    const r = tileRadius(tile, radius, relief);
    const color = biomeColor(tile.biome);
    const corners = tile.polygon.map((corner) => scaled(corner, r));
    for (let i = 1; i + 1 < corners.length; i += 1) {
      positions.set(corners[0]!, vertexAt);
      positions.set(corners[i]!, vertexAt + 3);
      positions.set(corners[i + 1]!, vertexAt + 6);
      // Couleur plate : les trois sommets du triangle portent celle de la case.
      for (let k = 0; k < 9; k += 3) {
        colors[vertexAt + k] = color[0];
        colors[vertexAt + k + 1] = color[1];
        colors[vertexAt + k + 2] = color[2];
      }
      tileOfTriangle[triangleAt] = tile.id;
      vertexAt += 9;
      triangleAt += 1;
    }
  }

  return { positions, colors, tileOfTriangle };
}
