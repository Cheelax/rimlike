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
                      # WORLD_PERSIST=0 pour désactiver la persistance
cargo fmt --all       # la CI vérifie le formatage
cargo run -p sim-cli --release -- bench --size 128 --ticks 20000   # référence de perf du sim
cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo
```

`crates/sim-cli` (binaire `rimlike-sim`) exécute le sim en natif : `run` (stats et hash),
`verify` (deux sims comparées), `snapshot` (aller-retour), `bench`. Référence mesurée le
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
  écrire des scénarios reproductibles.

## Contrats entre Rust et TypeScript

Les valeurs numériques des enums sont un contrat, à modifier des deux côtés :

| Rust | TypeScript |
|---|---|
| `map::Terrain`, `Feature`, `Zone`, `Designation` | `apps/client/src/render/terrain.ts` |
| `items::ItemKind` | `terrain.ts` (`ITEM_NAMES`, `ITEM_COLORS`) |
| `build::BuildKind`, `Material` | `terrain.ts` (`BUILD_KIND`, `MATERIAL`, `WALL_COLORS`, `DOOR_COLORS`) |
| `pawn::Faction` (0 colonie, 1 pillard), `EventKind` | `Renderer.ts`, `App.tsx` (index 10 du tampon pawn), `terrain.ts` (`eventLabel`) |
| `work::WorkType` (6 types), `weather::Weather` (0 clair, 1 pluie, 2 orage) | `terrain.ts` (`WORK_LABELS`, `WEATHER_LABELS`), `Renderer.ts` (`setWeather`) |
| `work::Skill` (niveau 0-20, xp), `EventKind::LevelUp = 7`, `pawn_name(id)` | à exposer côté client (tampon `skills`, stride 13 : id puis niveau/xp par type dans l'ordre de `WorkType::ALL`) |
| `pawn::Job::code()` | `terrain.ts` (`JOB_LABELS`) |
| `sim-wasm` : `PAWN_STRIDE` = 12, `ITEM_STRIDE` = 5, `BLUEPRINT_STRIDE` = 8, `EVENT_STRIDE` = 4, `PRIORITY_STRIDE` = 7, `SKILL_STRIDE` = 13, drapeaux | `Renderer.ts` (`PAWN_STRIDE`, `ITEM_STRIDE`, `PAWN_FLAGS`), `terrain.ts` (`BLUEPRINT_STRIDE`, `EVENT_STRIDE`) |

Les vues mémoire (`tiles`, `features`, `zones`, `designations`) sont en zéro-copie sur la
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
  (WebSocket navigateur) et `WsTransport` (paquet `ws`, tests uniquement, jamais importé
  depuis `App.tsx`).
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
