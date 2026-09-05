/**
 * Tests de `Room` avec une horloge injectée et de faux transports : la logique
 * de salle est vérifiée tick par tick, sans réseau ni timer.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { decodeServerMessage, type ServerMessage } from "@rimlike/protocol";

import { Room, type ClockStarter, type RoomOptions } from "../src/room.js";

/** Faux client : garde les messages décodés reçus. */
class Recorder {
  readonly received: ServerMessage[] = [];

  readonly send = (text: string): void => {
    const message = decodeServerMessage(text);
    if (message === null) {
      throw new Error(`trame serveur invalide : ${text}`);
    }
    this.received.push(message);
  };

  ofType<T extends ServerMessage["type"]>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  clear(): void {
    this.received.length = 0;
  }
}

/** Horloge manuelle : le test décide quand un bundle est émis. */
class ManualClock {
  private fire: (() => void) | null = null;
  running = false;
  intervalMs = 0;

  readonly starter: ClockStarter = (onBundle, intervalMs) => {
    this.fire = onBundle;
    this.intervalMs = intervalMs;
    this.running = true;
    return () => {
      this.running = false;
      this.fire = null;
    };
  };

  tick(times = 1): void {
    for (let i = 0; i < times; i += 1) {
      if (this.fire === null) {
        throw new Error("horloge arrêtée");
      }
      this.fire();
    }
  }
}

/** Suite plate `[player, premier octet]` de toutes les commandes reçues. */
function commandOrder(recorder: Recorder): Array<[number, number]> {
  return recorder
    .ofType("bundle")
    .flatMap((b) => b.ticks)
    .flatMap((t) => t.commands.map((c): [number, number] => [c.player, c.payload[0]!]));
}

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

let clock: ManualClock;
let now: number;
let room: Room;

beforeEach(() => {
  clock = new ManualClock();
  now = 1_000_000;
  room = new Room({
    name: "test",
    startClock: clock.starter,
    now: () => now,
    log: () => {},
  });
});

describe("lobby", () => {
  it("accueille le premier joueur comme host et diffuse la composition", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send);
    const bobId = room.join("bob", bob.send);

    expect(aliceId).toBe(1);
    expect(bobId).toBe(2);
    expect(room.host).toBe(1);
    expect(room.state).toBe("lobby");

    const welcome = alice.ofType("welcome")[0]!;
    expect(welcome.isHost).toBe(true);
    expect(welcome.state).toBe("lobby");
    expect(welcome.tick).toBe(0);
    expect(welcome.seed).toBeUndefined();
    expect(bob.ofType("welcome")[0]!.isHost).toBe(false);

    // Les deux ont vu la composition à deux joueurs.
    for (const recorder of [alice, bob]) {
      const last = recorder.ofType("players").at(-1)!;
      expect(last.hostId).toBe(1);
      expect(last.players).toEqual([
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ]);
    }
  });

  it("refuse un démarrage par un autre que le host", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    room.join("alice", alice.send);
    const bobId = room.join("bob", bob.send)!;
    room.handle(bobId, { type: "start", seed: 1, width: 32, height: 32 });
    expect(bob.ofType("error")[0]!.code).toBe("not_host");
    expect(room.state).toBe("lobby");
    expect(clock.running).toBe(false);
  });

  it("refuse commandes et hashes avant le démarrage", () => {
    const alice = new Recorder();
    const id = room.join("alice", alice.send)!;
    room.handle(id, { type: "command", payload: bytes(1) });
    room.handle(id, { type: "hash", tick: 0, hash: "aaaa" });
    expect(alice.ofType("error").map((e) => e.code)).toEqual(["not_running", "not_running"]);
  });

  it("refuse un second démarrage", () => {
    const alice = new Recorder();
    const id = room.join("alice", alice.send)!;
    room.handle(id, { type: "start", seed: 1, width: 32, height: 32 });
    room.handle(id, { type: "start", seed: 2, width: 64, height: 64 });
    expect(alice.ofType("error")[0]!.code).toBe("already_running");
  });

  it("refuse un joueur de plus que la limite", () => {
    const small = new Room({ name: "small", maxPlayers: 2, startClock: clock.starter, log: () => {} });
    expect(small.join("a", () => {})).toBe(1);
    expect(small.join("b", () => {})).toBe(2);
    expect(small.join("c", () => {})).toBeNull();
  });
});

describe("lockstep", () => {
  it("émet la même suite de bundles à tous, dans le même ordre", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    room.handle(aliceId, { type: "start", seed: 7, width: 64, height: 64 });

    expect(room.state).toBe("running");
    expect(clock.running).toBe(true);
    expect(clock.intervalMs).toBe(50);
    for (const recorder of [alice, bob]) {
      expect(recorder.ofType("start")[0]).toEqual({
        type: "start",
        seed: 7,
        width: 64,
        height: 64,
        tick: 0,
      });
    }

    clock.tick(); // bundle 0-2, vide
    room.handle(bobId, { type: "command", payload: bytes(20) });
    room.handle(aliceId, { type: "command", payload: bytes(10) });
    clock.tick(); // bundle 3-5, porte les deux commandes
    clock.tick(); // bundle 6-8, vide

    const aliceBundles = alice.ofType("bundle");
    const bobBundles = bob.ofType("bundle");
    expect(aliceBundles).toEqual(bobBundles);
    expect(aliceBundles.map((b) => [b.from, b.to])).toEqual([
      [0, 2],
      [3, 5],
      [6, 8],
    ]);
    expect(aliceBundles[0]!.ticks).toEqual([]);
    expect(aliceBundles[2]!.ticks).toEqual([]);
    expect(room.tick).toBe(9);

    // Arrivées au même instant : ordre par playerId croissant, pas d'appel.
    expect(commandOrder(alice)).toEqual([
      [1, 10],
      [2, 20],
    ]);
  });

  it("planifie une commande au premier tick du prochain bundle", () => {
    const alice = new Recorder();
    const id = room.join("alice", alice.send)!;
    room.handle(id, { type: "start", seed: 1, width: 32, height: 32 });
    clock.tick(); // 0-2
    room.handle(id, { type: "command", payload: bytes(1) });
    clock.tick(); // 3-5
    const bundles = alice.ofType("bundle");
    expect(bundles[0]!.ticks).toEqual([]);
    expect(bundles[1]!.ticks).toHaveLength(1);
    expect(bundles[1]!.ticks[0]!.tick).toBe(3);
  });

  it("ordonne par instant d'arrivée puis par playerId", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    room.handle(bobId, { type: "command", payload: bytes(21) }); // t+0
    now += 5;
    room.handle(aliceId, { type: "command", payload: bytes(11) }); // t+5
    room.handle(bobId, { type: "command", payload: bytes(22) }); // t+5, après alice
    clock.tick();

    expect(commandOrder(alice)).toEqual([
      [2, 21],
      [1, 11],
      [2, 22],
    ]);
    expect(commandOrder(bob)).toEqual(commandOrder(alice));
  });
});

describe("rejoindre en cours", () => {
  it("demande un snapshot au host puis rejoue les bundles", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    room.join("bob", bob.send);
    room.handle(aliceId, { type: "start", seed: 3, width: 48, height: 48 });
    clock.tick(); // 0-2
    room.handle(aliceId, { type: "command", payload: bytes(10) });
    clock.tick(); // 3-5, porte la commande
    alice.clear();

    const carol = new Recorder();
    const carolId = room.join("carol", carol.send)!;

    // Bienvenue avec l'état de la carte, mais pas encore de bundle.
    const welcome = carol.ofType("welcome")[0]!;
    expect(welcome.state).toBe("running");
    expect(welcome.seed).toBe(3);
    expect(welcome.width).toBe(48);
    expect(welcome.tick).toBe(6);
    expect(carol.ofType("bundle")).toEqual([]);

    // Le host, et lui seul, reçoit la demande.
    expect(alice.ofType("request_snapshot")).toEqual([{ type: "request_snapshot", forPlayer: carolId }]);
    expect(bob.ofType("request_snapshot")).toEqual([]);

    // Un bundle émis pendant l'attente ne part pas vers carol.
    clock.tick(); // 6-8
    expect(carol.ofType("bundle")).toEqual([]);

    room.handle(aliceId, { type: "snapshot", tick: 3, data: bytes(1, 2, 3), forPlayer: carolId });

    expect(carol.ofType("snapshot")).toEqual([{ type: "snapshot", tick: 3, data: bytes(1, 2, 3) }]);
    // Rejeu de tout ce qui couvre le tick 3 et au-delà.
    expect(carol.ofType("bundle").map((b) => b.from)).toEqual([3, 6]);
    expect(commandOrder(carol)).toEqual([[1, 10]]);

    // Puis le flux courant, identique pour tout le monde.
    clock.tick(); // 9-11
    expect(carol.ofType("bundle").at(-1)!.from).toBe(9);
    expect(bob.ofType("bundle").at(-1)!.from).toBe(9);
  });

  it("sert tous les joueurs en attente quand le snapshot ne cible personne", () => {
    const alice = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
    clock.tick();

    const bob = new Recorder();
    const carol = new Recorder();
    room.join("bob", bob.send);
    room.join("carol", carol.send);
    room.handle(aliceId, { type: "snapshot", tick: 3, data: bytes(9) });

    expect(bob.ofType("snapshot")).toHaveLength(1);
    expect(carol.ofType("snapshot")).toHaveLength(1);
    clock.tick();
    expect(bob.ofType("bundle").at(-1)!.from).toBe(3);
    expect(carol.ofType("bundle").at(-1)!.from).toBe(3);
  });

  it("refuse un snapshot plus vieux que l'historique", () => {
    const small = new Room({
      name: "small",
      maxHistoryBundles: 2,
      startClock: clock.starter,
      log: () => {},
    });
    const alice = new Recorder();
    const aliceId = small.join("alice", alice.send)!;
    small.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
    clock.tick(3); // bundles 0-2, 3-5, 6-8 : le premier est oublié

    const bob = new Recorder();
    const bobId = small.join("bob", bob.send)!;
    small.handle(aliceId, { type: "snapshot", tick: 0, data: bytes(1), forPlayer: bobId });
    expect(bob.ofType("error")[0]!.code).toBe("history_gap");
    expect(bob.ofType("snapshot")).toEqual([]);
  });

  it("refuse un snapshot envoyé par un autre que le host", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
    room.handle(bobId, { type: "snapshot", tick: 0, data: bytes(1) });
    expect(bob.ofType("error")[0]!.code).toBe("not_host");
  });
});

describe("désync", () => {
  it("signale le premier écart de hash à tous et marque la salle", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    room.handle(aliceId, { type: "hash", tick: 300, hash: "aaaa" });
    room.handle(bobId, { type: "hash", tick: 300, hash: "aaaa" });
    expect(alice.ofType("desync")).toEqual([]);
    expect(room.state).toBe("running");

    room.handle(aliceId, { type: "hash", tick: 600, hash: "aaaa" });
    room.handle(bobId, { type: "hash", tick: 600, hash: "bbbb" });

    const expected = { type: "desync", tick: 600, hashes: { 1: "aaaa", 2: "bbbb" } };
    expect(alice.ofType("desync")).toEqual([expected]);
    expect(bob.ofType("desync")).toEqual([expected]);
    expect(room.state).toBe("desynced");

    // L'horloge continue : en v1 on signale, on ne répare pas.
    clock.tick();
    expect(alice.ofType("bundle").at(-1)!.from).toBeGreaterThanOrEqual(0);
    expect(clock.running).toBe(true);

    // Un second écart ne redéclenche rien.
    room.handle(aliceId, { type: "hash", tick: 900, hash: "cccc" });
    room.handle(bobId, { type: "hash", tick: 900, hash: "dddd" });
    expect(alice.ofType("desync")).toHaveLength(1);
  });

  it("ne calcule aucune majorité à deux joueurs : pas d'outliers, pas d'auto-réparation", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    room.handle(aliceId, { type: "hash", tick: 300, hash: "aaaa" });
    room.handle(bobId, { type: "hash", tick: 300, hash: "bbbb" });

    const desync = alice.ofType("desync")[0]!;
    expect(desync.outliers).toBeUndefined();
    expect(room.state).toBe("desynced");
    // Impossible de départager qui a raison à deux : personne n'est sollicité.
    expect(alice.ofType("request_snapshot")).toEqual([]);
    expect(bob.ofType("request_snapshot")).toEqual([]);
  });
});

describe("resynchronisation", () => {
  it("répare automatiquement le déviant identifié par la majorité, puis signale son retour", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const carol = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    const carolId = room.join("carol", carol.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    // Point de contrôle : bob dévie, alice et carol s'accordent.
    room.handle(aliceId, { type: "hash", tick: 300, hash: "AAAA" });
    room.handle(carolId, { type: "hash", tick: 300, hash: "AAAA" });
    room.handle(bobId, { type: "hash", tick: 300, hash: "ZZZZ" });

    expect(alice.ofType("desync")).toEqual([
      { type: "desync", tick: 300, hashes: { 1: "AAAA", 2: "ZZZZ", 3: "AAAA" }, outliers: [bobId] },
    ]);
    expect(room.state).toBe("desynced");

    // L'hôte, et lui seul, est sollicité pour rattraper bob — comme un rejoignant.
    expect(alice.ofType("request_snapshot")).toEqual([{ type: "request_snapshot", forPlayer: bobId }]);
    expect(carol.ofType("request_snapshot")).toEqual([]);

    const resyncTick = room.tick;
    room.handle(aliceId, { type: "snapshot", tick: resyncTick, data: bytes(9, 9, 9), forPlayer: bobId });
    expect(bob.ofType("snapshot")).toEqual([{ type: "snapshot", tick: resyncTick, data: bytes(9, 9, 9) }]);

    // Prochain point de contrôle : bob a rattrapé la majorité.
    room.handle(aliceId, { type: "hash", tick: 600, hash: "BBBB" });
    room.handle(carolId, { type: "hash", tick: 600, hash: "BBBB" });
    room.handle(bobId, { type: "hash", tick: 600, hash: "BBBB" });

    expect(alice.ofType("resynced")).toEqual([{ type: "resynced", player: bobId, tick: 600 }]);
    expect(room.state).toBe("running");
  });

  it("ne redéclenche pas de réparation avant RESYNC_COOLDOWN_TICKS, puis le fait au-delà", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const carol = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    const carolId = room.join("carol", carol.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    room.handle(aliceId, { type: "hash", tick: 300, hash: "AAAA" });
    room.handle(carolId, { type: "hash", tick: 300, hash: "AAAA" });
    room.handle(bobId, { type: "hash", tick: 300, hash: "ZZZZ" });
    expect(alice.ofType("request_snapshot")).toHaveLength(1);

    // Bob dévie encore juste après : le cooldown est actif, pas de nouvelle demande.
    room.handle(aliceId, { type: "hash", tick: 350, hash: "BBBB" });
    room.handle(carolId, { type: "hash", tick: 350, hash: "BBBB" });
    room.handle(bobId, { type: "hash", tick: 350, hash: "YYYY" });
    expect(alice.ofType("request_snapshot")).toHaveLength(1);

    // 1800 ticks après la première tentative : le cooldown est passé.
    room.handle(aliceId, { type: "hash", tick: 2100, hash: "CCCC" });
    room.handle(carolId, { type: "hash", tick: 2100, hash: "CCCC" });
    room.handle(bobId, { type: "hash", tick: 2100, hash: "XXXX" });
    expect(alice.ofType("request_snapshot")).toHaveLength(2);
    expect(alice.ofType("request_snapshot").at(-1)).toEqual({ type: "request_snapshot", forPlayer: bobId });
  });

  it("ne répare jamais un hôte déviant : on se contente de desync", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const carol = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    const carolId = room.join("carol", carol.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    // C'est l'hôte (alice) qui dévie ; bob et carol s'accordent en premier, pour
    // que la majorité soit déjà connue au moment où le hash de l'hôte arrive.
    room.handle(bobId, { type: "hash", tick: 300, hash: "ZZZZ" });
    room.handle(carolId, { type: "hash", tick: 300, hash: "ZZZZ" });
    room.handle(aliceId, { type: "hash", tick: 300, hash: "AAAA" });

    expect(alice.ofType("desync")[0]!.outliers).toEqual([aliceId]);
    expect(room.state).toBe("desynced");
    // Aucune demande de snapshot : en v1, personne ne corrige l'hôte.
    expect(alice.ofType("request_snapshot")).toEqual([]);
  });

  describe("manuelle", () => {
    it("un non-host obtient un nouveau snapshot", () => {
      const alice = new Recorder();
      const bob = new Recorder();
      const aliceId = room.join("alice", alice.send)!;
      const bobId = room.join("bob", bob.send)!;
      room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

      room.handle(bobId, { type: "resync" });
      expect(alice.ofType("request_snapshot")).toEqual([{ type: "request_snapshot", forPlayer: bobId }]);
      expect(bob.ofType("error")).toEqual([]);

      room.handle(aliceId, { type: "snapshot", tick: 0, data: bytes(5), forPlayer: bobId });
      expect(bob.ofType("snapshot")).toEqual([{ type: "snapshot", tick: 0, data: bytes(5) }]);
    });

    it("refuse l'hôte", () => {
      const alice = new Recorder();
      const aliceId = room.join("alice", alice.send)!;
      room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
      room.handle(aliceId, { type: "resync" });
      expect(alice.ofType("error")[0]!.code).toBe("host_cannot_resync");
    });

    it("refuse avant le démarrage de la salle", () => {
      const alice = new Recorder();
      const bob = new Recorder();
      room.join("alice", alice.send);
      const bobId = room.join("bob", bob.send)!;
      room.handle(bobId, { type: "resync" });
      expect(bob.ofType("error")[0]!.code).toBe("not_running");
    });

    it("refuse une seconde demande avant le délai de repos", () => {
      const alice = new Recorder();
      const bob = new Recorder();
      const aliceId = room.join("alice", alice.send)!;
      const bobId = room.join("bob", bob.send)!;
      room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
      room.handle(bobId, { type: "resync" });
      room.handle(bobId, { type: "resync" });
      expect(bob.ofType("error")[0]!.code).toBe("resync_cooldown");
    });
  });
});

describe("salle de case", () => {
  /** Une salle adossée à la case 4 du globe, graine imposée 777. */
  function tileRoom(options: Partial<RoomOptions> = {}): {
    room: Room;
    snapshots: Array<{ tick: number; data: Uint8Array; width: number; height: number }>;
  } {
    const snapshots: Array<{ tick: number; data: Uint8Array; width: number; height: number }> = [];
    const room = new Room({
      name: "tile-4",
      tile: { id: 4, seed: 777 },
      snapshotEveryTicks: 6,
      startClock: clock.starter,
      now: () => now,
      log: () => {},
      onSnapshot: (snapshot) => snapshots.push(snapshot),
      ...options,
    });
    return { room, snapshots };
  }

  it("impose la graine de la case, quoi qu'annonce l'hôte", () => {
    const { room: tile } = tileRoom();
    const alice = new Recorder();
    const aliceId = tile.join("alice", alice.send)!;
    tile.handle(aliceId, { type: "start", seed: 123, width: 64, height: 64 });

    expect(tile.tileId).toBe(4);
    expect(alice.ofType("start")[0]).toEqual({
      type: "start",
      seed: 777,
      width: 64,
      height: 64,
      tick: 0,
    });
  });

  it("porte le climat de la case dans le start quand il est fourni, l'omet sinon", () => {
    const climate = { baseTemperature: -340, amplitude: 200 };
    const { room: tile } = tileRoom({ tile: { id: 4, seed: 777, climate } });
    const alice = new Recorder();
    const aliceId = tile.join("alice", alice.send)!;
    tile.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    expect(alice.ofType("start")[0]).toEqual({
      type: "start",
      seed: 777,
      width: 32,
      height: 32,
      tick: 0,
      climate,
    });

    // Sans climat fourni (le cas par défaut de `tileRoom()`) : le champ est
    // absent, pas `undefined` explicite.
    const { room: bare } = tileRoom();
    const bob = new Recorder();
    const bobId = bare.join("bob", bob.send)!;
    bare.handle(bobId, { type: "start", seed: 1, width: 32, height: 32 });
    expect(bob.ofType("start")[0]!).not.toHaveProperty("climate");
  });

  it("porte le jour de l'année de la case dans le start quand il est fourni, l'omet sinon", () => {
    const { room: tile } = tileRoom({ tile: { id: 4, seed: 777, dayOfYear: 45 } });
    const alice = new Recorder();
    const aliceId = tile.join("alice", alice.send)!;
    tile.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });

    expect(alice.ofType("start")[0]).toEqual({
      type: "start",
      seed: 777,
      width: 32,
      height: 32,
      tick: 0,
      dayOfYear: 45,
    });

    // Sans jour fourni (le cas par défaut de `tileRoom()`) : le champ est
    // absent, pas `undefined` explicite — même règle que `climate`.
    const { room: bare } = tileRoom();
    const bob = new Recorder();
    const bobId = bare.join("bob", bob.send)!;
    bare.handle(bobId, { type: "start", seed: 1, width: 32, height: 32 });
    expect(bob.ofType("start")[0]!).not.toHaveProperty("dayOfYear");
  });

  it("réclame périodiquement un snapshot de conservation et le garde sans le relayer", () => {
    const { room: tile, snapshots } = tileRoom();
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = tile.join("alice", alice.send)!;
    tile.join("bob", bob.send);
    tile.handle(aliceId, { type: "start", seed: 1, width: 96, height: 48 });

    clock.tick(2); // ticks 0-5 : pas encore la période
    expect(alice.ofType("request_snapshot")).toEqual([]);
    clock.tick(); // 6-8 : la période de 6 ticks est franchie
    expect(alice.ofType("request_snapshot")).toEqual([{ type: "request_snapshot", forPlayer: 0 }]);
    // L'hôte seul est sollicité.
    expect(bob.ofType("request_snapshot")).toEqual([]);

    tile.handle(aliceId, { type: "snapshot", tick: 9, data: bytes(4, 5, 6) });
    expect(snapshots).toEqual([{ tick: 9, data: bytes(4, 5, 6), width: 96, height: 48 }]);
    // Conservation ne veut pas dire diffusion : personne ne reçoit ce snapshot.
    expect(alice.ofType("snapshot")).toEqual([]);
    expect(bob.ofType("snapshot")).toEqual([]);
  });

  it("rouvre en jeu depuis un snapshot conservé, sans solliciter personne", () => {
    const { room: tile } = tileRoom({
      restore: { tick: 1800, data: bytes(7, 7, 7), width: 128, height: 128 },
    });
    const alice = new Recorder();
    tile.join("alice", alice.send);

    expect(tile.state).toBe("running");
    const welcome = alice.ofType("welcome")[0]!;
    expect(welcome.state).toBe("running");
    expect(welcome.tick).toBe(1800);
    expect(welcome.seed).toBe(777);
    expect(welcome.width).toBe(128);
    expect(welcome.isHost).toBe(true);
    // L'état vient du serveur : aucun hôte n'a été sollicité.
    expect(alice.ofType("request_snapshot")).toEqual([]);
    expect(alice.ofType("snapshot")).toEqual([{ type: "snapshot", tick: 1800, data: bytes(7, 7, 7) }]);
    expect(alice.ofType("error")).toEqual([]);

    // Les bundles repartent du tick du snapshot, sans rejeu.
    clock.tick(2);
    expect(alice.ofType("bundle").map((b) => b.from)).toEqual([1800, 1803]);

    // Le second arrivant, lui, passe par l'hôte comme dans une salle ordinaire.
    const bob = new Recorder();
    tile.join("bob", bob.send);
    expect(alice.ofType("request_snapshot")).toHaveLength(1);
    expect(bob.ofType("snapshot")).toEqual([]);
  });

  it("porte le temps gelé au premier arrivant, et rien quand il n'y en a pas", () => {
    const { room: tile } = tileRoom({
      restore: { tick: 1800, data: bytes(7, 7, 7), width: 128, height: 128, frozenTicks: 3000 },
    });
    const alice = new Recorder();
    tile.join("alice", alice.send);
    // C'est à ce joueur — l'hôte — d'émettre l'avance rapide en lockstep.
    expect(alice.ofType("snapshot")).toEqual([
      { type: "snapshot", tick: 1800, data: bytes(7, 7, 7), frozenTicks: 3000 },
    ]);

    // Colonie rouverte dans la foulée : pas de champ du tout, rien à rattraper.
    const { room: warm } = tileRoom({
      restore: { tick: 60, data: bytes(1), width: 64, height: 64, frozenTicks: 0 },
    });
    const bob = new Recorder();
    warm.join("bob", bob.send);
    expect(bob.ofType("snapshot")).toEqual([{ type: "snapshot", tick: 60, data: bytes(1) }]);
  });

  it("refuse une réouverture hors salle de case", () => {
    expect(
      () =>
        new Room({
          name: "demo",
          restore: { tick: 10, data: bytes(1), width: 32, height: 32 },
          startClock: clock.starter,
          log: () => {},
        }),
    ).toThrow(/salle de case/);
  });
});

describe("départs", () => {
  it("réattribue le host et arrête l'horloge quand la salle se vide", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
    clock.tick();

    room.leave(aliceId);
    expect(room.host).toBe(bobId);
    const players = bob.ofType("players").at(-1)!;
    expect(players.hostId).toBe(bobId);
    expect(players.players).toEqual([{ id: 2, name: "bob" }]);
    expect(clock.running).toBe(true);

    room.leave(bobId);
    expect(room.isEmpty).toBe(true);
    expect(room.host).toBeNull();
    expect(clock.running).toBe(false);
  });

  it("redemande le snapshot au nouveau host si l'ancien part", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    room.join("bob", bob.send);
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
    clock.tick();

    const carol = new Recorder();
    const carolId = room.join("carol", carol.send)!;
    expect(alice.ofType("request_snapshot")).toHaveLength(1);
    expect(bob.ofType("request_snapshot")).toHaveLength(0);

    room.leave(aliceId);
    expect(bob.ofType("request_snapshot")).toEqual([{ type: "request_snapshot", forPlayer: carolId }]);
  });

  it("oublie les commandes en attente d'un joueur parti", () => {
    const alice = new Recorder();
    const bob = new Recorder();
    const aliceId = room.join("alice", alice.send)!;
    const bobId = room.join("bob", bob.send)!;
    room.handle(aliceId, { type: "start", seed: 1, width: 32, height: 32 });
    room.handle(bobId, { type: "command", payload: bytes(20) });
    room.handle(aliceId, { type: "command", payload: bytes(10) });
    room.leave(bobId);
    clock.tick();
    expect(commandOrder(alice)).toEqual([[1, 10]]);
  });
});
