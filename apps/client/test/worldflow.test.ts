/**
 * Le parcours complet du monde, contre le **vrai** serveur : télécharger le
 * globe, entrer dans le monde, s'installer sur une case, jouer sa salle, puis
 * y revenir après que la salle a été détruite.
 *
 * C'est le seul endroit où le client exerce `GET /world` et la réouverture
 * d'une colonie depuis un snapshot de conservation (`docs/protocol.md` §11.6) —
 * deux chemins qu'aucun transport factice ne peut vérifier honnêtement.
 *
 * Le sim est un `FakeSim` déterministe, comme dans `lockstep.test.ts` : ce qui
 * est éprouvé ici est le réseau, pas le gameplay.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { SettledMessage } from "@rimlike/protocol";
import { movementCost, tileCount, type World } from "@rimlike/world";

import { startServer, type RunningServer } from "../../server/src/server.js";
import { LockstepClient, type LockstepError } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import { WorldClient, type WorldError } from "../src/net/WorldClient";
import { WsTransport } from "../src/net/WsTransport";
import { fetchWorld } from "../src/net/worldFetch";

/** Globe minuscule : 162 cases, généré en quelques millisecondes. */
const SUBDIVISIONS = 2;
const WORLD_SEED = 7;
/** Snapshot de conservation réclamé tôt : le test n'attend pas 1800 ticks. */
const SNAPSHOT_EVERY = 30;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const hex = (data: Uint8Array): string => Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");

interface FakeState {
  seed: number;
  tick: number;
  applied: string[];
}

/** Sim sans WASM : son état est la suite des commandes appliquées. */
class FakeSim implements SimLike {
  private constructor(private readonly inner: FakeState) {}

  static fresh(seed: number): FakeSim {
    return new FakeSim({ seed, tick: 0, applied: [] });
  }

  static fromSnapshot(data: Uint8Array): FakeSim {
    return new FakeSim(JSON.parse(new TextDecoder().decode(data)) as FakeState);
  }

  tick(): number {
    return this.inner.tick;
  }

  step(n: number): void {
    this.inner.tick += n;
  }

  applyEncoded(data: Uint8Array): void {
    this.inner.applied.push(`${this.inner.tick}:${hex(data)}`);
  }

  hash(): string {
    return `${this.inner.seed}|${this.inner.tick}|${this.inner.applied.join(",")}`;
  }

  snapshot(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.inner));
  }

  get seed(): number {
    return this.inner.seed;
  }

  trace(): readonly string[] {
    return this.inner.applied;
  }
}

let server: RunningServer;
const closers: Array<() => void> = [];

async function waitFor(label: string, done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé en attendant : ${label}`);
    await sleep(2);
  }
}

/** Une connexion monde branchée sur le vrai serveur. */
async function enterWorld(world: World, name: string) {
  const transport = await WsTransport.connect(server.url);
  const settled: SettledMessage[] = [];
  const errors: WorldError[] = [];
  const client = new WorldClient({
    transport,
    name,
    expected: { seed: world.seed, subdivisions: world.subdivisions, tiles: world.tiles.length },
    onSettled: (message) => settled.push(message),
    onError: (error) => errors.push(error),
  });
  closers.push(() => client.close());
  client.join();
  await waitFor(`${name} dans le monde`, () => client.state.phase === "connected");
  return { client, settled, errors };
}

/** Une connexion de salle, avec son sim factice. */
async function enterRoom(room: string, name: string) {
  const transport = await WsTransport.connect(server.url);
  const errors: LockstepError[] = [];
  const client = new LockstepClient({
    transport,
    createSim: (seed) => Promise.resolve(FakeSim.fresh(seed)),
    restoreSim: (data) => Promise.resolve(FakeSim.fromSnapshot(data)),
    onError: (error) => errors.push(error),
  });
  closers.push(() => client.close());
  client.join(room, name);
  return { client, errors, sim: () => client.sim as FakeSim | null };
}

/** Pompe comme le ferait la boucle du Worker jusqu'à ce que `done` soit vrai. */
async function pumpUntil(client: LockstepClient, label: string, done: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    client.pump(64);
    if (done()) return;
    if (Date.now() > deadline) throw new Error(`délai dépassé : ${label} (tick ${client.tick})`);
    await sleep(2);
  }
}

beforeEach(async () => {
  server = await startServer({
    port: 0,
    log: () => {},
    worldSeed: WORLD_SEED,
    worldSubdivisions: SUBDIVISIONS,
    // Horloge accélérée et conservation rapprochée : le test tient en une seconde.
    roomOptions: { tickRate: 600, snapshotEveryTicks: SNAPSHOT_EVERY },
  });
});

afterEach(async () => {
  for (const close of closers.splice(0)) close();
  await server.close();
});

describe("écran Monde contre le vrai serveur", () => {
  it("télécharge le globe par GET /world et le désérialise", async () => {
    const { world, payload } = await fetchWorld(server.url);

    expect(payload.seed).toBe(WORLD_SEED);
    expect(payload.subdivisions).toBe(SUBDIVISIONS);
    expect(world.seed).toBe(WORLD_SEED);
    expect(world.tiles.length).toBe(tileCount(SUBDIVISIONS));
    // Le globe reçu est complet : chaque case a son polygone et ses voisins.
    for (const tile of world.tiles) {
      expect(tile.polygon.length === 5 || tile.polygon.length === 6).toBe(true);
      expect(tile.neighbors.length).toBe(tile.polygon.length);
    }
    // Et il porte bien des terres : il y a où s'installer.
    expect(world.tiles.some((tile) => movementCost(tile.biome) !== null)).toBe(true);
  });

  it("s'installe sur une case et entre dans sa salle avec la graine imposée", async () => {
    const { world } = await fetchWorld(server.url);
    const land = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;
    const alice = await enterWorld(world, "alice");

    alice.client.settle(land.id);
    await waitFor("settled", () => alice.settled.length === 1);
    const settled = alice.settled[0];
    expect(settled.tile).toBe(land.id);
    expect(settled.room).toBe(`tile-${land.id}`);

    // Le monde diffuse la colonie à tout le monde, y compris à son auteur.
    await waitFor("colonie diffusée", () => alice.client.settlementAt(land.id) !== undefined);
    expect(alice.client.settlementAt(land.id)?.owner).toBe("alice");

    const room = await enterRoom(settled.room, "alice");
    await waitFor("lobby", () => room.client.state.phase === "lobby");
    // Le client propose sa graine ; le serveur impose celle de la case (§11.2).
    room.client.startGame(12345, 16, 16);
    await waitFor("sim créé", () => room.sim() !== null);
    expect(room.client.state.seed).toBe(settled.seed);
    expect(room.sim()?.seed).toBe(settled.seed);
  });

  it("refuse une case d'océan et une case déjà colonisée", async () => {
    const { world } = await fetchWorld(server.url);
    const ocean = world.tiles.find((tile) => movementCost(tile.biome) === null)!;
    const land = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;
    const alice = await enterWorld(world, "alice");

    alice.client.settle(ocean.id);
    await waitFor("refus not_land", () => alice.errors.length === 1);
    expect(alice.errors[0].code).toBe("not_land");
    // Refusé, mais toujours dans le monde : on choisit une autre case.
    expect(alice.client.state.phase).toBe("connected");

    alice.client.settle(land.id);
    await waitFor("settled", () => alice.settled.length === 1);

    const bob = await enterWorld(world, "bob");
    bob.client.settle(land.id);
    await waitFor("refus occupied", () => bob.errors.length === 1);
    expect(bob.errors[0].code).toBe("occupied");
    // `visit` sur la même case, lui, donne la salle : c'est le chemin d'invité.
    bob.client.visit(land.id);
    await waitFor("visite acceptée", () => bob.settled.length === 1);
    expect(bob.settled[0].room).toBe(`tile-${land.id}`);
  });

  it("reprend une colonie rouverte : welcome running, snapshot, puis bundles", async () => {
    const { world } = await fetchWorld(server.url);
    const land = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;
    const alice = await enterWorld(world, "alice");
    alice.client.settle(land.id);
    await waitFor("settled", () => alice.settled.length === 1);
    const room = alice.settled[0].room;

    // --- Première session : on joue, on laisse un snapshot de conservation ---
    const first = await enterRoom(room, "alice");
    await waitFor("lobby", () => first.client.state.phase === "lobby");
    first.client.startGame(1, 16, 16);
    await waitFor("sim créé", () => first.sim() !== null);
    first.client.issue(new Uint8Array([0xaa, 0xbb]));
    await pumpUntil(first.client, "commande appliquée", () => first.sim()!.trace().length === 1);
    await pumpUntil(
      first.client,
      "snapshot de conservation",
      () => server.world.snapshotFor(room) !== undefined && first.client.tick > SNAPSHOT_EVERY,
    );
    const kept = server.world.snapshotFor(room)!;
    const trace = [...first.sim()!.trace()];
    expect(trace).toHaveLength(1);

    // --- La salle se vide : détruite, mais le snapshot survit ---
    first.client.close();
    await waitFor("salle détruite", () => server.room(room) === undefined);
    expect(server.world.snapshotFor(room)).toBeDefined();

    // --- Retour : `visit` puis `join`, et la salle rouvre au tick conservé ---
    const bob = await enterWorld(world, "bob");
    bob.client.visit(land.id);
    await waitFor("settled par visite", () => bob.settled.length === 1);

    const second = await enterRoom(bob.settled[0].room, "bob");
    await waitFor("sim restauré", () => second.sim() !== null);
    // Aucun `history_gap` : le flux `snapshot` puis bundles au même tick est
    // exactement celui que `LockstepClient` sait déjà suivre (§8).
    expect(second.errors).toEqual([]);
    expect(second.client.state.phase).toBe("running");
    expect(second.client.tick).toBe(kept.tick);
    // L'état repris est bien celui d'avant : la commande jouée y est encore.
    expect(second.sim()!.trace()).toEqual(trace);

    // Et l'horloge repart de là, sans trou.
    const target = second.client.tick + 12;
    await pumpUntil(second.client, "reprise des bundles", () => second.client.tick >= target);
    expect(second.errors).toEqual([]);
  });
});
