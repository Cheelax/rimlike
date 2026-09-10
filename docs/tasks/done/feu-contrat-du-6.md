---
slug: feu-contrat-du-6
status: done
claimed_by: Claude Fable (session orchestrateur)
claimed_at: 2026-09-10
layer: sim
scope:
  - crates/sim/src/fire.rs, crates/sim/src/weather.rs (seulement si la cause est là)
  - crates/sim/tests/balance_fire.rs
  - crates/sim-cli/src/campaign.rs (un compteur : le pire incendie unique par graine, distinct du total brûlé)
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§16)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - la cause de la dérive est identifiée par bissection de l historique (quel commit entre le 2026-09-05 et main fait passer la pire graine de 534 à 1 000 cases), et écrite au §16 avec le chiffre par révision
  - si la cause est un effet de bord d une autre tranche (chasse à mains nues, gibier, plancher de ressources…), le contrat du §6 est rétabli SANS toucher au réglage de cette tranche, ou le contrat est explicitement révisé avec la raison — dans les deux cas c est écrit
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 → pire graine ≤ 13 % de la carte (≤ 532 cases sur 4 096), départs de feu par jour inchangés, survie inchangée à ±1 colonie
  - même campagne --day-scale 30 → pire graine rapportée (référence : 1 322 cases, 32 %)
  - DEMO_HASH mis à jour dans le même commit si et seulement si le sim change, avec la raison ; parity.test.ts vert
done_in: 0cc85d4 (PR #18)
---

# Le feu ne tient plus son contrat du §6, et ce n'est pas l'échelle du jour

## Constat (rapport §15.11, 2026-09-10)

Le 2026-09-05, le feu orienté par le vent avait ramené la pire graine de la campagne normale de
2 339 cases (57 % de la carte 64×64) à **534 (13 %)**, et ce chiffre est le contrat écrit au §6.
La remesure du 2026-09-10 sur `main`, **à K = 1, sans que rien de la fiche en cours ne
l'explique**, donne une pire graine à **1 000 cases (24 %)** ; à K = 30 elle monte à 1 322 (32 %).
La dérive est dans `main`. Entre les deux dates, le sim a reçu : le métal, le plancher de
ressources (20 arbres forcés), la chasse à mains nues, le gibier par biome, l'unification du
scénario, l'échelle du jour. Aucune n'a remesuré le feu.

Le rapport ne mesure que le **total brûlé par graine**, pas le pire incendie **unique** : un
total de 1 000 cases peut être un feu de 1 000 ou dix feux de 100, et ce n'est pas la même
dérive. La campagne a besoin de ce compteur.

## Design imposé

1. **Bissection avant tout.** Rejouer la campagne normale (30 graines, 64×64, 30 jours) sur les
   révisions clés entre `3bf2830`… et `main` (au moins : avant / après le plancher de ressources,
   avant / après la chasse à mains nues, avant / après le gibier par biome) et lire la pire
   graine à chaque fois. La cause est un commit, pas une hypothèse.
2. **Le compteur** : `campaign` rapporte, par graine, le pire incendie unique (cases brûlées par
   un même foyer, du départ à l'extinction) en plus du total. Sans changer les colonnes
   existantes (les rapports historiques les lisent).
3. **La correction dépend de la cause** : si une tranche a rendu la carte plus inflammable par
   effet de bord (par ex. plus d'arbres atteignables, plus de colons dehors qui n'éteignent
   plus), le contrat se rétablit **sans toucher au réglage de cette tranche** (on ne rouvre pas
   une décision mesurée pour en réparer une autre) ; si aucune correction propre n'existe, le
   contrat du §6 est **révisé** par écrit avec la nouvelle borne et la raison. Rien ne se règle
   « au passage ».
4. Le feu reste **physique** (`docs/time.md`) : cette fiche n'a pas à revenir sur l'échelle du
   jour.

## Rapport attendu

§16 de `CAMPAIGN-FINDINGS.md` : la bissection (pire graine par révision), la cause, la
correction ou la révision du contrat, avant → après à K = 1 et K = 30, pire incendie unique
par graine. Journal du plan par l'orchestrateur.
