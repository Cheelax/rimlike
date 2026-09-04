//! Culture et cuisine : constantes et plants en croissance.

use serde::{Deserialize, Serialize};

use crate::TICKS_PER_DAY;

/// Durée du semis.
pub const SOW_TICKS: u32 = 90;
/// Durée de la récolte d'un plant.
pub const HARVEST_TICKS: u32 = 120;
/// Croissance complète : un jour et demi.
pub const GROW_TICKS: u32 = TICKS_PER_DAY * 3 / 2;
/// Légumes par plant récolté.
pub const CROP_YIELD: u32 = 6;
/// Durée de cuisson d'un repas.
pub const COOK_TICKS: u32 = 180;
/// Unités de nourriture crue par repas.
pub const RAW_PER_MEAL: u32 = 5;
/// On cuisine tant que la colonie a moins de repas que cela.
pub const MEALS_TARGET: u32 = 10;

/// Un plant en terre. L'élément de la case dit s'il est mûr ; ici, l'avancement.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Crop {
    pub x: u32,
    pub y: u32,
    pub growth: u32,
}
