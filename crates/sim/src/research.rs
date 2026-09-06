//! Recherche : six technologies, des points gagnés à l'établi, des bonus.
//!
//! Les cinq premières ne **verrouillent** rien : tout ce que la colonie sait
//! faire au premier tick, elle sait encore le faire sans avoir rien cherché.
//! Une technologie acquise améliore ce qui existe déjà — les cultures poussent
//! mieux, les soins vont plus vite, les vivres tiennent plus longtemps, l'arc
//! porte plus loin, la pierre se taille plus vite.
//!
//! `Tech::Metallurgy` fait exception, et c'est délibéré : un **palier de
//! matériau** n'est pas un bonus qu'on module, c'est une porte. Sans elle, la
//! forge est refusée (`Sim::apply` sur `Command::Build`), donc pas de lingot,
//! donc pas d'épée. C'est la seule chose que la recherche interdise.
//!
//! Chaque technologie dit **ici** ce qu'elle change, en constantes et en
//! fonctions pures : les points d'application (`jobs`, `combat`, `build`,
//! `fastforward`) n'ont plus qu'à lire le drapeau et appliquer. C'est aussi ce
//! qui rend les effets testables sans jouer une partie.

use serde::{Deserialize, Serialize};

/// Nombre de technologies. Contrat avec le client : `research_state()` renvoie
/// `1 + 3 × COUNT` entiers.
pub const TECH_COUNT: usize = 6;

/// Ce qu'une colonie peut chercher. Les valeurs sont un contrat avec le client
/// (`Command::SetResearch`, `arg` de `EventKind::ResearchDone`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Tech {
    /// Les cultures poussent un quart plus vite.
    Agriculture = 0,
    /// Les soins vont moitié plus vite, et une plaie pansée cicatrise
    /// d'autant.
    Medicine = 1,
    /// Les vivres se gâtent deux fois moins vite, en plus du froid.
    Preservation = 2,
    /// L'arc porte plus loin et frappe plus fort.
    Archery = 3,
    /// Bâtir en pierre prend un quart de temps en moins.
    Masonry = 4,
    /// Déverrouille la forge (`build::BuildKind::Forge`), donc la fonte du
    /// minerai et l'épée. **Ajoutée en fin d'énumération** : le numéro est un
    /// contrat avec le client (`Command::SetResearch`).
    Metallurgy = 5,
}

impl Tech {
    pub const COUNT: usize = TECH_COUNT;

    /// Dans l'ordre des valeurs.
    pub const ALL: [Tech; TECH_COUNT] = [
        Tech::Agriculture,
        Tech::Medicine,
        Tech::Preservation,
        Tech::Archery,
        Tech::Masonry,
        Tech::Metallurgy,
    ];

    /// `None` pour un octet qui ne désigne aucune technologie — `NO_TECH`
    /// compris. Contrairement aux autres `from_u8` du sim, celui-ci ne retombe
    /// pas sur une valeur par défaut : une commande de recherche invalide est
    /// **ignorée**, pas réinterprétée.
    pub fn from_u8(v: u8) -> Option<Tech> {
        match v {
            0 => Some(Tech::Agriculture),
            1 => Some(Tech::Medicine),
            2 => Some(Tech::Preservation),
            3 => Some(Tech::Archery),
            4 => Some(Tech::Masonry),
            5 => Some(Tech::Metallurgy),
            _ => None,
        }
    }

    /// Points de recherche à accumuler. À `RESEARCH_STEP` centièmes de point
    /// par tick de travail nominal, comptez 10 000 à 15 000 ticks de recherche
    /// effective par technologie, soit un peu plus d'une journée pour un
    /// colon seul qui part de la compétence zéro, et une à deux journées
    /// dans une colonie où le chercheur dort, mange et range aussi (mesuré :
    /// 7 115 ticks à quatre dixièmes de point par tick, d'où deux dixièmes ;
    /// test `a_tech_takes_a_day_or_two`).
    pub fn cost(self) -> u32 {
        match self {
            Tech::Agriculture => 2_000,
            Tech::Medicine | Tech::Preservation => 2_500,
            Tech::Archery | Tech::Masonry => 3_000,
            // La plus chère : c'est elle qui ouvre un âge, pas un bonus.
            Tech::Metallurgy => 3_500,
        }
    }
}

/// Valeur de `ResearchState::current` quand la colonie ne cherche rien. C'est
/// aussi ce que `Command::SetResearch` accepte pour tout arrêter.
pub const NO_TECH: u8 = 255;

/// Centièmes de point apportés par un tick de recherche à vitesse nominale :
/// deux dixièmes de point par tick. L'avancement (`ResearchState::progress`)
/// se compte en centièmes pour rester entier sans perdre la modulation de la
/// vitesse ; les coûts (`Tech::cost`) et `progress_of` parlent en points.
pub const RESEARCH_STEP: u32 = 20;

/// Centièmes de point dans un point (`progress` = points × `PROGRESS_SCALE`).
pub const PROGRESS_SCALE: u32 = 100;

/// Durée d'une séance, en ticks : au bout du compte le chercheur lâche
/// l'établi, quitte à le reprendre au tick suivant. Ses besoins et le reste de
/// son tableau de travail sont ainsi réévalués comme après n'importe quel job
/// terminé, et un camarade peut prendre la place. La tranche se compte sur
/// l'horloge du sim et non dans le job : `Job::Research` ne porte que
/// l'établi, et le tick fait déjà partie de l'état.
pub const RESEARCH_SESSION: u32 = 600;

/// Un tick de pousse sur `AGRICULTURE_BONUS_INTERVAL` compte double
/// (voir `crop_growth_step`).
pub const AGRICULTURE_BONUS_INTERVAL: u64 = 4;

/// Vitesse de soin avec `Tech::Medicine`, en pourcentage de la nominale.
pub const MEDICINE_TEND_PERCENT: u32 = 150;
/// Points de cicatrisation d'une plaie pansée : deux sans `Tech::Medicine`,
/// trois avec (`+50 %`, voir `Sim::tick_injuries`).
pub const TENDED_HEAL_POINTS: u32 = 2;
pub const MEDICINE_HEAL_POINTS: u32 = 3;

/// Diviseur supplémentaire de la péremption avec `Tech::Preservation` : il
/// vient **multiplier** celui du froid (`climate::spoilage_divisor`).
pub const PRESERVATION_DIVISOR: u32 = 2;

/// Portée de l'arc avec `Tech::Archery`, en cases (contre `combat::BOW_RANGE`
/// sans elle).
pub const ARCHERY_BOW_RANGE: u32 = 10;
/// Dégâts d'une flèche avec `Tech::Archery`, en pourcentage.
pub const ARCHERY_DAMAGE_PERCENT: u32 = 125;

/// Durée d'un chantier **en pierre** avec `Tech::Masonry`, en pourcentage de
/// la nominale.
pub const MASONRY_WORK_PERCENT: u32 = 75;

/// Centièmes de point gagnés en un tick. `work_step` est la vitesse de
/// travail du colon en centièmes (`Pawn::work_step`) : humeur, compétence,
/// bras abîmés et maladie s'y trouvent déjà. Le résultat est entier, et jamais
/// nul : un éclopé cherche lentement, il ne cherche pas pour rien.
pub fn points_for(work_step: u32) -> u32 {
    (RESEARCH_STEP * work_step / 100).max(1)
}

/// Pousse d'un plant sur un tick, bonus d'`Agriculture` compris.
///
/// La pousse nominale (`climate::growth_step`) vaut 0, 1 ou 2 : un
/// `step * 125 / 100` entier ne donnerait jamais rien de plus. Le quart
/// supplémentaire est donc versé d'un coup un tick sur quatre — même total sur
/// la durée, toujours entier, et déterministe puisque le tick fait partie de
/// l'état.
pub fn crop_growth_step(step: u32, agriculture: bool, tick: u64) -> u32 {
    if agriculture && tick % AGRICULTURE_BONUS_INTERVAL == 0 {
        step * 2
    } else {
        step
    }
}

/// Même bonus, compté d'un coup pour une avance rapide (`fastforward`) : le
/// nombre de ticks « doubles » d'une fenêtre de `ticks` ticks est exactement
/// `ticks / AGRICULTURE_BONUS_INTERVAL`.
pub fn crop_growth_ticks(ticks: u32, agriculture: bool) -> u32 {
    if agriculture {
        ticks.saturating_add(ticks / AGRICULTURE_BONUS_INTERVAL as u32)
    } else {
        ticks
    }
}

/// Avancement d'un soin sur un tick, en centièmes (voir `health::TEND_STEP`).
pub fn tend_step(base: u32, medicine: bool) -> u32 {
    if medicine {
        base * MEDICINE_TEND_PERCENT / 100
    } else {
        base
    }
}

/// Points de cicatrisation d'une plaie **pansée** par intervalle de soin.
pub fn tended_heal_points(medicine: bool) -> u32 {
    if medicine {
        MEDICINE_HEAL_POINTS
    } else {
        TENDED_HEAL_POINTS
    }
}

/// Diviseur de péremption, froid et `Preservation` combinés.
pub fn spoilage_divisor(cold: u32, preservation: bool) -> u32 {
    if preservation {
        cold.saturating_mul(PRESERVATION_DIVISOR)
    } else {
        cold
    }
}

/// Portée de l'arc, `Archery` comprise.
pub fn bow_range(base: u32, archery: bool) -> u32 {
    if archery { ARCHERY_BOW_RANGE } else { base }
}

/// Dégâts d'une flèche, `Archery` comprise.
pub fn ranged_damage(base: u32, archery: bool) -> u32 {
    if archery {
        base * ARCHERY_DAMAGE_PERCENT / 100
    } else {
        base
    }
}

/// Où en est la colonie. `current` vaut `NO_TECH` quand elle ne cherche rien ;
/// `progress` et `done` sont indexés par `Tech`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ResearchState {
    pub current: u8,
    pub progress: [u32; TECH_COUNT],
    pub done: [bool; TECH_COUNT],
}

impl Default for ResearchState {
    fn default() -> ResearchState {
        ResearchState {
            current: NO_TECH,
            progress: [0; TECH_COUNT],
            done: [false; TECH_COUNT],
        }
    }
}

impl ResearchState {
    /// Technologie en cours, `None` si la colonie ne cherche rien (ou si
    /// `current` désigne, snapshot bricolé aidant, une technologie inconnue ou
    /// déjà acquise).
    pub fn current(&self) -> Option<Tech> {
        let tech = Tech::from_u8(self.current)?;
        if self.done[tech as usize] {
            None
        } else {
            Some(tech)
        }
    }

    pub fn is_done(&self, tech: Tech) -> bool {
        self.done[tech as usize]
    }

    /// Avancement en points (l'état interne compte en centièmes).
    pub fn progress_of(&self, tech: Tech) -> u32 {
        self.progress[tech as usize] / PROGRESS_SCALE
    }

    /// La technologie en cours a-t-elle atteint son coût ?
    pub fn reached(&self, tech: Tech) -> bool {
        self.progress[tech as usize] >= tech.cost().saturating_mul(PROGRESS_SCALE)
    }

    /// Acquiert une technologie d'un trait. **Pour les tests et les
    /// scénarios** (via `Sim::research_mut`) : en jeu, une technologie
    /// s'obtient en cherchant.
    pub fn complete(&mut self, tech: Tech) {
        self.progress[tech as usize] = tech.cost().saturating_mul(PROGRESS_SCALE);
        self.done[tech as usize] = true;
        if self.current == tech as u8 {
            self.current = NO_TECH;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_technologies_sont_coherentes() {
        for (k, tech) in Tech::ALL.iter().enumerate() {
            assert_eq!(*tech as usize, k, "ALL n'est pas dans l'ordre des valeurs");
            assert_eq!(Tech::from_u8(k as u8), Some(*tech));
            assert!(tech.cost() > 0);
        }
        assert_eq!(Tech::from_u8(TECH_COUNT as u8), None);
        assert_eq!(Tech::from_u8(NO_TECH), None);
    }

    #[test]
    fn l_etat_par_defaut_ne_cherche_rien() {
        let mut state = ResearchState::default();
        assert_eq!(state.current, NO_TECH);
        assert_eq!(state.current(), None);
        state.current = Tech::Medicine as u8;
        assert_eq!(state.current(), Some(Tech::Medicine));
        // Acquise en cours de route : elle cesse d'être cherchée.
        state.complete(Tech::Medicine);
        assert!(state.is_done(Tech::Medicine));
        assert_eq!(state.current(), None);
        assert_eq!(state.current, NO_TECH);
    }

    #[test]
    fn le_quart_de_pousse_tombe_juste_sur_quatre_ticks() {
        let plain: u32 = (0..4).map(|t| crop_growth_step(1, false, t)).sum();
        let farmed: u32 = (0..4).map(|t| crop_growth_step(1, true, t)).sum();
        assert_eq!(plain, 4);
        assert_eq!(farmed, 5, "un quart de pousse en plus sur quatre ticks");
        assert_eq!(crop_growth_ticks(400, false), 400);
        assert_eq!(crop_growth_ticks(400, true), 500);
        // Rien ne pousse quand rien ne pousse : le bonus ne crée pas de vie.
        assert_eq!(crop_growth_step(0, true, 0), 0);
    }

    #[test]
    fn les_bonus_vont_dans_le_bon_sens() {
        assert_eq!(points_for(100), RESEARCH_STEP);
        assert_eq!(points_for(60), 12);
        assert_eq!(points_for(0), 1, "un éclopé avance quand même");
        assert_eq!(tend_step(100, false), 100);
        assert_eq!(tend_step(100, true), 150);
        assert_eq!(tended_heal_points(false), 2);
        assert_eq!(tended_heal_points(true), 3);
        assert_eq!(spoilage_divisor(4, false), 4);
        assert_eq!(spoilage_divisor(4, true), 8);
        assert_eq!(bow_range(8, false), 8);
        assert_eq!(bow_range(8, true), ARCHERY_BOW_RANGE);
        assert_eq!(ranged_damage(80, false), 80);
        assert_eq!(ranged_damage(80, true), 100);
    }
}
