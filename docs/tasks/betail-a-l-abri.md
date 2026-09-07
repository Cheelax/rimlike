---
slug: betail-a-l-abri
status: open
claimed_by:
claimed_at:
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
done_in:
---

# Le bétail ne meurt plus sous les raids parce qu'il paît dehors

**Constat mesuré** (`CAMPAIGN-FINDINGS.md` §11.3) : 50 bêtes apprivoisées pour 10 colonies
qui en gardent une au jour 30 en normal ; en paisible, 24 colonies sur 29 gardent leur
bétail. `LIVESTOCK_RANGE` = 12 contre une enceinte de demi-côté 6 : la bête est dehors par
construction, de faction colonie, donc cible des pillards.

**État** : un premier essai (agent Claude, 2026-09-06) a laissé du code non commité dans
`livestock.rs`, `combat.rs` et `tests/balance_livestock.rs` ; son dernier constat : « ancrer
la bête à la pièce la plus proche vise une case près de la porte, pire (10 tuées contre 6) ;
essayer barycentre + hystérésis ». Repartir de ce code ou le jeter, au choix, mais mesurer.

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
