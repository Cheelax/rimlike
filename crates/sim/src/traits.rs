//! Traits de caractère.
//!
//! Deux tirages par colon à la création (voyageurs compris, jamais les
//! pillards ni les bêtes — voir `Sim::spawn_pawn`), qui modulent l'humeur, la
//! vitesse de travail et le combat. Purement des modificateurs sur des
//! mécanismes déjà en place : aucun état nouveau hors `Pawn::traits` (et les
//! trois petits champs recopiés par tick dans le même esprit qu'`outdoor_storm`
//! — voir `Pawn::is_night`, `Pawn::enemy_present`, `Pawn::other_colonists_alive`).
//!
//! Toutes les constantes d'effet vivent ici, nommées : c'est le seul endroit
//! à modifier pour rééquilibrer un trait.

use serde::{Deserialize, Serialize};

use crate::rng::Rng;

/// Trait de caractère d'un colon. Les valeurs sont un contrat avec le client
/// (`pawn_traits`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Trait {
    /// Travaille plus vite (`INDUSTRIOUS_WORK_PERCENT`).
    Industrious = 0,
    /// Travaille moins vite (`LAZY_WORK_PERCENT`).
    Lazy = 1,
    /// Humeur en hausse permanente (`OPTIMIST_MOOD_BONUS`).
    Optimist = 2,
    /// Humeur en baisse permanente (`PESSIMIST_MOOD_MALUS`).
    Pessimist = 3,
    /// Frappe plus fort au corps à corps mais vise moins bien à l'arc
    /// (`BRAWLER_MELEE_PERCENT`, `BRAWLER_RANGED_MALUS`).
    Brawler = 4,
    /// Ne se défend jamais de lui-même (`Sim::defend_if_threatened` l'ignore ;
    /// un ordre du joueur reste possible) et son humeur baisse tant qu'un
    /// pillard traîne sur la carte (`COWARD_ENEMY_MOOD_MALUS`).
    Coward = 5,
    /// Faim qui décline plus vite (`GOURMAND_HUNGER_PERCENT`), mais un repas
    /// cuisiné vaut plus d'humeur (`GOURMAND_EXTRA_MEAL_BONUS`).
    Gourmand = 6,
    /// Dormir au sol ou manger cru ne coûte plus rien à l'humeur.
    Ascetic = 7,
    /// Travaille plus vite la nuit, moins vite le jour
    /// (`NIGHT_OWL_NIGHT_PERCENT`, `NIGHT_OWL_DAY_PERCENT`, `DAY_START_HOUR`,
    /// `DAY_END_HOUR`).
    NightOwl = 8,
    /// Encaisse moins de dégâts (`TOUGH_DAMAGE_PERCENT`).
    Tough = 9,
    /// Encaisse plus de dégâts, et saigne d'autant : la sévérité porte les
    /// deux (`FRAIL_DAMAGE_PERCENT`).
    Frail = 10,
    /// Humeur qui grimpe avec la compagnie, plafonnée
    /// (`SOCIABLE_MOOD_PER_COLONIST`, `SOCIABLE_MOOD_CAP`), qui s'effondre
    /// seul (`SOCIABLE_ALONE_MOOD_MALUS`).
    Sociable = 11,
}

/// Nombre de traits.
pub const COUNT: usize = 12;

impl Trait {
    /// Dans l'ordre des valeurs.
    pub const ALL: [Trait; COUNT] = [
        Trait::Industrious,
        Trait::Lazy,
        Trait::Optimist,
        Trait::Pessimist,
        Trait::Brawler,
        Trait::Coward,
        Trait::Gourmand,
        Trait::Ascetic,
        Trait::NightOwl,
        Trait::Tough,
        Trait::Frail,
        Trait::Sociable,
    ];

    pub fn from_u8(v: u8) -> Trait {
        match v {
            0 => Trait::Industrious,
            1 => Trait::Lazy,
            2 => Trait::Optimist,
            3 => Trait::Pessimist,
            4 => Trait::Brawler,
            5 => Trait::Coward,
            6 => Trait::Gourmand,
            7 => Trait::Ascetic,
            8 => Trait::NightOwl,
            9 => Trait::Tough,
            10 => Trait::Frail,
            _ => Trait::Sociable,
        }
    }

    /// Vrai si les deux traits ne peuvent pas cohabiter sur le même colon :
    /// deux faces opposées du même trait de caractère.
    fn conflicts_with(self, other: Trait) -> bool {
        use Trait::{
            Ascetic, Brawler, Coward, Frail, Gourmand, Industrious, Lazy, Optimist, Pessimist,
            Tough,
        };
        matches!(
            (self, other),
            (Industrious, Lazy)
                | (Lazy, Industrious)
                | (Optimist, Pessimist)
                | (Pessimist, Optimist)
                | (Brawler, Coward)
                | (Coward, Brawler)
                | (Gourmand, Ascetic)
                | (Ascetic, Gourmand)
                | (Tough, Frail)
                | (Frail, Tough)
        )
    }
}

/// Tentatives de second trait avant d'abandonner : au-delà, le colon garde un
/// seul trait plutôt que de forcer une paire cohérente à tout prix.
const SECOND_TRAIT_REROLLS: u32 = 4;

/// Tire les traits d'un nouveau colon : deux tirages `rng.below(COUNT)`
/// distincts et non contradictoires (voir `Trait::conflicts_with`). Le second
/// tirage est relancé au plus `SECOND_TRAIT_REROLLS` fois ; encore en conflit
/// après ça, le colon garde un seul trait. Appelée par `Sim::spawn_pawn` pour
/// les colons (voyageurs compris) uniquement.
pub fn roll(rng: &mut Rng) -> [Option<Trait>; 2] {
    let first = Trait::from_u8(rng.below(COUNT as u32) as u8);
    let mut second = None;
    for _ in 0..=SECOND_TRAIT_REROLLS {
        let candidate = Trait::from_u8(rng.below(COUNT as u32) as u8);
        if candidate != first && !first.conflicts_with(candidate) {
            second = Some(candidate);
            break;
        }
    }
    [Some(first), second]
}

// ------------------------------------------------------------------
// Constantes d'effet, toutes des entiers (pas de flottant : voir AGENTS.md).
// ------------------------------------------------------------------

/// Vitesse de travail (`Pawn::work_step`) d'un travailleur acharné, en
/// pourcentage.
pub const INDUSTRIOUS_WORK_PERCENT: u32 = 115;
/// Vitesse de travail d'un paresseux, en pourcentage.
pub const LAZY_WORK_PERCENT: u32 = 85;

/// Bonus d'humeur permanent d'un optimiste.
pub const OPTIMIST_MOOD_BONUS: i64 = 60_000;
/// Malus d'humeur permanent d'un pessimiste.
pub const PESSIMIST_MOOD_MALUS: i64 = 60_000;

/// Dégâts de mêlée d'un bagarreur, en pourcentage (voir `Sim::melee_strike`).
pub const BRAWLER_MELEE_PERCENT: u32 = 120;
/// Précision de tir perdue par un bagarreur, en points (voir `Sim::shoot`).
pub const BRAWLER_RANGED_MALUS: u32 = 10;

/// Malus d'humeur d'un couard tant qu'un pillard vivant traîne sur la carte
/// (`Pawn::enemy_present`, recopié par tick comme `outdoor_storm`).
pub const COWARD_ENEMY_MOOD_MALUS: i64 = 40_000;

/// Vitesse à laquelle la faim baisse chez un gourmand, en pourcentage de la
/// baisse normale (`pawn::HUNGER_DECAY`).
pub const GOURMAND_HUNGER_PERCENT: u32 = 125;
/// Bonus d'humeur supplémentaire d'un gourmand après un repas cuisiné : vient
/// s'ajouter au bonus normal de `Pawn::mood` (+40 000 devient +80 000).
pub const GOURMAND_EXTRA_MEAL_BONUS: i64 = 40_000;

/// Heures de la journée entre lesquelles `Trait::NightOwl` travaille au ralenti
/// (le jour) plutôt qu'en surrégime (la nuit). Bornes en heures sur 24.
pub const DAY_START_HOUR: u32 = 6;
pub const DAY_END_HOUR: u32 = 20;
/// Vitesse de travail d'un lève-tard la nuit, en pourcentage.
pub const NIGHT_OWL_NIGHT_PERCENT: u32 = 110;
/// Vitesse de travail d'un lève-tard le jour, en pourcentage.
pub const NIGHT_OWL_DAY_PERCENT: u32 = 90;

/// Dégâts reçus par un dur à cuire, en pourcentage (`Pawn::damage_from`). La
/// sévérité porte le saignement (`Injury::bleeding` = sévérité /
/// `health::BLEED_FRACTION`) : moduler l'une revient à moduler l'autre dans
/// les mêmes proportions, sans double compte.
pub const TOUGH_DAMAGE_PERCENT: u32 = 80;
/// Dégâts reçus par un fragile, en pourcentage.
pub const FRAIL_DAMAGE_PERCENT: u32 = 120;

/// Humeur apportée par chaque autre colon vivant sur la carte pour un
/// sociable (`Pawn::other_colonists_alive`), et son plafond.
pub const SOCIABLE_MOOD_PER_COLONIST: u32 = 30_000;
pub const SOCIABLE_MOOD_CAP: u32 = 90_000;
/// Malus d'humeur d'un sociable livré à lui-même.
pub const SOCIABLE_ALONE_MOOD_MALUS: i64 = 60_000;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn from_u8_couvre_toute_la_plage_et_revient_par_defaut_sur_sociable() {
        for t in Trait::ALL {
            assert_eq!(Trait::from_u8(t as u8), t);
        }
        assert_eq!(Trait::from_u8(255), Trait::Sociable);
    }

    #[test]
    fn les_paires_opposees_se_contredisent_dans_les_deux_sens() {
        let pairs = [
            (Trait::Industrious, Trait::Lazy),
            (Trait::Optimist, Trait::Pessimist),
            (Trait::Brawler, Trait::Coward),
            (Trait::Gourmand, Trait::Ascetic),
            (Trait::Tough, Trait::Frail),
        ];
        for (a, b) in pairs {
            assert!(a.conflicts_with(b));
            assert!(b.conflicts_with(a));
        }
        assert!(!Trait::Industrious.conflicts_with(Trait::Optimist));
    }
}
