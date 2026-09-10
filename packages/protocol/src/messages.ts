/**
 * Messages échangés entre un client et le serveur relais, et constantes du
 * lockstep. Rien ici ne connaît le contenu des commandes : elles voyagent en
 * octets opaques, produits et relus par le sim.
 *
 * Direction des noms : `Client*` = client → serveur, `Server*` = serveur → client.
 * Deux types de message portent le même nom de wire dans les deux sens
 * (`start`, `snapshot`) avec une forme différente : ils ont donc deux types.
 */

/**
 * Incrémenté à chaque changement incompatible de forme des messages.
 * Passé à 2 quand l'identité d'un joueur du monde a cessé d'être son nom pour
 * devenir un jeton (`WorldJoinMessage.token`, `docs/protocol.md` §11.2) : la
 * forme de `world_welcome`, `world_players`, `Settlement` et `Caravan` a
 * changé (clé de joueur en plus du nom, ou à sa place).
 *
 * Passé à 3 avec l'**échelle du jour** (`start.dayScale`, `docs/protocol.md`
 * §3.2) : un client d'avant ignorerait le champ, construirait son sim à
 * l'échelle 1 et divergerait au premier tick — une désync silencieuse, le pire
 * des échecs. La montée de version le fait refuser proprement à `join`
 * (`version_mismatch`) au lieu de le laisser entrer.
 */
export const PROTOCOL_VERSION = 3;

/** Ticks de simulation par seconde. Contrat partagé par tous les clients. */
export const TICK_RATE = 60;

/** Ticks couverts par un bundle. 3 ticks à 60/s = 20 bundles/s. */
export const BUNDLE_TICKS = 3;

/** Période d'émission d'un bundle, en millisecondes réelles. */
export const BUNDLE_INTERVAL_MS = (1000 / TICK_RATE) * BUNDLE_TICKS;

/**
 * Un client envoie son hash d'état tous les N ticks (5 s réelles).
 *
 * Comme `BUNDLE_TICKS`, `SNAPSHOT_EVERY_TICKS`, `RESYNC_COOLDOWN_TICKS` et
 * `MAX_HISTORY_BUNDLES`, cette constante est en **temps réel** : elle compte
 * des ticks joués à 60 par seconde, quelle que soit l'échelle du jour de la
 * partie. Elle ne se met donc jamais à l'échelle — à K = 30, un hash toutes
 * les 5 s réelles reste toutes les 5 s réelles, même si cela ne fait plus
 * qu'un instant de jeu.
 */
export const HASH_EVERY_TICKS = 300;

/**
 * Ticks d'une **journée de jeu** sur une carte à l'échelle 1
 * (`sim::TICKS_PER_DAY`) : quatre minutes réelles à 60 ticks/s. Contrat avec
 * le sim, à changer des deux côtés. Ce n'est **pas** la longueur d'un jour :
 * une partie porte une échelle du jour `K` qui la multiplie, voir
 * `ticksPerDay(dayScale)` et `docs/time.md`.
 */
export const TICKS_PER_DAY = 14_400;

/**
 * Ticks d'une **heure de jeu du monde** à l'échelle 1 : `TICKS_PER_DAY / 24`.
 * Comme `TICKS_PER_DAY`, c'est l'unité de K = 1 ; l'heure d'une partie
 * d'échelle `K` vaut `ticksPerHour(K)`.
 */
export const TICKS_PER_HOUR = TICKS_PER_DAY / 24;

// --- Échelle du jour (`docs/time.md`, `docs/PLAN.md` §6) ---

/**
 * Bornes de l'échelle du jour, le contrat de `sim::DayScale`
 * (`DAY_SCALE_MIN`/`DAY_SCALE_MAX`) : au-delà, le sim retomberait
 * silencieusement sur 1 et la frontière réseau ne laisse pas passer une
 * valeur dont elle ne peut pas garantir l'effet.
 */
export const DAY_SCALE_MIN = 1;
export const DAY_SCALE_MAX = 120;

/**
 * Échelle d'une partie dont personne n'impose l'échelle : 1, le rythme
 * d'origine (un jour de jeu en quatre minutes réelles). C'est ce que vaut un
 * `start` **sans** `dayScale` — donc toute salle simple servie par un serveur
 * qui ne connaît pas le champ.
 */
export const DEFAULT_DAY_SCALE = 1;

/**
 * Échelle du **monde partagé** : 30 (mesurée en campagne, `docs/PLAN.md` §6 et
 * §8 du 2026-09-10). Un jour de jeu y dure 14 400 × 30 = 432 000 ticks, soit
 * 2 h réelles à 60 ticks/s ; une heure de jeu, 5 minutes ; une saison, 30 h ;
 * une année, 5 jours. Le serveur la lit dans `WORLD_DAY_SCALE` et l'impose à
 * toutes ses salles (`start.dayScale`).
 */
export const WORLD_DAY_SCALE = 30;

/** Vrai si `value` est une échelle du jour acceptable (`DAY_SCALE_MIN..=MAX`). */
export function isDayScale(value: unknown): value is number {
  return (
    typeof value === "number" &&
    Number.isSafeInteger(value) &&
    value >= DAY_SCALE_MIN &&
    value <= DAY_SCALE_MAX
  );
}

/**
 * Ticks d'une journée de jeu d'une partie d'échelle `dayScale`
 * (`Sim::ticks_per_day()`). Une échelle absurde retombe sur 1, comme le fait
 * le sim lui-même.
 *
 * Le client n'appelle **pas** cette fonction pour son HUD : il lit
 * `ticks_per_day()` dans le sim (`frame.ticksPerDay`), seule source qui ne
 * puisse pas mentir. Elle sert au serveur, qui n'a pas de sim.
 */
export function ticksPerDay(dayScale: number = DEFAULT_DAY_SCALE): number {
  return TICKS_PER_DAY * (isDayScale(dayScale) ? dayScale : DEFAULT_DAY_SCALE);
}

/** Ticks d'une heure de jeu d'une partie d'échelle `dayScale` : `ticksPerDay / 24`. */
export function ticksPerHour(dayScale: number = DEFAULT_DAY_SCALE): number {
  return ticksPerDay(dayScale) / 24;
}

/**
 * **Une seule horloge** (`docs/PLAN.md` §6) : la durée réelle d'une heure de
 * jeu du monde se **déduit** de l'échelle du jour, elle ne se règle plus à
 * part. Une heure de jeu vaut `ticksPerHour(K)` ticks, joués à `TICK_RATE`
 * ticks par seconde — soit 10 000 × K millisecondes.
 *
 * À l'échelle du monde (30) : 300 000 ms, cinq minutes réelles par heure de
 * jeu, deux heures réelles par jour de monde.
 */
export function worldHourMsFor(dayScale: number = DEFAULT_DAY_SCALE): number {
  return (ticksPerHour(dayScale) / TICK_RATE) * 1000;
}

/**
 * Avance rapide maximale d'une colonie gelée à l'échelle 1, en ticks : 60
 * jours de jeu. Même borne que `sim::MAX_FAST_FORWARD` — au-delà, le sim
 * tronquerait de toute façon, autant ne pas transporter un nombre qui ment.
 * Le sim la met à l'échelle (`self.scaled(MAX_FAST_FORWARD)`), donc
 * `maxFrozenTicks(K)` ici aussi.
 */
export const MAX_FROZEN_TICKS = TICKS_PER_DAY * 60;

/** Les mêmes 60 jours de jeu, à l'échelle `dayScale`. */
export function maxFrozenTicks(dayScale: number = DEFAULT_DAY_SCALE): number {
  return ticksPerDay(dayScale) * 60;
}

/**
 * Jours d'une année de jeu sur une carte (`sim::climate::YEAR_DAYS`) : quatre
 * saisons de 15 jours. Contrat avec le sim, à changer des deux côtés — c'est
 * aussi le modulo de `worldDayOfYear` et la borne de `start.dayOfYear`.
 */
export const YEAR_DAYS = 60;

/**
 * Jour de l'année du **monde**, déduit de son horloge (en heures de jeu,
 * `WorldClock.hours()` côté serveur) : un jour de monde dure 24 heures de jeu,
 * comme une journée de carte dure `TICKS_PER_DAY` ticks. C'est ce qui impose
 * le jour de l'année d'une colonie neuve (`start.dayOfYear`,
 * `docs/protocol.md` §11.6 et §12.1) — la même case du globe, visitée deux
 * fois à des instants différents, ne recommence pas systématiquement au
 * printemps. Toujours dans `0..YEAR_DAYS` ; une entrée non finie ou négative
 * donne 0 (le monde vient de naître).
 */
export function worldDayOfYear(worldHours: number): number {
  if (!Number.isFinite(worldHours) || worldHours <= 0) {
    return 0;
  }
  return Math.floor(worldHours / 24) % YEAR_DAYS;
}

/**
 * Convertit un temps gelé, en **heures de jeu du monde**, en ticks d'avance
 * rapide : arrondi au tick, jamais négatif (une horloge qui recule ne fait pas
 * remonter le temps d'une colonie), et borné à `maxFrozenTicks(dayScale)`. Une
 * entrée non finie donne 0. C'est le calcul de `snapshot.frozenTicks` (§11.6).
 *
 * `dayScale` est l'échelle du jour de la salle : une heure de jeu vaut
 * `ticksPerHour(K)` ticks de carte, et la borne des 60 jours suit la même
 * échelle que `sim::MAX_FAST_FORWARD`. Omise, l'échelle 1 s'applique.
 */
export function frozenTicksForHours(elapsedHours: number, dayScale: number = DEFAULT_DAY_SCALE): number {
  if (!Number.isFinite(elapsedHours) || elapsedHours <= 0) {
    return 0;
  }
  return Math.min(maxFrozenTicks(dayScale), Math.round(elapsedHours * ticksPerHour(dayScale)));
}

/**
 * Dans une salle « case » du monde, le serveur demande à l'hôte un snapshot de
 * conservation tous les N ticks (1800 ticks = 30 s à 60 ticks/s). Ce snapshot
 * ne sert personne en particulier : il est stocké pour rouvrir la colonie plus
 * tard. Sans effet dans une salle hors monde.
 *
 * En **temps réel** comme `HASH_EVERY_TICKS` : 30 s réelles entre deux
 * sauvegardes, à toute échelle du jour.
 */
export const SNAPSHOT_EVERY_TICKS = 1800;

/** Bundles conservés par salle pour le rejeu d'un joueur qui rejoint. */
export const MAX_HISTORY_BUNDLES = 2000;

/**
 * Cooldown d'une resynchronisation, en ticks : un déviant qui continue de
 * diverger à un point de contrôle suivant n'est pas resollicité avant ce
 * délai (pas de tempête de `request_snapshot`), et une demande manuelle
 * (`resync`) trop rapprochée de la précédente pour ce joueur est refusée
 * (`error resync_cooldown`). 1800 ticks = 30 s à 60 ticks/s, la même échelle
 * que `SNAPSHOT_EVERY_TICKS` (`docs/protocol.md` §7).
 */
export const RESYNC_COOLDOWN_TICKS = 1800;

/** Période du heartbeat serveur → client. */
export const HEARTBEAT_MS = 5000;

/** Silence toléré avant de fermer une connexion. */
export const HEARTBEAT_TIMEOUT_MS = 15000;

/** Joueurs simultanés par salle (phase 3 : 2 à 4 joueurs sur une carte). */
export const MAX_PLAYERS = 4;

/**
 * Durée réelle d'une **heure de jeu** du monde, en millisecondes, à l'échelle
 * du monde : `worldHourMsFor(WORLD_DAY_SCALE)` = 300 000, soit cinq minutes
 * réelles par heure de jeu et deux heures réelles par jour de monde.
 *
 * Ce n'est plus une valeur libre mais une **dérivée** : le monde n'a plus
 * d'horloge à part de l'échelle du jour (`docs/PLAN.md` §6, « une seule
 * horloge »). La variable d'environnement `WORLD_HOUR_MS` existe encore côté
 * serveur, mais **pour les tests d'intégration seulement** : elle sert à
 * voyager vite, jamais à régler le rythme d'un vrai monde — c'est
 * `WORLD_DAY_SCALE` qui le fait.
 *
 * Un client qui veut animer une caravane entre deux `world_caravans` a besoin
 * de la même valeur : il la déduit de l'échelle reçue dans `start.dayScale`.
 */
export const WORLD_HOUR_MS = worldHourMsFor(WORLD_DAY_SCALE);

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

/**
 * Marchands itinérants (`docs/protocol.md` §13) entretenus en permanence par
 * le serveur monde. Ce sont des caravanes **PNJ**, 100 % serveur : aucun
 * client ne les crée, ne les déplace ni ne les fait visiter. Le serveur lit la
 * valeur dans `WORLD_MERCHANTS` ; `0` en supprime toute trace.
 */
export const MERCHANT_COUNT = 2;

/**
 * Heures de jeu qu'un marchand passe sur une colonie avant de repartir vers la
 * suivante (`MERCHANT_STAY_HOURS` côté serveur) : un jour de monde, la même
 * durée que la visite d'un marchand dans le sim (`Command::TriggerTraderVisit`).
 */
export const MERCHANT_STAY_HOURS = 24;

/**
 * Arrivées de marchands mises en attente pour une colonie **fermée**
 * (`docs/protocol.md` §13) : au-delà, les suivantes sont oubliées. Trois
 * marchands d'affilée à l'ouverture suffisent largement ; en accumuler
 * davantage ferait débarquer une foire sur une colonie qui vient de se
 * réveiller.
 */
export const MAX_PENDING_TRADERS = 3;

// --- Réputation envers les factions PNJ (`docs/protocol.md` §14) ---

/**
 * Factions PNJ du sim (`sim::factions::FACTION_COUNT`) : 0 Clan des Cendres,
 * 1 Fraternité du Fer, 2 Guilde des Colporteurs. Fixe — la réputation voyage
 * comme un triplet dans l'ordre de leurs identifiants, jamais comme une table
 * indexée par nom. Contrat avec le sim, à changer des deux côtés.
 */
export const FACTION_COUNT = 3;

/**
 * Bornes de la réputation, en points (`sim::factions::GOODWILL_MIN`/`MAX`) :
 * hostile en dessous de −50, allié à partir de 50. Dupliquées ici comme
 * `MAX_FROZEN_TICKS` duplique `sim::MAX_FAST_FORWARD` — ce paquet n'a pas de
 * dépendance runtime.
 */
export const GOODWILL_MIN = -100;
export const GOODWILL_MAX = 100;

/**
 * Réputation d'une colonie envers les trois factions PNJ, dans l'ordre de
 * leurs identifiants. C'est la forme de `Command::SetGoodwill`
 * (`crates/sim/src/factions.rs`), et celle sous laquelle le serveur monde la
 * garde **par joueur** (`docs/protocol.md` §14).
 */
export type GoodwillValues = readonly [number, number, number];

/**
 * Réputation d'un joueur que le monde n'a encore jamais vu agir
 * (`sim::factions::START_GOODWILL`) : les deux tribus se méfient, la Guilde
 * commerce volontiers. Un joueur inconnu du serveur monde repart de là, comme
 * une colonie solo.
 */
export const DEFAULT_GOODWILL: GoodwillValues = [-20, -20, 10];

/**
 * Ramène trois réputations dans `GOODWILL_MIN..=GOODWILL_MAX`, en entiers.
 * Le serveur monde s'en sert sur ce qu'un client lui **remonte**
 * (`goodwill_report`) : il ne refuse pas une valeur excentrique, il la rogne,
 * puisque c'est lui qui la réimposera ensuite — les bornes du sim sont les
 * siennes, un client qui les dépasserait n'a pas à couper la connexion. Une
 * entrée non finie compte pour 0.
 */
export function clampGoodwill(values: GoodwillValues): GoodwillValues {
  const clamp = (value: number): number =>
    Number.isFinite(value) ? Math.min(GOODWILL_MAX, Math.max(GOODWILL_MIN, Math.trunc(value))) : 0;
  return [clamp(values[0]), clamp(values[1]), clamp(values[2])];
}

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
 * Un joueur connu du monde : sa clé publique et stable (`playerKey`), son nom
 * d'affichage courant, et s'il est présentement connecté au monde. C'est la
 * table de résolution clé → nom diffusée par `world_welcome` et
 * `world_players` (`docs/protocol.md` §11.2) — un joueur qui s'est déjà
 * connecté au moins une fois y reste, `online` distingue qui est là.
 */
export interface WorldPlayerInfo {
  readonly key: string;
  readonly name: string;
  readonly online: boolean;
}

/**
 * Une colonie posée sur une case du globe. Une case en porte au plus une.
 *
 * `owner` est la **clé** du joueur propriétaire (`WorldPlayerInfo.key`), pas
 * un nom : l'identité d'un joueur est son jeton, pas son libellé (voir
 * `docs/protocol.md` §11.2). `ownerName` est le nom d'affichage courant de ce
 * joueur, résolu par le serveur au moment de la diffusion — il peut changer
 * d'un message à l'autre si le joueur s'est reconnecté sous un autre nom,
 * `owner` jamais.
 *
 * `room` est la salle lockstep de la case (`tile-<id>`) et `seed` la graine de
 * carte imposée par le serveur : deux visites de la même case donnent la même
 * carte.
 */
export interface Settlement {
  /** Identifiant de case du globe (`Tile.id` de `@rimlike/world`). */
  readonly tile: number;
  readonly owner: string;
  readonly ownerName: string;
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
  /** Clé du joueur qui l'a expédiée (`WorldPlayerInfo.key`), pas un nom. */
  readonly owner: string;
  /** Nom d'affichage courant de l'expéditeur, résolu à la diffusion. */
  readonly ownerName: string;
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

/**
 * `travelling` : en route vers `toTile`. Un marchand qui n'a aucune colonie où
 * aller **attend sur place** et se reconnaît à `toTile === tile`.
 * `visiting` : à l'étal sur une colonie, pour `MERCHANT_STAY_HOURS` heures de
 * jeu, puis il repart vers la colonie fondée la plus proche.
 */
export type MerchantStatus = "travelling" | "visiting";

/**
 * Un marchand itinérant, tel que le serveur monde le diffuse
 * (`docs/protocol.md` §13). Contrairement à une `Caravan`, il n'a ni
 * propriétaire ni manifeste : c'est un PNJ, entièrement serveur, que le client
 * se contente d'afficher sur le globe.
 *
 * `tile` et `progress` sont **dérivés** du temps par le serveur à chaque
 * diffusion, comme `Caravan.currentTile`/`Caravan.progress` : un client peut
 * les interpoler entre deux messages, le serveur a le dernier mot. Les
 * coordonnées se déduisent de `tile` par la géométrie du globe
 * (`world.tiles[tile].center`), il n'y a rien à transporter de plus.
 */
export interface Merchant {
  /** Identifiant attribué par le serveur, stable pour la vie du marchand. */
  readonly id: string;
  /** Nom de compagnie, tiré à la naissance et déterministe par graine du globe. */
  readonly name: string;
  /** Case courante, dérivée de l'avancement sur l'itinéraire. */
  readonly tile: number;
  /** Case visée ; égale à `tile` quand le marchand attend une colonie où aller. */
  readonly toTile: number;
  readonly status: MerchantStatus;
  /** Avancement dans `[0, 1]` sur le trajet courant. */
  readonly progress: number;
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
 * Demande explicite du client de se resynchroniser sur l'état de l'hôte : le
 * serveur relance pour lui le mécanisme d'un rejoignant (`request_snapshot`
 * puis `snapshot` puis rejeu, `docs/protocol.md` §8 et §7). Refusée pour
 * l'hôte (`error host_cannot_resync` : en v1 l'hôte fait référence, se
 * resynchroniser sur soi-même n'a pas de sens), si la salle n'a pas démarré
 * (`not_running`), ou si une resynchronisation vient déjà d'être déclenchée
 * pour ce joueur, automatiquement ou manuellement, il y a moins de
 * `RESYNC_COOLDOWN_TICKS` (`resync_cooldown`).
 */
export interface ResyncMessage {
  readonly type: "resync";
}

/**
 * Connexion au **monde**, sans entrer dans une salle : le client reçoit la
 * liste des colonies et peut ensuite s'installer, visiter ou repartir. Une
 * connexion peut faire `world_join` puis `join` : le monde et la salle
 * cohabitent sur la même WebSocket.
 *
 * L'identité d'un joueur est son `token`, pas son `name` (`docs/protocol.md`
 * §11.2) :
 *
 * - **absent** : le serveur crée un nouveau joueur (clé et jeton neufs) et les
 *   renvoie dans `world_welcome` — c'est la seule fois où le jeton est
 *   transmis ;
 * - **connu** : le joueur est reconnu, quel que soit le `name` envoyé — qui
 *   peut différer de la dernière fois, `name` n'est qu'un libellé et se met à
 *   jour ;
 * - **inconnu** (jeton perdu, effacé, ou d'un autre serveur) : le serveur
 *   répond `world_error { code: "bad_token" }` et ferme la connexion — il n'y
 *   a pas de compte de secours, un jeton perdu est une identité perdue.
 */
export interface WorldJoinMessage {
  readonly type: "world_join";
  readonly name: string;
  /** Facultatif ; si présent et différent, le serveur répond `version_mismatch`. */
  readonly protocol?: number;
  /** Jeton reçu d'un précédent `world_welcome`. Absent : nouveau joueur. */
  readonly token?: string;
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

/**
 * L'hôte d'une salle « case » remonte la réputation de sa colonie envers les
 * trois factions PNJ, pour que le serveur monde la porte **par joueur** et la
 * réimpose à la colonie suivante (`docs/protocol.md` §14).
 *
 * La salle n'est pas dans le message : c'est celle de la connexion qui
 * l'envoie, et seul son **hôte** est écouté — un invité verrait la même
 * réputation, mais rien ne dit qu'il joue la colonie de son propre compte.
 * `values` est ce que le sim rend (`WasmSim.goodwill()`), dans l'ordre des
 * identifiants de faction ; le serveur le rogne à `GOODWILL_MIN..=GOODWILL_MAX`
 * plutôt que de refuser la trame (`clampGoodwill`).
 *
 * Le client le renvoie à intervalle régulier et à la fermeture de la colonie ;
 * le serveur n'a pas à le savoir et n'accepte qu'un rapport toutes les dix
 * secondes par salle — les suivants sont ignorés en silence.
 */
export interface GoodwillReportMessage {
  readonly type: "goodwill_report";
  readonly values: GoodwillValues;
}

export type ClientMessage =
  | JoinMessage
  | ClientStartMessage
  | CommandMessage
  | HashMessage
  | ClientSnapshotMessage
  | PingMessage
  | PongMessage
  | ResyncMessage
  | WorldJoinMessage
  | SettleMessage
  | VisitMessage
  | AbandonMessage
  | WorldLeaveMessage
  | CaravanDepartMessage
  | CaravanCancelMessage
  | CaravanDeliveredMessage
  | GoodwillReportMessage;

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

/**
 * Bornes de `StartClimate`, en dixièmes de °C : le même contrat que
 * `crates/sim/src/climate.rs` (`TEMPERATURE_MIN`/`MAX`,
 * `Climate::AMPLITUDE_MAX`) et que `@rimlike/world` (`CLIMATE_BASE_*`,
 * `CLIMATE_AMPLITUDE_*`), dupliqué ici comme `MAX_FROZEN_TICKS` duplique
 * `sim::MAX_FAST_FORWARD` : ce paquet n'a pas de dépendance runtime, donc pas
 * d'import de `@rimlike/world` pour trois entiers.
 */
export const CLIMATE_BASE_MIN = -2000;
export const CLIMATE_BASE_MAX = 2000;
export const CLIMATE_AMPLITUDE_MIN = 0;
export const CLIMATE_AMPLITUDE_MAX = 1000;

/**
 * Nombre de biomes du globe (`Biome` de `packages/world/src/biomes.ts`, et
 * `sim::Biome` côté Rust) : les valeurs valides vont de 0 à `BIOME_COUNT - 1`.
 * Dupliqué ici comme `CLIMATE_BASE_MIN` duplique la borne du sim — ce paquet
 * n'a pas de dépendance runtime, donc pas d'import de `@rimlike/world` pour un
 * entier.
 */
export const BIOME_COUNT = 10;

/**
 * Biome d'une colonie dont personne n'impose le biome : la forêt tempérée
 * (`Biome.TemperateForest`, 4). C'est la carte que rend le constructeur
 * `WasmSim` ordinaire, donc celle du solo et de toute salle hors monde — un
 * `start` sans `biome` veut dire « celle-là », pas « aucune ».
 */
export const DEFAULT_BIOME = 4;

/**
 * Climat à imposer au sim d'une colonie, en dixièmes de degré Celsius : la
 * forme attendue par `Command::SetClimate` (`crates/sim/src/climate.rs`).
 * Calculé par `@rimlike/world` (`climateForTile`) à partir de la température
 * et de la latitude de la case, jamais choisi par un client.
 */
export interface StartClimate {
  /** Moyenne annuelle, en dixièmes de °C. */
  readonly baseTemperature: number;
  /** Écart été/hiver, en dixièmes de °C. */
  readonly amplitude: number;
}

/**
 * Diffusé quand le host démarre. `tick` vaut 0 : le sim part de zéro.
 *
 * `climate`, `dayOfYear` et `biome` n'apparaissent que dans une salle « case »
 * (`docs/protocol.md` §11) : la colonie hérite du climat, du jour de
 * l'année et du biome de sa case du globe (`worldDayOfYear`, §12.1). Absents en salle
 * simple — le sim y garde son climat et son calendrier par défaut (printemps,
 * jour 0) tant que personne n'émet `SetClimate`/`SetCalendar`. Présents, ils
 * ne sont **imposés à personne** : c'est à l'hôte, et seulement lui, d'émettre
 * `encode_set_climate(baseTemperature, amplitude)` puis
 * `encode_set_calendar(dayOfYear)` en première et deuxième commandes après ce
 * `start` (`docs/protocol.md` §11.6) — ces champs ne font qu'informer tous les
 * clients de la valeur à attendre, pour qu'un HUD puisse l'afficher avant que
 * les commandes n'aient fait un aller-retour en lockstep.
 */
export interface ServerStartMessage {
  readonly type: "start";
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly tick: number;
  readonly climate?: StartClimate;
  /** Jour de l'année à imposer (`Command::SetCalendar`), dans `0..YEAR_DAYS`. */
  readonly dayOfYear?: number;
  /**
   * Biome de la case du globe (`0..BIOME_COUNT`), dont la carte de la colonie
   * hérite : sols, arbres, buissons, rochers, veines et eau en suivent
   * (`docs/protocol.md` §3.2, §11.6). À la différence de `climate` et de
   * `dayOfYear`, ce n'est **pas** une information à imposer par une commande :
   * le biome est fixé à la **construction** du sim (`WasmSim.new_in_biome`), il
   * n'existe pas de `Command::SetBiome` — après le premier tick, ce serait une
   * autre carte. Chaque client le lit donc dans ce `start` et construit son sim
   * avec, hôte comme invité. Absent en salle simple : le sim y prend le biome
   * par défaut (`DEFAULT_BIOME`, la forêt tempérée).
   */
  readonly biome?: number;
  /**
   * **Échelle du jour** de la partie (`sim::DayScale`, `DAY_SCALE_MIN..=MAX`),
   * imposée par le serveur à **toute** salle — « case » comme nommée
   * (`docs/protocol.md` §3.2). Elle multiplie la longueur du jour et les
   * durées de travail, jamais la marche ni le combat (`docs/time.md`).
   *
   * Même règle que `biome`, et pour la même raison : elle se fixe à la
   * **construction** du sim (`WasmSim.new_scaled`), il n'existe pas de
   * commande pour la changer — après le premier tick, ce serait une autre
   * partie. Tous les clients d'une salle la lisent ici et construisent avec ;
   * un seul qui l'ignorerait divergerait au premier tick, d'où la montée de
   * `PROTOCOL_VERSION` à 3.
   *
   * Absente : `DEFAULT_DAY_SCALE` (1). Le serveur l'omet quand elle vaut 1,
   * ce qui laisse le message d'une partie « rapide » identique à celui d'avant.
   */
  readonly dayScale?: number;
  /**
   * Marchands itinérants arrivés sur la case pendant que la colonie était
   * **fermée** (`docs/protocol.md` §13), au plus `MAX_PENDING_TRADERS`. L'hôte,
   * et lui seul, émet autant de `Command::TriggerTraderVisit` après ce `start`,
   * exactement comme il émet `FastForward` pour `snapshot.frozenTicks` : le
   * serveur ne simule pas, il ne fait que compter. Omis quand il vaut 0.
   */
  readonly pendingTraders?: number;
  /**
   * Réputation du **propriétaire** de la case envers les trois factions PNJ
   * (`docs/protocol.md` §14), portée par le serveur monde d'une colonie à
   * l'autre. Présente dans toute salle « case », absente en salle simple —
   * comme `climate` et `dayOfYear`, et pour la même raison : hors du globe, il
   * n'y a personne dont la réputation suivrait. Présente, elle n'impose rien
   * par elle-même : l'hôte, et lui seul, émet `Command::SetGoodwill` après ce
   * `start`, une seule fois.
   */
  readonly goodwill?: GoodwillValues;
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
  /**
   * Le pendant de `start.pendingTraders` pour une colonie qui rouvre **depuis
   * son snapshot conservé** : ce chemin-là ne diffuse aucun `start`
   * (`docs/protocol.md` §11.6), le compte voyage donc ici, à côté de
   * `frozenTicks` et avec la même règle — le premier arrivant est l'hôte, lui
   * seul émet les `Command::TriggerTraderVisit` correspondantes, une par
   * marchand. Omis quand il vaut 0.
   */
  readonly pendingTraders?: number;
  /**
   * Réputation du propriétaire de la case, comme `start.goodwill` — mais ici
   * elle est **la valeur du joueur**, pas celle que le sim porte dans `data`
   * (`docs/protocol.md` §14). C'est toute la différence avec le climat et le
   * calendrier, que le snapshot restauré porte déjà et qu'on se garde bien de
   * réémettre : la réputation, elle, a continué de vivre dans les **autres**
   * colonies du joueur pendant que celle-ci dormait, et c'est cette
   * valeur-là qui fait foi. L'hôte — le premier arrivant — émet
   * `Command::SetGoodwill` une seule fois, **après** `FastForward` : l'avance
   * rapide adoucit les rancunes d'un point par jour (`sim::factions::FADE_PER_DAY`),
   * et la valeur imposée ici est déjà à jour, elle n'a pas à revieillir.
   */
  readonly goodwill?: GoodwillValues;
  /**
   * Biome de la case, comme `start.biome` — mais ici **aucun client n'a rien à
   * en faire pour le sim** : le biome est fixé à la construction, et le sim que
   * `data` restaure porte déjà sa carte. Le champ ne sert qu'à l'**affichage**
   * (le HUD peut nommer le biome avant la première frame) et c'est la seule
   * raison de sa présence : contrairement à `frozenTicks` ou `goodwill`, il ne
   * déclenche aucune commande. Absent en salle simple.
   */
  readonly biome?: number;
  /**
   * Échelle du jour de la salle, comme `start.dayScale` — et ici, exactement
   * comme `biome`, **purement informative** : le sim que `data` restaure porte
   * déjà son échelle (elle est dans le snapshot, `docs/time.md`). Le champ
   * sert au HUD et au diagnostic, il ne déclenche aucune commande et aucune
   * construction. Absente : `DEFAULT_DAY_SCALE` (1).
   */
  readonly dayScale?: number;
}

/**
 * Premier écart de hash constaté. Les clés de `hashes` sont des identifiants
 * de joueur (chaînes après passage par JSON).
 *
 * `outliers` liste les joueurs déviants au sens de `HashLedger.outliers` : la
 * valeur majoritaire à ce tick fait référence, les autres sont les déviants.
 * Absent (jamais un tableau vide sur le fil) quand aucune majorité n'est
 * connue — il faut au moins trois hashes pour ce tick, donc systématiquement
 * absent à deux joueurs, faute de pouvoir départager qui a raison. Facultatif
 * pour la compatibilité d'un ancien serveur ou d'un ancien client
 * (`docs/protocol.md` §7).
 */
export interface DesyncMessage {
  readonly type: "desync";
  readonly tick: number;
  readonly hashes: Readonly<Record<PlayerId, string>>;
  readonly outliers?: readonly PlayerId[];
}

/**
 * Une resynchronisation a réussi : `player` a de nouveau annoncé, au point de
 * contrôle `tick`, un hash égal à la majorité (`HashLedger.majorityHash`).
 * Diffusé à tous ; la salle quitte l'état `desynced` si plus personne ne
 * dévie (`docs/protocol.md` §7).
 */
export interface ResyncedMessage {
  readonly type: "resynced";
  readonly player: PlayerId;
  readonly tick: number;
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
 *
 * `playerKey` est l'identité **publique** et stable du joueur (à conserver
 * pour retrouver ses colonies dans `settlements`/`world_settlements`).
 * `token` est le secret correspondant : présent **uniquement** à la création
 * d'un nouveau joueur (`WorldJoinMessage.token` absent ou inconnu du serveur —
 * dans ce dernier cas c'est `world_error { code: "bad_token" }` qui répond,
 * pas ce message). Le client doit le garder (`localStorage`, par serveur) et
 * le renvoyer dans son prochain `world_join` : c'est la seule fois où le
 * serveur l'envoie, il n'est jamais rejoué à une reconnexion reconnue.
 *
 * `playerId`, lui, n'a rien d'une identité : c'est un simple compteur de
 * connexion, remis à zéro à chaque redémarrage, qui ne sert qu'à
 * `request_snapshot.forPlayer` (§8). Ne pas le confondre avec `playerKey`.
 */
export interface WorldWelcomeMessage {
  readonly type: "world_welcome";
  readonly playerId: PlayerId;
  readonly playerKey: string;
  readonly name: string;
  /** Présent uniquement à la création d'un nouveau joueur. Jamais rejoué. */
  readonly token?: string;
  readonly settlements: readonly Settlement[];
  /** Tous les joueurs déjà vus par le monde, connectés ou non. */
  readonly players: readonly WorldPlayerInfo[];
  readonly world: WorldInfo;
}

/** Diffusé à tous les joueurs du monde à chaque fondation ou abandon. */
export interface WorldSettlementsMessage {
  readonly type: "world_settlements";
  readonly settlements: readonly Settlement[];
}

/** Diffusé à chaque connexion ou déconnexion du monde, et à chaque renommage. */
export interface WorldPlayersMessage {
  readonly type: "world_players";
  readonly players: readonly WorldPlayerInfo[];
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
  /**
   * Marchands itinérants du globe (`docs/protocol.md` §13), diffusés par le
   * même message et à la même cadence que les caravanes des joueurs : liste
   * complète, le client remplace la sienne. **Facultatif** — un serveur qui ne
   * connaît pas les marchands n'envoie rien, et un client qui les ignore reste
   * compatible.
   */
  readonly merchants?: readonly Merchant[];
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

/**
 * Un marchand itinérant vient d'arriver sur la case d'une colonie **ouverte et
 * en jeu** : envoyé à son seul **hôte** (`docs/protocol.md` §13), qui répond en
 * émettant `Command::TriggerTraderVisit` en lockstep — un marchand neutre entre
 * alors sur la carte et y reste un jour, comme celui du storyteller local.
 *
 * Rien à confirmer au serveur, contrairement à `caravan_arrive` : il n'y a
 * aucun manifeste à ne pas perdre, seulement une occasion de commerce. Une
 * arrivée sur une colonie **fermée** ne produit pas ce message mais un
 * `pendingTraders` remis à l'ouverture suivante (`start`, ou `snapshot` pour
 * une colonie qui rouvre depuis son état conservé).
 */
export interface TraderArrivalMessage {
  readonly type: "trader_arrival";
  /** Case d'arrivée : celle de la salle qui reçoit ce message. */
  readonly tile: number;
  readonly merchantId: string;
  /** Nom de compagnie, pour l'annoncer dans le HUD. */
  readonly merchantName: string;
}

export type ServerMessage =
  | WelcomeMessage
  | PlayersMessage
  | ServerStartMessage
  | BundleMessage
  | RequestSnapshotMessage
  | ServerSnapshotMessage
  | DesyncMessage
  | ResyncedMessage
  | ErrorMessage
  | PingMessage
  | PongMessage
  | WorldWelcomeMessage
  | WorldSettlementsMessage
  | WorldPlayersMessage
  | SettledMessage
  | WorldErrorMessage
  | WorldCaravansMessage
  | CaravanArriveMessage
  | TraderArrivalMessage;

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
  /** `resync` envoyé par le host : en v1 il fait référence, rien à corriger. */
  "host_cannot_resync",
  /** `resync` refusé : une resynchronisation vient déjà d'être déclenchée pour ce joueur. */
  "resync_cooldown",
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
  /** `world_join.token` ne correspond à aucun joueur connu. */
  "bad_token",
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
