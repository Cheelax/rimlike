/** Même stockage en mémoire que settings.test.ts, sans navigateur. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { Biome, BIOME_NAMES } from "@rimlike/world";
import { DEFAULT_SOLO_BIOME, isSoloBiome, loadSoloBiome, saveSoloBiome, SOLO_BIOMES } from "../src/soloBiome";

const KEY = "rimlike.solo.biome.v1";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("biome solo mémorisé", () => {
  it("propose les neuf biomes fondables, nommés par le monde", () => {
    expect([...SOLO_BIOMES]).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
    expect(Object.values(Biome).filter((v) => typeof v === "number" && v !== Biome.Ocean)).toEqual(SOLO_BIOMES);
    for (const biome of SOLO_BIOMES) {
      expect(isSoloBiome(biome)).toBe(true);
      expect(BIOME_NAMES[biome]).toBeTruthy();
    }
  });

  it("prend la forêt tempérée quand aucun choix n'est enregistré", () => {
    expect(DEFAULT_SOLO_BIOME).toBe(4);
    expect(loadSoloBiome()).toBe(Biome.TemperateForest);
  });

  it("mémorise chaque biome fondable sous la clé versionnée", () => {
    for (const biome of SOLO_BIOMES) {
      saveSoloBiome(biome);
      expect(localStorage.getItem(KEY)).toBe(JSON.stringify(biome));
      expect(loadSoloBiome()).toBe(biome);
    }
  });

  it.each([0, -1, 10, 6.5, "6", null, true, [], {}, { biome: 6 }])(
    "refuse une préférence invalide (%j) et revient au défaut",
    (value) => {
      expect(isSoloBiome(value)).toBe(false);
      localStorage.setItem(KEY, JSON.stringify(value));
      expect(loadSoloBiome()).toBe(DEFAULT_SOLO_BIOME);
    },
  );

  it("rejette les nombres non finis et les valeurs absentes", () => {
    for (const value of [NaN, Infinity, -Infinity, undefined]) expect(isSoloBiome(value)).toBe(false);
  });

  it("tolère un JSON cassé", () => {
    localStorage.setItem(KEY, "{ pas du json");
    expect(loadSoloBiome()).toBe(DEFAULT_SOLO_BIOME);
  });

  it("tolère le stockage indisponible, en lecture comme en écriture", () => {
    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("stockage indisponible"); },
      setItem: () => { throw new Error("quota dépassé"); },
    });
    expect(loadSoloBiome()).toBe(DEFAULT_SOLO_BIOME);
    expect(() => saveSoloBiome(Biome.Desert)).not.toThrow();
  });

  it("tolère l'absence complète de localStorage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadSoloBiome()).toBe(DEFAULT_SOLO_BIOME);
    expect(() => saveSoloBiome(Biome.Desert)).not.toThrow();
  });
});
