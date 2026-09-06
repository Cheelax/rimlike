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
commandes de l'un appliquées chez l'autre. Resynchronisation livrée côté serveur le 2026-09-05 (Sonnet) :
majorité des hashes dès trois joueurs, déviants identifiés dans `desync`, réparation
automatique par snapshot de l'hôte avec cooldown, `resync` manuel, `resynced` quand le déviant
revient dans le rang ; limites : hôte déviant jamais réparé, pas de majorité à deux joueurs.
Client à brancher (bandeau avec bouton, restauration en cours de partie). Worker livré le
2026-09-05 : sim et client lockstep dans un Web Worker (`SimRunner` pur testé, `SimBridge` côté principal, protocole
typé, tampons transférés, carte et overlays envoyés seulement quand leur version change) ;
onglet masqué : 60 ticks/s maintenus. Livré par trois sous-agents Opus. Reconnexion automatique
livrée le 2026-09-05 (Sonnet) : `ReconnectingTransport` (délai 1 s → 15 s, gigue, huit essais),
`LockstepClient.reconnect()` rejoue `join` et reprend par le snapshot du rejoignant, commandes
émises pendant la coupure comptées et signalées, bandeau « Serveur injoignable » avec « Réessayer ».
Vérifié en navigateur : relais coupé puis relancé, les deux onglets retrouvent la salle.
Resynchronisation côté client complétée le 2026-09-05 (Sonnet) : la restauration en cours de
partie et le bouton existaient déjà ; ajoutés le cas de l'hôte déviant (message sans bouton), les
noms des déviants dans le bandeau, la pastille verte/rouge sur le hash, et un test contre le vrai
serveur à trois clients dont un qui ment sur son hash (option de test `testHashOverride`,
jamais exposée au Worker) : désync détectée, snapshot de l'hôte, reconvergence. Essai d'une heure
réussi le 2026-09-05 (voir le jalon ci-dessous).
- Serveur relais : lobby, ordonnancement des commandes par tick, redistribution.
- Lockstep 2-4 joueurs sur la même carte, hash de désync, resync par snapshot.
- Rejoindre en cours de partie.
**Jalon** : deux navigateurs gèrent la même colonie sans désync pendant 1 h.
**Atteint le 2026-09-05** : deux onglets (l'un masqué, rendu à 0 fps) sur le build de production
servi statiquement, serveur rapide, 61 minutes, tick 211 539 (quinze jours de jeu) identique des
deux côtés, retard 0, 58-59 ticks/s, aucune salle « desynced » côté serveur (contrôle des hashes
tous les 300 ticks, soit ~700 contrôles concordants).

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
entre-temps : avance rapide à faire). 30 tests serveur de plus. Persistance disque livrée le
2026-09-05 (Sonnet) : état du monde et snapshots dans un JSON écrit atomiquement et
débouncé, rechargé au démarrage, mis en quarantaine si le globe a changé. Écran Monde côté client livré le
2026-09-05 (Opus) : globe Three.js construit depuis les polygones du `WorldWire` (triangulation
en éventail, couleur par biome, léger relief), survol et sélection par raycast, panneau
joueurs / colonies / case, connexion monde pure (`WorldClient`) gardée ouverte pendant la
partie, installation ou visite puis entrée dans la salle `tile-N` à graine imposée, retour au
globe sans rechargement, reprise d'une colonie depuis le snapshot vérifiée contre le serveur.
57 tests client. `GET /world` sert désormais les en-têtes CORS. Caravanes livrées le 2026-09-05 côté sim
(Opus) et côté serveur (Opus), interface client en cours : le sim sort un groupe de colons et
des marchandises sous forme de manifeste postcard (`FormCaravan`, file des départs vidée par
`ClearDepartures` pour rester en lockstep) et fait entrer un manifeste (`ArriveCaravan`,
nouveaux ids, marchandises au sol) ; le serveur monde tient une horloge de jeu
(`WORLD_HOUR_MS`), calcule l'itinéraire, fait voyager la caravane, la livre à l'hôte de la
salle d'arrivée ou la met en attente si la salle est fermée, et fonde une colonie au nom du
propriétaire sur une case vide ; annulation avant la moitié du trajet ; tout est persisté.
Avance rapide livrée le 2026-09-05 (Opus) : `FastForward { ticks }` en O(entités) (plants
mûrissent, vivres pourrissent, plaies se referment et guérissent, pillards quittent la
carte, besoins remis à un niveau raisonnable, raids et voyageurs décalés, météo retirée) ;
le serveur date chaque snapshot de conservation en heures monde et envoie `frozenTicks` à la
réouverture, l'hôte émet l'avance rapide comme première commande. Équilibrage du combat
(Sonnet) : les pillards décrochent à 60 % de PV (mesuré sur 200 graines, plus aucun raid à
deux morts quand les colons sont dispersés) et un test statistique sur douze graines garde
le premier raid dangereux mais survivable. Interface des caravanes livrée le 2026-09-05
(Opus) : panneau Caravane (touche V) avec colons cochables et marchandises bornées au stock,
choix de la destination sur le globe avec itinéraire et durée prévisualisés, convois dessinés
sur le globe avec progression et annulation, expédition des départs par l'hôte
(`CaravanDispatcher`, FIFO des destinations, vidage par préfixe), réinjection à l'arrivée et
confirmation ; 22 tests dont deux voyages complets contre le vrai serveur. Découverte : le
serveur n'accepte `caravan_depart` / `caravan_delivered` et n'envoie `caravan_arrive` que sur
la connexion de salle ; le client relaie donc par le Worker et fait un `world_join` paresseux
sur cette connexion (le joueur apparaît deux fois dans la liste, dédoublonné par nom).
**À corriger côté serveur** : accepter ces messages depuis la connexion monde d'un joueur
présent dans la salle, ou documenter §12.3 comme réservé aux clients mono-connexion.
Identité par jeton livrée côté serveur le 2026-09-05 (Sonnet) : `world_join` sans jeton
crée un joueur (clé publique + jeton secret rendu une fois), avec jeton le reconnaît ;
colonies et caravanes appartiennent à une clé, le nom n'est qu'un libellé résolu à la
diffusion (`ownerName`) ; comparaison en temps constant ; migration du fichier de
persistance v1 → v2 ; protocole version 2 ; 106 tests serveur. Client livré le 2026-09-05 (Sonnet ×2) :
avance rapide émise une seule fois par l'hôte à la réouverture (`frozenTicks`), identité
stockée par serveur **et par nom** (le nom saisi sert de profil local : deux onglets d'un même
navigateur avec deux noms sont deux joueurs), appartenance comparée par clé, liste des joueurs
avec présence, `bad_token` géré. Serveur : les messages de caravane sont acceptés depuis la
connexion monde d'un joueur présent dans la salle et l'arrivée est envoyée sur ses deux
connexions (Sonnet, 109 tests). Essai réel à deux onglets : alice et bob installés sur deux
cases, un colon d'alice parti en caravane est arrivé chez bob en huit heures de jeu. Climat par case livré côté serveur le 2026-09-05 (Sonnet) : `start.climate` dérivé de la
température et de la latitude de la case (désert plus contrasté), l'hôte l'émet en `SetClimate`
en première commande ; côté client livré le 2026-09-05 (Sonnet, coupé par la limite puis
terminé par l'orchestrateur : tests) avec l'affichage du climat de la case sur l'écran Monde.
Contexte WebGL unique livré le 2026-09-05 (Opus) : `apps/client/src/render/gl.ts` possède
le seul `WebGLRenderer` et le seul canevas de l'onglet (mémoïsés, compteur d'utilisateurs,
réglages globaux posés une fois, `ResizeObserver` unique, perte et restauration de contexte
gérées), le canevas passe d'un conteneur d'écran à l'autre — ce qui route aussi la souris —
et `Renderer` comme `GlobeRenderer` rendent toutes leurs géométries et matériaux à la
fermeture sans jamais toucher au renderer partagé ; alterner globe et colonie ne crée plus
de contexte.
- Globe hexagonal, rendu du globe, biomes, choix de case de départ.
- Serveur autoritaire persistant : cases, propriétaires, horloge globale.
- Cartes gelées + avance rapide abstraite.
- Caravanes : formation, chemin sur le globe, arrivée sur une case, retour.
- Visite d'une case occupée par un autre joueur.
**Jalon** : deux joueurs s'installent sur des cases distinctes, l'un envoie une
caravane chez l'autre. **Atteint le 2026-09-05**, en tests d'intégration contre le vrai
serveur et en essai réel à deux onglets (alice sur la case 5, bob sur la 199, un colon
d'alice arrivé chez bob).

### Phase 5 — Profondeur (ouvert)

État : entamée le 2026-09-05, l'essentiel livré les 2026-09-05 et 06.

**Livré**

- **Noms et compétences** (2026-09-05, sim/sim-wasm + interface client) : noms tirés au
  sort par faction (déterministe), six compétences niveau 0-20 avec XP par tick de
  travail et montée de niveau ; la vitesse de travail combine humeur et compétence, les
  transports ne rapportent pas d'XP. Interface : noms partout (panneau, tableau Travail,
  notifications, étiquettes au-dessus des pawns), onglet Compétences dans le panneau.
- **Santé détaillée** (2026-09-05, sim + interface client) : six parties du corps,
  blessures à sévérité et saignement qui se referme seul, sang, conscience, mobilité et
  manipulation réduites, colons à terre secourus vers un lit puis soignés par leurs
  camarades (pillards qui les ignorent), mort par hémorragie ou coup fatal. Mesure :
  rapport morts de leurs plaies / tués au combat 0,35 → 0,17 sur 30 graines × 30 jours
  (réglé le 2026-09-05 : hémostase à 60 ticks, triage par temps de saignement avant le
  brancard).
- **Armes et combat à distance** (2026-09-05, sim + interface client) : poste de
  fabrication (10 bois), recettes gourdin / épieu / arc, ordres « jusqu'à N »,
  équipement automatique de la meilleure arme, compétences mêlée et tir, tir à l'arc à
  8 cases en ligne de vue directe (murs, portes, rochers bloquent), pillards armés selon
  la taille du raid. Mesure : seuil de fuite des pillards fixé à 650 (60 graines, pour
  garder « jamais deux morts d'un coup »).
- **Saisons et température** (2026-09-05, sim) : année de 60 jours en quatre saisons,
  météo et climat réglable par carte (`SetClimate`), pièces détectées par remplissage
  paresseux (isolation, chaleur des feux par pièce), gel qui arrête les cultures et peut
  tuer les plants, neige, chaleur excessive, hypothermie par blessures « froid ». Pas de
  toits explicites à ce stade. Interface livrée le 2026-09-05 : saison, jour, température et
  météo au HUD, neige et pluie rendues, calque de température (touche I), ressenti dans le
  panneau du colon.
- **Faune, chasse et dépeçage** (2026-09-05, sim + interface client) : cerfs, lapins,
  sangliers qui paissent et fuient, hardes tous les 2 à 4 jours (12 bêtes au plus),
  sanglier qui riposte ; chasse par bête marquée (`Hunt`, colons armés seulement, XP de
  tir ou de mêlée), dépeçage automatique au poste (viande selon l'espèce, cuir). Interface :
  bêtes dessinées par espèce, marquage au clic ou à la touche H, panneau animal. À
  surveiller : le coût par tick suit le nombre de pawns, bêtes comprises.
- **Vêtements** (2026-09-05, sim + interface client) : tunique (6 cuir) et manteau
  (12 cuir) au poste, isolation ajoutée au confort (+6 et +15 °C), habillage automatique
  sous 6 °C (seuil mesuré sur dix graines : 12 °C habillait la colonie la moitié du
  temps en climat doux), manteau préféré, habit perdu à la mort. Pas de gestion de la
  chaleur excessive (le manteau reste porté). Interface : habit dans le panneau et sur
  le corps du colon ; au passage, barre des colons (santé, humeur, à terre, endormi) et
  journal des événements filtrable (touche N).
- **Storyteller adaptatif** (2026-09-05, sim + interface client, réglé le 2026-09-06) :
  points de menace selon colons, richesse, jours et difficulté (`SetDifficulty`), taille
  de bande puis équipement acheté avec le reliquat, trois types de raid (charge, archers,
  siège), répit d'un jour après une mort, largages, maladie, coups de froid, canicules ;
  `MAX_RAIDERS` 6 → 12. Interface : sélecteur de difficulté (accueil, lobby, Options),
  richesse au HUD, événements 21-25 libellés. Mesure (réglé le 2026-09-06, plafond plutôt
  que sursis) : premier raid plafonné à deux têtes, difficile à 120 % de menace (cadence
  1,75 à 2 jours), richesse comptée deux fois au-delà de 2 000 ; sur 30 graines × 30
  jours, difficile 0/30 → 8/30 colonies vivantes au jour 30 (11/30 → 24/30 au jour 10),
  normale stable (20 → 22).
- **Traits** (2026-09-05, sim + interface client) : douze traits en six paires opposées,
  deux par colon tirés sans contradiction, effets sur vitesse de travail, humeur, dégâts
  donnés et reçus, défense automatique. Interface : traits et infobulles dans le panneau
  et sur les pastilles.
- **Calendrier partagé** (2026-09-05, sim + serveur + client) : `SetCalendar` décale le
  jour de l'année sans toucher au tick, le serveur impose le jour du monde à la
  fondation (`start.dayOfYear`), l'avance rapide garde l'alignement au gel ; vérifié :
  une colonie fondée sur un monde de douze jours démarre au jour 12. HUD : ligne de
  stock unifiée (cinq genres de base affichés en permanence, le reste si présent).
- **Marchands et troc** (2026-09-05, sim + interface client) : marchand neutre tous les
  4 à 7 jours (trois profils : vivrier, artisan, armurier), installé 4-6 cases des
  colons pendant un jour, vend à 120 % et achète à 70 % de la valeur, troc en valeur par
  `Trade` (stockage → étal) ; attaqué, il devient hostile et la rancune espace ses
  visites. Interface : marchand ocre au ballot, ligne HUD « repart dans N h », panneau
  Troc (balance pré-validée, motif de refus) ; vérifié : 72 bois contre un arc.
- **Conservation par le froid et tombes** (2026-09-05, sim + interface client) :
  fraîcheur en millionièmes par pile périssable, décroissance selon la température de la
  case (normale au-dessus de 15 °C, moitié entre 5 et 15, quart entre 0 et 5, gelée sous
  zéro), évaluée toutes les 60 ticks ; tombe (5 pierre) et job d'inhumation, un cadavre
  au sol pèse −40 000 d'humeur par cadavre (plafond −120 000) sur toute la colonie,
  l'enterrer divise le deuil en cours par deux. Interface : outil Tombe, job « enterre »,
  pastille de fraîcheur par genre dans la ligne de stock.
- **Recherche** (2026-09-05, sim + interface client) : septième type de travail (strides
  `priorities`/`skills` → 8/15), établi de recherche (15 bois), cinq technologies à
  bonus passifs — agriculture (+25 % de pousse), médecine (soins et cicatrisation +50 %),
  conservation (péremption ÷ 2), archerie (portée 10, dégâts +25 %), maçonnerie (pierre
  −25 % de temps) — rien n'est verrouillé derrière la recherche. Interface : outil
  Établi, panneau Recherche (touche R), ligne HUD. Mesure (réglée le 2026-09-05, cadence
  mesurée et non devinée) : deux dixièmes de point par tick (la consigne initiale
  donnait une technologie en trois secondes) — environ 14 000 ticks pour un chercheur
  seul (un peu plus d'une journée), test borné entre une demi-journée et trois jours.
- **Pièges à pointes** (2026-09-05, sim + interface client) : piège (5 bois, 150 ticks,
  une case, franchissable) qui blesse une jambe du premier pillard, marchand hostile ou
  animal qui s'y engage ; les colons le connaissent et le contournent, réarmement par un
  colon (100 ticks). Interface : outil Piège, props armé/déclenché, job « réarme ».
  Mesure : sévérité 250 sur 120 graines — un pillard piégé sur deux à terre ou tué,
  pertes de la colonie 741 contre 1 210 sans pièges (non monotone : à 300 le pillard fuit
  avant d'avoir saigné).
- **Incendies** (2026-09-05, sim + interface client, budget de lutte réglé le
  2026-09-06) : couche `fire` (intensité 0-3, liste de foyers), combustible (arbres,
  buissons, plants, bois bâti, lits, postes, établis, pièges, piles sauf la pierre,
  herbe par temps chaud et sec), consommation en 900 ticks, lutte prioritaire des colons
  (`Firefight`), foudre pendant les orages, feu de camp par temps chaud et sec. Interface :
  flammes à l'écran, ligne HUD rouge, job « combat le feu ». Mesure : le feu suit
  désormais le vent (1/40 sous le vent, ÷ 3 de côté, ÷ 16 à contre-vent) — pire incendie
  de la campagne normale 57 % → 13 % de la carte ; budget de lutte réglé le 2026-09-06
  (10 688 → 461 recherches de chemin sur 600 ticks, 49 → 1 153 ticks/s, indépendant du
  nombre de foyers).
- **Apprivoisement et élevage** (2026-09-05, sim + interface client) : marquage `Tame`
  exclusif de la chasse, job d'apprivoisement (5 baies ou légumes, 300 ticks, réussite
  de base 25 % modulée par l'espèce et la compétence Culture), bêtes de la colonie qui
  restent près du foyer, paissent ou puisent au stockage sous le gel, se reproduisent
  par paire (douze au plus par espèce), sangliers qui défendent ; abattage `Slaughter`.
  Interface : boutons Apprivoiser/Abattre, panneau « <Espèce> de la colonie », ligne HUD
  « Bétail : N ». Mesure sur 20 graines : lapin sûr, cerf patient, sanglier un pari sur
  deux.
- **Factions PNJ et réputation** (2026-09-05, sim + interface client) : trois factions
  fixes (Clan des Cendres et Fraternité du Fer, pillards ; Guilde des Colporteurs,
  marchands), réputation −100..100 par faction (départ −20 / −20 / +10), raids
  attribués selon l'hostilité (alliée à ≥ 50 n'attaque plus, deux alliées : plus aucune
  bande), effets des actions (raid mené −10, repoussé +5/+3, troc +2, marchand frappé
  −30 ou tué −40, rancune qui s'estompe de +1/jour), tribut `Gift` (valeur / 20), Guilde
  alliée qui vend à 110 %. Réputation encore locale à la colonie (pas de globe, voir
  Reste). Interface : panneau Factions (jauges par palier, tribut avec aperçu du gain) ;
  vérifié : 60 bois offerts au Clan des Cendres, réputation −20 → −17.
- **Marchands itinérants côté serveur** (2026-09-05, serveur + client) : `WORLD_MERCHANTS`
  caravanes PNJ (deux par défaut) qui visent la colonie fondée la plus proche, avancent
  au tick monde, séjournent `MERCHANT_STAY_HOURS` puis repartent ; `trader_arrival` à
  l'hôte (qui émet `TriggerTraderVisit`) ou `pendingTraders` (borné à 3) remis à la
  réouverture d'une colonie gelée. Client : `startTraders.ts` rejoue les passages
  manqués après `FastForward`, chariots ocres sur le globe ; vérifié : deux caravanes
  PNJ arrivées, marchand entré, événement 26.
- **Relations entre colons** (2026-09-05, sim + interface client) : avis de −100 à +100
  (seize au plus par colon), bavardage de 90 ticks entre voisins désœuvrés (+4 d'avis
  mutuel, +8 000 d'humeur un jour, délai de 1 200 ticks par paire), dispute une fois sur
  huit (un sur quatre avec un bagarreur), rixe non mortelle sous −60, amis (≥ 50) et
  rivaux (≤ −50) qui pèsent sur l'humeur, deuil doublé à la mort d'un ami. Interface :
  section Relations du panneau (avis triés, qualificatifs). Mesure sur 20 graines : douze
  bavardages par paire et par jour, 12 % de disputes, avis final toujours positif.
- **Campagne d'équilibrage et ses cinq réglages** (2026-09-05, `crates/sim-cli`,
  réglages appliqués les 2026-09-05 et 06) : `rimlike-sim campaign` rejoue un joueur
  scripté déterministe sur N graines × D jours, rapport chiffré dans
  `crates/sim-cli/CAMPAIGN-FINDINGS.md`. Cinq constats mesurés puis traités : (1)
  rangement — recherche de case de stockage sans balayage de carte, 2 000 → 1 000 000
  ticks/s à 60 piles au sol ; (2) difficulté — premier raid plafonné (voir Storyteller) ;
  (3) menace — richesse comptée deux fois au-delà de 2 000 (voir Storyteller) ; (4) feu —
  propagation orientée par le vent (voir Incendies) ; (5) soins — triage par temps de
  saignement (voir Santé détaillée).
- **Mini-carte** (2026-09-05, client) : canvas 2D en bas à droite (fond repeint au
  changement de version, pawns, feu et rectangle de vue à la cadence du HUD), clic pour
  recentrer, repli mémorisé ; `Renderer.viewBounds()` projette les coins de l'écran sur
  le sol sans allocation.
- **Notifications et journal cliquables** (2026-09-05, client) : table pure
  `eventTarget` qui associe à chaque `EventKind` un pawn, une case en feu ou rien ; le
  clic recentre la caméra et sélectionne le pawn.
- **Sélection multiple** (2026-09-05, client) : Maj + clic, Maj + rectangle, Ctrl/Cmd + A,
  clic droit qui répartit les colons sur des cases voisines distinctes (spirale
  déterministe) ou les fait tous attaquer la même cible ; module `selection.ts` pur.
- **Réglages graphiques** (2026-09-05, client) : rapport de pixels et densité des props
  appliqués à chaud, ombres lues au démarrage (jamais basculées à chaud), compteur fps
  et draw calls, mémorisés en `localStorage` ; densité « moyenne » sans rochers ni
  buissons ni joints de sol, « basse » sans cultures en plus.
- **Écran d'aide** (2026-09-05, client) : touche `?` ou `F1`, table des raccourcis
  construite à partir des mêmes constantes que la barre d'outils et le clavier
  (`tools.ts`, `shortcuts.ts`, test d'unicité des touches), rappel à la première partie.

- **Réputation partagée sur le monde** (2026-09-06, sim + serveur + client) : `SetGoodwill`
  imposée par l'hôte après `FastForward` et avant les marchands en attente, réputation par
  joueur côté serveur (`start.goodwill`, `snapshot.goodwill`, `goodwill_report` de l'hôte toutes
  les 60 s et à la fermeture, dernier rapport gagnant, persistance v4). Vérifié : tribut dans
  une colonie, la suivante démarre avec la réputation obtenue.

- **Métal** (2026-09-06, sim) : rochers veinés (un sur huit) qui donnent du minerai, technologie
  Métallurgie (3 500 points, premier verrou) qui débloque la forge (20 pierre), fonte de 3
  minerais en un lingot, épée (4 lingots, 200 % de dégâts de mêlée, mesurée en duel sur 30
  graines), épées chez l'armurier et chez les pillards à forte menace ; objectif intenable
  sauté au lieu de bloquer la file. Interface à faire (outil Forge grisé sans métallurgie,
  minerai, lingot et épée nommés, sixième technologie).

**Reste**

- Mods de contenu : pas commencés.
- Toits : absents. Métal comme matériau de construction : absent (le métal ne sert qu'aux
  armes).
- Faune : coût par tick qui suit le nombre de pawns, bêtes comprises — à surveiller,
  pas encore mesuré ni optimisé.
- Vêtements : pas de gestion de la chaleur excessive (le colon garde son manteau même
  par forte chaleur).

**Mesure** : chaque chiffre ci-dessus vient d'un test statistique sur plusieurs graines,
jamais de l'intuition (règle « on mesure avant de régler », `AGENTS.md`) ; méthode et
détails dans `crates/sim-cli/CAMPAIGN-FINDINGS.md`.

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

- 2026-09-06 : le métal est le premier palier verrouillé. La recherche ne donnait que des bonus ;
  la forge exige la technologie Métallurgie (3 500 points), parce qu'un palier de matériau
  justifie un verrou là où un bonus n'en justifiait pas. Le minerai vient des rochers veinés
  (un sur huit, bruit dérivé), se fond à la forge (3 pour 1 lingot, 300 ticks) et l'épée (4
  lingots) se fabrique au poste : une recette dit désormais où elle se travaille, et un objectif
  intenable est sauté au lieu de bloquer la file. Dégâts de l'épée fixés à 200 % après un duel
  mesuré sur 30 graines (à deux contre un : 21 victoires à l'épée contre 10 à l'épieu). Sous le
  seuil de menace de l'épée, la table d'armes des pillards est bit-à-bit celle d'avant. Contrat
  client : `ItemKind::COUNT` 16 → 19, `TECH_COUNT` 5 → 6, éléments 19-20, forge 9, job 30.
  Point chaud relevé au passage, antérieur au métal : `do_butcher` relance un A* raté vers un
  poste inatteignable à chaque tick.

- 2026-09-06 : la réputation suit le joueur, pas la colonie. Le serveur monde tient une
  réputation par `playerKey`, l'impose à la fondation (`start.goodwill`) et à la réouverture
  d'une colonie gelée (`snapshot.goodwill` : la valeur du joueur, pas celle du sim conservé,
  qui a vécu ailleurs pendant le gel), et reçoit `goodwill_report` de l'hôte seul (un par
  salle et par dix secondes, dernier rapport gagnant : la moyenne pondérée entre colonies est
  écartée, documentée en §14.2 du protocole). L'hôte émet `SetGoodwill` **après**
  `FastForward` (l'avance rapide adoucit déjà les rancunes : l'imposer avant compterait le gel
  deux fois) et **avant** `TriggerTraderVisit` (les prix dépendent de la Guilde).

- 2026-09-06 : la lutte contre le feu a un budget. Un colon inactif ne réévalue la lutte qu'un
  tick sur dix (même phase pour tous : le « je lâche ma besogne » et le « je prends les
  flammes » se jouent dans le même tick), six recherches de chemin au plus par appel (foyers et
  voisines confondus), une « salve » locale au tick mémorise les foyers démontrés inatteignables
  et la réponse d'un colon (déterministe : ordre fixe des colons), sans champ nouveau dans
  `Sim`. Mesuré : 10 688 → 461 A* sur 600 ticks, 49 → 1 153 ticks/s, indépendant du nombre de
  foyers et de la surface ; scénario `demo` bit-identique. Les compteurs d'observation
  (`haul_scans`, `bury_scans`, `firefight_paths`) hors snapshot et hors hash sont désormais la
  façon de tester le travail plutôt que le temps.

- 2026-09-06 : la difficulté se règle par un plafond, pas par un sursis. Allonger le délai de
  grâce en difficile faisait l'inverse de l'effet voulu (un voyageur arrivait avant le premier
  raid, la bande montait à quatre têtes) : le premier raid naturel est plafonné à deux têtes
  (`FIRST_RAID_POINTS`, `TriggerRaid` l'ignore), difficile passe de 150 à 120 % de menace avec
  une cadence de 1,75 à 2 jours, et la richesse compte une seconde fois au-delà de 2 000 pour
  que tripler sa richesse grossisse enfin les bandes (2 → 3 têtes) sans tuer les colonies
  modestes (un tarif linéaire plus fort faisait tomber la campagne normale de 20 à 14
  survivantes). Mesuré sur 30 graines × 30 jours : difficile 0/30 → 8/30 vivantes au jour 30,
  11/30 → 24/30 au jour 10, normale inchangée (20 → 22). Les cinq constats du rapport de
  campagne sont traités ; reste le point chaud `fire_to_fight`.

- 2026-09-05 : le feu suit le vent. Un feu isotrope sur un bosquet homogène est de la
  percolation : sous le seuil il meurt, au-dessus il prend tout, et aucun dénominateur
  (1/100 à 1/150, `SPREAD_MIN` 3, foyers plus courts) ne donnait plus de 11 graines sur 20
  entre 15 et 60 % du bosquet brûlé. Le vent (lu dans le bruit météo, aucun champ de plus)
  brise la symétrie : 1/40 sous le vent, ÷ 3 de côté, ÷ 16 à contre-vent → 17/20 dans la bande,
  médiane 28 %. Le gel ne fait plus qu'halver la propagation : seul ce qui tombe du ciel éteint.
  Campagne normale : maximum brûlé 57 % → 13 % de la carte. Défaut relevé au passage :
  `fire_to_fight` relance jusqu'à 48 A* par tick et par colon inactif tant qu'un feu brûle à
  portée, à corriger comme le rangement.
- 2026-09-05 : soigner d'abord ce qui saigne. Mesure tick par tick de 24 morts d'après-raid : 10
  pendant un soin trop lent, 6 pendant un sauvetage, 4 avec un camarade endormi, 4 sans personne
  debout. Réglage : hémostase au quart du geste (60 ticks) qui arrête tous les saignements avant
  la fin du pansement, soin des hémorragies avant le brancard, triage par temps avant de se
  vider, une hémorragie réveille un dormeur. Rapport morts de leurs plaies / tués au combat :
  0,35 → 0,17 sur 30 graines × 30 jours ; les tués au combat montent un peu (un colon pansé se
  relève et repart). L'inhumation reçoit le même index que le rangement (`grave_tiles`), avec
  un tri explicite `(x, y)` que le chargement par rangées ne garantissait pas.

- 2026-09-05 : le rangement saturé ne balaie plus la carte. `Map` porte la liste triée des cases
  d'entrepôt (sérialisée comme le reste : elle décide où un colon porte sa charge, donc pas un
  cache), le rangement relève en un passage ce que chaque case accepte, « saturé » est exact
  (aucune case libre, aucune pile non pleine) et la borne d'essais compte les candidats
  examinés, plus seulement les aboutis. Mesuré : de 2 000 à 1 000 000 ticks/s à 60 piles au
  sol, coût plat en surface ; la campagne de trois graines passe de 11 s à 0,25 s. Un compteur
  d'observation hors snapshot et hors hash (`haul_scans`) borne le travail dans les tests, jamais
  le temps. Le même défaut existe pour l'inhumation (`try_start_bury`), à corriger.

- 2026-09-05 : la partie longue se mesure avec un joueur scripté. `rimlike-sim campaign` joue N
  graines × D jours avec un joueur pur et déterministe (zones, coupe, culture, feu, lits, poste,
  enceinte et pièges, recherche, arcs, chasse, élevage, troc, tribut) et déduit la cause des
  morts de l'état du tick précédent ; rapport dans `crates/sim-cli/CAMPAIGN-FINDINGS.md`. Cinq
  constats chiffrés, aucun réglage appliqué dans la même tranche : (1) entrepôt plein ⇒ un
  balayage de carte par pile au sol et par tick (1 870× plus lent à 60 piles : défaut du sim,
  `find_stockpile_dest` sans court-circuit et compteur d'essais jamais incrémenté) ; (2) difficile
  éteint 30 colonies sur 30, 25 avant le jour 10 ; (3) la richesse ne pèse que 3 % sur la taille
  des bandes ; (4) le feu est surcritique en été (jusqu'à 2 339 cases sur 4 096) et éteint
  aussitôt par temps froid ; (5) un mort sur trois succombe à ses plaies après le combat, faute
  de débit de pansement. Une année de 60 jours : une campagne de 30 jours partie du jour 0 ne
  voit que printemps et été, d'où `--day-of-year`.

- 2026-09-05 : factions PNJ dans le sim, pas encore dans le monde. Trois factions fixes et une
  réputation par colonie : suffisant pour la boucle « payer sa paix » en solo ; la réputation
  partagée à l'échelle du globe attendra le serveur monde. `TriggerRaid` ignore l'alliance (outil
  de débogage, il doit marcher en pleine paix) alors que le refus de visite marchande s'applique
  aussi à la visite forcée (c'est le refus qu'on veut pouvoir observer). Le prix de vente affiché
  par `trader_offers` est désormais celui de la colonie (réputation comprise) : le client ne
  recalcule rien.

- 2026-09-05 : une bête apprivoisée est un pawn de la colonie. `Faction::Colony` ne veut plus dire
  « un colon » : `is_colonist()` (faction colonie **et** aucune espèce) et `is_livestock()`
  départagent, et les vingt-cinq sites qui lisaient la faction ont été relus un à un (menace,
  barycentre, maladies, caravanes, tableaux de travail, deuil, bavardage, hypothermie…). Aucun
  stride ne change : la troisième valeur du tampon `animals` devient un champ de drapeaux
  (chassée, à apprivoiser, à abattre), la chasse seule vaut toujours 1. La faim du bétail
  réutilise la famine des colons plutôt qu'un compteur neuf. Le fuzz n'atteint jamais l'état
  apprivoisé (les colons y meurent trop vite) : un test de déterminisme dédié avec troupeau
  imposé couvre naissance et abattage.

- 2026-09-05 : le feu est une couche de carte, pas un élément. Une case qui brûle garde son arbre
  ou son mur jusqu'à consommation : `fire` (u8 par case) s'ajoute aux quatre couches existantes
  avec sa propre version, et une liste de foyers porte l'horloge de chaque feu pour ne jamais
  balayer la carte. Toute la dynamique s'évalue une fois sur dix ticks ; sans feu, le coût est
  un test de compteur. La lutte passe avant le travail mais après les besoins critiques, et ne
  fait lâcher un job qu'un tick sur dix et seulement si un foyer est atteignable : un feu
  emmuré ne paralyse pas la colonie. Les cadences (propagation, foudre, feu de camp) sont
  mesurées sur 10 à 20 graines et notées sur les constantes.

- 2026-09-05 : pièges à pointes réglés à la mesure. Sévérité choisie sur 120 graines jouées avec
  et sans pièges ; la courbe n'est pas monotone (à 300 le pillard tombe sous le seuil de fuite au
  premier coup et repart avant d'avoir saigné, donc meurt moins), et un piège inoffensif coûte
  des points de vie à la colonie parce qu'il empêche les colons de sortir. Les colons voient
  leurs propres pièges : la traversabilité dépend du marcheur (`Walker`), la case de départ
  n'est jamais testée, et sans piège sur la carte le marcheur averti redevient ordinaire.
  L'avancement du réarmement vit dans le job du colon, comme `Work` ou `Tend`.

- 2026-09-05 : marchands itinérants 100 % serveur. Le serveur monde fait circuler des caravanes
  PNJ et ne fait jamais confiance au client pour elles ; il ne réémet jamais une arrivée (pas
  d'accusé), l'hôte émet `TriggerTraderVisit` une fois par message. Une colonie fermée cumule
  les passages (trois au plus) remis à la réouverture, par `start` pour une colonie qui démarre
  et par `snapshot` pour une colonie gelée qui rouvre. L'avancement est dérivé des dates de
  départ et d'arrivée, jamais incrémenté : un redémarrage reprend le voyage à l'identique. Une
  entrée de marchand corrompue est ignorée au chargement plutôt que de bloquer le fichier.

- 2026-09-05 : un seul contexte WebGL par onglet. `render/gl.ts` possède l'unique
  `WebGLRenderer` et son canevas ; les écrans Monde et Colonie gardent chacun leur scène et
  leur caméra et se passent le canevas en le déplaçant d'un conteneur à l'autre (ce qui route
  aussi les entrées souris). Réglages globaux posés une fois, ombres toujours actives (les
  basculer recompile tous les matériaux), perte de contexte interceptée pour permettre la
  restauration. Chaque écran libère ses géométries et matériaux à la fermeture, jamais le
  renderer ni les textures partagées. Vérifié : quatre allers-retours, compteurs mémoire
  stables (6 géométries, 0 texture sur le globe).

- 2026-09-05 : le bavardage n'est pas un travail. Pas de `WorkType` ni de priorité : un colon ne
  discute que quand il n'a rien d'autre à faire, juste avant de flâner, ce qui garde le tableau
  des priorités intact et empêche le social de concurrencer la survie. Pas d'orientation dans
  `Pawn` (le stride n'a pas bougé) : « se faire face » se traduit par un arrêt. Une rixe ne tue
  jamais (sévérité rabotée pour laisser 200 points de vie). Un colon parti ou mort est oublié
  des avis des autres : les ids d'une autre colonie ne désignent personne, et une caravane
  arrive donc sans avis.

- 2026-09-05 : cadence de la recherche mesurée, pas devinée. La consigne initiale (10 points par
  tick, coûts de 2 000 à 3 000) donnait une technologie en trois secondes. L'avancement se
  compte désormais en centièmes de point (état interne), les coûts et l'affichage en points ;
  réglage à deux dixièmes de point par tick après deux mesures (un colon seul qui ne fait que
  chercher : 7 115 ticks à quatre dixièmes, donc ~14 000 à deux dixièmes, soit un peu plus
  d'une journée), avec un test qui borne la durée entre une demi-journée et trois jours.

- 2026-09-05 : recherche à bonus, pas à verrous. Une technologie améliore ce que la colonie
  sait déjà faire ; rien d'existant n'est bloqué derrière l'établi, ce qui laisse les tests
  et les parties en cours intacts et évite un début de partie vide. Chaque technologie décrit
  ses effets en constantes et fonctions pures dans `research.rs`, les points d'application
  (`jobs`, `combat`, `build`, `fastforward`) ne font que lire le drapeau. Une commande de
  recherche invalide est ignorée, pas réinterprétée. Le septième type de travail change deux
  strides de tampons : contrat mis à jour des deux côtés dans le même élan.

- 2026-09-05 : conservation par le froid. La date de péremption fixe devient une fraîcheur
  entière par pile dont la perte dépend de la température de la case ; `spoil_at` reste
  comme simple estimation d'affichage à la vitesse courante, il ne décide plus rien. Perte
  calculée en `u64` avec la division en dernier : un quotient tronqué trop tôt laissait un
  résidu qui retardait la disparition. L'avance rapide applique la vitesse de la température
  actuelle (on ne connaît pas la température passée). Le test `unreachable_food_spoils`
  force un climat chaud : sous le climat tempéré par défaut, les baies durent maintenant
  plus longtemps, c'est l'effet voulu. Bench 100 000 ticks : aucune régression, le
  scénario chargé gagne 20 % (péremption évaluée toutes les 60 ticks au lieu de chaque tick).

- 2026-09-05 : reconnexion automatique (client). Le transport de salle et celui du monde
  sont enveloppés dans `ReconnectingTransport`, qui masque les essais intermédiaires : la couche
  au-dessus ne voit que « nouveau transport prêt » (`onReconnect`) ou « abandon » (`onClose`).
  Les commandes émises pendant la coupure ne sont jamais rejouées (le lockstep leur aurait donné
  un autre tick, voir protocole §5) : elles sont comptées et le joueur est prévenu une fois.
  Un serveur relancé perd ses salles : les clients reviennent alors dans un lobby neuf, ce qui
  est le comportement attendu tant que les salles ne sont pas persistées.

- 2026-09-05 : props naturalistes modulaires (client). Catalogue procédural fusionné
  et instancié : tous les éléments et les seize genres d'objets, sols joints,
  silhouettes et portage harmonisés. Murs coupés à 0,56 case, plans issus des modèles
  finis, portes orientées selon murs construits/planifiés et grille locale des outils.
  Le lit et l'établi restent dans une case pour respecter le sim. Aucune règle ni
  frontière WASM changée. Revue de développement `/props-review.html`, détails dans
  `docs/props.md` ; tests d'empreinte, plans, bords et capacité d'instances.

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
- 2026-09-05 : identité par jeton plutôt que par compte : pas de mot de passe, un secret
  par serveur dans le navigateur, une clé publique pour l'appartenance. Le nom redevient un
  libellé. Les protocoles montent en version 2 : un client version 1 est refusé proprement.
- 2026-09-05 : marchands (sim) : le troc se fait en valeur, au barème de la richesse, sans
  monnaie : une monnaie ferait diverger deux échelles de valeur et le commerce deviendrait une
  machine à raids. L'hostilité est un champ du pawn, pas un changement de faction, pour
  pouvoir dire « le marchand est mort » et faire tomber sa réserve.
- 2026-09-05 : traits (sim) : effets appliqués dans `mood()` et `work_step()` plutôt qu'à la
  source des jobs, pour ne pas disperser les règles. Un test forçant un colon à craquer a dû
  neutraliser ses traits : le hasard lui donnait « Ascète ». Calendrier : un décalage en jours
  plutôt qu'un saut de tick, pour que hash, météo et heure restent cohérents.
- 2026-09-05 : client publié sur GitHub Pages (https://cheelax.github.io/rimlike/) à chaque
  push sur `main`. Le solo se joue sans rien installer ; c'est le canal de test le plus simple
  pour des joueurs extérieurs. Réversible d'un clic dans les réglages du dépôt.
- 2026-09-05 : écran « Salles ouvertes » (Sonnet, client) : sondage de `GET /rooms` toutes
  les 5 s sur l'accueil, Rejoindre préremplit et connecte, une salle de case ouvre le globe sur
  sa case. Vérifié à deux onglets.
- 2026-09-05 : storyteller (sim). La taille d'une bande est tranchée d'abord (60 points par
  pillard), l'équipement se paie avec le reste : une boucle « 40 points = un pillard » donnait
  trois pillards au tick 0 et cassait la mesure du premier raid. La richesse se lit sans
  recalcul (`&self`, cache rafraîchi par le tick) pour que le client puisse l'afficher sans
  risque de désync.
- 2026-09-05 : `GET /rooms` (Sonnet) pour rejoindre ses amis sans connaître le nom de la
  salle ; au passage, trois tests serveur dépendant du temps réel sont passés sur horloge et
  planificateur injectés : plus de faux échecs sous charge, suite quatre fois plus rapide.
- 2026-09-05 : vêtements (sim). Le seuil d'habillage a été fixé après mesure sur dix
  graines d'une journée de printemps tempéré, pas à l'intuition. Arme et habit partagent la
  même recherche d'équipement, seul le barème change.
- 2026-09-05 : climat par case : dérivé à la volée du globe partagé, jamais persisté ; pas
  de `snapshot.climate` car le climat est déjà dans l'état du sim restauré, contrairement au
  temps gelé qui doit être rejoué en commande.
- 2026-09-05 : faune (sim). Les bêtes sont des `Pawn` de faction Animal : même santé, même
  déplacement, IA courte. La chasse se marque par bête (une commande, pas une désignation de
  case) et reste rattachée au type de travail « désignations ». Paître et fuir marchent en
  ligne droite plutôt qu'en A*, qui allouait trois grilles pour quatre pas.
- 2026-09-05 : garde-fous serveur (Sonnet) : tailles, débit, connexions par IP (refus à
  l'upgrade en 429), salles, noms ; tout configurable, exposé dans `/health`. Préalable à
  tout hébergement public.
- 2026-09-05 : resync (serveur) : la majorité est recalculée à chaque hash reçu, pas
  seulement au premier écart, sinon ni réparation ni retour à la normale ne seraient
  détectables. Un seul cooldown par joueur, partagé entre réparation automatique et demande
  manuelle.
- 2026-09-05 : climat (sim). Le calendrier démarre au printemps pour ne pas commencer dans
  le gel ; le remplissage des pièces ignore arbres, feux et eau pour rester rarement
  invalidé ; une seule lecture de la température extérieure par tick partagée par tous les
  systèmes (10 % de perf en jeu). Champs ajoutés en fin de `Pawn`, commande en fin d'enum.
- 2026-09-05 : déploiement (Sonnet) : image Docker qui n'embarque que du JavaScript compilé
  et `ws`, compose avec volume. La CI construit et démarre l'image : elle a révélé que le
  `node_modules` du paquet n'était fait que de liens vers un dépôt `.pnpm` absent de l'image
  (`ws` introuvable) ; corrigé en installant la production en mode hoisted.
- 2026-09-05 : portée de l'identité = serveur + nom. Découvert à l'essai : deux onglets
  partageant `localStorage` devenaient un seul joueur renommé au dernier `world_join`. Le nom
  reste un libellé côté serveur, mais côté navigateur il choisit le profil.
- 2026-09-05 : armes (sim). La fabrication s'appuie sur la compétence Construire plutôt
  qu'un septième type de travail : `WORK_TYPES` et les tampons de priorités ne bougent pas.
  Les compteurs du bill incluent les armes équipées par les colons, pas celles des pillards.
  Champs ajoutés en fin de structures : un vieux snapshot échoue proprement au lieu d'être
  relu de travers.
- 2026-09-05 : avance rapide abstraite plutôt que rejouée : O(entités), déterministe, sans
  rien semer ni récolter (personne n'était là) ; la commande est ajoutée en fin d'enum pour
  ne pas décaler les indices postcard des manifestes et snapshots existants. Équilibrage :
  on a mesuré avant de régler ; le scénario groupé passait déjà, le scénario dispersé a
  révélé l'acharnement des pillards sur une cible isolée.
- 2026-09-05 : caravanes. Le manifeste voyage dans la commande `ArriveCaravan` : tous les
  clients d'une salle l'appliquent au même tick, le serveur ne le décode jamais. Les ids des
  colons ne survivent pas au voyage (réattribués à l'arrivée). Le monde ne vieillit pas
  serveur éteint. Les deux agents ont été coupés par la limite d'usage en fin de travail :
  l'état sur disque était complet et vert, vérifié et commité après reprise.
- 2026-09-05 : santé détaillée (sim). `hp` reste dans le tampon comme valeur dérivée pour ne
  rien casser côté client. La famine crée des blessures « faiblesse » déjà pansées : sans ça
  les colons affamés passaient leur temps à se soigner entre eux. Les pawns à terre sont
  ignorés par toutes les recherches d'ennemi, ce qui rend le sauvetage possible.
- 2026-09-05 : écran Monde livré. Connexion monde sur le thread principal, connexion de
  salle dans le Worker : deux sockets, ce que le protocole autorise, plutôt qu'un transfert
  impossible de socket vers le Worker. Le client ne regénère jamais le globe.
- 2026-09-05 : compétences et noms (sim). `spawn_pawn` prend la faction pour tirer nom et
  niveaux au bon moment ; les tirages supplémentaires changent les hashes mais pas le
  déterminisme (test inchangé et vert). Bench inchangé.
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
