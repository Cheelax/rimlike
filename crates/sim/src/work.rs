//! Types de travail et priorités par colon.
//!
//! Un colon range chaque type de travail de 1 (le plus urgent) à 4 (à faire
//! quand il n'y a rien d'autre), 0 signifiant « ne fait pas ça ». L'ordre du
//! tableau `ALL` départage deux travaux de même priorité : c'est l'ordre
//! historique de la phase 2c.

use serde::{Deserialize, Serialize};

/// Nombre de types de travail. Contrat avec `terrain.ts` (`WORK_LABELS`).
pub const WORK_TYPES: usize = 6;

/// Famille de travail réglable par le joueur. Les valeurs sont un contrat
/// avec `apps/client/src/render/terrain.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum WorkType {
    Build = 0,
    Deliver = 1,
    Cook = 2,
    /// Travail désigné par le joueur : couper, miner, récolter.
    Designated = 3,
    Farm = 4,
    Haul = 5,
}

impl WorkType {
    /// Dans l'ordre des valeurs : c'est aussi l'ordre de départage.
    pub const ALL: [WorkType; WORK_TYPES] = [
        WorkType::Build,
        WorkType::Deliver,
        WorkType::Cook,
        WorkType::Designated,
        WorkType::Farm,
        WorkType::Haul,
    ];

    pub fn from_u8(v: u8) -> WorkType {
        match v {
            0 => WorkType::Build,
            1 => WorkType::Deliver,
            2 => WorkType::Cook,
            3 => WorkType::Designated,
            4 => WorkType::Farm,
            _ => WorkType::Haul,
        }
    }
}
