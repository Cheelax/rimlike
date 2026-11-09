---
slug: colons-lisibles
status: open
claimed_by:
claimed_at:
layer: client
scope:
  - apps/client/src/render/Renderer.ts (taille et repère au sol des pawns, seuil des noms, cadrage de départ)
  - apps/client/src/App.tsx (cadrage à l'ouverture d'une partie, file des notifications)
  - apps/client/src/styles.css, apps/client/src/ui/colony.css (notifications)
  - apps/client/test/ (tests purs de la file de notifications et du cadrage)
acceptance:
  - pnpm --filter client typecheck && pnpm build:wasm && pnpm test:client
  - aucune règle de jeu côté TypeScript, aucun changement du sim ni de la frontière (le hash de référence ne bouge pas)
  - captures avant / après jointes à la PR, fenêtre 1440×900, partie solo neuve en forêt tempérée, sans toucher à la caméra : chaque colon fait au moins 16 px de haut et son nom est lisible
  - au zoom minimal, chaque pawn reste repérable par une pastille ou un anneau au sol coloré par faction (colon, pillard, bête, marchand)
  - pendant un raid à ×10, les notifications ne couvrent plus le centre de l'écran : une colonne sur le côté, au plus quatre visibles, les doublons regroupés (« Un pillard est mort ×2 »)
done_in:
---

# Voir ses colons

## Constat (bilan de jeu du 2026-11-09)

Au zoom de départ d'une partie solo, les trois colons sont des points d'un ou deux pixels au
milieu de la carte 128×128 : on ne les voit pas sans zoomer fort, et leurs noms n'apparaissent
qu'au-delà de `NAME_LABEL_MIN_ZOOM` (1,6). Les notifications (`.toasts`) s'empilent au centre
de l'écran, juste au-dessus de la colonie : pendant un raid ou après une avance rapide, une
quinzaine d'entre elles masque ce qu'elles annoncent. Captures dans le bilan
(`claude-livrables/rimlike/bilan-rimlike.html`).

## Design imposé

1. **Cadrage de départ** : la partie s'ouvre centrée sur les colons, à un zoom où ils sont
   lisibles et nommés. Le joueur dézoome s'il veut la carte entière ; la mini-carte existe pour ça.
2. **Repère au sol** : un anneau ou une pastille plate sous chaque pawn, coloré par faction,
   dont la taille à l'écran ne descend pas sous quelques pixels quand on dézoome. Il sert de
   lecture tactique pendant un raid ; le colon sélectionné garde sa mise en évidence actuelle.
3. **Notifications** : une colonne sur un côté, hors du centre, quatre visibles au plus, les plus
   anciennes repliées ; deux notifications identiques rapprochées fusionnent avec un compteur.
   Le clic qui cadre l'événement (`eventFocus.ts`) reste. Le Journal garde tout.

## Interdit

Changer le sim, la frontière ou les tampons ; ajouter une dépendance ; toucher au rythme ou à la
pause automatique.
