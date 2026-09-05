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
    /// Gourdin : du bois taillé. Arme de mêlée d'entrée de gamme.
    Club = 6,
    /// Épieu : bois et pierre. Frappe plus fort qu'un gourdin.
    Spear = 7,
    /// Arc : tire à distance (voir `combat::BOW_RANGE`), médiocre en mêlée.
    Bow = 8,
}

impl ItemKind {
    pub const COUNT: usize = 9;

    pub fn from_u8(v: u8) -> ItemKind {
        match v {
            0 => ItemKind::Wood,
            1 => ItemKind::Stone,
            2 => ItemKind::Berries,
            3 => ItemKind::Vegetables,
            4 => ItemKind::Meal,
            6 => ItemKind::Club,
            7 => ItemKind::Spear,
            8 => ItemKind::Bow,
            _ => ItemKind::Corpse,
        }
    }

    /// Nutrition d'une unité, en millionièmes de besoin. `None` : pas comestible.
    pub fn nutrition(self) -> Option<u32> {
        match self {
            ItemKind::Berries => Some(200_000),
            ItemKind::Vegetables => Some(150_000),
            ItemKind::Meal => Some(900_000),
            ItemKind::Wood
            | ItemKind::Stone
            | ItemKind::Corpse
            | ItemKind::Club
            | ItemKind::Spear
            | ItemKind::Bow => None,
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
            ItemKind::Wood
            | ItemKind::Stone
            | ItemKind::Corpse
            | ItemKind::Club
            | ItemKind::Spear
            | ItemKind::Bow => u32::MAX,
        }
    }

    /// Une arme se fabrique, se range, s'équipe — et se porte à l'unité, même
    /// si une pile posée au sol en empile plusieurs comme n'importe quoi d'autre.
    pub fn is_weapon(self) -> bool {
        matches!(self, ItemKind::Club | ItemKind::Spear | ItemKind::Bow)
    }

    /// Qualité d'une arme : plus grand = meilleur. C'est l'ordre dans lequel un
    /// colon s'équipe (`Bow > Spear > Club`) ; 0 pour ce qui n'est pas une arme.
    pub fn weapon_rank(self) -> u32 {
        match self {
            ItemKind::Club => 1,
            ItemKind::Spear => 2,
            ItemKind::Bow => 3,
            _ => 0,
        }
    }

    /// Dégâts de mêlée en pourcentage de ceux des poings nus. L'arc est une
    /// mauvaise massue : on ne se bat pas au corps à corps avec un arc.
    pub fn melee_percent(self) -> u32 {
        match self {
            ItemKind::Club => 130,
            ItemKind::Spear => 160,
            ItemKind::Bow => 80,
            _ => 100,
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
            ItemKind::Wood | ItemKind::Stone | ItemKind::Club | ItemKind::Spear | ItemKind::Bow => {
                None
            }
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
