/**
 * Câblage réel SimBridge → message solo → Worker → SimHandle, sans port ni
 * navigateur. Comme startbiome.test.ts, on observe la fabrique ; ici le WASM
 * local permet aussi de vérifier le snapshot et le frame destiné au HUD.
 */
import { readFileSync } from "node:fs";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DAY_SCALE, TICKS_PER_DAY, WORLD_DAY_SCALE } from "@rimlike/protocol";
import { BIOME_NAMES } from "@rimlike/world";
import type { SimHandle as Sim } from "../src/sim/SimHandle";
import type { MainToWorker, WorkerToMain } from "../src/worker/protocol";
import type { SimBridge as Bridge } from "../src/worker/SimBridge";

let currentSim: Sim | undefined;
let bridge: Bridge | undefined;
let messages: WorkerToMain[];

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers();
  messages = [];
  currentSim = undefined;
  bridge = undefined;
});

afterEach(() => {
  bridge?.dispose();
  currentSim?.dispose();
  vi.clearAllTimers();
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

async function start(biome: number, dayScale = 1) {
  let toWorker: (event: MessageEvent<MainToWorker>) => void;
  let toMain: ((event: MessageEvent<WorkerToMain>) => void) | undefined;
  vi.stubGlobal("self", {
    addEventListener: (_type: string, listener: typeof toWorker) => { toWorker = listener; },
    postMessage: (message: WorkerToMain) => {
      const copy = structuredClone(message);
      messages.push(copy);
      toMain?.({ data: copy } as MessageEvent<WorkerToMain>);
    },
  });
  vi.stubGlobal("Worker", class {
    addEventListener(type: string, listener: typeof toMain) {
      if (type === "message") toMain = listener;
    }
    postMessage(message: MainToWorker) {
      toWorker({ data: structuredClone(message) } as MessageEvent<MainToWorker>);
    }
    terminate() { /* Les timers sont nettoyés après chaque test. */ }
  });

  // Même glue que le navigateur, initialisée depuis le disque sans fetch.
  const { initSync } = await import("../src/wasm/sim.js");
  initSync({ module: readFileSync(new URL("../src/wasm/sim_bg.wasm", import.meta.url)) });
  const { SimHandle } = await import("../src/sim/SimHandle");
  const create = SimHandle.create;
  const restore = SimHandle.restore;
  const factory = vi.spyOn(SimHandle, "create").mockImplementation(async (opts) => {
    currentSim = await create(opts);
    return currentSim;
  });
  vi.spyOn(SimHandle, "restore").mockImplementation(async (bytes) => {
    currentSim = await restore(bytes);
    return currentSim;
  });
  await import("../src/worker/sim.worker");
  const { SimBridge } = await import("../src/worker/SimBridge");
  const noop = () => {};
  bridge = new SimBridge({
    onMap: noop, onOverlays: noop, onIndoor: noop, onFire: noop, onFrame: noop,
    onNet: noop, onSaved: noop, onLoaded: noop, onError: noop,
  });
  bridge.start({ mode: "solo", seed: 42, width: 32, height: 32, difficulty: 2, biome, dayScale });
  await vi.advanceTimersByTimeAsync(16);
  bridge.setPaused(true);
  return { client: bridge, factory, create };
}

function lastFrame() {
  return messages.filter((message) => message.type === "frame").at(-1);
}

describe("biome solo dans le Worker", () => {
  it("transmet le désert (6) à la fabrique puis au RPC et au frame du HUD", async () => {
    const { client, factory } = await start(6);
    expect(factory).toHaveBeenCalledExactlyOnceWith({ seed: 42n, width: 32, height: 32, biome: 6, dayScale: 1 });
    expect(await client.rpc("biome")).toBe(6);
    expect(lastFrame()?.biome).toBe(6);
    expect(BIOME_NAMES[lastFrame()!.biome as keyof typeof BIOME_NAMES]).toBe("désert");
    expect(messages.filter((message) => message.type === "error")).toEqual([]);
  });

  it("Sauver / Charger retrouve le biome du snapshot, même différent du choix de départ", async () => {
    const { client, factory, create } = await start(6);
    client.save();
    const saved = messages.find((message) => message.type === "saved");
    expect(saved).toBeDefined();

    // Une autre sauvegarde porte la toundra : le choix désert ne l'écrase pas.
    const tundra = await create({ seed: 7n, width: 32, height: 32, biome: 2 });
    const tundraBytes = tundra.snapshot();
    tundra.dispose();
    factory.mockClear();
    client.load(tundraBytes);
    await vi.advanceTimersByTimeAsync(16);
    expect(await client.rpc("biome")).toBe(2);
    expect(lastFrame()?.biome).toBe(2);

    client.load(saved!.bytes);
    await vi.advanceTimersByTimeAsync(16);
    expect(await client.rpc("biome")).toBe(6);
    expect(lastFrame()?.biome).toBe(6);
    expect(BIOME_NAMES[lastFrame()!.biome as keyof typeof BIOME_NAMES]).toBe("désert");
    expect(factory).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === "loaded")).toEqual([
      { type: "loaded" }, { type: "loaded" },
    ]);
    expect(messages.filter((message) => message.type === "error")).toEqual([]);
  });
});

describe("échelle du jour solo dans le Worker", () => {
  it("part au constructeur et allonge le jour vu par le HUD", async () => {
    const { client, factory } = await start(4, WORLD_DAY_SCALE);
    expect(factory).toHaveBeenCalledExactlyOnceWith({
      seed: 42n, width: 32, height: 32, biome: 4, dayScale: WORLD_DAY_SCALE,
    });
    expect(await client.rpc("dayScale")).toBe(WORLD_DAY_SCALE);
    // Le HUD lit la longueur du jour **dans le sim**, jamais une constante :
    // 14 400 × 30 = 432 000 ticks, deux heures réelles à 60 ticks/s.
    expect(await client.rpc("ticksPerDay")).toBe(TICKS_PER_DAY * WORLD_DAY_SCALE);
    expect(lastFrame()?.ticksPerDay).toBe(432_000);
    expect(messages.filter((message) => message.type === "error")).toEqual([]);
  });

  it("garde le rythme d'origine pour une partie rapide", async () => {
    const { client } = await start(4, DEFAULT_DAY_SCALE);
    expect(await client.rpc("dayScale")).toBe(1);
    expect(lastFrame()?.ticksPerDay).toBe(TICKS_PER_DAY);
  });

  it("Sauver / Charger retrouve l'échelle du snapshot, pas celle de l'accueil", async () => {
    // La sauvegarde solo porte son échelle : elle est dans le snapshot du sim
    // (`docs/time.md`), donc « Charger » rejoue au rythme de la partie chargée.
    const { client, factory, create } = await start(4, WORLD_DAY_SCALE);
    client.save();
    const saved = messages.find((message) => message.type === "saved");
    expect(saved).toBeDefined();

    const quick = await create({ seed: 7n, width: 32, height: 32, biome: 4, dayScale: 1 });
    const quickBytes = quick.snapshot();
    quick.dispose();
    factory.mockClear();
    client.load(quickBytes);
    await vi.advanceTimersByTimeAsync(16);
    expect(await client.rpc("dayScale")).toBe(1);
    expect(lastFrame()?.ticksPerDay).toBe(TICKS_PER_DAY);

    client.load(saved!.bytes);
    await vi.advanceTimersByTimeAsync(16);
    expect(await client.rpc("dayScale")).toBe(WORLD_DAY_SCALE);
    expect(lastFrame()?.ticksPerDay).toBe(432_000);
    expect(factory).not.toHaveBeenCalled();
    expect(messages.filter((message) => message.type === "error")).toEqual([]);
  });
});
