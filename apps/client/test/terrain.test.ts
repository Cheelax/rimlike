/**
 * Fonctions pures de `render/terrain.ts` : pas de sim, pas de rendu, juste du
 * texte pour le HUD et le panneau du colon.
 */

import { describe, expect, it } from "vitest";

import {
  APPAREL_NAMES,
  BASE_STOCK_COUNT,
  clampCraftTarget,
  DIFFICULTY_LABELS,
  eventCategory,
  eventLabel,
  formatEventTime,
  formatInjury,
  formatTemperature,
  formatWealth,
  hKeyAction,
  ITEM_NAMES,
  moodIcon,
  SEASON_LABELS,
  sickHoursRemaining,
  SPECIES_LABELS,
  TRAIT_HINTS,
  TRAIT_LABELS,
  visibleStock,
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

  it("annonce l'arrivée d'une harde, `arg` étant son effectif", () => {
    // Contrat avec `sim::EventKind::AnimalsArrived` (17).
    expect(eventLabel(17, 1)).toBe("Une harde de 1 bête est arrivée");
    expect(eventLabel(17, 3)).toBe("Une harde de 3 bêtes est arrivée");
  });

  it("nomme l'espèce chassée, `arg` suivant `sim::animals::Species` et non un id", () => {
    // Contrat avec `sim::EventKind::AnimalHunted` (18).
    expect(eventLabel(18, 0)).toBe("Un cerf a été chassé");
    expect(eventLabel(18, 1)).toBe("Un lapin a été chassé");
    expect(eventLabel(18, 2)).toBe("Un sanglier a été chassé");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(18, 0, { 0: "Alice" })).toBe("Un cerf a été chassé");
  });

  it("annonce la charge d'un sanglier, sans dépendre de `arg`", () => {
    // Contrat avec `sim::EventKind::BoarAttacks` (19) : `arg` = l'id du sanglier.
    expect(eventLabel(19, 7)).toBe("Un sanglier charge !");
  });

  it("nomme l'habit fabriqué, accordé en genre, `arg` étant son genre et non un id", () => {
    // Contrat avec `sim::EventKind::ItemCrafted` (20) : les armes gardent 14.
    expect(eventLabel(20, 14)).toBe("Une tunique a été fabriquée");
    expect(eventLabel(20, 15)).toBe("Un manteau a été fabriqué");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(20, 14, { 14: "Alice" })).toBe("Une tunique a été fabriquée");
  });

  it("annonce un raid en approche, `arg` suivant `sim::storyteller::RaidKind`", () => {
    // Contrat avec `sim::EventKind::RaidIncoming` (21).
    expect(eventLabel(21, 0)).toBe("Raid en approche : charge");
    expect(eventLabel(21, 1)).toBe("Raid en approche : archers");
    // Le siège a sa propre phrase, plus parlante que « : siège ».
    expect(eventLabel(21, 2)).toBe("Raid en approche : les pillards campent avant d'attaquer");
  });

  it("annonce un largage de vivres, `arg` étant le nombre de piles", () => {
    // Contrat avec `sim::EventKind::SupplyDrop` (22).
    expect(eventLabel(22, 1)).toBe("Un largage de 1 pile est tombé près de la colonie");
    expect(eventLabel(22, 3)).toBe("Un largage de 3 piles est tombé près de la colonie");
  });

  it("nomme le colon malade, `arg` étant son id", () => {
    // Contrat avec `sim::EventKind::Illness` (23).
    expect(eventLabel(23, 3, { 3: "Alice" })).toBe("Alice est malade");
    expect(eventLabel(23, 5)).toBe("Un colon est malade");
  });

  it("annonce un coup de froid ou une canicule, `arg` en dixièmes de degré", () => {
    // Contrat avec `sim::EventKind::ColdSnap` (24) et `Heatwave` (25) :
    // `arg` est toujours un écart positif, le signe vient du genre.
    expect(eventLabel(24, 100)).toBe("Coup de froid : −10 °C pendant un jour");
    expect(eventLabel(25, 100)).toBe("Canicule : +10 °C pendant un jour");
  });
});

describe("DIFFICULTY_LABELS", () => {
  it("suit `sim::storyteller::Difficulty` (0 paisible … 3 difficile)", () => {
    expect(DIFFICULTY_LABELS).toEqual(["Paisible", "Facile", "Normal", "Difficile"]);
  });
});

describe("APPAREL_NAMES", () => {
  it("donne le nom singulier des deux habits, indexé par `ItemKind`", () => {
    expect(APPAREL_NAMES[14]).toBe("tunique");
    expect(APPAREL_NAMES[15]).toBe("manteau");
  });
});

describe("SPECIES_LABELS", () => {
  it("suit `sim::animals::Species` (0 cerf, 1 lapin, 2 sanglier)", () => {
    expect(SPECIES_LABELS).toEqual(["cerf", "lapin", "sanglier"]);
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

describe("hKeyAction", () => {
  it("bascule la chasse quand la sélection est une bête (espèce ≥ 0)", () => {
    expect(hKeyAction(0)).toBe("hunt"); // cerf
    expect(hKeyAction(1)).toBe("hunt"); // lapin
    expect(hKeyAction(2)).toBe("hunt"); // sanglier
  });

  it("retombe sur l'outil Récolter sans bête sélectionnée", () => {
    expect(hKeyAction(-1)).toBe("harvest");
  });
});

describe("moodIcon", () => {
  it("donne une icône selon les mêmes seuils que `moodLabel` (App.tsx)", () => {
    expect(moodIcon(85)).toBe("☺");
    expect(moodIcon(70)).toBe("☺"); // seuil inclus
    expect(moodIcon(50)).toBe("─");
    expect(moodIcon(20)).toBe("─"); // seuil bas inclus dans le neutre
    expect(moodIcon(19)).toBe("☹");
    expect(moodIcon(0)).toBe("☹");
  });
});

describe("formatEventTime", () => {
  it("formate « jour J hh:mm » depuis un tick absolu", () => {
    const ticksPerDay = 14400;
    expect(formatEventTime(0, ticksPerDay)).toBe("jour 1 00:00");
    expect(formatEventTime(ticksPerDay / 2, ticksPerDay)).toBe("jour 1 12:00");
    // Un tick multiple de `ticksPerDay` bascule au jour suivant, à minuit.
    expect(formatEventTime(ticksPerDay, ticksPerDay)).toBe("jour 2 00:00");
    // Jour 4 (1-indexé), 06:00 : trois jours pleins puis un quart de jour.
    expect(formatEventTime(ticksPerDay * 3 + ticksPerDay / 4, ticksPerDay)).toBe("jour 4 06:00");
  });
});

describe("eventCategory", () => {
  it("classe les menaces : raid, morts au combat, à terre, sanglier, raid en approche, maladie", () => {
    expect(eventCategory(1)).toBe("threat"); // Raid
    expect(eventCategory(2)).toBe("threat"); // ColonistDied
    expect(eventCategory(3)).toBe("threat"); // RaiderDied
    expect(eventCategory(8)).toBe("threat"); // ColonistDowned
    expect(eventCategory(19)).toBe("threat"); // BoarAttacks
    expect(eventCategory(21)).toBe("threat"); // RaidIncoming
    expect(eventCategory(23)).toBe("threat"); // Illness
  });

  it("classe le reste en colonie", () => {
    // WandererJoined, ColonistBreak, LevelUp, RaiderLeft, ColonistRescued,
    // ColonistTended, les deux caravanes, FastForwarded, les deux artisanats,
    // saison, gelée, harde et chasse, largage, coup de froid et canicule :
    // rien de tout ça n'est une menace.
    for (const kind of [4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 25]) {
      expect(eventCategory(kind)).toBe("colony");
    }
  });
});

describe("formatWealth", () => {
  it("groupe par milliers avec un espace", () => {
    expect(formatWealth(0)).toBe("0");
    expect(formatWealth(240)).toBe("240");
    expect(formatWealth(1240)).toBe("1 240");
    expect(formatWealth(1234567)).toBe("1 234 567");
  });

  it("tronque les décimales et refuse les valeurs négatives", () => {
    expect(formatWealth(12.9)).toBe("12");
    expect(formatWealth(-50)).toBe("0");
  });
});

describe("sickHoursRemaining", () => {
  it("convertit les ticks de `pawn_sick` en heures, arrondies au-dessus", () => {
    expect(sickHoursRemaining(0)).toBe(0);
    expect(sickHoursRemaining(600)).toBe(1);
    expect(sickHoursRemaining(601)).toBe(2);
    expect(sickHoursRemaining(1200)).toBe(2);
  });

  it("ne renvoie jamais un nombre négatif", () => {
    expect(sickHoursRemaining(-100)).toBe(0);
  });
});

describe("TRAIT_LABELS et TRAIT_HINTS", () => {
  it("couvrent les douze traits de `sim::Trait`", () => {
    expect(TRAIT_LABELS.length).toBe(12);
    expect(TRAIT_HINTS.length).toBe(12);
    expect(TRAIT_LABELS).toEqual([
      "travailleur",
      "paresseux",
      "optimiste",
      "pessimiste",
      "bagarreur",
      "lâche",
      "gourmand",
      "ascète",
      "noctambule",
      "robuste",
      "fragile",
      "sociable",
    ]);
  });

  it("donne une phrase non vide par trait, dans le même ordre que les libellés", () => {
    for (const hint of TRAIT_HINTS) {
      expect(typeof hint).toBe("string");
      expect(hint.length).toBeGreaterThan(0);
    }
  });
});

describe("visibleStock", () => {
  it("affiche toujours les cinq genres de base, même à 0", () => {
    const stored = new Array(ITEM_NAMES.length).fill(0);
    const lines = visibleStock(stored);
    expect(lines.length).toBe(BASE_STOCK_COUNT);
    expect(lines).toEqual([
      { name: "bois", count: 0 },
      { name: "pierre", count: 0 },
      { name: "baies", count: 0 },
      { name: "légumes", count: 0 },
      { name: "repas", count: 0 },
    ]);
  });

  it("n'affiche un autre genre que si son stock est positif", () => {
    const stored = new Array(ITEM_NAMES.length).fill(0);
    stored[5] = 3; // cadavres
    stored[13] = 2; // cuir
    stored[14] = 1; // tuniques
    const names = visibleStock(stored).map((l) => l.name);
    expect(names).toEqual(["bois", "pierre", "baies", "légumes", "repas", "cadavres", "cuir", "tuniques"]);
  });

  it("porte les manteaux comme n'importe quel genre au-delà des cinq de base", () => {
    // Régression : les habits (ajoutés après les armes et la faune) doivent
    // suivre la même règle que le reste, pas rester affichés à 0.
    const stored = new Array(ITEM_NAMES.length).fill(0);
    const withoutCoat = visibleStock(stored).map((l) => l.name);
    expect(withoutCoat).not.toContain("manteaux");
    stored[15] = 1; // manteaux
    const withCoat = visibleStock(stored).map((l) => l.name);
    expect(withCoat).toContain("manteaux");
  });

  it("traite un stock manquant (indice hors tableau) comme 0", () => {
    const lines = visibleStock([9, 8, 7, 6, 5]); // les cinq genres de base seulement
    expect(lines.length).toBe(BASE_STOCK_COUNT);
    expect(lines[0]).toEqual({ name: "bois", count: 9 });
  });
});
