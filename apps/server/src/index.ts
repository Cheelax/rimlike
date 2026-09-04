/**
 * Démarrage du serveur relais et monde. Variables d'environnement :
 *
 * | variable | défaut | rôle |
 * |---|---|---|
 * | `PORT` | 8787 | port HTTP et WebSocket |
 * | `HOST` | toutes | interface d'écoute |
 * | `WORLD_SEED` | 1 | graine du globe |
 * | `WORLD_SUBDIVISIONS` | 4 | subdivisions (4 = 2 562 cases, 5 = 10 242 en production) |
 */

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

const server = await startServer({
  port,
  worldSeed,
  worldSubdivisions,
  ...(process.env.HOST !== undefined ? { host: process.env.HOST } : {}),
});
console.log(
  `[serveur] écoute sur le port ${server.port} — santé : http://127.0.0.1:${server.port}/health, globe : http://127.0.0.1:${server.port}/world`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[serveur] ${signal} reçu, arrêt`);
    void server.close().then(() => process.exit(0));
  });
}
