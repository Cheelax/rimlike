# Campagnes d'équilibrage — constatations

Mesures produites par `cargo run -p sim-cli --release -- campaign`
(`crates/sim-cli/src/campaign.rs`), le 2026-09-05, sur la révision de travail de
la phase 2c.

**Ce document mesure, il ne règle rien.** Aucune constante du sim n'a été
touchée pour l'écrire. Chaque constat porte une proposition chiffrée, à
éprouver par un test statistique sur plusieurs graines avant d'être appliquée
(règle « on mesure avant de régler », `AGENTS.md`).

Les constats, eux, ont été traités **le même jour** ; chacun porte alors une
section « après réglage » qui donne les chiffres d'arrivée, mesurés de la même
façon, et dit ce qui a été essayé puis rejeté en route. La proposition d'origine
reste écrite telle quelle : plusieurs se sont révélées fausses à la mesure, et
c'est le genre de chose qu'on regrette d'avoir effacée.

## Les cinq constats, en une ligne chacun

1. **Rangement** (**corrigé le 2026-09-05**, voir le journal du plan) — dès qu'un entrepôt est plein, chaque colon relance un
   balayage complet de la carte **par pile au sol et par tick** : 1 870 fois
   plus lent à 60 piles. Défaut du sim, pas réglage. (§3)
2. **Difficulté** (**réglée le 2026-09-05**, voir « Après réglage » en §4) —
   « difficile » éteignait **30 colonies sur 30**, 25 avant le jour 10 : le
   premier raid y faisait trois pillards armés contre trois colons qui n'ont pas
   encore d'arme. La première bande est maintenant plafonnée à deux têtes à
   toutes les difficultés : 24 colonies sur 30 passent le jour 10 et 8 voient le
   jour 30. (§4)
3. **Menace** (**réglée le 2026-09-05**, voir « Après réglage » en §5) — une
   bande valait 1,9 pillard au premier raid comme au neuvième : tripler sa
   richesse ne changeait la taille des raids que de 3 %. La richesse compte
   maintenant **deux fois** au-delà de 2 000, et une colonie trois fois plus
   riche reçoit une tête de plus. (§5)
4. **Feu** (**réglé le 2026-09-05**, voir « Ce qui a été fait » en §6) — médiane
   3 cases brûlées, maximum 2 339 sur une carte qui en compte 4 096, et rien
   entre les deux. Le feu suit maintenant le vent : le pire incendie de la
   campagne normale tombe à 534 cases (13 %), et la tranche « quelques dizaines
   de cases », jusque-là vide, se remplit. (§6)
5. **Soins** (**corrigé le 2026-09-05**, voir le journal du plan) — pour deux
   colons tués au combat, un troisième mourait de ses plaies après, faute de
   débit de pansement. Rapport stable à 0,5. (§7)

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

### Le même défaut ailleurs : l'inhumation (corrigé le 2026-09-05)

`Sim::try_start_bury` cherchait la tombe vide la plus proche **en balayant la
carte entière**, à chaque appel, exactement comme le rangement — `grave_count`
ne servait, là aussi, que de garde à l'entrée. Le troisième geste ci-dessus lui
a été appliqué tel quel : `Map::grave_tiles`, liste triée des tombes vides
tenue par `set_feature` et sérialisée comme `stockpile_tiles`, plus un
court-circuit « aucune tombe libre » avant de trier les cadavres.

Mesuré par un compteur frère de `haul_scans` (`Sim::bury_scans`, hors snapshot
et hors hash), sur 600 ticks, trois colons, seize tombes, des cadavres hors
d'atteinte (`crates/sim/tests/burial_perf.rs`) :

| scène | avant | après |
|---|---|---|
| 96×96, 60 cadavres | 8 753 280 cases | **105 280** |
| 192×192, 60 cadavres | 34 742 400 cases | **105 280** |
| 96×96, 10 cadavres | 8 753 280 cases | **105 280** |

Quatre-vingt-trois fois moins de travail en 96×96, trois cent trente fois moins
en 192×192, et le coût ne dépend plus de la surface. Une différence avec le
rangement, à la décharge du code d'origine : la borne `PATH_ATTEMPTS` s'armait
**déjà** sur les cadavres examinés (d'où la troisième ligne, identique à la
première avant comme après) ; seul le balayage était en cause. Le joueur
scripté des campagnes ne creusant jamais de tombe (§8, biais n°2), ce défaut ne
pesait sur aucun chiffre de ce rapport — il attendait le premier joueur qui
enterre ses morts.

---

## 4. Constat n°2 — « difficile » n'était pas une difficulté, c'était une extinction

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

### Proposition d'alors (éprouvée le 2026-09-05, voir plus bas)

Séparer les deux leviers, qui frappent le même instant :

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

### Après réglage du 2026-09-05

Les deux propositions ont été essayées ; **la première est fausse** (voir plus
bas) et la seconde ne suffisait pas. Trois gestes ont été retenus, chacun
mesuré séparément sur 30 graines :

| geste | avant | après |
|---|---|---|
| plafond de la **première** bande (`storyteller::FIRST_RAID_POINTS`) | (n'existait pas) | **120 points**, soit deux têtes |
| `Difficulty::threat_percent` (difficile) | 150 % | **120 %** |
| `Difficulty::raid_delay` (difficile) | 1,5 à 3 jours (2,25 de moyenne) | **1,75 à 3,75 jours** (2,75) |

plus le réglage de la menace elle-même (§5), commun à toutes les difficultés.
Les tests statistiques qui encodent la cible sont dans
`crates/sim/tests/balance_threat.rs` ; ils échouaient tous les trois avant.

| campagne 30 graines × 30 jours | **difficile** témoin | **difficile** après | normale témoin | normale après |
|---|---|---|---|---|
| colonies vivantes au jour 30 | **0/30** | **8/30** | 20/30 | 22/30 |
| colonies vivantes au jour 10 | 11/30 | **24/30** | 28/30 | 28/30 |
| colonies éteintes avant le jour 10 | 19/30 | **6/30** | 2/30 | 2/30 |
| colons au jour 10 / 20 | 0,7 / 0,0 | 2,2 / 1,5 | 2,9 / 2,8 | 3,0 / 2,6 |
| raids reçus par colonie | 2,5 | 5,9 | 6,6 | 6,6 |
| pillards par bande | 2,8 | 2,3 | 2,1 | 2,2 |
| richesse finale moyenne | 550 | 1 401 | 2 102 | 2 127 |
| technologies acquises | 0,0 | 0,6 | 0,9 | 0,9 |

Les objectifs sont tenus : en difficile **la moitié des colonies passent le
jour 10** (24 sur 30) et **plus du quart atteignent le jour 30** (8 sur 30), et
celles qui s'éteignent le font maintenant *après* le jour 10 (16 sur 22, contre
19 sur 30 avant le jour 10). La normale, elle, ne bouge pas : 22 colonies
vivantes contre 20 pour le témoin, à l'intérieur du bruit de trente graines.

Les 2,5 raids par colonie du témoin difficile ne sont toujours pas « moins de
raids » : la colonie meurt avant d'en voir d'autres. Après réglage elle en voit
5,9, presque autant qu'en normale — et c'est bien le signe qu'elle survit.

**Le témoin compte autant que la mesure.** Les constats n°1, n°4 et n°5 ont été
corrigés le même jour, et le tableau de référence en tête de ce constat date
d'avant eux : la colonne « témoin » ci-dessus est donc la révision d'arrivée
avec le seul `storyteller.rs` remis dans son état antérieur. Sans elle, on
porterait au crédit du réglage de la menace ce que le rangement, le feu et les
soins ont apporté — à eux seuls, ils font passer la campagne difficile de 4 à
11 colonies vivantes au jour 10, et la normale de 16 à 20 au jour 30.

### Ce qui a été essayé, et rejeté

1. **`GRACE_DAYS` à 5 en difficile** (proposition n°1). Elle suppose que la
   colonie profitera de ces deux jours pour s'armer. Mesuré, l'effet est
   **inverse** : un voyageur arrive au jour 4 ou 5 (`next_wanderer_at`), la
   colonie passe à quatre colons, et à 40 points par colon la première bande
   grossit d'une tête au lieu de rétrécir — **4,0 pillards par bande** contre
   2,7, 30 colonies éteintes sur 30, 25 avant le jour 10. C'est ce résultat qui
   a fait remplacer le sursis par un **plafond** : le plafond, lui, ne dépend ni
   de l'heure ni de ce que la colonie est devenue entre-temps.
2. **`threat_percent` à 120 sans plafond** (proposition n°2 seule). La colonie
   du joueur scripté vaut 1 711 de richesse dès le jour 3 (§5) : avec un tarif
   de richesse assez raide pour que la prospérité pèse, sa première bande valait
   encore trois têtes. 30 colonies éteintes sur 30, 3 passaient le jour 10.
3. **Garder la cadence de 1,5 jour.** Avec le plafond et les 120 %, l'ouverture
   devient survivable — 23 colonies sur 30 passent le jour 10 — mais une bande
   toutes les 2,25 journées use ce qui reste : **3 colonies sur 30** voient le
   jour 30. C'est cette mesure-là qui a désigné `raid_delay` comme troisième
   geste, plutôt qu'un tour de vis de plus sur les points.

---

## 5. Constat n°3 — la menace n'escaladait pas : une bande valait deux têtes, toujours

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

### Proposition d'alors (éprouvée le 2026-09-05, voir plus bas)

Rééquilibrer les trois termes pour qu'au jour 30 la richesse pèse autant que
les colons :

- `WEALTH_PER_THREAT` de 400 à **120** : 3 240 de richesse rendent alors 27
  points au lieu de 8 ;
- `DAYS_PER_THREAT` de 4 à **2** : trente jours rendent 15 points au lieu de 7.

Le premier raid ne bouge pas (au jour 3 la richesse et les jours pèsent encore
presque zéro, donc le test de référence tient), mais au jour 30 la bande passe
de 1,9 à ≈ 2,7 têtes. À mesurer sur 30 graines : la taille moyenne doit croître
avec le numéro du raid, ce qu'aucune campagne ne montre aujourd'hui.

### Après réglage du 2026-09-05

La proposition a une hypothèse cachée — que la richesse d'une colonie *monte*
avec le temps. Mesurée, elle **descend** :

| jour | 3 | 5 | 10 | 30 |
|---|---|---|---|---|
| richesse moyenne (30 graines, normale) | **1 711** | 1 565 | 1 448 | 1 436 |

(chaque colonne est la richesse finale d'une campagne `--days N`.)

Une colonie vaut donc 1 700 dès le troisième jour, sans avoir rien prospéré :
c'est le bois qu'elle vient d'abattre et qui traîne au sol. Toute pente
linéaire assez raide pour que « tripler sa richesse » se voie fait donc payer
cette colonie-là, et le premier raid la tue :

| `WEALTH_PER_THREAT` linéaire | jour 5 → jour 30 (×3 de richesse) | campagne normale |
|---|---|---|
| 400 (avant) | 2 → 2 têtes | 20 colonies vivantes sur 30 |
| 80 | 2 → **3** têtes | **14 sur 30** |
| 15 | 3 à 4 têtes dès le début | **0 sur 30** |

(La dernière ligne allait de pair avec `THREAT_PER_COLONIST` à 35 : c'est ce
couple-là qui a été mesuré, l'un ne va pas sans l'autre — voir la fin de cette
section.)

D'où le réglage retenu : **deux tranches**, pas une pente.

| constante | avant | après |
|---|---|---|
| `WEALTH_PER_THREAT` | 400 | 400 (inchangé) |
| `WEALTH_RICH_FROM` | — | **2 000** |
| `WEALTH_PER_THREAT_RICH` | — | **40** |
| `DAYS_PER_THREAT` | 4 | **2** |
| `THREAT_PER_COLONIST` | 40 | 40 (inchangé, essayé à 35) |

Sous 2 000 de richesse, la menace est **exactement** celle d'avant — c'est ce
qui protège la colonie qui n'a fait qu'abattre des arbres. Au-dessus, ce qui
dépasse compte une seconde fois, dix fois plus cher. Décomposition des points
d'une colonie de trois colons au jour 30, à 4 700 de richesse (le triple de ce
qu'elle vaut au jour 5) :

| terme | avant | après |
|---|---|---|
| colons (40 × 3) | 120 (**91 %**) | 120 (56 %) |
| richesse | 11 (8 %) | 78 (**37 %**) |
| jours | 7 (5 %) | 15 (7 %) |
| **total** | 138 → **2 têtes** | 213 → **3 têtes** |

Taille de bande mesurée (`crates/sim/tests/balance_threat.rs`, richesse forcée
par `spawn_item`, raid **forcé** pour lire la menace elle-même et non le
plafond de la première bande du §4) :

| scène | avant | après |
|---|---|---|
| tick 0, 3 colons, 300 de richesse | 2 | 2 |
| jour 5, 3 colons, 1 565 (mesurée en campagne) | 2 | 2 |
| jour 30, 3 colons, **4 695** (le triple) | 2 | **3** |
| 6 colons, 2 600 de richesse | 4 | 4 |

En campagne, la bande moyenne passe de 2,1 à 2,2 têtes en normale : c'est peu,
et c'est voulu — la moitié des colonies ne franchissent jamais le seuil. Ce qui
change, c'est que **celles qui prospèrent le paient** : la plus riche des trente
finit à 4 374 de richesse, soit 59 points de menace de plus qu'avant, une tête
de bande entière.

Reste **le deuxième point du constat**, non traité : perdre un colon allège
toujours le raid suivant de 40 points. Le corriger demanderait de descendre
`THREAT_PER_COLONIST`, donc de remonter le tarif de la richesse pour tenir la
fourchette du tick 0 — c'est exactement la ligne « 15 » du tableau ci-dessus.
Essayé, mesuré, rejeté.

---

## 6. Constat n°4 — le feu ne connaissait que deux régimes : trois cases ou la moitié de la carte

**Réglé le 2026-09-05.** Le constat et le mécanisme sont laissés tels qu'ils ont
été mesurés ; ce qui a été changé, ce qui a été essayé puis écarté et les
chiffres d'après sont en fin de section. Le banc de mesure vit désormais dans
`crates/sim/tests/balance_fire.rs`.

### Mesure (avant)

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

### Le banc de mesure

`crates/sim/tests/balance_fire.rs` : un **bosquet de 20×20 arbres** posé sur de
la terre nue, allumé en son centre, laissé brûler jusqu'au bout, sur vingt
graines et sous quatre climats forcés. La terre nue autour isole la mesure —
l'herbe ne prend qu'au-dessus de `GRASS_FIRE_TEMP` et fausserait la comparaison
chaud / froid. Les trois colons naissent enfermés dans un enclos de roche : leur
barycentre ne bouge plus, le bosquet reste hors de `FIREFIGHT_RADIUS`, personne
ne vient éteindre.

Cet enclos n'est pas qu'une commodité de scénario, c'est aussi ce qui rend le
banc utilisable : **sans lui, le même incendie passe de 0,3 s à 66 s en
`debug`**. Profil `sample` sur la version sans enclos : 99 % des échantillons
dans `find_job` → `try_start_firefight` → `fire_to_fight` → `path_beside_fire`
→ `path::find_path_for`. C'est le constat n°1 sous un autre nom — un colon
inactif relance sa recherche à chaque tick, et ici cette recherche vaut jusqu'à
**48 A\*** (6 foyers candidats × 8 voisines). Défaut à part entière,
**corrigé le 2026-09-06** : voir « Le coût de la lutte » en fin de section.

### Ce qui a été fait

Deux changements, tous les deux dans `crates/sim/src/fire.rs`.

**1. Le feu suit le vent.** `FIRE_SPREAD_DEN` ne bouge pas (1/40), mais elle ne
vaut plus que pour le voisin **sous le vent** : `CROSS_SPREAD_DIVISOR` = 3 sur
les deux côtés, `BACK_SPREAD_DIVISOR` = 16 à contre-vent. L'espérance
d'allumages par voisine libre passe de 0,85 dans les quatre directions à 0,85
sous le vent, 0,46 de chaque côté et 0,10 en amont : la somme repasse sous
2 et, surtout, le feu **court en panache** au lieu de s'étaler en tache. Il
traverse ce qu'il a devant lui et s'arrête.

Le vent n'ajoute **aucun champ à `Sim`** : `fire::wind_direction` le lit dans
`Sim::weather_noise`, le bruit de température tiré par `tick_weather` à chaque
changement de temps. Il tourne donc tout seul, toutes les quelques heures de
jeu, et un incendie qui dure voit son panache s'infléchir.

**2. Le gel n'éteint plus, il ralentit.** `quench_chance` perd son terme
`freezing` : seul ce qui tombe du ciel éteint (pluie et orage 1/4, neige 2/4).
En échange, `COLD_SPREAD_DIVISOR` = 2 double le dénominateur de propagation sous
`FREEZING`. C'était bien là la cause du « une case par départ » : une case gelée
avait une chance sur quatre de s'éteindre par évaluation, soit 40 ticks
d'espérance de vie quand il en faut `FIRE_GROWTH` = 150 pour atteindre
`SPREAD_MIN`. Aucun feu ne franchissait jamais le premier palier sous zéro.

### Mesure (après) — le banc

Arbres consumés sur 400, vingt graines, temps clair et sec sauf mention :

| climat | avant : médiane | après : médiane | min | max | graines dans 15-60 % |
|---|---|---|---|---|---|
| 30 °C | 399 (99 %) | **112 (28 %)** | 1 | **168 (42 %)** | **17/20** (avant 0/20) |
| 0 °C (gel la nuit) | 399 (99 %) | 73 (18 %) | 1 | 139 | 11/20 |
| −5 °C (gel permanent) | **0** | **5** (moyenne 13,9) | 1 | 45 | 0/20 |
| pluie, 30 °C | 0 | 0 | 0 | 0 | — |
| neige, −5 °C | 0 | 0 | 0 | 0 | — |

Les deux premières lignes du « avant » valent 99 % parce que le bosquet est
dense : à 12 °C comme à 30 °C, il partait entier. La troisième valait zéro — pas
même la case d'origine, consumée avant terme.

### Ce qui a été essayé et écarté

Toutes ces variantes ont été mesurées sur le même banc, mêmes vingt graines,
30 °C :

| variante | médiane | maximum | dans 15-60 % |
|---|---|---|---|
| `FIRE_SPREAD_DEN` 40 → 100, sans vent | 269 (67 %) | 354 (88 %) | 6/20 |
| `FIRE_SPREAD_DEN` 40 → 110, sans vent | 163 (40 %) | 279 (69 %) | 11/20 |
| `FIRE_SPREAD_DEN` 40 → 120, sans vent | 90 (22 %) | 230 (57 %) | 11/20 |
| `FIRE_SPREAD_DEN` 40 → 150, sans vent | 7 (1 %) | 166 (41 %) | 3/20 |
| `SPREAD_MIN` = 3 et 1/80, sans vent | 235 (58 %) | 344 (86 %) | 7/20 |
| `FIRE_BURN_TICKS` 900 → 400, sans vent | 14 (3 %) | 255 (63 %) | 6/20 |
| **vent, côtés ÷3, amont ÷16** | **112 (28 %)** | **168 (42 %)** | **17/20** |

La proposition d'origine — ne toucher qu'au dénominateur — ne marche pas, et la
raison est structurelle : **un feu isotrope sur un bosquet homogène est un
processus de percolation.** Sous le seuil il meurt, au-dessus il prend tout, et
la fenêtre où il fait autre chose est exactement le point critique — là où la
variance est maximale. C'est ce que dit la colonne de droite : le meilleur
dénominateur isotrope (110 ou 120) ne tient la bande visée que pour onze graines
sur vingt, avec une médiane à 22 % et un pire cas à 69 %. Il n'y a pas de
réglage isotrope qui donne « un feu qui coûte cher sans tout raser » de manière
fiable.

Le vent casse la symétrie et c'est ce qui change tout : le processus devient
dirigé, sa distribution se resserre, et dix-sept graines sur vingt tombent dans
la bande. Le facteur d'amont pèse autant que celui des côtés — à côtés égaux,
passer de 6 à 16 en amont fait tomber le pire cas de 62 % à 42 % : c'est le
retour de flamme qui remplissait la tache.

Écartée aussi, la troisième piste (plafonner le nombre de cases enflammées) :
elle borne le *débit* du feu, pas son étendue. Un front sous-plafond avance
moins vite mais finit quand même par manquer de combustible, c'est-à-dire par
tout brûler.

### Mesure (après) — la campagne

Trois campagnes de 30 graines × 30 jours, carte 64×64, difficulté normale,
jouées **deux fois** : une fois sur la révision d'avant, une fois avec le seul
changement du feu. Les deux binaires sortent d'une copie de travail isolée
(`git worktree`), pour que les réglages menés en parallèle sur `storyteller`,
`jobs` et `health` ne s'invitent pas dans la comparaison. Le « avant » retrouve
bien les chiffres du tableau du haut (69 feux, médiane 3, maximum 2 339).

| campagne | | feux | médiane | maximum | total | colonies touchées |
|---|---|---|---|---|---|---|
| normale | avant | 69 | 3 | **2 339 (57 %)** | 8 176 | 20/30 |
| normale | **après** | 81 | 2 | **534 (13 %)** | 907 | 20/30 |
| chaude (+30 °C) | avant | 86 | 4 | **2 676 (65 %)** | 14 483 | 24/30 |
| chaude (+30 °C) | **après** | 94 | 3 | **609 (14 %)** | 1 112 | 24/30 |
| froide (−5 °C) | avant | 44 | 1 | 10 | 52 | 24/30 |
| froide (−5 °C) | **après** | 44 | 1 | 5 | 46 | 24/30 |

Le maximum passe donc de 57 % à **13 %** de la carte en normal et de 65 % à
**14 %** en chaud : la remise à zéro de la carte n'existe plus. Mais le chiffre
qui compte n'est pas le maximum, c'est la **forme** de la distribution. Cases
brûlées par graine, campagne normale, triées :

```
avant : 0 ×10, 1, 1, 2, 2, 3, 3, 3, 3, 4, 10, 15, | 323, 369, 424, 513, 678, 742, 819, 1922, 2339
après : 0 ×10, 1, 1, 2, 2, 2, 3, 3, 3, 3, 4, 6, 9, 10, 11, 15, 33, 75, 95, 95, 534
```

Le trou est là, en toutes lettres : **avant, aucune colonie ne perdait entre 15
et 323 cases.** Après, il y en a cinq (33, 75, 95, 95, 534). C'est exactement le
constat qui ouvre cette section — « il n'y a pratiquement rien entre les deux » —
et c'est lui qui est réglé.

Deux réserves, honnêtement :

**La médiane de la campagne normale passe de 3 à 2**, sous la cible qu'on
s'était donnée (≥ 3). Ce n'est pas un régime qui change : c'est une case sur la
colonie médiane, dans une distribution où la moitié des colonies voit zéro ou
une case. La médiane **des colonies touchées**, plus parlante, passe de 12 à 5,
et le nombre de colonies touchées ne bouge pas (20/30 en normal, 24/30 en
chaud). Le feu n'est pas devenu un non-événement — il est devenu un accident de
quelques dizaines de cases au lieu d'un accident de mille.

**La campagne froide, elle, ne bouge pas** (52 → 46 cases pour 44 feux). Le banc
montre pourtant qu'un bosquet dense brûle maintenant par −5 °C (médiane 5 au
lieu de 0). Les deux mesures ne se contredisent pas : le « une case par départ »
de la campagne froide avait **deux** causes, et celle qui reste est
`GRASS_FIRE_TEMP` = 20 °C. `--climate -50` impose une moyenne de −5 °C avec
l'amplitude tempérée (±15 °C) : la carte plafonne à **10 °C au cœur de l'été**,
l'herbe n'y compte donc jamais comme combustible, et un feu ne peut sauter d'un
arbre à l'autre que si les arbres se touchent. La campagne normale, elle, monte
à 27 °C en été — c'est l'herbe sèche qui portait ses incendies de mille cases.
Faire brûler l'herbe plus froide est un autre réglage, avec son propre risque
(il rendrait les cartes froides plus dangereuses que les tempérées) : il n'est
pas fait ici.

### Le coût de la lutte (corrigé le 2026-09-06)

**C'est un défaut du sim, pas un réglage** — le même que le constat n°1, sur une
autre recherche.

Ce qui coûtait n'était pas l'A\* qui aboutit (il s'arrête sur sa cible) mais
celui qui **échoue** : il explore toute la région où se tient le colon avant de
rendre `None`. Un foyer inatteignable — muré, de l'autre côté d'un étang, ou
simplement au fond d'une poche de terre nue que l'incendie vient d'ouvrir au
milieu d'un bosquet — en déclenchait un par voisine tenable, pour chaque colon
inactif, **à chaque tick**.

Quatre changements, dans `crates/sim/src/fire.rs` et l'appel de
`crates/sim/src/jobs.rs` :

1. **Une évaluation sur dix.** `FIREFIGHT_RETRY` = `FIRE_INTERVAL` = 10 : la
   lutte n'est réévaluée qu'un tick sur dix, comme le feu lui-même et comme
   l'interruption de travail (`drop_work_for_fire`) l'était déjà. Rien ne bouge
   entre deux évaluations du feu ; chercher à chaque tick payait dix fois la
   même réponse. Le pas se lit dans `Sim::tick`, **sans état** : pas de champ de
   plus dans `Pawn`, pas de ligne de plus au snapshot. Il est le même pour tous
   les colons — décaler la phase par identité (`(tick + id) % 10`) étalerait la
   charge, mais casserait l'enchaînement « je lâche ma besogne » → « je prends
   les flammes » qui se joue dans le même tick.
2. **Un budget d'A\*, pas seulement un nombre de foyers.** `fire_to_fight`
   examinait déjà au plus `PATH_ATTEMPTS` = 6 foyers, mais chacun pouvait coûter
   ses huit voisines. Le budget de six recherches de chemin vaut maintenant pour
   **tout l'appel**, foyers et voisines confondus, comme le rangement.
3. **Un cache d'inatteignabilité par salve.** Un foyer dont un colon vient de
   démontrer qu'aucune de ses voisines n'est atteignable est inscrit dans une
   liste locale au tick (`fire::Salvo`), que les colons suivants consultent
   avant de lancer quoi que ce soit. C'est déterministe parce que les colons
   sont parcourus par indice, toujours dans le même ordre : ce que le premier y
   écrit, le deuxième le lit, partout et à toutes les exécutions. Ce n'est pas
   de l'état — la salve naît et meurt dans `Sim::update`, elle n'entre ni au
   snapshot ni au hash.
4. **Une seule recherche par colon et par salve.** `drop_work_for_fire` posait
   la question, `find_job` la reposait aussitôt pour le même colon et sur le
   même état : la réponse est mémorisée dans la salve, et le chemin est rendu
   avec le foyer au lieu d'être recalculé.

Deux court-circuits étaient déjà là et le restent : `Map::fire_count` (sans feu
sur la carte, rien n'est comparé) et la distance au barycentre (aucun foyer à
`FIREFIGHT_RADIUS`, aucune recherche de chemin).

### Mesure (après) — la lutte

Banc : `crates/sim/tests/firefight_perf.rs`. Un réduit de roche hermétique à
quinze cases de trois colons inactifs, où alternent colonnes d'arbres en feu et
colonnes de terre nue — les colonnes de terre sont franchissables, ne brûlent
pas, jouxtent les flammes, et aucune n'est atteignable : c'est le pire cas, et
il y en a autant qu'on veut. 600 ticks, `release` :

| scène | A\* avant | A\* après | ticks/s avant | ticks/s après |
|---|---|---|---|---|
| 96×96, 40 foyers | 10 688 | **461** | 49 | **1 153** |
| 96×96, 200 foyers | 11 208 | **461** | 48 | **1 196** |
| 192×192, 40 foyers | 10 688 | **461** | 11 | **272** |

Le plafond que le test impose vaut `colons × PATH_ATTEMPTS × ticks /
FIREFIGHT_RETRY` = 1 080 : la mesure est à 461, et elle ne bouge ni avec le
nombre de foyers ni avec la surface. Les colons éteignent quand même le bosquet
libre du décor — la borne ne les empêche pas de travailler.

Le banc du feu, lui, **garde son enclos**. Sans lui, `cargo test --test
balance_fire` en `debug` passait de 2,2 s à 106 s ; il n'en demande plus que 24,
mais c'est encore onze fois la version enclose, et surtout l'enclos n'est pas
qu'une commodité de vitesse : il garantit que personne ne vient éteindre, donc
que la distribution mesurée est bien celle du feu et pas celle des colons.

---

---

## 7. Constat n°5 — le raid tue une deuxième fois : un mort de plus pour deux tués

**Corrigé le 2026-09-05** (voir « Ce qui a été fait », en fin de section). Le
constat et sa mesure sont laissés tels qu'ils ont été écrits ; la proposition
est remplacée par ce qui a effectivement été appliqué, et par ce que ça a donné.

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

Ce n'est **pas** un problème de priorités : `try_start_tend` passe avant tout
travail, juste après les besoins vitaux et le secours, et le délai mesuré entre
la chute d'un colon et le départ du soignant est de **17 ticks**. C'est un
problème de **débit**.

- Une plaie non pansée saigne pendant `health::BLEED_TICKS`
  = `TICKS_PER_DAY / 6` = **2 400 ticks**, à `severity / BLEED_FRACTION`
  (= 4) points de sang par `BLEED_INTERVAL` (100 ticks). Une seule entaille au
  torse de sévérité 250 vide donc les `BLOOD_MAX` = 1 000 points d'un corps
  avant de se refermer d'elle-même : **tout ce qui n'est pas pansé assez vite
  tue**, et un colon s'écroule dès `DOWNED_BLOOD` = 300.
- Un soin coûte `health::TEND_TICKS` = **240 ticks**, à vitesse neutre
  (`TEND_STEP` = 100 : ni l'humeur ni la compétence ne l'accélèrent). Une
  rectification à la première rédaction de ce constat : la séance couvrait
  **déjà** toutes les plaies d'un blessé à la fois, pas une par une. Le débit
  manquant n'était donc pas « quatre à six pansements », il était ailleurs.

Où, exactement : scène ciblée de trente graines (trois colons, des lits, des
vivres, un raid déclenché, cinq jours d'observation), **24 morts de leurs plaies**
décortiquées une par une au tick de la mort.

| ce qui se passait au moment de la mort | morts |
|---|---|
| un soin en cours, commencé trop tard ou trop lent | 10 |
| **un sauvetage en cours** — on le portait au lit pendant qu'il se vidait | 6 |
| un camarade valide, mais **endormi** | 4 |
| plus un seul camarade debout (irréductible) | 4 |

Le sauvetage et le sommeil pèsent donc autant que la durée du soin : le sim
allait chercher un brancard avant de comprimer la plaie, et laissait dormir la
colonie pendant qu'un blessé se vidait.

### Ce qui a été fait (2026-09-05)

Quatre changements, essayés un par un, tous conservés — `crates/sim/src/health.rs`
et la partie « soins » de `crates/sim/src/jobs.rs` :

1. **Hémostase** (`health::HEMOSTASIS_TICKS` = `TEND_TICKS / 4` = **60 ticks**,
   la valeur proposée plus haut). Au quart du geste, toutes les plaies du
   blessé cessent de saigner (`Injury::close`) ; elles ne sont pas *pansées*
   pour autant — la séance continue jusqu'aux 240 ticks, qui seuls posent
   `tended` et donnent la cicatrisation accélérée et le bonus de
   `research::MEDICINE_TEND_PERCENT`. `TEND_TICKS` ne bouge pas.
2. **Le pansement passe avant le brancard.** `find_job` essaie
   `try_start_tend(bleeding_only)` **avant** `try_start_rescue` : on comprime le
   blessé là où il est tombé, on le porte au lit ensuite. Une écorchure, elle,
   attend toujours son tour derrière le brancard.
3. **Triage.** `try_start_tend` classait les blessés par
   `(saigne, à terre, distance)` ; il les classe désormais par
   `Pawn::ticks_to_bleed_out` — `blood × BLEED_INTERVAL / bleed_rate`, entier —
   puis à terre avant debout, puis distance. Le soignant va à celui qui se vide
   le plus vite, pas au plus proche.
4. **Une hémorragie réveille la colonie.** `do_sleep` tente
   `try_start_tend(bleeding_only)` à chaque tick : si le geste est possible, le
   dormeur se lève ; sinon il ne se réveille même pas. Le court-circuit est le
   même que partout ailleurs — sans plaie ouverte, le test coûte un parcours
   des colons et rien de plus.

Une cinquième piste n'a pas eu d'objet : « panser d'abord la blessure qui
saigne le plus ». Une séance couvrait **déjà** toutes les plaies d'un blessé,
il n'y avait aucun ordre entre elles à corriger ; c'est le tri des **blessés**
(n°3) qui en tient lieu. Aucune constante n'a bougé non plus : `TEND_TICKS`
reste à 240, la variante « 240 → 120 » proposée plus haut n'a pas été
nécessaire.

**Mesure, scène ciblée** (`crates/sim/tests/balance_tending.rs`, 60 graines, un
raid déclenché puis une journée entière sans ennemi debout ; la même révision
du sim, avec et sans la tranche) :

| | morts de leurs plaies | tués au combat | rapport |
|---|---|---|---|
| avant | 19 | 13 | **1,46** |
| après | **4** | 12 | **0,33** |

Les tués au combat perdent un seul mort sur treize (−8 %, sous le plafond de
10 % qu'on s'était donné) : c'est bien le soin qui a changé, pas le combat. Sur
le détail, les six morts sur le brancard et les quatre morts pendant que la
colonie dormait ont disparu ; ce qui reste tient aux blessés que plus personne
ne peut atteindre.

**Mesure, campagne** (`campaign --seeds 30 --difficulty 2 --size 64`, le même
joueur scripté, la même révision du sim, avec et sans la tranche — un vrai
témoin, à un `git checkout` de `jobs.rs` près, ce que ne serait pas une
comparaison avec la campagne de référence du §2, mesurée sur une révision
antérieure) :

| | morts, total | dont raid | dont blessures | rapport | colonies éteintes |
|---|---|---|---|---|---|
| **12 jours**, contrôle | 85 | 57 | 24 | **0,42** | 4/30 |
| **12 jours**, après | 79 | **61** | **13** | **0,21** | **2/30** |
| **30 jours**, contrôle | 210 | 149 | 52 | **0,35** | 13/30 |
| **30 jours**, après | 208 | **171** | **29** | **0,17** | 16/30 |

**La cible du rapport — sous 0,25 — est tenue aux deux horizons**, et les tués
au combat ne baissent pas : ils *montent* (+7 % à douze jours, +15 % à trente),
à nombre de raids et de bandes inchangé (2,6 puis 6,2 raids par colonie de part
et d'autre). Le plafond qu'on s'était donné — « pas plus de 10 % de tués au
combat en moins » — est donc franchi du bon côté, et l'explication n'a rien de
mystérieux : **un colon pansé se relève, reprend les armes, et peut mourir au
raid suivant.** Une mort d'hémorragie évitée n'est pas une vie sauvée, c'est une
mort déplacée vers un endroit où le joueur, lui, peut faire quelque chose.

Le bilan net est franchement bon à douze jours (deux colonies éteintes contre
quatre, 2,4 colons vivants contre 2,2) et neutre à trente (210 morts contre 208,
mais seize colonies éteintes contre treize — un écart de trois colonies sur
trente, dans le bruit d'un tirage à cette taille). C'est cohérent avec la suite
du rapport : à trente jours, ce qui éteint une colonie n'est plus le soin, c'est
la menace qui n'escalade pas (§5) et l'armement qui ne suit pas (§8, biais n°9).

**Ce qui n'a pas été touché** : aucun objet de soin (bandage, médicaments),
aucun `WorkType` de plus — en ajouter un changerait `WORK_TYPES` et les tampons
de priorités du client. `TEND_STEP` reste neutre.

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
