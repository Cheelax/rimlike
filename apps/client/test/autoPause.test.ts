/**
 * `autoPause.ts` : réglages de la pause automatique (aller-retour
 * `localStorage`, valeurs corrompues ramenées au défaut) et `shouldAutoPause`.
 * Même patron que `settings.test.ts` : un faux `localStorage` en mémoire
 * tient lieu de DOM.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  AUTO_PAUSE_EVENTS,
  DEFAULT_AUTO_PAUSE,
  loadAutoPause,
  saveAutoPause,
  shouldAutoPause,
  type AutoPauseSettings,
} from "../src/autoPause";

/** `localStorage` minimal, le strict nécessaire d'`autoPause.ts`. */
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

describe("AUTO_PAUSE_EVENTS", () => {
  it("porte les cinq genres surveillés avec leur défaut (raid annoncé, raid, à terre, incendie activés ; marchand désactivé)", () => {
    const byKind = new Map(AUTO_PAUSE_EVENTS.map((e) => [e.kind, e.defaultOn]));
    expect(byKind.get(21)).toBe(true); // raid annoncé
    expect(byKind.get(1)).toBe(true); // raid
    expect(byKind.get(8)).toBe(true); // colon à terre
    expect(byKind.get(36)).toBe(true); // incendie déclaré
    expect(byKind.get(26)).toBe(false); // marchand arrivé
  });
});

describe("réglages de pause automatique", () => {
  it("renvoie le défaut quand rien n'est mémorisé", () => {
    expect(loadAutoPause()).toEqual(DEFAULT_AUTO_PAUSE);
  });

  it("fait l'aller-retour sans perte", () => {
    const settings: AutoPauseSettings = {
      enabled: true,
      events: { 21: false, 1: true, 8: false, 36: true, 26: true },
    };
    saveAutoPause(settings);
    expect(loadAutoPause()).toEqual(settings);
  });

  it("ramène l'interrupteur général au défaut s'il est corrompu, sans toucher aux cases", () => {
    (localStorage as unknown as FakeStorage).setItem(
      "rimlike.autopause.v1",
      JSON.stringify({ enabled: "oui", events: { 21: false, 1: true, 8: true, 36: true, 26: false } }),
    );
    expect(loadAutoPause()).toEqual({
      enabled: DEFAULT_AUTO_PAUSE.enabled,
      events: { 21: false, 1: true, 8: true, 36: true, 26: false },
    });
  });

  it("ramène un genre corrompu ou absent à son propre défaut, sans faire perdre les autres", () => {
    (localStorage as unknown as FakeStorage).setItem(
      "rimlike.autopause.v1",
      JSON.stringify({ enabled: true, events: { 21: "toujours", 1: false } }),
    );
    expect(loadAutoPause()).toEqual({
      enabled: true,
      // 21 corrompu -> défaut (true) ; 1 valide -> false ; le reste absent -> défaut.
      events: { 21: true, 1: false, 8: true, 36: true, 26: false },
    });
  });

  it("renvoie le défaut sur un JSON invalide", () => {
    (localStorage as unknown as FakeStorage).setItem("rimlike.autopause.v1", "{ pas du json");
    expect(loadAutoPause()).toEqual(DEFAULT_AUTO_PAUSE);
  });

  it("renvoie le défaut si `events` n'est pas un objet", () => {
    (localStorage as unknown as FakeStorage).setItem(
      "rimlike.autopause.v1",
      JSON.stringify({ enabled: false, events: null }),
    );
    expect(loadAutoPause()).toEqual({ ...DEFAULT_AUTO_PAUSE, enabled: false });
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
    expect(loadAutoPause()).toEqual(DEFAULT_AUTO_PAUSE);
    expect(() => saveAutoPause(DEFAULT_AUTO_PAUSE)).not.toThrow();
  });
});

describe("shouldAutoPause", () => {
  it("vrai en solo pour un genre coché avec l'interrupteur général activé", () => {
    expect(shouldAutoPause(8, DEFAULT_AUTO_PAUSE, false)).toBe(true); // colon à terre, activé par défaut
  });

  it("faux pour un genre décoché, même activé", () => {
    expect(shouldAutoPause(26, DEFAULT_AUTO_PAUSE, false)).toBe(false); // marchand, désactivé par défaut
  });

  it("faux si l'interrupteur général est coupé, même si le genre est coché", () => {
    const settings: AutoPauseSettings = { ...DEFAULT_AUTO_PAUSE, enabled: false };
    expect(shouldAutoPause(1, settings, false)).toBe(false);
  });

  it("jamais en multijoueur, même coché et l'interrupteur général activé", () => {
    expect(shouldAutoPause(1, DEFAULT_AUTO_PAUSE, true)).toBe(false);
    expect(shouldAutoPause(21, DEFAULT_AUTO_PAUSE, true)).toBe(false);
    expect(shouldAutoPause(8, DEFAULT_AUTO_PAUSE, true)).toBe(false);
    expect(shouldAutoPause(36, DEFAULT_AUTO_PAUSE, true)).toBe(false);
  });

  it("faux pour un genre non surveillé, absent d'AUTO_PAUSE_EVENTS", () => {
    expect(shouldAutoPause(2, DEFAULT_AUTO_PAUSE, false)).toBe(false); // mort d'un colon : pas dans la liste
  });
});
