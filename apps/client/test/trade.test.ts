/**
 * Logique pure du troc (`src/trade.ts`) : décodage de l'étal du marchand et
 * prévalidation d'une proposition, sans sim ni rendu.
 */

import { describe, expect, it } from "vitest";

import { tradeBalance, tradeOffers, type TradeBalanceInput } from "../src/trade";

describe("tradeOffers", () => {
  it("décode l'étal du marchand : [genre, quantité, prix unitaire] × n", () => {
    const buf = new Int32Array([6, 3, 40, 12, 10, 5]);
    expect(tradeOffers(buf)).toEqual([
      { kind: 6, count: 3, sellPrice: 40 },
      { kind: 12, count: 10, sellPrice: 5 },
    ]);
  });

  it("renvoie un tableau vide sans marchand", () => {
    expect(tradeOffers(new Int32Array(0))).toEqual([]);
  });

  it("accepte un tableau ordinaire, pas seulement un `Int32Array`", () => {
    expect(tradeOffers([6, 3, 40])).toEqual([{ kind: 6, count: 3, sellPrice: 40 }]);
  });
});

describe("tradeBalance", () => {
  // 20 bois en stock (prix d'achat 3), le marchand vend 5 viandes à 10 chacune.
  const base: TradeBalanceInput = {
    give: 0,
    giveCount: 10,
    take: 12,
    takeCount: 2,
    stored: [20, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    available: 5,
    buyPrices: [3, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0],
    sellPrice: 10,
  };

  it("accepte un troc dont la valeur offerte couvre la valeur demandée", () => {
    // payé = 3 × 10 = 30, demandé = 10 × 2 = 20.
    const res = tradeBalance(base);
    expect(res.paid).toBe(30);
    expect(res.cost).toBe(20);
    expect(res.ok).toBe(true);
    expect(res.reason).toBeNull();
  });

  it("accepte un troc tout juste à l'équilibre", () => {
    const res = tradeBalance({ ...base, giveCount: 7 }); // 3 × 7 = 21 ≥ 20
    expect(res.paid).toBe(21);
    expect(res.ok).toBe(true);
  });

  it("refuse tant qu'aucune quantité n'est choisie d'un côté ou de l'autre, sans raison affichée", () => {
    expect(tradeBalance({ ...base, giveCount: 0 })).toMatchObject({ ok: false, reason: null });
    expect(tradeBalance({ ...base, takeCount: 0 })).toMatchObject({ ok: false, reason: null });
    expect(tradeBalance({ ...base, giveCount: 0, takeCount: 0 })).toMatchObject({ ok: false, reason: null });
  });

  it("refuse si le stock de la colonie ne suffit pas", () => {
    const res = tradeBalance({ ...base, giveCount: 30 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("Pas assez en stockage");
  });

  it("refuse si le marchand n'a pas autant du genre demandé", () => {
    const res = tradeBalance({ ...base, takeCount: 6 }); // le lot n'en a que 5
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("Le marchand n'en a pas autant");
  });

  it("refuse une offre sous la valeur demandée, en chiffrant ce qui manque", () => {
    // payé = 3 × 4 = 12, demandé = 10 × 2 = 20 : il manque 8.
    const res = tradeBalance({ ...base, giveCount: 4 });
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("Offre insuffisante : il manque 8 de valeur");
  });

  it("priorise le stock de la colonie sur la valeur quand les deux manquent", () => {
    // Ni le stock (30 > 20) ni la valeur (3 × 30 = 90 ≥ 20, en fait suffisante :
    // on force donc aussi un prix nul pour que la valeur manque également).
    const res = tradeBalance({ ...base, giveCount: 30, buyPrices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(res.reason).toBe("Pas assez en stockage");
  });

  it("priorise le stock du marchand sur la valeur quand les deux manquent", () => {
    const res = tradeBalance({ ...base, takeCount: 6, buyPrices: [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0] });
    expect(res.reason).toBe("Le marchand n'en a pas autant");
  });

  it("traite un prix ou un stock manquant (indice hors tableau) comme 0", () => {
    const res = tradeBalance({ ...base, give: 99, stored: [] });
    expect(res.paid).toBe(0);
    expect(res.ok).toBe(false);
    expect(res.reason).toBe("Pas assez en stockage");
  });
});
