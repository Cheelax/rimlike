---
slug: epee-a-portee
status: open
claimed_by:
claimed_at:
layer: sim
scope:
  - crates/sim/src/craft.rs
  - crates/sim/src/jobs.rs (fabrication et fonte seulement)
  - crates/sim/src/items.rs (constantes)
  - crates/sim/tests/balance_metal.rs
  - crates/sim/tests/metal.rs (bornes seulement, à signaler)
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§10.2, §11.4)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 4 --commands-per-tick 6
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64
done_in:
---

# Une colonie qui paie la métallurgie doit pouvoir forger une épée en trente jours

**Constat mesuré** (`CAMPAIGN-FINDINGS.md` §10.2 et §11.4, joueur scripté corrigé) : 11/14
colonies à la métallurgie bâtissent une forge, 6/14 fondent un lingot, **1/14** forge une épée ;
à 60 jours, 21 lingots et toujours 1 épée. Piste : la règle « ingrédients dans une seule
pile » (3 minerais par lingot alors qu'un rocher veiné en rend 2 ou 3, piles au pied des
rochers qui ne fusionnent pas, puis 4 lingots dans une pile pour l'épée).

**État** : un premier essai (agent Claude, 2026-09-06) a laissé du code non commité dans
`craft.rs`, `items.rs`, `jobs.rs`, `tests/metal.rs` et `tests/balance_metal.rs`, interrompu
pendant la suite de tests. Repartir de ce code ou le jeter, au choix, mais mesurer.

**Mesurer d'abord** : scénario ciblé (forge, poste, entrepôt 6×6, métallurgie acquise, 5
veines à 10 cases, 3 colons, paisible, 15 jours) : lingots, épées, et **où bloque la chaîne**.

**Pistes, une à la fois** : prélever les ingrédients sur le stock rangé (plusieurs piles,
comme `take_from_stock` du troc), puis seulement si nécessaire **une** constante (rendement
des veines, `ORE_PER_INGOT` ou `METAL_PER_SWORD`), choisie par la mesure.

**Tests** : `crafting_draws_ingredients_from_several_stockpile_piles`,
`smelting_does_not_wait_for_a_single_pile_of_three`,
`a_metallurgy_colony_forges_a_sword_in_fifteen_days` (20 graines), `survival_is_unchanged`.
`first_raid_is_dangerous_but_survivable` reste vert.

**Objectif** : au moins un quart des colonies à la métallurgie forgent une épée en campagne
normale (référence 1/14), survie inchangée à bruit de graine égal.

**Contrat** : aucun changement de stride ni de `COUNT` ; si une constante d'`items.rs` bouge,
le guide (`docs/GUIDE.md`, section Métal) suit dans la même PR.
