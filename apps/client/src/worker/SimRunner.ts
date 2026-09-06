/**
 * La cadence du jeu, sans timer et sans `postMessage` : une classe pure que
 * l'on pilote en l'appelant, et qui répond ce qui a changé.
 *
 * C'est l'ancienne boucle de `App.tsx` extraite du `requestAnimationFrame` :
 * `sim.worker.ts` ne fait plus que la brancher sur un `setInterval`, sur le
 * WASM, sur le transport et sur `postMessage`. Tout est ici pour que ce soit
 * testable sous Node avec un sim factice (voir `test/simrunner.test.ts`).
 *
 * Deux cadences, un seul appelant :
 * - **solo** : accumulateur en millisecondes, pas fixe de 60 ticks/s multiplié
 *   par la vitesse, rattrapage borné, accumulateur gelé en pause ;
 * - **multi** : aucune horloge locale, l'horloge est celle des bundles du
 *   serveur. `advance` ne fait que `pump` avec un budget borné.
 */

import type { SimLike } from "../net/SimLike";
import {
  HASH_EVERY_FRAMES,
  type FireMessage,
  type FrameMessage,
  type IndoorMessage,
  type MapMessage,
  type OverlaysMessage,
} from "./protocol";

/** Entiers par pawn dans le tampon `pawns()` ; seul l'id (offset 0) sert ici. */
const PAWN_STRIDE = 12;
/** Entiers par pile dans le tampon `items()` : `[id, genre, quantité, x, y]` (`sim-wasm::ITEM_STRIDE`). */
const ITEM_STRIDE = 5;
/** Genres de `sim::ItemKind` (contrat `AGENTS.md` : `ItemKind::COUNT` = 19). */
const ITEM_KIND_COUNT = 19;

/** 60 ticks de jeu par seconde à la vitesse x1. */
export const TICKS_PER_SECOND = 60;
export const BASE_TICK_MS = 1000 / TICKS_PER_SECOND;
/** Rattrapage maximal par intervalle : au-delà on lâche du temps plutôt que de geler. */
export const MAX_TICKS_PER_STEP = 8;
/** En multi, au-delà de ce retard on rattrape plus fort (borné, jamais infini). */
export const CATCHUP_LAG_TICKS = 60;
export const MAX_TICKS_CATCHUP = 30;
/** Fenêtre de mesure des ticks par seconde. */
export const TPS_WINDOW_MS = 500;

/**
 * Ce que le runner attend d'un sim : le contrat réseau (`SimLike`) plus les
 * tampons de rendu. `SimHandle` l'implémente ; les tests en fabriquent un faux.
 */
export interface RunnerSim extends SimLike {
  readonly width: number;
  readonly height: number;
  mapVersion(): number;
  overlayVersion(): number;
  tiles(): Uint8Array;
  features(): Uint8Array;
  zones(): Uint8Array;
  designations(): Uint8Array;
  pawns(): Int32Array;
  items(): Int32Array;
  /**
   * Fraîcheur d'une pile, en ‰ restant ; −1 si son genre ne périme pas ou si
   * l'id est inconnu (`sim-wasm::item_freshness`). Sert à `foodFreshnessOf`.
   */
  itemFreshness(id: number): number;
  blueprints(): Int32Array;
  events(): Int32Array;
  priorities(): Int32Array;
  /** `[id, (niveau, xp)×6]` par colon. */
  skills(): Int32Array;
  /** `[id, sang, conscience %, blessures]` par pawn. */
  health(): Int32Array;
  /**
   * Faune vivante : `[id, espèce, drapeaux]` par bête, sauvage et apprivoisée
   * (`sim-wasm::ANIMAL_STRIDE`).
   */
  animals(): Int32Array;
  /** Objectifs de fabrication courants, indexés par `ItemKind` (19 entrées). */
  craftTargets(): Uint32Array;
  /** Arme équipée de chaque pawn armé : `[id, genre]` par pawn qui en porte une. */
  weapons(): Int32Array;
  /** Habit porté de chaque pawn habillé : `[id, genre]` par pawn qui en porte un. */
  apparel(): Int32Array;
  /** Traits de chaque pawn, aplatis : `[id, t0, t1]` par pawn (`-1` si absent). */
  traits(): Int32Array;
  /** Nom du pawn, chaîne vide si l'id est inconnu. */
  pawnName(id: number): string;
  /** Manifestes de caravane en attente d'expédition. */
  departuresCount(): number;
  storedTotals(): Uint32Array;
  weather(): number;
  timeOfDay(): number;
  ticksPerDay(): number;
  /** Saison courante, suivant `sim::climate::Season` (0 printemps … 3 hiver). */
  season(): number;
  /** Jour de l'année courant, dans `0..yearDays()`. */
  dayOfYear(): number;
  /** Jours d'une année de jeu (quatre saisons), constant. */
  yearDays(): number;
  /** Température extérieure, en dixièmes de degré. */
  outdoorTemperature(): number;
  /** Dose de menace courante, suivant `sim::storyteller::Difficulty`. */
  difficulty(): number;
  /** Richesse de la colonie (`sim::Sim::wealth`), en cache côté sim. */
  wealth(): number;
  /** Id du marchand avec qui on peut traiter, −1 s'il n'y en a pas. */
  traderPresent(): number;
  /** Ticks avant que le marchand ne reprenne la route ; 0 s'il n'y en a pas. */
  traderLeavesIn(): number;
  /** Étal du marchand, à plat : `[genre, quantité, prix unitaire de vente] × n`. */
  traderOffers(): Int32Array;
  /** Prix unitaire d'achat par genre, indexé par `ItemKind` (19 entrées). */
  buyPrices(): Uint32Array;
  /**
   * Où en est la recherche : `[courante, (avancement, coût, acquise) × 6]`,
   * 19 entiers. `courante` vaut 255 quand personne ne cherche rien.
   */
  researchState(): Uint32Array;
  /**
   * Réputation de la colonie auprès des trois factions PNJ, dans l'ordre des
   * ids (`sim-wasm::goodwill`).
   */
  goodwill(): Int32Array;
  /** Tribu du dernier raid (`sim-wasm::last_raid_faction`), −1 si aucune. */
  lastRaidFaction(): number;
  /** Change à chaque recalcul effectif de la couche « intérieur ». */
  indoorVersion(): number;
  /** Couche « intérieur » : un octet par case, 0 dehors, sinon le numéro de pièce. */
  indoor(): Uint8Array;
  /** Change à chaque changement d'intensité du feu (`sim-wasm::fire_version`). */
  fireVersion(): number;
  /** Cases en feu (`sim-wasm::fire_count`), à zéro s'il n'y a aucun incendie. */
  fireCount(): number;
  /** Couche « feu » : un octet par case, 0 éteint, sinon l'intensité de 1 à 3. */
  fire(): Uint8Array;
  /** Bêtes de la colonie vivantes, tous genres confondus (`sim-wasm::livestock_count`). */
  livestockCount(): number;
  dispose(): void;
}

/** Ce que le runner attend du lockstep : de quoi avancer et mesurer le retard. */
export interface LockstepLike {
  pump(maxTicks: number): number;
  readonly lag: number;
}

export interface SimRunnerOptions {
  /** Présent = mode multi : l'horloge vient du serveur, pas de l'accumulateur. */
  readonly lockstep?: LockstepLike | null;
  readonly maxTicksPerStep?: number;
  readonly catchupLagTicks?: number;
  readonly maxTicksCatchup?: number;
  readonly hashEveryFrames?: number;
  readonly tpsWindowMs?: number;
}

/** Ce qu'un `advance` a produit. Les champs `null` n'ont pas à être émis. */
export interface RunnerOutput {
  /** Ticks exécutés pendant cet appel. */
  readonly ticks: number;
  readonly map: MapMessage | null;
  readonly overlays: OverlaysMessage | null;
  readonly indoor: IndoorMessage | null;
  readonly fire: FireMessage | null;
  readonly frame: FrameMessage | null;
}

const NOTHING: RunnerOutput = { ticks: 0, map: null, overlays: null, indoor: null, fire: null, frame: null };

/**
 * Fraîcheur la plus basse par genre (`sim::ItemKind`), depuis le tampon
 * `items` et `itemFreshness` : la pile la plus proche de disparaître. `-1`
 * si aucune pile de ce genre n'est sur la carte, ou si le genre ne périme
 * pas (`itemFreshness` renvoie déjà `-1` dans ce cas, un simple minimum sur
 * les valeurs valides suffit à distinguer les deux du HUD).
 */
export function foodFreshnessOf(sim: RunnerSim, items: Int32Array): Int32Array {
  const out = new Int32Array(ITEM_KIND_COUNT).fill(-1);
  for (let o = 0; o + ITEM_STRIDE <= items.length; o += ITEM_STRIDE) {
    const kind = items[o + 1];
    if (kind < 0 || kind >= ITEM_KIND_COUNT) continue;
    const freshness = sim.itemFreshness(items[o]);
    if (freshness < 0) continue;
    if (out[kind] === -1 || freshness < out[kind]) out[kind] = freshness;
  }
  return out;
}

export class SimRunner {
  private readonly lockstep: LockstepLike | null;
  private readonly maxTicksPerStep: number;
  private readonly catchupLagTicks: number;
  private readonly maxTicksCatchup: number;
  private readonly hashEveryFrames: number;
  private readonly tpsWindowMs: number;

  private current: RunnerSim | null = null;
  private pausedFlag = false;
  private speedValue = 1;
  /** Millisecondes de jeu en attente d'être converties en ticks. */
  private acc = 0;
  /** Dernier instant vu par `advance`, `null` avant le premier appel. */
  private last: number | null = null;
  private knownMapVersion = -1;
  private knownOverlayVersion = -1;
  private knownIndoorVersion = -1;
  private knownFireVersion = -1;
  /** Force un `frame` juste après l'adoption d'un sim, même sans tick. */
  private needFirstFrame = false;
  private frameCount = 0;
  private ticksInWindow = 0;
  private windowStart = 0;
  private tpsValue = 0;
  /** Ids connus au dernier calcul de `knownNames` : sert à détecter un changement. */
  private knownIds = new Set<number>();
  /** Nom par id, recalculé seulement quand `knownIds` change (pas de `pawn_name` par frame). */
  private knownNames: Record<number, string> = {};

  constructor(options: SimRunnerOptions = {}) {
    this.lockstep = options.lockstep ?? null;
    this.maxTicksPerStep = options.maxTicksPerStep ?? MAX_TICKS_PER_STEP;
    this.catchupLagTicks = options.catchupLagTicks ?? CATCHUP_LAG_TICKS;
    this.maxTicksCatchup = options.maxTicksCatchup ?? MAX_TICKS_CATCHUP;
    this.hashEveryFrames = options.hashEveryFrames ?? HASH_EVERY_FRAMES;
    this.tpsWindowMs = options.tpsWindowMs ?? TPS_WINDOW_MS;
  }

  get sim(): RunnerSim | null {
    return this.current;
  }

  get paused(): boolean {
    return this.pausedFlag;
  }

  get speed(): number {
    return this.speedValue;
  }

  get tps(): number {
    return this.tpsValue;
  }

  /** Retard du lockstep, toujours 0 en solo. */
  get lag(): number {
    return this.lockstep?.lag ?? 0;
  }

  /**
   * Adopte un sim neuf, chargé ou restauré, et libère le précédent. Les
   * versions connues repartent à `-1` : la carte et les calques seront réémis,
   * et un premier `frame` partira même en pause.
   */
  setSim(next: RunnerSim | null): void {
    const previous = this.current;
    if (previous !== null && previous !== next) previous.dispose();
    this.current = next;
    this.knownMapVersion = -1;
    this.knownOverlayVersion = -1;
    this.knownIndoorVersion = -1;
    this.knownFireVersion = -1;
    this.knownIds = new Set();
    this.knownNames = {};
    this.acc = 0;
    this.needFirstFrame = next !== null;
  }

  /**
   * Nom de chaque pawn du tampon `pawns`, recalculé seulement quand la liste
   * des ids a changé depuis le dernier appel : `pawn_name` ne coûte rien tant
   * que personne n'apparaît ni ne disparaît.
   */
  private namesFor(sim: RunnerSim, pawns: Int32Array): Record<number, string> {
    const ids = new Set<number>();
    for (let o = 0; o + PAWN_STRIDE <= pawns.length; o += PAWN_STRIDE) ids.add(pawns[o]);
    let changed = ids.size !== this.knownIds.size;
    if (!changed) {
      for (const id of ids) {
        if (!this.knownIds.has(id)) {
          changed = true;
          break;
        }
      }
    }
    if (!changed) return this.knownNames;
    this.knownIds = ids;
    const names: Record<number, string> = {};
    for (const id of ids) names[id] = sim.pawnName(id);
    this.knownNames = names;
    return names;
  }

  /**
   * Force un `frame` au prochain `advance`, même sans tick. Sert au crochet de
   * debug : un scénario joué en pause depuis la console doit se voir à l'écran.
   */
  requestFrame(): void {
    if (this.current !== null) this.needFirstFrame = true;
  }

  setPaused(paused: boolean): void {
    // En multi la pause n'existe pas : l'horloge du serveur ne s'arrête jamais.
    if (this.lockstep !== null) return;
    this.pausedFlag = paused;
  }

  setSpeed(speed: number): void {
    if (this.lockstep !== null) return;
    this.speedValue = Number.isFinite(speed) && speed > 0 ? speed : 1;
  }

  /**
   * Exécute le lot de ticks que le temps écoulé autorise, puis décrit ce qui a
   * changé. `nowMs` est une horloge monotone (`performance.now()` du Worker).
   *
   * Aucun `frame` n'est produit sans tick exécuté, sauf le premier après
   * l'adoption d'un sim : sinon un jeu en pause n'afficherait jamais rien.
   */
  advance(nowMs: number): RunnerOutput {
    const first = this.last === null;
    const dt = first ? 0 : Math.max(0, nowMs - (this.last ?? nowMs));
    this.last = nowMs;
    if (first) this.windowStart = nowMs;
    const sim = this.current;
    if (sim === null) return NOTHING;

    const ticks = this.runTicks(sim, dt);
    this.ticksInWindow += ticks;
    const windowMs = nowMs - this.windowStart;
    if (windowMs >= this.tpsWindowMs) {
      this.tpsValue = Math.round((this.ticksInWindow * 1000) / windowMs);
      this.ticksInWindow = 0;
      this.windowStart = nowMs;
    }
    if (ticks === 0 && !this.needFirstFrame) return NOTHING;
    this.needFirstFrame = false;

    // Les versions ne bougent qu'en exécutant des ticks : inutile de les
    // relire quand rien n'a tourné.
    let map: MapMessage | null = null;
    let overlays: OverlaysMessage | null = null;
    const mapVersion = sim.mapVersion();
    if (mapVersion !== this.knownMapVersion) {
      this.knownMapVersion = mapVersion;
      map = {
        type: "map",
        width: sim.width,
        height: sim.height,
        mapVersion,
        // Copies : les vues sont zéro-copie sur la mémoire WASM.
        tiles: sim.tiles().slice(),
        features: sim.features().slice(),
      };
    }
    const overlayVersion = sim.overlayVersion();
    if (overlayVersion !== this.knownOverlayVersion) {
      this.knownOverlayVersion = overlayVersion;
      overlays = {
        type: "overlays",
        overlayVersion,
        zones: sim.zones().slice(),
        designations: sim.designations().slice(),
      };
    }
    let indoor: IndoorMessage | null = null;
    const indoorVersion = sim.indoorVersion();
    if (indoorVersion !== this.knownIndoorVersion) {
      this.knownIndoorVersion = indoorVersion;
      indoor = { type: "indoor", indoorVersion, indoor: sim.indoor().slice() };
    }
    let fire: FireMessage | null = null;
    const fireVersion = sim.fireVersion();
    if (fireVersion !== this.knownFireVersion) {
      this.knownFireVersion = fireVersion;
      fire = { type: "fire", fireVersion, fire: sim.fire().slice() };
    }

    const withHash = this.frameCount % this.hashEveryFrames === 0;
    this.frameCount += 1;
    const pawns = sim.pawns();
    const items = sim.items();
    const frame: FrameMessage = {
      type: "frame",
      tick: sim.tick(),
      timeOfDay: sim.timeOfDay(),
      ticksPerDay: sim.ticksPerDay(),
      weather: sim.weather(),
      temperature: sim.outdoorTemperature(),
      season: sim.season(),
      dayOfYear: sim.dayOfYear(),
      yearDays: sim.yearDays(),
      hash: withHash ? sim.hash() : null,
      pawns,
      items,
      foodFreshness: foodFreshnessOf(sim, items),
      blueprints: sim.blueprints(),
      events: sim.events(),
      priorities: sim.priorities(),
      skills: sim.skills(),
      health: sim.health(),
      animals: sim.animals(),
      names: this.namesFor(sim, pawns),
      stored: sim.storedTotals(),
      craftTargets: sim.craftTargets(),
      weapons: sim.weapons(),
      apparel: sim.apparel(),
      traits: sim.traits(),
      departures: sim.departuresCount(),
      fireCount: sim.fireCount(),
      livestockCount: sim.livestockCount(),
      lag: this.lag,
      tps: this.tpsValue,
      difficulty: sim.difficulty(),
      wealth: sim.wealth(),
      traderPresent: sim.traderPresent(),
      traderLeavesIn: sim.traderLeavesIn(),
      traderOffers: sim.traderOffers(),
      buyPrices: sim.buyPrices(),
      researchState: sim.researchState(),
      goodwill: sim.goodwill(),
      lastRaidFaction: sim.lastRaidFaction(),
    };
    return { ticks, map, overlays, indoor, fire, frame };
  }

  /** Le pas de temps proprement dit. Renvoie le nombre de ticks exécutés. */
  private runTicks(sim: RunnerSim, dt: number): number {
    if (this.lockstep !== null) {
      // L'horloge est celle des bundles : on n'avance que sur ce qui est reçu.
      const budget = this.lockstep.lag > this.catchupLagTicks ? this.maxTicksCatchup : this.maxTicksPerStep;
      return this.lockstep.pump(budget);
    }
    if (this.pausedFlag) return 0; // accumulateur gelé
    this.acc += dt;
    const tickMs = BASE_TICK_MS / this.speedValue;
    // Une division plutôt qu'une soustraction en boucle : `floor(dt / tickMs)`
    // exactement, sans le grain de sable de soixantièmes accumulés.
    const ticks = Math.min(Math.floor(this.acc / tickMs), this.maxTicksPerStep);
    this.acc -= ticks * tickMs;
    // Trop de retard : on lâche le temps en trop au lieu de le rattraper sans fin.
    if (this.acc > tickMs * this.maxTicksPerStep) this.acc = 0;
    if (ticks > 0) sim.step(ticks);
    return ticks;
  }
}
