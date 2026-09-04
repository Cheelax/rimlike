# Plan — RimWorld-like multijoueur (nom de code : rimlike)

> Nom de dossier provisoire. À renommer quand on aura un vrai nom.

## 1. Vision

Un jeu de gestion de colonie à la RimWorld, en vue du dessus pseudo-3D (Three.js),
jouable seul puis en multijoueur persistant sur un **globe partagé** : chaque case du
monde est une carte où un joueur peut s'installer ou simplement passer. Des caravanes
traversent automatiquement les cases pour rejoindre des destinations lointaines.

Différenciateurs visés :
- Rendu plus beau que RimWorld : low-poly / voxel, éclairage temps réel, ombres,
  cycle jour-nuit, caméra orthographique inclinée.
- Un monde commun à tous les joueurs, pas des parties isolées.

## 2. Contraintes structurantes (à respecter dès le jour 1)

### 2.1 Simulation déterministe
Le multi sur une carte se fera en **lockstep** : chaque client exécute la même
simulation et on n'échange que les commandes des joueurs. Cela impose :

- Boucle à ticks fixes (ex. 60 ticks/s de jeu), indépendante du rendu.
- RNG seedé maison (xoshiro128** ou mulberry32), un flux par sous-système si besoin.
  Jamais `Math.random`, `Date.now`, `performance.now` dans le sim.
- Logique en **entiers** (positions en 1/256 de case, durées en ticks, stats en
  millièmes). Pas de `Math.sin/cos/sqrt/pow` : résultats non garantis entre moteurs JS.
  Tables précalculées ou fixed-point si nécessaire.
- Ordre d'itération stable : entités triées par id, jamais dépendre d'un ordre de
  `Set`/`Map` non maîtrisé.
- Le sim n'importe rien du rendu ni du réseau. Il tourne en Node pour les tests.
- **Test de non-régression permanent** : deux sims, même seed, mêmes commandes,
  hash d'état identique après N ticks. Lancé en CI.

### 2.2 État sérialisable
Sauvegarde/chargement = snapshot du sim. Indispensable pour :
le solo, la reprise d'une carte gelée, la resynchronisation d'un joueur qui rejoint.
Format binaire compact (structs typés), pas de JSON en prod.

### 2.3 Trois couches indépendantes

```
┌──────────────────────────────────────────────────────────┐
│ Client (Three.js + React)                                │
│  lit l'état du sim, interpole entre ticks, envoie des    │
│  commandes                                               │
└───────────────┬──────────────────────────────────────────┘
                │ commandes / snapshots
┌───────────────▼──────────────────────────────────────────┐
│ Sim de carte (packages/sim) — déterministe, lockstep     │
│  une instance par carte active, exécutée par les clients │
│  présents sur la case                                    │
└───────────────┬──────────────────────────────────────────┘
                │ événements monde (départ caravane, etc.)
┌───────────────▼──────────────────────────────────────────┐
│ Serveur monde (apps/server) — autoritaire, persistant    │
│  globe, cases, propriétaires, caravanes, horloge globale,│
│  relais ordonné des commandes par carte, stockage des    │
│  snapshots                                               │
└──────────────────────────────────────────────────────────┘
```

Le serveur **ne simule pas les cartes**. Il gère le monde et relaie. C'est ce qui
rend le multi hébergeable à moindre coût.

## 3. Modèle multijoueur monde

- **Globe** : icosaèdre subdivisé → cases hexagonales (12 pentagones). Chaque case a
  un biome, un relief, une température. ~2 500 à 10 000 cases selon subdivision.
- **Horloge globale** continue. En multi, pas de pause ni de vitesse variable
  (impossible avec un monde partagé). En solo, pause et x1/x2/x3 restent possibles.
- **Carte active** : quand au moins un joueur est présent sur une case, la carte est
  simulée en lockstep par ces joueurs. Un d'eux est « hôte de snapshot » et pousse
  périodiquement l'état au serveur.
- **Carte gelée** : personne présent → pas de simulation. Au retour, **avance rapide
  abstraite** (croissance des cultures, décomposition, faim des animaux via formules
  sur le temps écoulé), comme RimWorld le fait pour les cartes déchargées.
- **Colonies hors ligne** : abstraites côté serveur. Pillables ou non → décision de
  design à prendre en phase 5, pas avant.
- **Caravanes** : entités du serveur monde. Déplacement le long d'un chemin sur le
  globe à vitesse dépendant du terrain et de la charge. À l'arrivée sur une case, la
  caravane est injectée dans le sim de carte comme groupe de pawns.
- **Rejoindre une carte en cours** : le serveur envoie le dernier snapshot + les
  commandes depuis, le client rattrape, puis entre en lockstep.
- **Désync** : hash d'état échangé toutes les N ticks. En cas d'écart, resync depuis
  le snapshot de l'hôte.

## 4. Rendu : Three.js, vue du dessus pseudo-3D

Pourquoi oui :
- Caméra orthographique inclinée (~40°), rotation par pas de 90°. Lisibilité d'un
  jeu 2D, profondeur d'un jeu 3D.
- Éclairage dynamique + ombres = cycle jour-nuit, torches, incendies qui « rendent »
  sans effort artistique.
- Style **low-poly / voxel** (MagicaVoxel, packs Kenney/Quaternius CC0 pour
  démarrer). Un asset voxel coûte moins cher qu'un sprite animé multi-directions.
- Thomas a déjà touché à three (zkorp-landing).

Points techniques :
- `InstancedMesh` pour sols, murs, végétation : une draw call par type.
- Chunks de 16x16 cases, rebuild du chunk seulement quand il change.
- Sélection de case par raycast sur un plan, pas sur les meshes.
- Interpolation des positions des pawns entre deux ticks du sim.
- React pour toute l'UI (HUD, menus, panneaux). Three en vanilla, pas R3F, pour
  garder la main sur la boucle.
- Repli : si la perf ou l'art coince, la couche sim est intacte, on peut basculer sur
  du 2D sans toucher au jeu.

## 5. Stack

| Couche | Choix |
|---|---|
| Langage | TypeScript partout, strict |
| Monorepo | pnpm workspaces + turborepo |
| Sim | TS pur, ECS léger maison (arrays typés, ids entiers) |
| Client | Vite, Three.js, React, Zustand pour l'état UI |
| Serveur | Node, Fastify + ws, Drizzle + SQLite (Postgres plus tard) |
| Tests | Vitest ; test de déterminisme en CI |
| Assets | GLTF voxel/low-poly, données de jeu en JSON/YAML (moddable) |

Structure :
```
rimlike/
  packages/
    sim/        # simulation déterministe, zéro dépendance
    protocol/   # commandes, snapshots, hash, codecs binaires
    world/      # géométrie du globe, biomes, pathfinding monde
    content/    # définitions : objets, recettes, plantes, traits (data)
  apps/
    client/     # Vite + Three + React
    server/     # serveur monde + relais
  docs/
```

## 6. Phases

### Phase 0 — Squelette (1-2 jours)
Monorepo, lint, Vitest, CI GitHub Actions, page Vite vide avec une scène three.

### Phase 1 — Fondations déterministes + rendu (2-3 semaines)
- Boucle ticks fixes, RNG, fixed-point, ECS.
- Grille 128x128, génération de terrain (bruit déterministe), eau/roche/sol/arbres.
- Rendu chunks instanciés, caméra ortho inclinée, pan/zoom/rotation, jour-nuit.
- Un pawn, pathfinding A* sur grille (avec coût terrain), ordre « aller ici ».
- Sérialisation snapshot + test de déterminisme (10 000 ticks, hash identique).
**Jalon** : on regarde un bonhomme marcher dans un joli décor, et le test passe.

### Phase 2 — Cœur du gameplay solo (1-2 mois)
- Besoins : faim, repos, humeur. Effets sur le comportement.
- Système de jobs : priorités par pawn, réservation de cibles, interruption.
- Construction : plans, matériaux, murs/portes/sols/meubles, zones.
- Ressources : récolte bois/pierre, stockage, transport (hauling).
- Agriculture, cuisine, repas ; lits, sommeil.
- Premier événement : raid simple + combat basique, ou tempête.
- Sauvegarde/chargement.
- Vitesses x1/x2/x3, pause, UI de gestion.
**Jalon** : une colonie de 3 pawns survit quelques jours, on a envie d'y rejouer.

### Phase 3 — Multi sur une carte (2-3 semaines)
- Serveur relais : lobby, ordonnancement des commandes par tick, redistribution.
- Lockstep 2-4 joueurs sur la même carte, hash de désync, resync par snapshot.
- Rejoindre en cours de partie.
**Jalon** : deux navigateurs gèrent la même colonie sans désync pendant 1 h.

### Phase 4 — Couche monde (1-2 mois)
- Globe hexagonal, rendu du globe, biomes, choix de case de départ.
- Serveur autoritaire persistant : cases, propriétaires, horloge globale.
- Cartes gelées + avance rapide abstraite.
- Caravanes : formation, chemin sur le globe, arrivée sur une case, retour.
- Visite d'une case occupée par un autre joueur.
**Jalon** : deux joueurs s'installent sur des cases distinctes, l'un envoie une
caravane chez l'autre.

### Phase 5 — Profondeur (ouvert)
Santé/blessures par membre, recherche, traits et relations, storyteller adaptatif,
factions PNJ et commerce, colonies hors ligne, mods de contenu, événements monde.

## 7. Risques identifiés

| Risque | Mitigation |
|---|---|
| Désyncs sournois (float, ordre d'itération) | Fixed-point strict, lint custom interdisant Math.*/Date dans `sim`, test de déterminisme en CI dès la phase 1 |
| Perf JS pour des centaines de pawns | ECS en arrays typés, pathfinding avec cache de régions (flow fields / HPA*) en phase 2 si besoin, sim dans un Worker |
| Pipeline d'assets 3D coûteux | Style voxel, packs CC0 au départ, contenu générique (couleurs par matériau) |
| Le multi monde est un gouffre | Phases 1-2 donnent un jeu solo complet et autonome. Le multi se greffe dessus, pas l'inverse |
| Horloge globale sans pause frustrante | Vitesse de jeu monde lente (1 jour de jeu ≈ 20-30 min réel) ; automatisation forte (priorités, zones) pour ne pas exiger du micro-management |

## 8. Journal des décisions

- 2026-09-04 : multi type RimWorld (globe, une carte par case, caravanes) plutôt que
  coop sur carte unique. Impose la séparation serveur-monde / sim-carte.
- 2026-09-04 : rendu Three.js vue du dessus pseudo-3D, style low-poly/voxel.
  Repli 2D possible car sim isolé.
- 2026-09-04 : TypeScript full-stack, monorepo pnpm.
- 2026-09-04 : en multi, horloge globale continue, pas de pause.
