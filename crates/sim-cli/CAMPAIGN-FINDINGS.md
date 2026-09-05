# Campagnes d'équilibrage — constatations

Mesures produites par `cargo run -p sim-cli --release -- campaign`
(`crates/sim-cli/src/campaign.rs`), le 2026-09-05, sur la révision de travail de
la phase 2c.

**Ce document mesure, il ne règle rien.** Aucune constante du sim n'a été
touchée pour l'écrire. Chaque constat porte une proposition chiffrée, à
éprouver par un test statistique sur plusieurs graines avant d'être appliquée
(règle « on mesure avant de régler », `AGENTS.md`).

## Les cinq constats, en une ligne chacun

1. **Rangement** — dès qu'un entrepôt est plein, chaque colon relance un
   balayage complet de la carte **par pile au sol et par tick** : 1 870 fois
   plus lent à 60 piles. Défaut du sim, pas réglage. (§3)
2. **Difficulté** — « difficile » éteint **30 colonies sur 30**, 25 avant le
   jour 10 : le premier raid y fait trois pillards armés contre trois colons
   qui n'ont pas encore d'arme. (§4)
3. **Menace** — une bande vaut 1,9 pillard au premier raid comme au neuvième :
   tripler sa richesse ne change la taille des raids que de 3 %. (§5)
4. **Feu** — médiane 3 cases brûlées, maximum 2 339 sur une carte qui en compte
   4 096, et exactement une case par départ dès qu'il fait froid. (§6)
5. **Soins** — pour deux colons tués au combat, un troisième meurt de ses
   plaies après, faute de débit de pansement. Rapport stable à 0,5. (§7)

---

## 1. La méthode

### Le joueur scripté

`campaign::plan` est une fonction **pure** de la `Sim` vers une liste de
`Command`, appelée toutes les `PLAN_INTERVAL` (600) ticks — dix secondes de jeu.
Elle n'a aucune mémoire : « le feu de camp est-il déjà bâti ? » se relit dans la
carte, ce qui la rend idempotente, testable et déterministe. Ce qu'elle fait,
dans cet ordre :

| Étape | Déclencheur | Ce qui part |
|---|---|---|
| Zones | une seule fois | stockage 4×4, culture 5×5 |
| Coupe | tant que `bois < 100` | rectangle 21×21 autour du repère |
| Récolte | un passage sur dix | rectangle 51×51 |
| Priorités | une seule fois | un cultivateur, un bâtisseur (priorité 1) |
| Confort | `bois ≥ 40` | feu de camp, un lit par colon, poste de fabrication |
| Enceinte | `bois ≥ 100` | porte **puis** l'enceinte de bois (48 cases de pourtour), puis 3 pièges devant la porte |
| Recherche | jour 5, `bois ≥ 40` | établi, puis agriculture puis médecine |
| Fabrication | permanent | un arc par colon ; une tunique par colon en automne |
| Chasse | `viande + repas < 10 × colons` | une bête à la fois, la plus proche **atteignable** |
| Élevage | jour 8, `baies ≥ 30` | un lapin à apprivoiser |
| Troc | marchand présent et `vivres < 3 jours` | achat du comestible le plus nourrissant, payé en bois ou en cuir |
| Tribut | `réputation < −40` et `bois ≥ 80` | 40 bois à la tribu fâchée |

### Le harnais

`play_seed` observe les colons **à chaque tick** : le sim ne garde aucune trace
de la cause d'une mort (`EventKind::ColonistDied` ne porte que l'id), elle est
donc déduite du dernier état observé au tick d'avant la disparition — feu sous
les pieds, ventre vide, ennemi debout et blessure, froid, maladie, plaies sans
ennemi, rixe. La colonne `?` du tableau compte les morts qu'aucun de ces états
n'explique : **elle est restée à 0 sur les 150 colonies mesurées**, la déduction
n'invente donc rien. Le journal d'événements du sim est borné à 32 entrées et
vidé tous les 60 ticks : `lost_events` est resté à 0, et le total des morts
déduites égale exactement le total annoncé par le sim.

### Réglage des campagnes

Cinq campagnes, **30 graines × 30 jours** chacune, carte **64×64** :

| Campagne | Options | Durée réelle |
|---|---|---|
| Normale | `--seeds 30 --days 30 --size 64 --difficulty 2` | 29 min |
| Difficile | `--seeds 30 --days 30 --size 64 --difficulty 3` | 4 min |
| Froide (−5 °C) | `… --difficulty 2 --climate -50` | 43 min |
| Chaude (+30 °C) | `… --difficulty 2 --climate 300` | 16 min |
| Automne-hiver | `… --difficulty 2 --day-of-year 30` | 27 min |

Les cinq ont tourné **en même temps**, sur une machine à huit cœurs : les durées
ci-dessus, comme la colonne `ms` des tableaux détaillés, sont donc contendues.
Elles servent à comparer des campagnes et des graines entre elles, jamais comme
référence absolue — celle du constat n°1 vient d'une mesure isolée.

La cinquième existe parce que l'année de jeu fait `climate::YEAR_DAYS` = 60
jours, quatre saisons de quinze : **une campagne de trente jours partie du jour
0 ne voit que le printemps et l'été.** Sans elle, ni le premier gel, ni les
tuniques d'automne, ni la conservation des vivres par le froid ne seraient
jamais mesurés. `--day-of-year` a été ajouté à `campaign` pour cette tranche ;
il émet `Command::SetCalendar` juste après `SetClimate`, dans l'ordre où le
serveur monde l'impose à l'hôte.

L'écart de durée entre la difficile (4 min) et la froide (43 min) n'est pas un
hasard : c'est le constat n°1. Une colonie qui meurt tôt coûte quelques
centaines de millisecondes ; une colonie qui vit trente jours en coûte des
centaines de milliers.

**La carte est à 64×64 et non à 96×96 à cause du constat n°1.** Une première
campagne normale lancée en 96×96 tournait encore après **65 minutes** sans avoir
fini ses 30 graines, et le coût y est proportionnel à la surface : 64×64 divise
la note par 2,25 avant même de compter les objets en moins. La taille de carte
ne change ni les points de menace (ils ne dépendent que des colons, de la
richesse et des jours) ni le climat ; elle change la densité de bois et les
distances de marche, ce qui joue plutôt en faveur de la colonie. Les trente
jours restent trente jours.

---

## 2. Ce que les campagnes donnent

Chaque campagne : 30 graines, 30 jours (432 000 ticks), carte 64×64, le même
joueur scripté.

| | normale | difficile | froide (−5 °C) | chaude (+30 °C) | automne-hiver |
|---|---|---|---|---|---|
| colonies éteintes | **14/30** | **30/30** | 12/30 | 20/30 | 12/30 |
| colonies à ≥ 3 colons | 10/30 | 0/30 | 10/30 | 6/30 | 13/30 |
| colons vivants (moy.) | 1,6 | 0,0 | 1,6 | 0,9 | 1,8 |
| colons au jour 10 / 20 | 2,3 / 1,8 | 0,2 / 0,0 | 2,0 / 1,5 | 2,2 / 1,2 | 2,3 / 1,8 |
| morts au total | 187 | 118 | 187 | 177 | 180 |
| dont raid / blessures | 57 % / 31 % | 77 % / 14 % | 56 % / 37 % | 61 % / 29 % | 60 % / 27 % |
| dont froid | 0 % | 0 % | 2 % | 0 % | 6 % |
| raids reçus / colonie | 5,9 | 2,0 | 6,1 | 5,0 | 6,1 |
| pillards par bande | 1,9 | 2,7 | 1,7 | 1,9 | 2,0 |
| richesse finale (moy.) | 1 436 | 332 | 2 562 | 1 018 | 3 240 |
| vivres en stock (jours) | 10,2 | 0,0 | 20,5 | 5,6 | 30,1 |
| technologies acquises | 0,8 | 0,0 | 0,8 | 0,8 | 0,8 |
| cases brûlées (total) | 8 877 | 13 818 | **39** | 9 835 | **33** |
| colons armés / vivants | 23/49 | 0/0 | 25/49 | 16/28 | 19/55 |
| humeur finale | 52 % | — | **35 %** | 49 % | 51 % |

La ligne « technologies acquises » se lit avec une réserve : le joueur scripté
n'en vise que **deux** (agriculture puis médecine, `plan` §3), jamais les cinq.
Et le résultat est binaire — sur les trente graines de la campagne normale,
**dix-sept colonies en ont zéro et treize en ont exactement deux**, jamais une
seule. Une colonie qui pose son établi finit les deux ; une colonie qui meurt
avant le jour 5 n'en voit aucune.

Deux vérifications de bonne foi tiennent sur les cinq campagnes : la colonne
« morts inexpliquées » est restée à **0**, et le total des morts déduites égale
exactement celui annoncé par le sim (187 = 187, 118 = 118, 177 = 177,
180 = 180). Aucun événement n'a été perdu (`lost_events` = 0 partout).

Une graine sur trente (la 7, en 64×64) ne reçoit **aucun** raid des trente
jours et perd ses trois colons de faim : la colonie y naît sur un morceau de
terre isolé, où `find_entry_tile` ne trouve pas d'entrée. C'est le même monde
dans les cinq campagnes ; il ne fausse rien, mais il rappelle qu'une carte sur
trente est injouable telle quelle.

---

## 3. Constat n°1 — le rangement coûte un balayage de carte par pile au sol

**C'est un défaut du sim, pas un réglage.** Il n'est pas corrigé ici.

### Ce qu'on observe

Sur `campaign --seeds 3 --days 5` en carte 96×96, la graine 2 (colonie vivante,
trois colons) a demandé **5 416 ms** pour ses 72 000 ticks — 13 300 ticks/s —
quand la graine 3, quatre colons vivants sur la même carte, en demandait **151**.
Le `bench` du sim annonce 600 000 ticks/s en pleine activité : la colonie
vivante tourne **quarante-cinq fois** sous la référence.

### Où va le temps

Profil (`sample`, 4 s, graine 2) : **2 306 échantillons sur 2 532 (91 %)** dans
`Sim::find_stockpile_dest`, appelée depuis `try_start_haul`. Le pathfinding n'y
est pour rien : sur la tranche la plus lente (ticks 47 400 → 48 000, 474 ms),
des compteurs posés à la main donnent **13 appels à `find_path` pour 37 140
appels à `find_stockpile_dest`, tous rendant `None`**.

Deux défauts qui se multiplient :

1. `find_stockpile_dest` (`crates/sim/src/jobs.rs:1124`) balaie **les 9 216
   cases de la carte** pour retrouver les seize cases d'entrepôt. C'est
   exactement ce que l'invariant « pas de balayage de carte sans court-circuit »
   (`AGENTS.md`) interdit : le compteur `Map::stockpile_count` existe, mais il
   ne sert que de garde à l'entrée de `try_start_haul`, pas à la recherche
   elle-même.
2. Dans `try_start_haul` (`crates/sim/src/jobs.rs:948`), le compteur `attempts`
   n'est incrémenté **qu'après** un `find_stockpile_dest` réussi :

   ```rust
   let Some(dest) = self.find_stockpile_dest(kind, (x, y)) else {
       continue;               // ← `attempts` ne bouge pas
   };
   attempts += 1;
   ```

   Tant que l'entrepôt est plein, le `else` est pris à chaque tour et le garde-
   fou `PATH_ATTEMPTS` (6) ne s'arme jamais : la boucle parcourt **toutes** les
   piles non rangées. 37 140 balayages en 600 ticks, soit ≈ 342 millions de
   lectures de case.

### Mesure isolée

Scénario minimal : carte vide, trois colons, un entrepôt 4×4, `n` piles de bois
non réservées au sol, 600 ticks en `--release`.

| piles au sol | entrepôt **libre** | entrepôt **saturé** |
|---|---|---|
| 0 | 1 182 070 ticks/s | 497 908 ticks/s |
| 10 | 1 429 848 ticks/s | 5 008 ticks/s |
| 30 | 1 400 917 ticks/s | 1 584 ticks/s |
| 60 | 1 337 295 ticks/s | **714 ticks/s** |

Entrepôt libre, le nombre de piles ne coûte rien (`PATH_ATTEMPTS` plafonne à
six). Entrepôt saturé, le coût est **linéaire en piles au sol** : à 60 piles,
**1 870 fois** plus lent. Il est aussi linéaire en surface de carte — même
scène, 60 piles, entrepôt saturé : 1 650 ticks/s en 64×64, 646 en 96×96, 370 en
128×128, soit exactement le rapport des surfaces (4 096 / 9 216 / 16 384).

Contre-épreuve dans la campagne : `STOCKPILE_SIDE` porté de 4 à 10 (entrepôt de
100 cases, jamais saturé) fait passer la graine 2 de **5 416 ms à 83 ms** — le
même monde, les mêmes morts, **65 fois** plus vite.

### Pourquoi ça compte

C'est un défaut **de jeu réel**, pas un artefact du harnais : toute colonie
dirigée finit par saturer son entrepôt. Le sim tourne dans un Web Worker à
60 ticks/s ; à 714 ticks/s la marge tombe à douze fois le temps réel, et le
`bench` ne le voit pas (son scénario ne sature aucun entrepôt). C'est aussi ce
qui a imposé de mesurer en 64×64 plutôt qu'en 96×96 (§1).

### Proposition (non appliquée)

Trois gestes indépendants, du moins cher au plus structurant :

1. Sortir l'appel de la boucle : `find_stockpile_dest` ne dépend que de `kind`
   et de `(x, y)`. Mémoïser par genre le fait qu'aucune case n'accepte plus
   rien, le temps de l'appel à `try_start_haul`, supprime déjà le gros du coût.
2. Compter l'échec : incrémenter `attempts` avant le `continue`, pour que
   `PATH_ATTEMPTS` borne le travail dans tous les cas. Une ligne, et le pire cas
   passe de O(piles × surface) à O(6 × surface).
3. Tenir dans `Map` la **liste** des cases d'entrepôt à côté de
   `stockpile_count` (elle change rarement : seulement sur `Command::SetZone`),
   et faire boucler `find_stockpile_dest` dessus. Le pire cas devient
   O(6 × cases d'entrepôt). C'est le geste que demande l'invariant.

À vérifier après coup avec le tableau ci-dessus : entrepôt saturé, 60 piles,
96×96, la scène doit rester au-dessus de 500 000 ticks/s.

---

## 4. Constat n°2 — « difficile » n'est pas une difficulté, c'est une extinction

### Mesure

| | normale | difficile |
|---|---|---|
| colonies éteintes | 14/30 | **30/30** |
| colons au jour 10 | 2,3 | **0,2** |
| colonies finissant à ≥ 3 colons | 10/30 | **0/30** |
| morts dues au raid | 57 % | 77 % |
| raids reçus par colonie | 5,9 | 2,0 |
| pillards par bande | 1,9 | **2,7** |
| technologies acquises | 0,8 | 0,0 |

Les 2,0 raids par colonie en difficile ne veulent pas dire « moins de raids » :
la colonie meurt avant d'en voir d'autres. **Vingt-cinq colonies sur trente sont
déjà éteintes au jour 10**, et onze n'ont jamais vu qu'une seule bande — celle
du jour 3, qui a suffi.

### Le mécanisme

Deux leviers de `storyteller::Difficulty` se multiplient sans que rien ne les
rattrape :

- `threat_percent` : 100 % en normal, **150 %** en difficile ;
- `raid_delay` : (2 j, 2 j) en normal, **(1,5 j, 1,5 j)** en difficile.

`combat::GRACE_DAYS` (3) est commun aux deux. Au jour 3, trois colons et une
richesse de départ donnent ≈ 120 points de menace ; ×150 % = 180, soit
`180 / POINTS_PER_RAIDER` = **3 pillards**, et 60 points de reste qui les
arment (`raid_roster`). Face à eux, trois colons **sans arme** : le poste de
fabrication demande 40 bois rangés, et un arc 12 bois et 480 ticks de travail —
la colonie ne les a pas au jour 3. En normal la même situation donne
**2 pillards** pour trois colons — la campagne le confirme : les graines
normales qui n'ont vu qu'un seul raid affichent bien deux têtes —, ce que le
test de référence
`first_raid_is_dangerous_but_survivable` (`crates/sim/tests/gameplay.rs:1347`)
calibre explicitement : ≤ 2 anéantissements sur 12 graines, ≤ 1,0 mort par
graine.

**Ce test n'a pas d'équivalent en difficile.** Le multiplicateur a été posé sans
être mesuré de bout en bout, et il fait passer le premier raid de « dangereux
mais survivable » à « toujours fatal ».

### Proposition (non appliquée)

Séparer les deux leviers, qui aujourd'hui frappent le même instant :

1. Donner à la difficulté son propre délai de grâce — `GRACE_DAYS` à 5 en
   difficile, 3 ailleurs — pour que le premier raid arrive après le poste de
   fabrication, pas avant.
2. Sinon, ou en plus, ramener `threat_percent` de 150 à **120** : au jour 3 la
   bande repasse à deux pillards (144 / 60 = 2), et la marche normal → difficile
   se joue sur la cadence et l'équipement, pas sur un pillard de plus dès la
   première bande.

À éprouver par un `first_raid_at_hard_is_survivable` bâti sur le modèle de
l'existant, plus une campagne de 30 graines qui doit viser **la moitié environ**
des colonies éteintes, pas la totalité.

---

## 5. Constat n°3 — la menace n'escalade pas : une bande vaut deux têtes, toujours

### Mesure

Sur les 177 bandes de la campagne normale, **1,9 pillard par bande**. Et le
chiffre ne bouge pas avec la prospérité :

| campagne | ≤ 2 raids (mortes tôt, pauvres) | ≥ 6 raids (vivantes, riches) |
|---|---|---|
| normale | 1,86 | **1,92** |
| froide | 1,71 | **1,80** |

Trente jours de survie et une richesse multipliée par plusieurs unités ne
changent la taille des bandes que de **3 à 5 %**. En automne-hiver, campagne où
la richesse moyenne monte à 3 240, la bande fait toujours 2,0 têtes.

### Le mécanisme

`Sim::threat_points` (`crates/sim/src/storyteller.rs:362`) :

```rust
THREAT_PER_COLONIST * colonists + wealth / WEALTH_PER_THREAT + days / DAYS_PER_THREAT
```

avec `THREAT_PER_COLONIST` = 40, `WEALTH_PER_THREAT` = 400, `DAYS_PER_THREAT` = 4.
Sur une partie de trente jours à trois colons et 3 240 de richesse :

| terme | points | part |
|---|---|---|
| colons (40 × 3) | 120 | **91 %** |
| richesse (3 240 / 400) | 8 | 6 % |
| jours (30 / 4) | 7 | 5 % |

Le nombre de colons écrase tout. Deux conséquences :

1. **Prospérer n'attire personne.** Une colonie qui triple sa richesse gagne
   huit points de menace, soit un huitième de pillard (`POINTS_PER_RAIDER` = 60).
   Le levier « la richesse appelle les ennuis », qui est le moteur du genre,
   est débranché.
2. **Perdre un colon allège le raid suivant de 40 points**, soit les deux tiers
   d'un pillard. La spirale joue à l'envers : la colonie affaiblie est attaquée
   moins fort. C'est ce qui explique qu'en normal 16 colonies sur 30 tiennent
   trente jours en n'ayant jamais rien fait pour se défendre.

### Proposition (non appliquée)

Rééquilibrer les trois termes pour qu'au jour 30 la richesse pèse autant que
les colons :

- `WEALTH_PER_THREAT` de 400 à **120** : 3 240 de richesse rendent alors 27
  points au lieu de 8 ;
- `DAYS_PER_THREAT` de 4 à **2** : trente jours rendent 15 points au lieu de 7.

Le premier raid ne bouge pas (au jour 3 la richesse et les jours pèsent encore
presque zéro, donc le test de référence tient), mais au jour 30 la bande passe
de 1,9 à ≈ 2,7 têtes. À mesurer sur 30 graines : la taille moyenne doit croître
avec le numéro du raid, ce qu'aucune campagne ne montre aujourd'hui.

---

## 6. Constat n°4 — le feu ne connaît que deux régimes : trois cases ou la moitié de la carte

### Mesure

Cases brûlées **par graine**, campagne de 30 graines :

| campagne | feux | médiane | maximum | total |
|---|---|---|---|---|
| normale (printemps-été) | 71 | **3** | **2 339** | 8 877 |
| chaude (+30 °C) | 76 | 3 | 1 985 | 9 835 |
| difficile | 60 | 2 | 2 746 | 13 818 |
| **froide (−5 °C)** | 39 | **1** | **5** | **39** |
| **automne-hiver** | 33 | **1** | **5** | **33** |

Une carte 64×64 fait 4 096 cases : le pire feu de la campagne difficile en a
consumé **67 %**. La médiane, elle, est à deux ou trois cases. Il n'y a
pratiquement rien entre les deux — un départ s'éteint tout seul, ou il prend la
carte.

Dès qu'il fait froid, le feu est un non-événement : **33 cases brûlées pour 33
départs** en automne-hiver, **39 pour 39** en climat froid — exactement une case
par feu, aucune propagation, jamais.

### Le mécanisme

Une case qui prend feu (`fire::burn_step`) :

- naît à l'intensité 1 et gagne un cran tous les `FIRE_GROWTH` = 150 ticks ;
- ne propage qu'à partir de `SPREAD_MIN` = 2, donc dès 150 ticks ;
- s'éteint à `FIRE_BURN_TICKS` = 900 ticks.

Elle propage donc pendant 750 ticks, et l'évaluation tourne tous les
`FIRE_INTERVAL` = 10 ticks : **75 tirages** à
`FIRE_SPREAD_NUM / FIRE_SPREAD_DEN` = **1/40**, vers **chacune** des quatre
voisines orthogonales. L'espérance vaut donc ≈ 1,9 allumage par voisine encore
libre — largement au-dessus de 1. C'est un processus de branchement
**surcritique** : une fois lancé, il croît jusqu'à manquer de combustible.

Rien ne le ramène sous le seuil, sauf le temps : `WET_SPREAD_DIVISOR` = 4
quadruple le dénominateur sous la pluie, et `GRASS_FIRE_TEMP` = 20 °C empêche
l'herbe sèche de prendre en dessous — c'est exactement pourquoi les campagnes
froide et automne-hiver n'ont **jamais** vu un feu grandir. D'un côté du seuil
rien ne part, de l'autre tout brûle.

Les colons n'y peuvent rien : `FIREFIGHT_RADIUS` = 25 les envoie sur les feux
proches, mais `EXTINGUISH_TICKS` = 80 par cran d'intensité veut dire 240 ticks
pour éteindre une case à 3 — pendant quoi le front en a gagné plusieurs.

Le coût est en **carte**, pas en vies : le feu ne fait que 3 % des morts. Mais
il efface les arbres, donc le bois, donc l'enceinte et les arcs.

### Proposition (non appliquée)

Ramener le processus près de la criticité au lieu de le laisser franchement
au-dessus :

- monter `FIRE_SPREAD_DEN` de 40 vers **150**, ce qui ramène l'espérance par
  voisine libre de 1,9 à 0,5 et fait repasser le branchement sous le seuil
  critique pour un front qui n'a qu'une ou deux voisines libres ;
- ou, à propagation égale, raccourcir la fenêtre : `FIRE_BURN_TICKS` de 900 à
  **400** divise par deux le nombre de tirages qu'une case obtient ;
- ou, plus structurant, plafonner le nombre de cases enflammées simultanément et
  laisser le front avancer sans s'élargir.

Le premier est le plus simple à mesurer et le seul qui ne touche pas à ce qu'un
incendie *fait* — seulement à ce qu'il *devient*.

Cible mesurable, sur 30 graines de la campagne normale : **médiane inchangée
(2 à 3 cases) et maximum sous 300** — le feu doit rester un accident coûteux,
pas une remise à zéro de la carte.

---

## 7. Constat n°5 — le raid tue une deuxième fois : un mort de plus pour deux tués

### Mesure

La cause « blessures » du tableau est celle d'un colon mort **alors qu'il ne
restait plus un ennemi vivant sur la carte** : une hémorragie que personne n'a
pansée, au lendemain du combat. Rapportée aux morts du combat lui-même :

| campagne | tués au combat | morts de leurs plaies **après** | rapport |
|---|---|---|---|
| normale | 108 | 59 | **0,55** |
| froide | 106 | 71 | 0,67 |
| chaude | 109 | 53 | 0,49 |
| automne-hiver | 109 | 49 | 0,45 |
| difficile | 92 | 17 | 0,18 |

Quatre campagnes sur cinq tiennent entre 0,45 et 0,67 : **pour deux colons tués
pendant le raid, un troisième meurt après.** Ce n'est pas un artefact de la
sélection des survivants — dans la campagne normale, le rapport vaut 0,54 chez
les colonies qui tiennent trente jours (37 pour 68) et 0,55 chez celles qui
s'éteignent (22 pour 40). La difficile fait exception pour une raison qui n'en
est pas une : la colonie y est anéantie sur place, il ne reste personne pour
mourir plus tard.

La médecine aide, sans régler quoi que ce soit. Dans la campagne normale, les
colonies qui ont acquis `Tech::Medicine` perdent 0,45 colon de ses plaies par
colon tué ; celles qui n'ont aucune technologie, **0,67**.

### Le mécanisme

Ce n'est **pas** un problème de priorités : `try_start_tend`
(`crates/sim/src/jobs.rs:373`) passe avant tout travail, juste après les besoins
vitaux et le secours. C'est un problème de **débit**.

- Une plaie non pansée saigne pendant `health::BLEED_TICKS`
  = `TICKS_PER_DAY / 6` = **2 400 ticks**, à `severity / BLEED_FRACTION`
  (= 4) points de sang par `BLEED_INTERVAL` (100 ticks).
- Panser **une** plaie coûte `health::TEND_TICKS` = **240 ticks**, à vitesse
  neutre (`TEND_STEP` = 100 : ni l'humeur ni la compétence ne l'accélèrent).
- Un colon s'écroule à `DOWNED_BLOOD` = 300 sur `BLOOD_MAX` = 1 000.

Après un raid, une colonie de trois colons compte typiquement deux blessés
portant deux ou trois plaies chacun, et **un seul soignant debout**. Quatre à
six pansements à 240 ticks, plus les allers-retours, occupent 1 200 à
1 800 ticks : on est dans l'ordre de grandeur exact de la fenêtre de saignement.
La colonie perd la course d'un cheveu, régulièrement, et c'est ce que le rapport
constant de 0,5 raconte.

### Proposition (non appliquée)

Découpler **arrêter l'hémorragie** de **soigner la plaie**, qui sont
aujourd'hui le même geste de 240 ticks :

1. Un premier passage court — 60 ticks — met `Injury::bleeding` à 0 sans
   toucher à `severity` ; la cicatrisation garde ses 240 ticks et son bonus de
   `research::MEDICINE_TEND_PERCENT`. Un soignant seul stoppe alors quatre
   hémorragies dans le temps qu'il en pansait une.
2. Variante minimale si l'on ne veut pas d'un deuxième état : `TEND_TICKS` de
   240 à **120**, ce qui double le débit sans rien changer d'autre.

Cible mesurable, sur les 30 graines de la campagne normale : le rapport
« morts de leurs plaies / tués au combat » doit tomber **sous 0,25** sans que le
nombre de tués au combat bouge — sinon c'est le combat qu'on a changé, pas le
soin.

---

## 8. Les biais du joueur scripté

Tous les chiffres de ce rapport sont ceux d'**un** joueur, toujours le même,
qui joue toujours la même ouverture. Ils disent ce qui arrive à une colonie
correctement mais banalement dirigée ; ils ne disent pas ce qu'un bon joueur
obtiendrait. Ce qui les fausse, et dans quel sens :

1. **Il ne pilote aucun combat.** Aucun repli derrière la porte, aucun
   regroupement, aucune sortie choisie : les colons se battent là où le sim les
   envoie, y compris seuls. Les morts en raid sont donc un **plafond**, pas une
   moyenne — c'est le levier le plus fort dont dispose un vrai joueur, et il
   n'est pas tiré ici.
2. **Il ne mine jamais.** Ni pierre, ni tombes, ni épieux : toute la colonie
   est en bois, donc inflammable, et aucune `BuildKind::Grave` n'est jamais
   posée. Les cadavres restent au sol, pèsent sur l'humeur et se comptent dans
   la richesse. Le poids du feu (constat n°4) et celui de l'humeur sont donc
   surévalués par rapport à une colonie de pierre.
3. **Il ne dédie personne à la recherche ni au soin,** et ne vise que deux
   technologies sur cinq. Il attitre un cultivateur et un bâtisseur, rien
   d'autre : tout le reste suit l'ordre par défaut de `work::WorkType::ORDER`,
   où `Research` passe sixième sur sept, derrière le travail désigné. La ligne
   « technologies » du tableau ne dit donc rien du coût réel d'une technologie ;
   elle dit seulement si la colonie a vécu assez longtemps pour poser son
   établi.

   **Contre-épreuve mesurée** (10 graines, 30 jours, difficulté normale, variante
   du joueur scripté avec un troisième colon en `WorkType::Research` priorité 1,
   non conservée) : **1,20 technologie de moyenne dans les deux cas, les mêmes
   quatre graines à zéro**. La recherche n'est donc **pas** étranglée par
   `WorkType::ORDER` — le goulot est l'établi, qu'une colonie morte avant le
   jour 5 ne pose jamais. C'est un résultat négatif, et il vaut d'être écrit :
   il ferme une piste qui semblait évidente. (Le reste a bougé — 2,1 colons
   vivants au lieu de 1,4, 16 armés sur 21 au lieu de 12 sur 14 — mais sur dix
   graines c'est du bruit, et ce n'est pas ce que la mesure cherchait.)
4. **Il ne redimensionne jamais son entrepôt** (4×4 pour toute la partie) et
   n'annule jamais un chantier. C'est ce qui a révélé le constat n°1 — un vrai
   joueur agrandit son entrepôt et ne verrait pas le ralentissement, ce qui
   rend le défaut d'autant plus sournois.
5. **Il ne s'adapte ni au terrain ni au biome.** Zones et enceinte tombent
   toujours aux mêmes décalages autour d'un repère fixe (le centre de la
   carte). Sur une carte coupée par l'eau, une partie de l'enceinte tombe dans
   le vide et ne se bâtit jamais.
6. **Il ne vend jamais son surplus** et n'achète que sous trois jours de
   vivres : le marchand est un filet de sécurité, jamais une économie.
7. **Il ne déplace jamais un colon** : aucune fuite devant le feu, aucun
   sauvetage dirigé, aucun déménagement.
8. **Une campagne de trente jours partie du jour 0 ne voit que le printemps et
   l'été** (`climate::YEAR_DAYS` = 60, quatre saisons de quinze). C'est pour ça
   que la cinquième campagne part du jour 30 : sans elle, ni le premier gel, ni
   les tuniques d'automne, ni les cultures tuées par le froid ne seraient
   jamais mesurés. Et même à 30 jours, personne ne joue une **année** entière :
   `--days 60` reste à faire, quand le constat n°1 aura été traité.
9. **Il ne s'arme qu'à moitié**, sans qu'on sache si c'est lui ou le sim :
   23 colons armés sur 49 vivants en campagne normale, et six colonies vivantes
   sur seize n'ont pas une seule arme au jour 30 — alors que l'objectif « un arc
   par colon » est posé au tick 0, qu'un arc coûte 12 bois et 480 ticks
   (`craft::RECIPES`), et que `WorkType::Build` couvre **à la fois** les
   chantiers et le poste de fabrication. Les 48 murs de l'enceinte et les arcs
   se disputent donc le même bâtisseur. Le départager demanderait une campagne
   de contrôle sans enceinte : c'est la mesure suivante à faire, pas un constat
   qu'on peut tirer d'ici.

Deux garde-fous rendent malgré tout les chiffres exploitables : la colonne `?`
(morts inexpliquées) est restée à **0** sur les 150 colonies, et le total des
morts déduites égale exactement celui annoncé par le sim. Le tableau ne raconte
donc pas d'histoire que la simulation n'ait pas racontée d'abord.
