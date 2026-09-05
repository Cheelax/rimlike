/**
 * Réputation partagée (`docs/protocol.md` §14) : le serveur monde porte la
 * réputation envers les trois factions PNJ **par joueur** et l'impose à chaque
 * colonie qu'il ouvre, exactement comme il impose déjà le climat et le jour de
 * l'année.
 *
 * **Rien n'attend ici.** L'horloge du transport (`options.now`, celle qui
 * décide de la limite anti-spam) est injectée, et le délai entre deux rapports
 * est réglé par `goodwillReportMs` : un test qui veut voir la limite mordre
 * n'a pas dix vraies secondes à perdre. Le globe de test est à la
 * subdivision 2 (162 cases), comme les autres suites du monde.
 */

import { readFileSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { DEFAULT_GOODWILL, GOODWILL_MAX, GOODWILL_MIN, type GoodwillValues } from "@rimlike/protocol";
import { movementCost } from "@rimlike/world";

import { WORLD_STATE_FILE_VERSION, WorldStore, type WorldStateFile } from "../src/persistence.js";
import { startServer, type RunningServer, type ServerOptions } from "../src/server.js";
import { DEFAULT_WORLD_SEED, sharedWorld } from "../src/world.js";
import { TestClient, bytes } from "./helpers.js";

const SUBDIVISIONS = 2;
const globe = sharedWorld(SUBDIVISIONS, DEFAULT_WORLD_SEED);
/** Trois cases terrestres distinctes : une colonie par test, sans se marcher dessus. */
const [tileA, tileB, tileC] = globe.tiles
  .filter((tile) => movementCost(tile.biome) !== null)
  .slice(0, 3)
  .map((tile) => tile.id) as [number, number, number];

/** Une réputation reconnaissable, différente du défaut sur les trois factions. */
const REPORTED: GoodwillValues = [-70, 15, 55];

const servers: RunningServer[] = [];
const clients: TestClient[] = [];
const dirs: string[] = [];

/**
 * Un serveur dont l'horloge du transport est pilotée par le test : c'est elle
 * que consulte la limite anti-spam des rapports de réputation.
 */
interface Driven {
  readonly server: RunningServer;
  /** Avance l'horloge murale de `ms` millisecondes. */
  advance(ms: number): void;
}

async function startWorld(extra: Partial<ServerOptions> = {}): Promise<Driven> {
  const clock = { nowMs: 1_757_000_000_000 };
  const server = await startServer({
    port: 0,
    log: () => {},
    worldSubdivisions: SUBDIVISIONS,
    now: () => clock.nowMs,
    // Salle rapide : 600 ticks par bundle toutes les 10 ms, de quoi atteindre
    // un snapshot de conservation (1800 ticks) en quelques dizaines de ms.
    roomOptions: { tickRate: 60_000, bundleTicks: 600 },
    ...extra,
  });
  servers.push(server);
  return {
    server,
    advance: (ms: number) => {
      clock.nowMs += ms;
    },
  };
}

async function connect(server: RunningServer): Promise<TestClient> {
  const client = await TestClient.connect(server.url);
  clients.push(client);
  return client;
}

/** Un client déjà entré dans le monde. `token` : reconnexion sous un jeton connu. */
async function joinWorld(name: string, server: RunningServer, token?: string): Promise<TestClient> {
  const client = await connect(server);
  client.send(token === undefined ? { type: "world_join", name } : { type: "world_join", name, token });
  await client.next("world_welcome");
  return client;
}

/** La clé de joueur reçue dans le premier `world_welcome` d'un client. */
function keyOf(client: TestClient): string {
  return client.ofType("world_welcome")[0]!.playerKey;
}

/**
 * Un joueur du monde : sa connexion « globe », sa clé et son jeton. Comme un
 * vrai client, il ouvre **une connexion par colonie** — une connexion vaut une
 * salle (`docs/protocol.md` §11.3), et le jeton lui permet de se faire
 * reconnaître comme le même joueur sur chacune.
 */
interface Player {
  readonly world: TestClient;
  readonly key: string;
  readonly token: string;
}

async function newPlayer(name: string, server: RunningServer): Promise<Player> {
  const world = await joinWorld(name, server);
  const welcome = world.ofType("world_welcome")[0]!;
  return { world, key: welcome.playerKey, token: welcome.token! };
}

/**
 * Fonde une colonie depuis la connexion monde du joueur, l'ouvre depuis une
 * connexion de salle dédiée (reconnue par son jeton), la démarre, et renvoie
 * le `start` diffusé.
 */
async function settleAndStart(server: RunningServer, player: Player, tile: number, name: string) {
  player.world.send({ type: "settle", tile });
  const settled = await player.world.next("settled");
  const client = await joinWorld(name, server, player.token);
  client.send({ type: "join", room: settled.room, name });
  await client.next("welcome");
  client.send({ type: "start", seed: 1, width: 32, height: 32 });
  const start = await client.next("start");
  return { settled, start, client };
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

afterEach(async () => {
  for (const client of clients) {
    client.close();
  }
  clients.length = 0;
  for (const server of servers) {
    await server.close();
  }
  servers.length = 0;
  for (const dir of dirs) {
    await rm(dir, { recursive: true, force: true });
  }
  dirs.length = 0;
});

describe("imposition à l'ouverture d'une colonie", () => {
  it("a_new_player_starts_with_default_goodwill", async () => {
    const world = await startWorld();
    const alice = await newPlayer("alice", world.server);
    const { start } = await settleAndStart(world.server, alice, tileA, "alice");

    // Un joueur que le monde n'a jamais vu agir repart de la réputation de
    // départ du sim (`factions::START_GOODWILL`), comme une partie solo.
    expect(start.goodwill).toEqual(DEFAULT_GOODWILL);
    expect(world.server.world.goodwillOf(alice.key)).toEqual(DEFAULT_GOODWILL);
  });

  it("host_report_is_stored_and_reimposed_on_next_colony", async () => {
    const world = await startWorld();
    const alice = await newPlayer("alice", world.server);
    const first = await settleAndStart(world.server, alice, tileA, "alice");

    // L'hôte remonte ce que son sim a fini par porter : un raid mené par le
    // Clan, un troc avec la Guilde…
    first.client.send({ type: "goodwill_report", values: REPORTED });
    await until("réputation d'alice enregistrée", () => world.server.world.goodwillOf(alice.key)[0] === REPORTED[0]);
    expect(world.server.world.goodwillOf(alice.key)).toEqual(REPORTED);

    // La colonie suivante du **même** joueur en hérite : c'est tout l'objet de
    // cette tranche, la réputation suit le joueur sur le globe.
    const second = await settleAndStart(world.server, alice, tileB, "alice");
    expect(second.start.goodwill).toEqual(REPORTED);

    // Un autre joueur, lui, garde le défaut : les rancunes ne se partagent pas
    // entre joueurs, seulement entre les colonies d'un même joueur.
    const bob = await newPlayer("bob", world.server);
    const third = await settleAndStart(world.server, bob, tileC, "bob");
    expect(third.start.goodwill).toEqual(DEFAULT_GOODWILL);
    expect(world.server.world.goodwillOf(bob.key)).toEqual(DEFAULT_GOODWILL);
  });

  it("frozen_colony_reopen_gets_player_goodwill", async () => {
    const world = await startWorld();
    const alice = await newPlayer("alice", world.server);
    const frozen = await settleAndStart(world.server, alice, tileA, "alice");

    // La colonie produit un snapshot de conservation, puis se vide.
    await frozen.client.next("request_snapshot");
    const tick = frozen.client.ofType("bundle").at(-1)!.to + 1;
    frozen.client.send({ type: "snapshot", tick, data: bytes(1, 2, 3) });
    await until("snapshot conservé", () => world.server.world.snapshotFor(frozen.settled.room) !== undefined);

    // Pendant ce temps, alice joue **ailleurs** : sa réputation bouge, et
    // c'est celle-là qui doit primer au réveil de la colonie gelée — le sim
    // conservé, lui, porte encore la valeur d'avant.
    const elsewhere = await settleAndStart(world.server, alice, tileB, "alice");
    elsewhere.client.send({ type: "goodwill_report", values: REPORTED });
    await until("réputation d'alice enregistrée", () => world.server.world.goodwillOf(alice.key)[0] === REPORTED[0]);

    frozen.client.close();
    elsewhere.client.close();
    alice.world.close();
    await until("salles détruites", () => world.server.roomCount === 0);

    // Réouverture : aucun `start` n'est diffusé, la réputation voyage donc
    // dans le `snapshot`, à côté du temps gelé.
    const carol = await newPlayer("carol", world.server);
    carol.world.send({ type: "visit", tile: tileA });
    const destination = await carol.world.next("settled");
    const opener = await joinWorld("carol", world.server, carol.token);
    opener.send({ type: "join", room: destination.room, name: "carol" });
    // `nth` et non `next` : sur une réouverture, `welcome` et `snapshot`
    // partent dans la même rafale — `next` compterait à partir de l'appel et
    // attendrait un second snapshot qui ne viendra jamais.
    expect((await opener.nth("welcome")).isHost).toBe(true);
    const snapshot = await opener.nth("snapshot");
    expect(snapshot.tick).toBe(tick);
    expect(snapshot.data).toEqual(bytes(1, 2, 3));
    // La valeur du **propriétaire** (alice), pas celle du visiteur qui ouvre.
    expect(snapshot.goodwill).toEqual(REPORTED);
    expect(world.server.world.goodwillOf(carol.key)).toEqual(DEFAULT_GOODWILL);
  });
});

describe("qui peut remonter, et à quel rythme", () => {
  it("guest_reports_are_refused", async () => {
    const world = await startWorld();
    const alice = await newPlayer("alice", world.server);
    const { settled } = await settleAndStart(world.server, alice, tileA, "alice");

    // bob rejoint la salle d'alice en invité : il voit la même colonie, mais
    // ce n'est pas sa réputation.
    const bob = await newPlayer("bob", world.server);
    bob.world.send({ type: "visit", tile: tileA });
    await bob.world.next("settled");
    const guest = await joinWorld("bob", world.server, bob.token);
    guest.send({ type: "join", room: settled.room, name: "bob" });
    expect((await guest.next("welcome")).isHost).toBe(false);

    guest.send({ type: "goodwill_report", values: REPORTED });
    expect((await guest.next("error")).code).toBe("not_host");
    expect(world.server.world.goodwillOf(bob.key)).toEqual(DEFAULT_GOODWILL);
    expect(world.server.world.goodwillOf(alice.key)).toEqual(DEFAULT_GOODWILL);

    // Hors de toute salle, c'est le même refus : la salle du rapport est
    // celle de la connexion, il n'y en a pas ici.
    const carol = await newPlayer("carol", world.server);
    carol.world.send({ type: "goodwill_report", values: REPORTED });
    expect((await carol.world.next("error")).code).toBe("not_host");

    // Et dans une salle **simple** non plus : elle n'a pas de case, donc pas
    // de colonie dont la réputation voyagerait.
    const dave = await joinWorld("dave", world.server);
    dave.send({ type: "join", room: "demo", name: "dave" });
    await dave.next("welcome");
    dave.send({ type: "start", seed: 5, width: 32, height: 32 });
    await dave.next("start");
    dave.send({ type: "goodwill_report", values: REPORTED });
    expect((await dave.next("error")).code).toBe("not_host");
    expect(world.server.world.goodwillOf(keyOf(dave))).toEqual(DEFAULT_GOODWILL);
  });

  it("refuse un rapport dont l'auteur n'est pas un joueur du monde", async () => {
    const world = await startWorld();
    const alice = await newPlayer("alice", world.server);
    const opened = await settleAndStart(world.server, alice, tileA, "alice");

    // Une connexion de salle pure, sans identité de monde et sous un nom que
    // personne ne porte dans le monde : le serveur ne saurait à qui créditer
    // la réputation, même une fois cette connexion devenue hôte.
    const anonymous = await connect(world.server);
    anonymous.send({ type: "join", room: opened.settled.room, name: "zoé" });
    await anonymous.next("welcome");
    opened.client.close();
    await until("zoé est devenue hôte", () => world.server.room(opened.settled.room)?.host === 2);

    anonymous.send({ type: "goodwill_report", values: REPORTED });
    expect((await anonymous.next("world_error")).code).toBe("not_in_world");
    expect(world.server.world.goodwillOf(alice.key)).toEqual(DEFAULT_GOODWILL);
  });

  it("values_are_clamped", async () => {
    const world = await startWorld();
    const alice = await newPlayer("alice", world.server);
    const first = await settleAndStart(world.server, alice, tileA, "alice");

    // Un client qui remonterait des valeurs aberrantes n'est pas refusé : le
    // serveur les rogne, puisque c'est lui qui les réimposera.
    first.client.send({ type: "goodwill_report", values: [-4000, 4000, 7] });
    await until("réputation rognée", () => world.server.world.goodwillOf(alice.key)[0] === GOODWILL_MIN);
    expect(world.server.world.goodwillOf(alice.key)).toEqual([GOODWILL_MIN, GOODWILL_MAX, 7]);

    // Et ce sont les valeurs rognées qui repartent, jamais l'original.
    const second = await settleAndStart(world.server, alice, tileB, "alice");
    expect(second.start.goodwill).toEqual([GOODWILL_MIN, GOODWILL_MAX, 7]);
  });

  it("reports_are_rate_limited", async () => {
    // Une limite de 10 s comme en production, mais sur une horloge pilotée :
    // le test ne dort jamais.
    const world = await startWorld({ goodwillReportMs: 10_000 });
    const alice = await newPlayer("alice", world.server);
    const colony = await settleAndStart(world.server, alice, tileA, "alice");

    colony.client.send({ type: "goodwill_report", values: REPORTED });
    await until("premier rapport accepté", () => world.server.world.goodwillOf(alice.key)[0] === REPORTED[0]);

    // Trop tôt : ignoré **en silence**, aucune erreur, aucun changement.
    world.advance(9_999);
    colony.client.send({ type: "goodwill_report", values: [0, 0, 0] });
    // Un aller-retour pour laisser au serveur le temps de traiter (et de ne
    // rien faire) : le `pong` revient forcément après le rapport.
    colony.client.send({ type: "ping" });
    await colony.client.next("pong");
    expect(world.server.world.goodwillOf(alice.key)).toEqual(REPORTED);
    expect(colony.client.ofType("error")).toEqual([]);
    expect(colony.client.ofType("world_error")).toEqual([]);

    // Le délai écoulé, le rapport suivant passe : c'est le dernier qui gagne.
    world.advance(1);
    colony.client.send({ type: "goodwill_report", values: [0, 0, 0] });
    await until("second rapport accepté", () => world.server.world.goodwillOf(alice.key)[0] === 0);
    expect(world.server.world.goodwillOf(alice.key)).toEqual([0, 0, 0]);
  });

  it("compte la limite par salle, pas par serveur", async () => {
    const world = await startWorld({ goodwillReportMs: 10_000 });
    const alice = await newPlayer("alice", world.server);
    const bob = await newPlayer("bob", world.server);
    const chezAlice = await settleAndStart(world.server, alice, tileA, "alice");
    const chezBob = await settleAndStart(world.server, bob, tileB, "bob");

    chezAlice.client.send({ type: "goodwill_report", values: REPORTED });
    await until("rapport d'alice accepté", () => world.server.world.goodwillOf(alice.key)[0] === REPORTED[0]);
    // Sans avancer l'horloge : la salle de bob a son propre compteur.
    chezBob.client.send({ type: "goodwill_report", values: [30, 30, 30] });
    await until("rapport de bob accepté", () => world.server.world.goodwillOf(bob.key)[0] === 30);
  });
});

describe("persistance", () => {
  async function tempDir(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "rimlike-goodwill-"));
    dirs.push(dir);
    return dir;
  }

  it("goodwill_survives_persistence", async () => {
    const dir = await tempDir();
    const file = join(dir, "world-state.json");

    const first = await startWorld({ worldStateFile: file, saveDebounceMs: 20 });
    const alice = await newPlayer("alice", first.server);
    const { key, token } = alice;
    const colony = await settleAndStart(first.server, alice, tileA, "alice");
    colony.client.send({ type: "goodwill_report", values: REPORTED });
    await until("réputation enregistrée", () => first.server.world.goodwillOf(key)[0] === REPORTED[0]);
    // La sauvegarde est différée : on attend que le fichier porte bien la
    // réputation, pas seulement qu'une écriture ait eu lieu (la fondation en
    // a déclenché une avant le rapport).
    await until("réputation dans le fichier", () => savedGoodwill(file, key) !== undefined);

    const onDisk = JSON.parse(await readFile(file, "utf8")) as WorldStateFile;
    expect(onDisk.version).toBe(WORLD_STATE_FILE_VERSION);
    expect(onDisk.state.goodwill?.[key]).toEqual([...REPORTED]);

    await first.server.close();
    servers.length = 0;

    // Redémarrage sur le même fichier : alice se reconnecte avec son jeton et
    // retrouve sa réputation — y compris sur une colonie neuve.
    const second = await startWorld({ worldStateFile: file, saveDebounceMs: 20 });
    expect(second.server.world.goodwillOf(key)).toEqual(REPORTED);
    const back = await joinWorld("alice", second.server, token);
    expect(keyOf(back)).toBe(key);
    const { start } = await settleAndStart(second.server, { world: back, key, token }, tileB, "alice");
    expect(start.goodwill).toEqual(REPORTED);
  });

  it("relit un fichier v3, écrit avant la réputation partagée", async () => {
    const dir = await tempDir();
    const file = join(dir, "world-state.json");
    // Un fichier tel qu'écrit avant cette tranche : identité par jeton et
    // marchands déjà là, mais pas de `state.goodwill`.
    const v3 = {
      version: 3,
      worldSeed: DEFAULT_WORLD_SEED,
      subdivisions: SUBDIVISIONS,
      savedAt: 1_700_000_000_000,
      state: {
        seed: DEFAULT_WORLD_SEED,
        subdivisions: SUBDIVISIONS,
        settlements: [
          { tile: tileA, owner: "key-alice", room: `tile-${tileA}`, seed: 42, createdAt: 1_700_000_000_000 },
        ],
        snapshots: [],
        players: [{ key: "key-alice", name: "alice", token: "tok-alice", createdAt: 1_700_000_000_000 }],
      },
    };
    await writeFile(file, JSON.stringify(v3), "utf8");

    const store = new WorldStore({ file, worldSeed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, log: () => {} });
    const result = await store.load(globe);
    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") {
      return;
    }
    // La colonie est intacte, et alice repart de la réputation par défaut :
    // c'est déjà ce que chaque colonie faisait dans son coin, rien n'est perdu.
    expect(result.state.settlementAt(tileA)?.ownerName).toBe("alice");
    expect(result.state.goodwillOf("key-alice")).toEqual(DEFAULT_GOODWILL);
    // Et un joueur inconnu du fichier n'est pas un cas d'erreur.
    expect(result.state.goodwillOf("key-inconnue")).toEqual(DEFAULT_GOODWILL);

    // La prochaine sauvegarde réécrit le fichier dans la version courante.
    result.state.setGoodwill("key-alice", REPORTED);
    await store.save(result.state);
    const onDisk = JSON.parse(await readFile(file, "utf8")) as WorldStateFile;
    expect(onDisk.version).toBe(WORLD_STATE_FILE_VERSION);
    expect(onDisk.state.goodwill).toEqual({ "key-alice": [...REPORTED] });
  });

  it("ignore une entrée de réputation mal formée sans mettre le fichier en quarantaine", async () => {
    const dir = await tempDir();
    const file = join(dir, "world-state.json");
    const trafiqué = {
      version: WORLD_STATE_FILE_VERSION,
      worldSeed: DEFAULT_WORLD_SEED,
      subdivisions: SUBDIVISIONS,
      savedAt: 1_700_000_000_000,
      state: {
        seed: DEFAULT_WORLD_SEED,
        subdivisions: SUBDIVISIONS,
        settlements: [],
        snapshots: [],
        players: [{ key: "key-alice", name: "alice", token: "tok-alice", createdAt: 1_700_000_000_000 }],
        goodwill: {
          "key-alice": [-4000, 4000, 3],
          "key-bob": [1, 2],
          "key-carol": "hostile",
          "key-dave": [1, 2, Number.NaN],
        },
      },
    };
    await writeFile(file, JSON.stringify(trafiqué), "utf8");

    const store = new WorldStore({ file, worldSeed: DEFAULT_WORLD_SEED, subdivisions: SUBDIVISIONS, log: () => {} });
    const result = await store.load(globe);
    // Rien n'est levé : un triplet abîmé n'emporte pas les colonies du fichier.
    expect(result.kind).toBe("loaded");
    if (result.kind !== "loaded") {
      return;
    }
    // Rogné pour l'entrée valide, défaut pour les trois autres. `NaN` sort du
    // JSON en `null`, donc l'entrée est écartée avant même `clampGoodwill`.
    expect(result.state.goodwillOf("key-alice")).toEqual([GOODWILL_MIN, GOODWILL_MAX, 3]);
    expect(result.state.goodwillOf("key-bob")).toEqual(DEFAULT_GOODWILL);
    expect(result.state.goodwillOf("key-carol")).toEqual(DEFAULT_GOODWILL);
    expect(result.state.goodwillOf("key-dave")).toEqual(DEFAULT_GOODWILL);
  });
});

/**
 * La réputation d'un joueur telle qu'écrite sur disque, `undefined` si le
 * fichier ne la porte pas encore. Lecture synchrone volontairement laxiste :
 * elle sert de prédicat d'attente, pas d'assertion.
 */
function savedGoodwill(file: string, key: string): readonly number[] | undefined {
  try {
    const parsed = JSON.parse(readFileSync(file, "utf8")) as WorldStateFile;
    return parsed.state.goodwill?.[key];
  } catch {
    return undefined;
  }
}
