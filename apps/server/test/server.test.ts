/**
 * Tests d'intégration avec de vrais WebSockets sur un port éphémère et
 * l'horloge réelle du serveur (20 bundles/s). Ce qui est vérifié ici est la
 * garantie centrale : deux clients reçoivent exactement la même suite de
 * bundles, dans le même ordre.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { WebSocket } from "ws";

import { movementCost } from "@rimlike/world";

import { startServer, type RunningServer } from "../src/server.js";
import { DEFAULT_WORLD_SEED, DEFAULT_WORLD_SUBDIVISIONS, sharedWorld } from "../src/world.js";
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
    // `merchants` compte les marchands itinérants en circulation (§13) : zéro
    // ici, ils naissent au premier tick du monde et ce serveur vient de naître.
    const world = { seed: 1, subdivisions: 4, tiles: 2562, settlements: 0, merchants: 0 };
    // Persistance non précisée à `startServer` : mode mémoire, comme dans
    // tous les tests qui ne le demandent pas explicitement (persistence.test.ts).
    const persistence = { enabled: false, file: null, lastSavedAt: null };
    // Valeurs par défaut des garde-fous (`docs/protocol.md` §2, « Limites »),
    // aucune n'est précisée à `startServer` dans ce test.
    const limits = {
      maxMessageBytes: 262_144,
      maxSnapshotBytes: 8_388_608,
      maxMessagesPerSecond: 120,
      maxConnectionsPerIp: 16,
      maxRooms: 500,
      maxPlayersPerRoom: 4,
    };
    const response = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      ok: true,
      rooms: 0,
      roomsByState: { lobby: 0, running: 0, desynced: 0 },
      connections: 0,
      world,
      limits,
      persistence,
    });

    const alice = await connect();
    alice.send({ type: "join", room: "demo", name: "alice" });
    await alice.next("welcome");
    const second = await fetch(`http://127.0.0.1:${server.port}/health`);
    expect(await second.json()).toEqual({
      ok: true,
      rooms: 1,
      roomsByState: { lobby: 1, running: 0, desynced: 0 },
      connections: 1,
      world,
      limits,
      persistence,
    });
  });

  it("renvoie 404 ailleurs", async () => {
    const response = await fetch(`http://127.0.0.1:${server.port}/autre`);
    expect(response.status).toBe(404);
  });
});

describe("découverte des salles (GET /rooms)", () => {
  it("liste les salles ouvertes, lobbies d'abord puis par nom, avec CORS et sans cache", async () => {
    const alice = await connect();
    alice.send({ type: "join", room: "zzz-en-jeu", name: "alice" });
    await alice.next("welcome");
    alice.send({ type: "start", seed: 1, width: 32, height: 32 });
    await alice.next("start");

    const bob = await connect();
    bob.send({ type: "join", room: "aaa-en-attente", name: "bob" });
    await bob.next("welcome");

    const response = await fetch(`http://127.0.0.1:${server.port}/rooms`);
    expect(response.status).toBe(200);
    expect(response.headers.get("access-control-allow-origin")).toBe("*");
    expect(response.headers.get("cache-control")).toBe("no-store");

    const body = (await response.json()) as { rooms: Array<Record<string, unknown>>; truncated: boolean };
    expect(body.truncated).toBe(false);
    // Lobbies d'abord malgré l'ordre alphabétique inverse des deux noms.
    expect(body.rooms.map((r) => r.name)).toEqual(["aaa-en-attente", "zzz-en-jeu"]);

    const lobbyRoom = body.rooms.find((r) => r.name === "aaa-en-attente")!;
    expect(lobbyRoom).toMatchObject({ state: "lobby", players: 1, maxPlayers: 4, tick: 0, isTile: false });
    expect(lobbyRoom.tile).toBeUndefined();
    expect(lobbyRoom.seed).toBeUndefined();
    expect(typeof lobbyRoom.createdAt).toBe("number");

    const runningRoom = body.rooms.find((r) => r.name === "zzz-en-jeu")!;
    expect(runningRoom).toMatchObject({ state: "running", players: 1, maxPlayers: 4, seed: 1, isTile: false });
  });

  it("liste une colonie fondée avec isTile, tile et ownerName résolu, sans le moindre secret", async () => {
    const globe = sharedWorld(DEFAULT_WORLD_SUBDIVISIONS, DEFAULT_WORLD_SEED);
    const landTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) !== null);

    const alice = await connect();
    alice.send({ type: "world_join", name: "alice" });
    await alice.next("world_welcome");
    alice.send({ type: "settle", tile: landTile });
    const settled = await alice.next("settled");
    alice.send({ type: "join", room: settled.room, name: "alice" });
    await alice.next("welcome");

    const body = (await (await fetch(`http://127.0.0.1:${server.port}/rooms`)).json()) as {
      rooms: Array<Record<string, unknown>>;
    };
    const tileRoom = body.rooms.find((r) => r.name === settled.room)!;
    expect(tileRoom).toBeDefined();
    expect(tileRoom).toMatchObject({
      isTile: true,
      tile: landTile,
      ownerName: "alice",
      seed: settled.seed,
      state: "lobby",
    });
    // Aucun secret : ni jeton, ni clé de joueur, seulement le nom résolu.
    expect(JSON.stringify(tileRoom)).not.toMatch(/token|owner"/);
  });

  it("filtre par état (?state=) et par nom (?q=, insensible à la casse)", async () => {
    const alice = await connect();
    alice.send({ type: "join", room: "salle-un", name: "alice" });
    await alice.next("welcome");

    const bob = await connect();
    bob.send({ type: "join", room: "salle-deux", name: "bob" });
    await bob.next("welcome");
    bob.send({ type: "start", seed: 1, width: 32, height: 32 });
    await bob.next("start");

    const onlyLobby = (await (await fetch(`http://127.0.0.1:${server.port}/rooms?state=lobby`)).json()) as {
      rooms: Array<{ name: string }>;
    };
    expect(onlyLobby.rooms.map((r) => r.name)).toEqual(["salle-un"]);

    const onlyRunning = (await (await fetch(`http://127.0.0.1:${server.port}/rooms?state=running`)).json()) as {
      rooms: Array<{ name: string }>;
    };
    expect(onlyRunning.rooms.map((r) => r.name)).toEqual(["salle-deux"]);

    const byQuery = (await (await fetch(`http://127.0.0.1:${server.port}/rooms?q=DEUX`)).json()) as {
      rooms: Array<{ name: string }>;
    };
    expect(byQuery.rooms.map((r) => r.name)).toEqual(["salle-deux"]);
  });

  it("tronque à maxListedRooms, en ne gardant que les salles les plus récemment créées", async () => {
    const guarded = await startServer({ port: 0, log: () => {}, maxListedRooms: 2 });
    const guardedClients: TestClient[] = [];
    try {
      for (const name of ["r1", "r2", "r3"]) {
        const client = await TestClient.connect(guarded.url);
        guardedClients.push(client);
        client.send({ type: "join", room: name, name: "p" });
        await client.next("welcome");
      }
      const body = (await (await fetch(`http://127.0.0.1:${guarded.port}/rooms`)).json()) as {
        rooms: Array<{ name: string }>;
        truncated: boolean;
      };
      expect(body.truncated).toBe(true);
      // r1 est la plus ancienne, donc la première évincée.
      expect(body.rooms.map((r) => r.name)).toEqual(["r2", "r3"]);
    } finally {
      for (const client of guardedClients) {
        client.close();
      }
      await guarded.close();
    }
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

  it("refuse un nom trop long ou avec des caractères de contrôle", async () => {
    const tooLong = await connect();
    tooLong.send({ type: "join", room: "demo", name: "x".repeat(33) });
    const error = await tooLong.next("error");
    expect(error.code).toBe("bad_name");

    const control = await connect();
    control.send({ type: "join", room: "demo", name: `ali${String.fromCharCode(7)}ce` });
    const controlError = await control.next("error");
    expect(controlError.code).toBe("bad_name");
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

describe("garde-fous avant hébergement public", () => {
  it("refuse un message trop gros (message_too_large, fermeture 1009), mais accepte un snapshot sous son propre plafond", async () => {
    const guarded = await startServer({ port: 0, log: () => {}, maxMessageBytes: 100, maxSnapshotBytes: 2000 });
    try {
      const alice = await TestClient.connect(guarded.url);
      alice.send({ type: "join", room: "demo", name: "alice" });
      await alice.next("welcome");

      // Une commande dont la trame dépasse `maxMessageBytes` (100) mais reste
      // sous `maxSnapshotBytes` (2000) : ce n'est pas un `snapshot`, la limite
      // générale s'applique.
      alice.sendRaw(JSON.stringify({ type: "command", payload: "A".repeat(300) }));
      const error = await alice.next("error");
      expect(error.code).toBe("message_too_large");
      await alice.waitUntil("fermeture après dépassement de taille", () => alice.closed);

      // Un `snapshot` de même ordre de grandeur, lui, passe : c'est
      // `maxSnapshotBytes` qui s'applique, pas `maxMessageBytes`.
      const bob = await TestClient.connect(guarded.url);
      bob.send({ type: "join", room: "demo2", name: "bob" });
      await bob.next("welcome");
      bob.sendRaw(JSON.stringify({ type: "snapshot", tick: 0, data: "A".repeat(300) }));
      // Laisse le temps à un éventuel refus d'arriver avant de conclure.
      await new Promise((resolve) => setTimeout(resolve, 150));
      expect(bob.ofType("error").some((entry) => entry.code === "message_too_large")).toBe(false);
      expect(bob.closed).toBe(false);
    } finally {
      await guarded.close();
    }
  });

  it("signale un dépassement de débit sans fermer sur une simple rafale", async () => {
    // Horloge fausse figée : le limiteur de débit lit `now()` à chaque
    // message reçu (`docs/protocol.md` §2, « Limites »), mais elle ne bouge
    // jamais ici. L'écart `now - overLimitSince` reste donc mathématiquement
    // nul, quel que soit le temps réel que ce test met à s'exécuter — plus
    // besoin d'un vrai délai pour être sûr que la connexion ne se ferme pas.
    const guarded = await startServer({ port: 0, log: () => {}, maxMessagesPerSecond: 10, now: () => 0 });
    try {
      const alice = await TestClient.connect(guarded.url);
      for (let i = 0; i < 30; i += 1) {
        alice.send({ type: "ping" });
      }
      await alice.waitUntil("rate_limited signalé", () => alice.ofType("error").some((entry) => entry.code === "rate_limited"));
      // Laisse les messages en vol se traiter ; l'assertion qui suit ne
      // dépend plus de cette durée pour être vraie (voir l'horloge figée
      // ci-dessus), seulement du temps de traiter la rafale déjà envoyée.
      await new Promise((resolve) => setTimeout(resolve, 20));
      expect(alice.closed).toBe(false);
    } finally {
      await guarded.close();
    }
  });

  it("ferme la connexion après un dépassement de débit soutenu 3 s", async () => {
    // Horloge fausse qui avance de 50 ms virtuelles à chaque appel (donc à
    // chaque message vu par le serveur) : deux fois le débit autorisé sur la
    // fenêtre d'une seconde, ce qui maintient le dépassement en continu, et
    // de quoi couvrir RATE_CLOSE_AFTER_MS (3 s, `docs/protocol.md` §2) en une
    // poignée de messages plutôt qu'en attendant 3 vraies secondes — c'est
    // cette attente réelle qui rendait le test fragile sous charge machine.
    let fakeNow = 0;
    const guarded = await startServer({
      port: 0,
      log: () => {},
      maxMessagesPerSecond: 10,
      now: () => (fakeNow += 50),
    });
    try {
      const alice = await TestClient.connect(guarded.url);
      // 80 × 50 ms virtuelles = 4 s, confortablement au-delà des 3 s requises.
      for (let i = 0; i < 80; i += 1) {
        if (!alice.closed) {
          alice.send({ type: "ping" });
        }
      }
      await alice.waitUntil("fermeture pour dépassement soutenu", () => alice.closed);
      expect(alice.ofType("error").some((entry) => entry.code === "rate_limited")).toBe(true);
    } finally {
      await guarded.close();
    }
  });

  it("refuse la (N+1)-ième connexion d'une même IP, laisse les autres ouvertes", async () => {
    const guarded = await startServer({ port: 0, log: () => {}, maxConnectionsPerIp: 2 });
    try {
      const first = await TestClient.connect(guarded.url);
      const second = await TestClient.connect(guarded.url);

      // La troisième est refusée dès l'upgrade (HTTP 429), avant tout message.
      const rejected = new WebSocket(guarded.url);
      const status = await new Promise<number>((resolve, reject) => {
        rejected.once("unexpected-response", (_request, response) => resolve(response.statusCode ?? 0));
        rejected.once("open", () => reject(new Error("la connexion aurait dû être refusée")));
        setTimeout(() => reject(new Error("délai dépassé en attendant le refus")), 2000);
      });
      expect(status).toBe(429);

      // Les deux premières connexions restent pleinement utilisables.
      first.send({ type: "join", room: "demo", name: "alice" });
      await first.next("welcome");
      second.send({ type: "join", room: "demo", name: "bob" });
      await second.next("welcome");
      expect(first.closed).toBe(false);
      expect(second.closed).toBe(false);
    } finally {
      await guarded.close();
    }
  });

  it("refuse une deuxième salle au-delà de MAX_ROOMS (server_full)", async () => {
    const guarded = await startServer({ port: 0, log: () => {}, maxRooms: 1 });
    try {
      const alice = await TestClient.connect(guarded.url);
      alice.send({ type: "join", room: "un", name: "alice" });
      await alice.next("welcome");

      const bob = await TestClient.connect(guarded.url);
      bob.send({ type: "join", room: "deux", name: "bob" });
      const error = await bob.next("error");
      expect(error.code).toBe("server_full");
      expect(bob.closed).toBe(false);

      // La salle déjà ouverte, elle, continue d'accepter des joueurs.
      const carol = await TestClient.connect(guarded.url);
      carol.send({ type: "join", room: "un", name: "carol" });
      const welcome = await carol.next("welcome");
      expect(welcome.isHost).toBe(false);
    } finally {
      await guarded.close();
    }
  });
});
