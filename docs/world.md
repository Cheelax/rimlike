# Le globe — `packages/world`

Fondations de la phase 4 (« couche monde ») : la géométrie du globe, ses biomes et le
calcul d'itinéraire. Paquet TypeScript pur, sans I/O ni rendu, **zéro dépendance
runtime**, utilisable côté Node comme côté navigateur.

Ce paquet ne contient **pas** le serveur monde : il lui fournit ses primitives. Voir
`docs/PLAN.md` §3 pour le modèle multijoueur et §6 phase 4 pour le périmètre visé.

```
packages/world/
  src/rng.ts          mulberry32 seedé, dérivation de sous-seeds
  src/noise.ts        bruit de valeur 3D et fBm normalisé
  src/geometry.ts     icosaèdre, subdivision, dual hexagonal, lat/lon, aires
  src/biomes.ts       élévation, température, humidité, table de décision
  src/travel.ts       coûts par biome, distance orthodromique, A*
  src/serialize.ts    WorldWire : format de transport compact
  test/               83 tests vitest (~0,6 s)
```

## 1. Modèle : géodésique puis dual

Le globe part d'un **icosaèdre** régulier inscrit dans la sphère unité (12 sommets,
20 faces, 30 arêtes). Chaque subdivision coupe chaque triangle en quatre et reprojette
les nouveaux sommets sur la sphère. Les milieux d'arête sont mutualisés par une table
indexée sur la **paire d'indices** de sommets, pas sur des coordonnées : la
déduplication est exacte, sans tolérance flottante.

Les cases de jeu ne sont pas ces triangles mais les cellules du **dual** : une case par
sommet de la géodésique, dont le polygone est formé des centres des faces incidentes.

```
        géodésique (triangles)              dual (cases de jeu)

              •                                  ┌───┐
             / \                             ┌───┤   ├───┐
            /   \          ──────►           │   │ ▓ │   │
           •-----•                           └───┤   ├───┘
          / \   / \                              └───┘
         •---•---•                          un sommet = une case
                                            une face  = un coin de case
```

Un sommet à 6 faces incidentes donne un hexagone ; les 12 sommets de l'icosaèdre
d'origine n'en ont que 5 et donnent des **pentagones**. C'est inévitable : aucun pavage
de la sphère par des hexagones seuls n'existe (Euler l'interdit). Ces 12 pentagones
gardent les **identifiants 0 à 11** à toute subdivision, la subdivision n'insérant des
sommets qu'après eux — pratique pour les repérer côté client.

| n | cases | faces | arêtes | angle moyen entre voisins |
|---|---|---|---|---|
| 0 | 12 | 20 | 30 | 1,10715 rad (63,4°) |
| 1 | 42 | 80 | 120 | 0,59095 rad |
| 2 | 162 | 320 | 480 | 0,30048 rad |
| 3 | 642 | 1 280 | 1 920 | 0,15087 rad |
| 4 | 2 562 | 5 120 | 7 680 | 0,07552 rad |
| **5** | **10 242** | 20 480 | 30 720 | **0,03777 rad (2,16°)** |

`tileCount(n) = 10 × 4^n + 2`. La cible de jeu est **n = 5** (`DEFAULT_SUBDIVISIONS`),
soit 10 242 cases : conforme à la fourchette « ~2 500 à 10 000 » du plan. Les tests
travaillent à n = 2 ou 3 pour rester instantanés, et à n = 4 pour la calibration.

La subdivision **déforme** les arêtes : à n = 5 elles vont de 0,0346 à 0,0413 rad, soit
±10 % autour de la moyenne. Cet écart n'est pas anecdotique, il intervient dans
l'admissibilité de l'heuristique de l'A* (§5).

### Repère

Sphère unité, **axe +Y vers le nord** (convention Three.js : le client peut poser les
positions telles quelles). `lat = asin(y)`, `lon = atan2(x, z)`, en degrés : longitude 0
sur le méridien +Z, croissante vers +X (est).

### Aires

`area` est l'aire du polygone sphérique en **stéradians** (la sphère entière vaut 4π),
calculée par la formule de Van Oosterom & Strackee (excès sphérique en `atan2`, stable
sur les triangles très fins). Comme les cases adjacentes partagent leurs sommets à
l'identique, les polygones pavent la sphère exactement : la somme des aires vaut 4π à
la précision machine (le test l'exige à 1 % près, on obtient mieux que 10⁻⁶).

## 2. Formats de données

### `Tile` et `World` (en mémoire)

```ts
interface Tile {
  id: number;            // = indice du sommet dans la géodésique
  center: Vec3;          // vecteur unitaire
  lat: number; lon: number;   // degrés
  neighbors: number[];   // 5 ou 6, ordonnés autour du centre
  polygon: Vec3[];       // 5 ou 6 sommets, même ordre que neighbors
  area: number;          // stéradians
  biome: Biome;
  elevation: number;     // [0, 1], SEA_LEVEL sépare eau et terre
  temperature: number;   // °C
  moisture: number;      // [0, 1]
}
interface World { seed: number; subdivisions: number; tiles: Tile[] }
```

`polygon[i]` est le coin qui joint `neighbors[i]` à `neighbors[i + 1]` : les deux listes
tournent ensemble dans le sens antihoraire vu de l'extérieur.

### `WorldWire` (sur le réseau)

Tout en tableaux de nombres plats, sans objet par case : compact en JSON et recopiable
directement dans des tableaux typés côté client.

| champ | longueur | contenu |
|---|---|---|
| `version`, `seed`, `subdivisions`, `tileCount` | — | en-tête |
| `centers` | 3 N | centres unitaires |
| `biomes` | N | valeur de l'enum `Biome`, un octet |
| `elevation`, `temperature`, `moisture` | N chacun | climat |
| `neighbors` | 6 N | voisins, **-1** en 6ᵉ place pour les 12 pentagones |
| `polygonOffsets` | N + 1 | bornes de `polygons`, **en sommets** |
| `polygons` | 3 × (6 N − 12) | sommets des polygones aplatis |

`lat`, `lon` et `area` ne sont **pas** transportés : ils se recalculent exactement depuis
`centers` et `polygons`, et coûteraient trois nombres de plus par case.

Une longueur fixe de 6 voisins avec un trou marqué à -1 évite un second tableau
d'offsets pour 12 cases sur 10 242 ; les polygones, eux, ont besoin de leurs offsets.

**Piège de taille** : convertir un `Float32Array` en nombres JavaScript donne des
doubles dont l'écriture décimale la plus courte fait 17 chiffres
(`0.5257311463356018`). Les valeurs sont donc arrondies à `WIRE_PRECISION = 7` chiffres
significatifs avant d'entrer dans le JSON — la précision d'un `Float32`, pour une
écriture deux fois plus courte.

| n | cases | nombres | JSON | JSON gzippé | génération |
|---|---|---|---|---|---|
| 3 | 642 | 20 509 | 171 Kio | 30 Kio | 10 ms |
| 4 | 2 562 | 81 949 | 0,69 Mio | 139 Kio | 56 ms |
| **5** | **10 242** | **327 709** | **2,78 Mio** | **647 Kio** | 149 ms |

À n = 5, un client télécharge donc ~650 Kio une fois (le globe ne change pas), soit
~284 octets par case avant compression. C'est acceptable pour un chargement unique
mis en cache. Deux optimisations restent en réserve si ça devient gênant :

1. **Partager les coins.** Chaque sommet de polygone est le centre d'une face,
   partagé par exactement 3 cases : les transporter une fois (20 480 coins) avec des
   indices par case ramènerait 184 320 flottants à 61 440 flottants + 61 440 entiers,
   soit ~35 % de nombres en moins.
2. **Passer en binaire.** Les mêmes tableaux typés en `ArrayBuffer` font 1,3 Mio brut
   sans arrondi ni virgules, et se transmettent tel quel sur une WebSocket.

Le format actuel est volontairement en JSON lisible : la phase 4 n'en est qu'aux
fondations et un paquet inspectable à l'œil vaut mieux qu'un gain de 35 %.

### Aller-retour

`serializeWorld` / `deserializeWorld` garantissent :

- **exact** pour les entiers : `seed`, `subdivisions`, `id`, `biome`, `neighbors` ;
- **10⁻⁶ en relatif** pour les flottants transportés : `center`, `elevation`,
  `temperature`, `moisture`, `polygon` ;
- **dérivé** pour `lat`, `lon` et `area`, recalculés à l'arrivée. `area` reste à 10⁻⁵
  en relatif, mais la **latitude peut dériver de ~2 × 10⁻⁴ degré** près des pôles :
  `asin` a une dérivée qui explose quand `y` approche ±1, donc l'erreur de simple
  précision sur le centre y est amplifiée. Sans conséquence pour le jeu (2 × 10⁻⁴
  degré, c'est 2 cm au sol), mais à savoir avant d'écrire un test à 10⁻⁶ dessus.

`deserializeWorld` valide la version et toutes les longueurs de tableaux, et rejette
un voisin hors du monde ou un biome inconnu : un `WorldWire` reçu est une donnée
extérieure, pas une valeur de confiance.

## 3. Calibration des biomes

Trois champs par case, dans cet ordre : élévation, puis température (qui dépend de
l'élévation), puis humidité. Tous les seuils ci-dessous sont mesurés à **n = 4**
(2 562 cases) sur 24 seeds.

### Élévation, et pourquoi le niveau de la mer n'est pas un seuil constant

L'élévation brute est un fBm basse fréquence (le « biais continental », qui décide où
sont les masses de terre) mélangé à un fBm plus fin (le relief) :

| paramètre | valeur | rôle |
|---|---|---|
| `CONTINENT_FREQUENCY` | 1,15 | continents de l'ordre du quart de globe |
| `CONTINENT_OCTAVES` | 4 | |
| `RELIEF_FREQUENCY` | 3,6 | chaînes et vallées |
| `RELIEF_OCTAVES` | 5 | |
| `CONTINENT_WEIGHT` | 0,62 | part du biais continental |
| `ELEVATION_CONTRAST` | 2,35 | étirement autour de 0,5 : le fBm est trop concentré |

**Un seuil constant sur ce champ ne tient pas.** Mesure faite : avec un niveau de la
mer fixé à 0,53, la part d'océan à n = 4 va de **21 % à 73 %** selon le seed. La raison
est structurelle : à la fréquence 1,15, le fBm continental n'a qu'une quinzaine de
motifs indépendants sur toute la sphère, donc sa moyenne spatiale est elle-même une
variable aléatoire de forte variance. Monter la fréquence réduirait la variance mais
supprimerait les grands continents, qui sont le but. Un joueur ne doit pas tomber sur un
monde noyé ou sans mer.

La correction est une **normalisation par quantile** (`normalizeElevations`) : on prend
le quantile `WATER_TARGET` du champ comme niveau de la mer, puis on étire linéairement
les deux moitiés vers [0, `SEA_LEVEL`) et [`SEA_LEVEL`, 1]. C'est une transformation
monotone : l'ordre des cases par altitude est conservé, donc la géographie reste
entièrement dictée par le bruit, seule l'échelle change. Le résultat reste une fonction
déterministe de `(subdivisions, seed)`.

| valeur retenue | | |
|---|---|---|
| `WATER_TARGET` | **0,64** | part de cases sous le niveau de la mer, imposée |
| `SEA_LEVEL` | **0,5** | par commodité : c'est le quantile qui décide, pas ce nombre |
| `MOUNTAIN_HEIGHT` | **0,62** | en hauteur de terre normalisée (0 = mer, 1 = point le plus haut) |

Conséquence : `generateWorld` fait **deux passes** (élévation brute de toutes les cases,
puis climat sur l'élévation normalisée). C'est le seul endroit où une case dépend des
autres.

Résultat mesuré sur 24 seeds à n = 4 : le biome `Ocean` couvre **56 % à 63,5 %** des
cases (médiane 59,2 %), dans la fourchette visée de 55-65 %. L'écart entre
`WATER_TARGET` = 64 % et l'océan observé vient de la banquise : les mers polaires
gèlent et deviennent `Ice`. Les montagnes couvrent 2,6 % à 11,2 % des cases (moyenne
5,6 %) — cette part-là n'est pas imposée par le quantile, elle dépend de la forme de la
queue haute du champ.

### Température

`EQUATOR_TEMPERATURE` + (`POLE_TEMPERATURE` − `EQUATOR_TEMPERATURE`) × (|lat|/90)^`LATITUDE_EXPONENT`
− `ALTITUDE_LAPSE` × hauteur de terre + bruit.

| paramètre | valeur |
|---|---|
| `EQUATOR_TEMPERATURE` | 32 °C |
| `POLE_TEMPERATURE` | −30 °C |
| `LATITUDE_EXPONENT` | 1,35 (> 1 : élargit la ceinture chaude) |
| `ALTITUDE_LAPSE` | 26 °C du niveau de la mer au sommet |
| `TEMPERATURE_NOISE` | ±4 °C |

Le choix de `ALTITUDE_LAPSE` = 26 et `MOUNTAIN_HEIGHT` = 0,62 n'est pas indépendant :
le refroidissement maximal d'une case **non** montagneuse est
26 × 0,62 = 15,6 °C, donc une case de l'équateur reste au-dessus de
32 − 15,6 − 4 = 12,4 °C. **Il ne peut jamais y avoir de glace à l'équateur**, c'est une
propriété arithmétique de la table, pas une chance de tirage — et c'est testé.

### Humidité

fBm indépendant (`MOISTURE_FREQUENCY` 2,1, 4 octaves), étiré par
`MOISTURE_CONTRAST` = 2,2. Volontairement sans lien avec la latitude : ni ceinture
désertique aux tropiques, ni effet d'ombre pluviométrique derrière les chaînes. Ce
serait plus réaliste et ça viendra si le besoin se fait sentir ; pour l'instant un champ
simple suffit à mélanger les biomes.

### Table de décision

```
élévation < SEA_LEVEL ─┬─ T < -10 °C ─────────────── banquise (Ice)
                       └─ sinon ──────────────────── océan (Ocean)

terre ─┬─ hauteur >= 0,62 ───────────────────────── montagne (Mountain)
       ├─ T < -8 °C ─────────────────────────────── calotte (Ice)
       ├─ T < 1 °C ──────────────────────────────── toundra (Tundra)
       ├─ T < 10 °C ─┬─ humidité >= 0,38 ────────── forêt boréale
       │             └─ sinon ───────────────────── toundra
       ├─ T < 20 °C ─┬─ humidité >= 0,60 ────────── forêt tempérée
       │             ├─ humidité >= 0,32 ────────── prairie
       │             └─ sinon ───────────────────── désert (froid)
       └─ T >= 20 °C ┬─ humidité >= 0,62 ────────── jungle
                     ├─ humidité >= 0,34 ────────── savane
                     └─ sinon ───────────────────── désert (chaud)
```

L'ordre compte. La **montagne passe avant le climat** : au-dessus du seuil, la case est
de la roche où qu'elle soit sur le globe, y compris aux pôles (c'est pourquoi le test
polaire tolère 20 % de cases hors {glace, toundra, océan} : ce sont des sommets).
La **banquise avant l'océan** donne des calottes polaires franchissables — c'est le
seul pont terrestre possible entre deux continents séparés par la mer, tant qu'il n'y a
pas de bateaux.

Parts mesurées à n = 5, seed 20260904 :

| biome | part | | biome | part |
|---|---|---|---|---|
| océan | 57,4 % | | prairie | 3,7 % |
| banquise | 10,3 % | | forêt tempérée | 2,7 % |
| montagne | 6,3 % | | jungle | 2,6 % |
| toundra | 5,4 % | | savane | 2,1 % |
| forêt boréale | 4,8 % | | désert | 4,6 % |

## 4. Coûts de déplacement

En **heures de jeu par case traversée**. Entrer dans une case coûte le prix de **son**
biome ; la case de départ est gratuite.

| biome | heures | | biome | heures |
|---|---|---|---|---|
| océan | **infranchissable** | | forêt tempérée | 8 |
| montagne | 24 | | désert | 8 |
| banquise | 14 | | toundra | 7 |
| jungle | 12 | | savane | 5 |
| forêt boréale | 9 | | prairie | 4 |

L'océan est infranchissable (`null`) : pas de bateaux pour l'instant, donc une caravane
ne quitte pas son continent. C'est une décision de périmètre, pas une contrainte du
modèle : ajouter un coût maritime et une condition « la caravane a un navire » ne
touchera que `MOVEMENT_COSTS` et la signature de `findRoute`.

## 5. Itinéraires

`findRoute(world, fromId, toId)` : A* sur le graphe des voisins, tas binaire maison
(pas de dépendance). Rend `{ tiles, hours }` avec départ et arrivée inclus dans
`tiles`, ou `null` si la destination est inaccessible par voie terrestre ou si l'une des
deux extrémités est infranchissable.

Heuristique : `distance orthodromique / plus grand pas possible × MIN_MOVEMENT_COST`.

Elle est **admissible**, et c'est démontrable : tout chemin de `k` étapes couvre au plus
`k × angleMax` de sphère, or la distance orthodromique est un minorant de la longueur
du chemin (inégalité triangulaire sur la sphère), donc `k ≥ angle / angleMax` ; et
chaque étape coûte au moins `MIN_MOVEMENT_COST`. L'heuristique ne surestime donc jamais
le coût restant, et l'A* rend un optimum — c'est ce que vérifie le test qui compare
`findRoute` à un Dijkstra naïf de référence sur 20 paires tirées au sort.

C'est pour ça que l'échelle est le **maximum** des angles entre voisins et non leur
moyenne : avec la moyenne, les arêtes courtes (−10 %) rendraient l'heuristique
optimiste et l'A* pourrait manquer l'optimum. Les angles sont mesurés une fois par monde
et mémoïsés dans une `WeakMap`.

`greatCircleDistance(a, b, world?)` rend l'écart **en radians** et **en « cases »**
(angle / angle **moyen** entre voisins — ici la moyenne est la bonne mesure, c'est un
nombre d'affichage). Sans `world`, la conversion utilise `DEFAULT_TILE_ANGLE`, l'angle
moyen du globe par défaut (n = 5) : 0,03777 rad. Une case n'est donc pas une unité
exacte, seulement un ordre de grandeur à ±10 %.

## 6. Déterminisme et ses limites

**Ce qui est garanti :** même `(subdivisions, seed)`, même monde, **sur la même
machine et le même moteur JS**. C'est la garantie dont le serveur monde a besoin : il
peut regénérer un globe depuis son seed au lieu de le stocker.

- Tout l'aléa passe par `createRng` (mulberry32) ou par le hachage de `noise.ts`.
  **Aucun `Math.random`** dans le paquet, et aucune table globale mutable : la valeur
  d'un nœud du réseau de bruit est calculée à la demande depuis ses coordonnées
  entières et le seed.
- Ces deux briques sont en arithmétique **entière 32 bits** (`Math.imul`, `^`, `>>>`),
  exacte et identique dans tous les moteurs JS.
- Aucune structure à ordre d'itération non maîtrisé n'influence un résultat : les `Map`
  de `geometry.ts` servent à mutualiser des indices, et l'éventail de faces autour d'un
  sommet est parcouru en démarrant **au voisin d'indice le plus petit**, pas au premier
  venu.
- Les flottants sont acceptés — contrairement à `crates/sim`, où ils sont interdits par
  lint. Ce paquet n'est pas en lockstep : le serveur monde est autoritaire, il calcule
  seul et diffuse le résultat.

**Ce qui n'est pas garanti :** `Math.sin`, `Math.cos`, `Math.asin`, `Math.atan2` et
`**` ne sont **pas** normalisés au dernier bit par ECMA-262 — la norme n'exige qu'une
« approximation ». Deux moteurs (ou deux versions du même moteur, ou deux
architectures) peuvent différer d'un ULP. La géométrie du globe et le climat en
dépendent partout : `normalize`, `angleBetween`, `toLatLon`, les aires sphériques, la
courbe de latitude.

Conséquence pratique, et c'est une règle, pas une précaution :

> **Le client ne régénère jamais le monde.** Le serveur monde génère le globe et sert
> son `WorldWire`. Un écart d'un ULP sur une élévation peut basculer une case juste au
> seuil d'un biome, et deux joueurs ne verraient pas la même carte.

Ce que ça implique en aval : la normalisation par quantile est calculée par le serveur
et fait partie des données servies, elle n'est pas reproductible case par case ; et si
un jour le serveur monde tourne en Rust plutôt qu'en Node, ce paquet devient la
référence *de comportement*, pas de bits — il faudra retester les parts de biomes, pas
comparer des hashes.

## 7. Utilisation prévue par le serveur monde et le client

### Serveur monde

```ts
import { generateWorld, serializeWorld, findRoute, movementCost } from "@rimlike/world";

// Au premier démarrage : un seul globe, persisté avec son seed.
const world = generateWorld(5, seedDuMonde);
const wire = serializeWorld(world);          // ~650 Kio gzippés, servis en cache

// Itinéraire d'une caravane : autorité serveur, jamais recalculé par le client.
const route = findRoute(world, caravane.tileId, destinationId);
if (route === null) {
  // destination inatteignable : refuser l'ordre
} else {
  caravane.path = route.tiles;
  caravane.hoursRemaining = movementCost(world.tiles[route.tiles[1]].biome);
}
```

Le serveur garde par case ce que ce paquet ne connaît pas : propriétaire, snapshot de
carte, date de dernière visite. La case est identifiée par son `id`, stable pour une
subdivision donnée puisqu'il ne dépend d'aucun aléa — c'est une clé persistante
utilisable en base.

L'avancement d'une caravane se fait en **heures de jeu** sur l'horloge globale
(continue, sans pause en multi — cf. `docs/PLAN.md` §3) : à chaque tick de monde, on
décrémente `hoursRemaining` ; à zéro, la caravane passe à la case suivante de
`route.tiles` et recharge le coût de la nouvelle. À l'arrivée sur une case habitée,
elle est injectée dans le sim de carte comme groupe de pawns.

Un itinéraire est recalculé si un biome change (route coupée) ; à 10 242 cases, l'A*
tient largement dans le budget d'un tick de monde.

**Note — climat des colonies.** `climateForTile(tile)` (`src/climate.ts`) relie le
climat du globe à celui du sim : elle rend `{ baseTemperature, amplitude }` en
**dixièmes de degré Celsius entiers**, la forme attendue par `Command::SetClimate`
côté sim (`crates/sim/src/climate.rs`). `baseTemperature` reprend `tile.temperature`
telle quelle (arrondie, convertie) ; `amplitude` grandit avec la latitude — ±4 °C à
l'équateur, jusqu'à ±20 °C au pôle, une courbe en sinus de la latitude comme celle de
la température (§3) — et gagne ±3 °C de plus en désert (plus grand écart été/hiver
d'un climat sec). Les deux valeurs sont bornées aux limites du sim
(`CLIMATE_BASE_MIN/MAX`, `CLIMATE_AMPLITUDE_MIN/MAX`), en pratique jamais atteintes par
ce globe. Le serveur monde (`apps/server/src/server.ts`) l'appelle à la création de la
salle d'une case pour fabriquer le `climate` du `start` diffusé
(`docs/protocol.md` §3.2 et §11.6) : rien n'est persisté, c'est une fonction pure de la
case, recalculée à la volée depuis le globe partagé (`sharedWorld`) à chaque fondation.

### Client

Le client **reçoit** `WorldWire` et ne génère rien. Rendu du globe en Three.js :

```ts
const world = deserializeWorld(wire);

// Une BufferGeometry pour tout le globe, triangulation en éventail par case :
// un polygone à k sommets donne k - 2 triangles (centre non nécessaire, les
// cases sont convexes).
const positions: number[] = [];
const colors: number[] = [];
for (const tile of world.tiles) {
  const color = BIOME_COLORS[tile.biome];
  for (let i = 1; i + 1 < tile.polygon.length; i += 1) {
    positions.push(...tile.polygon[0], ...tile.polygon[i], ...tile.polygon[i + 1]);
    colors.push(...color, ...color, ...color);   // couleur plate par case
  }
}
```

`BIOME_COLORS` est une table du client, pas du paquet — celui-ci ne fournit que
`BIOME_NAMES`, la couleur est une affaire de rendu.

Le compte de triangles : (N − 12) hexagones × 4 + 12 pentagones × 3 = 4 N − 12, soit
**40 956 triangles** à n = 5 pour le globe entier. Une seule `BufferGeometry`, une
seule draw call, rebâtie seulement quand un biome ou un propriétaire change. La couleur
par sommet plutôt qu'une texture évite toute question de dépliage UV sur une sphère.

Sélection d'une case : raycast sur la sphère unité, puis case la plus proche du point
d'impact — même principe que le raycast sur un plan de la carte de colonie
(`AGENTS.md`, conventions client). Une recherche linéaire sur 10 242 centres suffit
pour un clic ; si le survol continu la rend visible, indexer par latitude.

L'itinéraire d'une caravane s'affiche depuis `route.tiles` reçu du serveur ; le client
peut appeler `findRoute` **en prévisualisation** avant d'envoyer l'ordre, en acceptant
que le serveur ait le dernier mot.

Contrats à tenir des deux côtés, comme pour les enums du sim (`AGENTS.md`) : les
valeurs numériques de `Biome` font partie du format réseau, et `NEIGHBOR_SLOTS` = 6
avec `NO_NEIGHBOR` = −1 est la convention d'aplatissement des voisins.

## 8. Tests

`pnpm test:world` (ou `pnpm --filter @rimlike/world test`) — 83 tests, ~0,6 s.

| fichier | couvre |
|---|---|
| `test/geometry.test.ts` | `tileCount` pour n = 0..5, Euler `V − E + F = 2`, exactement 12 pentagones, symétrie et ordonnancement des voisins, centres et coins unitaires à 10⁻⁹, somme des aires = 4π, repère lat/lon, angles entre voisins |
| `test/biomes.test.ts` | même seed → biomes strictement égaux, seed différent → plus de 30 % de cases changées, géométrie indépendante du seed, part d'eau imposée par le quantile sur plusieurs seeds, océan entre 50 et 70 % à n = 4, pôles gelés, pas de glace à l'équateur, gradient d'altitude, chaque branche de la table de décision, les dix biomes présents, propriétés du RNG |
| `test/travel.test.ts` | ordre des coûts, distance orthodromique, route de longueur 2 entre voisins, **égalité avec un Dijkstra de référence** sur 20 paires seedées, cohérence des routes (cases voisines, coûts additifs, sans cycle), aucune route ne traverse l'océan, `null` entre deux continents séparés (biomes forcés), passage retrouvé si on pose un pont de banquise, admissibilité de l'heuristique |
| `test/serialize.test.ts` | longueurs et invariants du `WorldWire`, un seul trou de voisin par pentagone, aller-retour (entiers exacts, flottants à 10⁻⁶ relatif, dérivés recalculés), stabilité d'une seconde sérialisation, itinéraires identiques après aller-retour, rejet des paquets malformés |

Les seuils statistiques (part d'océan, pôles gelés) sont testés sur plusieurs seeds et
non sur un seul : c'est la seule façon de détecter une régression de calibration plutôt
qu'un heureux tirage.
