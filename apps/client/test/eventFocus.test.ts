/**
 * `eventFocus.ts` : logique pure, testée avec un contexte factice (pas de
 * sim, pas de rendu). Un cas par famille de la table (voir l'en-tête du
 * fichier testé), plus les cas limites où le pawn visé a disparu.
 */

import { describe, expect, it } from "vitest";

import { eventTarget, type EventFocusCtx } from "../src/eventFocus";

/** Contexte factice : `pawns` simule le tampon `pawns` courant, `fire` la couche feu, `trader` `frame.traderPresent`. */
function fakeCtx(opts: {
  pawns?: { id: number; x: number; y: number; faction: number }[];
  fire?: { x: number; y: number }[];
  trader?: number | null;
}): EventFocusCtx {
  const pawns = opts.pawns ?? [];
  const fire = opts.fire ?? [];
  const trader = opts.trader ?? null;
  return {
    pawnById(id) {
      const p = pawns.find((q) => q.id === id);
      return p ? { x: p.x, y: p.y } : null;
    },
    firstPawnOfFaction(faction) {
      const p = pawns.find((q) => q.faction === faction);
      return p ? { id: p.id, x: p.x, y: p.y } : null;
    },
    firstBurningTile() {
      return fire.length > 0 ? fire[0] : null;
    },
    traderId() {
      return trader;
    },
  };
}

describe("eventTarget", () => {
  it("mène à un pawn encore présent pour un colon à terre (8)", () => {
    const ctx = fakeCtx({ pawns: [{ id: 7, x: 10, y: 12, faction: 0 }] });
    expect(eventTarget(8, 7, ctx)).toEqual({ kind: "pawn", id: 7 });
  });

  it("couvre les autres genres de la famille pawn direct (secouru, soigné, malade, dispute, rixe, ami perdu, piège, sanglier, craque, voyageur)", () => {
    const ctx = fakeCtx({ pawns: [{ id: 3, x: 1, y: 1, faction: 0 }] });
    for (const kind of [9, 10, 23, 32, 33, 34, 35, 19, 6, 5]) {
      expect(eventTarget(kind, 3, ctx)).toEqual({ kind: "pawn", id: 3 });
    }
  });

  it("redevient null si le pawn visé n'est plus dans le tampon (mort, parti)", () => {
    const ctx = fakeCtx({ pawns: [] });
    expect(eventTarget(9, 42, ctx)).toBeNull();
  });

  it("marchand (26, 27, 29) mène au marchand courant (`ctx.traderId`), pas à `arg`", () => {
    const ctx = fakeCtx({ pawns: [{ id: 99, x: 5, y: 5, faction: 3 }], trader: 99 });
    expect(eventTarget(26, 99, ctx)).toEqual({ kind: "pawn", id: 99 });
    expect(eventTarget(27, 99, ctx)).toEqual({ kind: "pawn", id: 99 });
    // `arg` volontairement différent de l'id courant : le marchand courant gagne quand même.
    expect(eventTarget(29, 1, ctx)).toEqual({ kind: "pawn", id: 99 });
  });

  it("marchand : null si plus aucun marchand présent (déjà reparti ou mort)", () => {
    const ctx = fakeCtx({ pawns: [], trader: null });
    expect(eventTarget(29, 99, ctx)).toBeNull();
  });

  it("raid (1) et annonce de raid (21) mènent au premier pillard trouvé", () => {
    const ctx = fakeCtx({
      pawns: [
        { id: 1, x: 0, y: 0, faction: 0 },
        { id: 5, x: 20, y: 21, faction: 1 },
      ],
    });
    expect(eventTarget(1, 3, ctx)).toEqual({ kind: "pawn", id: 5 });
    expect(eventTarget(21, 0, ctx)).toEqual({ kind: "pawn", id: 5 });
  });

  it("raid : null si plus aucun pillard sur la carte", () => {
    const ctx = fakeCtx({ pawns: [{ id: 1, x: 0, y: 0, faction: 0 }] });
    expect(eventTarget(1, 3, ctx)).toBeNull();
    expect(eventTarget(21, 0, ctx)).toBeNull();
  });

  it("incendie (36) mène à la première case en feu", () => {
    const ctx = fakeCtx({ fire: [{ x: 8, y: 9 }] });
    expect(eventTarget(36, 0, ctx)).toEqual({ kind: "tile", x: 8, y: 9 });
  });

  it("incendie : null si rien ne brûle", () => {
    const ctx = fakeCtx({ fire: [] });
    expect(eventTarget(36, 0, ctx)).toBeNull();
  });

  it("événements sans lieu : niveau, saison, gel, recherche, troc, réputation, tribut, largage, feu éteint", () => {
    const ctx = fakeCtx({ pawns: [{ id: 1, x: 0, y: 0, faction: 0 }] });
    for (const kind of [7, 15, 16, 31, 28, 43, 42, 22, 37]) {
      expect(eventTarget(kind, 1, ctx)).toBeNull();
    }
  });

  it("mort d'un colon ou d'un pillard, et pillard qui fuit : null (déjà retirés du tampon au même tick)", () => {
    const ctx = fakeCtx({ pawns: [] });
    for (const kind of [2, 3, 4]) {
      expect(eventTarget(kind, 1, ctx)).toBeNull();
    }
  });
});
