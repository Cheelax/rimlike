//! Types de travail et priorités par colon.
//!
//! Un colon range chaque type de travail de 1 (le plus urgent) à 4 (à faire
//! quand il n'y a rien d'autre), 0 signifiant « ne fait pas ça ». À priorité
//! égale, c'est l'ordre du tableau `ORDER` qui départage.
//!
//! Deux tableaux, deux rôles à ne pas confondre :
//! - `ALL` suit les **valeurs** de l'énumération. C'est l'ordre des tampons du
//!   client (priorités, compétences), donc un contrat : on n'y ajoute qu'en
//!   fin.
//! - `ORDER` est l'ordre de **départage**, celui dans lequel un colon libre
//!   essaie ses travaux. Il n'engage rien côté client et se réarrange au gré
//!   de l'équilibrage : la recherche, arrivée en dernier dans l'énumération,
//!   s'y glisse juste après la fabrication.

use serde::{Deserialize, Serialize};

/// Nombre de types de travail. Contrat avec `terrain.ts` (`WORK_LABELS`).
pub const WORK_TYPES: usize = 7;

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
    /// Recherche à l'établi (voir `research`). **Ajouté en fin
    /// d'énumération** : les priorités et les compétences sont indexées par
    /// cette valeur, et le client lit les tampons dans cet ordre.
    Research = 6,
}

impl WorkType {
    /// Dans l'ordre des valeurs : c'est l'ordre des tampons du client.
    pub const ALL: [WorkType; WORK_TYPES] = [
        WorkType::Build,
        WorkType::Deliver,
        WorkType::Cook,
        WorkType::Designated,
        WorkType::Farm,
        WorkType::Haul,
        WorkType::Research,
    ];

    /// Ordre d'essai d'un colon libre, à priorité égale : c'est celui de la
    /// phase 2c, la recherche insérée après la fabrication (`WorkType::Build`
    /// couvre chantiers **et** poste de fabrication) et avant le rangement,
    /// qui reste le travail de dernier recours. `ORDER` contient exactement
    /// les mêmes valeurs qu'`ALL` : voir le test `l_ordre_est_une_permutation`.
    pub const ORDER: [WorkType; WORK_TYPES] = [
        WorkType::Build,
        WorkType::Deliver,
        WorkType::Cook,
        WorkType::Designated,
        WorkType::Farm,
        WorkType::Research,
        WorkType::Haul,
    ];

    pub fn from_u8(v: u8) -> WorkType {
        match v {
            0 => WorkType::Build,
            1 => WorkType::Deliver,
            2 => WorkType::Cook,
            3 => WorkType::Designated,
            4 => WorkType::Farm,
            6 => WorkType::Research,
            _ => WorkType::Haul,
        }
    }
}

/// Compétence d'un colon dans un type de travail : niveau atteint et
/// expérience accumulée vers le niveau suivant. `Deliver` et `Haul` n'ont pas
/// de barre de progression (le transport est instantané une fois la case
/// atteinte) : leurs compétences existent dans le tableau mais ne gagnent
/// jamais d'XP.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Skill {
    pub level: u8,
    pub xp: u32,
}

/// Niveau maximal d'une compétence.
pub const SKILL_MAX: u8 = 20;

/// Expérience nécessaire pour passer du niveau `level` au suivant.
pub fn xp_to_next(level: u8) -> u32 {
    1000 * (u32::from(level) + 1)
}

/// Vitesse de travail apportée par le niveau, en pourcentage de la nominale :
/// 60 % au niveau 0, 100 % au niveau 10, 140 % au niveau 20.
pub fn skill_percent(level: u8) -> u32 {
    60 + 4 * u32::from(level)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn l_ordre_est_une_permutation() {
        for work in WorkType::ALL {
            assert_eq!(
                WorkType::ORDER.iter().filter(|&&w| w == work).count(),
                1,
                "{work:?} manque à ORDER (ou y figure deux fois)"
            );
            assert_eq!(WorkType::from_u8(work as u8), work);
        }
    }
}
