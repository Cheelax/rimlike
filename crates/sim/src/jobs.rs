//! Comportement des colons : besoins, recherche de travail, exécution des jobs.
//! Toutes les recherches parcourent des `Vec` dans l'ordre des indices et
//! départagent par distance puis coordonnées : déterministe.
//!
//! Ordre de priorité d'un colon libre : dormir > manger > les travaux dans
//! l'ordre réglé par le joueur (`Pawn::priorities`) > flâner.

use core::cmp::Reverse;

use crate::animals::Species;
use crate::build;
use crate::climate;
use crate::craft::{self, CraftStage};
use crate::farm::{self, Crop};
use crate::health::{TEND_STEP, TEND_TICKS};
use crate::items::{ItemKind, ItemStack, STACK_MAX};
use crate::map::{Designation, Feature, Zone, chebyshev};
use crate::path;
use crate::pawn::{
    BREAK_TICKS, Faction, HUNGER_DECAY, Job, MOOD_BREAK, NEED_MAX, RELIEF_TICKS, REST_DECAY,
    REST_RECOVERY, RESTED,
};
use crate::work::{self, WorkType};
use crate::{EventKind, Sim, TICKS_PER_DAY, Weather};

/// Nombre maximal de candidats pour lesquels on tente un A* par recherche.
const PATH_ATTEMPTS: usize = 6;
/// Un colon en crise ne change de direction que tous ces ticks.
const BREAK_WANDER_INTERVAL: u64 = 30;
/// Chance par tick qu'un colon au moral à zéro craque : une fois toutes les
/// dix secondes de jeu en moyenne.
const BREAK_CHANCE: u32 = 600;

/// Production d'un travail terminé.
fn yield_of(kind: Designation) -> Option<(ItemKind, u32)> {
    match kind {
        Designation::Chop => Some((ItemKind::Wood, 20)),
        Designation::Mine => Some((ItemKind::Stone, 15)),
        Designation::Harvest => Some((ItemKind::Berries, 8)),
        Designation::None => None,
    }
}

impl Sim {
    pub(crate) fn tick_pawn(&mut self, i: usize, outdoor: i32) {
        if !self.pawns[i].is_alive() {
            return;
        }
        self.pawns[i].outdoor_storm = self.weather == Weather::Storm;
        self.tick_comfort(i, outdoor);
        self.tick_health(i);
        // Une hémorragie peut avoir tué le pawn à l'instant : il sera retiré
        // en fin de tick, il n'agit plus.
        if !self.pawns[i].is_alive() {
            return;
        }
        if self.pawns[i].faction == Faction::Raider {
            // Un pillard à terre reste à terre : il ne combat plus et ne fuit
            // plus, il attend de se relever (ou de mourir).
            if self.pawns[i].is_downed() {
                return;
            }
            // Les pillards ne mangent ni ne dorment : ils viennent, ils frappent.
            match self.pawns[i].job.clone() {
                Job::Attack { target } => self.do_attack(i, target),
                Job::Flee => self.do_flee(i),
                // Un assiégeant patiente à son point d'entrée.
                Job::Wait { until } => self.do_wait(i, until),
                _ => self.raider_ai(i),
            }
            return;
        }
        // La faune : boucle courte elle aussi, sans besoin ni recherche de job.
        if self.pawns[i].faction == Faction::Animal {
            self.animal_ai(i);
            return;
        }
        self.decay_needs(i);
        // À terre : plus de défense, plus de crise, plus de recherche de job.
        // Sa position, s'il est porté, est recopiée par le porteur.
        if self.pawns[i].is_downed() {
            return;
        }
        self.defend_if_threatened(i);
        if self.pawns[i].is_starving()
            && !matches!(
                self.pawns[i].job,
                Job::Eat { .. }
                    | Job::Sleep { .. }
                    | Job::Move { manual: true }
                    | Job::Attack { .. }
            )
            && self.food_available()
        {
            self.abandon_job(i);
        }
        self.break_if_desperate(i);
        match self.pawns[i].job.clone() {
            Job::Idle => self.find_job(i),
            Job::Move { .. } => {
                self.pawns[i].advance(&self.map);
                if !self.pawns[i].is_moving() {
                    self.pawns[i].job = Job::Idle;
                }
            }
            Job::Work {
                kind,
                x,
                y,
                progress,
            } => self.do_work(i, kind, x, y, progress),
            Job::Haul { item, dest, picked } => self.do_haul(i, item, dest, picked),
            Job::Eat { item } => self.do_eat(i, item),
            Job::Sleep { in_bed } => self.do_sleep(i, in_bed),
            Job::Deliver {
                blueprint,
                item,
                picked,
            } => self.do_deliver(i, blueprint, item, picked),
            Job::Build { blueprint } => self.do_build(i, blueprint),
            Job::Farm {
                sow,
                x,
                y,
                progress,
            } => self.do_farm(i, sow, x, y, progress),
            Job::Cook {
                campfire,
                item,
                picked,
                progress,
            } => self.do_cook(i, campfire, item, picked, progress),
            Job::Attack { target } => self.do_attack(i, target),
            Job::Flee => self.do_flee(i),
            Job::Break { until } => self.do_break(i, until),
            Job::Rescue { target, picked } => self.do_rescue(i, target, picked),
            Job::Tend { target, progress } => self.do_tend(i, target, progress),
            Job::Craft {
                spot,
                recipe,
                stage,
            } => self.do_craft(i, spot, recipe, stage),
            Job::Equip { item } => self.do_equip(i, item),
            Job::Hunt { target } => self.do_hunt(i, target),
            Job::Butcher {
                spot,
                item,
                picked,
                progress,
            } => self.do_butcher(i, spot, item, picked, progress),
            // Traité plus haut : un pawn à terre ne passe jamais par ici.
            Job::Downed => {}
            // Réservé aux assiégeants (traités plus haut) : un colon n'attend
            // jamais. S'il s'en trouvait un, il reprendrait le travail.
            Job::Wait { .. } => self.pawns[i].job = Job::Idle,
        }
    }

    /// Un colon au bout du rouleau finit par tout lâcher. La défense
    /// automatique reste prioritaire : elle abandonne la crise.
    fn break_if_desperate(&mut self, i: usize) {
        if self.pawns[i].mood() >= MOOD_BREAK
            || matches!(
                self.pawns[i].job,
                Job::Break { .. }
                    | Job::Sleep { .. }
                    | Job::Eat { .. }
                    | Job::Attack { .. }
                    | Job::Move { manual: true }
            )
            || !self.rng.chance(1, BREAK_CHANCE)
        {
            return;
        }
        self.abandon_job(i);
        let until = self.tick + u64::from(BREAK_TICKS);
        self.pawns[i].job = Job::Break { until };
        let id = self.pawns[i].id;
        self.push_event(EventKind::ColonistBreak, id);
    }

    /// Pendant une crise, le colon erre au hasard autour de lui.
    fn do_break(&mut self, i: usize, until: u64) {
        if self.tick >= until {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
            self.pawns[i].relief_ticks = RELIEF_TICKS;
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if self.tick % BREAK_WANDER_INTERVAL != 0 || !self.rng.chance(1, 3) {
            return;
        }
        let (px, py) = self.pawns[i].tile();
        let tx = px as i32 + self.rng.range_i32(-6, 7);
        let ty = py as i32 + self.rng.range_i32(-6, 7);
        if !self.map.in_bounds(tx, ty) || !self.map.passable(tx as u32, ty as u32) {
            return;
        }
        // Le chemin est posé, mais le job reste la crise jusqu'à son terme.
        if let Some(path) = path::find_path(&self.map, (px, py), (tx as u32, ty as u32))
            && !path.is_empty()
        {
            self.pawns[i].set_path(path);
        }
    }

    fn decay_needs(&mut self, i: usize) {
        let p = &self.pawns[i];
        let sleeping = matches!(p.job, Job::Sleep { .. }) && !p.is_moving();
        let in_bed = matches!(p.job, Job::Sleep { in_bed: true });
        let p = &mut self.pawns[i];
        p.hunger = p.hunger.saturating_sub(if sleeping {
            HUNGER_DECAY / 2
        } else {
            HUNGER_DECAY
        });
        if sleeping {
            let recovery = if in_bed {
                REST_RECOVERY * 3 / 2
            } else {
                REST_RECOVERY
            };
            p.rest = (p.rest + recovery).min(NEED_MAX);
        } else {
            p.rest = p.rest.saturating_sub(REST_DECAY);
        }
    }

    fn food_available(&self) -> bool {
        self.items
            .iter()
            .any(|s| s.kind.is_food() && s.reserved_by.is_none())
    }

    /// Libère réservations et objets portés, remet le colon à l'arrêt.
    pub(crate) fn abandon_job(&mut self, i: usize) {
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        for s in &mut self.items {
            if s.reserved_by == Some(id) {
                s.reserved_by = None;
            }
        }
        for b in &mut self.blueprints {
            if b.reserved_by == Some(id) {
                b.reserved_by = None;
            }
        }
        self.drop_carried(i);
        // Un porteur qui lâche son job repose le blessé là où il en est.
        self.pawns[i].carrying_pawn = None;
        self.pawns[i].path.clear();
        self.pawns[i].job = Job::Idle;
    }

    fn drop_carried(&mut self, i: usize) {
        if let Some((kind, count)) = self.pawns[i].carrying.take() {
            let (x, y) = self.pawns[i].tile();
            self.spawn_item(kind, count, x, y);
        }
    }

    /// Fait progresser d'un cran la compétence associée à un tick de travail
    /// effectif. Appelée par `do_work`, `do_build`, `do_farm` et `do_cook` ;
    /// jamais par `do_haul`/`do_deliver`, qui n'ont pas de barre de
    /// progression et ne font donc jamais gagner d'XP au transport.
    fn gain_xp(&mut self, i: usize, work: WorkType) {
        let id = self.pawns[i].id;
        let skill = &mut self.pawns[i].skills[work as usize];
        skill.xp += 1;
        if skill.xp >= work::xp_to_next(skill.level) && skill.level < work::SKILL_MAX {
            skill.level += 1;
            skill.xp = 0;
            self.push_event(EventKind::LevelUp, id);
        }
    }

    // ------------------------------------------------------------------
    // Recherche de travail
    // ------------------------------------------------------------------

    fn find_job(&mut self, i: usize) {
        if self.pawns[i].is_tired() {
            self.start_sleep(i);
            return;
        }
        if self.pawns[i].is_hungry() && self.try_start_eat(i) {
            return;
        }
        // Le secours passe avant tout travail, mais après ses propres besoins :
        // un colon épuisé ou affamé ne porte personne.
        if self.try_start_rescue(i) {
            return;
        }
        if self.try_start_tend(i) {
            return;
        }
        // S'armer passe avant le travail : un colon désarmé qui part couper du
        // bois pendant qu'un arc l'attend en stockage n'a aucun sens.
        if self.try_start_equip(i) {
            return;
        }
        // Priorité 1 d'abord, et à priorité égale l'ordre de `WorkType::ALL`.
        for prio in 1..=4 {
            for work in WorkType::ALL {
                if self.pawns[i].priorities[work as usize] == prio && self.try_start(work, i) {
                    return;
                }
            }
        }
        self.idle_wander(i);
    }

    /// Tente de démarrer un travail de la famille demandée.
    fn try_start(&mut self, work: WorkType, i: usize) -> bool {
        match work {
            // La fabrication est du travail de constructeur : elle suit la même
            // priorité et la même compétence, après les chantiers en cours.
            WorkType::Build => self.try_start_build(i) || self.try_start_craft(i),
            WorkType::Deliver => self.try_start_deliver(i),
            // Le dépeçage suit la cuisine : même compétence, même urgence
            // (la viande se gâte), mais après les repas déjà lancés.
            WorkType::Cook => self.try_start_cook(i) || self.try_start_butcher(i),
            // La chasse est du travail désigné : le joueur la demande bête par
            // bête (`Command::Hunt`) plutôt que case par case, mais c'est la
            // même priorité et la même place dans le tableau de travail.
            WorkType::Designated => self.try_start_work(i) || self.try_start_hunt(i),
            WorkType::Farm => self.try_start_farm(i),
            WorkType::Haul => self.try_start_haul(i),
        }
    }

    /// Flâner autour de soi de temps en temps.
    fn idle_wander(&mut self, i: usize) {
        self.pawns[i].idle_ticks += 1;
        if self.pawns[i].idle_ticks < 90 || !self.rng.chance(1, 45) {
            return;
        }
        let (px, py) = self.pawns[i].tile();
        let tx = px as i32 + self.rng.range_i32(-7, 8);
        let ty = py as i32 + self.rng.range_i32(-7, 8);
        if !self.map.in_bounds(tx, ty) || !self.map.passable(tx as u32, ty as u32) {
            return;
        }
        if let Some(path) = path::find_path(&self.map, (px, py), (tx as u32, ty as u32))
            && !path.is_empty()
        {
            self.pawns[i].set_path(path);
            self.pawns[i].job = Job::Move { manual: false };
        }
    }

    /// Va dormir dans le lit libre le plus proche, sinon au sol sur place.
    fn start_sleep(&mut self, i: usize) {
        let from = self.pawns[i].tile();
        let mut beds: Vec<(u32, u32, u32)> = Vec::new();
        if self.map.bed_count() == 0 {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Sleep { in_bed: false };
            return;
        }
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                // Un lit réservé attend un blessé qu'on est en train de porter.
                if self.map.feature(x, y) == Feature::Bed
                    && !self.bed_occupied_by_other(i, (x, y))
                    && !self.is_reserved(x, y)
                {
                    beds.push((chebyshev(from, (x, y)), x, y));
                }
            }
        }
        beds.sort_unstable();
        for &(_, x, y) in beds.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = path::find_path(&self.map, from, (x, y)) {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Sleep { in_bed: true };
                return;
            }
        }
        self.pawns[i].path.clear();
        self.pawns[i].job = Job::Sleep { in_bed: false };
    }

    fn bed_occupied_by_other(&self, i: usize, bed: (u32, u32)) -> bool {
        self.pawns.iter().enumerate().any(|(k, p)| {
            k != i
                && p.tile() == bed
                && (p.is_downed() || matches!(p.job, Job::Sleep { in_bed: true }) && !p.is_moving())
        })
    }

    // ------------------------------------------------------------------
    // Secours : porter les blessés au lit, panser les plaies
    // ------------------------------------------------------------------

    /// Un colon déjà chargé de ce blessé (porteur ou soignant) ?
    fn already_handled(&self, target: u32) -> bool {
        self.pawns.iter().any(|p| match p.job {
            Job::Rescue { target: t, .. } | Job::Tend { target: t, .. } => t == target,
            _ => false,
        })
    }

    /// Lit libre le plus proche de `near`, atteignable depuis là. Réservé pour
    /// un blessé donné : le lit où il gît déjà ne compte pas comme occupé.
    fn find_free_bed(&self, near: (u32, u32), patient: u32) -> Option<(u32, u32)> {
        let mut beds: Vec<(u32, u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) != Feature::Bed || self.is_reserved(x, y) {
                    continue;
                }
                let taken = self.pawns.iter().any(|p| {
                    p.id != patient
                        && p.tile() == (x, y)
                        && (p.is_downed()
                            || matches!(p.job, Job::Sleep { in_bed: true }) && !p.is_moving())
                });
                if !taken {
                    beds.push((chebyshev(near, (x, y)), x, y));
                }
            }
        }
        beds.sort_unstable();
        beds.iter()
            .take(PATH_ATTEMPTS)
            .find(|&&(_, x, y)| path::find_path(&self.map, near, (x, y)).is_some())
            .map(|&(_, x, y)| (x, y))
    }

    /// Va chercher un colon à terre pour le porter dans un lit. Sans lit sur la
    /// carte, on le laisse où il est : il sera soigné au sol.
    fn try_start_rescue(&mut self, i: usize) -> bool {
        // Deux tests qui court-circuitent le cas courant : pas de lit à viser,
        // ou personne au sol. Un colon inactif repasse ici à chaque tick.
        if self.map.bed_count() == 0 || !self.pawns.iter().any(|p| p.is_downed()) {
            return false;
        }
        let me = self.pawns[i].id;
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if p.id == me || p.faction != Faction::Colony || !p.is_alive() || !p.is_downed() {
                continue;
            }
            let (x, y) = p.tile();
            // Déjà au lit : rien à faire de plus pour lui.
            if self.map.feature(x, y) == Feature::Bed || self.already_handled(p.id) {
                continue;
            }
            candidates.push((chebyshev(from, (x, y)), x, y, p.id));
        }
        candidates.sort_unstable();
        for &(_, x, y, target) in candidates.iter().take(PATH_ATTEMPTS) {
            let Some(bed) = self.find_free_bed((x, y), target) else {
                continue;
            };
            let Some(p) = self.path_to_work(from, (x, y)) else {
                continue;
            };
            // Le lit est réservé par `reservations` ; le blessé, lui, l'est par
            // le job du porteur (`already_handled`) : sa case bouge pendant le
            // transport, une réservation de case ne le suivrait pas.
            self.reservations.push(Reservation {
                x: bed.0,
                y: bed.1,
                pawn: me,
            });
            self.pawns[i].set_path(p);
            self.pawns[i].job = Job::Rescue {
                target,
                picked: false,
            };
            return true;
        }
        false
    }

    /// Case réservée par ce colon (le lit visé par un sauvetage).
    fn reserved_tile(&self, pawn: u32) -> Option<(u32, u32)> {
        self.reservations
            .iter()
            .find(|r| r.pawn == pawn)
            .map(|r| (r.x, r.y))
    }

    fn do_rescue(&mut self, i: usize, target: u32, picked: bool) {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == target && p.is_alive() && p.is_downed())
        else {
            // Mort, ou relevé tout seul : on le repose et on passe à autre chose.
            self.abandon_job(i);
            return;
        };
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            if picked {
                self.carry_along(i, k);
            }
            return;
        }
        if !picked {
            let me = self.pawns[i].tile();
            if chebyshev(me, self.pawns[k].tile()) > 1 {
                self.abandon_job(i);
                return;
            }
            let id = self.pawns[i].id;
            let Some(bed) = self.reserved_tile(id) else {
                self.abandon_job(i);
                return;
            };
            let Some(p) = path::find_path(&self.map, me, bed) else {
                self.abandon_job(i);
                return;
            };
            self.pawns[i].carrying_pawn = Some(target);
            self.pawns[i].set_path(p);
            self.pawns[i].job = Job::Rescue {
                target,
                picked: true,
            };
            self.pawns[k].path.clear();
            self.carry_along(i, k);
            return;
        }
        // Arrivé au lit : on dépose.
        self.carry_along(i, k);
        self.pawns[i].carrying_pawn = None;
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
        self.push_event(EventKind::ColonistRescued, target);
    }

    /// Le blessé porté occupe la case de son porteur.
    fn carry_along(&mut self, carrier: usize, carried: usize) {
        let (x, y) = (self.pawns[carrier].x, self.pawns[carrier].y);
        self.pawns[carried].x = x;
        self.pawns[carried].y = y;
    }

    /// Va panser un colon blessé. D'abord ceux qui saignent, puis ceux qui sont
    /// à terre, puis les plus proches. On ne se soigne pas soi-même.
    fn try_start_tend(&mut self, i: usize) -> bool {
        // Court-circuit : personne à panser, on ne compare rien.
        if !self.pawns.iter().any(|p| p.needs_tending()) {
            return false;
        }
        let me = self.pawns[i].id;
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if p.id == me
                || p.faction != Faction::Colony
                || !p.is_alive()
                || !p.needs_tending()
                || self.already_handled(p.id)
            {
                continue;
            }
            let (x, y) = p.tile();
            candidates.push((
                u32::from(!p.is_bleeding()),
                u32::from(!p.is_downed()),
                chebyshev(from, (x, y)),
                x,
                y,
                p.id,
            ));
        }
        candidates.sort_unstable();
        for &(.., x, y, target) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.path_to_work(from, (x, y)) {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Tend {
                    target,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    fn do_tend(&mut self, i: usize, target: u32, progress: u32) {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == target && p.is_alive())
        else {
            self.abandon_job(i);
            return;
        };
        if !self.pawns[k].needs_tending() {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), self.pawns[k].tile()) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + TEND_STEP;
        if progress < TEND_TICKS * 100 {
            self.pawns[i].job = Job::Tend { target, progress };
            return;
        }
        for inj in &mut self.pawns[k].injuries {
            inj.tended = true;
            inj.close();
        }
        // Le même chevet soigne la maladie : elle passe deux fois plus vite.
        self.tend_illness(k);
        self.pawns[i].job = Job::Idle;
        self.push_event(EventKind::ColonistTended, target);
    }

    /// Va manger la meilleure nourriture accessible : repas, puis baies, puis cru.
    fn try_start_eat(&mut self, i: usize) -> bool {
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.is_food() && s.reserved_by.is_none())
            .map(|(k, s)| (s.kind.food_rank(), chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        candidates.sort_unstable();
        for &(_, _, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = path::find_path(&self.map, from, (x, y)) {
                let id = self.pawns[i].id;
                self.items[k].reserved_by = Some(id);
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Eat { item };
                return true;
            }
        }
        false
    }

    fn try_start_build(&mut self, i: usize) -> bool {
        if self.blueprints.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, usize)> = self
            .blueprints
            .iter()
            .enumerate()
            .filter(|(_, b)| b.ready() && b.reserved_by.is_none())
            .map(|(k, b)| (chebyshev(from, (b.x, b.y)), b.x, b.y, k))
            .collect();
        candidates.sort_unstable();
        for &(_, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
            let path = if self.blueprints[k].kind.adjacent_only() {
                self.path_adjacent(from, (x, y))
            } else {
                self.path_to_work(from, (x, y))
            };
            if let Some(p) = path {
                let id = self.pawns[i].id;
                self.blueprints[k].reserved_by = Some(id);
                let blueprint = self.blueprints[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Build { blueprint };
                return true;
            }
        }
        false
    }

    fn try_start_deliver(&mut self, i: usize) -> bool {
        if self.blueprints.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, usize)> = self
            .blueprints
            .iter()
            .enumerate()
            .filter(|(_, b)| b.missing() > 0 && b.reserved_by.is_none())
            .map(|(k, b)| (chebyshev(from, (b.x, b.y)), b.x, b.y, k))
            .collect();
        candidates.sort_unstable();
        let mut attempts = 0;
        for &(_, _, _, k) in &candidates {
            if attempts >= PATH_ATTEMPTS {
                break;
            }
            let wanted = self.blueprints[k].material.item_kind();
            // La pile la plus proche du colon, qui va d'abord la chercher.
            let mut stacks: Vec<(u32, u32, u32, usize)> = self
                .items
                .iter()
                .enumerate()
                .filter(|(_, s)| s.kind == wanted && s.reserved_by.is_none() && s.count > 0)
                .map(|(j, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, j))
                .collect();
            stacks.sort_unstable();
            let Some(&(_, sx, sy, j)) = stacks.first() else {
                continue;
            };
            attempts += 1;
            if let Some(p) = path::find_path(&self.map, from, (sx, sy)) {
                let id = self.pawns[i].id;
                self.blueprints[k].reserved_by = Some(id);
                self.items[j].reserved_by = Some(id);
                let blueprint = self.blueprints[k].id;
                let item = self.items[j].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Deliver {
                    blueprint,
                    item,
                    picked: false,
                };
                return true;
            }
        }
        false
    }

    fn try_start_work(&mut self, i: usize) -> bool {
        if self.map.designation_count() == 0 {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                let d = self.map.designation(x, y);
                if d != Designation::None
                    && d.applies_to(self.map.feature(x, y))
                    && !self.is_reserved(x, y)
                {
                    candidates.push((chebyshev(from, (x, y)), x, y));
                }
            }
        }
        candidates.sort_unstable();
        for &(_, x, y) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.path_to_work(from, (x, y)) {
                let kind = self.map.designation(x, y);
                let pawn = self.pawns[i].id;
                self.reservations.push(Reservation { x, y, pawn });
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Work {
                    kind,
                    x,
                    y,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    /// Chemin vers la cible si elle est franchissable, sinon vers une voisine.
    fn path_to_work(&self, from: (u32, u32), target: (u32, u32)) -> Option<Vec<path::Tile>> {
        if self.map.passable(target.0, target.1) {
            return path::find_path(&self.map, from, target);
        }
        self.path_adjacent(from, target)
    }

    /// Chemin vers la case voisine franchissable la plus proche du colon.
    pub(crate) fn path_adjacent(
        &self,
        from: (u32, u32),
        target: (u32, u32),
    ) -> Option<Vec<path::Tile>> {
        let mut neighbours: Vec<(u32, u32, u32)> = Vec::new();
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = target.0 as i32 + dx;
                let ny = target.1 as i32 + dy;
                if self.map.in_bounds(nx, ny) && self.map.passable(nx as u32, ny as u32) {
                    let n = (nx as u32, ny as u32);
                    neighbours.push((chebyshev(from, n), n.0, n.1));
                }
            }
        }
        neighbours.sort_unstable();
        neighbours
            .iter()
            .find_map(|&(_, x, y)| path::find_path(&self.map, from, (x, y)))
    }

    fn try_start_haul(&mut self, i: usize) -> bool {
        if self.map.stockpile_count() == 0 {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.haulable() && s.reserved_by.is_none() && !self.is_stored(s))
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        candidates.sort_unstable();
        let mut attempts = 0;
        for &(_, x, y, k) in &candidates {
            if attempts >= PATH_ATTEMPTS {
                break;
            }
            let kind = self.items[k].kind;
            let Some(dest) = self.find_stockpile_dest(kind, (x, y)) else {
                continue;
            };
            attempts += 1;
            if let Some(p) = path::find_path(&self.map, from, (x, y)) {
                let id = self.pawns[i].id;
                self.items[k].reserved_by = Some(id);
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Haul {
                    item,
                    dest: Some(dest),
                    picked: false,
                };
                return true;
            }
        }
        false
    }

    /// Une pile est rangée si elle est seule de son genre sur une case de stockage.
    fn is_stored(&self, s: &ItemStack) -> bool {
        self.map.zone(s.x, s.y) == Zone::Stockpile
            && self
                .items
                .iter()
                .all(|o| o.id == s.id || (o.x, o.y) != (s.x, s.y) || o.kind == s.kind)
    }

    /// Case de stockage la plus proche de `near` pouvant accueillir `kind`.
    fn find_stockpile_dest(&self, kind: ItemKind, near: (u32, u32)) -> Option<(u32, u32)> {
        let mut best: Option<(u32, u32, u32)> = None;
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.zone(x, y) != Zone::Stockpile || !self.dest_accepts((x, y), kind) {
                    continue;
                }
                let key = (chebyshev(near, (x, y)), x, y);
                if best.is_none_or(|b| key < b) {
                    best = Some(key);
                }
            }
        }
        best.map(|(_, x, y)| (x, y))
    }

    fn dest_accepts(&self, d: (u32, u32), kind: ItemKind) -> bool {
        if self.map.zone(d.0, d.1) != Zone::Stockpile || !self.map.passable(d.0, d.1) {
            return false;
        }
        let mut here = self.items.iter().filter(|s| (s.x, s.y) == d);
        match (here.next(), here.next()) {
            (None, _) => true,
            (Some(s), None) => s.kind == kind && s.count < STACK_MAX,
            _ => false,
        }
    }

    fn is_reserved(&self, x: u32, y: u32) -> bool {
        self.reservations.iter().any(|r| r.x == x && r.y == y)
    }

    // ------------------------------------------------------------------
    // Exécution
    // ------------------------------------------------------------------

    fn do_sleep(&mut self, i: usize, in_bed: bool) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        let actually_in_bed = in_bed
            && self.map.feature(here.0, here.1) == Feature::Bed
            && !self.bed_occupied_by_other(i, here);
        if actually_in_bed != in_bed {
            self.pawns[i].job = Job::Sleep {
                in_bed: actually_in_bed,
            };
        }
        if self.pawns[i].rest >= RESTED {
            self.pawns[i].last_sleep_in_bed = actually_in_bed;
            self.pawns[i].job = Job::Idle;
        }
    }

    fn do_work(&mut self, i: usize, kind: Designation, x: u32, y: u32, progress: u32) {
        if self.map.designation(x, y) != kind || !kind.applies_to(self.map.feature(x, y)) {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), (x, y)) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Designated);
        self.gain_xp(i, WorkType::Designated);
        if progress < kind.work_ticks() * 100 {
            self.pawns[i].job = Job::Work {
                kind,
                x,
                y,
                progress,
            };
            return;
        }
        match kind {
            Designation::Chop | Designation::Mine => self.map.set_feature(x, y, Feature::None),
            Designation::Harvest => {
                self.map.set_feature(x, y, Feature::BushUnripe);
                self.regrow.push(Regrow {
                    x,
                    y,
                    ready_at: self.tick + u64::from(TICKS_PER_DAY),
                });
            }
            Designation::None => {}
        }
        if let Some((item, count)) = yield_of(kind) {
            self.spawn_item(item, count, x, y);
        }
        self.map.set_designation(x, y, Designation::None);
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    fn do_haul(&mut self, i: usize, item: u32, dest: Option<(u32, u32)>, picked: bool) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            let Some(k) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[k].x, self.items[k].y) != here {
                self.abandon_job(i);
                return;
            }
            let stack = self.items.remove(k);
            self.pawns[i].carrying = Some((stack.kind, stack.count.min(STACK_MAX)));
            let kind = stack.kind;
            let dest = dest
                .filter(|&d| self.dest_accepts(d, kind))
                .or_else(|| self.find_stockpile_dest(kind, here));
            match dest.and_then(|d| path::find_path(&self.map, here, d).map(|p| (d, p))) {
                Some((d, p)) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Haul {
                        item,
                        dest: Some(d),
                        picked: true,
                    };
                }
                None => {
                    self.drop_carried(i);
                    self.pawns[i].job = Job::Idle;
                }
            }
            return;
        }
        let Some((kind, _)) = self.pawns[i].carrying else {
            self.pawns[i].job = Job::Idle;
            return;
        };
        if dest != Some(here) || !self.dest_accepts(here, kind) {
            // La destination a changé sous nos pieds : en chercher une autre.
            if let Some(d) = self.find_stockpile_dest(kind, here)
                && let Some(p) = path::find_path(&self.map, here, d)
            {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Haul {
                    item,
                    dest: Some(d),
                    picked: true,
                };
                return;
            }
        }
        self.drop_carried(i);
        self.pawns[i].job = Job::Idle;
    }

    fn do_eat(&mut self, i: usize, item: u32) {
        let Some(k) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if self.pawns[i].tile() != (self.items[k].x, self.items[k].y) {
            self.abandon_job(i);
            return;
        }
        let kind = self.items[k].kind;
        let Some(per_unit) = kind.nutrition() else {
            self.abandon_job(i);
            return;
        };
        let hunger = self.pawns[i].hunger;
        let wanted = (NEED_MAX - hunger).div_ceil(per_unit).max(1);
        let n = wanted.min(kind.max_per_meal()).min(self.items[k].count);
        self.pawns[i].hunger = (hunger + n * per_unit).min(NEED_MAX);
        self.pawns[i].last_meal_quality = kind.meal_quality();
        self.items[k].count -= n;
        self.items[k].reserved_by = None;
        if self.items[k].count == 0 {
            self.items.remove(k);
        }
        self.pawns[i].job = Job::Idle;
    }

    fn do_deliver(&mut self, i: usize, blueprint: u32, item: u32, picked: bool) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let Some(k) = self.blueprints.iter().position(|b| b.id == blueprint) else {
            self.abandon_job(i);
            return;
        };
        let here = self.pawns[i].tile();
        if !picked {
            let Some(j) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[j].x, self.items[j].y) != here {
                self.abandon_job(i);
                return;
            }
            let n = self.blueprints[k]
                .missing()
                .min(self.items[j].count)
                .min(STACK_MAX);
            if n == 0 {
                self.abandon_job(i);
                return;
            }
            self.items[j].count -= n;
            self.items[j].reserved_by = None;
            if self.items[j].count == 0 {
                self.items.remove(j);
            }
            let kind = self.blueprints[k].material.item_kind();
            self.pawns[i].carrying = Some((kind, n));
            let target = (self.blueprints[k].x, self.blueprints[k].y);
            match self.path_to_work(here, target) {
                Some(p) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Deliver {
                        blueprint,
                        item,
                        picked: true,
                    };
                }
                None => self.abandon_job(i),
            }
            return;
        }
        let target = (self.blueprints[k].x, self.blueprints[k].y);
        if chebyshev(here, target) > 1 {
            self.abandon_job(i);
            return;
        }
        let Some((kind, n)) = self.pawns[i].carrying.take() else {
            self.blueprints[k].reserved_by = None;
            self.pawns[i].job = Job::Idle;
            return;
        };
        if kind == self.blueprints[k].material.item_kind() {
            let accepted = n.min(self.blueprints[k].missing());
            self.blueprints[k].delivered += accepted;
            if n > accepted {
                self.spawn_item(kind, n - accepted, here.0, here.1);
            }
        } else {
            self.spawn_item(kind, n, here.0, here.1);
        }
        self.blueprints[k].reserved_by = None;
        self.pawns[i].job = Job::Idle;
    }

    fn do_build(&mut self, i: usize, blueprint: u32) {
        let Some(k) = self.blueprints.iter().position(|b| b.id == blueprint) else {
            self.abandon_job(i);
            return;
        };
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let target = (self.blueprints[k].x, self.blueprints[k].y);
        if chebyshev(self.pawns[i].tile(), target) > 1 || !self.blueprints[k].ready() {
            self.abandon_job(i);
            return;
        }
        let kind = self.blueprints[k].kind;
        // Un mur ne se ferme pas sur quelqu'un : on attend que la case se libère.
        if kind.adjacent_only() && self.pawns.iter().any(|p| p.tile() == target) {
            return;
        }
        self.blueprints[k].progress += self.pawns[i].work_step(WorkType::Build);
        self.gain_xp(i, WorkType::Build);
        if self.blueprints[k].progress < kind.work_ticks() * 100 {
            return;
        }
        self.complete_blueprint(k);
        self.pawns[i].job = Job::Idle;
    }

    fn complete_blueprint(&mut self, k: usize) {
        let bp = self.blueprints.remove(k);
        match build::result_feature(bp.kind, bp.material) {
            Some(f) => {
                self.map.set_feature(bp.x, bp.y, f);
                if !f.passable() {
                    self.relocate_items_from(bp.x, bp.y);
                    self.replan_paths_through(bp.x, bp.y);
                }
            }
            None => self
                .map
                .set_terrain(bp.x, bp.y, build::result_terrain(bp.material)),
        }
    }

    /// Pousse les piles d'une case devenue infranchissable sur la voisine la plus proche.
    fn relocate_items_from(&mut self, x: u32, y: u32) {
        let Some(dest) = self.map.nearest_passable(x, y) else {
            return;
        };
        for s in &mut self.items {
            if (s.x, s.y) == (x, y) {
                s.x = dest.0;
                s.y = dest.1;
            }
        }
    }

    /// Recalcule le chemin des colons qui passaient par une case devenue
    /// infranchissable ; abandonne le job si la destination n'est plus atteignable.
    fn replan_paths_through(&mut self, x: u32, y: u32) {
        let tile: path::Tile = (x as u16, y as u16);
        for i in 0..self.pawns.len() {
            if !self.pawns[i].path.contains(&tile) {
                continue;
            }
            let dest = self.pawns[i].path[0];
            let from = self.pawns[i].tile();
            match path::find_path(&self.map, from, (u32::from(dest.0), u32::from(dest.1))) {
                Some(p) if !p.is_empty() => self.pawns[i].set_path(p),
                _ => self.abandon_job(i),
            }
        }
    }

    // ------------------------------------------------------------------
    // Cuisine et culture
    // ------------------------------------------------------------------

    /// Cuisine s'il y a un feu libre, de la nourriture crue et pas assez de repas.
    fn try_start_cook(&mut self, i: usize) -> bool {
        if self.map.campfire_count() == 0 {
            return false;
        }
        let mut fires: Vec<(u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::Campfire && !self.is_reserved(x, y) {
                    fires.push((x, y));
                }
            }
        }
        if fires.is_empty() {
            return false;
        }
        let meals: u32 = self
            .items
            .iter()
            .filter(|s| s.kind == ItemKind::Meal)
            .map(|s| s.count)
            .sum();
        if meals >= farm::MEALS_TARGET {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut stacks: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                s.kind.is_raw_food() && s.reserved_by.is_none() && s.count >= farm::RAW_PER_MEAL
            })
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        stacks.sort_unstable();
        for &(_, sx, sy, k) in stacks.iter().take(PATH_ATTEMPTS) {
            let Some(&(_, fx, fy)) = fires
                .iter()
                .map(|&(x, y)| (chebyshev((sx, sy), (x, y)), x, y))
                .min()
                .as_ref()
            else {
                return false;
            };
            if let Some(p) = path::find_path(&self.map, from, (sx, sy)) {
                let pawn = self.pawns[i].id;
                self.items[k].reserved_by = Some(pawn);
                self.reservations.push(Reservation { x: fx, y: fy, pawn });
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Cook {
                    campfire: (fx, fy),
                    item,
                    picked: false,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    fn do_cook(&mut self, i: usize, campfire: (u32, u32), item: u32, picked: bool, progress: u32) {
        if self.map.feature(campfire.0, campfire.1) != Feature::Campfire {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            let Some(j) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[j].x, self.items[j].y) != here
                || self.items[j].count < farm::RAW_PER_MEAL
            {
                self.abandon_job(i);
                return;
            }
            let kind = self.items[j].kind;
            self.items[j].count -= farm::RAW_PER_MEAL;
            self.items[j].reserved_by = None;
            if self.items[j].count == 0 {
                self.items.remove(j);
            }
            self.pawns[i].carrying = Some((kind, farm::RAW_PER_MEAL));
            match self.path_adjacent(here, campfire) {
                Some(p) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Cook {
                        campfire,
                        item,
                        picked: true,
                        progress: 0,
                    };
                }
                None => self.abandon_job(i),
            }
            return;
        }
        if chebyshev(here, campfire) > 1 || self.pawns[i].carrying.is_none() {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Cook);
        self.gain_xp(i, WorkType::Cook);
        if progress < farm::COOK_TICKS * 100 {
            self.pawns[i].job = Job::Cook {
                campfire,
                item,
                picked: true,
                progress,
            };
            return;
        }
        // Les ingrédients sont consommés, le repas est posé au pied du cuisinier.
        self.pawns[i].carrying = None;
        self.spawn_item(ItemKind::Meal, 1, here.0, here.1);
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    // ------------------------------------------------------------------
    // Fabrication d'armes et de vêtements, équipement
    // ------------------------------------------------------------------

    /// Exemplaires d'un genre que possède la colonie : piles au sol ou rangées,
    /// charges en main, armes équipées et vêtements portés. Les pillards ne
    /// comptent pas, leur gourdin (ni leur tunique) n'appartient pas à la
    /// colonie tant qu'ils le portent.
    pub fn colony_total(&self, kind: ItemKind) -> u32 {
        let mut total: u32 = self
            .items
            .iter()
            .filter(|s| s.kind == kind)
            .map(|s| s.count)
            .sum();
        for p in &self.pawns {
            if p.faction != Faction::Colony {
                continue;
            }
            if let Some((k, n)) = p.carrying
                && k == kind
            {
                total += n;
            }
            if p.weapon == Some(kind) {
                total += 1;
            }
            if p.apparel == Some(kind) {
                total += 1;
            }
        }
        total
    }

    /// Première recette dont l'objectif n'est pas atteint, dans l'ordre de
    /// `craft::RECIPES`.
    fn wanted_recipe(&self) -> Option<&'static craft::Recipe> {
        craft::RECIPES
            .iter()
            .find(|r| self.colony_total(r.output) < self.craft_targets[r.output as usize])
    }

    /// Fabrique s'il y a un poste libre, un objectif non atteint et de quoi
    /// tenir la recette. Les piles nécessaires sont réservées d'un coup : un
    /// colon ne part pas chercher du bois pour un épieu sans pierre.
    fn try_start_craft(&mut self, i: usize) -> bool {
        // Trois court-circuits avant tout balayage : pas de poste, aucun
        // objectif posé, ou tous atteints.
        if self.map.crafting_spot_count() == 0 || self.craft_targets.iter().all(|&t| t == 0) {
            return false;
        }
        let Some(recipe) = self.wanted_recipe() else {
            return false;
        };
        let from = self.pawns[i].tile();
        let mut spots: Vec<(u32, u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::CraftingSpot && !self.is_reserved(x, y) {
                    spots.push((chebyshev(from, (x, y)), x, y));
                }
            }
        }
        spots.sort_unstable();
        let Some(&(_, fx, fy)) = spots.first() else {
            return false;
        };
        // Une pile par ingrédient, la plus proche du colon, assez fournie pour
        // couvrir la recette d'un seul voyage.
        let mut picks: Vec<usize> = Vec::with_capacity(recipe.inputs.len());
        for &(kind, need) in recipe.inputs {
            let mut stacks: Vec<(u32, u32, u32, usize)> = self
                .items
                .iter()
                .enumerate()
                .filter(|(k, s)| {
                    s.kind == kind
                        && s.reserved_by.is_none()
                        && s.count >= need
                        && !picks.contains(k)
                })
                .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
                .collect();
            stacks.sort_unstable();
            let Some(&(_, _, _, k)) = stacks.first() else {
                return false;
            };
            picks.push(k);
        }
        let first = picks[0];
        let target = (self.items[first].x, self.items[first].y);
        let Some(p) = path::find_path(&self.map, from, target) else {
            return false;
        };
        let pawn = self.pawns[i].id;
        for &k in &picks {
            self.items[k].reserved_by = Some(pawn);
        }
        self.reservations.push(Reservation { x: fx, y: fy, pawn });
        let item = self.items[first].id;
        self.pawns[i].set_path(p);
        self.pawns[i].job = Job::Craft {
            spot: (fx, fy),
            recipe: recipe.output,
            stage: CraftStage::Fetch {
                index: 0,
                item,
                carried: false,
            },
        };
        true
    }

    fn do_craft(&mut self, i: usize, spot: (u32, u32), recipe: ItemKind, stage: CraftStage) {
        let Some(r) = craft::recipe_for(recipe) else {
            self.abandon_job(i);
            return;
        };
        if self.map.feature(spot.0, spot.1) != Feature::CraftingSpot {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        match stage {
            CraftStage::Fetch {
                index,
                item,
                carried,
            } => {
                let Some(&(kind, need)) = r.inputs.get(usize::from(index)) else {
                    self.abandon_job(i);
                    return;
                };
                if !carried {
                    self.pick_ingredient(i, spot, recipe, index, item, kind, need);
                    return;
                }
                // Arrivé au poste, la charge y reste : elle est consommée par
                // la fabrication, qu'on la termine ou non.
                if chebyshev(here, spot) > 1 || self.pawns[i].carrying.is_none() {
                    self.abandon_job(i);
                    return;
                }
                self.pawns[i].carrying = None;
                self.next_ingredient(i, spot, recipe, usize::from(index) + 1);
            }
            CraftStage::Work { progress } => {
                if chebyshev(here, spot) > 1 {
                    self.abandon_job(i);
                    return;
                }
                let progress = progress + self.pawns[i].work_step(WorkType::Build);
                self.gain_xp(i, WorkType::Build);
                if progress < r.work_ticks * 100 {
                    self.pawns[i].job = Job::Craft {
                        spot,
                        recipe,
                        stage: CraftStage::Work { progress },
                    };
                    return;
                }
                // La pièce tombe au pied du poste : un rangeur la mettra en
                // stockage, où un colon viendra la prendre.
                self.spawn_item(recipe, 1, here.0, here.1);
                let id = self.pawns[i].id;
                self.reservations.retain(|r| r.pawn != id);
                self.pawns[i].job = Job::Idle;
                // Les armes gardent `WeaponCrafted`, que le client sait déjà
                // afficher ; le reste passe par `ItemCrafted`.
                let event = if recipe.is_weapon() {
                    EventKind::WeaponCrafted
                } else {
                    EventKind::ItemCrafted
                };
                self.push_event(event, recipe as u32);
            }
        }
    }

    /// Ramasse la part de la pile réservée qu'exige la recette, puis met le cap
    /// sur le poste.
    #[allow(clippy::too_many_arguments)]
    fn pick_ingredient(
        &mut self,
        i: usize,
        spot: (u32, u32),
        recipe: ItemKind,
        index: u8,
        item: u32,
        kind: ItemKind,
        need: u32,
    ) {
        let here = self.pawns[i].tile();
        let Some(j) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        if (self.items[j].x, self.items[j].y) != here || self.items[j].count < need {
            self.abandon_job(i);
            return;
        }
        self.items[j].count -= need;
        self.items[j].reserved_by = None;
        if self.items[j].count == 0 {
            self.items.remove(j);
        }
        self.pawns[i].carrying = Some((kind, need));
        match self.path_adjacent(here, spot) {
            Some(p) => {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Craft {
                    spot,
                    recipe,
                    stage: CraftStage::Fetch {
                        index,
                        item,
                        carried: true,
                    },
                };
            }
            None => self.abandon_job(i),
        }
    }

    /// Enchaîne sur l'ingrédient suivant (sa pile est déjà réservée) ou passe
    /// au travail quand la recette est complète.
    fn next_ingredient(&mut self, i: usize, spot: (u32, u32), recipe: ItemKind, index: usize) {
        let Some(r) = craft::recipe_for(recipe) else {
            self.abandon_job(i);
            return;
        };
        let Some(&(kind, need)) = r.inputs.get(index) else {
            self.pawns[i].job = Job::Craft {
                spot,
                recipe,
                stage: CraftStage::Work { progress: 0 },
            };
            return;
        };
        let id = self.pawns[i].id;
        let here = self.pawns[i].tile();
        let found = self
            .items
            .iter()
            .position(|s| s.kind == kind && s.reserved_by == Some(id) && s.count >= need);
        let Some(j) = found else {
            self.abandon_job(i);
            return;
        };
        let target = (self.items[j].x, self.items[j].y);
        let item = self.items[j].id;
        match path::find_path(&self.map, here, target) {
            Some(p) => {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Craft {
                    spot,
                    recipe,
                    stage: CraftStage::Fetch {
                        index: index as u8,
                        item,
                        carried: false,
                    },
                };
            }
            None => self.abandon_job(i),
        }
    }

    /// Va chercher en stockage le meilleur équipement disponible : une arme
    /// (`Bow > Spear > Club`) et un vêtement (`Coat > Tunic`). Les deux tiennent
    /// dans la même fonction parce qu'ils tiennent la même place dans l'ordre
    /// du colon — juste avant le travail — et se jouent pareil (`Job::Equip`,
    /// une pile réservée, un aller simple).
    ///
    /// Quand le colon a froid, l'habit passe devant : celui qui grelotte a plus
    /// besoin d'un manteau que d'un arc.
    fn try_start_equip(&mut self, i: usize) -> bool {
        if self.map.stockpile_count() == 0 {
            return false;
        }
        if self.pawns[i].comfort < climate::COLD_MOOD_TEMP {
            return self.try_start_wear(i) || self.try_start_arm(i);
        }
        self.try_start_arm(i) || self.try_start_wear(i)
    }

    /// L'arme : on ne redescend jamais en gamme.
    fn try_start_arm(&mut self, i: usize) -> bool {
        let current = self.pawns[i].weapon.map_or(0, |w| w.weapon_rank());
        self.try_start_gear(i, current, ItemKind::weapon_rank)
    }

    /// L'habit, seulement s'il sert : au-dessus de `climate::DRESS_TEMP`, un
    /// colon a mieux à faire que traverser la carte pour un manteau.
    ///
    /// La température de sa case se relit **sans rien recalculer** : `comfort`
    /// vient d'être posé par `tick_comfort` au même tick, isolation comprise.
    fn try_start_wear(&mut self, i: usize) -> bool {
        if self.pawns[i].comfort - self.pawns[i].insulation_tenths() >= climate::DRESS_TEMP {
            return false;
        }
        let current = self.pawns[i].apparel.map_or(0, |a| a.apparel_rank());
        self.try_start_gear(i, current, ItemKind::apparel_rank)
    }

    /// Part chercher la meilleure pile rangée dont le rang dépasse `current`.
    /// Partagée par l'arme et l'habit : seul le barème change.
    fn try_start_gear(&mut self, i: usize, current: u32, rank: fn(ItemKind) -> u32) -> bool {
        // Test sans allocation : le cas courant est « rien de rangé ».
        let usable = |s: &ItemStack| {
            rank(s.kind) > current
                && s.reserved_by.is_none()
                && s.count > 0
                && self.map.zone(s.x, s.y) == Zone::Stockpile
        };
        if !self.items.iter().any(usable) {
            return false;
        }
        let from = self.pawns[i].tile();
        // Meilleure pièce d'abord, puis la plus proche : `Reverse` renverse le
        // seul critère décroissant sans casser l'ordre total du tri.
        let mut candidates: Vec<(Reverse<u32>, u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| usable(s))
            .map(|(k, s)| {
                (
                    Reverse(rank(s.kind)),
                    chebyshev(from, (s.x, s.y)),
                    s.x,
                    s.y,
                    k,
                )
            })
            .collect();
        candidates.sort_unstable();
        for &(_, _, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = path::find_path(&self.map, from, (x, y)) {
                let id = self.pawns[i].id;
                self.items[k].reserved_by = Some(id);
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Equip { item };
                return true;
            }
        }
        false
    }

    fn do_equip(&mut self, i: usize, item: u32) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let Some(k) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        let here = self.pawns[i].tile();
        let kind = self.items[k].kind;
        // Arme ou habit : la pile dit lequel, et chacun se compare au sien.
        let better = if kind.is_apparel() {
            kind.apparel_rank() > self.pawns[i].apparel.map_or(0, |a| a.apparel_rank())
        } else {
            kind.weapon_rank() > self.pawns[i].weapon.map_or(0, |w| w.weapon_rank())
        };
        if (self.items[k].x, self.items[k].y) != here || !better {
            self.abandon_job(i);
            return;
        }
        // Arme comme habit se portent à l'unité : la pile en perd une, pas plus.
        self.items[k].count -= 1;
        self.items[k].reserved_by = None;
        if self.items[k].count == 0 {
            self.items.remove(k);
        }
        let replaced = if kind.is_apparel() {
            self.pawns[i].apparel.replace(kind)
        } else {
            self.pawns[i].weapon.replace(kind)
        };
        // Ce qu'il quitte tombe à ses pieds : un rangeur le remettra en rayon.
        if let Some(old) = replaced {
            self.spawn_item(old, 1, here.0, here.1);
        }
        self.pawns[i].job = Job::Idle;
    }

    // ------------------------------------------------------------------
    // Chasse et dépeçage
    // ------------------------------------------------------------------

    /// Le gibier est-il déjà pris en charge par un autre chasseur ?
    fn hunted_by_other(&self, i: usize, target: u32) -> bool {
        self.pawns
            .iter()
            .enumerate()
            .any(|(k, p)| k != i && matches!(p.job, Job::Hunt { target: t } if t == target))
    }

    /// Part chasser le gibier marqué le plus proche. **Un colon à mains nues
    /// ne chasse pas** : on ne court pas après un cerf pour l'étrangler.
    fn try_start_hunt(&mut self, i: usize) -> bool {
        // Deux court-circuits : pas d'arme, ou rien de marqué sur la carte.
        if self.pawns[i].weapon.is_none()
            || !self
                .pawns
                .iter()
                .any(|p| p.hunted && p.faction == Faction::Animal && p.is_alive())
        {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if !p.hunted || p.faction != Faction::Animal || !p.is_alive() {
                continue;
            }
            if self.hunted_by_other(i, p.id) {
                continue;
            }
            let (x, y) = p.tile();
            candidates.push((chebyshev(from, (x, y)), x, y, p.id));
        }
        candidates.sort_unstable();
        for &(d, x, y, target) in candidates.iter().take(PATH_ATTEMPTS) {
            // La bête bouge : le chemin sera refait à chaque tick par
            // `engage`. Ici on vérifie seulement qu'elle est atteignable, pour
            // qu'un chasseur ne parte pas après un lapin de l'autre rive.
            if d <= 1 || self.path_adjacent(from, (x, y)).is_some() {
                self.pawns[i].path.clear();
                self.pawns[i].job = Job::Hunt { target };
                return true;
            }
        }
        false
    }

    /// Poursuit et abat le gibier. Contrairement aux pillards face à un colon
    /// écroulé, **le chasseur achève une bête à terre** : la laisser agoniser
    /// n'aurait aucun sens.
    fn do_hunt(&mut self, i: usize, target: u32) {
        let hunted = self
            .pawns
            .iter()
            .any(|p| p.id == target && p.is_alive() && p.hunted);
        if !hunted {
            // Bête morte, partie, ou chasse annulée par le joueur.
            self.abandon_job(i);
            return;
        }
        if self.engage(i, target) != crate::combat::EngageOutcome::Engaged {
            self.abandon_job(i);
        }
    }

    /// Dépèce s'il y a un poste libre et une dépouille au sol. Aucun objectif à
    /// régler : dès qu'une bête est morte, on la débite (voir
    /// `craft::BUTCHER_TICKS`).
    fn try_start_butcher(&mut self, i: usize) -> bool {
        // Deux court-circuits avant tout balayage : pas de poste, pas de
        // dépouille. Le premier est un compteur, le second un test sur les piles.
        if self.map.crafting_spot_count() == 0
            || !self
                .items
                .iter()
                .any(|s| s.kind.is_animal_corpse() && s.reserved_by.is_none() && s.count > 0)
        {
            return false;
        }
        let mut spots: Vec<(u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::CraftingSpot && !self.is_reserved(x, y) {
                    spots.push((x, y));
                }
            }
        }
        if spots.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut stacks: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.is_animal_corpse() && s.reserved_by.is_none() && s.count > 0)
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        stacks.sort_unstable();
        for &(_, sx, sy, k) in stacks.iter().take(PATH_ATTEMPTS) {
            // Le poste le plus proche de la dépouille, pas du colon : c'est
            // elle qu'il va falloir porter.
            let Some(&(_, fx, fy)) = spots
                .iter()
                .map(|&(x, y)| (chebyshev((sx, sy), (x, y)), x, y))
                .min()
                .as_ref()
            else {
                return false;
            };
            if let Some(p) = path::find_path(&self.map, from, (sx, sy)) {
                let pawn = self.pawns[i].id;
                self.items[k].reserved_by = Some(pawn);
                self.reservations.push(Reservation { x: fx, y: fy, pawn });
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Butcher {
                    spot: (fx, fy),
                    item,
                    picked: false,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    fn do_butcher(&mut self, i: usize, spot: (u32, u32), item: u32, picked: bool, progress: u32) {
        if self.map.feature(spot.0, spot.1) != Feature::CraftingSpot {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            let Some(j) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[j].x, self.items[j].y) != here || !self.items[j].kind.is_animal_corpse()
            {
                self.abandon_job(i);
                return;
            }
            // Une dépouille se porte à l'unité, comme une arme.
            let kind = self.items[j].kind;
            self.items[j].count -= 1;
            self.items[j].reserved_by = None;
            if self.items[j].count == 0 {
                self.items.remove(j);
            }
            self.pawns[i].carrying = Some((kind, 1));
            match self.path_adjacent(here, spot) {
                Some(p) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Butcher {
                        spot,
                        item,
                        picked: true,
                        progress: 0,
                    };
                }
                None => self.abandon_job(i),
            }
            return;
        }
        let Some((kind, _)) = self.pawns[i].carrying else {
            self.abandon_job(i);
            return;
        };
        if chebyshev(here, spot) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Cook);
        self.gain_xp(i, WorkType::Cook);
        if progress < craft::BUTCHER_TICKS * 100 {
            self.pawns[i].job = Job::Butcher {
                spot,
                item,
                picked: true,
                progress,
            };
            return;
        }
        // La dépouille est consommée ; viande et cuir tombent au pied du poste.
        self.pawns[i].carrying = None;
        if let Some(species) = Species::from_corpse(kind) {
            self.spawn_item(ItemKind::Meat, species.meat(), here.0, here.1);
            self.spawn_item(ItemKind::Leather, species.leather(), here.0, here.1);
        }
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    fn can_sow(&self, x: u32, y: u32) -> bool {
        self.map.is_soil(x, y)
            && self.map.feature(x, y) == Feature::None
            && !self.blueprints.iter().any(|b| (b.x, b.y) == (x, y))
            && !self.items.iter().any(|s| (s.x, s.y) == (x, y))
    }

    /// Récolte les plants mûrs, sème les cases de culture libres.
    fn try_start_farm(&mut self, i: usize) -> bool {
        if self.map.growing_count() == 0 && self.crops.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        // (distance, x, y, semer) : à distance égale, la récolte passe avant le semis.
        let mut candidates: Vec<(u32, u32, u32, bool)> = Vec::new();
        for c in &self.crops {
            if self.map.feature(c.x, c.y) == Feature::CropRipe && !self.is_reserved(c.x, c.y) {
                candidates.push((chebyshev(from, (c.x, c.y)), c.x, c.y, false));
            }
        }
        if self.map.growing_count() > 0 {
            for y in 0..self.map.height() {
                for x in 0..self.map.width() {
                    if self.map.zone(x, y) == Zone::Growing
                        && self.can_sow(x, y)
                        && !self.is_reserved(x, y)
                    {
                        candidates.push((chebyshev(from, (x, y)), x, y, true));
                    }
                }
            }
        }
        candidates.sort_unstable();
        for &(_, x, y, sow) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.path_to_work(from, (x, y)) {
                let pawn = self.pawns[i].id;
                self.reservations.push(Reservation { x, y, pawn });
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Farm {
                    sow,
                    x,
                    y,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    fn do_farm(&mut self, i: usize, sow: bool, x: u32, y: u32, progress: u32) {
        let valid = if sow {
            self.map.zone(x, y) == Zone::Growing && self.can_sow(x, y)
        } else {
            self.map.feature(x, y) == Feature::CropRipe
        };
        if !valid {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), (x, y)) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Farm);
        self.gain_xp(i, WorkType::Farm);
        let needed = if sow {
            farm::SOW_TICKS * 100
        } else {
            farm::HARVEST_TICKS * 100
        };
        if progress < needed {
            self.pawns[i].job = Job::Farm {
                sow,
                x,
                y,
                progress,
            };
            return;
        }
        if sow {
            self.map.set_feature(x, y, Feature::Crop);
            self.crops.push(Crop { x, y, growth: 0 });
        } else {
            self.map.set_feature(x, y, Feature::None);
            self.crops.retain(|c| (c.x, c.y) != (x, y));
            self.spawn_item(ItemKind::Vegetables, farm::CROP_YIELD, x, y);
        }
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    /// Les plants poussent — ou pas. Sous la pluie deux fois plus vite, sous
    /// 8 °C deux fois moins, sous 0 °C plus du tout, et sous −5 °C ils peuvent
    /// geler pour de bon. La température est celle de leur case : un plant
    /// dans une pièce chauffée passe l'hiver.
    pub(crate) fn tick_crops(&mut self, outdoor: i32) {
        if self.crops.is_empty() {
            return;
        }
        let wet = self.weather.is_wet();
        let tick = self.tick;
        let mut k = 0;
        while k < self.crops.len() {
            let (x, y) = (self.crops[k].x, self.crops[k].y);
            let temperature = outdoor + self.indoor_bonus(x, y);
            if temperature < climate::CROP_KILL_TEMP
                && self.rng.chance(1, climate::CROP_KILL_CHANCE)
            {
                self.kill_crop(x, y);
                self.crops.remove(k);
                continue;
            }
            if self.crops[k].growth < farm::GROW_TICKS {
                let step = climate::growth_step(temperature, wet, tick);
                self.crops[k].growth = (self.crops[k].growth + step).min(farm::GROW_TICKS);
                if self.crops[k].growth == farm::GROW_TICKS
                    && self.map.feature(x, y) == Feature::Crop
                {
                    self.map.set_feature(x, y, Feature::CropRipe);
                }
            }
            k += 1;
        }
    }

    /// La nourriture périmée disparaît. Les jobs qui la visaient s'arrêtent
    /// d'eux-mêmes en ne la retrouvant pas.
    pub(crate) fn tick_spoilage(&mut self) {
        let now = self.tick;
        self.items.retain(|s| s.spoil_at > now);
    }

    // ------------------------------------------------------------------
    // Objets et repousse
    // ------------------------------------------------------------------

    /// Pose `count` objets en `(x, y)`, fusionnés avec une pile existante du
    /// même genre si elle a la place.
    pub fn spawn_item(&mut self, kind: ItemKind, count: u32, x: u32, y: u32) {
        if count == 0 {
            return;
        }
        let spoil_at = kind
            .shelf_life()
            .map_or(u64::MAX, |life| self.tick + u64::from(life));
        if let Some(s) = self
            .items
            .iter_mut()
            .find(|s| (s.x, s.y) == (x, y) && s.kind == kind && s.count + count <= STACK_MAX)
        {
            s.count += count;
            // La pile fusionnée se gâte à la date la plus proche.
            s.spoil_at = s.spoil_at.min(spoil_at);
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.items.push(ItemStack {
            id,
            kind,
            count,
            x,
            y,
            reserved_by: None,
            spoil_at,
        });
    }

    /// Les buissons récoltés refont leurs baies. Sous le gel, rien ne repousse :
    /// l'échéance est **repoussée**, pas perdue — le buisson repartira au
    /// premier redoux.
    pub(crate) fn tick_regrowth(&mut self, outdoor: i32) {
        if self.regrow.is_empty() {
            return;
        }
        let now = self.tick;
        let mut k = 0;
        while k < self.regrow.len() {
            if self.regrow[k].ready_at <= now {
                let (x, y) = (self.regrow[k].x, self.regrow[k].y);
                if outdoor + self.indoor_bonus(x, y) < climate::FREEZING {
                    self.regrow[k].ready_at = now + u64::from(climate::FROST_REGROW_DELAY);
                    k += 1;
                    continue;
                }
                let r = self.regrow.remove(k);
                if self.map.feature(r.x, r.y) == Feature::BushUnripe {
                    self.map.set_feature(r.x, r.y, Feature::Bush);
                }
            } else {
                k += 1;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Reservation {
    pub x: u32,
    pub y: u32,
    pub pawn: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Regrow {
    pub x: u32,
    pub y: u32,
    pub ready_at: u64,
}
