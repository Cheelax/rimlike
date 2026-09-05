/**
 * Les caravanes du monde : qui voyage, sur quel itinéraire, et où elle en est.
 *
 * `CaravanRegistry` est **pure** — pas de réseau, pas de disque, pas de timer.
 * Elle ne connaît le temps que par la fonction `hours()` qu'on lui injecte, qui
 * rend les **heures de jeu** écoulées depuis la création du monde (voir
 * `WorldClock` dans `world.ts`). Toute la progression en découle : rien n'est
 * incrémenté à chaque tick, tout est dérivé de `departedAt`, `arrivesAt` et de
 * l'heure courante. Un serveur qui redémarre reprend donc exactement où il en
 * était, sans rattrapage ni dérive.
 *
 * Le **manifeste** est une suite d'octets postcard produite par le sim
 * (colons et marchandises du convoi). Le serveur ne la décode jamais, pas plus
 * que les commandes de lockstep : il la transporte de la case de départ à la
 * case d'arrivée, où l'hôte l'injectera dans sa carte. C'est aussi pourquoi le
 * `summary` d'affichage vient du client : le serveur ne peut pas le déduire.
 *
 * Les **arrivées en attente** ne sont pas un second état : ce sont exactement
 * les caravanes de statut `arrived`, celles dont l'hôte de la case d'arrivée
 * n'a pas encore confirmé l'injection (`pendingArrivals`). Une seule source de
 * vérité, donc rien à resynchroniser entre deux structures, et le manifeste est
 * persisté avec la caravane qui le porte.
 *
 * Voir `docs/protocol.md` §12 pour le cycle de vie complet.
 */

import {
  CARAVAN_HISTORY_HOURS,
  base64ToBytes,
  bytesToBase64,
  type Caravan,
  type CaravanStatus,
  type CaravanSummary,
} from "@rimlike/protocol";
import { findRoute, type World } from "@rimlike/world";

/** Ce qu'il faut pour expédier une caravane. */
export interface CaravanDepartRequest {
  /** Clé du joueur expéditeur (`WorldPlayer.key`), pas un nom. */
  readonly owner: string;
  readonly fromTile: number;
  readonly toTile: number;
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
}

export type DepartResult =
  | { readonly ok: true; readonly caravan: Caravan }
  | { readonly ok: false; readonly code: "bad_tile" | "caravan_same_tile" | "caravan_no_route" };

export type CancelResult =
  | { readonly ok: true; readonly caravan: Caravan }
  | {
      readonly ok: false;
      readonly code: "caravan_not_found" | "not_owner" | "caravan_too_late" | "caravan_no_route";
    };

/**
 * Une arrivée à livrer : exactement la charge d'un `caravan_arrive`. Le
 * registre la rend tant que l'hôte n'a pas répondu `caravan_delivered`.
 */
export interface CaravanArrival {
  readonly id: string;
  readonly tile: number;
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
}

/** Ce que fait avancer un tick de monde. */
export interface AdvanceResult {
  /** Les caravanes qui viennent de passer en `arrived`, dans l'ordre de départ. */
  readonly arrived: readonly Caravan[];
  /** Vrai si quoi que ce soit a changé (arrivée ou expiration d'une livrée). */
  readonly changed: boolean;
}

/** Forme JSON d'une caravane. Le manifeste y passe en base64. */
export interface CaravanJson {
  readonly id: string;
  readonly owner: string;
  readonly fromTile: number;
  readonly toTile: number;
  readonly route: readonly number[];
  readonly departedAt: number;
  readonly arrivesAt: number;
  readonly status: CaravanStatus;
  /** Heure de jeu de la livraison, `null` tant qu'elle n'a pas eu lieu. */
  readonly deliveredAt: number | null;
  readonly manifest: string;
  readonly summary: CaravanSummary;
}

export interface CaravanRegistryJson {
  /** Prochain numéro d'identifiant : les identifiants ne se réutilisent pas. */
  readonly nextId: number;
  readonly caravans: readonly CaravanJson[];
}

export interface CaravanRegistryOptions {
  readonly world: World;
  /** Heures de jeu écoulées depuis la création du monde. */
  readonly hours: () => number;
  /** Durée de visibilité d'une caravane livrée. Défaut : `CARAVAN_HISTORY_HOURS`. */
  readonly historyHours?: number;
  /**
   * Résout la clé d'un propriétaire (`owner`) en nom d'affichage, pour
   * `Caravan.ownerName` (`docs/protocol.md` §11.2). Défaut : l'identité —
   * pratique pour les tests qui n'ont pas de table de joueurs et traitent
   * `owner` comme son propre libellé.
   */
  readonly ownerName?: (key: string) => string;
}

/** État interne, mutable : la vue diffusée est recalculée à la demande. */
interface StoredCaravan {
  readonly id: string;
  readonly owner: string;
  fromTile: number;
  toTile: number;
  route: number[];
  departedAt: number;
  arrivesAt: number;
  status: CaravanStatus;
  deliveredAt: number | null;
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
}

export class CaravanRegistry {
  private readonly world: World;
  private readonly hours: () => number;
  private readonly historyHours: number;
  private readonly ownerName: (key: string) => string;
  /** Caravanes par identifiant, dans leur ordre de création (`Map` ordonnée). */
  private readonly caravans = new Map<string, StoredCaravan>();
  private nextId = 1;

  constructor(options: CaravanRegistryOptions) {
    this.world = options.world;
    this.hours = options.hours;
    this.historyHours = options.historyHours ?? CARAVAN_HISTORY_HOURS;
    this.ownerName = options.ownerName ?? ((key) => key);
  }

  get count(): number {
    return this.caravans.size;
  }

  /** Vrai si au moins une caravane est en mouvement (donc son avancement change). */
  get hasMoving(): boolean {
    for (const stored of this.caravans.values()) {
      if (stored.status === "travelling" || stored.status === "returning") {
        return true;
      }
    }
    return false;
  }

  /** Toutes les caravanes connues, dans l'ordre de départ. */
  list(): Caravan[] {
    const now = this.hours();
    return [...this.caravans.values()].map((stored) => this.view(stored, now));
  }

  get(id: string): Caravan | undefined {
    const stored = this.caravans.get(id);
    return stored === undefined ? undefined : this.view(stored, this.hours());
  }

  /**
   * Expédie une caravane. L'itinéraire est celui du globe (`findRoute`), donc
   * la durée aussi : `arrivesAt = maintenant + route.hours`. Un océan sur le
   * chemin rend `null` et le départ est refusé — pas de bateaux en v1.
   */
  depart(request: CaravanDepartRequest): DepartResult {
    const { fromTile, toTile } = request;
    if (!this.hasTile(fromTile) || !this.hasTile(toTile)) {
      return { ok: false, code: "bad_tile" };
    }
    if (fromTile === toTile) {
      return { ok: false, code: "caravan_same_tile" };
    }
    const route = findRoute(this.world, fromTile, toTile);
    if (route === null) {
      return { ok: false, code: "caravan_no_route" };
    }
    const now = this.hours();
    const stored: StoredCaravan = {
      id: `c${this.nextId++}`,
      owner: request.owner,
      fromTile,
      toTile,
      route: route.tiles,
      departedAt: now,
      arrivesAt: now + route.hours,
      status: "travelling",
      deliveredAt: null,
      manifest: request.manifest,
      summary: request.summary,
    };
    this.caravans.set(stored.id, stored);
    return { ok: true, caravan: this.view(stored, now) };
  }

  /**
   * Demi-tour. Refusé au-delà de la moitié du trajet : passé ce point la
   * caravane est plus près de sa destination que de chez elle, la faire
   * revenir coûterait plus cher que d'arriver.
   *
   * La caravane repart de sa **position courante** vers sa case d'origine, sur
   * un itinéraire recalculé (le coût d'entrée dans une case n'est pas
   * symétrique : reprendre le chemin à l'envers ne donnerait pas la bonne
   * durée). `fromTile` devient donc la case du demi-tour et `toTile` la case
   * d'origine — la caravane n'a plus qu'une destination : rentrer.
   */
  cancel(id: string, owner: string): CancelResult {
    const stored = this.caravans.get(id);
    if (stored === undefined) {
      return { ok: false, code: "caravan_not_found" };
    }
    if (stored.owner !== owner) {
      return { ok: false, code: "not_owner" };
    }
    if (stored.status !== "travelling") {
      return { ok: false, code: "caravan_too_late" };
    }
    const now = this.hours();
    const view = this.view(stored, now);
    if (view.progress >= 0.5) {
      return { ok: false, code: "caravan_too_late" };
    }
    const back = findRoute(this.world, view.currentTile, stored.fromTile);
    if (back === null) {
      // Impossible en pratique : on vient de passer par là.
      return { ok: false, code: "caravan_no_route" };
    }
    stored.toTile = stored.fromTile;
    stored.fromTile = view.currentTile;
    stored.route = back.tiles;
    stored.departedAt = now;
    stored.arrivesAt = now + back.hours;
    stored.status = "returning";
    return { ok: true, caravan: this.view(stored, now) };
  }

  /**
   * Fait avancer les statuts : ce qui devait arriver arrive, ce qui a été
   * livré il y a plus de `historyHours` disparaît de la liste. C'est la seule
   * méthode qui mute le temps ; le reste est dérivé.
   */
  advance(): AdvanceResult {
    const now = this.hours();
    const arrived: Caravan[] = [];
    let changed = false;
    for (const stored of this.caravans.values()) {
      if ((stored.status === "travelling" || stored.status === "returning") && now >= stored.arrivesAt) {
        stored.status = "arrived";
        arrived.push(this.view(stored, now));
        changed = true;
      }
    }
    for (const [id, stored] of [...this.caravans]) {
      if (stored.status === "delivered" && stored.deliveredAt !== null && now - stored.deliveredAt >= this.historyHours) {
        this.caravans.delete(id);
        changed = true;
      }
    }
    return { arrived, changed };
  }

  /**
   * Les arrivées d'une case qui attendent encore leur hôte. C'est ce que le
   * serveur réémet quand l'hôte change ou quand la salle rouvre : tant que la
   * confirmation n'est pas venue, l'arrivée est toujours là.
   */
  pendingArrivals(tile: number): CaravanArrival[] {
    const arrivals: CaravanArrival[] = [];
    for (const stored of this.caravans.values()) {
      if (stored.status === "arrived" && stored.toTile === tile) {
        arrivals.push({ id: stored.id, tile, manifest: stored.manifest, summary: stored.summary });
      }
    }
    return arrivals;
  }

  /** L'arrivée d'une caravane donnée, si elle est bien en attente de livraison. */
  arrivalOf(id: string): CaravanArrival | undefined {
    const stored = this.caravans.get(id);
    if (stored === undefined || stored.status !== "arrived") {
      return undefined;
    }
    return { id: stored.id, tile: stored.toTile, manifest: stored.manifest, summary: stored.summary };
  }

  /** L'hôte a injecté le convoi dans sa carte. Faux si l'état ne s'y prête pas. */
  markDelivered(id: string): boolean {
    const stored = this.caravans.get(id);
    if (stored === undefined || stored.status !== "arrived") {
      return false;
    }
    stored.status = "delivered";
    stored.deliveredAt = this.hours();
    return true;
  }

  /** État complet, manifestes compris : c'est ce que `WorldState` fait écrire. */
  toJSON(): CaravanRegistryJson {
    return {
      nextId: this.nextId,
      caravans: [...this.caravans.values()].map((stored) => ({
        id: stored.id,
        owner: stored.owner,
        fromTile: stored.fromTile,
        toTile: stored.toTile,
        route: [...stored.route],
        departedAt: stored.departedAt,
        arrivesAt: stored.arrivesAt,
        status: stored.status,
        deliveredAt: stored.deliveredAt,
        manifest: bytesToBase64(stored.manifest),
        summary: stored.summary,
      })),
    };
  }

  /**
   * Remplace le contenu par celui d'une sauvegarde. Les heures relues sont des
   * heures de **jeu** : elles restent valables tant que l'horloge du monde
   * reprend son compte là où elle s'était arrêtée (`WorldClock`), ce qui est
   * précisément ce que la persistance garantit.
   */
  restore(json: CaravanRegistryJson): void {
    this.caravans.clear();
    for (const entry of json.caravans) {
      const manifest = base64ToBytes(entry.manifest);
      if (manifest === null) {
        throw new Error(`manifeste illisible pour la caravane ${entry.id}`);
      }
      if (!this.hasTile(entry.fromTile) || !this.hasTile(entry.toTile)) {
        throw new Error(`caravane ${entry.id} sur une case inexistante`);
      }
      this.caravans.set(entry.id, {
        id: entry.id,
        owner: entry.owner,
        fromTile: entry.fromTile,
        toTile: entry.toTile,
        route: [...entry.route],
        departedAt: entry.departedAt,
        arrivesAt: entry.arrivesAt,
        status: entry.status,
        deliveredAt: entry.deliveredAt,
        manifest,
        summary: entry.summary,
      });
    }
    this.nextId = Math.max(json.nextId, this.caravans.size + 1);
  }

  // --- Interne ---

  private hasTile(tileId: number): boolean {
    return Number.isInteger(tileId) && tileId >= 0 && tileId < this.world.tiles.length;
  }

  /**
   * Vue diffusable : `progress` et `currentTile` sont dérivés du temps, jamais
   * stockés. L'interpolation est linéaire sur la durée totale du trajet — la
   * caravane ne s'arrête pas case par case, elle avance à vitesse constante sur
   * un itinéraire dont le coût, lui, tient compte des biomes traversés.
   */
  private view(stored: StoredCaravan, now: number): Caravan {
    const total = stored.arrivesAt - stored.departedAt;
    const done = stored.status === "arrived" || stored.status === "delivered";
    const raw = done || total <= 0 ? 1 : (now - stored.departedAt) / total;
    const progress = Math.min(1, Math.max(0, raw));
    const steps = stored.route.length - 1;
    const index = Math.min(steps, Math.max(0, Math.floor(progress * steps)));
    return {
      id: stored.id,
      owner: stored.owner,
      ownerName: this.ownerName(stored.owner),
      fromTile: stored.fromTile,
      toTile: stored.toTile,
      route: [...stored.route],
      departedAt: stored.departedAt,
      arrivesAt: stored.arrivesAt,
      progress,
      currentTile: stored.route[index]!,
      summary: stored.summary,
      status: stored.status,
    };
  }
}
