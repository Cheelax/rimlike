---
slug: colonie-tient-seule
status: open
claimed_by:
claimed_at:
layer: sim
scope:
  - crates/sim/src/combat.rs (décision tactique à l annonce d un raid)
  - crates/sim/src/storyteller.rs (délai de prévenance entre l annonce et l entrée)
  - crates/sim/src/jobs.rs (job de repli / rassemblement, s il en faut un)
  - crates/sim/src/pawn.rs (variante de Job en fin d enum, s il en faut une)
  - crates/sim/tests/defense.rs, crates/sim/tests/balance_threat.rs (tests et relevés)
  - crates/sim-cli/src/campaign.rs (mode --absent-from J : le joueur ne donne plus d ordre)
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§16)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - sim::scenario::DEMO_HASH et les empreintes changent seulement si le comportement des colons change sur ces parties ; alors la constante est mise à jour dans le même commit avec la raison, et le test de parité WASM reste vert (pnpm build:wasm && pnpm test:client)
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 → référence relevée AVANT le changement (30 graines, joueur présent) et rejouée APRÈS : colonies vivantes ≥ référence − 2 (l IA ne doit pas coûter au joueur présent)
  - même campagne avec --absent-from 8 (le joueur cesse tout ordre au jour 8, la colonie a une enceinte ou pas selon la graine) AVANT et APRÈS : colonies éteintes APRÈS ≤ la moitié de AVANT, et parmi les colonies qui avaient une enceinte fermée au jour 8, morts de colons APRÈS ≤ le tiers de AVANT
  - les pertes d une colonie absente et murée sont des ressources et du bétail dehors, pas des colons : rapporté par graine
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6 → OK
done_in:
---

# La colonie tient seule : tenir la porte ou se replier

## Pourquoi (plan, phase 6, décision du 2026-09-10)

Le monde continu ne gèle plus les cartes : une colonie vit pendant que son joueur dort, et un
raid peut la frapper à trois heures du matin. Règle tranchée : **l'absence coûte, elle ne tue
pas** — pas de menaces suspendues (rejeté : une carte gelée déguisée), un bouclier diégétique :
l'enceinte, la veille, la prévenance, les factions. Et l'échelle du jour rend les raids
brefs en temps réel (quelques secondes) : un joueur qui passe deux fois par jour ne les verra
presque jamais. Il faut donc que la colonie se défende **intelligemment** sans lui, comme les
bases ennemies de RimWorld se défendent sans joueur.

## Ce qui existe

- `combat::defend_if_threatened` : un colon qui voit un ennemi à `DEFEND_RADIUS` = 8 cases
  lâche son job et l'attaque, où qu'il soit ; un couard ne se défend jamais. Pas de décision
  collective, pas de notion de rapport de force, pas de repli.
- `combat::raider_ai` : le pillard charge le colon **atteignable** le plus proche ; s'il n'y en a
  aucun (murs fermés), il décroche et quitte la carte — après s'être rabattu sur le bétail dehors
  (fiche `repli-sur-le-betail`). Une enceinte fermée est donc déjà un bouclier ; ce sont les
  colons qui sortent l'affronter, ou qui sont dehors au travail, qui meurent.
- `storyteller` : `EventKind::RaidAnnounced` puis `spawn_raid` — vérifier s'il existe un délai
  réel entre l'annonce et l'entrée de la bande (le siège attend `SIEGE_TICKS`, la charge non).
- `campaign.rs` : le joueur scripté donne des ordres toutes les `PLAN_INTERVAL` ticks ; il n'a
  pas de mode « absent ».

## Design imposé

1. **La prévenance** : entre l'annonce d'un raid et l'entrée de la bande, un délai suffisant pour
   qu'un colon au travail rentre derrière les murs — de l'ordre d'une heure de jeu
   (`ticks_per_day() / 24`, donc mis à l'échelle si la fiche `echelle-du-jour` est fusionnée :
   la prévenance est un délai de **jeu**, pas de physique). Le joueur présent le voit dans le
   journal et peut ordonner autre chose.
2. **La décision tactique, à l'annonce** : la colonie compare ce qu'elle peut mettre en ligne
   (colons debout, non couards, armés ou pas, avec les dégâts qu'ils portent) à ce qui arrive
   (taille et armement de la bande, connus du storyteller à l'annonce). Rapport favorable → les
   colons **tiennent la porte** : ils se rassemblent côté intérieur de l'entrée de l'enceinte et
   frappent ce qui entre ; ils ne partent plus courir après un pillard dehors. Rapport
   défavorable **et** enceinte fermée → **veille** : tout le monde rentre, personne ne sort tant
   qu'un pillard vit sur la carte (`raid_unresolved`), le travail reprend après. Pas d'enceinte
   → comportement actuel (on se bat où l'on est) : la colonie sans mur est vulnérable, absence
   ou pas, c'est la règle. Un ordre du joueur (`Command::Attack`, `Move` manuel) prime toujours.
3. **Présence du joueur** : première version **sans** notion de présence — la décision tactique
   s'applique toujours, le joueur présent la corrige par ses ordres. Un drapeau de présence
   (`Command` en fin d'enum, posé par le serveur) ne s'ajoute que si la mesure montre qu'un
   joueur présent y perd quelque chose.
4. **Le seuil du rapport de force se mesure**, pas ne se devine : relevé sur 30 graines des
   issues « tenir » contre « veille » à plusieurs seuils, comme `first_raid_is_dangerous_but_survivable`.
5. **`campaign --absent-from J`** : à partir du jour J le joueur scripté ne pousse plus aucune
   commande (il « s'absente »). Le rapport distingue les colonies qui avaient une enceinte
   fermée au jour J des autres, et compte séparément les morts de colons, les pertes de
   ressources dehors et le bétail tué. C'est l'instrument de la règle « l'absence coûte, elle ne
   tue pas ».

## Interdit

- Suspendre, adoucir ou retarder les raids selon la présence du joueur (rejeté par décision).
- Rendre un colon invulnérable ou téléporter qui que ce soit derrière les murs : la veille est
  une marche jusqu'à la porte, un colon trop loin ou à terre dehors reste dehors — c'est un cas
  du rapport, pas un cas à masquer.
- Toucher aux dégâts, aux armes, au seuil de fuite des pillards (`FLEE_HP`), au storyteller
  hors du délai de prévenance.
- Un flottant, une `HashMap`, une horloge ; une variante de `Job` ou de `Command` ailleurs qu'en
  fin d'enum.

## Rapport attendu

§16 de `CAMPAIGN-FINDINGS.md` : protocole, le seuil retenu et sa courbe, avant → après avec
joueur présent et joueur absent (par graine pour l'absent : enceinte ou pas, morts, pertes,
bétail), les cas limites vus (colon à terre dehors, porte piégée, siège), ce que la mesure laisse
ouvert. Journal du plan par l'orchestrateur à la fusion.
