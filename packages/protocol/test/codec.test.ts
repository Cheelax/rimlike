import { describe, expect, it } from "vitest";

import {
  base64ToBytes,
  bytesToBase64,
  decodeClientMessage,
  decodeMessage,
  decodeServerMessage,
  encodeMessage,
  isCompatibleProtocol,
  PROTOCOL_VERSION,
  validateClientMessage,
  validateServerMessage,
  type ClientMessage,
  type ServerMessage,
} from "../src/index.js";

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
    { type: "snapshot", tick: 42, data: new Uint8Array([1, 2, 3, 4, 5, 6, 7]) },
    { type: "desync", tick: 600, hashes: { 1: "aaaa", 2: "bbbb" } },
    { type: "error", code: "bad_message", message: "champ manquant" },
    { type: "ping" },
    { type: "pong" },
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
