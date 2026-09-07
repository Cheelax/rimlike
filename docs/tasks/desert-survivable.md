---
slug: desert-survivable
status: claimed
claimed_by: claude-opus (session Fable)
claimed_at: 2026-09-07
layer: sim
scope:
  - crates/sim/src/biome.rs
  - crates/sim/src/map.rs (plancher de jouabilité et oasis seulement)
  - crates/sim/src/farm.rs (si le sable devient cultivable au ralenti)
  - crates/sim/tests/biomes.rs (bornes signalées) et crates/sim/tests/balance_biomes.rs (nouveau)
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§13 nouveau)
contract: aucun changement de stride ni d'enum ; si une constante de biome bouge, le guide suit
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --biome 6
  - cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo   # tempéré inchangé
done_in:
---

# Une colonie du désert doit pouvoir survivre

**Constat mesuré** (rapport de l'agent biomes, 2026-09-07) : `campaign --seeds 5 --days 10 --size
64 --biome 6` éteint **5 colonies sur 5** par famine, contre 2/5 en tempéré, 1/5 en boréale, 3/5
en jungle, 2/5 en toundra. Cohérent avec la table du désert : aucun buisson, sol sableux
incultivable hors de l'oasis.

**Mesurer d'abord** : sur 30 graines et 30 jours (`--biome 6`), colonies vivantes, cause des
morts, jours de vivres, cases cultivables atteignables au jour 1 ; et les mêmes chiffres en
tempéré comme référence. Identifier le goulot : pas de baies au départ ? pas assez de terre
cultivable ? cultures trop lentes ?

**Pistes, une à la fois, mesurées** :
1. Élargir l'oasis (herbe cultivable et point d'eau) à un rayon garanti autour du centre.
2. Une plante à baies du désert (buissons rares mais présents : `bush_density` > 0 sur l'herbe).
3. Le sable cultivable au ralenti (`farm.rs` : pousse divisée par deux sur `Terrain::Sand`).
Garder la combinaison la plus petite qui atteint l'objectif ; documenter les rejets.

**Objectif chiffré** : survie à 30 jours en désert au moins égale à la **moitié** de la survie
tempérée sur les mêmes graines, sans changer la génération tempérée (hash de `demo` inchangé)
ni la signature du désert (sable > 50 %, arbres < 2 % : les bornes de `biomes.rs` peuvent
bouger un peu, en le signalant).

**Tests** : `desert_colonies_survive_often_enough` (statistique 20 graines, échoue avant), la
signature du désert conservée, déterminisme et fuzz verts.

**Rapport attendu** : court, en français : goulot identifié, piste gardée et rejets chiffrés,
survie désert / tempéré avant → après, fichiers, tests.
