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

pub mod fixed;
pub mod hash;
pub mod map;
pub mod noise;
pub mod path;
pub mod pawn;
pub mod rng;

use serde::{Deserialize, Serialize};

pub use map::{Map, Terrain};
pub use pawn::Pawn;
pub use rng::Rng;

/// Ticks de simulation par seconde de jeu.
pub const TICKS_PER_SECOND: u32 = 60;
/// Durée d'une journée de jeu. 4 minutes réelles pour l'instant.
pub const TICKS_PER_DAY: u32 = TICKS_PER_SECOND * 60 * 4;
/// La partie commence le matin, pas à minuit.
const DAY_START_OFFSET: u32 = TICKS_PER_DAY * 3 / 10;

/// Ordre émis par un joueur. Appliqué au début du tick où il est planifié.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {
    /// Ne fait rien. Utile pour tester le lockstep sans gameplay.
    Nop,
    /// Envoie un pawn vers une case. Ignoré si la case est inaccessible.
    MoveTo { pawn: u32, x: u32, y: u32 },
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
    next_id: u32,
}

impl Sim {
    pub fn new(seed: u64, width: u32, height: u32) -> Sim {
        let mut rng = Rng::new(seed);
        // Le seed de la carte est dérivé : changer la gen de terrain ne doit pas
        // décaler le flux RNG du gameplay, et inversement.
        let map_seed = rng.next_u64();
        let map = Map::generate(map_seed, width, height);
        let mut sim = Sim {
            tick: 0,
            rng,
            map,
            pawns: Vec::new(),
            next_id: 1,
        };
        sim.spawn_starting_pawns(3);
        sim
    }

    fn spawn_starting_pawns(&mut self, count: u32) {
        let (cx, cy) = (self.map.width() / 2, self.map.height() / 2);
        let Some(center) = self.map.nearest_walkable(cx, cy) else {
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
                    if self.map.in_bounds(x, y) && self.map.get(x as u32, y as u32).walkable() {
                        self.spawn_pawn(x as u32, y as u32);
                        spawned += 1;
                    }
                }
            }
            r += 1;
        }
    }

    pub fn spawn_pawn(&mut self, x: u32, y: u32) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        self.pawns.push(Pawn::at_tile(id, x, y));
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
        match command {
            Command::Nop => {}
            Command::MoveTo { pawn, x, y } => {
                if !self.map.in_bounds(*x as i32, *y as i32) {
                    return;
                }
                let Some(p) = self.pawns.iter_mut().find(|p| p.id == *pawn) else {
                    return;
                };
                if let Some(path) = path::find_path(&self.map, p.tile(), (*x, *y)) {
                    p.set_path(path);
                }
            }
        }
    }

    fn update(&mut self) {
        for i in 0..self.pawns.len() {
            if self.pawns[i].is_moving() {
                self.pawns[i].advance(&self.map);
            } else {
                self.idle(i);
            }
        }
    }

    /// Comportement d'attente : flâner autour de soi de temps en temps.
    /// Sera remplacé par le système de jobs en phase 2.
    fn idle(&mut self, i: usize) {
        self.pawns[i].idle_ticks += 1;
        if self.pawns[i].idle_ticks < 90 || !self.rng.chance(1, 45) {
            return;
        }
        let (px, py) = self.pawns[i].tile();
        let tx = px as i32 + self.rng.range_i32(-7, 8);
        let ty = py as i32 + self.rng.range_i32(-7, 8);
        if !self.map.in_bounds(tx, ty) || !self.map.get(tx as u32, ty as u32).walkable() {
            return;
        }
        if let Some(path) = path::find_path(&self.map, (px, py), (tx as u32, ty as u32))
            && !path.is_empty()
        {
            self.pawns[i].set_path(path);
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

    pub fn pawns(&self) -> &[Pawn] {
        &self.pawns
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
