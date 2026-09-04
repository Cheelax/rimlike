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
 * - l'identité d'un joueur est son **nom**. Il n'y a pas de compte : quiconque
 *   se connecte sous le nom du propriétaire est reconnu comme tel. Limite
 *   assumée de la v1, à remplacer par de vrais comptes avant toute mise en
 *   ligne publique.
 *
 * **Rien n'est écrit sur disque dans cette tranche.** `toJSON` / `fromJSON`
 * existent pour que la persistance soit un branchement et non une réécriture :
 * l'état complet (colonies + dernier snapshot de chaque salle) est un objet
 * JSON. Un redémarrage du serveur perd donc tout, y compris les colonies.
 */

import { base64ToBytes, bytesToBase64, type Settlement } from "@rimlike/protocol";
import { generateWorld, movementCost, tileCount, type World } from "@rimlike/world";

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

/** Forme JSON de `WorldState`, pour une persistance future. */
export interface WorldStateJson {
  readonly seed: number;
  readonly subdivisions: number;
  readonly settlements: readonly Settlement[];
  readonly snapshots: readonly {
    readonly room: string;
    readonly tick: number;
    /** Octets du snapshot en base64 (le JSON ne transporte pas de binaire). */
    readonly data: string;
    readonly width: number;
    readonly height: number;
    readonly savedAt: number;
  }[];
}

export interface WorldStateOptions {
  /** Le globe, généré par `@rimlike/world`. */
  readonly world: World;
  /** Horloge des dates de fondation et d'enregistrement. Défaut : `Date.now`. */
  readonly now?: () => number;
}

export class WorldState {
  private readonly world: World;
  private readonly now: () => number;
  /** Colonies par identifiant de case. */
  private readonly settlements = new Map<number, Settlement>();
  /** Dernier snapshot connu par nom de salle. */
  private readonly snapshots = new Map<string, RoomSnapshot>();

  constructor(options: WorldStateOptions) {
    this.world = options.world;
    this.now = options.now ?? Date.now;
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
    return this.settlements.get(tileId);
  }

  /** Colonie d'une salle, ou `undefined` si la salle n'est pas une case. */
  settlementOfRoom(room: string): Settlement | undefined {
    const tileId = tileFromRoomName(room);
    return tileId === null ? undefined : this.settlements.get(tileId);
  }

  /** Toutes les colonies, triées par case : l'ordre du fil est stable. */
  list(): Settlement[] {
    return [...this.settlements.values()].sort((a, b) => a.tile - b.tile);
  }

  /** Nom de la salle lockstep d'une case. */
  roomFor(tileId: number): string {
    return tileRoomName(tileId);
  }

  /** Graine de carte d'une case. Déterministe, jamais stockée pour elle-même. */
  seedFor(tileId: number): number {
    return mixTileSeed(this.world.seed, tileId);
  }

  /** Fonde une colonie. La case doit être terrestre et libre. */
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
    const settlement: Settlement = {
      tile: tileId,
      owner,
      room: this.roomFor(tileId),
      seed: this.seedFor(tileId),
      createdAt: this.now(),
    };
    this.settlements.set(tileId, settlement);
    return { ok: true, settlement };
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
    return { ok: true, settlement };
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
  saveSnapshot(room: string, snapshot: Omit<RoomSnapshot, "savedAt">): boolean {
    if (this.settlementOfRoom(room) === undefined) {
      return false;
    }
    const known = this.snapshots.get(room);
    if (known !== undefined && known.tick > snapshot.tick) {
      return false;
    }
    this.snapshots.set(room, { ...snapshot, savedAt: this.now() });
    return true;
  }

  snapshotFor(room: string): RoomSnapshot | undefined {
    return this.snapshots.get(room);
  }

  dropSnapshot(room: string): void {
    this.snapshots.delete(room);
  }

  /** État complet en JSON. Voir l'en-tête : rien n'est encore écrit sur disque. */
  toJSON(): WorldStateJson {
    return {
      seed: this.seed,
      subdivisions: this.subdivisions,
      settlements: this.list(),
      snapshots: [...this.snapshots.entries()]
        .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
        .map(([room, snapshot]) => ({
          room,
          tick: snapshot.tick,
          data: bytesToBase64(snapshot.data),
          width: snapshot.width,
          height: snapshot.height,
          savedAt: snapshot.savedAt,
        })),
    };
  }

  /**
   * Relit un état sauvegardé sur le globe fourni. Le globe n'est pas dans le
   * JSON : il se regénère depuis `(subdivisions, seed)`, et une incohérence
   * est refusée plutôt que corrigée — des colonies posées sur un autre globe
   * tomberaient sur d'autres biomes.
   */
  static fromJSON(json: WorldStateJson, options: WorldStateOptions): WorldState {
    const state = new WorldState(options);
    if (json.seed !== state.seed || json.subdivisions !== state.subdivisions) {
      throw new Error(
        `état monde incompatible : sauvegarde (${json.seed}, ${json.subdivisions}) contre globe (${state.seed}, ${state.subdivisions})`,
      );
    }
    for (const settlement of json.settlements) {
      if (!state.hasTile(settlement.tile)) {
        throw new Error(`colonie sur une case inexistante : ${settlement.tile}`);
      }
      state.settlements.set(settlement.tile, settlement);
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
      });
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
