---
slug: enceinte-sans-trous
status: done
claimed_by: codex
claimed_at: 2026-09-07
layer: sim-cli
scope:
  - crates/sim-cli/src/campaign.rs
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§12 nouveau)
contract: aucun changement du sim ; l'instrument seulement
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --json
done_in: PR #6 (task/enceinte-sans-trous)
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


## Résultat

Réalisé par Codex le 2026-09-07 dans le worktree `task/enceinte-sans-trous`,
base `d151bbe`. Fichiers laissés modifiés pour relecture et commit par
l'orchestrateur ; la fiche reste `claimed` jusqu'à l'intégration.

Le script choisit et conserve un carré 13/11/9 dans les huit cases du barycentre
initial, vérifie la constructibilité et la circulation après fermeture, puis
installe les zones et bâtiments dans ce tracé. Il coupe les arbres du pourtour
avant les murs, retente les cases libérées et garde la porte face au stockage.
Les pièges laissent une sortie ; le bois d'une enceinte inachevée est recherché
plus loin lorsque la coupe locale est épuisée. Aucun changement du sim.

Même commande avant et après, graines 1–30, normale, forêt tempérée, 30 jours,
64×64 : `cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --json`.
Le relevé avant ne change que l'instrumentation du booléen `enclosed`.

| Mesure | Avant mesuré | Après |
|---|---:|---:|
| Enceintes fermées au jour 30 | 6/30 | **24/30** |
| Colonies vivantes avec bétail | 14/17 | **19/20** |
| Colonies vivantes au jour 30 | 17/30 | **20/30** |
| Colons vivants au jour 30 | 52 | 61 |
| Morts cumulés | 189 | 200 |
| Événements perdus | 0 | 0 |

Objectif ≥ 24/30 atteint **en fin de campagne**, sans compter deux enceintes
construites puis brûlées après extinction. La référence historique 5/30 et 16/21
(§11.8) précède les cartes par biome ; elle n'est pas le témoin de ce worktree.
Le détail par graine, les limites et les changements du joueur sont au §12 de
`crates/sim-cli/CAMPAIGN-FINDINGS.md`.

Validation :

- `cargo fmt --all -- --check` : OK.
- `cargo test --workspace` : OK, **359 tests réussis**, 2 ignorés existants.
- `cargo test -p sim-cli` : OK, **46 tests**, relancés après la dernière précision
  du placement de porte ; le test de campagne courte reste inchangé.
- `cargo clippy --workspace --all-targets -- -D warnings` : OK.
- Campagnes avant/après avec la commande ci-dessus : OK, 30 graines chacune,
  `enclosed` booléen par graine, aucune perte d'événement. Résultats bruts :
  `/tmp/enceinte-before.json`, `/tmp/enceinte-after.json`.
- `git diff --check` : OK ; seuls `campaign.rs`, `CAMPAIGN-FINDINGS.md` (§12)
  et cette fiche sont modifiés. Aucun fichier du sim, commit ou push.

La précision finale impose un côté dirigé vers le stockage : une porte au nord
n'est plus retenue si le stockage est au sud. Une seule graine change par rapport
à l'essai précédent ; l'objectif reste 24/30. Le tableau ci-dessus vient du rejeu
**final** après cette précision. Les morts cumulés augmentent de 11 : le gain de
survivants finaux n'est pas présenté comme une baisse de toute mortalité.
