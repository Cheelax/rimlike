/** Contrat avec `pawn::Faction` (0 colonie, 1 pillard, 2 bête sauvage). */
export const FACTION = { Colony: 0, Raider: 1, Animal: 2 } as const;

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
  0x1f4f8f, // eau profonde
  0x3d7fc0, // eau peu profonde
  0xd8c88a, // sable
  0x6aa84f, // herbe
  0x9a7b4f, // terre
  0x9b9b93, // gravier
  0xb08a55, // plancher
  0x8f8a80, // dallage
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
} as const;

export const BUILD_KIND = { Wall: 0, Door: 1, Floor: 2, Bed: 3, Campfire: 4, CraftingSpot: 5 } as const;
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
] as const;
export const ITEM_COLORS: readonly number[] = [
  0x9c6b3c, 0x8d8d8d, 0xc9304a, 0x5aa02c, 0xf0c070, 0x5c4a3a,
  0x5a3d22 /* gourdin : bois sombre */, 0x8a8f94 /* épieu : gris acier */, 0xd9b273 /* arc : bois clair */,
  0x8a6a4a /* dépouille de cerf : brun clair */,
  0xbfbfbf /* dépouille de lapin : gris clair */,
  0x4a3a2a /* dépouille de sanglier : brun sombre */,
  0x8a2020 /* viande : rouge sombre */,
  0xc9a06a /* cuir : brun clair */,
];

/**
 * Contrat avec `items::ItemKind` (armes seulement, 6 gourdin, 7 épieu, 8 arc) :
 * noms au singulier, pour l'arme équipée d'un colon (panneau) et l'événement 14
 * (`WeaponCrafted`). Les trois sont masculins : pas d'accord à porter.
 */
export const WEAPON_NAMES: Readonly<Record<number, string>> = { 6: "gourdin", 7: "épieu", 8: "arc" };

/** Borne d'affichage d'un objectif de fabrication (le sim, lui, accepte n'importe quel entier). */
export function clampCraftTarget(n: number): number {
  if (!Number.isFinite(n)) return 0;
  return Math.max(0, Math.min(20, Math.trunc(n)));
}

/** Contrat avec `sim::WorkType` : index = valeur de l'enum. */
export const WORK_LABELS = ["Construire", "Livrer", "Cuisiner", "Désignations", "Cultiver", "Ranger"] as const;
/** Contrat avec `sim-wasm::PRIORITY_STRIDE` : [id, p0..p5] par colon. */
export const PRIORITY_STRIDE = 7;
/** Contrat avec `sim-wasm::SKILL_STRIDE` : [id, (niveau, xp)×6] par colon. */
export const SKILL_STRIDE = 13;
/** Expérience nécessaire pour passer du niveau `level` au suivant (`sim::work::xp_to_next`). */
export function xpToNext(level: number): number {
  return 1000 * (level + 1);
}

/** Contrat avec `sim-wasm::HEALTH_STRIDE` : [id, sang, conscience %, blessures] par pawn. */
export const HEALTH_STRIDE = 4;
/** Contrat avec `sim::health::BodyPart` : index = valeur de l'enum. */
export const BODY_PART_LABELS = ["tête", "torse", "bras gauche", "bras droit", "jambe gauche", "jambe droite"] as const;

/** Contrat avec `sim-wasm::ANIMAL_STRIDE` : `[id, espèce, chassée]` par bête vivante. */
export const ANIMAL_STRIDE = 3;

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
] as const;

/** Contrat avec `sim::EventKind` et `sim-wasm::EVENT_STRIDE`. */
export const EVENT_STRIDE = 4;

/**
 * Texte de notification pour un événement du sim. `arg` est l'id d'un pawn
 * pour les genres 7 à 10 : `names` (voir `worker/protocol.ts`) permet d'y
 * mettre un nom plutôt qu'un id ; à défaut, un « Un colon » générique — ces
 * événements ne concernent que des colons côté sim.
 */
export function eventLabel(kind: number, arg: number, names?: Record<number, string>): string {
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
    default:
      return "";
  }
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
