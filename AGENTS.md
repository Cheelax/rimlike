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

Le futur serveur monde (`apps/server`, phase 4) relaie les commandes et gère le globe ;
il ne simule pas les cartes.

## Commandes

```bash
pnpm install          # dépendances JS (Rust : rustup lit rust-toolchain.toml)
pnpm dev              # compile le WASM puis lance Vite sur :5173
pnpm test             # cargo test --workspace (dont le test de déterminisme)
pnpm lint             # cargo clippy -D warnings + tsc --noEmit
pnpm build:wasm       # à relancer après TOUTE modification Rust avant de tester le client
pnpm build            # WASM + typecheck + build de production
cargo fmt --all       # la CI vérifie le formatage
```

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
| `pawn::Job::code()` | `terrain.ts` (`JOB_LABELS`) |
| `sim-wasm` : `PAWN_STRIDE` = 10, `ITEM_STRIDE` = 5, `BLUEPRINT_STRIDE` = 8, drapeaux | `Renderer.ts` (`PAWN_STRIDE`, `ITEM_STRIDE`, `PAWN_FLAGS`), `terrain.ts` (`BLUEPRINT_STRIDE`) |

Les vues mémoire (`tiles`, `features`, `zones`, `designations`) sont en zéro-copie sur la
mémoire WASM : à recréer après chaque appel au sim, jamais conservées. `pawns()`,
`items()` et `blueprints()` renvoient des copies. Le client rebâtit ses meshes quand `map_version` ou
`overlay_version` change, pas à chaque frame.

## Conventions côté client

- `Renderer.ts` ne connaît que des tampons plats et ne décide rien.
- `App.tsx` possède la boucle à pas fixe (60 ticks/s, rattrapage borné), les entrées et
  le HUD. L'état de jeu affiché est relu depuis les tampons, pas dupliqué en React.
- Toute action du joueur passe par `SimHandle` → méthode `WasmSim` → `Command`.
- Souris : glisser gauche trace un rectangle quand un outil est actif, sinon déplace la
  caméra ; glisser droit et flèches déplacent toujours ; clic droit = ordre en sélection,
  retour à la sélection en mode outil.
- L'init wasm-bindgen est mémoïsée dans `SimHandle.ts` : React StrictMode monte deux fois
  et deux inits concurrentes corrompent la mémoire. Ne pas contourner.

## Vérifier dans le navigateur

`pnpm dev`, puis ouvrir http://localhost:5173. En mode dev, `window.__rimlike` expose :
`sim` (SimHandle), `renderer`, `pawns()`, `paused`, `speed`, `selected`, `setTool(id)`,
`actions.current.save()/load()`. Exemple de scénario reproductible depuis la console :

```js
const d = window.__rimlike; d.paused = true;
const s = d.sim, p = s.pawns(), px = Math.floor(p[1] / 256), py = Math.floor(p[2] / 256);
s.setZone(1, px + 2, py + 2, px + 4, py + 4);          // stockage 3x3
s.designate(1, px - 10, py - 10, px + 10, py + 10);   // couper les arbres autour
s.build(0, 0, px - 5, py - 5, px + 5, py - 5);        // plans de mur en bois (kind, matériau, rect)
s.step(5000); Array.from(s.storedTotals());           // [bois, pierre, baies] rangés
s.blueprints().length / 8;                            // chantiers restants
d.paused = false;
```

Un onglet en arrière-plan ne reçoit presque plus de frames : les tps et fps affichés
chutent sans que ce soit un bug (le sim passera dans un Worker en phase 3).

## Style

- Commentaires, documentation, messages de commit et textes du jeu en français ;
  identifiants en anglais.
- Messages de commit : une ligne de titre préfixée par la phase (`phase 2b : ...`) ou
  `chore:`/`docs:`, puis le détail par couche (sim, sim-wasm, client).
- Pas de dépendance ajoutée au sim sans raison écrite dans le plan. Le crate reste petit.
