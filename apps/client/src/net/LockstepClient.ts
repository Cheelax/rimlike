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
  type ClientMessage,
  type PlayerId,
  type PlayerInfo,
  type ServerMessage,
  type StartClimate, NO_PLAYER } from "@rimlike/protocol";

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
  /**
   * Joueurs déviants au sens de la majorité, à l'instant de l'alarme (§7).
   * Absent quand aucune majorité n'était connue (moins de trois hashes pour ce
   * tick, ou cas systématique à deux joueurs) : record figé de la première et
   * unique diffusion `desync` d'une salle, jamais réémis ensuite.
   */
  readonly outliers?: readonly PlayerId[];
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
  /**
   * Climat hérité de la case du globe, reçu par `start.climate` à la
   * fondation d'une colonie neuve (`docs/protocol.md` §11.6). `null` en salle
   * simple (pas de case) ou une fois consommé par `consumeStartClimate` — même
   * schéma que `frozenTicks`/`consumeFrozenTicks` : un champ qui se vide dès
   * qu'il a été mis à profit, pour garantir une émission unique.
   */
  readonly climate: StartClimate | null;
  /**
   * Joueurs actuellement connus comme déviants (§7) : `desync.outliers` au
   * départ, réduit à chaque `resynced` reçu. Vide tant qu'aucune majorité n'a
   * jamais été connue (salle à deux joueurs, ou moins de trois hashes) : dans
   * ce cas `isOutlier` et `roomDesynced` ne peuvent pas mieux faire que rester
   * conservateurs (voir leur documentation).
   */
  readonly outliers: readonly PlayerId[];
  /** Notre propre `playerId` figure dans `outliers` : notre copie diverge. */
  readonly isOutlier: boolean;
  /**
   * La salle a déjà signalé un `desync` et n'est pas connue comme rétablie.
   * Un `resynced` nous concernant ne suffit pas à le retirer si d'autres
   * joueurs (ou l'hôte, jamais resynchronisable) divergent encore — ni si
   * aucune majorité n'a jamais permis de savoir qui divergeait (`docs/protocol.md`
   * §7, cas à deux joueurs) : dans ce cas le doute profite à la prudence, le
   * champ reste vrai tant que la salle n'a pas prouvé son rétablissement.
   */
  readonly roomDesynced: boolean;
  /**
   * Tick du dernier `resynced` nous concernant, `null` avant le premier.
   * Jamais remis à `null` ensuite : c'est un simple repère pour afficher un
   * toast une fois (comparer à la valeur précédemment vue, comme
   * `frozenTicks`/`consumeFrozenTicks` sert d'avance rapide, en plus simple
   * puisqu'il n'y a rien à consommer ici).
   */
  readonly lastResyncTick: number | null;
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
  /** Erreurs serveur et trous de bundles. Jamais avalées en silence. */
  readonly onError?: (error: LockstepError) => void;
}

export class LockstepClient {
  private readonly transport: Transport;
  private readonly createSim: CreateSim;
  private readonly restoreSim: RestoreSim;
  private readonly onState: ((state: LockstepState) => void) | null;
  private readonly onSim: ((sim: SimLike) => void) | null;
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
  /** Voir `LockstepState.climate` et `consumeStartClimate`. */
  private climateValue: StartClimate | null = null;
  /**
   * Dose de menace choisie par l'hôte pour la partie qui démarre, mémorisée
   * par `startGame` (jamais par le réseau : la difficulté n'est pas dans le
   * protocole). Voir `consumeStartDifficulty`.
   */
  private pendingDifficultyValue: number | null = null;
  /** Voir `LockstepState.outliers` : réduit par `resynced`, jamais réétendu que par `desync`. */
  private deviating = new Set<PlayerId>();
  /** Vrai dès qu'un `desync` a porté des `outliers` : sans ça, `deviating` vide ne prouve rien. */
  private outliersKnown = false;
  /** Voir `LockstepState.lastResyncTick`. */
  private lastResyncTick: number | null = null;

  constructor(options: LockstepOptions) {
    this.transport = options.transport;
    this.createSim = options.createSim;
    this.restoreSim = options.restoreSim;
    this.onState = options.onState ?? null;
    this.onSim = options.onSim ?? null;
    this.onError = options.onError ?? null;
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
    this.send({ type: "join", room, name, protocol: PROTOCOL_VERSION });
    this.emit();
  }

  /**
   * Réservé au host, en lobby. Fixe la graine et la taille pour tous.
   *
   * `difficulty` (`render/terrain.ts::DIFFICULTY`) ne part jamais sur le
   * réseau : elle est mémorisée ici et lue une seule fois par
   * `consumeStartDifficulty`, dès que ce client adopte son propre sim (voir
   * `worker/startDifficulty.ts`) — c'est alors une commande ordinaire,
   * comme n'importe quel ordre du lockstep, qui la propage à tous les autres.
   */
  startGame(seed: number, width: number, height: number, difficulty?: number): void {
    this.pendingDifficultyValue = difficulty ?? null;
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
   * Demande explicite d'une resynchronisation fraîche (`docs/protocol.md` §7) :
   * le serveur relance pour nous le mécanisme d'un rejoignant, sans attendre
   * un point de contrôle. Refusée pour l'hôte (`host_cannot_resync`) ou trop
   * tôt après la précédente (`resync_cooldown`) : ces deux codes arrivent par
   * `onError`, à traiter comme des refus non bloquants, pas des erreurs.
   */
  requestResync(): void {
    this.send({ type: "resync" });
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
   * Lit le climat hérité de la case et le remet à `null` : deux appels ne le
   * renvoient qu'une fois. C'est ce qui garantit qu'un seul `SetClimate` part
   * par colonie neuve, même si l'appelant se trompe et appelle deux fois
   * (`docs/protocol.md` §11.6, même garantie que `consumeFrozenTicks`).
   */
  consumeStartClimate(): StartClimate | null {
    const value = this.climateValue;
    this.climateValue = null;
    return value;
  }

  /**
   * Lit la difficulté choisie par l'hôte au moment de `startGame` et la
   * remet à `null` : deux appels ne la renvoient qu'une fois, même garantie
   * que `consumeFrozenTicks`/`consumeStartClimate`. `null` pour un non-hôte,
   * qui n'appelle jamais `startGame`.
   */
  consumeStartDifficulty(): number | null {
    const value = this.pendingDifficultyValue;
    this.pendingDifficultyValue = null;
    return value;
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
        // Climat hérité de la case (§11.6) : stocké, jamais appliqué ici.
        // `consumeStartClimate` est le seul chemin qui le consomme, dès que le
        // sim neuf est adopté (voir le Worker) — même schéma que `frozenTicks`.
        this.climateValue = message.climate ?? null;
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
        this.desyncInfo = Object.freeze({
          tick: message.tick,
          hashes: Object.freeze({ ...message.hashes }),
          ...(message.outliers ? { outliers: Object.freeze([...message.outliers]) } : {}),
        });
        // `desync` n'est diffusé qu'une fois pour la vie de la salle (§7) :
        // c'est ici, et seulement ici, que `deviating` se peuple.
        if (message.outliers) {
          this.outliersKnown = true;
          this.deviating = new Set(message.outliers);
        }
        this.emit();
        return;
      case "resynced":
        // Retire ce joueur des déviants connus, que ce soit nous ou un autre :
        // `roomDesynced` (dérivé de `deviating`) ne redevient faux que si plus
        // personne n'y figure (`docs/protocol.md` §7).
        this.deviating.delete(message.player);
        if (message.player === this.playerId) {
          this.lastResyncTick = message.tick;
        }
        this.emit();
        return;
      case "caravan_arrive":
        // Le serveur l'envoie aussi ici (§12.4), mais le client ne s'en sert
        // plus : `caravan_depart`/`caravan_delivered` partent désormais de la
        // connexion **monde** (`WorldClient`, voir `docs/protocol.md` §12.7),
        // qui reçoit le même message par la même règle de présence (clé, ou
        // nom en repli) et suffit à piloter tout le flux d'arrivée.
        return;
      case "world_error":
        // Un refus de caravane ne peut plus arriver ici : ces ordres ne
        // partent plus de cette connexion. Gardé par exhaustivité du type.
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
      climate: this.climateValue,
      outliers: Object.freeze([...this.deviating]),
      isOutlier: this.playerId !== null && this.deviating.has(this.playerId),
      roomDesynced: this.desyncInfo !== null && !(this.outliersKnown && this.deviating.size === 0),
      lastResyncTick: this.lastResyncTick,
    });
  }
}

/** Commandes d'un tick, dans l'ordre du bundle. Un tick vide est omis. */
function commandsAt(bundle: Bundle, tick: number): Bundle["ticks"][number]["commands"] {
  return bundle.ticks.find((t) => t.tick === tick)?.commands ?? [];
}
