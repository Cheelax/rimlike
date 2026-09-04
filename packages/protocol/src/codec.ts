/**
 * Sérialisation des messages. v1 : JSON sur le fil, charges binaires en base64.
 * Le codec ne dépend d'aucune API de plateforme (ni `Buffer`, ni `btoa`) pour
 * rester identique dans le navigateur, dans Node et dans un Worker.
 *
 * La validation est écrite à la main, message par message : elle sert de
 * frontière de confiance et documente le schéma mieux qu'un schéma déclaratif.
 * Un message invalide donne `null`, jamais une exception.
 */

import {
  NO_PLAYER,
  PROTOCOL_VERSION,
  type Bundle,
  type ClientMessage,
  type PlayerId,
  type PlayerInfo,
  type RoomState,
  type ServerMessage,
  type Settlement,
  type TickCommand,
  type TickCommands,
  type WorldInfo,
} from "./messages.js";

const B64_ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

const B64_REVERSE: readonly number[] = (() => {
  const table = new Array<number>(128).fill(-1);
  for (let i = 0; i < B64_ALPHABET.length; i += 1) {
    table[B64_ALPHABET.charCodeAt(i)] = i;
  }
  return table;
})();

/** Base64 standard, avec remplissage `=`. */
export function bytesToBase64(bytes: Uint8Array): string {
  let out = "";
  let i = 0;
  for (; i + 2 < bytes.length; i += 3) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8) | bytes[i + 2]!;
    out +=
      B64_ALPHABET[(n >> 18) & 63]! +
      B64_ALPHABET[(n >> 12) & 63]! +
      B64_ALPHABET[(n >> 6) & 63]! +
      B64_ALPHABET[n & 63]!;
  }
  const rest = bytes.length - i;
  if (rest === 1) {
    const n = bytes[i]! << 16;
    out += `${B64_ALPHABET[(n >> 18) & 63]!}${B64_ALPHABET[(n >> 12) & 63]!}==`;
  } else if (rest === 2) {
    const n = (bytes[i]! << 16) | (bytes[i + 1]! << 8);
    out += `${B64_ALPHABET[(n >> 18) & 63]!}${B64_ALPHABET[(n >> 12) & 63]!}${B64_ALPHABET[(n >> 6) & 63]!}=`;
  }
  return out;
}

/** Renvoie `null` si la chaîne n'est pas du base64 standard bien formé. */
export function base64ToBytes(text: string): Uint8Array | null {
  if (text.length % 4 !== 0) {
    return null;
  }
  let padding = 0;
  if (text.endsWith("==")) {
    padding = 2;
  } else if (text.endsWith("=")) {
    padding = 1;
  }
  const bytes = new Uint8Array((text.length / 4) * 3 - padding);
  let out = 0;
  for (let i = 0; i < text.length; i += 4) {
    const chunk = [0, 1, 2, 3].map((k) => {
      const code = text.charCodeAt(i + k);
      if (code >= 128) {
        return -1;
      }
      const isPad = code === 61 /* '=' */ && i + 4 === text.length && k >= 4 - padding;
      return isPad ? 0 : (B64_REVERSE[code] ?? -1);
    });
    if (chunk.some((v) => v < 0)) {
      return null;
    }
    const n = (chunk[0]! << 18) | (chunk[1]! << 12) | (chunk[2]! << 6) | chunk[3]!;
    if (out < bytes.length) {
      bytes[out++] = (n >> 16) & 255;
    }
    if (out < bytes.length) {
      bytes[out++] = (n >> 8) & 255;
    }
    if (out < bytes.length) {
      bytes[out++] = n & 255;
    }
  }
  return bytes;
}

/** Remplace récursivement les `Uint8Array` par du base64. */
function toWire(value: unknown): unknown {
  if (value instanceof Uint8Array) {
    return bytesToBase64(value);
  }
  if (Array.isArray(value)) {
    return value.map(toWire);
  }
  if (isRecord(value)) {
    const out: Record<string, unknown> = {};
    for (const key of Object.keys(value)) {
      const converted = toWire(value[key]);
      if (converted !== undefined) {
        out[key] = converted;
      }
    }
    return out;
  }
  return value;
}

/** Encode un message pour l'envoi : JSON, charges binaires en base64. */
export function encodeMessage(message: ClientMessage | ServerMessage): string {
  return JSON.stringify(toWire(message));
}

/**
 * Parse une trame reçue. Renvoie l'objet brut (charges encore en base64) ou
 * `null` si le JSON est illisible. Passer le résultat à `validateClientMessage`
 * ou `validateServerMessage` pour obtenir un message typé.
 */
export function decodeMessage(text: string): unknown {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return null;
  }
}

/** `decodeMessage` + validation, pour le serveur qui lit une trame cliente. */
export function decodeClientMessage(text: string): ClientMessage | null {
  return validateClientMessage(decodeMessage(text));
}

/** `decodeMessage` + validation, pour le client qui lit une trame serveur. */
export function decodeServerMessage(text: string): ServerMessage | null {
  return validateServerMessage(decodeMessage(text));
}

// --- Briques de validation ---

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isTick(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0;
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

function isHash(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

function isDimension(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= 4096;
}

/** Les graines sont des entiers sûrs positifs (le sim attend un `u64`). */
function isSeed(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isPlayerId(value: unknown): value is PlayerId {
  return typeof value === "number" && Number.isInteger(value) && value >= 1;
}

/** `forPlayer` d'un `request_snapshot` : un joueur, ou `NO_PLAYER` (0). */
function isPlayerIdOrNone(value: unknown): value is PlayerId {
  return isPlayerId(value) || value === NO_PLAYER;
}

/**
 * Identifiant de case du globe. La borne haute n'est qu'un garde-fou contre
 * les valeurs absurdes : c'est le serveur, seul à connaître la subdivision en
 * cours, qui vérifie que la case existe (`bad_tile`).
 */
function isTileId(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 10_000_000;
}

/** Date en millisecondes epoch. */
function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function asSettlements(value: unknown): Settlement[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const settlements: Settlement[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isTileId(entry.tile) || !isName(entry.owner) || !isName(entry.room)) {
      return null;
    }
    if (!isSeed(entry.seed) || !isTimestamp(entry.createdAt)) {
      return null;
    }
    settlements.push({
      tile: entry.tile,
      owner: entry.owner,
      room: entry.room,
      seed: entry.seed,
      createdAt: entry.createdAt,
    });
  }
  return settlements;
}

/** Noms de joueurs du monde : l'identité v1 est le nom, pas un identifiant. */
function asNames(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const names: string[] = [];
  for (const entry of value) {
    if (!isName(entry)) {
      return null;
    }
    names.push(entry);
  }
  return names;
}

function asWorldInfo(value: unknown): WorldInfo | null {
  if (!isRecord(value) || !isSeed(value.seed)) {
    return null;
  }
  const { subdivisions, tiles } = value;
  if (typeof subdivisions !== "number" || !Number.isInteger(subdivisions) || subdivisions < 0) {
    return null;
  }
  if (typeof tiles !== "number" || !Number.isInteger(tiles) || tiles < 1) {
    return null;
  }
  return { seed: value.seed, subdivisions, tiles };
}

/** Accepte du base64 (le fil) comme des octets déjà décodés (même processus). */
function asBytes(value: unknown): Uint8Array | null {
  if (value instanceof Uint8Array) {
    return value;
  }
  if (typeof value === "string") {
    return base64ToBytes(value);
  }
  return null;
}

function asPlayers(value: unknown): PlayerInfo[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const players: PlayerInfo[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isPlayerId(entry.id) || !isName(entry.name)) {
      return null;
    }
    players.push({ id: entry.id, name: entry.name });
  }
  return players;
}

function asRoomState(value: unknown): RoomState | null {
  return value === "lobby" || value === "running" || value === "desynced" ? value : null;
}

function asBundle(value: Record<string, unknown>): Bundle | null {
  if (!isTick(value.from) || !isTick(value.to) || value.to < value.from) {
    return null;
  }
  if (!Array.isArray(value.ticks)) {
    return null;
  }
  const ticks: TickCommands[] = [];
  for (const raw of value.ticks) {
    if (!isRecord(raw) || !isTick(raw.tick) || !Array.isArray(raw.commands)) {
      return null;
    }
    if (raw.tick < value.from || raw.tick > value.to) {
      return null;
    }
    const commands: TickCommand[] = [];
    for (const rawCommand of raw.commands) {
      if (!isRecord(rawCommand) || !isPlayerId(rawCommand.player)) {
        return null;
      }
      const payload = asBytes(rawCommand.payload);
      if (payload === null) {
        return null;
      }
      commands.push({ player: rawCommand.player, payload });
    }
    ticks.push({ tick: raw.tick, commands });
  }
  return { from: value.from, to: value.to, ticks };
}

// --- Validation des messages ---

/** Valide une trame client → serveur et décode ses charges binaires. */
export function validateClientMessage(value: unknown): ClientMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "join": {
      if (!isName(value.room) || !isName(value.name)) {
        return null;
      }
      if (value.protocol !== undefined && !isTick(value.protocol)) {
        return null;
      }
      return value.protocol === undefined
        ? { type: "join", room: value.room, name: value.name }
        : { type: "join", room: value.room, name: value.name, protocol: value.protocol };
    }
    case "start": {
      if (!isSeed(value.seed) || !isDimension(value.width) || !isDimension(value.height)) {
        return null;
      }
      return { type: "start", seed: value.seed, width: value.width, height: value.height };
    }
    case "command": {
      const payload = asBytes(value.payload);
      if (payload === null || payload.length === 0) {
        return null;
      }
      return { type: "command", payload };
    }
    case "hash": {
      if (!isTick(value.tick) || !isHash(value.hash)) {
        return null;
      }
      return { type: "hash", tick: value.tick, hash: value.hash };
    }
    case "snapshot": {
      const data = asBytes(value.data);
      if (data === null || !isTick(value.tick)) {
        return null;
      }
      if (value.forPlayer !== undefined && !isPlayerId(value.forPlayer)) {
        return null;
      }
      return value.forPlayer === undefined
        ? { type: "snapshot", tick: value.tick, data }
        : { type: "snapshot", tick: value.tick, data, forPlayer: value.forPlayer };
    }
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    case "world_join": {
      if (!isName(value.name)) {
        return null;
      }
      if (value.protocol !== undefined && !isTick(value.protocol)) {
        return null;
      }
      return value.protocol === undefined
        ? { type: "world_join", name: value.name }
        : { type: "world_join", name: value.name, protocol: value.protocol };
    }
    case "settle":
      return isTileId(value.tile) ? { type: "settle", tile: value.tile } : null;
    case "visit":
      return isTileId(value.tile) ? { type: "visit", tile: value.tile } : null;
    case "abandon":
      return isTileId(value.tile) ? { type: "abandon", tile: value.tile } : null;
    case "world_leave":
      return { type: "world_leave" };
    default:
      return null;
  }
}

/** Valide une trame serveur → client et décode ses charges binaires. */
export function validateServerMessage(value: unknown): ServerMessage | null {
  if (!isRecord(value) || typeof value.type !== "string") {
    return null;
  }
  switch (value.type) {
    case "welcome": {
      const players = asPlayers(value.players);
      const state = asRoomState(value.state);
      if (players === null || state === null) {
        return null;
      }
      if (!isTick(value.protocol) || !isPlayerId(value.playerId) || !isTick(value.tick)) {
        return null;
      }
      if (typeof value.isHost !== "boolean") {
        return null;
      }
      const started = value.seed !== undefined || value.width !== undefined || value.height !== undefined;
      if (started && (!isSeed(value.seed) || !isDimension(value.width) || !isDimension(value.height))) {
        return null;
      }
      const base: ServerMessage = {
        type: "welcome",
        protocol: value.protocol,
        playerId: value.playerId,
        isHost: value.isHost,
        players,
        state,
        tick: value.tick,
      };
      return started
        ? {
            ...base,
            seed: value.seed as number,
            width: value.width as number,
            height: value.height as number,
          }
        : base;
    }
    case "players": {
      const players = asPlayers(value.players);
      if (players === null) {
        return null;
      }
      if (value.hostId !== null && !isPlayerId(value.hostId)) {
        return null;
      }
      return { type: "players", players, hostId: value.hostId as PlayerId | null };
    }
    case "start": {
      if (!isSeed(value.seed) || !isDimension(value.width) || !isDimension(value.height)) {
        return null;
      }
      if (!isTick(value.tick)) {
        return null;
      }
      return {
        type: "start",
        seed: value.seed,
        width: value.width,
        height: value.height,
        tick: value.tick,
      };
    }
    case "bundle": {
      const bundle = asBundle(value);
      return bundle === null ? null : { type: "bundle", ...bundle };
    }
    case "request_snapshot": {
      // `NO_PLAYER` est admis : c'est la demande de snapshot de conservation
      // d'une salle « case » (docs/protocol.md §11).
      if (!isPlayerIdOrNone(value.forPlayer)) {
        return null;
      }
      return { type: "request_snapshot", forPlayer: value.forPlayer };
    }
    case "snapshot": {
      const data = asBytes(value.data);
      if (data === null || !isTick(value.tick)) {
        return null;
      }
      return { type: "snapshot", tick: value.tick, data };
    }
    case "desync": {
      if (!isTick(value.tick) || !isRecord(value.hashes)) {
        return null;
      }
      const hashes: Record<PlayerId, string> = {};
      for (const key of Object.keys(value.hashes)) {
        const id = Number(key);
        const hash = value.hashes[key];
        if (!isPlayerId(id) || !isHash(hash)) {
          return null;
        }
        hashes[id] = hash;
      }
      return { type: "desync", tick: value.tick, hashes };
    }
    case "error": {
      if (!isName(value.code) || typeof value.message !== "string") {
        return null;
      }
      return { type: "error", code: value.code, message: value.message };
    }
    case "ping":
      return { type: "ping" };
    case "pong":
      return { type: "pong" };
    case "world_welcome": {
      const settlements = asSettlements(value.settlements);
      const players = asNames(value.players);
      const world = asWorldInfo(value.world);
      if (settlements === null || players === null || world === null) {
        return null;
      }
      if (!isPlayerId(value.playerId) || !isName(value.name)) {
        return null;
      }
      return {
        type: "world_welcome",
        playerId: value.playerId,
        name: value.name,
        settlements,
        players,
        world,
      };
    }
    case "world_settlements": {
      const settlements = asSettlements(value.settlements);
      return settlements === null ? null : { type: "world_settlements", settlements };
    }
    case "world_players": {
      const players = asNames(value.players);
      return players === null ? null : { type: "world_players", players };
    }
    case "settled": {
      if (!isTileId(value.tile) || !isName(value.room) || !isSeed(value.seed)) {
        return null;
      }
      return { type: "settled", tile: value.tile, room: value.room, seed: value.seed };
    }
    case "world_error": {
      if (!isName(value.code) || typeof value.message !== "string") {
        return null;
      }
      return { type: "world_error", code: value.code, message: value.message };
    }
    default:
      return null;
  }
}

/** Vrai si la version annoncée par un client est compatible. */
export function isCompatibleProtocol(version: number | undefined): boolean {
  return version === undefined || version === PROTOCOL_VERSION;
}
