/**
 * Le protocole entre le thread principal et le Worker de simulation.
 *
 * Deux choses à garantir : chaque message se reconnaît à son `type` (les deux
 * côtés font un `switch` exhaustif dessus), et les tampons arrivent bien
 * **copiés** de l'autre côté — le clone structuré du `postMessage` est ce qui
 * sépare la mémoire WASM du Worker du rendu du thread principal.
 */

import { describe, expect, it } from "vitest";

import type { LockstepState } from "../src/net/LockstepClient";
import {
  transferablesOf,
  type FireMessage,
  type FrameMessage,
  type IndoorMessage,
  type MainToWorker,
  type MapMessage,
  type OverlaysMessage,
  type WorkerToMain,
} from "../src/worker/protocol";

const netState: LockstepState = Object.freeze({
  phase: "running",
  room: "demo",
  playerId: 1,
  hostId: 1,
  isHost: true,
  players: Object.freeze([{ id: 1, name: "alice" }]),
  tick: 42,
  lag: 3,
  ready: true,
  seed: 7,
  width: 32,
  height: 32,
  desync: null,
  lastError: null,
  frozenTicks: 0,
  climate: null,
  dayOfYear: null,
  outliers: Object.freeze([]),
  isOutlier: false,
  roomDesynced: false,
  lastResyncTick: null,
});

function frame(): FrameMessage {
  return {
    type: "frame",
    tick: 12,
    timeOfDay: 120,
    ticksPerDay: 14400,
    weather: 2,
    temperature: 120,
    season: 1,
    dayOfYear: 20,
    yearDays: 60,
    hash: "deadbeef",
    pawns: new Int32Array([1, 256, 512, 0, 800, 900, 700, 0, -1, 0, 0, 1000]),
    items: new Int32Array([1, 0, 5, 2, 2]),
    blueprints: new Int32Array([1, 0, 0, 3, 4, 0, 5, 0]),
    events: new Int32Array([1, 10, 0, 2]),
    priorities: new Int32Array([1, 3, 3, 3, 3, 3, 3]),
    skills: new Int32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    health: new Int32Array([1, 1000, 100, 0]),
    animals: new Int32Array([2, 0, 1]),
    names: { 1: "Alice" },
    stored: new Uint32Array([9, 8, 7, 6, 5, 4, 0, 0, 0]),
    craftTargets: new Uint32Array([0, 0, 0, 0, 0, 0, 3, 0, 1]),
    weapons: new Int32Array([1, 6]),
    apparel: new Int32Array([1, 15]),
    traits: new Int32Array([1, 0, 2]),
    departures: 1,
    lag: 3,
    tps: 60,
    difficulty: 2,
    wealth: 1240,
    traderPresent: 9,
    traderLeavesIn: 3600,
    traderOffers: new Int32Array([6, 3, 40, 12, 10, 5]),
    buyPrices: new Uint32Array([3, 4, 2, 2, 6, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]),
    foodFreshness: new Int32Array([-1, -1, 800, -1, -1, -1, -1, -1, -1, -1, -1, -1, 400, -1, -1, -1]),
    researchState: new Uint32Array([255, 0, 2000, 0, 0, 2500, 0, 0, 2500, 0, 0, 3000, 0, 0, 3000, 0]),
    fireCount: 2,
    livestockCount: 1,
  };
}

function map(): MapMessage {
  return {
    type: "map",
    width: 2,
    height: 2,
    mapVersion: 5,
    tiles: new Uint8Array([3, 3, 4, 1]),
    features: new Uint8Array([0, 1, 0, 2]),
  };
}

function overlays(): OverlaysMessage {
  return {
    type: "overlays",
    overlayVersion: 9,
    zones: new Uint8Array([0, 1, 1, 0]),
    designations: new Uint8Array([0, 0, 2, 0]),
  };
}

function indoorMessage(): IndoorMessage {
  return {
    type: "indoor",
    indoorVersion: 4,
    indoor: new Uint8Array([0, 1, 1, 0]),
  };
}

function fireMessage(): FireMessage {
  return {
    type: "fire",
    fireVersion: 6,
    fire: new Uint8Array([0, 2, 0, 1]),
  };
}

const fromMain: MainToWorker[] = [
  { type: "init", mode: "solo", seed: 42, width: 128, height: 128, difficulty: 2 },
  { type: "init", mode: "multi", server: "ws://localhost:8787", room: "demo", name: "alice" },
  { type: "issue", bytes: new Uint8Array([1, 2]) },
  { type: "setPaused", paused: true },
  { type: "setSpeed", speed: 3 },
  { type: "startGame", seed: 7, width: 32, height: 32, difficulty: 3 },
  { type: "save" },
  { type: "load", bytes: new Uint8Array([9]) },
  { type: "debug", id: 1, method: "step", args: [5] },
];

const toMain: WorkerToMain[] = [
  map(),
  overlays(),
  indoorMessage(),
  fireMessage(),
  frame(),
  { type: "net", state: netState },
  { type: "saved", bytes: new Uint8Array([4, 5, 6]) },
  { type: "loaded" },
  { type: "error", message: "boum" },
  { type: "debugResult", id: 1, value: 3 },
];

describe("protocole du Worker de simulation", () => {
  it("discrimine chaque message par son `type`", () => {
    for (const message of [...fromMain, ...toMain]) {
      expect(typeof message.type).toBe("string");
    }
    expect(new Set(fromMain.map((m) => m.type))).toEqual(
      new Set(["init", "issue", "setPaused", "setSpeed", "startGame", "save", "load", "debug"]),
    );
    expect(new Set(toMain.map((m) => m.type))).toEqual(
      new Set(["map", "overlays", "indoor", "fire", "frame", "net", "saved", "loaded", "error", "debugResult"]),
    );
  });

  it("fait arriver les tampons d'un `frame` copiés, jamais partagés", () => {
    const original = frame();
    const clone = structuredClone(original);
    for (const key of [
      "pawns", "items", "blueprints", "events", "priorities", "skills", "health", "animals", "stored",
      "craftTargets", "weapons", "apparel", "traits", "traderOffers", "buyPrices", "foodFreshness",
      "researchState",
    ] as const) {
      expect(clone[key]).toEqual(original[key]);
      expect(clone[key]).not.toBe(original[key]);
      expect(clone[key].buffer).not.toBe(original[key].buffer);
    }
    // Le clone vit sa vie : muter la source ne le touche pas.
    original.pawns[0] = 999;
    expect(clone.pawns[0]).toBe(1);
    expect(clone.hash).toBe("deadbeef");
    expect(clone.tps).toBe(60);
    // Climat, saisons et température : de simples nombres, clonés tels quels.
    expect(clone.temperature).toBe(120);
    expect(clone.season).toBe(1);
    expect(clone.dayOfYear).toBe(20);
    expect(clone.yearDays).toBe(60);
    // Dose de menace et richesse (`sim-wasm::difficulty`/`wealth`) : de simples
    // nombres, clonés tels quels, comme la température ou la saison.
    expect(clone.difficulty).toBe(2);
    expect(clone.wealth).toBe(1240);
    // Marchand (`sim-wasm::trader_present`/`trader_leaves_in`) : mêmes simples
    // nombres ; l'étal et les prix d'achat sont des tampons, comme le reste.
    expect(clone.traderPresent).toBe(9);
    expect(clone.traderLeavesIn).toBe(3600);
    expect(Array.from(clone.traderOffers)).toEqual([6, 3, 40, 12, 10, 5]);
    expect(clone.traderOffers).not.toBe(original.traderOffers);
    // `names` est un simple objet : cloné en donnée, pas en tampon.
    expect(clone.names).toEqual({ 1: "Alice" });
    expect(clone.names).not.toBe(original.names);
    // Cases en feu (`sim-wasm::fire_count`) : un simple nombre, comme `wealth`
    // ou `difficulty` — la couche elle-même voyage à part (`FireMessage`).
    expect(clone.fireCount).toBe(2);
    // Bêtes de la colonie (`sim-wasm::livestock_count`) : même contrat que
    // `fireCount`, un simple nombre cloné tel quel.
    expect(clone.livestockCount).toBe(1);
  });

  it("fait arriver la carte, les calques et l'intérieur copiés", () => {
    const clonedMap = structuredClone(map());
    expect(Array.from(clonedMap.tiles)).toEqual([3, 3, 4, 1]);
    expect(Array.from(clonedMap.features)).toEqual([0, 1, 0, 2]);
    const clonedOverlays = structuredClone(overlays());
    expect(Array.from(clonedOverlays.zones)).toEqual([0, 1, 1, 0]);
    expect(Array.from(clonedOverlays.designations)).toEqual([0, 0, 2, 0]);
    const original = indoorMessage();
    const clonedIndoor = structuredClone(original);
    expect(clonedIndoor.indoorVersion).toBe(4);
    expect(Array.from(clonedIndoor.indoor)).toEqual([0, 1, 1, 0]);
    expect(clonedIndoor.indoor).not.toBe(original.indoor);
  });

  it("fait arriver la couche de feu copiée", () => {
    const original = fireMessage();
    const clone = structuredClone(original);
    expect(clone.fireVersion).toBe(6);
    expect(Array.from(clone.fire)).toEqual([0, 2, 0, 1]);
    expect(clone.fire).not.toBe(original.fire);
    expect(clone.fire.buffer).not.toBe(original.fire.buffer);
  });

  it("clone l'état réseau, gelé côté lockstep, en simple donnée", () => {
    const clone = structuredClone({ type: "net", state: netState } satisfies WorkerToMain);
    expect(clone.state.room).toBe("demo");
    expect(clone.state.players[0]?.name).toBe("alice");
    expect(clone.state.lag).toBe(3);
  });

  it("annonce des tampons distincts, transférables sans copie", () => {
    const original = frame();
    const transfer = transferablesOf(original);
    // Dix-sept tampons, tous différents : un tampon transféré deux fois lèverait.
    expect(transfer.length).toBe(17);
    expect(new Set(transfer).size).toBe(17);

    const clone = structuredClone(original, { transfer });
    expect(Array.from(clone.stored)).toEqual([9, 8, 7, 6, 5, 4, 0, 0, 0]);
    expect(clone.pawns[11]).toBe(1000);
    // Détachés côté émetteur : c'est le prix du transfert, et il est sans
    // conséquence puisque le Worker rebâtit ses tampons à chaque frame.
    expect(original.pawns.byteLength).toBe(0);
  });

  it("n'annonce que les tampons qui existent", () => {
    expect(transferablesOf(map()).length).toBe(2);
    expect(transferablesOf(overlays()).length).toBe(2);
    expect(transferablesOf(indoorMessage()).length).toBe(1);
    expect(transferablesOf(fireMessage()).length).toBe(1);
    expect(transferablesOf({ type: "saved", bytes: new Uint8Array([1]) }).length).toBe(1);
    expect(transferablesOf({ type: "net", state: netState })).toEqual([]);
    expect(transferablesOf({ type: "loaded" })).toEqual([]);
    expect(transferablesOf({ type: "error", message: "boum" })).toEqual([]);
    expect(transferablesOf({ type: "debugResult", id: 1, value: null })).toEqual([]);
  });
});
