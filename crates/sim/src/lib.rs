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
pub mod rng;

use serde::{Deserialize, Serialize};

pub use map::{Map, Terrain};
pub use rng::Rng;

/// Ticks de simulation par seconde de jeu.
pub const TICKS_PER_SECOND: u32 = 60;

/// Ordre émis par un joueur. Appliqué au début du tick où il est planifié.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {
    /// Ne fait rien. Utile pour tester le lockstep sans gameplay.
    Nop,
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
}

impl Sim {
    pub fn new(seed: u64, width: u32, height: u32) -> Sim {
        let mut rng = Rng::new(seed);
        // Le seed de la carte est dérivé : changer la gen de terrain ne doit pas
        // décaler le flux RNG du gameplay, et inversement.
        let map_seed = rng.next_u64();
        Sim {
            tick: 0,
            rng,
            map: Map::generate(map_seed, width, height),
        }
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
        }
    }

    fn update(&mut self) {
        // Phase 0 : rien à simuler encore. Le RNG avance pour que le hash
        // dépende bien du nombre de ticks écoulés et que le flux soit exercé.
        let _ = self.rng.next_u32();
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    pub fn map(&self) -> &Map {
        &self.map
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
