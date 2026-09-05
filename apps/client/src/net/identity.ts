/**
 * Stockage local de l'identité de joueur du monde : la clé publique
 * (`playerKey`) et le jeton secret qui va avec, par serveur
 * (`docs/protocol.md` §11.2).
 *
 * Un jeton perdu est une identité perdue — et donc les colonies qui allaient
 * avec — mais un `localStorage` indisponible (navigation privée, quota,
 * absence dans un test) ne doit pas faire planter le client : tous les accès
 * sont protégés, une erreur de stockage revient simplement à un mode sans
 * mémoire (le prochain `world_join` repart sans jeton, donc comme un nouveau
 * joueur).
 *
 * Le jeton n'est **jamais** journalisé ici, conformément à la règle du
 * protocole : ce module ne fait que le ranger et le relire tel quel.
 */

/** Ce qu'on conserve d'un `world_welcome` : de quoi se faire reconnaître. */
export interface StoredIdentity {
  readonly token: string;
  readonly playerKey: string;
}

/** Le sous-ensemble de `Storage` dont ce module a besoin, pour l'injection en test. */
export type IdentityStorage = Pick<Storage, "getItem" | "setItem" | "removeItem">;

const PREFIX = "rimlike:identity:";

/**
 * Portée d'une identité : un serveur **et** un nom de joueur. Le nom saisi sert
 * de profil local : deux onglets du même navigateur avec des noms différents sont
 * deux joueurs distincts (sans ça, ils partageraient le même jeton via
 * `localStorage` et ne feraient qu'un seul joueur, renommé au dernier `world_join`).
 */
export function identityScope(serverUrl: string, playerName: string): string {
  return `${serverUrl.trim().toLowerCase()}#${playerName.trim().toLowerCase()}`;
}

/** Clé de stockage stable pour un serveur donné : insensible à la casse et aux espaces. */
function storageKey(serverUrl: string): string {
  return `${PREFIX}${serverUrl.trim().toLowerCase()}`;
}

/**
 * Le `localStorage` du navigateur, ou `null` s'il est indisponible. Un test
 * peut fournir le sien à chaque fonction plutôt que de dépendre de celui-ci.
 */
function defaultStorage(): IdentityStorage | null {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    // Certains environnements (navigation privée de Safari, iframes tierces)
    // lèvent au premier accès plutôt que de rendre `undefined`.
    return null;
  }
}

/** L'identité connue pour ce serveur, ou `null` si on n'en a aucune (ou pas de stockage). */
export function loadIdentity(serverUrl: string, store: IdentityStorage | null = defaultStorage()): StoredIdentity | null {
  if (store === null) return null;
  try {
    const raw = store.getItem(storageKey(serverUrl));
    if (raw === null) return null;
    const parsed = JSON.parse(raw) as Partial<StoredIdentity> | null;
    if (typeof parsed?.token !== "string" || typeof parsed.playerKey !== "string") return null;
    return { token: parsed.token, playerKey: parsed.playerKey };
  } catch {
    return null;
  }
}

/** Range l'identité reçue à la création d'un joueur. Silencieux si le stockage refuse. */
export function saveIdentity(
  serverUrl: string,
  identity: StoredIdentity,
  store: IdentityStorage | null = defaultStorage(),
): void {
  if (store === null) return;
  try {
    store.setItem(storageKey(serverUrl), JSON.stringify(identity));
  } catch {
    // Stockage plein ou refusé : le prochain `world_join` repartira sans
    // jeton, ce qui crée un nouveau joueur — dégradé, mais pas une panne.
  }
}

/** Oublie l'identité stockée pour ce serveur (jeton perdu ou `bad_token`, §11.2). */
export function forgetIdentity(serverUrl: string, store: IdentityStorage | null = defaultStorage()): void {
  if (store === null) return;
  try {
    store.removeItem(storageKey(serverUrl));
  } catch {
    // Rien à faire : sans stockage fonctionnel il n'y avait rien à oublier.
  }
}
