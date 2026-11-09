/**
 * Le jour affiché (`gameDay`, HUD et Journal) change à minuit, au même instant
 * que le calendrier du sim (`day_of_year`). Avant le 2026-11-09, il changeait
 * au tick multiple de `ticks_per_day`, soit vers 07:12 : de minuit au matin,
 * l'en-tête disait « Jour 3 02:49 » à côté d'un calendrier déjà au jour 4.
 *
 * Le WASM est chargé depuis le disque, comme dans `parity.test.ts` :
 * `pnpm build:wasm` doit avoir tourné avant.
 */
import { readFileSync } from "node:fs";
import { beforeAll, describe, expect, it } from "vitest";
import { formatClock, formatEventTime, gameDay } from "../src/render/terrain";

let wasm: typeof import("../src/wasm/sim.js");

beforeAll(async () => {
  wasm = await import("../src/wasm/sim.js");
  wasm.initSync({ module: readFileSync(new URL("../src/wasm/sim_bg.wasm", import.meta.url)) });
});

/** Le décalage tel que `App.tsx` le lit dans le sim. */
function clockOffset(tick: number, timeOfDay: number, ticksPerDay: number): number {
  return (timeOfDay - tick % ticksPerDay + ticksPerDay) % ticksPerDay;
}

describe("jour affiché", () => {
  it("bascule à minuit sur l'horloge, pas au tick multiple d'un jour", () => {
    const tpd = 14_400;
    const offset = 4_320; // la partie commence à 07:12
    expect(formatEventTime(0, tpd, offset)).toBe("jour 1 07:12");
    expect(formatEventTime(tpd - offset - 1, tpd, offset)).toBe("jour 1 23:59");
    expect(formatEventTime(tpd - offset, tpd, offset)).toBe("jour 2 00:00");
    // L'ancien calcul disait encore « jour 1 » ici.
    expect(gameDay(tpd - 1, tpd, offset)).toBe(2);
  });

  it.each([1, 30])("suit le calendrier du sim, à l'échelle %i", (dayScale) => {
    const sim = wasm.WasmSim.new_scaled(7n, 24, 24, 4, dayScale);
    try {
      const tpd = sim.ticks_per_day();
      // Une heure de jeu par pas : on traverse trois minuits.
      const hour = tpd / 24;
      for (let i = 0; i < 24 * 3; i++) {
        const tick = Number(sim.tick());
        const offset = clockOffset(tick, sim.time_of_day(), tpd);
        const label = `tick ${tick}, ${formatClock(sim.time_of_day(), tpd)}`;
        expect(gameDay(tick, tpd, offset) - 1, label).toBe(sim.day_of_year());
        sim.step(hour);
      }
    } finally {
      sim.free();
    }
  });
});
