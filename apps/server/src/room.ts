/**
 * Une salle : un groupe de joueurs sur une carte, une horloge, un ordre de
 * commandes. Le serveur **ne simule pas** : il numérote les ticks, ordonne les
 * commandes et relaie. Les charges des commandes sont des octets opaques.
 *
 * Aucune dépendance au transport : une salle ne connaît que des fonctions
 * d'envoi (`Sender`) et un démarreur d'horloge (`ClockStarter`), tous deux
 * injectables, ce qui permet de tester la logique sans WebSocket ni timer réel.
 *
 * Deux sortes de salles, même code :
 *
 * - **salle simple** (`join { room: "demo" }`) : l'hôte choisit la graine et
 *   la taille de carte, la salle disparaît sans laisser de trace ;
 * - **salle « case »** (`tile`), adossée à une case du globe : la graine est
 *   imposée par le serveur, l'hôte fournit périodiquement un snapshot de
 *   conservation, et la salle peut être rouverte depuis ce snapshot
 *   (`restore`) au lieu de repartir d'un lobby.
 */

import {
  BUNDLE_TICKS,
  BundleHistory,
  HashLedger,
  MAX_HISTORY_BUNDLES,
  MAX_PLAYERS,
  NO_PLAYER,
  PROTOCOL_VERSION,
  SNAPSHOT_EVERY_TICKS,
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

/** Case du globe portée par la salle : la graine y est imposée. */
export interface TileRoom {
  readonly id: number;
  readonly seed: number;
}

/**
 * Dernier état connu d'une colonie, pour rouvrir la salle sans repasser par un
 * lobby. `tick` est le prochain tick à exécuter : les bundles reprennent là,
 * sans rejeu.
 *
 * `frozenTicks` est le temps que la colonie a passé **sans personne**, converti
 * en ticks de carte par le serveur monde. Il part tel quel dans le `snapshot`
 * du premier arrivant, qui émet alors une commande d'avance rapide en lockstep
 * (`docs/protocol.md` §11.6) : la salle, elle, ne simule rien et son horloge
 * repart bien du `tick` du snapshot.
 */
export interface RoomRestore {
  readonly tick: number;
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
  /** Temps gelé en ticks, 0 ou absent s'il n'y a rien à rattraper. */
  readonly frozenTicks?: number;
}

/** Snapshot de conservation remonté par l'hôte d'une salle « case ». */
export interface RoomSnapshotReport {
  readonly tick: number;
  readonly data: Uint8Array;
  readonly width: number;
  readonly height: number;
}

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
  /** Présent pour une salle adossée à une case du globe. */
  readonly tile?: TileRoom;
  /** Rouvre la salle depuis un snapshot au lieu d'un lobby. Exige `tile`. */
  readonly restore?: RoomRestore;
  /** Appelé quand l'hôte remonte un snapshot de conservation. */
  readonly onSnapshot?: (snapshot: RoomSnapshotReport) => void;
  /**
   * Appelé dès que la salle est en jeu **avec un hôte**, puis à chaque
   * changement d'hôte — jamais deux fois de suite pour le même. Le serveur
   * monde s'en sert pour (re)livrer les caravanes arrivées sur la case : une
   * arrivée non confirmée doit repartir vers le nouvel hôte, ou vers le
   * premier hôte d'une salle qui rouvre (`docs/protocol.md` §12).
   */
  readonly onHostReady?: (hostId: PlayerId) => void;
  /** Période des snapshots de conservation. Défaut : `SNAPSHOT_EVERY_TICKS`. */
  readonly snapshotEveryTicks?: number;
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
  private readonly tile: TileRoom | null;
  private readonly onSnapshot: ((snapshot: RoomSnapshotReport) => void) | null;
  private readonly onHostReady: ((hostId: PlayerId) => void) | null;
  private readonly snapshotEveryTicks: number;

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
  /** Snapshot d'ouverture, servi au premier joueur puis oublié. */
  private restore: RoomRestore | null = null;
  /** Prochain tick où réclamer un snapshot de conservation. */
  private nextKeepTick = Number.POSITIVE_INFINITY;
  /** Dernier hôte annoncé par `onHostReady`, pour ne pas le réannoncer. */
  private readyHost: PlayerId | null = null;

  constructor(options: RoomOptions) {
    this.name = options.name;
    this.tickRate = options.tickRate ?? TICK_RATE;
    this.bundleTicks = options.bundleTicks ?? BUNDLE_TICKS;
    this.maxPlayers = options.maxPlayers ?? MAX_PLAYERS;
    this.now = options.now ?? Date.now;
    this.startClock = options.startClock ?? defaultClock;
    this.log = options.log ?? ((line) => console.log(line));
    this.tile = options.tile ?? null;
    this.onSnapshot = options.onSnapshot ?? null;
    this.onHostReady = options.onHostReady ?? null;
    this.snapshotEveryTicks = options.snapshotEveryTicks ?? SNAPSHOT_EVERY_TICKS;
    if (!Number.isInteger(this.snapshotEveryTicks) || this.snapshotEveryTicks < 1) {
      throw new RangeError("snapshotEveryTicks doit être un entier >= 1");
    }
    this.history = new BundleHistory(options.maxHistoryBundles ?? MAX_HISTORY_BUNDLES);
    this.scheduler = new Scheduler({ bundleTicks: this.bundleTicks });

    if (this.tile !== null) {
      // La graine d'une case est imposée : le `start` de l'hôte ne la choisit pas.
      this.seed = this.tile.seed;
    }
    if (options.restore !== undefined) {
      if (this.tile === null) {
        throw new Error("restore n'a de sens que pour une salle de case");
      }
      // Reprise : la salle est déjà en jeu, l'horloge repart du tick du
      // snapshot et l'historique repart vide (pas de rejeu).
      this.restore = options.restore;
      this.roomState = "running";
      this.width = options.restore.width;
      this.height = options.restore.height;
      this.scheduler = new Scheduler({ bundleTicks: this.bundleTicks, startTick: options.restore.tick });
      this.nextKeepTick = options.restore.tick + this.snapshotEveryTicks;
    }
  }

  get state(): RoomState {
    return this.roomState;
  }

  /** Case du globe portée par la salle, `null` pour une salle simple. */
  get tileId(): number | null {
    return this.tile?.id ?? null;
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
      const opening = this.restore;
      if (opening !== null && this.players.length === 1) {
        // Réouverture d'une colonie : le serveur a l'état, l'hôte n'a rien à
        // fournir. Aucun bundle à rejouer, l'historique repart de ce tick.
        // `frozenTicks` n'est transporté que s'il y a du temps à rattraper :
        // c'est à ce joueur, qui est l'hôte, d'émettre l'avance rapide.
        const frozenTicks = opening.frozenTicks ?? 0;
        this.sendTo(player, {
          type: "snapshot",
          tick: opening.tick,
          data: opening.data,
          ...(frozenTicks > 0 ? { frozenTicks } : {}),
        });
        player.synced = true;
        this.restore = null;
        this.log(
          `[${this.name}] rouverte au tick ${opening.tick} depuis un snapshot conservé (${opening.data.length} octets` +
            `${frozenTicks > 0 ? `, ${frozenTicks} ticks gelés à rattraper` : ""})`,
        );
      } else {
        this.requestSnapshotFor(player.id);
      }
    }
    // Une salle rouverte n'a pas eu de `start` : son horloge démarre à la
    // première arrivée.
    if (this.isRunning() && this.stopClock === null) {
      this.stopClock = this.startClock(() => this.emitBundle(), this.bundleIntervalMs);
    }
    this.notifyHostReady();
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
    this.notifyHostReady();
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
      case "world_join":
      case "settle":
      case "visit":
      case "abandon":
      case "world_leave":
      case "caravan_depart":
      case "caravan_cancel":
      case "caravan_delivered":
        // Les actions de monde sont traitées par le serveur avant d'atteindre
        // une salle : en arriver ici est un bug de câblage.
        this.fail(player, "bad_message", "action de monde adressée à une salle");
        return;
    }
  }

  /**
   * Envoie un message à l'hôte, s'il y en a un. Renvoie faux sinon : au
   * serveur de réessayer plus tard (c'est ce que fait `onHostReady`).
   */
  sendToHost(message: ServerMessage): boolean {
    const host = this.players.find((p) => p.id === this.hostId);
    if (host === undefined) {
      return false;
    }
    this.sendTo(host, message);
    return true;
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

  /**
   * Annonce l'hôte au serveur monde, une seule fois par hôte : à l'entrée en
   * jeu (`start` ou réouverture depuis un snapshot) et à chaque changement
   * d'hôte. Une salle en `lobby` n'a pas de sim, donc rien à recevoir.
   */
  private notifyHostReady(): void {
    if (!this.isRunning() || this.hostId === null || this.hostId === this.readyHost) {
      return;
    }
    this.readyHost = this.hostId;
    this.onHostReady?.(this.hostId);
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
    // Dans une salle « case », la graine appartient à la case : le `seed`
    // annoncé par l'hôte est ignoré et c'est celui du serveur qui est diffusé.
    const effectiveSeed = this.tile === null ? seed : this.tile.seed;
    this.seed = effectiveSeed;
    this.width = width;
    this.height = height;
    this.roomState = "running";
    this.scheduler = new Scheduler({ bundleTicks: this.bundleTicks });
    this.history.clear();
    this.nextKeepTick = this.tile === null ? Number.POSITIVE_INFINITY : this.snapshotEveryTicks;
    for (const p of this.players) {
      p.synced = true;
    }
    this.broadcast({ type: "start", seed: effectiveSeed, width, height, tick: 0 });
    this.log(
      `[${this.name}] démarrage — seed ${effectiveSeed}${this.tile === null ? "" : " (imposé par la case)"}, carte ${width}x${height}, ${this.players.length} joueur(s)`,
    );
    this.stopClock = this.startClock(() => this.emitBundle(), this.bundleIntervalMs);
    // La carte existe enfin : une caravane arrivée pendant le lobby peut être
    // livrée à l'hôte.
    this.notifyHostReady();
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
    if (bundle.to >= this.nextKeepTick) {
      while (this.nextKeepTick <= bundle.to) {
        this.nextKeepTick += this.snapshotEveryTicks;
      }
      this.requestKeepSnapshot();
    }
  }

  /**
   * Réclame à l'hôte l'état de la colonie, pour conservation. `forPlayer` vaut
   * `NO_PLAYER` : personne n'attend ce snapshot, il est destiné au serveur.
   */
  private requestKeepSnapshot(): void {
    const host = this.players.find((p) => p.id === this.hostId);
    if (host === undefined || this.onSnapshot === null) {
      return;
    }
    this.sendTo(host, { type: "request_snapshot", forPlayer: NO_PLAYER });
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
    if (
      this.tile !== null &&
      forPlayer === undefined &&
      this.onSnapshot !== null &&
      this.width !== null &&
      this.height !== null
    ) {
      // Snapshot de conservation : il n'est diffusé à personne, il devient le
      // dernier état connu de la colonie. Il sert quand même les rejoignants
      // encore en attente, juste en dessous : c'est exactement l'état qu'ils
      // réclament.
      this.onSnapshot({ tick, data, width: this.width, height: this.height });
      this.log(`[${this.name}] snapshot conservé au tick ${tick} (${data.length} octets)`);
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
