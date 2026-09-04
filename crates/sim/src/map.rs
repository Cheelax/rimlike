use serde::{Deserialize, Serialize};

use crate::noise;

/// Terrain d'une case. Stocké en `u8` pour que le client lise le tableau
/// directement en mémoire, sans copie ni décodage. Les valeurs sont un
/// contrat avec `apps/client/src/render/terrain.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Terrain {
    DeepWater = 0,
    ShallowWater = 1,
    Sand = 2,
    Grass = 3,
    Dirt = 4,
    Gravel = 5,
    Rock = 6,
    Tree = 7,
}

impl Terrain {
    pub const COUNT: u8 = 8;

    pub fn from_u8(v: u8) -> Terrain {
        match v {
            0 => Terrain::DeepWater,
            1 => Terrain::ShallowWater,
            2 => Terrain::Sand,
            3 => Terrain::Grass,
            4 => Terrain::Dirt,
            5 => Terrain::Gravel,
            6 => Terrain::Rock,
            _ => Terrain::Tree,
        }
    }

    /// Coût de traversée en centièmes : 100 = vitesse nominale, 200 = deux
    /// fois plus lent. `None` = infranchissable.
    pub fn move_cost(self) -> Option<u32> {
        match self {
            Terrain::DeepWater | Terrain::Rock | Terrain::Tree => None,
            Terrain::ShallowWater => Some(300),
            Terrain::Sand => Some(130),
            Terrain::Grass => Some(100),
            Terrain::Dirt => Some(105),
            Terrain::Gravel => Some(115),
        }
    }

    pub fn walkable(self) -> bool {
        self.move_cost().is_some()
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Map {
    width: u32,
    height: u32,
    tiles: Vec<u8>,
}

impl Map {
    pub fn generate(seed: u64, width: u32, height: u32) -> Map {
        let moisture_seed = seed ^ 0x77AA_1234_5678_9ABC;
        let mut tiles = Vec::with_capacity((width * height) as usize);
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let elevation = noise::fbm3(seed, x, y, 32);
                let moisture = noise::fbm3(moisture_seed, x, y, 32);
                let dice = noise::scatter(seed, x, y) % 100;
                let t = if elevation < 92 {
                    Terrain::DeepWater
                } else if elevation < 104 {
                    Terrain::ShallowWater
                } else if elevation < 114 {
                    Terrain::Sand
                } else if elevation < 184 {
                    if moisture > 150 {
                        if dice < 18 {
                            Terrain::Tree
                        } else {
                            Terrain::Grass
                        }
                    } else if moisture > 96 {
                        if dice < 5 {
                            Terrain::Tree
                        } else {
                            Terrain::Grass
                        }
                    } else if dice < 1 {
                        Terrain::Tree
                    } else {
                        Terrain::Dirt
                    }
                } else if elevation < 204 {
                    Terrain::Gravel
                } else {
                    Terrain::Rock
                };
                tiles.push(t as u8);
            }
        }
        Map {
            width,
            height,
            tiles,
        }
    }

    /// Carte explicite, pour les tests.
    pub fn from_tiles(width: u32, height: u32, tiles: Vec<u8>) -> Map {
        assert_eq!(tiles.len(), (width * height) as usize);
        Map {
            width,
            height,
            tiles,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as u32) < self.width && (y as u32) < self.height
    }

    pub fn index(&self, x: u32, y: u32) -> usize {
        debug_assert!(x < self.width && y < self.height);
        (y * self.width + x) as usize
    }

    pub fn get(&self, x: u32, y: u32) -> Terrain {
        Terrain::from_u8(self.tiles[self.index(x, y)])
    }

    pub fn tiles(&self) -> &[u8] {
        &self.tiles
    }

    /// Case franchissable la plus proche de `(cx, cy)`, par anneaux croissants.
    /// L'ordre de parcours est fixe, donc le résultat est déterministe.
    pub fn nearest_walkable(&self, cx: u32, cy: u32) -> Option<(u32, u32)> {
        let max_r = self.width.max(self.height) as i32;
        for r in 0..max_r {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let x = cx as i32 + dx;
                    let y = cy as i32 + dy;
                    if self.in_bounds(x, y) && self.get(x as u32, y as u32).walkable() {
                        return Some((x as u32, y as u32));
                    }
                }
            }
        }
        None
    }
}
