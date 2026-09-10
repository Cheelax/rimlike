---
slug: echelle-client-serveur
status: claimed
claimed_by: Claude Fable (session orchestrateur)
claimed_at: 2026-09-10
layer: client + serveur
scope:
  - packages/protocol/src/messages.ts (start.dayScale, constantes en ticks re-documentées en durées)
  - apps/server/src/server.ts, world.ts, room-persistence.ts, index.ts (échelle imposée à la salle, horloge unique)
  - apps/server/README.md, deploy/README.md (variables)
  - apps/client/src/worker/** (construction du sim avec l échelle, vitesses)
  - apps/client/src/sim/SimHandle.ts, apps/client/src/net/LockstepClient.ts
  - apps/client/src/App.tsx (boutons x5 / x10, HUD)
  - apps/client/test/** (tests du câblage)
  - docs/protocol.md
  - AGENTS.md (commandes, contrats)
acceptance:
  - pnpm --filter @rimlike/protocol typecheck && pnpm --filter server typecheck && pnpm --filter client typecheck
  - pnpm test:protocol && pnpm test:server && pnpm test:client → vert
  - une salle « case » démarre avec l échelle du monde (start.dayScale) et tous les clients construisent le sim avec ; un client sans le champ (protocole d avant) est refusé proprement ou reçoit 1 — dire lequel et le tester
  - le solo joue à l échelle du monde par défaut avec les vitesses x1, x2, x3, x5, x10 ; une sauvegarde solo porte son échelle
  - le monde n a plus d horloge à part : WORLD_HOUR_MS disparaît ou devient dérivé de l échelle (une heure de jeu = ticks_par_jour / 24 ticks à 60 ticks/s) ; les caravanes, les marchands itinérants et frozenTicksForHours suivent ; test serveur qui le prouve
  - essai à deux onglets (AGENTS.md « Essayer le monde partagé ») : même hash des deux côtés à l échelle 30, une caravane arrive au temps prévu
done_in:
---

# L'échelle du jour arrive au client et au serveur

## Dépend de

La fiche `echelle-du-jour` (sim) : `Sim` porte `day_scale`, `sim-wasm` expose un constructeur
avec échelle et `day_scale()`, `ticks_per_day()` est mis à l'échelle. Cette fiche ne commence
pas avant sa fusion. La valeur de l'échelle du monde vient du §15 du rapport de campagne (cible
mesurée : 30) — elle est une **variable du serveur**, pas une constante du code.

## Design imposé

- **Le serveur impose l'échelle** : variable d'environnement (`WORLD_DAY_SCALE`, défaut 1 tant
  que le §15 n'a pas tranché, puis la valeur mesurée), envoyée dans `start.dayScale` pour toute
  salle, « case » ou nommée, et dans `snapshot` à titre informatif (l'état du sim la porte déjà).
  Tous les clients d'une salle construisent le sim avec la même échelle, comme ils le font
  pour le biome. Protocole : nouvelle version ou champ optionnel — choisir ce qui refuse
  proprement un vieux client, et le documenter dans `docs/protocol.md`.
- **Une seule horloge.** L'heure de jeu du monde vaut `ticks_par_jour / 24` ticks, à 60 ticks
  par seconde : à l'échelle 30, une heure de jeu = 30 min réelles, un jour = 12 h… non : un jour
  = 14 400 × 30 ticks = 2 h réelles, une heure de jeu = 5 min. `WORLD_HOUR_MS` disparaît au profit
  de cette dérivation (ou reste comme surcharge de test explicitement marquée). Les coûts de
  déplacement des caravanes sont en heures de jeu (`docs/world.md` §4) : à l'échelle 30 une case
  de forêt tempérée (8 h) se traverse en 40 min réelles, une traversée de dix cases en sept
  heures — c'est le rythme voulu d'un monde qu'on ne regarde pas en continu, à écrire dans
  `docs/world.md`. `frozenTicksForHours` et les marchands itinérants suivent la même heure.
- **Le solo** joue à l'échelle du monde par défaut (le même jeu partout), avec **x5 et x10** en
  plus des x1 à x3, disponibles en solo seulement (le multi ne change pas de vitesse, décision
  du 2026-09-04). Le sélecteur de l'accueil peut proposer l'échelle 1 « partie rapide » : c'est
  une option, pas le défaut. La sauvegarde solo porte l'échelle (elle est dans le snapshot).
- **Le HUD** affiche déjà jour et heure à partir de `frame.ticksPerDay` : vérifier que le
  Journal, la mini-carte et les notifications ne supposent nulle part 14 400 ticks par jour
  (`grep -rn "14400\|14_400" apps/client packages`).
- **Les constantes du protocole en ticks** (bundles de 3 ticks, hash toutes les 300, snapshot de
  conservation tous les 1 800, cooldown de resync) ne changent pas de valeur : elles sont en
  temps réel (60 ticks/s), et c'est ce qu'elles doivent rester. Corriger seulement les
  commentaires qui les traduisent en « minutes de jeu ».

## Interdit

- Toucher au sim (`crates/sim`) ou à la frontière (`crates/sim-wasm`) : leur API vient de la
  fiche précédente. Si elle ne suffit pas, le dire, ne pas la contourner.
- Changer les ticks par seconde du lockstep.
- Une échelle par joueur ou par salle choisie côté client en multi : c'est le serveur qui la
  fixe pour tout le monde.

## Vérification

Tests protocole / serveur / client, puis l'essai réel d'`AGENTS.md` (« Essayer le monde
partagé ») avec `WORLD_DAY_SCALE=30` et une horloge rapide de test si nécessaire : deux onglets,
même hash, une caravane qui arrive au temps prévu par la nouvelle heure. Rapport : ce qui a
changé de visible pour un joueur (vitesses, durée d'une caravane, d'une saison).
