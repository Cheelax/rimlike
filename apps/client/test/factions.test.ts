/**
 * Factions PNJ et réputation, logique pure (`src/factions.ts`) : les trois
 * factions, le palier de réputation et l'estimation d'un tribut. Contrat avec
 * `crates/sim/src/factions.rs`, relu sans WASM (voir l'en-tête de
 * `src/factions.ts`).
 */

import { describe, expect, it } from "vitest";

import {
  ALLY_GOODWILL,
  FACTION_KIND,
  FACTIONS,
  factionDative,
  factionDefinite,
  factionGenitive,
  factionName,
  giftGain,
  HOSTILE_GOODWILL,
  relationLabel,
} from "../src/factions";

describe("FACTIONS", () => {
  it("liste les trois factions dans l'ordre de leurs ids", () => {
    expect(FACTIONS.map((f) => f.id)).toEqual([0, 1, 2]);
    expect(FACTIONS[0]).toMatchObject({ name: "Clan des Cendres", kind: FACTION_KIND.Raiders });
    expect(FACTIONS[1]).toMatchObject({ name: "Fraternité du Fer", kind: FACTION_KIND.Raiders });
    expect(FACTIONS[2]).toMatchObject({ name: "Guilde des Colporteurs", kind: FACTION_KIND.Guild });
  });

  it("distingue les deux tribus de la guilde par leur genre", () => {
    expect(FACTIONS.filter((f) => f.kind === FACTION_KIND.Raiders)).toHaveLength(2);
    expect(FACTIONS.filter((f) => f.kind === FACTION_KIND.Guild)).toHaveLength(1);
  });

  it("factionName renvoie une chaîne vide pour un id inconnu", () => {
    expect(factionName(0)).toBe("Clan des Cendres");
    expect(factionName(2)).toBe("Guilde des Colporteurs");
    expect(factionName(3)).toBe("");
    expect(factionName(-1)).toBe("");
  });

  it("accorde l'article selon le genre grammatical de chaque nom", () => {
    // Masculin : Clan des Cendres.
    expect(factionDefinite(0)).toBe("le Clan des Cendres");
    expect(factionDative(0)).toBe("au Clan des Cendres");
    expect(factionGenitive(0)).toBe("du Clan des Cendres");
    // Féminin : Fraternité du Fer et Guilde des Colporteurs.
    expect(factionDefinite(1)).toBe("la Fraternité du Fer");
    expect(factionDative(1)).toBe("à la Fraternité du Fer");
    expect(factionGenitive(1)).toBe("de la Fraternité du Fer");
    expect(factionDative(2)).toBe("à la Guilde des Colporteurs");
    // Id inconnu : chaîne vide, comme `factionName`.
    expect(factionDefinite(9)).toBe("");
    expect(factionDative(9)).toBe("");
    expect(factionGenitive(9)).toBe("");
  });
});

describe("relationLabel", () => {
  it("classe hostile strictement sous le seuil bas", () => {
    expect(relationLabel(HOSTILE_GOODWILL - 1)).toBe("hostile");
    expect(relationLabel(-100)).toBe("hostile");
  });

  it("classe méfiant entre les deux seuils, bornes basses incluses", () => {
    expect(relationLabel(HOSTILE_GOODWILL)).toBe("méfiant");
    expect(relationLabel(0)).toBe("méfiant");
    expect(relationLabel(ALLY_GOODWILL - 1)).toBe("méfiant");
  });

  it("classe allié à partir du seuil haut", () => {
    expect(relationLabel(ALLY_GOODWILL)).toBe("allié");
    expect(relationLabel(100)).toBe("allié");
  });
});

describe("giftGain", () => {
  it("applique la valeur par point du sim (20)", () => {
    expect(giftGain(3, 60)).toBe(9); // 3 * 60 / 20 = 9
    expect(giftGain(50, 2)).toBe(5); // un manteau de cuir (valeur 50) : deux points
  });

  it("vaut au moins 1 dès que prix et quantité sont positifs", () => {
    expect(giftGain(1, 1)).toBe(1);
    expect(giftGain(5, 1)).toBe(1); // 5 / 20 arrondi à 0, remonté à 1
  });

  it("vaut 0 sans prix connu ou sans quantité", () => {
    expect(giftGain(0, 10)).toBe(0);
    expect(giftGain(5, 0)).toBe(0);
    expect(giftGain(-1, 10)).toBe(0);
  });
});
