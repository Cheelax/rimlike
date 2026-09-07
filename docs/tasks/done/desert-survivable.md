---
slug: desert-survivable
status: done
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
done_in: PR #11 (task/desert-survivable)
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

## Résultat

**Objectif atteint : 14/30 colonies vivantes au jour 30 en désert, contre 0/30 avant, pour
20/30 en forêt tempérée sur les mêmes graines** (seuil demandé : ≥ 10/30). Le tempéré est
identique chiffre pour chiffre, liste des graines survivantes comprise. Détail chiffré et
rejets : `crates/sim-cli/CAMPAIGN-FINDINGS.md` §13.

**Goulot mesuré** : ce n'était pas « pas assez » de terre, c'était **aucune**. `sand_share`
à 1 000 fait rejoindre `sand_noise()` et `gravel_noise()`, donc toute la bande de sol est du
sable, que `Map::is_soil` refuse ; les vingt seules cases d'herbe (le bosquet forcé) portaient
un arbre, et `can_sow` veut une case libre. Zéro case semable sur 20 graines, zéro buisson,
2 à 4 bêtes à chasser : 90 morts de famine sur 30 graines, aucune colonie ne voyait le jour 10.

**Piste gardée — piste 1, le potager garanti.** `Map::ensure_resources` promet désormais
`MIN_SOIL` = 49 cases de sol **libre** atteignables, posées par la même spirale déterministe
que le bosquet et la mare (`Map::force_soil` : du **sable** vers l'herbe, rien d'autre — ni la
neige d'une calotte, ni le gravier d'un piémont ; le sol change, jamais la franchissabilité).
Le déclencheur ne regarde pas le sol trouvé sur la carte mais la **table du biome**
(`BiomeTable::has_no_soil`, nouveau) : seul un biome dont la règle interdit toute case
cultivable reçoit une oasis, donc **aucune carte tempérée n'est touchée, à aucune taille**.

**Rejets, mesurés** (banc de `balance_biomes.rs` réglé sur 20 graines × 30 jours en 64×64
le temps de comparer les pistes, témoin tempéré 9/20 avec ce joueur maigre) :

- `MIN_SOIL` = 25, pourtant justifié par la ration (une case nourrit ~0,8 colon) : **1/20**.
  25 cases dispersées ne mettent que 4 plants dans le rectangle que le joueur sème — le nombre
  qui compte est la **largeur de la tache**, pas la ration. Plateau ensuite : 36 → 7/20,
  49 → 8/20, 64 → 5/20, 81 → 9/20, 121 → 7/20 ; 49 gardé, plus petit disque franc au-dessus
  de la falaise.
- **Piste 2, buissons du désert** : **7/20**, mais il faut rouvrir la bande de sol
  (`sand_share` 1 000 → 500) pour qu'un buisson ait de l'herbe ; le sable tombe à 615-923 pour
  mille et surtout ça ne garantit **rien** — de 0 à 1 734 cases semables selon la graine.
- **Piste 3, sable cultivable au ralenti** : **1/20**. Tout le désert devient un champ et la
  colonie meurt quand même : la pousse divisée par deux repousse la première récolte au jour 3,
  quand la faim de départ s'épuise vers le jour 1 et que rien ne fait le pont. À pleine vitesse
  8/20, mais ce n'est plus un désert et **le témoin bouge** (9 → 10/20, autres graines) : toutes
  les plages de tous les biomes deviennent cultivables.

**Signature du désert conservée** : `each_biome_has_its_signature` mesure la composition nue
(`generate_bare`), que cette tranche ne touche pas — aucune borne de `tests/biomes.rs` n'a
bougé. Sur la carte **réellement jouée**, oasis comprise, le nouveau test
`the_oasis_keeps_the_desert_a_desert` tient sable > 500 et arbres < 20 pour mille (relevé :
sable 758 à 951, herbe 11 à 12, arbres 4).

**Fichiers** : `crates/sim/src/map.rs` (`MIN_SOIL`, `OPEN_PER_SOIL`, `free_soil_count`,
`force_soil`, `ensure_resources` prend la table), `crates/sim/src/biome.rs`
(`BiomeTable::has_no_soil` + son test), `crates/sim/src/lib.rs` (réexport de `MIN_SOIL`),
`crates/sim/tests/balance_biomes.rs` (nouveau : 4 tests, 6 relevés `#[ignore]`),
`crates/sim-cli/CAMPAIGN-FINDINGS.md` (§13). `farm.rs`, `climate.rs`, `jobs.rs`,
`tests/biomes.rs` et `campaign.rs` **inchangés**.

**Tests** : `desert_colonies_survive_often_enough` (20 graines ; échoue avant, 0/20 contre un
témoin à 18/20 ; passe après, 20/20), `a_desert_always_has_a_plot_to_sow`,
`the_soil_floor_never_greens_a_temperate_map` (7 tailles × 40 graines),
`the_oasis_keeps_the_desert_a_desert`, `only_the_sand_and_the_snow_forbid_farming`. Le banc
livré tourne à 24×24 sur dix jours, pas en 64×64 sur 30 : quarante colonies au format de la
campagne coûtent sept minutes en `debug`, quand tout le reste de la suite du sim tient en
190 s ; la famine tombant avant le jour 10, le signal est intact (0/20 → 20/20) et le fichier
coûte 90 s. Le chiffre à 30 jours reste du ressort de la campagne.

**Reste ouvert** : une graine sur vingt (la 18 en 64×64) a son centre dans une cuvette de
gravier, l'oasis se pose de côté et la colonie meurt quand même ; la banquise et la toundra
n'ont pas de sable à verdir et restent injouables (0/20 et 4/20), hors périmètre.
