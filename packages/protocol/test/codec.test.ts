import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  CLIMATE_AMPLITUDE_MAX,
  CLIMATE_BASE_MIN,
  DEFAULT_GOODWILL,
  FACTION_COUNT,
  GOODWILL_MAX,
  GOODWILL_MIN,
  clampGoodwill,
  frozenTicksForHours,
  MAX_FROZEN_TICKS,
  MAX_PENDING_TRADERS,
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
  worldDayOfYear,
  WORLD_ERROR_CODES,
  YEAR_DAYS,
  type Caravan,
  type ClientMessage,
  type GoodwillValues,
  type Merchant,
  type ServerMessage,
  type Settlement,
  type StartClimate,
  type WorldPlayerInfo,
} from "../src/index.js";

/** Une colonie de référence, réutilisée par plusieurs cas. */
const settlement: Settlement = {
  tile: 1234,
  owner: "key-alice",
  ownerName: "alice",
  room: "tile-1234",
  seed: 3_141_592_653,
  createdAt: 1_757_000_000_000,
};

/** Une caravane de référence, en vol à mi-parcours. */
const caravan: Caravan = {
  id: "c1",
  owner: "key-alice",
  ownerName: "alice",
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

/** Le climat d'une colonie sur une case polaire : moyenne très négative, fort écart saisonnier. */
const climate: StartClimate = { baseTemperature: -340, amplitude: 200 };

/** Un marchand itinérant de référence, en chemin vers une colonie (§13). */
const merchant: Merchant = {
  id: "m1",
  name: "Compagnie du Levant",
  tile: 23,
  toTile: 40,
  status: "travelling",
  progress: 0.5,
};

/** La table des joueurs connus du monde, telle que diffusée par `world_welcome`/`world_players`. */
const worldPlayers: WorldPlayerInfo[] = [
  { key: "key-alice", name: "alice", online: true },
  { key: "key-bob", name: "bob", online: false },
];

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
    { type: "resync" },
    { type: "world_join", name: "alice" },
    { type: "world_join", name: "bob", protocol: PROTOCOL_VERSION },
    { type: "world_join", name: "carol", token: "tok-carol" },
    { type: "world_join", name: "dave", protocol: PROTOCOL_VERSION, token: "tok-dave" },
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
    // Réputation remontée par l'hôte d'une colonie (§14) : les trois valeurs
    // dans l'ordre des factions, bornes comprises.
    { type: "goodwill_report", values: [-20, -20, 10] },
    { type: "goodwill_report", values: [GOODWILL_MIN, 0, GOODWILL_MAX] },
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
    // Salle « case » : la colonie hérite du climat et du jour de l'année de
    // sa case (§11.6, §12.1).
    { type: "start", seed: 7, width: 128, height: 128, tick: 0, climate, dayOfYear: 1 },
    // Colonie rouverte en lobby après le passage de marchands (§13).
    { type: "start", seed: 7, width: 64, height: 64, tick: 0, climate, dayOfYear: 1, pendingTraders: 2 },
    // Réputation du propriétaire, imposée à la fondation (§14).
    { type: "start", seed: 7, width: 64, height: 64, tick: 0, climate, dayOfYear: 1, goodwill: [-45, 0, 60] },
    { type: "start", seed: 7, width: 64, height: 64, tick: 0, goodwill: DEFAULT_GOODWILL },
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
    // Réouverture d'une colonie gelée qu'un marchand a visitée entretemps :
    // les deux champs voyagent ensemble, chacun sa commande à émettre (§13).
    { type: "snapshot", tick: 1800, data: new Uint8Array([1]), frozenTicks: 3000, pendingTraders: 1 },
    { type: "snapshot", tick: 1800, data: new Uint8Array([1]), pendingTraders: MAX_PENDING_TRADERS },
    // Colonie gelée qui rouvre : la réputation du joueur voyage à côté du
    // temps gelé, et s'impose **après** lui (§14).
    { type: "snapshot", tick: 1800, data: new Uint8Array([1]), frozenTicks: 3000, goodwill: [-100, 5, 100] },
    { type: "desync", tick: 600, hashes: { 1: "aaaa", 2: "bbbb" } },
    { type: "desync", tick: 600, hashes: { 1: "aaaa", 2: "zzzz", 3: "aaaa" }, outliers: [2] },
    { type: "resynced", player: 2, tick: 900 },
    { type: "error", code: "bad_message", message: "champ manquant" },
    { type: "ping" },
    { type: "pong" },
    {
      type: "world_welcome",
      playerId: 2,
      playerKey: "key-bob",
      name: "bob",
      settlements: [settlement],
      players: worldPlayers,
      world: { seed: 1, subdivisions: 4, tiles: 2562 },
    },
    {
      type: "world_welcome",
      playerId: 1,
      playerKey: "key-alice",
      name: "alice",
      // Uniquement à la création d'un nouveau joueur : jamais rejoué ensuite.
      token: "tok-alice",
      settlements: [],
      players: [worldPlayers[0]!],
      world: { seed: 0, subdivisions: 0, tiles: 12 },
    },
    { type: "world_settlements", settlements: [] },
    { type: "world_settlements", settlements: [settlement, { ...settlement, tile: 7, room: "tile-7" }] },
    { type: "world_players", players: [] },
    { type: "world_players", players: worldPlayers },
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
    // Marchands itinérants : même message que les caravanes, champ en plus (§13).
    { type: "world_caravans", caravans: [], merchants: [] },
    {
      type: "world_caravans",
      caravans: [caravan],
      merchants: [merchant, { ...merchant, id: "m2", tile: 40, toTile: 40, status: "visiting", progress: 1 }],
    },
    { type: "trader_arrival", tile: 40, merchantId: "m1", merchantName: "Compagnie du Levant" },
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
      { type: "world_join", name: "alice", token: 7 },
      { type: "world_join", name: "alice", token: "" },
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
      { type: "start", seed: 7, width: 128, height: 128, tick: 0, climate: { baseTemperature: 0 } },
      { type: "start", seed: 7, width: 128, height: 128, tick: 0, climate: { baseTemperature: 0, amplitude: -1 } },
      {
        type: "start",
        seed: 7,
        width: 128,
        height: 128,
        tick: 0,
        climate: { baseTemperature: CLIMATE_BASE_MIN - 1, amplitude: 0 },
      },
      {
        type: "start",
        seed: 7,
        width: 128,
        height: 128,
        tick: 0,
        climate: { baseTemperature: 0, amplitude: CLIMATE_AMPLITUDE_MAX + 1 },
      },
      { type: "start", seed: 7, width: 128, height: 128, tick: 0, climate: { baseTemperature: 1.5, amplitude: 0 } },
      { type: "start", seed: 7, width: 128, height: 128, tick: 0, dayOfYear: -1 },
      { type: "start", seed: 7, width: 128, height: 128, tick: 0, dayOfYear: YEAR_DAYS },
      { type: "start", seed: 7, width: 128, height: 128, tick: 0, dayOfYear: 1.5 },
      { type: "start", seed: 7, width: 128, height: 128, tick: 0, dayOfYear: "1" },
      { type: "bundle", from: 5, to: 2, ticks: [] },
      { type: "bundle", from: 0, to: 2 },
      { type: "bundle", from: 0, to: 2, ticks: [{ tick: 9, commands: [] }] },
      { type: "bundle", from: 0, to: 2, ticks: [{ tick: 0, commands: [{ player: 1 }] }] },
      { type: "request_snapshot", forPlayer: "1" },
      { type: "desync", tick: 1, hashes: { abc: "aa" } },
      { type: "desync", tick: 1, hashes: [] },
      { type: "desync", tick: 1, hashes: { 1: "aa" }, outliers: "nope" },
      { type: "desync", tick: 1, hashes: { 1: "aa" }, outliers: [0] },
      { type: "resynced", tick: 1 },
      { type: "resynced", player: 0, tick: 1 },
      { type: "resynced", player: 1 },
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
      // Sans `playerKey`, ou vide, ou un `token` du mauvais type.
      {
        type: "world_welcome",
        playerId: 1,
        name: "alice",
        settlements: [],
        players: [],
        world: { seed: 1, subdivisions: 4, tiles: 2562 },
      },
      {
        type: "world_welcome",
        playerId: 1,
        playerKey: "",
        name: "alice",
        settlements: [],
        players: [],
        world: { seed: 1, subdivisions: 4, tiles: 2562 },
      },
      {
        type: "world_welcome",
        playerId: 1,
        playerKey: "key-alice",
        name: "alice",
        token: 7,
        settlements: [],
        players: [],
        world: { seed: 1, subdivisions: 4, tiles: 2562 },
      },
      { type: "world_settlements", settlements: {} },
      // Colonie sans `createdAt` : un `Settlement` est validé champ par champ.
      { type: "world_settlements", settlements: [{ tile: 1, owner: "a", ownerName: "a", room: "tile-1", seed: 2 }] },
      { type: "world_settlements", settlements: [{ ...settlement, owner: "" }] },
      { type: "world_settlements", settlements: [{ ...settlement, ownerName: "" }] },
      { type: "world_settlements", settlements: [{ ...settlement, tile: -3 }] },
      { type: "world_players", players: [7] },
      { type: "world_players", players: "alice" },
      { type: "world_players", players: [{ key: "k" }] },
      { type: "world_players", players: [{ key: "k", name: "n", online: "oui" }] },
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
      { type: "world_caravans", caravans: [{ ...caravan, ownerName: "" }] },
      { type: "world_caravans", caravans: [{ ...caravan, summary: { pawns: 1 } }] },
      { type: "caravan_arrive", id: "c1", tile: 3, summary: { pawns: 1, items: [] } },
      { type: "caravan_arrive", id: "c1", manifest: "AQID", summary: { pawns: 1, items: [] } },
      { type: "caravan_arrive", id: "c1", tile: 3, manifest: "AQID" },
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: -1 },
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: 1.5 },
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: "3000" },
      // Au-delà de 60 jours, le sim tronquerait : la trame ment, on la refuse.
      { type: "snapshot", tick: 1, data: "AQID", frozenTicks: MAX_FROZEN_TICKS + 1 },
      // Marchands itinérants (§13).
      { type: "world_caravans", caravans: [], merchants: {} },
      { type: "world_caravans", caravans: [], merchants: [{ ...merchant, status: "arrived" }] },
      { type: "world_caravans", caravans: [], merchants: [{ ...merchant, progress: 1.5 }] },
      { type: "world_caravans", caravans: [], merchants: [{ ...merchant, tile: -1 }] },
      { type: "world_caravans", caravans: [], merchants: [{ ...merchant, id: "" }] },
      { type: "world_caravans", caravans: [], merchants: [{ ...merchant, name: "" }] },
      { type: "trader_arrival", tile: 40, merchantId: "m1" },
      { type: "trader_arrival", tile: 40, merchantName: "Compagnie du Levant" },
      { type: "trader_arrival", merchantId: "m1", merchantName: "Compagnie du Levant" },
      { type: "trader_arrival", tile: -1, merchantId: "m1", merchantName: "Compagnie du Levant" },
      // Au-delà de la borne du serveur, la trame ment sur ce qu'il enverra.
      { type: "start", seed: 1, width: 64, height: 64, tick: 0, pendingTraders: MAX_PENDING_TRADERS + 1 },
      { type: "start", seed: 1, width: 64, height: 64, tick: 0, pendingTraders: -1 },
      { type: "start", seed: 1, width: 64, height: 64, tick: 0, pendingTraders: 1.5 },
      { type: "snapshot", tick: 1, data: "AQID", pendingTraders: "2" },
      { type: "snapshot", tick: 1, data: "AQID", pendingTraders: MAX_PENDING_TRADERS + 1 },
      // Réputation (§14) : le serveur la borne avant de l'envoyer, une valeur
      // hors bornes mentirait sur ce que le sim appliquera.
      { type: "start", seed: 1, width: 8, height: 8, tick: 0, goodwill: [GOODWILL_MIN - 1, 0, 0] },
      { type: "start", seed: 1, width: 8, height: 8, tick: 0, goodwill: [0, GOODWILL_MAX + 1, 0] },
      { type: "start", seed: 1, width: 8, height: 8, tick: 0, goodwill: [0, 0] },
      { type: "start", seed: 1, width: 8, height: 8, tick: 0, goodwill: [0, 0, 0, 0] },
      { type: "start", seed: 1, width: 8, height: 8, tick: 0, goodwill: [0, 0, 1.5] },
      { type: "start", seed: 1, width: 8, height: 8, tick: 0, goodwill: [0, 0, "10"] },
      { type: "start", seed: 1, width: 8, height: 8, tick: 0, goodwill: { 0: 0, 1: 0, 2: 0 } },
      { type: "snapshot", tick: 1, data: "AQID", goodwill: [0, 0, GOODWILL_MAX + 1] },
      { type: "snapshot", tick: 1, data: "AQID", goodwill: null },
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

describe("marchands itinérants", () => {
  it("transporte un marchand sans perdre de champ, à côté des caravanes", () => {
    const wire = encodeMessage({ type: "world_caravans", caravans: [caravan], merchants: [merchant] });
    expect(decodeMessage(wire)).toEqual({ type: "world_caravans", caravans: [caravan], merchants: [merchant] });
    const back = decodeServerMessage(wire);
    expect(back?.type === "world_caravans" ? back.merchants : null).toEqual([merchant]);
  });

  it("laisse passer un world_caravans sans merchants : un vieux serveur reste lisible", () => {
    const plain = validateServerMessage({ type: "world_caravans", caravans: [] });
    expect(plain).toEqual({ type: "world_caravans", caravans: [] });
    expect(plain !== null && "merchants" in plain).toBe(false);
  });

  it("accepte les deux statuts d'un marchand et rien d'autre", () => {
    for (const status of ["travelling", "visiting"]) {
      expect(validateServerMessage({ type: "world_caravans", caravans: [], merchants: [{ ...merchant, status }] })).not.toBeNull();
    }
    for (const status of ["arrived", "delivered", "returning", "en_visite"]) {
      expect(validateServerMessage({ type: "world_caravans", caravans: [], merchants: [{ ...merchant, status }] })).toBeNull();
    }
  });

  it("fait l'aller-retour d'un trader_arrival, nom de compagnie compris", () => {
    const message: ServerMessage = {
      type: "trader_arrival",
      tile: 1732,
      merchantId: "m3",
      merchantName: "Convoi des Trois Rivières",
    };
    expect(decodeServerMessage(encodeMessage(message))).toEqual(message);
    // Un `trader_arrival` ne vient jamais d'un client : le serveur le refuse.
    expect(validateClientMessage(message)).toBeNull();
  });

  it("laisse passer un start sans pendingTraders et garde le champ sinon", () => {
    const plain = validateServerMessage({ type: "start", seed: 7, width: 64, height: 64, tick: 0 });
    expect(plain !== null && "pendingTraders" in plain).toBe(false);

    const wire = encodeMessage({ type: "start", seed: 7, width: 64, height: 64, tick: 0, pendingTraders: 3 });
    const back = decodeServerMessage(wire);
    expect(back?.type === "start" ? back.pendingTraders : null).toBe(MAX_PENDING_TRADERS);
  });

  it("borne pendingTraders des deux côtés, sur start comme sur snapshot", () => {
    expect(MAX_PENDING_TRADERS).toBe(3);
    for (const pendingTraders of [0, 1, MAX_PENDING_TRADERS]) {
      expect(validateServerMessage({ type: "start", seed: 1, width: 8, height: 8, tick: 0, pendingTraders })).not.toBeNull();
      expect(validateServerMessage({ type: "snapshot", tick: 1, data: "AQID", pendingTraders })).not.toBeNull();
    }
    for (const pendingTraders of [-1, 1.5, MAX_PENDING_TRADERS + 1, "2", null]) {
      expect(validateServerMessage({ type: "start", seed: 1, width: 8, height: 8, tick: 0, pendingTraders })).toBeNull();
      expect(validateServerMessage({ type: "snapshot", tick: 1, data: "AQID", pendingTraders })).toBeNull();
    }
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

describe("climat des colonies", () => {
  it("laisse passer un start sans climate et garde le champ sinon", () => {
    const plain = validateServerMessage({ type: "start", seed: 7, width: 128, height: 128, tick: 0 });
    expect(plain).toEqual({ type: "start", seed: 7, width: 128, height: 128, tick: 0 });
    expect(plain !== null && "climate" in plain).toBe(false);

    const wire = encodeMessage({ type: "start", seed: 7, width: 128, height: 128, tick: 0, climate });
    const back = decodeServerMessage(wire);
    expect(back?.type === "start" ? back.climate : null).toEqual(climate);
  });

  it("refuse un climate hors des bornes du sim ou incomplet", () => {
    const base = { type: "start" as const, seed: 7, width: 128, height: 128, tick: 0 };
    expect(validateServerMessage({ ...base, climate: { baseTemperature: CLIMATE_BASE_MIN - 1, amplitude: 0 } })).toBeNull();
    expect(validateServerMessage({ ...base, climate: { baseTemperature: 0, amplitude: CLIMATE_AMPLITUDE_MAX + 1 } })).toBeNull();
    expect(validateServerMessage({ ...base, climate: { baseTemperature: 0 } })).toBeNull();
    expect(validateServerMessage({ ...base, climate: { amplitude: 0 } })).toBeNull();
    expect(validateServerMessage({ ...base, climate: "chaud" })).toBeNull();
  });
});

describe("calendrier des colonies", () => {
  it("déduit le jour de l'année de l'horloge du monde, en heures de jeu", () => {
    // Contrat avec `sim::climate::YEAR_DAYS` (`crates/sim/src/climate.rs`).
    expect(YEAR_DAYS).toBe(60);
    // Une horloge à 30 h de jeu, c'est un jour et demi de monde : jour 1.
    expect(worldDayOfYear(30)).toBe(1);
    expect(worldDayOfYear(0)).toBe(0);
    expect(worldDayOfYear(23)).toBe(0);
    expect(worldDayOfYear(24)).toBe(1);
    // Un an de monde tout juste bouclé retombe au jour 0.
    expect(worldDayOfYear(YEAR_DAYS * 24)).toBe(0);
    expect(worldDayOfYear(YEAR_DAYS * 24 + 24)).toBe(1);
    // Rien à imposer : horloge à l'arrêt, ou qui aurait reculé.
    expect(worldDayOfYear(0)).toBe(0);
    expect(worldDayOfYear(-5)).toBe(0);
    expect(worldDayOfYear(Number.NaN)).toBe(0);
  });

  it("laisse passer un start sans dayOfYear et garde le champ sinon", () => {
    const plain = validateServerMessage({ type: "start", seed: 7, width: 128, height: 128, tick: 0 });
    expect(plain).toEqual({ type: "start", seed: 7, width: 128, height: 128, tick: 0 });
    expect(plain !== null && "dayOfYear" in plain).toBe(false);

    const wire = encodeMessage({ type: "start", seed: 7, width: 128, height: 128, tick: 0, dayOfYear: 45 });
    const back = decodeServerMessage(wire);
    expect(back?.type === "start" ? back.dayOfYear : null).toBe(45);
  });

  it("refuse un dayOfYear hors de 0..YEAR_DAYS ou non entier", () => {
    const base = { type: "start" as const, seed: 7, width: 128, height: 128, tick: 0 };
    expect(validateServerMessage({ ...base, dayOfYear: -1 })).toBeNull();
    expect(validateServerMessage({ ...base, dayOfYear: YEAR_DAYS })).toBeNull();
    expect(validateServerMessage({ ...base, dayOfYear: 1.5 })).toBeNull();
    expect(validateServerMessage({ ...base, dayOfYear: "1" })).toBeNull();
    expect(validateServerMessage({ ...base, dayOfYear: 0 })).toEqual({ ...base, dayOfYear: 0 });
    expect(validateServerMessage({ ...base, dayOfYear: YEAR_DAYS - 1 })).toEqual({ ...base, dayOfYear: YEAR_DAYS - 1 });
  });
});

describe("réputation partagée (§14)", () => {
  it("annonce les trois factions du sim et leur réputation de départ", () => {
    // Contrat avec `sim::factions` : trois factions, réputation de départ
    // −20 / −20 / +10, bornée à −100..=100.
    expect(FACTION_COUNT).toBe(3);
    expect(DEFAULT_GOODWILL).toEqual([-20, -20, 10]);
    expect(DEFAULT_GOODWILL).toHaveLength(FACTION_COUNT);
    expect(GOODWILL_MIN).toBe(-100);
    expect(GOODWILL_MAX).toBe(100);
  });

  it("rogne aux bornes du sim, tronque et neutralise le non fini", () => {
    expect(clampGoodwill([0, 0, 0])).toEqual([0, 0, 0]);
    expect(clampGoodwill([-500, 500, 42])).toEqual([GOODWILL_MIN, GOODWILL_MAX, 42]);
    expect(clampGoodwill([1.9, -1.9, 0])).toEqual([1, -1, 0]);
    expect(clampGoodwill([Number.NaN, Number.POSITIVE_INFINITY, Number.NEGATIVE_INFINITY])).toEqual([0, 0, 0]);
    // Les bornes elles-mêmes passent telles quelles.
    expect(clampGoodwill([GOODWILL_MIN, GOODWILL_MAX, 0])).toEqual([GOODWILL_MIN, GOODWILL_MAX, 0]);
  });

  it("fait l'aller-retour d'un goodwill_report et refuse une forme invalide", () => {
    const message: ClientMessage = { type: "goodwill_report", values: [-45, 12, 60] };
    expect(decodeClientMessage(encodeMessage(message))).toEqual(message);
    // Un `goodwill_report` ne vient jamais du serveur.
    expect(validateServerMessage(message)).toBeNull();

    for (const values of [[0, 0], [0, 0, 0, 0], [0, 0, "3"], [0, 0, 1.5], "0,0,0", null, { a: 1 }]) {
      expect(validateClientMessage({ type: "goodwill_report", values }), JSON.stringify(values)).toBeNull();
    }
  });

  it("accepte du client une valeur hors bornes : c'est le serveur qui rogne", () => {
    // Asymétrie voulue (`asReportedGoodwill` contre `asGoodwill`) : refuser la
    // trame ferait dépendre la connexion des bornes que le sim se donne, alors
    // que le serveur monde les applique de toute façon avec `clampGoodwill`.
    const wild = validateClientMessage({ type: "goodwill_report", values: [-4000, 4000, 0] });
    expect(wild).toEqual({ type: "goodwill_report", values: [-4000, 4000, 0] });
    expect(clampGoodwill((wild as { values: GoodwillValues }).values)).toEqual([GOODWILL_MIN, GOODWILL_MAX, 0]);
  });

  it("laisse passer start et snapshot sans goodwill, et gardent le champ sinon", () => {
    const plainStart = validateServerMessage({ type: "start", seed: 7, width: 64, height: 64, tick: 0 });
    expect(plainStart !== null && "goodwill" in plainStart).toBe(false);
    const plainSnapshot = validateServerMessage({ type: "snapshot", tick: 9, data: "AQID" });
    expect(plainSnapshot !== null && "goodwill" in plainSnapshot).toBe(false);

    const start = decodeServerMessage(
      encodeMessage({ type: "start", seed: 7, width: 64, height: 64, tick: 0, goodwill: [-20, -20, 10] }),
    );
    expect(start?.type === "start" ? start.goodwill : null).toEqual([-20, -20, 10]);

    const snapshot = decodeServerMessage(
      encodeMessage({
        type: "snapshot",
        tick: 1800,
        data: new Uint8Array([1, 2, 3]),
        frozenTicks: 3000,
        goodwill: [40, -60, 0],
      }),
    );
    expect(snapshot?.type === "snapshot" ? snapshot.goodwill : null).toEqual([40, -60, 0]);
    expect(snapshot?.type === "snapshot" ? snapshot.frozenTicks : null).toBe(3000);
  });
});
