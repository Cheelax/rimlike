/**
 * Preuve directe, sans hash recopié : le processus Rust piloté depuis Node
 * reçoit exactement les mêmes octets postcard que le WASM.
 */
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { NativeSimProcess } from "../../server/src/native-sim";

let wasm: typeof import("../src/wasm/sim.js");
let native: NativeSimProcess;
beforeAll(async () => {
  wasm = await import("../src/wasm/sim.js");
  wasm.initSync({ module: readFileSync(new URL("../src/wasm/sim_bg.wasm", import.meta.url)) });
  native = await NativeSimProcess.start();
});
afterAll(async () => { await native?.close(); });

describe("le vrai processus natif produit le même état que le WASM", () => {
  for (const [biome, dayScale] of [[1, 1], [2, 30], [4, 30], [6, 1]] as const) {
    it(`biome ${biome}, échelle ${dayScale}`, async () => {
      const map = `parity-${biome}-${dayScale}`;
      const browser = wasm.WasmSim.new_scaled(17n, 32, 32, biome, dayScale);
      try {
        const initial = await native.create(map, { seed: 17, width: 32, height: 32, biome, dayScale });
        expect(initial.hash).toBe(browser.hash());
        const frames: Uint8Array[][] = Array.from({ length: 900 }, () => []);
        frames[0] = [wasm.WasmSim.encode_set_difficulty(2), wasm.WasmSim.encode_set_calendar(12)];
        frames[2] = [wasm.WasmSim.encode_set_zone(1, 12, 12, 16, 16)];
        frames[5] = [wasm.WasmSim.encode_designate(1, 0, 0, 31, 31)];
        frames[300] = [wasm.WasmSim.encode_trigger_raid()];
        for (const commands of frames) {
          for (const bytes of commands) browser.apply_encoded(bytes);
          browser.step(1);
        }
        expect(await native.step(map, 0, frames)).toBe(Number(browser.tick()));
        const result = await native.inspect(map);
        expect(result.hash).toBe(browser.hash());
        expect(result.raid_status).toEqual(Array.from(browser.raid_status()));

        // Natifs -> navigateur, puis navigateur -> nouvelle carte native.
        const saved = await native.snapshot(map);
        const reopened = wasm.WasmSim.restore(saved.data);
        try {
          expect(reopened.hash()).toBe(browser.hash());
          reopened.step(120);
          const restored = await native.restore(map + "-restored", reopened.snapshot());
          expect(restored.hash).toBe(reopened.hash());
          await native.step(map, saved.tick, Array.from({ length: 120 }, () => []));
          expect((await native.inspect(map)).hash).toBe(reopened.hash());
        } finally { reopened.free(); }
      } finally {
        browser.free();
        await native.remove(map);
        await native.remove(map + "-restored");
      }
    });
  }

  it("reprend une colonie construite de trente jours avec dix habitants", async () => {
    const fixture = readFileSync(new URL("../../../docs/benchmarks/2026-09-19/mature-seed1.bin", import.meta.url));
    const browser = wasm.WasmSim.restore(fixture);
    try {
      const start = await native.restore("mature", fixture);
      expect(start.colonists).toBe(10);
      expect(start.tick).toBe(12_960_000);
      expect(start.hash).toBe(browser.hash());
      browser.step(3_600);
      await native.step("mature", start.tick, Array.from({ length: 3_600 }, () => []));
      expect((await native.inspect("mature")).hash).toBe(browser.hash());
      const snapshot = await native.snapshot("mature");
      const reloaded = wasm.WasmSim.restore(snapshot.data);
      try { expect(reloaded.hash()).toBe(browser.hash()); }
      finally { reloaded.free(); }
    } finally { browser.free(); await native.remove("mature"); }
  });

  it("reprend une défense après l'arrêt complet du processus", async () => {
    const fixture = readFileSync(new URL("../../../crates/sim/tests/fixtures/raid-hold.bin", import.meta.url));
    const first = await NativeSimProcess.start();
    let snapshot: Awaited<ReturnType<NativeSimProcess["snapshot"]>>;
    try {
      const start = await first.restore("raid", fixture);
      await first.step("raid", start.tick, Array.from({ length: 60 }, () => []));
      snapshot = await first.snapshot("raid");
    } finally { await first.close(); }
    const next = await NativeSimProcess.start();
    const browser = wasm.WasmSim.restore(snapshot!.data);
    try {
      const restored = await next.restore("raid", snapshot!.data);
      const frames = Array.from({ length: 300 }, () => []);
      await next.step("raid", restored.tick, frames);
      browser.step(300);
      expect((await next.inspect("raid")).hash).toBe(browser.hash());
    } finally { browser.free(); await next.close(); }
  });
});
