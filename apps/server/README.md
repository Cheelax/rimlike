# `apps/server` — relais WebSocket + serveur monde

Ce paquet est le relais réseau du jeu (phase 3) et le serveur du globe
partagé (phase 4). Il **ne simule rien** : le sim (`crates/sim`) tourne
uniquement chez chaque client, déterministe. Le serveur est autorité sur deux
choses seulement — la numérotation des ticks et l'ordre des commandes d'une
salle — et sert la géométrie du globe (`@rimlike/world`) sans jamais décoder
une commande de joueur. Protocole complet : `docs/protocol.md`.

Concrètement, un seul processus expose sur un port HTTP/WebSocket unique :

- `GET /health` — diagnostic (salles ouvertes, état du globe, persistance).
- `GET /world` — géométrie complète du globe (`WorldWire`), gzippée, mise en
  cache une heure côté client, jamais régénérée côté client.
- l'upgrade WebSocket — lobby de salles (une carte, lockstep) et couche monde
  (rejoindre le globe, fonder/visiter/abandonner une colonie, faire voyager
  une caravane).

## Variables d'environnement

Lues une seule fois par `src/index.ts` au démarrage (`startServer` lui-même,
dans `src/server.ts`, ne lit jamais l'environnement — il reçoit des options
explicites).

| Variable | Défaut | Rôle |
|---|---|---|
| `PORT` | `8787` | Port HTTP et WebSocket. |
| `HOST` | (toutes les interfaces) | Interface d'écoute. |
| `WORLD_SEED` | `1` | Graine du globe généré au démarrage. |
| `WORLD_SUBDIVISIONS` | `4` | Subdivisions de l'icosaèdre : `4` = 2 562 cases (défaut), `5` = 10 242 cases (recommandé en production), max `6`. |
| `WORLD_STATE_FILE` | `apps/server/data/world-state.json` | Fichier de persistance de l'état du monde (colonies, joueurs, caravanes). Chaîne vide = persistance désactivée (mode mémoire). |
| `WORLD_PERSIST` | (non défini) | `0` désactive la persistance, quel que soit `WORLD_STATE_FILE`. |
| `WORLD_HOUR_MS` | `30000` | Durée réelle d'une heure de jeu du monde, en ms (30 000 = un jour de monde en 12 min réelles). |
| `CARAVAN_TICK_MS` | `5000` | Période du tick du monde : avancement des caravanes en route et diffusion aux joueurs connectés. |

Une valeur absurde (hors bornes, non entière) fait échouer le démarrage avec
un message d'erreur explicite plutôt que de partir sur un défaut silencieux.

Changer `WORLD_SEED`/`WORLD_SUBDIVISIONS` sur un serveur qui a déjà un
fichier d'état régénère un **globe différent** : les colonies existantes ne
s'y retrouvent pas, le fichier est alors mis en quarantaine (renommé, jamais
supprimé) plutôt qu'interprété à moitié — voir `src/persistence.ts` et
`deploy/README.md` (« Changer le globe »).

## Scripts

| Script | Rôle |
|---|---|
| `pnpm dev` | Développement : `tsx watch`, relance sur chaque changement. |
| `pnpm start` | Démarrage direct via `tsx`, sans compilation préalable. |
| `pnpm typecheck` | `tsc --noEmit` (le paquet reste sans émission par défaut). |
| `pnpm test` | Tests du relais et du monde, vrais WebSockets sur port éphémère. |
| `pnpm build:server` | Compile `src/` **et** `@rimlike/protocol`/`@rimlike/world` (TS brut) vers `dist/`, pour lancer avec `node` seul en production — voir `tsconfig.build.json` et les commentaires de `Dockerfile`. |
| `pnpm start:server` | `node dist/apps/server/src/index.js` : le point d'entrée compilé. |

`pnpm build:server` doit toujours précéder `pnpm start:server` (`dist/`
n'est pas versionné, et n'est pas recréé par les autres scripts).

## Conteneuriser / déployer

Voir `Dockerfile` (choix de compilation détaillé en tête de fichier) et
`deploy/README.md` (construire, lancer, vérifier `/health`, sauvegarder les
données, changer le globe, brancher le client, `wss://` derrière un reverse
proxy).
