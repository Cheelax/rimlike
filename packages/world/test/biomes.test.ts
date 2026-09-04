import { describe, expect, it } from "vitest";

import {
  Biome,
  BIOME_NAMES,
  MOUNTAIN_HEIGHT,
  SEA_LEVEL,
  WATER_TARGET,
  biomeShare,
  classifyBiome,
  createRng,
  generateWorld,
  landHeight,
  normalizeElevations,
  rawElevationAt,
  type World,
} from "../src/index.js";

/** Subdivision de calibration : celle sur laquelle les seuils sont réglés. */
const CALIBRATION = 4;

/** Un seul monde à n = 4 par fichier : c'est la génération la plus coûteuse. */
const world = generateWorld(CALIBRATION, 20_260_904);

const biomesOf = (w: World): number[] => w.tiles.map((tile) => tile.biome);

describe("déterminisme de la génération", () => {
  it("rend exactement les mêmes biomes pour le même seed", () => {
    const a = generateWorld(3, 4242);
    const b = generateWorld(3, 4242);
    expect(biomesOf(a)).toEqual(biomesOf(b));
    expect(a.tiles.map((t) => t.elevation)).toEqual(b.tiles.map((t) => t.elevation));
    expect(a.tiles.map((t) => t.temperature)).toEqual(b.tiles.map((t) => t.temperature));
    expect(a.tiles.map((t) => t.moisture)).toEqual(b.tiles.map((t) => t.moisture));
  });

  it("rend un monde différent pour un seed différent", () => {
    const a = biomesOf(generateWorld(3, 4242));
    const b = biomesOf(generateWorld(3, 4243));
    expect(a).not.toEqual(b);
    // Pas seulement quelques cases : la géographie entière change.
    const differing = a.filter((biome, i) => biome !== b[i]).length;
    expect(differing).toBeGreaterThan(a.length * 0.3);
  });

  it("normalise le seed en entier 32 bits", () => {
    expect(generateWorld(2, 7).seed).toBe(7);
    expect(biomesOf(generateWorld(2, 7))).toEqual(biomesOf(generateWorld(2, 7.9)));
  });

  it("garde les identifiants et la géométrie indépendants du seed", () => {
    const a = generateWorld(2, 1);
    const b = generateWorld(2, 999);
    expect(a.tiles.map((t) => t.center)).toEqual(b.tiles.map((t) => t.center));
    expect(a.tiles.map((t) => t.neighbors)).toEqual(b.tiles.map((t) => t.neighbors));
  });
});

describe("élévation", () => {
  it("reste bornée dans [0, 1]", () => {
    for (const tile of world.tiles) {
      expect(tile.elevation).toBeGreaterThanOrEqual(0);
      expect(tile.elevation).toBeLessThanOrEqual(1);
    }
  });

  it("place exactement WATER_TARGET des cases sous le niveau de la mer", () => {
    const submerged = world.tiles.filter((tile) => tile.elevation < SEA_LEVEL).length;
    const share = submerged / world.tiles.length;
    expect(share).toBeCloseTo(WATER_TARGET, 2);
  });

  it("conserve l'ordre des altitudes en normalisant", () => {
    const raw = world.tiles.map((tile) => rawElevationAt(tile.center, world.seed));
    const normalized = normalizeElevations(raw);
    for (let i = 1; i < raw.length; i += 1) {
      if ((raw[i] as number) > (raw[i - 1] as number)) {
        expect(normalized[i] as number).toBeGreaterThanOrEqual(normalized[i - 1] as number);
      }
    }
  });

  it("tient la part d'eau visée sur beaucoup de seeds", () => {
    // C'est la raison d'être de la normalisation : un seuil constant sur le
    // bruit donnait de 21 % à 73 % d'eau selon le seed.
    for (let s = 0; s < 6; s += 1) {
      const small = generateWorld(2, 500 + s * 7919);
      const submerged = small.tiles.filter((tile) => tile.elevation < SEA_LEVEL).length;
      expect(submerged / small.tiles.length).toBeCloseTo(WATER_TARGET, 1);
    }
  });

  it("met landHeight à 0 sous l'eau et à 1 au sommet", () => {
    expect(landHeight(0)).toBe(0);
    expect(landHeight(SEA_LEVEL)).toBe(0);
    expect(landHeight(1)).toBeCloseTo(1, 12);
  });
});

describe("part d'océan", () => {
  it("reste entre 50 et 70 % à n = 4", () => {
    const share = biomeShare(world, Biome.Ocean);
    expect(share).toBeGreaterThan(0.5);
    expect(share).toBeLessThan(0.7);
  });

  it("y reste sur une dizaine de seeds", () => {
    for (let s = 0; s < 8; s += 1) {
      const share = biomeShare(generateWorld(3, 31 + s * 104_729), Biome.Ocean);
      expect(share).toBeGreaterThan(0.5);
      expect(share).toBeLessThan(0.7);
    }
  });

  it("laisse assez de terre pour jouer", () => {
    const land = world.tiles.filter(
      (tile) => tile.biome !== Biome.Ocean && tile.biome !== Biome.Mountain,
    ).length;
    expect(land / world.tiles.length).toBeGreaterThan(0.25);
  });
});

describe("climat", () => {
  it("gèle les pôles", () => {
    const polar = world.tiles.filter((tile) => Math.abs(tile.lat) > 75);
    expect(polar.length).toBeGreaterThan(20);
    const frozen = polar.filter(
      (tile) => tile.biome === Biome.Ice || tile.biome === Biome.Tundra || tile.biome === Biome.Ocean,
    );
    // Le reste, ce sont des sommets : la montagne passe avant le climat.
    expect(frozen.length / polar.length).toBeGreaterThan(0.8);
    for (const tile of polar) {
      expect(tile.biome).not.toBe(Biome.Jungle);
      expect(tile.biome).not.toBe(Biome.Savanna);
      expect(tile.biome).not.toBe(Biome.TemperateForest);
    }
  });

  it("ne met jamais de glace à l'équateur", () => {
    const equator = world.tiles.filter((tile) => Math.abs(tile.lat) < 10);
    expect(equator.length).toBeGreaterThan(50);
    for (const tile of equator) {
      expect(tile.biome).not.toBe(Biome.Ice);
      expect(tile.biome).not.toBe(Biome.Tundra);
    }
  });

  it("est plus chaud à l'équateur qu'aux pôles", () => {
    const mean = (tiles: readonly { temperature: number }[]): number =>
      tiles.reduce((sum, tile) => sum + tile.temperature, 0) / tiles.length;
    const equator = mean(world.tiles.filter((tile) => Math.abs(tile.lat) < 15));
    const polar = mean(world.tiles.filter((tile) => Math.abs(tile.lat) > 75));
    expect(equator).toBeGreaterThan(15);
    expect(polar).toBeLessThan(-10);
  });

  it("refroidit avec l'altitude", () => {
    // À latitude comparable, les cases hautes sont plus froides.
    const band = world.tiles.filter((tile) => Math.abs(tile.lat) < 30 && tile.elevation > SEA_LEVEL);
    const high = band.filter((tile) => landHeight(tile.elevation) > 0.5);
    const low = band.filter((tile) => landHeight(tile.elevation) < 0.1);
    expect(high.length).toBeGreaterThan(5);
    expect(low.length).toBeGreaterThan(5);
    const meanOf = (tiles: typeof band): number =>
      tiles.reduce((sum, tile) => sum + tile.temperature, 0) / tiles.length;
    expect(meanOf(high)).toBeLessThan(meanOf(low));
  });

  it("garde l'humidité dans [0, 1]", () => {
    for (const tile of world.tiles) {
      expect(tile.moisture).toBeGreaterThanOrEqual(0);
      expect(tile.moisture).toBeLessThanOrEqual(1);
    }
  });
});

describe("table de décision", () => {
  it("nomme les dix biomes", () => {
    const values = Object.values(Biome).filter((value): value is Biome => typeof value === "number");
    expect(values).toHaveLength(10);
    for (const biome of values) {
      expect(BIOME_NAMES[biome]).toBeTruthy();
    }
  });

  it("met de l'eau sous le niveau de la mer, de la banquise si elle gèle", () => {
    expect(classifyBiome(SEA_LEVEL - 0.01, 20, 0.5)).toBe(Biome.Ocean);
    expect(classifyBiome(SEA_LEVEL - 0.01, -25, 0.5)).toBe(Biome.Ice);
  });

  it("met de la montagne au-dessus du seuil, quel que soit le climat", () => {
    const high = SEA_LEVEL + (1 - SEA_LEVEL) * (MOUNTAIN_HEIGHT + 0.05);
    expect(classifyBiome(high, 30, 0.9)).toBe(Biome.Mountain);
    expect(classifyBiome(high, -20, 0.1)).toBe(Biome.Mountain);
  });

  it("suit la température puis l'humidité sur les basses terres", () => {
    const low = SEA_LEVEL + 0.01;
    expect(classifyBiome(low, -20, 0.5)).toBe(Biome.Ice);
    expect(classifyBiome(low, -3, 0.5)).toBe(Biome.Tundra);
    expect(classifyBiome(low, 5, 0.6)).toBe(Biome.BorealForest);
    expect(classifyBiome(low, 5, 0.1)).toBe(Biome.Tundra);
    expect(classifyBiome(low, 15, 0.8)).toBe(Biome.TemperateForest);
    expect(classifyBiome(low, 15, 0.45)).toBe(Biome.Grassland);
    expect(classifyBiome(low, 15, 0.1)).toBe(Biome.Desert);
    expect(classifyBiome(low, 26, 0.8)).toBe(Biome.Jungle);
    expect(classifyBiome(low, 26, 0.45)).toBe(Biome.Savanna);
    expect(classifyBiome(low, 26, 0.1)).toBe(Biome.Desert);
  });

  it("produit tous les biomes sur un globe à n = 4", () => {
    const present = new Set(world.tiles.map((tile) => tile.biome));
    expect(present.size).toBe(10);
  });
});

describe("rng", () => {
  it("rend la même suite pour le même seed", () => {
    const a = createRng(7);
    const b = createRng(7);
    for (let i = 0; i < 100; i += 1) {
      expect(a.next()).toBe(b.next());
    }
  });

  it("reste dans [0, 1) et couvre l'intervalle", () => {
    const rng = createRng(1234);
    let min = 1;
    let max = 0;
    for (let i = 0; i < 10_000; i += 1) {
      const value = rng.next();
      expect(value).toBeGreaterThanOrEqual(0);
      expect(value).toBeLessThan(1);
      min = Math.min(min, value);
      max = Math.max(max, value);
    }
    expect(min).toBeLessThan(0.01);
    expect(max).toBeGreaterThan(0.99);
  });

  it("tire des entiers bornés et des éléments de tableau", () => {
    const rng = createRng(99);
    const counts = [0, 0, 0, 0];
    for (let i = 0; i < 4000; i += 1) {
      const value = rng.int(4);
      expect(Number.isInteger(value)).toBe(true);
      counts[value] = (counts[value] as number) + 1;
    }
    for (const count of counts) {
      expect(count).toBeGreaterThan(800);
    }
    expect(["a", "b"]).toContain(createRng(3).pick(["a", "b"]));
    expect(() => rng.int(0)).toThrow(RangeError);
    expect(() => rng.pick([])).toThrow(RangeError);
  });
});
