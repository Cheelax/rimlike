/** Salles nommées conservées : octets opaques, dates réelles et expiration. */
import { base64ToBytes, bytesToBase64, frozenTicksForHours } from "@rimlike/protocol";

import type { RoomRestore, RoomSnapshotReport } from "./room.js";
import { tileFromRoomName } from "./world.js";

export const ROOM_PERSIST_MS = 30_000;
export const ROOM_TTL_HOURS = 72;
/** Plafond des octets conservés, aligné sur MAX_SNAPSHOT_BYTES par défaut (§2). */
export const MAX_SAVED_SNAPSHOT_BYTES = 8_388_608;

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

/** Même contrat à la réception et à la lecture, sans interpréter le sim. */
function validMetadata(entry: Omit<SavedRoom, "data">): boolean {
  return (
    entry !== null && typeof entry === "object" && !Array.isArray(entry) &&
    typeof entry.name === "string" && entry.name.length >= 1 && entry.name.length <= 64 &&
    tileFromRoomName(entry.name) === null &&
    // Le protocole ne fixe pas de plafond de tick plus bas que l'entier sûr JS.
    [entry.seed, entry.tick, entry.width, entry.height].every(Number.isSafeInteger) &&
    entry.seed >= 0 && entry.tick >= 0 &&
    entry.width >= 1 && entry.width <= 4096 && entry.height >= 1 && entry.height <= 4096 &&
    [entry.createdAt, entry.lastVisitedAt, entry.frozenAt].every((n) => Number.isFinite(n) && n >= 0)
  );
}

function validSavedData(data: unknown): boolean {
  if (typeof data !== "string" || data.length > Math.ceil(MAX_SAVED_SNAPSHOT_BYTES / 3) * 4) {
    return false;
  }
  const bytes = base64ToBytes(data);
  return bytes !== null && bytes.byteLength <= MAX_SAVED_SNAPSHOT_BYTES;
}

/** Une entrée hostile ne condamne ni les autres salles ni l'état du monde. */
export function readSavedRooms(value: unknown, log: (line: string) => void = console.error): SavedRoom[] {
  if (value === undefined) {
    return [];
  }
  if (!Array.isArray(value)) {
    throw new Error("liste de salles sauvegardées invalide");
  }
  const names = new Set<string>();
  const rooms: SavedRoom[] = [];
  for (const [index, entry] of value.entries()) {
    if (!validMetadata(entry) || names.has(entry.name) || !validSavedData(entry.data)) {
      // L'index suffit au diagnostic : aucun contenu fourni par l'hôte dans le journal.
      log(`[monde] salle sauvegardée incohérente à l'index ${index}, ignorée`);
      continue;
    }
    names.add(entry.name);
    rooms.push(entry);
  }
  return rooms;
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
    const at = this.now();
    const entry = { name, seed, createdAt, ...report, lastVisitedAt: at, frozenAt: at };
    if (!validMetadata(entry) || !(report.data instanceof Uint8Array) || report.data.byteLength > MAX_SAVED_SNAPSHOT_BYTES) {
      return;
    }
    const known = this.saved.get(name);
    if (known !== undefined && report.tick < known.tick) {
      return;
    }
    this.saved.set(name, { ...entry, data: bytesToBase64(report.data) });
  }

  /**
   * `hourMs` est la durée réelle d'une heure de jeu et `dayScale` l'échelle du
   * jour de la salle : les deux viennent de la **même** horloge du monde
   * (`WorldClock.hourMs`, `WorldClock.dayScale`), l'une pour compter les
   * heures écoulées, l'autre pour les convertir en ticks de carte.
   */
  restore(name: string, hourMs: number, dayScale?: number): RoomRestore | undefined {
    const entry = this.saved.get(name);
    if (entry === undefined) {
      return undefined;
    }
    return {
      seed: entry.seed, tick: entry.tick, data: base64ToBytes(entry.data)!,
      width: entry.width, height: entry.height,
      frozenTicks: this.frozenTicksFor(name, hourMs, dayScale),
    };
  }

  /** Calcul seul : ne redécode pas un snapshot à chaque consultation du temps gelé. */
  frozenTicksFor(name: string, hourMs: number, dayScale?: number): number {
    const entry = this.saved.get(name);
    return entry === undefined
      ? 0
      : frozenTicksForHours((this.now() - entry.frozenAt) / hourMs, dayScale);
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
