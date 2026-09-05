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
} as const;

export const BUILD_KIND = { Wall: 0, Door: 1, Floor: 2, Bed: 3, Campfire: 4 } as const;
export const MATERIAL = { Wood: 0, Stone: 1 } as const;
export const MATERIAL_NAMES = ["bois", "pierre"] as const;
/** Couleurs des matériaux construits : [bois, pierre]. */
export const WALL_COLORS: readonly number[] = [0x8a5a2b, 0x7d7d7d];
export const DOOR_COLORS: readonly number[] = [0xa06a30, 0x8d8d8d];
export const BLUEPRINT_STRIDE = 8;

export const ZONE = { None: 0, Stockpile: 1, Growing: 2 } as const;
export const DESIGNATION = { None: 0, Chop: 1, Mine: 2, Harvest: 3 } as const;

export const ITEM_NAMES = ["bois", "pierre", "baies", "légumes", "repas", "cadavres"] as const;
export const ITEM_COLORS: readonly number[] = [0x9c6b3c, 0x8d8d8d, 0xc9304a, 0x5aa02c, 0xf0c070, 0x5c4a3a];

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

/** Contrat avec `sim::Weather` : index = valeur de l'enum. */
export const WEATHER_LABELS = ["Clair", "Pluie", "Orage"] as const;

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
    default:
      return "";
  }
}
