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
 * Enveloppe fine autour du sim WASM. Garde une référence à la mémoire pour
 * construire des vues zéro-copie sur l'état.
 */
export class SimHandle {
  private constructor(
    private readonly wasm: InitOutput,
    private readonly inner: WasmSim,
  ) {}

  static async create(opts: { seed: bigint; width: number; height: number }): Promise<SimHandle> {
    const wasm = await initOnce();
    return new SimHandle(wasm, new WasmSim(opts.seed, opts.width, opts.height));
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

  moveTo(pawn: number, x: number, y: number): void {
    this.inner.move_to(pawn, x, y);
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

  hash(): string {
    return this.inner.hash();
  }

  /** Vue directe sur le terrain. À ne pas conserver entre deux appels au sim. */
  tiles(): Uint8Array {
    return new Uint8Array(this.wasm.memory.buffer, this.inner.tiles_ptr(), this.inner.tiles_len());
  }

  /** Copie du tampon des pawns (id, x, y, flags en virgule fixe 24.8). */
  pawns(): Int32Array {
    return new Int32Array(new Int32Array(this.wasm.memory.buffer, this.inner.pawns_ptr(), this.inner.pawns_len()));
  }

  dispose(): void {
    this.inner.free();
  }
}
