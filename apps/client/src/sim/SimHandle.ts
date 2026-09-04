import type { SimLike } from "../net/SimLike";
import init, { WasmSim, type InitOutput } from "../wasm/sim.js";

/**
 * L'init wasm-bindgen n'est pas idempotente si elle est appelée deux fois en
 * parallèle (deux instances, deux mémoires, la seconde écrase la globale).
 * React StrictMode monte deux fois : on mémoïse la promesse.
 */
let initPromise: Promise<InitOutput> | undefined;
function initOnce(): Promise<InitOutput> {
  initPromise ??= init();
  return initPromise;
}

/**
 * Initialise le WASM du thread courant, sans créer de sim.
 *
 * Le Worker le fait implicitement en créant son sim. Le thread principal, lui,
 * n'a plus de sim mais garde besoin du module : les `encode*` de
 * `sim/commands.ts` sont des fonctions du WASM. Une instance qui ne sert qu'à
 * encoder ne coûte que les quelques pages initiales de mémoire.
 */
export function initSim(): Promise<InitOutput> {
  return initOnce();
}

/**
 * Enveloppe fine autour du sim WASM. Garde une référence à la mémoire pour
 * construire des vues zéro-copie sur l'état. Les vues (`tiles`, `features`,
 * `zones`, `designations`) ne doivent pas être conservées entre deux appels
 * au sim ; `pawns` et `items` renvoient des copies.
 *
 * Implémente `SimLike` : c'est par ce contrat que la couche réseau le pilote.
 */
export class SimHandle implements SimLike {
  private constructor(
    private readonly wasm: InitOutput,
    private readonly inner: WasmSim,
  ) {}

  static async create(opts: { seed: bigint; width: number; height: number }): Promise<SimHandle> {
    const wasm = await initOnce();
    return new SimHandle(wasm, new WasmSim(opts.seed, opts.width, opts.height));
  }

  static async restore(bytes: Uint8Array): Promise<SimHandle> {
    const wasm = await initOnce();
    return new SimHandle(wasm, WasmSim.restore(bytes));
  }

  get width(): number {
    return this.inner.width();
  }

  get height(): number {
    return this.inner.height();
  }

  step(n: number): void {
    this.inner.step(n);
  }

  /**
   * Met en attente une commande encodée (voir `sim/commands.ts`). Seul chemin
   * des actions du joueur, en solo comme en multi. Lève si les octets ne sont
   * pas une commande valide.
   */
  applyEncoded(bytes: Uint8Array): void {
    this.inner.apply_encoded(bytes);
  }

  /** Commandes en attente du prochain `step`. */
  pendingLen(): number {
    return this.inner.pending_len();
  }

  moveTo(pawn: number, x: number, y: number): void {
    this.inner.move_to(pawn, x, y);
  }

  designate(kind: number, x0: number, y0: number, x1: number, y1: number): void {
    this.inner.designate(kind, x0, y0, x1, y1);
  }

  setZone(zone: number, x0: number, y0: number, x1: number, y1: number): void {
    this.inner.set_zone(zone, x0, y0, x1, y1);
  }

  build(kind: number, material: number, x0: number, y0: number, x1: number, y1: number): void {
    this.inner.build(kind, material, x0, y0, x1, y1);
  }

  cancelBuild(x0: number, y0: number, x1: number, y1: number): void {
    this.inner.cancel_build(x0, y0, x1, y1);
  }

  attack(pawn: number, target: number): void {
    this.inner.attack(pawn, target);
  }

  /** `work` suit `sim::WorkType`, `priority` : 1 haute … 4 basse, 0 désactivé. */
  setPriority(pawn: number, work: number, priority: number): void {
    this.inner.set_priority(pawn, work, priority);
  }

  triggerRaid(): void {
    this.inner.trigger_raid();
  }

  tick(): number {
    return this.inner.tick();
  }

  ticksPerDay(): number {
    return this.inner.ticks_per_day();
  }

  timeOfDay(): number {
    return this.inner.time_of_day();
  }

  /** Météo courante, suivant `sim::Weather`. */
  weather(): number {
    return this.inner.weather();
  }

  hash(): string {
    return this.inner.hash();
  }

  mapVersion(): number {
    return this.inner.map_version();
  }

  overlayVersion(): number {
    return this.inner.overlay_version();
  }

  storedTotals(): Uint32Array {
    return this.inner.stored_totals();
  }

  snapshot(): Uint8Array {
    return this.inner.snapshot();
  }

  private view8(ptr: number): Uint8Array {
    return new Uint8Array(this.wasm.memory.buffer, ptr, this.inner.tiles_len());
  }

  tiles(): Uint8Array {
    return this.view8(this.inner.tiles_ptr());
  }

  features(): Uint8Array {
    return this.view8(this.inner.features_ptr());
  }

  zones(): Uint8Array {
    return this.view8(this.inner.zones_ptr());
  }

  designations(): Uint8Array {
    return this.view8(this.inner.designations_ptr());
  }

  pawns(): Int32Array {
    return new Int32Array(new Int32Array(this.wasm.memory.buffer, this.inner.pawns_ptr(), this.inner.pawns_len()));
  }

  items(): Int32Array {
    return new Int32Array(new Int32Array(this.wasm.memory.buffer, this.inner.items_ptr(), this.inner.items_len()));
  }

  blueprints(): Int32Array {
    return new Int32Array(
      new Int32Array(this.wasm.memory.buffer, this.inner.blueprints_ptr(), this.inner.blueprints_len()),
    );
  }

  events(): Int32Array {
    return new Int32Array(new Int32Array(this.wasm.memory.buffer, this.inner.events_ptr(), this.inner.events_len()));
  }

  /** Priorités de travail : `[id, p0..p5]` par colon. Copie. */
  priorities(): Int32Array {
    return new Int32Array(
      new Int32Array(this.wasm.memory.buffer, this.inner.priorities_ptr(), this.inner.priorities_len()),
    );
  }

  dispose(): void {
    this.inner.free();
  }
}
