/**
 * Boucle autonome de colonies : tourne sans navigateur, sans règles de jeu TS.
 * Prépare le participant permanent ; Room/WebSocket utilise encore le relais.
 */
import { NativeSimError, NativeSimProcess, type NativeCreate, type NativeProcessOptions, type NativeState } from "./native-sim.js";
import { NativeCheckpointStore, validateNativeMapName } from "./native-checkpoints.js";

export type NativeClock = (pulse: () => void, intervalMs: number) => () => void;
export interface NativeColoniesOptions {
  readonly process?: NativeProcessOptions;
  readonly store?: NativeCheckpointStore;
  readonly bundleTicks?: number;
  readonly checkpointEveryTicks?: number;
  readonly clock?: NativeClock;
  readonly onError?: (error: Error) => void;
}
interface Colony {
  tick: number;
  nextCheckpoint: number;
  pending: Uint8Array[];
  pendingBytes: number;
}
export interface NativeAdvance {
  readonly map: string;
  readonly from: number;
  readonly to: number;
  /** Commandes effectivement appliquées au premier tick du lot. */
  readonly commands: readonly Uint8Array[];
}

const defaultClock: NativeClock = (pulse, intervalMs) => {
  const timer = setInterval(pulse, intervalMs);
  timer.unref();
  return () => clearInterval(timer);
};
const MAX_COMMANDS = 256;
const MAX_COMMAND_BYTES = 1024 * 1024;
const MAX_OPERATIONS = 128;

export class NativeColonies {
  private readonly maps = new Map<string, Colony>();
  private readonly bundleTicks: number;
  private readonly checkpointEveryTicks: number;
  private readonly clock: NativeClock;
  private tail: Promise<unknown> = Promise.resolve();
  private operations = 0;
  private stopClock: (() => void) | null = null;
  private pulsePending = false;
  private closed = false;
  private closePromise: Promise<void> | null = null;
  private failure: Error | null = null;
  private skipped = 0;

  private constructor(private readonly engine: NativeSimProcess, private readonly options: NativeColoniesOptions,
    private readonly releaseWriter?: () => Promise<void>) {
    this.bundleTicks = options.bundleTicks ?? 3;
    this.checkpointEveryTicks = options.checkpointEveryTicks ?? 3600;
    this.clock = options.clock ?? defaultClock;
  }

  static async open(options: NativeColoniesOptions = {}): Promise<NativeColonies> {
    const ticks = options.bundleTicks ?? 3;
    const checkpoint = options.checkpointEveryTicks ?? 3600;
    if (!Number.isSafeInteger(ticks) || ticks < 1 || ticks > 6000
      || !Number.isSafeInteger(checkpoint) || checkpoint < ticks) {
      throw new Error("Cadence native invalide");
    }
    const release = await options.store?.acquireWriter();
    try {
      return new NativeColonies(await NativeSimProcess.start(options.process), options, release);
    } catch (error) {
      await release?.();
      throw error;
    }
  }

  get running(): boolean { return this.stopClock !== null; }
  get error(): Error | null { return this.failure; }
  /** Une saturation ralentit le monde ; elle n'accumule jamais une file illimitée. */
  get skippedPulses(): number { return this.skipped; }
  get mapCount(): number { return this.maps.size; }

  private checkOpen(): void {
    if (this.closed) throw new NativeSimError("closed", "Colonies natives fermées");
    if (this.failure) throw this.failure;
  }

  private enqueue<T>(operation: () => Promise<T>): Promise<T> {
    try { this.checkOpen(); } catch (error) { return Promise.reject(error); }
    if (this.operations >= MAX_OPERATIONS) return Promise.reject(new NativeSimError("backpressure", "File des colonies pleine"));
    this.operations++;
    const result = this.tail.then(() => {
      if (this.failure) throw this.failure;
      return operation();
    });
    this.tail = result.catch(() => {}).finally(() => { this.operations--; });
    return result;
  }

  private fail(error: unknown): Error {
    const reason = error instanceof Error ? error : new Error(String(error));
    if (!this.failure) {
      this.failure = reason;
      this.stop();
      this.options.onError?.(reason);
    }
    return reason;
  }

  private remember(map: string, state: NativeState): void {
    this.maps.set(map, { tick: state.tick, nextCheckpoint: state.tick + this.checkpointEveryTicks, pending: [], pendingBytes: 0 });
  }

  create(map: string, options: NativeCreate): Promise<NativeState> {
    return this.enqueue(async () => {
      validateNativeMapName(map);
      if (this.maps.has(map) || await this.options.store?.read(map)) {
        throw new NativeSimError("already_exists", "Une colonie existe déjà ; restaurer son checkpoint");
      }
      const state = await this.engine.create(map, options);
      this.remember(map, state);
      if (this.options.store) {
        try { await this.checkpointOne(map); } catch (error) { throw this.fail(error); }
      }
      return state;
    });
  }

  restore(map: string): Promise<NativeState> {
    return this.enqueue(async () => {
      if (!this.options.store) throw new Error("Aucun magasin de checkpoints configuré");
      if (this.maps.has(map)) throw new NativeSimError("already_exists", "Colonie déjà chargée");
      const checkpoint = await this.options.store.read(map);
      if (!checkpoint) throw new NativeSimError("not_found", "Checkpoint absent");
      const state = await this.engine.restore(map, checkpoint.data);
      if (state.tick !== checkpoint.tick || state.hash !== checkpoint.hash
        || state.width !== checkpoint.width || state.height !== checkpoint.height || state.day_scale !== checkpoint.dayScale) {
        await this.engine.remove(map);
        throw new Error("Le checkpoint ne correspond pas à son état natif");
      }
      this.remember(map, state);
      // Aucun calcul de temps mural : serveur arrêté = monde arrêté.
      return state;
    });
  }

  /** Copie les octets à l'admission ; ils restent opaques jusqu'au Rust. */
  submit(map: string, command: Uint8Array): void {
    this.checkOpen();
    const colony = this.maps.get(map);
    if (!colony) throw new NativeSimError("not_found", "Colonie non chargée");
    if (command.length === 0 || command.length > 65536) throw new NativeSimError("invalid_command", "Commande hors bornes");
    if (colony.pending.length >= MAX_COMMANDS || colony.pendingBytes + command.length > MAX_COMMAND_BYTES) {
      throw new NativeSimError("backpressure", "Trop de commandes pour la colonie");
    }
    colony.pending.push(command.slice());
    colony.pendingBytes += command.length;
  }

  advance(): Promise<readonly NativeAdvance[]> {
    return this.enqueue(() => this.advanceNow());
  }

  private async advanceNow(): Promise<readonly NativeAdvance[]> {
      const result: NativeAdvance[] = [];
      try {
        for (const map of [...this.maps.keys()].sort()) {
          const colony = this.maps.get(map)!;
          const commands = colony.pending;
          colony.pending = [];
          colony.pendingBytes = 0;
          const from = colony.tick;
          let to: number;
          try {
            to = await this.engine.step(map, from,
              Array.from({ length: this.bundleTicks }, (_, i) => i === 0 ? commands : []));
          } catch (error) {
            // Jamais de rejeu automatique après une erreur de transport :
            // le moteur peut avoir appliqué le lot avant de perdre la réponse.
            colony.pending.unshift(...commands);
            colony.pendingBytes += commands.reduce((n, bytes) => n + bytes.length, 0);
            throw error;
          }
          colony.tick = to;
          result.push({ map, from, to, commands });
          if (this.options.store && to >= colony.nextCheckpoint) await this.checkpointOne(map);
        }
        return result;
      } catch (error) { throw this.fail(error); }
  }

  inspect(map: string): Promise<NativeState> {
    return this.enqueue(() => this.engine.inspect(map));
  }

  private async checkpointOne(map: string): Promise<void> {
    if (!this.options.store) return;
    const state = await this.engine.inspect(map);
    const snapshot = await this.engine.snapshot(map);
    await this.options.store.write(map, state, snapshot);
    this.maps.get(map)!.nextCheckpoint = state.tick + this.checkpointEveryTicks;
  }

  checkpoint(): Promise<void> {
    return this.enqueue(async () => {
      try { for (const map of [...this.maps.keys()].sort()) await this.checkpointOne(map); }
      catch (error) { throw this.fail(error); }
    });
  }

  /** L'horloge n'a aucune dépendance à un nombre de joueurs ou de visiteurs. */
  start(): void {
    this.checkOpen();
    if (this.stopClock) return;
    this.stopClock = this.clock(() => {
      if (this.pulsePending) { this.skipped++; return; }
      this.pulsePending = true;
      void this.advance().catch((error) => { this.fail(error); }).finally(() => { this.pulsePending = false; });
    }, this.bundleTicks * 1000 / 60);
  }

  stop(): void {
    this.stopClock?.();
    this.stopClock = null;
  }

  close(): Promise<void> {
    if (this.closePromise) return this.closePromise;
    this.closed = true;
    this.stop();
    this.closePromise = (async () => {
      await this.tail;
      try {
        if (this.failure) throw this.failure;
        // Un dernier lot applique les commandes admises avant l'arrêt,
        // puis le checkpoint les conserve. Aucun ordre accepté n'est perdu.
        if ([...this.maps.values()].some((colony) => colony.pending.length > 0)) {
          await this.advanceNow();
        }
        for (const map of [...this.maps.keys()].sort()) await this.checkpointOne(map);
      } finally {
        try { await this.engine.close(); }
        finally { await this.releaseWriter?.(); }
      }
    })();
    return this.closePromise;
  }
}
