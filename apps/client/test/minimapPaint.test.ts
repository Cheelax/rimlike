/**
 * Fonctions pures de `src/minimapPaint.ts` : couleurs de fond, conversion
 * case ↔ pixel, rectangle de vue borné à la carte. Pas de DOM, pas de
 * canevas : `Minimap.tsx` s'en sert pour peindre un vrai canevas, jamais
 * l'inverse.
 */

import { describe, expect, it } from "vitest";

import {
  clampRect,
  MINIMAP_SCALE,
  MINIMAP_ROCK_COLOR,
  MINIMAP_TREE_COLOR,
  paintBackground,
  pixelToTile,
  tileColor,
  tileToPixel,
} from "../src/minimapPaint";
import { FEATURE, MATERIAL, TERRAIN, TERRAIN_COLORS, WALL_COLORS } from "../src/render/terrain";

describe("tileColor", () => {
  it("reprend la couleur de terrain sans élément dessus", () => {
    expect(tileColor(TERRAIN.DeepWater, FEATURE.None)).toBe(TERRAIN_COLORS[TERRAIN.DeepWater]);
    expect(tileColor(TERRAIN.Grass, FEATURE.None)).toBe(TERRAIN_COLORS[TERRAIN.Grass]);
    // Un sol posé (planche, dallage) est déjà une couleur de terrain à part :
    // rien à ajouter par-dessus.
    expect(tileColor(TERRAIN.StoneFloor, FEATURE.None)).toBe(TERRAIN_COLORS[TERRAIN.StoneFloor]);
  });

  it("un arbre est vert sombre, quel que soit le terrain dessous", () => {
    expect(tileColor(TERRAIN.Grass, FEATURE.Tree)).toBe(MINIMAP_TREE_COLOR);
    expect(tileColor(TERRAIN.Dirt, FEATURE.Tree)).toBe(MINIMAP_TREE_COLOR);
  });

  it("un rocher est gris", () => {
    expect(tileColor(TERRAIN.Gravel, FEATURE.Rock)).toBe(MINIMAP_ROCK_COLOR);
  });

  it("un mur reprend la couleur de son matériau (contrat sim::build::Material)", () => {
    expect(tileColor(TERRAIN.Dirt, FEATURE.WallWood)).toBe(WALL_COLORS[MATERIAL.Wood]);
    expect(tileColor(TERRAIN.Dirt, FEATURE.WallStone)).toBe(WALL_COLORS[MATERIAL.Stone]);
  });

  it("un élément non couvert (porte, lit...) laisse la couleur de terrain", () => {
    expect(tileColor(TERRAIN.Grass, FEATURE.Bed)).toBe(TERRAIN_COLORS[TERRAIN.Grass]);
  });
});

describe("paintBackground", () => {
  it("peint chaque case en RGBA opaque, dans l'ordre y * largeur + x", () => {
    // Deux cases : eau profonde à (0,0), un arbre sur herbe à (1,0).
    const tiles = new Uint8Array([TERRAIN.DeepWater, TERRAIN.Grass]);
    const features = new Uint8Array([FEATURE.None, FEATURE.Tree]);
    const out = new Uint8ClampedArray(2 * 4);
    paintBackground(2, 1, tiles, features, out);

    const water = TERRAIN_COLORS[TERRAIN.DeepWater];
    expect([out[0], out[1], out[2], out[3]]).toEqual([
      (water >> 16) & 0xff,
      (water >> 8) & 0xff,
      water & 0xff,
      255,
    ]);
    expect([out[4], out[5], out[6], out[7]]).toEqual([
      (MINIMAP_TREE_COLOR >> 16) & 0xff,
      (MINIMAP_TREE_COLOR >> 8) & 0xff,
      MINIMAP_TREE_COLOR & 0xff,
      255,
    ]);
  });
});

describe("tileToPixel / pixelToTile", () => {
  it("fait l'aller-retour à l'échelle par défaut", () => {
    for (const tile of [0, 1, 5, 63, 127]) {
      expect(pixelToTile(tileToPixel(tile))).toBe(tile);
    }
  });

  it("fait l'aller-retour à une échelle explicite", () => {
    expect(tileToPixel(10, 2)).toBe(20);
    expect(pixelToTile(20, 2)).toBe(10);
    // Un pixel au milieu d'une case retombe sur la même case.
    expect(pixelToTile(tileToPixel(10, MINIMAP_SCALE) + 1, MINIMAP_SCALE)).toBe(10);
  });
});

describe("clampRect", () => {
  it("laisse un rectangle déjà dans la carte inchangé", () => {
    expect(clampRect({ x0: 2, y0: 3, x1: 10, y1: 12 }, 128, 128)).toEqual({ x0: 2, y0: 3, x1: 10, y1: 12 });
  });

  it("borne un rectangle qui déborde de la carte (caméra près d'un coin)", () => {
    expect(clampRect({ x0: -20, y0: -5, x1: 40, y1: 30 }, 128, 128)).toEqual({ x0: 0, y0: 0, x1: 40, y1: 30 });
    expect(clampRect({ x0: 100, y0: 110, x1: 160, y1: 200 }, 128, 128)).toEqual({ x0: 100, y0: 110, x1: 128, y1: 128 });
  });

  it("réordonne un rectangle entièrement hors carte en un rectangle dégénéré", () => {
    expect(clampRect({ x0: -50, y0: -50, x1: -10, y1: -10 }, 128, 128)).toEqual({ x0: 0, y0: 0, x1: 0, y1: 0 });
  });
});
