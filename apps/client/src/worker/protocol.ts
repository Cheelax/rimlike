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

import type { LockstepState } from "../net/LockstepClient";

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
      /** Dose de menace choisie à l'accueil (`render/terrain.ts::DIFFICULTY`). */
      readonly difficulty: number;
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
  /**
   * Réservé à l'hôte, en lobby. `difficulty` (`render/terrain.ts::DIFFICULTY`)
   * n'est jamais envoyée au serveur (`packages/protocol` l'ignore) : elle ne
   * quitte pas ce client, qui l'émettra lui-même en première commande une
   * fois son propre sim adopté (voir `worker/startDifficulty.ts`).
   */
  | {
      readonly type: "startGame";
      readonly seed: number;
      readonly width: number;
      readonly height: number;
      readonly difficulty?: number;
    }
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
 * Couche « intérieur » (`sim-wasm::indoor_ptr`, un octet par case : 0 dehors,
 * sinon le numéro de la pièce). Émis seulement quand `indoorVersion` change,
 * comme `overlays` pour `overlayVersion` : c'est un calque à part, pas une
 * zone ou une désignation, et il change à un rythme différent (posé un mur,
 * pas dessiné une zone).
 */
export interface IndoorMessage {
  readonly type: "indoor";
  readonly indoorVersion: number;
  readonly indoor: Uint8Array;
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
  /** Température extérieure, en **dixièmes de degré** (`sim::outdoor_temperature`). */
  readonly temperature: number;
  /** Saison courante, suivant `sim::climate::Season` (0 printemps … 3 hiver). */
  readonly season: number;
  /** Jour de l'année courant, dans `0..yearDays`. */
  readonly dayOfYear: number;
  /** Jours d'une année de jeu (quatre saisons), constant (`sim::climate::YEAR_DAYS`). */
  readonly yearDays: number;
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
  /** Faune vivante : `[id, espèce, chassée]` par bête (`sim-wasm::ANIMAL_STRIDE`). */
  readonly animals: Int32Array;
  /**
   * Nom de chaque pawn vivant, par id. Recalculé seulement quand la liste des
   * ids change (voir `SimRunner`) : pas un appel à `pawn_name` par frame.
   */
  readonly names: Record<number, string>;
  readonly stored: Uint32Array;
  /** Objectifs de fabrication courants, indexés par `ItemKind` (9 entrées, `sim-wasm::craft_targets`). */
  readonly craftTargets: Uint32Array;
  /**
   * Arme équipée de chaque pawn armé, aplatie : `[id, genre]×n` (`sim::ItemKind`
   * 6 gourdin, 7 épieu, 8 arc). Absent des mains nues. Recalculé chaque frame
   * depuis le tampon `pawns` (`SimHandle.weapons`) : petit, pas besoin de RPC.
   */
  readonly weapons: Int32Array;
  /**
   * Habit de chaque pawn habillé, aplatie : `[id, genre]×n` (`sim::ItemKind`
   * 14 tunique, 15 manteau). Absent sur le dos nu. Recalculé chaque frame
   * depuis le tampon `pawns` (`SimHandle.apparel`), même limite que `weapons`.
   */
  readonly apparel: Int32Array;
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
  /** Dose de menace courante, suivant `render/terrain.ts::DIFFICULTY`. */
  readonly difficulty: number;
  /** Richesse de la colonie (`sim-wasm::wealth`), pour le HUD stock. */
  readonly wealth: number;
}

export type WorkerToMain =
  | MapMessage
  | OverlaysMessage
  | IndoorMessage
  | FrameMessage
  /** À chaque changement d'état du `LockstepClient` (lobby, joueurs, désync…). */
  | { readonly type: "net"; readonly state: LockstepState }
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
    case "indoor":
      return [message.indoor.buffer as ArrayBuffer];
    case "frame":
      return [
        message.pawns.buffer as ArrayBuffer,
        message.items.buffer as ArrayBuffer,
        message.blueprints.buffer as ArrayBuffer,
        message.events.buffer as ArrayBuffer,
        message.priorities.buffer as ArrayBuffer,
        message.skills.buffer as ArrayBuffer,
        message.health.buffer as ArrayBuffer,
        message.animals.buffer as ArrayBuffer,
        message.stored.buffer as ArrayBuffer,
        message.craftTargets.buffer as ArrayBuffer,
        message.weapons.buffer as ArrayBuffer,
        message.apparel.buffer as ArrayBuffer,
      ];
    case "saved":
      return [message.bytes.buffer as ArrayBuffer];
    default:
      // `net`, `loaded`, `error`, `debugResult` : rien de gros à transférer.
      // Un `debugResult` porte des copies, clonées comme n'importe quelle valeur.
      return [];
  }
}
