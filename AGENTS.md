# Guide pour les agents et contributeurs

Ce fichier est le point d'entrée pour toute session de travail sur ce dépôt, quel que
soit le modèle ou l'outil. Lis-le en entier, puis lis `docs/PLAN.md` (architecture,
phases, journal des décisions) avant de proposer quoi que ce soit. Les décisions du
journal ne se rouvrent pas sans nouvel argument.

## Ce qu'est le projet

Un jeu de gestion de colonie à la RimWorld, en vue du dessus pseudo-3D, destiné à un
multijoueur sur un globe partagé. Trois couches indépendantes :

- `crates/sim` : la simulation, en Rust. Déterministe, sans rendu, sans réseau, sans
  horloge. Compile en natif (tests, futur serveur) et en WASM (navigateur).
- `crates/sim-wasm` : frontière wasm-bindgen, seule porte entre Rust et JavaScript.
  Zéro logique dedans : elle expose des méthodes et des tampons plats.
- `apps/client` : Vite + React + Three.js. Lit l'état du sim, envoie des commandes.
  Aucune règle de jeu côté TypeScript.

- `packages/protocol` : types de messages, codec et logique lockstep pure (sans I/O),
  partagés entre serveur et client. Zéro dépendance runtime.
- `apps/server` : relais WebSocket (salles, horloge par bundles, ordre des commandes,
  hashes, snapshots pour les rejoignants). Il ne simule pas et ne décode jamais les
  commandes. Voir `docs/protocol.md`.
- `packages/world` : géométrie du globe (géodésique → cases hexagonales), biomes,
  itinéraires de caravanes, sérialisation. Pur, sans I/O ; les flottants y sont permis
  (autorité serveur, pas de lockstep). Voir `docs/world.md`.

Le futur serveur monde (phase 4) s'appuiera sur ce relais pour gérer le globe.

## Commandes

```bash
pnpm install          # dépendances JS (Rust : rustup lit rust-toolchain.toml)
pnpm dev              # compile le WASM puis lance Vite sur :5173
pnpm test             # cargo test --workspace (dont le test de déterminisme)
pnpm lint             # cargo clippy -D warnings + tsc --noEmit
pnpm build:wasm       # à relancer après TOUTE modification Rust avant de tester le client
pnpm build            # WASM + typecheck + build de production
pnpm test:protocol    # tests du paquet protocole (vitest)
pnpm test:server      # tests du serveur relais, vrais WebSockets sur port éphémère
pnpm test:client      # tests du client lockstep contre le vrai serveur en mémoire (vitest)
pnpm test:world       # tests du globe (géométrie, biomes, itinéraires)
pnpm dev:server       # relais + serveur monde sur :8787 (GET /health, GET /world)
                      # env : PORT, WORLD_SEED (1), WORLD_SUBDIVISIONS (4),
                      # WORLD_STATE_FILE (apps/server/data/world-state.json ; vide = mémoire),
                      # WORLD_PERSIST=0 pour désactiver la persistance,
                      # WORLD_HOUR_MS (30000 : une heure de jeu = 30 s), CARAVAN_TICK_MS (5000),
                      # WORLD_MERCHANTS (2 caravanes marchandes PNJ ; 0 désactive), MERCHANT_STAY_HOURS (24),
                      # limites : MAX_MESSAGE_BYTES, MAX_SNAPSHOT_BYTES, MAX_MESSAGES_PER_SECOND,
                      # MAX_CONNECTIONS_PER_IP, MAX_ROOMS, MAX_PLAYERS_PER_ROOM, TRUST_PROXY
cargo fmt --all       # la CI vérifie le formatage
cargo run -p sim-cli --release -- bench --size 128 --ticks 20000   # référence de perf du sim
cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo
cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 40000 --runs 10 --commands-per-tick 6
```

`crates/sim-cli` (binaire `rimlike-sim`) exécute le sim en natif : `run` (stats et hash),
`verify` (deux sims comparées), `snapshot` (aller-retour), `bench`, `fuzz` (commandes
aléatoires et aberrantes, deux sims comparées, paniques attrapées ; bilan dans
`crates/sim-cli/FUZZ-FINDINGS.md`). Après tout changement du sim, relancer une campagne
de fuzz courte. Référence mesurée le
2026-09-05 sur carte 128×128 en release : ~2,2 M ticks/s à vide, ~0,6 M en pleine
activité, ~0,2 M avec 15 colons. Toute régression nette sur ces chiffres se justifie.

## Ordre de travail attendu

1. Modifier le Rust → `cargo test --workspace` → `cargo clippy --workspace --all-targets -- -D warnings`.
2. Si la frontière ou les tampons changent, mettre à jour `crates/sim-wasm`, puis
   `apps/client/src/sim/SimHandle.ts` et `apps/client/src/render/terrain.ts`.
3. `pnpm build:wasm` puis `pnpm --filter client typecheck`.
4. Vérifier dans le navigateur (voir « Vérifier dans le navigateur »).
5. `cargo fmt --all`, puis commit. Mettre `docs/PLAN.md` à jour dans le même commit si une
   phase avance ou si une décision est prise (section « Journal des décisions », datée).

Ne jamais commiter `target/`, `node_modules/`, `apps/client/src/wasm/` ni `dist/` : ils
sont dans `.gitignore`, vérifier avec `git status` avant `git add -A`.

## Invariants du sim (non négociables)

Ils sont imposés par les lints là où c'est possible, et par le test de déterminisme
`crates/sim/tests/determinism.rs` pour le reste.

- **Aucun flottant** dans `crates/sim` : `#![deny(clippy::float_arithmetic)]`. Positions en
  virgule fixe 24.8 (`fixed::Fx`, 256 = une case). Besoins en entiers `0..=1_000_000`.
  Racines et distances via `fixed::isqrt` et `map::chebyshev`.
- **Aucune structure à ordre aléatoire** : pas de `HashMap`, `HashSet`, `RandomState`,
  `Instant`, `SystemTime` (interdits dans `clippy.toml`). `Vec` parcourus par indice,
  `BTreeMap` si besoin d'une clé.
- **Aucune entropie hors `Rng`** : tout aléa passe par `self.rng`, dans un ordre fixe.
- **Recherches déterministes** : trier les candidats par `(distance, x, y)` puis tester les
  chemins dans cet ordre. Jamais « le premier trouvé » d'un ordre non maîtrisé.
- **Pas de balayage de carte sans court-circuit** : toute recherche qui parcourt les 16 384
  cases doit d'abord tester un compteur maintenu par `Map` (`designation_count`,
  `stockpile_count`, `growing_count`, `bed_count`, `campfire_count`). Un colon inactif
  relance sa recherche à chaque tick.
- **Tout l'état est dans `Sim`** et sérialisé par serde/postcard. Pas de cache non
  sérialisé qui influence le futur. Un nouveau champ = pensé pour le snapshot.
- **Les ordres du joueur sont des `Command`** appliquées au début d'un tick. Aucune
  mutation directe de l'état depuis l'extérieur en dehors des tests.
- Un test nouveau par comportement nouveau. Les cartes ASCII de `sim::testmap` servent à
  écrire des scénarios reproductibles. **On mesure avant de régler** : un équilibrage se
  fait avec un test statistique sur plusieurs graines (voir
  `first_raid_is_dangerous_but_survivable`), jamais à l'intuition.
- **Ajouter une variante de `Command` en fin d'enum** : postcard encode l'index, les
  manifestes et snapshots existants en dépendent.

## Contrats entre Rust et TypeScript

Les valeurs numériques des enums sont un contrat, à modifier des deux côtés :

| Rust | TypeScript |
|---|---|
| `map::Terrain`, `Feature`, `Zone`, `Designation` | `apps/client/src/render/terrain.ts` |
| `items::ItemKind` | `terrain.ts` (`ITEM_NAMES`, `ITEM_COLORS`) |
| `build::BuildKind`, `Material` | `terrain.ts` (`BUILD_KIND`, `MATERIAL`, `WALL_COLORS`, `DOOR_COLORS`) |
| `pawn::Faction` (0 colonie, 1 pillard), `EventKind` | `Renderer.ts`, `App.tsx` (index 10 du tampon pawn), `terrain.ts` (`eventLabel`) |
| `work::WorkType` (7 types), `weather::Weather` (0 clair, 1 pluie, 2 orage) | `terrain.ts` (`WORK_LABELS`, `WEATHER_LABELS`), `Renderer.ts` (`setWeather`) |
| `work::Skill` (niveau 0-20, xp), `EventKind::LevelUp = 7`, `pawn_name(id)` | tampon `skills`, stride 15 : id puis niveau/xp par type dans l'ordre de `WorkType::ALL` |
| `health::BodyPart` (0 tête … 5 jambe droite), `EventKind` 8 à terre / 9 secouru / 10 soigné, jobs 15 à terre / 16 secourt / 17 soigne, drapeau pawn `DOWNED = 32` | tampon `health`, stride 4 : id, sang 0-1000, conscience %, nombre de blessures ; `pawn_injuries(id)` : partie, sévérité, saignement, pansée |
| `Command::FastForward { ticks }` (borne 60 jours), `EventKind::FastForwarded = 13` (`arg` = jours écoulés) | `encode_fast_forward(ticks)` ; le serveur envoie `snapshot.frozenTicks` à la réouverture d'une colonie gelée, l'hôte l'émet une seule fois en première commande |
| `ItemKind` 6 gourdin / 7 épieu / 8 arc (`COUNT` = 9 : `stored_totals` et `craft_targets` ont 9 entrées), `Feature::CraftingSpot = 13`, `BuildKind::CraftingSpot = 5`, `EventKind::WeaponCrafted = 14`, jobs 18 fabrique / 19 s'équipe, `Command::SetCraftTarget` | `set_craft_target`, `encode_set_craft_target`, `craft_targets()`, `pawn_weapon(id)` (−1 si aucune), `pawn_combat_skills(id)` → `[mêlée niv, xp, tir niv, xp]` |
| `climate::Season` (0 printemps … 3 hiver), `Weather::Snow = 3`, `EventKind` 15 saison / 16 premier gel, `Command::SetClimate` (dixièmes de °C) | `set_climate`, `encode_set_climate`, `outdoor_temperature`, `tile_temperature(x, y)`, `pawn_comfort(id)`, `season`, `day_of_year`, `year_days`, vue `indoor` (u8 par case : 0 dehors, sinon numéro de pièce) et `indoor_version` |
| `Faction::Animal = 2`, `animals::Species` (0 cerf, 1 lapin, 2 sanglier), `ItemKind` 9-11 dépouilles / 12 viande / 13 cuir (`COUNT` = 14), `EventKind` 17 harde / 18 bête chassée / 19 sanglier attaque, jobs 20 chasse / 21 dépèce, `Command::Hunt { animal, on }` | tampon `animals` stride 3 : id, espèce, drapeaux (bit 0 chassée, bit 1 à apprivoiser, bit 2 à abattre ; la chasse seule vaut 1) ; `pawn_species(id)` ; `hunt`, `encode_hunt` |
| `ItemKind` 14 tunique / 15 manteau (`COUNT` = 16), `EventKind::ItemCrafted = 20` (`arg` = genre) | `pawn_apparel(id)` (−1 si aucun) ; fabrication par `SetCraftTarget` |
| `storyteller::Difficulty` (0 paisible … 3 difficile), `Command::SetDifficulty`, `EventKind` 21 raid annoncé (`arg` = type 0 charge / 1 archers / 2 siège) / 22 largage / 23 maladie / 24 coup de froid / 25 canicule, job 22 attend | `set_difficulty`, `encode_set_difficulty`, `difficulty()`, `wealth()`, `pawn_sick(id)` (ticks restants) |
| `traits::Trait` (0 travailleur … 11 sociable), `Command::SetCalendar { day_of_year }` | `pawn_traits(id)` (0 à 2 valeurs) ; `set_calendar`, `encode_set_calendar` ; le serveur envoie `start.dayOfYear`, l'hôte l'émet une fois après `SetClimate` |
| `Faction::Trader = 3` (job 22 à l'étal), `Command::Trade { give, give_count, take, take_count }`, `EventKind` 26 visite / 27 marchand furieux / 28 troc / 29 marchand mort | `trade`, `encode_trade`, `trader_present()` (id ou −1), `trader_leaves_in()`, `trader_offers()` → `[genre, quantité, prix] × n`, `buy_prices()` ; un troc refusé est silencieux : lire les offres avant de proposer |
| `caravan::CaravanManifest` (octets postcard opaques), `Command::FormCaravan` / `ClearDepartures` / `ArriveCaravan`, `EventKind` 11 départ / 12 arrivée | `departures_count`, `departure(i)`, `describe_manifest(bytes)` → `[colons, genres, kind, count, …]` ; le manifeste part au serveur monde (`caravan_depart`) et revient dans la commande `ArriveCaravan` de l'hôte d'arrivée (voir `docs/protocol.md` §12) |
| `BuildKind::Grave = 6` (5 pierre), `Feature::Grave = 14` / `GraveFilled = 15`, job 23 enterre, `EventKind::Buried = 30`, fraîcheur par pile selon la température de la case (`climate::spoilage_divisor`) | `item_freshness(id)` (‰ restant, −1 si non périssable) ; le tampon `items` ne change pas |
| `Command::TriggerTraderVisit` (débogage, comme `TriggerRaid`) | `trigger_trader_visit`, `encode_trigger_trader_visit` ; `rpc("triggerTraderVisit")` en dev |
| `work::WorkType::Research = 6` (`WORK_TYPES` = 7 : `PRIORITY_STRIDE` = 8, `SKILL_STRIDE` = 15), `BuildKind::ResearchBench = 7` (15 bois), `Feature::ResearchBench = 16`, job 24 recherche, `research::Tech` (0 agriculture, 1 médecine, 2 conservation, 3 archerie, 4 maçonnerie), `Command::SetResearch { tech }` (255 = aucune, invalide ignorée), `EventKind::ResearchDone = 31` (`arg` = tech) | `set_research`, `encode_set_research`, `research_state()` → `[courante, (avancement, coût, acquise) × 5]`, `tech_cost(tech)` ; `WORK_LABELS` à 7 entrées |
| `social::Opinion` (avis −100..=100, 16 par colon), job 25 bavarde, `EventKind` 32 dispute / 33 rixe (`arg` = le plus petit des deux ids) / 34 ami perdu (`arg` = id du survivant) | `pawn_opinions(id)` → `[autre, avis] × n` trié par id, vide pour un non-colon ; aucun stride ne change |
| `BuildKind::SpikeTrap = 8` (5 bois, bois imposé), `Feature::SpikeTrap = 17` (armé) / `SpikeTrapSprung = 18`, job 26 réarme, `EventKind::TrapSprung = 35` (`arg` = id de la victime) ; `path::Walker` : les colons contournent les pièges armés | `build(8, …)` / `encode_build(8, …)` existants ; `BUILD_KIND`, `FEATURE` 17/18, `JOB_LABELS[26]`, `eventLabel(35)` |
| couche `fire` (u8 par case : 0 éteint, 1-3 intensité) et `fire_version`, `Command::Ignite { x, y }`, job 27 combat le feu, `EventKind::FireStarted = 36` (`arg` 0 foudre / 1 feu de camp / 2 ordre) / `FireOut = 37` (`arg` = cases enflammées) | vue zéro-copie `fire` (comme `indoor`), `fire_version`, `fire_count`, `ignite`, `encode_ignite` ; `JOB_LABELS[27]`, `eventLabel` 36-37 |
| élevage : une bête apprivoisée a `faction` 0 **et** une espèce (`Pawn::is_colonist` / `is_livestock`), `Command::Tame { animal, on }` (exclusif de `Hunt`), `Command::Slaughter { animal }`, jobs 28 apprivoise / 29 abat, `EventKind` 38 apprivoisée / 39 née / 40 abattue (`arg` = espèce) | `tame`, `encode_tame`, `slaughter`, `encode_slaughter`, `livestock_count()` ; les tampons `priorities` et `skills` excluent le bétail |
| `factions::NpcFaction` : 0 Clan des Cendres, 1 Fraternité du Fer (pillards), 2 Guilde des Colporteurs (marchands) ; réputation −100..=100 (hostile < −50, allié ≥ 50) ; `Command::Gift { faction, kind, count }` ; `EventKind` 41 raid repoussé (`arg` = tribu) / 42 tribut / 43 relation changée (`arg` = faction) | `goodwill()` (3 valeurs), statiques `faction_name(id)` et `faction_kind(id)` (0 pillards, 1 guilde, −1), `last_raid_faction()` (−1 si aucun), `gift`, `encode_gift` ; `trader_offers()` renvoie le prix déjà remisé (110 % si Guilde alliée) |
| `pawn::Job::code()` | `terrain.ts` (`JOB_LABELS`) |
| `sim-wasm` : `PAWN_STRIDE` = 12, `ITEM_STRIDE` = 5, `BLUEPRINT_STRIDE` = 8, `EVENT_STRIDE` = 4, `PRIORITY_STRIDE` = 8, `SKILL_STRIDE` = 15, `HEALTH_STRIDE` = 4, drapeaux | `Renderer.ts` (`PAWN_STRIDE`, `ITEM_STRIDE`, `PAWN_FLAGS`), `terrain.ts` (`BLUEPRINT_STRIDE`, `EVENT_STRIDE`) |

Les vues mémoire (`tiles`, `features`, `zones`, `designations`, `indoor`, `fire`) sont en zéro-copie sur la
mémoire WASM : à recréer après chaque appel au sim, jamais conservées. `pawns()`,
`items()`, `blueprints()`, `events()` et `priorities()` renvoient des copies. Les avancements
de travail sont en centièmes de tick dans le sim (l'humeur module la vitesse) ; le tampon des
chantiers les émet divisés par 100. Le client rebâtit ses meshes quand `map_version` ou
`overlay_version` change, pas à chaque frame.

## Conventions côté client

- `Renderer.ts` ne connaît que des tampons plats et ne décide rien.
- `App.tsx` possède la boucle à pas fixe (60 ticks/s, rattrapage borné), les entrées et
  le HUD. L'état de jeu affiché est relu depuis les tampons, pas dupliqué en React.
- Toute action du joueur devient des octets postcard via `apps/client/src/sim/commands.ts`
  (`encode*`, qui appellent `WasmSim.encode_*`) puis passe par `issue(bytes)` : en solo
  `sim.applyEncoded`, en multi `LockstepClient.issue`. Ne jamais appliquer une commande
  localement en multi : elle revient dans un bundle.
- `apps/client/src/net/` : `LockstepClient` (logique pure, sans timer ni DOM), `Transport`
  (WebSocket navigateur), `ReconnectingTransport` (enveloppe une fabrique de transport :
  délai exponentiel 1 s → 15 s avec gigue, huit essais, planificateur injectable ; appelle
  `onReconnect` quand un transport neuf existe, `onClose` seulement à l'abandon) et
  `WsTransport` (paquet `ws`, tests uniquement, jamais importé depuis `App.tsx`). Salle et
  monde ont chacun leur transport reconnectant ; `LockstepClient.reconnect()` rejoue `join`
  et reprend par le snapshot du rejoignant, les commandes émises pendant la coupure sont
  comptées (`lastReconnectLostCommands`), jamais rejouées.
- Souris : glisser gauche trace un rectangle quand un outil est actif, sinon déplace la
  caméra ; glisser droit et flèches déplacent toujours ; clic droit = ordre en sélection,
  retour à la sélection en mode outil.
- L'init wasm-bindgen est mémoïsée dans `SimHandle.ts` : React StrictMode monte deux fois
  et deux inits concurrentes corrompent la mémoire. Ne pas contourner.

## Essayer le multijoueur

`pnpm dev:server` (relais sur :8787) et `pnpm --filter client dev`, puis deux onglets :
`http://localhost:5173/?server=ws://localhost:8787&room=demo&name=alice` et le même avec
`name=bob`. L'hôte clique « Démarrer ». Vérifier dans le HUD : même hash dans les deux
onglets, retard proche de 0, et une action faite dans l'un visible dans l'autre, y compris
onglet masqué (le Worker tient la cadence).

## Publication du client

Le workflow `.github/workflows/pages.yml` publie `apps/client/dist` sur GitHub Pages à chaque
push sur `main` (https://cheelax.github.io/rimlike/), avec `VITE_BASE=/rimlike/`. Le solo y
est complet ; multi et monde se branchent sur l'adresse de serveur saisie dans l'accueil
(`wss://` derrière un reverse proxy en production, voir `deploy/README.md`).

## Héberger le serveur

`apps/server/Dockerfile` (contexte = racine du dépôt) compile serveur et paquets partagés en
JavaScript pur (`pnpm --filter server run build:server` → `apps/server/dist/`) et lance `node`
sans TypeScript ; `deploy/docker-compose.yml` porte le volume `/data` de persistance. Mode
d'emploi : `deploy/README.md` ; variables : `apps/server/README.md`.

## Identité des joueurs

Pas de compte : le serveur remet un jeton secret au premier `world_join` et une clé publique
(`playerKey`) qui porte l'appartenance des colonies et des caravanes. Le client range le
jeton dans `localStorage` sous une clé **serveur + nom** (`identityScope`) : le nom saisi
sert de profil local. Ne jamais journaliser un jeton ; `__rimlike.world.forget()` l'oublie
pour tester `bad_token`. Détails : `docs/protocol.md` §11.2.

## Essayer le monde partagé

Même serveur que le multi. URL : `http://localhost:5173/?server=ws://localhost:8787&name=alice&world=1`
(ou l'accueil, bouton « Monde partagé »). Le globe se charge depuis `GET /world`, jamais
regénéré côté client. Pour les caravanes, lancer le serveur avec une horloge rapide :
`WORLD_HOUR_MS=1000 CARAVAN_TICK_MS=500 WORLD_PERSIST=0 pnpm dev:server`. Séquence console
sans souris (deux onglets, deux noms = deux joueurs) :

```js
const w = window.__rimlike.world;      // state, select(tile), tile(id), freeLand(n), settle(), visit(), abandon(), back()
const [tile] = w.freeLand(1); w.select(tile); w.settle();          // → salle tile-<id>, graine imposée
await window.__rimlike.rpc("lockstep.startGame", 0, 128, 128);    // l'hôte démarre
window.__rimlike.frame.tick;                                       // progresse
window.__rimlike.world.back(); window.__rimlike.world.state.settlements;
// caravane vers la colonie de l'autre onglet (case B) : un colon, sans marchandises
const p = await window.__rimlike.rpc("pawns");
await window.__rimlike.world.sendCaravan({ pawnIds: [p[0]], items: [], toTile: B });
window.__rimlike.world.caravans;           // status travelling → arrived → delivered
// chez l'autre : frame.pawns.length / 12 augmente de 1, événement kind 12
```

Le crochet `window.__rimlike` est **recréé** au passage globe → salle : relire
`window.__rimlike` après `settle()` plutôt que garder une référence.

## Vérifier dans le navigateur

`pnpm dev`, puis ouvrir http://localhost:5173 et cliquer « Partie solo ». Le sim et le
client lockstep tournent dans un **Web Worker** (`apps/client/src/worker/`) : le thread
principal ne fait que rendre et saisir. En mode dev, `window.__rimlike` expose :
`rpc(method, ...args)` (asynchrone, exécute dans le Worker une méthode de `SimHandle`, ou du
`LockstepClient` si préfixée `lockstep.`), `issue(bytes)`, `frame` (dernier état reçu :
`tick`, `hash` un frame sur 30, `lag`, `tps`, tampons), `net`, `renderer`, `setTool`,
`setMaterial`, `actions`, `paused`, `speed`, `selected`. Exemple reproductible :

```js
const d = window.__rimlike; d.paused = true;
const p = await d.rpc("pawns"), px = Math.floor(p[1] / 256), py = Math.floor(p[2] / 256);
await d.rpc("setZone", 1, px + 2, py + 2, px + 4, py + 4);         // stockage 3x3
await d.rpc("designate", 1, px - 10, py - 10, px + 10, py + 10);   // couper les arbres autour
await d.rpc("build", 0, 0, px - 5, py - 5, px + 5, py - 5);        // plans de mur en bois
await d.rpc("step", 5000);
Array.from(await d.rpc("storedTotals"));      // [bois, pierre, baies, légumes, repas, cadavres]
(await d.rpc("blueprints")).length / 8;       // chantiers restants
await d.rpc("triggerRaid"); await d.rpc("step", 3000);
await d.rpc("events");                        // journal (seq, tick, kind, arg)
d.frame.tick; d.paused = false;
```

En multi, `rpc("step", n)` est refusé : `await d.rpc("lockstep.pump", 8)`, `d.net.lag`,
`await d.rpc("lockstep.state")`. Un onglet masqué ne rend plus (0 fps, normal) mais le
Worker continue de ticker : `d.frame.tick` progresse, le retard multi reste proche de 0.

## Style

- Commentaires, documentation, messages de commit et textes du jeu en français ;
  identifiants en anglais.
- Messages de commit : une ligne de titre préfixée par la phase (`phase 2b : ...`) ou
  `chore:`/`docs:`, puis le détail par couche (sim, sim-wasm, client).
- Pas de dépendance ajoutée au sim sans raison écrite dans le plan. Le crate reste petit.
