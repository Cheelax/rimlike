---
slug: plancher-de-ressources
status: open
claimed_by:
claimed_at:
layer: sim
scope:
  - crates/sim/src/map.rs (ensure_resources seulement)
  - crates/sim/tests/biomes.rs (bornes signalées) ou crates/sim/tests/playability.rs (nouveau)
contract: aucun changement de stride ni d'enum ; la génération tempérée hors plancher reste bit-identique
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6
  - cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo
done_in:
---

# Le plancher de ressources ne doit ni enfermer ni compter le minerai comme de la pierre

**Constats d'une relecture indépendante** (Codex, `codex exec review --commit d151bbe`, gravité
P2, reproductions déterministes) :

1. **Connexité perdue** (`map.rs`, `ensure_resources`, vers les lignes 1352-1354) : avec
   `Sim::new_in_biome(77, 48, 48, Biome::BorealForest)`, les rochers ajoutés réduisent la terre
   atteignable depuis le centre de **1 547 à 10 cases** : les colons sont enfermés. Deux voisins
   libres ne garantissent pas qu'une case n'est pas un passage critique, et l'ensemble `seen`
   reste celui de la carte d'avant les ajouts.
2. **Veines comptées comme pierre** (vers les lignes 1297-1300) : `f.is_rock()` inclut
   `OreRock`, alors que `jobs::yield_of` ne lui fait produire que du minerai. Avec
   `Sim::new_in_biome(439, 16, 16, Biome::Mountain)` : 237 cases atteignables, quatre veines,
   **aucun rocher ordinaire**, et le plancher se croit satisfait. La colonie n'a pas de pierre
   pour une forge ou une tombe, contrairement au but de `MIN_ROCKS`.

**Design imposé** : (1) chaque obstacle forcé est posé seulement si la case n'est pas un point
d'articulation de la terre atteignable (recalcul de l'atteignabilité après chaque pose, ou test
local suffisant et prouvé), et la terre atteignable finale ne descend jamais sous la terre
atteignable initiale moins le nombre d'obstacles posés ; (2) `MIN_ROCKS` ne compte que
`Feature::Rock` ; les veines gardent leur propre part. La composition tempérée hors plancher
reste bit-identique (test existant) ; le hash de `demo` ne bouge que si le plancher intervient
sur la graine 1 de `demo` : le dire.

**Tests** : les deux reproductions ci-dessus deviennent des tests (terre atteignable après
plancher ≥ avant − obstacles posés, sur les biomes et graines cités et sur 20 graines × 3
tailles ; au moins `MIN_ROCKS` rochers **ordinaires** atteignables partout).

**Rapport attendu** : court : ce qui a changé, terre atteignable avant → après sur les deux
reproductions, hash de `demo`.
