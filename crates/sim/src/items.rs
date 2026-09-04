use serde::{Deserialize, Serialize};

use crate::TICKS_PER_DAY;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum ItemKind {
    Wood = 0,
    Stone = 1,
    Berries = 2,
    Vegetables = 3,
    Meal = 4,
    /// Dépouille d'un pawn mort. Ne se transporte pas, se décompose.
    Corpse = 5,
}

impl ItemKind {
    pub const COUNT: usize = 6;

    pub fn from_u8(v: u8) -> ItemKind {
        match v {
            0 => ItemKind::Wood,
            1 => ItemKind::Stone,
            2 => ItemKind::Berries,
            3 => ItemKind::Vegetables,
            4 => ItemKind::Meal,
            _ => ItemKind::Corpse,
        }
    }

    /// Nutrition d'une unité, en millionièmes de besoin. `None` : pas comestible.
    pub fn nutrition(self) -> Option<u32> {
        match self {
            ItemKind::Berries => Some(200_000),
            ItemKind::Vegetables => Some(150_000),
            ItemKind::Meal => Some(900_000),
            ItemKind::Wood | ItemKind::Stone | ItemKind::Corpse => None,
        }
    }

    pub fn is_food(self) -> bool {
        self.nutrition().is_some()
    }

    /// Un colon peut-il ranger cette pile ? Les cadavres restent où ils tombent.
    pub fn haulable(self) -> bool {
        self != ItemKind::Corpse
    }

    /// Nourriture crue, transformable en repas au feu de camp.
    pub fn is_raw_food(self) -> bool {
        matches!(self, ItemKind::Berries | ItemKind::Vegetables)
    }

    /// Ordre de préférence quand un colon a faim : plus petit = meilleur.
    pub fn food_rank(self) -> u32 {
        match self {
            ItemKind::Meal => 0,
            ItemKind::Berries => 1,
            ItemKind::Vegetables => 2,
            ItemKind::Wood | ItemKind::Stone | ItemKind::Corpse => u32::MAX,
        }
    }

    /// Effet sur l'humeur du dernier repas : repas cuisiné bon, légumes crus mauvais.
    pub fn meal_quality(self) -> i8 {
        match self {
            ItemKind::Meal => 1,
            ItemKind::Vegetables => -1,
            _ => 0,
        }
    }

    /// Unités mangées au maximum en un repas.
    pub fn max_per_meal(self) -> u32 {
        match self {
            ItemKind::Meal => 1,
            _ => 5,
        }
    }

    /// Durée de conservation en ticks. `None` : ne se gâte pas.
    pub fn shelf_life(self) -> Option<u32> {
        match self {
            ItemKind::Berries => Some(TICKS_PER_DAY * 3),
            ItemKind::Vegetables => Some(TICKS_PER_DAY * 4),
            ItemKind::Meal => Some(TICKS_PER_DAY * 2),
            ItemKind::Corpse => Some(TICKS_PER_DAY * 3),
            ItemKind::Wood | ItemKind::Stone => None,
        }
    }
}

/// Taille maximale d'une pile.
pub const STACK_MAX: u32 = 75;

/// Une pile d'objets posée au sol. Une pile portée par un colon n'est plus
/// dans la liste : elle vit dans `Pawn::carrying`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemStack {
    pub id: u32,
    pub kind: ItemKind,
    pub count: u32,
    pub x: u32,
    pub y: u32,
    /// Colon qui a réservé cette pile (transport, repas, cuisine, livraison).
    pub reserved_by: Option<u32>,
    /// Tick à partir duquel la pile est perdue. `u64::MAX` si elle ne se gâte pas.
    pub spoil_at: u64,
}
