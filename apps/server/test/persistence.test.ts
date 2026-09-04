/**
 * Tests de la persistance disque de `WorldState` :
 *
 * - `WorldState.toJSON`/`fromJSON`, l'aller-retour (déjà couvert en détail par
 *   `world.test.ts`, redit ici succinctement — c'est la base sur laquelle
 *   `WorldStore` s'appuie) ;
 * - `WorldStore` en isolation (écriture atomique, débounce, quarantaine) ;
 * - le cycle complet à travers un vrai serveur : redémarrage sur le même
 *   fichier, et fichier ignoré quand le globe a changé.
 *
 * Chaque test d'écriture travaille dans son propre dossier temporaire
 * (`fs.mkdtemp`), jamais dans `apps/server/data/` : ce dossier ne doit être
 * touché par aucun test, existant ou nouveau (voir la dernière section).
 */

import { mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { movementCost } from "@rimlike/world";

import {
  DEFAULT_WORLD_STATE_FILE,
  WORLD_STATE_FILE_VERSION,
  WorldStore,
  resolveWorldStateFile,
  type WorldStateFile,
} from "../src/persistence.js";
import { startServer, type RunningServer } from "../src/server.js";
import { DEFAULT_WORLD_SEED, WorldState, sharedWorld } from "../src/world.js";
import { TestClient, bytes } from "./helpers.js";

const SUBDIVISIONS = 2;
const globe = sharedWorld(SUBDIVISIONS, DEFAULT_WORLD_SEED);
const landTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) !== null);

/** Attend une condition sur l'état du serveur (pas sur un flux de messages). */
async function until(label: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`délai dépassé en attendant : ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

let dir: string;

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), "rimlike-world-state-"));
});

afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

describe("résolution de la configuration", () => {
  it("WORLD_PERSIST=0 et WORLD_STATE_FILE vide désactivent, sinon la variable ou le défaut choisit le fichier", () => {
    expect(resolveWorldStateFile({ WORLD_PERSIST: "0", WORLD_STATE_FILE: "/tmp/x.json" })).toBeNull();
    expect(resolveWorldStateFile({ WORLD_STATE_FILE: "" })).toBeNull();
    expect(resolveWorldStateFile({ WORLD_STATE_FILE: "/tmp/x.json" })).toBe("/tmp/x.json");
    expect(resolveWorldStateFile({})).toBe(DEFAULT_WORLD_STATE_FILE);
  });
});

describe("WorldState : aller-retour JSON", () => {
  it("conserve colonies et octets de snapshot exactement", () => {
    const state = new WorldState({ world: globe, now: () => 1_757_000_000_000 });
    state.settle(landTile, "alice");
    const data = new Uint8Array([0, 1, 2, 254, 255]);
    state.saveSnapshot(`tile-${landTile}`, { tick: 1800, data, width: 96, height: 64 });

    const json = JSON.parse(JSON.stringify(state.toJSON())) as ReturnType<WorldState["toJSON"]>;
    const back = WorldState.fromJSON(json, { world: globe });

    expect(back.list()).toEqual(state.list());
    expect(back.snapshotFor(`tile-${landTile}`)).toEqual(state.snapshotFor(`tile-${landTile}`));
    expect(back.snapshotFor(`tile-${landTile}`)?.data).toEqual(data);
  });
});

describe("WorldStore : écriture et lecture", () => {
  it("écrit un JSON valide et atomique (pas de .tmp résiduel), et le relit", async () => {
    const file = join(dir, "world-state.json");
    const store = new WorldStore({ file, worldSeed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, log: () => {} });
    const state = new WorldState({ world: globe, now: () => 42 });
    state.settle(landTile, "alice");

    await store.save(state);

    await expect(stat(`${file}.tmp`)).rejects.toThrow();
    const onDisk = JSON.parse(await readFile(file, "utf8")) as WorldStateFile;
    expect(onDisk.version).toBe(WORLD_STATE_FILE_VERSION);
    expect(onDisk.worldSeed).toBe(DEFAULT_WORLD_SEED);
    expect(onDisk.subdivisions).toBe(SUBDIVISIONS);
    expect(onDisk.state.settlements).toHaveLength(1);
    expect(store.lastSavedAt).toBe(onDisk.savedAt);

    const reader = new WorldStore({ file, worldSeed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, log: () => {} });
    const loaded = await reader.load(globe);
    expect(loaded.kind).toBe("loaded");
    if (loaded.kind === "loaded") {
      expect(loaded.state.list()).toEqual(state.list());
      expect(loaded.savedAt).toBe(onDisk.savedAt);
    }
  });

  it("crée le dossier du fichier s'il n'existe pas", async () => {
    const file = join(dir, "nested", "deeper", "world-state.json");
    const store = new WorldStore({ file, worldSeed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, log: () => {} });
    await store.save(new WorldState({ world: globe }));
    expect((await stat(file)).isFile()).toBe(true);
  });

  it("renvoie 'none' quand le fichier n'existe pas", async () => {
    const store = new WorldStore({
      file: join(dir, "absent.json"),
      worldSeed: DEFAULT_WORLD_SEED,
      subdivisions: SUBDIVISIONS,
      log: () => {},
    });
    expect(await store.load(globe)).toEqual({ kind: "none" });
  });

  it("ignore et renomme un fichier écrit pour un autre globe", async () => {
    const file = join(dir, "world-state.json");
    const otherGlobe = sharedWorld(SUBDIVISIONS, 999);
    const writer = new WorldStore({ file, worldSeed: 999, subdivisions: SUBDIVISIONS, log: () => {} });
    await writer.save(new WorldState({ world: otherGlobe }));

    const messages: string[] = [];
    const reader = new WorldStore({
      file,
      worldSeed: DEFAULT_WORLD_SEED,
      subdivisions: SUBDIVISIONS,
      log: (line) => messages.push(line),
    });
    const result = await reader.load(globe);
    expect(result.kind).toBe("ignored");
    if (result.kind !== "ignored") {
      return;
    }
    expect(result.reason).toBe("mismatch");
    expect(result.quarantineFile).toMatch(/\.ignored-\d+\.json$/);
    expect((await stat(result.quarantineFile!)).isFile()).toBe(true);
    await expect(stat(file)).rejects.toThrow();
    expect(messages.some((line) => line.includes("changement de globe"))).toBe(true);
  });

  it("ignore et renomme un JSON illisible", async () => {
    const file = join(dir, "world-state.json");
    await writeFile(file, "{ ceci n'est pas du json", "utf8");

    const store = new WorldStore({ file, worldSeed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, log: () => {} });
    const result = await store.load(globe);
    expect(result.kind).toBe("ignored");
    if (result.kind !== "ignored") {
      return;
    }
    expect(result.reason).toBe("corrupt");
    expect((await stat(result.quarantineFile!)).isFile()).toBe(true);
  });
});

describe("WorldStore : débounce", () => {
  it("n'écrit qu'une fois pour trois scheduleSave() rapprochés", async () => {
    const file = join(dir, "world-state.json");
    const store = new WorldStore({
      file,
      worldSeed: DEFAULT_WORLD_SEED,
      subdivisions: SUBDIVISIONS,
      debounceMs: 20,
      log: () => {},
    });
    let writes = 0;
    const realSave = store.save.bind(store);
    store.save = async (state) => {
      writes += 1;
      await realSave(state);
    };

    const state = new WorldState({ world: globe });
    state.settle(landTile, "alice");
    store.scheduleSave(state);
    store.scheduleSave(state);
    store.scheduleSave(state);

    await new Promise((resolve) => setTimeout(resolve, 80));
    expect(writes).toBe(1);
    expect(store.lastSavedAt).not.toBeNull();
    expect((await stat(file)).isFile()).toBe(true);
  });
});

describe("cycle complet à travers un vrai serveur", () => {
  let servers: RunningServer[] = [];
  const clients: TestClient[] = [];

  afterEach(async () => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
    for (const server of servers) {
      await server.close();
    }
    servers = [];
  });

  async function boot(worldStateFile: string, worldSeed = DEFAULT_WORLD_SEED): Promise<RunningServer> {
    const server = await startServer({
      port: 0,
      log: () => {},
      worldSeed,
      worldSubdivisions: SUBDIVISIONS,
      worldStateFile,
      saveDebounceMs: 20,
      roomOptions: { tickRate: 60_000, bundleTicks: 600 },
    });
    servers.push(server);
    return server;
  }

  async function connect(server: RunningServer): Promise<TestClient> {
    const client = await TestClient.connect(server.url);
    clients.push(client);
    return client;
  }

  it("survit à un redémarrage (colonie et snapshot conservé), et ignore un autre globe", async () => {
    const file = join(dir, "world-state.json");
    const first = await boot(file);
    expect(first.persistence).toEqual({ enabled: true, file, lastSavedAt: null });

    const alice = await connect(first);
    alice.send({ type: "world_join", name: "alice" });
    await alice.next("world_welcome");
    alice.send({ type: "settle", tile: landTile });
    const settled = await alice.next("settled");

    // La fondation déclenche une sauvegarde différée : on l'attend.
    await until("sauvegarde de la fondation", () => first.persistence.lastSavedAt !== null);
    const onDiskAfterSettle = JSON.parse(await readFile(file, "utf8")) as WorldStateFile;
    expect(onDiskAfterSettle.state.settlements).toEqual([
      expect.objectContaining({ tile: landTile, owner: "alice", room: settled.room }) as unknown,
    ]);

    // L'hôte joue, produit un snapshot de conservation.
    alice.send({ type: "join", room: settled.room, name: "alice" });
    await alice.nth("welcome");
    alice.send({ type: "start", seed: 1, width: 64, height: 64 });
    await alice.nth("start");
    await alice.nth("request_snapshot");
    const tick = alice.ofType("bundle").at(-1)!.to + 1;
    alice.send({ type: "snapshot", tick, data: bytes(9, 8, 7) });

    await until("snapshot conservé côté monde", () => first.world.snapshotFor(settled.room) !== undefined);
    const savedAtBeforeClose = first.persistence.lastSavedAt;
    await until(
      "sauvegarde du snapshot conservé",
      () => first.persistence.lastSavedAt !== null && first.persistence.lastSavedAt !== savedAtBeforeClose,
    );

    await first.close();

    // Redémarrage sur le même fichier : la colonie et son snapshot sont là.
    const second = await boot(file);
    expect(second.world.settlementCount).toBe(1);
    expect(second.world.snapshotFor(settled.room)?.data).toEqual(bytes(9, 8, 7));

    const bob = await connect(second);
    bob.send({ type: "world_join", name: "bob" });
    const welcome = await bob.next("world_welcome");
    expect(welcome.settlements.map((s) => s.tile)).toEqual([landTile]);

    // Un `join` sur sa salle la rouvre directement en jeu, depuis le snapshot.
    bob.send({ type: "visit", tile: landTile });
    const destination = await bob.next("settled");
    expect(destination.room).toBe(settled.room);
    bob.send({ type: "join", room: destination.room, name: "bob" });
    const roomWelcome = await bob.nth("welcome");
    expect(roomWelcome.state).toBe("running");
    expect(roomWelcome.tick).toBe(tick);
    const snapshot = await bob.nth("snapshot");
    expect(snapshot.data).toEqual(bytes(9, 8, 7));

    await second.close();

    // `WORLD_SEED` différent au redémarrage : le fichier ne correspond plus
    // au globe régénéré, il est ignoré et renommé plutôt que rechargé.
    const third = await boot(file, DEFAULT_WORLD_SEED + 1);
    expect(third.world.settlementCount).toBe(0);
    const entries = await readdir(dir);
    expect(entries.some((name) => name.includes(".ignored-"))).toBe(true);
  });
});

describe("mode mémoire par défaut", () => {
  const clients: TestClient[] = [];

  afterEach(() => {
    for (const client of clients) {
      client.close();
    }
    clients.length = 0;
  });

  it("n'écrit rien sur le disque quand worldStateFile n'est pas précisé (comme tous les autres tests serveur)", async () => {
    const server = await startServer({ port: 0, log: () => {}, worldSubdivisions: SUBDIVISIONS });
    try {
      expect(server.persistence).toEqual({ enabled: false, file: null, lastSavedAt: null });
      const alice = await TestClient.connect(server.url);
      clients.push(alice);
      alice.send({ type: "world_join", name: "alice" });
      await alice.next("world_welcome");
      alice.send({ type: "settle", tile: landTile });
      await alice.next("settled");
      // `persistence.enabled` reflète directement l'absence de `WorldStore`
      // interne : aucune écriture n'a pu être programmée, quoi qu'il se passe
      // dans la salle ou le monde. On n'observe pas un chemin de fichier
      // partagé (`DEFAULT_WORLD_STATE_FILE`) depuis un test : une exécution
      // concurrente du vrai serveur (`pnpm dev:server`) sur la même machine
      // pourrait légitimement y écrire au même moment.
      expect(server.persistence.enabled).toBe(false);
    } finally {
      await server.close();
    }
  });
});
