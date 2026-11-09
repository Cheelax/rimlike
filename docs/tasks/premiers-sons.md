---
slug: premiers-sons
status: open
claimed_by:
claimed_at:
layer: client
scope:
  - apps/client/src/audio/ (nouveau module : moteur Web Audio, table événement → son)
  - apps/client/src/App.tsx (branchement sur les événements déjà lus, déblocage au premier clic)
  - apps/client/src/settings.ts et le panneau Options (volume, coupure)
  - apps/client/public/sounds/ (seulement si des fichiers sont nécessaires, avec LICENSE)
  - apps/client/test/ (tests purs de la table et de la limitation)
acceptance:
  - pnpm --filter client typecheck && pnpm build:wasm && pnpm test:client
  - aucune dépendance npm ajoutée ; aucun changement du sim, de la frontière ni du Worker
  - tout fichier son est CC0 ou produit dans le dépôt, avec sa source et sa licence dans apps/client/public/sounds/LICENSE ; à défaut, des sons synthétisés en Web Audio
  - le son ne démarre qu'après une interaction du joueur, se coupe quand l'onglet est masqué, et le volume (0 = coupé) est mémorisé comme les autres réglages
  - un test pur prouve qu'une rafale d'événements (dix pillards morts dans le même tick) ne joue pas dix fois le même son
  - vérifié en navigateur et décrit dans la PR : ambiance, un raid annoncé, un colon à terre
done_in:
---

# Les premiers sons

**À réserver après la fusion de `colons-lisibles`** : les deux fiches touchent `App.tsx`, et le
tableau exige un écrivain par fichier.

## Constat (bilan de jeu du 2026-11-09)

Le client n'a aucun son : pas d'ambiance, pas de bruit de travail, pas d'alerte de raid. Pour
un jeu de colonie où l'on regarde longtemps sans agir, c'est le manque le plus visible après la
lisibilité (fiche `colons-lisibles`).

## Design imposé

1. **Ambiance** : une boucle douce qui suit la météo (`Weather` : clair, pluie, orage, neige) et
   le jour et la nuit, déjà dans chaque frame.
2. **Alertes**, lues dans les événements que le client reçoit déjà (`EventKind`) : raid annoncé
   (21), raid (1), colon à terre (8), colon mort (2), incendie (36), marchand arrivé (26),
   montée de niveau (7). Une table pure `kind → son`, testée, à côté de `autoPause.ts` qui fait
   déjà ce tri.
3. **Travail** : au plus trois bruits (hache, pioche, marteau) pour les colons visibles à l'écran
   (`renderer.viewBounds()`), avec un plafond de sons simultanés.

## Interdit

Lire l'état de jeu ailleurs que dans les frames et événements existants ; décider quoi que ce
soit côté son qui change la partie ; ajouter une bibliothèque audio.
