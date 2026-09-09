---
slug: banquise-survivable
status: claimed
claimed_by: Claude Fable (session orchestrateur, seconde passe)
claimed_at: 2026-09-09
layer: sim
scope:
  - crates/sim/src/biome.rs
  - crates/sim/src/animals.rs
  - crates/sim/src/storyteller.rs
  - crates/sim/src/jobs.rs (try_start_hunt seulement)
  - crates/sim/tests/balance_biomes.rs
  - crates/sim/tests/biomes.rs
  - crates/sim/tests/gameplay.rs (un test de chasse à mains nues)
  - crates/sim-cli/CAMPAIGN-FINDINGS.md
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- verify --seed 1 --size 64 --ticks 10000 --scenario demo → OK ; hash 402c950b5ca15d90 inchangé, ou changé pour une raison écrite (le scénario chasse sans arme)
  - cargo test -p sim --release --test balance_biomes measure_survival -- --ignored --nocapture → banquise ≥ 10/20 (la moitié du témoin tempéré, 18/20) ; aucun autre biome ne perd plus d'une colonie sur vingt par rapport au relevé du 2026-09-09 (toundra 19, boréale 20, tempéré 18, prairie 20, désert 20, savane 20, jungle 11, montagne 17)
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --biome 1 → colonies vivantes ≥ 9/30 (la moitié du témoin tempéré) et famine < 50 % des morts
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --biome 1 --climate -100 → colonies vivantes ≥ 5/30 (la moitié de la campagne froide de référence, 11/30 en tempéré à −50)
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --biome 4 → colonies vivantes ≥ 17/30 (référence 18/30, 207 morts ; la chasse à mains nues a le droit de changer le tempéré, pas de le dégrader), et l'écart est expliqué dans le rapport
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6 → OK
  - le test ice_colonies_survive_often_enough sort de #[ignore] et passe
done_in:
---

# Une banquise survivable : vivre de chasse sur la glace

## Ce qui a été appris (première passe, 2026-09-09, PR #12)

La première passe a livré le **mécanisme** (`BiomeTable::game_density`, 2000 ‰ sur `ICE`,
1000 partout ailleurs, flux RNG intact, empreintes figées) et la **mesure**, mais **aucun
critère de survie n'est atteint** : banc 0/20, campagne 0/30, 100 % famine, de 1000 à
20000 ‰ d'abondance. Le rapport est au §14.2 de `CAMPAIGN-FINDINGS.md`. Le goulot n'est pas
la quantité de gibier :

1. **Un colon à mains nues ne chasse pas** (`jobs.rs::try_start_hunt`), et ni le joueur maigre
   du banc ni le joueur scripté de la campagne ne s'arment avant de mourir — sur la glace les
   trois colons sont morts au jour 3, avant le poste de fabrication. Sur les autres biomes, on
   mange des baies en attendant ; ici il n'y a rien à attendre.
2. **Armé, on ne meurt plus de faim, on meurt du sanglier.** Avec un joueur de relevé qui
   fabrique un poste et un arc par colon (`plan_armed`, relevé seulement), la famine tombe de
   façon monotone avec l'abondance (47/62 → 27/59 à 2000 → 0/59 à 8000), mais les colonies
   vivantes ne bougent pas (2 à 6 sur 20) : une bête sur trois est un sanglier, il charge, et
   ce joueur n'a ni lit ni médecine. Le test `ice_colonies_survive_often_enough` est écrit et
   posé `#[ignore]` avec ce diagnostic.

La fiche est donc **remise ouverte**, avec un design à trancher (ci-dessous) qui sort du
périmètre initial. Le constat et les interdits d'origine restent valables.

## Design tranché pour la seconde passe (Thomas, 2026-09-09)

« On doit pouvoir chasser le gibier à mains nues, et la population d'animaux doit dépendre
du biome. » Les deux leviers sont donc retenus, dans cet ordre, et se mesurent séparément
puis ensemble :

- **A. La chasse à mains nues.** `try_start_hunt` (`jobs.rs`) n'exige plus d'arme : un
  colon désarmé part chasser au corps à corps avec ses dégâts de mains nues
  (`combat::COLONIST_DAMAGE`, 80 à 121, déjà là — les pillards désarmés se battent ainsi), par
  le même `engage` que la chasse armée ; rien d'autre ne change dans la chasse ni le combat.
  **À mesurer** : (1) toutes les espèces à mains nues, (2) seulement les bêtes non agressives
  (`Species::aggressive`, le sanglier exige une arme). Garder la variante qui survit le mieux
  sans retirer au joueur ce qui ne le tue pas ; si les deux se valent, la plus libre (1).
  Un chasseur armé garde évidemment la priorité qu'il a aujourd'hui.
- **B. La composition des hardes par biome.** Une pondération d'espèces dans `BiomeTable`
  (par ex. `game_mix: [u32; SPECIES_COUNT]`, dans l'ordre de `Species::ALL` : cerf, lapin,
  sanglier). `spawn_herd` tire `rng.below(somme des poids)` et choisit l'espèce par tranche :
  avec `[1, 1, 1]` c'est exactement le `below(3)` d'aujourd'hui — **même tirage, même
  résultat, bit-identique** — et c'est la valeur de toutes les tables sauf `ICE` (et, si la
  mesure le justifie, `TUNDRA`). Sur la glace : pas de sanglier, ou presque (les bêtes du
  relevé sont un cerf sur deux et un lapin sur deux au départ ; la harde peut suivre), valeur
  à mesurer. Les bêtes de départ (`spawn_starting_animals`, cerf ou lapin) ne changent pas.
- **C. `game_density` remesuré** une fois A et B en place : garder la plus petite valeur qui
  passe les critères (elle peut redescendre à 1000 si A suffit — alors on le dit, et la valeur
  de la première passe est un rejet de plus).

Protocole : relevé par variante (A1, A2, A1+B, A2+B, puis C) sur le banc, puis campagne
banquise, campagne froide, et **les autres biomes** — la chasse à mains nues change tout le
monde, la fiche exige de le mesurer (`measure_survival` complet, campagne tempérée). Le témoin
tempéré a le droit de bouger : il ne doit pas se dégrader, et l'écart s'explique dans le
rapport (par ex. « les colonies chassent avant d'avoir un arc, N morts de sanglier de plus »).
Le hash de `demo` ne bouge que si le scénario chasse sans arme ; le dire.

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
