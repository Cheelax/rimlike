import { describe, expect, it } from "vitest";

import {
  NEIGHBOR_SLOTS,
  NO_NEIGHBOR,
  WORLD_WIRE_VERSION,
  deserializeWorld,
  findRoute,
  generateWorld,
  reclassify,
  serializeWorld,
  tileCount,
  type WorldWire,
} from "../src/index.js";

const N = 3;
const world = generateWorld(N, 20_260_904);
const wire = serializeWorld(world);

/** Tolérance de l'aller-retour : erreur relative d'un flottant simple précision. */
const RELATIVE = 1e-6;

function expectClose(actual: number, expected: number): void {
  expect(Math.abs(actual - expected)).toBeLessThanOrEqual(RELATIVE * Math.max(1, Math.abs(expected)));
}

describe("format du WorldWire", () => {
  it("porte sa version et ses dimensions", () => {
    expect(wire.version).toBe(WORLD_WIRE_VERSION);
    expect(wire.seed).toBe(world.seed);
    expect(wire.subdivisions).toBe(N);
    expect(wire.tileCount).toBe(tileCount(N));
  });

  it("a des longueurs de tableaux cohérentes", () => {
    const count = wire.tileCount;
    expect(wire.centers).toHaveLength(count * 3);
    expect(wire.biomes).toHaveLength(count);
    expect(wire.elevation).toHaveLength(count);
    expect(wire.temperature).toHaveLength(count);
    expect(wire.moisture).toHaveLength(count);
    expect(wire.neighbors).toHaveLength(count * NEIGHBOR_SLOTS);
    expect(wire.polygonOffsets).toHaveLength(count + 1);
    expect(wire.polygons).toHaveLength((wire.polygonOffsets[count] as number) * 3);
    // 6 sommets par case, moins un pour chacun des 12 pentagones.
    expect(wire.polygonOffsets[count]).toBe(6 * count - 12);
  });

  it("marque la 6ᵉ place des pentagones avec -1, et seulement elle", () => {
    let holes = 0;
    for (let i = 0; i < wire.tileCount; i += 1) {
      for (let k = 0; k < NEIGHBOR_SLOTS; k += 1) {
        const id = wire.neighbors[i * NEIGHBOR_SLOTS + k] as number;
        if (id === NO_NEIGHBOR) {
          holes += 1;
          expect(k).toBe(5);
        } else {
          expect(id).toBeGreaterThanOrEqual(0);
          expect(id).toBeLessThan(wire.tileCount);
        }
      }
    }
    expect(holes).toBe(12);
  });

  it("ne contient que des nombres finis, donc passe en JSON", () => {
    for (const key of ["centers", "elevation", "temperature", "moisture", "polygons"] as const) {
      for (const value of wire[key]) {
        expect(Number.isFinite(value)).toBe(true);
      }
    }
    expect(JSON.parse(JSON.stringify(wire))).toEqual(wire);
  });

  it("garde des identifiants de biome entiers dans [0, 9]", () => {
    for (const biome of wire.biomes) {
      expect(Number.isInteger(biome)).toBe(true);
      expect(biome).toBeGreaterThanOrEqual(0);
      expect(biome).toBeLessThanOrEqual(9);
    }
  });
});

describe("aller-retour", () => {
  const restored = deserializeWorld(wire);

  it("restitue le seed, la subdivision et le nombre de cases", () => {
    expect(restored.seed).toBe(world.seed);
    expect(restored.subdivisions).toBe(world.subdivisions);
    expect(restored.tiles).toHaveLength(world.tiles.length);
  });

  it("restitue sans perte les entiers : identifiants, biomes, voisins", () => {
    expect(restored.tiles.map((tile) => tile.id)).toEqual(world.tiles.map((tile) => tile.id));
    expect(restored.tiles.map((tile) => tile.biome)).toEqual(world.tiles.map((tile) => tile.biome));
    expect(restored.tiles.map((tile) => tile.neighbors)).toEqual(
      world.tiles.map((tile) => [...tile.neighbors]),
    );
  });

  it("restitue les flottants à 1e-6 près", () => {
    for (let i = 0; i < world.tiles.length; i += 1) {
      const before = world.tiles[i]!;
      const after = restored.tiles[i]!;
      expectClose(after.center[0], before.center[0]);
      expectClose(after.center[1], before.center[1]);
      expectClose(after.center[2], before.center[2]);
      expectClose(after.elevation, before.elevation);
      expectClose(after.temperature, before.temperature);
      expectClose(after.moisture, before.moisture);
      expect(after.polygon).toHaveLength(before.polygon.length);
      for (let v = 0; v < before.polygon.length; v += 1) {
        for (let axis = 0; axis < 3; axis += 1) {
          expectClose(after.polygon[v]![axis]!, before.polygon[v]![axis]!);
        }
      }
    }
  });

  it("recalcule latitude, longitude et aire au lieu de les transporter", () => {
    // Elles se déduisent des centres et des polygones ; l'écart est celui de
    // la précision simple, amplifié près des pôles pour la latitude.
    for (let i = 0; i < world.tiles.length; i += 1) {
      const before = world.tiles[i]!;
      const after = restored.tiles[i]!;
      expect(Math.abs(after.lat - before.lat)).toBeLessThan(1e-3);
      expect(Math.abs(after.lon - before.lon)).toBeLessThan(1e-3);
      expect(Math.abs(after.area - before.area) / before.area).toBeLessThan(1e-5);
    }
  });

  it("est stable : sérialiser deux fois donne le même paquet", () => {
    expect(serializeWorld(restored)).toEqual(wire);
  });

  it("donne les mêmes itinéraires après l'aller-retour", () => {
    const from = world.tiles.findIndex((tile) => tile.biome !== 0);
    const to = world.tiles.length - 1 - [...world.tiles].reverse().findIndex((tile) => tile.biome !== 0);
    const before = findRoute(world, from, to);
    const after = findRoute(restored, from, to);
    if (before === null) {
      expect(after).toBeNull();
    } else {
      expect(after).not.toBeNull();
      expect(after!.tiles).toEqual(before.tiles);
      expect(after!.hours).toBeCloseTo(before.hours, 9);
    }
  });

  it("garde des biomes cohérents avec la table de décision locale", () => {
    for (const tile of restored.tiles) {
      expect(reclassify(tile)).toBe(tile.biome);
    }
  });
});

describe("validation du paquet reçu", () => {
  const clone = (): WorldWire => JSON.parse(JSON.stringify(wire)) as WorldWire;

  it("refuse une version inconnue", () => {
    expect(() => deserializeWorld({ ...clone(), version: 99 })).toThrow(RangeError);
  });

  it("refuse un tableau de la mauvaise longueur", () => {
    const broken = clone();
    expect(() => deserializeWorld({ ...broken, centers: broken.centers.slice(0, -3) })).toThrow(
      RangeError,
    );
    expect(() => deserializeWorld({ ...broken, biomes: broken.biomes.slice(0, -1) })).toThrow(
      RangeError,
    );
    expect(() =>
      deserializeWorld({ ...broken, polygonOffsets: broken.polygonOffsets.slice(0, -1) }),
    ).toThrow(RangeError);
  });

  it("refuse un tileCount incohérent", () => {
    expect(() => deserializeWorld({ ...clone(), tileCount: 0 })).toThrow(RangeError);
  });

  it("refuse un voisin hors du monde", () => {
    const broken = clone();
    broken.neighbors[0] = broken.tileCount + 5;
    expect(() => deserializeWorld(broken)).toThrow(RangeError);
  });

  it("refuse un biome inconnu", () => {
    const broken = clone();
    broken.biomes[0] = 42;
    expect(() => deserializeWorld(broken)).toThrow(RangeError);
  });
});
