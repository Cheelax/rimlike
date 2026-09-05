/**
 * Logique pure des relations entre colons (`src/social.ts`) : décodage de
 * `pawn_opinions`, qualificatif d'un avis et tri, sans sim ni rendu.
 */

import { describe, expect, it } from "vitest";

import { decodeOpinions, opinionLabel, sortOpinions, type Opinion } from "../src/social";

describe("decodeOpinions", () => {
  it("décode `[autre, avis] × n`", () => {
    const buf = new Int32Array([3, 60, 5, -10, 7, -70]);
    expect(decodeOpinions(buf)).toEqual([
      { other: 3, value: 60 },
      { other: 5, value: -10 },
      { other: 7, value: -70 },
    ]);
  });

  it("renvoie un tableau vide pour un tampon vide", () => {
    expect(decodeOpinions(new Int32Array(0))).toEqual([]);
  });

  it("coupe proprement un tampon impair, sans planter", () => {
    const buf = new Int32Array([3, 60, 5]);
    expect(decodeOpinions(buf)).toEqual([{ other: 3, value: 60 }]);
  });

  it("accepte un tableau ordinaire, pas seulement un `Int32Array`", () => {
    expect(decodeOpinions([3, 60, 5, -10])).toEqual([
      { other: 3, value: 60 },
      { other: 5, value: -10 },
    ]);
  });
});

describe("opinionLabel", () => {
  it("qualifie ami à partir de 50 (`FRIEND_OPINION`)", () => {
    expect(opinionLabel(50)).toBe("ami");
    expect(opinionLabel(100)).toBe("ami");
  });

  it("qualifie apprécié de 20 à 49", () => {
    expect(opinionLabel(49)).toBe("apprécié");
    expect(opinionLabel(20)).toBe("apprécié");
  });

  it("qualifie toléré de -19 à 19", () => {
    expect(opinionLabel(19)).toBe("toléré");
    expect(opinionLabel(0)).toBe("toléré");
    expect(opinionLabel(-19)).toBe("toléré");
  });

  it("qualifie mal vu de -49 à -20", () => {
    expect(opinionLabel(-20)).toBe("mal vu");
    expect(opinionLabel(-49)).toBe("mal vu");
  });

  it("qualifie rival à partir de -50 (`RIVAL_OPINION`)", () => {
    expect(opinionLabel(-50)).toBe("rival");
    expect(opinionLabel(-100)).toBe("rival");
  });
});

describe("sortOpinions", () => {
  it("trie par avis décroissant, amis en tête et rivaux en fin de liste", () => {
    const opinions: Opinion[] = [
      { other: 1, value: -60 },
      { other: 2, value: 70 },
      { other: 3, value: 0 },
    ];
    expect(sortOpinions(opinions)).toEqual([
      { other: 2, value: 70 },
      { other: 3, value: 0 },
      { other: 1, value: -60 },
    ]);
  });

  it("ne modifie pas le tableau reçu", () => {
    const opinions: Opinion[] = [
      { other: 1, value: -60 },
      { other: 2, value: 70 },
    ];
    const original = [...opinions];
    sortOpinions(opinions);
    expect(opinions).toEqual(original);
  });

  it("renvoie un tableau vide pour une liste vide", () => {
    expect(sortOpinions([])).toEqual([]);
  });
});
