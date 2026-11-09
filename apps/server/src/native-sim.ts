/**
 * Client du processus Rust natif. Une seule file stdin/stdout pour plusieurs
 * cartes, commandes postcard opaques, et aucune règle de jeu dans Node.
 *
 * Le relais actuel ne l'active pas encore : cette frontière se teste et se
 * mesure séparément avant de faire du serveur l'autorité des salles.
 */
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { fileURLToPath } from "node:url";

export const NATIVE_PROTOCOL_VERSION = 1;
export const MAX_NATIVE_FRAME_BYTES = 16 * 1024 * 1024;
export const MAX_PENDING_NATIVE_REQUESTS = 128;
const MAX_PENDING_BYTES = 32 * 1024 * 1024;

export interface NativeState {
  readonly tick: number;
  readonly width: number;
  readonly height: number;
  readonly day_scale: number;
  readonly hash: string;
  readonly snapshot_bytes: number;
  readonly colonists: number;
  readonly raid_status: readonly number[];
}

export interface NativeSnapshot {
  readonly tick: number;
  readonly data: Uint8Array;
}

export interface NativeCreate {
  readonly seed: number;
  readonly width: number;
  readonly height: number;
  readonly biome: number;
  readonly dayScale: number;
}

export class NativeSimError extends Error {
  constructor(readonly code: string, message: string) {
    super(message);
    this.name = "NativeSimError";
  }
}

export interface NativeProcessOptions {
  readonly binary?: string;
  readonly args?: readonly string[];
  readonly timeoutMs?: number;
}

interface Pending {
  readonly resolve: (value: unknown) => void;
  readonly reject: (reason: Error) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly bytes: number;
}

/** Chemin de développement indépendant du cwd ; un déploiement fixe RIMLIKE_NATIVE_SIM_BIN. */
export function defaultNativeBinary(): string {
  return process.env.RIMLIKE_NATIVE_SIM_BIN ??
    fileURLToPath(new URL(`../../../target/release/rimlike-native${process.platform === "win32" ? ".exe" : ""}`, import.meta.url));
}

/** Décodeur incrémental : une copie par octet, même sur une grosse sauvegarde fragmentée. */
export class NativeFrameReader {
  private readonly header = Buffer.alloc(4);
  private headerUsed = 0;
  private payload: Buffer | null = null;
  private payloadUsed = 0;

  push(chunk: Uint8Array, accept: (bytes: Buffer) => void): void {
    let offset = 0;
    while (offset < chunk.length) {
      if (this.payload === null) {
        const count = Math.min(4 - this.headerUsed, chunk.length - offset);
        this.header.set(chunk.subarray(offset, offset + count), this.headerUsed);
        this.headerUsed += count;
        offset += count;
        if (this.headerUsed < 4) continue;
        const length = this.header.readUInt32BE(0);
        if (length === 0 || length > MAX_NATIVE_FRAME_BYTES) {
          throw new NativeSimError("protocol_error", "Taille de réponse native hors bornes");
        }
        this.payload = Buffer.allocUnsafe(length);
        this.payloadUsed = 0;
        this.headerUsed = 0;
      }
      const count = Math.min(this.payload.length - this.payloadUsed, chunk.length - offset);
      this.payload.set(chunk.subarray(offset, offset + count), this.payloadUsed);
      this.payloadUsed += count;
      offset += count;
      if (this.payloadUsed === this.payload.length) {
        const completed = this.payload;
        this.payload = null;
        this.payloadUsed = 0;
        accept(completed);
      }
    }
  }
}

function object(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function state(value: unknown): NativeState {
  if (!object(value) || !Number.isSafeInteger(value.tick) || !Number.isSafeInteger(value.width)
    || !Number.isSafeInteger(value.height) || !Number.isSafeInteger(value.day_scale)
    || !Number.isSafeInteger(value.snapshot_bytes) || !Number.isSafeInteger(value.colonists)
    || typeof value.hash !== "string" || !/^[0-9a-f]{16}$/.test(value.hash)
    || !Array.isArray(value.raid_status) || value.raid_status.length !== 6
    || !value.raid_status.every(Number.isSafeInteger)) {
    throw new NativeSimError("protocol_error", "État natif invalide");
  }
  return value as unknown as NativeState;
}

export class NativeSimProcess {
  private readonly child: ChildProcessWithoutNullStreams;
  private readonly pending = new Map<number, Pending>();
  private readonly reader = new NativeFrameReader();
  private readonly timeoutMs: number;
  private readonly exited: Promise<void>;
  private nextId = 1;
  private pendingBytes = 0;
  private failure: Error | null = null;
  private closing = false;
  private stderr = "";

  private constructor(options: NativeProcessOptions) {
    this.timeoutMs = options.timeoutMs ?? 10_000;
    if (!Number.isFinite(this.timeoutMs) || this.timeoutMs <= 0) {
      throw new NativeSimError("invalid_request", "Délai natif invalide");
    }
    this.child = spawn(options.binary ?? defaultNativeBinary(), [...(options.args ?? [])], {
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
      shell: false,
    });
    this.exited = new Promise((resolve) => {
      this.child.once("close", () => resolve());
      this.child.once("error", () => resolve());
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.stdin.on("error", (error) => this.fail(error));
    this.child.stderr.on("data", (chunk: Buffer) => {
      this.stderr = (this.stderr + chunk.toString("utf8")).slice(-4_096);
    });
    this.child.stdout.on("data", (chunk: Buffer) => {
      try { this.reader.push(chunk, (bytes) => this.receive(bytes)); }
      catch (error) { this.fail(error instanceof Error ? error : new Error(String(error))); }
    });
    // close arrive après la fermeture de stdout : le dernier accusé de
    // réception doit être décodé avant de rejeter ce qui reste en vol.
    this.child.on("close", (code, signal) => {
      this.fail(new NativeSimError("process_exited",
        `Le moteur natif s'est arrêté (code ${code}, signal ${signal})${this.stderr ? ": " + this.stderr.trim() : ""}`));
    });
  }

  /** PID pour la mesure locale de mémoire ; jamais exposé au protocole réseau. */
  get pid(): number {
    if (this.child.pid === undefined) throw new NativeSimError("process_exited", "Processus natif absent");
    return this.child.pid;
  }

  static async start(options: NativeProcessOptions = {}): Promise<NativeSimProcess> {
    const process = new NativeSimProcess(options);
    try {
      const hello = await process.request({ op: "ping" });
      if (!object(hello) || hello.protocol !== NATIVE_PROTOCOL_VERSION) {
        throw new NativeSimError("protocol_error", "Version du moteur natif incompatible");
      }
      return process;
    } catch (error) {
      process.terminate();
      throw error;
    }
  }

  private fail(error: Error): void {
    if (this.failure) return;
    this.failure = error;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.reject(error);
    }
    this.pending.clear();
    this.pendingBytes = 0;
    this.child.kill();
  }

  private receive(bytes: Buffer): void {
    const message: unknown = JSON.parse(bytes.toString("utf8"));
    if (!object(message) || !Number.isSafeInteger(message.id) || typeof message.ok !== "boolean") {
      throw new NativeSimError("protocol_error", "Réponse native invalide");
    }
    const id = message.id as number;
    const pending = this.pending.get(id);
    if (!pending) throw new NativeSimError("protocol_error", "Réponse native sans requête");
    this.pending.delete(id);
    this.pendingBytes -= pending.bytes;
    clearTimeout(pending.timer);
    if (message.ok) pending.resolve(message.result);
    else if (object(message.error) && typeof message.error.code === "string" && typeof message.error.message === "string") {
      pending.reject(new NativeSimError(message.error.code, message.error.message));
    } else {
      const error = new NativeSimError("protocol_error", "Erreur native mal formée");
      pending.reject(error);
      throw error;
    }
  }

  private request(request: Record<string, unknown>): Promise<unknown> {
    if (this.failure) return Promise.reject(this.failure);
    if (this.closing) return Promise.reject(new NativeSimError("closed", "Moteur natif fermé"));
    if (this.pending.size >= MAX_PENDING_NATIVE_REQUESTS) {
      return Promise.reject(new NativeSimError("backpressure", "Trop de requêtes natives en attente"));
    }
    const id = this.nextId++;
    const data = Buffer.from(JSON.stringify({ id, request }), "utf8");
    if (data.length > MAX_NATIVE_FRAME_BYTES) {
      return Promise.reject(new NativeSimError("invalid_request", "Requête native trop grande"));
    }
    if (this.pendingBytes + data.length > MAX_PENDING_BYTES) {
      return Promise.reject(new NativeSimError("backpressure", "File native trop grande"));
    }
    const frame = Buffer.allocUnsafe(4 + data.length);
    frame.writeUInt32BE(data.length, 0);
    data.copy(frame, 4);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => this.fail(new NativeSimError("timeout", "Le moteur natif ne répond plus")), this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer, bytes: data.length });
      this.pendingBytes += data.length;
      this.child.stdin.write(frame, (error) => { if (error) this.fail(error); });
    });
  }

  async create(map: string, options: NativeCreate): Promise<NativeState> {
    return state(await this.request({ op: "create", map, seed: options.seed, width: options.width,
      height: options.height, biome: options.biome, day_scale: options.dayScale }));
  }

  async restore(map: string, data: Uint8Array): Promise<NativeState> {
    return state(await this.request({ op: "restore", map, data: Buffer.from(data).toString("base64") }));
  }

  async step(map: string, expectedTick: number, frames: readonly (readonly Uint8Array[])[]): Promise<number> {
    const result = await this.request({ op: "step", map, expected_tick: expectedTick,
      frames: frames.map((frame) => frame.map((command) => Buffer.from(command).toString("base64"))) });
    if (!object(result) || !Number.isSafeInteger(result.tick)) throw new NativeSimError("protocol_error", "Tick natif invalide");
    return result.tick as number;
  }

  async inspect(map: string): Promise<NativeState> {
    return state(await this.request({ op: "inspect", map }));
  }

  async snapshot(map: string): Promise<NativeSnapshot> {
    const result = await this.request({ op: "snapshot", map });
    if (!object(result) || !Number.isSafeInteger(result.tick) || typeof result.data !== "string") {
      throw new NativeSimError("protocol_error", "Snapshot natif invalide");
    }
    return { tick: result.tick as number, data: Buffer.from(result.data, "base64") };
  }

  async remove(map: string): Promise<boolean> {
    const result = await this.request({ op: "remove", map });
    if (!object(result) || typeof result.removed !== "boolean") throw new NativeSimError("protocol_error", "Suppression native invalide");
    return result.removed;
  }

  /** Arrêt explicite : toutes les promesses en vol sont rejetées. */
  terminate(): void {
    this.fail(new NativeSimError("closed", "Moteur natif arrêté"));
  }

  async close(): Promise<void> {
    if (this.closing) { await this.exited; return; }
    if (!this.failure) {
      const goodbye = this.request({ op: "shutdown" });
      this.closing = true;
      try { await goodbye; } catch { this.child.kill(); }
    }
    this.child.stdin.end();
    await this.exited;
  }
}
