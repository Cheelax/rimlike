/** Contrat avec `crates/sim/src/map.rs` : index = valeur `Terrain`. */
export const TERRAIN = {
  DeepWater: 0,
  ShallowWater: 1,
  Sand: 2,
  Grass: 3,
  Dirt: 4,
  Gravel: 5,
  Rock: 6,
  Tree: 7,
} as const;

export const TERRAIN_COLORS: readonly number[] = [
  0x1f4f8f, // eau profonde
  0x3d7fc0, // eau peu profonde
  0xd8c88a, // sable
  0x6aa84f, // herbe
  0x9a7b4f, // terre
  0x9b9b93, // gravier
  0x6e6e6e, // roche
  0x4e8a3a, // sol sous les arbres
];
