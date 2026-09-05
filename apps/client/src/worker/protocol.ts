/**
 * Protocole entre le thread principal (React + Three) et le Worker de
 * simulation. Types discriminés par `type` : chaque message est complet à lui
 * seul, il n'y a aucun état partagé entre les deux côtés.
 *
 * Pourquoi un Worker : la boucle de jeu tournait dans `requestAnimationFrame`,
 * que le navigateur bride à ~1/s sur un onglet masqué. En solo le temps se
 * figeait, en multi le client décrochait du lockstep. Les timers d'un Worker
 * dédié continuent de tourner, onglet visible ou non.
 *
 * Règle de partage : le Worker possède le sim (donc le WASM) et, en multi, le
 * `LockstepClient` et sa WebSocket. Le thread principal ne possède que le
 * rendu et l'UI. Tous les tampons envoyés sont des **copies** (les vues
 * zéro-copie sur la mémoire WASM ne survivraient pas au transfert) et leurs
 * `ArrayBuffer` sont transférés, jamais clonés.
 */

import type { CaravanArriveMessage } from "@rimlike/protocol";
import type { LockstepState, RoomCaravanDeparture } from "../net/LockstepClient";

/** Un `frame` sur `HASH_EVERY_FRAMES` porte le hash : il coûte une sérialisation complète. */
export const HASH_EVERY_FRAMES = 30;

// --- Thread principal → Worker ---

/**
 * Premier message, une seule fois par Worker. En solo le sim est créé tout de
 * suite ; en multi le Worker se connecte et attend le démarrage de la salle.
 */
export type InitMessage =
  | {
      readonly type: "init";
      readonly mode: "solo";
      readonly seed: number;
      readonly width: number;
      readonly height: number;
    }
  | {
      readonly type: "init";
      readonly mode: "multi";
      readonly server: string;
      readonly room: string;
      readonly name: string;
    };

export type MainToWorker =
  | InitMessage
  /** Commande encodée (voir `sim/commands.ts`). Seul chemin des actions du joueur. */
  | { readonly type: "issue"; readonly bytes: Uint8Array }
  | { readonly type: "setPaused"; readonly paused: boolean }
  | { readonly type: "setSpeed"; readonly speed: number }
  /** Réservé à l'hôte, en lobby. */
  | { readonly type: "startGame"; readonly seed: number; readonly width: number; readonly height: number }
  /**
   * Expédie un manifeste de caravane. Il part par la connexion **de salle**,
   * qui vit ici : le serveur exige que l'auteur d'un `caravan_depart` soit
   * dans la salle de `fromTile` (`docs/protocol.md` §12.5), et la connexion
   * monde du thread principal n'y est pas.
   */
  | { readonly type: "caravanDepart"; readonly departure: RoomCaravanDeparture }
  /** Confirme une arrivée injectée, sur la même connexion, pour la même raison. */
  | { readonly type: "caravanDelivered"; readonly id: string }
  /** Demande un snapshot : `localStorage` n'existe pas dans un Worker. */
  | { readonly type: "save" }
  | { readonly type: "load"; readonly bytes: Uint8Array }
  /** Crochet de dev : appelle une méthode du sim ou du lockstep. Voir `sim.worker.ts`. */
  | { readonly type: "debug"; readonly id: number; readonly method: string; readonly args: readonly unknown[] };

// --- Worker → thread principal ---

/** Sol et éléments. Émis seulement quand `mapVersion` change. */
export interface MapMessage {
  readonly type: "map";
  readonly width: number;
  readonly height: number;
  readonly mapVersion: number;
  readonly tiles: Uint8Array;
  readonly features: Uint8Array;
}

/** Zones et désignations. Émis seulement quand `overlayVersion` change. */
export interface OverlaysMessage {
  readonly type: "overlays";
  readonly overlayVersion: number;
  readonly zones: Uint8Array;
  readonly designations: Uint8Array;
}

/**
 * État à afficher, après un lot de ticks. Au plus un par intervalle du Worker,
 * et jamais si aucun tick n'a été exécuté — sauf le premier, juste après
 * l'adoption d'un sim, pour que l'écran ne reste pas vide en pause.
 */
export interface FrameMessage {
  readonly type: "frame";
  readonly tick: number;
  readonly timeOfDay: number;
  readonly ticksPerDay: number;
  readonly weather: number;
  /** `null` sauf un `frame` sur `HASH_EVERY_FRAMES`. */
  readonly hash: string | null;
  readonly pawns: Int32Array;
  readonly items: Int32Array;
  readonly blueprints: Int32Array;
  readonly events: Int32Array;
  readonly priorities: Int32Array;
  /** Compétences : `[id, (niveau, xp)×6]` par colon (`sim-wasm::SKILL_STRIDE`). */
  readonly skills: Int32Array;
  /** Santé : `[id, sang, conscience %, blessures]` par pawn (`sim-wasm::HEALTH_STRIDE`). */
  readonly health: Int32Array;
  /**
   * Nom de chaque pawn vivant, par id. Recalculé seulement quand la liste des
   * ids change (voir `SimRunner`) : pas un appel à `pawn_name` par frame.
   */
  readonly names: Record<number, string>;
  readonly stored: Uint32Array;
  /**
   * Manifestes de caravane en attente d'expédition (`Sim::departures`). C'est
   * le déclencheur de l'hôte : tant qu'il est non nul, il reste des départs à
   * envoyer au serveur monde puis à retirer de la file (`docs/protocol.md`
   * §12.7). Le manifeste lui-même se lit par `rpc("departure", i)` : il n'a
   * rien à faire dans un `frame` émis soixante fois par seconde.
   */
  readonly departures: number;
  /** Retard du lockstep en ticks. Toujours 0 en solo. */
  readonly lag: number;
  /** Ticks par seconde mesurés dans le Worker. */
  readonly tps: number;
}

export type WorkerToMain =
  | MapMessage
  | OverlaysMessage
  | FrameMessage
  /** À chaque changement d'état du `LockstepClient` (lobby, joueurs, désync…). */
  | { readonly type: "net"; readonly state: LockstepState }
  /**
   * Une caravane est arrivée sur la case de notre salle et nous en sommes
   * l'hôte. Le thread principal émet `ArriveCaravan` puis renvoie un
   * `caravanDelivered` : c'est lui qui possède le WASM d'encodage.
   */
  | { readonly type: "caravanArrive"; readonly arrival: CaravanArriveMessage }
  | { readonly type: "saved"; readonly bytes: Uint8Array }
  /** Fin d'un `load`. `error` non vide si la sauvegarde était illisible. */
  | { readonly type: "loaded"; readonly error?: string }
  | { readonly type: "error"; readonly message: string }
  /** Réponse à un `debug`. `error` non vide si l'appel a échoué. */
  | { readonly type: "debugResult"; readonly id: number; readonly value: unknown; readonly error?: string };

/**
 * `ArrayBuffer` à transférer avec un message, dans l'ordre des champs.
 *
 * Le transfert évite une copie de plus (les tampons sont déjà des copies
 * fraîches côté Worker) : après `postMessage` ils sont détachés côté Worker,
 * ce qui est sans conséquence puisqu'ils sont rebâtis à chaque frame.
 */
export function transferablesOf(message: WorkerToMain): ArrayBuffer[] {
  switch (message.type) {
    case "map":
      return [message.tiles.buffer as ArrayBuffer, message.features.buffer as ArrayBuffer];
    case "overlays":
      return [message.zones.buffer as ArrayBuffer, message.designations.buffer as ArrayBuffer];
    case "frame":
      return [
        message.pawns.buffer as ArrayBuffer,
        message.items.buffer as ArrayBuffer,
        message.blueprints.buffer as ArrayBuffer,
        message.events.buffer as ArrayBuffer,
        message.priorities.buffer as ArrayBuffer,
        message.skills.buffer as ArrayBuffer,
        message.health.buffer as ArrayBuffer,
        message.stored.buffer as ArrayBuffer,
      ];
    case "saved":
      return [message.bytes.buffer as ArrayBuffer];
    default:
      // `net`, `caravanArrive`, `loaded`, `error`, `debugResult` : rien de gros
      // à transférer (un manifeste pèse quelques centaines d'octets).
      // Un `debugResult` porte des copies, clonées comme n'importe quelle valeur.
      return [];
  }
}
