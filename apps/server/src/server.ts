/**
 * Câblage WebSocket ↔ salles ↔ monde. Un `http.createServer` minimal sert
 * `GET /health`, `GET /world` et l'upgrade WebSocket sur le même port : pas de
 * framework.
 *
 * Le serveur ne connaît que quatre choses : quelle connexion appartient à
 * quelle salle et au monde, le heartbeat, la validation des trames entrantes,
 * et l'état du globe. Toute la logique de lockstep est dans `Room` et dans
 * `@rimlike/protocol` ; la géométrie du globe est dans `@rimlike/world`.
 *
 * Le globe est généré **une fois** au démarrage et son `WorldWire` sérialisé
 * est mis en cache : il ne change pas, les clients le téléchargent une fois.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { gzipSync } from "node:zlib";

import {
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  decodeClientMessage,
  encodeMessage,
  isCompatibleProtocol,
  type ClientMessage,
  type ErrorCode,
  type PlayerId,
  type WorldErrorCode,
} from "@rimlike/protocol";
import { WORLD_WIRE_VERSION, serializeWorld } from "@rimlike/world";
import { WebSocketServer, type WebSocket } from "ws";

import { Room, type RoomOptions } from "./room.js";
import {
  DEFAULT_WORLD_SEED,
  DEFAULT_WORLD_SUBDIVISIONS,
  WorldState,
  sharedWorld,
  tileFromRoomName,
} from "./world.js";

export interface ServerOptions {
  /** 0 pour un port éphémère (tests). Défaut : 8787. */
  readonly port?: number;
  readonly host?: string;
  readonly heartbeatMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  /** Options passées à chaque salle créée (horloge injectable, tailles). */
  readonly roomOptions?: Omit<RoomOptions, "name" | "log" | "tile" | "restore" | "onSnapshot">;
  /** Graine du globe. Défaut : `DEFAULT_WORLD_SEED`. */
  readonly worldSeed?: number;
  /** Subdivisions du globe. Défaut : `DEFAULT_WORLD_SUBDIVISIONS`. */
  readonly worldSubdivisions?: number;
}

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  readonly roomCount: number;
  /** État du monde : colonies et derniers snapshots connus. */
  readonly world: WorldState;
  room(name: string): Room | undefined;
  close(): Promise<void>;
}

interface Connection {
  readonly socket: WebSocket;
  room: Room | null;
  playerId: PlayerId | null;
  /** Nom du joueur dans le monde, `null` s'il n'a pas fait `world_join`. */
  worldName: string | null;
  /** Identifiant de monde, sans rapport avec les identifiants de salle. */
  worldPlayerId: PlayerId | null;
  lastSeen: number;
}

/** Messages traités au niveau de la connexion, avant toute salle. */
type WorldClientMessage = Extract<
  ClientMessage,
  { type: "world_join" | "settle" | "visit" | "abandon" | "world_leave" }
>;

function isWorldMessage(message: ClientMessage): message is WorldClientMessage {
  return (
    message.type === "world_join" ||
    message.type === "settle" ||
    message.type === "visit" ||
    message.type === "abandon" ||
    message.type === "world_leave"
  );
}

const DEFAULT_PORT = 8787;

/** Durée de cache de `GET /world`, en secondes. Le globe ne change pas. */
const WORLD_MAX_AGE_SECONDS = 3600;

/** Diagnostic d'un `settle` refusé (français, non destiné à l'affichage brut). */
function settleErrorText(code: "bad_tile" | "not_land" | "occupied", tile: number): string {
  switch (code) {
    case "bad_tile":
      return `la case ${tile} n'existe pas sur ce globe`;
    case "not_land":
      return `la case ${tile} n'est pas terrestre`;
    case "occupied":
      return `la case ${tile} est déjà colonisée`;
  }
}

/** Diagnostic d'un `abandon` refusé. */
function abandonErrorText(code: "bad_tile" | "not_settled" | "not_owner", tile: number): string {
  switch (code) {
    case "bad_tile":
      return `la case ${tile} n'existe pas sur ce globe`;
    case "not_settled":
      return `la case ${tile} n'est pas colonisée`;
    case "not_owner":
      return `la colonie de la case ${tile} appartient à quelqu'un d'autre`;
  }
}

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const rooms = new Map<string, Room>();
  const connections = new Set<Connection>();
  /** Connexions présentes dans le monde, dans leur ordre d'arrivée. */
  const worldMembers = new Set<Connection>();
  let nextWorldPlayerId: PlayerId = 1;

  const worldSeed = options.worldSeed ?? DEFAULT_WORLD_SEED;
  const worldSubdivisions = options.worldSubdivisions ?? DEFAULT_WORLD_SUBDIVISIONS;
  const globe = sharedWorld(worldSubdivisions, worldSeed);
  const worldState = new WorldState({ world: globe });
  const generatedAt = Date.now();

  /**
   * `GET /world` : le corps JSON, calculé à la première demande et gardé. La
   * sérialisation d'un globe à la subdivision 5 fait ~2,8 Mo, autant ne pas la
   * payer si personne ne la demande (les tests de salle, par exemple).
   */
  let worldBody: Buffer | null = null;
  let worldBodyGzip: Buffer | null = null;
  // L'ETag ne dépend que de ce qui détermine le globe : version du format,
  // graine, subdivision. Deux serveurs identiques servent donc le même ETag.
  const worldEtag = `"world-${WORLD_WIRE_VERSION}-${worldSeed}-${worldSubdivisions}"`;

  const worldPayload = (): Buffer => {
    if (worldBody === null) {
      const payload = {
        seed: worldSeed,
        subdivisions: worldSubdivisions,
        generatedAt,
        wire: serializeWorld(globe),
      };
      worldBody = Buffer.from(JSON.stringify(payload), "utf8");
      log(`[monde] WorldWire sérialisé : ${worldBody.length} octets pour ${globe.tiles.length} cases`);
    }
    return worldBody;
  };

  const worldPayloadGzip = (): Buffer => {
    if (worldBodyGzip === null) {
      worldBodyGzip = gzipSync(worldPayload());
      log(`[monde] WorldWire gzippé : ${worldBodyGzip.length} octets`);
    }
    return worldBodyGzip;
  };

  const serveWorld = (request: IncomingMessage, response: ServerResponse): void => {
    const headers: Record<string, string> = {
      "content-type": "application/json; charset=utf-8",
      etag: worldEtag,
      "cache-control": `public, max-age=${WORLD_MAX_AGE_SECONDS}`,
      // Le corps change avec l'encodage, pas l'ETag : un cache partagé doit
      // distinguer les deux variantes.
      vary: "Accept-Encoding",
    };
    if (request.headers["if-none-match"] === worldEtag) {
      response.writeHead(304, headers);
      response.end();
      return;
    }
    const acceptsGzip = /(^|[\s,])gzip([\s,;]|$)/.test(request.headers["accept-encoding"] ?? "");
    const body = acceptsGzip ? worldPayloadGzip() : worldPayload();
    if (acceptsGzip) {
      headers["content-encoding"] = "gzip";
    }
    headers["content-length"] = String(body.length);
    response.writeHead(200, headers);
    response.end(body);
  };

  const httpServer = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0];
    if (request.method === "GET" && path === "/health") {
      const body = JSON.stringify({
        ok: true,
        rooms: rooms.size,
        world: {
          seed: worldState.seed,
          subdivisions: worldState.subdivisions,
          tiles: worldState.tileCount,
          settlements: worldState.settlementCount,
        },
      });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(body);
      return;
    }
    if (request.method === "GET" && path === "/world") {
      serveWorld(request, response);
      return;
    }
    response.writeHead(404, { "content-type": "application/json; charset=utf-8" });
    response.end(JSON.stringify({ ok: false }));
  });

  const wss = new WebSocketServer({ server: httpServer });

  const send = (socket: WebSocket, text: string): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(text);
    }
  };

  const fail = (socket: WebSocket, code: ErrorCode | WorldErrorCode, message: string): void => {
    send(socket, encodeMessage({ type: "error", code, message }));
  };

  const worldFail = (socket: WebSocket, code: WorldErrorCode, message: string): void => {
    send(socket, encodeMessage({ type: "world_error", code, message }));
  };

  const dropRoomIfEmpty = (room: Room): void => {
    if (room.isEmpty) {
      room.stop();
      rooms.delete(room.name);
      // Le snapshot conservé de la salle, lui, survit : c'est ce qui permet de
      // rouvrir la colonie plus tard.
      log(`[${room.name}] salle détruite — ${rooms.size} salle(s) active(s)`);
    }
  };

  const worldPlayerNames = (): string[] =>
    [...worldMembers].map((member) => member.worldName ?? "").filter((name) => name.length > 0);

  const broadcastWorld = (text: string): void => {
    for (const member of worldMembers) {
      send(member.socket, text);
    }
  };

  const broadcastSettlements = (): void => {
    broadcastWorld(encodeMessage({ type: "world_settlements", settlements: worldState.list() }));
  };

  const broadcastWorldPlayers = (): void => {
    broadcastWorld(encodeMessage({ type: "world_players", players: worldPlayerNames() }));
  };

  const leaveWorld = (connection: Connection): void => {
    if (!worldMembers.delete(connection)) {
      return;
    }
    log(`[monde] ${connection.worldName ?? "?"} quitte le monde — ${worldMembers.size} présent(s)`);
    connection.worldName = null;
    connection.worldPlayerId = null;
    broadcastWorldPlayers();
  };

  /**
   * Actions de monde. Elles vivent au niveau de la connexion : un joueur peut
   * être dans le monde sans salle, dans une salle sans monde, ou les deux.
   */
  const handleWorldMessage = (connection: Connection, message: WorldClientMessage): void => {
    const socket = connection.socket;
    if (message.type === "world_join") {
      if (connection.worldName !== null) {
        fail(socket, "already_joined", "déjà connecté au monde");
        return;
      }
      if (!isCompatibleProtocol(message.protocol)) {
        fail(socket, "version_mismatch", "version de protocole incompatible");
        socket.close();
        return;
      }
      connection.worldName = message.name;
      connection.worldPlayerId = nextWorldPlayerId++;
      worldMembers.add(connection);
      send(
        socket,
        encodeMessage({
          type: "world_welcome",
          playerId: connection.worldPlayerId,
          name: message.name,
          settlements: worldState.list(),
          players: worldPlayerNames(),
          world: {
            seed: worldState.seed,
            subdivisions: worldState.subdivisions,
            tiles: worldState.tileCount,
          },
        }),
      );
      log(`[monde] ${message.name} rejoint le monde — ${worldMembers.size} présent(s)`);
      broadcastWorldPlayers();
      return;
    }

    const name = connection.worldName;
    if (name === null) {
      worldFail(socket, "not_in_world", "envoyer d'abord `world_join`");
      return;
    }

    switch (message.type) {
      case "world_leave":
        leaveWorld(connection);
        return;
      case "settle": {
        const result = worldState.settle(message.tile, name);
        if (!result.ok) {
          worldFail(socket, result.code, settleErrorText(result.code, message.tile));
          return;
        }
        const settlement = result.settlement;
        send(
          socket,
          encodeMessage({
            type: "settled",
            tile: settlement.tile,
            room: settlement.room,
            seed: settlement.seed,
          }),
        );
        log(`[monde] ${name} fonde une colonie sur la case ${settlement.tile} (salle ${settlement.room})`);
        broadcastSettlements();
        return;
      }
      case "visit": {
        if (!worldState.hasTile(message.tile)) {
          worldFail(socket, "bad_tile", `la case ${message.tile} n'existe pas sur ce globe`);
          return;
        }
        const settlement = worldState.settlementAt(message.tile);
        if (settlement === undefined) {
          worldFail(socket, "not_settled", `la case ${message.tile} n'est pas colonisée`);
          return;
        }
        send(
          socket,
          encodeMessage({
            type: "settled",
            tile: settlement.tile,
            room: settlement.room,
            seed: settlement.seed,
          }),
        );
        log(`[monde] ${name} visite la case ${settlement.tile} de ${settlement.owner}`);
        return;
      }
      case "abandon": {
        const result = worldState.abandon(message.tile, name);
        if (!result.ok) {
          worldFail(socket, result.code, abandonErrorText(result.code, message.tile));
          return;
        }
        log(`[monde] ${name} abandonne la case ${message.tile}`);
        broadcastSettlements();
        return;
      }
    }
  };

  /**
   * Crée la salle `name`. Un nom qui désigne une case du globe (`tile-<id>`)
   * donne une salle « case » : graine imposée par la case, snapshots de
   * conservation, et réouverture depuis le dernier état connu s'il y en a un.
   *
   * Renvoie `null` si le nom désigne une case qui n'est pas colonisée : le
   * préfixe est réservé, on ne laisse pas squatter le nom d'une future colonie
   * avec une salle ordinaire.
   */
  const createRoom = (name: string): Room | null => {
    const tileId = tileFromRoomName(name);
    if (tileId === null) {
      return new Room({ name, log, ...options.roomOptions });
    }
    const settlement = worldState.settlementAt(tileId);
    if (settlement === undefined) {
      return null;
    }
    const snapshot = worldState.snapshotFor(name);
    return new Room({
      name,
      log,
      ...options.roomOptions,
      tile: { id: tileId, seed: settlement.seed },
      ...(snapshot !== undefined
        ? {
            restore: {
              tick: snapshot.tick,
              data: snapshot.data,
              width: snapshot.width,
              height: snapshot.height,
            },
          }
        : {}),
      onSnapshot: (report) => {
        worldState.saveSnapshot(name, report);
      },
    });
  };

  wss.on("connection", (socket: WebSocket) => {
    const connection: Connection = {
      socket,
      room: null,
      playerId: null,
      worldName: null,
      worldPlayerId: null,
      lastSeen: Date.now(),
    };
    connections.add(connection);

    socket.on("message", (data: unknown) => {
      connection.lastSeen = Date.now();
      const message = decodeClientMessage(String(data));
      if (message === null) {
        fail(socket, "bad_message", "trame illisible ou champ invalide");
        return;
      }
      if (message.type === "pong") {
        return;
      }
      if (isWorldMessage(message)) {
        handleWorldMessage(connection, message);
        return;
      }
      if (connection.room === null || connection.playerId === null) {
        if (message.type === "ping") {
          send(socket, encodeMessage({ type: "pong" }));
          return;
        }
        if (message.type !== "join") {
          fail(socket, "not_joined", "envoyer d'abord `join`");
          return;
        }
        if (!isCompatibleProtocol(message.protocol)) {
          fail(socket, "version_mismatch", "version de protocole incompatible");
          socket.close();
          return;
        }
        let room = rooms.get(message.room);
        if (room === undefined) {
          const created = createRoom(message.room);
          if (created === null) {
            fail(socket, "not_settled", `la salle ${message.room} n'est pas une case colonisée`);
            return;
          }
          room = created;
          rooms.set(message.room, room);
          log(`[${message.room}] salle créée — ${rooms.size} salle(s) active(s)`);
        }
        const playerId = room.join(message.name, (text) => send(socket, text));
        if (playerId === null) {
          fail(socket, "room_full", "salle pleine");
          dropRoomIfEmpty(room);
          socket.close();
          return;
        }
        connection.room = room;
        connection.playerId = playerId;
        return;
      }
      if (message.type === "join") {
        fail(socket, "already_joined", "une connexion ne rejoint qu'une salle");
        return;
      }
      connection.room.handle(connection.playerId, message);
    });

    const disconnect = (): void => {
      if (!connections.delete(connection)) {
        return;
      }
      leaveWorld(connection);
      const { room, playerId } = connection;
      if (room !== null && playerId !== null) {
        room.leave(playerId);
        dropRoomIfEmpty(room);
      }
    };

    socket.on("close", disconnect);
    socket.on("error", disconnect);
  });

  const heartbeat = setInterval(() => {
    const now = Date.now();
    for (const connection of connections) {
      if (now - connection.lastSeen > timeoutMs) {
        log(`[heartbeat] connexion silencieuse depuis ${now - connection.lastSeen} ms, fermée`);
        connection.socket.terminate();
        continue;
      }
      send(connection.socket, encodeMessage({ type: "ping" }));
    }
  }, heartbeatMs);
  heartbeat.unref?.();

  await new Promise<void>((resolve, reject) => {
    httpServer.once("error", reject);
    httpServer.listen(options.port ?? DEFAULT_PORT, options.host, () => {
      httpServer.removeListener("error", reject);
      resolve();
    });
  });

  const address = httpServer.address() as AddressInfo;
  const port = address.port;

  log(
    `[monde] globe généré — seed ${worldSeed}, subdivision ${worldSubdivisions}, ${globe.tiles.length} cases`,
  );

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
    world: worldState,
    get roomCount(): number {
      return rooms.size;
    },
    room(name: string): Room | undefined {
      return rooms.get(name);
    },
    async close(): Promise<void> {
      clearInterval(heartbeat);
      for (const room of rooms.values()) {
        room.stop();
      }
      rooms.clear();
      worldMembers.clear();
      for (const connection of connections) {
        connection.socket.terminate();
      }
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
