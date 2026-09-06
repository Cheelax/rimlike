/**
 * Fonctions pures de la mini-carte (`Minimap.tsx`) : conversion case ↔ pixel
 * et peinture du fond depuis les tampons `tiles`/`features` du sim. Aucun DOM
 * ici (testé sous Node, `test/minimapPaint.test.ts`) : le composant React
 * s'en sert pour peindre un vrai canevas, jamais l'inverse.
 *
 * Nom de fichier en minuscules à part de `Minimap.tsx` (composant) : `minimap.ts`
 * et `Minimap.tsx` ne diffèrent que par la casse, ce que les systèmes de
 * fichiers insensibles à la casse (macOS par défaut) et la résolution de
 * modules de TypeScript ne supportent pas (`forceConsistentCasingInFileNames`).
 */

import { FEATURE, MATERIAL, TERRAIN_COLORS, WALL_COLORS } from "./render/terrain";

/** Pixels affichés par case (mission : « un pixel et demi par case »). */
export const MINIMAP_SCALE = 1.5;

/** Arbre : vert sombre, plus sombre que l'herbe pour trancher au premier coup d'œil. */
export const MINIMAP_TREE_COLOR = 0x1d3a1d;
/** Rocher : gris clair, distinct du gravier et de la pierre du sol. */
export const MINIMAP_ROCK_COLOR = 0x9a9a9a;
/** Rocher veiné : teinte cuivrée, distincte du rocher ordinaire, pour repérer le minerai sans miner à l'aveugle. */
export const MINIMAP_ORE_ROCK_COLOR = 0xb5651d;

/** Un rectangle, en cases ou en coordonnées monde flottantes (vue caméra). */
export interface Rect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/** Case → pixel affiché, à l'échelle `scale` (par défaut `MINIMAP_SCALE`). */
export function tileToPixel(tile: number, scale: number = MINIMAP_SCALE): number {
  return tile * scale;
}

/** Pixel affiché → case, réciproque de `tileToPixel` (arrondi au sol). */
export function pixelToTile(pixel: number, scale: number = MINIMAP_SCALE): number {
  return Math.floor(pixel / scale);
}

/**
 * Couleur de fond d'une case (0xRRGGBB) : la case elle-même (`TERRAIN_COLORS`,
 * qui couvre déjà les sols posés, planche et dallage), puis un arbre, un
 * rocher ou un rocher veiné par-dessus (vert sombre / gris / cuivré), puis un
 * mur selon son matériau (`WALL_COLORS`, contrat `sim::build::Material`). Les
 * autres éléments (buissons, portes, lits, cultures, tombes, forges...)
 * restent la couleur de la case : une mini-carte lisible d'un coup d'œil n'a
 * pas besoin de plus.
 */
export function tileColor(terrain: number, feature: number): number {
  switch (feature) {
    case FEATURE.Tree:
      return MINIMAP_TREE_COLOR;
    case FEATURE.Rock:
      return MINIMAP_ROCK_COLOR;
    case FEATURE.OreRock:
      return MINIMAP_ORE_ROCK_COLOR;
    case FEATURE.WallWood:
      return WALL_COLORS[MATERIAL.Wood];
    case FEATURE.WallStone:
      return WALL_COLORS[MATERIAL.Stone];
    default:
      return TERRAIN_COLORS[terrain] ?? 0xff00ff;
  }
}

/**
 * Peint le fond dans `out` (RGBA, `width * height * 4` octets, déjà alloué
 * par l'appelant — une fois par changement de carte, jamais à chaque
 * rafraîchissement du HUD). Une case, un pixel : l'agrandissement à l'écran
 * (`MINIMAP_SCALE`) est l'affaire du canevas (`drawImage`), pas de cette
 * fonction.
 */
export function paintBackground(
  width: number,
  height: number,
  tiles: Uint8Array,
  features: Uint8Array,
  out: Uint8ClampedArray,
): void {
  const count = width * height;
  for (let i = 0; i < count; i++) {
    const color = tileColor(tiles[i], features[i]);
    const o = i * 4;
    out[o] = (color >> 16) & 0xff;
    out[o + 1] = (color >> 8) & 0xff;
    out[o + 2] = color & 0xff;
    out[o + 3] = 255;
  }
}

/**
 * Borne un rectangle (cases ou coordonnées monde) à la carte
 * `[0, width] × [0, height]`, en gardant `x0 <= x1` et `y0 <= y1` même si
 * l'entrée était partiellement hors carte ou désordonnée.
 */
export function clampRect(rect: Rect, width: number, height: number): Rect {
  const x0 = Math.max(0, Math.min(width, rect.x0));
  const x1 = Math.max(0, Math.min(width, rect.x1));
  const y0 = Math.max(0, Math.min(height, rect.y0));
  const y1 = Math.max(0, Math.min(height, rect.y1));
  return { x0: Math.min(x0, x1), y0: Math.min(y0, y1), x1: Math.max(x0, x1), y1: Math.max(y0, y1) };
}
