/**
 * Logique pure de la recherche (`src/research.ts`) : décodage de
 * `research_state()` et pourcentage d'avancement, sans sim ni rendu.
 */

import { describe, expect, it } from "vitest";

import { decodeResearch, researchPercent, TECH_METALLURGY, TECHS } from "../src/research";

describe("TECHS", () => {
  it("couvre les six technologies de `sim::research::Tech`, dans l'ordre de l'enum", () => {
    expect(TECHS.map((t) => t.value)).toEqual([0, 1, 2, 3, 4, 5]);
    expect(TECHS.map((t) => t.name)).toEqual([
      "Agriculture",
      "Médecine",
      "Conservation",
      "Archerie",
      "Maçonnerie",
      "Métallurgie",
    ]);
  });

  it("donne une description non vide par technologie", () => {
    for (const tech of TECHS) {
      expect(typeof tech.description).toBe("string");
      expect(tech.description.length).toBeGreaterThan(0);
    }
  });

  it("TECH_METALLURGY pointe la sixième technologie, la seule qui verrouille quelque chose", () => {
    expect(TECH_METALLURGY).toBe(5);
    expect(TECHS[TECH_METALLURGY].name).toBe("Métallurgie");
  });
});

describe("decodeResearch", () => {
  it("décode `[courante, (avancement, coût, acquise) × 6]`", () => {
    const buf = new Uint32Array([
      1, // la médecine (tech 1) est en cours
      500, 2000, 0, // Agriculture : en cours d'aucune recherche, pas acquise
      300, 2500, 0, // Médecine : la courante
      2500, 2500, 1, // Conservation : acquise
      0, 3000, 0, // Archerie : rien
      0, 3000, 0, // Maçonnerie : rien
      0, 3500, 0, // Métallurgie : rien
    ]);
    const state = decodeResearch(buf);
    expect(state.current).toBe(1);
    expect(state.techs).toEqual([
      { tech: 0, progress: 500, cost: 2000, done: false },
      { tech: 1, progress: 300, cost: 2500, done: false },
      { tech: 2, progress: 2500, cost: 2500, done: true },
      { tech: 3, progress: 0, cost: 3000, done: false },
      { tech: 4, progress: 0, cost: 3000, done: false },
      { tech: 5, progress: 0, cost: 3500, done: false },
    ]);
  });

  it("renvoie `current: null` quand rien n'est cherché (255)", () => {
    const buf = new Uint32Array(19).fill(0);
    buf[0] = 255;
    expect(decodeResearch(buf).current).toBeNull();
  });

  it("rend les lignes qu'un tampon trop court peut porter, sans planter", () => {
    expect(decodeResearch(new Uint32Array(0)).techs).toEqual([]);
    expect(decodeResearch(new Uint32Array(0)).current).toBeNull();
    // Juste `current` et une technologie complète : la suite est coupée proprement.
    const partial = decodeResearch(new Uint32Array([0, 100, 2000, 0]));
    expect(partial.current).toBe(0);
    expect(partial.techs).toEqual([{ tech: 0, progress: 100, cost: 2000, done: false }]);
  });

  it("accepte un tableau ordinaire, pas seulement un `Uint32Array`", () => {
    const buf = [255, 0, 2000, 0, 0, 2500, 0, 0, 2500, 0, 0, 3000, 0, 0, 3000, 0, 0, 3500, 0];
    expect(decodeResearch(buf).techs.length).toBe(6);
    expect(decodeResearch(buf).current).toBeNull();
  });
});

describe("researchPercent", () => {
  it("calcule un pourcentage entier borné 0..100", () => {
    expect(researchPercent(0, 2000)).toBe(0);
    expect(researchPercent(1000, 2000)).toBe(50);
    expect(researchPercent(2000, 2000)).toBe(100);
    expect(researchPercent(2500, 2000)).toBe(100); // au-delà du coût : borné
  });

  it("ne plante pas sur un coût nul, négatif ou non fini", () => {
    expect(researchPercent(500, 0)).toBe(0);
    expect(researchPercent(500, -10)).toBe(0);
    expect(researchPercent(Number.NaN, 2000)).toBe(0);
  });
});
