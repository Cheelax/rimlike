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
 * Ticks d'une **journée de jeu** sur une carte (`sim::TICKS_PER_DAY`) : quatre
 * minutes réelles à 60 ticks/s. Contrat avec le sim, à changer des deux côtés.
 */
export const TICKS_PER_DAY = 14_400;

/**
 * Ticks d'une **heure de jeu du monde** : `TICKS_PER_DAY / 24`. C'est le taux
 * de change entre l'horloge du globe (en heures de jeu, `WORLD_HOUR_MS`) et
 * les ticks d'une carte — il ne sert qu'à ça : convertir le temps qu'une
 * colonie a passé gelée en ticks d'avance rapide (`frozenTicks`, §11.6).
 */
export const TICKS_PER_HOUR = TICKS_PER_DAY / 24;

/**
 * Avance rapide maximale d'une colonie gelée, en ticks : 60 jours de jeu.
 * Même borne que `sim::MAX_FAST_FORWARD` — au-delà, le sim tronquerait de
 * toute façon, autant ne pas transporter un nombre qui ment.
 */
export const MAX_FROZEN_TICKS = TICKS_PER_DAY * 60;

/**
 * Convertit un temps gelé, en **heures de jeu du monde**, en ticks d'avance
 * rapide : arrondi au tick, jamais négatif (une horloge qui recule ne fait pas
 * remonter le temps d'une colonie), et borné à `MAX_FROZEN_TICKS`. Une entrée
 * non finie donne 0. C'est le calcul de `snapshot.frozenTicks` (§11.6).
 */
export function frozenTicksForHours(elapsedHours: number): number {
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
    return 0;
  }
  return Math.min(MAX_FROZEN_TICKS, Math.round(elapsedHours * TICKS_PER_HOUR));
}

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

/**
 * Durée réelle d'une **heure de jeu** du monde, en millisecondes : 30 s, donc
 * un jour de monde en 12 min. C'est l'unité de l'horloge du globe, celle qui
 * fait avancer les caravanes (`docs/protocol.md` §12) — sans rapport avec les
 * ticks d'une salle, qui numérotent la simulation d'une carte.
 *
 * Le serveur la lit dans `WORLD_HOUR_MS` ; un client qui veut animer une
 * caravane entre deux `world_caravans` a besoin de la même valeur.
 */
export const WORLD_HOUR_MS = 30_000;

/**
 * Période du tick du monde : le serveur fait avancer les caravanes et diffuse
 * `world_caravans` au plus une fois par `CARAVAN_TICK_MS`, même si dix
 * changements surviennent entre deux.
 */
export const CARAVAN_TICK_MS = 5000;

/**
 * Une caravane livrée reste visible dans `world_caravans` pendant ce nombre
 * d'heures de jeu, puis disparaît de la liste : le client peut afficher les
 * arrivées récentes sans tenir d'historique.
 */
export const CARAVAN_HISTORY_HOURS = 24;

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

/**
 * Résumé d'affichage d'une caravane, **fourni par le client** qui l'expédie :
 * le serveur ne décode jamais le manifeste (c'est du postcard produit par le
 * sim, comme les commandes), il ne peut donc pas savoir seul ce qu'elle
 * transporte. Le résumé sert au globe et aux notifications ; il n'a aucune
 * valeur d'autorité et ne doit rien décider dans le sim.
 */
export interface CaravanSummary {
  /** Nombre de colons du convoi. */
  readonly pawns: number;
  /** Marchandises, `[kind, count]` avec `kind` la valeur de `items::ItemKind`. */
  readonly items: readonly (readonly [number, number])[];
}

/**
 * `travelling` : en route vers `toTile`.
 * `returning` : annulée avant la moitié, elle refait le trajet vers son point
 * de départ (`toTile` devient alors la case d'origine).
 * `arrived` : parvenue à destination, en attente d'être injectée dans la carte
 * par l'hôte de la salle d'arrivée.
 * `delivered` : l'hôte a confirmé l'injection ; la caravane reste listée
 * `CARAVAN_HISTORY_HOURS` heures de jeu, puis disparaît.
 */
export type CaravanStatus = "travelling" | "returning" | "arrived" | "delivered";

/**
 * Une caravane en voyage sur le globe, telle que le serveur la diffuse. Les
 * dates sont en **heures de jeu du monde** (voir `WORLD_HOUR_MS`), pas en
 * millisecondes ni en ticks de salle.
 *
 * `progress` et `currentTile` sont dérivés du temps par le serveur et
 * recalculés à chaque diffusion : un client peut les interpoler entre deux
 * `world_caravans`, mais c'est le serveur qui fait autorité.
 */
export interface Caravan {
  /** Identifiant attribué par le serveur, unique et stable pour la vie du monde. */
  readonly id: string;
  /** Nom du joueur qui l'a expédiée (l'identité v1 est le nom). */
  readonly owner: string;
  readonly fromTile: number;
  readonly toTile: number;
  /** Cases traversées, `[fromTile, …, toTile]` (le `Route.tiles` du globe). */
  readonly route: readonly number[];
  /** Heure de jeu du départ. */
  readonly departedAt: number;
  /** Heure de jeu de l'arrivée prévue (ou constatée). */
  readonly arrivesAt: number;
  /** Avancement dans `[0, 1]`, linéaire sur la durée du trajet. */
  readonly progress: number;
  /** Case courante, `route[floor(progress × (route.length − 1))]`. */
  readonly currentTile: number;
  readonly summary: CaravanSummary;
  readonly status: CaravanStatus;
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

/**
 * Expédier une caravane depuis la case `fromTile`. Envoyé par un joueur
 * **présent dans la salle de `fromTile`** (v1 : propriétaire ou simple
 * visiteur, voir `docs/protocol.md` §12) et déjà entré dans le monde.
 *
 * `manifest` est l'encodage postcard du convoi produit par le sim, opaque pour
 * le serveur, qui se contente de le transporter jusqu'à la case d'arrivée.
 */
export interface CaravanDepartMessage {
  readonly type: "caravan_depart";
  readonly fromTile: number;
  readonly toTile: number;
  /** Manifeste du sim, en octets opaques (base64 sur le fil). */
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
}

/**
 * Faire demi-tour. Refusé (`caravan_too_late`) au-delà de la moitié du trajet :
 * passé ce point la caravane est plus près de sa destination que de chez elle.
 */
export interface CaravanCancelMessage {
  readonly type: "caravan_cancel";
  readonly id: string;
}

/**
 * L'hôte de la salle d'arrivée confirme avoir émis la commande d'entrée du
 * convoi en lockstep. Tant que le serveur ne l'a pas reçu, la caravane reste
 * `arrived` et son `caravan_arrive` est réémis (nouvel hôte, réouverture).
 */
export interface CaravanDeliveredMessage {
  readonly type: "caravan_delivered";
  readonly id: string;
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
  | WorldLeaveMessage
  | CaravanDepartMessage
  | CaravanCancelMessage
  | CaravanDeliveredMessage;

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

/**
 * Snapshot relayé au joueur qui rejoint, avant le rejeu des bundles.
 *
 * `frozenTicks` n'apparaît qu'à la **réouverture d'une colonie gelée**
 * (`docs/protocol.md` §11.6) et vaut le temps passé sans personne sur la case,
 * converti en ticks (`frozenTicksForHours`). Le premier arrivant — qui est
 * l'hôte — émet alors `FastForward { ticks: frozenTicks }` en **première
 * commande** après avoir restauré l'état : le rattrapage passe par le lockstep
 * comme n'importe quel ordre, donc tous les clients l'appliquent au même tick.
 * Absent (ou 0) : rien à rattraper, la colonie reprend où elle s'était
 * arrêtée. Le champ est facultatif : un serveur qui ne le connaît pas et un
 * client qui l'ignore restent compatibles.
 */
export interface ServerSnapshotMessage {
  readonly type: "snapshot";
  readonly tick: number;
  readonly data: Uint8Array;
  readonly frozenTicks?: number;
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

/**
 * Toutes les caravanes connues du monde, diffusé aux joueurs présents dans le
 * monde à chaque changement et au plus une fois par `CARAVAN_TICK_MS`. Liste
 * complète comme `world_settlements` : le client remplace la sienne.
 */
export interface WorldCaravansMessage {
  readonly type: "world_caravans";
  readonly caravans: readonly Caravan[];
}

/**
 * Une caravane est arrivée sur la case d'une salle en jeu : envoyé à **l'hôte**
 * de cette salle, qui doit émettre la commande d'entrée du convoi en lockstep
 * puis répondre `caravan_delivered`. Le message est réémis si l'hôte change ou
 * si la salle rouvre sans que la livraison ait été confirmée.
 */
export interface CaravanArriveMessage {
  readonly type: "caravan_arrive";
  readonly id: string;
  /** Case d'arrivée : celle de la salle qui reçoit ce message. */
  readonly tile: number;
  /** Le manifeste tel qu'expédié, jamais décodé par le serveur. */
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
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
  | WorldErrorMessage
  | WorldCaravansMessage
  | CaravanArriveMessage;

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
  /** Caravane inconnue, ou dans un état qui ne se prête pas à l'action. */
  "caravan_not_found",
  /** Aucun itinéraire terrestre entre les deux cases (`findRoute` rend `null`). */
  "caravan_no_route",
  /** Départ et arrivée sont la même case. */
  "caravan_same_tile",
  /** Expédier ou livrer sans être dans la salle de la case concernée. */
  "caravan_not_in_room",
  /** Annulation demandée après la moitié du trajet. */
  "caravan_too_late",
] as const;

export type WorldErrorCode = (typeof WORLD_ERROR_CODES)[number];
