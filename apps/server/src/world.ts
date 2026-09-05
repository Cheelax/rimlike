/**
 * État du monde côté serveur : qui possède quelle case, et le dernier état
 * connu de chaque colonie.
 *
 * Le globe lui-même (géométrie, biomes, itinéraires) vient de
 * `@rimlike/world` : ce module ne le recalcule pas, il ne fait que le
 * consulter (`movementCost(biome)` pour savoir si une case est terrestre).
 * `WorldState` est **pure** — pas de réseau, pas d'horloge imposée, pas de
 * disque — donc testable sans serveur.
 *
 * Modèle, tel que décidé pour cette tranche (`docs/protocol.md` §11) :
 *
 * - une case = une colonie possible, au plus une colonie par case ;
 * - la salle lockstep d'une case s'appelle `tile-<id>` ;
 * - sa graine de carte est `mixTileSeed(worldSeed, tileId)` : déterministe,
 *   donc deux visites de la même case donnent la même carte, et le serveur
 *   n'a rien à stocker pour la retrouver ;
 * - l'identité d'un joueur est un **jeton** secret, pas son nom (`docs/protocol.md`
 *   §11.2) : `createPlayer` engendre une clé publique (`key`, un uuid) et un
 *   jeton (32 octets aléatoires en base64url), remis une seule fois au client
 *   dans `world_welcome`. Une reconnexion prouve son identité en présentant ce
 *   jeton (`playerByToken`, comparaison en temps constant) ; le nom, lui,
 *   n'est plus qu'un libellé, mis à jour librement à chaque connexion
 *   (`renamePlayer`). Les colonies (`Settlement.owner`) et les caravanes
 *   (`Caravan.owner`) réfèrent la **clé**, jamais le nom — `nameOf` la résout
 *   à la diffusion, dans `ownerName`.
 *
 * S'y ajoutent, depuis la tranche « caravanes » (`docs/protocol.md` §12), une
 * **horloge de jeu** (`WorldClock`, en heures de jeu) et le registre des
 * caravanes en voyage (`CaravanRegistry`), tous deux persistés avec le reste ;
 * puis, depuis la tranche « marchands » (§13), le registre des marchands
 * itinérants PNJ (`MerchantRegistry`) et le compte de marchands en attente sur
 * une colonie fermée (`StoredSettlement.pendingTraders`).
 *
 * `toJSON` / `fromJSON` font l'aller-retour complet (colonies, dernier
 * snapshot de chaque salle, horloge, caravanes et joueurs) en un objet JSON :
 * c'est ce que `WorldStore` (`persistence.ts`) écrit et relit sur disque, pour
 * qu'un redémarrage du serveur ne perde ni les colonies, ni leurs snapshots
 * conservés, ni les jetons de leurs joueurs. Ce module n'y touche pas
 * lui-même — il reste pur — voir `docs/protocol.md` §11.8. `fromJSON` migre
 * aussi un fichier antérieur à cette tranche (v1, « identité = le nom ») : les
 * noms de propriétaire qu'il contient deviennent des joueurs créés à la
 * volée, avec un jeton **neuf** — l'ancien propriétaire ne peut pas être
 * reconnu sans jeton connu, voir `docs/protocol.md` §11.8.
 */

import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";

import {
  MAX_PENDING_TRADERS,
  WORLD_HOUR_MS,
  base64ToBytes,
  bytesToBase64,
  frozenTicksForHours,
  type Settlement,
} from "@rimlike/protocol";
import { generateWorld, movementCost, tileCount, type World } from "@rimlike/world";

import { CaravanRegistry, type CaravanRegistryJson } from "./caravans.js";
import { MerchantRegistry, type MerchantRegistryJson } from "./merchants.js";

/** Graine du globe par défaut (surchargée par `WORLD_SEED`). */
export const DEFAULT_WORLD_SEED = 1;

/**
 * Subdivisions par défaut (surchargées par `WORLD_SUBDIVISIONS`) : 4, soit
 * 2 562 cases. La cible de production est 5 (10 242 cases), plus lente à
 * générer et quatre fois plus lourde à servir.
 */
export const DEFAULT_WORLD_SUBDIVISIONS = 4;

/** Préfixe des salles adossées à une case du globe. */
export const TILE_ROOM_PREFIX = "tile-";

/** Nom de la salle lockstep d'une case. */
export function tileRoomName(tileId: number): string {
  return `${TILE_ROOM_PREFIX}${tileId}`;
}

/**
 * Case d'une salle « case », ou `null` si le nom n'en désigne pas une. Strict
 * exprès : `tile-007` et `tile-1.5` ne sont pas des noms de salle de case, un
 * identifiant n'a qu'une écriture.
 */
export function tileFromRoomName(room: string): number | null {
  if (!room.startsWith(TILE_ROOM_PREFIX)) {
    return null;
  }
  const digits = room.slice(TILE_ROOM_PREFIX.length);
  if (!/^(0|[1-9][0-9]*)$/.test(digits)) {
    return null;
  }
  return Number(digits);
}

/**
 * Graine de carte d'une case : mélange 32 bits du seed du monde et de
 * l'identifiant de case (finaliseur de type murmur3, en `Math.imul` pour
 * rester en entiers exacts). Déterministe et bien dispersé — deux cases
 * voisines ne doivent pas donner deux cartes voisines.
 */
export function mixTileSeed(worldSeed: number, tileId: number): number {
  let h = ((worldSeed | 0) ^ 0x9e37_79b9) >>> 0;
  h = Math.imul(h ^ (tileId | 0), 0x85eb_ca6b) >>> 0;
  h = (h ^ (h >>> 13)) >>> 0;
  h = Math.imul(h, 0xc2b2_ae35) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Octets de jeton, avant encodage base64url (32 = 256 bits). */
const TOKEN_BYTES = 32;

/** Jeton secret : des octets aléatoires, en base64url (pas de `+`/`/`, lisible en URL). */
function randomToken(): string {
  return randomBytes(TOKEN_BYTES).toString("base64url");
}

/**
 * Un joueur du monde : sa clé publique et stable (`key`, un uuid), son nom
 * d'affichage courant (`name`, un simple libellé, mutable) et son jeton secret
 * (`token`). Le jeton est écrit tel quel dans le fichier de persistance
 * (`docs/protocol.md` §11.8) — il n'y a pas de compte à côté pour le
 * retrouver autrement, et le comparer en temps constant (`playerByToken`)
 * exige de le garder en clair, pas haché.
 */
export interface WorldPlayer {
  readonly key: string;
  name: string;
  readonly token: string;
  readonly createdAt: number;
}

/** Forme JSON d'un `WorldPlayer` : identique, le jeton voyage tel quel. */
export interface WorldPlayerJson {
  readonly key: string;
  readonly name: string;
  readonly token: string;
  readonly createdAt: number;
}

/**
 * Dernier état connu d'une salle « case ». `width` et `height` s'ajoutent au
 * couple `(tick, data)` parce qu'une salle rouverte depuis un snapshot doit
 * pouvoir répondre `welcome` avec la taille de carte : le protocole exige
 * `seed`, `width` et `height` ensemble ou pas du tout.
 */
export interface RoomSnapshot {
  /** Prochain tick à exécuter, donc nombre de ticks déjà appliqués. */
  readonly tick: number;
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Date d'enregistrement, en millisecondes epoch. */
  readonly savedAt: number;
  /**
   * Heure de jeu du monde (`WorldClock.hours`) au moment de l'enregistrement.
   * C'est l'origine du temps gelé : à la réouverture, l'écart avec l'heure
   * courante devient le `frozenTicks` du `snapshot` (`docs/protocol.md`
   * §11.6). **Facultatif** : un snapshot relu d'un fichier écrit avant cette
   * tranche n'en a pas, et ne donne alors aucune avance rapide — mieux vaut
   * une colonie qui reprend où elle en était qu'un rattrapage inventé.
   */
  readonly savedAtHours?: number;
}

/** Forme JSON de l'horloge du monde. */
export interface WorldClockJson {
  /** Date réelle de création du monde, en millisecondes epoch. */
  readonly worldStartedAt: number;
  /** Heures de jeu déjà écoulées à l'instant de l'enregistrement. */
  readonly hoursOffset: number;
}

export interface WorldClockOptions {
  /** Durée réelle d'une heure de jeu. Défaut : `WORLD_HOUR_MS` (30 s). */
  readonly hourMs?: number;
  /** Horloge murale, injectable pour les tests. Défaut : `Date.now`. */
  readonly now?: () => number;
  /** Date réelle de création du monde. Défaut : maintenant. */
  readonly worldStartedAt?: number;
  /** Heures de jeu déjà écoulées avant ce démarrage (relues d'une sauvegarde). */
  readonly hoursOffset?: number;
}

/**
 * L'horloge de jeu du globe : `hours()` rend les **heures de jeu** écoulées
 * depuis la création du monde. Une heure de jeu dure `hourMs` millisecondes
 * réelles (30 s par défaut, donc un jour de monde en 12 min). C'est l'unité de
 * tout ce qui voyage sur le globe ; elle n'a rien à voir avec les ticks d'une
 * salle, qui numérotent la simulation d'une **carte**.
 *
 * Le compte est **continu pendant que le serveur tourne** (pas de pause en
 * multi, `docs/PLAN.md` §3) mais **s'arrête quand il s'éteint** : au
 * redémarrage, `hoursOffset` reprend le total relu de la sauvegarde et repart
 * de zéro en temps réel. Le monde ne vieillit donc pas serveur éteint, et une
 * caravane partie avant l'arrêt reprend son voyage avec le même `arrivesAt`,
 * pas « rattrapée » par des heures qui ne se sont jamais jouées.
 *
 * `worldStartedAt` est la date **réelle** de création du monde. Elle ne sert
 * qu'à dater le monde pour un humain : ce n'est pas elle qui fait avancer
 * l'horloge, justement parce que le temps d'arrêt ne compte pas.
 */
export class WorldClock {
  /** Durée réelle d'une heure de jeu, en millisecondes. */
  readonly hourMs: number;
  /** Date réelle de création du monde, en millisecondes epoch. */
  readonly worldStartedAt: number;
  private readonly nowMs: () => number;
  private readonly hoursOffset: number;
  /** Instant réel du démarrage de cette session, origine du compte en cours. */
  private readonly sessionStartedAt: number;

  constructor(options: WorldClockOptions = {}) {
    this.hourMs = options.hourMs ?? WORLD_HOUR_MS;
    if (!Number.isFinite(this.hourMs) || this.hourMs <= 0) {
      throw new RangeError("hourMs doit être un nombre strictement positif");
    }
    this.nowMs = options.now ?? Date.now;
    this.sessionStartedAt = this.nowMs();
    this.hoursOffset = options.hoursOffset ?? 0;
    this.worldStartedAt = options.worldStartedAt ?? this.sessionStartedAt;
  }

  /** Heures de jeu écoulées depuis la création du monde. */
  hours(): number {
    return this.hoursOffset + (this.nowMs() - this.sessionStartedAt) / this.hourMs;
  }

  /** Sauvegarde : le total courant devient l'offset du prochain démarrage. */
  toJSON(): WorldClockJson {
    return { worldStartedAt: this.worldStartedAt, hoursOffset: this.hours() };
  }
}

/** Refus d'une action de monde, avec le code à renvoyer au client. */
export type SettleFailure =
  | { readonly ok: false; readonly code: "bad_tile" }
  | { readonly ok: false; readonly code: "not_land" }
  | { readonly ok: false; readonly code: "occupied" };

export type SettleResult = { readonly ok: true; readonly settlement: Settlement } | SettleFailure;

export type AbandonResult =
  | { readonly ok: true; readonly settlement: Settlement }
  | { readonly ok: false; readonly code: "bad_tile" | "not_settled" | "not_owner" };

/**
 * Colonie telle que **stockée** en mémoire et sur disque : `owner` est la clé
 * du joueur, mais `ownerName` n'y est pas — c'est un nom d'affichage résolu
 * fraîchement à chaque diffusion (`WorldState.toSettlement`), jamais figé.
 * `Settlement` (le type du fil, avec `ownerName`) n'apparaît que dans les
 * méthodes publiques qui rendent une colonie à un appelant.
 */
export interface StoredSettlement {
  readonly tile: number;
  readonly owner: string;
  readonly room: string;
  readonly seed: number;
  readonly createdAt: number;
  /**
   * Marchands itinérants arrivés pendant que la colonie était **fermée**
   * (`docs/protocol.md` §13), borné à `MAX_PENDING_TRADERS`. Remis en une fois
   * à la prochaine ouverture de la salle — `start.pendingTraders` pour une
   * colonie qui démarre, `snapshot.pendingTraders` pour une colonie qui rouvre
   * depuis son état conservé — puis remis à zéro. Mutable, contrairement au
   * reste : c'est le seul champ d'une colonie qui bouge sans passer par une
   * fondation ou un abandon. Absent quand il vaut 0.
   */
  pendingTraders?: number;
}

/**
 * Forme JSON de `WorldState`, telle qu'écrite sur disque par `WorldStore`.
 *
 * `clock` et `caravans` sont **facultatifs** : un fichier écrit avant les
 * caravanes se relit tel quel, le monde repart simplement d'une horloge neuve
 * et sans convoi en vol. `players` est facultatif pour la même raison, mais sa
 * portée est différente : son **absence** est le signal qu'un fichier est
 * antérieur à la tranche « jeton » (v1, « identité = le nom ») — `owner`, dans
 * `settlements` et dans `caravans`, y est alors un **nom**, pas une clé, et
 * `WorldState.fromJSON` migre en fabriquant un joueur (clé et jeton neufs) par
 * nom rencontré (`docs/protocol.md` §11.8).
 */
export interface WorldStateJson {
  readonly seed: number;
  readonly subdivisions: number;
  readonly settlements: readonly StoredSettlement[];
  readonly snapshots: readonly {
    readonly room: string;
    readonly tick: number;
    /** Octets du snapshot en base64 (le JSON ne transporte pas de binaire). */
    readonly data: string;
    readonly width: number;
    readonly height: number;
    readonly savedAt: number;
    /**
     * Heure de jeu du monde à l'enregistrement. **Facultative** : un fichier
     * écrit avant l'avance rapide se relit tel quel, ses colonies rouvrent
     * simplement sans rattrapage.
     */
    readonly savedAtHours?: number;
  }[];
  /** Horloge de jeu du monde ; absente d'un fichier antérieur aux caravanes. */
  readonly clock?: WorldClockJson;
  /** Caravanes en vol et arrivées en attente ; absentes de même. */
  readonly caravans?: CaravanRegistryJson;
  /** Joueurs connus (clé, nom, jeton) ; absents d'un fichier antérieur à cette tranche. */
  readonly players?: readonly WorldPlayerJson[];
  /**
   * Marchands itinérants en circulation (`docs/protocol.md` §13).
   * **Facultatifs** : un fichier écrit avant cette tranche se relit tel quel,
   * les marchands renaissent simplement au premier tick du monde — ce sont des
   * PNJ, personne ne perd rien à les voir repartir d'ailleurs.
   */
  readonly merchants?: MerchantRegistryJson;
}

export interface WorldStateOptions {
  /** Le globe, généré par `@rimlike/world`. */
  readonly world: World;
  /** Horloge des dates de fondation et d'enregistrement. Défaut : `Date.now`. */
  readonly now?: () => number;
  /** Horloge de jeu du monde. Défaut : une horloge neuve sur `now`. */
  readonly clock?: WorldClock;
  /** Durée réelle d'une heure de jeu, si `clock` n'est pas fourni. */
  readonly hourMs?: number;
  /** Marchands itinérants entretenus. Défaut : `MERCHANT_COUNT` ; 0 en supprime tout. */
  readonly merchantCount?: number;
  /** Durée d'un séjour de marchand, en heures de jeu. Défaut : `MERCHANT_STAY_HOURS`. */
  readonly merchantStayHours?: number;
}

export class WorldState {
  private readonly world: World;
  private readonly now: () => number;
  /** Horloge de jeu du globe (heures de jeu). */
  readonly clock: WorldClock;
  /** Caravanes en voyage sur le globe. */
  readonly caravans: CaravanRegistry;
  /** Marchands itinérants PNJ, entretenus par le serveur seul. */
  readonly merchants: MerchantRegistry;
  /** Colonies par identifiant de case. */
  private readonly settlements = new Map<number, StoredSettlement>();
  /** Dernier snapshot connu par nom de salle. */
  private readonly snapshots = new Map<string, RoomSnapshot>();
  /** Joueurs connus du monde, par clé publique. */
  private readonly players = new Map<string, WorldPlayer>();

  constructor(options: WorldStateOptions) {
    this.world = options.world;
    this.now = options.now ?? Date.now;
    this.clock =
      options.clock ??
      new WorldClock({
        now: this.now,
        ...(options.hourMs !== undefined ? { hourMs: options.hourMs } : {}),
      });
    this.caravans = new CaravanRegistry({
      world: this.world,
      hours: () => this.clock.hours(),
      ownerName: (key) => this.nameOf(key),
    });
    this.merchants = new MerchantRegistry({
      world: this.world,
      hours: () => this.clock.hours(),
      // Les colonies fondées, triées : l'ordre départage deux destinations à
      // égale distance, il doit être stable d'un tick à l'autre.
      settlements: () => [...this.settlements.keys()].sort((a, b) => a - b),
      ...(options.merchantCount !== undefined ? { count: options.merchantCount } : {}),
      ...(options.merchantStayHours !== undefined ? { stayHours: options.merchantStayHours } : {}),
    });
  }

  /** Heures de jeu écoulées depuis la création du monde. */
  get hours(): number {
    return this.clock.hours();
  }

  get seed(): number {
    return this.world.seed;
  }

  get subdivisions(): number {
    return this.world.subdivisions;
  }

  get tileCount(): number {
    return this.world.tiles.length;
  }

  get settlementCount(): number {
    return this.settlements.size;
  }

  get snapshotCount(): number {
    return this.snapshots.size;
  }

  /** Vrai si la case existe sur ce globe. */
  hasTile(tileId: number): boolean {
    return Number.isInteger(tileId) && tileId >= 0 && tileId < this.world.tiles.length;
  }

  /**
   * Vrai si on peut poser une colonie sur le biome de la case. Le critère est
   * celui du déplacement : une case franchissable est une case terrestre, donc
   * l'océan est exclu et la banquise acceptée (`movementCost` renvoie `null`
   * pour l'océan seul).
   */
  isLand(tileId: number): boolean {
    if (!this.hasTile(tileId)) {
      return false;
    }
    return movementCost(this.world.tiles[tileId]!.biome) !== null;
  }

  /** Case terrestre et libre. */
  canSettle(tileId: number): boolean {
    return this.isLand(tileId) && !this.settlements.has(tileId);
  }

  settlementAt(tileId: number): Settlement | undefined {
    const stored = this.settlements.get(tileId);
    return stored === undefined ? undefined : this.toSettlement(stored);
  }

  /** Colonie d'une salle, ou `undefined` si la salle n'est pas une case. */
  settlementOfRoom(room: string): Settlement | undefined {
    const tileId = tileFromRoomName(room);
    if (tileId === null) {
      return undefined;
    }
    return this.settlementAt(tileId);
  }

  /** Toutes les colonies, triées par case : l'ordre du fil est stable. */
  list(): Settlement[] {
    return [...this.settlements.values()]
      .sort((a, b) => a.tile - b.tile)
      .map((stored) => this.toSettlement(stored));
  }

  /** Nom de la salle lockstep d'une case. */
  roomFor(tileId: number): string {
    return tileRoomName(tileId);
  }

  /** Graine de carte d'une case. Déterministe, jamais stockée pour elle-même. */
  seedFor(tileId: number): number {
    return mixTileSeed(this.world.seed, tileId);
  }

  /**
   * Fonde une colonie. La case doit être terrestre et libre. `owner` est la
   * **clé** du joueur (`WorldPlayer.key`), jamais son nom — c'est à
   * l'appelant (le serveur) de l'avoir déjà résolue via `world_join`.
   */
  settle(tileId: number, owner: string): SettleResult {
    if (!this.hasTile(tileId)) {
      return { ok: false, code: "bad_tile" };
    }
    if (!this.isLand(tileId)) {
      return { ok: false, code: "not_land" };
    }
    if (this.settlements.has(tileId)) {
      return { ok: false, code: "occupied" };
    }
    const settlement: StoredSettlement = {
      tile: tileId,
      owner,
      room: this.roomFor(tileId),
      seed: this.seedFor(tileId),
      createdAt: this.now(),
    };
    this.settlements.set(tileId, settlement);
    return { ok: true, settlement: this.toSettlement(settlement) };
  }

  /**
   * Abandonne une colonie : la case redevient libre et son dernier snapshot
   * est oublié. Une salle encore peuplée n'est pas fermée pour autant — les
   * joueurs présents finissent leur session, la case est simplement libre.
   */
  abandon(tileId: number, owner: string): AbandonResult {
    if (!this.hasTile(tileId)) {
      return { ok: false, code: "bad_tile" };
    }
    const settlement = this.settlements.get(tileId);
    if (settlement === undefined) {
      return { ok: false, code: "not_settled" };
    }
    if (settlement.owner !== owner) {
      return { ok: false, code: "not_owner" };
    }
    this.settlements.delete(tileId);
    this.snapshots.delete(settlement.room);
    return { ok: true, settlement: this.toSettlement(settlement) };
  }

  /**
   * Enregistre le dernier état connu d'une salle. Deux refus :
   *
   * - une case **sans colonie** n'a pas d'état à conserver. Sans cette garde,
   *   une salle encore peuplée après un `abandon` continuerait d'écrire, et la
   *   colonie suivante rouvrirait sur l'état de la précédente ;
   * - un snapshot **plus ancien** que celui déjà connu : le temps ne remonte
   *   pas, et deux hôtes peuvent répondre à des instants différents.
   */
  saveSnapshot(room: string, snapshot: Omit<RoomSnapshot, "savedAt" | "savedAtHours">): boolean {
    if (this.settlementOfRoom(room) === undefined) {
      return false;
    }
    const known = this.snapshots.get(room);
    if (known !== undefined && known.tick > snapshot.tick) {
      return false;
    }
    this.snapshots.set(room, { ...snapshot, savedAt: this.now(), savedAtHours: this.clock.hours() });
    return true;
  }

  snapshotFor(room: string): RoomSnapshot | undefined {
    return this.snapshots.get(room);
  }

  /**
   * Ticks d'avance rapide dus à une salle « case » qui rouvre : le temps
   * passé sans personne, en heures de jeu du monde, converti en ticks de carte
   * (`frozenTicksForHours`, borné à 60 jours). Vaut 0 sans snapshot conservé,
   * et 0 pour un snapshot d'avant cette tranche, qui n'a pas d'heure d'origine.
   *
   * Le serveur ne fait que **calculer** ce nombre : c'est l'hôte qui, après
   * avoir restauré l'état, émet `FastForward` en lockstep (§11.6).
   */
  frozenTicksFor(room: string): number {
    const snapshot = this.snapshots.get(room);
    if (snapshot?.savedAtHours === undefined) {
      return 0;
    }
    return frozenTicksForHours(this.clock.hours() - snapshot.savedAtHours);
  }

  dropSnapshot(room: string): void {
    this.snapshots.delete(room);
  }

  // --- Marchands en attente (`docs/protocol.md` §13) ---
  //
  // Un marchand qui arrive sur une colonie **ouverte et en jeu** part tout de
  // suite vers son hôte (`trader_arrival`). S'il n'y a personne, l'arrivée est
  // simplement comptée ici, et remise en une fois à la prochaine ouverture de
  // la salle. Une arrivée donne donc soit un message immédiat, soit un +1 —
  // jamais les deux.

  /** Marchands en attente sur une case, 0 si la case n'est pas colonisée. */
  pendingTradersAt(tileId: number): number {
    return this.settlements.get(tileId)?.pendingTraders ?? 0;
  }

  /**
   * Compte une arrivée de marchand sur une colonie fermée. Faux si la case n'a
   * pas de colonie, ou si le compte est déjà à `MAX_PENDING_TRADERS` : les
   * suivantes sont oubliées plutôt qu'accumulées, une colonie qui se réveille
   * n'a pas à voir débarquer une foire.
   */
  addPendingTrader(tileId: number): boolean {
    const settlement = this.settlements.get(tileId);
    if (settlement === undefined) {
      return false;
    }
    const known = settlement.pendingTraders ?? 0;
    if (known >= MAX_PENDING_TRADERS) {
      return false;
    }
    settlement.pendingTraders = known + 1;
    return true;
  }

  /** Prend les marchands en attente d'une case et remet le compte à zéro. */
  takePendingTraders(tileId: number): number {
    const settlement = this.settlements.get(tileId);
    const pending = settlement?.pendingTraders ?? 0;
    if (settlement !== undefined) {
      delete settlement.pendingTraders;
    }
    return pending;
  }

  // --- Joueurs ---
  //
  // L'identité d'un joueur est son jeton, pas son nom (`docs/protocol.md`
  // §11.2). `createPlayer` est la seule façon d'en obtenir un nouveau ; une
  // reconnexion passe par `playerByToken`, jamais par le nom.

  /** Crée un nouveau joueur : clé publique et jeton neufs. */
  createPlayer(name: string): WorldPlayer {
    const player: WorldPlayer = { key: randomUUID(), name, token: randomToken(), createdAt: this.now() };
    this.players.set(player.key, player);
    return player;
  }

  /**
   * Le joueur propriétaire d'un jeton, ou `undefined`. Comparaison en temps
   * constant (`crypto.timingSafeEqual`) : un jeton faux ne doit rien
   * apprendre par la durée de la comparaison, y compris sa longueur relative à
   * celle des jetons connus — d'où le test de longueur avant de comparer,
   * plutôt que de laisser `timingSafeEqual` lever pour des tampons inégaux.
   */
  playerByToken(token: string): WorldPlayer | undefined {
    const candidate = Buffer.from(token, "utf8");
    for (const player of this.players.values()) {
      const known = Buffer.from(player.token, "utf8");
      if (known.length === candidate.length && timingSafeEqual(known, candidate)) {
        return player;
      }
    }
    return undefined;
  }

  playerByKey(key: string): WorldPlayer | undefined {
    return this.players.get(key);
  }

  /** Renomme un joueur reconnu : le nom n'est qu'un libellé (§11.2). */
  renamePlayer(key: string, name: string): void {
    const player = this.players.get(key);
    if (player !== undefined) {
      player.name = name;
    }
  }

  /** Nom d'affichage d'un joueur, ou la clé elle-même si le joueur est inconnu. */
  nameOf(key: string): string {
    return this.players.get(key)?.name ?? key;
  }

  /** Tous les joueurs déjà vus par le monde, triés par ancienneté puis par clé. */
  listPlayers(): readonly WorldPlayer[] {
    return [...this.players.values()].sort(
      (a, b) => a.createdAt - b.createdAt || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
    );
  }

  /**
   * Diffusable : `ownerName` résolu à l'instant présent, jamais figé. Les
   * champs sont recopiés un à un plutôt qu'étalés — `pendingTraders` est une
   * affaire interne au serveur (`docs/protocol.md` §13), il n'a rien à faire
   * sur le fil.
   */
  private toSettlement(stored: StoredSettlement): Settlement {
    return {
      tile: stored.tile,
      owner: stored.owner,
      ownerName: this.nameOf(stored.owner),
      room: stored.room,
      seed: stored.seed,
      createdAt: stored.createdAt,
    };
  }

  /** État complet en JSON. Voir l'en-tête : rien n'est encore écrit sur disque. */
  toJSON(): WorldStateJson {
    return {
      seed: this.seed,
      subdivisions: this.subdivisions,
      clock: this.clock.toJSON(),
      caravans: this.caravans.toJSON(),
      merchants: this.merchants.toJSON(),
      settlements: [...this.settlements.values()]
        .sort((a, b) => a.tile - b.tile)
        .map((settlement) => ({
          tile: settlement.tile,
          owner: settlement.owner,
          room: settlement.room,
          seed: settlement.seed,
          createdAt: settlement.createdAt,
          // Omis quand il vaut 0 : le cas courant, et un champ absent se relit
          // par une version antérieure sans rien casser.
          ...(settlement.pendingTraders ? { pendingTraders: settlement.pendingTraders } : {}),
        })),
      snapshots: [...this.snapshots.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([room, snapshot]) => ({
          room,
          tick: snapshot.tick,
          data: bytesToBase64(snapshot.data),
          width: snapshot.width,
          height: snapshot.height,
          savedAt: snapshot.savedAt,
          ...(snapshot.savedAtHours !== undefined ? { savedAtHours: snapshot.savedAtHours } : {}),
        })),
      players: this.listPlayers().map((p) => ({ key: p.key, name: p.name, token: p.token, createdAt: p.createdAt })),
    };
  }

  /**
   * Relit un état sauvegardé sur le globe fourni. Le globe n'est pas dans le
   * JSON : il se regénère depuis `(subdivisions, seed)`, et une incohérence
   * est refusée plutôt que corrigée — des colonies posées sur un autre globe
   * tomberaient sur d'autres biomes.
   *
   * **Migration v1 → v2** (`docs/protocol.md` §11.8) : un fichier sans
   * `json.players` est antérieur à la tranche « jeton » — `owner`, dans
   * `json.settlements` et dans `json.caravans`, y est un **nom**. Chaque nom
   * rencontré devient un joueur créé à la volée (clé et jeton neufs, un seul
   * par nom) ; l'ancien propriétaire ne peut évidemment pas être reconnu sans
   * jeton connu, mais l'exploitant peut lire ce jeton dans le fichier une fois
   * la migration écrite (prochaine sauvegarde) pour le lui communiquer hors
   * bande s'il le souhaite.
   */
  static fromJSON(json: WorldStateJson, options: WorldStateOptions): WorldState {
    // L'horloge repart du total relu, sur une origine réelle fixée
    // maintenant : le temps passé serveur éteint ne vieillit pas le monde.
    const clock =
      options.clock ??
      new WorldClock({
        now: options.now ?? Date.now,
        ...(options.hourMs !== undefined ? { hourMs: options.hourMs } : {}),
        ...(json.clock !== undefined
          ? { worldStartedAt: json.clock.worldStartedAt, hoursOffset: json.clock.hoursOffset }
          : {}),
      });
    const state = new WorldState({ ...options, clock });
    if (json.seed !== state.seed || json.subdivisions !== state.subdivisions) {
      throw new Error(
        `état monde incompatible : sauvegarde (${json.seed}, ${json.subdivisions}) contre globe (${state.seed}, ${state.subdivisions})`,
      );
    }

    // Migration v1 → v2 : sans table de joueurs, les `owner` de ce fichier
    // sont des noms. On en fabrique un joueur par nom rencontré (une seule
    // fois chacun), avec un jeton neuf — voir l'en-tête de cette méthode.
    const legacy = json.players === undefined;
    const legacyPlayerByName = new Map<string, WorldPlayer>();
    const resolveOwner = (owner: string): string => {
      if (!legacy) {
        return owner;
      }
      let player = legacyPlayerByName.get(owner);
      if (player === undefined) {
        player = state.createPlayer(owner);
        legacyPlayerByName.set(owner, player);
      }
      return player.key;
    };

    if (!legacy) {
      for (const entry of json.players!) {
        state.players.set(entry.key, {
          key: entry.key,
          name: entry.name,
          token: entry.token,
          createdAt: entry.createdAt,
        });
      }
    }

    for (const settlement of json.settlements) {
      if (!state.hasTile(settlement.tile)) {
        throw new Error(`colonie sur une case inexistante : ${settlement.tile}`);
      }
      // `pendingTraders` est relu borné : un fichier trafiqué ne fait pas
      // débarquer trente marchands à la réouverture d'une colonie.
      const pending = Math.min(MAX_PENDING_TRADERS, Math.max(0, Math.trunc(settlement.pendingTraders ?? 0)));
      state.settlements.set(settlement.tile, {
        tile: settlement.tile,
        owner: resolveOwner(settlement.owner),
        room: settlement.room,
        seed: settlement.seed,
        createdAt: settlement.createdAt,
        ...(pending > 0 ? { pendingTraders: pending } : {}),
      });
    }
    for (const entry of json.snapshots) {
      const data = base64ToBytes(entry.data);
      if (data === null) {
        throw new Error(`snapshot illisible pour la salle ${entry.room}`);
      }
      state.snapshots.set(entry.room, {
        tick: entry.tick,
        data,
        width: entry.width,
        height: entry.height,
        savedAt: entry.savedAt,
        ...(typeof entry.savedAtHours === "number" ? { savedAtHours: entry.savedAtHours } : {}),
      });
    }
    if (json.caravans !== undefined) {
      const caravansJson = legacy
        ? { ...json.caravans, caravans: json.caravans.caravans.map((c) => ({ ...c, owner: resolveOwner(c.owner) })) }
        : json.caravans;
      state.caravans.restore(caravansJson);
    }
    // Absents d'un fichier antérieur aux marchands : ils renaîtront au premier
    // tick du monde, sur une case tirée au sort comme au premier démarrage.
    if (json.merchants !== undefined) {
      state.merchants.restore(json.merchants);
    }
    return state;
  }
}

/**
 * Globes déjà générés, par `(subdivisions, seed)`. `generateWorld` est pure et
 * son résultat immuable : le mémoïser évite de repayer 50 ms (et 2 562 cases)
 * à chaque `startServer`, ce qui compte surtout pour les tests, qui en
 * démarrent un par cas.
 */
const worldCache = new Map<string, World>();

/** Globe partagé pour un couple `(subdivisions, seed)`. */
export function sharedWorld(subdivisions: number, seed: number): World {
  const key = `${subdivisions}/${seed}`;
  const known = worldCache.get(key);
  if (known !== undefined) {
    return known;
  }
  const world = generateWorld(subdivisions, seed);
  if (world.tiles.length !== tileCount(subdivisions)) {
    throw new Error(`globe incohérent : ${world.tiles.length} cases pour ${subdivisions} subdivisions`);
  }
  worldCache.set(key, world);
  return world;
}
