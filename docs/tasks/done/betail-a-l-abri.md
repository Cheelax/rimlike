---
slug: betail-a-l-abri
status: done
claimed_by: claude-opus (session Fable)
claimed_at: 2026-09-07
layer: sim
scope:
  - crates/sim/src/livestock.rs
  - crates/sim/src/combat.rs (ciblage seulement)
  - crates/sim/tests/balance_livestock.rs
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§11.3)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 4 --commands-per-tick 6
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64
done_in: PR #5 (task/betail-a-l-abri)
---

# Le bétail ne meurt plus sous les raids parce qu'il paît dehors

**Constat mesuré** (`CAMPAIGN-FINDINGS.md` §11.3) : 50 bêtes apprivoisées pour 10 colonies
qui en gardent une au jour 30 en normal ; en paisible, 24 colonies sur 29 gardent leur
bétail. `LIVESTOCK_RANGE` = 12 contre une enceinte de demi-côté 6 : la bête est dehors par
construction, de faction colonie, donc cible des pillards.

**État au 2026-09-07** : première tranche intégrée dans `08c68cd`, après reprise
et correction des essais du 6 septembre. Les tests ciblés, snapshots, builds et fuzz
passent ; voir `CAMPAIGN-FINDINGS.md` §11.6. Ne pas refaire la collecte fractionnée ni
le repli déjà livrés. La campagne combinée laisse 20 colonies vivantes, dix avec du
bétail, et une productrice d’épées sur neuf ayant acquis la métallurgie (deux épées).
L’objectif statistique ci-dessous reste à démontrer par comparaison contrôlée ; cette
fiche demeure ouverte pour ce travail restant.

**Mesurer d'abord** : scénario ciblé (colonie murée avec porte, 2 bêtes apprivoisées, raid de
2 pillards, 30 graines), compter les bêtes tuées par un pillard et les autres morts, avant
tout réglage.

**Pistes, une à la fois** : repli dans la pièce du barycentre des colons pendant un raid
(`raid_unresolved`), errance bornée à la pièce si elle contient herbe ou vivres, un pillard ne
préfère une bête à un colon que si elle est plus proche de 3 cases ou plus. Garder ce qui
fait baisser les bêtes tuées **sans** faire monter les morts de colons. Les sangliers
défendent toujours.

**Tests** : `livestock_retreats_indoors_during_a_raid`,
`livestock_grazes_inside_when_the_room_has_grass`, `livestock_leaves_a_barren_room_to_graze`,
`boars_still_defend`, `raids_kill_fewer_livestock_after_the_change` (30 graines, témoin),
`colonist_deaths_do_not_rise`. `first_raid_is_dangerous_but_survivable` reste vert sans
modification.

**Objectif** : colonies vivantes avec bétail au jour 30 en normale, 8/18 → ≥ 12/18 sur les
mêmes graines (bruit de graine connu : comparer graine à graine).

**Rapport attendu** : mesure initiale, pistes gardées et rejetées avec chiffres, colonies avec
bétail avant → après, morts de colons avant → après.

## Résultat

**Objectif atteint le 2026-09-07** : colonies vivantes avec du bétail au jour 30 en normale,
**9/21 → 16/21** sur les trente graines de référence (43 % → 76 %), et **20/36 → 26/34** sur
soixante. Détail complet, protocole et pistes écartées : `crates/sim-cli/CAMPAIGN-FINDINGS.md`
§11.8.

Un seul réglage, dans le **choix de cible d'un assaillant** :
`combat::LIVESTOCK_TARGET_PENALTY` (malus additif de trois cases) devient
`combat::LIVESTOCK_TARGET_REACH` (le contact), et `nearest_reachable_enemy` trie sur un
**rang** avant la distance — une bête de la colonie passe après tous les colons atteignables,
et redevient une cible ordinaire au contact ou quand il n'y a plus un colon debout. Le repli
et l'errance bornée de `08c68cd` ne sont pas retouchés : `livestock.rs` ne change pas.

Ce que le diagnostic a montré (harnais jetable, campagne de référence, 30 graines) : des 27
bêtes perdues, **27 tuées par un pillard**, **27 dehors**, à 1,7 case en moyenne du point de
repli — elles y étaient arrivées. Et surtout : `map::indoor_count()` reste à zéro pour **25
graines sur 30**, l'enceinte du joueur scripté n'étant refermée que cinq fois sur trente
(eau peu profonde, segments jamais planifiés). L'enclos n'a donc jamais eu l'occasion de
servir ; seul le repli de secours s'exécute, et un barycentre de colons dispersés est un
point où il n'y a personne.

Pistes mesurées puis **écartées** (60 graines) : malus porté à 6 puis 12 cases (24/38 et
23/34, sous le rang à hausse de morts égale) ; errance bornée à 6 cases (23/36 pour 25 morts
de colons en plus) ; repli contre le colon le plus proche (19/39, pire pour le troupeau, qui
redevient un bouclier) ; repli derrière les colons (7/15 sur 30 graines) ; repli à l'annonce
du raid, **impossible sans toucher au storyteller** — `EventKind::RaidIncoming` est poussé
après l'arrivée des pillards, il n'existe aucun préavis.

Coût assumé : les morts de colons montent de moins de 2 % (187 → 191 sur 30 graines,
362 → 368 sur 60). Le témoin sans bétail du tout, joué au même commit, en compte **394** :
élever reste largement gagnant, la colonie n'achète simplement plus cette avance avec ses
bêtes. C'est ce que fige `colonist_deaths_do_not_rise`.

Tests neufs, qui échouent avec l'ancien ciblage et passent avec le nouveau :
`a_raider_walks_past_the_herd_to_reach_a_colonist` (les trois cas de la règle),
`raiders_no_longer_pick_off_a_herd_in_the_open` (décor à ciel ouvert, 30 graines : bêtes
tuées 5 → 1 sur 60) et l'assertion resserrée de `raids_kill_fewer_livestock_after_the_change`
(7 → 0). `first_raid_is_dangerous_but_survivable` reste vert sans modification. Le hash du
scénario `demo` ne change pas (`5fdc5754c55cc434`) : il ne contient aucune bête apprivoisée.

Constat laissé ouvert, hors périmètre de cette fiche : le joueur scripté de `campaign.rs`
bâtit une enceinte trouée, ce qui rend l'enclos dormant en campagne. Tant que ce sera le cas,
la campagne mesurera le repli de secours et jamais la pièce nourricière.
