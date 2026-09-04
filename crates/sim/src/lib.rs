//! Simulation déterministe.
//!
//! Règles non négociables (docs/PLAN.md §2.1) :
//! - aucun flottant : `clippy::float_arithmetic` est en `deny` ;
//! - aucune structure à ordre aléatoire (`HashMap`, `HashSet`) : voir `clippy.toml` ;
//! - aucune horloge, aucune entropie : tout vient du seed et des commandes ;
//! - le crate ne connaît ni le rendu ni le réseau.
//!
//! Le même code compile en natif (tests, serveur) et en WASM (navigateur).

#![forbid(unsafe_code)]
#![deny(clippy::float_arithmetic)]
#![deny(clippy::disallowed_types)]
#![deny(clippy::disallowed_methods)]

pub mod build;
pub mod combat;
pub mod farm;
pub mod fixed;
pub mod hash;
pub mod items;
pub mod jobs;
pub mod map;
pub mod names;
pub mod noise;
pub mod path;
pub mod pawn;
pub mod rng;
pub mod testmap;
pub mod weather;
pub mod work;

use serde::{Deserialize, Serialize};

pub use build::{Blueprint, BuildKind, Material};
pub use farm::Crop;
pub use items::{ItemKind, ItemStack};
pub use jobs::{Regrow, Reservation};
pub use map::{Designation, Feature, Map, Rect, Terrain, Zone};
pub use pawn::{Faction, Job, Pawn};
pub use rng::Rng;
pub use weather::Weather;
pub use work::{WORK_TYPES, WorkType};

/// Ticks de simulation par seconde de jeu.
pub const TICKS_PER_SECOND: u32 = 60;
/// Durée d'une journée de jeu. 4 minutes réelles pour l'instant.
pub const TICKS_PER_DAY: u32 = TICKS_PER_SECOND * 60 * 4;
/// La partie commence le matin, pas à minuit.
const DAY_START_OFFSET: u32 = TICKS_PER_DAY * 3 / 10;
/// Événements gardés pour le client. Au-delà, le plus ancien est oublié.
const MAX_EVENTS: usize = 32;

/// Fait notable de la partie, poussé au client pour affichage.
/// Les valeurs sont un contrat avec `apps/client/src/render/terrain.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum EventKind {
    Raid = 1,
    ColonistDied = 2,
    RaiderDied = 3,
    RaiderLeft = 4,
    WandererJoined = 5,
    ColonistBreak = 6,
    /// Un colon a gagné un niveau dans une compétence. `arg` : son id ; le
    /// client choisira plus tard comment nommer la compétence concernée.
    LevelUp = 7,
}

/// `arg` dépend du genre : nombre de pillards pour un raid, id du pawn sinon.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameEvent {
    pub seq: u32,
    pub tick: u64,
    pub kind: EventKind,
    pub arg: u32,
}

/// Ordre émis par un joueur. Appliqué au début du tick où il est planifié.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {
    /// Ne fait rien. Utile pour tester le lockstep sans gameplay.
    Nop,
    /// Envoie un pawn vers une case. Ignoré si la case est inaccessible.
    MoveTo { pawn: u32, x: u32, y: u32 },
    /// Pose (ou retire avec `Designation::None`) une désignation sur un rectangle.
    Designate {
        kind: Designation,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Pose (ou retire avec `Zone::None`) une zone sur un rectangle.
    SetZone {
        zone: Zone,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Pose des plans de construction sur chaque case valide du rectangle.
    Build {
        kind: BuildKind,
        material: Material,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Annule les plans du rectangle et rend les matériaux déjà livrés.
    CancelBuild { x0: i32, y0: i32, x1: i32, y1: i32 },
    /// Envoie un pawn en attaquer un autre, d'un camp différent.
    Attack { pawn: u32, target: u32 },
    /// Règle la priorité d'un type de travail pour un colon.
    /// `priority` : 1 la plus haute, 4 la plus basse, 0 désactivé.
    SetPriority {
        pawn: u32,
        work: WorkType,
        priority: u8,
    },
    /// Fait entrer un raid tout de suite (débogage, tests).
    TriggerRaid,
}

#[derive(Debug)]
pub enum SnapshotError {
    Corrupt,
}

impl core::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SnapshotError::Corrupt => f.write_str("snapshot corrompu"),
        }
    }
}

/// État complet d'une carte simulée. Tout ce qui influence le futur est ici,
/// et uniquement ici : c'est ce qui est sérialisé et hashé.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sim {
    tick: u64,
    rng: Rng,
    map: Map,
    /// Triés par id croissant (ordre d'insertion, jamais réordonnés).
    pawns: Vec<Pawn>,
    items: Vec<ItemStack>,
    reservations: Vec<Reservation>,
    regrow: Vec<Regrow>,
    blueprints: Vec<Blueprint>,
    crops: Vec<Crop>,
    /// Faits notables récents, du plus ancien au plus récent.
    events: Vec<GameEvent>,
    next_event_seq: u32,
    /// Tick du prochain raid.
    next_raid_at: u64,
    /// Tick d'arrivée du prochain voyageur.
    next_wanderer_at: u64,
    weather: Weather,
    /// Tick où la météo courante s'arrête.
    weather_until: u64,
    /// Compteur d'ids partagé par tout ce qui a un id.
    next_id: u32,
}

impl Sim {
    pub fn new(seed: u64, width: u32, height: u32) -> Sim {
        let mut rng = Rng::new(seed);
        // Le seed de la carte est dérivé : changer la gen de terrain ne doit pas
        // décaler le flux RNG du gameplay, et inversement.
        let map_seed = rng.next_u64();
        Sim::with_map(rng, Map::generate(map_seed, width, height))
    }

    /// Sim sur une carte fournie (tests, scénarios).
    pub fn from_map(seed: u64, map: Map) -> Sim {
        Sim::with_map(Rng::new(seed), map)
    }

    fn with_map(rng: Rng, map: Map) -> Sim {
        let mut sim = Sim {
            tick: 0,
            rng,
            map,
            pawns: Vec::new(),
            items: Vec::new(),
            reservations: Vec::new(),
            regrow: Vec::new(),
            blueprints: Vec::new(),
            crops: Vec::new(),
            events: Vec::new(),
            next_event_seq: 0,
            next_raid_at: 0,
            next_wanderer_at: 0,
            weather: Weather::Clear,
            weather_until: 0,
            next_id: 1,
        };
        sim.spawn_starting_pawns(3);
        sim.schedule_first_raid();
        // La première journée reste claire un moment, le temps de s'installer.
        sim.weather_until = u64::from(TICKS_PER_DAY / 2 + sim.rng.below(TICKS_PER_DAY / 2));
        sim.next_wanderer_at = u64::from(4 * TICKS_PER_DAY + sim.rng.below(TICKS_PER_DAY));
        sim
    }

    fn spawn_starting_pawns(&mut self, count: u32) {
        let (cx, cy) = (self.map.width() / 2, self.map.height() / 2);
        let Some(center) = self.map.nearest_passable(cx, cy) else {
            return;
        };
        let mut spawned = 0;
        let mut r: i32 = 0;
        while spawned < count && r < 16 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if spawned >= count || (dx.abs() != r && dy.abs() != r) {
                        continue;
                    }
                    let x = center.0 as i32 + dx;
                    let y = center.1 as i32 + dy;
                    if self.map.in_bounds(x, y) && self.map.passable(x as u32, y as u32) {
                        self.spawn_pawn(x as u32, y as u32, Faction::Colony);
                        spawned += 1;
                    }
                }
            }
            r += 1;
        }
    }

    /// Crée un pawn du camp donné, avec un nom tiré au sort. Les colons
    /// (et voyageurs) reçoivent aussi des niveaux de compétence de départ ;
    /// les pillards restent à 0 partout (valeur par défaut de `Pawn::at_tile`).
    pub fn spawn_pawn(&mut self, x: u32, y: u32, faction: Faction) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let name = names::pick(&mut self.rng, faction);
        let mut pawn = Pawn::at_tile(id, x, y, name);
        pawn.faction = faction;
        if faction == Faction::Colony {
            for work in WorkType::ALL {
                pawn.skills[work as usize].level = self.rng.below(9) as u8;
            }
        }
        self.pawns.push(pawn);
        id
    }

    /// Avance d'un tick. Les commandes sont appliquées dans l'ordre reçu,
    /// avant la mise à jour du monde. Le lockstep garantit que tous les
    /// clients reçoivent la même liste dans le même ordre pour ce tick.
    pub fn step(&mut self, commands: &[Command]) {
        for command in commands {
            self.apply(command);
        }
        self.update();
        self.tick += 1;
    }

    fn apply(&mut self, command: &Command) {
        match *command {
            Command::Nop => {}
            Command::MoveTo { pawn, x, y } => {
                if !self.map.in_bounds(x as i32, y as i32) {
                    return;
                }
                let Some(i) = self.pawns.iter().position(|p| p.id == pawn) else {
                    return;
                };
                let from = self.pawns[i].tile();
                if let Some(path) = path::find_path(&self.map, from, (x, y)) {
                    self.abandon_job(i);
                    self.pawns[i].set_path(path);
                    self.pawns[i].job = Job::Move { manual: true };
                }
            }
            Command::Designate {
                kind,
                x0,
                y0,
                x1,
                y1,
            } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                for (x, y) in rect.tiles() {
                    if kind == Designation::None || kind.applies_to(self.map.feature(x, y)) {
                        self.map.set_designation(x, y, kind);
                    }
                }
            }
            Command::SetZone {
                zone,
                x0,
                y0,
                x1,
                y1,
            } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                for (x, y) in rect.tiles() {
                    if zone == Zone::None || self.map.passable(x, y) {
                        self.map.set_zone(x, y, zone);
                    }
                }
            }
            Command::Build {
                kind,
                material,
                x0,
                y0,
                x1,
                y1,
            } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                let material = kind.forced_material().unwrap_or(material);
                for (x, y) in rect.tiles() {
                    if !build::can_place(&self.map, kind, x, y)
                        || self.blueprints.iter().any(|b| (b.x, b.y) == (x, y))
                        || (kind != BuildKind::Floor
                            && self.items.iter().any(|s| (s.x, s.y) == (x, y)))
                    {
                        continue;
                    }
                    let id = self.next_id;
                    self.next_id += 1;
                    self.blueprints.push(Blueprint {
                        id,
                        x,
                        y,
                        kind,
                        material,
                        delivered: 0,
                        needed: kind.cost(),
                        progress: 0,
                        reserved_by: None,
                    });
                }
            }
            Command::CancelBuild { x0, y0, x1, y1 } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                let mut k = 0;
                while k < self.blueprints.len() {
                    let b = &self.blueprints[k];
                    if b.x >= rect.x0 && b.x <= rect.x1 && b.y >= rect.y0 && b.y <= rect.y1 {
                        let b = self.blueprints.remove(k);
                        self.spawn_item(b.material.item_kind(), b.delivered, b.x, b.y);
                    } else {
                        k += 1;
                    }
                }
            }
            Command::Attack { pawn, target } => {
                let Some(i) = self.pawns.iter().position(|p| p.id == pawn && p.is_alive()) else {
                    return;
                };
                let Some(k) = self
                    .pawns
                    .iter()
                    .position(|p| p.id == target && p.is_alive())
                else {
                    return;
                };
                if self.pawns[i].faction == self.pawns[k].faction {
                    return;
                }
                self.abandon_job(i);
                self.pawns[i].job = Job::Attack { target };
            }
            Command::SetPriority {
                pawn,
                work,
                priority,
            } => {
                let Some(p) = self.pawns.iter_mut().find(|p| p.id == pawn) else {
                    return;
                };
                if p.faction == Faction::Raider {
                    return;
                }
                p.priorities[work as usize] = priority.min(4);
            }
            Command::TriggerRaid => {
                self.spawn_raid();
            }
        }
    }

    fn update(&mut self) {
        self.tick_regrowth();
        self.tick_weather();
        self.tick_crops();
        self.tick_spoilage();
        self.tick_storyteller();
        for i in 0..self.pawns.len() {
            self.tick_pawn(i);
        }
        self.remove_dead();
    }

    /// Enregistre un fait notable pour le client. La file est bornée : le
    /// client suit les `seq` qu'il a déjà vus.
    fn push_event(&mut self, kind: EventKind, arg: u32) {
        let seq = self.next_event_seq;
        self.next_event_seq += 1;
        self.events.push(GameEvent {
            seq,
            tick: self.tick,
            kind,
            arg,
        });
        if self.events.len() > MAX_EVENTS {
            self.events.remove(0);
        }
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// Instant dans la journée, dans `0..TICKS_PER_DAY`. 0 = minuit.
    pub fn time_of_day(&self) -> u32 {
        ((self.tick + u64::from(DAY_START_OFFSET)) % u64::from(TICKS_PER_DAY)) as u32
    }

    pub fn map(&self) -> &Map {
        &self.map
    }

    /// Accès direct à la carte, pour les tests et scénarios. Le jeu passe par
    /// des `Command`.
    pub fn map_mut(&mut self) -> &mut Map {
        &mut self.map
    }

    pub fn blueprints(&self) -> &[Blueprint] {
        &self.blueprints
    }

    pub fn crops(&self) -> &[Crop] {
        &self.crops
    }

    pub fn pawns(&self) -> &[Pawn] {
        &self.pawns
    }

    pub fn pawn_mut(&mut self, id: u32) -> Option<&mut Pawn> {
        self.pawns.iter_mut().find(|p| p.id == id)
    }

    pub fn items(&self) -> &[ItemStack] {
        &self.items
    }

    /// Faits notables récents, du plus ancien au plus récent.
    pub fn events(&self) -> &[GameEvent] {
        &self.events
    }

    /// Total d'objets rangés en zone de stockage, par genre.
    pub fn stored_totals(&self) -> [u32; ItemKind::COUNT] {
        let mut out = [0; ItemKind::COUNT];
        for s in &self.items {
            if self.map.zone(s.x, s.y) == Zone::Stockpile {
                out[s.kind as usize] += s.count;
            }
        }
        out
    }

    /// Sérialisation binaire compacte de l'état complet.
    pub fn snapshot(&self) -> Vec<u8> {
        postcard::to_allocvec(self).expect("sérialisation en mémoire infaillible")
    }

    pub fn restore(bytes: &[u8]) -> Result<Sim, SnapshotError> {
        postcard::from_bytes(bytes).map_err(|_| SnapshotError::Corrupt)
    }

    /// Hash de l'état, comparé entre clients pour détecter une désynchronisation.
    /// Phase 0 : hash du snapshot complet. À rendre incrémental quand l'état grossit.
    pub fn state_hash(&self) -> u64 {
        hash::fnv1a64(&self.snapshot())
    }
}
