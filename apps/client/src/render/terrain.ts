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
} as const;

export const BUILD_KIND = { Wall: 0, Door: 1, Floor: 2, Bed: 3 } as const;
export const MATERIAL = { Wood: 0, Stone: 1 } as const;
export const MATERIAL_NAMES = ["bois", "pierre"] as const;
/** Couleurs des matériaux construits : [bois, pierre]. */
export const WALL_COLORS: readonly number[] = [0x8a5a2b, 0x7d7d7d];
export const DOOR_COLORS: readonly number[] = [0xa06a30, 0x8d8d8d];
export const BLUEPRINT_STRIDE = 8;

export const ZONE = { None: 0, Stockpile: 1 } as const;
export const DESIGNATION = { None: 0, Chop: 1, Mine: 2, Harvest: 3 } as const;

export const ITEM_NAMES = ["bois", "pierre", "baies"] as const;
export const ITEM_COLORS: readonly number[] = [0x9c6b3c, 0x8d8d8d, 0xc9304a];

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
] as const;
