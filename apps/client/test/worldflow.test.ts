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
import type { CaravanArriveMessage, SettledMessage } from "@rimlike/protocol";
import { findRoute, movementCost, tileCount, type World } from "@rimlike/world";

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
/**
 * Une heure de jeu du monde, en millisecondes réelles (30 000 en vrai) : assez
 * courte pour qu'un voyage tienne dans un test, assez longue pour qu'une
 * annulation ait le temps d'arriver avant la moitié du trajet.
 */
const WORLD_HOUR_MS = 20;
/** Période du tick du monde : avancement des caravanes et `world_caravans`. */
const CARAVAN_TICK_MS = 5;

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

/**
 * Un `Storage` en mémoire, posé sur `globalThis.localStorage` pour la durée
 * d'un test : c'est là que `net/identity.ts` range le jeton d'un `WorldClient`
 * (l'environnement de test est Node, sans DOM ni vrai `localStorage`). Pas de
 * `implements Storage` : l'interface DOM porte un index de signature que ce
 * type ordinaire ne satisfait pas ; la forme suffit, castée à l'assignation.
 */
class FakeStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
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

let server: RunningServer;
const closers: Array<() => void> = [];
/** Un `identityKey` frais par appel par défaut : chaque connexion de test reste un nouveau joueur. */
let deviceCounter = 0;

async function waitFor(label: string, done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) throw new Error(`délai dépassé en attendant : ${label}`);
    await sleep(2);
  }
}

/**
 * Une connexion monde branchée sur le vrai serveur.
 *
 * `identityKey` simule l'« appareil » qui se connecte : c'est la clé de
 * stockage de l'identité (`WorldClientOptions.serverUrl`, réutilisée ici comme
 * un simple identifiant d'appareil plutôt que l'URL réelle du serveur — le
 * jeton et la clé n'en dépendent que par son contenu). Deux appels avec la
 * **même** valeur partagent le jeton stocké : c'est une reconnexion depuis le
 * même appareil (§11.2). Par défaut, une valeur fraîche à chaque appel : sans
 * jeton partagé, le serveur crée un nouveau joueur à chaque connexion, comme
 * avant l'identité par jeton — le comportement qu'attendent les tests qui ne
 * précisent rien.
 */
async function enterWorld(world: World, name: string, identityKey = `device-${deviceCounter++}`) {
  const transport = await WsTransport.connect(server.url);
  const settled: SettledMessage[] = [];
  const errors: WorldError[] = [];
  // Les arrivées de caravane se reçoivent désormais ici, sur la connexion
  // monde (docs/protocol.md §12.7) : collectées comme `settled`/`errors`,
  // même quand aucun test de caravane ne les regarde.
  const arrivals: CaravanArriveMessage[] = [];
  const client = new WorldClient({
    transport,
    name,
    serverUrl: identityKey,
    expected: { seed: world.seed, subdivisions: world.subdivisions, tiles: world.tiles.length },
    onSettled: (message) => settled.push(message),
    onError: (error) => errors.push(error),
    onCaravanArrive: (arrival) => arrivals.push(arrival),
  });
  closers.push(() => client.close());
  client.join();
  await waitFor(`${name} dans le monde`, () => client.state.phase === "connected");
  return { client, settled, errors, arrivals };
}

/**
 * Une connexion de salle, avec son sim factice. Ne porte plus aucun ordre de
 * caravane : ils partent désormais de la connexion monde (`enterWorld`,
 * `docs/protocol.md` §12.7). Le serveur reconnaît la présence de cette salle
 * pour la connexion monde du même nom par repli (`isPresentInRoom`, §12.3),
 * sans qu'un jeton partagé soit nécessaire.
 */
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

beforeEach(() => {
  (globalThis as { localStorage?: Storage }).localStorage = new FakeStorage() as unknown as Storage;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

beforeEach(async () => {
  server = await startServer({
    port: 0,
    log: () => {},
    worldSeed: WORLD_SEED,
    worldSubdivisions: SUBDIVISIONS,
    // Horloge accélérée et conservation rapprochée : le test tient en une seconde.
    roomOptions: { tickRate: 600, snapshotEveryTicks: SNAPSHOT_EVERY },
    // Horloge du monde accélérée : un voyage de caravane tient dans un test,
    // au lieu des 30 s réelles par heure de jeu du serveur.
    worldHourMs: WORLD_HOUR_MS,
    caravanTickMs: CARAVAN_TICK_MS,
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
    // `owner` est la clé du joueur, jamais son nom (§11.2) : c'est `ownerName`
    // qui porte le libellé d'affichage.
    expect(alice.client.settlementAt(land.id)?.owner).toBe(alice.client.state.playerKey);
    expect(alice.client.settlementAt(land.id)?.ownerName).toBe("alice");

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

  it("une reconnexion avec le même jeton retrouve la même clé et ses colonies", async () => {
    const { world } = await fetchWorld(server.url);
    const land = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;

    const first = await enterWorld(world, "alice", "device-alice");
    first.client.settle(land.id);
    await waitFor("settled", () => first.settled.length === 1);
    const key = first.client.state.playerKey;
    expect(key).not.toBeNull();
    first.client.close();

    // Même appareil et même nom (la portée de l'identité est serveur + nom : le
    // nom saisi sert de profil local, pour que deux onglets d'un même navigateur
    // avec deux noms soient deux joueurs) : le jeton rangé par la première
    // connexion revient dans le `world_join` de la seconde.
    const second = await enterWorld(world, "alice", "device-alice");
    expect(second.client.state.playerKey).toBe(key);
    expect(second.client.settlementAt(land.id)?.owner).toBe(key);
  });

  it("un autre appareil, même nom mais sans jeton, ne possède pas la colonie", async () => {
    const { world } = await fetchWorld(server.url);
    const land = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;

    const alice = await enterWorld(world, "alice", "device-alice-original");
    alice.client.settle(land.id);
    await waitFor("settled", () => alice.settled.length === 1);
    const aliceKey = alice.client.state.playerKey;

    // Un appareil différent (aucun jeton connu sous cette clé de stockage),
    // même nom : le serveur ne le reconnaît pas, il crée un nouveau joueur
    // avec sa propre clé — le nom ne prouve jamais l'appartenance (§11.2).
    const impostor = await enterWorld(world, "alice", "device-impostor");
    expect(impostor.client.state.playerKey).not.toBe(aliceKey);
    const settlement = impostor.client.settlementAt(land.id);
    expect(settlement?.owner).toBe(aliceKey);
    expect(settlement?.owner).not.toBe(impostor.client.state.playerKey);
  });
});

/**
 * Deux cases terrestres reliées par la terre : la plus proche pour voyager
 * vite, la plus lointaine pour avoir le temps de faire demi-tour.
 */
function landPair(world: World, want: "nearest" | "farthest") {
  const from = world.tiles.find((tile) => movementCost(tile.biome) !== null)!;
  let best: { id: number; hours: number } | null = null;
  for (const tile of world.tiles) {
    if (tile.id === from.id || movementCost(tile.biome) === null) continue;
    const route = findRoute(world, from.id, tile.id);
    if (route === null) continue;
    const better = best === null || (want === "nearest" ? route.hours < best.hours : route.hours > best.hours);
    if (better) best = { id: tile.id, hours: route.hours };
  }
  return { from: from.id, to: best!.id, hours: best!.hours };
}

describe("caravanes contre le vrai serveur", () => {
  /**
   * Le voyage complet : former, expédier, voir la colonie d'arrivée se fonder
   * toute seule, l'ouvrir, recevoir le manifeste et le livrer.
   *
   * C'est ici que se vérifie le point qu'aucun transport factice ne dit : les
   * ordres de caravane partent désormais de la connexion **monde** (`alice`),
   * et le serveur reconnaît sa présence dans la salle de `fromTile` par repli
   * sur le nom — la connexion de salle (`departure`, `arrival`) n'a plus
   * besoin de jeton ni de `world_join` (`docs/protocol.md` §12.3, §12.7).
   */
  it("expédie une caravane, fonde la colonie d'arrivée, puis la livre", async () => {
    const { world } = await fetchWorld(server.url);
    const { from, to } = landPair(world, "nearest");
    const manifest = new Uint8Array([1, 2, 3, 4]);

    const alice = await enterWorld(world, "alice");
    alice.client.settle(from);
    await waitFor("settled", () => alice.settled.length === 1);
    const departure = await enterRoom(alice.settled[0].room, "alice");
    await waitFor("lobby", () => departure.client.state.phase === "lobby");
    departure.client.startGame(1, 16, 16);
    await waitFor("sim créé", () => departure.sim() !== null);

    // Départ depuis la connexion monde : la présence dans la salle se prouve
    // par le nom de `departure`, qui n'a pas fait de `world_join` (§12.3).
    alice.client.sendDepart({
      fromTile: from,
      toTile: to,
      manifest,
      summary: { pawns: 1, items: [[0, 20]] },
    });

    // Le globe apprend la caravane par la connexion monde, elle.
    await waitFor("caravane diffusée", () => alice.client.state.caravans.length === 1);
    const caravan = alice.client.state.caravans[0];
    // `owner` est la clé du joueur (§11.2) : directement celle de la
    // connexion monde qui a expédié. `ownerName` porte le libellé.
    expect(caravan.owner).toBe(alice.client.state.playerKey);
    expect(caravan.ownerName).toBe("alice");
    expect(caravan.fromTile).toBe(from);
    expect(caravan.route[0]).toBe(from);
    expect(caravan.route.at(-1)).toBe(to);
    expect(departure.errors).toEqual([]);
    expect(alice.errors).toEqual([]);

    // Arrivée sur une case libre : le serveur fonde la colonie au nom de son
    // propriétaire, et l'annonce à tout le monde (§12.5).
    await waitFor("colonie fondée à l'arrivée", () => alice.client.settlementAt(to) !== undefined);
    expect(alice.client.settlementAt(to)?.owner).toBe(alice.client.state.playerKey);

    // « La colonie naît quand quelqu'un l'ouvre » : le manifeste attend le
    // premier hôte en jeu, pas le `join`. L'arrivée, elle, se lit sur la
    // connexion monde d'alice — inchangée depuis le début du test.
    const arrival = await enterRoom(`tile-${to}`, "alice");
    await waitFor("lobby de la case d'arrivée", () => arrival.client.state.phase === "lobby");
    expect(alice.arrivals).toEqual([]);
    arrival.client.startGame(1, 16, 16);
    await waitFor("arrivée proposée à l'hôte", () => alice.arrivals.length === 1);
    expect(alice.arrivals[0].tile).toBe(to);
    expect(alice.arrivals[0].manifest).toEqual(manifest);

    // On injecte en lockstep (connexion de salle, qui possède le sim), **puis**
    // on confirme (connexion monde) : c'est l'ordre du protocole.
    arrival.client.issue(new Uint8Array([0x0c, ...manifest]));
    alice.client.deliverCaravan(alice.arrivals[0].id);
    await waitFor(
      "caravane livrée",
      () => alice.client.caravanById(caravan.id)?.status === "delivered",
    );
    expect(arrival.errors).toEqual([]);
    expect(alice.errors).toEqual([]);
  });

  it("rappelle une caravane avant la moitié du trajet", async () => {
    const { world } = await fetchWorld(server.url);
    // Un trajet long : le demi-tour doit tenir dans la première moitié.
    const { from, to } = landPair(world, "farthest");

    const alice = await enterWorld(world, "alice");
    alice.client.settle(from);
    await waitFor("settled", () => alice.settled.length === 1);
    const room = await enterRoom(alice.settled[0].room, "alice");
    await waitFor("lobby", () => room.client.state.phase === "lobby");
    room.client.startGame(1, 16, 16);
    await waitFor("sim créé", () => room.sim() !== null);

    // Départ depuis la connexion monde : `owner` est directement sa clé, donc
    // `cancelCaravan` plus bas (même connexion) est bien celui du propriétaire.
    alice.client.sendDepart({
      fromTile: from,
      toTile: to,
      manifest: new Uint8Array([7]),
      summary: { pawns: 2, items: [] },
    });
    await waitFor("caravane diffusée", () => alice.client.state.caravans.length === 1);
    const id = alice.client.state.caravans[0].id;

    // On laisse la caravane quitter sa case de départ : sinon le demi-tour est
    // un trajet de zéro heure, et elle « rentre » avant même d'être repartie.
    await waitFor("caravane en chemin", () => (alice.client.caravanById(id)?.progress ?? 0) > 0.1);
    expect(alice.client.caravanById(id)!.currentTile).not.toBe(from);

    // `caravan_cancel` n'exige que le monde, pas la salle : il part donc de la
    // connexion monde, comme le fait le panneau du globe.
    alice.client.cancelCaravan(id);
    await waitFor("demi-tour", () => alice.client.caravanById(id)?.status === "returning");
    // La case d'origine devient la destination, sur un itinéraire recalculé.
    expect(alice.client.caravanById(id)?.toTile).toBe(from);
    expect(alice.errors).toEqual([]);
  });
});
