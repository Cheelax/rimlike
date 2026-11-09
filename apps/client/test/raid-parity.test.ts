/**
 * Trois snapshots natifs : veille, Job::Defend et retour vers un abri éloigné.
 * Les fichiers .hash sont également vérifiés par crates/sim/tests/raid_fixtures.rs.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { formatEventTime } from "../src/render/terrain";

let wasm: typeof import("../src/wasm/sim.js");
let memory: WebAssembly.Memory;
beforeAll(async () => {
  wasm = await import("../src/wasm/sim.js");
  memory = wasm.initSync({ module: readFileSync(new URL("../src/wasm/sim_bg.wasm", import.meta.url)) }).memory;
});
function fixture(name: string, extension: string) {
  return readFileSync(new URL(`../../../crates/sim/tests/fixtures/${name}.${extension}`, import.meta.url));
}
describe("raids : snapshots natifs rejoués en WASM", () => {
  it("date le pillage à l'heure du sim, qui commence au matin", () => {
    const s = wasm.WasmSim.restore(fixture("raid-watch", "bin"));
    try {
      const day = s.ticks_per_day();
      const offset = (s.time_of_day() - Number(s.tick()) % day + day) % day;
      expect(formatEventTime(Number(s.tick()), day, offset)).toBe("jour 1 07:12");
      s.step(20000);
      const events = new Int32Array(memory.buffer, s.events_ptr(), s.events_len());
      const at = Array.from({ length: events.length / 4 }, (_, i) => i * 4)
        .find((i) => events[i + 2] === 44);
      expect(at).toBeDefined();
      expect(formatEventTime(events[at! + 1]!, day, offset)).toBe("jour 1 08:14");
      // Minuit civil ne change pas le compteur de jours écoulés du HUD.
      expect(formatEventTime(day - offset, day, offset)).toBe("jour 1 00:00");
      expect(formatEventTime(day, day, offset)).toBe("jour 2 07:12");
    } finally { s.free(); }
  });

  for (const [name, stance, remaining] of [["raid-watch", 2, 0], ["raid-hold", 1, 0], ["raid-return", 2, 6]] as const) {
    it(name, () => {
      const s = wasm.WasmSim.restore(fixture(name, "bin"));
      try {
        expect(s.raid_status()[0]).toBe(stance);
        expect(s.day_scale()).toBe(30);
        const ticks = Number(fixture(name, "ticks").toString("utf8").trim());
        s.step(ticks);
        expect(s.hash()).toBe(fixture(name, "hash").toString("utf8").trim());
        expect(s.raid_status()[1]).toBe(remaining);
      } finally { s.free(); }
    });
  }
});
