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
  CLIMATE_AMPLITUDE_MAX,
  CLIMATE_AMPLITUDE_MIN,
  CLIMATE_BASE_MAX,
  CLIMATE_BASE_MIN,
  FACTION_COUNT,
  GOODWILL_MAX,
  GOODWILL_MIN,
  MAX_FROZEN_TICKS,
  MAX_PENDING_TRADERS,
  NO_PLAYER,
  PROTOCOL_VERSION,
  YEAR_DAYS,
  type Bundle,
  type Caravan,
  type CaravanStatus,
  type CaravanSummary,
  type ClientMessage,
  type GoodwillValues,
  type Merchant,
  type MerchantStatus,
  type PlayerId,
  type PlayerInfo,
  type RoomState,
  type ServerMessage,
  type Settlement,
  type StartClimate,
  type TickCommand,
  type TickCommands,
  type WorldInfo,
  type WorldPlayerInfo,
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

/**
 * Temps gelé d'une colonie, en ticks : un entier positif borné à la même
 * limite que le sim (60 jours). Un serveur qui annoncerait plus mentirait sur
 * ce que le sim appliquera — la trame est refusée plutôt que rognée.
 */
function isFrozenTicks(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= MAX_FROZEN_TICKS;
}

function isInRange(value: unknown, min: number, max: number): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= min && value <= max;
}

/**
 * `start.dayOfYear` : le jour du calendrier à imposer (`Command::SetCalendar`),
 * dans `0..YEAR_DAYS`. Même principe que `isFrozenTicks` : une valeur hors
 * bornes est refusée plutôt que rognée, elle mentirait sur ce que le sim
 * appliquera (`day_of_year % YEAR_DAYS` côté sim, mais silencieusement — la
 * frontière réseau, elle, ne laisse rien passer qu'elle ne peut garantir).
 */
function isDayOfYear(value: unknown): value is number {
  return isInRange(value, 0, YEAR_DAYS - 1);
}

/**
 * `start.climate` : un climat à imposer au sim, dans les bornes de
 * `Command::SetClimate` (`CLIMATE_BASE_*`, `CLIMATE_AMPLITUDE_*`). Une valeur
 * hors bornes est refusée plutôt que rognée : elle mentirait sur ce que le
 * sim appliquera réellement (même principe que `isFrozenTicks`).
 */
function asStartClimate(value: unknown): StartClimate | null {
  if (!isRecord(value)) {
    return null;
  }
  if (!isInRange(value.baseTemperature, CLIMATE_BASE_MIN, CLIMATE_BASE_MAX)) {
    return null;
  }
  if (!isInRange(value.amplitude, CLIMATE_AMPLITUDE_MIN, CLIMATE_AMPLITUDE_MAX)) {
    return null;
  }
  return { baseTemperature: value.baseTemperature, amplitude: value.amplitude };
}

/**
 * `start.pendingTraders` / `snapshot.pendingTraders` : le nombre de marchands
 * itinérants à faire entrer à l'ouverture d'une colonie (`docs/protocol.md`
 * §13). Même principe que `isFrozenTicks` : au-delà de la borne du serveur, la
 * trame est refusée plutôt que rognée. Zéro est accepté (le serveur l'omet,
 * mais rien ne casse s'il l'envoie).
 */
function isPendingTraders(value: unknown): value is number {
  return isInRange(value, 0, MAX_PENDING_TRADERS);
}

/**
 * Un triplet de réputations (`docs/protocol.md` §14), quel qu'en soit le
 * contenu numérique : exactement `FACTION_COUNT` entiers sûrs. Sert de base
 * aux deux formes ci-dessous, qui diffèrent seulement par les bornes qu'elles
 * exigent.
 */
function asGoodwillTriplet(value: unknown): [number, number, number] | null {
  if (!Array.isArray(value) || value.length !== FACTION_COUNT) {
    return null;
  }
  for (const entry of value) {
    if (typeof entry !== "number" || !Number.isSafeInteger(entry)) {
      return null;
    }
  }
  return [value[0] as number, value[1] as number, value[2] as number];
}

/**
 * `start.goodwill` / `snapshot.goodwill` : trois réputations que le serveur a
 * déjà bornées. Hors de `GOODWILL_MIN..=GOODWILL_MAX`, la trame est **refusée**
 * plutôt que rognée — même principe que `asStartClimate` : elle mentirait sur
 * ce que le sim appliquera.
 */
function asGoodwill(value: unknown): GoodwillValues | null {
  const triplet = asGoodwillTriplet(value);
  if (triplet === null) {
    return null;
  }
  return triplet.every((entry) => entry >= GOODWILL_MIN && entry <= GOODWILL_MAX) ? triplet : null;
}

/**
 * `goodwill_report.values` : ce qu'un **client** remonte de son sim. Trois
 * entiers, sans borne exigée ici — c'est le serveur monde qui les ramène dans
 * `GOODWILL_MIN..=GOODWILL_MAX` (`clampGoodwill`), parce que c'est lui qui les
 * réimposera. Refuser la trame ferait dépendre la connexion des bornes que le
 * sim se donne, alors que rogner ne coûte rien et ne perd rien de sensé.
 */
function asReportedGoodwill(value: unknown): GoodwillValues | null {
  return asGoodwillTriplet(value);
}

function isName(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 64;
}

/**
 * Clé publique de joueur (`WorldPlayerInfo.key`) : un identifiant opaque, pas
 * un nom affiché — juste borné en longueur pour rester une valeur raisonnable.
 */
function isKey(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 128;
}

/**
 * Jeton secret de joueur (`WorldJoinMessage.token`). Opaque pour le codec :
 * c'est le serveur qui le compare en temps constant (`crypto.timingSafeEqual`,
 * `docs/protocol.md` §11.2), le codec ne fait que borner sa longueur.
 */
function isToken(value: unknown): value is string {
  return typeof value === "string" && value.length > 0 && value.length <= 256;
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
    if (!isRecord(entry) || !isTileId(entry.tile) || !isKey(entry.owner) || !isName(entry.ownerName)) {
      return null;
    }
    if (!isName(entry.room) || !isSeed(entry.seed) || !isTimestamp(entry.createdAt)) {
      return null;
    }
    settlements.push({
      tile: entry.tile,
      owner: entry.owner,
      ownerName: entry.ownerName,
      room: entry.room,
      seed: entry.seed,
      createdAt: entry.createdAt,
    });
  }
  return settlements;
}

/** Entier de comptage : nombre de colons, quantité d'un objet, type d'objet. */
function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isInteger(value) && value >= 0 && value <= 1_000_000;
}

/**
 * Heure de jeu du monde. Flottante — l'horloge du globe n'est pas en lockstep,
 * le serveur fait autorité (`docs/world.md` §6).
 */
function isGameHours(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0;
}

/** Avancement d'une caravane : un flottant de `[0, 1]`. */
function isProgress(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
}

function asCaravanStatus(value: unknown): CaravanStatus | null {
  return value === "travelling" || value === "returning" || value === "arrived" || value === "delivered"
    ? value
    : null;
}

/**
 * Résumé d'affichage d'une caravane. Le serveur ne le produit pas — il le
 * relaie depuis le client qui expédie — mais il le valide comme tout le reste :
 * c'est une donnée extérieure qui finit par être rediffusée à tout le monde.
 */
function asCaravanSummary(value: unknown): CaravanSummary | null {
  if (!isRecord(value) || !isCount(value.pawns) || !Array.isArray(value.items)) {
    return null;
  }
  const items: [number, number][] = [];
  for (const entry of value.items) {
    if (!Array.isArray(entry) || entry.length !== 2 || !isCount(entry[0]) || !isCount(entry[1])) {
      return null;
    }
    items.push([entry[0], entry[1]]);
  }
  return { pawns: value.pawns, items };
}

/** Cases traversées : au moins la case de départ, toutes des identifiants. */
function asRoute(value: unknown): number[] | null {
  if (!Array.isArray(value) || value.length === 0) {
    return null;
  }
  const route: number[] = [];
  for (const entry of value) {
    if (!isTileId(entry)) {
      return null;
    }
    route.push(entry);
  }
  return route;
}

function asCaravans(value: unknown): Caravan[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const caravans: Caravan[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isName(entry.id) || !isKey(entry.owner) || !isName(entry.ownerName)) {
      return null;
    }
    if (!isTileId(entry.fromTile) || !isTileId(entry.toTile) || !isTileId(entry.currentTile)) {
      return null;
    }
    if (!isGameHours(entry.departedAt) || !isGameHours(entry.arrivesAt) || !isProgress(entry.progress)) {
      return null;
    }
    const route = asRoute(entry.route);
    const summary = asCaravanSummary(entry.summary);
    const status = asCaravanStatus(entry.status);
    if (route === null || summary === null || status === null) {
      return null;
    }
    caravans.push({
      id: entry.id,
      owner: entry.owner,
      ownerName: entry.ownerName,
      fromTile: entry.fromTile,
      toTile: entry.toTile,
      route,
      departedAt: entry.departedAt,
      arrivesAt: entry.arrivesAt,
      progress: entry.progress,
      currentTile: entry.currentTile,
      summary,
      status,
    });
  }
  return caravans;
}

function asMerchantStatus(value: unknown): MerchantStatus | null {
  return value === "travelling" || value === "visiting" ? value : null;
}

/**
 * Marchands itinérants d'un `world_caravans` (`docs/protocol.md` §13). Ils sont
 * produits par le serveur seul — aucun client n'en envoie — mais validés comme
 * le reste : ce codec est aussi celui que le client applique à ce qu'il reçoit.
 */
function asMerchants(value: unknown): Merchant[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const merchants: Merchant[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isName(entry.id) || !isName(entry.name)) {
      return null;
    }
    if (!isTileId(entry.tile) || !isTileId(entry.toTile) || !isProgress(entry.progress)) {
      return null;
    }
    const status = asMerchantStatus(entry.status);
    if (status === null) {
      return null;
    }
    merchants.push({
      id: entry.id,
      name: entry.name,
      tile: entry.tile,
      toTile: entry.toTile,
      status,
      progress: entry.progress,
    });
  }
  return merchants;
}

/** Table des joueurs connus du monde (`world_welcome`, `world_players`). */
function asWorldPlayers(value: unknown): WorldPlayerInfo[] | null {
  if (!Array.isArray(value)) {
    return null;
  }
  const players: WorldPlayerInfo[] = [];
  for (const entry of value) {
    if (!isRecord(entry) || !isKey(entry.key) || !isName(entry.name) || typeof entry.online !== "boolean") {
      return null;
    }
    players.push({ key: entry.key, name: entry.name, online: entry.online });
  }
  return players;
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
    case "resync":
      return { type: "resync" };
    case "world_join": {
      if (!isName(value.name)) {
        return null;
      }
      if (value.protocol !== undefined && !isTick(value.protocol)) {
        return null;
      }
      if (value.token !== undefined && !isToken(value.token)) {
        return null;
      }
      if (value.protocol === undefined && value.token === undefined) {
        return { type: "world_join", name: value.name };
      }
      if (value.token === undefined) {
        return { type: "world_join", name: value.name, protocol: value.protocol };
      }
      if (value.protocol === undefined) {
        return { type: "world_join", name: value.name, token: value.token };
      }
      return { type: "world_join", name: value.name, protocol: value.protocol, token: value.token };
    }
    case "settle":
      return isTileId(value.tile) ? { type: "settle", tile: value.tile } : null;
    case "visit":
      return isTileId(value.tile) ? { type: "visit", tile: value.tile } : null;
    case "abandon":
      return isTileId(value.tile) ? { type: "abandon", tile: value.tile } : null;
    case "world_leave":
      return { type: "world_leave" };
    case "caravan_depart": {
      const manifest = asBytes(value.manifest);
      const summary = asCaravanSummary(value.summary);
      if (manifest === null || manifest.length === 0 || summary === null) {
        return null;
      }
      if (!isTileId(value.fromTile) || !isTileId(value.toTile)) {
        return null;
      }
      return {
        type: "caravan_depart",
        fromTile: value.fromTile,
        toTile: value.toTile,
        manifest,
        summary,
      };
    }
    case "caravan_cancel":
      return isName(value.id) ? { type: "caravan_cancel", id: value.id } : null;
    case "caravan_delivered":
      return isName(value.id) ? { type: "caravan_delivered", id: value.id } : null;
    case "goodwill_report": {
      const values = asReportedGoodwill(value.values);
      return values === null ? null : { type: "goodwill_report", values };
    }
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
      let climate: StartClimate | undefined;
      if (value.climate !== undefined) {
        const parsed = asStartClimate(value.climate);
        if (parsed === null) {
          return null;
        }
        climate = parsed;
      }
      if (value.dayOfYear !== undefined && !isDayOfYear(value.dayOfYear)) {
        return null;
      }
      if (value.pendingTraders !== undefined && !isPendingTraders(value.pendingTraders)) {
        return null;
      }
      let goodwill: GoodwillValues | undefined;
      if (value.goodwill !== undefined) {
        const parsed = asGoodwill(value.goodwill);
        if (parsed === null) {
          return null;
        }
        goodwill = parsed;
      }
      return {
        type: "start",
        seed: value.seed,
        width: value.width,
        height: value.height,
        tick: value.tick,
        ...(climate === undefined ? {} : { climate }),
        ...(value.dayOfYear === undefined ? {} : { dayOfYear: value.dayOfYear }),
        ...(value.pendingTraders === undefined ? {} : { pendingTraders: value.pendingTraders }),
        ...(goodwill === undefined ? {} : { goodwill }),
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
      if (value.frozenTicks !== undefined && !isFrozenTicks(value.frozenTicks)) {
        return null;
      }
      if (value.pendingTraders !== undefined && !isPendingTraders(value.pendingTraders)) {
        return null;
      }
      let restored: GoodwillValues | undefined;
      if (value.goodwill !== undefined) {
        const parsed = asGoodwill(value.goodwill);
        if (parsed === null) {
          return null;
        }
        restored = parsed;
      }
      return {
        type: "snapshot",
        tick: value.tick,
        data,
        ...(value.frozenTicks === undefined ? {} : { frozenTicks: value.frozenTicks }),
        ...(value.pendingTraders === undefined ? {} : { pendingTraders: value.pendingTraders }),
        ...(restored === undefined ? {} : { goodwill: restored }),
      };
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
      let outliers: PlayerId[] | undefined;
      if (value.outliers !== undefined) {
        if (!Array.isArray(value.outliers)) {
          return null;
        }
        outliers = [];
        for (const entry of value.outliers) {
          if (!isPlayerId(entry)) {
            return null;
          }
          outliers.push(entry);
        }
      }
      return outliers === undefined
        ? { type: "desync", tick: value.tick, hashes }
        : { type: "desync", tick: value.tick, hashes, outliers };
    }
    case "resynced": {
      if (!isPlayerId(value.player) || !isTick(value.tick)) {
        return null;
      }
      return { type: "resynced", player: value.player, tick: value.tick };
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
      const players = asWorldPlayers(value.players);
      const world = asWorldInfo(value.world);
      if (settlements === null || players === null || world === null) {
        return null;
      }
      if (!isPlayerId(value.playerId) || !isKey(value.playerKey) || !isName(value.name)) {
        return null;
      }
      if (value.token !== undefined && !isToken(value.token)) {
        return null;
      }
      const base: ServerMessage = {
        type: "world_welcome",
        playerId: value.playerId,
        playerKey: value.playerKey,
        name: value.name,
        settlements,
        players,
        world,
      };
      return value.token === undefined ? base : { ...base, token: value.token };
    }
    case "world_settlements": {
      const settlements = asSettlements(value.settlements);
      return settlements === null ? null : { type: "world_settlements", settlements };
    }
    case "world_players": {
      const players = asWorldPlayers(value.players);
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
    case "world_caravans": {
      const caravans = asCaravans(value.caravans);
      if (caravans === null) {
        return null;
      }
      if (value.merchants === undefined) {
        return { type: "world_caravans", caravans };
      }
      const merchants = asMerchants(value.merchants);
      return merchants === null ? null : { type: "world_caravans", caravans, merchants };
    }
    case "caravan_arrive": {
      const manifest = asBytes(value.manifest);
      const summary = asCaravanSummary(value.summary);
      if (manifest === null || manifest.length === 0 || summary === null) {
        return null;
      }
      if (!isName(value.id) || !isTileId(value.tile)) {
        return null;
      }
      return { type: "caravan_arrive", id: value.id, tile: value.tile, manifest, summary };
    }
    case "trader_arrival": {
      if (!isName(value.merchantId) || !isName(value.merchantName) || !isTileId(value.tile)) {
        return null;
      }
      return {
        type: "trader_arrival",
        tile: value.tile,
        merchantId: value.merchantId,
        merchantName: value.merchantName,
      };
    }
    default:
      return null;
  }
}

/** Vrai si la version annoncée par un client est compatible. */
export function isCompatibleProtocol(version: number | undefined): boolean {
  return version === undefined || version === PROTOCOL_VERSION;
}
