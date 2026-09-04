use serde::{Deserialize, Serialize};

use crate::noise;

/// Sol d'une case. Stocké en `u8`, lu en zéro-copie par le client. Les valeurs
/// sont un contrat avec `apps/client/src/render/terrain.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Terrain {
    DeepWater = 0,
    ShallowWater = 1,
    Sand = 2,
    Grass = 3,
    Dirt = 4,
    Gravel = 5,
    WoodFloor = 6,
    StoneFloor = 7,
}

impl Terrain {
    pub fn from_u8(v: u8) -> Terrain {
        match v {
            0 => Terrain::DeepWater,
            1 => Terrain::ShallowWater,
            2 => Terrain::Sand,
            3 => Terrain::Grass,
            4 => Terrain::Dirt,
            6 => Terrain::WoodFloor,
            7 => Terrain::StoneFloor,
            _ => Terrain::Gravel,
        }
    }

    /// Coût de traversée en centièmes : 100 = vitesse nominale. `None` = infranchissable.
    pub fn move_cost(self) -> Option<u32> {
        match self {
            Terrain::DeepWater => None,
            Terrain::ShallowWater => Some(300),
            Terrain::Sand => Some(130),
            Terrain::Grass => Some(100),
            Terrain::Dirt => Some(105),
            Terrain::Gravel => Some(115),
            Terrain::WoodFloor | Terrain::StoneFloor => Some(90),
        }
    }

    pub fn walkable(self) -> bool {
        self.move_cost().is_some()
    }
}

/// Ce qui est posé sur une case. Même contrat client que `Terrain`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Feature {
    None = 0,
    Tree = 1,
    Rock = 2,
    /// Buisson à baies mûr, récoltable.
    Bush = 3,
    /// Buisson récolté, repousse au bout d'un jour.
    BushUnripe = 4,
    WallWood = 5,
    WallStone = 6,
    DoorWood = 7,
    DoorStone = 8,
    Bed = 9,
}

impl Feature {
    pub fn from_u8(v: u8) -> Feature {
        match v {
            1 => Feature::Tree,
            2 => Feature::Rock,
            3 => Feature::Bush,
            4 => Feature::BushUnripe,
            5 => Feature::WallWood,
            6 => Feature::WallStone,
            7 => Feature::DoorWood,
            8 => Feature::DoorStone,
            9 => Feature::Bed,
            _ => Feature::None,
        }
    }

    pub fn passable(self) -> bool {
        !matches!(
            self,
            Feature::Tree | Feature::Rock | Feature::WallWood | Feature::WallStone
        )
    }

    pub fn is_wall(self) -> bool {
        matches!(self, Feature::WallWood | Feature::WallStone)
    }

    pub fn is_door(self) -> bool {
        matches!(self, Feature::DoorWood | Feature::DoorStone)
    }

    /// Multiplicateur de coût en centièmes.
    pub fn cost_mult(self) -> u32 {
        match self {
            Feature::Bush | Feature::BushUnripe => 150,
            Feature::DoorWood | Feature::DoorStone => 150,
            Feature::Bed => 200,
            _ => 100,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Zone {
    None = 0,
    Stockpile = 1,
}

impl Zone {
    pub fn from_u8(v: u8) -> Zone {
        if v == 1 { Zone::Stockpile } else { Zone::None }
    }
}

/// Ordre de travail posé par le joueur sur une case.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Designation {
    None = 0,
    Chop = 1,
    Mine = 2,
    Harvest = 3,
}

impl Designation {
    pub fn from_u8(v: u8) -> Designation {
        match v {
            1 => Designation::Chop,
            2 => Designation::Mine,
            3 => Designation::Harvest,
            _ => Designation::None,
        }
    }

    /// La désignation a-t-elle un sens sur cet élément ?
    pub fn applies_to(self, f: Feature) -> bool {
        match self {
            Designation::Chop => f == Feature::Tree,
            Designation::Mine => f == Feature::Rock,
            Designation::Harvest => f == Feature::Bush,
            Designation::None => false,
        }
    }

    /// Durée du travail en ticks.
    pub fn work_ticks(self) -> u32 {
        match self {
            Designation::Chop => 240,
            Designation::Mine => 360,
            Designation::Harvest => 120,
            Designation::None => 0,
        }
    }
}

/// Rectangle inclusif, normalisé et borné à la carte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Rect {
    pub fn tiles(self) -> impl Iterator<Item = (u32, u32)> {
        (self.y0..=self.y1).flat_map(move |y| (self.x0..=self.x1).map(move |x| (x, y)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Map {
    width: u32,
    height: u32,
    tiles: Vec<u8>,
    features: Vec<u8>,
    zones: Vec<u8>,
    designations: Vec<u8>,
    /// Incrémenté à chaque changement de sol ou d'élément : le client rebâtit ses meshes.
    version: u32,
    /// Incrémenté à chaque changement de zone ou de désignation.
    overlay_version: u32,
    designation_count: u32,
    stockpile_count: u32,
}

impl Map {
    pub fn generate(seed: u64, width: u32, height: u32) -> Map {
        let moisture_seed = seed ^ 0x77AA_1234_5678_9ABC;
        let n = (width * height) as usize;
        let mut tiles = Vec::with_capacity(n);
        let mut features = Vec::with_capacity(n);
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let elevation = noise::fbm3(seed, x, y, 32);
                let moisture = noise::fbm3(moisture_seed, x, y, 32);
                let dice = noise::scatter(seed, x, y) % 100;
                let (t, f) = if elevation < 92 {
                    (Terrain::DeepWater, Feature::None)
                } else if elevation < 104 {
                    (Terrain::ShallowWater, Feature::None)
                } else if elevation < 114 {
                    (Terrain::Sand, Feature::None)
                } else if elevation < 184 {
                    if moisture > 150 {
                        let f = if dice < 18 {
                            Feature::Tree
                        } else if dice < 21 {
                            Feature::Bush
                        } else {
                            Feature::None
                        };
                        (Terrain::Grass, f)
                    } else if moisture > 96 {
                        let f = if dice < 5 {
                            Feature::Tree
                        } else if dice < 7 {
                            Feature::Bush
                        } else {
                            Feature::None
                        };
                        (Terrain::Grass, f)
                    } else {
                        (
                            Terrain::Dirt,
                            if dice < 1 {
                                Feature::Tree
                            } else {
                                Feature::None
                            },
                        )
                    }
                } else if elevation < 204 {
                    (Terrain::Gravel, Feature::None)
                } else {
                    (Terrain::Gravel, Feature::Rock)
                };
                tiles.push(t as u8);
                features.push(f as u8);
            }
        }
        Map::from_layers(width, height, tiles, features)
    }

    /// Carte explicite (sol seul), pour les tests.
    pub fn from_tiles(width: u32, height: u32, tiles: Vec<u8>) -> Map {
        let n = tiles.len();
        Map::from_layers(width, height, tiles, vec![Feature::None as u8; n])
    }

    /// Carte explicite (sol + éléments), pour les tests.
    pub fn from_layers(width: u32, height: u32, tiles: Vec<u8>, features: Vec<u8>) -> Map {
        let n = (width * height) as usize;
        assert_eq!(tiles.len(), n);
        assert_eq!(features.len(), n);
        Map {
            width,
            height,
            tiles,
            features,
            zones: vec![0; n],
            designations: vec![0; n],
            version: 0,
            overlay_version: 0,
            designation_count: 0,
            stockpile_count: 0,
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

    pub fn feature(&self, x: u32, y: u32) -> Feature {
        Feature::from_u8(self.features[self.index(x, y)])
    }

    pub fn zone(&self, x: u32, y: u32) -> Zone {
        Zone::from_u8(self.zones[self.index(x, y)])
    }

    pub fn designation(&self, x: u32, y: u32) -> Designation {
        Designation::from_u8(self.designations[self.index(x, y)])
    }

    pub fn set_terrain(&mut self, x: u32, y: u32, t: Terrain) {
        let i = self.index(x, y);
        if self.tiles[i] != t as u8 {
            self.tiles[i] = t as u8;
            self.version += 1;
        }
    }

    pub fn set_feature(&mut self, x: u32, y: u32, f: Feature) {
        let i = self.index(x, y);
        if self.features[i] != f as u8 {
            self.features[i] = f as u8;
            self.version += 1;
        }
    }

    pub fn set_zone(&mut self, x: u32, y: u32, z: Zone) {
        let i = self.index(x, y);
        let old = Zone::from_u8(self.zones[i]);
        if old != z {
            if old == Zone::Stockpile {
                self.stockpile_count -= 1;
            }
            if z == Zone::Stockpile {
                self.stockpile_count += 1;
            }
            self.zones[i] = z as u8;
            self.overlay_version += 1;
        }
    }

    pub fn set_designation(&mut self, x: u32, y: u32, d: Designation) {
        let i = self.index(x, y);
        let old = Designation::from_u8(self.designations[i]);
        if old != d {
            if old != Designation::None {
                self.designation_count -= 1;
            }
            if d != Designation::None {
                self.designation_count += 1;
            }
            self.designations[i] = d as u8;
            self.overlay_version += 1;
        }
    }

    /// Coût de traversée combiné sol + élément. `None` = infranchissable.
    pub fn move_cost(&self, x: u32, y: u32) -> Option<u32> {
        let f = self.feature(x, y);
        if !f.passable() {
            return None;
        }
        self.get(x, y).move_cost().map(|c| c * f.cost_mult() / 100)
    }

    pub fn passable(&self, x: u32, y: u32) -> bool {
        self.move_cost(x, y).is_some()
    }

    pub fn tiles(&self) -> &[u8] {
        &self.tiles
    }

    pub fn features(&self) -> &[u8] {
        &self.features
    }

    pub fn zones(&self) -> &[u8] {
        &self.zones
    }

    pub fn designations(&self) -> &[u8] {
        &self.designations
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn overlay_version(&self) -> u32 {
        self.overlay_version
    }

    pub fn designation_count(&self) -> u32 {
        self.designation_count
    }

    pub fn stockpile_count(&self) -> u32 {
        self.stockpile_count
    }

    /// Rectangle normalisé et borné à la carte, `None` s'il est entièrement dehors.
    pub fn clamp_rect(&self, x0: i32, y0: i32, x1: i32, y1: i32) -> Option<Rect> {
        let (x0, x1) = (x0.min(x1), x0.max(x1));
        let (y0, y1) = (y0.min(y1), y0.max(y1));
        if x1 < 0 || y1 < 0 || x0 >= self.width as i32 || y0 >= self.height as i32 {
            return None;
        }
        Some(Rect {
            x0: x0.max(0) as u32,
            y0: y0.max(0) as u32,
            x1: x1.min(self.width as i32 - 1) as u32,
            y1: y1.min(self.height as i32 - 1) as u32,
        })
    }

    /// Case franchissable la plus proche de `(cx, cy)`, par anneaux croissants.
    /// L'ordre de parcours est fixe, donc le résultat est déterministe.
    pub fn nearest_passable(&self, cx: u32, cy: u32) -> Option<(u32, u32)> {
        let max_r = self.width.max(self.height) as i32;
        for r in 0..max_r {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let x = cx as i32 + dx;
                    let y = cy as i32 + dy;
                    if self.in_bounds(x, y) && self.passable(x as u32, y as u32) {
                        return Some((x as u32, y as u32));
                    }
                }
            }
        }
        None
    }
}

/// Distance de Tchebychev entre deux cases.
pub fn chebyshev(a: (u32, u32), b: (u32, u32)) -> u32 {
    a.0.abs_diff(b.0).max(a.1.abs_diff(b.1))
}
