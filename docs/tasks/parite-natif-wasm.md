---
slug: parite-natif-wasm
status: claimed
claimed_by: Claude Fable (session orchestrateur)
claimed_at: 2026-09-10
layer: sim
scope:
  - crates/sim/src/scenario.rs (nouveau)
  - crates/sim/src/lib.rs (export du module)
  - crates/sim/tests/determinism.rs
  - crates/sim-cli/src/scenario.rs
  - crates/sim-wasm/src/lib.rs
  - apps/client/test/parity.test.ts (nouveau)
  - AGENTS.md (une ligne dans la table des contrats)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo → OK, hash 402c950b5ca15d90 inchangé
  - pnpm build:wasm && pnpm --filter client typecheck && pnpm test:client → vert, dont apps/client/test/parity.test.ts
  - la même constante de hash est épinglée UNE fois côté Rust (crates/sim/src/scenario.rs) et lue côté TypeScript à travers la frontière WASM, jamais recopiée en dur dans le test client
  - le test Rust de determinism.rs compare le natif à cette constante ; le test client compare le WASM à la même constante → parité prouvée par transitivité
done_in:
---

# Parité natif / WASM : la preuve que le serveur peut simuler

## Pourquoi maintenant

La phase 6 (`docs/PLAN.md`) fait tourner le **même sim** en natif sur le serveur et en WASM
chez les clients, et le serveur devient l'autorité de désync. Tout repose sur une égalité
qui n'a **jamais été prouvée** : le test de déterminisme (`crates/sim/tests/determinism.rs`)
compare deux sims **natives**, et personne ne compare un hash natif à un hash WASM. Le
`hash` du scénario `demo` (`402c950b5ca15d90` pour graine 1, 64×64, 10 000 ticks) est cité
dans les fiches et le journal, mais épinglé dans aucun test : il se lit à la main avec
`verify`. Un `usize`, un `wrapping_*` ou un débordement traité différemment par les deux
cibles passerait inaperçu jusqu'à la première désync en production.

Au passage, le scénario `demo` existe **en deux copies** : `scripted_commands` dans
`tests/determinism.rs` et sa recopie dans `crates/sim-cli/src/scenario.rs` (« toute
modification du scénario de test doit être reportée ici »). Une seule source suffit.

## Design imposé

1. **Le scénario vit dans `crates/sim`** : nouveau module `crates/sim/src/scenario.rs`,
   exporté par `lib.rs`, avec `pub fn demo_commands(sim: &Sim, t: u64) -> Vec<Command>`
   (le `scripted_commands` d'aujourd'hui, déplacé à l'identique — pas une ligne de
   comportement ne change, le hash le prouve) et **une constante épinglée** :
   `pub const DEMO_HASH: u64 = 0x402c_950b_5ca1_5d90;` documentée comme « graine 1, 64×64,
   10 000 ticks, `Sim::new` (tempéré), `demo_commands` appliqué à chaque tick avant `step` —
   exactement ce que fait `rimlike-sim verify --scenario demo` ». Vérifier d'abord dans
   `crates/sim-cli/src/commands.rs` l'ordre exact (commandes puis `step`, ou l'inverse) et la
   construction (`Sim::new(seed, w, h)`) pour que la constante décrive bien la même partie.
   Le module est du sim ordinaire : mêmes lints (aucun flottant, aucune HashMap).
2. **`tests/determinism.rs`** utilise `sim::scenario::demo_commands` (la copie locale
   disparaît) et gagne un test `demo_hash_is_pinned` : joue la partie décrite ci-dessus en
   natif et affirme `state_hash() == scenario::DEMO_HASH`. Ce test **échoue quand le sim
   change** : c'est voulu, c'est le rôle d'un hash épinglé — celui qui change le sim met la
   constante à jour dans le même commit, et le dit (règle déjà appliquée aux empreintes de
   `tests/biomes.rs`).
3. **`crates/sim-cli/src/scenario.rs`** délègue à `sim::scenario::demo_commands` (sa copie
   disparaît ; `Scenario::Demo` reste).
4. **`crates/sim-wasm`** expose, sans logique : `WasmSim::step_demo(&mut self, n: u32)` qui,
   pour chaque tick, applique `sim::scenario::demo_commands(&self.sim, tick)` puis avance d'un
   tick (même ordre qu'en natif), et une fonction statique `demo_hash() -> String` qui rend
   `format!("{:016x}", sim::scenario::DEMO_HASH)` — le **même format** que `hash()`. Rien
   d'autre : pas de scénario écrit en Rust côté wasm, pas de constante recopiée.
5. **`apps/client/test/parity.test.ts`** charge le WASM depuis le disque comme
   `soloBiome-worker.test.ts` (`initSync` sur `src/wasm/sim_bg.wasm`, sans fetch), construit
   `new WasmSim(1n, 64, 64)` (vérifier le type attendu pour la graine u64 : `BigInt`),
   appelle `step_demo(10000)`, et affirme `hash() === WasmSim.demo_hash()`. Un second cas sans
   commande sur un autre biome (par ex. `new_in_biome(5n, 48, 48, 2)` toundra, 6 jours) couvre
   les chemins de code des biomes ; sa constante est **lue** de la même façon (ajouter
   `TUNDRA_IDLE_HASH` au module `scenario` si les empreintes de
   `tests/biomes.rs::the_other_biomes_draw_the_same_herds` ne sont pas déjà exposables — les
   réutiliser telles quelles est préférable à en créer d'autres).
6. **CI** : rien à ajouter si `pnpm test:client` couvre le nouveau test — le job `client`
   construit déjà le WASM avant. Vérifier que le test tient sous quelques secondes en Node
   (le WASM est compilé en `--release` par `pnpm build:wasm`).
7. **`AGENTS.md`** : une ligne dans la table des contrats (`step_demo`, `demo_hash`,
   `sim::scenario`) et une phrase dans « Invariants » : le hash `demo` est épinglé, le
   changer se fait dans le commit qui change le sim, avec la raison.

## Interdit

- Changer une commande, un tick, un ordre d'application du scénario : le hash doit rester
  `402c950b5ca15d90` **avant et après** cette fiche. S'il change, c'est que le déplacement a
  altéré quelque chose : trouver quoi, pas mettre la constante à jour.
- De la logique de jeu dans `sim-wasm` (il ne fait que transmettre au module `scenario`).
- Recopier la constante en dur côté TypeScript (elle traverse la frontière).
- Un flottant, une `HashMap`, une horloge dans `crates/sim`.

## Ce que le rapport doit dire

Le hash natif et le hash WASM obtenus (identiques, ou pas — **si le WASM diverge, c'est le
résultat le plus précieux que cette fiche puisse rendre** : le dire, chercher la cause dans
le sim, et ne rien masquer), le temps du test client, la ligne d'`AGENTS.md`. L'orchestrateur
écrit la ligne du journal à la fusion.
