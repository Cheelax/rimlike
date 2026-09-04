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
- RNG seedé (xoshiro128**), un flux par sous-système si besoin. Jamais d'horloge
  système ni d'entropie dans le sim.
- Logique en **entiers** (positions en 1/256 de case, durées en ticks, stats en
  millièmes). **Aucun `f32`/`f64` dans le crate sim** : interdit par
  `#![deny(clippy::float_arithmetic)]`. Trig et racines via tables ou fixed-point.
- Ordre d'itération stable : pas de `HashMap`/`HashSet` std (ordre aléatoire par
  design), interdits via `clippy.toml` `disallowed-types`. `BTreeMap`, `Vec` triés,
  ou hasher fixe.
- Le sim n'importe rien du rendu ni du réseau. Il compile en natif pour les tests et
  en WASM pour le navigateur, à partir du même code.
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
| Sim | **Rust**, crate pur sans dépendance au rendu ni au réseau. Compilé en WASM (navigateur) et en natif (tests, serveur). ECS léger maison en SoA |
| Pont sim ↔ client | wasm-bindgen ; interface volontairement minuscule : `step(commands)`, `snapshot()`, `hash()`, vues mémoire pour le rendu |
| Client | Vite, Three.js, React, Zustand pour l'état UI |
| Serveur | Node, Fastify + ws, Drizzle + SQLite (Postgres plus tard). Peut charger le sim Rust en natif via napi-rs si un jour il doit simuler des cartes |
| Tests | Vitest ; test de déterminisme en CI |
| Assets | GLTF voxel/low-poly, données de jeu en JSON/YAML (moddable) |

Structure :
```
rimlike/
  crates/
    sim/        # Rust : simulation déterministe, zéro dépendance, testé en natif
    sim-wasm/   # Rust : wrapper wasm-bindgen autour de sim, seule frontière avec le JS
  packages/
    protocol/   # TS : types des commandes, codecs, messages réseau
    world/      # TS : géométrie du globe, biomes, pathfinding monde
  content/      # définitions : objets, recettes, plantes, traits (data, lu par le sim)
  apps/
    client/     # Vite + Three + React
    server/     # serveur monde + relais
  docs/
```

## 6. Phases

### Phase 0 — Squelette (1-2 jours)
Cargo workspace + pnpm workspace, crate `sim` avec tick fixe, RNG et hash d'état,
test de déterminisme natif, wrapper `sim-wasm`, client Vite qui charge le WASM et
affiche une scène three vide avec le compteur de ticks. Lints anti-float et
anti-HashMap. CI GitHub Actions (cargo test + build client).

### Phase 1 — Fondations déterministes + rendu (2-3 semaines) — livrée le 2026-09-04
- Boucle ticks fixes, RNG, fixed-point, ECS.
- Grille 128x128, génération de terrain (bruit déterministe), eau/roche/sol/arbres.
- Rendu chunks instanciés, caméra ortho inclinée, pan/zoom/rotation, jour-nuit.
- Un pawn, pathfinding A* sur grille (avec coût terrain), ordre « aller ici ».
- Sérialisation snapshot + test de déterminisme (10 000 ticks, hash identique).
**Jalon** : on regarde un bonhomme marcher dans un joli décor, et le test passe.
Fait : A* 8 directions sans coupe de coin, coûts par terrain, 3 colons qui flânent,
ordre « aller ici » (clic gauche sélection, clic droit destination), jour de 4 min avec
soleil et ombres qui tournent, rotation caméra Q/E, pause et vitesses x1-x3 (solo),
8 terrains, interpolation des positions entre ticks. Reporté en phase 2 : ECS (un
`Vec<Pawn>` suffit tant qu'il n'y a qu'un composant), chunks de rendu (inutile tant
que le terrain ne change pas), replanification si le terrain change sous un chemin.

### Phase 2 — Cœur du gameplay solo (1-2 mois) — en cours

Découpée en tranches livrables, chacune jouable :

**2a. Boucle de ressources — livrée le 2026-09-04.** Besoins (faim, repos, humeur
dérivée) ; carte en deux couches, sol + élément (arbre, rocher, buisson) ; désignations
couper / miner / récolter par rectangle ; objets au sol en piles fusionnées ; zones de
stockage ; transport ; repas de baies ; sommeil sur place ; repousse des buissons ;
outils et raccourcis, panneau du colon avec jauges, compteur de stock ; sauvegarde et
chargement (localStorage). Ordre de travail fixe : dormir > manger > travail désigné >
transport > flâner.

**2b. Construction — livrée le 2026-09-04.** Plans de murs, portes, sols et lits en bois
ou pierre (lit en bois), posés par rectangle ; jobs de livraison (depuis les piles au sol
ou le stockage) et de construction, avec réservation du chantier ; murs infranchissables
et replanification des chemins qui les traversaient, piles poussées hors du mur ; un mur
ne se ferme jamais sur un colon ; portes et lits franchissables mais lents ; sommeil au lit
plus rapide avec bonus d'humeur, malus au sol ; annulation qui rend les matériaux livrés ;
fantômes de chantier bleus puis jaunes quand les matériaux sont là. Priorité d'un colon
libre : dormir > manger > construire > livrer > travail désigné > ranger > flâner.
À faire plus tard : une livraison par chantier fait un aller-retour par mur, à grouper
par chantiers voisins ; chunks de rendu si le rebuild complet devient visible.

**2c. Nourriture — livrée le 2026-09-04.** Zones de culture où les colons sèment seuls,
plants qui mûrissent en un jour et demi puis sont récoltés en légumes, resemés ensuite ;
feu de camp (8 bois) et job de cuisine : cinq unités de cru donnent un repas, tant que la
colonie a moins de dix repas ; préférence alimentaire repas > baies > légumes crus ;
humeur : repas cuisiné +, légumes crus - ; péremption (baies 3 jours, légumes 4, repas 2),
une pile fusionnée prend la date la plus proche ; le feu éclaire la nuit.
Priorité d'un colon libre : dormir > manger > construire > livrer > cuisiner > travail
désigné > cultiver > ranger > flâner. À faire plus tard : réfrigération, bill de cuisine
réglable, croissance dépendant de la lumière et de la saison.

**2d. Menaces — livrée le 2026-09-04.** Points de vie (1000), dégâts de famine quand la
faim est à zéro (mort en deux jours), guérison lente quand on mange, deux fois plus vite
au lit ; blessé on ralentit et l'humeur baisse ; mort = cadavre au sol (se décompose en
trois jours, non transportable) et deuil de deux jours pour la colonie. Pillards : bande de
1 + colons/2 (max 6) qui entre par un bord relié à la colonie, fonce sur le colon
atteignable le plus proche, frappe en mêlée toutes les secondes, fuit sous 30 % de PV ou
quand personne n'est atteignable (les murs comptent). Colons : défense automatique dans un
rayon de 8 cases, ordre d'attaque au clic droit sur un ennemi. Storyteller minimal : trois
jours de grâce puis un raid tous les 2 à 4 jours. Journal d'événements (raid, morts,
fuites) et notifications à l'écran ; bouton « Raid » en dev. Pas d'enterrement ni de
soins actifs : viendront avec la santé détaillée. Livré par un sous-agent Opus sur
consigne cadrée, vérifié par l'orchestrateur (42 tests, raid joué dans le navigateur :
deux pillards tués, un colon perdu).

**2e. Confort et pilotage — livrée le 2026-09-05.** Tableau de priorités de travail par
colon (six types, 1 à 4 ou désactivé, panneau « Travail » cliquable, touche J) ; humeur avec
effets : sous 20 % un colon craque (quart de journée à errer, puis soulagement d'un jour),
vitesse de travail ×1,2 au-dessus de 70 % et ×0,8 sous 40 % (avancements en centièmes) ;
météo clair / pluie / orage tirée au sort par périodes d'un quart à une journée, pluie qui
double la croissance des cultures, orage qui pèse sur l'humeur (tout le monde est dehors
tant qu'il n'y a pas de toits) ; particules de pluie et éclairs au rendu ; un voyageur
rejoint la colonie à partir du jour 4 puis tous les 3 à 5 jours. Livré par un sous-agent
Opus, vérifié par l'orchestrateur (48 tests, orage et panneau vus dans le navigateur).

**Jalon** : une colonie de 3 pawns survit quelques jours, on a envie d'y rejouer.
**Atteint le 2026-09-05** : les cinq tranches sont livrées. Le jeu solo est complet dans
ses grandes lignes ; la profondeur (santé détaillée, compétences, recherche, commerce)
reste pour la phase 5.

### Phase 3 — Multi sur une carte (2-3 semaines) — fondations livrées le 2026-09-04

Fait : `packages/protocol` (types de messages, codec JSON + base64, ordonnanceur
lockstep pur : `Scheduler`, `HashLedger`, `BundleHistory`) et `apps/server` (relais
WebSocket : salles, hôte, horloge par bundles de 3 ticks, ordre des commandes garanti par
arrivée puis id de joueur, hashes toutes les 300 ticks et signal de désync, rejoint en cours
par snapshot de l'hôte et rejeu d'un historique borné à 2000 bundles, heartbeat). 57 tests
dont dix sur de vrais WebSockets. Doc : `docs/protocol.md`. Le serveur ne décode jamais les
commandes : ce sont des octets postcard opaques. Intégration livrée le 2026-09-05 : encodeurs
postcard et `apply_encoded` dans `sim-wasm` ; client lockstep pur (`LockstepClient`) testé
contre le vrai serveur et le vrai WASM ; écran d'accueil, lobby, mode multi (exécution par
bundle, hashes, snapshot de l'hôte pour les rejoignants, bandeau de désync), un seul chemin
`issue(bytes)` pour le solo et le multi. Essai réel à deux onglets : même tick, même hash,
commandes de l'un appliquées chez l'autre. Worker livré le 2026-09-05 : sim et client
lockstep dans un Web Worker (`SimRunner` pur testé, `SimBridge` côté principal, protocole
typé, tampons transférés, carte et overlays envoyés seulement quand leur version change) ;
onglet masqué : 60 ticks/s maintenus. Reste : reconnexion, resynchronisation après désync,
essai d'une heure. Livré par trois sous-agents Opus.
- Serveur relais : lobby, ordonnancement des commandes par tick, redistribution.
- Lockstep 2-4 joueurs sur la même carte, hash de désync, resync par snapshot.
- Rejoindre en cours de partie.
**Jalon** : deux navigateurs gèrent la même colonie sans désync pendant 1 h.
Partiellement atteint le 2026-09-05 : convergence vérifiée sur quelques minutes ; l'heure
complète attend le Worker.

### Phase 4 — Couche monde (1-2 mois) — fondations livrées le 2026-09-05

Fait : `packages/world` (sphère géodésique et son dual en cases hexagonales avec 12
pentagones, 10 242 cases à la subdivision 5 ; élévation, température et humidité par bruit
3D seedé, niveau de la mer fixé par quantile pour tenir 56 à 64 % d'océan quel que soit le
seed ; dix biomes ; coûts de déplacement par biome, banquise franchissable ; A* avec
heuristique orthodromique admissible vérifiée contre Dijkstra ; sérialisation compacte,
2,8 Mo JSON et 650 Ko gzippés à la subdivision 5). 83 tests. Doc : `docs/world.md`. Serveur monde livré le
2026-09-05 : globe généré au démarrage (`WORLD_SEED`, `WORLD_SUBDIVISIONS`) et servi en gzip
avec ETag sur `GET /world` ; connexion monde (`world_join`), colonies par case (`settle`,
`visit`, `abandon`, une salle `tile-N` par case avec seed dérivé du monde), diffusion des
colonies et des joueurs ; snapshot de conservation demandé à l'hôte toutes les 30 s et
réutilisé pour rouvrir la salle quand quelqu'un revient (le temps ne s'écoule pas
entre-temps : avance rapide à faire). 30 tests serveur de plus. Reste : rendu du globe et
choix de la case côté client, caravanes, avance rapide, persistance disque, comptes. Livré
par deux sous-agents Opus.
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
| Recherche de travail : chaque colon inactif balaie toute la carte à chaque tick | Compteurs dans `Map` (désignations, zones, lits, feux) qui court-circuitent les balayages ; l'oubli des lits et des feux coûtait un facteur 30 à vide, mesuré par `sim-cli bench` le 2026-09-05. À indexer (listes de cases) si la carte grossit |
| Onglet en arrière-plan : le navigateur bride `requestAnimationFrame` à ~2/s, le client décroche du lockstep | Réglé le 2026-09-05 : sim et lockstep dans un Web Worker cadencé par timer, le thread principal ne fait que rendre. Mesuré : 60 ticks/s onglet masqué |
| Horloge globale sans pause frustrante | Vitesse de jeu monde lente (1 jour de jeu ≈ 20-30 min réel) ; automatisation forte (priorités, zones) pour ne pas exiger du micro-management |

## 8. Journal des décisions

- 2026-09-04 : multi type RimWorld (globe, une carte par case, caravanes) plutôt que
  coop sur carte unique. Impose la séparation serveur-monde / sim-carte.
- 2026-09-04 : rendu Three.js vue du dessus pseudo-3D, style low-poly/voxel.
  Repli 2D possible car sim isolé.
- 2026-09-04 : **sim en Rust** (WASM + natif), client Three.js/React en TS, serveur
  Node en TS. Motifs : déterminisme imposé par le typage, marge de perf, même binaire
  côté client et serveur. Go écarté (WASM médiocre). Unreal écarté (pas de web,
  réseau inadapté au lockstep, workflow éditeur).
- 2026-09-04 : réécriture éventuelle : le **client** est remplaçable à faible coût
  (il ne fait que lire l'état du sim). Le **sim** ne l'est pas, d'où le soin mis
  dessus dès la phase 0.
- 2026-09-04 : en multi, horloge globale continue, pas de pause.
- 2026-09-05 : serveur monde livré. Identité joueur = le nom (pas de compte en v1).
  Une colonie fermée survit par son dernier snapshot côté serveur, en mémoire seulement.
  Le préfixe de salle `tile-` est réservé aux colonies du globe.
- 2026-09-05 : Worker livré. Le thread principal garde une instance WASM sans sim, juste
  pour encoder les commandes ; le hash n'est calculé qu'un frame sur trente (sérialisation
  complète). Le crochet de debug devient asynchrone (`rpc`), la méthode de vérification est
  dans `AGENTS.md`.
- 2026-09-05 : `crates/sim-cli` (Sonnet) : exécution native du sim pour mesurer, vérifier le
  déterminisme et les snapshots hors navigateur. Son premier bench a révélé deux balayages
  de carte sans court-circuit (lits, feux) : corrigés, ×30 à vide.
- 2026-09-05 : intégration réseau livrée. Toute action joueur passe par des octets
  postcard encodés par le sim, y compris en solo : un seul chemin, testé partout.
  Décodage strict (octets en trop refusés). Le rejeu d'un rejoignant commence par un
  bundle qui peut couvrir des ticks déjà dans le snapshot : le client les saute.
- 2026-09-05 : fondations phase 4 livrées. Le globe se génère côté serveur et se
  transmet sérialisé : les clients ne regénèrent pas (les fonctions trigonométriques
  JS ne sont pas garanties identiques entre moteurs). Niveau de la mer par quantile
  plutôt que par constante : un seuil fixe donnait de 21 à 73 % d'océan selon le seed.
- 2026-09-05 : phase 2e livrée, phase 2 complète. Les avancements de travail passent en
  centièmes de tick pour que l'humeur module la vitesse sans flottant. La météo et le
  moral sont des états du sim (sérialisés, déterministes), leurs effets visuels restent
  côté client et peuvent utiliser `Math.random` : le rendu ne rentre jamais dans le hash.
- 2026-09-04 : fondations phase 3 livrées. Lockstep « le serveur n'attend personne » :
  horloge continue, bundles de 3 ticks, retardataires qui rattrapent. Les ticks vides sont
  omis des bundles. Le serveur est en TypeScript pur et ne dépend pas du sim : il ne
  décode rien, donc un changement de `Command` ne le touche pas.
- 2026-09-04 : phase 2d livrée. Les pillards sont des `Pawn` ordinaires avec une
  `faction` : même rendu, même pathfinding, mêmes tampons ; seule la boucle de décision
  diffère (IA courte au lieu de la recherche de jobs). Les morts sont retirés en fin de
  tick, jamais pendant la boucle des pawns, pour ne pas décaler les indices. Le journal
  d'événements est borné à 32 entrées et fait partie de l'état : la sauvegarde le porte.
- 2026-09-04 : passage en mode orchestrateur : Fable rédige des consignes cadrées, des
  sous-agents (Opus pour la conception, Sonnet pour le mécanique) implémentent sur des
  périmètres disjoints, Fable vérifie et commite. Première tranche ainsi livrée : 2d.
- 2026-09-04 : phase 2c livrée. Les plants sont un élément de case (`Crop`, `CropRipe`)
  plus une liste `crops` pour l'avancement, même schéma que les buissons qui repoussent.
  La nourriture porte une date de péremption par pile ; les jobs qui visaient une pile
  disparue s'arrêtent seuls, pas de nettoyage spécial. Un seul niveau de repas pour
  l'instant : la qualité viendra avec les compétences.
- 2026-09-04 : phase 2b livrée. Constructions = éléments de la couche `Feature`
  (murs, portes, lit) ou sols de la couche `Terrain` (plancher, dallage) : rien de neuf
  côté rendu de carte, juste des valeurs en plus dans les contrats. Chantiers dans une
  liste à part avec leur propre tampon, pas une couche par case. Un colon ne porte
  jamais plus que ce que le chantier réclame.
- 2026-09-04 : phase 2a livrée. Carte en quatre couches `u8` par case (sol, élément,
  zone, désignation) avec deux compteurs de version pour que le client ne rebâtisse ses
  meshes que quand ça change. Objets : une pile par genre et par case en stockage,
  fusion automatique, 75 max. Nuit rendue par une « lune » bleutée haute plutôt que par
  le noir : lisibilité avant réalisme. La souris suit RimWorld : glisser gauche = tracer
  quand un outil est actif, glisser droit et flèches = caméra.
- 2026-09-04 : phase 1 livrée. Tampon de rendu des pawns : `Vec<i32>` plat
  (id, x, y, flags) régénéré par `sim-wasm` après chaque tick, lu en zéro-copie. Les
  commandes JS → sim passent par des méthodes typées sur `WasmSim` en attendant
  `packages/protocol` (phase 3). En dev, `window.__rimlike` expose sim et renderer
  pour les tests pilotés depuis la console.
- 2026-09-04 : phase 0 livrée. Leçon : l'init wasm-bindgen doit être mémoïsée côté JS,
  sinon deux appels concurrents (React StrictMode) instancient deux mémoires.
