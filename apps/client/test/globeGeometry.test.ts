/**
 * La géométrie du globe, éprouvée sans WebGL.
 *
 * `buildGlobeGeometry` est la seule pièce du rendu du monde qui ait des
 * invariants vérifiables à froid : le compte de triangles, le mappage
 * triangle → case dont dépendent le survol et le clic, le rayon de chaque
 * sommet (donc le relief), et des couleurs dans l'intervalle attendu par
 * Three.js. Le reste (caméra, lumières, calques) se regarde à l'écran.
 *
 * `generateWorld` est appelé ici — et seulement ici : en production le client
 * ne génère jamais le globe, il le télécharge (`docs/world.md` §6).
 */

import { describe, expect, it } from "vitest";
import { generateWorld, landHeight } from "@rimlike/world";

import {
  BIOME_COLORS,
  GLOBE_RADIUS,
  RELIEF_SCALE,
  biomeColor,
  buildGlobeGeometry,
  buildTileFan,
  srgbToLinear,
  tileRadius,
} from "../src/render/globeGeometry";

/** Petit globe : 42 cases, assez pour tous les invariants, instantané à générer. */
const world = generateWorld(1, 7);

describe("buildGlobeGeometry", () => {
  it("triangule chaque case en éventail : k sommets donnent k − 2 triangles", () => {
    const expected = world.tiles.reduce((sum, tile) => sum + tile.polygon.length - 2, 0);
    const { positions, colors, tileOfTriangle } = buildGlobeGeometry(world);

    expect(tileOfTriangle.length).toBe(expected);
    expect(positions.length).toBe(expected * 9);
    expect(colors.length).toBe(expected * 9);
    // 12 pentagones et le reste en hexagones : 4 N − 12 triangles.
    expect(expected).toBe(4 * world.tiles.length - 12);
  });

  it("associe chaque triangle à sa case, et n'oublie aucune case", () => {
    const { tileOfTriangle } = buildGlobeGeometry(world);
    const seen = new Set<number>(tileOfTriangle);

    expect(seen.size).toBe(world.tiles.length);
    for (const tile of world.tiles) {
      expect(seen.has(tile.id)).toBe(true);
      // Une case donne exactement `polygon.length - 2` triangles.
      const count = [...tileOfTriangle].filter((id) => id === tile.id).length;
      expect(count).toBe(tile.polygon.length - 2);
    }
  });

  it("émet les triangles case par case, dans l'ordre des identifiants", () => {
    const { tileOfTriangle } = buildGlobeGeometry(world);
    // Le raycast n'a besoin que de `tileOfTriangle`, mais la contiguïté est ce
    // qui rendrait un surlignage par plage de sommets possible sans indirection.
    let at = 0;
    for (const tile of world.tiles) {
      for (let i = 0; i < tile.polygon.length - 2; i += 1) {
        expect(tileOfTriangle[at]).toBe(tile.id);
        at += 1;
      }
    }
    expect(at).toBe(tileOfTriangle.length);
  });

  it("pose chaque sommet au rayon de relief de sa case", () => {
    const { positions, tileOfTriangle } = buildGlobeGeometry(world);

    for (let triangle = 0; triangle < tileOfTriangle.length; triangle += 1) {
      const tile = world.tiles[tileOfTriangle[triangle]];
      const expected = GLOBE_RADIUS * (1 + RELIEF_SCALE * landHeight(tile.elevation));
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const at = triangle * 9 + vertex * 3;
        const norm = Math.hypot(positions[at], positions[at + 1], positions[at + 2]);
        expect(norm).toBeCloseTo(expected, 5);
      }
    }
  });

  it("laisse l'eau au niveau de la mer et pousse les terres au plus de 2 %", () => {
    for (const tile of world.tiles) {
      const radius = tileRadius(tile);
      expect(radius).toBeGreaterThanOrEqual(GLOBE_RADIUS);
      expect(radius).toBeLessThanOrEqual(GLOBE_RADIUS * (1 + RELIEF_SCALE));
      if (landHeight(tile.elevation) === 0) expect(radius).toBe(GLOBE_RADIUS);
    }
    // Un globe a forcément des terres : sinon le relief ne se verrait jamais.
    expect(world.tiles.some((tile) => tileRadius(tile) > GLOBE_RADIUS)).toBe(true);
  });

  it("ne produit que des couleurs dans [0, 1]", () => {
    const { colors } = buildGlobeGeometry(world);
    for (const channel of colors) {
      expect(channel).toBeGreaterThanOrEqual(0);
      expect(channel).toBeLessThanOrEqual(1);
    }
  });

  it("donne aux trois sommets d'un triangle la couleur plate de son biome", () => {
    const { colors, tileOfTriangle } = buildGlobeGeometry(world);
    for (let triangle = 0; triangle < tileOfTriangle.length; triangle += 1) {
      const expected = biomeColor(world.tiles[tileOfTriangle[triangle]].biome);
      for (let vertex = 0; vertex < 3; vertex += 1) {
        const at = triangle * 9 + vertex * 3;
        // Le tampon est en `Float32Array` : la comparaison se fait à sa précision.
        expect(colors[at]).toBeCloseTo(expected[0], 6);
        expect(colors[at + 1]).toBeCloseTo(expected[1], 6);
        expect(colors[at + 2]).toBeCloseTo(expected[2], 6);
      }
    }
  });

  it("accepte un globe lisse : relief nul, tous les sommets sur la sphère", () => {
    const { positions } = buildGlobeGeometry(world, { radius: 2, relief: 0 });
    for (let at = 0; at + 2 < positions.length; at += 3) {
      expect(Math.hypot(positions[at], positions[at + 1], positions[at + 2])).toBeCloseTo(2, 5);
    }
  });
});

describe("palette", () => {
  it("donne une couleur distincte à chacun des dix biomes", () => {
    const values = Object.values(BIOME_COLORS);
    expect(values.length).toBe(10);
    expect(new Set(values).size).toBe(10);
  });

  it("convertit le sRGB en linéaire aux deux bouts de l'intervalle", () => {
    expect(srgbToLinear(0)).toBe(0);
    expect(srgbToLinear(1)).toBeCloseTo(1, 12);
    // Le gris moyen sRGB vaut ~0,21 en linéaire : c'est tout l'intérêt de la
    // conversion, sans elle le globe serait délavé.
    expect(srgbToLinear(0.5)).toBeCloseTo(0.2140, 3);
  });
});

describe("buildTileFan", () => {
  it("rend les mêmes triangles qu'une case du globe entier", () => {
    const { positions, tileOfTriangle } = buildGlobeGeometry(world);
    const tile = world.tiles[3];
    const start = [...tileOfTriangle].indexOf(tile.id) * 9;
    const fan = buildTileFan(tile, GLOBE_RADIUS);

    expect(fan.length).toBe((tile.polygon.length - 2) * 9);
    for (let i = 0; i < fan.length; i += 1) {
      expect(fan[i]).toBeCloseTo(positions[start + i], 6);
    }
  });
});
