---
slug: enceinte-sans-trous
status: open
claimed_by:
claimed_at:
layer: sim-cli
scope:
  - crates/sim-cli/src/campaign.rs
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§12 nouveau)
contract: aucun changement du sim ; l'instrument seulement
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --json
done_in:
---

# Le joueur scripté referme son enceinte

**Constat mesuré** (`CAMPAIGN-FINDINGS.md` §11.8) : l'enceinte 13×13 du joueur scripté n'est
refermée que **5 fois sur 30** graines ; `map::indoor_count()` reste à zéro pour 25 colonies.
Cause : eau peu profonde sur le tracé, segments jamais planifiés. Conséquence : l'enclos
nourricier du bétail est dormant, les colons dorment dehors, les pièges n'ont pas d'entrée à
garder ; toute mesure « avec enceinte » est en réalité une mesure « sans ».

**Design imposé** : choisir l'emplacement de l'enceinte **avant** de la planifier : glisser
le carré autour du barycentre des colons jusqu'à trouver une position dont le pourtour ne
traverse ni eau ni rocher ni arbre non coupable (ou couper les arbres du tracé d'abord), en
restant à ≤ 8 cases du point de départ ; à défaut, réduire le côté à 11 puis 9. La porte se
pose sur le côté qui fait face au stockage. Vérifier après construction que `indoor_count() > 0`
et compter cette réussite dans les statistiques (`enclosed` par graine, au résumé et au JSON).

**Tests** : un test unitaire du choix d'emplacement sur une carte ASCII avec un lac au sud
(l'enceinte se décale au nord) ; `une_campagne_courte_tourne_sans_panique` inchangé.

**Objectif chiffré** : enceinte refermée dans **≥ 24/30** graines en campagne normale ;
rapporter l'effet sur les colonies avec bétail (16/21 avant) et sur la survie, sans réglage
du sim.

**Rapport attendu** : court, chiffres avant → après (enceintes refermées, bétail, survie).
