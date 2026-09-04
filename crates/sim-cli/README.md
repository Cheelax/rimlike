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
```

`--help` (global ou après une sous-commande) affiche l'usage détaillé.
Argument manquant ou invalide → code de sortie 2 avec message d'aide.
`verify` et `snapshot` sortent en 1 si les deux sims divergent.

## Scénario `demo`

Recopie fidèle de `scripted_commands` dans
`crates/sim/tests/determinism.rs` (`crates/sim-cli/src/scenario.rs`) : zone de
stockage, désignations tournantes, plans de mur, culture, feu de camp, ordres
de déplacement, raid déclenché à 6000, annulation à 4000. Toute modification
du scénario de test doit être reportée dans `scenario.rs`.

## Ligne à ajouter dans `AGENTS.md`

Dans la section « Commandes » (non modifié par ce crate — à faire à la main) :

```
cargo run -p sim-cli --release -- bench --size 128 --ticks 20000   # référence de perf native
```
