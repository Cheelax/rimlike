/**
 * Téléchargement du globe : `GET /world` (`docs/protocol.md` §11.1).
 *
 * Le client ne régénère **jamais** le monde — `Math.sin` et consorts ne sont
 * pas normalisés au bit près en JavaScript, deux moteurs ne verraient pas la
 * même carte (`docs/world.md` §6). Il télécharge le `WorldWire`, il le
 * désérialise, il l'affiche.
 *
 * Contournement assumé, côté client seulement : le serveur relais ne pose
 * aucun en-tête CORS sur `GET /world`, donc un `fetch` depuis
 * `http://localhost:5173` vers `http://localhost:8787` est refusé par le
 * navigateur. En développement, la requête passe donc par le petit relais
 * `/__world` de `vite.config.ts`, sur la même origine. En production (client
 * servi par le serveur monde, ou en-tête ajouté côté serveur) l'appel est
 * direct.
 */

import { deserializeWorld, type World, type WorldWire } from "@rimlike/world";

/** Ce que sert `GET /world`. */
export interface WorldPayload {
  readonly seed: number;
  readonly subdivisions: number;
  readonly generatedAt: number;
  readonly wire: WorldWire;
}

/** Avancement du téléchargement, pour un affichage sobre. */
export interface WorldProgress {
  readonly phase: "download" | "decode";
  /** Octets reçus (après décompression du transport). */
  readonly received: number;
}

/**
 * Adresse HTTP dérivée de l'adresse WebSocket du serveur : `ws://` → `http://`,
 * `wss://` → `https://`, sans barre oblique finale. Une adresse déjà en
 * `http(s)://` est acceptée telle quelle : c'est pratique en console.
 */
export function httpBaseFromWs(serverUrl: string): string {
  const url = new URL(serverUrl);
  if (url.protocol === "ws:") url.protocol = "http:";
  else if (url.protocol === "wss:") url.protocol = "https:";
  const base = url.origin + url.pathname;
  return base.endsWith("/") ? base.slice(0, -1) : base;
}

/**
 * URL à interroger pour obtenir le globe. En développement et hors origine
 * courante, on passe par le relais `/__world` de Vite (voir l'en-tête).
 */
export function worldEndpoint(serverUrl: string): string {
  const base = httpBaseFromWs(serverUrl);
  // Hors navigateur (tests sous Node), il n'y a ni origine ni politique CORS :
  // l'appel direct est le bon.
  if (typeof window === "undefined") {
    return `${base}/world`;
  }
  if (import.meta.env.DEV && new URL(base).origin !== window.location.origin) {
    return `/__world?target=${encodeURIComponent(base)}`;
  }
  return `${base}/world`;
}

/** Lit le corps en flux pour pouvoir annoncer les octets reçus. */
async function readBody(response: Response, onProgress?: (p: WorldProgress) => void): Promise<string> {
  const body = response.body;
  if (!body) return response.text();
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let received = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    received += value.length;
    onProgress?.({ phase: "download", received });
  }
  const decoder = new TextDecoder();
  let text = "";
  for (const chunk of chunks) text += decoder.decode(chunk, { stream: true });
  text += decoder.decode();
  return text;
}

/**
 * Télécharge et désérialise le globe du serveur. Lève avec un message en
 * français si le serveur répond mal ou si le paquet est malformé —
 * `deserializeWorld` valide les longueurs et rejette un voisin ou un biome
 * hors du monde, un `WorldWire` reçu n'est pas une valeur de confiance.
 */
export async function fetchWorld(
  serverUrl: string,
  onProgress?: (progress: WorldProgress) => void,
): Promise<{ world: World; payload: WorldPayload }> {
  const endpoint = worldEndpoint(serverUrl);
  let response: Response;
  try {
    response = await fetch(endpoint, { headers: { accept: "application/json" } });
  } catch (e) {
    throw new Error(`globe injoignable sur ${endpoint} : ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!response.ok) {
    throw new Error(`le serveur a répondu ${response.status} à ${endpoint}`);
  }
  const text = await readBody(response, onProgress);
  onProgress?.({ phase: "decode", received: text.length });
  let payload: WorldPayload;
  try {
    payload = JSON.parse(text) as WorldPayload;
  } catch {
    throw new Error("réponse de /world illisible (JSON invalide)");
  }
  if (payload === null || typeof payload !== "object" || typeof payload.wire !== "object") {
    throw new Error("réponse de /world inattendue : pas de champ `wire`");
  }
  const world = deserializeWorld(payload.wire);
  return { world, payload };
}
