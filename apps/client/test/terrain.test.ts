/**
 * Fonctions pures de `render/terrain.ts` : pas de sim, pas de rendu, juste du
 * texte pour le HUD et le panneau du colon.
 */

import { describe, expect, it } from "vitest";

import {
  ANIMAL_FLAG,
  APPAREL_NAMES,
  BASE_STOCK_COUNT,
  BUILD_KIND,
  clampCraftTarget,
  DIFFICULTY_LABELS,
  eventCategory,
  eventLabel,
  FACTION,
  FEATURE,
  formatEventTime,
  formatInjury,
  formatTemperature,
  formatTraderLeaves,
  formatWealth,
  freshnessLevel,
  freshnessPercent,
  hKeyAction,
  ITEM_NAMES,
  JOB_LABELS,
  moodIcon,
  SEASON_LABELS,
  sickHoursRemaining,
  SLAUGHTER_HINT,
  SPECIES_LABELS,
  TAME_HINT,
  TRAIT_HINTS,
  TRAIT_LABELS,
  visibleStock,
  WEAPON_NAMES,
  WEATHER_LABELS,
  WORK_LABELS,
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

  it("annonce l'arrivée du marchand, `arg` étant son id", () => {
    // Contrat avec `sim::EventKind` 26 (voir AGENTS.md, `crates/sim/src/trade.rs`).
    expect(eventLabel(26, 9, { 9: "Zara" })).toBe("Zara, un marchand, est arrivé");
    expect(eventLabel(26, 9)).toBe("Un marchand est arrivé");
  });

  it("annonce le marchand furieux, `arg` étant son id", () => {
    // Contrat avec `sim::EventKind` 27.
    expect(eventLabel(27, 9, { 9: "Zara" })).toBe("Zara le marchand est furieux");
    expect(eventLabel(27, 9)).toBe("Le marchand est furieux");
  });

  it("annonce un troc conclu, `arg` étant le genre acheté et non un id", () => {
    // Contrat avec `sim::EventKind` 28 : `arg` suit `ItemKind`.
    expect(eventLabel(28, 12)).toBe("Troc conclu : viande");
    expect(eventLabel(28, 6, { 6: "Zara" })).toBe("Troc conclu : gourdins"); // un nom connu ne doit pas s'y glisser
  });

  it("annonce la mort du marchand, `arg` étant son id", () => {
    // Contrat avec `sim::EventKind` 29.
    expect(eventLabel(29, 9, { 9: "Zara" })).toBe("Zara le marchand est mort");
    expect(eventLabel(29, 9)).toBe("Le marchand est mort");
  });

  it("annonce une inhumation, sans dépendre de `arg` ni d'un nom connu", () => {
    // Contrat avec `sim::EventKind::Buried` (30) : `arg` vaut toujours 0, pas un id.
    expect(eventLabel(30, 0)).toBe("Un mort a été enterré");
    expect(eventLabel(30, 0, { 0: "Alice" })).toBe("Un mort a été enterré");
  });

  it("nomme la technologie acquise, `arg` étant son numéro et non un id", () => {
    // Contrat avec `sim::EventKind::ResearchDone` (31) : `arg` suit `sim::research::Tech`.
    expect(eventLabel(31, 0)).toBe("Agriculture : recherche terminée");
    expect(eventLabel(31, 4)).toBe("Maçonnerie : recherche terminée");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(31, 0, { 0: "Alice" })).toBe("Agriculture : recherche terminée");
  });

  it("nomme le colon d'une dispute ou d'une rixe, `arg` étant le plus petit des deux ids", () => {
    // Contrat avec `sim::EventKind` 32 (dispute) et 33 (rixe), `crates/sim/src/social.rs`.
    expect(eventLabel(32, 3, { 3: "Alice" })).toBe("Alice s'est disputé avec un camarade");
    expect(eventLabel(32, 5)).toBe("Un colon s'est disputé avec un camarade");
    expect(eventLabel(33, 3, { 3: "Alice" })).toBe("Alice s'est battu avec un camarade");
    expect(eventLabel(33, 5)).toBe("Un colon s'est battu avec un camarade");
  });

  it("nomme le colon qui perd un ami, `arg` étant l'id du survivant", () => {
    // Contrat avec `sim::EventKind::FriendLost` (34).
    expect(eventLabel(34, 3, { 3: "Alice" })).toBe("Alice a perdu un ami");
    expect(eventLabel(34, 5)).toBe("Un colon a perdu un ami");
  });

  it("nomme la victime d'un piège à pointes, `arg` étant son id", () => {
    // Contrat avec `sim::EventKind::TrapSprung` (35) : pillard, marchand
    // hostile ou bête.
    expect(eventLabel(35, 9, { 9: "Rex" })).toBe("Rex s'est pris dans un piège");
    expect(eventLabel(35, 9, { 9: "Zara" })).toBe("Zara s'est pris dans un piège");
    // Sans nom connu (id absent du dictionnaire), phrase générique.
    expect(eventLabel(35, 9)).toBe("Une bête s'est prise dans un piège");
  });

  it("distingue une bête (nommée d'après son espèce) d'un pillard ou d'un marchand", () => {
    // Une bête porte son espèce comme « nom » (`animals::Species::label`,
    // capitalisé) : ce n'est pas un prénom, `eventLabel` ne doit pas
    // l'afficher comme tel.
    expect(eventLabel(35, 4, { 4: "Cerf" })).toBe("Une bête s'est prise dans un piège");
    expect(eventLabel(35, 4, { 4: "Lapin" })).toBe("Une bête s'est prise dans un piège");
    expect(eventLabel(35, 4, { 4: "Sanglier" })).toBe("Une bête s'est prise dans un piège");
  });

  it("nomme l'espèce apprivoisée, née ou abattue, `arg` suivant `sim::animals::Species` et non un id", () => {
    // Contrat avec `sim::EventKind` 38 (Tamed), 39 (AnimalBorn), 40 (Slaughtered) :
    // lapin, cerf et sanglier sont masculins, aucun accord à porter.
    expect(eventLabel(38, 0)).toBe("Un cerf a été apprivoisé");
    expect(eventLabel(38, 1)).toBe("Un lapin a été apprivoisé");
    expect(eventLabel(38, 2)).toBe("Un sanglier a été apprivoisé");
    expect(eventLabel(39, 0)).toBe("Un cerf est né");
    expect(eventLabel(39, 1)).toBe("Un lapin est né");
    expect(eventLabel(40, 2)).toBe("Un sanglier a été abattu");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(38, 0, { 0: "Alice" })).toBe("Un cerf a été apprivoisé");
  });
});

describe("eventLabel : factions et réputation", () => {
  it("accorde le raid repoussé selon le genre de la tribu qui le menait", () => {
    // `arg` = la tribu (`sim::EventKind::RaidRepelled`), jamais un id de pawn.
    expect(eventLabel(41, 0)).toBe("Le raid du Clan des Cendres a été repoussé");
    expect(eventLabel(41, 1)).toBe("Le raid de la Fraternité du Fer a été repoussé");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(41, 0, { 0: "Alice" })).toBe("Le raid du Clan des Cendres a été repoussé");
  });

  it("accorde le tribut offert selon le genre de la faction qui l'a reçu", () => {
    // `arg` = la faction (`sim::EventKind::Gift`), les trois genres possibles.
    expect(eventLabel(42, 0)).toBe("Tribut offert au Clan des Cendres");
    expect(eventLabel(42, 1)).toBe("Tribut offert à la Fraternité du Fer");
    expect(eventLabel(42, 2)).toBe("Tribut offert à la Guilde des Colporteurs");
  });

  it("nomme la faction et son palier de relation quand `goodwill` est fourni", () => {
    // `arg` = la faction (`sim::EventKind::RelationChanged`).
    expect(eventLabel(43, 0, undefined, [-60, 0, 0])).toBe("Clan des Cendres : relation hostile");
    expect(eventLabel(43, 1, undefined, [0, 60, 0])).toBe("Fraternité du Fer : relation allié");
    expect(eventLabel(43, 2, undefined, [0, 0, 0])).toBe("Guilde des Colporteurs : relation méfiant");
  });

  it("retombe sur une phrase neutre sans `goodwill`, et sur une faction inconnue", () => {
    expect(eventLabel(43, 0)).toBe("Clan des Cendres : relation changée");
    expect(eventLabel(43, 9)).toBe("Relation changée");
    expect(eventLabel(41, 9)).toBe("Un raid a été repoussé");
    expect(eventLabel(42, 9)).toBe("Un tribut a été offert");
  });
});

describe("eventCategory : élevage", () => {
  it("classe l'apprivoisement, la naissance et l'abattage en colonie, jamais en menace", () => {
    expect(eventCategory(38)).toBe("colony");
    expect(eventCategory(39)).toBe("colony");
    expect(eventCategory(40)).toBe("colony");
  });
});

describe("BUILD_KIND et FEATURE : établi de recherche", () => {
  it("ajoute l'établi de recherche à la suite de la tombe, sans renuméroter le reste", () => {
    expect(BUILD_KIND.ResearchBench).toBe(7);
    expect(FEATURE.ResearchBench).toBe(16);
    expect(BUILD_KIND.Grave).toBe(6);
    expect(FEATURE.GraveFilled).toBe(15);
  });
});

describe("BUILD_KIND et FEATURE : piège à pointes", () => {
  it("ajoute le piège à la suite de l'établi de recherche, sans renuméroter le reste", () => {
    expect(BUILD_KIND.SpikeTrap).toBe(8);
    expect(FEATURE.SpikeTrap).toBe(17);
    expect(FEATURE.SpikeTrapSprung).toBe(18);
    expect(BUILD_KIND.ResearchBench).toBe(7);
  });
});

describe("WORK_LABELS", () => {
  it("porte Rechercher en dernier (`sim::WorkType::Research` = 6)", () => {
    expect(WORK_LABELS[6]).toBe("Rechercher");
    expect(WORK_LABELS.length).toBe(7);
  });
});

describe("FACTION", () => {
  it("suit `pawn::Faction` (0 colonie, 1 pillard, 2 bête, 3 marchand)", () => {
    expect(FACTION).toEqual({ Colony: 0, Raider: 1, Animal: 2, Trader: 3 });
  });
});

describe("formatTraderLeaves", () => {
  it("affiche « moins d'une heure » sous 600 ticks", () => {
    expect(formatTraderLeaves(0)).toBe("moins d'une heure");
    expect(formatTraderLeaves(599)).toBe("moins d'une heure");
  });

  it("arrondit à l'heure la plus proche au-delà", () => {
    expect(formatTraderLeaves(600)).toBe("1 h");
    expect(formatTraderLeaves(900)).toBe("2 h"); // 1,5 h arrondi au-dessus
    expect(formatTraderLeaves(14400)).toBe("24 h");
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
  it("classe les menaces : raid, morts au combat, à terre, sanglier, raid en approche, maladie, incendie", () => {
    expect(eventCategory(1)).toBe("threat"); // Raid
    expect(eventCategory(2)).toBe("threat"); // ColonistDied
    expect(eventCategory(3)).toBe("threat"); // RaiderDied
    expect(eventCategory(8)).toBe("threat"); // ColonistDowned
    expect(eventCategory(19)).toBe("threat"); // BoarAttacks
    expect(eventCategory(21)).toBe("threat"); // RaidIncoming
    expect(eventCategory(23)).toBe("threat"); // Illness
    expect(eventCategory(35)).toBe("threat"); // TrapSprung
    expect(eventCategory(36)).toBe("threat"); // FireStarted
    expect(eventCategory(37)).toBe("threat"); // FireOut
  });

  it("classe le raid repoussé et le changement de relation en menace, le tribut en colonie", () => {
    expect(eventCategory(41)).toBe("threat"); // RaidRepelled
    expect(eventCategory(42)).toBe("colony"); // Gift
    expect(eventCategory(43)).toBe("threat"); // RelationChanged
  });

  it("classe le reste en colonie", () => {
    // WandererJoined, ColonistBreak, LevelUp, RaiderLeft, ColonistRescued,
    // ColonistTended, les deux caravanes, FastForwarded, les deux artisanats,
    // saison, gelée, harde et chasse, largage, coup de froid et canicule,
    // les quatre événements du marchand, une inhumation, une recherche
    // acquise, dispute, rixe et ami perdu : rien de tout ça n'est une menace.
    for (const kind of [
      4, 5, 6, 7, 9, 10, 11, 12, 13, 14, 15, 16, 17, 18, 20, 22, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34,
    ]) {
      expect(eventCategory(kind)).toBe("colony");
    }
  });
});

describe("JOB_LABELS", () => {
  it("nomme le job Bury (code 23) « enterre »", () => {
    // Contrat avec `pawn::Job::code()` : un colon qui porte un cadavre vers
    // une tombe vide.
    expect(JOB_LABELS[23]).toBe("enterre");
  });

  it("nomme le job Chat (code 25) « bavarde »", () => {
    // Contrat avec `pawn::Job::code()` (`crates/sim/src/social.rs`) : deux
    // colons désœuvrés et voisins qui s'arrêtent pour discuter.
    expect(JOB_LABELS[25]).toBe("bavarde");
  });

  it("nomme le job RearmTrap (code 26) « réarme un piège »", () => {
    // Contrat avec `pawn::Job::code()` : un colon libre qui remet en état un
    // piège à pointes déclenché.
    expect(JOB_LABELS[26]).toBe("réarme un piège");
  });

  it("nomme le job FightFire (code 27) « combat le feu »", () => {
    // Contrat avec `pawn::Job::code()` (`crates/sim/src/fire.rs`) : un colon
    // qui combat un incendie proche.
    expect(JOB_LABELS[27]).toBe("combat le feu");
  });

  it("nomme les jobs Tame (code 28) et Slaughter (code 29), `crates/sim/src/livestock.rs`", () => {
    expect(JOB_LABELS[28]).toBe("apprivoise");
    expect(JOB_LABELS[29]).toBe("abat");
  });
});

describe("ANIMAL_FLAG", () => {
  it("suit les drapeaux du tampon `animals` (`sim::livestock`)", () => {
    expect(ANIMAL_FLAG).toEqual({ Hunted: 1, TameMarked: 2, SlaughterMarked: 4 });
  });

  it("teste chaque drapeau au bit, jamais sur la valeur entière", () => {
    // La chasse seule valait 1 avant l'élevage ; ce n'est plus vrai dès
    // qu'un autre drapeau se combine (contrat `AGENTS.md`, tampon `animals`).
    const huntedAndTameMarked = ANIMAL_FLAG.Hunted | ANIMAL_FLAG.TameMarked;
    expect((huntedAndTameMarked & ANIMAL_FLAG.Hunted) !== 0).toBe(true);
    const tameOnly = ANIMAL_FLAG.TameMarked;
    expect((tameOnly & ANIMAL_FLAG.Hunted) !== 0).toBe(false);
    expect((ANIMAL_FLAG.SlaughterMarked & ANIMAL_FLAG.Hunted) !== 0).toBe(false);
  });
});

describe("TAME_HINT et SLAUGHTER_HINT", () => {
  it("donnent une infobulle non vide pour les boutons Apprivoiser et Abattre", () => {
    expect(TAME_HINT.length).toBeGreaterThan(0);
    expect(SLAUGHTER_HINT.length).toBeGreaterThan(0);
  });
});

describe("eventLabel : incendies", () => {
  it("nomme la cause de l'événement FireStarted (36), `arg` n'étant pas un id", () => {
    expect(eventLabel(36, 0)).toBe("La foudre a mis le feu");
    expect(eventLabel(36, 1)).toBe("Le feu de camp a mis le feu alentour");
    expect(eventLabel(36, 2)).toBe("Un incendie a été allumé");
    // Un nom connu ne doit pas s'y glisser : ce n'est pas un id de pawn.
    expect(eventLabel(36, 0, { 0: "Alice" })).toBe("La foudre a mis le feu");
  });

  it("annonce l'extinction (FireOut, 37), `arg` étant le nombre de cases brûlées", () => {
    expect(eventLabel(37, 1)).toBe("Incendie éteint : 1 case brûlée");
    expect(eventLabel(37, 3)).toBe("Incendie éteint : 3 cases brûlées");
  });
});

describe("freshnessPercent et freshnessLevel", () => {
  it("convertit le ‰ restant d'`item_freshness` en pourcentage arrondi", () => {
    expect(freshnessPercent(1000)).toBe(100);
    expect(freshnessPercent(720)).toBe(72);
    expect(freshnessPercent(0)).toBe(0);
  });

  it("classe la fraîcheur : verte au-dessus de 50 %, orange de 20 à 50, rouge en dessous", () => {
    expect(freshnessLevel(1000)).toBe("good");
    expect(freshnessLevel(500)).toBe("good"); // seuil inclus
    expect(freshnessLevel(499)).toBe("warn");
    expect(freshnessLevel(200)).toBe("warn"); // seuil bas inclus
    expect(freshnessLevel(199)).toBe("bad");
    expect(freshnessLevel(0)).toBe("bad");
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
