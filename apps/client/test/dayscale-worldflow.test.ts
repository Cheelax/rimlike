/**
 * L'essai réel de l'échelle du jour, contre le **vrai** serveur et le **vrai**
 * sim WASM : l'équivalent en test de la séquence « Essayer le monde partagé »
 * d'`AGENTS.md`, quand aucun navigateur n'est disponible.
 *
 * Ce qui est prouvé ici, et nulle part ailleurs :
 *
 * 1. deux clients d'une même salle « case » construisent leur sim à l'échelle
 *    du serveur et **retombent sur le même hash** après le même nombre de
 *    ticks — c'est la seule preuve que l'échelle ne désynchronise pas ;
 * 2. `frame.ticksPerDay` vaut 432 000 à l'échelle 30, lu **dans le sim** et
 *    non recopié d'une constante ;
 * 3. le monde n'a plus d'horloge à part : `WorldClock.hourMs` se déduit de
 *    l'échelle, et une caravane arrive à l'heure que cette dérivation prédit.
 *
 * Le WASM est chargé depuis le disque, sans fetch, comme dans
 * `parity.test.ts` : `pnpm build:wasm` doit avoir tourné avant.
 */
import { readFileSync } from "node:fs";

import { afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";

import { TICKS_PER_DAY, WORLD_DAY_SCALE, worldHourMsFor, type SettledMessage } from "@rimlike/protocol";
import { findRoute, movementCost, type World } from "@rimlike/world";

import { startServer, type RunningServer } from "../../server/src/server.js";
import { LockstepClient, type LockstepError } from "../src/net/LockstepClient";
import { WorldClient, type WorldError } from "../src/net/WorldClient";
import { WsTransport } from "../src/net/WsTransport";
import { fetchWorld } from "../src/net/worldFetch";
import type { SimHandle as Sim } from "../src/sim/SimHandle";

/** Globe minuscule : 162 cases, généré en quelques millisecondes. */
const SUBDIVISIONS = 2;
const WORLD_SEED = 7;
/** Carte minuscule : le test compare des hashes, pas une partie jouable. */
const MAP = 32;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

let SimHandle: typeof import("../src/sim/SimHandle").SimHandle;
let encodeSetDifficulty: (level: number) => Uint8Array;
let encodeSetResearch: (tech: number) => Uint8Array;
let server: RunningServer;
const closers: Array<() => void> = [];
const sims: Sim[] = [];
/** Horloge murale du monde, pilotée par le test : rien n'attend en vrai. */
let worldNow = 1_800_000_000_000;
/** Tick du monde (caravanes, marchands), déclenché à la main. */
let tickWorld: () => void = () => {};
let deviceCounter = 0;

async function waitFor(label: string, done: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé en attendant : ${label}`);
    await sleep(2);
  }
}

/** `localStorage` en mémoire : `net/identity.ts` y range le jeton du monde. */
class FakeStorage {
  private readonly map = new Map<string, string>();
  get length(): number {
    return this.map.size;
  }
  clear(): void {
    this.map.clear();
  }
  getItem(key: string): string | null {
    return this.map.get(key) ?? null;
  }
  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }
  removeItem(key: string): void {
    this.map.delete(key);
  }
  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

async function enterWorld(world: World, name: string) {
  const transport = await WsTransport.connect(server.url);
  const settled: SettledMessage[] = [];
  const errors: WorldError[] = [];
  const client = new WorldClient({
    transport,
    name,
    serverUrl: `device-${deviceCounter++}`,
    expected: { seed: world.seed, subdivisions: world.subdivisions, tiles: world.tiles.length },
    onSettled: (message) => settled.push(message),
    onError: (error) => errors.push(error),
  });
  closers.push(() => client.close());
  client.join();
  await waitFor(`${name} dans le monde`, () => client.state.phase === "connected");
  return { client, settled, errors };
}

/**
 * Une connexion de salle avec le **vrai** sim : c'est tout l'intérêt de ce
 * fichier — le hash comparé est celui du sim, pas d'un faux déterministe.
 */
async function enterRoom(room: string, name: string) {
  const transport = await WsTransport.connect(server.url);
  const errors: LockstepError[] = [];
  const client = new LockstepClient({
    transport,
    createSim: async (seed, width, height, biome, dayScale) => {
      const sim = await SimHandle.create({
        seed: BigInt(seed),
        width,
        height,
        ...(biome === undefined ? {} : { biome }),
        ...(dayScale === undefined ? {} : { dayScale }),
      });
      sims.push(sim);
      return sim;
    },
    restoreSim: async (data) => {
      const sim = await SimHandle.restore(data);
      sims.push(sim);
      return sim;
    },
    onError: (error) => errors.push(error),
  });
  closers.push(() => client.close());
  client.join(room, name);
  return { client, errors, sim: () => client.sim as Sim | null };
}

/** Pompe comme le ferait la boucle du Worker jusqu'à ce que `done` soit vrai. */
async function pumpUntil(
  clients: readonly LockstepClient[],
  label: string,
  done: () => boolean,
  timeoutMs = 20_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const client of clients) client.pump(64);
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label}`);
    await sleep(1);
  }
}

beforeAll(async () => {
  const wasm = await import("../src/wasm/sim.js");
  wasm.initSync({ module: readFileSync(new URL("../src/wasm/sim_bg.wasm", import.meta.url)) });
  ({ SimHandle } = await import("../src/sim/SimHandle"));
  ({ encodeSetDifficulty, encodeSetResearch } = await import("../src/sim/commands"));
});

beforeEach(async () => {
  (globalThis as { localStorage?: Storage }).localStorage = new FakeStorage() as unknown as Storage;
  worldNow = 1_800_000_000_000;
  tickWorld = () => {};
  server = await startServer({
    port: 0,
    log: () => {},
    worldSeed: WORLD_SEED,
    worldSubdivisions: SUBDIVISIONS,
    // Aucune surcharge d'horloge : c'est la dérivation qui est jugée. Le
    // temps réel, lui, est piloté — le test n'attend pas cinq minutes par
    // heure de jeu.
    worldNow: () => worldNow,
    startWorldClock: (onTick) => {
      tickWorld = onTick;
      return () => {
        tickWorld = () => {};
      };
    },
    roomOptions: { tickRate: 600 },
  });
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  for (const sim of sims.splice(0)) sim.dispose();
  await server.close();
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

describe("échelle du jour de bout en bout, contre le vrai serveur", () => {
  it("impose 30 au serveur et en déduit l'heure du monde", () => {
    expect(server.dayScale).toBe(WORLD_DAY_SCALE);
    expect(server.dayScale).toBe(30);
    // Une seule horloge : 14 400 × 30 / 24 ticks à 60 ticks/s = 300 000 ms.
    expect(server.world.clock.hourMs).toBe(worldHourMsFor(30));
    expect(server.world.clock.hourMs).toBe(300_000);
    // Un jour de monde : 24 heures de jeu, donc deux heures réelles.
    expect(24 * server.world.clock.hourMs).toBe(2 * 3_600_000);
  });

  it("deux clients d'une même case tombent sur le même hash à l'échelle 30", async () => {
    const { world } = await fetchWorld(server.url);
    const land = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;
    const alice = await enterWorld(world, "alice");
    alice.client.settle(land.id);
    await waitFor("settled", () => alice.settled.length === 1);
    const room = alice.settled[0].room;

    const host = await enterRoom(room, "alice");
    await waitFor("lobby hôte", () => host.client.state.phase === "lobby");
    const guest = await enterRoom(room, "bob");
    await waitFor("lobby invité", () => guest.client.state.phase === "lobby");

    host.client.startGame(1, MAP, MAP);
    await waitFor("les deux sims créés", () => host.sim() !== null && guest.sim() !== null);

    // L'échelle vient du serveur, identique des deux côtés : personne ne l'a
    // choisie, ni l'hôte ni l'invité.
    expect(host.client.state.dayScale).toBe(30);
    expect(guest.client.state.dayScale).toBe(30);
    expect(host.sim()!.dayScale()).toBe(30);
    expect(guest.sim()!.dayScale()).toBe(30);
    // Le jour du HUD est lu dans le sim, jamais recopié : 14 400 × 30.
    expect(host.sim()!.ticksPerDay()).toBe(TICKS_PER_DAY * 30);
    expect(host.sim()!.ticksPerDay()).toBe(432_000);
    expect(guest.sim()!.ticksPerDay()).toBe(432_000);

    // Une commande de l'hôte, une de l'invité : le lockstep les ordonne, les
    // deux sims les appliquent au même tick.
    host.client.issue(encodeSetDifficulty(1));
    guest.client.issue(encodeSetResearch(0));

    const target = 240;
    await pumpUntil(
      [host.client, guest.client],
      "240 ticks joués des deux côtés",
      () => host.client.tick >= target && guest.client.tick >= target,
    );
    // Même tick, même hash : la salle est synchrone à l'échelle 30.
    await pumpUntil(
      [host.client, guest.client],
      "les deux au même tick",
      () => host.client.tick === guest.client.tick,
    );
    expect(host.sim()!.tick()).toBe(guest.sim()!.tick());
    expect(host.sim()!.hash()).toBe(guest.sim()!.hash());
    expect(host.errors).toEqual([]);
    expect(guest.errors).toEqual([]);
  });

  it("livre une caravane à l'heure que la nouvelle horloge prédit", async () => {
    const { world } = await fetchWorld(server.url);
    const from = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;
    let best: { id: number; hours: number } | null = null;
    for (const tile of world.tiles) {
      if (tile.id === from.id || movementCost(tile.biome) === null) continue;
      const route = findRoute(world, from.id, tile.id);
      if (route !== null && (best === null || route.hours < best.hours)) {
        best = { id: tile.id, hours: route.hours };
      }
    }
    const to = best!;

    const alice = await enterWorld(world, "alice");
    alice.client.settle(from.id);
    await waitFor("settled", () => alice.settled.length === 1);
    const room = await enterRoom(alice.settled[0].room, "alice");
    await waitFor("lobby", () => room.client.state.phase === "lobby");
    room.client.startGame(1, MAP, MAP);
    await waitFor("sim créé", () => room.sim() !== null);

    alice.client.sendDepart({
      fromTile: from.id,
      toTile: to.id,
      manifest: new Uint8Array([1, 2, 3]),
      summary: { pawns: 1, items: [] },
    });
    await waitFor("caravane diffusée", () => alice.client.state.caravans.length === 1);
    const caravan = alice.client.state.caravans[0];
    // Le trajet est compté en **heures de jeu** (`docs/world.md` §4) : rien
    // n'a changé de ce côté, c'est l'heure elle-même qui a changé de durée.
    expect(caravan.arrivesAt - caravan.departedAt).toBeCloseTo(to.hours, 6);

    // Une heure avant l'arrivée prévue, elle est encore en route.
    const travelMs = to.hours * server.world.clock.hourMs;
    worldNow += travelMs - server.world.clock.hourMs;
    tickWorld();
    await waitFor("toujours en route", () => alice.client.caravanById(caravan.id)?.status === "travelling");

    // À l'heure dite, elle est arrivée — et « l'heure dite » n'est plus une
    // constante du serveur mais `ticks_par_jour / 24` à 60 ticks/s.
    worldNow += server.world.clock.hourMs;
    tickWorld();
    await waitFor(
      "caravane arrivée",
      () => alice.client.caravanById(caravan.id)?.status === "arrived",
    );
    // En temps réel : la case la plus proche de ce globe se traverse en
    // `to.hours × 5` minutes, pas en `to.hours × 30` secondes.
    expect(travelMs).toBe(to.hours * 300_000);
    expect(alice.errors).toEqual([]);
    expect(room.errors).toEqual([]);
  });
});
