# Tableau des tâches

Un fichier par tâche, réservable par n'importe quel agent (Claude, Codex, humain). Le
dépôt est la seule source de vérité : pas d'outil externe.

## Cycle de vie

1. **Ouverte** : l'orchestrateur (le modèle du dessus) écrit la fiche avec un périmètre
   de fichiers strict, un contrat, des critères d'acceptation exécutables et la marche à
   suivre pour vérifier. Une fiche sans critère exécutable n'est pas prête.
2. **Réservée** : l'agent qui la prend fait **un commit sur `main`** qui passe
   `status: open` à `status: claimed` avec `claimed_by` (nom de l'agent ou de la
   personne) et la date. Si deux agents réservent la même fiche, le second commit ne
   s'applique pas proprement : c'est la réservation. Il travaille ensuite sur une
   branche `task/<slug>`, jamais sur `main`.
3. **Livrée** : une PR vers `main` qui cite la fiche, avec les critères d'acceptation
   passés collés dans la description. L'orchestrateur relit, vérifie ce que l'agent ne
   peut pas vérifier (navigateur, campagne longue), écrit l'entrée du journal de
   `docs/PLAN.md`, fusionne et passe la fiche à `status: done` avec le commit.
4. **Abandonnée** : `status: open` remis, avec une ligne « ce qui a été appris ».

## Règles

- **Un écrivain par fichier.** Deux fiches ouvertes en même temps ont des périmètres de
  fichiers disjoints ; c'est à l'orchestrateur d'y veiller quand il écrit les fiches.
- Les agents ne commitent pas sur `main` en dehors de la réservation. Les sous-agents
  lancés depuis une session Claude travaillent dans l'arbre de la session et ne
  réservent pas : c'est la session qui réserve pour eux.
- Le sim (`crates/sim`) et le protocole restent revus par l'orchestrateur avant fusion :
  invariants de déterminisme, contrats Rust ↔ TypeScript (`AGENTS.md`).
- Une fiche qui touche un contrat (stride, `COUNT`, variante d'enum) le dit dans
  `contract` et liste les fichiers client à mettre à jour dans la même PR.

## Format

```markdown
---
slug: bétail-à-l-abri
status: open | claimed | done
claimed_by:
claimed_at:
layer: sim | client | serveur | docs
scope:
  - crates/sim/src/livestock.rs
  - crates/sim/tests/balance_livestock.rs
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
done_in:
---

# Titre

Constat mesuré, design imposé, ce qui est interdit, tests attendus, marche à suivre pour
vérifier, rapport attendu.
```

Les fiches vivent dans ce dossier ; `done/` reçoit les fiches terminées (déplacées par
l'orchestrateur à la fusion) pour garder la liste courte.
