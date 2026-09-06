# Guide du joueur

Ce guide décrit ce que le jeu fait aujourd'hui, du point de vue de qui joue.
Pour l'architecture et les décisions techniques, voir `docs/PLAN.md` ; pour le
protocole réseau, `docs/protocol.md`.

## Table des matières

1. [Prise en main](#1-prise-en-main)
   - [Démarrer une partie](#démarrer-une-partie)
   - [Caméra et sélection](#caméra-et-sélection)
   - [Outils (glisser un rectangle pour les appliquer)](#outils-glisser-un-rectangle-pour-les-appliquer)
   - [Pause, vitesse et sauvegarde](#pause-vitesse-et-sauvegarde)
   - [Panneaux](#panneaux)
2. [Survie](#2-survie)
   - [Ressources et stockage](#ressources-et-stockage)
   - [Nourriture](#nourriture)
   - [Conserver les vivres](#conserver-les-vivres)
   - [Lits, sommeil et humeur](#lits-sommeil-et-humeur)
   - [Relations](#relations)
   - [Blessures et santé](#blessures-et-santé)
   - [Morts et tombes](#morts-et-tombes)
   - [Incendies](#incendies)
3. [Progrès](#3-progrès)
   - [Chasse et dépeçage](#chasse-et-dépeçage)
   - [Élevage](#élevage)
   - [Vêtements et armes](#vêtements-et-armes)
   - [Recherche](#recherche)
   - [Métal](#métal)
4. [Dangers](#4-dangers)
   - [Raids](#raids)
   - [Pièges à pointes](#pièges-à-pointes)
   - [Factions et réputation](#factions-et-réputation)
   - [Famine, froid et chaleur](#famine-froid-et-chaleur)
   - [Maladie et autres aléas](#maladie-et-autres-aléas)
5. [Commerce](#5-commerce)
   - [Marchands et troc](#marchands-et-troc)
   - [Caravanes](#caravanes-touche-v-en-colonie-du-monde-uniquement)
   - [Marchands itinérants](#marchands-itinérants)
6. [Multijoueur et monde partagé](#6-multijoueur-et-monde-partagé)
   - [Multijoueur (salle nommée)](#multijoueur-salle-nommée)
   - [Désynchronisation](#désynchronisation)
   - [Le monde partagé](#le-monde-partagé)
   - [Colonies gelées et avance rapide](#colonies-gelées-et-avance-rapide)
   - [Identité et profil local](#identité-et-profil-local)
7. [Conseils de débutant](#7-conseils-de-débutant)
8. [Limites connues](#8-limites-connues)

## 1. Prise en main

### Démarrer une partie

Un sélecteur « Difficulté » (Paisible / Facile / Normal / Difficile, défaut
Normal) précède le bouton « Partie solo » sur l'écran d'accueil : il règle la
dose de menace du storyteller pour la partie qui commence (voir §4). Une carte
de 128×128 se génère aussitôt, sans réseau : pause et vitesses de jeu
disponibles.

Le même écran d'accueil propose aussi le multijoueur (salle nommée) et le
monde partagé ; voir §6 pour la suite (rejoindre une salle, désynchronisation,
le globe, colonies gelées).

### Caméra et sélection

- Glisser droit, ou les flèches : déplacer la vue (toujours actif).
- Glisser gauche : trace un rectangle si un outil est actif, sinon déplace la
  caméra comme le clic droit.
- Molette : zoom. `Q` / `E` : rotation par pas de 90°.
- Clic gauche sur un colon : le sélectionne. Clic droit avec un colon
  sélectionné : ordre de déplacement, ou d'attaque sur un ennemi ou un animal.
- Plusieurs colons : `Maj` + clic ajoute ou retire un colon, `Maj` + glisser
  gauche trace un rectangle de sélection, `Ctrl`/`Cmd` + `A` sélectionne tous
  les colons. Clic droit : chacun part vers une case voisine distincte, ou tous
  attaquent la même cible. Le panneau indique « N colons sélectionnés ».
- `Échap` : ferme le menu Options s'il est ouvert ; sinon quitte l'outil en
  cours pour revenir à la sélection ; en sélection, désélectionne.
- Barre des colons (bas d'écran) : clic pour sélectionner un colon, double
  clic pour centrer la caméra sur lui.
- `?` ou `F1`, à tout moment : ouvre l'aide des raccourcis (bouton « ? » de la barre, `Échap` pour la refermer).

### Outils (glisser un rectangle pour les appliquer)

Ordres :

| Touche | Outil | Effet |
|---|---|---|
| S | Sélection | outil par défaut |
| C | Couper | désigne les arbres à abattre |
| M | Miner | désigne la roche à miner |
| H | Récolter | désigne les buissons ou plants mûrs à récolter (bascule en ordre de chasse si un animal est sélectionné, voir §3) |
| Z | Stockage | zone où les colons rangent les objets |
| G | Culture | zone où les colons sèment (sur herbe ou terre) |
| X | Annuler | efface désignations, zones et chantiers sur le rectangle |

Constructions (posées en plans, matériau réglé par `T`) :

| Touche | Construction | Coût |
|---|---|---|
| B | Mur | 5 (bois ou pierre) |
| P | Porte | 10 (bois ou pierre) |
| O | Sol | 3 (bois ou pierre) |
| L | Lit | 12, bois seulement |
| F | Feu | 8, bois seulement (feu de camp) |
| A | Poste | 10, bois seulement (poste de fabrication) |
| — | Établi de recherche (bouton, pas de raccourci) | 15, bois seulement |
| — | Forge (bouton, pas de raccourci) | 20, pierre seulement, demande la technologie Métallurgie (voir « Métal », §3) |
| — | Tombe (bouton, pas de raccourci) | 5, pierre seulement |
| — | Piège à pointes (bouton, pas de raccourci) | 5, bois seulement, franchissable |

`T` bascule le matériau (bois/pierre) des murs, portes et sols. Les plans
apparaissent en bleu, puis en jaune quand les matériaux livrés suffisent ; un
colon libre les construit alors.

### Pause, vitesse et sauvegarde

`Espace` : pause. `1` / `2` / `3` : vitesse ×1/×2/×3. Boutons « Sauver » /
« Charger » (une sauvegarde locale au navigateur). Indisponibles en
multijoueur : l'horloge du serveur ne s'arrête jamais et rien n'est persisté
côté client.

### Panneaux

| Touche | Panneau | Contenu |
|---|---|---|
| J | Travail | priorités de chaque colon par type de travail (Construire, Livrer, Cuisiner, Désignations, Cultiver, Ranger, Rechercher) : clic pour la priorité suivante, clic droit pour la précédente. 1 = urgent, 4 = en dernier recours, — = jamais. |
| K | Fabrication | objectif de stock (0 à 20) par arme, par vêtement et par lingot ; nécessite un poste de fabrication posé sur la carte (une forge en plus pour les lingots, voir « Métal », §3) |
| R | Recherche | choisir une des six technologies ; nécessite un établi de recherche posé sur la carte et un colon dont la priorité Rechercher est active (voir « Recherche », §3) |
| I | Chaleur | colore les cases par température |
| N | Journal | événements de la partie, filtrables (Tout / Menaces / Colonie) |
| V | Caravane | former une caravane (seulement dans une colonie du monde partagé, voir §5) |
| — | Options (bouton dans la barre, `Échap` pour fermer) | change la difficulté en cours de partie (en multi, réservé à l'hôte) ; section Graphismes : résolution, densité des props et ombres |
| — | Troc (bouton grisé sans marchand de passage, voir §5) | négocier avec le marchand présent |
| — | Factions | réputation auprès des trois factions PNJ et tribut (voir « Factions et réputation », §4) |
| — | Mini-carte (coin bas droit, bouton « − » pour la replier) | vue d'ensemble de la carte 128×128 : colons, bêtes, pillards, marchand et cases en feu en pastilles colorées, rectangle blanc pour la vue caméra ; clic ou glisser dessus pour s'y déplacer |

Les réglages Graphismes sont mémorisés dans le navigateur : résolution et
densité des props s'appliquent aussitôt, les ombres seulement au prochain
chargement (le panneau le rappelle) ; « Réinitialiser » revient au défaut.

Un toast ou une ligne du Journal repérée d'un ⌖ se clique pour recentrer la
caméra sur l'événement (un raid mène au premier pillard, un incendie à la
première case en feu) et sélectionner le colon concerné s'il y en a un.

Le panneau d'un colon sélectionné montre son travail en cours, son arme et son
habit, la température ressentie, ses besoins (PV, faim, repos, humeur), sa
santé (sang, conscience, blessures détaillées, heures de maladie restantes
s'il y a lieu) et ses compétences. Chaque colon a aussi jusqu'à deux traits de
caractère visibles dans son panneau (infobulle à l'appui), qui modulent son
travail, son humeur et son combat.

## 2. Survie

### Ressources et stockage

Bois (arbres coupés) et pierre (roche minée) sont les matériaux de base. Une
zone de stockage (`Z`) laisse les colons y ranger tout ce qui traîne au sol ;
une pile atteint 75 unités avant d'en former une autre. Poser le stockage près
d'une désignation raccourcit les trajets.

Le HUD affiche aussi la **richesse** de la colonie (piles, constructions et
colons confondus) à la suite du stock : c'est elle, avec le nombre de colons
et le temps écoulé, qui décide de la taille des raids (voir §4).

### Nourriture

Buissons sauvages (récolte par `H`) et cultures semées en zone de culture
(`G`, sur herbe ou terre) donnent des baies et des légumes ; un plant mûrit en
un jour et demi de jeu (six minutes réelles), puis se resème seul. Au feu de
camp, un colon cuisine cinq unités de nourriture crue en un repas, tant que la
colonie a moins de dix repas en réserve — la nourriture crue se gâte, les
repas cuisinés aussi mais plus vite (baies : trois jours ; légumes : quatre
jours ; repas : deux jours). Ordre de préférence d'un colon affamé : repas
cuisiné, puis baies, puis légumes crus, puis viande crue en dernier recours.
Un repas cuisiné remonte l'humeur, un cru ou une viande crue la fait baisser.

### Conserver les vivres

La vitesse de péremption d'une pile dépend de la température de la case où
elle repose : normale au-dessus de 15 °C, deux fois plus lente de 5 à 15 °C,
quatre fois plus lente de 0 à 5 °C, à l'arrêt complet sous 0 °C. Une pièce
fermée et fraîche, ou tout simplement l'hiver, ralentit donc la péremption
sans rien faire de plus ; le gel l'arrête net. Le HUD affiche, à côté de
chaque genre entamé, une pastille de fraîcheur (« · 72 % » : verte au-dessus
de 50 %, orange de 20 à 50, rouge en dessous) reprenant la pile la plus
proche de se perdre ; en dessous de 20 %, un message discret prévient que des
vivres vont se perdre.

### Lits, sommeil et humeur

Un colon fatigué dort sur place ou, mieux, dans un lit libre (bonus
d'humeur ; dormir au sol en donne un malus). L'humeur descend sous l'effet de
la faim, de la fatigue, du froid, de l'orage, d'un mauvais repas, d'une
blessure ou de la maladie ; en dessous de 20 %, un colon craque et erre une
fraction de journée avant un jour de soulagement. Au-dessus de 70 %, il
travaille 20 % plus vite ; en dessous de 40 %, 20 % plus lentement. Le
panneau Travail (`J`) permet de réserver certains colons à certaines tâches
plutôt que de les laisser tous égaux face à toutes les priorités.

### Relations

Deux colons désœuvrés et à deux cases l'un de l'autre au plus s'arrêtent pour
bavarder (un travail à part entière : « bavarde » dans son panneau et la
barre des colons, essayé seulement quand rien d'autre ne presse). La
conversation dure une minute et demie de jeu, remonte l'avis de chacun sur
l'autre et redonne un peu d'humeur pour la journée. Une fois sur huit environ
(une sur quatre si l'un des deux est bagarreur) elle tourne à la dispute :
l'avis baisse au lieu de monter, et l'humeur avec, pour la journée ; entre
deux colons qui s'apprécient déjà très peu, la dispute dégénère en rixe (une
bourrade chacun, jamais mortelle). Un ami (avis très bon, deux au plus
comptés) remonte durablement l'humeur de la colonie ; un rival (avis très
mauvais) la fait baisser d'autant ; perdre un ami double le deuil habituel.
Les avis d'un colon se lisent dans la section « Relations » de son panneau :
le nom de l'autre, l'avis chiffré et son qualificatif (ami, apprécié, toléré,
mal vu, rival), triés du plus apprécié au moins apprécié — « Ne connaît
personne encore » tant qu'il n'a parlé à personne.

### Blessures et santé

Un coup touche une partie du corps au hasard (torse et bras plus souvent que
tête ou jambes) et peut faire saigner : une plaie non pansée se referme
seule en quatre heures de jeu, sinon un camarade peut la panser. Le sang
perdu remonte lentement de lui-même. Sous 30 % de sang ou de conscience, un
colon s'écroule (« à terre ») : il ne fait plus rien, les pillards l'ignorent,
et un camarade peut le porter jusqu'à un lit puis le soigner. Une blessure
grave à la tête ou au torse, ou une perte de sang totale, est mortelle. Un
mort laisse un cadavre (se décompose en trois jours) et un deuil de deux
jours pèse sur le moral de la colonie.

### Morts et tombes

Un cadavre laissé au sol démoralise toute la colonie tant qu'il traîne, pas
seulement le jour de la mort. Construire une tombe (bouton dédié de la barre
d'outils, 5 pierre, une case) répare cela : un colon libre s'en charge de
lui-même, sans ordre à donner, dès qu'une tombe vide et un chemin jusqu'au
corps existent. L'inhumation apaise le deuil de la colonie. Les dépouilles
animales, elles, ne s'enterrent pas : elles se dépècent au poste de
fabrication (voir « Chasse et dépeçage », §3) pour leur viande et leur cuir.

### Incendies

Deux départs de feu : la foudre, qui peut tomber sur une case pendant un
orage, et un feu de camp allumé par temps chaud et sec qui embrase l'herbe
alentour. Le feu se propage aux arbres, buissons, plants, constructions en
bois et piles inflammables (tout sauf la pierre) ; il gagne case par case
tant qu'il trouve du combustible. La pluie l'éteint d'elle-même, orage
compris — un incendie qui dure ne survit donc en général qu'au sec. Le HUD
affiche en rouge « Feu : N case(s) » tant qu'il en reste une seule allumée,
et le Journal note le départ de feu puis son extinction (nombre de cases
brûlées).

Les colons libres à moins de vingt-cinq cases d'un feu vont le combattre
d'eux-mêmes (« combat le feu » dans leur panneau) ; tout le monde d'autre
part le contourne en se déplaçant, comme un obstacle. Rien à ordonner : dès
qu'il n'y a plus de combustible à portée ou que la pluie s'en charge, le feu
s'éteint tout seul.

Conseils : ne pas planter de feu de camp au milieu des herbes hautes, un feu
de camp isolé sur du sol nu ou une dalle ne peut rien embraser autour de lui.
Des murs en pierre coupent la propagation (la pierre ne brûle jamais) ; une
réserve de vivres et de bois vaut mieux à l'abri dans une pièce aux murs de
pierre, plutôt qu'entassée en plein air près d'un feu de camp en bois.

## 3. Progrès

### Chasse et dépeçage

Sélectionner un animal (cerf, lapin, sanglier) puis touche `H`, ou clic droit
avec un colon armé sélectionné, le marque comme gibier. Seul un colon armé
chasse ; le sanglier riposte s'il est blessé. Une dépouille rapportée au poste
de fabrication est dépecée en viande et en cuir, selon l'espèce.

### Élevage

Sélectionner un animal sauvage puis le bouton Apprivoiser de son panneau (pas
de raccourci clavier : `A` est déjà pris par le poste de fabrication) le
marque pour l'apprivoisement, exclusif de la chasse — marquer l'un retire
l'autre. Un colon libre apporte alors 5 baies ou légumes du stockage et tente
sa chance : environ un quart de succès en moyenne, plus facile sur un lapin,
moyen sur un cerf, difficile sur un sanglier (qui peut charger en cas
d'échec) ; un essai raté n'est pas définitif, un colon retente plus tard tant
que la bête reste marquée et le stock fourni.

Apprivoisée, la bête rejoint la colonie (« *Espèce* de la colonie » dans son
panneau, un collier de la couleur de la colonie sur son dessin) : elle reste
à proximité du foyer, paît l'herbe alentour ou, à défaut, puise dans le
stockage de vivres — sans pâture ni réserve à portée, elle maigrit puis
meurt. Gardez de l'herbe non rasée près de la colonie plutôt que de tout
couper autour d'elle. Deux bêtes de la même espèce se reproduisent d'elles-
mêmes au bout de quelques jours (le lapin fait vite des petits, le sanglier
prend son temps), jusqu'à douze têtes par espèce ; au-delà, plus de naissance
tant que le troupeau n'a pas baissé. Le sanglier apprivoisé, en plus, défend
la colonie comme un colon face à un ennemi proche.

Le bouton Abattre du panneau d'une bête de la colonie la marque pour
l'abattoir : un colon la rejoint et l'abat, sa dépouille se dépèce ensuite au
poste de fabrication comme celle d'une bête chassée. Le marquage est
irréversible (le bouton se grise une fois posé). Le HUD affiche « Bétail :
N » tant que la colonie compte au moins une bête.

### Vêtements et armes

Le poste de fabrication (touche `A`) produit, sur objectif réglé au panneau
Fabrication : gourdin (8 bois), épieu (6 bois, 4 pierre), arc (12 bois),
tunique (6 cuir, +6 °C ressentis) et manteau (12 cuir, +15 °C). Un colon
s'équipe automatiquement de la meilleure arme et du meilleur habit
disponibles en stock ; sous 6 °C de température ambiante, il va chercher un
vêtement de lui-même. L'épée, la meilleure arme de mêlée, demande la
métallurgie et une forge : voir « Métal » ci-dessous.

### Recherche

L'établi de recherche (bouton dédié de la barre d'outils, 15 bois, une case)
laisse un colon dont la priorité Rechercher est active faire avancer, par
séances, la technologie choisie au panneau Recherche (touche `R`). Les cinq
premières technologies ne verrouillent rien : chacune n'apporte qu'un bonus
une fois acquise, jamais une condition pour construire ou fabriquer quoi que
ce soit. La sixième, Métallurgie, fait exception : sans elle, la forge est
refusée (voir « Métal » ci-dessous, la seule chose que la recherche interdise).

| Technologie | Coût | Effet |
|---|---|---|
| Agriculture | 2 000 | cultures : rendement +25 % |
| Médecine | 2 500 | soins et cicatrisation des pansements 50 % plus vite |
| Conservation | 2 500 | péremption des vivres divisée par deux |
| Archerie | 3 000 | portée de tir 10 cases, dégâts +25 % |
| Maçonnerie | 3 000 | bâtir en pierre 25 % plus vite |
| Métallurgie | 3 500 | débloque la forge (voir « Métal » ci-dessous) |

Une seule technologie avance à la fois ; le bouton « Arrêter » du panneau
libère le colon pour autre chose sans perdre l'avancement déjà fait. Le HUD
affiche la technologie en cours et son pourcentage tant qu'une recherche est
lancée, et une notification annonce chaque technologie acquise.

### Métal

Un rocher sur huit environ est un rocher veiné (teinte cuivrée sur la
mini-carte, distincte du rocher gris ordinaire) : le miner (`M`) donne du
minerai en plus de la pierre habituelle. Le minerai ne sert à rien tel quel,
il se fond à la forge.

La forge (bouton dédié de la barre d'outils, 20 pierre, une case) est
grisée, infobulle à l'appui, tant que la technologie Métallurgie n'est pas
acquise (voir « Recherche » ci-dessus) : y poser un plan échoue sinon en
silence. Une fois bâtie, un colon y fond trois minerais en un lingot, sur
objectif réglé au panneau Fabrication (« Lingots », comme une arme). Au
poste de fabrication, quatre lingots donnent ensuite une épée — la meilleure
arme de mêlée du jeu, devant l'épieu et l'arc, mais la plus chère à produire.

## 4. Dangers

### Raids

Trois jours de tranquillité (douze minutes réelles) avant la première bande
de pillards ; ensuite un raid tous les deux à quatre jours. Sa taille et son
équipement dépendent de la colonie (nombre de colons, richesse accumulée,
temps écoulé) : plus la colonie prospère, plus les bandes grossissent et
s'arment. Une bande charge directement, ou arrive à moitié à l'arc, ou encore
s'installe un moment près de son point d'entrée avant de charger (le temps de
fermer une porte) — un toast et une entrée de Journal (« Raid en approche »)
l'annoncent dès qu'elle apparaît sur la carte, avant qu'elle ne charge. Un
pillard décroche et fuit sous 65 % de PV. Les colons se défendent seuls contre
un ennemi à moins de huit cases ; un clic droit sur un ennemi, avec un colon
sélectionné, ordonne l'attaque. Un tireur à l'arc porte à huit cases, à
condition d'une ligne de vue dégagée (murs, portes et rochers bloquent).

Le menu Options (§1) règle la dose de menace du storyteller : Paisible
supprime les raids (le reste de la vie de la colonie continue sans eux),
Facile et Difficile resserrent ou espacent le délai entre deux bandes et leur
budget autour des valeurs ci-dessus, Normal est la référence. Choisie à
l'accueil ou dans le lobby avant de démarrer, modifiable ensuite à tout
moment par ce même menu (réservé à l'hôte en multijoueur).

### Pièges à pointes

Un piège à pointes (bouton dédié de la barre d'outils, 5 bois, une case,
franchissable) blesse à la jambe le premier pillard, marchand hostile ou bête
qui marche dessus — les colons de la colonie le connaissent et le contournent
d'instinct, jamais les intrus. À poser à l'entrée de l'enceinte plutôt qu'au
hasard, en ligne d'au moins trois plutôt qu'isolé : franchissable, un piège
seul se traverse comme n'importe quelle case, mais une ligne barrant l'unique
passage force l'assaillant à en déclencher un avant d'atteindre les colons.
Une fois déclenché, il ne blesse plus personne tant qu'un colon libre ne l'a
pas réarmé (une tâche rapide, sans bois à fournir) ; le Journal note chaque
déclenchement (« … s'est pris dans un piège »). Une bête prise au piège
pendant une battue de chasse s'ajoute sans effort à la journée. Un piège armé
pèse un peu dans la richesse de la colonie, comme toute autre construction.

### Factions et réputation

Trois factions PNJ fixes, jamais créées ni détruites : le Clan des Cendres et
la Fraternité du Fer (deux bandes de pillards distinctes), et la Guilde des
Colporteurs (qui envoie les marchands). Chacune garde une réputation propre,
de −100 à 100, affichée par le bouton Factions de la barre d'outils : hostile
sous −50, alliée à partir de +50, méfiante entre les deux. Les deux tribus
commencent méfiantes, la Guilde a entendu parler de la colonie en bien.

Ce qui la fait monter ou descendre :

- une bande qui entre dans la colonie coûte de la réputation à la tribu qui
  la mène (l'attaque se paie) ; la repousser entièrement (tous ses pillards
  morts ou repartis) en rapporte à la Guilde, qui y voit une place forte, et
  un peu à l'autre tribu, ravie du sort de sa rivale ;
- un troc conclu avec un marchand rapporte un peu à la Guilde ; frapper un
  marchand lui coûte cher, le tuer plus encore, et referme la porte à de
  nouvelles visites (voir « Marchands et troc », §5) ;
- le temps adoucit d'un point par jour toute rancune (jamais l'inverse) ;
- un tribut volontaire (bouton Offrir du panneau Factions) rapporte à
  proportion de sa valeur.

Une tribu alliée ne mène plus aucun raid ; une tribu qui bascule sous le seuil
hostile prépare des représailles (son prochain raid arrive plus tôt). La
Guilde alliée vend moins cher (110 % de la valeur du genre, contre 120 %
d'ordinaire) ; hostile, elle n'envoie plus personne. Le Journal note chaque
raid repoussé, chaque tribut offert et chaque changement de palier
(« méfiant » ↔ « hostile » ou « allié »), et l'annonce d'un raid en approche
nomme désormais la tribu qui le mène.

Offrir un tribut prélève en stockage : dans le panneau Factions, sous chaque
faction, choisir un genre disponible et une quantité fait apparaître un
aperçu (« ≈ +N de réputation ») avant de cliquer Offrir, grisé si le stock ne
suit pas. La quantité qui compte est sa valeur, pas le nombre de piles : un
manteau de cuir vaut nettement plus que le même poids de bois.

Sur le monde partagé, la réputation est celle du joueur : elle vous suit
d'une colonie à l'autre, jamais figée sur la case où elle a été gagnée ou
perdue.

### Famine, froid et chaleur

Un colon qui ne mange plus meurt en deux jours environ. Sous 5 °C ressentis,
l'humeur baisse ; sous −5 °C, le froid blesse directement (le froid empêche
aussi toute cicatrisation en dessous de ce seuil) — un vêtement chaud
remonte le ressenti. Au-dessus de 32 °C, l'humeur baisse aussi ; il n'y a pas
encore de gestion active de la chaleur (pas de retrait de vêtement, pas de
toits). Un plant gèle et peut mourir sous −5 °C, cesse de pousser sous 0 °C.

### Maladie et autres aléas

Un colon peut tomber malade (tous les six à onze jours), ce qui le ralentit
nettement et pèse sur son moral pendant deux jours, ou un seul si un
camarade vient le veiller — le même geste que panser une plaie. Un toast et
une entrée de Journal l'annoncent, et un point vert apparaît sur sa pastille
dans la barre des colons ; son panneau affiche « Malade : encore N h » tant
que ça dure. Des vivres tombent aussi près de la colonie de temps à autre
(toast « Un largage de N pile(s)… »), et une vague de froid ou de chaleur
peut durer une journée (toast « Coup de froid » ou « Canicule », avec
l'écart de température) — ces deux-là continuent quelle que soit la
difficulté choisie, seuls les raids en dépendent (voir plus haut).

## 5. Commerce

### Marchands et troc

Un marchand arrive tous les quatre à sept jours de jeu, s'installe un jour
près d'un étal improvisé puis reprend la route ; dès qu'il est là, le HUD
affiche son nom suivi de « repart dans N h ». Il est neutre : ne pas
l'attaquer, sinon il se défend et les visites suivantes s'espacent
davantage. Le cliquer le sélectionne comme un colon (bouton Troc dans son
panneau), ou le bouton Troc de la barre d'outils, actif seulement pendant sa
visite, ouvre le panneau : à gauche ce qu'il vend (genre, quantité, prix
unitaire), à droite ce que la colonie a en stockage. Pas de monnaie : le
troc se juge en valeur, la colonie devant céder au moins autant qu'elle
demande (prix d'achat du genre cédé × quantité, comparé au prix de vente du
genre pris × quantité) ; en dessous, le bouton Proposer reste grisé et le
motif du refus s'affiche. Les marchandises reçues sont déposées au sol près
de l'étal, à ranger comme n'importe quel butin.

### Caravanes (touche `V`, en colonie du monde uniquement)

Le panneau Caravane propose les colons de la colonie (un colon à terre ne
part pas), les marchandises en stock, et un bouton pour choisir la
destination sur le globe (durée et itinéraire prévisualisés). Seul l'hôte de
la salle peut expédier ou confirmer une arrivée. Une caravane en vol peut
faire demi-tour tant qu'elle n'a pas dépassé la moitié du trajet ; passé ce
point, seule l'arrivée reste possible. Arrivée sur une case libre, elle y
fonde une nouvelle colonie au nom de son expéditeur ; arrivée sur une
colonie fermée, elle patiente jusqu'à ce que quelqu'un l'ouvre.

### Marchands itinérants

Des compagnies marchandes PNJ circulent en permanence de colonie en colonie
sur le globe, indépendamment de tout joueur : elles se voient sur le globe
(chariot ocre, distinct des caravanes des joueurs), avec leur nom et leur
destination au survol ou au clic. À leur arrivée, le marchand entre
directement dans la colonie visitée et s'installe à l'étal, exactement comme
un marchand fait venir par le storyteller local — même si personne ne jouait
cette colonie à cet instant : les passages manqués sont livrés à la
prochaine ouverture, trois au plus, les arrivées suivantes étant perdues au-delà.

## 6. Multijoueur et monde partagé

### Multijoueur (salle nommée)

Sur l'accueil : un serveur (`ws://…`), un nom, une salle, bouton « Rejoindre ».
Ou directement par URL, pratique pour ouvrir deux onglets :

```
http://localhost:5173/?server=ws://localhost:8787&room=demo&name=alice
```

Le premier arrivé dans la salle est l'**hôte** : lui seul choisit la graine et
la difficulté (à côté de la graine, même sélecteur qu'en solo) puis clique
« Démarrer ». Une fois la partie lancée, chacun voit les actions des autres ;
il n'y a plus ni pause ni choix de vitesse, l'horloge du serveur ne s'arrête
jamais.

### Désynchronisation

Le HUD affiche le hash de la partie à côté d'une petite pastille — verte tant
que votre copie concorde avec celle de la majorité, rouge si vous êtes
signalé comme déviant. Dès que trois joueurs ou plus sont réunis, le serveur
compare les hashes annoncés par chacun toutes les 300 ticks (§7 du
protocole) : si une majorité se dégage, les copies minoritaires sont
réparées **automatiquement** depuis l'état de l'hôte, sans rien à faire. Un
bandeau apparaît le temps de la réparation, nommant les joueurs déviants
(« vous » si c'est votre propre copie), avec un bouton **Resynchroniser** pour
la déclencher soi-même sans attendre le
prochain point de contrôle (utile si on soupçonne sa propre copie sans
attendre que le serveur la désigne). Le bandeau disparaît de lui-même dès que
tout le monde concorde de nouveau, avec un toast « Resynchronisé au tick N ».
À deux joueurs, il n'y a jamais de majorité possible : le bouton reste le
seul recours, en pariant sur l'un des deux.

Un cas ne se répare jamais tout seul : si c'est l'**hôte** qui diverge, le
bandeau l'indique (« L'hôte est en désaccord avec la majorité : la partie ne
peut pas être réparée automatiquement ») sans bouton, parce que tout
rattrapage part justement de l'état de l'hôte — personne ne peut le corriger
depuis lui-même. La seule issue est de quitter la salle et de la rouvrir.

### Le monde partagé

Bouton « Monde partagé » (ou `?server=…&name=…&world=1`) sur l'écran
d'accueil. Le globe se télécharge une fois puis s'affiche : il ne se
régénère jamais côté client, il vient du serveur, une fois pour toutes.
Chaque case terrestre est une carte de colonie possible, avec son biome et
son climat propres (température et amplitude saisonnière dérivées de la
latitude).

Survoler et cliquer une case terrestre propose « S'installer ici » (case
libre) ou « Visiter » / « Reprendre ma colonie » (case déjà occupée).
S'installer fonde une colonie ; visiter entre dans celle d'un autre joueur
sans rien y changer d'office. Dans les deux cas, ça ouvre la salle de cette
case exactement comme une salle nommée, avec une graine imposée par le
serveur. Voir §5 pour les caravanes ; ci-dessous pour les colonies gelées.
Votre réputation envers les factions PNJ (§4) suit le joueur, pas la case :
fonder ou rouvrir une autre colonie du même globe la retrouve telle quelle.

### Colonies gelées et avance rapide

Une colonie sans personne dessus ne tourne plus : à la réouverture, elle
rattrape le temps passé par des formules (pousse des cultures, péremption,
cicatrisation…), plafonnées à soixante jours d'absence. Un message annonce
le nombre de jours écoulés pendant l'absence.

### Identité et profil local

Pas de compte : le serveur remet un jeton au premier contact, gardé par le
navigateur pour ce serveur et ce nom. Deux onglets du même navigateur avec
deux noms différents sont deux joueurs distincts ; un jeton perdu (stockage
effacé) est une identité perdue, sans recours simple.

## 7. Conseils de débutant

- Poser le stockage à proximité des arbres et de la roche à exploiter :
  chaque trajet en moins compte.
- Fabriquer un arc avant le premier raid (trois jours de répit) : un tireur
  change beaucoup l'issue d'un premier affrontement.
- Un feu de camp avant l'hiver, pas seulement pour cuisiner : la chaleur des
  feux réchauffe la pièce qui les contient.
- Garder un matelas de repas cuisinés (dix en stock) plutôt que de ne
  cuisiner qu'à la dernière minute : la péremption ne pardonne pas.
- Ne pas laisser un colon blessé sans surveillance : une plaie qui saigne se
  referme seule en quatre heures de jeu, mais un camarade peut la panser
  bien plus vite.
- Surveiller l'humeur autant que la faim : un colon qui craque abandonne son
  poste au pire moment.
- En monde partagé, vérifier la route (durée, biomes traversés) avant
  d'envoyer une caravane : l'itinéraire prévisualisé est indicatif, mais le
  demi-tour n'est plus possible passé la moitié du trajet.

## 8. Limites connues

- Pas de toits : la chaleur ne se gère pas encore (voir « Famine, froid et
  chaleur », §4).
- Pas de nouveau matériau de construction : bois et pierre restent les deux
  seuls choix pour murs, portes et sols ; le métal (minerai, lingot, épée,
  voir « Métal », §3) est une chaîne de fabrication à part, pas un matériau
  de bâtiment.
- Pas de compte joueur : identité par jeton local uniquement, sans
  recouvrement en cas de perte (voir « Identité et profil local », §6).
- Réputation locale à la colonie : chaque colonie du monde partagé tient sa
  propre réputation auprès des trois factions, sans lien avec les autres
  colonies, même celles du même joueur.
- Pas d'orientation des colons à l'écran : une position, jamais un sens de
  déplacement figuré.
- Pas de mods ni d'extensions : aucun contenu tiers ne se charge.
