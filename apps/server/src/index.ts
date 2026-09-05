/**
 * Démarrage du serveur relais et monde. Variables d'environnement :
 *
 * | variable | défaut | rôle |
 * |---|---|---|
 * | `PORT` | 8787 | port HTTP et WebSocket |
 * | `HOST` | toutes | interface d'écoute |
 * | `WORLD_SEED` | 1 | graine du globe |
 * | `WORLD_SUBDIVISIONS` | 4 | subdivisions (4 = 2 562 cases, 5 = 10 242 en production) |
 * | `WORLD_STATE_FILE` | `apps/server/data/world-state.json` | fichier de persistance du monde ; vide désactive |
 * | `WORLD_PERSIST` | (non défini) | `0` désactive la persistance, quel que soit `WORLD_STATE_FILE` |
 * | `WORLD_HOUR_MS` | 30 000 | durée réelle d'une heure de jeu du monde (30 s = un jour de monde en 12 min) |
 * | `CARAVAN_TICK_MS` | 5 000 | période du tick du monde : avancement des caravanes et diffusion |
 *
 * `startServer` lui-même ne lit jamais l'environnement (voir `server.ts`) :
 * c'est ce module qui le fait, une fois, et lui passe des options explicites —
 * ce qui inclut la résolution de la persistance disque via
 * `resolveWorldStateFile` (`persistence.ts`).
 */

import { CARAVAN_TICK_MS, WORLD_HOUR_MS } from "@rimlike/protocol";

import { resolveWorldStateFile } from "./persistence.js";
import { startServer } from "./server.js";
import { DEFAULT_WORLD_SEED, DEFAULT_WORLD_SUBDIVISIONS } from "./world.js";

/** Lit un entier d'environnement, ou sort en erreur si la valeur est absurde. */
function readInteger(name: string, fallback: number, min: number, max: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") {
    return fallback;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    console.error(`${name} invalide : ${raw} (entier attendu dans [${min}, ${max}])`);
    process.exit(1);
  }
  return value;
}

const port = readInteger("PORT", 8787, 0, 65535);
const worldSeed = readInteger("WORLD_SEED", DEFAULT_WORLD_SEED, 0, Number.MAX_SAFE_INTEGER);
const worldSubdivisions = readInteger("WORLD_SUBDIVISIONS", DEFAULT_WORLD_SUBDIVISIONS, 0, 6);
// Une heure de jeu ne descend pas sous la milliseconde, et une journée de
// monde reste sous la journée réelle : au-delà, c'est une erreur de saisie.
const worldHourMs = readInteger("WORLD_HOUR_MS", WORLD_HOUR_MS, 1, 3_600_000);
const caravanTickMs = readInteger("CARAVAN_TICK_MS", CARAVAN_TICK_MS, 10, 600_000);

const worldStateFile = resolveWorldStateFile(process.env);

const server = await startServer({
  port,
  worldSeed,
  worldSubdivisions,
  worldStateFile,
  worldHourMs,
  caravanTickMs,
  ...(process.env.HOST !== undefined ? { host: process.env.HOST } : {}),
});
console.log(
  `[serveur] écoute sur le port ${server.port} — santé : http://127.0.0.1:${server.port}/health, globe : http://127.0.0.1:${server.port}/world`,
);
console.log(
  worldStateFile === null
    ? "[serveur] persistance du monde désactivée (mode mémoire)"
    : `[serveur] persistance du monde : ${worldStateFile}`,
);
console.log(
  `[serveur] horloge du monde : 1 h de jeu = ${worldHourMs} ms réelles, tick des caravanes toutes les ${caravanTickMs} ms`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[serveur] ${signal} reçu, arrêt`);
    void server.close().then(() => process.exit(0));
  });
}
