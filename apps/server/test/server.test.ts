/**
 * Tests d'intégration avec de vrais WebSockets sur un port éphémère et
 * l'horloge réelle du serveur (20 bundles/s). Ce qui est vérifié ici est la
 * garantie centrale : deux clients reçoivent exactement la même suite de
 * bundles, dans le même ordre.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { startServer, type RunningServer } from "../src/server.js";
import { TestClient, assertContiguous, bytes, commandOrder } from "./helpers.js";

let server: RunningServer;
const clients: TestClient[] = [];

async function connect(): Promise<TestClient> {
  const client = await TestClient.connect(server.url);
  clients.push(client);
  return client;
}

beforeEach(async () => {
  server = await startServer({ port: 0, log: () => {} });
});

afterEach(async () => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  await server.close();
});

describe("santé", () => {
  it("répond sur GET /health", async () => {
    // `world` décrit le globe servi : c'est le premier contrôle de cohérence
    // entre un client et un serveur (docs/protocol.md §11).
    const world = { seed: 1, subdivisions: 4, tiles: 2562, settlements: 0 };
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, rooms: 0, world });

    const alice = await connect();
    alice.send({ type: "join", room: "demo", name: "alice" });
    await alice.next("welcome");
    const second = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(await second.json()).toEqual({ ok: true, rooms: 1, world });
  });

  it("renvoie 404 ailleurs", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/autre`);
    expect(response.status).toBe(404);
  });
});

describe("lobby et lockstep", () => {
  it("donne à deux clients exactement les mêmes bundles dans le même ordre", async () => {
    const alice = await connect();
    alice.send({ type: "join", room: "demo", name: "alice" });
    const aliceWelcome = await alice.next("welcome");
    expect(aliceWelcome.isHost).toBe(true);
    expect(aliceWelcome.state).toBe("lobby");

    const bob = await connect();
    bob.send({ type: "join", room: "demo", name: "bob" });
    const bobWelcome = await bob.next("welcome");
    expect(bobWelcome.isHost).toBe(false);
    expect(bobWelcome.playerId).toBe(2);
    await alice.waitUntil("composition à deux", () => (alice.ofType("players").at(-1)?.players.length ?? 0) === 2);

    alice.send({ type: "start", seed: 12345, width: 96, height: 96 });
    await Promise.all([alice.next("start"), bob.next("start")]);
    expect(alice.ofType("start")[0]).toEqual({
      type: "start",
      seed: 12345,
      width: 96,
      height: 96,
      tick: 0,
    });

    alice.send({ type: "command", payload: bytes(11) });
    bob.send({ type: "command", payload: bytes(21) });
    await new Promise((resolve) => setTimeout(resolve, 60));
    bob.send({ type: "command", payload: bytes(22) });
    alice.send({ type: "command", payload: bytes(12) });

    const total = (client: TestClient): number => commandOrder(client).length;
    await alice.waitUntil("4 commandes chez alice", () => total(alice) === 4);
    await bob.waitUntil("4 commandes chez bob", () => total(bob) === 4);
    // Un battement de plus pour vérifier que rien ne diverge après coup.
    await new Promise((resolve) => setTimeout(resolve, 60));

    expect(commandOrder(alice)).toEqual(commandOrder(bob));
    expect(new Set(commandOrder(alice).map(([, v]) => v))).toEqual(new Set([11, 21, 22, 12]));

    // Même découpage de ticks des deux côtés, du tick 0 et sans trou.
    const aliceBundles = alice.ofType("bundle");
    const bobBundles = bob.ofType("bundle");
    const shared = Math.min(aliceBundles.length, bobBundles.length);
    expect(aliceBundles.slice(0, shared)).toEqual(bobBundles.slice(0, shared));
    expect(aliceBundles[0]!.from).toBe(0);
    expect(aliceBundles[0]!.to).toBe(2);
    assertContiguous(alice);
    assertContiguous(bob);
  });

  it("détruit la salle quand tout le monde part", async () => {
    const alice = await connect();
    alice.send({ type: "join", room: "demo", name: "alice" });
    await alice.next("welcome");
    expect(server.roomCount).toBe(1);
    alice.close();
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(server.roomCount).toBe(0);
  });
});

describe("rejoindre en cours", () => {
  it("passe par un snapshot du host puis le rejeu des bundles", async () => {
    const alice = await connect();
    alice.send({ type: "join", room: "demo", name: "alice" });
    await alice.next("welcome");
    const bob = await connect();
    bob.send({ type: "join", room: "demo", name: "bob" });
    await bob.next("welcome");

    alice.send({ type: "start", seed: 99, width: 64, height: 64 });
    await alice.next("start");
    alice.send({ type: "command", payload: bytes(11) });
    await alice.waitUntil("une commande relayée", () => commandOrder(alice).length === 1);

    const carol = await connect();
    carol.send({ type: "join", room: "demo", name: "carol" });
    const welcome = await carol.next("welcome");
    expect(welcome.state).toBe("running");
    expect(welcome.seed).toBe(99);
    expect(welcome.isHost).toBe(false);

    // Le host, et lui seul, est sollicité.
    const request = await alice.next("request_snapshot");
    expect(request.forPlayer).toBe(welcome.playerId);
    expect(bob.ofType("request_snapshot")).toEqual([]);

    // Le host répond avec l'état de son sim au tick courant.
    const snapshotTick = alice.ofType("bundle").at(-1)!.to + 1;
    alice.send({ type: "snapshot", tick: snapshotTick, data: bytes(1, 2, 3, 4), forPlayer: request.forPlayer });

    const snapshot = await carol.next("snapshot");
    expect(snapshot.tick).toBe(snapshotTick);
    expect(snapshot.data).toEqual(bytes(1, 2, 3, 4));

    await carol.waitUntil("des bundles après le snapshot", () => carol.ofType("bundle").length >= 2);

    // Aucun bundle avant le snapshot, puis un flux contigu depuis son tick.
    const snapshotIndex = carol.received.findIndex((m) => m.type === "snapshot");
    const firstBundleIndex = carol.received.findIndex((m) => m.type === "bundle");
    expect(snapshotIndex).toBeGreaterThanOrEqual(0);
    expect(firstBundleIndex).toBeGreaterThan(snapshotIndex);
    const first = carol.ofType("bundle")[0]!;
    expect(first.from).toBeLessThanOrEqual(snapshotTick);
    expect(first.to).toBeGreaterThanOrEqual(snapshotTick);
    assertContiguous(carol);

    // Et à partir de là, carol suit le même flux que bob.
    const carolLast = carol.ofType("bundle").at(-1)!;
    const bobSame = bob.ofType("bundle").find((b) => b.from === carolLast.from);
    expect(bobSame).toEqual(carolLast);
  });
});

describe("désync", () => {
  it("prévient tout le monde au premier écart de hash", async () => {
    const alice = await connect();
    alice.send({ type: "join", room: "demo", name: "alice" });
    await alice.next("welcome");
    const bob = await connect();
    bob.send({ type: "join", room: "demo", name: "bob" });
    await bob.next("welcome");
    alice.send({ type: "start", seed: 1, width: 32, height: 32 });
    await Promise.all([alice.next("start"), bob.next("start")]);

    alice.send({ type: "hash", tick: 300, hash: "0123456789abcdef" });
    bob.send({ type: "hash", tick: 300, hash: "0123456789abcdef" });
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(alice.ofType("desync")).toEqual([]);

    alice.send({ type: "hash", tick: 600, hash: "aaaaaaaaaaaaaaaa" });
    bob.send({ type: "hash", tick: 600, hash: "bbbbbbbbbbbbbbbb" });

    const desync = await alice.next("desync");
    await bob.next("desync");
    expect(desync.tick).toBe(600);
    expect(desync.hashes).toEqual({ 1: "aaaaaaaaaaaaaaaa", 2: "bbbbbbbbbbbbbbbb" });
    expect(server.room("demo")?.state).toBe("desynced");
  });
});

describe("erreurs", () => {
  it("refuse une trame illisible et un message avant join", async () => {
    const client = await connect();
    client.sendRaw("{ceci n'est pas du json");
    const first = await client.next("error");
    expect(first.code).toBe("bad_message");

    client.send({ type: "command", payload: bytes(1) });
    await client.waitUntil("deux erreurs", () => client.ofType("error").length === 2);
    expect(client.ofType("error")[1]!.code).toBe("not_joined");
  });

  it("refuse une version de protocole incompatible", async () => {
    const client = await connect();
    client.send({ type: "join", room: "demo", name: "alice", protocol: 999 });
    const error = await client.next("error");
    expect(error.code).toBe("version_mismatch");
  });

  it("refuse un second join sur la même connexion", async () => {
    const client = await connect();
    client.send({ type: "join", room: "demo", name: "alice" });
    await client.next("welcome");
    client.send({ type: "join", room: "autre", name: "alice" });
    const error = await client.next("error");
    expect(error.code).toBe("already_joined");
  });
});

describe("heartbeat", () => {
  it("ferme une connexion silencieuse et laisse vivre celle qui répond", async () => {
    const fast = await startServer({ port: 0, log: () => {}, heartbeatMs: 20, timeoutMs: 60 });
    try {
      const answering = await TestClient.connect(fast.url);
      const silent = new WebSocket(fast.url);
      await new Promise<void>((resolve, reject) => {
        silent.once("open", () => resolve());
        silent.once("error", reject);
      });
      const closed = new Promise<void>((resolve) => silent.once("close", () => resolve()));

      answering.send({ type: "join", room: "demo", name: "alice" });
      await answering.next("welcome");
      await answering.waitUntil("un ping reçu", () => answering.ofType("ping").length >= 1);

      await closed;
      expect(answering.closed).toBe(false);
      answering.close();
    } finally {
      await fast.close();
    }
  });
});
