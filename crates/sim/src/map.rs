use serde::{Deserialize, Serialize};

use crate::noise;

/// Terrain d'une case. Stocké en `u8` pour que le client lise le tableau
/// directement en mémoire, sans copie ni décodage.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Terrain {
    Water = 0,
    Sand = 1,
    Grass = 2,
    Rock = 3,
    Tree = 4,
}

impl Terrain {
    pub fn from_u8(v: u8) -> Terrain {
        match v {
            0 => Terrain::Water,
            1 => Terrain::Sand,
            2 => Terrain::Grass,
            3 => Terrain::Rock,
            _ => Terrain::Tree,
        }
    }

    pub fn walkable(self) -> bool {
        matches!(self, Terrain::Sand | Terrain::Grass)
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
        let mut tiles = Vec::with_capacity((width * height) as usize);
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let h = noise::fbm2(seed, x, y, 16);
                let t = if h < 96 {
                    Terrain::Water
                } else if h < 112 {
                    Terrain::Sand
                } else if h < 190 {
                    if noise::scatter(seed, x, y) % 100 < 12 {
                        Terrain::Tree
                    } else {
                        Terrain::Grass
                    }
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

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
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
}
