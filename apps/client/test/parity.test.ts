/**
 * Parité natif / WASM : la preuve que le serveur et le navigateur simulent
 * la même partie.
 *
 * Le sim est compilé deux fois — en natif pour les tests et le futur serveur,
 * en WASM pour le navigateur. Rien ne garantit qu'un `usize`, un `wrapping_*`
 * ou un débordement se comportent pareil des deux côtés ; la phase 6 en
 * dépend pourtant entièrement (le serveur devient l'autorité de désync).
 *
 * La preuve tient en deux moitiés, reliées par une constante écrite **une
 * seule fois**, en Rust, dans `crates/sim/src/scenario.rs` :
 *
 * - `crates/sim/tests/determinism.rs::demo_hash_is_pinned` joue la partie en
 *   natif et la compare à `scenario::DEMO_HASH` ;
 * - ce fichier joue la même partie en WASM et la compare à la même constante,
 *   **lue à travers la frontière** (`WasmSim.demo_hash()`), jamais recopiée.
 *
 * Natif == constante et WASM == constante, donc natif == WASM.
 *
 * Le WASM est chargé depuis le disque, sans fetch, comme dans
 * `soloBiome-worker.test.ts` : `pnpm build:wasm` doit avoir tourné avant.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";

let wasm: typeof import("../src/wasm/sim.js");

beforeAll(async () => {
  wasm = await import("../src/wasm/sim.js");
  wasm.initSync({ module: readFileSync(new URL("../src/wasm/sim_bg.wasm", import.meta.url)) });
});

describe("parité natif / WASM", () => {
  it("rejoue le scénario de référence et retombe sur le hash épinglé en Rust", () => {
    const { WasmSim } = wasm;
    const size = WasmSim.demo_size();
    const sim = new WasmSim(WasmSim.demo_seed(), size, size);
    try {
      sim.step_demo(WasmSim.demo_ticks());
      // Un hash lisible des deux côtés : `hash()` et `demo_hash()` ont le
      // même format (16 chiffres hexadécimaux, minuscules).
      expect(sim.hash()).toMatch(/^[0-9a-f]{16}$/);
      expect(sim.hash()).toBe(WasmSim.demo_hash());
    } finally {
      sim.free();
    }
  });

  it("rejoue la toundra sans commande et retombe sur la seconde empreinte", () => {
    const { WasmSim } = wasm;
    const size = WasmSim.tundra_idle_size();
    // 2 = `sim::Biome::Tundra` (contrat de `AGENTS.md`, aligné sur
    // `packages/world/src/biomes.ts`).
    const sim = WasmSim.new_in_biome(WasmSim.tundra_idle_seed(), size, size, 2);
    try {
      expect(sim.biome()).toBe(2);
      sim.step(WasmSim.tundra_idle_days() * sim.ticks_per_day());
      expect(sim.hash()).toBe(WasmSim.tundra_idle_hash());
    } finally {
      sim.free();
    }
  });

  it("deux hashes de référence différents : le test ne compare pas une valeur vide", () => {
    const { WasmSim } = wasm;
    expect(WasmSim.demo_hash()).not.toBe(WasmSim.tundra_idle_hash());
    expect(WasmSim.demo_hash()).toMatch(/^[0-9a-f]{16}$/);
    expect(WasmSim.tundra_idle_hash()).toMatch(/^[0-9a-f]{16}$/);
  });
});
