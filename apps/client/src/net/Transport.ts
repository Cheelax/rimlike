/**
 * Le fil, réduit à quatre fonctions. `LockstepClient` ne connaît que cette
 * interface : il ne sait pas s'il parle à un `WebSocket` du navigateur, au
 * paquet `ws` sous Node (tests, voir `WsTransport.ts`) ou à rien du tout.
 *
 * Les trames sont du texte : le protocole v1 est du JSON (voir
 * `docs/protocol.md` §2). Le passage au binaire ne changera que le codec.
 */
export interface Transport {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
  /**
   * `code`/`reason` reprennent ceux du `CloseEvent` (RFC 6455) : 1000 pour une
   * fermeture normale, 1006 pour une coupure sans trame de fermeture (perte
   * réseau, processus tué). Optionnels : une fabrique de test qui n'en a pas
   * l'usage peut continuer à écrire `cb: () => void`, TypeScript l'accepte
   * (un appelant peut toujours ignorer des arguments qu'on lui offre).
   */
  onClose(cb: (code?: number, reason?: string) => void): void;
  close(): void;
}

/**
 * Implémentation navigateur. Les trames envoyées avant l'ouverture de la
 * socket sont gardées puis émises dans l'ordre : le client peut appeler
 * `join` tout de suite après la construction.
 */
export class WebSocketTransport implements Transport {
  private readonly socket: WebSocket;
  private readonly backlog: string[] = [];
  private message: ((text: string) => void) | null = null;
  private closed: ((code?: number, reason?: string) => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      for (const text of this.backlog.splice(0)) {
        this.socket.send(text);
      }
    });
    this.socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") {
        this.message?.(event.data);
      }
    });
    // Une erreur de WebSocket est toujours suivie d'un `close` : un seul chemin.
    this.socket.addEventListener("close", (event: CloseEvent) => this.closed?.(event.code, event.reason));
  }

  send(text: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
      this.socket.send(text);
    } else {
      this.backlog.push(text);
    }
  }

  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }

  onClose(cb: (code?: number, reason?: string) => void): void {
    this.closed = cb;
  }

  close(): void {
    this.backlog.length = 0;
    this.socket.close();
  }
}

/** Horloge injectable : la vraie par défaut, une fausse pilotée à la main dans les tests. */
export interface Scheduler {
  setTimeout(cb: () => void, ms: number): unknown;
  clearTimeout(handle: unknown): void;
}

const REAL_SCHEDULER: Scheduler = {
  setTimeout: (cb, ms) => setTimeout(cb, ms),
  clearTimeout: (handle) => clearTimeout(handle as ReturnType<typeof setTimeout>),
};

/** Délais du plan de reconnexion, avant gigue (millisecondes). */
export const RECONNECT_BASE_DELAY_MS = 1000;
export const RECONNECT_MAX_DELAY_MS = 15000;
/** Gigue relative appliquée au délai, `±20 %`. */
export const RECONNECT_JITTER_RATIO = 0.2;
/** Échecs consécutifs tolérés avant d'abandonner (bandeau « Serveur injoignable », `App.tsx`). */
export const MAX_RECONNECT_ATTEMPTS = 8;

export interface ReconnectingTransportOptions {
  /** Fabrique un `Transport` frais à chaque tentative (une `WebSocket` neuve). */
  readonly factory: () => Transport;
  /** Injectable en test : pas de vrais délais dans `reconnect.test.ts`. */
  readonly scheduler?: Scheduler;
  /** Source d'aléa pour la gigue, injectable pour des délais reproductibles en test. */
  readonly random?: () => number;
  readonly baseDelayMs?: number;
  readonly maxDelayMs?: number;
  readonly maxAttempts?: number;
}

/**
 * Enveloppe une fabrique de `Transport` et rouvre tout seul après une
 * fermeture non demandée, avec un délai exponentiel plafonné (1 s, 2 s, 4 s…
 * jusqu'à 15 s) et un peu de gigue pour ne pas cogner le serveur en même temps
 * que tous les clients tombés ensemble (c'est du rendu/réseau, pas du sim :
 * `Math.random` est de mise, contrairement à `crates/sim`).
 *
 * `close()` est la seule façon d'arrêter définitivement les tentatives :
 * toute autre fermeture programme la suivante. `onReconnect` prévient la
 * couche au-dessus qu'un `Transport` neuf vient d'être créé — jamais avant :
 * le précédent est mort, une trame qu'on lui donnerait n'irait nulle part.
 * C'est le moment de rejouer sa séquence d'entrée (`join`/`world_join`,
 * `docs/protocol.md` §4, §11.4), pas de supposer que la reconnexion a réussi
 * (le nouveau `Transport` peut lui aussi échouer, et sera remplacé à son tour).
 *
 * Après `MAX_ATTEMPTS` échecs consécutifs — jamais rouverte assez longtemps
 * pour recevoir une seule trame — on abandonne : `onClose` est appelé une
 * dernière fois, comme un `Transport` ordinaire qui aurait fermé pour de bon.
 * Une trame reçue (la preuve qu'une tentative a abouti) remet le compte à
 * zéro : ce sont des échecs **consécutifs**, pas un total sur toute la vie de
 * la connexion.
 *
 * `send` pendant l'attente entre deux tentatives ne va nulle part : il n'y a
 * pas de `Transport` courant à qui la donner, et la mettre de côté pour un
 * envoi différé referait ce que le lockstep interdit déjà (§5) — c'est à la
 * couche au-dessus (`LockstepClient.issue`, `docs/protocol.md`) de compter ces
 * pertes, pas à ce transport de les cacher.
 */
export class ReconnectingTransport implements Transport {
  private readonly factory: () => Transport;
  private readonly scheduler: Scheduler;
  private readonly random: () => number;
  private readonly baseDelayMs: number;
  private readonly maxDelayMs: number;
  private readonly maxAttempts: number;

  private current: Transport;
  private message: ((text: string) => void) | null = null;
  private closed: ((code?: number, reason?: string) => void) | null = null;
  private reconnected: (() => void) | null = null;
  private explicitlyClosed = false;
  private pendingTimer: unknown = null;
  /** Échecs consécutifs depuis la dernière trame reçue. */
  private consecutiveFailures = 0;

  constructor(options: ReconnectingTransportOptions) {
    this.factory = options.factory;
    this.scheduler = options.scheduler ?? REAL_SCHEDULER;
    this.random = options.random ?? Math.random;
    this.baseDelayMs = options.baseDelayMs ?? RECONNECT_BASE_DELAY_MS;
    this.maxDelayMs = options.maxDelayMs ?? RECONNECT_MAX_DELAY_MS;
    this.maxAttempts = options.maxAttempts ?? MAX_RECONNECT_ATTEMPTS;
    this.current = this.factory();
    this.wire(this.current);
  }

  /** Vrai pendant l'attente d'une tentative (pas pendant qu'un `Transport` est en vie). */
  get reconnecting(): boolean {
    return this.pendingTimer !== null;
  }

  /** Échecs consécutifs depuis la dernière trame reçue, ou depuis le début. */
  get attempts(): number {
    return this.consecutiveFailures;
  }

  send(text: string): void {
    if (this.pendingTimer !== null) return; // en attente : rien à envoyer, la trame est perdue
    this.current.send(text);
  }

  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }

  onClose(cb: (code?: number, reason?: string) => void): void {
    this.closed = cb;
  }

  /** Un `Transport` neuf vient d'être créé : rejouer `join`/`world_join`. */
  onReconnect(cb: () => void): void {
    this.reconnected = cb;
  }

  close(): void {
    this.explicitlyClosed = true;
    if (this.pendingTimer !== null) {
      this.scheduler.clearTimeout(this.pendingTimer);
      this.pendingTimer = null;
    }
    this.current.close();
  }

  private wire(transport: Transport): void {
    transport.onMessage((text) => {
      // Une trame reçue prouve que cette tentative a abouti.
      this.consecutiveFailures = 0;
      this.message?.(text);
    });
    transport.onClose((code, reason) => this.handleClose(code, reason));
  }

  private handleClose(code?: number, reason?: string): void {
    if (this.explicitlyClosed) return;
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures >= this.maxAttempts) {
      this.closed?.(code, reason);
      return;
    }
    const delay = this.delayFor(this.consecutiveFailures);
    this.pendingTimer = this.scheduler.setTimeout(() => {
      this.pendingTimer = null;
      if (this.explicitlyClosed) return;
      this.current = this.factory();
      this.wire(this.current);
      this.reconnected?.();
    }, delay);
  }

  /** `1s, 2s, 4s, 8s, 15s (plafond)…`, ± `RECONNECT_JITTER_RATIO`. */
  private delayFor(attempt: number): number {
    const base = Math.min(this.baseDelayMs * 2 ** (attempt - 1), this.maxDelayMs);
    const jitter = base * RECONNECT_JITTER_RATIO * (this.random() * 2 - 1);
    return Math.max(0, Math.round(base + jitter));
  }
}
