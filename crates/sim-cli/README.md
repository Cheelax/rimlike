# sim-cli

Outil en ligne de commande natif (binaire `rimlike-sim`) pour mesurer, vérifier
et déboguer `crates/sim` hors navigateur. Ne dépend que du crate `sim` ; les
arguments sont analysés à la main (pas de `clap`).

## Sous-commandes

```bash
# Exécute la simulation, rapport périodique + résumé final.
cargo run -p sim-cli -- run --seed 42 --size 128 --ticks 20000 --scenario demo --report-every 1000

# Deux sims indépendantes, mêmes entrées, hashes comparés tous les 500 ticks.
cargo run -p sim-cli -- verify --seed 42 --size 128 --ticks 20000 --scenario demo

# Snapshot au tick --at, restauration, comparaison de hash et d'égalité structurelle.
cargo run -p sim-cli -- snapshot --seed 42 --size 128 --ticks 20000 --at 8000

# Ticks/s pour les scénarios none / demo / demo+12 colons. Référence de perf en --release.
cargo run -p sim-cli --release -- bench --size 128 --ticks 20000

# Bombarde deux sims de commandes aléatoires (toutes variantes de Command,
# paramètres parfois aberrants), compare les hashes tous les 100 ticks et
# vérifie un aller-retour snapshot/restore tous les --snapshot-every ticks.
cargo run -p sim-cli --release -- fuzz --seed 1 --size 64 --ticks 20000 --runs 20 --commands-per-tick 3

# Joue des colonies entières avec un joueur scripté et mesure la partie longue.
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --difficulty 2
```

`--help` (global ou après une sous-commande) affiche l'usage détaillé.
Argument manquant ou invalide → code de sortie 2 avec message d'aide.
`verify`, `snapshot` et `fuzz` sortent en 1 si un problème est détecté.

## Scénario `demo`

Source partagée dans `crates/sim/src/scenario.rs` : zone de stockage,
désignations tournantes, plans de mur, culture, feu de camp, ordres de
déplacement, raid déclenché à 6000, annulation à 4000. Le CLI, les tests
natifs et le wrapper WASM utilisent ce même scénario et ses empreintes.

## `fuzz`

Pour chaque run `r` de `0..--runs` (graine `--seed + r`), deux `Sim`
indépendantes de même graine et de même taille reçoivent, tick après tick,
les mêmes `--commands-per-tick` commandes aléatoires (`crates/sim-cli/src/fuzzgen.rs`) :
toutes les variantes de `Command` sont couvertes, avec des paramètres tantôt
plausibles, tantôt aberrants — coordonnées hors carte ou aux bornes de
l'entier, rectangles inversés, ids de pawns inventés, priorités hors bornes,
colon qui s'attaque lui-même, raids déclenchés plus souvent que leur part
uniforme, `CancelBuild` sur la carte entière...

Les hashes sont comparés tous les 100 ticks et à la fin du run ; un
aller-retour snapshot/restore est vérifié tous les `--snapshot-every` ticks
(1500 par défaut). Toute panique du sim est attrapée (`catch_unwind`, hook de
panique silencieux le temps du fuzz). À la première anomalie (désync,
panique, snapshot invalide), le rapport donne la graine, le tick, la ou les
commandes en cause et les 10 dernières commandes générées ; code de sortie 1.
Sans anomalie sur tous les runs : résumé (commandes par variante, ticks et
commandes au total, durée) et code de sortie 0.

## `campaign`

Là où `fuzz` cherche des paniques et `bench` des ticks/s, `campaign` mesure la
**partie longue** : ce que devient une colonie qu'on dirige pendant trente
jours. Chaque graine est jouée par le même **joueur scripté**
(`crates/sim-cli/src/campaign.rs`, fonction `plan`) : zone de stockage et de
culture, coupe et récolte, feu de camp, lits, poste de fabrication, enceinte de
bois avec porte et pièges, établi de recherche puis agriculture et médecine, un
arc par colon et une tunique par colon en automne, chasse quand la viande
manque, apprivoisement, achat de vivres au marchand, tribut à une tribu trop
hostile.

`plan` est une fonction **pure** de la `Sim` vers une liste de `Command`,
appelée toutes les `PLAN_INTERVAL` (600) ticks. Elle n'a aucune mémoire : « le
feu de camp est-il déjà bâti ? » se relit dans la carte. C'est ce qui la rend
testable (voir les tests du module) et déterministe : même graine, mêmes
ordres, mêmes chiffres d'une machine à l'autre — moyennes comprises, calculées
en dixièmes sur des entiers.

Le harnais observe les colons **à chaque tick** pour attribuer une cause à
chaque mort (le sim n'en garde pas trace : `EventKind::ColonistDied` ne porte
que l'id) et vide le journal d'événements tous les 60 ticks, celui-ci étant
borné à 32 entrées — la colonne `lost_events` du JSON doit rester à 0.

```bash
# Trente graines, trente jours, difficulté normale (le réglage de référence).
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30

# Difficile, puis climat froid et climat chaud imposés (dixièmes de °C).
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --difficulty 3
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --climate -50
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --climate 300

# Sortie machine, à comparer d'une tranche à l'autre.
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --json
```

Une ligne par graine (colons vivants en fin et aux jours 10 et 20, morts par
cause, raids reçus et repoussés, richesse, technologies, jours de vivres,
bétail, incendies, colons armés, humeur, chantiers non finis, millisecondes)
puis un résumé. `campaign` sort **toujours en 0** : c'est une mesure, pas un
test. Les constatations et les propositions de réglage sont dans
[`CAMPAIGN-FINDINGS.md`](CAMPAIGN-FINDINGS.md) ; ce fichier-là ne règle rien.

La colonne `ms` est une mesure à part entière : le coût par tick varie d'un
facteur soixante d'une colonie à l'autre, et c'est le premier constat du
rapport.

## Absence, diagnostic et comparaison

`--absent-from 8` coupe les commandes du joueur scripté au jour 8 ; le sim
continue de recevoir des lots vides. L'IA des colons, les raids et le temps
restent actifs. `--day-scale 30` utilise le rythme du monde partagé.

```bash
cargo run -p sim-cli --release -- campaign --seed 10 --seeds 1 --days 30 --size 64 --day-scale 30 --absent-from 8 --trace --json > campagne.json 2> diagnostic.log
```

`--trace` écrit sur **stderr** un état quotidien et chaque décès : besoins,
jobs, positions, pièces, stock alimentaire, ennemis et feu. Il n'ajoute aucun
ordre et ne change pas les ticks. Le JSON sur stdout reste exploitable.

`--snapshot-out FICHIER` exporte l'état postcard final d'une **seule graine**
(`--seeds 1` requis). Un fichier existant est refusé avant le calcul ; le
répertoire parent doit déjà exister. Aucun ordre supplémentaire n'est émis.

```bash
cargo run -p sim-cli --release -- campaign --seed 1 --seeds 1 --days 30 --size 64 --day-scale 30 --snapshot-out /tmp/colonie-jour30.bin --json
pnpm bench:native -- --maps 64 --ticks 3600 --batch 3 --snapshot /tmp/colonie-jour30.bin
```

Le snapshot peut aussi être chargé en solo via le crochet de développement
`window.__rimlike.loadSnapshot(bytes)` ; cette opération ne modifie pas la
sauvegarde locale. Les snapshots sont liés à la version courante du sim.

Le JSON distingue `enclosed_at_absence`, `deaths_absent`,
`livestock_lost_absent` et `stolen_units_absent`. Les vols comptent seulement
les objets emportés hors carte par un pillard vivant, à la date de l'événement.
Une charge récupérée sur un pillard abattu n'est pas un vol. La **baisse nette
du stock extérieur** mêle consommation, rangement, production, feu et pillage :
ce n'est pas une mesure des vols.

Le comparateur vérifie les graines, la configuration, le jour du départ et
l'absence d'événements perdus avant de calculer les trois critères de la fiche.
Il rapporte aussi les décès de la cohorte murée commune aux deux versions.

```bash
pnpm compare:campaign avant-present.json avant-absent.json apres-present.json apres-absent.json --json
pnpm test:campaign
```

Code de sortie : **0** si les trois critères passent, **1** si un critère
échoue, **2** si les entrées ne sont pas comparables. Pour une ancienne sortie
sans `campaign.day_scale`, fournir explicitement `--legacy-day-scale K` ;
cette valeur ne remplace jamais une échelle présente dans le fichier.
Les mesures du 2026-09-19 et leur provenance sont dans
[`campaign-results/2026-09-19/`](campaign-results/2026-09-19/README.md).
