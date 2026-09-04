//! Chantiers : un plan posé par le joueur, alimenté en matériaux par les
//! livreurs, puis bâti par un constructeur.

use serde::{Deserialize, Serialize};

use crate::items::ItemKind;
use crate::map::{Feature, Map, Terrain};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum BuildKind {
    Wall = 0,
    Door = 1,
    Floor = 2,
    Bed = 3,
}

impl BuildKind {
    pub fn from_u8(v: u8) -> BuildKind {
        match v {
            0 => BuildKind::Wall,
            1 => BuildKind::Door,
            2 => BuildKind::Floor,
            _ => BuildKind::Bed,
        }
    }

    pub fn work_ticks(self) -> u32 {
        match self {
            BuildKind::Wall => 300,
            BuildKind::Door => 400,
            BuildKind::Floor => 150,
            BuildKind::Bed => 500,
        }
    }

    /// Matériaux nécessaires.
    pub fn cost(self) -> u32 {
        match self {
            BuildKind::Wall => 5,
            BuildKind::Door => 10,
            BuildKind::Floor => 3,
            BuildKind::Bed => 12,
        }
    }

    /// Le constructeur doit rester à côté : la case devient infranchissable.
    pub fn adjacent_only(self) -> bool {
        matches!(self, BuildKind::Wall)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Material {
    Wood = 0,
    Stone = 1,
}

impl Material {
    pub fn from_u8(v: u8) -> Material {
        if v == 1 {
            Material::Stone
        } else {
            Material::Wood
        }
    }

    pub fn item_kind(self) -> ItemKind {
        match self {
            Material::Wood => ItemKind::Wood,
            Material::Stone => ItemKind::Stone,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Blueprint {
    pub id: u32,
    pub x: u32,
    pub y: u32,
    pub kind: BuildKind,
    pub material: Material,
    pub delivered: u32,
    pub needed: u32,
    pub progress: u32,
    pub reserved_by: Option<u32>,
}

impl Blueprint {
    pub fn ready(&self) -> bool {
        self.delivered >= self.needed
    }

    pub fn missing(&self) -> u32 {
        self.needed.saturating_sub(self.delivered)
    }
}

/// Le plan est-il posable ici ? Ne tient pas compte des autres plans.
pub fn can_place(map: &Map, kind: BuildKind, x: u32, y: u32) -> bool {
    let t = map.get(x, y);
    if matches!(t, Terrain::DeepWater | Terrain::ShallowWater) {
        return false;
    }
    let f = map.feature(x, y);
    match kind {
        BuildKind::Floor => {
            matches!(
                f,
                Feature::None | Feature::DoorWood | Feature::DoorStone | Feature::Bed
            ) && !matches!(t, Terrain::WoodFloor | Terrain::StoneFloor)
        }
        _ => f == Feature::None,
    }
}

/// Élément produit par un chantier terminé (`None` pour un sol).
pub fn result_feature(kind: BuildKind, material: Material) -> Option<Feature> {
    match (kind, material) {
        (BuildKind::Wall, Material::Wood) => Some(Feature::WallWood),
        (BuildKind::Wall, Material::Stone) => Some(Feature::WallStone),
        (BuildKind::Door, Material::Wood) => Some(Feature::DoorWood),
        (BuildKind::Door, Material::Stone) => Some(Feature::DoorStone),
        (BuildKind::Bed, _) => Some(Feature::Bed),
        (BuildKind::Floor, _) => None,
    }
}

pub fn result_terrain(material: Material) -> Terrain {
    match material {
        Material::Wood => Terrain::WoodFloor,
        Material::Stone => Terrain::StoneFloor,
    }
}
