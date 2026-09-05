//! Faune : espèces, apparition, comportement.
//!
//! Un animal est un `Pawn` comme un autre — même santé, même pathfinding,
//! mêmes tampons de rendu — avec `Faction::Animal` et une `species`. C'est le
//! choix qui avait déjà été fait pour les pillards (`docs/PLAN.md`, journal du
//! 2026-09-04) : seule la boucle de décision diffère.
//!
//! Ce qu'une bête n'a pas : ni besoin (elle ne mange ni ne dort dans cette
//! tranche), ni compétence, ni arme, ni humeur qui compte. Ce qu'elle a en
//! plus : une échéance de fuite (`Pawn::flee_until`), une échéance de pâture
//! (`Pawn::graze_at`) et un marqueur de chasse (`Pawn::hunted`).
//!
//! Les animaux ne sont **ni ciblés par les pillards ni par la défense
//! automatique** des colons : un raid ne se détourne pas sur un lapin. La
//! seule exception est le sanglier qui charge — il devient alors une menace
//! comme une autre (voir `Sim::is_auto_target`).

use serde::{Deserialize, Serialize};

use crate::combat::EngageOutcome;
use crate::items::ItemKind;
use crate::map::{Map, chebyshev};
use crate::path::Tile;
use crate::pawn::{Faction, Job, NEED_MAX, Pawn};
use crate::{EventKind, Sim, TICKS_PER_DAY};

/// Espèce d'un animal. Les valeurs sont un contrat avec le client (tampon
/// `animals` de `sim-wasm`, `arg` de `EventKind::AnimalHunted`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Species {
    Deer = 0,
    Rabbit = 1,
    Boar = 2,
}

/// Nombre d'espèces.
pub const SPECIES_COUNT: usize = 3;

impl Species {
    /// Dans l'ordre des valeurs.
    pub const ALL: [Species; SPECIES_COUNT] = [Species::Deer, Species::Rabbit, Species::Boar];

    pub fn from_u8(v: u8) -> Species {
        match v {
            1 => Species::Rabbit,
            2 => Species::Boar,
            _ => Species::Deer,
        }
    }

    /// Nom affiché : une bête n'a pas de prénom, elle porte son espèce.
    pub fn label(self) -> &'static str {
        match self {
            Species::Deer => "Cerf",
            Species::Rabbit => "Lapin",
            Species::Boar => "Sanglier",
        }
    }

    /// Vitesse en pourcentage de `pawn::BASE_SPEED` : le lapin détale, le
    /// sanglier pèse.
    pub fn speed_percent(self) -> u32 {
        match self {
            Species::Deer => 110,
            Species::Rabbit => 130,
            Species::Boar => 90,
        }
    }

    /// Points de vie d'une bête entière (plafond de `Pawn::recompute_hp`).
    pub fn max_hp(self) -> u32 {
        match self {
            Species::Deer => 600,
            Species::Rabbit => 150,
            Species::Boar => 800,
        }
    }

    /// Viande tirée d'un dépeçage.
    pub fn meat(self) -> u32 {
        match self {
            Species::Deer => 12,
            Species::Rabbit => 2,
            Species::Boar => 16,
        }
    }

    /// Cuir tiré d'un dépeçage. Un lapin n'en donne pas.
    pub fn leather(self) -> u32 {
        match self {
            Species::Deer => 3,
            Species::Rabbit => 0,
            Species::Boar => 4,
        }
    }

    /// Une bête agressive ne fuit pas le premier coup : elle charge. C'est
    /// aussi la seule qui, apprivoisée, rejoint la défense de la colonie
    /// (voir `livestock`).
    pub fn aggressive(self) -> bool {
        self == Species::Boar
    }

    /// Facilité d'apprivoisement, en pourcentage de la chance de base
    /// (`livestock::TAME_BASE_NUM`) : le lapin se laisse faire, le cerf est
    /// farouche, le sanglier ne veut rien savoir.
    pub fn tame_percent(self) -> u32 {
        match self {
            Species::Deer => 100,
            Species::Rabbit => 150,
            Species::Boar => 60,
        }
    }

    /// Jours entre deux naissances quand la colonie tient au moins deux bêtes
    /// de l'espèce (voir `Sim::tick_breeding`). Le lapin fait ce que fait un
    /// lapin ; le cerf prend son temps.
    pub fn breed_days(self) -> u32 {
        match self {
            Species::Deer => 8,
            Species::Rabbit => 3,
            Species::Boar => 6,
        }
    }

    /// Ce qu'une bête apprivoisée vaut dans la richesse de la colonie
    /// (`Sim::wealth`). Modeste devant un colon (100) : un troupeau attire les
    /// convoitises, il ne les déchaîne pas.
    pub fn wealth_value(self) -> u32 {
        match self {
            Species::Deer => 30,
            Species::Rabbit => 15,
            Species::Boar => 40,
        }
    }

    /// Genre de cadavre laissé à la mort. Un genre par espèce : `ItemStack`
    /// ne porte aucune métadonnée, c'est le genre qui dit ce qu'on dépèce.
    pub fn corpse_kind(self) -> ItemKind {
        match self {
            Species::Deer => ItemKind::DeerCorpse,
            Species::Rabbit => ItemKind::RabbitCorpse,
            Species::Boar => ItemKind::BoarCorpse,
        }
    }

    /// Espèce dont vient ce cadavre, `None` pour tout le reste (le cadavre
    /// humain compris : on ne dépèce pas les siens).
    pub fn from_corpse(kind: ItemKind) -> Option<Species> {
        match kind {
            ItemKind::DeerCorpse => Some(Species::Deer),
            ItemKind::RabbitCorpse => Some(Species::Rabbit),
            ItemKind::BoarCorpse => Some(Species::Boar),
            _ => None,
        }
    }
}

/// Animaux vivants au plus sur une carte. Au-delà, les troupeaux n'entrent plus.
pub const MAX_ANIMALS: u32 = 12;
/// Une bête frappée détale pendant ce temps.
pub const FLEE_TICKS: u32 = 600;
/// Une bête en fuite ne recalcule sa direction que tous ces ticks.
pub const FLEE_REPLAN: u64 = 30;
/// Cases visées dans la direction opposée à la menace.
pub const FLEE_DISTANCE: i32 = 6;
/// Une débandade sur `ESCAPE_CHANCE` finit hors de la carte : la bête file
/// vers un bord et disparaît. Le dé est jeté **une fois par débandade**
/// (`Sim::start_animal_flee`), pas à chaque ré-évaluation — sinon une course
/// jusqu'au bord serait une évasion garantie, et plus rien ne se chasserait.
pub const ESCAPE_CHANCE: u32 = 4;
/// Ticks minimum entre deux pas de pâture, et amplitude du tirage : 90 à 180.
pub const GRAZE_MIN: u32 = 90;
pub const GRAZE_SPAN: u32 = 91;
/// Rayon d'un pas de pâture, en cases.
pub const GRAZE_RANGE: i32 = 4;
/// Distance de Tchebychev minimale au centre pour les bêtes de départ : la
/// colonie ne se réveille pas au milieu d'un troupeau.
pub const WILD_MIN_DISTANCE: u32 = 12;
/// Tirages de case avant d'abandonner le placement d'une bête sauvage.
const SPAWN_DRAWS: u32 = 24;
/// Dégâts d'un coup de boutoir, bornes de `Rng::range_i32`.
pub const BOAR_DAMAGE: (i32, i32) = (60, 101);

/// Trajet en ligne droite (au sens de Tchebychev) de `from` à `to`, `None` si
/// quoi que ce soit barre la route. Mêmes règles de coupe de coin que l'A*,
/// mais sans exploration : le trajet fait au plus `chebyshev(from, to)` pas.
///
/// **Pourquoi ne pas appeler `path::find_path`** : il alloue et remet à zéro
/// trois tableaux d'une case par tuile — 16 384 sur une carte 128×128 — ce qui
/// est absurde pour un pas de quatre cases. Une bête qui broute ou qui détale
/// ne contourne rien : elle avance tout droit, ou elle reste où elle est. Le
/// `bench` du 2026-09-05 a mesuré ce détail : l'A* de pâture coûtait à lui
/// seul la moitié du budget d'un tick à vide sur carte 128×128.
pub(crate) fn straight_walk(map: &Map, from: (u32, u32), to: (u32, u32)) -> Option<Vec<Tile>> {
    let (mut x, mut y) = (from.0 as i32, from.1 as i32);
    let (tx, ty) = (to.0 as i32, to.1 as i32);
    let mut out: Vec<Tile> = Vec::new();
    while (x, y) != (tx, ty) {
        let nx = x + (tx - x).signum();
        let ny = y + (ty - y).signum();
        if !map.in_bounds(nx, ny) || !map.passable(nx as u32, ny as u32) {
            return None;
        }
        // Pas de coupe de coin, comme dans `path::find_path`.
        if nx != x
            && ny != y
            && (!map.passable(x as u32, ny as u32) || !map.passable(nx as u32, y as u32))
        {
            return None;
        }
        out.push((nx as u16, ny as u16));
        x = nx;
        y = ny;
    }
    if out.is_empty() { None } else { Some(out) }
}

impl Sim {
    // ------------------------------------------------------------------
    // Apparition
    // ------------------------------------------------------------------

    /// Crée un animal. Il ne tire aucun nom (son nom est son espèce) ni
    /// aucune compétence : le flux RNG n'avance pas ici.
    pub fn spawn_animal(&mut self, x: u32, y: u32, species: Species) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let mut p = Pawn::at_tile(id, x, y, species.label().to_string());
        p.faction = Faction::Animal;
        p.species = Some(species);
        // Une bête ne mange ni ne dort dans cette tranche : ses besoins sont
        // comblés une fois pour toutes, comme ceux d'un pillard.
        p.hunger = NEED_MAX;
        p.rest = NEED_MAX;
        // `at_tile` a posé `HP_MAX` : le plafond dépend de l'espèce.
        p.recompute_hp();
        self.pawns.push(p);
        id
    }

    /// Animaux **sauvages** vivants sur la carte : c'est le compte que
    /// `MAX_ANIMALS` plafonne. Les bêtes apprivoisées ont leur propre plafond
    /// (`livestock::MAX_LIVESTOCK`, par espèce) et ne barrent pas la route aux
    /// hardes : un éleveur ne tarit pas le gibier.
    pub fn animal_count(&self) -> u32 {
        self.pawns
            .iter()
            .filter(|p| p.faction == Faction::Animal && p.is_alive())
            .count() as u32
    }

    /// Deux à quatre herbivores installés loin du centre au premier tick.
    pub(crate) fn spawn_starting_animals(&mut self) {
        let count = self.rng.below(3) + 2;
        let center = (self.map.width() / 2, self.map.height() / 2);
        for _ in 0..count {
            // Aucun sanglier au départ : la première journée n'a pas à tourner
            // au corps à corps sans que le joueur ait rien demandé.
            let species = if self.rng.chance(1, 2) {
                Species::Deer
            } else {
                Species::Rabbit
            };
            let Some((x, y)) = self.random_wild_tile(center, WILD_MIN_DISTANCE) else {
                continue;
            };
            self.spawn_animal(x, y, species);
        }
    }

    /// Case franchissable et libre tirée au sort, de préférence à au moins
    /// `min_distance` du centre. À défaut (petite carte), la première case
    /// libre tirée fait l'affaire : mieux vaut une bête trop près que pas de
    /// bête du tout.
    fn random_wild_tile(&mut self, center: (u32, u32), min_distance: u32) -> Option<(u32, u32)> {
        let (w, h) = (self.map.width(), self.map.height());
        if w == 0 || h == 0 {
            return None;
        }
        let mut fallback = None;
        for _ in 0..SPAWN_DRAWS {
            let x = self.rng.below(w);
            let y = self.rng.below(h);
            if !self.map.passable(x, y) || self.pawns.iter().any(|p| p.tile() == (x, y)) {
                continue;
            }
            if chebyshev(center, (x, y)) >= min_distance {
                return Some((x, y));
            }
            if fallback.is_none() {
                fallback = Some((x, y));
            }
        }
        fallback
    }

    /// Programme le premier troupeau : pas avant le lendemain.
    pub(crate) fn schedule_first_herd(&mut self) {
        self.next_herd_at = u64::from(TICKS_PER_DAY) + u64::from(self.rng.below(TICKS_PER_DAY));
    }

    /// Fait entrer un troupeau d'une même espèce par un bord de la carte,
    /// comme un raid (`find_entry_tile`). Renvoie le nombre de bêtes entrées.
    pub fn spawn_herd(&mut self) -> u32 {
        let living = self.animal_count();
        if living >= MAX_ANIMALS {
            return 0;
        }
        let species = Species::from_u8(self.rng.below(SPECIES_COUNT as u32) as u8);
        // Le sanglier est solitaire ; cerfs et lapins vont par deux à quatre.
        let wanted = if species.aggressive() {
            1 + self.rng.below(2)
        } else {
            2 + self.rng.below(3)
        };
        let wanted = wanted.min(MAX_ANIMALS - living);
        let Some(entry) = self.find_entry_tile() else {
            return 0;
        };
        let spots = self.ring_tiles(entry, wanted as usize, true);
        let mut spawned = 0;
        for &(x, y) in &spots {
            self.spawn_animal(x, y, species);
            spawned += 1;
        }
        if spawned > 0 {
            self.push_event(EventKind::AnimalsArrived, spawned);
        }
        spawned
    }

    // ------------------------------------------------------------------
    // Décision
    // ------------------------------------------------------------------

    /// Boucle courte d'un animal, sur le modèle de `raider_ai` : charger,
    /// fuir, ou paître. Aucune recherche de job, aucun besoin.
    ///
    /// Une bête **apprivoisée** (`Pawn::is_livestock`) bifurque vers
    /// `livestock_ai` : elle ne fuit plus, ne quitte plus la carte, a faim et
    /// tient le rayon de la colonie.
    pub(crate) fn animal_ai(&mut self, i: usize) {
        // À terre, une bête attend de se relever — ou que le chasseur l'achève.
        if self.pawns[i].is_downed() {
            return;
        }
        let tame = self.pawns[i].is_livestock();
        if let Job::Attack { target } = self.pawns[i].job {
            if tame {
                self.livestock_fight(i, target);
            } else {
                self.boar_charge(i, target);
            }
            return;
        }
        if tame {
            self.livestock_ai(i);
            return;
        }
        if self.pawns[i].flee_until > self.tick {
            self.animal_flee(i);
            return;
        }
        self.animal_graze(i);
    }

    /// Un sanglier charge son agresseur jusqu'à ce que l'un des deux soit à
    /// terre, puis détale. Il réutilise la mêlée des colons et des pillards
    /// (`Sim::engage`) : mêmes règles d'approche, de portée et de cooldown.
    fn boar_charge(&mut self, i: usize, target: u32) {
        let over = self
            .pawns
            .iter()
            .find(|p| p.id == target)
            .is_none_or(|p| !p.is_alive() || p.is_downed())
            || self.pawns[i].is_downed();
        if over || !matches!(self.engage(i, target), EngageOutcome::Engaged) {
            self.start_animal_flee(i);
        }
    }

    /// Une bête frappée réagit : le sanglier charge son agresseur, tous les
    /// autres détalent. `attacker` vaut `None` quand le coup ne vient de
    /// personne (`Sim::inflict_injury`, tests et débogage) : le sanglier fuit
    /// alors comme les autres, faute de cible.
    pub(crate) fn animal_hit(&mut self, k: usize, attacker: Option<u32>) {
        if self.pawns[k].species.is_none() || !self.pawns[k].is_alive() {
            return;
        }
        // Une bête de la colonie ne détale pas et ne s'enfuit pas de chez
        // elle : elle encaisse (le sanglier, lui, se retourne — c'est la
        // défense automatique de `livestock_ai` qui s'en charge).
        if self.pawns[k].is_livestock() {
            return;
        }
        let charges = self.pawns[k].species.is_some_and(|s| s.aggressive())
            && !matches!(self.pawns[k].job, Job::Attack { .. });
        if let (true, Some(id)) = (charges, attacker) {
            self.pawns[k].path.clear();
            self.pawns[k].job = Job::Attack { target: id };
            let boar = self.pawns[k].id;
            self.push_event(EventKind::BoarAttacks, boar);
            return;
        }
        if matches!(self.pawns[k].job, Job::Attack { .. }) {
            // Un sanglier déjà lancé ne change pas d'avis à chaque coup reçu.
            return;
        }
        if self.pawns[k].flee_until > self.tick {
            // Déjà en fuite : le coup la prolonge, mais ne relance pas le dé
            // de la débandade — sinon aucun gibier ne survivrait à la
            // deuxième flèche.
            self.pawns[k].flee_until = self.tick + u64::from(FLEE_TICKS);
            return;
        }
        self.start_animal_flee(k);
    }

    /// Met la bête en fuite pour `FLEE_TICKS` et lui fait lâcher ce qu'elle
    /// faisait. C'est là, une fois par débandade, qu'on tire si elle prend la
    /// poudre d'escampette pour de bon : elle disparaîtra en atteignant un
    /// bord (voir `Pawn::leaving`).
    fn start_animal_flee(&mut self, i: usize) {
        self.pawns[i].flee_until = self.tick + u64::from(FLEE_TICKS);
        self.pawns[i].leaving = self.rng.chance(1, ESCAPE_CHANCE);
        self.pawns[i].path.clear();
        self.pawns[i].job = Job::Idle;
    }

    /// Fuir : viser une case franchissable à `FLEE_DISTANCE` dans la direction
    /// opposée au colon le plus proche, ré-évaluée toutes les `FLEE_REPLAN`
    /// ticks. Une bête acculée au bord finit par quitter la carte.
    fn animal_flee(&mut self, i: usize) {
        if self.tick % FLEE_REPLAN != 0 {
            if self.pawns[i].is_moving() {
                self.pawns[i].advance(&self.map);
            }
            return;
        }
        let me = self.pawns[i].tile();
        // La décision a été prise au premier coup de peur : arrivée au bord,
        // la bête passe la lisière et on ne la revoit plus.
        if self.pawns[i].leaving && self.is_edge_tile(me) {
            self.pawns[i].gone = true;
            return;
        }
        if let Some(threat) = self.nearest_colonist_tile(me) {
            let mut dx = (me.0 as i32 - threat.0 as i32).signum();
            let dy = (me.1 as i32 - threat.1 as i32).signum();
            // Pile dessus : n'importe quelle direction vaut mieux que rester là.
            if dx == 0 && dy == 0 {
                dx = 1;
            }
            // Tout droit : une bête affolée ne fait pas de plan, elle fonce.
            // Si un obstacle la gêne, elle raccourcit sa course plutôt que de
            // le contourner — au pire elle reste où elle est, acculée.
            for d in (1..=FLEE_DISTANCE).rev() {
                let tx = (me.0 as i32 + dx * d).clamp(0, self.map.width() as i32 - 1);
                let ty = (me.1 as i32 + dy * d).clamp(0, self.map.height() as i32 - 1);
                if let Some(p) = straight_walk(&self.map, me, (tx as u32, ty as u32)) {
                    self.pawns[i].set_path(p);
                    break;
                }
            }
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
        }
    }

    /// Case du colon vivant le plus proche, départagée par `(distance, x, y)`.
    /// Les bêtes de la colonie ne comptent pas : un cerf sauvage ne fuit pas
    /// un lapin apprivoisé.
    fn nearest_colonist_tile(&self, from: (u32, u32)) -> Option<(u32, u32)> {
        let mut best: Option<(u32, u32, u32)> = None;
        for p in &self.pawns {
            if !p.is_colonist() || !p.is_alive() {
                continue;
            }
            let (x, y) = p.tile();
            let key = (chebyshev(from, (x, y)), x, y);
            if best.is_none_or(|b| key < b) {
                best = Some(key);
            }
        }
        best.map(|(_, x, y)| (x, y))
    }

    /// Paître : un petit pas au hasard toutes les 90 à 180 ticks.
    fn animal_graze(&mut self, i: usize) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if self.tick < self.pawns[i].graze_at {
            return;
        }
        self.pawns[i].graze_at = self.tick + u64::from(GRAZE_MIN + self.rng.below(GRAZE_SPAN));
        let (px, py) = self.pawns[i].tile();
        let tx = px as i32 + self.rng.range_i32(-GRAZE_RANGE, GRAZE_RANGE + 1);
        let ty = py as i32 + self.rng.range_i32(-GRAZE_RANGE, GRAZE_RANGE + 1);
        if !self.map.in_bounds(tx, ty) || !self.map.passable(tx as u32, ty as u32) {
            return;
        }
        // Tout droit là aussi : si la touffe d'herbe visée est derrière un
        // rocher, la bête en cherchera une autre dans un moment.
        if let Some(p) = straight_walk(&self.map, (px, py), (tx as u32, ty as u32)) {
            self.pawns[i].set_path(p);
        }
    }

    // ------------------------------------------------------------------
    // Chasse
    // ------------------------------------------------------------------

    /// Marque (ou démarque) un animal comme gibier. Un id qui n'est pas celui
    /// d'un animal **sauvage** vivant est ignoré (une bête de la colonie ne se
    /// chasse pas, elle s'abat) ; démarquer arrête les chasseurs en route.
    ///
    /// Les deux marquages sont **exclusifs** : marquer pour la chasse retire
    /// le marquage d'apprivoisement et renvoie les apprivoiseurs à leurs
    /// affaires (voir `Sim::set_tame_marked` pour la réciproque).
    pub(crate) fn set_hunted(&mut self, animal: u32, on: bool) {
        let found = self
            .pawns
            .iter_mut()
            .find(|p| p.id == animal && p.faction == Faction::Animal && p.is_alive());
        let Some(p) = found else {
            return;
        };
        p.hunted = on;
        if on {
            p.tame_marked = false;
            self.abandon_jobs_on_animal(animal, false);
            return;
        }
        self.abandon_jobs_on_animal(animal, true);
    }

    /// Renvoie à `Job::Idle` les colons dont le job vise cette bête :
    /// les chasseurs si `hunters`, les apprivoiseurs sinon. Deux appels
    /// séparés plutôt qu'un prédicat, parce qu'`abandon_job` prend `&mut
    /// self` et qu'il faut d'abord collecter les indices.
    pub(crate) fn abandon_jobs_on_animal(&mut self, animal: u32, hunters: bool) {
        let busy: Vec<usize> = self
            .pawns
            .iter()
            .enumerate()
            .filter(|(_, p)| {
                if hunters {
                    matches!(p.job, Job::Hunt { target } if target == animal)
                } else {
                    matches!(p.job, Job::Tame { animal: a, .. } if a == animal)
                }
            })
            .map(|(i, _)| i)
            .collect();
        for i in busy {
            self.abandon_job(i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn chaque_espece_est_coherente() {
        for s in Species::ALL {
            assert_eq!(Species::from_u8(s as u8), s);
            assert!(!s.label().is_empty());
            assert!(s.max_hp() > 0 && s.speed_percent() > 0);
            assert!(s.meat() > 0, "{s:?} ne donne pas de viande");
            assert_eq!(Species::from_corpse(s.corpse_kind()), Some(s));
            assert!(s.corpse_kind().is_animal_corpse());
        }
        assert_eq!(Species::from_corpse(ItemKind::Corpse), None);
        assert_eq!(Species::from_corpse(ItemKind::Meat), None);
        // Une seule espèce agressive : le reste du design en dépend.
        assert_eq!(Species::ALL.iter().filter(|s| s.aggressive()).count(), 1);
    }
}
