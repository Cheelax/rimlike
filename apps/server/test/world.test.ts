/**
 * Tests de `WorldState`, sans réseau ni horloge réelle : les colonies, les
 * refus, les snapshots conservés et la sérialisation JSON.
 *
 * Le globe de test est à la subdivision 2 (162 cases) : instantané à générer,
 * et il contient largement de la terre et de l'océan.
 */

import { beforeEach, describe, expect, it } from "vitest";

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
});
