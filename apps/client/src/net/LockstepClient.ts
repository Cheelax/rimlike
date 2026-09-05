/**
 * Le lockstep côté client : logique pure, pilotée par les messages reçus.
 *
 * Aucun timer, aucun DOM, aucune référence au rendu. C'est l'appelant qui
 * décide quand avancer le sim, en appelant `pump` (une fois par frame dans
 * `App.tsx`). Tout ce qui vient du réseau entre par `Transport.onMessage`,
 * tout ce qui en sort passe par `Transport.send`.
 *
 * Règle du protocole (docs/protocol.md §5) : une commande n'est **jamais**
 * appliquée au clic. `issue` l'envoie au serveur, elle revient dans un bundle,
 * et c'est là seulement qu'elle entre dans le sim — chez tous les joueurs, au
 * même tick, dans le même ordre.
 */

import {
  HASH_EVERY_TICKS,
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeMessage,
  type Bundle,
  type CaravanArriveMessage,
  type CaravanSummary,
  type ClientMessage,
  type PlayerId,
  type PlayerInfo,
  type ServerMessage, NO_PLAYER } from "@rimlike/protocol";

import type { CreateSim, RestoreSim, SimLike } from "./SimLike";
import type { Transport } from "./Transport";

/**
 * `connecting` : `join` envoyé, pas encore de `welcome`.
 * `lobby` : la salle n'a pas démarré.
 * `running` : le sim tourne (ou est en cours de création / restauration).
 * `closed` : la connexion est tombée.
 */
export type LockstepPhase = "connecting" | "lobby" | "running" | "closed";

export interface DesyncInfo {
  readonly tick: number;
  readonly hashes: Readonly<Record<PlayerId, string>>;
}

/** Une erreur du serveur, ou un trou dans la suite des bundles. */
export interface LockstepError {
  readonly code: string;
  readonly message: string;
}

/** Photo de l'état réseau, figée : le HUD la lit sans pouvoir la modifier. */
export interface LockstepState {
  readonly phase: LockstepPhase;
  readonly room: string;
  readonly playerId: PlayerId | null;
  readonly hostId: PlayerId | null;
  readonly isHost: boolean;
  readonly players: readonly PlayerInfo[];
  /** Prochain tick à exécuter. */
  readonly tick: number;
  /** Ticks reçus mais pas encore exécutés. */
  readonly lag: number;
  /** Vrai dès que le sim existe et que `pump` peut avancer. */
  readonly ready: boolean;
  readonly seed: number | null;
  readonly width: number | null;
  readonly height: number | null;
  readonly desync: DesyncInfo | null;
  readonly lastError: LockstepError | null;
  /**
   * Temps gelé à rattraper, reçu par `snapshot.frozenTicks` à la réouverture
   * d'une colonie (`docs/protocol.md` §11.6). 0 hors de ce cas. Affiché tel
   * quel ; `consumeFrozenTicks` est le seul chemin qui le met à profit.
   */
  readonly frozenTicks: number;
}

export interface LockstepOptions {
  readonly transport: Transport;
  /** Sim neuf quand la partie démarre. */
  readonly createSim: CreateSim;
  /** Sim rebâti depuis le snapshot du host, pour un rejoint en cours. */
  readonly restoreSim: RestoreSim;
  /** Appelé à chaque changement d'état notable (pas à chaque tick). */
  readonly onState?: (state: LockstepState) => void;
  /** Appelé quand un sim devient utilisable (démarrage ou snapshot). */
  readonly onSim?: (sim: SimLike) => void;
  /**
   * Une caravane est arrivée sur la case de cette salle, et nous en sommes
   * l'hôte. À l'appelant d'émettre `ArriveCaravan` par `issue`, **puis** de
   * confirmer par `caravanDelivered` (`docs/protocol.md` §12.7).
   */
  readonly onCaravanArrive?: (arrival: CaravanArriveMessage) => void;
  /** Erreurs serveur et trous de bundles. Jamais avalées en silence. */
  readonly onError?: (error: LockstepError) => void;
  /**
   * Jeton de la connexion **monde** (`docs/protocol.md` §11.2), pour que le
   * `world_join` paresseux de `sendCaravanDepart` désigne le même joueur que
   * celle-ci — sinon le serveur crée un second joueur, et la caravane
   * expédiée d'ici n'est pas « à nous » sur le globe. Absent : comportement
   * d'avant (nouveau joueur sous le même nom), celui des clients à connexion
   * unique des tests, qui n'ont pas de connexion monde séparée.
   */
  readonly worldToken?: string;
}

/** Ce qu'il faut pour expédier un manifeste depuis la case de cette salle. */
export interface RoomCaravanDeparture {
  readonly fromTile: number;
  readonly toTile: number;
  /** Octets postcard du sim, opaques pour le serveur. */
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
}

export class LockstepClient {
  private readonly transport: Transport;
  private readonly createSim: CreateSim;
  private readonly restoreSim: RestoreSim;
  private readonly onState: ((state: LockstepState) => void) | null;
  private readonly onSim: ((sim: SimLike) => void) | null;
  private readonly onCaravanArrive: ((arrival: CaravanArriveMessage) => void) | null;
  private readonly onError: ((error: LockstepError) => void) | null;

  private simInstance: SimLike | null = null;
  /** Incrémenté à chaque sim demandé : une création tardive ne l'écrase pas. */
  private generation = 0;
  private readonly queue: Bundle[] = [];
  /** Dernier tick couvert par les bundles reçus, `-1` avant le premier. */
  private lastReceivedTick = -1;
  /** `from` attendu du prochain bundle ; `null` juste après un (re)départ. */
  private expectFrom: number | null = null;
  /** Tick où l'on s'est arrêté faute de bundle, pour ne le signaler qu'une fois. */
  private stalledAt: number | null = null;
  private nextTick = 0;
  /** Snapshots réclamés par le serveur avant que notre sim n'existe. */
  private snapshotRequests: PlayerId[] = [];

  private phase: LockstepPhase = "connecting";
  private roomName = "";
  private playerId: PlayerId | null = null;
  private hostId: PlayerId | null = null;
  private players: readonly PlayerInfo[] = [];
  private seed: number | null = null;
  private width: number | null = null;
  private height: number | null = null;
  private desyncInfo: DesyncInfo | null = null;
  private lastError: LockstepError | null = null;
  /** Voir `LockstepState.frozenTicks` et `consumeFrozenTicks`. */
  private frozenTicksValue = 0;
  /** Nom donné au `join` : le `world_join` tardif des caravanes en a besoin. */
  private playerName = "";
  /** Vrai une fois cette connexion entrée dans le monde (voir `sendCaravanDepart`). */
  private worldJoined = false;
  /** Voir `LockstepOptions.worldToken`. */
  private readonly worldToken: string | null;

  constructor(options: LockstepOptions) {
    this.transport = options.transport;
    this.createSim = options.createSim;
    this.restoreSim = options.restoreSim;
    this.onState = options.onState ?? null;
    this.onSim = options.onSim ?? null;
    this.onCaravanArrive = options.onCaravanArrive ?? null;
    this.onError = options.onError ?? null;
    this.worldToken = options.worldToken ?? null;
    this.transport.onMessage((text) => this.receive(text));
    this.transport.onClose(() => {
      this.phase = "closed";
      this.emit();
    });
  }

  // --- Lecture ---

  /** Le sim local, `null` tant que la partie n'a pas démarré. */
  get sim(): SimLike | null {
    return this.simInstance;
  }

  /** Prochain tick à exécuter. */
  get tick(): number {
    return this.nextTick;
  }

  /** Retard : ticks reçus qu'il reste à exécuter. Pour le HUD. */
  get lag(): number {
    return Math.max(0, this.lastReceivedTick + 1 - this.nextTick);
  }

  get state(): LockstepState {
    return this.snapshotState();
  }

  // --- Actions du joueur ---

  /** Premier message de la connexion. Crée la salle si elle n'existe pas. */
  join(room: string, name: string): void {
    this.roomName = room;
    this.playerName = name;
    this.send({ type: "join", room, name, protocol: PROTOCOL_VERSION });
    this.emit();
  }

  /** Réservé au host, en lobby. Fixe la graine et la taille pour tous. */
  startGame(seed: number, width: number, height: number): void {
    this.send({ type: "start", seed, width, height });
  }

  /**
   * Envoie une commande encodée. Rien n'est appliqué localement : elle
   * reviendra dans un bundle, au tick choisi par le serveur.
   */
  issue(bytes: Uint8Array): void {
    this.send({ type: "command", payload: bytes });
  }

  /**
   * Lit le temps gelé à rattraper et le remet à 0 : deux appels ne le
   * renvoient qu'une fois. C'est ce qui garantit qu'un seul `FastForward`
   * part par réouverture, même si l'appelant se trompe et appelle deux fois
   * (`docs/protocol.md` §11.6).
   */
  consumeFrozenTicks(): number {
    const value = this.frozenTicksValue;
    this.frozenTicksValue = 0;
    return value;
  }

  /**
   * Expédie un manifeste de caravane depuis la case de cette salle.
   *
   * Pourquoi **ici** et pas sur la connexion monde : le serveur exige que
   * l'auteur d'un `caravan_depart` soit dans la salle de `fromTile`
   * (`caravan_not_in_room`, `docs/protocol.md` §12.5). Notre client ouvre deux
   * connexions — le monde sur le thread principal, la salle dans le Worker —
   * et c'est celle-ci qui est dans la salle.
   *
   * Le serveur exige **aussi** un `world_join` sur la connexion qui expédie
   * (c'est de là que vient le `owner` de la caravane). On l'émet au premier
   * départ seulement, avec le **même jeton** que la connexion monde du thread
   * principal (`worldToken`, §11.2) : sans ça le serveur créerait un second
   * joueur, et la caravane n'appartiendrait pas à celui qui joue. Sans jeton
   * connu — clients à connexion unique des tests, ou identité pas encore
   * reçue — on repart sans, comme avant : un nouveau joueur sous le même nom.
   */
  sendCaravanDepart(departure: RoomCaravanDeparture): void {
    if (!this.worldJoined) {
      this.worldJoined = true;
      this.send({
        type: "world_join",
        name: this.playerName,
        protocol: PROTOCOL_VERSION,
        ...(this.worldToken !== null ? { token: this.worldToken } : {}),
      });
    }
    this.send({
      type: "caravan_depart",
      fromTile: departure.fromTile,
      toTile: departure.toTile,
      manifest: departure.manifest,
      summary: departure.summary,
    });
  }

  /**
   * Confirme l'injection d'une arrivée, **après** avoir émis la commande. Même
   * raison que ci-dessus : il faut être dans la salle de la case d'arrivée, et
   * `caravan_delivered` est justement le seul message de caravane qui n'exige
   * pas d'être entré dans le monde (§12.5).
   */
  sendCaravanDelivered(id: string): void {
    this.send({ type: "caravan_delivered", id });
  }

  close(): void {
    this.transport.close();
  }

  // --- Boucle ---

  /**
   * Exécute autant de ticks complets que les bundles reçus le permettent, au
   * plus `maxTicks`. Renvoie le nombre de ticks exécutés.
   *
   * Un tick n'est exécuté que si son bundle est là : pas d'extrapolation. Le
   * rattrapage est borné par appel, pas dans le temps : la file se vide sur
   * plusieurs frames s'il le faut (docs/protocol.md §6).
   */
  pump(maxTicks: number): number {
    const sim = this.simInstance;
    if (sim === null || maxTicks <= 0) {
      return 0;
    }
    let executed = 0;
    while (executed < maxTicks && this.queue.length > 0) {
      const bundle = this.queue[0]!;
      if (bundle.to < this.nextTick) {
        // Rejeu : ce bundle est entièrement derrière nous.
        this.queue.shift();
        continue;
      }
      if (bundle.from > this.nextTick) {
        // Signalé une seule fois par point d'arrêt : la boucle de rendu
        // repasse ici à chaque frame tant que le tick manquant n'arrive pas.
        if (this.stalledAt !== this.nextTick) {
          this.stalledAt = this.nextTick;
          this.fail("history_gap", `bundle au tick ${bundle.from} alors que le tick ${this.nextTick} manque`);
        }
        break;
      }
      while (this.nextTick <= bundle.to && executed < maxTicks) {
        for (const command of commandsAt(bundle, this.nextTick)) {
          sim.applyEncoded(command.payload);
        }
        sim.step(1);
        this.nextTick += 1;
        executed += 1;
        // Hash de l'état **avant** d'exécuter ce tick, donc juste après le
        // précédent : `nextTick` compte les ticks appliqués.
        if (this.nextTick % HASH_EVERY_TICKS === 0) {
          this.send({ type: "hash", tick: this.nextTick, hash: sim.hash() });
        }
      }
      if (this.nextTick > bundle.to) {
        this.queue.shift();
      }
    }
    return executed;
  }

  // --- Réception ---

  private receive(text: string): void {
    const message = decodeServerMessage(text);
    if (message === null) {
      this.fail("bad_message", "trame serveur illisible");
      return;
    }
    this.handle(message);
  }

  private handle(message: ServerMessage): void {
    switch (message.type) {
      case "welcome":
        this.playerId = message.playerId;
        this.players = message.players;
        this.hostId = message.isHost ? message.playerId : this.hostId;
        this.phase = message.state === "lobby" ? "lobby" : "running";
        this.seed = message.seed ?? null;
        this.width = message.width ?? null;
        this.height = message.height ?? null;
        // En cours de partie, le sim viendra du snapshot du host (§8).
        this.emit();
        return;
      case "players":
        this.players = message.players;
        this.hostId = message.hostId;
        this.emit();
        return;
      case "start":
        this.seed = message.seed;
        this.width = message.width;
        this.height = message.height;
        this.phase = "running";
        this.resetTo(message.tick);
        this.adopt(this.createSim(message.seed, message.width, message.height));
        this.emit();
        return;
      case "snapshot":
        this.phase = "running";
        this.resetTo(message.tick);
        // Réouverture d'une colonie gelée (§11.6) : stocké, jamais appliqué
        // ici. `consumeFrozenTicks` est le seul chemin qui le consomme, dès
        // que le sim restauré est adopté (voir le Worker).
        this.frozenTicksValue = message.frozenTicks ?? 0;
        this.adopt(this.restoreSim(message.data));
        this.emit();
        return;
      case "bundle":
        this.enqueue(message);
        return;
      case "request_snapshot":
        this.serveSnapshot(message.forPlayer);
        return;
      case "desync":
        this.desyncInfo = Object.freeze({ tick: message.tick, hashes: Object.freeze({ ...message.hashes }) });
        this.emit();
        return;
      case "caravan_arrive":
        // Adressé au seul hôte de cette salle, sur cette connexion : c'est
        // elle qui est dans la salle de la case d'arrivée (§12.4).
        this.onCaravanArrive?.(message);
        return;
      case "world_error":
        // Refus d'un ordre de caravane parti d'ici. Ce n'est pas une erreur de
        // salle, mais elle arrive sur cette connexion : à ne pas avaler.
        this.fail(message.code, message.message);
        return;
      case "error":
        this.fail(message.code, message.message);
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      case "pong":
        return;
    }
  }

  /**
   * Met un bundle en file. Un trou dans la suite est signalé : appliquer un
   * bundle après un tick manquant donnerait une colonie divergente.
   *
   * Le premier bundle après un démarrage ou un snapshot est un cas à part :
   * en rejeu, il commence souvent **avant** notre tick (docs/protocol.md §8).
   * Il doit seulement le couvrir ; `pump` ignorera les ticks déjà appliqués.
   */
  private enqueue(bundle: Bundle): void {
    if (this.expectFrom === null) {
      if (bundle.from > this.nextTick || bundle.to < this.nextTick) {
        this.fail(
          "history_gap",
          `premier bundle ${bundle.from}..${bundle.to} : il ne couvre pas le tick ${this.nextTick}`,
        );
      }
    } else if (bundle.from !== this.expectFrom) {
      this.fail(
        "history_gap",
        `bundle ${bundle.from}..${bundle.to} alors que le tick ${this.expectFrom} était attendu`,
      );
    }
    this.queue.push(bundle);
    this.expectFrom = bundle.to + 1;
    this.lastReceivedTick = Math.max(this.lastReceivedTick, bundle.to);
  }

  /** Repart d'un tick connu : nouvelle partie ou snapshot reçu. */
  private resetTo(tick: number): void {
    this.nextTick = tick;
    this.queue.length = 0;
    this.expectFrom = null;
    this.stalledAt = null;
    this.lastReceivedTick = tick - 1;
  }

  /**
   * Adopte le sim quand sa création (asynchrone : le WASM) aboutit. Les
   * bundles arrivés entre-temps sont déjà en file, `pump` les rattrapera.
   */
  private adopt(pending: Promise<SimLike>): void {
    this.generation += 1;
    const generation = this.generation;
    void pending.then(
      (sim) => {
        if (generation !== this.generation) {
          return;
        }
        this.simInstance = sim;
        this.onSim?.(sim);
        for (const player of this.snapshotRequests.splice(0)) {
          this.serveSnapshot(player);
        }
        this.emit();
      },
      (e: unknown) => {
        this.fail("sim_error", `sim indisponible : ${String(e)}`);
      },
    );
  }

  /** Le host fournit son état au joueur qui rejoint (docs/protocol.md §8). */
  private serveSnapshot(forPlayer: PlayerId): void {
    const sim = this.simInstance;
    if (sim === null) {
      // Notre sim n'est pas encore prêt : on répondra dès qu'il l'est.
      this.snapshotRequests.push(forPlayer);
      return;
    }
    if (forPlayer === NO_PLAYER) {
      // Snapshot de conservation demandé par le serveur monde : pas de destinataire.
      this.send({ type: "snapshot", tick: this.nextTick, data: sim.snapshot() });
      return;
    }
    this.send({ type: "snapshot", tick: this.nextTick, data: sim.snapshot(), forPlayer });
  }

  private send(message: ClientMessage): void {
    this.transport.send(encodeMessage(message));
  }

  private fail(code: string, message: string): void {
    this.lastError = Object.freeze({ code, message });
    this.onError?.(this.lastError);
    this.emit();
  }

  private emit(): void {
    this.onState?.(this.snapshotState());
  }

  private snapshotState(): LockstepState {
    return Object.freeze({
      phase: this.phase,
      room: this.roomName,
      playerId: this.playerId,
      hostId: this.hostId,
      isHost: this.playerId !== null && this.playerId === this.hostId,
      players: Object.freeze([...this.players]),
      tick: this.nextTick,
      lag: this.lag,
      ready: this.simInstance !== null,
      seed: this.seed,
      width: this.width,
      height: this.height,
      desync: this.desyncInfo,
      lastError: this.lastError,
      frozenTicks: this.frozenTicksValue,
    });
  }
}

/** Commandes d'un tick, dans l'ordre du bundle. Un tick vide est omis. */
function commandsAt(bundle: Bundle, tick: number): Bundle["ticks"][number]["commands"] {
  return bundle.ticks.find((t) => t.tick === tick)?.commands ?? [];
}
