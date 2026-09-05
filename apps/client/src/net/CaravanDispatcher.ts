/**
 * L'expédition des caravanes, côté hôte de la case de départ.
 *
 * Le sim produit un **manifeste** par caravane formée et l'empile dans sa file
 * de départs (`Sim::departures`, partie de l'état lockstep). Le client hôte
 * lit cette file, envoie chaque manifeste au serveur monde
 * (`caravan_depart`), puis **vide la file par une commande** —
 * `ClearDepartures`, appliquée au même tick chez tout le monde. Lire est
 * local, vider ne l'est pas : c'est le point à ne pas rater de
 * `docs/protocol.md` §12.7.
 *
 * Ce module est pur : ni DOM, ni WASM, ni WebSocket. Tout ce qui touche au
 * monde extérieur est injecté (`readDeparture`, `describe`, `sendDepart`,
 * `issue`, `encodeClear`), ce qui le rend testable sous Node
 * (`test/caravan-dispatcher.test.ts`).
 *
 * ## La destination n'est pas dans le manifeste
 *
 * `Command::FormCaravan` ne porte pas la case d'arrivée : le voyage appartient
 * au serveur monde, le sim ne connaît que les deux bouts. Le client garde donc
 * une **file FIFO de destinations** entre le moment où il émet `FormCaravan`
 * et celui où le départ ressort du sim (un aller-retour de bundle plus tard).
 *
 * Limite assumée : un manifeste qui ressort sans destination connue — l'hôte a
 * changé entre les deux, ou c'est un invité qui a formé la caravane — **reste
 * dans la file du sim**. On ne l'expédie pas vers sa propre case d'origine :
 * le serveur refuse (`caravan_same_tile`) et le convoi serait perdu pour de
 * bon, colons compris. On ne le jette pas non plus. Il attend, `waiting` le
 * signale à l'interface, et lui donner une destination (le panneau Caravane
 * le propose) suffit à le faire partir.
 */

import type { CaravanSummary } from "@rimlike/protocol";

/** Un manifeste sorti de la file du sim, prêt à partir sur le fil du monde. */
export interface DispatchedDeparture {
  readonly toTile: number;
  /** Octets postcard du sim, opaques pour le serveur. */
  readonly manifest: Uint8Array;
  readonly summary: CaravanSummary;
}

/** Le monde extérieur, réduit à cinq fonctions. */
export interface CaravanDispatcherOptions {
  /** Manifeste à cet indice de la file du sim (vide si l'indice est dépassé). */
  readonly readDeparture: (index: number) => Promise<Uint8Array>;
  /** Résumé d'affichage d'un manifeste (`SimHandle.describeManifest`). */
  readonly describe: (manifest: Uint8Array) => CaravanSummary;
  /** Émission de `caravan_depart` sur la connexion monde. */
  readonly sendDepart: (departure: DispatchedDeparture) => void;
  /** Seul chemin des commandes : en multi elles reviennent dans un bundle. */
  readonly issue: (bytes: Uint8Array) => void;
  readonly encodeClear: (count: number) => Uint8Array;
  /** Nombre de manifestes en attente de destination, à chaque changement. */
  readonly onWaiting?: (count: number) => void;
}

/**
 * Case d'une salle « case », ou `null` si le nom n'en désigne pas une.
 *
 * Même lecture stricte que le serveur (`apps/server/src/world.ts`) : un
 * identifiant n'a qu'une écriture, `tile-007` n'est pas `tile-7`.
 */
export function tileOfRoom(room: string): number | null {
  const match = /^tile-(0|[1-9][0-9]*)$/.exec(room);
  return match === null ? null : Number(match[1]);
}

/**
 * Résumé d'affichage depuis le tampon de `describe_manifest` :
 * `[nb colons, nb genres, genre0, quantité0, …]`. Un tampon vide (manifeste
 * illisible) donne une caravane vide plutôt qu'une exception : ces octets
 * viennent du réseau.
 */
export function manifestSummary(described: ArrayLike<number>): CaravanSummary {
  if (described.length < 2) {
    return { pawns: 0, items: [] };
  }
  const kinds = described[1];
  const items: [number, number][] = [];
  for (let i = 0; i < kinds && 2 + i * 2 + 1 < described.length; i += 1) {
    items.push([described[2 + i * 2], described[2 + i * 2 + 1]]);
  }
  return { pawns: described[0], items };
}

/** Clé d'identité d'un manifeste : ses octets. Sert à reconnaître un doublon. */
function keyOf(bytes: Uint8Array): string {
  return bytes.join(",");
}

/** Une destination en attente d'un manifeste, avec de quoi prévenir l'appelant. */
interface PlannedDestination {
  readonly toTile: number;
  readonly onDispatched?: (departure: DispatchedDeparture) => void;
}

export class CaravanDispatcher {
  /** Destinations choisies, dans l'ordre des `FormCaravan` émis. */
  private readonly destinations: PlannedDestination[] = [];
  /** Clés des manifestes déjà expédiés et pas encore retirés de la file. */
  private dispatched = new Set<string>();
  /**
   * Clé de la tête de file au moment du dernier `ClearDepartures` émis, ou
   * `null` si aucun n'est en vol. La file étant une FIFO vidée par le début,
   * une tête qui change veut dire que le vidage a été appliqué — c'est ce qui
   * empêche d'en émettre un second, qui retirerait des manifestes jamais
   * expédiés.
   */
  private clearHead: string | null = null;
  private waitingCount = 0;
  private busy = false;

  constructor(private readonly options: CaravanDispatcherOptions) {}

  /** Destinations choisies mais dont le `FormCaravan` n'est pas encore revenu. */
  get pendingDestinations(): number {
    return this.destinations.length;
  }

  /** Manifestes sortis du sim dont on ne connaît pas la destination. */
  get waiting(): number {
    return this.waitingCount;
  }

  /**
   * Note où ira la prochaine caravane formée. À appeler **avant** d'émettre
   * `FormCaravan` : l'ordre des destinations est celui des commandes, le
   * serveur garantissant l'ordre d'application (`docs/protocol.md` §5).
   */
  planDestination(toTile: number, onDispatched?: (departure: DispatchedDeparture) => void): void {
    this.destinations.push({ toTile, onDispatched });
  }

  /** Oublie les destinations choisies (fermeture du panneau, changement de salle). */
  forgetDestinations(): void {
    this.destinations.length = 0;
  }

  /**
   * Vide ce qu'il y a à vider, d'après le compte de départs du dernier `frame`.
   * Idempotent : appelée à chaque frame, elle ne réexpédie jamais un manifeste
   * déjà parti et n'émet qu'un `ClearDepartures` à la fois.
   *
   * Réentrante par nature (les lectures de manifeste sont des RPC vers le
   * Worker) : un appel pendant qu'un autre tourne ne fait rien.
   */
  async pump(departures: number): Promise<void> {
    if (this.busy) return;
    if (departures <= 0) {
      // File vide : plus rien à reconnaître, plus rien en vol.
      this.dispatched.clear();
      this.clearHead = null;
      this.setWaiting(0);
      return;
    }
    this.busy = true;
    try {
      const manifests: Uint8Array[] = [];
      const keys: string[] = [];
      for (let i = 0; i < departures; i += 1) {
        const bytes = await this.options.readDeparture(i);
        // Un tampon vide veut dire « indice hors file » : le sim a avancé
        // depuis le `frame`, on s'en tient à ce qu'il reste.
        if (bytes.length === 0) break;
        manifests.push(bytes);
        keys.push(keyOf(bytes));
      }
      if (manifests.length === 0) return;

      if (this.clearHead !== null && keys[0] !== this.clearHead) {
        this.clearHead = null;
      }

      let waiting = 0;
      for (let i = 0; i < manifests.length; i += 1) {
        if (this.dispatched.has(keys[i])) continue;
        const planned = this.destinations.shift();
        if (planned === undefined) {
          // Sans destination on s'arrête là : les manifestes suivants sont
          // derrière celui-ci dans la file, ils attendront avec lui.
          waiting = manifests.length - i;
          break;
        }
        const departure: DispatchedDeparture = {
          toTile: planned.toTile,
          manifest: manifests[i],
          summary: this.options.describe(manifests[i]),
        };
        this.options.sendDepart(departure);
        this.dispatched.add(keys[i]);
        planned.onDispatched?.(departure);
      }
      this.setWaiting(waiting);

      if (this.clearHead === null) {
        // On ne retire qu'un **préfixe** expédié : `ClearDepartures` enlève
        // par le début, un manifeste en attente bloque ceux d'après.
        let count = 0;
        while (count < keys.length && this.dispatched.has(keys[count])) count += 1;
        if (count > 0) {
          this.options.issue(this.options.encodeClear(count));
          this.clearHead = keys[0];
        }
      }

      // Mémoire bornée : on ne retient que les clés encore en file.
      const present = new Set(keys);
      for (const key of [...this.dispatched]) {
        if (!present.has(key)) this.dispatched.delete(key);
      }
    } finally {
      this.busy = false;
    }
  }

  private setWaiting(count: number): void {
    if (count === this.waitingCount) return;
    this.waitingCount = count;
    this.options.onWaiting?.(count);
  }
}
