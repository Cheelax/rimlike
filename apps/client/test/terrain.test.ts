/**
 * Fonctions pures de `render/terrain.ts` : pas de sim, pas de rendu, juste du
 * texte pour le HUD et le panneau du colon.
 */

import { describe, expect, it } from "vitest";

import {
  clampCraftTarget,
  eventLabel,
  formatInjury,
  formatTemperature,
  SEASON_LABELS,
  WEAPON_NAMES,
  WEATHER_LABELS,
} from "../src/render/terrain";

describe("eventLabel", () => {
  it("nomme le colon quand son nom est connu", () => {
    const names = { 3: "Alice" };
    expect(eventLabel(7, 3, names)).toBe("Alice monte en niveau");
    expect(eventLabel(8, 3, names)).toBe("Alice est à terre");
    expect(eventLabel(9, 3, names)).toBe("Alice a été secouru");
    expect(eventLabel(10, 3, names)).toBe("Alice a été soigné");
  });

  it("retombe sur « Un colon » sans nom connu", () => {
    expect(eventLabel(7, 3)).toBe("Un colon monte en niveau");
    expect(eventLabel(8, 3, {})).toBe("Un colon est à terre");
    expect(eventLabel(9, 3, { 5: "Bob" })).toBe("Un colon a été secouru"); // id absent du dictionnaire
  });

  it("laisse les genres sans nom inchangés", () => {
    expect(eventLabel(1, 4)).toBe("Raid ! 4 pillard(s) approchent");
    expect(eventLabel(2, 3, { 3: "Alice" })).toBe("Un colon est mort");
    expect(eventLabel(99, 0)).toBe("");
  });

  it("compte les colons d'une caravane, `arg` n'étant pas un id ici", () => {
    // Contrat avec `sim::EventKind` : 11 départ, 12 arrivée, `arg` = le nombre
    // de colons. Un dictionnaire de noms ne doit pas s'y glisser.
    expect(eventLabel(11, 3, { 3: "Alice" })).toBe("Une caravane est partie (3 colons)");
    expect(eventLabel(12, 3)).toBe("Une caravane est arrivée (3 colons)");
    expect(eventLabel(11, 1)).toBe("Une caravane est partie (1 colon)");
    // Un convoi de marchandises seules débarque zéro colon.
    expect(eventLabel(12, 0)).toBe("Une caravane est arrivée (0 colon)");
  });

  it("annonce le temps rattrapé par l'avance rapide d'une colonie gelée", () => {
    // Contrat avec `sim::EventKind::FastForwarded` : `arg` = jours entiers.
    expect(eventLabel(13, 0)).toBe("Moins d'un jour a passé pendant votre absence");
    expect(eventLabel(13, 1)).toBe("1 jour a passé pendant votre absence");
    expect(eventLabel(13, 12)).toBe("12 jours ont passé pendant votre absence");
  });

  it("nomme l'arme fabriquée, `arg` étant son genre et non un id", () => {
    // Contrat avec `sim::EventKind::WeaponCrafted` (14) : `arg` suit `ItemKind`.
    expect(eventLabel(14, 6)).toBe("Un gourdin a été fabriqué");
    expect(eventLabel(14, 7)).toBe("Un épieu a été fabriqué");
    expect(eventLabel(14, 8)).toBe("Un arc a été fabriqué");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(14, 6, { 6: "Alice" })).toBe("Un gourdin a été fabriqué");
  });

  it("annonce le changement de saison avec l'article qui va bien, `arg` suivant `sim::climate::Season`", () => {
    // Contrat avec `sim::EventKind::SeasonChanged` (15).
    expect(eventLabel(15, 0)).toBe("Le printemps commence");
    expect(eventLabel(15, 1)).toBe("L'été commence");
    expect(eventLabel(15, 2)).toBe("L'automne commence");
    expect(eventLabel(15, 3)).toBe("L'hiver commence");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(15, 3, { 3: "Alice" })).toBe("L'hiver commence");
  });

  it("annonce la première gelée de l'automne, sans dépendre de `arg`", () => {
    // Contrat avec `sim::EventKind::FirstFrost` (16) : `arg` = jour de l'année.
    expect(eventLabel(16, 45)).toBe("Premières gelées");
  });
});

describe("SEASON_LABELS", () => {
  it("suit `sim::climate::Season` (0 printemps … 3 hiver)", () => {
    expect(SEASON_LABELS).toEqual(["printemps", "été", "automne", "hiver"]);
  });
});

describe("WEATHER_LABELS", () => {
  it("suit `sim::Weather`, la neige en dernier (3 : la pluie qui gèle)", () => {
    expect(WEATHER_LABELS).toEqual(["Clair", "Pluie", "Orage", "Neige"]);
  });
});

describe("formatTemperature", () => {
  it("affiche des dixièmes de degré arrondis, avec l'unité", () => {
    expect(formatTemperature(120)).toBe("12 °C");
    expect(formatTemperature(0)).toBe("0 °C");
    expect(formatTemperature(-50)).toBe("-5 °C");
    // Arrondi, pas troncature : 126 dixièmes = 12,6 °C → 13.
    expect(formatTemperature(126)).toBe("13 °C");
    expect(formatTemperature(-126)).toBe("-13 °C");
  });
});

describe("WEAPON_NAMES", () => {
  it("donne le nom singulier des trois armes, indexé par `ItemKind`", () => {
    expect(WEAPON_NAMES[6]).toBe("gourdin");
    expect(WEAPON_NAMES[7]).toBe("épieu");
    expect(WEAPON_NAMES[8]).toBe("arc");
  });
});

describe("clampCraftTarget", () => {
  it("borne un objectif de fabrication à 0..20", () => {
    expect(clampCraftTarget(-5)).toBe(0);
    expect(clampCraftTarget(0)).toBe(0);
    expect(clampCraftTarget(7)).toBe(7);
    expect(clampCraftTarget(20)).toBe(20);
    expect(clampCraftTarget(21)).toBe(20);
    expect(clampCraftTarget(1000)).toBe(20);
  });

  it("tronque les décimales et rejette les valeurs non finies", () => {
    expect(clampCraftTarget(3.9)).toBe(3);
    expect(clampCraftTarget(Number.NaN)).toBe(0);
    expect(clampCraftTarget(Number.POSITIVE_INFINITY)).toBe(0);
  });
});

describe("formatInjury", () => {
  it("affiche la partie, la sévérité en pourcentage et l'état", () => {
    // Jambe gauche (4), sévérité 200/1000, saigne.
    expect(formatInjury(4, 200, 50, 0)).toBe("jambe gauche · 20 % · saigne");
    // Torse (1), pansé : ne saigne plus, quelle que soit la sévérité restante.
    expect(formatInjury(1, 100, 0, 1)).toBe("torse · 10 % · pansée");
    // Tête (0), refermée d'elle-même : ni saignement ni pansement.
    expect(formatInjury(0, 50, 0, 0)).toBe("tête · 5 % · stable");
  });

  it("couvre les six parties du corps", () => {
    expect(formatInjury(0, 0, 0, 0)).toContain("tête");
    expect(formatInjury(1, 0, 0, 0)).toContain("torse");
    expect(formatInjury(2, 0, 0, 0)).toContain("bras gauche");
    expect(formatInjury(3, 0, 0, 0)).toContain("bras droit");
    expect(formatInjury(4, 0, 0, 0)).toContain("jambe gauche");
    expect(formatInjury(5, 0, 0, 0)).toContain("jambe droite");
  });
});
