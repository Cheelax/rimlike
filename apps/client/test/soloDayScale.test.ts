/** Même stockage en mémoire que soloBiome.test.ts, sans navigateur. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAY_SCALE, TICKS_PER_DAY, WORLD_DAY_SCALE } from "@rimlike/protocol";
import {
  DEFAULT_SOLO_DAY_SCALE,
  isSoloDayScale,
  loadSoloDayScale,
  saveSoloDayScale,
  SOLO_DAY_SCALES,
  SOLO_DAY_SCALE_LABELS,
} from "../src/soloDayScale";

const KEY = "rimlike.solo.dayScale.v1";

beforeEach(() => {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
  });
});

afterEach(() => vi.unstubAllGlobals());

describe("échelle du jour solo mémorisée", () => {
  it("propose le rythme du monde et la partie rapide, et rien d'autre", () => {
    expect([...SOLO_DAY_SCALES]).toEqual([WORLD_DAY_SCALE, DEFAULT_DAY_SCALE]);
    for (const scale of SOLO_DAY_SCALES) {
      expect(isSoloDayScale(scale)).toBe(true);
      expect(SOLO_DAY_SCALE_LABELS[scale]).toBeTruthy();
    }
  });

  it("joue au rythme du monde par défaut : le solo n'est pas un autre jeu", () => {
    expect(DEFAULT_SOLO_DAY_SCALE).toBe(WORLD_DAY_SCALE);
    expect(loadSoloDayScale()).toBe(30);
    // Deux heures réelles par jour de jeu, à 60 ticks/s.
    expect(TICKS_PER_DAY * DEFAULT_SOLO_DAY_SCALE).toBe(432_000);
    expect((TICKS_PER_DAY * DEFAULT_SOLO_DAY_SCALE) / 60 / 3600).toBe(2);
  });

  it("mémorise chaque choix sous la clé versionnée", () => {
    for (const scale of SOLO_DAY_SCALES) {
      saveSoloDayScale(scale);
      expect(localStorage.getItem(KEY)).toBe(JSON.stringify(scale));
      expect(loadSoloDayScale()).toBe(scale);
    }
  });

  it.each([0, -1, 2, 29, 31, 121, 30.5, "30", null, true, [], {}])(
    "refuse une préférence invalide (%j) et revient au rythme du monde",
    (value) => {
      expect(isSoloDayScale(value)).toBe(false);
      localStorage.setItem(KEY, JSON.stringify(value));
      expect(loadSoloDayScale()).toBe(DEFAULT_SOLO_DAY_SCALE);
    },
  );

  it("tolère un JSON cassé, un stockage indisponible et son absence", () => {
    localStorage.setItem(KEY, "{ pas du json");
    expect(loadSoloDayScale()).toBe(DEFAULT_SOLO_DAY_SCALE);

    vi.stubGlobal("localStorage", {
      getItem: () => { throw new Error("stockage indisponible"); },
      setItem: () => { throw new Error("quota dépassé"); },
    });
    expect(loadSoloDayScale()).toBe(DEFAULT_SOLO_DAY_SCALE);
    expect(() => saveSoloDayScale(1)).not.toThrow();

    vi.stubGlobal("localStorage", undefined);
    expect(loadSoloDayScale()).toBe(DEFAULT_SOLO_DAY_SCALE);
    expect(() => saveSoloDayScale(1)).not.toThrow();
  });
});
