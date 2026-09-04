# Protocole réseau — phase 3 (une carte, lockstep) et phase 4 (le monde)

Ce document décrit le protocole entre un client et le serveur (`apps/server`),
tel qu'implémenté par `packages/protocol`. Il est la référence pour
l'intégration côté client.

Les sections 1 à 10 décrivent le **lockstep sur une carte** : c'est la couche
de base, inchangée. La section 11 décrit la **couche monde** : le globe
partagé, les colonies et les salles adossées à une case, qui se posent
au-dessus sans rien modifier de ce qui précède.

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
| `PROTOCOL_VERSION` | 1 | Incrémentée à chaque changement incompatible |
| `TICK_RATE` | 60 | Ticks de sim par seconde |
| `BUNDLE_TICKS` | 3 | Ticks par bundle, donc 20 bundles/s |
| `BUNDLE_INTERVAL_MS` | 50 | Période d'émission d'un bundle |
| `HASH_EVERY_TICKS` | 300 | Période d'envoi du hash d'état (5 s) |
| `SNAPSHOT_EVERY_TICKS` | 1800 | Période du snapshot de conservation d'une case (30 s) |
| `MAX_HISTORY_BUNDLES` | 2000 | Historique conservé par salle (100 s) |
| `HEARTBEAT_MS` | 5000 | Période du `ping` serveur |
| `HEARTBEAT_TIMEOUT_MS` | 15000 | Silence toléré avant fermeture |
| `MAX_PLAYERS` | 4 | Joueurs par salle |

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

```json
{ "type": "snapshot", "tick": 1806, "data": "8QIAAAcAAAA=" }
```

**`desync`** — premier écart de hash constaté. Les clés de `hashes` sont des
identifiants de joueur (chaînes, JSON oblige).

```json
{ "type": "desync", "tick": 600, "hashes": { "1": "3f0a1c77b2e94d10", "2": "aa19f0b3c4d55e21" } }
```

**`error`** — message invalide ou action refusée. `code` est stable, `message`
est un texte de diagnostic (français, non destiné à l'affichage brut).

```json
{ "type": "error", "code": "not_host", "message": "seul le host peut démarrer" }
```

Codes émis en v1 (`ERROR_CODES`, liste ouverte : un client ne doit pas exiger
d'appartenir à cette liste) : `bad_message`, `version_mismatch`, `not_joined`,
`already_joined`, `room_full`, `not_host`, `already_running`, `not_running`,
`history_gap`, `no_host`.

## 4. Cycle de vie d'une salle

```
                 join (1er joueur)                 start (host)
   [ pas de salle ] ─────────────▶ [ lobby ] ──────────────────▶ [ running ]
          ▲                            │                              │
          │ dernier départ             │ join / leave                 │ écart de hash
          │ (salle détruite)           ▼                              ▼
          └────────────────────── [ lobby ]                     [ desynced ]
                                                                      │
                                          horloge et bundles continuent
                                          (v1 : on signale, on ne répare pas)
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
  `already_running`. `command`, `hash` ou `snapshot` avant `start` →
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

## 7. Détection de désync

- Chaque client envoie `hash { tick, hash }` quand `tick % HASH_EVERY_TICKS === 0`,
  avec la valeur de `WasmSim.hash()` **avant** d'exécuter ce tick.
- Le serveur compare **par tick**, entre les seuls joueurs qui ont annoncé ce
  tick : un joueur en retard n'invente pas un écart, il arrive plus tard.
- Au **premier** écart, le serveur diffuse `desync { tick, hashes }` à tous et
  passe la salle en `desynced`. Les écarts suivants ne sont pas rediffusés.
- En v1 on **signale seulement** : l'horloge et les bundles continuent. La
  réparation (resync forcée depuis le snapshot du host) est un chantier séparé,
  qui réutilisera tel quel le mécanisme du §8.
- Côté client, `desync` doit être visible dans le HUD : la partie n'est plus
  fiable, mieux vaut le dire que laisser deux colonies diverger en silence.

## 8. Rejoindre en cours

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

- **L'identité d'un joueur est son nom.** Il n'y a pas de compte : quiconque se
  connecte sous le nom du propriétaire d'une colonie est reconnu comme tel.
  C'est une limite assumée de cette tranche, à remplacer par de vrais comptes
  avant toute mise en ligne publique.
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
comme celui de `join`.

```json
{ "type": "world_join", "name": "alice", "protocol": 1 }
```

Un second `world_join` sur la même connexion répond `error already_joined`, et
une version incompatible `error version_mismatch` suivi d'une fermeture —
comme pour `join`. Toutes les autres actions de monde refusées répondent
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

```json
{
  "type": "world_welcome",
  "playerId": 2,
  "name": "bob",
  "settlements": [
    {
      "tile": 1732,
      "owner": "alice",
      "room": "tile-1732",
      "seed": 2007225770,
      "createdAt": 1757000000000
    }
  ],
  "players": ["alice", "bob"],
  "world": { "seed": 1, "subdivisions": 4, "tiles": 2562 }
}
```

**`world_settlements`** — diffusé à tous les joueurs du monde à chaque
fondation et à chaque abandon. Liste complète, triée par case : le client
remplace la sienne, il n'y a pas de delta.

```json
{ "type": "world_settlements", "settlements": [ … ] }
```

**`world_players`** — diffusé à chaque arrivée et à chaque départ du monde.

```json
{ "type": "world_players", "players": ["alice", "bob"] }
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
  `width`/`height` du snapshot) puis `snapshot { tick, data }`, et les bundles
  reprennent à ce tick. **Aucun hôte n'est sollicité et il n'y a rien à
  rejouer** : l'historique repart de zéro à ce tick.
- Sans snapshot connu (colonie toute neuve), la salle s'ouvre en `lobby` et
  l'hôte fait `start` normalement — avec la graine de la case.
- **Le temps ne s'est pas écoulé** pendant l'absence : la colonie reprend
  exactement où elle s'était arrêtée. L'avance rapide abstraite des cartes
  gelées (croissance, décomposition, faim) est une tranche future.

### 11.7 Enchaînement complet, côté client

```ts
// 1. Le globe, une fois, mis en cache par le navigateur.
const { wire } = await (await fetch(`${http}/world`)).json();
const world = deserializeWorld(wire);

// 2. Le monde, sur la WebSocket.
socket.send(encodeMessage({ type: "world_join", name, protocol: PROTOCOL_VERSION }));
// ← world_welcome { settlements, players, world }  puis world_settlements/world_players

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
- `world_settlements` → remplacer la liste et recolorer les cases possédées ;
- `world_error` → un message à l'écran, pas une déconnexion.

### 11.8 Persistance

Le seul état qui existerait à perdre est celui de `WorldState` (colonies et
derniers snapshots de conservation) : le reste (salles en jeu, connexions)
repart de toute façon d'un état neuf à chaque redémarrage. `apps/server/src/persistence.ts`
(`WorldStore`) écrit et relit cet état dans **un fichier JSON unique**.

**Format sur disque** — l'en-tête sert à valider le fichier avant d'y toucher,
`state` est exactement `WorldState.toJSON()` (§11.6 pour les snapshots) :

```json
{
  "version": 1,
  "worldSeed": 1,
  "subdivisions": 4,
  "savedAt": 1757000000000,
  "state": {
    "seed": 1,
    "subdivisions": 4,
    "settlements": [
      { "tile": 1732, "owner": "alice", "room": "tile-1732", "seed": 2007225770, "createdAt": 1757000000000 }
    ],
    "snapshots": [
      { "room": "tile-1732", "tick": 1800, "data": "AQIDBA==", "width": 64, "height": 64, "savedAt": 1757000000000 }
    ]
  }
}
```

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
  pas survivre à un changement de globe.
- `GET /health` expose l'état de la persistance :
  `persistence: { enabled, file, lastSavedAt }` (`lastSavedAt` : `null` tant
  qu'aucune écriture n'a encore eu lieu).

### 11.9 Ce qui n'est pas encore fait

- **Caravanes** : `findRoute` existe dans `packages/world`, aucun message ne
  les expose. Pas de déplacement entre cases.
- **Avance rapide abstraite** des cartes gelées : le temps ne passe pas dans
  une colonie vide.
- **Comptes** : l'identité est le nom, sans mot de passe ni jeton.
- **Horloge globale** du monde : il n'y en a pas encore, seulement l'horloge
  par salle.
