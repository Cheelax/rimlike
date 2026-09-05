/**
 * Logique pure de la sélection multiple : aucune dépendance DOM ni Three.js,
 * testée sans rendu dans `test/selection.test.ts`. `App.tsx` la pilote depuis
 * les gestes souris/clavier (voir « Conventions côté client », `AGENTS.md`) ;
 * `Renderer.setSelection` ne fait que surligner les ids qu'elle désigne.
 */
import { FACTION } from "./render/terrain";

/** Case entière, comme `render/Renderer.ts::TilePos` (structurellement compatible, sans en dépendre). */
export interface TileCoord {
  readonly x: number;
  readonly y: number;
}

/** Rectangle de cases, comme `render/Renderer.ts::TileRect` (bornes non triées : `x0`/`y0` peuvent dépasser `x1`/`y1`). */
export interface SelectionRect {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
}

/**
 * Ajoute `id` à `selection` s'il n'y est pas encore, le retire sinon (Maj +
 * clic sur un pawn, dans la scène comme dans `ColonistBar`). Ordre conservé
 * (le premier id reste `selected` pour tout ce qui n'affiche qu'un seul
 * colon), jamais de doublon.
 */
export function toggle(selection: readonly number[], id: number): number[] {
  const i = selection.indexOf(id);
  if (i >= 0) return [...selection.slice(0, i), ...selection.slice(i + 1)];
  return [...selection, id];
}

/** Un pawn tel que lu dans le tampon `pawns` du frame courant, pour `selectInRect`. */
export interface RectPawn {
  readonly id: number;
  /** Case courante (coordonnées entières). */
  readonly x: number;
  readonly y: number;
  /** Contrat `pawn::Faction` (`render/terrain.ts::FACTION`) : seule la colonie (0) se sélectionne au rectangle. */
  readonly faction: number;
  /** Vrai pour une bête de la colonie (`sim::livestock`) : ni pillard ni colon, exclue comme lui. */
  readonly livestock: boolean;
}

/**
 * Colons (faction 0, pas de bête de la colonie) dont la case tombe dans
 * `rect`, bornes incluses : Maj + glisser gauche en mode Sélection
 * (`AGENTS.md`). Triés par id croissant — un ordre déterministe, indépendant
 * de celui, non garanti, du tampon `pawns`.
 */
export function selectInRect(pawns: readonly RectPawn[], rect: SelectionRect): number[] {
  const x0 = Math.min(rect.x0, rect.x1);
  const x1 = Math.max(rect.x0, rect.x1);
  const y0 = Math.min(rect.y0, rect.y1);
  const y1 = Math.max(rect.y0, rect.y1);
  const ids: number[] = [];
  for (const p of pawns) {
    if (p.faction !== FACTION.Colony || p.livestock) continue;
    if (p.x < x0 || p.x > x1 || p.y < y0 || p.y > y1) continue;
    ids.push(p.id);
  }
  return ids.sort((a, b) => a - b);
}

/** Rayon maximal exploré par `spreadTargets` : largement assez pour la carte 128×128 (`App.tsx::MAP_SIZE`). */
const MAX_SPREAD_RADIUS = 40;

/**
 * `count` cases libres distinctes autour de `center`, en spirale carrée
 * déterministe : le centre d'abord, puis des anneaux de rayon croissant,
 * chacun parcouru dans le même ordre (haut, droite, bas, gauche). Sert le
 * clic droit avec plusieurs colons sélectionnés (`AGENTS.md`) : chacun vers sa
 * propre case plutôt que de s'empiler sur celle visée.
 *
 * `isFree` décide seule ce qui est franchissable (bornes de carte, terrain,
 * éléments) : cette fonction ne connaît ni tuiles ni éléments. Peut renvoyer
 * moins de `count` cases si la zone explorée n'en contient pas assez ; jamais
 * deux fois la même case.
 */
export function spreadTargets(
  center: TileCoord,
  count: number,
  isFree: (x: number, y: number) => boolean,
): TileCoord[] {
  const out: TileCoord[] = [];
  if (count <= 0) return out;
  const seen = new Set<string>();
  const tryAdd = (x: number, y: number) => {
    if (out.length >= count) return;
    const key = `${x}:${y}`;
    if (seen.has(key)) return;
    seen.add(key);
    if (isFree(x, y)) out.push({ x, y });
  };
  tryAdd(center.x, center.y);
  for (let r = 1; out.length < count && r <= MAX_SPREAD_RADIUS; r++) {
    for (let x = center.x - r; x <= center.x + r && out.length < count; x++) tryAdd(x, center.y - r);
    for (let y = center.y - r + 1; y <= center.y + r && out.length < count; y++) tryAdd(center.x + r, y);
    for (let x = center.x + r - 1; x >= center.x - r && out.length < count; x--) tryAdd(x, center.y + r);
    for (let y = center.y + r - 1; y >= center.y - r + 1 && out.length < count; y--) tryAdd(center.x - r, y);
  }
  return out;
}
