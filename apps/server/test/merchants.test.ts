/**
 * Marchands itinérants (`docs/protocol.md` §13) : des caravanes marchandes PNJ
 * qui circulent de colonie en colonie et préviennent l'hôte de celle où elles
 * s'arrêtent.
 *
 * **Rien n'attend ici.** L'horloge de jeu du monde et le planificateur de son
 * tick sont tous deux injectés (`worldNow`, `startWorldClock`) : le test avance
 * les heures à la main et déclenche lui-même les ticks. Un voyage de trois
 * jours de monde se joue donc en une ligne, et deux exécutions donnent
 * exactement le même déroulé.
 *
 * Le globe de test est à la subdivision 2 (162 cases), comme les autres suites
 * du monde : instantané à générer, et il a plusieurs continents séparés par
 * l'océan — d'où la précaution de `continents` plus bas, un marchand ne prenant
 * pas la mer.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { MAX_PENDING_TRADERS, MERCHANT_STAY_HOURS } from "@rimlike/protocol";
import { findRoute, movementCost } from "@rimlike/world";

import { MERCHANT_COMPANY_NAMES } from "../src/merchants.js";
import { startServer, type RunningServer } from "../src/server.js";
import { DEFAULT_WORLD_SEED, WorldState, sharedWorld } from "../src/world.js";
import { TestClient, bytes } from "./helpers.js";

const SUBDIVISIONS = 2;
const globe = sharedWorld(SUBDIVISIONS, DEFAULT_WORLD_SEED);

/** Une heure de jeu en 1 s réelle — sans importance : le test pilote l'horloge. */
const HOUR_MS = 1000;

const landTiles = globe.tiles.filter((tile) => movementCost(tile.biome) !== null).map((tile) => tile.id);

/**
 * Une case terrestre par continent : en colonisant celles-là, on garantit qu'un
 * marchand a une colonie à rejoindre **où qu'il naisse**. Sans cette précaution,
 * un marchand né sur une île sans colonie attendrait indéfiniment — c'est le
 * comportement voulu (voir « aucune colonie »), mais pas ce qu'on veut tester
 * partout ailleurs.
 */
const continents: number[] = [];
for (const id of landTiles) {
  if (!continents.some((representative) => findRoute(globe, representative, id) !== null)) {
    continents.push(id);
  }
}

/** Cases atteignables depuis `from`, de la plus proche à la plus lointaine. */
function reachableFrom(from: number): { readonly id: number; readonly hours: number }[] {
  return landTiles
    .filter((id) => id !== from)
    .map((id) => ({ id, route: findRoute(globe, from, id) }))
    .filter((entry): entry is { id: number; route: NonNullable<typeof entry.route> } => entry.route !== null)
    .sort((a, b) => a.route.hours - b.route.hours || a.id - b.id)
    .map((entry) => ({ id: entry.id, hours: entry.route.hours }));
}

/** Un serveur dont l'horloge de jeu **et** le tick du monde sont pilotés par le test. */
interface DrivenWorld {
  readonly server: RunningServer;
  /** Un tick du monde, sans avancer l'horloge. */
  tick(): void;
  /** Avance l'horloge de jeu de `hours` heures, puis fait tourner un tick. */
  advance(hours: number): void;
}

const servers: DrivenWorld[] = [];
const clients: TestClient[] = [];

async function startWorld(
  options: {
    readonly merchants?: number;
    readonly stayHours?: number;
    readonly roomOptions?: { readonly tickRate?: number; readonly bundleTicks?: number };
  } = {},
): Promise<DrivenWorld> {
  const clock = { nowMs: 1_757_000_000_000, onTick: undefined as (() => void) | undefined };
  const server = await startServer({
    port: 0,
    log: () => {},
    worldSubdivisions: SUBDIVISIONS,
    worldHourMs: HOUR_MS,
    worldNow: () => clock.nowMs,
    // Le planificateur du tick du monde n'est jamais démarré : c'est le test
    // qui appelle `onTick`, quand il le décide.
    startWorldClock: (onTick) => {
      clock.onTick = onTick;
      return () => {
        clock.onTick = undefined;
      };
    },
    merchantCount: options.merchants ?? 1,
    merchantStayHours: options.stayHours ?? MERCHANT_STAY_HOURS,
    ...(options.roomOptions === undefined ? {} : { roomOptions: options.roomOptions }),
  });
  const driven: DrivenWorld = {
    server,
    tick: () => {
      clock.onTick?.();
    },
    advance: (hours: number) => {
      clock.nowMs += hours * HOUR_MS;
      clock.onTick?.();
    },
  };
  servers.push(driven);
  return driven;
}

async function connect(target: RunningServer): Promise<TestClient> {
  const client = await TestClient.connect(target.url);
  clients.push(client);
  return client;
}

/** Un client déjà entré dans le monde. */
async function joinWorld(name: string, target: RunningServer): Promise<TestClient> {
  const client = await connect(target);
  client.send({ type: "world_join", name });
  await client.next("world_welcome");
  return client;
}

/** L'état interne des marchands du serveur : itinéraires et statuts compris. */
function merchantsOf(world: DrivenWorld) {
  return world.server.world.merchants.toJSON().merchants;
}

/**
 * Attend une condition sur l'état du **serveur** (pas sur un flux de messages,
 * pour lequel `TestClient.waitUntil` suffit) : une salle détruite après un
 * départ, par exemple, n'annonce rien à personne. Rien à voir avec l'horloge du
 * monde, qui reste pilotée à la main.
 */
async function until(label: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`délai dépassé en attendant : ${label}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

afterEach(async () => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  for (const { server } of servers) {
    await server.close();
  }
  servers.length = 0;
});

describe("globe de test", () => {
  it("a plusieurs continents, donc de quoi rester bloqué", () => {
    expect(landTiles.length).toBeGreaterThan(10);
    expect(continents.length).toBeGreaterThanOrEqual(2);
  });
});

describe("naissance et destination", () => {
  it("fait naître les marchands et les envoie vers une colonie fondée", async () => {
    const world = await startWorld({ merchants: 2 });
    const alice = await joinWorld("alice", world.server);
    // Une colonie par continent : aucun marchand ne peut naître isolé.
    for (const tile of continents) {
      alice.send({ type: "settle", tile });
      await alice.nth("settled", continents.indexOf(tile));
    }

    world.tick();
    const merchants = merchantsOf(world);
    expect(merchants).toHaveLength(2);
    const settled = new Set(continents);
    const names = new Set<string>();
    for (const merchant of merchants) {
      expect(merchant.id).toMatch(/^m[0-9]+$/);
      expect(MERCHANT_COMPANY_NAMES).toContain(merchant.name);
      names.add(merchant.name);
      expect(merchant.status).toBe("travelling");
      // Une vraie route, du point de naissance jusqu'à une colonie.
      expect(merchant.route.length).toBeGreaterThanOrEqual(2);
      expect(merchant.route[0]).toBe(merchant.fromTile);
      expect(merchant.route.at(-1)).toBe(merchant.toTile);
      expect(settled.has(merchant.toTile)).toBe(true);
      expect(merchant.arrivesAt).toBeGreaterThan(merchant.departedAt);
      expect(merchant.visits).toBe(0);
    }
    // Deux compagnies d'une même graine portent des noms différents.
    expect(names.size).toBe(merchants.length);
    // Deux marchands, deux identifiants : jamais réutilisés.
    expect(new Set(merchants.map((m) => m.id)).size).toBe(2);

    // Et ils partent sur le fil, par le même message que les caravanes.
    await alice.waitUntil("marchands diffusés", () =>
      (alice.ofType("world_caravans").at(-1)?.merchants ?? []).length === 2,
    );
    const wire = alice.ofType("world_caravans").at(-1)!;
    expect(wire.caravans).toEqual([]);
    expect(wire.merchants!.map((m) => m.id).sort()).toEqual(merchants.map((m) => m.id).sort());
    for (const merchant of wire.merchants!) {
      // `tile` est la case **courante**, dérivée de l'avancement : au départ,
      // celle de naissance.
      const stored = merchants.find((m) => m.id === merchant.id)!;
      expect(merchant.tile).toBe(stored.fromTile);
      expect(merchant.toTile).toBe(stored.toTile);
      expect(merchant.progress).toBe(0);
    }
  });

  it("naît sur une case terrestre libre, jamais sur une colonie", async () => {
    const world = await startWorld({ merchants: 3 });
    const alice = await joinWorld("alice", world.server);
    for (const tile of continents) {
      alice.send({ type: "settle", tile });
      await alice.nth("settled", continents.indexOf(tile));
    }
    world.tick();
    for (const merchant of merchantsOf(world)) {
      expect(landTiles).toContain(merchant.fromTile);
      expect(continents).not.toContain(merchant.fromTile);
    }
  });

  it("choisit la colonie la plus proche, jamais celle qu'il quitte", async () => {
    const world = await startWorld({ merchants: 1 });
    // Un premier tick sans colonie : le marchand naît et attend sur place.
    world.tick();
    const [born] = merchantsOf(world);
    const near = reachableFrom(born!.fromTile);
    expect(near.length).toBeGreaterThan(1);

    const alice = await joinWorld("alice", world.server);
    // Deux colonies joignables : la plus proche d'abord, puis l'autre.
    for (const target of [near[0]!.id, near[1]!.id]) {
      alice.send({ type: "settle", tile: target });
      await alice.next("settled");
    }

    world.tick();
    expect(merchantsOf(world)[0]!.toTile).toBe(near[0]!.id);

    // Arrivé, il visite ; la visite finie, il repart — vers l'autre colonie,
    // pas vers celle où il est déjà.
    world.advance(near[0]!.hours);
    expect(merchantsOf(world)[0]!.status).toBe("visiting");
    world.advance(MERCHANT_STAY_HOURS);
    const next = merchantsOf(world)[0]!;
    expect(next.status).toBe("travelling");
    expect(next.fromTile).toBe(near[0]!.id);
    expect(next.toTile).toBe(near[1]!.id);
  });
});

describe("aucune colonie", () => {
  it("laisse les marchands attendre sur place et retente à chaque tick", async () => {
    const world = await startWorld({ merchants: 2 });
    const alice = await joinWorld("alice", world.server);

    world.tick();
    world.advance(100);
    world.advance(100);
    const waiting = merchantsOf(world);
    expect(waiting).toHaveLength(2);
    for (const merchant of waiting) {
      // Un marchand en attente se reconnaît à `toTile === fromTile`.
      expect(merchant.toTile).toBe(merchant.fromTile);
      expect(merchant.route).toEqual([merchant.fromTile]);
      expect(merchant.status).toBe("travelling");
      expect(merchant.visits).toBe(0);
    }
    const seen = alice.ofType("world_caravans").at(-1)?.merchants ?? [];
    for (const merchant of seen) {
      expect(merchant.progress).toBe(0);
      expect(merchant.tile).toBe(merchant.toTile);
    }

    // Une colonie apparaît : au tick suivant, ceux qui peuvent l'atteindre partent.
    for (const tile of continents) {
      alice.send({ type: "settle", tile });
      await alice.nth("settled", continents.indexOf(tile));
    }
    world.tick();
    for (const merchant of merchantsOf(world)) {
      expect(merchant.toTile).not.toBe(merchant.fromTile);
      expect(continents).toContain(merchant.toTile);
    }
  });
});

describe("WORLD_MERCHANTS=0", () => {
  it("n'en fait circuler aucun", async () => {
    const world = await startWorld({ merchants: 0 });
    const alice = await joinWorld("alice", world.server);
    for (const tile of continents) {
      alice.send({ type: "settle", tile });
      await alice.nth("settled", continents.indexOf(tile));
    }
    world.tick();
    world.advance(1000);

    expect(world.server.world.merchants.count).toBe(0);
    expect(merchantsOf(world)).toEqual([]);
    expect(alice.ofType("world_caravans").at(-1)?.merchants).toEqual([]);
    expect(alice.ofType("trader_arrival")).toEqual([]);

    const health = (await (await fetch(`http://127.0.0.1:${world.server.port}/health`)).json()) as {
      world: { merchants: number };
    };
    expect(health.world.merchants).toBe(0);
  });
});

describe("arrivée sur une colonie ouverte", () => {
  it("prévient l'hôte, et lui seul", async () => {
    const world = await startWorld({ merchants: 1 });
    world.tick();
    const born = merchantsOf(world)[0]!;
    const target = reachableFrom(born.fromTile)[0]!;

    // alice fonde la colonie visée et l'ouvre ; bob l'y rejoint en invité.
    const alice = await joinWorld("alice", world.server);
    alice.send({ type: "settle", tile: target.id });
    const settled = await alice.next("settled");
    alice.send({ type: "join", room: settled.room, name: "alice" });
    expect((await alice.nth("welcome")).isHost).toBe(true);
    const bob = await joinWorld("bob", world.server);
    bob.send({ type: "join", room: settled.room, name: "bob" });
    expect((await bob.nth("welcome")).isHost).toBe(false);
    alice.send({ type: "start", seed: 1, width: 64, height: 64 });
    const start = await alice.nth("start");
    // Personne n'est passé pendant que la colonie était fermée.
    expect(start).not.toHaveProperty("pendingTraders");
    await bob.nth("start");

    world.tick();
    expect(merchantsOf(world)[0]!.toTile).toBe(target.id);
    world.advance(target.hours);

    const arrival = await alice.next("trader_arrival");
    expect(arrival).toEqual({
      type: "trader_arrival",
      tile: target.id,
      merchantId: born.id,
      merchantName: born.name,
    });
    // Un invité n'a rien à faire entrer sur la carte : seul l'hôte est prévenu.
    expect(bob.ofType("trader_arrival")).toEqual([]);
    // Message immédiat **ou** mise en attente, jamais les deux (§13).
    expect(world.server.world.pendingTradersAt(target.id)).toBe(0);

    // Il s'attarde le temps d'une visite, sans réémission.
    expect(merchantsOf(world)[0]!.status).toBe("visiting");
    expect(merchantsOf(world)[0]!.visits).toBe(1);
    world.advance(MERCHANT_STAY_HOURS - 1);
    expect(alice.ofType("trader_arrival")).toHaveLength(1);
  });

  it("attend le start quand la salle est encore en lobby", async () => {
    const world = await startWorld({ merchants: 1 });
    world.tick();
    const born = merchantsOf(world)[0]!;
    const target = reachableFrom(born.fromTile)[0]!;

    const alice = await joinWorld("alice", world.server);
    alice.send({ type: "settle", tile: target.id });
    const settled = await alice.next("settled");
    // La salle existe et a un hôte, mais pas de carte : rien où faire entrer
    // un marchand tant que le `start` n'est pas passé.
    alice.send({ type: "join", room: settled.room, name: "alice" });
    expect((await alice.nth("welcome")).state).toBe("lobby");

    world.tick();
    world.advance(target.hours);
    expect(alice.ofType("trader_arrival")).toEqual([]);
    expect(world.server.world.pendingTradersAt(target.id)).toBe(1);

    alice.send({ type: "start", seed: 1, width: 64, height: 64 });
    expect((await alice.nth("start")).pendingTraders).toBe(1);
    expect(world.server.world.pendingTradersAt(target.id)).toBe(0);
  });
});

describe("arrivée sur une colonie fermée", () => {
  it("compte l'arrivée et la remet au prochain start", async () => {
    const world = await startWorld({ merchants: 1 });
    world.tick();
    const born = merchantsOf(world)[0]!;
    const target = reachableFrom(born.fromTile)[0]!;

    // La colonie est fondée mais jamais ouverte : aucune salle.
    const alice = await joinWorld("alice", world.server);
    alice.send({ type: "settle", tile: target.id });
    const settled = await alice.next("settled");
    expect(world.server.roomCount).toBe(0);

    world.tick();
    world.advance(target.hours);
    expect(alice.ofType("trader_arrival")).toEqual([]);
    expect(world.server.world.pendingTradersAt(target.id)).toBe(1);

    // Ouverture : lobby (rien à ce moment-là), puis le `start` porte le compte.
    alice.send({ type: "join", room: settled.room, name: "alice" });
    expect((await alice.nth("welcome")).state).toBe("lobby");
    expect(alice.ofType("trader_arrival")).toEqual([]);
    alice.send({ type: "start", seed: 1, width: 64, height: 64 });
    const start = await alice.nth("start");
    expect(start.pendingTraders).toBe(1);
    // Remis à zéro : un second `start` ne referait pas venir le même marchand.
    expect(world.server.world.pendingTradersAt(target.id)).toBe(0);
  });

  it("borne la file à trois marchands", async () => {
    // Deux colonies fermées, jamais ouvertes : le marchand fait la navette et
    // chaque passage compte, jusqu'à la borne.
    const world = await startWorld({ merchants: 1, stayHours: 1 });
    world.tick();
    const born = merchantsOf(world)[0]!;
    const near = reachableFrom(born.fromTile);
    const first = near[0]!;
    const second = near[1]!;

    const alice = await joinWorld("alice", world.server);
    for (const tile of [first.id, second.id]) {
      alice.send({ type: "settle", tile });
      await alice.next("settled");
    }

    // Assez de va-et-vient pour dépasser largement quatre arrivées.
    world.tick();
    for (let step = 0; step < 40; step += 1) {
      world.advance(Math.max(1, first.hours + second.hours));
    }
    const visits = merchantsOf(world)[0]!.visits;
    expect(visits).toBeGreaterThanOrEqual(4);

    const counted = world.server.world.pendingTradersAt(first.id) + world.server.world.pendingTradersAt(second.id);
    expect(counted).toBeLessThanOrEqual(2 * MAX_PENDING_TRADERS);
    expect(world.server.world.pendingTradersAt(first.id)).toBe(MAX_PENDING_TRADERS);
    expect(MAX_PENDING_TRADERS).toBe(3);

    // Et c'est bien ce plafond qui part dans le `start`.
    alice.send({ type: "join", room: `tile-${first.id}`, name: "alice" });
    await alice.nth("welcome");
    alice.send({ type: "start", seed: 1, width: 64, height: 64 });
    expect((await alice.nth("start")).pendingTraders).toBe(MAX_PENDING_TRADERS);
  });

  it("remet le compte dans le snapshot d'une colonie qui rouvre", async () => {
    // Une colonie **gelée** ne reçoit aucun `start` à sa réouverture (§11.6) :
    // le compte voyage alors avec son snapshot, à côté de `frozenTicks`.
    const world = await startWorld({
      merchants: 1,
      roomOptions: { tickRate: 60_000, bundleTicks: 600 },
    });
    world.tick();
    const born = merchantsOf(world)[0]!;
    const target = reachableFrom(born.fromTile)[0]!;

    const alice = await joinWorld("alice", world.server);
    alice.send({ type: "settle", tile: target.id });
    const settled = await alice.next("settled");
    alice.send({ type: "join", room: settled.room, name: "alice" });
    await alice.nth("welcome");
    alice.send({ type: "start", seed: 1, width: 64, height: 64 });
    await alice.nth("start");

    // L'hôte conserve un état, puis tout le monde s'en va.
    await alice.nth("request_snapshot");
    const tick = alice.ofType("bundle").at(-1)!.to + 1;
    alice.send({ type: "snapshot", tick, data: bytes(1, 2, 3, 4) });
    await until("snapshot stocké", () => world.server.world.snapshotFor(settled.room) !== undefined);
    alice.close();
    await until("salle détruite", () => world.server.roomCount === 0);

    // Le marchand passe pendant que la colonie dort.
    world.tick();
    world.advance(target.hours);
    expect(world.server.world.pendingTradersAt(target.id)).toBe(1);

    // Quelqu'un revient : la salle rouvre en jeu, sans `start`.
    const bob = await joinWorld("bob", world.server);
    bob.send({ type: "visit", tile: target.id });
    const destination = await bob.next("settled");
    bob.send({ type: "join", room: destination.room, name: "bob" });
    expect((await bob.nth("welcome")).state).toBe("running");
    const snapshot = await bob.nth("snapshot");
    expect(snapshot.tick).toBe(tick);
    expect(snapshot.pendingTraders).toBe(1);
    expect(bob.ofType("start")).toEqual([]);
    expect(world.server.world.pendingTradersAt(target.id)).toBe(0);
  });
});

describe("persistance", () => {
  /** Un état de monde à horloge pilotée, hors serveur. */
  function state(hours: () => number, merchantCount = 2): WorldState {
    return new WorldState({ world: globe, now: () => hours() * HOUR_MS, hourMs: HOUR_MS, merchantCount });
  }

  it("conserve itinéraires et statuts d'un aller-retour JSON", () => {
    let hours = 0;
    const world = state(() => hours);
    for (const tile of continents) {
      expect(world.settle(tile, "key-alice").ok).toBe(true);
    }
    world.merchants.tick();
    hours += 5;
    world.merchants.tick();
    const before = world.merchants.toJSON();
    expect(before.merchants).toHaveLength(2);
    expect(before.merchants[0]!.route.length).toBeGreaterThanOrEqual(2);

    const json = JSON.parse(JSON.stringify(world.toJSON())) as ReturnType<WorldState["toJSON"]>;
    expect(json.merchants).toEqual(before);
    const back = WorldState.fromJSON(json, { world: globe, now: () => hours * HOUR_MS, hourMs: HOUR_MS, merchantCount: 2 });
    expect(back.merchants.toJSON()).toEqual(before);
    expect(back.merchants.list()).toEqual(world.merchants.list());

    // Et le voyage reprend où il en était : même heure d'arrivée, pas de
    // rattrapage inventé par le redémarrage.
    hours = before.merchants[0]!.arrivesAt;
    const arrivals = back.merchants.tick().arrivals;
    expect(arrivals.map((a) => a.merchantId)).toContain(before.merchants[0]!.id);
  });

  it("garde les marchands en attente d'une colonie fermée", () => {
    let hours = 0;
    const world = state(() => hours, 0);
    expect(world.settle(continents[0]!, "key-alice").ok).toBe(true);
    expect(world.addPendingTrader(continents[0]!)).toBe(true);
    expect(world.addPendingTrader(continents[0]!)).toBe(true);

    const json = JSON.parse(JSON.stringify(world.toJSON())) as ReturnType<WorldState["toJSON"]>;
    // Le compte est sur la colonie, pas dans une seconde structure.
    expect(json.settlements[0]!.pendingTraders).toBe(2);
    // …et jamais sur le fil : `Settlement` n'a pas ce champ (§13).
    expect(world.list()[0]).not.toHaveProperty("pendingTraders");

    hours += 1;
    const back = WorldState.fromJSON(json, { world: globe, now: () => hours * HOUR_MS, hourMs: HOUR_MS, merchantCount: 0 });
    expect(back.pendingTradersAt(continents[0]!)).toBe(2);
    expect(back.takePendingTraders(continents[0]!)).toBe(2);
    expect(back.pendingTradersAt(continents[0]!)).toBe(0);
  });

  it("relit un fichier sans marchands : ils renaissent au premier tick", () => {
    let hours = 0;
    const world = state(() => hours);
    expect(world.settle(continents[0]!, "key-alice").ok).toBe(true);
    const { merchants: _merchants, ...older } = JSON.parse(
      JSON.stringify(world.toJSON()),
    ) as ReturnType<WorldState["toJSON"]>;

    const back = WorldState.fromJSON(older, {
      world: globe,
      now: () => hours * HOUR_MS,
      hourMs: HOUR_MS,
      merchantCount: 2,
    });
    expect(back.merchants.count).toBe(0);
    back.merchants.tick();
    expect(back.merchants.count).toBe(2);
  });

  it("ignore une entrée de marchand incohérente plutôt que de perdre le monde", () => {
    let hours = 0;
    const world = state(() => hours);
    expect(world.settle(continents[0]!, "key-alice").ok).toBe(true);
    world.merchants.tick();
    const json = JSON.parse(JSON.stringify(world.toJSON())) as ReturnType<WorldState["toJSON"]>;
    const [first, ...rest] = json.merchants!.merchants;
    const corrupted = {
      ...json,
      merchants: { ...json.merchants!, merchants: [{ ...first!, toTile: 9999 }, ...rest] },
    };

    // Un PNJ jetable ne met pas tout le fichier en quarantaine : il est
    // simplement oublié, et un autre naîtra.
    const back = WorldState.fromJSON(corrupted, {
      world: globe,
      now: () => hours * HOUR_MS,
      hourMs: HOUR_MS,
      merchantCount: 2,
    });
    expect(back.merchants.count).toBe(1);
    expect(back.settlementCount).toBe(1);
    back.merchants.tick();
    expect(back.merchants.count).toBe(2);
  });
});

describe("réglages", () => {
  let world: DrivenWorld;

  beforeEach(async () => {
    world = await startWorld({ merchants: 1, stayHours: 3 });
  });

  it("respecte la durée de visite configurée", async () => {
    world.tick();
    const born = merchantsOf(world)[0]!;
    const target = reachableFrom(born.fromTile)[0]!;
    const alice = await joinWorld("alice", world.server);
    alice.send({ type: "settle", tile: target.id });
    await alice.next("settled");

    world.tick();
    world.advance(target.hours);
    expect(merchantsOf(world)[0]!.status).toBe("visiting");
    expect(merchantsOf(world)[0]!.visitEndsAt).toBe(merchantsOf(world)[0]!.departedAt + 3);

    world.advance(2);
    expect(merchantsOf(world)[0]!.status).toBe("visiting");
    world.advance(1);
    // Une seule colonie sur son continent : il repart… nulle part, donc il
    // attend sur place, prêt à repartir dès qu'une autre sera fondée.
    expect(merchantsOf(world)[0]!.status).toBe("travelling");
  });
});
