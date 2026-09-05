/**
 * Réglages graphiques (`src/settings.ts`), module pur : défauts, aller-retour
 * `localStorage`, valeurs corrompues ramenées au défaut champ par champ, et
 * `effectivePixelRatio`. Un faux `localStorage` en mémoire tient lieu de DOM
 * (config de test sous Node, voir `vitest.config.ts`).
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DEFAULT_GRAPHICS, effectivePixelRatio, loadGraphics, saveGraphics, type GraphicsSettings } from "../src/settings";

/** `localStorage` minimal, le strict nécessaire de `settings.ts`. */
class FakeStorage {
  private store = new Map<string, string>();
  getItem(key: string): string | null {
    return this.store.get(key) ?? null;
  }
  setItem(key: string, value: string): void {
    this.store.set(key, value);
  }
  removeItem(key: string): void {
    this.store.delete(key);
  }
}

const globalWithStorage = globalThis as unknown as { localStorage?: unknown };
let previous: unknown;

beforeEach(() => {
  previous = globalWithStorage.localStorage;
  globalWithStorage.localStorage = new FakeStorage();
});

afterEach(() => {
  globalWithStorage.localStorage = previous;
});

describe("réglages graphiques", () => {
  it("renvoie le défaut quand rien n'est mémorisé", () => {
    expect(loadGraphics()).toEqual(DEFAULT_GRAPHICS);
  });

  it("fait l'aller-retour sans perte", () => {
    const settings: GraphicsSettings = { pixelRatio: 1.5, propDensity: "basse", shadows: false };
    saveGraphics(settings);
    expect(loadGraphics()).toEqual(settings);
  });

  it("ramène une valeur inconnue au défaut, champ par champ", () => {
    (localStorage as unknown as FakeStorage).setItem(
      "rimlike.graphics.v1",
      JSON.stringify({ pixelRatio: 3, propDensity: "extreme", shadows: false }),
    );
    // Seul `shadows` était valide : les deux autres retombent au défaut, pas
    // tout l'objet.
    expect(loadGraphics()).toEqual({ ...DEFAULT_GRAPHICS, shadows: false });
  });

  it("renvoie le défaut sur un JSON invalide", () => {
    (localStorage as unknown as FakeStorage).setItem("rimlike.graphics.v1", "{ pas du json");
    expect(loadGraphics()).toEqual(DEFAULT_GRAPHICS);
  });

  it("survit à un `localStorage` qui jette (mode privé, quota)", () => {
    const throwing = {
      getItem: () => {
        throw new Error("stockage indisponible");
      },
      setItem: () => {
        throw new Error("stockage indisponible");
      },
    };
    globalWithStorage.localStorage = throwing;
    expect(loadGraphics()).toEqual(DEFAULT_GRAPHICS);
    expect(() => saveGraphics(DEFAULT_GRAPHICS)).not.toThrow();
  });

  it("ratio effectif : auto plafonne à 2, une valeur explicite passe telle quelle", () => {
    expect(effectivePixelRatio("auto", 1)).toBe(1);
    expect(effectivePixelRatio("auto", 2)).toBe(2);
    expect(effectivePixelRatio("auto", 3)).toBe(2);
    expect(effectivePixelRatio(1, 3)).toBe(1);
    expect(effectivePixelRatio(1.5, 1)).toBe(1.5);
  });
});
