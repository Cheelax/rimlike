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
- `GET /rooms` — liste des salles ouvertes (lobby, en jeu, désynchronisées),
  pour un écran « parties en cours » avant même de rejoindre. Voir plus bas.
- l'upgrade WebSocket — lobby de salles (une carte, lockstep) et couche monde
  (rejoindre le globe, fonder/visiter/abandonner une colonie, faire voyager
  une caravane).

Il fait aussi circuler, de son propre chef, des **marchands itinérants** PNJ
d'une colonie à l'autre (`docs/protocol.md` §13, `WORLD_MERCHANTS`) : c'est la
seule chose qu'il « joue » lui-même, et encore, il ne simule rien — il annonce
l'arrivée à l'hôte de la colonie visitée, qui émet la commande correspondante
en lockstep.

## `GET /rooms` — découverte des salles

Détail complet du format et des invariants : `docs/protocol.md` §2,
« Découverte des salles ». En bref :

```
GET /rooms                → toutes les salles (au plus 200, les plus récentes)
GET /rooms?state=lobby    → uniquement celles qui attendent des joueurs
GET /rooms?q=alice        → recherche insensible à la casse sur le nom
```

Réponse : `{ rooms: [...], truncated: boolean }`, triée lobbies d'abord puis
par nom. Une salle « case » du monde (`tile-<id>`) porte en plus `isTile: true`,
`tile` et `ownerName` (le nom d'affichage résolu de la colonie — jamais la clé
du propriétaire ni un jeton : cette liste ne transporte aucun secret). Sans
cache (`Cache-Control: no-store`, contrairement à `GET /world`) : cette liste
change à chaque `join`/`leave`/`start`. Le nombre de salles renvoyées est
plafonné par `maxListedRooms` de `ServerOptions` (200 par défaut, pas de
variable d'environnement dédiée) ; `truncated` signale le dépassement, et le
filtrage (`state`/`q`) s'applique **après** cette troncature — un serveur qui
héberge plus de 200 salles n'en laisse jamais deviner le nombre réel par ce
chemin. `GET /health` porte le résumé correspondant (`roomsByState`).

## Salles nommées persistantes

Une salle en jeu est conservée dès réception d'un snapshot de son hôte,
qu'il soit périodique (`request_snapshot { forPlayer: 0 }`, toutes les
1 800 ticks) ou destiné à un rejoignant. Le fichier `WORLD_STATE_FILE`,
version **5** (versions 1 à 4 toujours relues), contient un tableau `rooms`
à côté de `state` : nom, graine, dimensions, tick, octets en base64, date de
création, dernière présence et début du gel. Un lobby ou une partie sans
snapshot ne peut pas être restauré.

Les écritures du fichier commun sont atomiques et sérialisées. Dès qu'il
contient des salles nommées, les écritures automatiques, y compris celles
sollicitées par le monde, sont espacées d'au moins `ROOM_PERSIST_MS` (30 s) ;
les rapports rapprochés sont regroupés sans repousser sans fin l'écriture.
`SIGINT`/`SIGTERM` forcent une dernière sauvegarde du dernier snapshot reçu.
Un arrêt brutal reprend le dernier checkpoint disque : les commandes plus
récentes que son snapshot sont perdues, le serveur ne simule pas.

Au redémarrage, les salles sauvées sont gelées, sans hôte ni horloge, et
figurent dans `GET /rooms` avec `state: "running"` et zéro joueur. Le premier
`join` reçoit `welcome` puis `snapshot`, sans nouveau `start`, et devient
hôte. `frozenTicks` compte le temps réel depuis l'arrêt (ou le dernier
checkpoint en cas de crash), jusqu'à ce `join`, converti selon l'heure de jeu
du monde (dérivée de `WORLD_DAY_SCALE`) et borné à 60 jours de jeu, eux aussi
mis à l'échelle. Une salle vidée se gèle au dernier départ.
Le client sait déjà appliquer cette avance rapide en lockstep : rien à changer.

Une salle sans présence depuis `ROOM_TTL_HOURS` (72 h) est oubliée ; un arrêt
ou une sauvegarde sans visite ne renouvelle pas cette durée. Les salles
occupées n'expirent pas. Les salles gelées comptent dans `MAX_ROOMS`.
Le comportement des colonies `tile-N` reste celui du monde (notamment son
horloge, arrêtée serveur éteint). `WORLD_PERSIST=0` ou un chemin vide désactive
également la persistance des salles nommées.

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
| `WORLD_STATE_FILE` | `apps/server/data/world-state.json` | Fichier de persistance de l'état du monde et des salles nommées (colonies, joueurs, caravanes, snapshots). Chaîne vide = persistance désactivée (mode mémoire). |
| `WORLD_PERSIST` | (non défini) | `0` désactive la persistance, quel que soit `WORLD_STATE_FILE`. |
| `ROOM_PERSIST_MS` | `30000` | Intervalle minimal entre checkpoints automatiques quand des salles nommées sont conservées, en ms. |
| `ROOM_TTL_HOURS` | `72` | Oublie une salle nommée après cette durée sans présence, en heures réelles. |
| `WORLD_DAY_SCALE` | `30` | **Échelle du jour** imposée à toutes les salles de ce serveur (1 à 120, `sim::DayScale`), envoyée dans `start.dayScale`. Un jour de jeu dure `14 400 × K` ticks : à 30, deux heures réelles (une saison en 30 h, une année en 5 jours). C'est aussi **la seule horloge du monde** — la durée d'une heure de jeu, les caravanes, les marchands et le temps gelé en découlent. Se décide **avant la première colonie** : la changer sur un monde peuplé laisse les sims conservés à leur ancienne échelle. |
| `WORLD_HOUR_MS` | (dérivé : `10 000 × WORLD_DAY_SCALE`, soit 300 000) | **Tests d'intégration seulement.** Force la durée réelle d'une heure de jeu du monde, en ms, au lieu de la déduire de `WORLD_DAY_SCALE` — utile pour faire voyager une caravane en quelques secondes. Un vrai monde ne la définit pas. |
| `CARAVAN_TICK_MS` | `5000` | Période du tick du monde : avancement des caravanes en route **et des marchands itinérants**, diffusion aux joueurs connectés. |
| `WORLD_MERCHANTS` | `2` | Marchands itinérants PNJ entretenus sur le globe (`docs/protocol.md` §13) : ils circulent de colonie en colonie et préviennent l'hôte de celle où ils s'arrêtent. `0` n'en fait circuler aucun. |
| `MERCHANT_STAY_HOURS` | `24` | Heures de jeu qu'un marchand passe sur une colonie avant de repartir vers la suivante (24 = un jour de monde). |
| `MAX_MESSAGE_BYTES` | `262144` | Taille maximale d'un message texte (octets UTF-8), sauf `snapshot` (voir `MAX_SNAPSHOT_BYTES`). Dépassement : `error { code: "message_too_large" }` puis fermeture (code WebSocket 1009). |
| `MAX_SNAPSHOT_BYTES` | `8388608` | Taille maximale d'un message `snapshot` : plus généreuse, il transporte l'état d'une carte entière en base64. |
| `MAX_MESSAGES_PER_SECOND` | `120` | Messages tolérés par connexion sur une fenêtre glissante d'une seconde (le `pong` ne compte pas). Au-delà : `error { code: "rate_limited" }` ; si le dépassement persiste sans interruption pendant 3 s, la connexion est fermée. |
| `MAX_CONNECTIONS_PER_IP` | `16` | Connexions simultanées tolérées pour une même adresse IP. Au-delà, refus à l'upgrade WebSocket (HTTP 429). |
| `MAX_ROOMS` | `500` | Salles simultanées tolérées sur ce serveur (salles ordinaires et salles « case » confondues). Un `join`/`settle` qui en créerait une de plus est refusé (`error { code: "server_full" }`). |
| `MAX_PLAYERS_PER_ROOM` | `4` | Joueurs simultanés tolérés dans une même salle. |
| `TRUST_PROXY` | (non défini) | `1` : fait confiance à l'en-tête `X-Forwarded-For` pour l'adresse d'un client (uniquement derrière un reverse proxy de confiance qui pose lui-même cet en-tête). |

Une valeur absurde (hors bornes, non entière) fait échouer le démarrage avec
un message d'erreur explicite plutôt que de partir sur un défaut silencieux.

Les valeurs effectives de ces garde-fous, ainsi que le nombre de connexions
ouvertes, sont exposées par `GET /health` (`limits`, `connections`) — utile
pour vérifier ce qui tourne réellement sans avoir à relire l'environnement du
processus. Un nom de joueur (`join.name`, `world_join.name`) est en outre
toujours limité à 32 caractères, sans caractère de contrôle, quelle que soit
la configuration (`error { code: "bad_name" }` sinon) : ce n'est pas une
variable d'environnement, juste une borne fixe.

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
