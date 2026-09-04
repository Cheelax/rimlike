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

  tick(): number {
    return this.inner.tick();
  }

  hash(): string {
    return this.inner.hash();
  }

  /** Vue directe sur le terrain. À ne pas conserver entre deux appels au sim. */
  tiles(): Uint8Array {
    return new Uint8Array(this.wasm.memory.buffer, this.inner.tiles_ptr(), this.inner.tiles_len());
  }

  dispose(): void {
    this.inner.free();
  }
}
