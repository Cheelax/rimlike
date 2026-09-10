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
 * | `ROOM_PERSIST_MS` | 30 000 | intervalle minimal des checkpoints des salles nommées |
 * | `ROOM_TTL_HOURS` | 72 | expiration des salles sans visite, en heures réelles |
 * | `WORLD_DAY_SCALE` | 30 | échelle du jour imposée à toutes les salles (1 à 120) ; 30 = un jour de jeu en 2 h réelles |
 * | `WORLD_HOUR_MS` | dérivé | **tests d'intégration seulement** : force la durée réelle d'une heure de jeu, au lieu de la déduire de `WORLD_DAY_SCALE` |
 * | `CARAVAN_TICK_MS` | 5 000 | période du tick du monde : avancement des caravanes et des marchands, diffusion |
 * | `WORLD_MERCHANTS` | 2 | marchands itinérants entretenus sur le globe ; `0` n'en fait circuler aucun |
 * | `MERCHANT_STAY_HOURS` | 24 | heures de jeu qu'un marchand passe sur une colonie avant de repartir |
 * | `MAX_MESSAGE_BYTES` | 262 144 | taille maximale d'un message texte, sauf `snapshot` |
 * | `MAX_SNAPSHOT_BYTES` | 8 388 608 | taille maximale d'un message `snapshot` |
 * | `MAX_MESSAGES_PER_SECOND` | 120 | messages tolérés par connexion et par seconde |
 * | `MAX_CONNECTIONS_PER_IP` | 16 | connexions simultanées tolérées pour une même adresse IP |
 * | `MAX_ROOMS` | 500 | salles simultanées tolérées sur ce serveur |
 * | `MAX_PLAYERS_PER_ROOM` | 4 | joueurs simultanés tolérés dans une même salle |
 * | `TRUST_PROXY` | (non défini) | `1` : fait confiance à `X-Forwarded-For` pour l'adresse d'un client |
 *
 * `startServer` lui-même ne lit jamais l'environnement (voir `server.ts`) :
 * c'est ce module qui le fait, une fois, et lui passe des options explicites —
 * ce qui inclut la résolution de la persistance disque via
 * `resolveWorldStateFile` (`persistence.ts`).
 */

import {
  CARAVAN_TICK_MS,
  DAY_SCALE_MAX,
  DAY_SCALE_MIN,
  MAX_PLAYERS,
  MERCHANT_COUNT,
  MERCHANT_STAY_HOURS,
  WORLD_DAY_SCALE,
  worldHourMsFor,
} from "@rimlike/protocol";

import { ROOM_PERSIST_MS, ROOM_TTL_HOURS } from "./room-persistence.js";
import { resolveWorldStateFile } from "./persistence.js";
import {
  DEFAULT_MAX_CONNECTIONS_PER_IP,
  DEFAULT_MAX_MESSAGE_BYTES,
  DEFAULT_MAX_MESSAGES_PER_SECOND,
  DEFAULT_MAX_ROOMS,
  DEFAULT_MAX_SNAPSHOT_BYTES,
  startServer,
} from "./server.js";
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
// L'échelle du jour : le seul réglage du rythme du monde (docs/PLAN.md §6).
// Bornes du sim (`sim::DayScale`) ; 30 est la valeur mesurée en campagne.
const worldDayScale = readInteger("WORLD_DAY_SCALE", WORLD_DAY_SCALE, DAY_SCALE_MIN, DAY_SCALE_MAX);
// Surcharge de l'heure de jeu, **pour les tests d'intégration seulement** :
// non définie, l'heure se déduit de l'échelle du jour. Une heure de jeu ne
// descend pas sous la milliseconde, et une journée de monde reste sous la
// journée réelle : au-delà, c'est une erreur de saisie.
const worldHourMs =
  process.env.WORLD_HOUR_MS === undefined || process.env.WORLD_HOUR_MS === ""
    ? undefined
    : readInteger("WORLD_HOUR_MS", worldHourMsFor(worldDayScale), 1, 3_600_000);
const caravanTickMs = readInteger("CARAVAN_TICK_MS", CARAVAN_TICK_MS, 10, 600_000);
// Marchands itinérants (`docs/protocol.md` §13). 0 les désactive complètement ;
// la borne haute n'est là que pour attraper une faute de frappe — un globe à
// 2 562 cases n'a rien à faire de cent marchands.
const merchantCount = readInteger("WORLD_MERCHANTS", MERCHANT_COUNT, 0, 100);
const merchantStayHours = readInteger("MERCHANT_STAY_HOURS", MERCHANT_STAY_HOURS, 0, 8760);

// Garde-fous avant hébergement public (`docs/protocol.md` §2, « Limites »).
const maxMessageBytes = readInteger("MAX_MESSAGE_BYTES", DEFAULT_MAX_MESSAGE_BYTES, 1024, 100_000_000);
const maxSnapshotBytes = readInteger("MAX_SNAPSHOT_BYTES", DEFAULT_MAX_SNAPSHOT_BYTES, 1024, 100_000_000);
const maxMessagesPerSecond = readInteger("MAX_MESSAGES_PER_SECOND", DEFAULT_MAX_MESSAGES_PER_SECOND, 1, 100_000);
const maxConnectionsPerIp = readInteger("MAX_CONNECTIONS_PER_IP", DEFAULT_MAX_CONNECTIONS_PER_IP, 1, 100_000);
const maxRooms = readInteger("MAX_ROOMS", DEFAULT_MAX_ROOMS, 1, 1_000_000);
const maxPlayersPerRoom = readInteger("MAX_PLAYERS_PER_ROOM", MAX_PLAYERS, 1, 64);
const trustProxy = process.env.TRUST_PROXY === "1";

const worldStateFile = resolveWorldStateFile(process.env);
const roomPersistMs = readInteger("ROOM_PERSIST_MS", ROOM_PERSIST_MS, 1, 2_147_483_647);
const roomTtlHours = readInteger("ROOM_TTL_HOURS", ROOM_TTL_HOURS, 1, 876_000);

const server = await startServer({
  port,
  worldSeed,
  worldSubdivisions,
  worldStateFile,
  roomPersistMs,
  roomTtlHours,
  worldDayScale,
  ...(worldHourMs === undefined ? {} : { worldHourMs }),
  caravanTickMs,
  merchantCount,
  merchantStayHours,
  maxMessageBytes,
  maxSnapshotBytes,
  maxMessagesPerSecond,
  maxConnectionsPerIp,
  maxRooms,
  trustProxy,
  roomOptions: { maxPlayers: maxPlayersPerRoom },
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
  `[serveur] échelle du jour : K = ${worldDayScale} — 1 jour de jeu = ${14_400 * worldDayScale} ticks, ` +
    // ticks → secondes (60 ticks/s) → heures réelles.
    `soit ${((14_400 * worldDayScale) / 60 / 3600).toFixed(1)} h réelles`,
);
console.log(
  `[serveur] horloge du monde : 1 h de jeu = ${server.world.clock.hourMs} ms réelles` +
    `${worldHourMs === undefined ? " (dérivée de l'échelle)" : " (WORLD_HOUR_MS, surcharge de test)"}, ` +
    `tick des caravanes toutes les ${caravanTickMs} ms`,
);
console.log(
  merchantCount === 0
    ? "[serveur] marchands itinérants désactivés (WORLD_MERCHANTS=0)"
    : `[serveur] ${merchantCount} marchand(s) itinérant(s), ${merchantStayHours} h de jeu par visite`,
);
console.log(
  `[serveur] limites : message ${maxMessageBytes} o (snapshot ${maxSnapshotBytes} o), ` +
    `${maxMessagesPerSecond} msg/s, ${maxConnectionsPerIp} connexion(s)/IP, ${maxRooms} salle(s), ` +
    `${maxPlayersPerRoom} joueur(s)/salle${trustProxy ? ", X-Forwarded-For de confiance" : ""}`,
);

for (const signal of ["SIGINT", "SIGTERM"] as const) {
  process.once(signal, () => {
    console.log(`[serveur] ${signal} reçu, arrêt`);
    void server.close().then(() => process.exit(0));
  });
}
