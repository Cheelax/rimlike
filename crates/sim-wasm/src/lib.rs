//! API minimale exposée au navigateur. Tout ce qui est ici doit rester
//! trivial : la logique vit dans `sim`, testée en natif.

use sim::{Designation, ItemKind, Job, Zone};
use wasm_bindgen::prelude::*;

/// Entiers par pawn dans le tampon de rendu :
/// id, x, y, flags, faim ‰, repos ‰, humeur ‰, code de job, genre porté (-1 = rien), quantité portée.
pub const PAWN_STRIDE: usize = 10;
/// Entiers par pile : id, genre, quantité, x, y.
pub const ITEM_STRIDE: usize = 5;

const FLAG_MOVING: i32 = 1;
const FLAG_SLEEPING: i32 = 2;
const FLAG_WORKING: i32 = 4;
const FLAG_STARVING: i32 = 8;
const FLAG_CARRYING: i32 = 16;

#[wasm_bindgen]
pub struct WasmSim {
    inner: sim::Sim,
    pending: Vec<sim::Command>,
    pawn_buffer: Vec<i32>,
    item_buffer: Vec<i32>,
}

#[wasm_bindgen]
impl WasmSim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, width: u32, height: u32) -> WasmSim {
        console_error_panic_hook::set_once();
        WasmSim::wrap(sim::Sim::new(seed, width, height))
    }

    /// Avance de `n` ticks. Les commandes en attente sont appliquées au premier.
    pub fn step(&mut self, n: u32) {
        if n == 0 {
            return;
        }
        let cmds = core::mem::take(&mut self.pending);
        self.inner.step(&cmds);
        for _ in 1..n {
            self.inner.step(&[]);
        }
        self.refresh_buffers();
    }

    // --- Commandes (appliquées au prochain tick) ---

    pub fn move_to(&mut self, pawn: u32, x: u32, y: u32) {
        self.pending.push(sim::Command::MoveTo { pawn, x, y });
    }

    /// `kind` : 0 annuler, 1 couper, 2 miner, 3 récolter.
    pub fn designate(&mut self, kind: u8, x0: i32, y0: i32, x1: i32, y1: i32) {
        self.pending.push(sim::Command::Designate {
            kind: Designation::from_u8(kind),
            x0,
            y0,
            x1,
            y1,
        });
    }

    /// `zone` : 0 retirer, 1 stockage.
    pub fn set_zone(&mut self, zone: u8, x0: i32, y0: i32, x1: i32, y1: i32) {
        self.pending.push(sim::Command::SetZone {
            zone: Zone::from_u8(zone),
            x0,
            y0,
            x1,
            y1,
        });
    }

    // --- Lecture ---

    pub fn tick(&self) -> f64 {
        self.inner.tick() as f64
    }

    pub fn ticks_per_day(&self) -> u32 {
        sim::TICKS_PER_DAY
    }

    pub fn time_of_day(&self) -> u32 {
        self.inner.time_of_day()
    }

    /// Hash d'état en hexadécimal, pour l'affichage et la détection de désync.
    pub fn hash(&self) -> String {
        format!("{:016x}", self.inner.state_hash())
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.inner.snapshot()
    }

    pub fn restore(bytes: &[u8]) -> Result<WasmSim, JsError> {
        sim::Sim::restore(bytes)
            .map(WasmSim::wrap)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn width(&self) -> u32 {
        self.inner.map().width()
    }

    pub fn height(&self) -> u32 {
        self.inner.map().height()
    }

    /// Change à chaque modification du sol ou des éléments.
    pub fn map_version(&self) -> u32 {
        self.inner.map().version()
    }

    /// Change à chaque modification des zones ou des désignations.
    pub fn overlay_version(&self) -> u32 {
        self.inner.map().overlay_version()
    }

    /// Total rangé en stockage, indexé par `ItemKind`.
    pub fn stored_totals(&self) -> Vec<u32> {
        self.inner.stored_totals().to_vec()
    }

    // --- Vues mémoire (zéro copie ; à recréer après tout appel au sim) ---

    pub fn tiles_ptr(&self) -> *const u8 {
        self.inner.map().tiles().as_ptr()
    }

    pub fn tiles_len(&self) -> usize {
        self.inner.map().tiles().len()
    }

    pub fn features_ptr(&self) -> *const u8 {
        self.inner.map().features().as_ptr()
    }

    pub fn zones_ptr(&self) -> *const u8 {
        self.inner.map().zones().as_ptr()
    }

    pub fn designations_ptr(&self) -> *const u8 {
        self.inner.map().designations().as_ptr()
    }

    pub fn pawn_stride(&self) -> usize {
        PAWN_STRIDE
    }

    pub fn pawns_ptr(&self) -> *const i32 {
        self.pawn_buffer.as_ptr()
    }

    pub fn pawns_len(&self) -> usize {
        self.pawn_buffer.len()
    }

    pub fn item_stride(&self) -> usize {
        ITEM_STRIDE
    }

    pub fn items_ptr(&self) -> *const i32 {
        self.item_buffer.as_ptr()
    }

    pub fn items_len(&self) -> usize {
        self.item_buffer.len()
    }
}

impl WasmSim {
    fn wrap(inner: sim::Sim) -> WasmSim {
        let mut s = WasmSim {
            inner,
            pending: Vec::new(),
            pawn_buffer: Vec::new(),
            item_buffer: Vec::new(),
        };
        s.refresh_buffers();
        s
    }

    fn refresh_buffers(&mut self) {
        self.pawn_buffer.clear();
        for p in self.inner.pawns() {
            let mut flags = 0;
            if p.is_moving() {
                flags |= FLAG_MOVING;
            }
            if matches!(p.job, Job::Sleep) {
                flags |= FLAG_SLEEPING;
            }
            if matches!(p.job, Job::Work { .. }) && !p.is_moving() {
                flags |= FLAG_WORKING;
            }
            if p.is_starving() {
                flags |= FLAG_STARVING;
            }
            if p.carrying.is_some() {
                flags |= FLAG_CARRYING;
            }
            let (ckind, ccount) = match p.carrying {
                Some((k, n)) => (k as i32, n as i32),
                None => (-1, 0),
            };
            self.pawn_buffer.extend_from_slice(&[
                p.id as i32,
                p.x,
                p.y,
                flags,
                (p.hunger / 1000) as i32,
                (p.rest / 1000) as i32,
                (p.mood() / 1000) as i32,
                p.job.code(),
                ckind,
                ccount,
            ]);
        }
        self.item_buffer.clear();
        for s in self.inner.items() {
            self.item_buffer.extend_from_slice(&[
                s.id as i32,
                s.kind as i32,
                s.count as i32,
                s.x as i32,
                s.y as i32,
            ]);
        }
        let _ = ItemKind::COUNT;
    }
}
