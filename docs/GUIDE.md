# Guide du joueur

Ce guide décrit ce que le jeu fait aujourd'hui, du point de vue de qui joue.
Pour l'architecture et les décisions techniques, voir `docs/PLAN.md` ; pour le
protocole réseau, `docs/protocol.md`.

## 1. Démarrer

### Partie solo

Un sélecteur « Difficulté » (Paisible / Facile / Normal / Difficile, défaut
Normal) précède le bouton « Partie solo » sur l'écran d'accueil : il règle la
dose de menace du storyteller pour la partie qui commence (voir §4). Une carte
de 128×128 se génère aussitôt, sans réseau : pause et vitesses de jeu
disponibles.

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
jamais. Un bandeau signale une désynchronisation éventuelle, avec un bouton
« Resynchroniser ».

### Monde partagé

Bouton « Monde partagé » (ou `?server=…&name=…&world=1`). Le globe se
télécharge une fois puis s'affiche : survoler et cliquer une case terrestre
propose « S'installer ici » (case libre) ou « Visiter » / « Reprendre ma
colonie » (case déjà occupée). S'installer ou visiter ouvre la salle de cette
case exactement comme une salle nommée, avec une graine imposée par le
serveur. Voir §5 pour la suite (caravanes, colonies gelées).

## 2. Contrôles

### Caméra et sélection

- Glisser droit, ou les flèches : déplacer la vue (toujours actif).
- Glisser gauche : trace un rectangle si un outil est actif, sinon déplace la
  caméra comme le clic droit.
- Molette : zoom. `Q` / `E` : rotation par pas de 90°.
- Clic gauche sur un colon : le sélectionne. Clic droit avec un colon
  sélectionné : ordre de déplacement, ou d'attaque sur un ennemi ou un animal.
- `Échap` : ferme le menu Options s'il est ouvert ; sinon quitte l'outil en
  cours pour revenir à la sélection ; en sélection, désélectionne.
- Barre des colons (bas d'écran) : clic pour sélectionner un colon, double
  clic pour centrer la caméra sur lui.

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
| F | Feu de camp | 8, bois seulement |
| A | Poste de fabrication | 10, bois seulement |

`T` bascule le matériau (bois/pierre) des murs, portes et sols. Les plans
apparaissent en bleu, puis en jaune quand les matériaux livrés suffisent ; un
colon libre les construit alors.

### Pause, vitesse et sauvegarde (solo seulement)

`Espace` : pause. `1` / `2` / `3` : vitesse ×1/×2/×3. Boutons « Sauver » /
« Charger » (une sauvegarde locale au navigateur). Indisponibles en
multijoueur : l'horloge du serveur ne s'arrête jamais et rien n'est persisté
côté client.

### Panneaux

| Touche | Panneau | Contenu |
|---|---|---|
| J | Travail | priorités de chaque colon par type de travail (Construire, Livrer, Cuisiner, Désignations, Cultiver, Ranger) : clic pour la priorité suivante, clic droit pour la précédente. 1 = urgent, 4 = en dernier recours, — = jamais. |
| K | Fabrication | objectif de stock (0 à 20) par arme et par vêtement ; nécessite un poste de fabrication posé sur la carte |
| I | Chaleur | colore les cases par température |
| N | Journal | événements de la partie, filtrables (Tout / Menaces / Colonie) |
| V | Caravane | former une caravane (seulement dans une colonie du monde partagé, voir §5) |
| — | Options (bouton dans la barre, `Échap` pour fermer) | change la difficulté en cours de partie ; en multi, réservé à l'hôte |
| — | Troc (bouton grisé sans marchand de passage, voir §3) | négocier avec le marchand présent |

Le panneau d'un colon sélectionné montre son travail en cours, son arme et son
habit, la température ressentie, ses besoins (PV, faim, repos, humeur), sa
santé (sang, conscience, blessures détaillées, heures de maladie restantes
s'il y a lieu) et ses compétences. Chaque colon a aussi jusqu'à deux traits de
caractère visibles dans son panneau (infobulle à l'appui), qui modulent son
travail, son humeur et son combat.

## 3. Boucle de survie

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

### Chasse et dépeçage

Sélectionner un animal (cerf, lapin, sanglier) puis touche `H`, ou clic droit
avec un colon armé sélectionné, le marque comme gibier. Seul un colon armé
chasse ; le sanglier riposte s'il est blessé. Une dépouille rapportée au poste
de fabrication est dépecée en viande et en cuir, selon l'espèce.

### Vêtements et armes

Le poste de fabrication (touche `A`) produit, sur objectif réglé au panneau
Fabrication : gourdin (8 bois), épieu (6 bois, 4 pierre), arc (12 bois),
tunique (6 cuir, +6 °C ressentis) et manteau (12 cuir, +15 °C). Un colon
s'équipe automatiquement de la meilleure arme et du meilleur habit
disponibles en stock ; sous 6 °C de température ambiante, il va chercher un
vêtement de lui-même.

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

### Lits, sommeil et humeur

Un colon fatigué dort sur place ou, mieux, dans un lit libre (bonus
d'humeur ; dormir au sol en donne un malus). L'humeur descend sous l'effet de
la faim, de la fatigue, du froid, de l'orage, d'un mauvais repas, d'une
blessure ou de la maladie ; en dessous de 20 %, un colon craque et erre une
fraction de journée avant un jour de soulagement. Au-dessus de 70 %, il
travaille 20 % plus vite ; en dessous de 40 %, 20 % plus lentement. Le
panneau Travail (`J`) permet de réserver certains colons à certaines tâches
plutôt que de les laisser tous égaux face à toutes les priorités.

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

Le menu Options (§2) règle la dose de menace du storyteller : Paisible
supprime les raids (le reste de la vie de la colonie continue sans eux),
Facile et Difficile resserrent ou espacent le délai entre deux bandes et leur
budget autour des valeurs ci-dessus, Normal est la référence. Choisie à
l'accueil ou dans le lobby avant de démarrer, modifiable ensuite à tout
moment par ce même menu (réservé à l'hôte en multijoueur).

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

## 5. Le monde

### Le globe

Chaque case du globe partagé est une carte de colonie possible, avec son
biome et son climat propres (température et amplitude saisonnière dérivées
de la latitude). S'installer fonde une colonie ; visiter entre dans celle
d'un autre joueur sans rien y changer d'office. Le globe ne se régénère
jamais côté client : il vient du serveur, une fois pour toutes.

### Caravanes (touche `V`, en colonie du monde uniquement)

Le panneau Caravane propose les colons de la colonie (un colon à terre ne
part pas), les marchandises en stock, et un bouton pour choisir la
destination sur le globe (durée et itinéraire prévisualisés). Seul l'hôte de
la salle peut expédier ou confirmer une arrivée. Une caravane en vol peut
faire demi-tour tant qu'elle n'a pas dépassé la moitié du trajet ; passé ce
point, seule l'arrivée reste possible. Arrivée sur une case libre, elle y
fonde une nouvelle colonie au nom de son expéditeur ; arrivée sur une
colonie fermée, elle patiente jusqu'à ce que quelqu'un l'ouvre.

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

## 6. Conseils de débutant

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

## 7. Limites connues

Pas encore de recherche ni de relations entre colons ; pas de toits (tout le
monde est dehors sous l'orage, la chaleur ne se gère pas encore) ; pas de
compte joueur (identité par jeton local uniquement, sans recouvrement en cas
de perte).
