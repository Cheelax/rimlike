/**
 * Fonctions pures de `selection.ts` : pas de sim, pas de rendu, pas de DOM —
 * juste la logique de sélection multiple pilotée par `App.tsx`.
 */

import { describe, expect, it } from "vitest";

import { selectInRect, spreadTargets, toggle, type RectPawn } from "../src/selection";

describe("toggle", () => {
  it("ajoute un id absent, en fin de liste", () => {
    expect(toggle([1, 2], 3)).toEqual([1, 2, 3]);
    expect(toggle([], 5)).toEqual([5]);
  });

  it("retire un id présent, sans toucher à l'ordre des autres", () => {
    expect(toggle([1, 2, 3], 2)).toEqual([1, 3]);
    expect(toggle([7], 7)).toEqual([]);
  });
});

describe("selectInRect", () => {
  const pawn = (id: number, x: number, y: number, faction = 0, livestock = false): RectPawn => ({
    id,
    x,
    y,
    faction,
    livestock,
  });

  it("sélectionne les colons dont la case tombe dans le rectangle, triés par id", () => {
    const pawns = [pawn(5, 3, 3), pawn(2, 1, 1), pawn(9, 10, 10)];
    expect(selectInRect(pawns, { x0: 0, y0: 0, x1: 5, y1: 5 })).toEqual([2, 5]);
  });

  it("fonctionne avec des bornes inversées (x0 > x1 ou y0 > y1)", () => {
    const pawns = [pawn(1, 2, 2)];
    expect(selectInRect(pawns, { x0: 5, y0: 5, x1: 0, y1: 0 })).toEqual([1]);
  });

  it("inclut les bornes du rectangle", () => {
    const pawns = [pawn(1, 0, 0), pawn(2, 4, 4), pawn(3, 5, 4)];
    expect(selectInRect(pawns, { x0: 0, y0: 0, x1: 4, y1: 4 })).toEqual([1, 2]);
  });

  it("exclut les pillards, le bétail et les bêtes sauvages", () => {
    const pawns = [
      pawn(1, 2, 2, 0), // colon : retenu
      pawn(2, 2, 2, 1), // pillard : exclu
      pawn(3, 2, 2, 2), // bête sauvage : exclue
      pawn(4, 2, 2, 3), // marchand : exclu
      pawn(5, 2, 2, 0, true), // bétail (faction colonie, mais bête) : exclu
    ];
    expect(selectInRect(pawns, { x0: 0, y0: 0, x1: 5, y1: 5 })).toEqual([1]);
  });

  it("renvoie une liste vide sans colon dans le rectangle", () => {
    expect(selectInRect([pawn(1, 20, 20)], { x0: 0, y0: 0, x1: 5, y1: 5 })).toEqual([]);
  });
});

describe("spreadTargets", () => {
  const allFree = () => true;

  it("renvoie le centre en premier, puis des cases distinctes autour", () => {
    const targets = spreadTargets({ x: 10, y: 10 }, 5, allFree);
    expect(targets[0]).toEqual({ x: 10, y: 10 });
    expect(targets).toHaveLength(5);
    // Jamais deux fois la même case.
    const keys = new Set(targets.map((t) => `${t.x}:${t.y}`));
    expect(keys.size).toBe(5);
  });

  it("est déterministe : deux appels identiques renvoient la même spirale", () => {
    const a = spreadTargets({ x: 3, y: 3 }, 9, allFree);
    const b = spreadTargets({ x: 3, y: 3 }, 9, allFree);
    expect(a).toEqual(b);
  });

  it("ne renvoie jamais une case où isFree est faux", () => {
    const blocked = new Set(["10:10", "11:10", "9:10"]);
    const isFree = (x: number, y: number) => !blocked.has(`${x}:${y}`);
    const targets = spreadTargets({ x: 10, y: 10 }, 4, isFree);
    for (const t of targets) expect(blocked.has(`${t.x}:${t.y}`)).toBe(false);
    expect(targets).toHaveLength(4);
  });

  it("s'arrête sans dépasser count", () => {
    expect(spreadTargets({ x: 0, y: 0 }, 1, allFree)).toEqual([{ x: 0, y: 0 }]);
    expect(spreadTargets({ x: 0, y: 0 }, 0, allFree)).toEqual([]);
  });

  it("renvoie moins de count si la zone explorée n'a pas assez de cases libres", () => {
    // Rien n'est libre : la spirale s'arrête à son rayon maximal, jamais en boucle infinie.
    const targets = spreadTargets({ x: 0, y: 0 }, 10, () => false);
    expect(targets).toEqual([]);
  });
});
