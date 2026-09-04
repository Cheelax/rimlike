# Bilan des campagnes de fuzz

Outil : `rimlike-sim fuzz` (deux sims nourries des mêmes commandes aléatoires et aberrantes,
hashes comparés tous les 100 ticks, snapshot/restore vérifié, paniques attrapées). Relancer une
campagne courte après tout changement du sim.

## 2026-09-05 — sim avec santé détaillée, compétences, noms (binaire release du jour)

| campagne | paramètres | résultat |
|---|---|---|
| petite carte, forte pression | `--seed 1 --size 24 --ticks 40000 --runs 10 --commands-per-tick 6` | **10/10 OK**, 400 000 ticks, 2 400 000 commandes, 9 s |
| carte moyenne | `--seed 100 --size 64 --ticks 20000 --runs 6 --commands-per-tick 3` | **6/6 OK**, 120 000 ticks, 360 000 commandes |

Aucune panique, aucune désync, aucun échec de snapshot. Variantes couvertes : `Nop`, `MoveTo`,
`Designate`, `SetZone`, `Build`, `CancelBuild`, `Attack`, `SetPriority`, `TriggerRaid` (les
raids sont sur-représentés volontairement : c'est là que le RNG et les retraits de pawns se
croisent).

## 2026-09-05 — sim avant la santé détaillée (première version du fuzzer)

`--seed 1 --size 24 --ticks 40000 --runs 10 --commands-per-tick 6` : 10/10 OK, 400 000 ticks,
2 400 000 commandes, 12 s. La campagne 64×64 de cette version a été interrompue (sortie perdue)
et refaite sur le sim du jour, ci-dessus.

## Trouvailles

Aucune à ce jour. Quand une trouvaille apparaît, la consigner ici : seed, paramètres, tick,
commande fautive, message, et la ligne de reproduction.
