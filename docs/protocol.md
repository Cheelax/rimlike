# Protocole réseau — phase 3 (multi sur une carte, lockstep)

Ce document décrit le protocole entre un client et le serveur relais
(`apps/server`), tel qu'implémenté par `packages/protocol`. Il est la référence
pour l'intégration côté client et pour les ajouts à faire dans `sim-wasm`
(dernière section).

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
| `MAX_HISTORY_BUNDLES` | 2000 | Historique conservé par salle (100 s) |
| `HEARTBEAT_MS` | 5000 | Période du `ping` serveur |
| `HEARTBEAT_TIMEOUT_MS` | 15000 | Silence toléré avant fermeture |
| `MAX_PLAYERS` | 4 | Joueurs par salle |

## 2. Transport et format

- WebSocket, une connexion = un joueur = une salle. `http.createServer` sert
  aussi `GET /health` → `{"ok":true,"rooms":2}` sur le même port (`PORT`,
  défaut 8787).
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

```json
{ "type": "request_snapshot", "forPlayer": 3 }
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
- La salle est **détruite dès qu'elle est vide** (v1 : rien n'est persisté ;
  la persistance des cartes est un sujet de la phase 4).
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
- Il n'y a pas de reprise de salle : si tout le monde part, la salle disparaît.

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

## 10. Intégration côté sim-wasm à faire

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
