/**
 * Démarrage du serveur relais. `PORT` pour changer de port (défaut 8787),
 * `HOST` pour l'interface d'écoute.
 */

import { startServer } from "./server.js";

const port = Number(process.env.PORT ?? 8787);
if (!Number.isInteger(port) || port < 0 || port > 65535) {
  console.error(`PORT invalide : ${process.env.PORT}`);
  process.exit(1);
}

const server = await startServer({ port, ...(process.env.HOST !== undefined ? { host: process.env.HOST } : {}) });
console.log(`[serveur] écoute sur le port ${server.port} — santé : http://127.0.0.1:${server.port}/health`);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[serveur] ${signal} reçu, arrêt`);
    void server.close().then(() => process.exit(0));
  });
}
