/**
 * Câblage WebSocket ↔ salles. Un `http.createServer` minimal sert `GET /health`
 * et l'upgrade WebSocket sur le même port : pas de framework.
 *
 * Le serveur ne connaît que trois choses : quelle connexion appartient à quelle
 * salle, le heartbeat, et la validation des trames entrantes. Toute la logique
 * de lockstep est dans `Room` et dans `@rimlike/protocol`.
 */

import { createServer as createHttpServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";

import {
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  decodeClientMessage,
  encodeMessage,
  isCompatibleProtocol,
  type ErrorCode,
  type PlayerId,
} from "@rimlike/protocol";
import { WebSocketServer, type WebSocket } from "ws";

import { Room, type RoomOptions } from "./room.js";

export interface ServerOptions {
  /** 0 pour un port éphémère (tests). Défaut : 8787. */
  readonly port?: number;
  readonly host?: string;
  readonly heartbeatMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  /** Options passées à chaque salle créée (horloge injectable, tailles). */
  readonly roomOptions?: Omit<RoomOptions, "name" | "log">;
}

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  readonly roomCount: number;
  room(name: string): Room | undefined;
  close(): Promise<void>;
}

interface Connection {
  readonly socket: WebSocket;
  room: Room | null;
  playerId: PlayerId | null;
  lastSeen: number;
}

const DEFAULT_PORT = 8787;

export async function startServer(options: ServerOptions = {}): Promise<RunningServer> {
  const log = options.log ?? ((line: string) => console.log(line));
  const heartbeatMs = options.heartbeatMs ?? HEARTBEAT_MS;
  const timeoutMs = options.timeoutMs ?? HEARTBEAT_TIMEOUT_MS;
  const rooms = new Map<string, Room>();
  const connections = new Set<Connection>();

  const httpServer = createHttpServer((request: IncomingMessage, response: ServerResponse) => {
    const path = (request.url ?? "/").split("?")[0];
    if (request.method === "GET" && path === "/health") {
      const body = JSON.stringify({ ok: true, rooms: rooms.size });
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(body);
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

  const fail = (socket: WebSocket, code: ErrorCode, message: string): void => {
    send(socket, encodeMessage({ type: "error", code, message }));
  };

  const dropRoomIfEmpty = (room: Room): void => {
    if (room.isEmpty) {
      room.stop();
      rooms.delete(room.name);
      log(`[${room.name}] salle détruite — ${rooms.size} salle(s) active(s)`);
    }
  };

  wss.on("connection", (socket: WebSocket) => {
    const connection: Connection = { socket, room: null, playerId: null, lastSeen: Date.now() };
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
          room = new Room({ name: message.room, log, ...options.roomOptions });
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

  return {
    port,
    url: `ws://127.0.0.1:${port}`,
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
      for (const connection of connections) {
        connection.socket.terminate();
      }
      connections.clear();
      await new Promise<void>((resolve) => wss.close(() => resolve()));
      await new Promise<void>((resolve) => httpServer.close(() => resolve()));
    },
  };
}
