---
slug: premiers-pas
status: done
claimed_by: codex
claimed_at: 2026-09-07
layer: client
scope:
  - apps/client/src (sauf wasm/ et CraftingPanel.tsx)
  - apps/client/test
  - docs/GUIDE.md
  - docs/tasks/premiers-pas.md
contract: Aucun changement des tampons, du Worker, du WASM ou des commandes.
acceptance:
  - pnpm --filter client typecheck && pnpm --filter client test && pnpm --filter client build
done_in: PR #4 (task/premiers-pas)
---

# Guide des premiers pas

Première partie solo : petit panneau sous le HUD à gauche, une consigne et les
commandes issues de `tools.ts` / `shortcuts.ts`, coches et encouragement sobre.
Jamais en multijoueur ni sur le monde partagé. Masquage et fin mémorisés sous
`rimlike.firststeps.v1`, réouverture par Options → « Revoir les premiers pas ».

## Conditions retenues

1. Stockage : au moins une case de zone de stockage.
2. Coupe : au moins une désignation de coupe ou du bois en stock.
3. Feu de camp : un plan ou un feu construit.
4. Lits : plans et lits construits au moins aussi nombreux que les colons vivants
   (bétail, pillards et marchands exclus ; zéro colon ne valide pas cette étape).
5. Culture : au moins une case de zone de culture.
6. Arc : poste de fabrication construit et objectif d'arcs supérieur à zéro.
7. Enceinte : au moins vingt murs et une porte, construits ou planifiés, bois ou
   pierre. C'est un repère de construction ; la fermeture géométrique n'est pas testée.

Les conditions se lisent uniquement dans les messages reçus. Les coches restent
acquises pendant la session même si une ressource est ensuite consommée ; la
réouverture volontaire recalcule la progression sur l'état actuel de la colonie.
La coche finale reste visible jusqu'au masquage, mais le guide terminé ne s'ouvre
plus automatiquement au prochain lancement.

## Vérification

Préfixer chaque commande pnpm par
`export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH`.
Lancer `pnpm --filter client dev` (glue WASM déjà disponible), ouvrir l'adresse
Vite sans paramètres multi/monde. Au besoin supprimer uniquement la clé
`rimlike.firststeps.v1` du localStorage, puis recharger.
Cliquer « Partie solo » : le panneau commence par « Tracer un stockage ».
Cliquer son bouton Stockage, glisser un rectangle sur le sol : une coche et
« Couper des arbres » apparaissent. Vérifier Masquer, rechargement, puis Options →
« Revoir les premiers pas », y compris en pause. Vérifier aussi l'absence du guide
et du bouton de réouverture dans une salle multijoueur et sur le globe.

## Résultat

Implémenté dans `apps/client/src/firstSteps.ts` et `FirstStepsPanel.tsx`, branché
sur les frames/couches reçus dans `App.tsx`, styles dans `ui/colony.css`.
Ajout de `apps/client/test/firstSteps.test.ts` (26 tests) et de deux lignes dans
`docs/GUIDE.md` §1. Aucun test existant modifié, aucune dépendance ajoutée.

Validation du 2026-09-07 :

- `pnpm --filter client typecheck` : réussi.
- `pnpm --filter client test test/firstSteps.test.ts` : 26/26 réussis.
- `pnpm --filter client test` : 400 tests réussis, 28 fichiers réussis ; deux
  suites (`lockstep.test.ts`, `worldflow.test.ts`) échouent avant de lancer leurs
  tests : `apps/server/node_modules` est absent, donc le serveur ne résout pas
  `@rimlike/protocol`. L'acceptation globale des tests reste à relancer par
  l'orchestrateur avec les dépendances serveur disponibles.
- `pnpm --filter client build` : réussi (avertissement Vite sur la taille du bundle).
- `git diff --check` : réussi.
- Navigateur non vérifié : le démarrage de Vite est refusé par la sandbox,
  `listen EPERM 127.0.0.1:5173`. Procédure manuelle ci-dessus à exécuter hors sandbox.

Aucun commit ni push : fichiers laissés modifiés à l'orchestrateur sur
`task/premiers-pas`. Le statut reste `claimed` en attente de sa relecture.

Vérification par l'orchestrateur hors sandbox (2026-09-07) : suite client complète 448 tests verts, typecheck et build verts.
