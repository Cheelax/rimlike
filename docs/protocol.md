# Protocole réseau — phase 3 (une carte, lockstep) et phase 4 (le monde)

Ce document décrit le protocole entre un client et le serveur (`apps/server`),
tel qu'implémenté par `packages/protocol`. Il est la référence pour
l'intégration côté client.

Les sections 1 à 10 décrivent le **lockstep sur une carte** : c'est la couche
de base, inchangée. La section 11 décrit la **couche monde** : le globe
partagé, les colonies et les salles adossées à une case, qui se posent
au-dessus sans rien modifier de ce qui précède. La section 12 décrit les
**caravanes**, qui font voyager colons et marchandises d'une case à l'autre —
et donc d'une salle à l'autre.

## 1. Principes

- Le sim est **déterministe** et tourne à 60 ticks/s **chez chaque client**.
- Le serveur **ne simule pas**. Il est autorité sur deux choses seulement :
  la **numérotation des ticks** et l'**ordre des commandes**. Il relaie.
- Une commande de joueur est une suite d'**octets opaques** produite par le sim
  (encodage postcard d'une `Command`). Le serveur ne la décode jamais.
- Le serveur **n'attend personne** : son horloge est continue, il n'y a pas de
  pause en multi (décision du plan, `docs/PLAN.md` §3). Un client en retard
  rattrape plusieurs ticks d'un coup.

Constantes partagées (`packages/protocol/src/messages.ts`) :

| Constante | Valeur | Rôle |
|---|---|---|
| `PROTOCOL_VERSION` | 2 | Incrémentée à chaque changement incompatible (2 : identité par jeton, §11.2) |
| `TICK_RATE` | 60 | Ticks de sim par seconde |
| `BUNDLE_TICKS` | 3 | Ticks par bundle, donc 20 bundles/s |
| `BUNDLE_INTERVAL_MS` | 50 | Période d'émission d'un bundle |
| `HASH_EVERY_TICKS` | 300 | Période d'envoi du hash d'état (5 s) |
| `TICKS_PER_DAY` | 14400 | Ticks d'une journée de jeu sur une carte (contrat avec le sim) |
| `TICKS_PER_HOUR` | 600 | Ticks d'une **heure de jeu du monde** : le taux de change du temps gelé (§11.6) |
| `MAX_FROZEN_TICKS` | 864000 | Avance rapide maximale d'une colonie gelée : 60 jours |
| `SNAPSHOT_EVERY_TICKS` | 1800 | Période du snapshot de conservation d'une case (30 s) |
| `MAX_HISTORY_BUNDLES` | 2000 | Historique conservé par salle (100 s) |
| `HEARTBEAT_MS` | 5000 | Période du `ping` serveur |
| `HEARTBEAT_TIMEOUT_MS` | 15000 | Silence toléré avant fermeture |
| `MAX_PLAYERS` | 4 | Joueurs par salle |
| `WORLD_HOUR_MS` | 30000 | Durée réelle d'une **heure de jeu** du monde (§12.1) |
| `CARAVAN_TICK_MS` | 5000 | Période du tick du monde et du `world_caravans` |
| `CARAVAN_HISTORY_HOURS` | 24 | Heures de jeu pendant lesquelles une caravane livrée reste listée |

## 2. Transport et format

- WebSocket, une connexion = un joueur = une salle, plus éventuellement le
  monde (§11). `http.createServer` sert aussi `GET /health` →
  `{"ok":true,"rooms":2,"world":{"seed":1,"subdivisions":4,"tiles":2562,"settlements":3}}`
  et `GET /world` sur le même port (`PORT`, défaut 8787).
- Messages de contrôle en **JSON**, un objet par trame, discriminé par `type`.
- Les charges binaires (`command.payload`, `snapshot.data`, les `payload` des
  commandes d'un bundle) voyagent en **base64 standard** dans le JSON.
- Toute trame illisible ou hors schéma est refusée par `error`. La validation
  est écrite à la main dans `codec.ts` (`validateClientMessage`,
  `validateServerMessage`) : pas de dépendance de schéma.

```ts
import { decodeClientMessage, encodeMessage } from "@rimlike/protocol";

socket.send(encodeMessage({ type: "command", payload: bytes })); // Uint8Array → base64
const message = decodeClientMessage(text); // null si invalide
```

## 3. Messages

### 3.1 Client → serveur

**`join`** — premier message de la connexion. Crée la salle si elle n'existe
pas. `protocol` est facultatif ; s'il est présent et différent de
`PROTOCOL_VERSION`, le serveur répond `error version_mismatch` et ferme.

```json
{ "type": "join", "room": "demo", "name": "alice", "protocol": 1 }
```

**`start`** — réservé au host, en salle `lobby`. Fixe la graine et la taille de
la carte pour tout le monde.

```json
{ "type": "start", "seed": 12345, "width": 128, "height": 128 }
```

**`command`** — une commande du joueur, en octets opaques (base64).

```json
{ "type": "command", "payload": "AQAAAAAFAAAABwAAAA==" }
```

**`hash`** — hash d'état, tous les `HASH_EVERY_TICKS` ticks. `tick` est le
nombre de ticks déjà appliqués, `hash` la sortie de `WasmSim.hash()`.

```json
{ "type": "hash", "tick": 300, "hash": "3f0a1c77b2e94d10" }
```

**`snapshot`** — réponse du host à `request_snapshot`. `tick` = prochain tick à
exécuter au moment du snapshot. `forPlayer` est facultatif : sans lui, le
serveur sert **tous** les joueurs en attente (utile si deux joueurs arrivent
ensemble).

```json
{ "type": "snapshot", "tick": 1806, "data": "8QIAAAcAAAA=", "forPlayer": 3 }
```

**`ping`** / **`pong`** — heartbeat. Le serveur envoie `ping` toutes les 5 s, le
client répond `pong` (n'importe quelle trame reçue rafraîchit le compteur). Un
client peut aussi envoyer `ping`, le serveur répond `pong`.

```json
{ "type": "pong" }
```

**`resync`** — demande explicite d'une resynchronisation sur l'état de l'hôte
(§7) : le serveur y répond comme pour un rejoignant (`request_snapshot` à
l'hôte puis `snapshot` et rejeu). Refusé pour l'hôte (`host_cannot_resync`),
hors salle démarrée (`not_running`) ou trop tôt après la précédente
resynchronisation de ce joueur (`resync_cooldown`).

```json
{ "type": "resync" }
```

### 3.2 Serveur → client

**`welcome`** — réponse à `join`. `tick` est le prochain tick que le serveur
planifiera (0 en lobby). `seed`, `width`, `height` sont présents dès que la
salle a démarré.

```json
{
  "type": "welcome",
  "protocol": 1,
  "playerId": 3,
  "isHost": false,
  "players": [{ "id": 1, "name": "alice" }, { "id": 3, "name": "carol" }],
  "state": "running",
  "tick": 1806,
  "seed": 12345,
  "width": 128,
  "height": 128
}
```

**`players`** — diffusé à chaque changement de composition ou de host.

```json
{ "type": "players", "players": [{ "id": 1, "name": "alice" }], "hostId": 1 }
```

**`start`** — diffusé quand le host démarre. `tick` vaut 0 : tous les clients
créent leur sim avec `seed`/`width`/`height` et partent du tick 0.

```json
{ "type": "start", "seed": 12345, "width": 128, "height": 128, "tick": 0 }
```

**`bundle`** — le message central. Couvre les ticks `from`..`to` **inclus**.
Les ticks sans commande sont **omis** de `ticks` : `"ticks": []` signifie
« avance de `from` à `to` sans rien appliquer », et c'est le cas courant.

```json
{
  "type": "bundle",
  "from": 30,
  "to": 32,
  "ticks": [
    {
      "tick": 30,
      "commands": [
        { "player": 1, "payload": "AQAAAAAFAAAABwAAAA==" },
        { "player": 2, "payload": "Bw==" }
      ]
    }
  ]
}
```

**`request_snapshot`** — envoyé au host seul, pour un joueur qui rejoint.
`forPlayer` vaut `NO_PLAYER` (0), qui n'est jamais un identifiant de joueur,
pour un **snapshot de conservation** dans une salle « case » (§11) : la réponse
doit alors omettre `forPlayer`.

```json
{ "type": "request_snapshot", "forPlayer": 3 }
{ "type": "request_snapshot", "forPlayer": 0 }
```

**`snapshot`** — relayé au joueur qui rejoint, avant le rejeu des bundles.
`frozenTicks` est facultatif et n'apparaît qu'à la **réouverture d'une colonie
gelée** (§11.6) : c'est le temps passé sans personne sur la case, en ticks, que
le premier arrivant rattrape avec une commande d'avance rapide.

```json
{ "type": "snapshot", "tick": 1806, "data": "8QIAAAcAAAA=" }
{ "type": "snapshot", "tick": 1806, "data": "8QIAAAcAAAA=", "frozenTicks": 3000 }
```

**`desync`** — premier écart de hash constaté. Les clés de `hashes` sont des
identifiants de joueur (chaînes, JSON oblige). `outliers` (§7) liste les
joueurs déviants au sens de la majorité ; absent quand aucune majorité n'est
connue (moins de trois hashes pour ce tick, ou pas de valeur majoritaire —
systématique à deux joueurs).

```json
{ "type": "desync", "tick": 600, "hashes": { "1": "3f0a1c77b2e94d10", "2": "aa19f0b3c4d55e21" } }
{ "type": "desync", "tick": 600, "hashes": { "1": "aaaa", "2": "zzzz", "3": "aaaa" }, "outliers": [2] }
```

**`resynced`** — une resynchronisation a réussi (§7) : `player` a de nouveau
annoncé, au point de contrôle `tick`, un hash égal à la majorité. Diffusé à
tous ; la salle quitte `desynced` pour `running` si plus personne ne dévie.

```json
{ "type": "resynced", "player": 2, "tick": 900 }
```

**`error`** — message invalide ou action refusée. `code` est stable, `message`
est un texte de diagnostic (français, non destiné à l'affichage brut).

```json
{ "type": "error", "code": "not_host", "message": "seul le host peut démarrer" }
```

Codes émis en v1 (`ERROR_CODES`, liste ouverte : un client ne doit pas exiger
d'appartenir à cette liste) : `bad_message`, `version_mismatch`, `not_joined`,
`already_joined`, `room_full`, `not_host`, `already_running`, `not_running`,
`history_gap`, `no_host`, `host_cannot_resync` (§7 : l'hôte ne peut pas se
resynchroniser sur lui-même), `resync_cooldown` (§7 : resynchronisation déjà
déclenchée récemment pour ce joueur).

## 4. Cycle de vie d'une salle

```
                 join (1er joueur)                 start (host)
   [ pas de salle ] ─────────────▶ [ lobby ] ──────────────────▶ [ running ]
          ▲                            │                              │  ▲
          │ dernier départ             │ join / leave                 │  │ plus aucun déviant
          │ (salle détruite)           ▼                              ▼  │ (resynced, §7)
          └────────────────────── [ lobby ]                     [ desynced ]
                                                                      │
                                          horloge et bundles continuent ;
                                          les déviants non-hôtes sont réparés
                                          automatiquement (§7)
```

En `running`, chaque battement de 50 ms :

```
   scheduler.emitBundle()   →   history.push(bundle)   →   diffusion aux joueurs synchronisés
```

Côté client, la boucle est :

```
   tant que j'ai le bundle du tick courant :
       appliquer les commandes de ce tick (dans l'ordre du bundle)
       step(1)
```

Détails de la vie d'une salle :

- Le **host** est le premier joueur connecté. S'il part, le joueur restant le
  plus ancien le devient et un `players` le diffuse. Les demandes de snapshot
  en cours sont réémises vers le nouveau host.
- La salle est **détruite dès qu'elle est vide**. Une salle ordinaire ne
  laisse rien derrière elle ; une salle « case » laisse son dernier snapshot
  de conservation au serveur, qui rouvre la colonie avec (§11).
- `start` par un non-host → `not_host`. `start` sur une salle démarrée →
  `already_running`. `command`, `hash`, `snapshot` ou `resync` avant `start` →
  `not_running`.

## 5. La garantie d'ordre

C'est le cœur du lockstep : **tous les clients appliquent la même liste de
commandes, sur le même tick, dans le même ordre**, donc obtiennent le même
état.

1. Une commande reçue pendant que le bundle N est « en cours » est planifiée au
   **premier tick du bundle N+1**, jamais dans un bundle déjà émis. Compté
   depuis le clic : 0 à 50 ms d'attente avant l'émission du bundle N+1, plus le
   temps que la lecture du client atteigne ce bundle, soit un **délai d'entrée
   de 50 à 100 ms** en pratique, aller-retour réseau en plus.
2. À l'intérieur d'un tick, l'ordre est
   `(instant d'arrivée au serveur, playerId croissant, rang d'arrivée)`.
   Le playerId départage deux arrivées à la même milliseconde ; le rang
   d'arrivée garde l'ordre de deux commandes d'un même joueur.
3. Le bundle sérialise cet ordre. Le client applique les commandes **dans
   l'ordre du tableau**, sans les retrier.

Cette logique est dans `Scheduler` (`packages/protocol/src/lockstep.ts`), pure
et sans I/O, et testée directement (`packages/protocol/test/lockstep.test.ts`),
puis de bout en bout avec deux vrais clients WebSocket
(`apps/server/test/server.test.ts`).

Conséquence pour le client : **ne jamais appliquer une commande localement au
moment du clic**. Le clic envoie `command` ; l'effet arrive avec le bundle,
un ou deux bundles plus tard. Ce qui peut être local et immédiat, c'est le
retour visuel non simulé (surbrillance, curseur, aperçu de rectangle).

## 6. Retard et rattrapage

- Le client n'avance le sim que s'il **possède le bundle du tick**. Sans bundle,
  il ne fait qu'afficher : pas d'extrapolation du sim.
- Un client en retard (onglet en arrière-plan, hoquet réseau) reçoit plusieurs
  bundles d'un coup et exécute plusieurs ticks dans la même frame. Le
  rattrapage doit être **borné par frame** (comme la boucle solo de `App.tsx`)
  pour ne pas geler l'affichage, mais **non borné dans le temps** : la file de
  bundles se vide sur plusieurs frames s'il le faut.
- Rappel du plan : un onglet en arrière-plan ne reçoit presque plus de frames.
  En multi, le sim doit tourner dans un Worker cadencé par timer, pas dans
  `requestAnimationFrame`.
- Le serveur n'attend jamais : aucun message ne demande un ralentissement. Un
  client qui n'arrive jamais à suivre finit par accumuler du retard, puis
  par manquer d'historique s'il se reconnecte (voir §8).

## 7. Détection de désync et resynchronisation

- Chaque client envoie `hash { tick, hash }` quand `tick % HASH_EVERY_TICKS === 0`,
  avec la valeur de `WasmSim.hash()` **avant** d'exécuter ce tick.
- Le serveur compare **par tick**, entre les seuls joueurs qui ont annoncé ce
  tick : un joueur en retard n'invente pas un écart, il arrive plus tard.
- Au **premier** écart jamais constaté dans la salle, le serveur diffuse
  `desync { tick, hashes }` à tous et passe la salle en `desynced`. Les écarts
  suivants ne redéclenchent pas cette diffusion : `desync` est un signal
  d'alarme, pas un journal (`HashLedger.report`, `packages/protocol/src/lockstep.ts`).

Ce que la v1 signalait sans jamais réparer se répare maintenant, à partir
d'une notion de **majorité** :

```
   3 joueurs annoncent le hash du tick 300 :   alice=AAAA  bob=ZZZZ  carol=AAAA
                                                      │
                                    HashLedger.majorityHash(300) = AAAA
                                    HashLedger.outliers(300)     = [bob]
                                                      │
              desync { tick:300, hashes:{...}, outliers:[bob] } ── diffusé à tous
                                                      │
   bob ≠ hôte ⇒ réparation automatique (sauf cooldown actif)
                                                      │
   serveur ──▶ hôte : request_snapshot { forPlayer: bob }   (comme un rejoignant, §8)
   hôte    ──▶ serveur : snapshot { tick, data, forPlayer: bob }
   serveur ──▶ bob    : snapshot { tick, data }  puis  bundle(tick..) rejoués
                                                      │
   au point de contrôle suivant, bob annonce un hash = majorité
                                                      │
              resynced { player: bob, tick } ── diffusé à tous
   salle : desynced → running (si plus personne ne dévie)
```

- **Majorité** (`HashLedger.majorityHash(tick)` / `outliers(tick)`, purs, sans
  I/O) : dès que **trois hashes ou plus** sont connus pour un tick, la valeur
  qui réunit une **majorité stricte** (plus de la moitié) fait référence ; les
  autres joueurs sont les « déviants » de ce tick. Sans majorité (moins de
  trois hashes connus, ou aucune valeur majoritaire — le cas systématique à
  deux joueurs, faute de pouvoir départager qui a raison), `outliers` est vide.
  Le champ `desync.outliers` reprend ce calcul au moment de la diffusion ;
  absent du fil quand il est vide (pas de `[]` explicite).
- **Auto-réparation** : à chaque hash reçu (pas seulement le premier écart
  jamais vu), le serveur recalcule la majorité du tick annoncé. Un joueur qui y
  apparaît comme déviant, **s'il n'est pas l'hôte**, déclenche automatiquement
  le même mécanisme que pour un rejoignant (§8) : `request_snapshot { forPlayer }`
  à l'hôte, puis relais du `snapshot` et rejeu des bundles depuis ce tick vers
  le déviant. Bornée à une tentative par déviant et par `RESYNC_COOLDOWN_TICKS`
  (1800 ticks, 30 s) : pas de tempête de `request_snapshot` si la réparation
  précédente n'a pas encore abouti ou si le déviant continue de diverger.
- **Retour à la normale** : un déviant dont le hash concorde de nouveau avec la
  majorité, à un point de contrôle suivant, fait émettre `resynced { player, tick }`
  à tous. La salle quitte `desynced` pour `running` dès que plus personne ne
  dévie.
- **Resynchronisation manuelle** : un client peut envoyer `resync {}` à tout
  moment (salle `running` ou `desynced`, jamais en `lobby` → `error not_running`)
  pour demander explicitement un snapshot frais, sans attendre un point de
  contrôle. Le serveur applique le même mécanisme (`request_snapshot` à l'hôte,
  puis `snapshot` et rejeu). Refusé pour l'hôte lui-même (`error
  host_cannot_resync`) et soumis au même cooldown que l'auto-réparation
  (`error resync_cooldown` si une resynchronisation, automatique ou manuelle,
  vient déjà d'être déclenchée pour ce joueur).
- **Limites, à connaître avant de compter dessus** :
  - **L'hôte fait référence en v1.** Si c'est l'hôte qui a dérivé, il apparaît
    comme déviant dans le calcul de majorité mais n'est **jamais** la cible
    d'une réparation automatique ou manuelle (`host_cannot_resync`) : personne
    ne peut le corriger, puisque tout rattrapage — le sien compris — part de
    son propre état. La salle reste `desynced` indéfiniment dans ce cas ; une
    v2 pourrait faire voter la majorité (n'importe quel joueur majoritaire
    devient la source d'un snapshot), mais cela suppose que les clients
    sachent produire un snapshot sur demande, pas seulement l'hôte.
  - **À deux joueurs, pas de majorité possible** : `outliers` est toujours
    vide et l'auto-réparation ne se déclenche jamais (il faut au moins trois
    hashes pour départager qui a raison). Seule la resynchronisation manuelle
    reste disponible, et elle suppose qu'on **sache** qui des deux dévie —
    l'un des deux joueurs peut toujours demander `resync` par précaution, le
    pire cas est un rattrapage inutile depuis un état déjà bon.
  - Un joueur en cours de resynchronisation ne reçoit plus de bundles
    (`synced = false`, exactement comme un rejoignant) jusqu'à ce que le
    snapshot et le rejeu soient reçus : un déviant qui reste longtemps sans
    réponse de l'hôte reste visible dans `deviating` jusqu'à expiration du
    cooldown, qui retente alors.

### Ce dont le client aura besoin

- Afficher `desync` dans le HUD dès réception (la partie n'est plus fiable,
  mieux vaut le dire que laisser deux colonies diverger en silence), avec le
  détail de `outliers` s'il est présent.
- Si son propre `playerId` figure dans `outliers` d'un `desync` (ou d'un appel
  ultérieur à `resync` par clic sur un bouton « Resynchroniser » du bandeau) :
  attendre le `snapshot` de resynchronisation exactement comme un rejoignant —
  `WasmSim.restore(data)` puis rejeu des bundles reçus ensuite. Comme le sim
  est restauré à un tick **supérieur ou égal** au tick courant du client (le
  snapshot vient de l'état actuel de l'hôte, pas d'un point dans le passé), le
  `LockstepClient` doit accepter un `snapshot` **en cours de partie**, pas
  seulement à la connexion initiale d'un rejoignant : vérifier que
  `resetTo(tick)` (déjà utilisé pour un rejoignant) vide bien la file de
  bundles déjà appliqués avant de repartir de ce tick, sans quoi d'anciens
  bundles seraient rejoués sur le nouvel état.
- Retirer le bandeau de désynchronisation dès réception d'un `resynced` dont
  `player` est son propre `playerId`. Si la salle reste `desynced` (hôte
  déviant, ou deux joueurs sans majorité), garder le bandeau et proposer le
  bouton manuel plutôt que de le retirer sur la seule foi du temps qui passe.
- Traiter `host_cannot_resync` et `resync_cooldown` comme des refus muets ou
  quasi muets (griser le bouton un instant), pas des erreurs bloquantes.

## 8. Rejoindre en cours

Ce mécanisme est **réutilisé tel quel** par la resynchronisation d'un déviant
(§7, automatique ou manuelle) : côté serveur, un déviant est traité exactement
comme un joueur qui rejoint (`synced = false`, `request_snapshot` à l'hôte,
puis `snapshot` et rejeu depuis ce tick), et non un fondu qui repart de zéro —
lui seul récupère un `snapshot` et se resynchronise, sans que la salle ni les
autres joueurs ne soient affectés.

```
   carol                    serveur                     alice (host)
     │  join                   │                            │
     ├────────────────────────▶│                            │
     │  welcome (running, seed) │                            │
     │◀────────────────────────┤  request_snapshot(carol)   │
     │                         ├───────────────────────────▶│
     │        (aucun bundle)   │  snapshot(tick, data)      │
     │                         │◀───────────────────────────┤
     │  snapshot(tick, data)   │                            │
     │◀────────────────────────┤                            │
     │  bundle(tick..) rejoués │                            │
     │◀────────────────────────┤                            │
     │  flux courant           │                            │
     │◀────────────────────────┤                            │
```

- Le joueur qui rejoint ne reçoit **aucun bundle** avant son snapshot : le
  serveur ne l'inclut dans la diffusion qu'une fois synchronisé. Il n'y a donc
  rien à mettre en file d'attente côté client.
- `snapshot.tick` est le **prochain tick à exécuter** (donc le nombre de ticks
  déjà appliqués). Après `WasmSim.restore(data)`, le client est exactement à ce
  tick.
- Le serveur rejoue ensuite tous les bundles dont `to >= snapshot.tick`, dans
  l'ordre d'émission, puis branche le joueur sur le flux courant. Le premier
  bundle rejoué peut commencer avant `snapshot.tick` : le client **ignore les
  ticks déjà appliqués** de ce bundle (comparer `ticks[].tick` à son propre
  tick courant).
- Les commandes que le joueur envoie avant d'être synchronisé ne sont pas
  perdues : elles sont planifiées normalement et lui reviennent avec le rejeu.

**Limites**, à connaître avant de compter dessus :

- L'historique est borné à `MAX_HISTORY_BUNDLES` bundles, soit 2000 × 50 ms =
  **100 secondes**. Si le host fournit un snapshot dont le tick est plus vieux
  que le plus ancien bundle conservé, le rattrapage serait incomplet : le
  serveur répond `error history_gap` au joueur concerné, qui reste
  désynchronisé et doit **redemander un snapshot** (le plus simple en v1 : se
  reconnecter). En pratique le host snapshotte à son tick courant, le cas
  n'arrive que si le host est lui-même très en retard.
- Le snapshot vient du **host**, pas du serveur : si le host est désynchronisé,
  le joueur qui rejoint hérite de l'état du host. C'est assumé en v1 (le
  serveur ne simule pas et ne peut pas arbitrer).
- Le snapshot d'une carte 128² fait plusieurs centaines de kilo-octets, gonflés
  d'un tiers par le base64. C'est le premier candidat au passage en binaire.
- Il n'y a pas de reprise de salle **hors monde** : si tout le monde part, la
  salle disparaît. Une salle « case », elle, rouvre depuis son dernier
  snapshot conservé (§11).
- Ces mêmes limites s'appliquent à une resynchronisation (§7) : un déviant peut
  lui aussi recevoir `error history_gap` si l'hôte snapshotte un tick trop
  vieux (en pratique il snapshotte son tick courant, comme pour un rejoignant),
  et hérite pareillement de l'état de l'hôte si celui-ci est lui-même déviant —
  d'où la règle « l'hôte ne se resynchronise jamais sur lui-même » du §7.

## 9. Migration binaire prévue

Le JSON de la v1 est un choix de lisibilité (on peut lire une session dans
l'inspecteur réseau), pas de performance. Le coût réel : un bundle vide fait
~44 octets, soit ~0,9 ko/s par client ; un snapshot est gonflé de 33 %.

Le passage aux trames binaires est déjà cadré par le protocole :

1. `PROTOCOL_VERSION` passe à 2, `join.protocol` fait le tri : un serveur peut
   accepter les deux versions le temps d'une transition.
2. Les trames binaires WebSocket (`ArrayBuffer`) sont réservées aux messages à
   charge : `bundle`, `command`, `snapshot`. Le contrôle (`join`, `welcome`,
   `players`, `start`, `desync`, `error`, heartbeat) peut rester en JSON texte
   sans coût mesurable — le type de la trame (texte ou binaire) suffit à
   distinguer les deux chemins.
3. Cadrage proposé : `u8` type de message, puis pour un bundle `u32 from`,
   `u8 tickCount`, et par tick `u8 delta` depuis `from`, `u8 commandCount`,
   puis par commande `u8 player`, `u16 length`, les octets bruts. Les charges
   sont déjà des octets : rien à convertir, le base64 disparaît.
4. Seuls `encodeMessage` / `decodeMessage` changent. Les types de `messages.ts`
   et toute la logique de `lockstep.ts` sont indépendants du cadrage — c'est
   pour cela qu'ils ne manipulent que des `Uint8Array`.

## 10. Intégration côté sim-wasm (livrée le 2026-09-05)

> Réalisée : encodeurs `WasmSim.encode_*`, `apply_encoded`, `pending_len` dans
> `crates/sim-wasm` ; côté client `apps/client/src/net/LockstepClient.ts` (logique pure,
> testée contre le vrai serveur dans `apps/client/test/lockstep.test.ts`),
> `apps/client/src/sim/commands.ts`, lobby et mode multi dans `App.tsx`. Le texte ci-dessous
> est la spécification d'origine, conservée comme référence.


Le client ne peut pas se brancher sur ce protocole avec l'API actuelle de
`WasmSim` : les méthodes typées (`move_to`, `designate`, …) poussent directement
dans la file `pending` du sim local. En multi, il faut **encoder sans appliquer**,
envoyer, puis **appliquer ce que le serveur renvoie**.

Ce qui existe déjà et suffit tel quel :

- `step(n)` — avancer le sim. En multi, appeler **`step(1)` par tick**, après
  avoir appliqué les commandes de ce tick. Ne pas utiliser `step(n)` avec `n > 1`
  pour rattraper un bundle qui contient des commandes : `step` n'applique la
  file qu'au premier de ses `n` ticks.
- `snapshot() -> Vec<u8>` et `restore(bytes) -> WasmSim` — exactement ce que
  demandent `snapshot` et le rejoint en cours. `SimHandle.restore` existe déjà
  côté client.
- `hash() -> String` — la valeur à envoyer dans `hash`.
- `tick() -> f64` — pour savoir quel tick on est en train d'exécuter.

Ce qui manque, à ajouter dans `crates/sim-wasm/src/lib.rs` (le sim lui-même
n'a rien à changer : `Command` dérive déjà `Serialize`/`Deserialize` et
`postcard` est déjà une dépendance) :

1. **Un encodeur par commande**, qui renvoie les octets sans toucher à l'état.
   Des fonctions **associées** (statiques, sans `&self`) : le client doit pouvoir
   encoder avant même d'avoir un sim, et l'encodage ne dépend d'aucun état.
   Une par variante de `sim::Command`, avec les mêmes paramètres que la méthode
   typée correspondante :

   | Commande | Signature attendue |
   |---|---|
   | `Command::MoveTo` | `encode_move_to(pawn: u32, x: u32, y: u32) -> Vec<u8>` |
   | `Command::Designate` | `encode_designate(kind: u8, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8>` |
   | `Command::SetZone` | `encode_set_zone(zone: u8, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8>` |
   | `Command::Build` | `encode_build(kind: u8, material: u8, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8>` |
   | `Command::CancelBuild` | `encode_cancel_build(x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8>` |
   | `Command::Attack` | `encode_attack(pawn: u32, target: u32) -> Vec<u8>` |
   | `Command::TriggerRaid` | `encode_trigger_raid() -> Vec<u8>` |
   | `Command::Nop` | `encode_nop() -> Vec<u8>` (utile pour tester le lockstep sans gameplay) |

   Corps type : `postcard::to_allocvec(&sim::Command::MoveTo { pawn, x, y }).expect(…)`.
   Toute commande ajoutée plus tard (priorités de travail, bills de cuisine…)
   doit venir avec son `encode_*` dans le même commit, sinon elle est
   injouable en multi.

2. **`apply_encoded(&mut self, bytes: &[u8]) -> Result<(), JsError>`** — décode
   une `Command` postcard et la pousse dans `pending`, exactement comme le font
   les méthodes typées. Erreur explicite si les octets sont invalides : c'est
   la seule frontière où des octets venus du réseau entrent dans le sim.
   Le déterminisme impose que des octets identiques donnent la même `Command`
   chez tous les clients — c'est le cas, postcard est un format canonique
   pour un même schéma, à condition que tous les clients tournent **le même
   binaire WASM** (à vérifier au `join`, par exemple en comparant le hash d'un
   sim neuf de mêmes paramètres).

3. Facultatif mais utile : **`pending_len() -> usize`** pour vérifier en test
   que la file a bien été vidée par `step(1)`, et **`encode_command_count()`**
   ou une constante de version de schéma des commandes si l'on veut détecter un
   client qui n'a pas le même jeu de commandes.

Enchaînement attendu côté client, une fois ces ajouts faits :

```ts
// À la réception d'un bundle : on ne saute jamais un tick.
for (let tick = bundle.from; tick <= bundle.to; tick += 1) {
  if (tick < sim.tick) continue;                 // déjà appliqué (rejeu)
  for (const c of commandsOf(bundle, tick)) {    // ordre du bundle, tel quel
    sim.applyEncoded(c.payload);
  }
  sim.step(1);
  if (sim.tick % HASH_EVERY_TICKS === 0) {
    socket.send(encodeMessage({ type: "hash", tick: sim.tick, hash: sim.hash() }));
  }
}
```

Ce que le client doit encore construire par-dessus (hors périmètre de ce
document) : le Worker qui porte le sim, la file de bundles, l'écran de lobby,
et le basculement solo/multi dans `App.tsx`.

## 11. Monde (phase 4, première tranche)

Le serveur devient autorité sur un **globe partagé** : une case du globe est
une colonie possible, et chaque case occupée a **sa** salle lockstep, avec les
règles des sections 1 à 10. Tout ce qui suit s'ajoute au protocole existant
sans le modifier : le mode « salle simple » (`join { room: "demo" }`) continue
de fonctionner à l'identique.

Le globe lui-même — géométrie, biomes, itinéraires — est `packages/world`, voir
`docs/world.md`.

### 11.1 Le globe : `GET /world`

Le serveur génère le globe **une fois** au démarrage, à partir de deux
variables d'environnement, et sert son `WorldWire` sérialisé :

| variable | défaut | rôle |
|---|---|---|
| `WORLD_SEED` | 1 | graine du globe |
| `WORLD_SUBDIVISIONS` | 4 | 4 = 2 562 cases (5 = 10 242, la cible de production) |

```
GET /world
→ 200 { "seed": 1, "subdivisions": 4, "generatedAt": 1757000000000, "wire": { … } }
   Content-Encoding: gzip          (si le client l'accepte)
   ETag: "world-1-1-4"             (version du format, graine, subdivision)
   Cache-Control: public, max-age=3600
   Vary: Accept-Encoding
```

- Le client **ne régénère jamais** le globe : `Math.sin` et consorts ne sont pas
  normalisés au bit près en JavaScript, deux moteurs ne verraient pas la même
  carte (`docs/world.md` §6). Il télécharge, il désérialise avec
  `deserializeWorld`, il affiche.
- L'ETag ne dépend que de ce qui détermine le globe. Un `If-None-Match` qui
  correspond donne un `304` : le globe ne change pas, un client n'a à le
  télécharger qu'une fois. Le corps gzippé et le corps brut partagent le même
  ETag, d'où le `Vary`.
- Le corps est calculé à la première demande puis gardé en mémoire (2,8 Mo de
  JSON, 650 Ko gzippés à la subdivision 5).
- `GET /health` annonce le même globe :
  `world: { seed, subdivisions, tiles, settlements }`. C'est le contrôle de
  cohérence le moins cher entre un client et un serveur.

### 11.2 Identité, cases et salles

- **L'identité d'un joueur est un jeton**, pas son nom. Il n'y a toujours pas
  de compte ni de mot de passe, mais on ne se fait plus reconnaître en tapant
  simplement le bon nom :
  - `world_join` sans `token` : le serveur crée un nouveau joueur — une clé
    publique et stable (`playerKey`, un uuid) et un jeton secret (32 octets
    aléatoires, encodés en base64url) — et renvoie les deux dans
    `world_welcome`, **une seule fois** : c'est au client de les conserver
    (`localStorage`, par serveur) et de renvoyer le jeton dans son prochain
    `world_join`.
  - `world_join` avec un `token` connu : le joueur est reconnu, quel que soit
    le `name` envoyé — qui n'est plus qu'un **libellé**, mis à jour librement à
    chaque connexion (deux appareils du même joueur peuvent afficher des noms
    différents sans se marcher dessus).
  - `world_join` avec un `token` inconnu (perdu, effacé, ou d'un autre
    serveur) : `world_error { code: "bad_token" }` puis fermeture de la
    connexion. Il n'y a pas de compte de secours — un jeton perdu est une
    identité perdue, et donc les colonies qui allaient avec.
  - Le jeton n'est **jamais** journalisé, jamais renvoyé à un autre joueur, et
    comparé côté serveur en **temps constant** (`crypto.timingSafeEqual`) :
    une tentative de deviner un jeton ne doit rien apprendre de la durée de la
    comparaison.
  - Les colonies (`Settlement.owner`) et les caravanes (`Caravan.owner`)
    réfèrent désormais la **clé** du joueur, jamais son nom. `ownerName` porte
    le nom d'affichage courant, résolu par le serveur à chaque diffusion — il
    peut changer d'un message à l'autre (le joueur s'est reconnecté sous un
    autre nom), `owner` jamais. La table complète des joueurs déjà vus par le
    monde, avec qui est en ligne, est diffusée par `world_welcome` et
    `world_players` (`WorldPlayerInfo`, §11.5).
  - Cette identité ne couvre que le **monde** : la salle (`join { room, name }`,
    §3) n'en sait rien et n'a pas changé — voir la fin de cette section.
- **Une colonie par case**, au plus. Un joueur peut en fonder plusieurs.
- Une colonie ne se pose que sur une case **terrestre**, au sens de
  `movementCost(biome) !== null` : tout sauf l'océan, la banquise comprise.
- La salle d'une case s'appelle **`tile-<id>`**, avec l'identifiant écrit sans
  zéro devant (`tile-0`, `tile-2561`). Ce préfixe est **réservé** : un `join`
  sur `tile-<id>` d'une case non colonisée est refusé par
  `error not_settled`, on ne squatte pas le nom d'une future colonie.
- La **graine de carte d'une case est imposée par le serveur** :
  `mix(WORLD_SEED, tileId)` sur 32 bits, déterministe. Deux visites de la même
  case donnent la même carte, et le serveur n'a rien à stocker pour la
  retrouver. Dans une salle « case », le `seed` du `start` de l'hôte est
  **ignoré** et c'est la graine de la case qui est diffusée ; `width` et
  `height` restent au choix de l'hôte.
- Le relais de salle (`join { room, name }`, §3) **ne change pas** : `name` y
  reste un simple libellé, sans jeton ni vérification — deux joueurs de la
  même salle peuvent toujours porter le même nom, ça n'a jamais eu
  d'importance à ce niveau. L'**autorité d'appartenance** (qui possède quelle
  colonie ou quelle caravane) est entièrement côté monde, avant même d'entrer
  dans une salle ; la salle elle-même n'a jamais eu la notion de propriétaire.

### 11.3 Cycle de vie

```
   world_join ──▶ [ dans le monde ]  ── settle ──▶ settled { room, seed }
                        │  ▲                │                  │
                        │  │ world_settlements (diffusé)       │
                   visit│  │                                   │
                        ▼  │                                   ▼
                  settled { room, seed } ────────────▶ join { room }   (§3)
                                                              │
   world_leave ◀── [ dans le monde ] ◀── (la salle vit sa vie lockstep)
                                                              │
        ┌── salle vide : détruite, snapshot conservé ◀─────────┘
        │
        └──▶ retour (visit ou propriétaire) : la salle rouvre en `running`,
             au tick du snapshot conservé
```

Une connexion peut être dans le monde, dans une salle, ou les deux : le
`world_join` ne remplace pas le `join`, il le précède. Les identifiants de
joueur du monde (`world_welcome.playerId`) et de salle (`welcome.playerId`)
sont **indépendants**.

### 11.4 Messages, client → serveur

**`world_join`** — entrer dans le monde, sans salle. `protocol` se comporte
comme celui de `join`. `token`, absent au premier contact, est ce qui
identifie un joueur reconnu (§11.2) ; `name` est toujours envoyé, mais n'est
qu'un libellé une fois un jeton en jeu.

```json
{ "type": "world_join", "name": "alice", "protocol": 2 }
```

Reconnexion, jeton en poche — le nom peut différer, ça n'a pas d'importance :

```json
{ "type": "world_join", "name": "alice (mobile)", "protocol": 2, "token": "8f2e…c1" }
```

Un second `world_join` sur la même connexion répond `error already_joined`, et
une version incompatible `error version_mismatch` suivi d'une fermeture —
comme pour `join`. Un `token` qui ne correspond à aucun joueur connu répond
`world_error { code: "bad_token" }` puis ferme la connexion — pas de compte de
secours (§11.2). Toutes les autres actions de monde refusées répondent
`world_error`.

**`settle`** — fonder une colonie sur une case libre et terrestre.

```json
{ "type": "settle", "tile": 1732 }
```

**`visit`** — demander la salle et la graine d'une case déjà colonisée, en
invité. Ne change rien à l'état du monde.

```json
{ "type": "visit", "tile": 1732 }
```

**`abandon`** — rendre une de ses cases. Son snapshot conservé est oublié ; une
salle encore peuplée n'est pas fermée pour autant.

```json
{ "type": "abandon", "tile": 1732 }
```

**`world_leave`** — quitter le monde sans fermer la connexion (ni la salle).

```json
{ "type": "world_leave" }
```

### 11.5 Messages, serveur → client

**`world_welcome`** — réponse à `world_join`. Le globe n'est **pas** dedans :
il se télécharge par `GET /world`. `world` sert à vérifier qu'on parle du même.

`playerKey` est l'identité **publique** et stable du joueur : c'est elle qui
apparaît dans `settlements[].owner` et `caravans[].owner`, à conserver pour se
retrouver dans ses propres colonies. `token` n'apparaît **qu'à la création**
d'un nouveau joueur (`world_join.token` absent, ou inconnu — dans ce dernier
cas c'est `world_error { code: "bad_token" }` qui répond, pas ce message) : à
conserver côté client (`localStorage`, par serveur), jamais rejoué à une
reconnexion reconnue. `playerId`, lui, n'a rien d'une identité : un simple
compteur de connexion remis à zéro à chaque redémarrage, qui ne sert qu'à
`request_snapshot.forPlayer` (§8) — à ne pas confondre avec `playerKey`.

```json
{
  "type": "world_welcome",
  "playerId": 2,
  "playerKey": "3f9c1a2e-...-b2",
  "name": "bob",
  "settlements": [
    {
      "tile": 1732,
      "owner": "8a1b2c3d-...-e4",
      "ownerName": "alice",
      "room": "tile-1732",
      "seed": 2007225770,
      "createdAt": 1757000000000
    }
  ],
  "players": [
    { "key": "8a1b2c3d-...-e4", "name": "alice", "online": true },
    { "key": "3f9c1a2e-...-b2", "name": "bob", "online": true }
  ],
  "world": { "seed": 1, "subdivisions": 4, "tiles": 2562 }
}
```

Réponse à un **nouveau** joueur (pas de `token` connu) — le seul cas où
`token` est présent :

```json
{
  "type": "world_welcome",
  "playerId": 3,
  "playerKey": "9d4e5f60-...-a1",
  "name": "carol",
  "token": "6UZ0y9F1qk…3aXw",
  "settlements": [],
  "players": [ … ],
  "world": { "seed": 1, "subdivisions": 4, "tiles": 2562 }
}
```

**`world_settlements`** — diffusé à tous les joueurs du monde à chaque
fondation et à chaque abandon. Liste complète, triée par case : le client
remplace la sienne, il n'y a pas de delta. `owner` est la clé du joueur,
`ownerName` son nom d'affichage résolu à l'instant de la diffusion — il peut
changer d'un message à l'autre, `owner` jamais.

```json
{ "type": "world_settlements", "settlements": [ … ] }
```

**`world_players`** — diffusé à chaque arrivée, à chaque départ et à chaque
renommage. Contrairement à `world_settlements`, ce n'est **pas** limité aux
joueurs présentement connectés : tout joueur déjà vu par le monde y figure,
`online` distingue qui est là.

```json
{
  "type": "world_players",
  "players": [
    { "key": "8a1b2c3d-...-e4", "name": "alice", "online": true },
    { "key": "3f9c1a2e-...-b2", "name": "bob", "online": false }
  ]
}
```

**`settled`** — où aller pour jouer une case. Envoyé à l'auteur d'un `settle`
réussi **et** d'un `visit` réussi. Le client enchaîne avec
`join { room, name }` sur la même connexion.

```json
{ "type": "settled", "tile": 1732, "room": "tile-1732", "seed": 2007225770 }
```

**`world_error`** — refus d'une action de monde. Distinct de `error` pour que
le client puisse router les deux séparément : `error` parle de la salle et du
transport, `world_error` de la carte du globe.

```json
{ "type": "world_error", "code": "occupied", "message": "la case 1732 est déjà colonisée" }
```

Codes (`WORLD_ERROR_CODES`, liste ouverte comme `ERROR_CODES`) :

| code | quand |
|---|---|
| `bad_tile` | case hors du globe |
| `not_land` | case sous l'eau |
| `occupied` | case déjà colonisée (`settle`) |
| `not_settled` | case libre alors qu'il fallait une colonie (`visit`, `abandon`) |
| `not_owner` | colonie fondée par quelqu'un d'autre (`abandon`) |
| `not_in_world` | action de monde avant `world_join` |
| `bad_token` | `world_join.token` ne correspond à aucun joueur connu (§11.2) |

### 11.6 Snapshots de conservation

Une colonie doit survivre au départ de ses joueurs. Le serveur ne simule pas :
le seul état existant est celui des clients, donc il le leur demande.

```
   hôte                         serveur
     │   (salle « case » en jeu)   │
     │◀── request_snapshot ────────┤  tous les SNAPSHOT_EVERY_TICKS (1800) ticks
     │      { forPlayer: 0 }       │
     ├─── snapshot { tick, data } ▶│  sans forPlayer
     │                             │  → WorldState.snapshots["tile-1732"]
```

- `forPlayer: 0` (`NO_PLAYER`) veut dire « personne » : ce snapshot n'est pas
  un rattrapage. Les identifiants de joueur commencent à 1.
- La réponse doit **omettre** `forPlayer`. Un snapshot de conservation n'est
  diffusé à personne ; il sert quand même les rejoignants encore en attente,
  exactement comme en salle simple (§8) — c'est le même état.
- Un snapshot plus ancien que celui déjà conservé est ignoré, et un snapshot
  pour une case **sans colonie** aussi : si le propriétaire abandonne pendant
  qu'on y joue, la partie en cours se termine mais n'écrit plus rien, et le
  prochain occupant de la case repart d'une carte neuve.
- **Réouverture** : quand la salle se vide elle est détruite comme les autres,
  mais le snapshot reste. Au retour du propriétaire ou d'un visiteur, la salle
  est recréée directement en `running`, à partir du snapshot : le premier
  arrivant reçoit son `welcome` (`state: "running"`, `tick`, `seed` de la case,
  `width`/`height` du snapshot) puis `snapshot { tick, data, frozenTicks? }`,
  et les bundles reprennent à ce tick. **Aucun hôte n'est sollicité et il n'y a
  rien à rejouer** : l'historique repart de zéro à ce tick.
- Sans snapshot connu (colonie toute neuve), la salle s'ouvre en `lobby` et
  l'hôte fait `start` normalement — avec la graine de la case.

**Le temps gelé et son rattrapage.** Le monde, lui, a continué de tourner
pendant l'absence (§12.1). À la réouverture, la colonie rattrape ce temps de
façon **abstraite** : pas en rejouant les ticks, mais en appliquant des
formules à l'état (croissance des plants, repousse, péremption, cicatrisation,
échéances du storyteller décalées), comme RimWorld le fait de ses cartes
déchargées. Le sim s'en charge dans `Command::FastForward { ticks }`
(`crates/sim/src/fastforward.rs`) ; le serveur, lui, ne fait que compter le
temps.

```
   (la salle se vide)                                   (quelqu'un revient)
        │                                                       │
   savedAtHours = worldHours()          frozenTicks = round(
        │                                 (worldHours() − savedAtHours) × 600)
        ▼                                                       ▼
   snapshot conservé  ────────── heures de jeu du monde ────▶ snapshot { tick, data, frozenTicks }
                                                                │
                                          restore(data) puis, en PREMIÈRE
                                          commande : FastForward { frozenTicks }
```

- Chaque snapshot de conservation est daté **en heures de jeu du monde**
  (`savedAtHours`, l'horloge de §12.1), en plus de sa date réelle `savedAt`.
- `frozenTicks` = `round((worldHours() − savedAtHours) × TICKS_PER_HOUR)`, avec
  `TICKS_PER_HOUR = 600` (`TICKS_PER_DAY = 14 400` ticks pour un jour de carte,
  divisés par 24 heures de monde). Le champ est **borné à 60 jours**
  (`MAX_FROZEN_TICKS`, la même borne que `sim::MAX_FAST_FORWARD`) et **omis
  quand il vaut 0**.
- Un snapshot **sans `savedAtHours`** — relu d'un fichier écrit avant cette
  tranche — ne donne aucune avance rapide : mieux vaut une colonie qui reprend
  où elle en était qu'un rattrapage inventé.
- **Le serveur ne fait rien de plus.** Il ne simule pas, donc il ne peut pas
  appliquer l'avance rapide : c'est le premier arrivant — qui est l'hôte de la
  salle rouverte — qui, après `WasmSim.restore(data)`, émet
  `encode_fast_forward(frozenTicks)` **une seule fois**, en première commande.
  Elle revient dans un bundle et tous les clients l'appliquent au même tick,
  comme n'importe quel ordre : le rattrapage est dans le lockstep, pas à côté.
- L'horloge du monde s'arrête quand le serveur s'éteint (§12.1) : un
  redémarrage ne vieillit donc pas les colonies gelées, il reprend le compte.
- **Le tick du lockstep n'est pas celui du sim.** L'avance rapide fait sauter le
  compteur interne du sim de `frozenTicks` d'un coup, alors que la salle, elle,
  continue de numéroter ses ticks un par un. Tout ce qui part sur le fil —
  `snapshot.tick`, `hash.tick` — reste donc le **tick de la salle** (le
  `nextTick` du `LockstepClient`), jamais `WasmSim.tick()`. L'écart entre les
  deux est identique chez tous les clients, puisqu'ils appliquent la même
  commande au même tick : le hash reste comparable.

### 11.7 Enchaînement complet, côté client

```ts
// 1. Le globe, une fois, mis en cache par le navigateur.
const { wire } = await (await fetch(`${http}/world`)).json();
const world = deserializeWorld(wire);

// 2. Le monde, sur la WebSocket. `token` : lu dans localStorage (par serveur),
//    absent la toute première fois.
const token = localStorage.getItem(`rimlike:token:${serverUrl}`) ?? undefined;
socket.send(encodeMessage({ type: "world_join", name, protocol: PROTOCOL_VERSION, token }));
// ← world_welcome { playerKey, token?, settlements, players, world }
//   `token` n'est présent qu'à la création : le conserver tout de suite.
//   puis world_settlements/world_players
//   ← world_error { code: "bad_token" } si le jeton stocké n'est plus reconnu :
//     l'oublier et proposer de repartir de zéro (nouveau world_join sans token).

// 3. S'installer (ou visiter) : la case cliquée sur le globe.
socket.send(encodeMessage({ type: "settle", tile: tileId }));
// ← settled { tile, room, seed }   ou   world_error { code }

// 4. Entrer dans la colonie : le protocole des sections 3 à 8, inchangé.
socket.send(encodeMessage({ type: "join", room, name }));
// ← welcome (lobby → start de l'hôte, ou running → snapshot puis bundles)
```

Ce que le client doit gérer en plus du mode salle :

- `request_snapshot { forPlayer: 0 }` → répondre `snapshot { tick, data }`
  **sans** `forPlayer` (un `forPlayer: 0` dans la réponse est refusé) ;
- `snapshot { frozenTicks }` → après `restore`, émettre
  `WasmSim.encode_fast_forward(frozenTicks)` **une seule fois**, comme première
  commande, et seulement si le client est l'hôte (`welcome.isHost`) et que
  `frozenTicks > 0` (§11.6). Deux clients qui l'émettraient chacun feraient
  vieillir la colonie deux fois — c'est une commande, pas une opération
  locale ;
- `world_settlements` → remplacer la liste et recolorer les cases possédées,
  en comparant `owner` (la clé) à son propre `playerKey` — jamais `ownerName`
  à son propre nom, deux joueurs peuvent le partager ;
- `world_error { code: "bad_token" }` → le jeton stocké n'est plus reconnu du
  serveur (fichier de persistance perdu ou remplacé) : l'oublier et proposer
  de repartir de zéro, pas une simple erreur à afficher ;
- `world_error` (les autres codes) → un message à l'écran, pas une
  déconnexion.

### 11.8 Persistance

Le seul état qui existerait à perdre est celui de `WorldState` (colonies et
derniers snapshots de conservation) : le reste (salles en jeu, connexions)
repart de toute façon d'un état neuf à chaque redémarrage. `apps/server/src/persistence.ts`
(`WorldStore`) écrit et relit cet état dans **un fichier JSON unique**.

**Format sur disque** — l'en-tête sert à valider le fichier avant d'y toucher,
`state` est exactement `WorldState.toJSON()` (§11.6 pour les snapshots, §12.6
pour l'horloge et les caravanes) :

```json
{
  "version": 2,
  "worldSeed": 1,
  "subdivisions": 4,
  "savedAt": 1757000000000,
  "state": {
    "seed": 1,
    "subdivisions": 4,
    "clock": { "worldStartedAt": 1756900000000, "hoursOffset": 412.5 },
    "caravans": { "nextId": 8, "caravans": [ … ] },
    "settlements": [
      { "tile": 1732, "owner": "8a1b2c3d-...-e4", "room": "tile-1732", "seed": 2007225770, "createdAt": 1757000000000 }
    ],
    "snapshots": [
      { "room": "tile-1732", "tick": 1800, "data": "AQIDBA==", "width": 64, "height": 64, "savedAt": 1757000000000, "savedAtHours": 412.5 }
    ],
    "players": [
      { "key": "8a1b2c3d-...-e4", "name": "alice", "token": "6UZ0y9F1qk…3aXw", "createdAt": 1757000000000 }
    ]
  }
}
```

Notez l'absence d'`ownerName` dans `settlements` : c'est un nom d'affichage
**résolu à la diffusion**, pas quelque chose qui se fige sur disque — figé, il
mentirait dès qu'un joueur se reconnecte sous un autre nom. Seul `players`
porte les noms, en face de la clé qui leur correspond ; `state.ts` la résout à
la volée (`WorldState.nameOf`) chaque fois qu'une colonie ou une caravane part
sur le fil.

`clock`, `caravans` et le `savedAtHours` d'un snapshot sont **facultatifs à la
lecture** : un fichier écrit avant les caravanes se relit tel quel, le monde
repart d'une horloge neuve et sans convoi en vol ; un snapshot sans
`savedAtHours` rouvre sa colonie sans avance rapide (§11.6). Ajouter des
champs optionnels ne casse rien — c'est pour cela que la version du fichier
n'a pas bougé de ces tranches-là.

**Migration v1 → v2 (identité par jeton).** `players` change les choses : dans
un fichier v1, `owner` (colonies et caravanes) est un **nom** ; à partir de v2
c'est une **clé**, résolue via `players`. L'absence de `players` est le signal
qu'un fichier est en v1 — `WorldState.fromJSON` migre alors chaque nom
rencontré en un joueur créé à la volée (clé et jeton **neufs**, un seul par
nom) :

- l'ancien propriétaire ne peut évidemment pas être reconnu sans jeton connu —
  ce n'est pas récupérable autrement, il n'y a pas de compte à côté ;
- mais rien n'est perdu : la colonie garde sa case, sa salle, sa graine, et son
  nom d'affichage (`ownerName`) reste celui d'avant ;
- l'exploitant du serveur peut lire le jeton fraîchement attribué dans le
  fichier une fois la migration écrite (`WORLD_STATE_FILE_VERSION` monte à 2 à
  la prochaine sauvegarde) et le communiquer hors bande à l'ancien joueur, s'il
  le souhaite — c'est un geste manuel, le protocole n'automatise rien de ce
  côté.

Un rechargement de fichier v1 est testé (`apps/server/test/persistence.test.ts`,
`apps/server/test/world.test.ts`).

**Configuration**, lue une fois par `index.ts` (`startServer` lui-même ne lit
jamais l'environnement, il reçoit des options explicites) :

| variable | défaut | rôle |
|---|---|---|
| `WORLD_STATE_FILE` | `apps/server/data/world-state.json` | chemin du fichier ; vide désactive |
| `WORLD_PERSIST` | (non défini) | `0` désactive, quel que soit `WORLD_STATE_FILE` |

Persistance désactivée = **mode mémoire** : aucune écriture, comme avant cette
tranche. C'est le comportement par défaut de `startServer` quand
`worldStateFile` n'est pas précisé, et donc celui de tous les tests qui ne le
précisent pas.

- **Écriture atomique** : dans `<fichier>.tmp` puis renommage, pour qu'un
  lecteur ou un crash en cours d'écriture ne voie jamais un JSON à moitié
  écrit. Le dossier du fichier est créé s'il n'existe pas.
- **Débounce** : `scheduleSave()`, déclenché par une fondation, un abandon ou
  un snapshot de conservation reçu, n'écrit qu'une fois toutes les
  `SAVE_DEBOUNCE_MS` (2000, injectable) malgré des changements rapprochés.
- Une écriture qui échoue (disque plein, permissions) est journalisée sur
  stderr et n'interrompt jamais le serveur.
- **Arrêt propre** (`SIGINT`/`SIGTERM`, gérés par `index.ts`) : une dernière
  sauvegarde a lieu avant de quitter, dans `RunningServer.close()`.
- **Chargement au démarrage** : fichier absent → monde vide, rien d'anormal.
  `worldSeed`/`subdivisions` du fichier différents du globe qui vient d'être
  régénéré (biomes recalculés, potentiellement différents case par case), ou
  JSON illisible/incohérent (`WorldState.fromJSON` qui échoue) → le fichier
  est **ignoré**, renommé `<fichier>.ignored-<horodatage>.json` plutôt que
  supprimé, avec un avertissement clair sur stderr : les colonies ne peuvent
  pas survivre à un changement de globe. Un fichier `version: 1` n'est **pas**
  de ce cas-là : il est chargé et migré (voir plus haut), pas mis en
  quarantaine.
- `GET /health` expose l'état de la persistance :
  `persistence: { enabled, file, lastSavedAt }` (`lastSavedAt` : `null` tant
  qu'aucune écriture n'a encore eu lieu).

### 11.9 Ce qui n'est pas encore fait

- **Comptes** : le jeton remplace le nom comme identité (§11.2), mais il n'y a
  toujours ni compte ni mot de passe, et donc pas de recouvrement : un jeton
  perdu (`localStorage` effacé, autre navigateur, autre appareil sans y avoir
  pensé) est une identité perdue, sans recours — seul l'exploitant du serveur
  peut, à la main, lire un jeton dans le fichier de persistance et le
  communiquer hors bande.
- **Bateaux** : l'océan reste infranchissable, une caravane ne quitte pas son
  continent (`docs/world.md` §4).
- **Interception** : une caravane en vol ne peut être ni attaquée ni pillée.

## 12. Caravanes (phase 4, deuxième tranche)

Une caravane emporte des colons et des marchandises d'une case du globe à une
autre. Elle sort d'une carte, traverse le globe pendant des heures de jeu, et
entre dans une autre carte. Trois couches s'y croisent, chacune dans son rôle :

- le **sim** (Rust) sait faire un manifeste (`describe_manifest` pour
  l'affichage) et sait faire entrer un convoi sur une carte
  (`Command::ArriveCaravan { manifest }`) ;
- le **serveur monde** possède le voyage : itinéraire, horloge, arrivée. Il ne
  décode **jamais** le manifeste, exactement comme il ne décode jamais une
  commande de lockstep (§1) ;
- les **clients** font le lien : l'hôte de la case de départ envoie le
  manifeste que son sim a produit, l'hôte de la case d'arrivée le réinjecte
  en lockstep.

### 12.1 L'horloge du monde

Les caravanes ne comptent ni en millisecondes ni en ticks de salle, mais en
**heures de jeu du monde** :

| notion | unité | qui la porte |
|---|---|---|
| tick | 1/60 s de jeu sur **une carte** | la salle (§1) |
| heure de jeu | `WORLD_HOUR_MS` = 30 s réelles | le serveur monde |

Une heure de jeu vaut 30 s réelles par défaut (`WORLD_HOUR_MS`, réglable par
la variable d'environnement du même nom), soit un jour de monde en 12 minutes.
Les coûts de déplacement de `packages/world` sont déjà dans cette unité : 4 h
pour traverser une prairie, 24 h pour une montagne (`docs/world.md` §4).

`worldHours()` est le nombre d'heures de jeu écoulées **depuis la création du
monde**. L'horloge est continue tant que le serveur tourne — pas de pause en
multi, c'est la décision du plan (`docs/PLAN.md` §3) — et **s'arrête quand le
serveur s'éteint** : à la sauvegarde, le total courant est écrit
(`clock.hoursOffset`), au redémarrage le compte reprend de là. Le temps d'arrêt
n'a donc pas vieilli le monde, et une caravane partie la veille ne se retrouve
pas arrivée « pendant la nuit » : elle reprend sa route avec le même
`arrivesAt`. `clock.worldStartedAt` est la date réelle de création du monde,
gardée pour dater le monde à l'usage d'un humain, pas pour faire tourner
l'horloge.

### 12.2 Cycle de vie

```
   hôte de la case A                serveur monde              hôte de la case B
        │                                 │                            │
        │  caravan_depart {manifest}      │                            │
        ├────────────────────────────────▶│  findRoute(A, B)           │
        │                                 │  arrivesAt = now + hours   │
        │  world_caravans (travelling) ◀──┼──────────────────────────▶ │
        │                                 │                            │
        │  caravan_cancel  (< 50 % du trajet seulement)                │
        ├────────────────────────────────▶│  demi-tour : `returning`   │
        │                                 │                            │
        │              … le temps passe, au rythme de WORLD_HOUR_MS …  │
        │                                 │                            │
        │                                 │  now >= arrivesAt          │
        │                                 │  → `arrived`               │
        │                                 │  caravan_arrive {manifest} │
        │                                 ├───────────────────────────▶│
        │                                 │                            │ commande
        │                                 │                            │ ArriveCaravan
        │                                 │  caravan_delivered         │ en lockstep
        │                                 │◀───────────────────────────┤
        │  world_caravans (delivered)  ◀──┤                            │
        │                                 │  oubliée après             │
        │                                 │  CARAVAN_HISTORY_HOURS     │
```

Les quatre statuts :

| statut | sens |
|---|---|
| `travelling` | en route vers `toTile` |
| `returning` | rappelée avant la moitié, elle rentre (`toTile` devient la case d'origine) |
| `arrived` | à destination, en attente d'un hôte qui l'injecte |
| `delivered` | injectée ; listée encore `CARAVAN_HISTORY_HOURS` heures de jeu, puis oubliée |

Une caravane qui **rentre** arrive comme une autre : elle repasse par `arrived`
sur sa case d'origine, et son hôte la réinjecte de la même façon. Il n'y a
qu'un seul chemin d'arrivée à écrire côté client.

### 12.3 Messages, client → serveur

Un client a en pratique **deux connexions** (§11.3) : la connexion **monde**
(thread principal) et la connexion de **salle** (Worker, lockstep). Ces trois
messages voyagent normalement sur la connexion monde (après `world_join`),
mais `caravan_depart` et `caravan_delivered` sont acceptés indifféremment
depuis l'une ou l'autre — un client n'a pas à choisir laquelle porte l'ordre,
ni à relayer artificiellement par l'autre. `caravan_cancel`, lui, ne voyage
que sur la connexion monde : c'est un ordre du **propriétaire** de la
caravane, identifié par sa clé, sans rapport avec une salle.

**`caravan_depart`** — expédier. Accepté depuis :

1. la connexion de **salle** `tile-<fromTile>` — l'auteur y est identifié par
   le `world_join` fait sur cette même connexion (schéma historique : une
   connexion qui porte à la fois le monde et la salle) ;
2. **ou** la connexion **monde** d'un joueur **présent dans la salle**
   `tile-<fromTile>` par n'importe laquelle de ses connexions. La présence se
   vérifie par la **clé** de joueur : une connexion de salle qui a fait
   `world_join` (avec le jeton) porte cette clé, comparée directement ; une
   connexion de salle qui ne l'a pas fait ne porte pas de clé, et le serveur
   compare alors son nom de salle (`join.name`) au nom d'affichage du joueur
   monde — un **repli v1**, moins sûr (deux joueurs peuvent partager un nom),
   mais nécessaire tant qu'une connexion de salle peut rester anonyme.

Dans les deux cas il faut être **dans la salle** : le propriétaire de la
colonie de départ n'a aucun privilège à distance, les colons partent d'une
carte ouverte (§12.5). `manifest` est l'encodage postcard du convoi produit
par le sim, opaque ; `summary` est ce que le client en sait, pour l'affichage
sur le globe.

```json
{
  "type": "caravan_depart",
  "fromTile": 1732,
  "toTile": 1810,
  "manifest": "BQAAAAMAAAA=",
  "summary": { "pawns": 3, "items": [[0, 40], [4, 12]] }
}
```

`summary.items` est une liste de `[kind, count]`, `kind` étant la valeur de
`items::ItemKind` du sim (le contrat d'enum d'`AGENTS.md`). Le serveur ne le
vérifie pas contre le manifeste : **il ne peut pas**, il ne le décode pas.
C'est un texte d'affichage, pas une autorité — rien dans le sim ne doit en
dépendre.

**`caravan_cancel`** — faire demi-tour, avant la moitié du trajet.

```json
{ "type": "caravan_cancel", "id": "c7" }
```

**`caravan_delivered`** — l'hôte de la case d'arrivée confirme avoir émis la
commande d'entrée du convoi en lockstep. Accepté depuis :

1. la connexion de **salle** de la case d'arrivée — le chemin historique, qui
   n'exige même pas `world_join` (§12.5) : n'importe quel membre de cette
   salle peut confirmer, pas seulement l'hôte, une confirmation tardive après
   un changement d'hôte restant vraie ;
2. **ou** la connexion **monde** d'un joueur qui est **l'hôte** de cette
   salle — vérifié par la même règle de présence que `caravan_depart` (clé,
   ou nom en repli). Ce chemin-là, à la différence du précédent, exige d'être
   l'hôte : une connexion monde seule ne prouve rien d'autre sur son auteur.

```json
{ "type": "caravan_delivered", "id": "c7" }
```

### 12.4 Messages, serveur → client

**`world_caravans`** — toutes les caravanes connues, diffusé aux joueurs du
monde. Liste complète comme `world_settlements` : le client remplace la sienne.
Envoyé à chaque changement et **au plus une fois par `CARAVAN_TICK_MS`** ; tant
qu'une caravane bouge, il repart à chaque tick du monde pour porter
l'avancement.

`owner` est la clé du joueur qui l'a expédiée (§11.2), `ownerName` son nom
d'affichage résolu à la diffusion.

```json
{
  "type": "world_caravans",
  "caravans": [
    {
      "id": "c7",
      "owner": "8a1b2c3d-...-e4",
      "ownerName": "alice",
      "fromTile": 1732,
      "toTile": 1810,
      "route": [1732, 1745, 1799, 1810],
      "departedAt": 412.5,
      "arrivesAt": 436.5,
      "progress": 0.25,
      "currentTile": 1732,
      "summary": { "pawns": 3, "items": [[0, 40], [4, 12]] },
      "status": "travelling"
    }
  ]
}
```

- `route` vient de `findRoute` : les cases traversées, départ et arrivée
  compris (`docs/world.md` §5).
- `departedAt` et `arrivesAt` sont des **heures de jeu**, flottantes.
- `progress` est linéaire sur la durée : `(now − departedAt) / (arrivesAt −
  departedAt)`, borné à `[0, 1]`.
- `currentTile` vaut `route[floor(progress × (route.length − 1))]`. La caravane
  ne s'arrête donc pas case par case : elle avance à vitesse constante sur un
  itinéraire dont le **coût**, lui, tient compte des biomes traversés.
- Les deux derniers sont **dérivés** du temps par le serveur, jamais stockés :
  un client peut les interpoler entre deux messages, le serveur a le dernier mot.

**`caravan_arrive`** — envoyé à **l'hôte** de la salle de la case d'arrivée,
sur sa connexion de salle **et**, si elle existe, sur sa connexion monde
séparée (même clé, ou même nom en repli — la règle de présence de
`caravan_depart`) : les deux connexions d'un même client reçoivent alors
chacune leur exemplaire. Ce n'est pas un second destinataire, c'est le même
hôte joignable par deux fils ; le client **ignore les doublons par `id`**
(§12.5), une seule confirmation suffisant.

```json
{
  "type": "caravan_arrive",
  "id": "c7",
  "tile": 1810,
  "manifest": "BQAAAAMAAAA=",
  "summary": { "pawns": 3, "items": [[0, 40], [4, 12]] }
}
```

**Codes de `world_error` ajoutés** :

| code | quand |
|---|---|
| `caravan_no_route` | aucun chemin terrestre entre les deux cases (`findRoute` rend `null`) |
| `caravan_same_tile` | départ et arrivée sur la même case |
| `caravan_not_in_room` | expédier ou livrer sans être dans la salle de la case concernée |
| `caravan_not_found` | caravane inconnue, ou dans un état qui ne se prête pas à l'action |
| `caravan_too_late` | annulation demandée après la moitié du trajet |

Les codes déjà en place servent aussi : `bad_tile` (case hors du globe),
`not_owner` (annuler la caravane d'un autre), `not_in_world` (ordre reçu avant
`world_join`).

### 12.5 Les règles

**Qui peut expédier.** Il faut être dans le monde **et** dans la salle de
`fromTile`. Le propriétaire de la colonie n'a toujours aucun privilège
particulier : un visiteur présent dans la salle peut expédier une caravane en
son propre nom (`owner` est la **clé** de l'expéditeur, pas celle du
propriétaire de la case). C'est un choix délibéré, indépendant de l'identité
par jeton (§11.2) — être dans la salle `tile-<id>` suffit à prouver que la
case est colonisée, le serveur n'ouvre pas la salle d'une case libre — et ce
sera à revoir le jour où des droits de colonie existeront.

**Annulation.** Seule une caravane `travelling` s'annule, et seulement tant que
`progress < 0.5` : au-delà, elle est plus près de sa destination que de chez
elle. Elle repart alors de sa **position courante** vers sa case d'origine, sur
un itinéraire **recalculé** — entrer dans une case coûte le prix de son biome,
donc reprendre le chemin à l'envers ne donne pas la même durée. `fromTile`
devient la case du demi-tour, `toTile` la case d'origine.

**Arrivée sur une colonie existante.** Si la salle est ouverte et en jeu,
`caravan_arrive` part vers son hôte. Si elle est fermée (colonie gelée) ou
encore en `lobby` — pas de carte, donc rien où injecter le convoi — l'arrivée
**attend**. Elle repart dès que la salle a un hôte en jeu : à la réouverture
(la salle rouvre depuis son snapshot conservé, §11.6, puis reçoit l'arrivée) ou
au `start` de l'hôte.

**Arrivée sur une case libre.** Le serveur **fonde la colonie** au nom du
propriétaire de la caravane : la case ne peut être que terrestre, un itinéraire
n'en traverse pas d'autres. Un `world_settlements` l'annonce à tout le monde.
La salle, elle, n'est pas créée pour autant : elle s'ouvrira en `lobby` au
premier `join`, comme toute salle de case sans snapshot. **La colonie « naît »
quand quelqu'un l'ouvre** ; jusque-là elle existe sur le globe, et le manifeste
attend au chaud.

**Attente et réémission.** Tant que le serveur n'a pas reçu
`caravan_delivered`, la caravane reste `arrived` et son `caravan_arrive` est
**réémis** — au nouvel hôte si l'hôte change, au premier hôte si la salle
rouvre. Une arrivée ne se perd donc pas parce qu'un joueur a fermé son onglet
au mauvais moment. En contrepartie, l'hôte doit accepter de **recevoir deux
fois** la même arrivée s'il a répondu au moment où il partait : le duplicata
est possible, la perte ne l'est pas. C'est le compromis choisi ; l'`id` permet
au client de reconnaître un doublon s'il tient un journal.

`caravan_delivered` est le seul message de cette section qui n'exige pas
`world_join` : il répond à un `caravan_arrive` reçu **dans une salle**, et un
client peut très bien jouer une case sans être entré dans le monde. Ce qu'il
exige, c'est d'être dans la salle de la case d'arrivée. Le serveur ne vérifie
pas que son auteur est encore l'hôte : seul l'hôte reçoit `caravan_arrive`, et
une confirmation qui arrive après un changement d'hôte reste vraie.

**Redémarrages.** Caravanes, manifestes et horloge sont persistés (§11.8) : un
redémarrage reprend les voyages en cours à l'heure de jeu où ils en étaient.
Une arrivée non confirmée avant l'arrêt est toujours en attente après.

### 12.6 Ce que le serveur garde

`WorldState.toJSON()` porte, en plus des colonies et des snapshots :

- `clock` : `{ worldStartedAt, hoursOffset }` (§12.1) ;
- `caravans` : `{ nextId, caravans: [...] }`, chaque caravane avec son
  itinéraire, ses heures, son statut et son **manifeste en base64** — la même
  convention que les snapshots, le JSON ne transporte pas de binaire.

Les arrivées en attente ne sont **pas** un second état : ce sont exactement les
caravanes de statut `arrived`. Une seule source de vérité, donc rien à
resynchroniser entre deux structures, et le manifeste est persisté avec la
caravane qui le porte.

Les identifiants (`c1`, `c2`, …) ne sont jamais réutilisés, `nextId` étant
persisté avec le reste.

### 12.7 Ce dont le client aura besoin

Les exemples ci-dessous envoient `caravan_depart` et `caravan_delivered` sur
`socket`, la connexion de **salle** (Worker) : c'est le chemin historique, et
il continue de fonctionner tel quel. Mais le serveur accepte maintenant ces
deux messages aussi bien depuis la connexion **monde** que depuis la
connexion de salle (§12.3) — un client peut donc les envoyer directement
depuis `WorldClient` (thread principal), là où vit déjà `world_join`, sans
détour par le Worker ni `world_join` paresseux sur la connexion de salle pour
se faire reconnaître : la présence dans la salle suffit, prouvée par la clé ou,
à défaut, par le nom (§12.3).

**Côté hôte de la case de départ** — vider la file de départs du sim à chaque
tour de boucle :

```ts
// Le sim a produit des manifestes (le joueur a formé une caravane).
for (const departure of sim.pendingDepartures()) {          // manifeste + destination
  socket.send(encodeMessage({
    type: "caravan_depart",
    fromTile,                                                // la case de cette salle
    toTile: departure.toTile,
    manifest: departure.manifest,                            // octets postcard, opaques
    summary: sim.describeManifest(departure.manifest),       // pawns + [kind, count][]
  }));
}
// Puis on retire ces départs de la file du sim, **en lockstep** : c'est une
// commande comme une autre, elle doit passer par le même chemin que le reste.
issue(encodeClearDepartures());
```

Le point à ne pas rater : la lecture de la file est locale, mais son **vidage**
est une commande lockstep. Sans cela, les autres clients de la salle
garderaient une file que l'hôte a vidée dans son coin — et deux sims qui
divergent, c'est une désync (§7).

**Côté hôte de la case d'arrivée** :

```ts
case "caravan_arrive": {
  // Le convoi entre sur la carte : commande lockstep, comme un clic du joueur.
  issue(WasmSim.encode_arrive_caravan(message.manifest));
  // Puis on confirme, sinon le serveur réémettra l'arrivée.
  socket.send(encodeMessage({ type: "caravan_delivered", id: message.id }));
  break;
}
```

Répondre **après** avoir émis la commande, pas avant : tant que le serveur n'a
pas la confirmation, il garde l'arrivée, ce qui est exactement le comportement
voulu si le client meurt entre les deux. Et comme toute commande de lockstep,
l'effet n'arrive pas au clic mais avec le bundle (§5) : ne pas appliquer le
manifeste localement.

Si le client a ses deux connexions ouvertes, ce `caravan_arrive` peut arriver
**deux fois** — une fois sur chacune (§12.4) : le code ci-dessus s'exécuterait
alors deux fois avec le même `id`, poussant deux fois le même
`ArriveCaravan` dans la file du sim. Un journal des `id` déjà traités, tenu
par le client, évite ça : n'injecter et ne confirmer qu'au premier exemplaire,
ignorer le second. Une confirmation envoyée deux fois n'est pas gratuite côté
serveur — la seconde répond `world_error { code: "caravan_not_found" }`,
la caravane n'étant plus `arrived` — mais rien d'autre n'en dépend : un
client qui l'ignore ne perd rien.

**Sur le globe**, à la réception de `world_caravans` :

- tracer la ligne de `route` (les centres des cases, `world.tiles[id].center`) ;
- poser la caravane sur `currentTile`, ou interpoler entre
  `route[i]` et `route[i + 1]` avec `progress` pour un déplacement continu ;
- afficher `ownerName` (« caravane de bob ») et `summary` (« 3 colons,
  40 bois ») et le temps restant : `(arrivesAt − now) × WORLD_HOUR_MS`
  millisecondes réelles, `now` étant l'heure de jeu estimée depuis le dernier
  message ;
- distinguer les statuts : `returning` rentre, `arrived` attend qu'on ouvre la
  colonie d'arrivée — c'est une notification à afficher, pas une erreur ;
- proposer `caravan_cancel` tant que `progress < 0.5` et que `caravan.owner`
  vaut son propre `playerKey` (jamais `ownerName` contre son propre nom : deux
  joueurs peuvent le partager), griser le bouton au-delà plutôt que
  d'encaisser un `caravan_too_late`.

Le client peut appeler `findRoute` **en prévisualisation** avant d'envoyer
l'ordre (durée estimée, tracé), en acceptant que le serveur ait le dernier mot :
c'est sa route à lui qui voyage.
