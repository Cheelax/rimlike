//! API minimale exposée au navigateur. Tout ce qui est ici doit rester
//! trivial : la logique vit dans `sim`, testée en natif.

use wasm_bindgen::prelude::*;

/// Entiers par pawn dans le tampon de rendu : id, x, y, flags.
pub const PAWN_STRIDE: usize = 4;
const FLAG_MOVING: i32 = 1;

#[wasm_bindgen]
pub struct WasmSim {
    inner: sim::Sim,
    pending: Vec<sim::Command>,
    /// Instantané des pawns pour le rendu, régénéré après chaque tick.
    pawn_buffer: Vec<i32>,
}

#[wasm_bindgen]
impl WasmSim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, width: u32, height: u32) -> WasmSim {
        console_error_panic_hook::set_once();
        let mut s = WasmSim {
            inner: sim::Sim::new(seed, width, height),
            pending: Vec::new(),
            pawn_buffer: Vec::new(),
        };
        s.refresh_pawn_buffer();
        s
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
        self.refresh_pawn_buffer();
    }

    /// Planifie un ordre de déplacement pour le prochain tick.
    pub fn move_to(&mut self, pawn: u32, x: u32, y: u32) {
        self.pending.push(sim::Command::MoveTo { pawn, x, y });
    }

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
        let inner = sim::Sim::restore(bytes).map_err(|e| JsError::new(&e.to_string()))?;
        let mut s = WasmSim {
            inner,
            pending: Vec::new(),
            pawn_buffer: Vec::new(),
        };
        s.refresh_pawn_buffer();
        Ok(s)
    }

    pub fn width(&self) -> u32 {
        self.inner.map().width()
    }

    pub fn height(&self) -> u32 {
        self.inner.map().height()
    }

    /// Adresse du tableau de terrain dans la mémoire WASM. Le client construit
    /// une vue `Uint8Array` dessus : zéro copie. La vue doit être recréée après
    /// tout appel susceptible de faire croître la mémoire.
    pub fn tiles_ptr(&self) -> *const u8 {
        self.inner.map().tiles().as_ptr()
    }

    pub fn tiles_len(&self) -> usize {
        self.inner.map().tiles().len()
    }

    pub fn pawn_stride(&self) -> usize {
        PAWN_STRIDE
    }

    /// Adresse du tampon `i32` des pawns (`PAWN_STRIDE` entiers par pawn,
    /// positions en virgule fixe 24.8). Mêmes règles que `tiles_ptr`.
    pub fn pawns_ptr(&self) -> *const i32 {
        self.pawn_buffer.as_ptr()
    }

    pub fn pawns_len(&self) -> usize {
        self.pawn_buffer.len()
    }
}

impl WasmSim {
    fn refresh_pawn_buffer(&mut self) {
        self.pawn_buffer.clear();
        for p in self.inner.pawns() {
            self.pawn_buffer.push(p.id as i32);
            self.pawn_buffer.push(p.x);
            self.pawn_buffer.push(p.y);
            self.pawn_buffer
                .push(if p.is_moving() { FLAG_MOVING } else { 0 });
        }
    }
}
