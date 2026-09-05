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
  CARAVAN_TICK_MS,
  HEARTBEAT_MS,
  HEARTBEAT_TIMEOUT_MS,
  MAX_PLAYERS,
  decodeClientMessage,
  encodeMessage,
  isCompatibleProtocol,
  type Caravan,
  type ClientMessage,
  type ErrorCode,
  type PlayerId,
  type WorldErrorCode,
  type WorldPlayerInfo,
} from "@rimlike/protocol";
import { WORLD_WIRE_VERSION, serializeWorld } from "@rimlike/world";
import { WebSocketServer, type WebSocket } from "ws";

import { WorldStore } from "./persistence.js";
import { Room, type RoomOptions } from "./room.js";
import {
  DEFAULT_WORLD_SEED,
  DEFAULT_WORLD_SUBDIVISIONS,
  WorldState,
  sharedWorld,
  tileFromRoomName,
  tileRoomName,
} from "./world.js";

export interface ServerOptions {
  /** 0 pour un port éphémère (tests). Défaut : 8787. */
  readonly port?: number;
  readonly host?: string;
  readonly heartbeatMs?: number;
  readonly timeoutMs?: number;
  readonly log?: (line: string) => void;
  /** Options passées à chaque salle créée (horloge injectable, tailles). */
  readonly roomOptions?: Omit<
    RoomOptions,
    "name" | "log" | "tile" | "restore" | "onSnapshot" | "onHostReady"
  >;
  /**
   * Durée réelle d'une heure de jeu du monde, en millisecondes. Défaut :
   * `WORLD_HOUR_MS` (30 s). `index.ts` la résout depuis `WORLD_HOUR_MS` ; les
   * tests la raccourcissent pour voyager vite.
   */
  readonly worldHourMs?: number;
  /**
   * Horloge murale du monde (dates de fondation, d'enregistrement, et surtout
   * l'horloge de jeu). Défaut : `Date.now`. Injectable pour piloter le temps
   * depuis un test — c'est ce qui permet de vérifier au tick près le
   * `frozenTicks` d'une colonie rouverte.
   */
  readonly worldNow?: () => number;
  /**
   * Période du tick du monde : avancement des caravanes et diffusion de
   * `world_caravans`. Défaut : `CARAVAN_TICK_MS` (5 s).
   */
  readonly caravanTickMs?: number;
  /**
   * Démarre le tick du monde. Défaut : `setInterval` non bloquant pour le
   * processus. Injectable pour piloter le temps depuis un test.
   */
  readonly startWorldClock?: (onTick: () => void, intervalMs: number) => () => void;
  /** Graine du globe. Défaut : `DEFAULT_WORLD_SEED`. */
  readonly worldSeed?: number;
  /** Subdivisions du globe. Défaut : `DEFAULT_WORLD_SUBDIVISIONS`. */
  readonly worldSubdivisions?: number;
  /**
   * Fichier où persister `WorldState` (colonies, snapshots de conservation).
   * Omis, `null` ou vide : mode mémoire, sans aucune écriture disque — c'est
   * le défaut, y compris pour tous les tests qui ne précisent pas ce champ.
   * `index.ts` le résout depuis `WORLD_STATE_FILE`/`WORLD_PERSIST` avant
   * d'appeler `startServer` ; ce module ne lit jamais l'environnement lui-même.
   */
  readonly worldStateFile?: string | null;
  /** Délai de débounce des sauvegardes, injectable pour les tests. Défaut : `SAVE_DEBOUNCE_MS`. */
  readonly saveDebounceMs?: number;

  // --- Garde-fous avant hébergement public (`docs/protocol.md` §2, « Limites ») ---

  /**
   * Taille maximale d'un message texte, en octets UTF-8, sauf `snapshot` (voir
   * `maxSnapshotBytes`). Dépassement : `error { code: "message_too_large" }`
   * puis fermeture (code WebSocket 1009). Défaut : 262 144 (256 Kio).
   */
  readonly maxMessageBytes?: number;
  /**
   * Taille maximale d'un message `snapshot`, en octets UTF-8 — plus généreuse
   * que `maxMessageBytes` car elle transporte l'état d'une carte entière en
   * base64. `maxPayload` du `WebSocketServer` est réglé au plus grand des deux
   * pour ne jamais couper un snapshot légitime avant que ce garde-fou ne le
   * voie. Défaut : 8 388 608 (8 Mio).
   */
  readonly maxSnapshotBytes?: number;
  /**
   * Messages tolérés par connexion sur une fenêtre glissante d'une seconde
   * (le `pong` ne compte pas). Au-delà : `error { code: "rate_limited" }` ; si
   * le dépassement persiste sans interruption pendant 3 s, la connexion est
   * fermée. Défaut : 120.
   */
  readonly maxMessagesPerSecond?: number;
  /**
   * Connexions simultanées tolérées pour une même adresse IP. Au-delà, la
   * connexion est refusée dès l'upgrade WebSocket (HTTP 429). Défaut : 16.
   */
  readonly maxConnectionsPerIp?: number;
  /**
   * Salles simultanées tolérées sur ce serveur (salles ordinaires et salles
   * « case » confondues). Un `join`/`settle` qui en créerait une de plus est
   * refusé avec `error { code: "server_full" }`. Défaut : 500.
   */
  readonly maxRooms?: number;
  /**
   * Fait confiance à l'en-tête `X-Forwarded-For` pour identifier l'adresse
   * d'un client (derrière un reverse proxy) plutôt qu'à
   * `req.socket.remoteAddress`. Défaut : faux — à n'activer que si le serveur
   * est bien derrière un proxy de confiance qui pose cet en-tête lui-même,
   * sans quoi un client peut usurper l'adresse d'un autre.
   */
  readonly trustProxy?: boolean;
}

export interface RunningServer {
  readonly port: number;
  readonly url: string;
  readonly roomCount: number;
  /** État du monde : colonies et derniers snapshots connus. */
  readonly world: WorldState;
  /** État de la persistance disque : le même contenu que `GET /health`. */
  readonly persistence: { readonly enabled: boolean; readonly file: string | null; readonly lastSavedAt: number | null };
  room(name: string): Room | undefined;
  close(): Promise<void>;
}

interface Connection {
  readonly socket: WebSocket;
  room: Room | null;
  playerId: PlayerId | null;
  /**
   * Nom envoyé dans le `join { room, name }` de cette connexion, `null` si
   * elle n'a rejoint aucune salle. Sert au repli v1 par nom (docs/protocol.md
   * §12.3) : une connexion de salle qui n'a pas fait `world_join` ne porte pas
   * de clé, on compare alors ce nom au nom d'affichage du joueur monde.
   */
  roomJoinName: string | null;
  /** Libellé du joueur dans le monde, `null` s'il n'a pas fait `world_join`. */
  worldName: string | null;
  /**
   * Clé publique et stable du joueur dans le monde (`WorldPlayer.key`), `null`
   * hors monde. C'est elle, jamais `worldName`, qui identifie le propriétaire
   * d'une colonie ou d'une caravane (`docs/protocol.md` §11.2).
   */
  worldPlayerKey: string | null;
  /** Identifiant de monde, sans rapport avec les identifiants de salle. */
  worldPlayerId: PlayerId | null;
  lastSeen: number;
  /** Adresse résolue à l'upgrade (`resolveClientIp`), pour le compteur par IP. */
  readonly ip: string;
  /** Horodatages des derniers messages comptés pour le débit (`pong` exclu). */
  messageTimestamps: number[];
  /** Depuis quand le débit est dépassé sans interruption, `null` sinon. */
  overLimitSince: number | null;
}

/** Messages traités au niveau de la connexion, avant toute salle. */
type WorldClientMessage = Extract<
  ClientMessage,
  {
    type:
      | "world_join"
      | "settle"
      | "visit"
      | "abandon"
      | "world_leave"
      | "caravan_depart"
      | "caravan_cancel"
      | "caravan_delivered";
  }
>;

function isWorldMessage(message: ClientMessage): message is WorldClientMessage {
  return (
    message.type === "world_join" ||
    message.type === "settle" ||
    message.type === "visit" ||
    message.type === "abandon" ||
    message.type === "world_leave" ||
    message.type === "caravan_depart" ||
    message.type === "caravan_cancel" ||
    message.type === "caravan_delivered"
  );
}

const DEFAULT_PORT = 8787;

/** Durée de cache de `GET /world`, en secondes. Le globe ne change pas. */
const WORLD_MAX_AGE_SECONDS = 3600;

// --- Garde-fous avant hébergement public (`docs/protocol.md` §2, « Limites ») ---

// Exportées : `index.ts` en a besoin comme défauts de `readInteger`, seule
// source de vérité plutôt que des nombres recopiés à la main.
export const DEFAULT_MAX_MESSAGE_BYTES = 262_144;
export const DEFAULT_MAX_SNAPSHOT_BYTES = 8_388_608;
export const DEFAULT_MAX_MESSAGES_PER_SECOND = 120;
export const DEFAULT_MAX_CONNECTIONS_PER_IP = 16;
export const DEFAULT_MAX_ROOMS = 500;

/** Fenêtre glissante du limiteur de débit. */
const RATE_WINDOW_MS = 1000;
/** Dépassement soutenu sans interruption avant fermeture de la connexion. */
const RATE_CLOSE_AFTER_MS = 3000;
/** Longueur maximale d'un nom affiché (plus stricte que `isName` du codec, qui autorise 64). */
const MAX_DISPLAY_NAME_LENGTH = 32;
/** Caractères de contrôle C0 et DEL : interdits dans un nom affiché. */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** Codes de fermeture WebSocket utilisés par les garde-fous (RFC 6455). */
const CLOSE_MESSAGE_TOO_LARGE = 1009;
/** 1008 : violation de politique — utilisé pour un dépassement de débit soutenu. */
const CLOSE_RATE_LIMITED = 1008;

/**
 * Codes d'erreur ajoutés par les garde-fous, en plus de ceux de
 * `@rimlike/protocol` (`ErrorCode`/`WorldErrorCode`) : la liste de codes est
 * ouverte (`ErrorMessage.code`/`WorldErrorMessage.code` sont de simples
 * chaînes), ajouter ceux-ci n'est donc pas un changement de protocole.
 */
type GuardErrorCode = "message_too_large" | "rate_limited" | "server_full" | "bad_name";
// `fail` sert aussi à refuser un `join` sur une salle « case » non colonisée
// (`not_settled`, un `WorldErrorCode`) : le code hérite donc des deux unions,
// comme avant l'ajout des garde-fous.
type ServerErrorCode = ErrorCode | WorldErrorCode | GuardErrorCode;
type WorldServerErrorCode = WorldErrorCode | GuardErrorCode;

/** Vrai si `name` respecte la longueur et l'absence de caractères de contrôle exigées. */
function isValidDisplayName(name: string): boolean {
  return name.length > 0 && name.length <= MAX_DISPLAY_NAME_LENGTH && !CONTROL_CHARS.test(name);
}

/**
 * Adresse d'une connexion entrante : `req.socket.remoteAddress`, ou le premier
 * élément de `X-Forwarded-For` si `trustProxy` est vrai (un serveur qui n'est
 * pas derrière un reverse proxy de confiance ne doit jamais lire cet en-tête,
 * un client pourrait y mettre n'importe quoi).
 */
function resolveClientIp(request: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const forwarded = request.headers["x-forwarded-for"];
    const raw = Array.isArray(forwarded) ? forwarded[0] : forwarded;
    if (raw !== undefined) {
      const first = raw.split(",")[0]!.trim();
      if (first.length > 0) {
        return first;
      }
    }
  }
  return request.socket.remoteAddress ?? "inconnue";
}

/**
 * Lit juste le champ `type` d'une trame, sans validation complète : sert à
 * choisir la bonne limite de taille (`snapshot` a droit à plus) avant même de
 * savoir si le message est par ailleurs valide.
 */
function sniffMessageType(text: string): string | null {
  try {
    const parsed: unknown = JSON.parse(text);
    if (parsed !== null && typeof parsed === "object" && typeof (parsed as Record<string, unknown>).type === "string") {
      return (parsed as Record<string, unknown>).type as string;
    }
  } catch {
    // Trame illisible : `decodeClientMessage` la refusera de toute façon
    // (`bad_message`), la limite générale s'applique ici.
  }
  return null;
}

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

/** Diagnostic d'un ordre de caravane refusé. */
function caravanErrorText(code: WorldErrorCode): string {
  switch (code) {
    case "bad_tile":
      return "une des deux cases n'existe pas sur ce globe";
    case "caravan_same_tile":
      return "une caravane doit partir vers une autre case";
    case "caravan_no_route":
      return "aucun itinéraire terrestre entre ces deux cases (l'océan est infranchissable)";
    case "caravan_not_found":
      return "caravane inconnue, ou dans un état qui ne se prête pas à cette action";
    case "not_owner":
      return "cette caravane appartient à quelqu'un d'autre";
    case "caravan_too_late":
      return "la caravane a passé la moitié de son trajet, elle ne fait plus demi-tour";
    default:
      return "ordre de caravane refusé";
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

  // --- Garde-fous avant hébergement public (`docs/protocol.md` §2, « Limites ») ---
  const maxMessageBytes = options.maxMessageBytes ?? DEFAULT_MAX_MESSAGE_BYTES;
  const maxSnapshotBytes = options.maxSnapshotBytes ?? DEFAULT_MAX_SNAPSHOT_BYTES;
  const maxMessagesPerSecond = options.maxMessagesPerSecond ?? DEFAULT_MAX_MESSAGES_PER_SECOND;
  const maxConnectionsPerIp = options.maxConnectionsPerIp ?? DEFAULT_MAX_CONNECTIONS_PER_IP;
  const maxRooms = options.maxRooms ?? DEFAULT_MAX_ROOMS;
  const trustProxy = options.trustProxy ?? false;
  const maxPlayersPerRoom = options.roomOptions?.maxPlayers ?? MAX_PLAYERS;
  /** Connexions ouvertes par adresse IP, pour `maxConnectionsPerIp`. */
  const ipConnectionCounts = new Map<string, number>();

  const worldSeed = options.worldSeed ?? DEFAULT_WORLD_SEED;
  const worldSubdivisions = options.worldSubdivisions ?? DEFAULT_WORLD_SUBDIVISIONS;
  const globe = sharedWorld(worldSubdivisions, worldSeed);

  // Persistance disque : désactivée par défaut (mode mémoire), y compris pour
  // tous les tests qui ne précisent pas `worldStateFile`. Voir `persistence.ts`.
  const worldStateFile = options.worldStateFile ?? null;
  const persistenceEnabled = worldStateFile !== null && worldStateFile !== "";
  const store = persistenceEnabled
    ? new WorldStore({
        file: worldStateFile,
        worldSeed,
        subdivisions: worldSubdivisions,
        debounceMs: options.saveDebounceMs,
      })
    : null;

  // Horloge de jeu du globe : c'est elle qui fait voyager les caravanes. Elle
  // reprend son compte au redémarrage (`WorldClock`), le monde ne vieillit pas
  // serveur éteint.
  const worldHourMs = options.worldHourMs;
  const caravanTickMs = options.caravanTickMs ?? CARAVAN_TICK_MS;
  const clockOptions = {
    ...(worldHourMs === undefined ? {} : { hourMs: worldHourMs }),
    ...(options.worldNow === undefined ? {} : { now: options.worldNow }),
  };

  let worldState: WorldState;
  if (store !== null) {
    const loaded = await store.load(globe, clockOptions);
    if (loaded.kind === "loaded") {
      worldState = loaded.state;
      log(
        `[monde] état rechargé depuis ${worldStateFile} — ${worldState.settlementCount} colonie(s), ` +
          `${worldState.snapshotCount} snapshot(s) conservé(s), ${worldState.caravans.count} caravane(s), ` +
          `horloge à ${worldState.hours.toFixed(1)} h de jeu`,
      );
    } else {
      worldState = new WorldState({ world: globe, ...clockOptions });
      if (loaded.kind === "ignored") {
        log(`[monde] fichier d'état ignoré (${loaded.reason}) — le monde repart à vide, voir le détail sur stderr`);
      }
    }
  } else {
    worldState = new WorldState({ world: globe, ...clockOptions });
  }
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
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Expose-Headers": "ETag, Content-Encoding",
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
        connections: connections.size,
        world: {
          seed: worldState.seed,
          subdivisions: worldState.subdivisions,
          tiles: worldState.tileCount,
          settlements: worldState.settlementCount,
        },
        // Valeurs effectives des garde-fous (`docs/protocol.md` §2, « Limites ») :
        // ce qu'un opérateur voit ici est ce qui s'applique réellement, options
        // injectées par les tests comprises.
        limits: {
          maxMessageBytes,
          maxSnapshotBytes,
          maxMessagesPerSecond,
          maxConnectionsPerIp,
          maxRooms,
          maxPlayersPerRoom,
        },
        persistence: {
          enabled: persistenceEnabled,
          file: persistenceEnabled ? worldStateFile : null,
          lastSavedAt: store?.lastSavedAt ?? null,
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

  const wss = new WebSocketServer({
    server: httpServer,
    // Au plus grand des deux : un `snapshot` légitime, sous `maxSnapshotBytes`,
    // ne doit jamais être coupé par `ws` avant que notre propre garde-fou de
    // taille (plus fin, il distingue `snapshot` du reste) ne le voie.
    maxPayload: Math.max(maxMessageBytes, maxSnapshotBytes),
    verifyClient: (info: { req: IncomingMessage }, callback: (verified: boolean, code?: number, message?: string) => void) => {
      const ip = resolveClientIp(info.req, trustProxy);
      const count = ipConnectionCounts.get(ip) ?? 0;
      if (count >= maxConnectionsPerIp) {
        log(`[connexions] upgrade refusé (429) pour ${ip} — ${count} déjà ouverte(s), limite ${maxConnectionsPerIp}`);
        callback(false, 429, "too_many_connections");
        return;
      }
      callback(true);
    },
  });

  const send = (socket: WebSocket, text: string): void => {
    if (socket.readyState === socket.OPEN) {
      socket.send(text);
    }
  };

  const fail = (socket: WebSocket, code: ServerErrorCode, message: string): void => {
    send(socket, encodeMessage({ type: "error", code, message }));
  };

  const worldFail = (socket: WebSocket, code: WorldServerErrorCode, message: string): void => {
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

  /**
   * Tous les joueurs déjà vus par le monde, avec qui est présentement
   * connecté (`docs/protocol.md` §11.2) : la table `{ key, name, online }[]`
   * diffusée par `world_welcome` et `world_players`.
   */
  const worldPlayerInfos = (): WorldPlayerInfo[] => {
    const online = new Set<string>();
    for (const member of worldMembers) {
      if (member.worldPlayerKey !== null) {
        online.add(member.worldPlayerKey);
      }
    }
    return worldState.listPlayers().map((player) => ({
      key: player.key,
      name: player.name,
      online: online.has(player.key),
    }));
  };

  const broadcastWorld = (text: string): void => {
    for (const member of worldMembers) {
      send(member.socket, text);
    }
  };

  const broadcastSettlements = (): void => {
    broadcastWorld(encodeMessage({ type: "world_settlements", settlements: worldState.list() }));
  };

  const broadcastWorldPlayers = (): void => {
    broadcastWorld(encodeMessage({ type: "world_players", players: worldPlayerInfos() }));
  };

  // --- Caravanes ---
  //
  // `world_caravans` est diffusé à chaque changement, mais au plus une fois
  // par `caravanTickMs` : un changement trop rapproché du précédent envoi
  // attend le prochain tick du monde, qui le portera avec l'avancement.

  let caravansDirty = false;
  let lastCaravanBroadcast = Number.NEGATIVE_INFINITY;

  const broadcastCaravans = (): void => {
    caravansDirty = false;
    lastCaravanBroadcast = Date.now();
    broadcastWorld(encodeMessage({ type: "world_caravans", caravans: worldState.caravans.list() }));
  };

  const caravansChanged = (): void => {
    if (Date.now() - lastCaravanBroadcast >= caravanTickMs) {
      broadcastCaravans();
    } else {
      caravansDirty = true;
    }
  };

  /**
   * Vrai si le joueur monde (clé `key`, nom d'affichage `name`) est présent
   * dans la salle `roomName` par n'importe laquelle de ses connexions
   * (docs/protocol.md §12.3) : une connexion de salle qui a fait `world_join`
   * (avec le jeton) porte une clé, comparée directement ; sinon on compare son
   * nom de salle (`join.name`) au nom d'affichage du joueur monde, en repli
   * v1. Couvre aussi bien le chemin actuel (la connexion émettrice est
   * elle-même dans la salle, donc trouvée par sa propre clé) que le nouveau
   * (une connexion monde distincte, dont le joueur est dans la salle par une
   * autre connexion).
   */
  const isPresentInRoom = (roomName: string, key: string, name: string): boolean => {
    for (const other of connections) {
      if (other.room === null || other.room.name !== roomName) {
        continue;
      }
      if (other.worldPlayerKey !== null) {
        if (other.worldPlayerKey === key) {
          return true;
        }
      } else if (other.roomJoinName === name) {
        return true;
      }
    }
    return false;
  };

  /**
   * Vrai si le joueur monde (clé `key`, nom `name`) est l'hôte de la salle
   * `roomName`, avec la même règle de présence (clé, ou nom en repli) que
   * `isPresentInRoom`, appliquée à la seule connexion hôte.
   */
  const isHostOfRoom = (roomName: string, key: string, name: string): boolean => {
    const room = rooms.get(roomName);
    if (room === undefined || room.host === null) {
      return false;
    }
    for (const other of connections) {
      if (other.room !== room || other.playerId !== room.host) {
        continue;
      }
      return other.worldPlayerKey !== null ? other.worldPlayerKey === key : other.roomJoinName === name;
    }
    return false;
  };

  /**
   * Remet à l'hôte d'une salle les arrivées que personne n'a encore confirmées.
   * Sans hôte, ou tant que la salle est en `lobby` (pas de carte, donc rien où
   * injecter le convoi), l'arrivée attend : elle repartira au prochain
   * `onHostReady`. Envoyée sur la connexion de salle de l'hôte **et**, si elle
   * existe, sur sa connexion monde séparée (même clé, ou même nom en repli) :
   * le client ignore les doublons par `id` (docs/protocol.md §12.3).
   */
  const deliverArrivals = (roomName: string): void => {
    const room = rooms.get(roomName);
    const tileId = tileFromRoomName(roomName);
    if (room === undefined || tileId === null || room.state === "lobby") {
      return;
    }
    const hostId = room.host;
    let hostConnection: Connection | undefined;
    if (hostId !== null) {
      for (const candidate of connections) {
        if (candidate.room === room && candidate.playerId === hostId) {
          hostConnection = candidate;
          break;
        }
      }
    }
    for (const arrival of worldState.caravans.pendingArrivals(tileId)) {
      if (room.sendToHost({ type: "caravan_arrive", ...arrival })) {
        log(`[monde] caravane ${arrival.id} proposée à l'hôte de ${roomName}`);
      }
      if (hostConnection === undefined) {
        continue;
      }
      for (const member of worldMembers) {
        if (member === hostConnection) {
          continue;
        }
        const sameKey = hostConnection.worldPlayerKey !== null && member.worldPlayerKey === hostConnection.worldPlayerKey;
        const sameNameFallback =
          hostConnection.worldPlayerKey === null &&
          hostConnection.roomJoinName !== null &&
          member.worldName === hostConnection.roomJoinName;
        if (sameKey || sameNameFallback) {
          send(member.socket, encodeMessage({ type: "caravan_arrive", ...arrival }));
        }
      }
    }
  };

  /**
   * Une caravane vient d'arriver. Sur une case libre, elle **fonde** la
   * colonie au nom de son propriétaire : la case est forcément terrestre,
   * l'itinéraire n'en traverse pas d'autres. La salle, elle, n'est pas créée
   * pour autant — elle s'ouvrira en `lobby` au premier `join`, comme toute
   * salle de case sans snapshot : la colonie « naît » quand quelqu'un l'ouvre,
   * et le manifeste attend jusque-là.
   */
  const handleArrival = (caravan: Caravan): void => {
    const tile = caravan.toTile;
    if (worldState.settlementAt(tile) === undefined) {
      const result = worldState.settle(tile, caravan.owner);
      if (!result.ok) {
        log(`[monde] caravane ${caravan.id} arrivée sur la case ${tile}, fondation refusée (${result.code})`);
        return;
      }
      log(`[monde] caravane ${caravan.id} : ${caravan.owner} fonde une colonie sur la case ${tile}`);
      store?.scheduleSave(worldState);
      broadcastSettlements();
    }
    deliverArrivals(tileRoomName(tile));
  };

  /**
   * Tick du monde : les caravanes avancent, celles qui arrivent sont livrées
   * (ou mises en attente), et la liste repart aux clients tant que quelque
   * chose bouge.
   */
  const worldTick = (): void => {
    const { arrived, changed } = worldState.caravans.advance();
    for (const caravan of arrived) {
      handleArrival(caravan);
    }
    if (changed) {
      caravansDirty = true;
      store?.scheduleSave(worldState);
    }
    if (caravansDirty || worldState.caravans.hasMoving) {
      broadcastCaravans();
    }
  };

  const startWorldClock =
    options.startWorldClock ??
    ((onTick: () => void, intervalMs: number) => {
      const handle = setInterval(onTick, intervalMs);
      handle.unref?.();
      return () => clearInterval(handle);
    });
  const stopWorldClock = startWorldClock(worldTick, caravanTickMs);

  const leaveWorld = (connection: Connection): void => {
    if (!worldMembers.delete(connection)) {
      return;
    }
    log(`[monde] ${connection.worldName ?? "?"} quitte le monde — ${worldMembers.size} présent(s)`);
    connection.worldName = null;
    connection.worldPlayerId = null;
    connection.worldPlayerKey = null;
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
      if (!isValidDisplayName(message.name)) {
        worldFail(socket, "bad_name", `nom invalide (${MAX_DISPLAY_NAME_LENGTH} caractères maximum, sans caractère de contrôle)`);
        return;
      }

      // L'identité d'un joueur est son jeton, pas son nom (docs/protocol.md
      // §11.2). Sans jeton : nouveau joueur, clé et jeton neufs, à persister
      // tout de suite — sinon un redémarrage avant la première colonie
      // perdrait le jeton qu'on vient de promettre au client. Avec un jeton
      // connu : le joueur est reconnu, `name` n'est qu'un libellé qui se met
      // à jour librement. Jeton inconnu : refus et fermeture, comme pour une
      // version de protocole incompatible — pas de compte de secours.
      let player;
      let isNewPlayer: boolean;
      if (message.token === undefined) {
        player = worldState.createPlayer(message.name);
        isNewPlayer = true;
        store?.scheduleSave(worldState);
      } else {
        const known = worldState.playerByToken(message.token);
        if (known === undefined) {
          worldFail(socket, "bad_token", "jeton de joueur inconnu");
          socket.close();
          return;
        }
        player = known;
        isNewPlayer = false;
        if (player.name !== message.name) {
          worldState.renamePlayer(player.key, message.name);
          store?.scheduleSave(worldState);
        }
      }

      connection.worldName = player.name;
      connection.worldPlayerKey = player.key;
      connection.worldPlayerId = nextWorldPlayerId++;
      worldMembers.add(connection);
      send(
        socket,
        encodeMessage({
          type: "world_welcome",
          playerId: connection.worldPlayerId,
          playerKey: player.key,
          name: player.name,
          // Uniquement à la création : c'est la seule fois où le jeton part
          // sur le fil (docs/protocol.md §11.2, jamais journalisé non plus).
          ...(isNewPlayer ? { token: player.token } : {}),
          settlements: worldState.list(),
          players: worldPlayerInfos(),
          world: {
            seed: worldState.seed,
            subdivisions: worldState.subdivisions,
            tiles: worldState.tileCount,
          },
        }),
      );
      // Les caravanes en vol, tout de suite : le globe s'affiche complet.
      send(socket, encodeMessage({ type: "world_caravans", caravans: worldState.caravans.list() }));
      log(
        `[monde] ${player.name} rejoint le monde (${isNewPlayer ? "nouveau joueur" : "reconnu"}) — ` +
          `${worldMembers.size} présent(s)`,
      );
      broadcastWorldPlayers();
      return;
    }

    if (message.type === "caravan_delivered") {
      // Ce message répond à un `caravan_arrive` reçu **dans une salle**. Son
      // auteur n'est pas forcément entré dans le monde : on ne lui impose que
      // d'être dans la salle de la case d'arrivée. Le serveur n'exige pas non
      // plus qu'il soit encore l'hôte par ce chemin — seul l'hôte reçoit
      // `caravan_arrive`, et une confirmation tardive après un changement
      // d'hôte reste vraie. Une connexion **monde** séparée, elle, doit
      // prouver qu'elle est bien l'hôte de cette salle (même règle de
      // présence, clé ou nom en repli) : elle n'a pas la garantie d'y être
      // pour une autre raison (docs/protocol.md §12.3).
      const arrival = worldState.caravans.arrivalOf(message.id);
      if (arrival === undefined) {
        worldFail(socket, "caravan_not_found", caravanErrorText("caravan_not_found"));
        return;
      }
      const room = tileRoomName(arrival.tile);
      const inRoom = connection.room !== null && connection.room.name === room;
      const isHostFromWorld =
        !inRoom &&
        connection.worldPlayerKey !== null &&
        connection.worldName !== null &&
        isHostOfRoom(room, connection.worldPlayerKey, connection.worldName);
      if (!inRoom && !isHostFromWorld) {
        worldFail(socket, "caravan_not_in_room", `il faut être dans la salle ${room} pour livrer cette caravane`);
        return;
      }
      worldState.caravans.markDelivered(message.id);
      store?.scheduleSave(worldState);
      log(`[monde] caravane ${message.id} livrée sur la case ${arrival.tile}`);
      caravansChanged();
      return;
    }

    const name = connection.worldName;
    const key = connection.worldPlayerKey;
    if (name === null || key === null) {
      worldFail(socket, "not_in_world", "envoyer d'abord `world_join`");
      return;
    }

    switch (message.type) {
      case "world_leave":
        leaveWorld(connection);
        return;
      case "settle": {
        // Une colonie fondée aura tôt ou tard sa salle « case » (au premier
        // `join` sur `tile-<id>`) : la refuser au-delà de `maxRooms` évite de
        // simplement déplacer le dépassement au moment de cette ouverture.
        if (rooms.size >= maxRooms) {
          log(`[monde] fondation refusée (server_full) sur la case ${message.tile} — ${rooms.size} salle(s) active(s)`);
          worldFail(socket, "server_full", `nombre maximal de salles atteint (${maxRooms})`);
          return;
        }
        // `key`, pas `name` : l'appartenance d'une colonie se prouve par
        // jeton, jamais par un nom qu'un autre joueur pourrait aussi taper.
        const result = worldState.settle(message.tile, key);
        if (!result.ok) {
          worldFail(socket, result.code, settleErrorText(result.code, message.tile));
          return;
        }
        const settlement = result.settlement;
        store?.scheduleSave(worldState);
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
        log(`[monde] ${name} visite la case ${settlement.tile} de ${settlement.ownerName}`);
        return;
      }
      case "abandon": {
        const result = worldState.abandon(message.tile, key);
        if (!result.ok) {
          worldFail(socket, result.code, abandonErrorText(result.code, message.tile));
          return;
        }
        store?.scheduleSave(worldState);
        log(`[monde] ${name} abandonne la case ${message.tile}`);
        broadcastSettlements();
        return;
      }
      case "caravan_depart": {
        // v1 : tout joueur **présent dans la salle de la case de départ** peut
        // expédier, propriétaire ou simple visiteur. Être dans la salle
        // `tile-<id>` suffit à prouver que la case est colonisée : le serveur
        // n'ouvre pas de salle de case libre (§11.2). La présence se vérifie
        // par n'importe quelle connexion du joueur (`isPresentInRoom`) : la
        // connexion émettrice elle-même si c'est une connexion de salle
        // (chemin actuel), ou une autre si c'est une connexion monde séparée
        // (docs/protocol.md §12.3) — il faut être dans la salle, le
        // propriétaire de la colonie n'a aucun privilège à distance.
        const room = tileRoomName(message.fromTile);
        if (!isPresentInRoom(room, key, name)) {
          worldFail(socket, "caravan_not_in_room", `il faut être dans la salle ${room} pour en faire partir une caravane`);
          return;
        }
        const result = worldState.caravans.depart({
          owner: key,
          fromTile: message.fromTile,
          toTile: message.toTile,
          manifest: message.manifest,
          summary: message.summary,
        });
        if (!result.ok) {
          worldFail(socket, result.code, caravanErrorText(result.code));
          return;
        }
        store?.scheduleSave(worldState);
        log(
          `[monde] ${name} expédie la caravane ${result.caravan.id} de la case ${message.fromTile} vers ${message.toTile} ` +
            `— ${result.caravan.route.length} case(s), ${(result.caravan.arrivesAt - result.caravan.departedAt).toFixed(1)} h de jeu`,
        );
        caravansChanged();
        return;
      }
      case "caravan_cancel": {
        const result = worldState.caravans.cancel(message.id, key);
        if (!result.ok) {
          worldFail(socket, result.code, caravanErrorText(result.code));
          return;
        }
        store?.scheduleSave(worldState);
        log(`[monde] ${name} rappelle la caravane ${message.id} vers la case ${result.caravan.toTile}`);
        caravansChanged();
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
              // Le monde a vieilli pendant que la colonie dormait : le premier
              // arrivant émettra l'avance rapide correspondante (§11.6).
              frozenTicks: worldState.frozenTicksFor(name),
            },
          }
        : {}),
      onSnapshot: (report) => {
        if (worldState.saveSnapshot(name, report)) {
          store?.scheduleSave(worldState);
        }
      },
      // La salle entre en jeu, ou change d'hôte : les arrivées non confirmées
      // repartent vers celui qui peut les injecter.
      onHostReady: () => deliverArrivals(name),
    });
  };

  wss.on("connection", (socket: WebSocket, request: IncomingMessage) => {
    const ip = resolveClientIp(request, trustProxy);
    ipConnectionCounts.set(ip, (ipConnectionCounts.get(ip) ?? 0) + 1);
    const connection: Connection = {
      socket,
      room: null,
      playerId: null,
      roomJoinName: null,
      worldName: null,
      worldPlayerKey: null,
      worldPlayerId: null,
      lastSeen: Date.now(),
      ip,
      messageTimestamps: [],
      overLimitSince: null,
    };
    connections.add(connection);

    /**
     * Débit d'une connexion, fenêtre glissante d'une seconde. `now` est déjà
     * comptée dans `connection.messageTimestamps` avant l'appel : à appeler une
     * fois par message qui compte (pas les `pong`).
     */
    const checkRate = (now: number): "ok" | "limited" | "close" => {
      const timestamps = connection.messageTimestamps;
      timestamps.push(now);
      const cutoff = now - RATE_WINDOW_MS;
      let firstFresh = 0;
      while (firstFresh < timestamps.length && timestamps[firstFresh]! < cutoff) {
        firstFresh += 1;
      }
      if (firstFresh > 0) {
        timestamps.splice(0, firstFresh);
      }
      if (timestamps.length <= maxMessagesPerSecond) {
        connection.overLimitSince = null;
        return "ok";
      }
      connection.overLimitSince ??= now;
      return now - connection.overLimitSince >= RATE_CLOSE_AFTER_MS ? "close" : "limited";
    };

    socket.on("message", (data: unknown) => {
      const now = Date.now();
      connection.lastSeen = now;
      const rawText = String(data);
      const byteLength = Buffer.byteLength(rawText, "utf8");

      // --- Taille (`docs/protocol.md` §2, « Limites ») ---
      const tooLarge =
        byteLength > maxSnapshotBytes || (byteLength > maxMessageBytes && sniffMessageType(rawText) !== "snapshot");
      if (tooLarge) {
        log(`[taille] connexion ${ip} fermée — message de ${byteLength} octets au-delà du maximum autorisé`);
        fail(socket, "message_too_large", `message de ${byteLength} octets, au-delà du maximum autorisé`);
        socket.close(CLOSE_MESSAGE_TOO_LARGE, "message_too_large");
        return;
      }

      const message = decodeClientMessage(rawText);

      // --- Débit (`docs/protocol.md` §2, « Limites »). Le `pong` ne compte pas. ---
      if (message === null || message.type !== "pong") {
        const verdict = checkRate(now);
        if (verdict === "close") {
          log(`[débit] connexion ${ip} fermée — dépassement soutenu depuis 3 s (limite ${maxMessagesPerSecond}/s)`);
          socket.close(CLOSE_RATE_LIMITED, "rate_limited");
          return;
        }
        if (verdict === "limited") {
          fail(socket, "rate_limited", `plus de ${maxMessagesPerSecond} messages par seconde`);
          return;
        }
      }

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
        if (!isValidDisplayName(message.name)) {
          fail(socket, "bad_name", `nom invalide (${MAX_DISPLAY_NAME_LENGTH} caractères maximum, sans caractère de contrôle)`);
          return;
        }
        let room = rooms.get(message.room);
        if (room === undefined) {
          if (rooms.size >= maxRooms) {
            log(`[serveur] salle ${message.room} refusée (server_full) — ${rooms.size} salle(s) active(s)`);
            fail(socket, "server_full", `nombre maximal de salles atteint (${maxRooms})`);
            return;
          }
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
        connection.roomJoinName = message.name;
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
      const ipCount = ipConnectionCounts.get(connection.ip) ?? 0;
      if (ipCount <= 1) {
        ipConnectionCounts.delete(connection.ip);
      } else {
        ipConnectionCounts.set(connection.ip, ipCount - 1);
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
    get persistence() {
      return {
        enabled: persistenceEnabled,
        file: persistenceEnabled ? worldStateFile : null,
        lastSavedAt: store?.lastSavedAt ?? null,
      };
    },
    get roomCount(): number {
      return rooms.size;
    },
    room(name: string): Room | undefined {
      return rooms.get(name);
    },
    async close(): Promise<void> {
      clearInterval(heartbeat);
      stopWorldClock();
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
      // Dernière sauvegarde avant de quitter : un arrêt propre (SIGINT/SIGTERM,
      // voir index.ts) ne doit pas perdre les changements les plus récents.
      if (store !== null) {
        await store.save(worldState);
      }
    },
  };
}
