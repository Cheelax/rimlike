//! Menaces : santé, raids, combat de mêlée, mort.
//!
//! Comme le reste du sim, toutes les recherches trient leurs candidats par
//! `(distance, x, y, id)` avant de tenter un chemin : l'ordre est total, donc
//! identique sur tous les clients.

use crate::animals::BOAR_DAMAGE;
use crate::health::{
    self, BLEED_INTERVAL, BLOOD_MAX, BLOOD_REGEN_INTERVAL, DOWNED_BLOOD, DOWNED_CONSCIOUSNESS,
    UP_BLOOD, UP_CONSCIOUSNESS,
};
use crate::items::ItemKind;
use crate::map::{Feature, Map, chebyshev};
use crate::path;
use crate::pawn::{Faction, Job, NEED_MAX, Pawn};
use crate::work;
use crate::{EventKind, Sim, TICKS_PER_DAY};

/// Ticks entre deux coups d'un même pawn.
pub const ATTACK_COOLDOWN: u32 = 60;
/// Dégâts d'un colon à mains nues, bornes de `range_i32`. L'arme et la
/// compétence viennent ensuite en pourcentage (`strike_percent`).
pub const COLONIST_DAMAGE: (i32, i32) = (80, 121);
/// Dégâts d'un pillard à mains nues, bornes de `range_i32`.
pub const RAIDER_DAMAGE: (i32, i32) = (70, 111);
/// Portée d'un arc, en cases (distance de Tchebychev).
pub const BOW_RANGE: u32 = 8;
/// Ticks entre deux flèches. Un arc frappe moins souvent qu'un gourdin.
pub const RANGED_COOLDOWN: u32 = 90;
/// Dégâts d'une flèche, bornes de `range_i32`.
pub const RANGED_DAMAGE: (i32, i32) = (50, 81);
/// Précision d'un tireur débutant, en pourcentage, plus 3 par niveau.
pub const RANGED_BASE_ACCURACY: u32 = 40;
/// Jusqu'à cette distance, on tire sans malus.
pub const RANGED_SWEET_SPOT: u32 = 3;
/// Précision perdue par case au-delà de `RANGED_SWEET_SPOT`, en points.
pub const RANGED_FALLOFF: u32 = 4;
/// Un tir garde toujours cette chance de toucher.
pub const RANGED_MIN_ACCURACY: u32 = 10;

/// Efficacité au corps à corps apportée par le niveau, en pourcentage :
/// 70 % au niveau 0, 100 % au niveau 10, 130 % au niveau 20.
pub fn melee_skill_percent(level: u8) -> u32 {
    70 + 3 * u32::from(level)
}

/// Chance de toucher d'une flèche, en pourcentage : le niveau ouvre la mire,
/// la distance la referme au-delà de `RANGED_SWEET_SPOT`.
pub fn ranged_accuracy_percent(level: u8, distance: u32) -> u32 {
    let base = RANGED_BASE_ACCURACY + 3 * u32::from(level);
    let malus = RANGED_FALLOFF * distance.saturating_sub(RANGED_SWEET_SPOT);
    base.saturating_sub(malus).max(RANGED_MIN_ACCURACY)
}

/// Ligne de vue entre deux cases, tracée en Bresenham entier. Toute case
/// infranchissable coupe la vue (mur, rocher, arbre, feu, eau profonde), et
/// toute porte aussi : la v1 ne sait pas si elle est ouverte. Ni la case de
/// départ ni celle de la cible ne bloquent — on se voit de mur à mur.
pub fn line_of_sight(map: &Map, from: (u32, u32), to: (u32, u32)) -> bool {
    let (mut x, mut y) = (from.0 as i32, from.1 as i32);
    let (tx, ty) = (to.0 as i32, to.1 as i32);
    let dx = (tx - x).abs();
    let dy = -(ty - y).abs();
    let sx = if x < tx { 1 } else { -1 };
    let sy = if y < ty { 1 } else { -1 };
    let mut err = dx + dy;
    while (x, y) != (tx, ty) {
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
        if (x, y) == (tx, ty) {
            return true;
        }
        if !map.in_bounds(x, y) {
            return false;
        }
        let (ux, uy) = (x as u32, y as u32);
        if !map.passable(ux, uy) || map.feature(ux, uy).is_door() {
            return false;
        }
    }
    true
}
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
///
/// Remonté de 600 à 650 le 2026-09-05, quand les pillards sont arrivés armés
/// (gourdin puis épieu) et les colons pénalisés par le facteur de compétence
/// de mêlée. Mesuré sur 60 graines, premier raid joué jusqu'au bout :
///
/// | scénario  | avant les armes | armé, 600 | armé, **650** | armé, 700 |
/// |---|---|---|---|---|
/// | groupés : morts    |  5 | 15 | 10 |  6 |
/// | dispersés : morts  | 29 | 57 | 41 | 21 |
/// | dispersés : doubles morts | 0 | 4 | **0** | 0 |
///
/// 650 est le premier palier qui rend au scénario dispersé sa propriété
/// « jamais deux morts d'un coup » sans annuler l'effet des armes : à 700 un
/// raid armé tuerait moins qu'un raid à mains nues, ce qui n'aurait aucun sens.
pub const FLEE_HP: u32 = 650;
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

/// Ce qu'a donné un tour d'approche-et-frappe (`Sim::engage`). L'appelant
/// décide quoi faire d'un échec : un pillard repart, un chasseur abandonne son
/// gibier, un sanglier détale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EngageOutcome {
    /// La cible n'existe plus : morte, partie, ou id inconnu.
    Gone,
    /// Aucun chemin jusqu'à elle (les murs comptent).
    Unreachable,
    /// En cours : on avance, on frappe, ou on attend la fin du cooldown.
    Engaged,
}

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
        // Sous `HYPOTHERMIA_TEMP`, plus rien ne cicatrise : le froid entretient
        // les plaies, et c'est ce qui rend l'hypothermie dangereuse — sans
        // cela, une atteinte de `COLD_SEVERITY` toutes les
        // `HYPOTHERMIA_INTERVAL` guérirait plus vite qu'elle ne s'aggrave.
        let heals = self.tick % HEAL_INTERVAL_BED == 0
            && !self.pawns[i].is_starving()
            && self.pawns[i].comfort >= crate::climate::HYPOTHERMIA_TEMP
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
        // Avant la sortie rapide du raid : sinon un troupeau n'entrerait
        // jamais tant qu'un raid est en attente, c'est-à-dire presque toujours.
        if self.tick >= self.next_herd_at {
            self.spawn_herd();
            let two_days = u64::from(TICKS_PER_DAY) * 2;
            self.next_herd_at = self.tick + two_days + u64::from(self.rng.below(TICKS_PER_DAY * 2));
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
                    self.pawns[k].weapon = Some(self.raider_weapon(spawned));
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

    /// Arme du `rank`-ième pillard d'un raid. Un petit raid arrive au gourdin,
    /// un raid moyen ajoute l'épieu, un gros amène l'arc ; au-delà du
    /// troisième, la bande est panachée au hasard. Les armes tombent au sol à
    /// leur mort : plus le raid est gros, plus le butin est beau.
    fn raider_weapon(&mut self, rank: u32) -> ItemKind {
        match rank {
            0 => ItemKind::Club,
            1 => ItemKind::Spear,
            2 => ItemKind::Bow,
            _ => match self.rng.below(3) {
                0 => ItemKind::Club,
                1 => ItemKind::Spear,
                _ => ItemKind::Bow,
            },
        }
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

    pub(crate) fn is_edge_tile(&self, t: (u32, u32)) -> bool {
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

    /// Une bête compte-t-elle comme ennemi qu'on prend de soi-même ? Non :
    /// un raid ne se détourne pas sur un lapin, et un colon ne lâche pas son
    /// chantier pour un cerf qui passe (c'est la chasse, pas la défense). La
    /// seule exception est le sanglier lancé à la charge : celui-là est une
    /// menace, et les colons se défendent.
    fn is_auto_target(&self, p: &Pawn, seeker: Faction) -> bool {
        if p.faction != Faction::Animal {
            return true;
        }
        seeker == Faction::Colony
            && matches!(p.job, Job::Attack { .. })
            && p.species.is_some_and(|s| s.aggressive())
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
            .filter(|p| {
                p.is_alive()
                    && p.faction != faction
                    && !p.is_downed()
                    && self.is_auto_target(p, faction)
            })
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

    /// Approcher et frapper (ou tirer). Le cœur du combat, partagé par
    /// l'attaque (`Job::Attack`), la chasse (`Job::Hunt`) et la charge d'un
    /// sanglier : mêmes portées, mêmes cooldowns, même XP. Ce qui diffère —
    /// qui décroche, qui achève un corps à terre, ce qu'on fait après un
    /// échec — reste chez l'appelant.
    pub(crate) fn engage(&mut self, i: usize, target: u32) -> EngageOutcome {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == target && p.is_alive())
        else {
            return EngageOutcome::Gone;
        };
        let me = self.pawns[i].tile();
        let them = self.pawns[k].tile();
        let distance = chebyshev(me, them);
        if distance <= 1 {
            self.pawns[i].path.clear();
            if self.pawns[i].attack_cooldown == 0 {
                self.melee_strike(i, k);
            }
            return EngageOutcome::Engaged;
        }
        // Un tireur garde ses distances : cible en vue et à portée, il s'arrête
        // là où il est et décoche.
        if self.pawns[i].weapon == Some(ItemKind::Bow)
            && distance <= BOW_RANGE
            && line_of_sight(&self.map, me, them)
        {
            self.pawns[i].path.clear();
            if self.pawns[i].attack_cooldown == 0 {
                self.shoot(i, k, distance);
            }
            return EngageOutcome::Engaged;
        }
        // Le chemin est stocké inversé : `first()` est la destination.
        let stale = self.pawns[i]
            .path
            .first()
            .is_none_or(|&(dx, dy)| chebyshev((u32::from(dx), u32::from(dy)), them) > 1);
        if stale {
            match self.path_adjacent(me, them) {
                Some(p) => self.pawns[i].set_path(p),
                None => return EngageOutcome::Unreachable,
            }
        }
        self.pawns[i].advance(&self.map);
        EngageOutcome::Engaged
    }

    pub(crate) fn do_attack(&mut self, i: usize, target: u32) {
        if self.pawns[i].faction == Faction::Raider && self.pawns[i].hp < FLEE_HP {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Flee;
            return;
        }
        // Un pillard ne s'acharne pas sur un corps à terre : il cherche une
        // autre cible debout, ou repart.
        if self.pawns[i].faction == Faction::Raider
            && self
                .pawns
                .iter()
                .any(|p| p.id == target && p.is_alive() && p.is_downed())
        {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
            return;
        }
        if self.engage(i, target) != EngageOutcome::Engaged {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
        }
    }

    /// Un coup au corps à corps : deux tirages dans un ordre fixe, les dégâts
    /// puis la partie du corps touchée. Le coup laisse une plaie qui saigne.
    fn melee_strike(&mut self, i: usize, k: usize) {
        let faction = self.pawns[i].faction;
        let (lo, hi) = match faction {
            Faction::Colony => COLONIST_DAMAGE,
            Faction::Raider => RAIDER_DAMAGE,
            Faction::Animal => BOAR_DAMAGE,
        };
        let roll = self.rng.range_i32(lo, hi) as u32;
        // Une bête ne tient pas d'arme et n'apprend rien du combat : ses
        // dégâts sont ceux de son espèce, sans facteur.
        let percent = if faction == Faction::Animal {
            100
        } else {
            self.pawns[i].weapon.map_or(100, |w| w.melee_percent())
                * melee_skill_percent(self.pawns[i].melee.level)
                / 100
        };
        let damage = (roll * percent / 100).max(1);
        let part = health::part_for_roll(self.rng.below(health::HIT_WEIGHT_TOTAL));
        self.pawns[k].add_injury(part, damage, damage / health::BLEED_FRACTION);
        self.pawns[i].attack_cooldown = ATTACK_COOLDOWN;
        let attacker = self.pawns[i].id;
        self.animal_hit(k, Some(attacker));
        self.gain_combat_xp(i, false);
    }

    /// Une flèche : la précision est tirée d'abord (elle ne dépend que de
    /// l'état, donc l'ordre du RNG reste identique partout), puis les dégâts et
    /// la partie touchée si le tir porte. Un tir manqué forme quand même.
    fn shoot(&mut self, i: usize, k: usize, distance: u32) {
        let accuracy = ranged_accuracy_percent(self.pawns[i].ranged.level, distance);
        if self.rng.below(100) < accuracy {
            let damage = self.rng.range_i32(RANGED_DAMAGE.0, RANGED_DAMAGE.1) as u32;
            let part = health::part_for_roll(self.rng.below(health::HIT_WEIGHT_TOTAL));
            self.pawns[k].add_injury(part, damage, damage / health::BLEED_FRACTION);
            // Une flèche qui porte déclenche la fuite (ou la charge) de la
            // bête ; une flèche perdue ne l'inquiète pas.
            let attacker = self.pawns[i].id;
            self.animal_hit(k, Some(attacker));
        }
        self.pawns[i].attack_cooldown = RANGED_COOLDOWN;
        self.gain_combat_xp(i, true);
    }

    /// Fait progresser une compétence de combat : +1 par coup porté, +1 par
    /// flèche tirée. Mêmes seuils que les compétences de travail, mais hors du
    /// tableau `skills` — et seuls les colons montent en grade au journal.
    fn gain_combat_xp(&mut self, i: usize, ranged: bool) {
        // Une bête ne progresse pas : ses coups ne dépendent pas d'un niveau.
        if self.pawns[i].faction == Faction::Animal {
            return;
        }
        let colonist = self.pawns[i].faction == Faction::Colony;
        let id = self.pawns[i].id;
        let skill = if ranged {
            &mut self.pawns[i].ranged
        } else {
            &mut self.pawns[i].melee
        };
        skill.xp += 1;
        if skill.xp >= work::xp_to_next(skill.level) && skill.level < work::SKILL_MAX {
            skill.level += 1;
            skill.xp = 0;
            if colonist {
                self.push_event(EventKind::LevelUp, id);
            }
        }
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
                match (p.faction, p.species) {
                    // Une bête laisse sa dépouille, pas un cadavre humain :
                    // celle-là se transporte et se dépèce.
                    (Faction::Animal, Some(species)) => {
                        self.spawn_item(species.corpse_kind(), 1, x, y);
                        self.push_event(EventKind::AnimalHunted, species as u32);
                    }
                    (Faction::Animal, None) => {}
                    (faction, _) => {
                        // L'arme du mort tombe là : butin pour la colonie quand
                        // c'est un pillard, arme à ramasser quand c'est un des
                        // siens. Un fuyard, lui, repart avec la sienne.
                        if let Some(weapon) = p.weapon {
                            self.spawn_item(weapon, 1, x, y);
                        }
                        self.spawn_item(ItemKind::Corpse, 1, x, y);
                        if faction == Faction::Colony {
                            for q in &mut self.pawns {
                                if q.faction == Faction::Colony {
                                    q.grief_ticks = GRIEF_TICKS;
                                }
                            }
                            self.push_event(EventKind::ColonistDied, p.id);
                        } else {
                            self.push_event(EventKind::RaiderDied, p.id);
                        }
                    }
                }
            } else if p.faction == Faction::Raider {
                self.push_event(EventKind::RaiderLeft, p.id);
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Terrain;
    use crate::testmap::map_from;

    #[test]
    fn la_vue_porte_a_travers_le_vide_et_bute_sur_les_obstacles() {
        let m = map_from(&["......", "..#...", "......"]);
        assert!(line_of_sight(&m, (0, 0), (0, 0)), "on se voit soi-même");
        assert!(line_of_sight(&m, (0, 0), (5, 0)), "ligne droite dégagée");
        assert!(line_of_sight(&m, (0, 2), (5, 2)), "sous l'obstacle");
        assert!(!line_of_sight(&m, (0, 1), (5, 1)), "rocher en (2, 1)");
        // La case de la cible ne bloque jamais : on vise ce qui est dessus.
        assert!(
            line_of_sight(&m, (0, 1), (2, 1)),
            "tir sur la case du rocher"
        );
        assert!(line_of_sight(&m, (2, 0), (2, 1)), "cible juste à côté");
    }

    #[test]
    fn une_porte_coupe_la_vue_mais_pas_l_eau_peu_profonde() {
        let mut m = map_from(&["....."]);
        assert!(line_of_sight(&m, (0, 0), (4, 0)));
        m.set_terrain(2, 0, Terrain::ShallowWater);
        assert!(
            line_of_sight(&m, (0, 0), (4, 0)),
            "un gué se traverse du regard"
        );
        m.set_terrain(2, 0, Terrain::DeepWater);
        assert!(
            !line_of_sight(&m, (0, 0), (4, 0)),
            "l'eau profonde est un trou"
        );
        m.set_terrain(2, 0, Terrain::Grass);
        m.set_feature(2, 0, Feature::DoorWood);
        assert!(
            !line_of_sight(&m, (0, 0), (4, 0)),
            "une porte est franchissable mais opaque en v1"
        );
    }

    #[test]
    fn la_precision_baisse_avec_la_distance_et_monte_avec_le_niveau() {
        // Sous `RANGED_SWEET_SPOT`, seul le niveau compte.
        assert_eq!(ranged_accuracy_percent(0, 1), RANGED_BASE_ACCURACY);
        assert_eq!(ranged_accuracy_percent(0, 3), RANGED_BASE_ACCURACY);
        assert_eq!(ranged_accuracy_percent(10, 3), RANGED_BASE_ACCURACY + 30);
        // Au-delà, chaque case coûte `RANGED_FALLOFF` points.
        assert_eq!(
            ranged_accuracy_percent(0, 8),
            RANGED_BASE_ACCURACY - 5 * RANGED_FALLOFF
        );
        // Un débutant qui tire au bout de sa portée garde sa chance minimale.
        assert_eq!(ranged_accuracy_percent(0, 100), RANGED_MIN_ACCURACY);
        assert!(ranged_accuracy_percent(20, BOW_RANGE) <= 100);
        // La compétence de mêlée va de 70 % à 130 %.
        assert_eq!(melee_skill_percent(0), 70);
        assert_eq!(melee_skill_percent(crate::work::SKILL_MAX), 130);
    }
}
