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
  type Caravan,
  type CaravanArriveMessage,
  type CaravanSummary,
  type ClientMessage,
  type Merchant,
  type PlayerId,
  type ServerMessage,
  type Settlement,
  type SettledMessage,
  type WorldInfo,
  type WorldPlayerInfo,
} from "@rimlike/protocol";

import {
  forgetIdentity as forgetStoredIdentity,
  loadIdentity,
  saveIdentity,
  type StoredIdentity, identityScope } from "./identity";
import type { Transport } from "./Transport";

/** Ce que le crochet de dev montre d'une identité stockée : jamais le jeton en clair. */
export interface IdentitySummary {
  readonly playerKey: string;
  /** Longueur du jeton, pas sa valeur : de quoi vérifier qu'il existe, rien de plus. */
  readonly tokenLength: number;
}

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
  /**
   * Notre clé publique et stable (`docs/protocol.md` §11.2) : c'est elle qui
   * apparaît dans `Settlement.owner` et `Caravan.owner`, à comparer pour
   * savoir si une colonie ou une caravane nous appartient. `null` avant le
   * premier `world_welcome`.
   */
  readonly playerKey: string | null;
  readonly name: string;
  /** Liste complète, telle que diffusée : le serveur ne fait pas de delta. */
  readonly settlements: readonly Settlement[];
  /**
   * Tous les joueurs déjà vus par le monde, connectés ou non (`online` le
   * distingue) — pas seulement ceux présents à l'instant, contrairement à la
   * v1 par nom.
   */
  readonly players: readonly WorldPlayerInfo[];
  /**
   * Caravanes en vol, telles que diffusées par `world_caravans`. Liste
   * complète elle aussi : le client remplace la sienne (`docs/protocol.md`
   * §12.4). Tenue à jour même pendant qu'on joue une colonie, pour que le
   * retour au globe montre tout de suite l'état courant.
   */
  readonly caravans: readonly Caravan[];
  /**
   * Marchands itinérants du globe, tels que diffusés par `world_caravans`
   * (`docs/protocol.md` §13.4) : même message, même cadence et même règle de
   * remplacement complet que `caravans`. Ce sont des PNJ, entièrement
   * serveur — aucune action de notre part n'agit sur eux, on les affiche.
   * Vide par défaut (avant le premier `world_caravans`, ou serveur qui ne les
   * connaît pas encore) ; un `world_caravans` sans champ `merchants` (ancien
   * serveur, §13.4) laisse la liste **inchangée** plutôt que de la vider.
   */
  readonly merchants: readonly Merchant[];
  /** Le globe annoncé par le serveur, `null` avant `world_welcome`. */
  readonly world: WorldInfo | null;
  readonly lastError: WorldError | null;
  /**
   * Le jeton courant de cette identité (`docs/protocol.md` §11.2). `null` tant
   * qu'aucune identité n'est connue (avant `world_welcome`, ou stockage
   * indisponible). Jamais affiché : le crochet de dev n'en montre que
   * `identitySummary` (longueur du jeton, pas sa valeur).
   */
  readonly token: string | null;
  /**
   * Vrai entre un `reconnect()` (coupure du `Transport`, en général via
   * `ReconnectingTransport.onReconnect`) et le `world_welcome` qui confirme
   * que le serveur nous a repris. Même rôle que `LockstepClient.reconnecting`
   * pour la salle, en indépendant : cette connexion et celle de la salle
   * tombent et se reconnectent chacune de son côté (`docs/protocol.md` §11.3).
   */
  readonly reconnecting: boolean;
  /** Tentatives de reconnexion consécutives depuis la dernière connexion établie. */
  readonly attempts: number;
}

/** Ce qu'il faut pour expédier un manifeste vers une autre case. */
export interface CaravanDeparture {
  readonly fromTile: number;
  readonly toTile: number;
  /** Octets postcard produits par le sim, opaques pour le serveur. */
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
}

export interface WorldClientOptions {
  readonly transport: Transport;
  /** Nom du joueur : un simple libellé d'affichage, l'identité est le jeton (`docs/protocol.md` §11.2). */
  readonly name: string;
  /**
   * URL du serveur, telle que passée à `Transport` : sert de clé de
   * stockage à l'identité (`net/identity.ts`), une par serveur. Deux serveurs
   * différents ne doivent jamais se voir proposer le jeton l'un de l'autre.
   */
  readonly serverUrl: string;
  /**
   * Le globe déjà téléchargé par `GET /world`. Le `world_welcome` doit
   * l'annoncer à l'identique, sinon on ne regarde pas la même carte et un clic
   * sur une case désignerait n'importe quoi.
   */
  readonly expected: WorldInfo;
  readonly onState?: (state: WorldClientState) => void;
  /** Réponse à `settle` comme à `visit` : où aller pour jouer la case. */
  readonly onSettled?: (settled: SettledMessage) => void;
  /**
   * Une caravane est arrivée sur la case d'une salle dont nous sommes l'hôte.
   * À charge de l'appelant d'émettre `ArriveCaravan` en lockstep (par le
   * Worker) **puis** de confirmer par `deliverCaravan`, ici (§12.7). Le
   * message est réémis tant qu'il n'est pas confirmé : recevoir deux fois la
   * même arrivée est possible, à dédoublonner par `id`.
   *
   * Le serveur l'adresse à l'hôte à la fois sur la connexion de salle (le
   * Worker, qui l'ignore désormais) et sur cette connexion monde (même clé,
   * ou même nom en repli) : c'est elle que le client écoute.
   */
  readonly onCaravanArrive?: (arrival: CaravanArriveMessage) => void;
  /** Refus du serveur. Un message à l'écran, jamais une déconnexion (§11.7). */
  readonly onError?: (error: WorldError) => void;
}

export class WorldClient {
  private readonly transport: Transport;
  private readonly serverUrl: string;
  private readonly expected: WorldInfo;
  private readonly onState: ((state: WorldClientState) => void) | null;
  private readonly onSettled: ((settled: SettledMessage) => void) | null;
  private readonly onCaravanArrive: ((arrival: CaravanArriveMessage) => void) | null;
  private readonly onError: ((error: WorldError) => void) | null;

  private phase: WorldPhase = "connecting";
  private readonly playerName: string;
  private playerId: PlayerId | null = null;
  private playerKey: string | null = null;
  private settlements: readonly Settlement[] = [];
  private players: readonly WorldPlayerInfo[] = Object.freeze([]);
  private caravans: readonly Caravan[] = Object.freeze([]);
  private merchants: readonly Merchant[] = Object.freeze([]);
  private worldInfo: WorldInfo | null = null;
  private lastError: WorldError | null = null;
  /** Jeton et clé connus pour ce serveur, `null` si on n'en a aucun. */
  private identity: StoredIdentity | null = null;
  /** Un seul essai après `bad_token` : le second `world_join` n'a pas de jeton à refuser. */
  private badTokenRetried = false;
  /** Voir `WorldClientState.reconnecting`. */
  private reconnectingFlag = false;
  /** Voir `WorldClientState.attempts`. */
  private attemptsValue = 0;

  constructor(options: WorldClientOptions) {
    this.transport = options.transport;
    this.serverUrl = options.serverUrl;
    this.expected = options.expected;
    this.playerName = options.name;
    this.onState = options.onState ?? null;
    this.onSettled = options.onSettled ?? null;
    this.onCaravanArrive = options.onCaravanArrive ?? null;
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

  /**
   * Résumé sans risque de l'identité stockée, pour le crochet de dev : la clé
   * publique, et la longueur du jeton (jamais sa valeur). `null` si on n'a
   * encore aucune identité pour ce serveur.
   */
  get identitySummary(): IdentitySummary | null {
    if (this.identity === null) return null;
    return { playerKey: this.identity.playerKey, tokenLength: this.identity.token.length };
  }

  /** La colonie posée sur une case, ou `undefined` si la case est libre. */
  settlementAt(tile: number): Settlement | undefined {
    return this.settlements.find((settlement) => settlement.tile === tile);
  }

  /** Une caravane par son identifiant, ou `undefined` si elle est inconnue. */
  caravanById(id: string): Caravan | undefined {
    return this.caravans.find((caravan) => caravan.id === id);
  }

  /** Un marchand itinérant par son identifiant, ou `undefined` si inconnu. */
  merchantById(id: string): Merchant | undefined {
    return this.merchants.find((merchant) => merchant.id === id);
  }

  // --- Actions ---

  /**
   * Premier message de la connexion monde : relit l'identité stockée pour ce
   * serveur et joint son jeton s'il y en a une (`docs/protocol.md` §11.2). Sans
   * jeton connu, le serveur crée un nouveau joueur.
   */
  join(): void {
    this.identity = loadIdentity(identityScope(this.serverUrl, this.playerName));
    this.send({
      type: "world_join",
      name: this.playerName,
      protocol: PROTOCOL_VERSION,
      ...(this.identity !== null ? { token: this.identity.token } : {}),
    });
    this.emit();
  }

  /**
   * Rejoue `world_join` après une coupure (`docs/protocol.md` §11.2, §11.3) :
   * même jeton qu'avant (`this.identity`, jamais perdu — il vit dans
   * `localStorage`, pas dans cette connexion), donc le serveur nous reconnaît
   * comme le même joueur. `world_welcome` qui suit remet `settlements`,
   * `players` et `caravans` à jour tout seul (ce sont des diffusions
   * complètes, pas des deltas, §11.5) : rien d'autre à faire ici.
   *
   * À appeler quand une couche au-dessus détecte qu'un `Transport` neuf est
   * disponible (`ReconnectingTransport.onReconnect`, câblé dans `App.tsx`).
   * Sans `join()` préalable il n'y a pas de nom à rejouer : no-op.
   */
  reconnect(): void {
    if (this.playerName === "") return;
    this.phase = "connecting";
    this.reconnectingFlag = true;
    this.attemptsValue += 1;
    this.send({
      type: "world_join",
      name: this.playerName,
      protocol: PROTOCOL_VERSION,
      ...(this.identity !== null ? { token: this.identity.token } : {}),
    });
    this.emit();
  }

  /**
   * Oublie l'identité stockée pour ce serveur (crochet de dev, pour tester
   * `bad_token` sans éditer `localStorage` à la main). N'affecte que le
   * **prochain** `join()` : la connexion en cours garde son jeton actuel.
   */
  forgetIdentity(): void {
    forgetStoredIdentity(identityScope(this.serverUrl, this.playerName));
    this.identity = null;
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

  /**
   * Expédier un manifeste. L'émetteur doit être **présent dans la salle** de
   * `fromTile` : le serveur le vérifie et refuse par `caravan_not_in_room`
   * sinon (`docs/protocol.md` §12.5). Notre client ouvre deux connexions — le
   * monde ici, la salle dans le Worker — mais le serveur accepte ce message
   * aussi bien depuis la connexion monde d'un joueur présent dans la salle
   * (par sa clé, ou son nom en repli) que depuis la connexion de salle
   * elle-même (§12.3) : `App.tsx` (`CaravanDispatcher`) passe donc par ici,
   * sans détour par le Worker (§12.7).
   */
  sendDepart(departure: CaravanDeparture): void {
    this.send({
      type: "caravan_depart",
      fromTile: departure.fromTile,
      toTile: departure.toTile,
      manifest: departure.manifest,
      summary: departure.summary,
    });
  }

  /** Rappeler une de nos caravanes, tant qu'elle n'a pas fait la moitié du trajet. */
  cancelCaravan(id: string): void {
    this.send({ type: "caravan_cancel", id });
  }

  /**
   * Confirmer l'injection d'une arrivée. À envoyer **après** avoir émis la
   * commande `ArriveCaravan` : tant que le serveur n'a pas ce message, il
   * garde l'arrivée et la réémettra (§12.5). Même remarque que `sendDepart` :
   * accepté ici tant qu'on est l'hôte de la salle d'arrivée (clé, ou nom en
   * repli), sans passer par le Worker.
   */
  deliverCaravan(id: string): void {
    this.send({ type: "caravan_delivered", id });
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
        this.playerKey = message.playerKey;
        this.settlements = Object.freeze([...message.settlements]);
        this.players = Object.freeze([...message.players]);
        this.worldInfo = message.world;
        // `token` n'apparaît qu'à la création d'un nouveau joueur (§11.2) : à
        // conserver tout de suite. Reconnu, on garde le jeton qu'on avait déjà
        // et on se contente d'aligner la clé (elle ne change pas, mais autant
        // ne pas dépendre de l'ordre des champs du serveur).
        if (message.token !== undefined) {
          this.identity = { token: message.token, playerKey: message.playerKey };
          saveIdentity(identityScope(this.serverUrl, this.playerName), this.identity);
        } else if (this.identity !== null) {
          this.identity = { ...this.identity, playerKey: message.playerKey };
        }
        this.phase = "connected";
        // Reconnexion confirmée : le réseau est de retour (rien à faire pour
        // un `world_welcome` ordinaire, `reconnectingFlag` déjà faux).
        this.reconnectingFlag = false;
        this.attemptsValue = 0;
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
      case "world_caravans":
        // Liste complète, comme `world_settlements` : on remplace (§12.4).
        this.caravans = Object.freeze([...message.caravans]);
        // `merchants` est facultatif (§13.4) : absent, on garde la liste
        // précédente plutôt que de la vider — c'est ce qui rend un client
        // compatible avec un serveur qui ne connaît pas encore les marchands.
        // Présent, c'est une liste complète comme les caravanes : on remplace.
        if (message.merchants !== undefined) {
          this.merchants = Object.freeze([...message.merchants]);
        }
        this.emit();
        return;
      case "caravan_arrive":
        // Adressé au seul hôte de la salle d'arrivée. À l'appelant de vérifier
        // qu'il joue bien cette case avant d'injecter quoi que ce soit.
        this.onCaravanArrive?.(message);
        return;
      case "settled":
        this.onSettled?.(message);
        return;
      case "world_error":
        if (message.code === "bad_token" && !this.badTokenRetried) {
          // Le jeton stocké ne correspond à aucun joueur connu (§11.2) : on
          // l'oublie et on redevient un nouveau joueur. Un seul essai — le
          // second `world_join` ne porte aucun jeton, il ne peut donc pas être
          // refusé pour la même raison.
          this.badTokenRetried = true;
          this.forgetIdentity();
          this.fail("bad_token", "Identité inconnue de ce serveur : nouvelle identité créée");
          this.phase = "connecting";
          this.send({ type: "world_join", name: this.playerName, protocol: PROTOCOL_VERSION });
          this.emit();
          return;
        }
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
      playerKey: this.playerKey,
      name: this.playerName,
      settlements: this.settlements,
      players: this.players,
      caravans: this.caravans,
      merchants: this.merchants,
      world: this.worldInfo,
      lastError: this.lastError,
      token: this.identity?.token ?? null,
      reconnecting: this.reconnectingFlag,
      attempts: this.attemptsValue,
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
