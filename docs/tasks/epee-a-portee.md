---
slug: epee-a-portee
status: done
claimed_by: codex (worktree task/epee-a-portee)
claimed_at: 2026-09-07
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
done_in: PR #2 (task/epee-a-portee)
---

# Une colonie qui paie la métallurgie doit pouvoir forger une épée en trente jours

**Constat mesuré** (`CAMPAIGN-FINDINGS.md` §10.2 et §11.4, joueur scripté corrigé) : 11/14
colonies à la métallurgie bâtissent une forge, 6/14 fondent un lingot, **1/14** forge une épée ;
à 60 jours, 21 lingots et toujours 1 épée. Piste : la règle « ingrédients dans une seule
pile » (3 minerais par lingot alors qu'un rocher veiné en rend 2 ou 3, piles au pied des
rochers qui ne fusionnent pas, puis 4 lingots dans une pile pour l'épée).

**État au 2026-09-07** : première tranche intégrée dans `08c68cd`, après reprise
et correction des essais du 6 septembre. Les tests ciblés, snapshots, builds et fuzz
passent ; voir `CAMPAIGN-FINDINGS.md` §11.6. Ne pas refaire la collecte fractionnée ni
le repli déjà livrés. La campagne combinée laisse 20 colonies vivantes, dix avec du
bétail, et une productrice d’épées sur neuf ayant acquis la métallurgie (deux épées).
L’objectif statistique ci-dessous reste à démontrer par comparaison contrôlée ; cette
fiche demeure ouverte pour ce travail restant.

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


## Résultat — 2026-09-07

Comparaison contrôlée depuis `0045406`, graines **1–30**, **30 jours**, carte
**64×64**, normale, climat tempéré et calendrier au jour 0. Le joueur scripté,
la collecte fractionnée et le repli du bétail restent ceux de la référence.
Détail graine à graine et méthode : `CAMPAIGN-FINDINGS.md` **§11.7**.

**Une seule constante changée** : `craft::ORE_PER_INGOT`, **3 → 1**. Le banc
paisible à cinq veines passait déjà ; avec trois veines, seules 2/20 colonies
forgeaient une épée. Un coût de deux minerais réussit ce banc mais laisse la
campagne à 2/9 : candidat écarté. Un minerai par lingot atteint la cible sans
changer les trois lingots par épée, les durées, les rendements ni le combat.

| Critère | Avant (3 minerais) | Intermédiaire (2) | Après (1) |
|---|---:|---:|---:|
| Colonies à la métallurgie | 9 | 9 | 9 |
| Forges finales | 7 | 7 | 7 |
| Colonies productrices d'épées | **1/9 (11 %)** | 2/9 (22 %) | **3/9 (33 %)** |
| Lingots fondus | 12 | 20 | 39 |
| Épées forgées | 2 | 4 | 6 |
| Épées portées en fin | 2 | 4 | 7 |
| Colonies vivantes | 20/30 | 20/30 | 21/30 |
| Colons vivants | 62 | 61 | 69 |
| Morts cumulés | 189 | 192 | 187 |
| Banc trois veines : productrices en quinze jours | 2/20 | 20/20 | 20/20 |

Productrices après : graines **3, 13, 27**, contre **27** seule avant.
La métallurgie est acquise aux mêmes jours pour les mêmes neuf graines.
Pour la survie au jour 30 : **27 effectifs identiques, trois augmentations,
aucune baisse** ; une extinction évitée (graine 3), aucune nouvelle.
Les 29 graines autres que 13 ont le même nombre de morts ; la 13 en a deux
de moins. Les 26 graines autres que 3, 13, 27 et 30 ont toutes les colonnes
JSON identiques hors durée. Aucun événement perdu dans les campagnes.
L'objectif empirique du quart est atteint sur le bloc demandé ; neuf colonies
à la métallurgie restent un petit échantillon, sans garantie du taux général
ni preuve d'une amélioration globale de survie.

Test ajouté : `three_veins_supply_a_sword_for_most_metallurgy_colonies`, seuil
**15/20**. Avec exactement le test livré, contre-épreuve à `ORE_PER_INGOT = 3` :
**échec, 2/20** (code 101) ; constante retenue : **succès, 20/20**. Le test
s'arrête à la première épée pour borner son coût quand l'objectif est atteint.
Les mesures complètes sur quinze jours figurent au §11.7. Les assertions des
tests existants sont inchangées ; **aucune borne de `metal.rs` retouchée**.

Vérifications :

- `cargo fmt --all -- --check` : passé.
- `cargo test --workspace` : passé, **337 tests**, dont `first_raid_is_dangerous_but_survivable` et les sept tests de `balance_metal`.
- `cargo clippy --workspace --all-targets -- -D warnings` : passé.
- `cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6` : passé, **360 000 commandes**, aucune panique ni divergence (trois runs conformément à la demande du 7 septembre).
- `cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64` : passé avant et après, ainsi qu'avec le candidat intermédiaire ; chacun rejoué avec `--json`.
- `pnpm build:wasm` : passé avec le binaire wasm-bindgen 0.2.127 déjà installé ajouté au PATH ; `pnpm --filter client typecheck` : passé (dépendances locales du dépôt voisin, lockfile identique).
- Essai navigateur non réalisé : Vite refuse l'écoute sur `127.0.0.1:5174` (`listen EPERM`) dans cet environnement ; le CLI Superset n'est pas authentifié.

Périmètre : `craft.rs`, `balance_metal.rs`, cette fiche et le nouveau §11.7
uniquement. À l'orchestrateur, lors de l'intégration : mise à jour du journal
de `docs/PLAN.md` et de la phrase du guide §3 « Métal » encore à trois minerais
par lingot, hors périmètre de cette mission. Fiche laissée `claimed` jusqu'à
la revue et la fusion ; aucun commit sur `main` et aucune fusion demandée.


Livraison bloquée dans cet environnement : `git add` échoue à créer
`/Users/thomas/Desktop/dev/rimlike/.git/worktrees/rimlike-codex-epee/index.lock`
(`Operation not permitted`, métadonnées du worktree hors sandbox). Aucun
commit n'a donc pu être créé. Le contrôle distant échoue aussi :
`git push --dry-run` ne résout pas `github.com` et `gh api` ne joint pas
`api.github.com`. Aucun push effectif ni PR créée. Patch et corps de PR
préparés dans `/tmp/epee-a-portee.patch` et `/tmp/epee-pr-body.md` ; ne créer
la PR qu'après avoir commité et poussé les quatre fichiers de ce worktree.
