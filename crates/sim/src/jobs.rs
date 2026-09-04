//! Comportement des colons : besoins, recherche de travail, exécution des jobs.
//! Toutes les recherches parcourent des `Vec` dans l'ordre des indices et
//! départagent par distance puis coordonnées : déterministe.
//!
//! Ordre de priorité d'un colon libre : dormir > manger > construire > livrer
//! des matériaux > travail désigné > ranger > flâner.

use crate::build;
use crate::items::{ItemKind, ItemStack, STACK_MAX};
use crate::map::{Designation, Feature, Zone, chebyshev};
use crate::path;
use crate::pawn::{
    BERRY_NUTRITION, HUNGER_DECAY, Job, MEAL_BERRIES, NEED_MAX, REST_DECAY, REST_RECOVERY, RESTED,
};
use crate::{Sim, TICKS_PER_DAY};

/// Nombre maximal de candidats pour lesquels on tente un A* par recherche.
const PATH_ATTEMPTS: usize = 6;

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
    pub(crate) fn tick_pawn(&mut self, i: usize) {
        self.decay_needs(i);
        if self.pawns[i].is_starving()
            && !matches!(
                self.pawns[i].job,
                Job::Eat { .. } | Job::Sleep { .. } | Job::Move { manual: true }
            )
            && self.food_available()
        {
            self.abandon_job(i);
        }
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
        self.pawns[i].path.clear();
        self.pawns[i].job = Job::Idle;
    }

    fn drop_carried(&mut self, i: usize) {
        if let Some((kind, count)) = self.pawns[i].carrying.take() {
            let (x, y) = self.pawns[i].tile();
            self.spawn_item(kind, count, x, y);
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
        if self.try_start_build(i)
            || self.try_start_deliver(i)
            || self.try_start_work(i)
            || self.try_start_haul(i)
        {
            return;
        }
        self.idle_wander(i);
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
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::Bed && !self.bed_occupied_by_other(i, (x, y))
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
                && matches!(p.job, Job::Sleep { in_bed: true })
                && !p.is_moving()
        })
    }

    fn try_start_eat(&mut self, i: usize) -> bool {
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.is_food() && s.reserved_by.is_none())
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        candidates.sort_unstable();
        for &(_, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
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
    fn path_adjacent(&self, from: (u32, u32), target: (u32, u32)) -> Option<Vec<path::Tile>> {
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
            .filter(|(_, s)| s.reserved_by.is_none() && !self.is_stored(s))
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
        let progress = progress + 1;
        if progress < kind.work_ticks() {
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
        let hunger = self.pawns[i].hunger;
        let wanted = (NEED_MAX - hunger).div_ceil(BERRY_NUTRITION).max(1);
        let n = wanted.min(MEAL_BERRIES).min(self.items[k].count);
        self.pawns[i].hunger = (hunger + n * BERRY_NUTRITION).min(NEED_MAX);
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
        self.blueprints[k].progress += 1;
        if self.blueprints[k].progress < kind.work_ticks() {
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
    // Objets et repousse
    // ------------------------------------------------------------------

    /// Pose `count` objets en `(x, y)`, fusionnés avec une pile existante du
    /// même genre si elle a la place.
    pub fn spawn_item(&mut self, kind: ItemKind, count: u32, x: u32, y: u32) {
        if count == 0 {
            return;
        }
        if let Some(s) = self
            .items
            .iter_mut()
            .find(|s| (s.x, s.y) == (x, y) && s.kind == kind && s.count + count <= STACK_MAX)
        {
            s.count += count;
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
        });
    }

    pub(crate) fn tick_regrowth(&mut self) {
        let now = self.tick;
        let mut k = 0;
        while k < self.regrow.len() {
            if self.regrow[k].ready_at <= now {
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
