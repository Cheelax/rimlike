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
en première commande (client à brancher). Reste : un seul contexte WebGL par onglet.
- Globe hexagonal, rendu du globe, biomes, choix de case de départ.
- Serveur autoritaire persistant : cases, propriétaires, horloge globale.
- Cartes gelées + avance rapide abstraite.
- Caravanes : formation, chemin sur le globe, arrivée sur une case, retour.
- Visite d'une case occupée par un autre joueur.
**Jalon** : deux joueurs s'installent sur des cases distinctes, l'un envoie une
caravane chez l'autre. **Atteint le 2026-09-05**, en tests d'intégration contre le vrai
serveur et en essai réel à deux onglets (alice sur la case 5, bob sur la 199, un colon
d'alice arrivé chez bob).

### Phase 5 — Profondeur (ouvert) — entamée le 2026-09-05
Fait : noms de colons (tirés au sort par faction, déterministes) et compétences (six
types, niveau 0-20, XP par tick de travail, montée de niveau avec événement ; la vitesse de
travail combine humeur et compétence, les transports ne rapportent pas d'XP). Côté sim et
sim-wasm seulement pour l'instant : l'interface (noms au lieu de « Colon N », onglet
compétences) suit dès que l'écran Monde est posé. Livré par un sous-agent Sonnet.
Santé détaillée livrée le 2026-09-05 (Opus) : six parties du corps, blessures avec sévérité
et saignement qui se referme seul, sang, `hp` dérivé, mobilité et manipulation qui ralentissent,
conscience, colons à terre, sauvetage vers un lit et soins par les camarades, pillards qui
ignorent les colons à terre, mort par hémorragie ou coup fatal. Fuzz : `rimlike-sim fuzz`
(Sonnet), aucune panique ni désync sur des millions de commandes aberrantes.
Interface livrée le 2026-09-05 (Sonnet) : noms partout (panneau, tableau Travail,
notifications, étiquettes au-dessus des pawns quand la caméra est proche), panneau du colon
avec Besoins, Santé (sang, conscience, blessures détaillées) et Compétences (niveau et XP),
pose « à terre ». À surveiller : les raids tuent vite depuis les saignements (deux colons sur
trois perdus dans un essai de 2 500 ticks), l'équilibrage viendra avec les soins actifs et
l'armement. Armes et combat à distance livrés le 2026-09-05 (Opus, sim) : poste de fabrication
(10 bois), recettes gourdin / épieu / arc, ordres de fabrication « jusqu'à N » par genre,
équipement automatique de la meilleure arme disponible en stockage, compétences de mêlée et de
tir hors tableau de travail, tir à l'arc à 8 cases avec ligne de vue entière (murs, portes,
rochers bloquent), pillards armés selon la taille du raid, butin à leur mort ; seuil de fuite
des pillards 600 → 650 mesuré sur 60 graines pour garder « jamais deux morts d'un coup ».
Interface des armes livrée le 2026-09-05 (Sonnet) : outil Poste, panneau Fabrication avec
cibles par arme, établi et armes dessinés, arme et compétences de combat dans le panneau du
colon ; au passage, les caravanes passent par la connexion monde et le relais par le Worker a
disparu. Saisons et température livrées le 2026-09-05 (Opus, sim) : année de 60 jours en quatre
saisons, courbe annuelle en table entière plus variation journalière, météo et bruit lent ;
climat réglable par carte (`SetClimate`, pour que chaque case du globe ait le sien) ; pièces
détectées par remplissage paresseux (murs, portes, rochers ; le bord de carte est ouvert),
isolation et chaleur des feux par pièce ; gel qui arrête les cultures et peut tuer les plants,
buissons qui ne repoussent pas sous zéro, neige ; froid qui pèse sur l'humeur, hypothermie par
blessures « froid » dont la cicatrisation est bloquée sous −5 °C, chaleur excessive. Pas encore
de vêtements ni de toits explicites. Interface à faire (température, saison, neige, pièces).
Faune, chasse et dépeçage livrés le 2026-09-05 (Opus, sim) : cerfs, lapins et sangliers qui
paissent, fuient et parfois quittent la carte, hardes qui arrivent tous les 2 à 4 jours
(12 bêtes au plus), sanglier qui riposte ; chasse par bête marquée (`Hunt`), réservée aux
colons armés, avec XP de tir ou de mêlée ; dépeçage automatique au poste (viande selon
l'espèce, cuir), viande crue ou cuisinée. Perf : le coût par tick suit le nombre de pawns
(les bêtes comptent), à surveiller ; `u64::isqrt` remplace la racine maison. Interface livrée le
2026-09-05 (Sonnet) : bêtes dessinées par espèce, marquage de chasse au clic ou à la touche
H, panneau animal, viande et cuir dans le stock ; chasse rejouée dans le navigateur : arc
fabriqué, lapin abattu, viande rangée.
À venir : recherche, traits et relations, storyteller adaptatif, factions PNJ et commerce,
mods de contenu, événements monde.

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
- 2026-09-05 : identité par jeton plutôt que par compte : pas de mot de passe, un secret
  par serveur dans le navigateur, une clé publique pour l'appartenance. Le nom redevient un
  libellé. Les protocoles montent en version 2 : un client version 1 est refusé proprement.
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
