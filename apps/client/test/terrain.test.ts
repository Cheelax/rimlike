/**
 * Fonctions pures de `render/terrain.ts` : pas de sim, pas de rendu, juste du
 * texte pour le HUD et le panneau du colon.
 */

import { describe, expect, it } from "vitest";

import { eventLabel, formatInjury } from "../src/render/terrain";

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
