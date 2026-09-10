---
slug: echelle-du-jour
status: done
claimed_by: Claude Fable (session orchestrateur)
claimed_at: 2026-09-10
layer: sim
scope:
  - crates/sim/src/** (toutes les constantes en ticks : classement et câblage de K)
  - crates/sim/tests/** (tests existants inchangés à K = 1 ; nouveaux tests de l'échelle)
  - crates/sim-wasm/src/lib.rs (constructeurs avec échelle, accesseur)
  - crates/sim-cli/src/campaign.rs (option --day-scale, mesure)
  - crates/sim-cli/src/commands.rs (option --day-scale sur run/verify/bench)
  - crates/sim-cli/CAMPAIGN-FINDINGS.md (§15)
  - docs/time.md (nouveau : la table des constantes classées)
  - AGENTS.md (ligne de contrat)
acceptance:
  - cargo fmt --all -- --check && cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - K = 1 est bit-identique à aujourd'hui : sim::scenario::DEMO_HASH (e42d5ed14b0cdc69) et TUNDRA_IDLE_HASH (ae9db4a01cb998d6) INCHANGÉS, toutes les empreintes de tests/biomes.rs inchangées, pnpm build:wasm && pnpm test:client vert (parity.test.ts)
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 → identique colonne par colonne à la référence du 2026-09-09 (K = 1 par défaut)
  - cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --day-scale 30 → tourne, résumé recopié au §15 ; colonies vivantes entre 0,5× et 2× la référence à K = 1 (18/30), morts par cause commentées ; toute dérive au-delà est un constat, pas un échec de la fiche
  - même campagne à --day-scale 30 en automne-hiver (--day-of-year 30) → recopiée au §15 (référence K = 1 : 24/30 éteintes)
  - un test statistique par famille : une durée de travail s'étire avec K (un mur à K = 4 prend 4 fois plus de ticks), une durée physique ne s'étire pas (la marche d'un colon sur N cases prend le même nombre de ticks à K = 1 et K = 4), une durée en jours reste en jours (la faim tombe au même point du jour à K = 1 et K = 4)
  - le snapshot porte K : un snapshot pris à K = 30 se restaure et rejoue au même hash ; un snapshot d'avant (sans champ) se relit à K = 1 ou échoue proprement — dire lequel
  - cargo run -p sim-cli --release -- fuzz --seed 1 --size 24 --ticks 20000 --runs 3 --commands-per-tick 6 → OK, plus un run avec --day-scale 30 si le fuzz accepte l'option (l'ajouter sinon)
done_in: e9aa80e (PR #15)
---

# L'échelle du jour : un monde lent, des colons qui marchent normalement

## La décision (plan, phase 6, 2026-09-10)

Le monde continu veut des saisons longues (une saison qu'on peut traverser sans être connecté),
des réserves pour l'hiver comme cœur du jeu, et des colons qui bougent normalement à l'écran.
Rejeté : ralentir les ticks par seconde (tout le monde au ralenti). Retenu : **un facteur `K`,
l'échelle du jour**, fixé à la création de la partie, qui étire le jour et le travail mais pas la
physique. 60 ticks par seconde restent la règle partout (client, serveur, lockstep).

**Cible de mesure : K = 30** — jour de jeu 2 h réelles, saison 30 h, année 5 jours, un mur 75 s,
une récolte 3 h. **Levier d'équilibrage fort** : cette fiche livre le mécanisme et la mesure, la
valeur du monde se décide au vu du §15, pas ici.

## Design imposé

1. **`K` est un paramètre de `Sim`** (`day_scale: u32`, `1..=120`), fixé à la construction
   (`Sim::new_scaled(seed, w, h, biome, day_scale)` ou équivalent ; `new` et `new_in_biome`
   valent K = 1), **en fin de structure**, sérialisé, dans le hash. Pas de `Command::SetDayScale` :
   comme le biome, changer l'échelle après le premier tick serait une autre partie. Une valeur
   hors bornes à la relecture retombe sur 1, comme un biome inconnu retombe sur le tempéré.
2. **Deux familles de constantes, classées une à une** dans `docs/time.md` (une table : constante,
   fichier, famille, raison en une ligne) :
   - **Travail — s'étire avec K** : toute durée écrite en ticks qui représente un effort ou une
     maturation : bâtir (par matériau), couper, miner, récolter, semer, cuisiner, fabriquer
     (armes, habits), fondre, réarmer un piège, apprivoiser, dépecer, enterrer, soigner
     (durée du geste et hémostase), chercher (points par tick → même total par jour),
     l'avancement en centièmes de tick qui suit. Et tout ce qui est déjà exprimé en
     `TICKS_PER_DAY` (faim, repos, humeur, pousse `GROW_TICKS`, cadence des raids, hardes,
     gestation, périssabilité, saisons, gel des plants, chaleur `UNDRESS_TICKS`…) suit **par
     construction** dès que `TICKS_PER_DAY` devient `sim.ticks_per_day()`.
   - **Physique — ne bouge pas** : la marche (`BASE_SPEED`, coûts de terrain), la cadence des
     coups au combat, la portée, la fuite (`FLEE_TICKS`, `FLEE_REPLAN`), la pâture
     (`GRAZE_*`), la propagation et la consommation du feu, les cadences de réessai des
     recherches de travail (`RETRY_TICKS`, budgets d'A\*), les cadences d'évaluation
     (météo, feu, périssabilité toutes les 60 ticks : ce sont des pas de calcul, pas des durées
     de jeu — vérifier que le résultat par jour ne dépend pas de K, ou étirer le pas).
   - Les cas ambigus se tranchent par la question « est-ce que ça se voit à l'écran comme un
     mouvement ou une action instantanée ? » (physique) « ou comme un effort qui dure ? »
     (travail), et la raison s'écrit dans la table. Le saignement et la guérison sont un cas à
     examiner : la guérison est en jours (travail), le saignement tue en ticks (physique) — dire
     ce qu'on choisit et pourquoi.
3. **`TICKS_PER_DAY` reste la constante de K = 1** (les tests l'utilisent partout) ; le sim
   lit `self.ticks_per_day()`. Les constantes dérivées (`HUNGER_DECAY = NEED_MAX / TICKS_PER_DAY`
   et semblables) deviennent des fonctions de l'échelle ; attention aux divisions entières
   (une décroissance par tick qui tombe à zéro à grand K est un bug : passer en accumulateur
   ou en millionièmes).
4. **K = 1 est l'identité au bit près** : les deux empreintes de `sim::scenario`, toutes celles
   de `tests/biomes.rs` et la campagne de référence ne bougent pas. C'est la preuve que le
   câblage est propre ; si une empreinte bouge à K = 1, c'est un bug, pas une constante à
   mettre à jour.
5. **`sim-cli`** : `--day-scale K` sur `run`, `verify`, `bench`, `campaign` (défaut 1). La
   campagne compte les jours avec `sim.ticks_per_day()` ; le joueur scripté garde sa cadence
   de décision en **ticks réels** (`PLAN_INTERVAL` 600 = dix secondes : un joueur ne regarde pas
   plus souvent parce que le jour est long) — le dire dans le rapport, c'est un biais assumé.
6. **`sim-wasm`** : constructeur avec échelle, accesseur `day_scale()`, `ticks_per_day()`
   renvoie la valeur mise à l'échelle (le client s'en sert déjà pour l'horloge du HUD). Aucun
   changement du client ni du serveur dans cette fiche (le câblage `start.dayScale` et les
   vitesses x5/x10 du solo sont la fiche suivante) ; `pnpm build:wasm && pnpm test:client`
   doivent rester verts.
7. **Le rapport** : `## 15. L'échelle du jour (2026-09-10)` dans `CAMPAIGN-FINDINGS.md` :
   protocole, la table des familles (ou un renvoi à `docs/time.md`), campagne K = 1 identique,
   campagne K = 30 normale et automne-hiver avec les résumés et les morts par cause, la
   comparaison en **jours de jeu** (c'est l'unité qui compte), ce que la marche devenue gratuite
   change (colonies plus riches ? raids plus gros ? plus d'enceintes fermées ?), et la
   proposition de valeur pour le monde — **sans l'appliquer**.

## Interdit

- Changer les ticks par seconde, où que ce soit.
- Régler une constante de jeu « au passage » : cette fiche classe et câble, elle ne rééquilibre
  pas (si un déséquilibre apparaît à K = 30, il va au rapport).
- Toucher au client ou au serveur (fiche suivante).
- Un flottant, une `HashMap`, une horloge, un état hors de `Sim` (`AGENTS.md`).
- Recopier une empreinte : elles se lisent dans `sim::scenario` et `tests/biomes.rs`.

## Marche à suivre

Commencer par l'inventaire : `grep -n "TICKS_PER_DAY\|_TICKS\|ticks" crates/sim/src/*.rs` →
la table de `docs/time.md`, **avant** de câbler. Puis câbler famille par famille, en relançant
`cargo test -p sim --test determinism --test biomes` (les empreintes) après chaque fichier.
Ensuite `sim-cli`, les campagnes, le rapport.
