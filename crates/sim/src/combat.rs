//! Menaces : santé, raids, combat de mêlée, mort.
//!
//! Comme le reste du sim, toutes les recherches trient leurs candidats par
//! `(distance, x, y, id)` avant de tenter un chemin : l'ordre est total, donc
//! identique sur tous les clients.

use crate::health::{
    self, BLEED_INTERVAL, BLOOD_MAX, BLOOD_REGEN_INTERVAL, DOWNED_BLOOD, DOWNED_CONSCIOUSNESS,
    UP_BLOOD, UP_CONSCIOUSNESS,
};
use crate::items::ItemKind;
use crate::map::{Feature, chebyshev};
use crate::path;
use crate::pawn::{Faction, Job, NEED_MAX};
use crate::{EventKind, Sim, TICKS_PER_DAY};

/// Ticks entre deux coups d'un même pawn.
pub const ATTACK_COOLDOWN: u32 = 60;
/// Dégâts d'un colon, bornes de `range_i32`.
pub const COLONIST_DAMAGE: (i32, i32) = (80, 121);
/// Dégâts d'un pillard, bornes de `range_i32`.
pub const RAIDER_DAMAGE: (i32, i32) = (70, 111);
/// Un colon attaque de lui-même un ennemi jusqu'à cette distance.
pub const DEFEND_RADIUS: u32 = 8;
/// En dessous de ces PV, un pillard décroche et quitte la carte. Assez haut
/// pour qu'un pillard lâche prise après une bonne raclée (environ 40 % de
/// sévérité cumulée) plutôt que de s'acharner jusqu'à l'agonie : un colon
/// pris à part (occupé loin des autres au moment du raid, cas courant en
/// vraie partie) a le temps de se faire mal sans que ça tourne
/// systématiquement au drame. `first_raid_is_dangerous_but_survivable`
/// (colons groupés à l'arrivée du raid) passe déjà à 300 : c'est un scénario
/// mesuré à part (trois colons envoyés aux coins de la carte avant le raid,
/// hors suite de tests) qui a servi de vraie jauge — à 300, ce scénario
/// dispersé perdait souvent deux colons sur 200 graines ; à 600, plus aucun
/// double mort, pour une baisse de moitié seulement du total des morts.
pub const FLEE_HP: u32 = 600;
/// Un pawn à jeun perd 1 PV tous ces ticks.
pub const STARVE_DAMAGE_INTERVAL: u64 = 28;
/// Un pawn nourri regagne 1 PV tous ces ticks.
pub const HEAL_INTERVAL: u64 = 60;
/// Deux fois plus vite au lit.
pub const HEAL_INTERVAL_BED: u64 = 30;
// `tick_injuries` s'appuie dessus pour ne consulter la carte qu'un tick sur
// `HEAL_INTERVAL_BED` : le plus long des deux intervalles doit être un
// multiple du plus court.
const _: () = assert!(HEAL_INTERVAL % HEAL_INTERVAL_BED == 0);
/// Jours de tranquillité avant le premier raid.
pub const GRACE_DAYS: u32 = 3;
/// Durée du deuil après la mort d'un colon.
pub const GRIEF_TICKS: u32 = TICKS_PER_DAY * 2;
/// Taille maximale d'un raid.
pub const MAX_RAIDERS: u32 = 6;

/// Nombre de cibles pour lesquelles on tente un chemin par recherche.
const MELEE_TARGETS: usize = 3;
/// Nombre de cases de bord testées par un fuyard.
const FLEE_ATTEMPTS: usize = 6;
/// Tirages de case d'entrée avant d'abandonner un raid.
const ENTRY_DRAWS: u32 = 12;

impl Sim {
    // ------------------------------------------------------------------
    // Santé
    // ------------------------------------------------------------------

    /// Faim qui ronge, plaies qui se referment et cicatrisent, sang qui se
    /// perd ou se refait, écroulement et relevé, minuteries de combat et de
    /// deuil. Le chemin d'un pawn en pleine forme reste court : deux tests.
    pub(crate) fn tick_health(&mut self, i: usize) {
        if self.pawns[i].hunger == 0 && self.tick % STARVE_DAMAGE_INTERVAL == 0 {
            // La famine n'entame plus les PV directement : elle affaiblit le torse.
            self.pawns[i].starve_torso();
        }
        if !self.pawns[i].injuries.is_empty() {
            self.tick_injuries(i);
        }
        self.tick_blood(i);
        self.update_downed(i);
        self.pawns[i].attack_cooldown = self.pawns[i].attack_cooldown.saturating_sub(1);
        self.pawns[i].grief_ticks = self.pawns[i].grief_ticks.saturating_sub(1);
        self.pawns[i].relief_ticks = self.pawns[i].relief_ticks.saturating_sub(1);
    }

    /// Referme les plaies au bout de `BLEED_TICKS`, fait cicatriser d'un point
    /// par intervalle (deux fois plus vite si la blessure est pansée) et
    /// oublie les blessures guéries.
    fn tick_injuries(&mut self, i: usize) {
        // `HEAL_INTERVAL` est un multiple de `HEAL_INTERVAL_BED` : hors de ces
        // ticks-là, aucune cicatrisation n'est possible et on s'épargne le
        // coup d'œil à la carte (le saignement, lui, s'écoule à chaque tick).
        let heals = self.tick % HEAL_INTERVAL_BED == 0
            && !self.pawns[i].is_starving()
            && self.tick % self.heal_interval(i) == 0;
        let p = &mut self.pawns[i];
        for inj in &mut p.injuries {
            if inj.bleeding > 0 {
                inj.bleed_ticks = inj.bleed_ticks.saturating_sub(1);
                if inj.bleed_ticks == 0 {
                    inj.close();
                }
            }
            if heals {
                inj.severity = inj.severity.saturating_sub(if inj.tended { 2 } else { 1 });
            }
        }
        if heals {
            p.injuries.retain(|inj| inj.severity > 0);
            p.recompute_hp();
        }
    }

    /// Un blessé allongé — endormi ou à terre — cicatrise deux fois plus vite.
    fn heal_interval(&self, i: usize) -> u64 {
        let (x, y) = self.pawns[i].tile();
        let in_bed = matches!(self.pawns[i].job, Job::Sleep { in_bed: true } | Job::Downed)
            && !self.pawns[i].is_moving()
            && self.map.feature(x, y) == Feature::Bed;
        if in_bed {
            HEAL_INTERVAL_BED
        } else {
            HEAL_INTERVAL
        }
    }

    /// Le sang se perd par tranches de `BLEED_INTERVAL` ticks et se refait
    /// lentement dès qu'aucune plaie ne coule.
    fn tick_blood(&mut self, i: usize) {
        let tick = self.tick;
        let p = &mut self.pawns[i];
        if p.injuries.is_empty() {
            // Cas courant : rien ne coule, le corps se refait doucement.
            if p.blood < BLOOD_MAX && tick % BLOOD_REGEN_INTERVAL == 0 {
                p.blood += 1;
            }
            return;
        }
        let rate = p.bleed_rate();
        if rate > 0 {
            if tick % BLEED_INTERVAL == 0 {
                p.blood = p.blood.saturating_sub(rate);
                // Le sang à zéro tue : `recompute_hp` s'en charge.
                p.recompute_hp();
            }
        } else if p.blood < BLOOD_MAX && tick % BLOOD_REGEN_INTERVAL == 0 {
            p.blood += 1;
        }
    }

    /// Fait tomber ou relever le pawn. L'hystérésis (30/40 %) évite qu'un
    /// blessé clignote entre les deux états.
    fn update_downed(&mut self, i: usize) {
        let p = &self.pawns[i];
        if p.is_downed() {
            if p.consciousness_percent() >= UP_CONSCIOUSNESS && p.blood >= UP_BLOOD {
                self.pawns[i].job = Job::Idle;
                self.pawns[i].idle_ticks = 0;
            }
            return;
        }
        // Sortie rapide : sans blessure et avec du sang, personne ne s'écroule.
        if p.injuries.is_empty() && p.blood >= UP_BLOOD {
            return;
        }
        if p.consciousness_percent() >= DOWNED_CONSCIOUSNESS && p.blood >= DOWNED_BLOOD {
            return;
        }
        // Il lâche tout : réservations, chargement, et le blessé qu'il portait.
        self.abandon_job(i);
        self.pawns[i].job = Job::Downed;
        if self.pawns[i].faction == Faction::Colony {
            let id = self.pawns[i].id;
            self.push_event(EventKind::ColonistDowned, id);
        }
    }

    // ------------------------------------------------------------------
    // Storyteller
    // ------------------------------------------------------------------

    /// Programme le premier raid, après quelques jours de répit.
    pub(crate) fn schedule_first_raid(&mut self) {
        let grace = u64::from(TICKS_PER_DAY) * u64::from(GRACE_DAYS);
        self.next_raid_at = grace + u64::from(self.rng.below(TICKS_PER_DAY / 2));
    }

    /// Déclenche les événements à l'heure dite et programme les suivants.
    pub(crate) fn tick_storyteller(&mut self) {
        if self.tick >= self.next_wanderer_at {
            self.spawn_wanderer();
            let three_days = u64::from(TICKS_PER_DAY) * 3;
            self.next_wanderer_at =
                self.tick + three_days + u64::from(self.rng.below(TICKS_PER_DAY * 2));
        }
        if self.tick < self.next_raid_at {
            return;
        }
        self.spawn_raid();
        let two_days = u64::from(TICKS_PER_DAY) * 2;
        self.next_raid_at = self.tick + two_days + u64::from(self.rng.below(TICKS_PER_DAY * 2));
    }

    /// Case de bord d'où la colonie est vraiment atteignable : sinon un
    /// arrivant resterait planté derrière un mur ou de l'eau.
    pub(crate) fn find_entry_tile(&mut self) -> Option<(u32, u32)> {
        let colonists = self.living_tiles(Faction::Colony);
        if colonists.is_empty() {
            return None;
        }
        let edges = self.edge_tiles();
        if edges.is_empty() {
            return None;
        }
        for _ in 0..ENTRY_DRAWS {
            let e = edges[self.rng.below(edges.len() as u32) as usize];
            if self.can_reach_any(e, &colonists) {
                return Some(e);
            }
        }
        None
    }

    /// Un colon de passage s'installe. Renvoie vrai s'il a trouvé sa place.
    pub fn spawn_wanderer(&mut self) -> bool {
        if self
            .pawns
            .iter()
            .all(|p| !p.is_alive() || p.faction != Faction::Colony)
        {
            return false;
        }
        let Some(entry) = self.find_entry_tile() else {
            return false;
        };
        let mut r: i32 = 0;
        while r < 8 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let x = entry.0 as i32 + dx;
                    let y = entry.1 as i32 + dy;
                    if !self.map.in_bounds(x, y) {
                        continue;
                    }
                    let tile = (x as u32, y as u32);
                    if !self.map.passable(tile.0, tile.1)
                        || self.pawns.iter().any(|p| p.tile() == tile)
                    {
                        continue;
                    }
                    // `Pawn::at_tile` donne déjà la colonie et les priorités par défaut ;
                    // `spawn_pawn` tire son nom et ses compétences de départ.
                    let id = self.spawn_pawn(tile.0, tile.1, Faction::Colony);
                    let k = self.pawns.len() - 1;
                    self.pawns[k].hunger = 600_000;
                    self.pawns[k].rest = 700_000;
                    self.push_event(EventKind::WandererJoined, id);
                    return true;
                }
            }
            r += 1;
        }
        false
    }

    /// Fait entrer un groupe de pillards par un bord de la carte depuis lequel
    /// la colonie est atteignable. Renvoie le nombre de pillards apparus.
    pub fn spawn_raid(&mut self) -> u32 {
        let colonists = self.living_tiles(Faction::Colony);
        if colonists.is_empty() {
            return 0;
        }
        let count = (1 + colonists.len() as u32 / 2).min(MAX_RAIDERS);
        let Some(entry) = self.find_entry_tile() else {
            return 0;
        };
        let mut spawned = 0;
        let mut r: i32 = 0;
        while spawned < count && r < 8 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if spawned >= count || (dx.abs() != r && dy.abs() != r) {
                        continue;
                    }
                    let x = entry.0 as i32 + dx;
                    let y = entry.1 as i32 + dy;
                    if !self.map.in_bounds(x, y) {
                        continue;
                    }
                    let tile = (x as u32, y as u32);
                    if !self.map.passable(tile.0, tile.1)
                        || self.pawns.iter().any(|p| p.tile() == tile)
                    {
                        continue;
                    }
                    self.spawn_pawn(tile.0, tile.1, Faction::Raider);
                    let k = self.pawns.len() - 1;
                    self.pawns[k].hunger = NEED_MAX;
                    self.pawns[k].rest = NEED_MAX;
                    spawned += 1;
                }
            }
            r += 1;
        }
        if spawned > 0 {
            self.push_event(EventKind::Raid, spawned);
        }
        spawned
    }

    /// Cases des pawns vivants d'un camp, dans l'ordre des indices.
    fn living_tiles(&self, faction: Faction) -> Vec<(u32, u32, u32)> {
        self.pawns
            .iter()
            .filter(|p| p.is_alive() && p.faction == faction)
            .map(|p| {
                let (x, y) = p.tile();
                (x, y, p.id)
            })
            .collect()
    }

    /// Cases franchissables du bord, dans un ordre fixe : rangée du haut,
    /// rangée du bas, puis les colonnes de gauche et de droite.
    fn edge_tiles(&self) -> Vec<(u32, u32)> {
        let (w, h) = (self.map.width(), self.map.height());
        let mut out = Vec::new();
        if w == 0 || h == 0 {
            return out;
        }
        for x in 0..w {
            if self.map.passable(x, 0) {
                out.push((x, 0));
            }
        }
        if h > 1 {
            for x in 0..w {
                if self.map.passable(x, h - 1) {
                    out.push((x, h - 1));
                }
            }
        }
        for y in 1..h.saturating_sub(1) {
            if self.map.passable(0, y) {
                out.push((0, y));
            }
            if w > 1 && self.map.passable(w - 1, y) {
                out.push((w - 1, y));
            }
        }
        out
    }

    fn is_edge_tile(&self, t: (u32, u32)) -> bool {
        t.0 == 0 || t.1 == 0 || t.0 + 1 >= self.map.width() || t.1 + 1 >= self.map.height()
    }

    /// Y a-t-il un chemin de `from` jusqu'au voisinage d'une des cibles ?
    fn can_reach_any(&self, from: (u32, u32), targets: &[(u32, u32, u32)]) -> bool {
        let mut sorted: Vec<(u32, u32, u32, u32)> = targets
            .iter()
            .map(|&(x, y, id)| (chebyshev(from, (x, y)), x, y, id))
            .collect();
        sorted.sort_unstable();
        sorted
            .iter()
            .take(MELEE_TARGETS)
            .any(|&(d, x, y, _)| d <= 1 || self.path_adjacent(from, (x, y)).is_some())
    }

    // ------------------------------------------------------------------
    // Décision
    // ------------------------------------------------------------------

    /// Un colon qui voit un ennemi à portée lâche ce qu'il fait et l'attaque.
    /// Renvoie vrai s'il vient de s'y mettre.
    pub(crate) fn defend_if_threatened(&mut self, i: usize) -> bool {
        if matches!(
            self.pawns[i].job,
            Job::Attack { .. } | Job::Move { manual: true }
        ) {
            return false;
        }
        let Some(id) = self.nearest_reachable_enemy(i, DEFEND_RADIUS) else {
            return false;
        };
        self.abandon_job(i);
        self.pawns[i].job = Job::Attack { target: id };
        true
    }

    /// Un pillard fonce sur le colon accessible le plus proche, ou décroche.
    pub(crate) fn raider_ai(&mut self, i: usize) {
        if self.pawns[i].hp < FLEE_HP {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Flee;
            return;
        }
        match self.nearest_reachable_enemy(i, u32::MAX) {
            // Personne d'atteignable (les murs comptent) : on repart.
            None => {
                self.pawns[i].path.clear();
                self.pawns[i].job = Job::Flee;
            }
            Some(id) => self.pawns[i].job = Job::Attack { target: id },
        }
    }

    /// Id de l'ennemi vivant le plus proche dans `radius`, parmi les
    /// `MELEE_TARGETS` premiers pour lesquels un chemin existe. Les pawns à
    /// terre ne sont jamais visés d'eux-mêmes : les pillards passent devant un
    /// colon écroulé sans s'y arrêter, ce qui laisse une chance au sauvetage.
    /// Un ordre explicite du joueur (`Command::Attack`) reste possible.
    fn nearest_reachable_enemy(&self, i: usize, radius: u32) -> Option<u32> {
        let me = self.pawns[i].tile();
        let faction = self.pawns[i].faction;
        let mut enemies: Vec<(u32, u32, u32, u32)> = self
            .pawns
            .iter()
            .filter(|p| p.is_alive() && p.faction != faction && !p.is_downed())
            .map(|p| {
                let (x, y) = p.tile();
                (chebyshev(me, (x, y)), x, y, p.id)
            })
            .filter(|&(d, ..)| d <= radius)
            .collect();
        enemies.sort_unstable();
        enemies
            .iter()
            .take(MELEE_TARGETS)
            .find(|&&(d, x, y, _)| d <= 1 || self.path_adjacent(me, (x, y)).is_some())
            .map(|&(.., id)| id)
    }

    // ------------------------------------------------------------------
    // Exécution
    // ------------------------------------------------------------------

    pub(crate) fn do_attack(&mut self, i: usize, target: u32) {
        if self.pawns[i].faction == Faction::Raider && self.pawns[i].hp < FLEE_HP {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Flee;
            return;
        }
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == target && p.is_alive())
        else {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
            return;
        };
        // Un pillard ne s'acharne pas sur un corps à terre : il cherche une
        // autre cible debout, ou repart.
        if self.pawns[i].faction == Faction::Raider && self.pawns[k].is_downed() {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
            return;
        }
        let me = self.pawns[i].tile();
        let them = self.pawns[k].tile();
        if chebyshev(me, them) <= 1 {
            self.pawns[i].path.clear();
            if self.pawns[i].attack_cooldown == 0 {
                let (lo, hi) = if self.pawns[i].faction == Faction::Colony {
                    COLONIST_DAMAGE
                } else {
                    RAIDER_DAMAGE
                };
                // Deux tirages dans un ordre fixe : les dégâts, puis la partie
                // du corps touchée. Le coup laisse une plaie qui saigne.
                let damage = self.rng.range_i32(lo, hi) as u32;
                let part = health::part_for_roll(self.rng.below(health::HIT_WEIGHT_TOTAL));
                self.pawns[k].add_injury(part, damage, damage / health::BLEED_FRACTION);
                self.pawns[i].attack_cooldown = ATTACK_COOLDOWN;
            }
            return;
        }
        // Le chemin est stocké inversé : `first()` est la destination.
        let stale = self.pawns[i]
            .path
            .first()
            .is_none_or(|&(dx, dy)| chebyshev((u32::from(dx), u32::from(dy)), them) > 1);
        if stale {
            match self.path_adjacent(me, them) {
                Some(p) => self.pawns[i].set_path(p),
                None => {
                    self.pawns[i].path.clear();
                    self.pawns[i].job = Job::Idle;
                    return;
                }
            }
        }
        self.pawns[i].advance(&self.map);
    }

    pub(crate) fn do_flee(&mut self, i: usize) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let me = self.pawns[i].tile();
        if self.is_edge_tile(me) {
            self.pawns[i].gone = true;
            return;
        }
        let mut edges: Vec<(u32, u32, u32)> = self
            .edge_tiles()
            .into_iter()
            .map(|(x, y)| (chebyshev(me, (x, y)), x, y))
            .collect();
        edges.sort_unstable();
        for &(_, x, y) in edges.iter().take(FLEE_ATTEMPTS) {
            let Some(p) = path::find_path(&self.map, me, (x, y)) else {
                continue;
            };
            if p.is_empty() {
                self.pawns[i].gone = true;
            } else {
                self.pawns[i].set_path(p);
            }
            return;
        }
        // Aucun bord atteignable : le pillard disparaît plutôt que de rester
        // coincé pour l'éternité.
        self.pawns[i].gone = true;
    }

    // ------------------------------------------------------------------
    // Nettoyage
    // ------------------------------------------------------------------

    /// Retire les pawns morts ou partis, libère leurs réservations, pose ce
    /// qu'ils portaient et laisse un cadavre derrière les morts.
    pub(crate) fn remove_dead(&mut self) {
        let mut i = 0;
        while i < self.pawns.len() {
            if self.pawns[i].is_alive() {
                i += 1;
                continue;
            }
            let p = self.pawns.remove(i);
            self.reservations.retain(|r| r.pawn != p.id);
            for q in &mut self.pawns {
                if q.carrying_pawn == Some(p.id) {
                    q.carrying_pawn = None;
                }
            }
            for s in &mut self.items {
                if s.reserved_by == Some(p.id) {
                    s.reserved_by = None;
                }
            }
            for b in &mut self.blueprints {
                if b.reserved_by == Some(p.id) {
                    b.reserved_by = None;
                }
            }
            let (x, y) = p.tile();
            if let Some((kind, count)) = p.carrying {
                self.spawn_item(kind, count, x, y);
            }
            if p.hp == 0 {
                self.spawn_item(ItemKind::Corpse, 1, x, y);
                match p.faction {
                    Faction::Colony => {
                        for q in &mut self.pawns {
                            if q.faction == Faction::Colony {
                                q.grief_ticks = GRIEF_TICKS;
                            }
                        }
                        self.push_event(EventKind::ColonistDied, p.id);
                    }
                    Faction::Raider => self.push_event(EventKind::RaiderDied, p.id),
                }
            } else if p.faction == Faction::Raider {
                self.push_event(EventKind::RaiderLeft, p.id);
            }
        }
    }
}
