---
slug: plancher-de-ressources
status: done
claimed_by: claude-opus (session Fable)
claimed_at: 2026-09-07
layer: sim
scope:
  - crates/sim/src/map.rs (ensure_resources seulement)
  - crates/sim/tests/playability.rs (nouveau)
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (note en fin de §13)
contract: aucun changement de stride ni d'enum ; la génération tempérée hors plancher reste bit-identique
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6
  - cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo
done_in: commit du 2026-09-07 (main)
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

## Résultat (2026-09-07)

**Ce qui a changé**, dans `crates/sim/src/map.rs` seulement :

1. `Map::force_blockers` ne demande plus « deux voisines orthogonales libres »
   (un couloir d'une case de large en a deux) mais un **test d'articulation
   locale**, `Map::cuts_a_passage` : les voisines franchissables doivent former
   un seul arc autour de la case. La preuve de suffisance est écrite dans la
   documentation de la fonction — bloquer une case ne supprime que des liens
   dont les deux bouts sont dans son voisinage, et un arc unique les relie tous
   par des pas orthogonaux qui survivent au blocage. Le test se trompe donc
   toujours du côté sûr. Nouvelle constante `RING` (l'ordre du tour, distinct de
   `NEIGHBORS`), et `Map::free_neighbours` disparaît.
2. `Map::reachable_resources` ne compte plus que `Feature::Rock`. Les veines
   (`Feature::OreRock`) gardent leur part de biome mais ne satisfont plus
   `MIN_ROCKS`.
3. Aucun recalcul d'atteignabilité par pose : `seen` reste exact jusqu'au bout,
   puisque chaque pose ne retire qu'elle-même et qu'une case posée porte un
   élément, donc les spirales l'écartent déjà. C'est documenté dans
   `ensure_resources`. Les docs mensongères de `CENTER_KEEPOUT` et
   `force_blockers` (« un obstacle isolé ne peut couper aucune carte en deux »)
   sont corrigées.

**Terre atteignable, avant → après** (les deux reproductions de la fiche) :

| reproduction | avant | après |
|---|---|---|
| `Sim::new_in_biome(77, 48, 48, BorealForest)` | 1 547 → **10** cases pour 10 obstacles posés | 1 547 → **1 537**, soit exactement les 10 posés |
| `Sim::new_in_biome(439, 16, 16, Mountain)` | 245 cases, 4 veines, **0** rocher ordinaire pour 2 promis | 245 → 235, **2** rochers ordinaires posés |

Sur le balayage de 540 cartes (20 graines × 3 tailles × 9 biomes fondables) :
pire perte d'atteignabilité **0** case au-delà des obstacles posés, pire manque
de pierre **0** rocher. La banquise en graine 15 (48×48) était un second cas du
défaut n° 2 : 7 rochers ordinaires pour 10 promis, complétés par trois veines.

**Hash de `demo` : inchangé, `402c950b5ca15d90`.** Sa carte (graine de partie 1,
64×64, tempéré) est de celles que le plancher ne touche pas — zéro obstacle
posé, cartes nue et complétée bit-à-bit identiques, et déjà exactement dix
rochers ordinaires atteignables, donc la correction du compte n'y déclenche rien
non plus. Les trois empreintes gelées de `tests/biomes.rs` tiennent pour la même
raison, et n'ont pas été touchées.

**Tests** (nouveau fichier `crates/sim/tests/playability.rs`, quatre tests qui
échouent tous sur le code d'avant, plus un relevé `#[ignore] measure`) :
`the_boreal_clearing_is_not_walled_in`, `ore_veins_do_not_pass_for_stone`,
`the_resource_floor_never_seals_a_map`,
`every_settleable_map_has_stone_within_reach`.

**Critères d'acceptation** : `cargo fmt --all -- --check` OK ;
`cargo test --workspace` 0 échec (l'arbre de la session porte d'autres travaux
en cours, le total de tests n'est donc pas comparable) ; `cargo clippy --workspace
--all-targets -- -D warnings` OK ; `verify --seed 1 --size 64 --ticks 10000
--scenario demo` OK ; `fuzz --seed 1 --size 24 --ticks 20000 --runs 3
--commands-per-tick 6` 3 runs OK (jungle, montagne, forêt boréale).
Note en fin de §13 de `crates/sim-cli/CAMPAIGN-FINDINGS.md` (§13.9).
