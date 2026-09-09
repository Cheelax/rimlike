---
slug: banquise-survivable
status: claimed
claimed_by: Claude Fable (session orchestrateur)
claimed_at: 2026-09-09
layer: sim
scope:
  - crates/sim/src/biome.rs
  - crates/sim/src/animals.rs
  - crates/sim/src/storyteller.rs
  - crates/sim/tests/balance_biomes.rs
  - crates/sim/tests/biomes.rs
  - crates/sim-cli/CAMPAIGN-FINDINGS.md
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo (hash 402c950b5ca15d90 inchangé)
  - cargo test -p sim --release --test balance_biomes measure_survival -- --ignored --nocapture → banquise ≥ 10/20 (la moitié du témoin tempéré, 18/20), toundra et désert inchangés (19/20, 20/20)
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --biome 1 → colonies vivantes ≥ 9/30 (la moitié du témoin tempéré, 18/30) et famine < 50 % des morts
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --biome 1 --climate -100 → colonies vivantes ≥ 5/30 (la moitié de la campagne froide de référence, 11/30 en tempéré à −50)
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --biome 4 → identique colonne par colonne à la référence du 2026-09-09 (18/30 vivantes, 207 morts)
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6 → OK
done_in:
---

# Une banquise survivable : vivre de chasse sur la glace

## Constat mesuré (2026-09-09, `main` à `1aa8a3c`)

La banquise est le seul biome du globe **impossible** à jouer, et ce n'est pas une
question de graine : c'est la table.

- Banc `tests/balance_biomes.rs::measure_survival` (20 graines, 24×24, 10 jours, joueur
  maigre) : **banquise 0/20**, toundra 19/20, désert 20/20, témoin tempéré 18/20.
- Campagne `--biome 1` (30 graines, 64×64, 30 jours) : **30/30 colonies éteintes, 90 morts,
  100 % famine, plus aucun colon vivant au jour 10**, 0 raid reçu (rien à piller), richesse
  finale 230 à 582. Identique à `--climate -150`.
- Garde-manger au jour 1 (`measure_larder`, 64×64) : **0 case semable, 0 case de sol,
  0 buisson**, 2 à 4 bêtes sauvages — comme partout ailleurs.

Le mécanisme : une colonie de trois mange trois repas par jour, soit 15 unités crues
(`pawn::HUNGER_DECAY`, `farm::RAW_PER_MEAL`). Sur la glace il n'y a ni potager ni baies
(`BiomeTable::has_no_soil` et `bush_density: 0`, et `Map::force_soil` ne verdit que le
sable : c'est voulu, une calotte ne dégèle pas). Il ne reste que la chasse : une harde
tous les 2 à 4 jours (`storyteller.rs`, `next_herd_at`), de 2 à 4 cerfs ou lapins
(`animals::spawn_herd`), un cerf rendant 12 viandes et un lapin 2
(`Species::meat`). Soit **7 unités par jour au mieux quand il en faut 15**, et encore
faut-il un colon armé pour chasser (poste de fabrication à 10 bois, puis un arc). La
chasse telle qu'elle est cadencée est **insuffisante d'un facteur deux**, avant même de
compter le temps de s'armer. Ce n'est pas le joueur scripté : il chasse dès que la viande
manque (`campaign.rs`, `MEAT_PER_COLONIST`), et le joueur maigre du banc aussi.

À l'inverse, **la toundra n'a pas ce problème** : ses 34 à 81 buissons nourrissent, et sa
survie est mesurée à 19/20 sur le banc et 22/30 en campagne (8/30 à `--climate -50`) —
voir §14 du rapport. Cette fiche ne la touche pas.

## Design imposé

La banquise nourrit par la **chasse** et conserve par le **froid** (la fraîcheur des
piles est déjà divisée par quatre sous 5 °C et gelée sous zéro, `climate::spoilage_divisor`) :
c'est le seul levier cohérent avec la table, et c'est celui-là qu'on mesure.

- **Une seule entrée nouvelle dans `BiomeTable`**, entière, en pour mille, qui règle
  l'abondance du gibier : cadence des hardes (`next_herd_at`) et/ou taille des hardes
  (`spawn_herd`), au choix de la mesure. Sa valeur est **1000 pour toutes les tables
  existantes** — la cadence d'aujourd'hui — et seule `ICE` porte une autre valeur. Les
  bêtes de départ (`spawn_starting_animals`) peuvent suivre la même entrée.
- **Le flux RNG ne change pas d'ordre** : mêmes tirages, dans le même ordre, sur les
  biomes à 1000 — seules les valeurs tirées sont mises à l'échelle sur la glace. C'est ce
  qui garantit `demo` inchangé et les empreintes tempérées gelées.
- Les hardes de la banquise restent faites des **trois espèces existantes**. Le cerf de la
  glace s'appelle toujours cerf.
- **On mesure avant de régler** : partir de la cadence d'aujourd'hui, mesurer au moins deux
  valeurs (par exemple hardes deux fois puis trois fois plus fréquentes, ou deux fois plus
  grosses), garder la plus petite qui passe les critères, et **écrire les rejets** avec
  leurs chiffres au §14 du rapport. Si la survie plafonne quelle que soit l'abondance,
  chercher le goulot dans la trajectoire (relevé `measure_trajectories` étendu à la
  banquise : quel jour meurt-on, avec combien de viande en stock, un arc en main ou pas)
  et le dire — c'est un résultat.

## Interdit

- Dégeler, verdir ou planter la glace : `has_no_soil` reste vrai pour `ICE`,
  `Map::force_soil` ne touche toujours que le sable, `bush_density` et `tree_density`
  d'`ICE` restent à 0, la signature (`tests/biomes.rs::each_biome_has_its_signature` :
  neige > 900 ‰, 0 arbre, 0 buisson, 0 herbe sur la composition nue) tient.
- Une nouvelle espèce, un nouveau genre d'objet, un nouveau `Command`, une variante
  d'`EventKind`.
- Toucher `MAX_ANIMALS` globalement, la conservation (`climate.rs`), la chasse (`jobs.rs`,
  `combat.rs`), les rendements (`Species::meat`).
- Adapter le joueur scripté (`crates/sim-cli/src/campaign.rs`) : si c'est lui qui bloque,
  le rapport le dit et la fiche s'arrête là.
- Un flottant, une `HashMap`, une horloge (`AGENTS.md`).

## Tests attendus

- Dans `tests/balance_biomes.rs` : un test statistique `ice_colonies_survive_often_enough`
  sur le patron de `desert_colonies_survive_often_enough` (banquise ≥ la moitié du témoin
  tempéré, témoin joué seulement si nécessaire), et le relevé `#[ignore]` qui a servi à
  choisir la valeur.
- Un test qui prouve que les biomes à 1000 tirent **exactement** les mêmes hardes qu'avant
  (empreinte d'état après N jours sur une graine tempérée, comparée à la valeur figée du
  2026-09-09 — la relever avant de toucher au code).
- Un test unitaire de la table : toutes les tables sauf `ICE` à 1000.

## Marche à suivre pour vérifier

1. `cargo test --workspace` en debug (le banc de survie tourne à 24×24 sur 10 jours pour
   tenir le budget : voir `SIZE`/`DAYS` dans `balance_biomes.rs`).
2. Les deux `measure_*` en release et les campagnes de l'en-tête ; recopier les résumés
   avant/après dans le rapport §14 (par graine pour la banquise).
3. `verify … demo` et un `fuzz` court.

## Rapport attendu

Une section **§14.2** dans `crates/sim-cli/CAMPAIGN-FINDINGS.md` : protocole, le goulot,
la valeur gardée et pourquoi, les rejets chiffrés, avant → après (banc et campagne, y
compris la campagne froide), ce que la mesure laisse ouvert. Une ligne dans le journal de
`docs/PLAN.md` est écrite par l'orchestrateur à la fusion.
