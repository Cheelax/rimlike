/**
 * Logique du lockstep, pure et sans I/O : ni WebSocket, ni timer, ni horloge.
 * Le serveur ne fait que brancher un transport et une horloge dessus, ce qui
 * rend cette partie testable sans réseau.
 */

import {
  BUNDLE_TICKS,
  MAX_HISTORY_BUNDLES,
  type Bundle,
  type PlayerId,
  type TickCommand,
  type TickCommands,
} from "./messages.js";

interface PendingCommand {
  readonly player: PlayerId;
  readonly payload: Uint8Array;
  /** Instant d'arrivée au serveur, en millisecondes. */
  readonly receivedAt: number;
  /** Rang d'arrivée, pour un tri total même à instants égaux. */
  readonly seq: number;
}

export interface SchedulerOptions {
  /** Ticks par bundle. Défaut : `BUNDLE_TICKS`. */
  readonly bundleTicks?: number;
  /** Premier tick du premier bundle. Défaut : 0. */
  readonly startTick?: number;
}

/**
 * Planifie les commandes reçues et découpe le temps en bundles.
 *
 * Une commande reçue pendant l'émission du bundle N est planifiée au **premier
 * tick du bundle N+1** : c'est le délai d'entrée (50 à 100 ms à 20 bundles/s).
 * L'ordre à l'intérieur d'un tick est `(instant d'arrivée, playerId, rang
 * d'arrivée)`. Cet ordre est la garantie centrale du lockstep : tous les
 * clients appliquent la même liste, donc obtiennent le même état.
 */
export class Scheduler {
  private readonly bundleTicks: number;
  private nextFrom: number;
  private pending: PendingCommand[] = [];
  private seq = 0;

  constructor(options: SchedulerOptions = {}) {
    this.bundleTicks = options.bundleTicks ?? BUNDLE_TICKS;
    if (!Number.isInteger(this.bundleTicks) || this.bundleTicks < 1) {
      throw new RangeError("bundleTicks doit être un entier >= 1");
    }
    this.nextFrom = options.startTick ?? 0;
  }

  /** Premier tick du prochain bundle à émettre. */
  get nextBundleFrom(): number {
    return this.nextFrom;
  }

  /** Nombre de commandes en attente d'émission. */
  get pendingCount(): number {
    return this.pending.length;
  }

  /**
   * Enregistre une commande et renvoie le tick auquel elle sera appliquée.
   * `receivedAt` est fourni par l'appelant (le serveur passe `Date.now()`) :
   * le scheduler ne lit jamais l'horloge lui-même.
   */
  submit(player: PlayerId, payload: Uint8Array, receivedAt: number): number {
    this.pending.push({ player, payload, receivedAt, seq: this.seq++ });
    return this.nextFrom;
  }

  /**
   * Ferme le bundle courant et avance l'horloge logique. À appeler à chaque
   * battement de l'horloge de la salle, même quand il n'y a rien à envoyer.
   */
  emitBundle(): Bundle {
    const from = this.nextFrom;
    const to = from + this.bundleTicks - 1;
    const ticks: TickCommands[] = [];
    if (this.pending.length > 0) {
      const ordered = [...this.pending].sort(compareArrival);
      const commands: TickCommand[] = ordered.map((c) => ({ player: c.player, payload: c.payload }));
      ticks.push({ tick: from, commands });
      this.pending = [];
    }
    this.nextFrom = to + 1;
    return { from, to, ticks };
  }

  /** Oublie les commandes en attente d'un joueur parti. */
  dropPlayer(player: PlayerId): void {
    this.pending = this.pending.filter((c) => c.player !== player);
  }
}

function compareArrival(a: PendingCommand, b: PendingCommand): number {
  if (a.receivedAt !== b.receivedAt) {
    return a.receivedAt - b.receivedAt;
  }
  if (a.player !== b.player) {
    return a.player - b.player;
  }
  return a.seq - b.seq;
}

export interface DesyncReport {
  readonly tick: number;
  readonly hashes: Readonly<Record<PlayerId, string>>;
}

export interface HashLedgerOptions {
  /** Ticks de hash conservés avant élagage. Défaut : 64. */
  readonly keepTicks?: number;
}

/**
 * Compare les hashes d'état annoncés par les clients, tick par tick. Un tick
 * n'est jugé qu'entre les joueurs qui l'ont annoncé : un joueur en retard
 * n'invente pas un écart, il arrive simplement plus tard.
 *
 * v1 : on ne signale que le **premier** écart, on ne répare pas.
 */
export class HashLedger {
  private readonly keepTicks: number;
  /** Ticks croissants, chacun avec les hashes annoncés par joueur. */
  private readonly perTick = new Map<number, Map<PlayerId, string>>();
  private firstDesync: DesyncReport | null = null;

  constructor(options: HashLedgerOptions = {}) {
    this.keepTicks = options.keepTicks ?? 64;
  }

  /** Non nul dès qu'un écart a été constaté. */
  get desync(): DesyncReport | null {
    return this.firstDesync;
  }

  /**
   * Enregistre un hash. Renvoie un rapport au tout premier écart constaté,
   * `null` ensuite (y compris pour les écarts suivants, déjà couverts).
   */
  report(player: PlayerId, tick: number, hash: string): DesyncReport | null {
    let entry = this.perTick.get(tick);
    if (entry === undefined) {
      entry = new Map<PlayerId, string>();
      this.perTick.set(tick, entry);
      this.prune();
    }
    entry.set(player, hash);
    if (this.firstDesync !== null) {
      return null;
    }
    let reference: string | undefined;
    for (const value of entry.values()) {
      if (reference === undefined) {
        reference = value;
      } else if (value !== reference) {
        this.firstDesync = { tick, hashes: Object.fromEntries(entry) };
        return this.firstDesync;
      }
    }
    return null;
  }

  /** Hashes annoncés pour un tick, pour l'inspection et les tests. */
  hashesAt(tick: number): Readonly<Record<PlayerId, string>> {
    const entry = this.perTick.get(tick);
    return entry === undefined ? {} : Object.fromEntries(entry);
  }

  /**
   * Hash majoritaire pour un tick, référence pour identifier les déviants
   * (`docs/protocol.md` §7). `null` si moins de trois hashes sont connus pour
   * ce tick, ou si aucune valeur ne réunit une **majorité stricte** (plus de
   * la moitié des joueurs qui l'ont annoncé) : à deux joueurs qui divergent,
   * impossible de départager qui a raison, on ne calcule donc jamais de
   * majorité dans ce cas.
   */
  majorityHash(tick: number): string | null {
    const entry = this.perTick.get(tick);
    if (entry === undefined || entry.size < 3) {
      return null;
    }
    const counts = new Map<string, number>();
    for (const hash of entry.values()) {
      counts.set(hash, (counts.get(hash) ?? 0) + 1);
    }
    let best: string | null = null;
    let bestCount = 0;
    for (const [hash, count] of counts) {
      if (count > bestCount) {
        best = hash;
        bestCount = count;
      }
    }
    return best !== null && bestCount * 2 > entry.size ? best : null;
  }

  /**
   * Joueurs dont le hash annoncé pour ce tick diverge de `majorityHash(tick)`,
   * triés par identifiant croissant. Liste vide si aucune majorité n'est
   * connue : sans référence, personne n'est désigné déviant.
   */
  outliers(tick: number): PlayerId[] {
    const majority = this.majorityHash(tick);
    const entry = this.perTick.get(tick);
    if (majority === null || entry === undefined) {
      return [];
    }
    const result: PlayerId[] = [];
    for (const [player, hash] of entry) {
      if (hash !== majority) {
        result.push(player);
      }
    }
    return result.sort((a, b) => a - b);
  }

  /** Retire un joueur parti de tous les ticks encore en mémoire. */
  removePlayer(player: PlayerId): void {
    for (const entry of this.perTick.values()) {
      entry.delete(player);
    }
  }

  private prune(): void {
    while (this.perTick.size > this.keepTicks) {
      const oldest = this.perTick.keys().next();
      if (oldest.done === true) {
        return;
      }
      this.perTick.delete(oldest.value);
    }
  }
}

/**
 * Historique borné des bundles émis, pour le rattrapage d'un joueur qui
 * rejoint. Au-delà de `max` bundles, les plus anciens sont oubliés : un
 * rejoignant dont le snapshot est plus vieux que l'historique doit demander
 * un snapshot plus récent (voir `covers`).
 */
export class BundleHistory {
  private readonly max: number;
  private readonly bundles: Bundle[] = [];

  constructor(max: number = MAX_HISTORY_BUNDLES) {
    if (!Number.isInteger(max) || max < 1) {
      throw new RangeError("max doit être un entier >= 1");
    }
    this.max = max;
  }

  get size(): number {
    return this.bundles.length;
  }

  /** Premier tick encore rejouable, `null` si l'historique est vide. */
  get oldestTick(): number | null {
    return this.bundles.length === 0 ? null : this.bundles[0]!.from;
  }

  /** Tick suivant le dernier bundle conservé, `null` si l'historique est vide. */
  get nextTick(): number | null {
    return this.bundles.length === 0 ? null : this.bundles[this.bundles.length - 1]!.to + 1;
  }

  push(bundle: Bundle): void {
    this.bundles.push(bundle);
    while (this.bundles.length > this.max) {
      this.bundles.shift();
    }
  }

  /** Vrai si le rejeu depuis `tick` est complet (rien d'oublié entre-temps). */
  covers(tick: number): boolean {
    const oldest = this.oldestTick;
    return oldest === null || tick >= oldest;
  }

  /**
   * Bundles à rejouer pour un client dont le prochain tick à exécuter est
   * `tick`, dans l'ordre d'émission. Un bundle est retenu dès qu'il contient
   * ce tick ou un tick postérieur.
   */
  since(tick: number): Bundle[] {
    return this.bundles.filter((b) => b.to >= tick);
  }

  clear(): void {
    this.bundles.length = 0;
  }
}
