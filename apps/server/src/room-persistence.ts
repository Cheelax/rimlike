/** Salles nommées conservées : octets opaques, dates réelles et expiration. */
import { base64ToBytes, bytesToBase64, frozenTicksForHours } from "@rimlike/protocol";

import type { RoomRestore, RoomSnapshotReport } from "./room.js";
import { tileFromRoomName } from "./world.js";

export const ROOM_PERSIST_MS = 30_000;
export const ROOM_TTL_HOURS = 72;

export interface SavedRoom {
  readonly name: string;
  readonly seed: number;
  readonly tick: number;
  readonly data: string;
  readonly width: number;
  readonly height: number;
  readonly createdAt: number;
  readonly lastVisitedAt: number;
  /** Arrêt propre, départ du dernier joueur, ou dernier checkpoint en cas de crash. */
  readonly frozenAt: number;
}

/** Valide les métadonnées sans interpréter les octets du sim. */
export function readSavedRooms(value: unknown): SavedRoom[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("liste de salles sauvegardées invalide");
  }
  const names = new Set<string>();
  return value.map((entry: SavedRoom) => {
    if (
      entry === null || typeof entry !== "object" ||
      typeof entry.name !== "string" || (entry.name.length < 1 || entry.name.length > 64) ||
      tileFromRoomName(entry.name) !== null || names.has(entry.name) ||
      ![entry.seed, entry.tick, entry.width, entry.height].every(Number.isSafeInteger) ||
      entry.seed < 0 || entry.tick < 0 || entry.width < 1 || entry.width > 4096 || entry.height < 1 || entry.height > 4096 ||
      ![entry.createdAt, entry.lastVisitedAt, entry.frozenAt].every((n) => Number.isFinite(n) && n >= 0) ||
      typeof entry.data !== "string" || base64ToBytes(entry.data) === null
    ) {
      throw new Error("salle sauvegardée incohérente");
    }
    names.add(entry.name);
    return entry;
  });
}

export class RoomPersistence {
  private readonly saved = new Map<string, SavedRoom>();
  private readonly active = new Set<string>();

  constructor(private readonly now: () => number, private readonly ttlHours = ROOM_TTL_HOURS) {}

  load(entries: readonly SavedRoom[]): void {
    for (const entry of entries) this.saved.set(entry.name, entry);
    this.prune();
  }

  get size(): number {
    return this.saved.size;
  }

  get(name: string): SavedRoom | undefined {
    return this.saved.get(name);
  }

  visit(name: string): void {
    this.active.add(name);
    const entry = this.saved.get(name);
    if (entry !== undefined) {
      this.saved.set(name, { ...entry, lastVisitedAt: this.now() });
    }
  }

  freeze(name: string): void {
    if (!this.active.delete(name)) {
      return;
    }
    const entry = this.saved.get(name);
    if (entry !== undefined) {
      const at = this.now();
      this.saved.set(name, { ...entry, lastVisitedAt: at, frozenAt: at });
    }
  }

  snapshot(name: string, seed: number, createdAt: number, report: RoomSnapshotReport): void {
    const known = this.saved.get(name);
    if (known !== undefined && report.tick < known.tick) {
      return;
    }
    const at = this.now();
    this.saved.set(name, {
      name, seed, createdAt, ...report, data: bytesToBase64(report.data), lastVisitedAt: at, frozenAt: at,
    });
  }

  restore(name: string, hourMs: number): RoomRestore | undefined {
    const entry = this.saved.get(name);
    if (entry === undefined) {
      return undefined;
    }
    return {
      seed: entry.seed, tick: entry.tick, data: base64ToBytes(entry.data)!,
      width: entry.width, height: entry.height,
      frozenTicks: this.frozenTicksFor(name, hourMs),
    };
  }

  /** Calcul seul : ne redécode pas un snapshot à chaque consultation du temps gelé. */
  frozenTicksFor(name: string, hourMs: number): number {
    const entry = this.saved.get(name);
    return entry === undefined ? 0 : frozenTicksForHours((this.now() - entry.frozenAt) / hourMs);
  }

  /** Les salles occupées ne vieillissent jamais vers le TTL. */
  prune(): string[] {
    const expired: string[] = [];
    for (const [name, entry] of this.saved) {
      if (!this.active.has(name) && this.now() - entry.lastVisitedAt >= this.ttlHours * 3_600_000) {
        this.saved.delete(name);
        expired.push(name);
      }
    }
    return expired;
  }

  toJSON(): SavedRoom[] {
    const at = this.now();
    return [...this.saved.values()].map((entry) => this.active.has(entry.name)
      ? { ...entry, lastVisitedAt: at, frozenAt: at }
      : entry);
  }
}
