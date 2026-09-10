---
slug: echelle-hemostase-pluie
status: done
claimed_by: Claude Fable (session orchestrateur)
claimed_at: 2026-09-10
layer: sim
scope:
  - crates/sim/src/jobs.rs (HEMOSTASIS_TICKS : classement)
  - crates/sim/src/fire.rs, crates/sim/src/weather.rs (le feu sous une météo mise à l échelle)
  - docs/time.md (les deux lignes reclassées, avec la raison)
  - crates/sim/tests/day_scale.rs, crates/sim/tests/balance_tending.rs, crates/sim/tests/balance_fire.rs
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§15.x)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - K = 1 reste l identité : DEMO_HASH e42d5ed14b0cdc69, TUNDRA_IDLE_HASH, empreintes de tests/biomes.rs et campagne de référence inchangés, pnpm build:wasm && pnpm test:client vert
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --day-scale 30 → part des morts par blessures ramenée sous 15 % (référence §15 : 33 % ; K = 1 : 9 %) et colonies vivantes ≥ 14/30 (référence §15 : 10/30 ; K = 1 : 18/30)
  - même campagne : surface brûlée par feu à K = 30 dans ±50 % de K = 1 (référence §15 : 37,8 contre 17,7 cases par feu), départs de feu par jour inchangés
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6 → OK, et un run --day-scale 30
done_in: 011719e (PR #16)
---

# L'échelle du jour, seconde mesure : l'hémostase et la pluie

## Ce que le §15 a trouvé

La fiche `echelle-du-jour` a livré le mécanisme et mesuré K = 30 sans rien régler (c'était sa
règle). Deux déséquilibres en sont sortis, chiffrés :

1. **L'hémostase arrive trop tard.** Le saignement est classé **physique** (`BLEED_TICKS`,
   `BLEED_INTERVAL` : une plaie coule le temps du combat qui l'a faite, ~1 700 ticks pour se
   vider) ; l'hémostase — le quart du geste de soin qui arrête le sang — est classée **travail**
   (`HEMOSTASIS_TICKS`, 60 ticks à K = 1, **1 800 à K = 30**). À K = 30 le blessé s'est vidé avant
   que la compression n'aboutisse : morts de blessures **9 % → 33 %** des morts, et c'est
   l'essentiel de la perte de survie (18/30 → 10/30).
2. **La pluie n'éteint plus les incendies.** Le feu est physique (propagation et consommation par
   tick), la météo est en jours : une période de temps sec dure 30× plus de ticks à K = 30, donc
   un feu ne voit plus le temps changer. Départs par jour tenus (112 → 95), **surface brûlée par
   feu doublée** (17,7 → 37,8 cases). Confirmé à contre-jour en automne-hiver, où l'écart
   disparaît avec le temps sec.

## Design imposé

- **Hémostase → physique.** `HEMOSTASIS_TICKS` cesse d'être mis à l'échelle : la compression
  court contre un saignement qui ne ralentit pas, comme l'extinction court contre les flammes
  (`EXTINGUISH_TICKS`, déjà physique). `TEND_TICKS` (le pansement complet) reste travail. La
  ligne de `docs/time.md` change de famille avec cette raison. Le réglage du 2026-09-05
  (hémostase au quart du geste, triage par temps de saignement) ne bouge pas.
- **Le feu sous la pluie : mesurer avant de choisir.** Deux pistes, à départager sur le banc de
  `balance_fire.rs` puis en campagne : (a) la **consommation** d'un feu suit l'échelle (un arbre
  brûle « longtemps » en jours de jeu) tandis que la propagation reste physique ; (b) rien ne
  change au feu, mais le contrat mesuré du 2026-09-05 (« pire incendie ≤ 13 % de la carte »,
  médiane quelques dizaines de cases) est vérifié à K = 30 et, s'il tient, l'écart de surface
  moyenne est accepté comme un effet de K et écrit tel quel. La piste (a) change les hashes à
  K > 1 seulement ; aucune ne doit toucher K = 1.
- **Pas d'autre réglage** : si la remesure à K = 30 révèle un troisième écart, il va au rapport.

## Rapport attendu

`### 15.x` dans `CAMPAIGN-FINDINGS.md` : avant → après à K = 30 (normal et automne-hiver), par
cause de mort, le feu (départs, surface moyenne, pire incendie par graine), la piste feu retenue
et l'autre chiffrée, et **une proposition de valeur pour le monde** au vu des deux mesures — sans
l'appliquer : c'est la fiche `echelle-client-serveur` qui la porte dans `WORLD_DAY_SCALE`.
