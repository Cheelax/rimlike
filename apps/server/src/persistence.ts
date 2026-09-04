/**
 * Persistance disque de `WorldState` : un fichier JSON unique, écrit de façon
 * **atomique** (fichier `.tmp` puis renommage) et au plus une fois toutes les
 * `debounceMs` millisecondes malgré des changements rapprochés (fondation,
 * abandon, snapshot de conservation) — voir `scheduleSave`.
 *
 * Le fichier porte un en-tête `{ version, worldSeed, subdivisions, savedAt }`
 * en plus de l'état sérialisé par `WorldState.toJSON()`. Au chargement :
 *
 * - absent → première fois, monde vide, rien d'anormal ;
 * - `worldSeed`/`subdivisions` différents du globe généré → les colonies ont
 *   été posées sur d'autres biomes, le fichier est **inutilisable** ;
 * - JSON illisible, forme inattendue, ou `WorldState.fromJSON` qui échoue
 *   (colonie sur une case qui n'existe plus, snapshot en base64 invalide) →
 *   même traitement, prudence : on ne devine pas un état à moitié lisible.
 *
 * Dans les deux derniers cas le fichier est renommé
 * `<fichier>.ignored-<horodatage>.json` plutôt que supprimé (l'opérateur peut
 * toujours aller y regarder) et le serveur repart d'un monde vide. Une
 * écriture qui échoue (disque plein, permissions) est journalisée sur stderr
 * et n'interrompt jamais le serveur : `save` et le déclenchement différé de
 * `scheduleSave` n'ont rien à faire lever à leur appelant.
 */

import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { fileURLToPath } from "node:url";

import type { World } from "@rimlike/world";

import { WorldState, type WorldStateJson } from "./world.js";

/** Version du format de fichier. À monter si `WorldStateJson` change de façon incompatible. */
export const WORLD_STATE_FILE_VERSION = 1;

/** Délai de débounce par défaut entre deux écritures, en millisecondes. */
export const SAVE_DEBOUNCE_MS = 2000;

/**
 * Chemin par défaut de `WORLD_STATE_FILE` : `apps/server/data/world-state.json`,
 * résolu depuis ce module (et non depuis le répertoire courant du processus,
 * qui varie selon comment le serveur est lancé — `pnpm --filter server` s'y
 * place, un `tsx src/index.ts` direct depuis la racine non).
 */
export const DEFAULT_WORLD_STATE_FILE = fileURLToPath(new URL("../data/world-state.json", import.meta.url));

/** Forme sur disque : l'état du monde encadré d'un en-tête de version. */
export interface WorldStateFile {
  readonly version: 1;
  readonly worldSeed: number;
  readonly subdivisions: number;
  /** Date de cet enregistrement, en millisecondes epoch. */
  readonly savedAt: number;
  readonly state: WorldStateJson;
}

export type WorldStoreLoadResult =
  | { readonly kind: "none" }
  | { readonly kind: "loaded"; readonly state: WorldState; readonly savedAt: number }
  | {
      readonly kind: "ignored";
      readonly reason: "mismatch" | "corrupt";
      /** Chemin du fichier renommé, `null` si le renommage lui-même a échoué. */
      readonly quarantineFile: string | null;
    };

export interface WorldStoreOptions {
  /** Fichier JSON unique portant tout l'état. */
  readonly file: string;
  /** Graine du globe généré par ce serveur : valide le fichier au chargement. */
  readonly worldSeed: number;
  readonly subdivisions: number;
  /** Horloge des dates (`savedAt`, horodatage de quarantaine). Défaut : `Date.now`. */
  readonly now?: () => number;
  /** Diagnostics (erreurs d'écriture, avertissements de chargement). Défaut : `console.error` (stderr). */
  readonly log?: (line: string) => void;
  /** Délai de débounce, injectable pour les tests. Défaut : `SAVE_DEBOUNCE_MS`. */
  readonly debounceMs?: number;
}

/**
 * Résout `WORLD_STATE_FILE`/`WORLD_PERSIST` en un chemin de fichier, ou
 * `null` si la persistance doit rester désactivée (mode mémoire). C'est le
 * mode par défaut de `startServer` (aucune de ces variables n'est lue là-bas :
 * un appelant qui ne précise pas `worldStateFile` reste en mémoire, ce qui
 * inclut tous les tests existants) — seul `index.ts`, qui démarre le vrai
 * process, doit s'en soucier.
 */
export function resolveWorldStateFile(env: NodeJS.ProcessEnv = process.env): string | null {
  if (env.WORLD_PERSIST === "0") {
    return null;
  }
  const raw = env.WORLD_STATE_FILE;
  if (raw === "") {
    return null;
  }
  return raw ?? DEFAULT_WORLD_STATE_FILE;
}

/** Validation minimale de la forme du fichier, avant de faire confiance au contenu. */
function isWorldStateFile(value: unknown): value is WorldStateFile {
  if (typeof value !== "object" || value === null) {
    return false;
  }
  const candidate = value as Partial<WorldStateFile>;
  return (
    candidate.version === WORLD_STATE_FILE_VERSION &&
    typeof candidate.worldSeed === "number" &&
    typeof candidate.subdivisions === "number" &&
    typeof candidate.savedAt === "number" &&
    typeof candidate.state === "object" &&
    candidate.state !== null
  );
}

export class WorldStore {
  readonly file: string;
  private readonly worldSeed: number;
  private readonly subdivisions: number;
  private readonly now: () => number;
  private readonly log: (line: string) => void;
  private readonly debounceMs: number;

  private timer: NodeJS.Timeout | null = null;
  private pendingState: WorldState | null = null;
  private lastSavedAtValue: number | null = null;

  constructor(options: WorldStoreOptions) {
    this.file = options.file;
    this.worldSeed = options.worldSeed;
    this.subdivisions = options.subdivisions;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? ((line) => console.error(line));
    this.debounceMs = options.debounceMs ?? SAVE_DEBOUNCE_MS;
  }

  /** Date de la dernière écriture réussie, `null` si aucune n'a encore eu lieu. */
  get lastSavedAt(): number | null {
    return this.lastSavedAtValue;
  }

  /**
   * Relit le fichier. `world` est le globe déjà généré par ce serveur : il
   * sert à la fois de référence pour valider `worldSeed`/`subdivisions` et à
   * reconstruire le `WorldState` (`WorldState.fromJSON`).
   */
  async load(world: World): Promise<WorldStoreLoadResult> {
    let raw: string;
    try {
      raw = await readFile(this.file, "utf8");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        return { kind: "none" };
      }
      this.log(`[monde] lecture de l'état impossible (${this.file}) : ${String(error)}`);
      return { kind: "ignored", reason: "corrupt", quarantineFile: null };
    }

    let parsed: WorldStateFile;
    try {
      const candidate: unknown = JSON.parse(raw);
      if (!isWorldStateFile(candidate)) {
        throw new Error("forme de fichier inattendue");
      }
      parsed = candidate;
    } catch (error) {
      const quarantineFile = await this.quarantine();
      this.log(
        `[monde] fichier d'état illisible (${String(error)}), ignoré` +
          (quarantineFile !== null ? ` et renommé vers ${quarantineFile}` : " (renommage impossible)"),
      );
      return { kind: "ignored", reason: "corrupt", quarantineFile };
    }

    if (parsed.worldSeed !== this.worldSeed || parsed.subdivisions !== this.subdivisions) {
      const quarantineFile = await this.quarantine();
      this.log(
        `[monde] fichier d'état pour un autre globe (seed ${parsed.worldSeed}, subdivision ${parsed.subdivisions}) ` +
          `que celui généré ici (seed ${this.worldSeed}, subdivision ${this.subdivisions}) : les colonies ne ` +
          `peuvent pas survivre à un changement de globe. Fichier ignoré` +
          (quarantineFile !== null ? ` et renommé vers ${quarantineFile}` : " (renommage impossible)"),
      );
      return { kind: "ignored", reason: "mismatch", quarantineFile };
    }

    try {
      const state = WorldState.fromJSON(parsed.state, { world });
      return { kind: "loaded", state, savedAt: parsed.savedAt };
    } catch (error) {
      const quarantineFile = await this.quarantine();
      this.log(
        `[monde] état sauvegardé incohérent (${String(error)}), ignoré` +
          (quarantineFile !== null ? ` et renommé vers ${quarantineFile}` : " (renommage impossible)"),
      );
      return { kind: "ignored", reason: "corrupt", quarantineFile };
    }
  }

  /**
   * Écriture immédiate et atomique : dans `<fichier>.tmp` puis renommage, pour
   * qu'un lecteur (ou un crash en cours d'écriture) ne voie jamais un JSON à
   * moitié écrit. N'échoue jamais à l'appelant : une erreur est journalisée et
   * avalée, une écriture ratée n'arrête pas le serveur. Annule aussi toute
   * écriture différée par `scheduleSave` : cette écriture-ci la rend obsolète.
   */
  async save(state: WorldState): Promise<void> {
    this.cancelScheduled();
    try {
      const payload: WorldStateFile = {
        version: WORLD_STATE_FILE_VERSION,
        worldSeed: this.worldSeed,
        subdivisions: this.subdivisions,
        savedAt: this.now(),
        state: state.toJSON(),
      };
      await mkdir(dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      await writeFile(tmp, JSON.stringify(payload), "utf8");
      await rename(tmp, this.file);
      this.lastSavedAtValue = payload.savedAt;
    } catch (error) {
      this.log(`[monde] échec de sauvegarde de l'état (${this.file}) : ${String(error)}`);
    }
  }

  /**
   * Programme une écriture, au plus une toutes les `debounceMs` : des appels
   * rapprochés (une fondation puis un abandon, par exemple) ne réécrivent le
   * fichier qu'une fois, avec le dernier état passé au moment où le délai
   * s'écoule. `state` n'a besoin d'être qu'une référence : c'est l'objet
   * `WorldState` du serveur, dont le contenu continue de changer jusqu'à
   * l'écriture effective.
   */
  scheduleSave(state: WorldState): void {
    this.pendingState = state;
    if (this.timer !== null) {
      clearTimeout(this.timer);
    }
    this.timer = setTimeout(() => {
      this.timer = null;
      const toSave = this.pendingState;
      this.pendingState = null;
      if (toSave !== null) {
        void this.save(toSave);
      }
    }, this.debounceMs);
    this.timer.unref?.();
  }

  /** Annule une écriture programmée non encore déclenchée, sans rien écrire. */
  private cancelScheduled(): void {
    if (this.timer !== null) {
      clearTimeout(this.timer);
      this.timer = null;
    }
    this.pendingState = null;
  }

  /** Renomme le fichier corrompu ou incompatible plutôt que de le supprimer. */
  private async quarantine(): Promise<string | null> {
    const target = `${this.file}.ignored-${this.now()}.json`;
    try {
      await rename(this.file, target);
      return target;
    } catch (error) {
      this.log(`[monde] impossible de mettre en quarantaine ${this.file} : ${String(error)}`);
      return null;
    }
  }
}
