import type { TileClimate } from "@rimlike/world";
import { factionDative, factionGenitive, factionName, relationLabel } from "../factions";
import { TECHS } from "../research";

/** Contrat avec `pawn::Faction` (0 colonie, 1 pillard, 2 bête sauvage, 3 marchand). */
export const FACTION = { Colony: 0, Raider: 1, Animal: 2, Trader: 3 } as const;

/** Contrat avec `sim::storyteller::Difficulty` : index = valeur de l'enum. */
export const DIFFICULTY = { Peaceful: 0, Easy: 1, Normal: 2, Hard: 3 } as const;
export const DIFFICULTY_LABELS = ["Paisible", "Facile", "Normal", "Difficile"] as const;

/** Contrat avec `sim::storyteller::RaidKind` : index = valeur de l'enum. */
export const RAID_KIND_LABELS = ["charge", "archers", "siège"] as const;

/** Contrat avec `animals::Species` : index = valeur de l'enum. */
export const SPECIES_LABELS = ["cerf", "lapin", "sanglier"] as const;

/** Contrats avec `crates/sim/src/map.rs` et `items.rs` : index = valeur de l'enum. */
export const TERRAIN = {
  DeepWater: 0,
  ShallowWater: 1,
  Sand: 2,
  Grass: 3,
  Dirt: 4,
  Gravel: 5,
  WoodFloor: 6,
  StoneFloor: 7,
} as const;

export const TERRAIN_COLORS: readonly number[] = [
  0x365761, // eau profonde
  0x688581, // eau peu profonde
  0xbaac7e, // sable
  0x78834d, // herbe
  0x887254, // terre
  0x8b8c7c, // gravier
  0x66543e, // plancher
  0x6b6e64, // dallage
];

export const FEATURE = {
  None: 0,
  Tree: 1,
  Rock: 2,
  Bush: 3,
  BushUnripe: 4,
  WallWood: 5,
  WallStone: 6,
  DoorWood: 7,
  DoorStone: 8,
  Bed: 9,
  Crop: 10,
  CropRipe: 11,
  Campfire: 12,
  /** Poste de fabrication d'armes (`crates/sim/src/craft.rs`) : infranchissable, comme le feu. */
  CraftingSpot: 13,
  /** Tombe vide (`crates/sim/src/build.rs`) : franchissable, une case, matériau pierre imposé. */
  Grave: 14,
  /** Tombe occupée : posée par le job `Bury` (code 23), jamais par une commande directe. */
  GraveFilled: 15,
  /** Établi de recherche (`crates/sim/src/research.rs`) : infranchissable, comme le poste de fabrication. */
  ResearchBench: 16,
  /** Piège à pointes armé (`crates/sim/src/build.rs`) : franchissable, une case, matériau bois imposé. */
  SpikeTrap: 17,
  /** Piège déclenché, inoffensif : posé par le job `RearmTrap` (code 26) le temps qu'un colon le réarme. */
  SpikeTrapSprung: 18,
} as const;

export const BUILD_KIND = {
  Wall: 0,
  Door: 1,
  Floor: 2,
  Bed: 3,
  Campfire: 4,
  CraftingSpot: 5,
  Grave: 6,
  ResearchBench: 7,
  SpikeTrap: 8,
} as const;
export const MATERIAL = { Wood: 0, Stone: 1 } as const;
export const MATERIAL_NAMES = ["bois", "pierre"] as const;
/** Couleurs des matériaux construits : [bois, pierre]. */
export const WALL_COLORS: readonly number[] = [0x8a5a2b, 0x7d7d7d];
export const DOOR_COLORS: readonly number[] = [0xa06a30, 0x8d8d8d];
export const BLUEPRINT_STRIDE = 8;

export const ZONE = { None: 0, Stockpile: 1, Growing: 2 } as const;
export const DESIGNATION = { None: 0, Chop: 1, Mine: 2, Harvest: 3 } as const;

export const ITEM_NAMES = [
  "bois",
  "pierre",
  "baies",
  "légumes",
  "repas",
  "cadavres",
  "gourdins",
  "épieux",
  "arcs",
  "dépouilles de cerf",
  "dépouilles de lapin",
  "dépouilles de sanglier",
  "viande",
  "cuir",
  "tuniques",
  "manteaux",
] as const;
/**
 * Cinq genres de base (bois, pierre, baies, légumes, repas), toujours
 * présents dans une colonie neuve : le HUD stock les affiche même à 0. Tout
 * le reste (armes, dépouilles, viande, cuir, habits, cadavres) n'apparaît que
 * s'il y en a en stock (voir `visibleStock`).
 */
export const BASE_STOCK_COUNT = 5;

/** Une ligne du HUD stock : un genre (`ITEM_NAMES`) et sa quantité. */
export interface StockLine {
  readonly name: string;
  readonly count: number;
}

/**
 * Ligne du HUD stock à afficher pour `stored` (`sim-wasm::stored_totals`,
 * indexé par `ItemKind`) : les cinq genres de base toujours, tout autre genre
 * seulement si son stock est positif. Une seule règle, pure, plutôt qu'une
 * liste à maintenir à la main à chaque genre ajouté (armes, dépouilles,
 * viande, cuir, puis habits : voir `docs/PLAN.md`, journal des décisions).
 */
export function visibleStock(stored: readonly number[]): StockLine[] {
  const lines: StockLine[] = [];
  for (let i = 0; i < ITEM_NAMES.length; i++) {
    const count = stored[i] ?? 0;
    if (i < BASE_STOCK_COUNT || count > 0) lines.push({ name: ITEM_NAMES[i], count });
  }
  return lines;
}

export const ITEM_COLORS: readonly number[] = [
  0x9c6b3c, 0x8d8d8d, 0xc9304a, 0x5aa02c, 0xf0c070, 0x5c4a3a,
  0x5a3d22 /* gourdin : bois sombre */, 0x8a8f94 /* épieu : gris acier */, 0xd9b273 /* arc : bois clair */,
  0x8a6a4a /* dépouille de cerf : brun clair */,
  0xbfbfbf /* dépouille de lapin : gris clair */,
  0x4a3a2a /* dépouille de sanglier : brun sombre */,
  0x8a2020 /* viande : rouge sombre */,
  0xc9a06a /* cuir : brun clair */,
  0x99917a /* tunique : lin */,
  0x6c7461 /* manteau : laine */,
];

/**
 * Contrat avec `items::ItemKind` (armes seulement, 6 gourdin, 7 épieu, 8 arc) :
 * noms au singulier, pour l'arme équipée d'un colon (panneau) et l'événement 14
 * (`WeaponCrafted`). Les trois sont masculins : pas d'accord à porter.
 */
export const WEAPON_NAMES: Readonly<Record<number, string>> = { 6: "gourdin", 7: "épieu", 8: "arc" };

/**
 * Contrat avec `items::ItemKind` (habits seulement, 14 tunique, 15 manteau) :
 * noms au singulier, pour l'habit porté d'un colon (ligne « Habit : » du
 * panneau) et l'événement 20 (`ItemCrafted`, voir `eventLabel`).
 */
export const APPAREL_NAMES: Readonly<Record<number, string>> = { 14: "tunique", 15: "manteau" };

/** Vrai pour un habit féminin (« une tunique ») : accord de `eventLabel` (20). */
const APPAREL_FEMININE: Readonly<Record<number, boolean>> = { 14: true, 15: false };

/**
 * Contrat avec `sim::Trait` (`crates/sim/src/traits.rs`) : index = valeur de
 * l'enum, deux tirages non contradictoires par colon à la création (voyageurs
 * compris, jamais les pillards ni les bêtes). Pour la ligne « Traits : » du
 * panneau du colon et l'infobulle enrichie de `ColonistBar`.
 */
export const TRAIT_LABELS = [
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
] as const;

/**
 * Une phrase d'infobulle par trait (`title`), reprise des constantes d'effet
 * de `traits.rs` : c'est le seul endroit à modifier pour rééquilibrer un
 * trait, donc le seul que ces phrases doivent suivre.
 */
export const TRAIT_HINTS = [
  "travaille 15 % plus vite",
  "travaille 15 % plus lentement",
  "humeur en hausse permanente",
  "humeur en baisse permanente",
  "frappe plus fort au corps à corps, vise moins bien à l'arc",
  "ne se défend jamais seul ; humeur en baisse tant qu'un pillard traîne sur la carte",
  "a plus vite faim, mais un repas cuisiné lui remonte plus le moral",
  "dormir au sol ou manger cru ne lui coûte rien à l'humeur",
  "travaille plus vite la nuit, moins vite le jour",
  "encaisse moins de dégâts",
  "encaisse plus de dégâts",
  "humeur en hausse avec la compagnie, s'effondre livré à lui-même",
] as const;

/** Borne d'affichage d'un objectif de fabrication (le sim, lui, accepte n'importe quel entier). */
export function clampCraftTarget(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(20, Math.trunc(n)));
}

/** Contrat avec `sim::WorkType` : index = valeur de l'enum. */
export const WORK_LABELS = ["Construire", "Livrer", "Cuisiner", "Désignations", "Cultiver", "Ranger", "Rechercher"] as const;
/** Contrat avec `sim-wasm::PRIORITY_STRIDE` : [id, p0..p6] par colon. */
export const PRIORITY_STRIDE = 8;
/** Contrat avec `sim-wasm::SKILL_STRIDE` : [id, (niveau, xp)×7] par colon. */
export const SKILL_STRIDE = 15;
/** Expérience nécessaire pour passer du niveau `level` au suivant (`sim::work::xp_to_next`). */
export function xpToNext(level: number): number {
  return 1000 * (level + 1);
}

/** Contrat avec `sim-wasm::HEALTH_STRIDE` : [id, sang, conscience %, blessures] par pawn. */
export const HEALTH_STRIDE = 4;
/** Contrat avec `sim::health::BodyPart` : index = valeur de l'enum. */
export const BODY_PART_LABELS = ["tête", "torse", "bras gauche", "bras droit", "jambe gauche", "jambe droite"] as const;

/**
 * Contrat avec `sim-wasm::ANIMAL_STRIDE` : `[id, espèce, drapeaux]` par bête
 * vivante, sauvage **et** apprivoisée (la faction du tampon `pawns` les
 * départage : 2 sauvage, 0 colonie). La troisième valeur est un champ de
 * drapeaux (`ANIMAL_FLAG`), pas un simple booléen : toujours tester au bit,
 * jamais `!== 0` (la chasse seule valait 1, ce n'est plus vrai).
 */
export const ANIMAL_STRIDE = 3;

/** Drapeaux du tampon `animals` (troisième valeur), contrat avec `sim::livestock`. */
export const ANIMAL_FLAG = { Hunted: 1, TameMarked: 2, SlaughterMarked: 4 } as const;

/** Infobulle du bouton Apprivoiser (panneau d'une bête sauvage sélectionnée). */
export const TAME_HINT = "5 baies ou légumes ; lapin facile, cerf moyen, sanglier difficile";

/** Infobulle du bouton Abattre (panneau d'une bête de la colonie sélectionnée). */
export const SLAUGHTER_HINT = "un colon l'abat, la dépouille se dépèce au poste";

/**
 * PV maximum par espèce (`animals::Species::max_hp`), pour convertir le PV
 * brut du tampon `pawns` en pourcentage : contrairement aux colons et aux
 * pillards (`pawn::HP_MAX` = 1000), chaque espèce a son propre plafond.
 */
export const SPECIES_MAX_HP = [600, 150, 800] as const;

/**
 * Texte d'une ligne du panneau du colon pour une blessure du tampon
 * `pawn_injuries` : `[partie, sévérité, saignement, pansée]`. La sévérité va
 * de 0 à 1000 (`sim::health::SEVERITY_MAX`), affichée en pourcentage.
 */
export function formatInjury(part: number, severity: number, bleeding: number, tended: number): string {
  const label = BODY_PART_LABELS[part] ?? "?";
  const pct = Math.round(severity / 10);
  const state = bleeding > 0 ? "saigne" : tended !== 0 ? "pansée" : "stable";
  return `${label} · ${pct} % · ${state}`;
}

/** Contrat avec `sim::Weather` : index = valeur de l'enum (3 : la pluie qui gèle). */
export const WEATHER_LABELS = ["Clair", "Pluie", "Orage", "Neige"] as const;

/** Contrat avec `sim::climate::Season` : index = valeur de l'enum. */
export const SEASON_LABELS = ["printemps", "été", "automne", "hiver"] as const;

/**
 * Saison avec son article défini, pour un texte du genre « Le printemps
 * commence » : élidé (« L'été », « L'automne », « L'hiver ») devant les trois
 * saisons qui commencent par une voyelle, plein (« Le printemps ») pour la
 * seule qui n'en commence pas.
 */
const SEASON_WITH_ARTICLE = ["Le printemps", "L'été", "L'automne", "L'hiver"] as const;

/** « 12 °C » à partir de dixièmes de degré, arrondi à l'entier. */
export function formatTemperature(tenths: number): string {
  return `${Math.round(tenths / 10)} °C`;
}

/**
 * Pourcentage de fraîcheur affiché par la pastille du HUD stock, à partir du
 * ‰ restant d'une pile (`sim-wasm::item_freshness`, `frame.foodFreshness`).
 */
export function freshnessPercent(perMille: number): number {
  return Math.round(perMille / 10);
}

/**
 * Couleur de la pastille de fraîcheur du HUD stock : verte au-dessus de 50 %,
 * orange de 20 à 50 %, rouge en dessous (mission « tombes et fraîcheur »).
 * `perMille` est la valeur brute de `item_freshness` (‰ restant), jamais déjà
 * convertie : la fonction fait la conversion elle-même pour ne jamais désaccorder
 * le seuil de son unité.
 */
export function freshnessLevel(perMille: number): "good" | "warn" | "bad" {
  // Comparé au ‰ brut, pas au pourcentage arrondi : un arrondi ferait basculer
  // une valeur comme 499 ‰ (49,9 %) dans « good » au lieu de « warn ».
  if (perMille >= 500) return "good";
  if (perMille >= 200) return "warn";
  return "bad";
}

/**
 * « 1 240 » : un entier groupé par milliers avec un espace, pour la richesse
 * de la colonie affichée dans le HUD (`sim-wasm::wealth`). Espace normal (pas
 * insécable) : un simple `replace`, pas `toLocaleString` dont le séparateur
 * dépend de l'environnement d'exécution.
 */
export function formatWealth(n: number): string {
  const truncated = Math.max(0, Math.trunc(n));
  return truncated.toString().replace(/\B(?=(\d{3})+(?!\d))/g, " ");
}

/**
 * Heures de maladie restantes, à partir des ticks de `sim-wasm::pawn_sick`
 * (600 ticks = 1 heure de jeu, `TICKS_PER_DAY` valant 24 h). Arrondi au-dessus
 * pour ne jamais afficher « 0 h » tant qu'il reste des ticks à purger.
 */
export function sickHoursRemaining(ticks: number): number {
  return ticks > 0 ? Math.ceil(ticks / 600) : 0;
}

/**
 * Temps avant que le marchand ne reprenne la route, en français, à partir des
 * ticks de `sim-wasm::trader_leaves_in` (600 ticks = 1 heure de jeu). Arrondi
 * à l'heure la plus proche, sauf sous une heure entière où l'arrondi donnerait
 * « 0 h » : « moins d'une heure » à la place.
 */
export function formatTraderLeaves(ticks: number): string {
  if (ticks < 600) return "moins d'une heure";
  const hours = Math.round(ticks / 600);
  return `${hours} h`;
}

export const JOB_LABELS = [
  "inactif",
  "se déplace",
  "coupe du bois",
  "mine",
  "récolte",
  "transporte",
  "mange",
  "dort",
  "livre des matériaux",
  "construit",
  "sème",
  "cuisine",
  "attaque",
  "fuit",
  "craque",
  "à terre",
  "secourt",
  "soigne",
  "fabrique",
  "s'équipe",
  "chasse",
  "dépèce",
  "attend",
  "enterre",
  "recherche",
  "bavarde",
  "réarme un piège",
  "combat le feu",
  "apprivoise",
  "abat",
] as const;

/** Contrat avec `sim::EventKind` et `sim-wasm::EVENT_STRIDE`. */
export const EVENT_STRIDE = 4;

/**
 * Texte de notification pour un événement du sim. `arg` est l'id d'un pawn
 * pour les genres 7 à 10 : `names` (voir `worker/protocol.ts`) permet d'y
 * mettre un nom plutôt qu'un id ; à défaut, un « Un colon » générique — ces
 * événements ne concernent que des colons côté sim. `goodwill` (copie de
 * `frame.goodwill`, voir `apps/client/src/factions.ts`) sert au genre 43 pour
 * afficher le palier atteint ; sans lui, une phrase neutre.
 */
export function eventLabel(
  kind: number,
  arg: number,
  names?: Record<number, string>,
  goodwill?: ArrayLike<number>,
): string {
  const who = names?.[arg] || "Un colon";
  switch (kind) {
    case 1:
      return `Raid ! ${arg} pillard(s) approchent`;
    case 2:
      return "Un colon est mort";
    case 3:
      return "Un pillard est mort";
    case 4:
      return "Un pillard a fui";
    case 5:
      return "Un voyageur rejoint la colonie";
    case 6:
      return "Un colon craque";
    case 7:
      return `${who} monte en niveau`;
    case 8:
      return `${who} est à terre`;
    case 9:
      return `${who} a été secouru`;
    case 10:
      return `${who} a été soigné`;
    case 11:
      return `Une caravane est partie (${arg} colon${arg > 1 ? "s" : ""})`;
    case 12:
      return `Une caravane est arrivée (${arg} colon${arg > 1 ? "s" : ""})`;
    case 13:
      // `arg` = jours entiers écoulés pendant la colonie gelée (§11.6 de
      // docs/protocol.md), jamais un id de pawn : pas de `names` ici.
      if (arg <= 0) return "Moins d'un jour a passé pendant votre absence";
      return `${arg} jour${arg > 1 ? "s" : ""} ${arg > 1 ? "ont" : "a"} passé pendant votre absence`;
    case 14: {
      // `arg` = le genre d'arme fabriquée (`sim::ItemKind`), pas un id de pawn.
      const name = WEAPON_NAMES[arg] ?? "objet";
      return `Un ${name} a été fabriqué`;
    }
    case 15:
      // `arg` = la saison qui commence (`sim::climate::Season`).
      return `${SEASON_WITH_ARTICLE[arg] ?? "La saison"} commence`;
    case 16:
      // `arg` = le jour de l'année de la première gelée, pas un id de pawn.
      return "Premières gelées";
    case 17:
      // `arg` = le nombre de bêtes arrivées (`sim::EventKind::AnimalsArrived`).
      return `Une harde de ${arg} bête${arg > 1 ? "s" : ""} est arrivée`;
    case 18: {
      // `arg` = l'espèce chassée (`sim::animals::Species`), pas un id de pawn.
      const species = SPECIES_LABELS[arg] ?? "bête";
      return `Un ${species} a été chassé`;
    }
    case 19:
      // `arg` = l'id du sanglier qui charge (`sim::EventKind::BoarAttacks`), pas affiché.
      return "Un sanglier charge !";
    case 20: {
      // `arg` = le genre d'habit fabriqué (`sim::ItemKind`), pas un id de pawn.
      // Les armes gardent l'événement 14 : celui-ci ne voit jamais 6, 7 ou 8.
      const name = APPAREL_NAMES[arg];
      if (!name) return "Un habit a été fabriqué";
      return APPAREL_FEMININE[arg] ? `Une ${name} a été fabriquée` : `Un ${name} a été fabriqué`;
    }
    case 21: {
      // `arg` = la manière d'aborder la colonie (`sim::storyteller::RaidKind`),
      // pas un id de pawn. Le siège a sa propre phrase : plus parlant que
      // « Raid en approche : siège », et `Raid` (1) garde le compte des pillards.
      const kind = arg === 2 ? "les pillards campent avant d'attaquer" : (RAID_KIND_LABELS[arg] ?? "charge");
      return `Raid en approche : ${kind}`;
    }
    case 22:
      // `arg` = le nombre de piles larguées (`sim::EventKind::SupplyDrop`).
      return `Un largage de ${arg} pile${arg > 1 ? "s" : ""} est tombé près de la colonie`;
    case 23:
      // `arg` = l'id du colon tombé malade (`sim::EventKind::Illness`).
      return `${who} est malade`;
    case 24:
      // `arg` = l'écart en dixièmes de degré (`sim::EventKind::ColdSnap`), positif.
      return `Coup de froid : −${Math.round(arg / 10)} °C pendant un jour`;
    case 25:
      // `arg` = l'écart en dixièmes de degré (`sim::EventKind::Heatwave`), positif.
      return `Canicule : +${Math.round(arg / 10)} °C pendant un jour`;
    case 26: {
      // `arg` = l'id du marchand qui arrive (`sim::EventKind`, voir AGENTS.md).
      const name = names?.[arg];
      return name ? `${name}, un marchand, est arrivé` : "Un marchand est arrivé";
    }
    case 27:
      return traderLabel(arg, names, "est furieux");
    case 28: {
      // `arg` = le genre acheté (`sim::ItemKind`), pas un id de pawn.
      return `Troc conclu : ${ITEM_NAMES[arg] ?? "objet"}`;
    }
    case 29:
      return traderLabel(arg, names, "est mort");
    case 30:
      // `arg` vaut toujours 0 (`sim::EventKind::Buried`) : ce n'est pas un id
      // de pawn, l'inhumation ne nomme personne.
      return "Un mort a été enterré";
    case 31: {
      // `arg` = la technologie acquise (`sim::research::Tech`), pas un id de pawn.
      const name = TECHS[arg]?.name ?? "Une technologie";
      return `${name} : recherche terminée`;
    }
    case 32:
      // `arg` = le plus petit des deux ids de colons disputés (`sim::EventKind::Quarrel`,
      // `crates/sim/src/social.rs`).
      return `${who} s'est disputé avec un camarade`;
    case 33:
      // `arg` = le plus petit des deux ids de colons (`sim::EventKind::Brawl`).
      return `${who} s'est battu avec un camarade`;
    case 34:
      // `arg` = l'id du colon survivant qui perd un ami (`sim::EventKind::FriendLost`).
      return `${who} a perdu un ami`;
    case 35: {
      // `arg` = l'id de la victime (`sim::EventKind::TrapSprung`) : pillard,
      // marchand hostile ou bête. Une bête porte son espèce comme « nom »
      // (`animals::Species::label`, tiré nulle part au hasard) : on ne l'affiche
      // jamais comme si c'était un prénom.
      const name = names?.[arg];
      if (name && !ANIMAL_LABELS.has(name)) return `${name} s'est pris dans un piège`;
      return "Une bête s'est prise dans un piège";
    }
    case 36:
      // `arg` = la cause (`sim::EventKind::FireStarted`, `crates/sim/src/fire.rs`) :
      // 0 foudre, 1 feu de camp, 2 ordre du joueur (`Command::Ignite`).
      return FIRE_STARTED_LABELS[arg] ?? "Un incendie a été allumé";
    case 37:
      // `arg` = le nombre de cases qui ont brûlé (`sim::EventKind::FireOut`).
      return `Incendie éteint : ${arg} case${arg > 1 ? "s" : ""} brûlée${arg > 1 ? "s" : ""}`;
    case 38: {
      // `arg` = l'espèce apprivoisée (`sim::EventKind::Tamed`), pas un id de
      // pawn. Les trois espèces sont masculines : jamais d'accord à porter.
      const species = SPECIES_LABELS[arg] ?? "bête";
      return `Un ${species} a été apprivoisé`;
    }
    case 39: {
      // `arg` = l'espèce née dans la colonie (`sim::EventKind::AnimalBorn`).
      const species = SPECIES_LABELS[arg] ?? "bête";
      return `Un ${species} est né`;
    }
    case 40: {
      // `arg` = l'espèce abattue (`sim::EventKind::Slaughtered`).
      const species = SPECIES_LABELS[arg] ?? "bête";
      return `Un ${species} a été abattu`;
    }
    case 41: {
      // `arg` = la tribu qui menait la bande repoussée (`sim::EventKind::RaidRepelled`,
      // toujours une des deux tribus : la Guilde ne mène jamais de raid).
      const genitive = factionGenitive(arg);
      return genitive ? `Le raid ${genitive} a été repoussé` : "Un raid a été repoussé";
    }
    case 42: {
      // `arg` = la faction qui a reçu le tribut (`sim::EventKind::Gift`).
      const dative = factionDative(arg);
      return dative ? `Tribut offert ${dative}` : "Un tribut a été offert";
    }
    case 43: {
      // `arg` = la faction dont la relation a franchi un seuil
      // (`sim::EventKind::RelationChanged`). Le palier courant se lit dans
      // `goodwill` au moment de l'affichage ; sans lui, une phrase neutre.
      const name = factionName(arg);
      if (!name) return "Relation changée";
      const value = goodwill?.[arg];
      return value === undefined ? `${name} : relation changée` : `${name} : relation ${relationLabel(value)}`;
    }
    default:
      return "";
  }
}

/**
 * Phrase de l'événement 36 selon sa cause (`arg`, `sim::EventKind::FireStarted`) :
 * 0 foudre (pendant un orage), 1 feu de camp (par temps chaud et sec),
 * 2 ordre du joueur (`Command::Ignite`, débogage ou outil).
 */
const FIRE_STARTED_LABELS: Readonly<Record<number, string>> = {
  0: "La foudre a mis le feu",
  1: "Le feu de camp a mis le feu alentour",
  2: "Un incendie a été allumé",
};

/**
 * Capitalisées comme `animals::Species::label` (« Cerf », « Lapin », « Sanglier »),
 * jamais tirées d'un des trois bassins de prénoms (`sim::names`) : sert à
 * `eventLabel` (35) à reconnaître une bête plutôt qu'un pillard ou un marchand.
 */
const ANIMAL_LABELS = new Set(SPECIES_LABELS.map((s) => s.charAt(0).toUpperCase() + s.slice(1)));

/**
 * « <nom> le marchand <suffixe> », ou « Le marchand <suffixe> » sans nom
 * connu (le marchand a disparu du tampon `names` avant l'événement, ou le sim
 * neuf qui vient de démarrer n'en a pas encore lu). Partagé par les
 * événements 27 (furieux) et 29 (mort) : seul le suffixe change.
 */
function traderLabel(id: number, names: Record<number, string> | undefined, suffix: string): string {
  const name = names?.[id];
  return name ? `${name} le marchand ${suffix}` : `Le marchand ${suffix}`;
}

/**
 * Ce que fait la touche H, qui portait « Récolter » avant la chasse : bascule
 * la chasse si la sélection est une bête (`pawn_species` ≥ 0), sinon choisit
 * l'outil Récolter comme toujours. `selectedSpecies` : -1 si rien d'animal
 * n'est sélectionné (id inconnu ou pawn non animal).
 */
export type HKeyAction = "hunt" | "harvest";
export function hKeyAction(selectedSpecies: number): HKeyAction {
  return selectedSpecies >= 0 ? "hunt" : "harvest";
}

/**
 * Climat d'une case, en français : « N °C en moyenne, ± A °C ». Convertit les
 * dixièmes de degré de `climateForTile` (`@rimlike/world`) en degrés entiers,
 * la même granularité que l'affichage de la température de la case
 * (`selectedTile.temperature.toFixed(1)` juste au-dessus). Purement informatif
 * côté client : c'est le serveur monde qui calcule le `climate` réellement
 * diffusé dans `start` (`docs/protocol.md` §11.6), jamais ce composant.
 */
export function formatClimate(climate: TileClimate): string {
  const base = Math.round(climate.baseTemperature / 10);
  const amplitude = Math.round(climate.amplitude / 10);
  return `${base} °C en moyenne, ± ${amplitude} °C`;
}

/**
 * Icône d'humeur textuelle pour la barre des colons (`App.tsx`), sur les
 * mêmes seuils que `moodLabel` (70 heureux, 20 au bord de la crise) : les deux
 * paliers intermédiaires (bien, morose) partagent un tiret neutre, une
 * pastille n'ayant pas la place d'un mot.
 */
export function moodIcon(mood: number): "☺" | "─" | "☹" {
  if (mood >= 70) return "☺";
  if (mood < 20) return "☹";
  return "─";
}

/**
 * Horodatage d'une entrée du Journal des événements : « jour J hh:mm » depuis
 * un tick absolu (`sim-wasm::EVENT_STRIDE` : le tick de l'événement, pas celui
 * courant), sur le même calcul que l'horloge du HUD. Jour 1-indexé, comme
 * `stats.day`.
 */
export function formatEventTime(tick: number, ticksPerDay: number): string {
  const day = Math.floor(tick / ticksPerDay) + 1;
  const timeOfDay = (tick % ticksPerDay) / ticksPerDay;
  const minutes = Math.floor(timeOfDay * 24 * 60);
  const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
  const mm = String(minutes % 60).padStart(2, "0");
  return `jour ${day} ${hh}:${mm}`;
}

/** Catégorie du filtre du Journal des événements (`App.tsx`). */
export type EventCategory = "threat" | "colony";

/**
 * Classe un genre d'événement (`sim::EventKind`) pour le filtre du Journal :
 * menace (raid, mort au combat, colon à terre, charge de sanglier, relation
 * qui bascule) ou colonie (tout le reste : arrivées, artisanat, saisons,
 * caravanes, tribut...).
 */
export function eventCategory(kind: number): EventCategory {
  switch (kind) {
    case 1: // Raid
    case 2: // ColonistDied
    case 3: // RaiderDied
    case 8: // ColonistDowned
    case 19: // BoarAttacks
    case 21: // RaidIncoming
    case 23: // Illness
    case 35: // TrapSprung
    case 36: // FireStarted
    case 37: // FireOut
    case 41: // RaidRepelled
    case 43: // RelationChanged
      return "threat";
    default:
      return "colony";
  }
}
