/**
 * Une salle : un groupe de joueurs sur une carte, une horloge, un ordre de
 * commandes. Le serveur **ne simule pas** : il numérote les ticks, ordonne les
 * commandes et relaie. Les charges des commandes sont des octets opaques.
 *
 * Aucune dépendance au transport : une salle ne connaît que des fonctions
 * d'envoi (`Sender`) et un démarreur d'horloge (`ClockStarter`), tous deux
 * injectables, ce qui permet de tester la logique sans WebSocket ni timer réel.
 */

import {
  BUNDLE_TICKS,
  BundleHistory,
  HashLedger,
  MAX_HISTORY_BUNDLES,
  MAX_PLAYERS,
  PROTOCOL_VERSION,
  Scheduler,
  TICK_RATE,
  encodeMessage,
  type ClientMessage,
  type ErrorCode,
  type PlayerId,
  type PlayerInfo,
  type RoomState,
  type ServerMessage,
} from "@rimlike/protocol";

/** Envoi d'une trame déjà sérialisée à un joueur. */
export type Sender = (text: string) => void;

/** Arrête une horloge démarrée par un `ClockStarter`. */
export type StopClock = () => void;

/** Démarre une horloge qui appelle `onBundle` toutes les `intervalMs`. */
export type ClockStarter = (onBundle: () => void, intervalMs: number) => StopClock;

export interface RoomOptions {
  readonly name: string;
  readonly tickRate?: number;
  readonly bundleTicks?: number;
  readonly maxHistoryBundles?: number;
  readonly maxPlayers?: number;
  /** Horloge murale, uniquement pour ordonner les arrivées. Défaut : `Date.now`. */
  readonly now?: () => number;
  /** Défaut : `setInterval` non bloquant pour le processus. */
  readonly startClock?: ClockStarter;
  readonly log?: (line: string) => void;
}

interface RoomPlayer {
  readonly id: PlayerId;
  readonly name: string;
  readonly send: Sender;
  /** Faux tant que le joueur attend son snapshot de rattrapage. */
  synced: boolean;
}

const defaultClock: ClockStarter = (onBundle, intervalMs) => {
  const handle = setInterval(onBundle, intervalMs);
  handle.unref?.();
  return () => clearInterval(handle);
};

export class Room {
  readonly name: string;
  private readonly tickRate: number;
  private readonly bundleTicks: number;
  private readonly maxPlayers: number;
  private readonly now: () => number;
  private readonly startClock: ClockStarter;
  private readonly log: (line: string) => void;

  private readonly players: RoomPlayer[] = [];
  private readonly history: BundleHistory;
  private readonly ledger = new HashLedger();
  private scheduler: Scheduler;

  private nextPlayerId: PlayerId = 1;
  private hostId: PlayerId | null = null;
  private roomState: RoomState = "lobby";
  private stopClock: StopClock | null = null;
  private seed: number | null = null;
  private width: number | null = null;
  private height: number | null = null;

  constructor(options: RoomOptions) {
    this.name = options.name;
    this.tickRate = options.tickRate ?? TICK_RATE;
    this.bundleTicks = options.bundleTicks ?? BUNDLE_TICKS;
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.now = options.now ?? Date.now;
    this.startClock = options.startClock ?? defaultClock;
    this.log = options.log ?? ((line) => console.log(line));
    this.history = new BundleHistory(options.maxHistoryBundles ?? MAX_HISTORY_BUNDLES);
    this.scheduler = new Scheduler({ bundleTicks: this.bundleTicks });
  }

  get state(): RoomState {
    return this.roomState;
  }

  /** Prochain tick que le serveur planifiera. 0 tant que la salle est en lobby. */
  get tick(): number {
    return this.scheduler.nextBundleFrom;
  }

  get playerCount(): number {
    return this.players.length;
  }

  get isEmpty(): boolean {
    return this.players.length === 0;
  }

  get isFull(): boolean {
    return this.players.length >= this.maxPlayers;
  }

  get host(): PlayerId | null {
    return this.hostId;
  }

  /** Période d'émission d'un bundle, en millisecondes réelles. */
  get bundleIntervalMs(): number {
    return (1000 / this.tickRate) * this.bundleTicks;
  }

  /**
   * Ajoute un joueur. Renvoie son identifiant, ou `null` si la salle est
   * pleine. Le premier arrivé devient host. Un joueur qui arrive en cours de
   * partie déclenche une demande de snapshot au host et ne reçoit aucun bundle
   * avant de l'avoir reçu.
   */
  join(name: string, send: Sender): PlayerId | null {
    if (this.isFull) {
      return null;
    }
    const player: RoomPlayer = {
      id: this.nextPlayerId++,
      name,
      send,
      synced: this.roomState === "lobby",
    };
    this.players.push(player);
    this.hostId ??= player.id;

    this.sendTo(player, {
      type: "welcome",
      protocol: PROTOCOL_VERSION,
      playerId: player.id,
      isHost: player.id === this.hostId,
      players: this.playerList(),
      state: this.roomState,
      tick: this.tick,
      ...(this.seed !== null && this.width !== null && this.height !== null
        ? { seed: this.seed, width: this.width, height: this.height }
        : {}),
    });
    this.log(`[${this.name}] joueur ${player.id} (${name}) rejoint — ${this.players.length} présent(s)`);
    this.broadcastPlayers();

    if (!player.synced) {
      this.requestSnapshotFor(player.id);
    }
    return player.id;
  }

  /** Retire un joueur, réattribue le host si besoin. */
  leave(id: PlayerId): void {
    const index = this.players.findIndex((p) => p.id === id);
    if (index < 0) {
      return;
    }
    const [player] = this.players.splice(index, 1);
    this.scheduler.dropPlayer(id);
    this.ledger.removePlayer(id);
    this.log(`[${this.name}] joueur ${id} (${player!.name}) part — ${this.players.length} restant(s)`);

    if (this.hostId === id) {
      this.hostId = this.players[0]?.id ?? null;
      if (this.hostId !== null) {
        this.log(`[${this.name}] nouveau host : joueur ${this.hostId}`);
        // Les joueurs encore en attente doivent être servis par le nouveau host.
        for (const waiting of this.players) {
          if (!waiting.synced) {
            this.requestSnapshotFor(waiting.id);
          }
        }
      }
    }
    this.broadcastPlayers();
    if (this.isEmpty) {
      this.stop();
    }
  }

  /** Traite un message validé. Les erreurs sont renvoyées à l'émetteur. */
  handle(id: PlayerId, message: ClientMessage): void {
    const player = this.players.find((p) => p.id === id);
    if (player === undefined) {
      return;
    }
    switch (message.type) {
      case "join":
        // Le serveur filtre ce cas en amont (une connexion = une salle).
        this.fail(player, "already_joined", "déjà dans une salle");
        return;
      case "start":
        this.handleStart(player, message.seed, message.width, message.height);
        return;
      case "command":
        if (!this.isRunning()) {
          this.fail(player, "not_running", "la salle n'a pas démarré");
          return;
        }
        this.scheduler.submit(player.id, message.payload, this.now());
        return;
      case "hash":
        if (!this.isRunning()) {
          this.fail(player, "not_running", "la salle n'a pas démarré");
          return;
        }
        this.handleHash(player.id, message.tick, message.hash);
        return;
      case "snapshot":
        this.handleSnapshot(player, message.tick, message.data, message.forPlayer);
        return;
      case "ping":
        this.sendTo(player, { type: "pong" });
        return;
      case "pong":
        return;
    }
  }

  /** Arrête l'horloge. À appeler quand la salle est détruite. */
  stop(): void {
    if (this.stopClock !== null) {
      this.stopClock();
      this.stopClock = null;
      this.log(`[${this.name}] horloge arrêtée au tick ${this.tick}`);
    }
  }

  // --- Interne ---

  private isRunning(): boolean {
    return this.roomState === "running" || this.roomState === "desynced";
  }

  private handleStart(player: RoomPlayer, seed: number, width: number, height: number): void {
    if (player.id !== this.hostId) {
      this.fail(player, "not_host", "seul le host peut démarrer");
      return;
    }
    if (this.roomState !== "lobby") {
      this.fail(player, "already_running", "la salle a déjà démarré");
      return;
    }
    this.seed = seed;
    this.width = width;
    this.height = height;
    this.roomState = "running";
    this.scheduler = new Scheduler({ bundleTicks: this.bundleTicks });
    this.history.clear();
    for (const p of this.players) {
      p.synced = true;
    }
    this.broadcast({ type: "start", seed, width, height, tick: 0 });
    this.log(`[${this.name}] démarrage — seed ${seed}, carte ${width}x${height}, ${this.players.length} joueur(s)`);
    this.stopClock = this.startClock(() => this.emitBundle(), this.bundleIntervalMs);
  }

  private emitBundle(): void {
    const bundle = this.scheduler.emitBundle();
    this.history.push(bundle);
    const message: ServerMessage = { type: "bundle", ...bundle };
    const text = encodeMessage(message);
    for (const player of this.players) {
      if (player.synced) {
        player.send(text);
      }
    }
  }

  private handleHash(id: PlayerId, tick: number, hash: string): void {
    const report = this.ledger.report(id, tick, hash);
    if (report === null) {
      return;
    }
    this.roomState = "desynced";
    this.broadcast({ type: "desync", tick: report.tick, hashes: report.hashes });
    const detail = Object.entries(report.hashes)
      .map(([player, value]) => `${player}=${value}`)
      .join(" ");
    this.log(`[${this.name}] DÉSYNC au tick ${tick} — ${detail}`);
  }

  private requestSnapshotFor(id: PlayerId): void {
    const host = this.players.find((p) => p.id === this.hostId);
    const target = this.players.find((p) => p.id === id);
    if (host === undefined || target === undefined) {
      return;
    }
    if (host.id === id) {
      // Personne d'autre ne peut fournir l'état : cas impossible tant que le
      // serveur détruit les salles vides, on trace au cas où.
      this.fail(target, "no_host", "aucun host pour fournir un snapshot");
      return;
    }
    this.sendTo(host, { type: "request_snapshot", forPlayer: id });
    this.log(`[${this.name}] snapshot demandé au host ${host.id} pour le joueur ${id}`);
  }

  private handleSnapshot(
    player: RoomPlayer,
    tick: number,
    data: Uint8Array,
    forPlayer: PlayerId | undefined,
  ): void {
    if (!this.isRunning()) {
      this.fail(player, "not_running", "la salle n'a pas démarré");
      return;
    }
    if (player.id !== this.hostId) {
      this.fail(player, "not_host", "seul le host fournit les snapshots");
      return;
    }
    const targets =
      forPlayer === undefined
        ? this.players.filter((p) => !p.synced)
        : this.players.filter((p) => p.id === forPlayer && !p.synced);
    if (targets.length === 0) {
      return;
    }
    const snapshot = encodeMessage({ type: "snapshot", tick, data });
    for (const target of targets) {
      if (!this.history.covers(tick)) {
        this.fail(target, "history_gap", `snapshot au tick ${tick} trop ancien pour être rattrapé`);
        this.log(`[${this.name}] snapshot du tick ${tick} hors historique pour le joueur ${target.id}`);
        continue;
      }
      target.send(snapshot);
      const replay = this.history.since(tick);
      for (const bundle of replay) {
        target.send(encodeMessage({ type: "bundle", ...bundle }));
      }
      target.synced = true;
      this.log(
        `[${this.name}] joueur ${target.id} rattrapé depuis le tick ${tick} (${data.length} octets, ${replay.length} bundle(s) rejoué(s))`,
      );
    }
  }

  private playerList(): PlayerInfo[] {
    return this.players.map((p) => ({ id: p.id, name: p.name }));
  }

  private broadcastPlayers(): void {
    this.broadcast({ type: "players", players: this.playerList(), hostId: this.hostId });
  }

  private broadcast(message: ServerMessage): void {
    const text = encodeMessage(message);
    for (const player of this.players) {
      player.send(text);
    }
  }

  private sendTo(player: RoomPlayer, message: ServerMessage): void {
    player.send(encodeMessage(message));
  }

  private fail(player: RoomPlayer, code: ErrorCode, message: string): void {
    this.sendTo(player, { type: "error", code, message });
  }
}
