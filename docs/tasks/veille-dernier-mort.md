---
slug: veille-dernier-mort
status: open
claimed_by:
claimed_at:
layer: sim
scope:
  - crates/sim/src/combat.rs, jobs.rs, path.rs (repli et confinement pendant la veille)
  - crates/sim/tests/raid_safety.rs, crates/sim/tests/defense.rs
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§17, suite)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --day-scale 30 --absent-from 8 → parmi les colonies murées au jour 8, morts de colons après départ ≤ 36 (le tiers de la référence d'avant la fiche colonie-tient-seule, 110)
  - les deux autres critères de colonie-tient-seule ne reculent pas, à K = 1 et K = 30 (colonies vivantes en présence et en absence, `CAMPAIGN-FINDINGS.md` §17)
  - sim::scenario::DEMO_HASH changé seulement avec la raison écrite dans le même commit, parité WASM verte (pnpm build:wasm && pnpm test:client)
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6 → OK
done_in:
---

# La veille : le dernier mort de trop à K = 30

## Constat (fusion de la PR #20, 2026-11-09)

La fiche `colonie-tient-seule` est livrée avec un critère non atteint : à K = 30, joueur
absent à partir du jour 8, les colonies murées comptent **37** morts de colons après le
départ pour une limite de 110 / 3 = 36,67. À K = 1 les trois critères passent. La
correction d'abri éloigné a retiré treize morts de raid mais fait apparaître trois famines
sur la graine 26 (§17).

## Marche à suivre

1. Rejouer la campagne ci-dessus sur `main` et relever les morts par graine et par cause.
2. Identifier les morts qui ne sont pas des raids (famine, feu) et celles de colons dehors
   au moment de la veille : la règle est que l'absence coûte des ressources et du bétail,
   pas des colons.
3. Corriger la cause, sans toucher aux dégâts, aux armes, à `FLEE_HP` ni à la fréquence des
   raids : un réglage pour le score est refusé.
4. Écrire le avant → après par graine au §17 de `CAMPAIGN-FINDINGS.md`.
