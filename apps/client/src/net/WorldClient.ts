/**
 * La connexion **monde** côté client : logique pure, pilotée par les messages
 * reçus (`docs/protocol.md` §11).
 *
 * Aucun timer, aucun DOM, aucune référence au rendu — même contrat que
 * `LockstepClient`, et le même `Transport`. Elle vit sur le **thread
 * principal** : le Worker de simulation n'ouvre sa propre connexion qu'au
 * moment d'entrer dans une salle, et les deux cohabitent (§11.3 : les
 * identifiants de joueur du monde et de salle sont indépendants).
 *
 * Ce que cette classe ne fait pas : télécharger le globe. Il vient de
 * `GET /world` (voir `worldFetch.ts`) et lui est passé sous la forme réduite
 * `WorldInfo`, seulement pour vérifier qu'on parle bien du même globe.
 */

import {
  PROTOCOL_VERSION,
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type PlayerId,
  type ServerMessage,
  type Settlement,
  type SettledMessage,
  type WorldInfo,
} from "@rimlike/protocol";

import type { Transport } from "./Transport";

/**
 * `connecting` : `world_join` envoyé, pas encore de `world_welcome`.
 * `connected` : on est dans le monde, la liste des colonies est à jour.
 * `closed` : la connexion est tombée, ou le globe du serveur n'est pas le
 * nôtre — dans les deux cas il n'y a plus rien à faire sans reconnexion.
 */
export type WorldPhase = "connecting" | "connected" | "closed";

/** Un refus du serveur (`world_error`), ou une incohérence constatée ici. */
export interface WorldError {
  readonly code: string;
  readonly message: string;
}

/** Photo de l'état du monde, figée : l'UI la lit sans pouvoir la modifier. */
export interface WorldClientState {
  readonly phase: WorldPhase;
  /** Notre identifiant de joueur **du monde**, sans rapport avec celui d'une salle. */
  readonly playerId: PlayerId | null;
  readonly name: string;
  /** Liste complète, telle que diffusée : le serveur ne fait pas de delta. */
  readonly settlements: readonly Settlement[];
  /** Noms des joueurs présents dans le monde (l'identité v1 est le nom). */
  readonly players: readonly string[];
  /** Le globe annoncé par le serveur, `null` avant `world_welcome`. */
  readonly world: WorldInfo | null;
  readonly lastError: WorldError | null;
}

export interface WorldClientOptions {
  readonly transport: Transport;
  /** Nom du joueur : c'est l'identité, faute de comptes (`docs/protocol.md` §11.2). */
  readonly name: string;
  /**
   * Le globe déjà téléchargé par `GET /world`. Le `world_welcome` doit
   * l'annoncer à l'identique, sinon on ne regarde pas la même carte et un clic
   * sur une case désignerait n'importe quoi.
   */
  readonly expected: WorldInfo;
  readonly onState?: (state: WorldClientState) => void;
  /** Réponse à `settle` comme à `visit` : où aller pour jouer la case. */
  readonly onSettled?: (settled: SettledMessage) => void;
  /** Refus du serveur. Un message à l'écran, jamais une déconnexion (§11.7). */
  readonly onError?: (error: WorldError) => void;
}

export class WorldClient {
  private readonly transport: Transport;
  private readonly expected: WorldInfo;
  private readonly onState: ((state: WorldClientState) => void) | null;
  private readonly onSettled: ((settled: SettledMessage) => void) | null;
  private readonly onError: ((error: WorldError) => void) | null;

  private phase: WorldPhase = "connecting";
  private readonly playerName: string;
  private playerId: PlayerId | null = null;
  private settlements: readonly Settlement[] = [];
  private players: readonly string[] = [];
  private worldInfo: WorldInfo | null = null;
  private lastError: WorldError | null = null;

  constructor(options: WorldClientOptions) {
    this.transport = options.transport;
    this.expected = options.expected;
    this.playerName = options.name;
    this.onState = options.onState ?? null;
    this.onSettled = options.onSettled ?? null;
    this.onError = options.onError ?? null;
    this.transport.onMessage((text) => this.receive(text));
    this.transport.onClose(() => {
      this.phase = "closed";
      this.emit();
    });
  }

  // --- Lecture ---

  get state(): WorldClientState {
    return this.snapshotState();
  }

  /** La colonie posée sur une case, ou `undefined` si la case est libre. */
  settlementAt(tile: number): Settlement | undefined {
    return this.settlements.find((settlement) => settlement.tile === tile);
  }

  // --- Actions ---

  /** Premier message de la connexion monde. */
  join(): void {
    this.send({ type: "world_join", name: this.playerName, protocol: PROTOCOL_VERSION });
    this.emit();
  }

  /** Fonder une colonie sur une case libre et terrestre. */
  settle(tile: number): void {
    this.send({ type: "settle", tile });
  }

  /** Demander la salle et la graine d'une case déjà colonisée, en invité. */
  visit(tile: number): void {
    this.send({ type: "visit", tile });
  }

  /** Rendre une de ses cases. */
  abandon(tile: number): void {
    this.send({ type: "abandon", tile });
  }

  /** Quitter le monde sans fermer la connexion. */
  leave(): void {
    this.send({ type: "world_leave" });
  }

  close(): void {
    this.transport.close();
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
      case "world_welcome": {
        const mismatch = describeMismatch(this.expected, message.world);
        if (mismatch !== null) {
          // Fatal : le globe affiché n'est pas celui du serveur, donc aucune
          // case cliquée ne désigne ce qu'on croit. Mieux vaut couper.
          this.worldInfo = message.world;
          this.phase = "closed";
          this.fail("world_mismatch", mismatch);
          this.transport.close();
          return;
        }
        this.playerId = message.playerId;
        this.settlements = Object.freeze([...message.settlements]);
        this.players = Object.freeze([...message.players]);
        this.worldInfo = message.world;
        this.phase = "connected";
        this.emit();
        return;
      }
      case "world_settlements":
        // Liste complète : on remplace, il n'y a pas de delta (§11.5).
        this.settlements = Object.freeze([...message.settlements]);
        this.emit();
        return;
      case "world_players":
        this.players = Object.freeze([...message.players]);
        this.emit();
        return;
      case "settled":
        this.onSettled?.(message);
        return;
      case "world_error":
        // Un refus de monde ne déconnecte pas : la case reste choisissable.
        this.fail(message.code, message.message);
        return;
      case "error":
        // `already_joined` ou `version_mismatch` : le serveur ferme derrière.
        this.fail(message.code, message.message);
        return;
      case "ping":
        this.send({ type: "pong" });
        return;
      default:
        // `welcome`, `bundle`, `start`… appartiennent à une salle : cette
        // connexion n'en a pas, le Worker a la sienne.
        return;
    }
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

  private snapshotState(): WorldClientState {
    return Object.freeze({
      phase: this.phase,
      playerId: this.playerId,
      name: this.playerName,
      settlements: this.settlements,
      players: this.players,
      world: this.worldInfo,
      lastError: this.lastError,
    });
  }
}

/**
 * Décrit en français ce qui diffère entre le globe téléchargé et celui
 * qu'annonce le serveur, ou `null` s'ils concordent. Les trois champs sont
 * vérifiés : deux globes de même graine mais de subdivision différente n'ont
 * ni le même nombre de cases ni les mêmes identifiants.
 */
export function describeMismatch(expected: WorldInfo, actual: WorldInfo): string | null {
  const parts: string[] = [];
  if (expected.seed !== actual.seed) parts.push(`graine ${actual.seed} au lieu de ${expected.seed}`);
  if (expected.subdivisions !== actual.subdivisions) {
    parts.push(`subdivision ${actual.subdivisions} au lieu de ${expected.subdivisions}`);
  }
  if (expected.tiles !== actual.tiles) parts.push(`${actual.tiles} cases au lieu de ${expected.tiles}`);
  if (parts.length === 0) return null;
  return `le globe du serveur ne correspond pas à celui téléchargé (${parts.join(", ")})`;
}
