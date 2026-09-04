//! API minimale exposée au navigateur. Tout ce qui est ici doit rester
//! trivial : la logique vit dans `sim`, testée en natif.

use wasm_bindgen::prelude::*;

#[wasm_bindgen]
pub struct WasmSim {
    inner: sim::Sim,
}

#[wasm_bindgen]
impl WasmSim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, width: u32, height: u32) -> WasmSim {
        console_error_panic_hook::set_once();
        WasmSim {
            inner: sim::Sim::new(seed, width, height),
        }
    }

    /// Avance de `n` ticks sans commande. L'entrée de commandes arrive avec
    /// le protocole (phase 2/3).
    pub fn step(&mut self, n: u32) {
        for _ in 0..n {
            self.inner.step(&[]);
        }
    }

    pub fn tick(&self) -> f64 {
        self.inner.tick() as f64
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
            .map(|inner| WasmSim { inner })
            .map_err(|e| JsError::new(&e.to_string()))
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
}
