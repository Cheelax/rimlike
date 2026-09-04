/**
 * Messages échangés entre un client et le serveur relais, et constantes du
 * lockstep. Rien ici ne connaît le contenu des commandes : elles voyagent en
 * octets opaques, produits et relus par le sim.
 *
 * Direction des noms : `Client*` = client → serveur, `Server*` = serveur → client.
 * Deux types de message portent le même nom de wire dans les deux sens
 * (`start`, `snapshot`) avec une forme différente : ils ont donc deux types.
 */

/** Incrémenté à chaque changement incompatible de forme des messages. */
export const PROTOCOL_VERSION = 1;

/** Ticks de simulation par seconde. Contrat partagé par tous les clients. */
export const TICK_RATE = 60;

/** Ticks couverts par un bundle. 3 ticks à 60/s = 20 bundles/s. */
export const BUNDLE_TICKS = 3;

/** Période d'émission d'un bundle, en millisecondes réelles. */
export const BUNDLE_INTERVAL_MS = (1000 / TICK_RATE) * BUNDLE_TICKS;

/** Un client envoie son hash d'état tous les N ticks. */
export const HASH_EVERY_TICKS = 300;

/**
 * Dans une salle « case » du monde, le serveur demande à l'hôte un snapshot de
 * conservation tous les N ticks (1800 ticks = 30 s à 60 ticks/s). Ce snapshot
 * ne sert personne en particulier : il est stocké pour rouvrir la colonie plus
 * tard. Sans effet dans une salle hors monde.
 */
export const SNAPSHOT_EVERY_TICKS = 1800;

/** Bundles conservés par salle pour le rejeu d'un joueur qui rejoint. */
export const MAX_HISTORY_BUNDLES = 2000;

/** Période du heartbeat serveur → client. */
export const HEARTBEAT_MS = 5000;

/** Silence toléré avant de fermer une connexion. */
export const HEARTBEAT_TIMEOUT_MS = 15000;

/** Joueurs simultanés par salle (phase 3 : 2 à 4 joueurs sur une carte). */
export const MAX_PLAYERS = 4;

/** Identifiant de joueur, attribué par le serveur, unique dans la salle. */
export type PlayerId = number;

/**
 * « Personne ». Les identifiants de joueur commencent à 1, donc 0 ne désigne
 * jamais un joueur : c'est la valeur de `request_snapshot.forPlayer` quand le
 * serveur réclame un snapshot **de conservation** et non le rattrapage d'un
 * rejoignant (voir `SNAPSHOT_EVERY_TICKS`).
 *
 * Pourquoi 0 et pas `null` : le type de `forPlayer` reste `PlayerId`, donc un
 * client déjà écrit continue de compiler. Un client à jour teste
 * `forPlayer === NO_PLAYER` et répond `snapshot` **sans** `forPlayer` — la
 * seule forme que le serveur accepte pour un snapshot de conservation.
 */
export const NO_PLAYER = 0;

/**
 * `lobby` : personne n'a démarré, le sim n'existe pas encore.
 * `running` : l'horloge tourne, les bundles sont émis.
 * `desynced` : un écart de hash a été constaté. En v1 on signale seulement :
 * l'horloge continue, les bundles continuent.
 */
export type RoomState = "lobby" | "running" | "desynced";

export interface PlayerInfo {
  readonly id: PlayerId;
  readonly name: string;
}

// --- Monde (phase 4) ---

/**
 * Une colonie posée sur une case du globe. Une case en porte au plus une.
 *
 * `owner` est un **nom de joueur** : l'identité v1 n'a pas de compte, donc
 * quiconque se connecte sous ce nom est reconnu comme propriétaire. C'est une
 * limite assumée, à remplacer par de vrais comptes avant toute mise en ligne
 * publique (voir `docs/protocol.md` §11).
 *
 * `room` est la salle lockstep de la case (`tile-<id>`) et `seed` la graine de
 * carte imposée par le serveur : deux visites de la même case donnent la même
 * carte.
 */
export interface Settlement {
  /** Identifiant de case du globe (`Tile.id` de `@rimlike/world`). */
  readonly tile: number;
  readonly owner: string;
  readonly room: string;
  readonly seed: number;
  /** Date de fondation, en millisecondes epoch. */
  readonly createdAt: number;
}

/** De quoi identifier le globe servi par `GET /world` et le vérifier. */
export interface WorldInfo {
  readonly seed: number;
  readonly subdivisions: number;
  /** Nombre de cases, `10 × 4^subdivisions + 2`. */
  readonly tiles: number;
}

/** Une commande de joueur planifiée sur un tick, en octets opaques. */
export interface TickCommand {
  readonly player: PlayerId;
  /** Encodage `Command` du sim (postcard). Base64 sur le fil. */
  readonly payload: Uint8Array;
}

/** Les commandes d'un tick, dans l'ordre d'application imposé par le serveur. */
export interface TickCommands {
  readonly tick: number;
  readonly commands: readonly TickCommand[];
}

/**
 * Bloc de `BUNDLE_TICKS` ticks, de `from` à `to` inclus. Les ticks sans
 * commande sont **omis** de `ticks` : un bundle vide est le cas courant et
 * `ticks: []` signifie « avance de `from` à `to` sans rien appliquer ».
 */
export interface Bundle {
  readonly from: number;
  readonly to: number;
  readonly ticks: readonly TickCommands[];
}

// --- Client → serveur ---

/** Premier message d'une connexion. Crée la salle si elle n'existe pas. */
export interface JoinMessage {
  readonly type: "join";
  readonly room: string;
  readonly name: string;
  /** Facultatif ; si présent et différent, le serveur répond `version_mismatch`. */
  readonly protocol?: number;
}

/** Réservé au host, en salle `lobby`. Fixe la graine et la taille de carte. */
export interface ClientStartMessage {
  readonly type: "start";
  readonly seed: number;
  readonly width: number;
  readonly height: number;
}

/** Une commande du joueur. Le serveur ne la décode jamais. */
export interface CommandMessage {
  readonly type: "command";
  readonly payload: Uint8Array;
}

/** Hash d'état, envoyé tous les `HASH_EVERY_TICKS` ticks. */
export interface HashMessage {
  readonly type: "hash";
  readonly tick: number;
  readonly hash: string;
}

/**
 * Réponse du host à `request_snapshot`. `tick` est le prochain tick à exécuter
 * (donc le nombre de ticks déjà appliqués). Sans `forPlayer`, le serveur sert
 * tous les joueurs en attente d'un snapshot.
 */
export interface ClientSnapshotMessage {
  readonly type: "snapshot";
  readonly tick: number;
  readonly data: Uint8Array;
  readonly forPlayer?: PlayerId;
}

export interface PingMessage {
  readonly type: "ping";
}

export interface PongMessage {
  readonly type: "pong";
}

/**
 * Connexion au **monde**, sans entrer dans une salle : le client reçoit la
 * liste des colonies et peut ensuite s'installer, visiter ou repartir. Une
 * connexion peut faire `world_join` puis `join` : le monde et la salle
 * cohabitent sur la même WebSocket.
 */
export interface WorldJoinMessage {
  readonly type: "world_join";
  readonly name: string;
  /** Facultatif ; si présent et différent, le serveur répond `version_mismatch`. */
  readonly protocol?: number;
}

/** Fonder une colonie sur une case libre et terrestre. */
export interface SettleMessage {
  readonly type: "settle";
  readonly tile: number;
}

/** Demander la salle et la graine d'une case déjà colonisée, en invité. */
export interface VisitMessage {
  readonly type: "visit";
  readonly tile: number;
}

/** Abandonner une de ses colonies : la case redevient libre. */
export interface AbandonMessage {
  readonly type: "abandon";
  readonly tile: number;
}

/** Quitter le monde sans fermer la connexion. */
export interface WorldLeaveMessage {
  readonly type: "world_leave";
}

export type ClientMessage =
  | JoinMessage
  | ClientStartMessage
  | CommandMessage
  | HashMessage
  | ClientSnapshotMessage
  | PingMessage
  | PongMessage
  | WorldJoinMessage
  | SettleMessage
  | VisitMessage
  | AbandonMessage
  | WorldLeaveMessage;

// --- Serveur → client ---

/** Réponse à `join`. `tick` = prochain tick à exécuter côté serveur. */
export interface WelcomeMessage {
  readonly type: "welcome";
  readonly protocol: number;
  readonly playerId: PlayerId;
  readonly isHost: boolean;
  readonly players: readonly PlayerInfo[];
  readonly state: RoomState;
  readonly tick: number;
  /** Présents dès que la salle a démarré, absents en `lobby`. */
  readonly seed?: number;
  readonly width?: number;
  readonly height?: number;
}

/** Diffusé à chaque changement de composition ou de host. */
export interface PlayersMessage {
  readonly type: "players";
  readonly players: readonly PlayerInfo[];
  readonly hostId: PlayerId | null;
}

/** Diffusé quand le host démarre. `tick` vaut 0 : le sim part de zéro. */
export interface ServerStartMessage {
  readonly type: "start";
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly tick: number;
}

/** Le message central : tous les clients reçoivent la même suite de bundles. */
export interface BundleMessage extends Bundle {
  readonly type: "bundle";
}

/**
 * Le serveur demande au host un snapshot. `forPlayer` est l'identifiant du
 * joueur à rattraper, ou `NO_PLAYER` (0) pour un snapshot **de conservation**
 * dans une salle « case » : le serveur le stocke pour rouvrir la colonie plus
 * tard. Dans ce cas la réponse doit être un `snapshot` **sans** `forPlayer`.
 */
export interface RequestSnapshotMessage {
  readonly type: "request_snapshot";
  readonly forPlayer: PlayerId;
}

/** Snapshot relayé au joueur qui rejoint, avant le rejeu des bundles. */
export interface ServerSnapshotMessage {
  readonly type: "snapshot";
  readonly tick: number;
  readonly data: Uint8Array;
}

/**
 * Premier écart de hash constaté. Les clés de `hashes` sont des identifiants
 * de joueur (chaînes après passage par JSON).
 */
export interface DesyncMessage {
  readonly type: "desync";
  readonly tick: number;
  readonly hashes: Readonly<Record<PlayerId, string>>;
}

export interface ErrorMessage {
  readonly type: "error";
  readonly code: string;
  readonly message: string;
}

/**
 * Réponse à `world_join`. Le globe lui-même n'est pas dans ce message : il se
 * télécharge une fois par `GET /world` (plusieurs centaines de kilo-octets).
 * `world` sert à vérifier qu'on parle bien du même globe.
 */
export interface WorldWelcomeMessage {
  readonly type: "world_welcome";
  readonly playerId: PlayerId;
  readonly name: string;
  readonly settlements: readonly Settlement[];
  /** Noms des joueurs connectés au monde (l'identité v1 est le nom). */
  readonly players: readonly string[];
  readonly world: WorldInfo;
}

/** Diffusé à tous les joueurs du monde à chaque fondation ou abandon. */
export interface WorldSettlementsMessage {
  readonly type: "world_settlements";
  readonly settlements: readonly Settlement[];
}

/** Diffusé à chaque arrivée ou départ dans le monde. */
export interface WorldPlayersMessage {
  readonly type: "world_players";
  readonly players: readonly string[];
}

/**
 * Où aller pour jouer une case : envoyé à l'auteur d'un `settle` réussi (la
 * colonie vient d'être fondée) comme d'un `visit` réussi (la colonie existe
 * déjà). Le client enchaîne avec le `join { room }` habituel sur la même
 * connexion. `seed` est la graine imposée par le serveur, donnée pour
 * information : le `start` diffusé la reprendra.
 */
export interface SettledMessage {
  readonly type: "settled";
  readonly tile: number;
  readonly room: string;
  readonly seed: number;
}

/**
 * Refus d'une action de monde. Distinct de `error` pour que le client puisse
 * router les deux séparément : `error` concerne la salle et le transport,
 * `world_error` la carte du globe. Codes : `WORLD_ERROR_CODES`.
 */
export interface WorldErrorMessage {
  readonly type: "world_error";
  readonly code: string;
  readonly message: string;
}

export type ServerMessage =
  | WelcomeMessage
  | PlayersMessage
  | ServerStartMessage
  | BundleMessage
  | RequestSnapshotMessage
  | ServerSnapshotMessage
  | DesyncMessage
  | ErrorMessage
  | PingMessage
  | PongMessage
  | WorldWelcomeMessage
  | WorldSettlementsMessage
  | WorldPlayersMessage
  | SettledMessage
  | WorldErrorMessage;

export type AnyMessage = ClientMessage | ServerMessage;

/**
 * Codes d'erreur émis par le serveur de la phase 3. La liste est ouverte :
 * la validation accepte toute chaîne non vide, un client ne doit donc pas
 * exiger d'appartenir à cette union.
 */
export const ERROR_CODES = [
  /** JSON illisible ou message qui ne respecte pas son schéma. */
  "bad_message",
  /** Version de protocole annoncée différente de `PROTOCOL_VERSION`. */
  "version_mismatch",
  /** Message reçu avant `join`. */
  "not_joined",
  /** Second `join` sur la même connexion. */
  "already_joined",
  /** Salle pleine (`MAX_PLAYERS`). */
  "room_full",
  /** `start` envoyé par un joueur qui n'est pas le host. */
  "not_host",
  /** `start` sur une salle déjà démarrée. */
  "already_running",
  /** Commande, hash ou snapshot reçus alors que la salle n'a pas démarré. */
  "not_running",
  /** Snapshot trop vieux : l'historique de bundles ne couvre plus son tick. */
  "history_gap",
  /** Pas de host disponible pour fournir un snapshot. */
  "no_host",
] as const;

export type ErrorCode = (typeof ERROR_CODES)[number];

/**
 * Codes de `world_error`. Liste ouverte comme `ERROR_CODES` : un client ne
 * doit pas exiger d'y appartenir.
 */
export const WORLD_ERROR_CODES = [
  /** Case hors du globe (identifiant négatif ou au-delà du nombre de cases). */
  "bad_tile",
  /** Case sous l'eau : on ne fonde pas de colonie sur l'océan. */
  "not_land",
  /** Case déjà colonisée. */
  "occupied",
  /** Case libre alors que l'action exige une colonie (`visit`, `abandon`). */
  "not_settled",
  /** Colonie fondée par quelqu'un d'autre. */
  "not_owner",
  /** Action de monde reçue avant `world_join`. */
  "not_in_world",
] as const;

export type WorldErrorCode = (typeof WORLD_ERROR_CODES)[number];
