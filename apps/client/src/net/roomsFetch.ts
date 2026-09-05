/**
 * Découverte des salles ouvertes : `GET /rooms` (`docs/protocol.md` §2,
 * « Découverte des salles »). Rien qu'une liste de lecture — aucune commande,
 * aucun état de jeu, pas de jeton ni de clé de joueur dans la réponse — utile
 * à un écran d'accueil « Salles ouvertes » avant même `world_join` ou `join`.
 *
 * Contrairement à `GET /world` (`net/worldFetch.ts`), le serveur pose déjà
 * `Access-Control-Allow-Origin: *` sur `/rooms` : pas besoin du relais `/__world`
 * de Vite, un `fetch` direct suffit même hors de l'origine du serveur.
 */

import { TICKS_PER_DAY } from "@rimlike/protocol";

import { httpBaseFromWs } from "./worldFetch";

/** État d'une salle, tel que diffusé par le serveur (`docs/protocol.md` §4). */
export type RoomState = "lobby" | "running" | "desynced";

const ROOM_STATES: readonly RoomState[] = ["lobby", "running", "desynced"];

/** Une salle décrite par `GET /rooms` : sans secret, jamais de jeton ni de clé de joueur. */
export interface RoomInfo {
  readonly name: string;
  readonly state: RoomState;
  readonly players: number;
  readonly maxPlayers: number;
  readonly tick: number;
  /** Vraie pour une salle « case » du monde (`tile-<id>`, `docs/protocol.md` §11.2). */
  readonly isTile: boolean;
  /** Identifiant de case du globe, seulement si `isTile`. */
  readonly tile?: number;
  /**
   * Nom d'affichage résolu du propriétaire de la colonie, seulement pour une
   * salle « case ». Absent si la colonie a été abandonnée pendant qu'une
   * salle encore peuplée continuait de tourner (§11.3) — la salle existe
   * encore, la colonie non.
   */
  readonly ownerName?: string;
  /**
   * Connue dès la création pour une salle « case » (imposée par le serveur) ;
   * pour une salle simple, seulement une fois `start` passé.
   */
  readonly seed?: number;
  readonly createdAt: number;
}

/** Corps complet de `GET /rooms`. */
export interface RoomsResponse {
  readonly rooms: readonly RoomInfo[];
  readonly truncated: boolean;
}

/** Filtres facultatifs de `GET /rooms` (`?state=`, `?q=`), encodés dans l'URL. */
export interface FetchRoomsOptions {
  readonly state?: RoomState;
  readonly q?: string;
}

function isRoomState(value: unknown): value is RoomState {
  return typeof value === "string" && (ROOM_STATES as readonly string[]).includes(value);
}

/** Validation légère de la forme d'une entrée : un corps venu du réseau n'est pas de confiance. */
function isRoomInfo(value: unknown): value is RoomInfo {
  if (value === null || typeof value !== "object") return false;
  const r = value as Record<string, unknown>;
  if (typeof r.name !== "string") return false;
  if (!isRoomState(r.state)) return false;
  if (typeof r.players !== "number") return false;
  if (typeof r.maxPlayers !== "number") return false;
  if (typeof r.tick !== "number") return false;
  if (typeof r.isTile !== "boolean") return false;
  if (r.tile !== undefined && typeof r.tile !== "number") return false;
  if (r.ownerName !== undefined && typeof r.ownerName !== "string") return false;
  if (r.seed !== undefined && typeof r.seed !== "number") return false;
  if (typeof r.createdAt !== "number") return false;
  return true;
}

/**
 * L'URL de `GET /rooms` pour ce serveur, filtres compris. Dérivée de
 * l'adresse WebSocket comme `worldEndpoint` (`ws://`/`wss://` → `http(s)://`).
 */
export function roomsEndpoint(serverUrl: string, opts: FetchRoomsOptions = {}): string {
  const base = httpBaseFromWs(serverUrl);
  const params = new URLSearchParams();
  if (opts.state !== undefined) params.set("state", opts.state);
  if (opts.q !== undefined && opts.q !== "") params.set("q", opts.q);
  const query = params.toString();
  return query === "" ? `${base}/rooms` : `${base}/rooms?${query}`;
}

/**
 * Interroge `GET /rooms`. Lève une erreur en français si le serveur est
 * injoignable, répond mal, ou si le corps ne ressemble pas à une réponse de
 * `/rooms` — jamais une valeur de confiance venue du réseau.
 */
export async function fetchRooms(serverUrl: string, opts: FetchRoomsOptions = {}): Promise<RoomsResponse> {
  const endpoint = roomsEndpoint(serverUrl, opts);
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`liste des salles injoignable sur ${endpoint} : ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    throw new Error(`le serveur a répondu ${response.status} à ${endpoint}`);
  }
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("réponse de /rooms illisible (JSON invalide)");
  }
  if (body === null || typeof body !== "object") {
    throw new Error("réponse de /rooms inattendue : un objet était attendu");
  }
  const { rooms, truncated } = body as Record<string, unknown>;
  if (!Array.isArray(rooms) || !rooms.every(isRoomInfo)) {
    throw new Error("réponse de /rooms inattendue : `rooms` doit être un tableau de salles valides");
  }
  if (typeof truncated !== "boolean") {
    throw new Error("réponse de /rooms inattendue : `truncated` doit être un booléen");
  }
  return { rooms, truncated };
}

/**
 * Nom affiché d'une salle : le sien pour une salle simple, sinon
 * « Colonie de ⟨ownerName⟩ · case N » — ou « Colonie abandonnée · case N » si
 * la colonie n'est plus là mais que la salle tourne encore (§11.3).
 */
export function roomDisplayName(room: RoomInfo): string {
  if (!room.isTile) return room.name;
  return room.ownerName !== undefined
    ? `Colonie de ${room.ownerName} · case ${room.tile}`
    : `Colonie abandonnée · case ${room.tile}`;
}

/** Libellé d'état d'une salle, en français, pour l'accueil. */
export function roomStateLabel(state: RoomState): string {
  switch (state) {
    case "lobby":
      return "en attente";
    case "running":
      return "en cours";
    case "desynced":
      return "désynchronisée";
  }
}

/**
 * Jour de jeu affiché pour une salle, à partir de son `tick` (même formule
 * qu'`App.tsx` pour `Stats.day` : `TICKS_PER_DAY` fait le contrat avec le sim).
 */
export function roomDay(tick: number): number {
  return Math.floor(tick / TICKS_PER_DAY) + 1;
}
