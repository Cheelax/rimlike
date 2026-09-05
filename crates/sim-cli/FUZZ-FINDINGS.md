# Trouvailles du fuzzer (`rimlike-sim fuzz`)

Ce fichier consigne les campagnes de fuzzing lancées sur `crates/sim` via la
sous-commande `fuzz` de `sim-cli`, et toute trouvaille (désync, panique,
snapshot invalide). Rappel du périmètre : cet outil vit entièrement dans
`crates/sim-cli` ; aucune trouvaille n'est corrigée ici, seulement documentée.

## Résumé

**Aucune trouvaille** sur les deux campagnes ci-dessous : ni désync, ni
panique, ni snapshot invalide, sur 800 000 ticks et 3 600 000 commandes
aléatoires au total (dont des paramètres volontairement aberrants :
coordonnées hors carte ou aux bornes de l'entier, rectangles inversés, ids de
pawns inventés, priorités hors bornes, colon qui s'attaque lui-même, raids
très fréquents, `CancelBuild` sur la carte entière...).

Contexte : ces campagnes ont tourné pendant que `crates/sim` était modifié en
parallèle par un autre agent (ajout de `Job::Downed`/`Rescue`/`Tend`, système
de soin). Les deux campagnes ci-dessous ont été relancées après stabilisation
du build pour porter sur une version cohérente et compilable de `crates/sim`.

## Campagne 1 — carte 64x64, pression modérée

```bash
cargo run -p sim-cli --release -- fuzz --seed 1 --size 64 --ticks 20000 --runs 20 --commands-per-tick 3
```

- 20/20 runs OK (seeds 1 à 20).
- Ticks au total : 400 000.
- Commandes au total : 1 200 000.
- Durée d'exécution (mesurée par l'outil) : 859 207 ms (~14,3 minutes).
- Répartition par variante (~identique entre variantes hors raid, comme
  attendu d'un tirage uniforme légèrement biaisé) :
  Nop 111 066, MoveTo 111 129, Designate 111 438, SetZone 110 923,
  Build 110 985, CancelBuild 111 088, Attack 111 338, SetPriority 111 321,
  TriggerRaid 310 712 (le raid est volontairement poussé au-delà de sa part
  uniforme, voir `fuzzgen::random_command`).
- Colons survivants en fin de run : 0 sur 19 des 20 runs (la pression de
  raids est telle que la colonie de départ, 3 colons, ne survit presque
  jamais 20 000 ticks) ; un seul run (run 6, seed 7) termine avec 3 colons
  vivants — preuve que l'issue dépend bien de la graine et pas d'un biais
  systématique.

## Campagne 2 — carte 24x24, forte pression (petite carte, 6 commandes/tick)

```bash
cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 40000 --runs 10 --commands-per-tick 6
```

- 10/10 runs OK (seeds 1 à 10).
- Ticks au total : 400 000.
- Commandes au total : 2 400 000.
- Durée d'exécution (mesurée par l'outil) : 12 017 ms (~12 secondes — la
  carte réduite et l'absence quasi systématique de colons vivants après les
  premiers raids rendent chaque tick beaucoup moins coûteux que sur la carte
  64x64).
- Répartition par variante : Nop 222 131, MoveTo 222 284, Designate 222 908,
  SetZone 221 865, Build 222 852, CancelBuild 222 207, Attack 222 313,
  SetPriority 222 261, TriggerRaid 621 179.
- Colons survivants en fin de run : 0 dans les 10 runs (carte réduite, forte
  pression de raids et de commandes aberrantes).

## Campagne 3 — sim avec caravanes (2026-09-05, après reprise)

```bash
cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 40000 --runs 10 --commands-per-tick 6
```

- 10/10 runs OK, 400 000 ticks, 2 400 000 commandes, 13,9 s.
- Le générateur couvre `FormCaravan` (listes vides ou inventées), `ClearDepartures` (comptes
  aberrants) et `ArriveCaravan` : un manifeste valide sur 25 (colons, blessures, compétences
  et cargaisons de moins de 40 unités par genre), sinon des octets quelconques refusés au
  décodage strict. Avant ce réglage, chaque arrivée valide déversait jusqu'à 120 unités par
  genre et la carte croulait sous des milliers de piles : le run passait de 1 à 12 secondes,
  sans bug pour autant. À retenir : les recherches d'objets sont en O(piles), un index spatial
  s'imposera si une colonie dépasse quelques milliers de piles.

## Total des trois campagnes

- 1 200 000 ticks simulés (deux sims indépendantes comparées à chaque fois,
  donc 2 400 000 ticks de simulation réelle).
- 6 000 000 de commandes aléatoires générées et appliquées identiquement aux
  deux sims de chaque run.
- 0 désync, 0 panique, 0 snapshot invalide.

## Note de performance sur l'outil lui-même

La première mouture de `fuzz_one_run` clonait la `Sim` entière à chaque tick
(pour pouvoir isoler la commande fautive en cas de panique). Ce coût dominait
largement le temps d'exécution sur la carte 64x64 (~400 ticks/s observés). Il
a été remplacé par une reconstruction à la demande : en cas de panique, l'état
d'avant tick est reconstruit en rejouant le run depuis zéro avec la même
graine (la génération de commandes est déterministe), au lieu de cloner à
chaque tick du chemin normal. Voir `reconstruct_pre_state` dans
`crates/sim-cli/src/commands.rs`. Sans ce changement, aucune régression n'a
été introduite dans la simulation elle-même : ce n'est qu'un coût interne au
harnais de fuzz.

Si une future campagne trouve un problème, ajouter une section datée
ci-dessus avec : graine, paramètres (`--seed`/`--size`/`--ticks`/
`--commands-per-tick`), tick, commande(s) en cause, message de panique le cas
échéant, et une ligne de reproduction directement copiable.
