import { describe, expect, it } from "vitest";

import {
  DEFAULT_SUBDIVISIONS,
  angleBetween,
  buildTiles,
  estimatedTileAngle,
  geodesicGrid,
  icosahedron,
  length,
  subdivide,
  tileCount,
  toLatLon,
  type TileGeometry,
  type Vec3,
} from "../src/index.js";

/** Les tests de masse tournent à n = 3 (642 cases) : assez grand, instantané. */
const N = 3;

describe("tileCount", () => {
  it("suit 10 × 4^n + 2", () => {
    expect(tileCount(0)).toBe(12);
    expect(tileCount(1)).toBe(42);
    expect(tileCount(2)).toBe(162);
    expect(tileCount(3)).toBe(642);
    expect(tileCount(4)).toBe(2562);
    expect(tileCount(5)).toBe(10_242);
  });

  it("correspond au nombre de cases réellement construites", () => {
    for (let n = 0; n <= N; n += 1) {
      expect(geodesicGrid(n).length).toBe(tileCount(n));
    }
  });

  it("refuse les subdivisions absurdes", () => {
    expect(() => tileCount(-1)).toThrow(RangeError);
    expect(() => tileCount(1.5)).toThrow(RangeError);
    expect(() => tileCount(99)).toThrow(RangeError);
  });
});

describe("maillage géodésique", () => {
  it("part d'un icosaèdre à 12 sommets, 20 faces et 30 arêtes", () => {
    const mesh = icosahedron();
    expect(mesh.positions).toHaveLength(12);
    expect(mesh.faces).toHaveLength(20);
    expect(mesh.edges).toHaveLength(30);
  });

  it("quadruple les faces à chaque subdivision et respecte Euler", () => {
    for (let n = 0; n <= N; n += 1) {
      const mesh = subdivide(icosahedron(), n);
      expect(mesh.faces).toHaveLength(20 * 4 ** n);
      expect(mesh.edges).toHaveLength(30 * 4 ** n);
      expect(mesh.positions).toHaveLength(tileCount(n));
      // V - E + F = 2 pour toute triangulation de la sphère.
      expect(mesh.positions.length - mesh.edges.length + mesh.faces.length).toBe(2);
    }
  });

  it("garde tous les sommets sur la sphère unité", () => {
    const mesh = subdivide(icosahedron(), N);
    for (const position of mesh.positions) {
      expect(length(position)).toBeCloseTo(1, 12);
    }
  });

  it("laisse le maillage inchangé pour n = 0", () => {
    const mesh = icosahedron();
    expect(subdivide(mesh, 0).positions).toEqual(mesh.positions);
  });
});

describe("dual : les cases", () => {
  const tiles = geodesicGrid(N);

  it("a exactement 12 pentagones, tout le reste en hexagones", () => {
    const pentagons = tiles.filter((tile) => tile.neighbors.length === 5);
    const hexagons = tiles.filter((tile) => tile.neighbors.length === 6);
    expect(pentagons).toHaveLength(12);
    expect(hexagons).toHaveLength(tiles.length - 12);
    // Les pentagones sont les 12 sommets de l'icosaèdre d'origine, donc les
    // 12 premiers identifiants : la subdivision n'insère qu'après eux.
    expect(pentagons.map((tile) => tile.id)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
  });

  it("garde les 12 pentagones aux mêmes identifiants à toute subdivision", () => {
    for (let n = 1; n <= N; n += 1) {
      const grid = geodesicGrid(n);
      for (let id = 0; id < 12; id += 1) {
        expect(grid[id]!.neighbors).toHaveLength(5);
      }
    }
  });

  it("a des voisinages symétriques", () => {
    for (const tile of tiles) {
      for (const neighbor of tile.neighbors) {
        expect(tiles[neighbor]!.neighbors).toContain(tile.id);
      }
      // Pas de doublon, pas d'auto-voisinage.
      expect(new Set(tile.neighbors).size).toBe(tile.neighbors.length);
      expect(tile.neighbors).not.toContain(tile.id);
    }
  });

  it("a tous ses centres unitaires", () => {
    for (const tile of tiles) {
      expect(Math.abs(length(tile.center) - 1)).toBeLessThan(1e-9);
    }
  });

  it("a des polygones à 5 ou 6 sommets, unitaires, autant que de voisins", () => {
    for (const tile of tiles) {
      expect([5, 6]).toContain(tile.polygon.length);
      expect(tile.polygon).toHaveLength(tile.neighbors.length);
      for (const point of tile.polygon) {
        expect(Math.abs(length(point) - 1)).toBeLessThan(1e-9);
      }
    }
  });

  it("ordonne les voisins autour du centre", () => {
    // Deux voisins consécutifs dans la liste sont eux-mêmes voisins : c'est
    // la définition d'une ronde autour du centre.
    for (const tile of tiles) {
      for (let k = 0; k < tile.neighbors.length; k += 1) {
        const current = tile.neighbors[k]!;
        const next = tile.neighbors[(k + 1) % tile.neighbors.length]!;
        expect(tiles[current]!.neighbors).toContain(next);
      }
    }
  });

  it("pave la sphère : la somme des aires vaut 4π", () => {
    const total = tiles.reduce((sum, tile) => sum + tile.area, 0);
    expect(total).toBeCloseTo(4 * Math.PI, 6);
    expect(Math.abs(total - 4 * Math.PI) / (4 * Math.PI)).toBeLessThan(0.01);
  });

  it("n'a que des aires positives et du bon ordre de grandeur", () => {
    const expected = (4 * Math.PI) / tiles.length;
    for (const tile of tiles) {
      expect(tile.area).toBeGreaterThan(0);
      expect(tile.area).toBeGreaterThan(expected * 0.5);
      expect(tile.area).toBeLessThan(expected * 1.5);
    }
  });

  it("donne le même dual que le passage explicite par le maillage", () => {
    const viaMesh = buildTiles(subdivide(icosahedron(), N));
    expect(viaMesh.map((tile) => tile.neighbors)).toEqual(tiles.map((tile) => tile.neighbors));
  });
});

describe("latitude et longitude", () => {
  it("place le nord en +Y et la longitude 0 sur le méridien +Z", () => {
    expect(toLatLon([0, 1, 0]).lat).toBeCloseTo(90, 10);
    expect(toLatLon([0, -1, 0]).lat).toBeCloseTo(-90, 10);
    expect(toLatLon([0, 0, 1]).lon).toBeCloseTo(0, 10);
    expect(toLatLon([1, 0, 0]).lon).toBeCloseTo(90, 10);
    expect(toLatLon([-1, 0, 0]).lon).toBeCloseTo(-90, 10);
  });

  it("reste dans les bornes sur tout le globe", () => {
    for (const tile of geodesicGrid(N)) {
      expect(tile.lat).toBeGreaterThanOrEqual(-90);
      expect(tile.lat).toBeLessThanOrEqual(90);
      expect(tile.lon).toBeGreaterThan(-180.000_001);
      expect(tile.lon).toBeLessThanOrEqual(180);
    }
  });

  it("couvre les deux hémisphères jusque près des pôles", () => {
    const lats = geodesicGrid(4).map((tile) => tile.lat);
    expect(Math.max(...lats)).toBeGreaterThan(85);
    expect(Math.min(...lats)).toBeLessThan(-85);
  });
});

describe("angles entre voisins", () => {
  it("suit l'estimation analytique à 15 % près", () => {
    for (let n = 1; n <= N; n += 1) {
      const grid: TileGeometry[] = geodesicGrid(n);
      const estimate = estimatedTileAngle(n);
      for (const tile of grid) {
        for (const neighbor of tile.neighbors) {
          const angle = angleBetween(tile.center, grid[neighbor]!.center);
          expect(angle).toBeGreaterThan(estimate * 0.85);
          expect(angle).toBeLessThan(estimate * 1.25);
        }
      }
    }
  });

  it("divise l'angle par deux à chaque subdivision", () => {
    expect(estimatedTileAngle(DEFAULT_SUBDIVISIONS)).toBeCloseTo(estimatedTileAngle(0) / 32, 12);
  });

  it("mesure π entre deux points antipodaux", () => {
    const north: Vec3 = [0, 1, 0];
    const south: Vec3 = [0, -1, 0];
    expect(angleBetween(north, south)).toBeCloseTo(Math.PI, 12);
    expect(angleBetween(north, north)).toBeCloseTo(0, 12);
  });
});
