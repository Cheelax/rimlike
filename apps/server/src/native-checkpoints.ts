/**
 * Checkpoints du moteur natif, indépendants du fichier de monde historique.
 * Un écrivain par répertoire. Les snapshots proviennent du moteur du serveur :
 * cette API n'est pas une entrée pour des fichiers envoyés par les joueurs.
 */
import { createHash, randomUUID } from "node:crypto";
import { mkdir, open, readFile, rename, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { hostname } from "node:os";
import { PROTOCOL_VERSION } from "@rimlike/protocol";
import type { NativeSnapshot, NativeState } from "./native-sim.js";

export const NATIVE_CHECKPOINT_VERSION = 1;
const MAX_SNAPSHOT_BYTES = 8 * 1024 * 1024;
const MAX_CHECKPOINT_BYTES = 12 * 1024 * 1024;

export interface NativeCheckpoint {
  readonly map: string;
  readonly tick: number;
  readonly hash: string;
  readonly width: number;
  readonly height: number;
  readonly dayScale: number;
  readonly data: Uint8Array;
}

export function validateNativeMapName(map: string): void {
  if (!/^[a-zA-Z0-9_-]{1,80}$/.test(map)) throw new Error("Nom de carte natif invalide");
}

function digest(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

function integer(value: unknown, min: number, max: number): value is number {
  return Number.isSafeInteger(value) && (value as number) >= min && (value as number) <= max;
}

export class NativeCheckpointStore {
  readonly directory: string;

  constructor(directory: string) {
    this.directory = resolve(directory);
  }

  /**
   * Un seul runtime écrivain, même entre processus. Après un arrêt brutal,
   * le verrou reste : l'opérateur vérifie PID/hôte avant de le retirer.
   * Aucune déduction de péremption sur l'heure ou réutilisation risquée du PID.
   */
  async acquireWriter(): Promise<() => Promise<void>> {
    await mkdir(this.directory, { recursive: true });
    const file = join(this.directory, ".writer.lock");
    const token = randomUUID();
    let handle;
    try { handle = await open(file, "wx", 0o600); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code === "EEXIST") {
        throw new Error("Dossier de checkpoints déjà utilisé ou verrou laissé après un arrêt brutal : " + file);
      }
      throw error;
    }
    try {
      await handle.writeFile(JSON.stringify({ token, pid: process.pid, host: hostname() }));
      await handle.sync();
    } catch (error) {
      await handle.close();
      await rm(file, { force: true });
      throw error;
    }
    await handle.close();
    let released = false;
    return async () => {
      if (released) return;
      const owner = JSON.parse(await readFile(file, "utf8")) as { token?: unknown };
      if (owner?.token !== token) throw new Error("Le propriétaire du verrou natif a changé ; verrou conservé");
      await rm(file);
      released = true;
    };
  }

  private file(map: string): string {
    validateNativeMapName(map);
    return join(this.directory, map + ".json");
  }

  async read(map: string): Promise<NativeCheckpoint | null> {
    const file = this.file(map);
    let raw: string;
    try {
      const info = await stat(file);
      if (!info.isFile() || info.size > MAX_CHECKPOINT_BYTES) throw new Error("Checkpoint trop grand ou invalide");
      raw = await readFile(file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
    const value: unknown = JSON.parse(raw);
    if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("Checkpoint invalide");
    const v = value as Record<string, unknown>;
    if (v.version !== NATIVE_CHECKPOINT_VERSION || v.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error("Version de checkpoint incompatible");
    }
    if (v.map !== map || !integer(v.tick, 0, Number.MAX_SAFE_INTEGER)
      || !integer(v.width, 8, 192) || !integer(v.height, 8, 192)
      || !integer(v.dayScale, 1, 120) || typeof v.hash !== "string" || !/^[0-9a-f]{16}$/.test(v.hash)
      || typeof v.sha256 !== "string" || typeof v.data !== "string"
      || v.data.length > Math.ceil(MAX_SNAPSHOT_BYTES / 3) * 4) {
      throw new Error("Métadonnées du checkpoint invalides");
    }
    const data = Buffer.from(v.data, "base64");
    if (data.length === 0 || data.length > MAX_SNAPSHOT_BYTES || data.toString("base64") !== v.data
      || digest(data) !== v.sha256) {
      throw new Error("Intégrité du checkpoint invalide");
    }
    return { map, tick: v.tick, hash: v.hash, width: v.width, height: v.height, dayScale: v.dayScale, data };
  }

  async write(map: string, state: NativeState, snapshot: NativeSnapshot): Promise<void> {
    const file = this.file(map);
    if (state.tick !== snapshot.tick || state.snapshot_bytes !== snapshot.data.length
      || snapshot.data.length === 0 || snapshot.data.length > MAX_SNAPSHOT_BYTES) {
      throw new Error("État et snapshot natifs incohérents");
    }
    const data = JSON.stringify({
      version: NATIVE_CHECKPOINT_VERSION, protocolVersion: PROTOCOL_VERSION, map,
      tick: state.tick, hash: state.hash, width: state.width, height: state.height,
      dayScale: state.day_scale, sha256: digest(snapshot.data),
      data: Buffer.from(snapshot.data).toString("base64"),
    });
    if (Buffer.byteLength(data) > MAX_CHECKPOINT_BYTES) throw new Error("Checkpoint trop grand");
    await mkdir(this.directory, { recursive: true });
    const temporary = file + "." + randomUUID() + ".tmp";
    try {
      const handle = await open(temporary, "wx", 0o600);
      try { await handle.writeFile(data); await handle.sync(); }
      finally { await handle.close(); }
      await rename(temporary, file);
      // Le contenu puis le renommage sont durables sur le FS Linux du serveur.
      if (process.platform !== "win32") {
        const directory = await open(this.directory, "r");
        try { await directory.sync(); } finally { await directory.close(); }
      }
    } finally {
      await rm(temporary, { force: true });
    }
  }
}
