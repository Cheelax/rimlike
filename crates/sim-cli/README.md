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
```

`--help` (global ou après une sous-commande) affiche l'usage détaillé.
Argument manquant ou invalide → code de sortie 2 avec message d'aide.
`verify`, `snapshot` et `fuzz` sortent en 1 si un problème est détecté.

## Scénario `demo`

Recopie fidèle de `scripted_commands` dans
`crates/sim/tests/determinism.rs` (`crates/sim-cli/src/scenario.rs`) : zone de
stockage, désignations tournantes, plans de mur, culture, feu de camp, ordres
de déplacement, raid déclenché à 6000, annulation à 4000. Toute modification
du scénario de test doit être reportée dans `scenario.rs`.

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

## Ligne à ajouter dans `AGENTS.md`

Dans la section « Commandes » (non modifié par ce crate — à faire à la main) :

```
cargo run -p sim-cli --release -- bench --size 128 --ticks 20000   # référence de perf native
```
