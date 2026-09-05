# Props naturalistes et modulaires

Direction validée le 2026-09-05 : formes 3D simplifiées, palette terre/lin/olive
légèrement désaturée, texture discrète et constructions lisibles case par case.

## Catalogue

`apps/client/src/render/props.ts` assemble des géométries colorées puis les met en
cache. Les pièces d'un modèle sont fusionnées : une instance par objet, une passe
par type, sans mesh supplémentaire par brique, feuille ou bûche.

- Éléments : arbre à branches et bouquets de feuillage, rochers facettés, buissons
  avec/sans baies, murs de bois et pierre, portes, lits, cultures aux deux stades,
  feu de camp et établi outillé.
- Objets : les seize genres actuels, dont bois empilé, pierre, paniers de récolte,
  repas, corps/dépouilles, armes, viande, cuir et vêtements pliés. Plusieurs genres
  sur une case sont répartis dans cette case ; la quantité module leur taille.
- Sols : planches et dallage avec joints ; teintes naturelles sur les terrains.
- Colons : vêtements distincts, silhouette avec jambes/bras, cheveux et portage
  utilisant le modèle de la ressource transportée.

## Grille et simulation

Une case mesure une unité Three.js. Les murs occupent une case entière et sont
coupés à **0,56 case de haut**, sans toit ni poutre qui masque les pièces.
Les portes suivent les murs voisins ; leurs plans utilisent la même orientation,
y compris les murs encore planifiés. Les chantiers reprennent les géométries finales
avec une teinte bleue ou ocre selon les matériaux livrés. Une grille locale apparaît
pendant l'utilisation d'un outil, et suit le rectangle tracé.

Le lit reste dans **une case** (0,68 × 0,92), comme l'établi (0,91 × 0,67) : le sim
actuel n'a pas de mobilier sur deux cases. Les silhouettes de l'image de référence
sont adaptées à cette contrainte. Aucun meuble, bâtiment préfabriqué, clôture ou
règle de circulation fictive n'est ajouté. Les pièces sont composées avec les
outils de construction existants.

Le rendu ne modifie ni les commandes, ni les tampons WASM, ni les règles de jeu.
La palette reste visible de nuit grâce à un éclairage lunaire un peu plus fort ;
l'intensité à plein jour est conservée. La neige masque les détails des sols
extérieurs et préserve ceux des pièces détectées par le sim.

## Revue

Lancer `pnpm --filter client dev`, ouvrir `/props-review.html`. Cette page de
**développement** utilise le même `Renderer` avec des tampons synthétiques : elle
montre tous les objets, les constructions, les plans, les cultures et cinq colons.
Les boutons permettent de contrôler les rotations, la nuit, la neige et les plans.
Cette scène ne simule aucune activité et ne touche à aucune sauvegarde ; elle
n'est pas une entrée du build de production.

Contrôles automatisés : `pnpm --filter client typecheck`, `pnpm test:client`,
`pnpm --filter client build` après génération du WASM. Les tests de props couvrent
les empreintes, les géométries des plans, l'orientation aux bords de carte et la
réutilisation de plus de 2 048 instances sans troncature. Les géométries et matériaux
de catalogue sont libérés à la fermeture, les buffers instanciés sont réutilisés.
