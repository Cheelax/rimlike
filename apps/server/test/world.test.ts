/**
 * Tests de `WorldState`, sans réseau ni horloge réelle : les colonies, les
 * refus, les snapshots conservés et la sérialisation JSON.
 *
 * Le globe de test est à la subdivision 2 (162 cases) : instantané à générer,
 * et il contient largement de la terre et de l'océan.
 */

import { beforeEach, describe, expect, it } from "vitest";

import { MAX_FROZEN_TICKS } from "@rimlike/protocol";
import { movementCost } from "@rimlike/world";

import {
  DEFAULT_WORLD_SEED,
  WorldState,
  mixTileSeed,
  sharedWorld,
  tileFromRoomName,
  tileRoomName,
} from "../src/world.js";

const SUBDIVISIONS = 2;
const globe = sharedWorld(SUBDIVISIONS, DEFAULT_WORLD_SEED);

const landTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) !== null);
const oceanTile = globe.tiles.findIndex((tile) => movementCost(tile.biome) === null);
const otherLandTile = globe.tiles.findIndex(
  (tile, index) => index !== landTile && movementCost(tile.biome) !== null,
);

let now: number;
let state: WorldState;

beforeEach(() => {
  now = 1_757_000_000_000;
  state = new WorldState({ world: globe, now: () => now });
});

describe("globe de test", () => {
  it("a bien de la terre et de l'océan", () => {
    expect(globe.tiles).toHaveLength(162);
    expect(landTile).toBeGreaterThanOrEqual(0);
    expect(oceanTile).toBeGreaterThanOrEqual(0);
    expect(otherLandTile).toBeGreaterThanOrEqual(0);
  });
});

describe("noms de salle", () => {
  it("associe une case à sa salle et retrouve la case", () => {
    expect(tileRoomName(0)).toBe("tile-0");
    expect(tileRoomName(2561)).toBe("tile-2561");
    expect(tileFromRoomName("tile-2561")).toBe(2561);
    expect(tileFromRoomName("tile-0")).toBe(0);
  });

  it("refuse tout ce qui n'est pas exactement le nom d'une case", () => {
    // Un identifiant n'a qu'une écriture : sinon deux noms de salle
    // désigneraient la même colonie.
    for (const room of ["demo", "tile-", "tile-007", "tile-1.5", "tile--1", "tile-1e3", "TILE-1", "tile-1 "]) {
      expect(tileFromRoomName(room), room).toBeNull();
    }
  });
});

describe("graine d'une case", () => {
  it("est déterministe et tient sur 32 bits non signés", () => {
    for (const tile of [0, 1, 41, 161]) {
      const seed = mixTileSeed(DEFAULT_WORLD_SEED, tile);
      expect(seed).toBe(mixTileSeed(DEFAULT_WORLD_SEED, tile));
      expect(Number.isSafeInteger(seed)).toBe(true);
      expect(seed).toBeGreaterThanOrEqual(0);
      expect(seed).toBeLessThan(2 ** 32);
    }
  });

  it("sépare les cases voisines et les mondes voisins", () => {
    const seeds = new Set<number>();
    for (let tile = 0; tile < 162; tile += 1) {
      seeds.add(mixTileSeed(DEFAULT_WORLD_SEED, tile));
    }
    // Aucune collision sur un globe entier : deux cases voisines ne donnent
    // pas deux cartes voisines.
    expect(seeds.size).toBe(162);
    expect(mixTileSeed(1, 7)).not.toBe(mixTileSeed(2, 7));
  });
});

describe("fonder une colonie", () => {
  it("accepte une case terrestre libre et fixe salle et graine", () => {
    expect(state.canSettle(landTile)).toBe(true);
    const result = state.settle(landTile, "alice");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    expect(result.settlement).toEqual({
      tile: landTile,
      owner: "alice",
      // Aucun joueur "alice" enregistré dans cet état : `nameOf` retombe sur
      // la clé elle-même (ici le simple nom qu'on lui a passé comme owner).
      ownerName: "alice",
      room: `tile-${landTile}`,
      seed: mixTileSeed(DEFAULT_WORLD_SEED, landTile),
      createdAt: now,
    });
    expect(state.settlementCount).toBe(1);
    expect(state.canSettle(landTile)).toBe(false);
    expect(state.settlementOfRoom(`tile-${landTile}`)).toEqual(result.settlement);
  });

  it("refuse l'océan, une case prise et une case hors du globe", () => {
    expect(state.settle(oceanTile, "alice")).toEqual({ ok: false, code: "not_land" });
    expect(state.canSettle(oceanTile)).toBe(false);

    state.settle(landTile, "alice");
    expect(state.settle(landTile, "bob")).toEqual({ ok: false, code: "occupied" });

    expect(state.settle(162, "alice")).toEqual({ ok: false, code: "bad_tile" });
    expect(state.settle(-1, "alice")).toEqual({ ok: false, code: "bad_tile" });
    expect(state.settlementCount).toBe(1);
  });

  it("rend les colonies triées par case", () => {
    const [a, b] = landTile < otherLandTile ? [landTile, otherLandTile] : [otherLandTile, landTile];
    state.settle(b, "bob");
    state.settle(a, "alice");
    expect(state.list().map((s) => s.tile)).toEqual([a, b]);
  });
});

describe("abandonner une colonie", () => {
  it("libère la case et oublie son snapshot", () => {
    state.settle(landTile, "alice");
    const room = `tile-${landTile}`;
    state.saveSnapshot(room, { tick: 60, data: new Uint8Array([1, 2]), width: 64, height: 64 });
    expect(state.snapshotFor(room)).toBeDefined();

    const result = state.abandon(landTile, "alice");
    expect(result.ok).toBe(true);
    expect(state.settlementCount).toBe(0);
    expect(state.snapshotFor(room)).toBeUndefined();
    expect(state.canSettle(landTile)).toBe(true);
  });

  it("refuse un autre propriétaire, une case libre et une case inconnue", () => {
    state.settle(landTile, "alice");
    expect(state.abandon(landTile, "bob")).toEqual({ ok: false, code: "not_owner" });
    expect(state.abandon(otherLandTile, "alice")).toEqual({ ok: false, code: "not_settled" });
    expect(state.abandon(9999, "alice")).toEqual({ ok: false, code: "bad_tile" });
    expect(state.settlementCount).toBe(1);
  });
});

describe("snapshots conservés", () => {
  it("garde le dernier état connu et ignore un état plus ancien", () => {
    state.settle(landTile, "alice");
    const room = `tile-${landTile}`;
    expect(state.saveSnapshot(room, { tick: 1800, data: new Uint8Array([9]), width: 96, height: 96 })).toBe(true);
    now += 1000;
    expect(state.saveSnapshot(room, { tick: 900, data: new Uint8Array([1]), width: 96, height: 96 })).toBe(false);
    expect(state.snapshotFor(room)).toEqual({
      tick: 1800,
      data: new Uint8Array([9]),
      width: 96,
      height: 96,
      savedAt: 1_757_000_000_000,
      // Horloge de jeu neuve : le monde vient de naître.
      savedAtHours: 0,
    });

    expect(state.saveSnapshot(room, { tick: 3600, data: new Uint8Array([8]), width: 96, height: 96 })).toBe(true);
    expect(state.snapshotFor(room)?.tick).toBe(3600);
    expect(state.snapshotFor(room)?.savedAt).toBe(1_757_000_001_000);

    state.dropSnapshot(room);
    expect(state.snapshotFor(room)).toBeUndefined();
    expect(state.snapshotCount).toBe(0);
  });

  it("refuse de conserver l'état d'une case sans colonie", () => {
    // Sinon une salle encore peuplée après un `abandon` rouvrirait sa colonie
    // au prochain occupant de la case.
    const room = `tile-${landTile}`;
    expect(state.saveSnapshot(room, { tick: 60, data: new Uint8Array([1]), width: 64, height: 64 })).toBe(false);
    expect(state.snapshotCount).toBe(0);

    state.settle(landTile, "alice");
    expect(state.saveSnapshot(room, { tick: 60, data: new Uint8Array([1]), width: 64, height: 64 })).toBe(true);
    state.abandon(landTile, "alice");
    expect(state.saveSnapshot(room, { tick: 120, data: new Uint8Array([2]), width: 64, height: 64 })).toBe(false);
    expect(state.snapshotCount).toBe(0);
  });
});

describe("temps gelé d'une colonie", () => {
  /** Un monde où une heure de jeu dure une seconde réelle. */
  function clocked(startAt: number): { state: WorldState; advance: (ms: number) => void } {
    let real = startAt;
    const state = new WorldState({ world: globe, now: () => real, hourMs: 1000 });
    return { state, advance: (ms) => (real += ms) };
  }

  it("compte les ticks gelés depuis l'heure de jeu du snapshot", () => {
    const { state: world, advance } = clocked(10_000);
    world.settle(landTile, "alice");
    const room = `tile-${landTile}`;
    advance(2000); // deux heures de jeu avant le snapshot
    world.saveSnapshot(room, { tick: 1800, data: new Uint8Array([1]), width: 64, height: 64 });
    expect(world.snapshotFor(room)?.savedAtHours).toBe(2);
    // Snapshot pris à l'instant : rien à rattraper.
    expect(world.frozenTicksFor(room)).toBe(0);

    // Cinq heures de jeu sans personne sur la case : 5 × 600 ticks.
    advance(5000);
    expect(world.frozenTicksFor(room)).toBe(3000);

    // Une colonie oubliée un an ne rattrape que soixante jours.
    advance(10_000_000);
    expect(world.frozenTicksFor(room)).toBe(MAX_FROZEN_TICKS);
  });

  it("ne rattrape rien sans snapshot, ni pour un snapshot d'avant cette tranche", () => {
    const { state: world, advance } = clocked(10_000);
    world.settle(landTile, "alice");
    const room = `tile-${landTile}`;
    expect(world.frozenTicksFor(room)).toBe(0);
    expect(world.frozenTicksFor("tile-9999")).toBe(0);

    world.saveSnapshot(room, { tick: 60, data: new Uint8Array([1]), width: 64, height: 64 });
    const json = JSON.parse(JSON.stringify(world.toJSON())) as ReturnType<WorldState["toJSON"]>;
    // Un fichier écrit avant l'avance rapide : pas d'heure d'origine.
    const older = {
      ...json,
      snapshots: json.snapshots.map(({ savedAtHours: _ignored, ...rest }) => rest),
    };
    advance(50_000);

    const back = WorldState.fromJSON(older, { world: globe, now: () => now, hourMs: 1000 });
    expect(back.snapshotFor(room)?.savedAtHours).toBeUndefined();
    expect(back.frozenTicksFor(room)).toBe(0);
  });
});

describe("sérialisation JSON", () => {
  it("fait l'aller-retour, octets de snapshot compris", () => {
    state.settle(landTile, "alice");
    state.settle(otherLandTile, "bob");
    const data = new Uint8Array([0, 127, 255, 4]);
    state.saveSnapshot(`tile-${landTile}`, { tick: 1800, data, width: 128, height: 96 });

    const json = JSON.parse(JSON.stringify(state.toJSON())) as ReturnType<WorldState["toJSON"]>;
    const back = WorldState.fromJSON(json, { world: globe, now: () => now });

    expect(back.list()).toEqual(state.list());
    expect(back.snapshotFor(`tile-${landTile}`)).toEqual(state.snapshotFor(`tile-${landTile}`));
    expect(back.snapshotFor(`tile-${landTile}`)?.data).toEqual(data);
  });

  it("emporte l'horloge de jeu et les caravanes, et se relit sans elles", () => {
    let real = 5_000;
    const clocked = new WorldState({ world: globe, now: () => real, hourMs: 1000 });
    clocked.settle(landTile, "alice");
    real += 3000; // 3 h de jeu
    clocked.caravans.depart({
      owner: "alice",
      fromTile: landTile,
      toTile: otherLandTile,
      manifest: new Uint8Array([1, 2, 3]),
      summary: { pawns: 1, items: [] },
    });

    const json = JSON.parse(JSON.stringify(clocked.toJSON())) as ReturnType<WorldState["toJSON"]>;
    expect(json.clock).toEqual({ worldStartedAt: 5_000, hoursOffset: 3 });

    // Le serveur redémarre bien plus tard : l'horloge reprend à 3 h, pas plus.
    real += 10_000_000;
    const back = WorldState.fromJSON(json, { world: globe, now: () => real, hourMs: 1000 });
    expect(back.hours).toBe(3);
    expect(back.caravans.toJSON()).toEqual(json.caravans);
    // Repartie à 3 h de jeu, la caravane n'a pas avancé pendant l'arrêt.
    expect(back.caravans.list()[0]).toMatchObject({ departedAt: 3, progress: 0, status: "travelling" });

    // Un fichier antérieur aux caravanes se relit tel quel : horloge neuve.
    const { clock: _clock, caravans: _caravans, ...older } = json;
    const legacy = WorldState.fromJSON(older, { world: globe, now: () => real, hourMs: 1000 });
    expect(legacy.hours).toBe(0);
    expect(legacy.caravans.count).toBe(0);
    expect(legacy.list()).toEqual(clocked.list());
  });

  it("refuse un état enregistré sur un autre globe", () => {
    const json = { ...state.toJSON(), subdivisions: 5 };
    expect(() => WorldState.fromJSON(json, { world: globe })).toThrow(/incompatible/);
  });

  it("migre un fichier v1 (owner = nom) : un joueur neuf par nom, jeton compris", () => {
    // Un fichier écrit avant la tranche « jeton » : pas de `players`, `owner`
    // est un nom en clair dans les colonies comme dans les caravanes.
    state.settle(landTile, "alice");
    state.caravans.depart({
      owner: "alice",
      fromTile: landTile,
      toTile: otherLandTile,
      manifest: new Uint8Array([1, 2, 3]),
      summary: { pawns: 1, items: [] },
    });
    const { players: _players, ...v1 } = state.toJSON();
    expect((v1 as { players?: unknown }).players).toBeUndefined();

    const migrated = WorldState.fromJSON(v1, { world: globe, now: () => now });
    const settlement = migrated.settlementAt(landTile)!;
    // "alice" n'est plus la clé : c'est un joueur neuf, avec un jeton.
    expect(settlement.owner).not.toBe("alice");
    expect(settlement.ownerName).toBe("alice");
    const players = migrated.listPlayers();
    expect(players).toHaveLength(1);
    expect(players[0]!.name).toBe("alice");
    expect(players[0]!.key).toBe(settlement.owner);
    expect(players[0]!.token.length).toBeGreaterThan(0);
    // La caravane du même joueur pointe vers la même clé, pas un doublon.
    expect(migrated.caravans.list()[0]!.owner).toBe(settlement.owner);
    expect(migrated.caravans.list()[0]!.ownerName).toBe("alice");
    // Et ce jeton fonctionne : c'est ainsi que l'exploitant peut le lire et le
    // communiquer hors bande à l'ancien propriétaire (docs/protocol.md §11.8).
    expect(migrated.playerByToken(players[0]!.token)?.key).toBe(settlement.owner);
  });
});

describe("joueurs du monde", () => {
  it("crée une clé et un jeton uniques, reconnaît par jeton, jamais par nom", () => {
    const alice = state.createPlayer("alice");
    const bob = state.createPlayer("alice"); // même nom, un autre joueur
    expect(alice.key).not.toBe(bob.key);
    expect(alice.token).not.toBe(bob.token);
    expect(state.playerByToken(alice.token)?.key).toBe(alice.key);
    expect(state.playerByToken(bob.token)?.key).toBe(bob.key);
    expect(state.playerByToken("jeton-invente")).toBeUndefined();
    // Un jeton de la même longueur qu'un vrai, mais faux : toujours refusé.
    expect(state.playerByToken("x".repeat(alice.token.length))).toBeUndefined();
  });

  it("renomme sans changer la clé ; le nom n'est qu'un libellé", () => {
    const player = state.createPlayer("alice");
    state.renamePlayer(player.key, "alice2");
    expect(state.nameOf(player.key)).toBe("alice2");
    expect(state.playerByKey(player.key)?.name).toBe("alice2");
    // Renommer une clé inconnue ne fait rien planter.
    state.renamePlayer("clé-inconnue", "quelqu'un");
  });

  it("nameOf retombe sur la clé pour un joueur inconnu", () => {
    expect(state.nameOf("clé-jamais-vue")).toBe("clé-jamais-vue");
  });

  it("liste tous les joueurs connus, triés par ancienneté", () => {
    now = 1000;
    const alice = state.createPlayer("alice");
    now = 2000;
    const bob = state.createPlayer("bob");
    expect(state.listPlayers().map((p) => p.key)).toEqual([alice.key, bob.key]);
  });
});
