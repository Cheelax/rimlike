/**
 * Tests d'intégration de la couche monde : `GET /world`, les messages de
 * monde sur de vrais WebSockets, et le cycle complet d'une colonie —
 * fondation, salle « case », snapshot de conservation, fermeture, réouverture.
 *
 * Le globe de test est à la subdivision 2 (162 cases) pour rester instantané.
 */

import { request as httpRequest, type IncomingHttpHeaders } from "node:http";
import { gunzipSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { NO_PLAYER } from "@rimlike/protocol";
import { deserializeWorld, movementCost, tileCount, type WorldWire } from "@rimlike/world";

import { startServer, type RunningServer } from "../src/server.js";
import { DEFAULT_WORLD_SEED, sharedWorld } from "../src/world.js";
import { TestClient, bytes } from "./helpers.js";

const SUBDIVISIONS = 2;
const globe = sharedWorld(SUBDIVISIONS, DEFAULT_WORLD_SEED);
const landTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) !== null);
const oceanTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) === null);


interface RawResponse {
  readonly status: number;
  readonly headers: IncomingHttpHeaders;
  readonly body: Buffer;
}

/** GET brut : `fetch` décompresse et masque `content-encoding`. */
async function rawGet(port: number, path: string, headers: Record<string, string>): Promise<RawResponse> {
  return new Promise<RawResponse>((resolve, reject) => {
    const req = httpRequest({ host: "127.0.0.1", port, path, method: "GET", headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on("data", (chunk: Buffer) => chunks.push(chunk));
      res.on("end", () => {
        resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks) });
      });
    });
    req.on("error", reject);
    req.end();
  });
}

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

let server: RunningServer;
const clients: TestClient[] = [];

async function connect(target: RunningServer = server): Promise<TestClient> {
  const client = await TestClient.connect(target.url);
  clients.push(client);
  return client;
}

/** Un client déjà entré dans le monde. */
async function joinWorld(name: string, target: RunningServer = server): Promise<TestClient> {
  const client = await connect(target);
  client.send({ type: "world_join", name });
  await client.next("world_welcome");
  return client;
}

beforeEach(async () => {
  server = await startServer({ port: 0, log: () => {}, worldSubdivisions: SUBDIVISIONS });
});

afterEach(async () => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  await server.close();
});

describe("GET /world", () => {
  it("sert un WorldWire désérialisable du bon nombre de cases", async () => {
    const response = await rawGet(server.port, "/world", { "accept-encoding": "identity" });
    expect(response.status).toBe(200);
    expect(response.headers["content-encoding"]).toBeUndefined();
    expect(response.headers["cache-control"]).toBe("public, max-age=3600");

    const payload = JSON.parse(response.body.toString("utf8")) as {
      seed: number;
      subdivisions: number;
      generatedAt: number;
      wire: WorldWire;
    };
    expect(payload.seed).toBe(DEFAULT_WORLD_SEED);
    expect(payload.subdivisions).toBe(SUBDIVISIONS);
    expect(Number.isSafeInteger(payload.generatedAt)).toBe(true);
    expect(payload.wire.tileCount).toBe(tileCount(SUBDIVISIONS));

    // Le client fera exactement ça : désérialiser et rendre.
    const world = deserializeWorld(payload.wire);
    expect(world.tiles).toHaveLength(tileCount(SUBDIVISIONS));
    expect(world.seed).toBe(DEFAULT_WORLD_SEED);
    expect(world.tiles.map((t) => t.biome)).toEqual(globe.tiles.map((t) => t.biome));
  });

  it("compresse quand le client l'accepte", async () => {
    const plain = await rawGet(server.port, "/world", { "accept-encoding": "identity" });
    const zipped = await rawGet(server.port, "/world", { "accept-encoding": "gzip, deflate" });

    expect(zipped.status).toBe(200);
    expect(zipped.headers["content-encoding"]).toBe("gzip");
    expect(zipped.headers["vary"]).toBe("Accept-Encoding");
    expect(zipped.body.length).toBeLessThan(plain.body.length);
    expect(gunzipSync(zipped.body).toString("utf8")).toBe(plain.body.toString("utf8"));
  });

  it("sert un ETag stable et répond 304 quand le client l'a déjà", async () => {
    const first = await rawGet(server.port, "/world", { "accept-encoding": "identity" });
    const second = await rawGet(server.port, "/world", { "accept-encoding": "gzip" });
    const etag = first.headers.etag;
    expect(typeof etag).toBe("string");
    expect(etag).toContain(String(SUBDIVISIONS));
    // Le globe ne change pas : le même ETag, quelle que soit la compression.
    expect(second.headers.etag).toBe(etag);

    const cached = await rawGet(server.port, "/world", {
      "accept-encoding": "identity",
      "if-none-match": etag as string,
    });
    expect(cached.status).toBe(304);
    expect(cached.body.length).toBe(0);
  });

  it("annonce le globe dans /health", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(await response.json()).toEqual({
      ok: true,
      rooms: 0,
      world: { seed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, tiles: 162, settlements: 0 },
    });
  });
});

describe("s'installer sur le globe", () => {
  it("annonce la fondation aux deux joueurs connectés au monde", async () => {
    const alice = await joinWorld("alice");
    const bob = await joinWorld("bob");

    const welcome = bob.ofType("world_welcome")[0]!;
    expect(welcome.settlements).toEqual([]);
    expect(welcome.world).toEqual({ seed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, tiles: 162 });
    expect(welcome.name).toBe("bob");
    await alice.waitUntil("bob visible", () =>
      (alice.ofType("world_players").at(-1)?.players ?? []).includes("bob"),
    );

    alice.send({ type: "settle", tile: landTile });
    const settled = await alice.next("settled");
    expect(settled.tile).toBe(landTile);
    expect(settled.room).toBe(`tile-${landTile}`);
    expect(settled.seed).toBeGreaterThanOrEqual(0);

    for (const client of [alice, bob]) {
      const list = (await client.nth("world_settlements")).settlements;
      expect(list).toEqual([
        {
          tile: landTile,
          owner: "alice",
          room: `tile-${landTile}`,
          seed: settled.seed,
          createdAt: expect.any(Number) as unknown as number,
        },
      ]);
    }
    expect(server.world.settlementCount).toBe(1);
  });

  it("refuse l'océan, une case prise, une case inconnue et un joueur hors monde", async () => {
    const alice = await joinWorld("alice");
    alice.send({ type: "settle", tile: oceanTile });
    expect((await alice.next("world_error")).code).toBe("not_land");

    alice.send({ type: "settle", tile: landTile });
    await alice.next("settled");

    const bob = await joinWorld("bob");
    bob.send({ type: "settle", tile: landTile });
    expect((await bob.next("world_error")).code).toBe("occupied");

    bob.send({ type: "settle", tile: 9999 });
    expect((await bob.next("world_error")).code).toBe("bad_tile");

    const carol = await connect();
    carol.send({ type: "settle", tile: landTile });
    expect((await carol.next("world_error")).code).toBe("not_in_world");
  });

  it("libère la case à l'abandon, et seulement pour son propriétaire", async () => {
    const alice = await joinWorld("alice");
    const bob = await joinWorld("bob");
    alice.send({ type: "settle", tile: landTile });
    await alice.next("settled");
    await bob.nth("world_settlements");

    bob.send({ type: "abandon", tile: landTile });
    expect((await bob.next("world_error")).code).toBe("not_owner");

    alice.send({ type: "abandon", tile: landTile });
    expect((await bob.nth("world_settlements", 1)).settlements).toEqual([]);
    expect(server.world.settlementCount).toBe(0);

    alice.send({ type: "abandon", tile: landTile });
    expect((await alice.next("world_error")).code).toBe("not_settled");
  });

  it("retire un joueur du monde sur world_leave", async () => {
    const alice = await joinWorld("alice");
    const bob = await joinWorld("bob");
    await alice.waitUntil("deux joueurs", () => (alice.ofType("world_players").at(-1)?.players.length ?? 0) === 2);

    bob.send({ type: "world_leave" });
    await alice.waitUntil("bob parti", () => (alice.ofType("world_players").at(-1)?.players ?? []).length === 1);
    expect(alice.ofType("world_players").at(-1)!.players).toEqual(["alice"]);

    bob.send({ type: "settle", tile: landTile });
    expect((await bob.next("world_error")).code).toBe("not_in_world");
  });
});

describe("salle d'une case", () => {
  it("impose la graine de la case au démarrage et accueille un visiteur", async () => {
    const alice = await joinWorld("alice");
    alice.send({ type: "settle", tile: landTile });
    const settled = await alice.next("settled");

    alice.send({ type: "join", room: settled.room, name: "alice" });
    const hostWelcome = await alice.nth("welcome");
    expect(hostWelcome.isHost).toBe(true);
    expect(hostWelcome.state).toBe("lobby");

    const bob = await joinWorld("bob");
    bob.send({ type: "visit", tile: landTile });
    const destination = await bob.next("settled");
    expect(destination).toEqual(settled);
    bob.send({ type: "join", room: destination.room, name: "bob" });
    expect((await bob.nth("welcome")).isHost).toBe(false);

    // L'hôte propose n'importe quelle graine : c'est celle de la case qui part.
    alice.send({ type: "start", seed: 424_242, width: 64, height: 64 });
    for (const client of [alice, bob]) {
      const start = await client.nth("start");
      expect(start.seed).toBe(settled.seed);
      expect(start).toEqual({ type: "start", seed: settled.seed, width: 64, height: 64, tick: 0 });
    }
  });

  it("refuse de visiter une case libre et de créer la salle d'une case libre", async () => {
    const alice = await joinWorld("alice");
    alice.send({ type: "visit", tile: landTile });
    expect((await alice.next("world_error")).code).toBe("not_settled");

    alice.send({ type: "join", room: `tile-${landTile}`, name: "alice" });
    expect((await alice.next("error")).code).toBe("not_settled");
    expect(server.roomCount).toBe(0);
  });

  it("laisse le mode salle simple inchangé", async () => {
    const alice = await connect();
    alice.send({ type: "join", room: "demo", name: "alice" });
    await alice.nth("welcome");
    alice.send({ type: "start", seed: 12_345, width: 64, height: 64 });
    const start = await alice.nth("start");
    // Hors monde, la graine reste celle du host.
    expect(start.seed).toBe(12_345);
  });
});

describe("conservation du snapshot d'une colonie", () => {
  it("stocke le snapshot de l'hôte, puis rouvre la salle à son tick", async () => {
    // Horloge accélérée : 600 ticks par bundle toutes les 10 ms, donc les
    // 1800 ticks entre deux snapshots passent en une quarantaine de ms.
    const fast = await startServer({
      port: 0,
      log: () => {},
      worldSubdivisions: SUBDIVISIONS,
      roomOptions: { tickRate: 60_000, bundleTicks: 600 },
    });
    try {
      const alice = await joinWorld("alice", fast);
      alice.send({ type: "settle", tile: landTile });
      const settled = await alice.next("settled");
      alice.send({ type: "join", room: settled.room, name: "alice" });
      await alice.nth("welcome");
      alice.send({ type: "start", seed: 1, width: 64, height: 64 });
      await alice.nth("start");

      // Snapshot de conservation : personne ne l'attend, il est pour le serveur.
      const request = await alice.nth("request_snapshot");
      expect(request.forPlayer).toBe(NO_PLAYER);

      const tick = alice.ofType("bundle").at(-1)!.to + 1;
      alice.send({ type: "snapshot", tick, data: bytes(1, 2, 3, 4) });
      await until("snapshot stocké", () => fast.world.snapshotFor(settled.room) !== undefined);
      const stored = fast.world.snapshotFor(settled.room)!;
      expect(stored.tick).toBe(tick);
      expect(stored.data).toEqual(bytes(1, 2, 3, 4));
      expect(stored.width).toBe(64);
      expect(stored.height).toBe(64);
      // Il n'a été relayé à personne : alice n'a reçu que sa propre trame.
      expect(alice.ofType("snapshot")).toEqual([]);

      // Tout le monde part : la salle disparaît, le snapshot reste.
      alice.close();
      await until("salle détruite", () => fast.roomCount === 0);
      expect(fast.world.snapshotFor(settled.room)?.tick).toBe(tick);
      expect(fast.world.settlementCount).toBe(1);

      // Quelqu'un revient : la salle rouvre en jeu, à partir du snapshot.
      const bob = await joinWorld("bob", fast);
      expect(bob.ofType("world_welcome")[0]!.settlements.map((s) => s.tile)).toEqual([landTile]);
      bob.send({ type: "visit", tile: landTile });
      const destination = await bob.next("settled");
      bob.send({ type: "join", room: destination.room, name: "bob" });

      const welcome = await bob.nth("welcome");
      expect(welcome.state).toBe("running");
      expect(welcome.tick).toBe(tick);
      expect(welcome.seed).toBe(settled.seed);
      expect(welcome.width).toBe(64);
      expect(welcome.height).toBe(64);
      expect(welcome.isHost).toBe(true);

      const snapshot = await bob.nth("snapshot");
      expect(snapshot).toEqual({ type: "snapshot", tick, data: bytes(1, 2, 3, 4) });

      // Puis les bundles reprennent à ce tick, sans rejeu de l'historique.
      await bob.waitUntil("des bundles après la réouverture", () => bob.ofType("bundle").length >= 2);
      const snapshotIndex = bob.received.findIndex((m) => m.type === "snapshot");
      const firstBundleIndex = bob.received.findIndex((m) => m.type === "bundle");
      expect(firstBundleIndex).toBeGreaterThan(snapshotIndex);
      const bundles = bob.ofType("bundle");
      expect(bundles[0]!.from).toBe(tick);
      expect(bundles[1]!.from).toBe(bundles[0]!.to + 1);
      // Personne n'a été sollicité pour un snapshot : le serveur avait l'état.
      expect(bob.ofType("request_snapshot")).toEqual([]);
    } finally {
      await fast.close();
    }
  });
});
