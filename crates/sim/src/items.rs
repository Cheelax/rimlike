use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum ItemKind {
    Wood = 0,
    Stone = 1,
    Berries = 2,
}

impl ItemKind {
    pub const COUNT: usize = 3;

    pub fn from_u8(v: u8) -> ItemKind {
        match v {
            0 => ItemKind::Wood,
            1 => ItemKind::Stone,
            _ => ItemKind::Berries,
        }
    }

    pub fn is_food(self) -> bool {
        matches!(self, ItemKind::Berries)
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
    /// Colon qui a réservé cette pile (transport ou repas).
    pub reserved_by: Option<u32>,
}
