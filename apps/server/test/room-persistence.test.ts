/** Checkpoints, redémarrage et expiration : dates et minuteurs pilotés, aucun sommeil. */
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { MAX_FROZEN_TICKS, decodeClientMessage, decodeServerMessage, encodeMessage, type ServerMessage } from "@rimlike/protocol";

import { WorldStore, resolveWorldStateFile, type ScheduleTimeout, type WorldStateFile } from "../src/persistence.js";
import { Room } from "../src/room.js";
import { MAX_SAVED_SNAPSHOT_BYTES, ROOM_PERSIST_MS, ROOM_TTL_HOURS, RoomPersistence, readSavedRooms } from "../src/room-persistence.js";
import { DEFAULT_MAX_SNAPSHOT_BYTES, startServer, type RunningServer, type ServerOptions } from "../src/server.js";
import { WorldState, sharedWorld } from "../src/world.js";
import { TestClient, bytes } from "./helpers.js";

class ManualTime {
  at = 1_800_000_000_000;
  private tasks = new Map<() => void, number>();
  readonly now = (): number => this.at;
  readonly schedule: ScheduleTimeout = (callback, ms) => {
    this.tasks.set(callback, this.at + ms);
    return () => { this.tasks.delete(callback); };
  };
  advance(ms: number): void {
    this.at += ms;
    for (const [callback, due] of [...this.tasks]) {
      if (due <= this.at) {
        this.tasks.delete(callback);
        callback();
      }
    }
  }
  get pending(): number { return this.tasks.size; }
}

let dir: string;
let file: string;
let time: ManualTime;
const servers: RunningServer[] = [];

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rimlike-rooms-"));
  file = join(dir, "world.json");
  time = new ManualTime();
});
afterEach(async () => {
  for (const server of servers.splice(0)) await server.close();
  await rm(dir, { recursive: true, force: true });
});

async function disk(): Promise<WorldStateFile> {
  return JSON.parse(await readFile(file, "utf8")) as WorldStateFile;
}

async function boot(extra: Partial<ServerOptions> = {}) {
  const clocks = new Set<() => void>();
  const server = await startServer({
    port: 0, host: "127.0.0.1", log: () => {}, worldSubdivisions: 0,
    worldStateFile: file, now: time.now, worldNow: time.now,
    worldHourMs: 1000, saveSchedule: time.schedule,
    startWorldClock: () => () => {},
    roomOptions: {
      snapshotEveryTicks: 6,
      startClock: (callback) => {
        clocks.add(callback);
        return () => { clocks.delete(callback); };
      },
    },
    ...extra,
  });
  servers.push(server);
  return { server, clocks, tick: () => { for (const callback of clocks) callback(); } };
}

async function enter(server: RunningServer, room = "démo partagée", name = "alice") {
  const client = await TestClient.connect(server.url);
  client.send({ type: "join", room, name });
  await client.nth("welcome");
  return client;
}

async function start(client: TestClient) {
  client.send({ type: "start", seed: 4242, width: 96, height: 48 });
  await client.nth("start");
}

/** Le pong garantit le traitement des trames précédentes, sans temporisation. */
async function barrier(client: TestClient) {
  const index = client.ofType("pong").length;
  client.send({ type: "ping" });
  await client.nth("pong", index);
}

async function snapshot(client: TestClient, tick = 9, data = bytes(0, 1, 254, 255)) {
  client.send({ type: "snapshot", tick, data });
  await barrier(client);
}

describe("salles nommées après redémarrage", () => {
  it("conserve le snapshot périodique, dégèle au premier join puis reprend les bundles au tick sauvé", async () => {
    const first = await boot();
    const alice = await enter(first.server);
    await start(alice);
    first.tick(); first.tick(); first.tick();
    expect(await alice.nth("request_snapshot")).toEqual({ type: "request_snapshot", forPlayer: 0 });
    await snapshot(alice);
    // L'arrêt, et non la réception du snapshot, date le gel d'une salle occupée.
    time.advance(2000);
    const stoppedAt = time.at;
    await first.server.close();
    expect((await disk()).rooms?.[0]).toMatchObject({ tick: 9, seed: 4242, frozenAt: stoppedAt });
    time.advance(5000);
    const second = await boot();
    expect(second.server.roomCount).toBe(1);
    expect(second.server.room("démo partagée")?.tick).toBe(9);
    expect(second.clocks.size).toBe(0);
    time.advance(2000); // Le gel continue après le démarrage, jusqu'à la visite.
    const bob = await enter(second.server, "démo partagée", "bob");
    expect(await bob.nth("welcome")).toMatchObject({
      state: "running", isHost: true, seed: 4242, width: 96, height: 48, tick: 9,
    });
    expect(await bob.nth("snapshot")).toEqual({ type: "snapshot", tick: 9, data: bytes(0, 1, 254, 255), frozenTicks: 4200 });
    expect(bob.ofType("start")).toEqual([]);
    second.tick(); second.tick();
    await bob.nth("bundle", 1);
    expect(bob.ofType("bundle").map((b) => b.from)).toEqual([9, 12]);
    const carol = await enter(second.server, "démo partagée", "carol");
    expect((await carol.nth("welcome")).isHost).toBe(false);
    const request = await bob.nth("request_snapshot");
    bob.send({ type: "snapshot", tick: 15, data: bytes(7), forPlayer: request.forPlayer });
    expect(await carol.nth("snapshot")).toEqual({ type: "snapshot", tick: 15, data: bytes(7) });
  });

  it("garde aussi le snapshot destiné à un rejoignant, ignore un invité et un état plus ancien", async () => {
    const { server } = await boot();
    const alice = await enter(server);
    await start(alice);
    const bob = await enter(server, "démo partagée", "bob");
    const request = await alice.nth("request_snapshot");
    alice.send({ type: "snapshot", tick: 0, data: bytes(8), forPlayer: request.forPlayer });
    await bob.nth("snapshot");
    await snapshot(alice, 9, bytes(9));
    await snapshot(alice, 3, bytes(3));
    await snapshot(bob, 100, bytes(100));
    expect((await bob.nth("error")).code).toBe("not_host");
    await server.close();
    expect((await disk()).rooms?.[0]).toMatchObject({ tick: 9, data: "CQ==" });
  });

  it("rouvre une salle vidée et conserve son gel à travers plusieurs arrêts sans visite", async () => {
    const first = await boot();
    const alice = await enter(first.server);
    await start(alice);
    await snapshot(alice);
    const room = first.server.room("démo partagée")!;
    const origin = time.at;
    // Les deux sockets émettent « close » indépendamment : celui du client ne
    // garantit pas encore le retrait du joueur ni le gel côté serveur.
    alice.close();
    await alice.waitUntil("fermeture", () => alice.closed);
    // waitUntil n'est réveillé que par le client, désormais fermé. Sonder l'état
    // serveur avant d'avancer l'horloge ; aucun délai fixe ne prouve le départ.
    await expect.poll(() => room.isEmpty, { timeout: 4000 }).toBe(true);
    expect(first.clocks.size).toBe(0);
    time.advance(1000);
    await first.server.close();
    expect((await disk()).rooms![0]!.frozenAt).toBe(origin);
    const second = await boot();
    time.advance(1000);
    await second.server.close();
    expect((await disk()).rooms![0]!.frozenAt).toBe(origin);
    const third = await boot();
    const bob = await enter(third.server);
    expect((await bob.nth("snapshot")).frozenTicks).toBe(1200);
  });

  it("oublie les salles expirées au démarrage et au join, sans prolonger le TTL par une sauvegarde", async () => {
    const first = await boot({ roomTtlHours: 1 });
    const alice = await enter(first.server);
    await start(alice);
    await snapshot(alice);
    await first.server.close();
    const initial = await readFile(file, "utf8");
    time.advance(3_600_000);
    const expired = await boot({ roomTtlHours: 1 });
    expect(expired.server.roomCount).toBe(0);
    expect((await (await enter(expired.server)).nth("welcome")).state).toBe("lobby");
    await expired.server.close();
    await writeFile(file, initial);
    time.at -= 3_600_000;
    const waiting = await boot({ roomTtlHours: 1, maxRooms: 1 });
    time.advance(3_600_000);
    const fresh = await enter(waiting.server, "autre");
    expect((await fresh.nth("welcome")).state).toBe("lobby");
    expect(waiting.server.room("démo partagée")).toBeUndefined();
    await waiting.server.close();
    expect((await disk()).rooms).toEqual([]);
  });

  it("ne sauve ni lobby ni salle en jeu dépourvue de snapshot", async () => {
    const { server } = await boot();
    await enter(server, "lobby");
    const alice = await enter(server, "sans-snapshot");
    await start(alice);
    await server.close();
    expect((await disk()).rooms).toEqual([]);
  });

  it("WORLD_PERSIST=0 désactive lecture, conservation et écritures des salles", async () => {
    const sentinel = "fichier intact";
    await writeFile(file, sentinel);
    const { server, tick } = await boot({
      worldStateFile: resolveWorldStateFile({ WORLD_STATE_FILE: file, WORLD_PERSIST: "0" }),
    });
    const alice = await enter(server);
    await start(alice);
    tick(); tick(); tick();
    await snapshot(alice);
    expect(alice.ofType("request_snapshot")).toEqual([]);
    await server.close();
    expect(await readFile(file, "utf8")).toBe(sentinel);
    expect(time.pending).toBe(0);
  });
});

describe("fichier commun et horloge injectée", () => {
  function setup() {
    const registry = new RoomPersistence(time.now);
    registry.visit("demo");
    registry.snapshot("demo", 42, time.at, { tick: 3, data: bytes(1), width: 64, height: 32 });
    const state = new WorldState({ world: sharedWorld(0, 1), now: time.now, merchantCount: 0 });
    const store = new WorldStore({
      file, worldSeed: 1, subdivisions: 0, now: time.now, schedule: time.schedule,
      rooms: () => registry.toJSON(), minIntervalMs: () => ROOM_PERSIST_MS, log: () => {},
    });
    return { registry, state, store };
  }

  it("reprend une salle nommée sans transport, avec le gel au premier hôte seulement", () => {
    const { registry } = setup();
    registry.freeze("demo");
    let onBundle: (() => void) | undefined;
    const room = new Room({
      name: "demo", restore: registry.restore("demo", 1000)!,
      frozenTicks: () => registry.restore("demo", 1000)?.frozenTicks ?? 0,
      startClock: (callback) => { onBundle = callback; return () => { onBundle = undefined; }; },
      log: () => {},
    });
    expect(onBundle).toBeUndefined();
    time.advance(5000);
    const messages: ServerMessage[] = [];
    const host = room.join("alice", (text) => { messages.push(decodeServerMessage(text)!); })!;
    expect(messages.find((m) => m.type === "welcome")).toMatchObject({ state: "running", seed: 42, tick: 3, isHost: true });
    expect(messages.find((m) => m.type === "snapshot")).toEqual({ type: "snapshot", tick: 3, data: bytes(1), frozenTicks: 3000 });
    onBundle!();
    expect(messages.find((m) => m.type === "bundle")).toMatchObject({ from: 3, to: 5 });
    const guestMessages: ServerMessage[] = [];
    const guest = room.join("bob", (text) => { guestMessages.push(decodeServerMessage(text)!); })!;
    room.handle(host, { type: "snapshot", tick: 6, data: bytes(2), forPlayer: guest });
    expect(guestMessages.find((m) => m.type === "snapshot")).toEqual({ type: "snapshot", tick: 6, data: bytes(2) });
  });

  it("collecte les snapshots pour les rejoignants et réclame aussi un checkpoint périodique", () => {
    const reports: number[] = [];
    let onBundle: (() => void) | undefined;
    const room = new Room({
      name: "demo", snapshotEveryTicks: 3, log: () => {},
      onSnapshot: (report) => { reports.push(report.tick); },
      startClock: (callback) => { onBundle = callback; return () => {}; },
    });
    const messages: ServerMessage[] = [];
    const host = room.join("alice", (text) => { messages.push(decodeServerMessage(text)!); })!;
    room.handle(host, { type: "start", seed: 42, width: 64, height: 32 });
    const guest = room.join("bob", () => {})!;
    room.handle(host, { type: "snapshot", tick: 0, data: bytes(1), forPlayer: guest });
    room.handle(guest, { type: "snapshot", tick: 1, data: bytes(9) });
    expect(reports).toEqual([0]);
    onBundle!(); onBundle!();
    expect(messages.filter((m) => m.type === "request_snapshot")).toEqual([
      { type: "request_snapshot", forPlayer: guest }, { type: "request_snapshot", forPlayer: 0 },
    ]);
  });

  it("borne les écritures malgré les rafales de snapshots et les mutations du monde, sans famine", async () => {
    const { registry, state, store } = setup();
    store.scheduleSave(state);
    for (let i = 1; i <= 29; i++) {
      time.advance(1000);
      registry.snapshot("demo", 42, time.at, { tick: i * 3, data: bytes(i), width: 64, height: 32 });
      state.createPlayer("visiteur");
      store.scheduleSave(state);
    }
    expect(store.lastSavedAt).toBeNull();
    time.advance(1000);
    await store.idle();
    expect((await disk()).rooms?.[0]?.tick).toBe(87);
    const firstWrite = store.lastSavedAt;
    registry.snapshot("demo", 42, time.at, { tick: 90, data: bytes(90), width: 64, height: 32 });
    store.scheduleSave(state);
    time.advance(29_999);
    await store.idle();
    expect(store.lastSavedAt).toBe(firstWrite);
    time.advance(1);
    await store.idle();
    expect((await disk()).rooms?.[0]?.tick).toBe(90);
  });

  it("l'arrêt force le dernier état, même pendant une écriture, et annule le minuteur", async () => {
    const { registry, state, store } = setup();
    const first = store.save(state);
    registry.snapshot("demo", 42, time.at, { tick: 12, data: bytes(12), width: 64, height: 32 });
    store.scheduleSave(state);
    await Promise.all([first, store.save(state)]);
    expect(time.pending).toBe(0);
    expect((await disk()).rooms?.[0]?.tick).toBe(12);
    expect(store.lastSavedAt).toBe(time.at);
  });

  it.each([1, 2, 3, 4] as const)("relit la version %i et réécrit en version 5", async (version) => {
    const { state, store } = setup();
    const json = state.toJSON();
    const { players: _players, ...legacy } = json;
    await writeFile(file, JSON.stringify({ version, worldSeed: 1, subdivisions: 0, savedAt: time.at,
      state: version === 1 ? legacy : json }));
    const loaded = await store.load(sharedWorld(0, 1), { now: time.now });
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind !== "loaded") throw new Error("chargement refusé");
    expect(loaded.rooms).toEqual([]);
    await store.save(loaded.state);
    expect((await disk()).version).toBe(5);
  });

  it("relit les salles v5 sans perdre les octets", async () => {
    const { state, store } = setup();
    await store.save(state);
    const reader = new WorldStore({ file, worldSeed: 1, subdivisions: 0, now: time.now });
    const loaded = await reader.load(sharedWorld(0, 1));
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind !== "loaded") throw new Error("chargement refusé");
    expect(loaded.rooms[0]?.data).toBe("AQ==");
    await reader.save(loaded.state);
    expect((await disk()).rooms).toEqual(loaded.rooms);
  });

  it("refuse de conserver le tick 1e20 reçu de l'hôte malgré son acceptation par le codec", async () => {
    const { registry, state, store } = setup();
    const room = new Room({
      name: "hostile", now: time.now, startClock: () => () => {}, log: () => {},
      onSnapshot: (report) => { registry.snapshot("hostile", room.seed!, room.createdAt, report); },
    });
    const host = room.join("alice", () => {})!;
    room.handle(host, { type: "start", seed: 42, width: 64, height: 32 });
    const message = decodeClientMessage(encodeMessage({ type: "snapshot", tick: 1e20, data: bytes(9) }));
    expect(message).not.toBeNull();
    room.handle(host, message!);
    expect(registry.get("hostile")).toBeUndefined();
    expect(registry.restore("hostile", 1000)).toBeUndefined();

    room.handle(host, { type: "snapshot", tick: 6, data: bytes(6) });
    const valid = registry.get("hostile");
    time.advance(1000);
    room.handle(host, message!);
    expect(registry.get("hostile")).toEqual(valid);
    await store.save(state);
    expect((await disk()).rooms?.map((entry) => entry.tick)).toEqual([3, 6]);
    room.stop();
  });

  it.each([
    { tick: -1 }, { tick: 1.5 }, { tick: 1e20 }, { tick: Number.MAX_SAFE_INTEGER + 1 },
    { tick: NaN }, { tick: Infinity },
    { seed: -1 }, { seed: 1.5 }, { seed: Number.MAX_SAFE_INTEGER + 1 },
    { width: 0 }, { width: 4097 }, { width: 1.5 },
    { height: 0 }, { height: 4097 }, { height: 1.5 },
    { name: "" }, { name: "tile-1" }, { name: "a".repeat(65) }, { createdAt: -1 },
  ])("ignore les métadonnées non persistables : %j", (invalid) => {
    const { registry } = setup();
    const before = registry.toJSON();
    const candidate = { name: "demo", seed: 42, createdAt: time.at, tick: 6, data: bytes(9), width: 64, height: 32, ...invalid };
    registry.snapshot(candidate.name, candidate.seed, candidate.createdAt, candidate);
    expect(registry.toJSON()).toEqual(before);
    expect(readSavedRooms([{ ...before[0], ...invalid }], () => {})).toEqual([]);
  });

  it.each([0, Number.MAX_SAFE_INTEGER])("accepte les bornes sûres de tick et graine : %i", (boundary) => {
    const registry = new RoomPersistence(time.now);
    registry.snapshot("limites", boundary, time.at, { tick: boundary, data: bytes(0, 255), width: 1, height: 4096 });
    expect(registry.size).toBe(1);
    expect(readSavedRooms(registry.toJSON())).toEqual(registry.toJSON());
    expect(registry.restore("limites", 1000)).toMatchObject({ seed: boundary, tick: boundary, data: bytes(0, 255) });
  });

  it("borne les octets avant conservation et à la lecture, y compris le dernier quartet base64", () => {
    const { registry } = setup();
    const before = registry.toJSON();
    expect(MAX_SAVED_SNAPSHOT_BYTES).toBe(DEFAULT_MAX_SNAPSHOT_BYTES);
    const data = new Uint8Array(MAX_SAVED_SNAPSHOT_BYTES + 1);
    registry.snapshot("demo", 42, time.at, { tick: 6, data, width: 64, height: 32 });
    expect(registry.toJSON()).toEqual(before);
    const atLimit = { ...before[0]!, data: Buffer.alloc(MAX_SAVED_SNAPSHOT_BYTES).toString("base64") };
    expect(readSavedRooms([atLimit])).toEqual([atLimit]);
    for (const size of [MAX_SAVED_SNAPSHOT_BYTES + 1, MAX_SAVED_SNAPSHOT_BYTES + 3]) {
      expect(readSavedRooms([{ ...atLimit, data: Buffer.alloc(size).toString("base64") }], () => {})).toEqual([]);
    }
  });

  it.each([
    null, 42, [], {}, { tick: 1e20 }, { data: "invalide!" }, { name: "tile-1" }, { frozenAt: -1 },
  ])("charge le fichier sans quarantaine malgré une salle corrompue : %j", async (invalid) => {
    const { registry, state, store } = setup();
    const globe = sharedWorld(0, 1);
    const player = state.createPlayer("alice");
    const tile = globe.tiles.find((tile) => state.canSettle(tile.id))!.id;
    expect(state.settle(tile, player.key)).toMatchObject({ ok: true });
    state.saveSnapshot(`tile-${tile}`, { tick: 9, data: bytes(4, 2), width: 32, height: 32 });
    await store.save(state);
    const saved = await disk();
    const demo = registry.get("demo")!;
    const corrupt = invalid !== null && typeof invalid === "object" && !Array.isArray(invalid)
      ? (Object.keys(invalid).length === 0 ? invalid : { ...demo, ...invalid })
      : invalid;
    const rooms = [{ ...demo, name: "avant" }, corrupt, demo, { ...demo, name: "après" }];
    const raw = JSON.stringify({ ...saved, rooms });
    await writeFile(file, raw);
    const messages: string[] = [];
    const reader = new WorldStore({ file, worldSeed: 1, subdivisions: 0, now: time.now, log: (line) => messages.push(line) });
    const loaded = await reader.load(globe, { now: time.now, merchantCount: 0 });
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind !== "loaded") throw new Error("chargement refusé");
    expect(loaded.rooms).toEqual([rooms[0], demo, rooms[3]]);
    expect(loaded.state.list()).toEqual(state.list());
    expect(loaded.state.listPlayers()).toEqual(state.listPlayers());
    expect(loaded.state.snapshotFor(`tile-${tile}`)).toEqual(state.snapshotFor(`tile-${tile}`));
    expect(messages).toEqual(["[monde] salle sauvegardée incohérente à l'index 1, ignorée"]);
    expect(await readFile(file, "utf8")).toBe(raw);
    expect(await readdir(dir)).toEqual(["world.json"]);
    await reader.save(loaded.state);
    expect((await disk()).rooms).toEqual(loaded.rooms);
  });

  it("garde la première salle valide en cas de doublon et journalise l'entrée ignorée", () => {
    const { registry } = setup();
    const demo = registry.get("demo")!;
    const messages: string[] = [];
    expect(readSavedRooms([demo, { ...demo, tick: 12 }, { ...demo, name: "autre" }], (line) => messages.push(line)))
      .toEqual([demo, { ...demo, name: "autre" }]);
    expect(messages).toHaveLength(1);
  });

  it("borne frozenTicks, protège les salles occupées du TTL et renouvelle la dernière visite", () => {
    const { registry } = setup();
    expect(ROOM_TTL_HOURS).toBe(72);
    time.advance(73 * 3_600_000);
    expect(registry.prune()).toEqual([]);
    registry.freeze("demo");
    const frozenAt = time.at;
    time.advance(10_000_000);
    expect(registry.restore("demo", 1000)?.frozenTicks).toBe(MAX_FROZEN_TICKS);
    registry.visit("demo");
    registry.freeze("demo");
    expect(registry.get("demo")?.lastVisitedAt).toBe(time.at);
    time.at = frozenAt - 1;
    expect(registry.restore("demo", 1000)?.frozenTicks).toBe(0);
  });
});
