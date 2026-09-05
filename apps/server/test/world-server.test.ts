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

import {
  NO_PLAYER,
  TICKS_PER_HOUR,
  WORLD_HOUR_MS,
  type Caravan,
  type CaravanSummary,
} from "@rimlike/protocol";
import { deserializeWorld, findRoute, movementCost, tileCount, type WorldWire } from "@rimlike/world";

import { startServer, type RunningServer } from "../src/server.js";
import { DEFAULT_WORLD_SEED, sharedWorld } from "../src/world.js";
import { TestClient, bytes } from "./helpers.js";

const SUBDIVISIONS = 2;
const globe = sharedWorld(SUBDIVISIONS, DEFAULT_WORLD_SEED);
const landTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) !== null);
const oceanTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) === null);

/**
 * Cases terrestres atteignables depuis `landTile`, de la plus proche à la plus
 * lointaine : `nearTile` sert de destination habitée, `emptyTile` de case vierge
 * où une caravane fondera une colonie.
 */
const reachable = globe.tiles
  .filter((tile) => tile.id !== landTile && movementCost(tile.biome) !== null)
  .map((tile) => ({ id: tile.id, route: findRoute(globe, landTile, tile.id) }))
  .filter((entry): entry is { id: number; route: NonNullable<typeof entry.route> } => entry.route !== null)
  .sort((a, b) => a.route.hours - b.route.hours || a.id - b.id);
const nearTile = reachable[0]!.id;
const emptyTile = reachable[1]!.id;
/** La destination la plus lointaine : un trajet assez long pour être annulé. */
const farTile = reachable.at(-1)!.id;
/** Case terrestre d'un autre continent : l'océan la rend inatteignable. */
const unreachableTile = globe.tiles.find(
  (tile) => tile.id !== landTile && movementCost(tile.biome) !== null && findRoute(globe, landTile, tile.id) === null,
)!.id;

/** Une heure de jeu en 20 ms : le trajet le plus court dure ~80 ms. */
const HOUR_MS = 20;
const manifest = bytes(7, 0, 255, 3);
const summary: CaravanSummary = { pawns: 2, items: [[0, 30], [4, 5]] };


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

/** Un client déjà entré dans le monde. `token` : reconnexion sous un jeton connu. */
async function joinWorld(name: string, target: RunningServer = server, token?: string): Promise<TestClient> {
  const client = await connect(target);
  client.send(token === undefined ? { type: "world_join", name } : { type: "world_join", name, token });
  await client.next("world_welcome");
  return client;
}

/** La clé de joueur reçue dans le premier `world_welcome` d'un client. */
function keyOf(client: TestClient): string {
  return client.ofType("world_welcome")[0]!.playerKey;
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
      // Persistance non précisée à `startServer` : mode mémoire (persistence.test.ts la teste).
      persistence: { enabled: false, file: null, lastSavedAt: null },
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
    // Un jeton neuf, jamais rejoué : ce message-ci est le seul qui le porte.
    expect(typeof welcome.token).toBe("string");
    expect(welcome.token!.length).toBeGreaterThan(0);
    expect(typeof welcome.playerKey).toBe("string");
    const aliceKey = alice.ofType("world_welcome")[0]!.playerKey;
    await alice.waitUntil("bob visible", () =>
      (alice.ofType("world_players").at(-1)?.players ?? []).some((p) => p.name === "bob" && p.online),
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
          owner: aliceKey,
          ownerName: "alice",
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
    await alice.waitUntil(
      "deux joueurs en ligne",
      () => (alice.ofType("world_players").at(-1)?.players ?? []).filter((p) => p.online).length === 2,
    );

    bob.send({ type: "world_leave" });
    // bob quitte le monde, mais reste un joueur **connu** (`docs/protocol.md`
    // §11.2) : la table garde son nom, seul `online` change.
    await alice.waitUntil(
      "bob hors ligne",
      () => alice.ofType("world_players").at(-1)?.players.find((p) => p.name === "bob")?.online === false,
    );
    const last = alice.ofType("world_players").at(-1)!.players;
    expect(last.find((p) => p.name === "alice")?.online).toBe(true);
    expect(last).toHaveLength(2);

    bob.send({ type: "settle", tile: landTile });
    expect((await bob.next("world_error")).code).toBe("not_in_world");
  });
});

describe("identité par jeton", () => {
  it("reconnexion par jeton : même playerKey, colonies retrouvées ; sans jeton, un tout autre joueur", async () => {
    const alice = await joinWorld("alice");
    const welcome = alice.ofType("world_welcome")[0]!;
    const token = welcome.token!;
    expect(typeof token).toBe("string");
    alice.send({ type: "settle", tile: landTile });
    await alice.next("settled");

    // Même nom, mais aucun jeton : un joueur neuf, sans aucun droit sur la
    // colonie d'alice — l'identité est le jeton, jamais le nom (§11.2).
    const impostor = await joinWorld("alice");
    expect(impostor.ofType("world_welcome")[0]!.playerKey).not.toBe(welcome.playerKey);
    impostor.send({ type: "settle", tile: landTile });
    expect((await impostor.next("world_error")).code).toBe("occupied");
    impostor.send({ type: "abandon", tile: landTile });
    expect((await impostor.next("world_error")).code).toBe("not_owner");

    // Alice, elle, reconnue par son jeton (un autre onglet, un autre nom
    // affiché) : sa colonie est bien retrouvée, et elle peut l'abandonner.
    const reconnected = await joinWorld("alice sur mobile", server, token);
    const backWelcome = reconnected.ofType("world_welcome")[0]!;
    expect(backWelcome.playerKey).toBe(welcome.playerKey);
    // Reconnue : le jeton n'est pas rejoué, il n'a été envoyé qu'une fois.
    expect(backWelcome.token).toBeUndefined();
    expect(backWelcome.settlements.map((s) => s.tile)).toEqual([landTile]);
    expect(backWelcome.settlements[0]!.ownerName).toBe("alice sur mobile");

    reconnected.send({ type: "abandon", tile: landTile });
    const afterAbandon = await reconnected.next("world_settlements");
    expect(afterAbandon.settlements).toEqual([]);
  });

  it("refuse un jeton inconnu et ferme la connexion", async () => {
    const client = await connect();
    client.send({ type: "world_join", name: "alice", token: "jeton-invente" });
    expect((await client.next("world_error")).code).toBe("bad_token");
    await client.waitUntil("connexion fermée", () => client.closed);
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

describe("caravanes", () => {
  /** Serveur à horloge de monde accélérée : les caravanes voyagent en ms. */
  let fast: RunningServer;

  beforeEach(async () => {
    fast = await startServer({
      port: 0,
      log: () => {},
      worldSubdivisions: SUBDIVISIONS,
      worldHourMs: HOUR_MS,
      caravanTickMs: 10,
    });
  });

  afterEach(async () => {
    await fast.close();
  });

  /** La dernière liste de caravanes reçue par un client. */
  const caravansOf = (client: TestClient): readonly Caravan[] =>
    client.ofType("world_caravans").at(-1)?.caravans ?? [];

  /** Attend qu'une caravane atteigne un statut, et la renvoie. */
  async function waitCaravan(client: TestClient, id: string, status: Caravan["status"]): Promise<Caravan> {
    await client.waitUntil(
      `caravane ${id} ${status}`,
      () => caravansOf(client).some((c) => c.id === id && c.status === status),
    );
    return caravansOf(client).find((c) => c.id === id)!;
  }

  /** Un joueur entré dans le monde, installé sur une case, sa salle en jeu. */
  async function openColony(name: string, tile: number): Promise<TestClient> {
    const client = await joinWorld(name, fast);
    client.send({ type: "settle", tile });
    await client.next("settled");
    client.send({ type: "join", room: `tile-${tile}`, name });
    await client.nth("welcome");
    client.send({ type: "start", seed: 1, width: 64, height: 64 });
    await client.nth("start");
    return client;
  }

  /** Expédie une caravane de `landTile` vers `toTile` et rend son identifiant. */
  async function depart(client: TestClient, toTile: number): Promise<string> {
    const known = new Set(caravansOf(client).map((c) => c.id));
    client.send({ type: "caravan_depart", fromTile: landTile, toTile, manifest, summary });
    await client.waitUntil("caravane annoncée", () => caravansOf(client).some((c) => !known.has(c.id)));
    return caravansOf(client).find((c) => !known.has(c.id))!.id;
  }

  it("voyage d'une colonie à l'autre et se fait livrer par l'hôte d'arrivée", async () => {
    const alice = await openColony("alice", landTile);
    const bob = await openColony("bob", nearTile);

    // Le monde annonce ses caravanes dès l'entrée, même vides.
    expect(bob.ofType("world_caravans")[0]!.caravans).toEqual([]);

    const aliceKey = keyOf(alice);
    const id = await depart(alice, nearTile);
    for (const client of [alice, bob]) {
      const caravan = await waitCaravan(client, id, "travelling");
      expect(caravan.owner).toBe(aliceKey);
      expect(caravan.ownerName).toBe("alice");
      expect(caravan.fromTile).toBe(landTile);
      expect(caravan.toTile).toBe(nearTile);
      expect(caravan.route[0]).toBe(landTile);
      expect(caravan.route.at(-1)).toBe(nearTile);
      expect(caravan.summary).toEqual(summary);
      expect(caravan.arrivesAt).toBeGreaterThan(caravan.departedAt);
      expect(caravan.progress).toBeLessThan(1);
    }

    // L'horloge tourne : l'hôte de la case d'arrivée reçoit le manifeste.
    const arrival = await bob.nth("caravan_arrive");
    expect(arrival).toEqual({ type: "caravan_arrive", id, tile: nearTile, manifest, summary });
    // Le serveur n'a rien décodé : les octets sont ceux d'alice, tels quels.
    expect(alice.ofType("caravan_arrive")).toEqual([]);
    expect((await waitCaravan(bob, id, "arrived")).progress).toBe(1);

    // L'hôte a injecté le convoi dans sa carte : il le confirme.
    bob.send({ type: "caravan_delivered", id });
    for (const client of [alice, bob]) {
      expect((await waitCaravan(client, id, "delivered")).currentTile).toBe(nearTile);
    }
  });

  it("attend l'ouverture de la salle d'arrivée quand la colonie est fermée", async () => {
    const alice = await openColony("alice", landTile);
    // bob fonde sa colonie mais n'y entre pas : sa salle n'existe pas.
    const bob = await joinWorld("bob", fast);
    bob.send({ type: "settle", tile: nearTile });
    await bob.next("settled");
    expect(fast.roomCount).toBe(1);

    const id = await depart(alice, nearTile);
    await waitCaravan(alice, id, "arrived");
    // Personne à qui livrer : l'arrivée patiente.
    expect(bob.ofType("caravan_arrive")).toEqual([]);

    // bob ouvre sa colonie : elle démarre en lobby, puis reçoit l'arrivée.
    bob.send({ type: "join", room: `tile-${nearTile}`, name: "bob" });
    expect((await bob.nth("welcome")).state).toBe("lobby");
    expect(bob.ofType("caravan_arrive")).toEqual([]);
    bob.send({ type: "start", seed: 1, width: 64, height: 64 });
    await bob.nth("start");

    const arrival = await bob.nth("caravan_arrive");
    expect(arrival.id).toBe(id);
    expect(arrival.manifest).toEqual(manifest);
    bob.send({ type: "caravan_delivered", id });
    await waitCaravan(bob, id, "delivered");
  });

  it("fonde la colonie du propriétaire en arrivant sur une case vierge", async () => {
    const alice = await openColony("alice", landTile);
    const id = await depart(alice, emptyTile);

    // À l'arrivée, la case devient une colonie d'alice… sans salle : la
    // colonie « naît » quand quelqu'un l'ouvre.
    await alice.waitUntil("colonie fondée par la caravane", () =>
      (alice.ofType("world_settlements").at(-1)?.settlements ?? []).some((s) => s.tile === emptyTile),
    );
    const settlements = alice.ofType("world_settlements").at(-1)!.settlements;
    expect(settlements.find((s) => s.tile === emptyTile)!.owner).toBe(keyOf(alice));
    expect(settlements.find((s) => s.tile === emptyTile)!.ownerName).toBe("alice");
    expect(fast.world.settlementCount).toBe(2);
    expect(fast.roomCount).toBe(1);
    await waitCaravan(alice, id, "arrived");
    expect(alice.ofType("caravan_arrive")).toEqual([]);

    // Alice ouvre sa nouvelle colonie : lobby, puis livraison après le start.
    // Une connexion ne tient qu'une salle, alice en ouvre donc une seconde.
    const owner = await connect(fast);
    owner.send({ type: "join", room: `tile-${emptyTile}`, name: "alice" });
    expect((await owner.nth("welcome")).state).toBe("lobby");
    expect(owner.ofType("caravan_arrive")).toEqual([]);
    owner.send({ type: "start", seed: 1, width: 64, height: 64 });
    await owner.nth("start");
    expect((await owner.nth("caravan_arrive")).id).toBe(id);
  });

  it("réémet l'arrivée au nouvel hôte si l'hôte change sans confirmer", async () => {
    const alice = await openColony("alice", landTile);
    const bob = await openColony("bob", nearTile);
    const carol = await connect(fast);
    carol.send({ type: "join", room: `tile-${nearTile}`, name: "carol" });
    await carol.nth("welcome");

    const id = await depart(alice, nearTile);
    expect((await bob.nth("caravan_arrive")).id).toBe(id);
    expect(carol.ofType("caravan_arrive")).toEqual([]);

    // bob s'en va sans confirmer : carol devient hôte et reçoit l'arrivée.
    bob.close();
    expect((await carol.nth("caravan_arrive")).id).toBe(id);
    carol.send({ type: "caravan_delivered", id });
    await waitCaravan(alice, id, "delivered");
  });

  it("fait demi-tour sur caravan_cancel avant la moitié du trajet", async () => {
    const alice = await openColony("alice", landTile);
    // Une destination lointaine : de quoi partir vraiment avant de renoncer.
    const id = await depart(alice, farTile);
    await alice.waitUntil("caravane en chemin", () => {
      const caravan = caravansOf(alice).find((c) => c.id === id);
      return caravan !== undefined && caravan.currentTile !== landTile;
    });

    alice.send({ type: "caravan_cancel", id });
    const returning = await waitCaravan(alice, id, "returning");
    expect(returning.toTile).toBe(landTile);
    expect(returning.fromTile).not.toBe(landTile);
    expect(returning.route.at(-1)).toBe(landTile);
    // Rentrer est une arrivée comme une autre : la salle de départ la reçoit.
    expect((await alice.nth("caravan_arrive")).tile).toBe(landTile);
    await waitCaravan(alice, id, "arrived");
  });

  it("refuse l'océan, la même case, une salle étrangère et une caravane inconnue", async () => {
    const alice = await openColony("alice", landTile);

    alice.send({ type: "caravan_depart", fromTile: landTile, toTile: unreachableTile, manifest, summary });
    expect((await alice.next("world_error")).code).toBe("caravan_no_route");

    alice.send({ type: "caravan_depart", fromTile: landTile, toTile: landTile, manifest, summary });
    expect((await alice.next("world_error")).code).toBe("caravan_same_tile");

    alice.send({ type: "caravan_depart", fromTile: landTile, toTile: 9999, manifest, summary });
    expect((await alice.next("world_error")).code).toBe("bad_tile");

    // bob est dans le monde mais dans aucune salle : il n'expédie rien.
    const bob = await joinWorld("bob", fast);
    bob.send({ type: "caravan_depart", fromTile: landTile, toTile: nearTile, manifest, summary });
    expect((await bob.next("world_error")).code).toBe("caravan_not_in_room");

    const id = await depart(alice, farTile);
    bob.send({ type: "caravan_cancel", id });
    expect((await bob.next("world_error")).code).toBe("not_owner");

    alice.send({ type: "caravan_cancel", id: "c404" });
    expect((await alice.next("world_error")).code).toBe("caravan_not_found");

    alice.send({ type: "caravan_delivered", id: "c404" });
    expect((await alice.next("world_error")).code).toBe("caravan_not_found");

    // Une caravane en vol n'est pas livrable, même par sa salle de départ.
    alice.send({ type: "caravan_delivered", id });
    expect((await alice.next("world_error")).code).toBe("caravan_not_found");

    // Hors monde, aucun ordre de caravane ne passe.
    const dave = await connect(fast);
    dave.send({ type: "caravan_depart", fromTile: landTile, toTile: nearTile, manifest, summary });
    expect((await dave.next("world_error")).code).toBe("not_in_world");
  });

  describe("depuis la connexion monde", () => {
    it("accepte le départ et la livraison depuis la connexion monde, et livre l'arrivée sur les deux connexions de l'hôte", async () => {
      // alice : une connexion de salle (jeu normal) et une connexion monde
      // distincte, reconnue par le même jeton — ce que fera `WorldClient` une
      // fois le relais paresseux du Worker retiré.
      const aliceRoom = await joinWorld("alice", fast);
      const token = aliceRoom.ofType("world_welcome")[0]!.token!;
      const aliceKey = keyOf(aliceRoom);
      aliceRoom.send({ type: "settle", tile: landTile });
      await aliceRoom.next("settled");
      aliceRoom.send({ type: "join", room: `tile-${landTile}`, name: "alice" });
      await aliceRoom.nth("welcome");
      aliceRoom.send({ type: "start", seed: 1, width: 64, height: 64 });
      await aliceRoom.nth("start");

      const aliceWorld = await joinWorld("alice (autre onglet)", fast, token);
      expect(keyOf(aliceWorld)).toBe(aliceKey);

      // Départ envoyé depuis la connexion MONDE, pas la connexion de salle.
      const id = await depart(aliceWorld, farTile);
      for (const client of [aliceRoom, aliceWorld]) {
        const caravan = await waitCaravan(client, id, "travelling");
        expect(caravan.owner).toBe(aliceKey);
        expect(caravan.fromTile).toBe(landTile);
      }

      // Elle rentre avant la moitié : l'arrivée revient sur la case de départ,
      // dont alice est déjà l'hôte sur ses deux connexions.
      await aliceWorld.waitUntil("caravane en chemin", () => {
        const caravan = caravansOf(aliceWorld).find((c) => c.id === id);
        return caravan !== undefined && caravan.currentTile !== landTile;
      });
      aliceWorld.send({ type: "caravan_cancel", id });
      await waitCaravan(aliceWorld, id, "returning");
      await waitCaravan(aliceWorld, id, "arrived");

      // Reçue sur les deux connexions de l'hôte, le client ignorant le doublon.
      expect((await aliceRoom.nth("caravan_arrive")).id).toBe(id);
      expect((await aliceWorld.nth("caravan_arrive")).id).toBe(id);

      // Confirmation depuis la connexion monde : acceptée puisqu'elle est
      // reconnue comme l'hôte de la salle d'arrivée (même clé).
      aliceWorld.send({ type: "caravan_delivered", id });
      for (const client of [aliceRoom, aliceWorld]) {
        expect((await waitCaravan(client, id, "delivered")).currentTile).toBe(landTile);
      }
    });

    it("refuse caravan_depart depuis la connexion monde d'un joueur absent de la salle", async () => {
      await openColony("alice", landTile);
      const outsider = await joinWorld("outsider", fast);
      outsider.send({ type: "caravan_depart", fromTile: landTile, toTile: nearTile, manifest, summary });
      expect((await outsider.next("world_error")).code).toBe("caravan_not_in_room");
    });

    it("accepte caravan_depart par repli sur le nom quand la connexion de salle n'a pas fait world_join", async () => {
      // La salle n'existe que si la case est colonisée : un fondateur
      // distinct s'en charge, sans jamais entrer dans la salle lui-même.
      const founder = await joinWorld("fondateur", fast);
      founder.send({ type: "settle", tile: landTile });
      await founder.next("settled");

      // Connexion de salle « brute » : `join` direct, sans `world_join` sur
      // cette connexion précise — le relais de salle n'a jamais exigé de
      // jeton (docs/protocol.md §11.2).
      const roomOnly = await connect(fast);
      roomOnly.send({ type: "join", room: `tile-${landTile}`, name: "alice" });
      await roomOnly.nth("welcome");

      // Connexion monde d'« alice » : aucun jeton, donc une identité neuve —
      // seul le nom la relie à la connexion de salle, en repli v1.
      const aliceWorld = await joinWorld("alice", fast);

      const known = new Set(caravansOf(aliceWorld).map((c) => c.id));
      aliceWorld.send({ type: "caravan_depart", fromTile: landTile, toTile: nearTile, manifest, summary });
      await aliceWorld.waitUntil("caravane annoncée", () => caravansOf(aliceWorld).some((c) => !known.has(c.id)));
      const caravan = caravansOf(aliceWorld).find((c) => !known.has(c.id))!;
      expect(caravan.fromTile).toBe(landTile);
      expect(caravan.owner).toBe(keyOf(aliceWorld));
    });
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
      // Horloge du monde figée : la colonie rouvre sans temps gelé, donc le
      // `snapshot` de réouverture n'emporte aucun `frozenTicks`.
      worldNow: () => 1_757_000_000_000,
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

  it("annonce le temps gelé au premier arrivant après une absence", async () => {
    // Horloge du monde pilotée par le test : cinq heures de jeu s'écoulent
    // pendant que la colonie est fermée (une heure de jeu = WORLD_HOUR_MS).
    let worldNow = 1_757_000_000_000;
    const fast = await startServer({
      port: 0,
      log: () => {},
      worldSubdivisions: SUBDIVISIONS,
      roomOptions: { tickRate: 60_000, bundleTicks: 600 },
      worldNow: () => worldNow,
    });
    try {
      const alice = await joinWorld("alice", fast);
      alice.send({ type: "settle", tile: landTile });
      const settled = await alice.next("settled");
      alice.send({ type: "join", room: settled.room, name: "alice" });
      await alice.nth("welcome");
      alice.send({ type: "start", seed: 1, width: 64, height: 64 });
      await alice.nth("start");
      await alice.nth("request_snapshot");

      const tick = alice.ofType("bundle").at(-1)!.to + 1;
      alice.send({ type: "snapshot", tick, data: bytes(1, 2, 3, 4) });
      await until("snapshot stocké", () => fast.world.snapshotFor(settled.room) !== undefined);
      expect(fast.world.snapshotFor(settled.room)?.savedAtHours).toBe(0);

      alice.close();
      await until("salle détruite", () => fast.roomCount === 0);
      worldNow += 5 * WORLD_HOUR_MS;
      expect(fast.world.frozenTicksFor(settled.room)).toBe(5 * TICKS_PER_HOUR);

      const bob = await joinWorld("bob", fast);
      bob.send({ type: "visit", tile: landTile });
      const destination = await bob.next("settled");
      bob.send({ type: "join", room: destination.room, name: "bob" });
      const welcome = await bob.nth("welcome");
      expect(welcome.isHost).toBe(true);

      // L'hôte reçoit l'état **et** le temps à rattraper : c'est lui qui
      // émettra `FastForward` en première commande (docs/protocol.md §11.6).
      const snapshot = await bob.nth("snapshot");
      expect(snapshot.tick).toBe(tick);
      expect(snapshot.data).toEqual(bytes(1, 2, 3, 4));
      expect(snapshot.frozenTicks).toBe(3000);
    } finally {
      await fast.close();
    }
  });
});
