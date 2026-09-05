import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  frozenTicksForHours,
  MAX_FROZEN_TICKS,
  decodeClientMessage,
  decodeMessage,
  decodeServerMessage,
  encodeMessage,
  isCompatibleProtocol,
  NO_PLAYER,
  PROTOCOL_VERSION,
  TICKS_PER_DAY,
  TICKS_PER_HOUR,
  validateClientMessage,
  validateServerMessage,
  WORLD_ERROR_CODES,
  type Caravan,
  type ClientMessage,
  type ServerMessage,
  type Settlement,
} from "../src/index.js";

/** Une colonie de référence, réutilisée par plusieurs cas. */
const settlement: Settlement = {
  tile: 1234,
  owner: "alice",
  room: "tile-1234",
  seed: 3_141_592_653,
  createdAt: 1_757_000_000_000,
};

/** Une caravane de référence, en vol à mi-parcours. */
const caravan: Caravan = {
  id: "c1",
  owner: "alice",
  fromTile: 12,
  toTile: 40,
  route: [12, 23, 31, 40],
  departedAt: 10,
  arrivesAt: 34.5,
  progress: 0.5,
  currentTile: 23,
  summary: { pawns: 3, items: [[0, 40], [4, 12]] },
  status: "travelling",
};

describe("base64", () => {
  it("fait l'aller-retour sur toutes les longueurs de reste", () => {
    for (let n = 0; n < 40; n += 1) {
      const bytes = new Uint8Array(n);
      for (let i = 0; i < n; i += 1) {
        bytes[i] = (i * 37 + 11) & 255;
      }
      const text = bytesToBase64(bytes);
      expect(text.length % 4).toBe(0);
      expect(base64ToBytes(text)).toEqual(bytes);
    }
  });

  it("couvre les 256 valeurs d'octet", () => {
    const bytes = new Uint8Array(256);
    for (let i = 0; i < 256; i += 1) {
      bytes[i] = i;
    }
    expect(base64ToBytes(bytesToBase64(bytes))).toEqual(bytes);
  });

  it("refuse le base64 mal formé", () => {
    expect(base64ToBytes("AQI")).toBeNull();
    expect(base64ToBytes("!!!!")).toBeNull();
    expect(base64ToBytes("====")).toBeNull();
    expect(base64ToBytes("A===")).toBeNull();
  });
});

describe("encodeMessage / decodeMessage", () => {
  const clientMessages: ClientMessage[] = [
    { type: "join", room: "demo", name: "alice" },
    { type: "join", room: "demo", name: "bob", protocol: PROTOCOL_VERSION },
    { type: "start", seed: 42, width: 128, height: 128 },
    { type: "command", payload: new Uint8Array([1, 0, 255, 7, 200]) },
    { type: "hash", tick: 300, hash: "00ff00ff00ff00ff" },
    { type: "snapshot", tick: 1234, data: new Uint8Array([9, 8, 7, 6, 5]) },
    { type: "snapshot", tick: 1234, data: new Uint8Array([0]), forPlayer: 3 },
    { type: "ping" },
    { type: "pong" },
    { type: "world_join", name: "alice" },
    { type: "world_join", name: "bob", protocol: PROTOCOL_VERSION },
    { type: "settle", tile: 1234 },
    { type: "visit", tile: 0 },
    { type: "abandon", tile: 10_241 },
    { type: "world_leave" },
    {
      type: "caravan_depart",
      fromTile: 12,
      toTile: 40,
      manifest: new Uint8Array([1, 0, 255, 42]),
      summary: { pawns: 3, items: [[0, 40], [4, 12]] },
    },
    {
      type: "caravan_depart",
      fromTile: 0,
      toTile: 1,
      manifest: new Uint8Array([7]),
      summary: { pawns: 0, items: [] },
    },
    { type: "caravan_cancel", id: "c1" },
    { type: "caravan_delivered", id: "c1" },
  ];

  const serverMessages: ServerMessage[] = [
    {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      playerId: 1,
      isHost: true,
      players: [{ id: 1, name: "alice" }],
      state: "lobby",
      tick: 0,
    },
    {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      playerId: 2,
      isHost: false,
      players: [
        { id: 1, name: "alice" },
        { id: 2, name: "bob" },
      ],
      state: "running",
      tick: 90,
      seed: 7,
      width: 128,
      height: 96,
    },
    { type: "players", players: [{ id: 1, name: "alice" }], hostId: 1 },
    { type: "players", players: [], hostId: null },
    { type: "start", seed: 7, width: 128, height: 128, tick: 0 },
    { type: "bundle", from: 0, to: 2, ticks: [] },
    {
      type: "bundle",
      from: 3,
      to: 5,
      ticks: [
        {
          tick: 3,
          commands: [
            { player: 1, payload: new Uint8Array([1, 2, 3]) },
            { player: 2, payload: new Uint8Array([4]) },
          ],
        },
      ],
    },
    { type: "request_snapshot", forPlayer: 3 },
    { type: "request_snapshot", forPlayer: NO_PLAYER },
    { type: "snapshot", tick: 42, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) },
    { type: "snapshot", tick: 1800, data: new Uint8Array([1]), frozenTicks: 3000 },
    { type: "desync", tick: 600, hashes: { 1: "aaaa", 2: "bbbb" } },
    { type: "error", code: "bad_message", message: "champ manquant" },
    { type: "ping" },
    { type: "pong" },
    {
      type: "world_welcome",
      playerId: 2,
      name: "bob",
      settlements: [settlement],
      players: ["alice", "bob"],
      world: { seed: 1, subdivisions: 4, tiles: 2562 },
    },
    { type: "world_welcome", playerId: 1, name: "alice", settlements: [], players: ["alice"], world: { seed: 0, subdivisions: 0, tiles: 12 } },
    { type: "world_settlements", settlements: [] },
    { type: "world_settlements", settlements: [settlement, { ...settlement, tile: 7, room: "tile-7" }] },
    { type: "world_players", players: [] },
    { type: "world_players", players: ["alice"] },
    { type: "settled", tile: 1234, room: "tile-1234", seed: 3_141_592_653 },
    { type: "world_error", code: "occupied", message: "case déjà colonisée" },
    { type: "world_caravans", caravans: [] },
    {
      type: "world_caravans",
      caravans: [caravan, { ...caravan, id: "c2", status: "delivered", progress: 1, currentTile: 40 }],
    },
    {
      type: "caravan_arrive",
      id: "c1",
      tile: 40,
      manifest: new Uint8Array([0, 128, 255]),
      summary: { pawns: 2, items: [[3, 5]] },
    },
  ];

  it("fait l'aller-retour sur chaque message client", () => {
    for (const message of clientMessages) {
      expect(decodeClientMessage(encodeMessage(message))).toEqual(message);
    }
  });

  it("fait l'aller-retour sur chaque message serveur", () => {
    for (const message of serverMessages) {
      expect(decodeServerMessage(encodeMessage(message))).toEqual(message);
    }
  });

  it("préserve les octets d'une charge binaire, y compris 0 et 255", () => {
    const payload = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const wire = encodeMessage({ type: "command", payload });
    expect(wire).toContain('"payload":"');
    const back = decodeClientMessage(wire);
    expect(back?.type).toBe("command");
    expect(back?.type === "command" ? back.payload : null).toEqual(payload);
  });

  it("écrit les charges binaires en base64 dans le JSON", () => {
    const wire = decodeMessage(encodeMessage({ type: "command", payload: new Uint8Array([1, 2, 3]) }));
    expect(wire).toEqual({ type: "command", payload: "AQID" });
  });

  it("renvoie null sur un JSON illisible", () => {
    expect(decodeMessage("{pas du json")).toBeNull();
    expect(decodeClientMessage("{pas du json")).toBeNull();
    expect(decodeServerMessage("")).toBeNull();
  });
});

describe("validation", () => {
  it("refuse les messages clients malformés", () => {
    const bad: unknown[] = [
      null,
      42,
      "join",
      [],
      {},
      { type: "inconnu" },
      { type: "join" },
      { type: "join", room: "", name: "alice" },
      { type: "join", room: "demo", name: 7 },
      { type: "join", room: "demo", name: "alice", protocol: "1" },
      { type: "start", seed: 1, width: 0, height: 10 },
      { type: "start", seed: -1, width: 10, height: 10 },
      { type: "start", seed: 1.5, width: 10, height: 10 },
      { type: "command" },
      { type: "command", payload: "pas du base64!" },
      { type: "command", payload: "" },
      { type: "hash", tick: -1, hash: "aa" },
      { type: "hash", tick: 10 },
      { type: "snapshot", tick: 10 },
      { type: "snapshot", tick: 10, data: "AQID", forPlayer: 0 },
      { type: "world_join" },
      { type: "world_join", name: "" },
      { type: "world_join", name: "alice", protocol: "1" },
      { type: "settle" },
      { type: "settle", tile: -1 },
      { type: "settle", tile: 1.5 },
      { type: "visit", tile: "3" },
      { type: "abandon", tile: null },
      { type: "caravan_depart", fromTile: 1, toTile: 2, summary: { pawns: 1, items: [] } },
      { type: "caravan_depart", fromTile: 1, toTile: 2, manifest: "", summary: { pawns: 1, items: [] } },
      { type: "caravan_depart", fromTile: 1, manifest: "AQID", summary: { pawns: 1, items: [] } },
      { type: "caravan_depart", fromTile: -1, toTile: 2, manifest: "AQID", summary: { pawns: 1, items: [] } },
      { type: "caravan_depart", fromTile: 1, toTile: 2, manifest: "AQID" },
      { type: "caravan_depart", fromTile: 1, toTile: 2, manifest: "AQID", summary: { pawns: -1, items: [] } },
      { type: "caravan_depart", fromTile: 1, toTile: 2, manifest: "AQID", summary: { pawns: 1, items: [[1]] } },
      {
        type: "caravan_depart",
        fromTile: 1,
        toTile: 2,
        manifest: "AQID",
        summary: { pawns: 1, items: [[1, 2, 3]] },
      },
      { type: "caravan_depart", fromTile: 1, toTile: 2, manifest: "AQID", summary: { pawns: 1, items: {} } },
      { type: "caravan_cancel" },
      { type: "caravan_cancel", id: "" },
      { type: "caravan_delivered", id: 3 },
    ];
    for (const value of bad) {
      expect(validateClientMessage(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("refuse les messages serveurs malformés", () => {
    const bad: unknown[] = [
      { type: "welcome" },
      { type: "welcome", protocol: 1, playerId: 1, isHost: "oui", players: [], state: "lobby", tick: 0 },
      { type: "welcome", protocol: 1, playerId: 1, isHost: true, players: [{}], state: "lobby", tick: 0 },
      { type: "welcome", protocol: 1, playerId: 1, isHost: true, players: [], state: "zombie", tick: 0 },
      { type: "players", players: {} },
      { type: "players", players: [], hostId: 0 },
      { type: "bundle", from: 5, to: 2, ticks: [] },
      { type: "bundle", from: 0, to: 2 },
      { type: "bundle", from: 0, to: 2, ticks: [{ tick: 9, commands: [] }] },
      { type: "bundle", from: 0, to: 2, ticks: [{ tick: 0, commands: [{ player: 1 }] }] },
      { type: "request_snapshot", forPlayer: "1" },
      { type: "desync", tick: 1, hashes: { abc: "aa" } },
      { type: "desync", tick: 1, hashes: [] },
      { type: "error", code: "", message: "vide" },
      { type: "error", code: "bad_message" },
      { type: "request_snapshot", forPlayer: -1 },
      { type: "world_welcome", playerId: 1, name: "alice", settlements: [], players: [] },
      {
        type: "world_welcome",
        playerId: 1,
        name: "alice",
        settlements: [],
        players: [],
        world: { seed: 1, subdivisions: 4 },
      },
      {
        type: "world_welcome",
        playerId: 0,
        name: "alice",
        settlements: [],
        players: [],
        world: { seed: 1, subdivisions: 4, tiles: 2562 },
      },
      { type: "world_settlements", settlements: {} },
      // Colonie sans `createdAt` : un `Settlement` est validé champ par champ.
      { type: "world_settlements", settlements: [{ tile: 1, owner: "a", room: "tile-1", seed: 2 }] },
      { type: "world_settlements", settlements: [{ ...settlement, owner: "" }] },
      { type: "world_settlements", settlements: [{ ...settlement, tile: -3 }] },
      { type: "world_players", players: [7] },
      { type: "world_players", players: "alice" },
      { type: "settled", tile: 1, room: "", seed: 1 },
      { type: "settled", tile: 1, room: "tile-1", seed: -1 },
      { type: "settled", room: "tile-1", seed: 1 },
      { type: "world_error", code: "", message: "vide" },
      { type: "world_error", code: "occupied" },
      { type: "world_caravans", caravans: {} },
      { type: "world_caravans", caravans: [{ ...caravan, status: "perdue" }] },
      { type: "world_caravans", caravans: [{ ...caravan, progress: 1.5 }] },
      { type: "world_caravans", caravans: [{ ...caravan, progress: "0.5" }] },
      { type: "world_caravans", caravans: [{ ...caravan, route: [] }] },
      { type: "world_caravans", caravans: [{ ...caravan, route: [1, -2] }] },
      { type: "world_caravans", caravans: [{ ...caravan, arrivesAt: Number.POSITIVE_INFINITY }] },
      { type: "world_caravans", caravans: [{ ...caravan, departedAt: -1 }] },
      { type: "world_caravans", caravans: [{ ...caravan, id: "" }] },
      { type: "world_caravans", caravans: [{ ...caravan, owner: 1 }] },
      { type: "world_caravans", caravans: [{ ...caravan, summary: { pawns: 1 } }] },
      { type: "caravan_arrive", id: "c1", tile: 3, summary: { pawns: 1, items: [] } },
      { type: "caravan_arrive", id: "c1", manifest: "AQID", summary: { pawns: 1, items: [] } },
      { type: "caravan_arrive", id: "c1", tile: 3, manifest: "AQID" },
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: -1 },
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: 1.5 },
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: "3000" },
      // Au-delà de 60 jours, le sim tronquerait : la trame ment, on la refuse.
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: MAX_FROZEN_TICKS + 1 },
    ];
    for (const value of bad) {
      expect(validateServerMessage(value), JSON.stringify(value)).toBeNull();
    }
  });

  it("accepte des octets déjà décodés (transport en même processus)", () => {
    const message = validateClientMessage({ type: "command", payload: new Uint8Array([5, 6]) });
    expect(message?.type === "command" ? message.payload : null).toEqual(new Uint8Array([5, 6]));
  });

  it("valide la version de protocole", () => {
    expect(isCompatibleProtocol(undefined)).toBe(true);
    expect(isCompatibleProtocol(PROTOCOL_VERSION)).toBe(true);
    expect(isCompatibleProtocol(PROTOCOL_VERSION + 1)).toBe(false);
  });
});

describe("monde", () => {
  it("accepte NO_PLAYER dans request_snapshot mais pas dans snapshot", () => {
    // Le serveur peut demander un snapshot « pour personne » (conservation) ;
    // la réponse, elle, doit omettre `forPlayer` — 0 n'y est pas une cible.
    expect(validateServerMessage({ type: "request_snapshot", forPlayer: NO_PLAYER })).toEqual({
      type: "request_snapshot",
      forPlayer: 0,
    });
    expect(validateClientMessage({ type: "snapshot", tick: 5, data: "AQID", forPlayer: NO_PLAYER })).toBeNull();
    expect(validateClientMessage({ type: "snapshot", tick: 5, data: "AQID" })).toEqual({
      type: "snapshot",
      tick: 5,
      data: new Uint8Array([1, 2, 3]),
    });
  });

  it("transporte une colonie sans perdre de champ", () => {
    const wire = encodeMessage({ type: "world_settlements", settlements: [settlement] });
    expect(decodeMessage(wire)).toEqual({ type: "world_settlements", settlements: [settlement] });
    const back = decodeServerMessage(wire);
    expect(back?.type === "world_settlements" ? back.settlements : null).toEqual([settlement]);
  });

  it("garde des codes d'erreur monde distincts", () => {
    expect(new Set(WORLD_ERROR_CODES).size).toBe(WORLD_ERROR_CODES.length);
  });
});

describe("caravanes", () => {
  it("écrit le manifeste en base64 et le rend octet pour octet", () => {
    const manifest = new Uint8Array([0, 1, 127, 128, 254, 255]);
    const wire = encodeMessage({
      type: "caravan_depart",
      fromTile: 3,
      toTile: 9,
      manifest,
      summary: { pawns: 1, items: [] },
    });
    expect(decodeMessage(wire)).toEqual({
      type: "caravan_depart",
      fromTile: 3,
      toTile: 9,
      manifest: "AAF/gP7/",
      summary: { pawns: 1, items: [] },
    });
    const back = decodeClientMessage(wire);
    expect(back?.type === "caravan_depart" ? back.manifest : null).toEqual(manifest);
  });

  it("transporte une caravane sans perdre de champ", () => {
    const wire = encodeMessage({ type: "world_caravans", caravans: [caravan] });
    expect(decodeMessage(wire)).toEqual({ type: "world_caravans", caravans: [caravan] });
    const back = decodeServerMessage(wire);
    expect(back?.type === "world_caravans" ? back.caravans : null).toEqual([caravan]);
  });

  it("accepte les quatre statuts et rien d'autre", () => {
    for (const status of ["travelling", "returning", "arrived", "delivered"]) {
      expect(validateServerMessage({ type: "world_caravans", caravans: [{ ...caravan, status }] })).not.toBeNull();
    }
    expect(validateServerMessage({ type: "world_caravans", caravans: [{ ...caravan, status: "en_vol" }] })).toBeNull();
  });

  it("garde les heures de jeu flottantes, contrairement aux ticks", () => {
    // L'horloge du monde n'est pas en lockstep : le serveur fait autorité, les
    // flottants y sont permis (docs/world.md §6).
    const message = validateServerMessage({
      type: "world_caravans",
      caravans: [{ ...caravan, departedAt: 0.25, arrivesAt: 12.75, progress: 0.125 }],
    });
    expect(message?.type === "world_caravans" ? message.caravans[0] : null).toMatchObject({
      departedAt: 0.25,
      arrivesAt: 12.75,
      progress: 0.125,
    });
  });
});

describe("colonie gelée", () => {
  it("compte 600 ticks par heure de jeu et 14 400 par jour", () => {
    // Contrat avec `sim::TICKS_PER_DAY` et l'horloge du monde (§11.6, §12.1).
    expect(TICKS_PER_DAY).toBe(14_400);
    expect(TICKS_PER_HOUR).toBe(600);
    expect(MAX_FROZEN_TICKS).toBe(TICKS_PER_DAY * 60);
  });

  it("convertit des heures de jeu en ticks d'avance rapide", () => {
    expect(frozenTicksForHours(5)).toBe(3000);
    expect(frozenTicksForHours(0.5)).toBe(300);
    // Arrondi au tick, pas de troncature.
    expect(frozenTicksForHours(1 / 1200)).toBe(1);
    // Rien à rattraper : horloge à l'arrêt, ou qui a reculé.
    expect(frozenTicksForHours(0)).toBe(0);
    expect(frozenTicksForHours(-3)).toBe(0);
    expect(frozenTicksForHours(Number.NaN)).toBe(0);
    // Deux mois de gel au plus, comme `sim::MAX_FAST_FORWARD`.
    expect(frozenTicksForHours(24 * 60)).toBe(MAX_FROZEN_TICKS);
    expect(frozenTicksForHours(24 * 365)).toBe(MAX_FROZEN_TICKS);
  });

  it("laisse passer un snapshot sans frozenTicks et garde le champ sinon", () => {
    const plain = validateServerMessage({ type: "snapshot", tick: 9, data: "AQID" });
    expect(plain).toEqual({ type: "snapshot", tick: 9, data: new Uint8Array([1, 2, 3]) });
    expect(plain !== null && "frozenTicks" in plain).toBe(false);

    const wire = encodeMessage({
      type: "snapshot",
      tick: 1800,
      data: new Uint8Array([1, 2, 3]),
      frozenTicks: 3000,
    });
    const back = decodeServerMessage(wire);
    expect(back?.type === "snapshot" ? back.frozenTicks : null).toBe(3000);
  });
});
