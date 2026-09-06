# Campagnes d'équilibrage — constatations

Mesures produites par `cargo run -p sim-cli --release -- campaign`
(`crates/sim-cli/src/campaign.rs`). Rapport écrit le 2026-09-05 sur la révision
de travail de la phase 2c, puis annoté tranche par tranche le même jour
(rangement, difficulté, menace, feu, soins) et les 2026-09-06 suivants (postes
hors d'atteinte, index de régions, cuisine). **Remis à plat le 2026-09-06**,
révision `661d1b3` (`git log --oneline -1`) : le résumé et le §2 donnent
maintenant l'état du 2026-09-06, mesuré sur cinq nouvelles campagnes de
référence (mêmes graines, mêmes commandes), avec les chiffres du 2026-09-05
gardés à côté sous « avant réglages ». Les §3 à §7 ne sont **pas** retouchés :
ils portent l'historique de chaque correction, écrit au moment où elle a été
faite. Le détail graine par graine des campagnes du 2026-09-06 est au §9, et
la suite du même jour — les trois graines lentes élucidées, la chaîne du métal
et la diplomatie enfin mesurées — au **§10**. Le **§11**, écrit dans la foulée,
corrige le **joueur scripté** lui-même sur trois points (forge et minage,
tuniques d'automne, apprivoisement) et donne l'effet mesuré de chacun ; le
tableau d'arrivée des cinq campagnes est au §2, sous « Joueur scripté corrigé
le 2026-09-06 ».

**Ce document mesure, il ne règle rien.** Aucune constante du sim n'a été
touchée pour l'écrire. Chaque constat porte une proposition chiffrée, à
éprouver par un test statistique sur plusieurs graines avant d'être appliquée
(règle « on mesure avant de régler », `AGENTS.md`).

Les constats d'origine, eux, ont été traités **le même jour** (2026-09-05) ;
chacun porte alors une section « après réglage » qui donne les chiffres
d'arrivée, mesurés de la même façon, et dit ce qui a été essayé puis rejeté en
route. La proposition d'origine reste écrite telle quelle : plusieurs se sont
révélées fausses à la mesure, et c'est le genre de chose qu'on regrette d'avoir
effacée. Trois défauts de performance, distincts des cinq constats
d'équilibrage, ont été corrigés depuis (§3 : inhumation le 2026-09-05, postes
hors d'atteinte et index de régions le 2026-09-06) — c'est ce qui fait tourner
les cinq campagnes ci-dessous en moins d'une minute chacune au lieu de
plusieurs dizaines de minutes.

## Les cinq constats, en une ligne chacun

1. **Rangement** (**corrigé le 2026-09-05**, voir le journal du plan) — dès qu'un entrepôt est plein, chaque colon relance un
   balayage complet de la carte **par pile au sol et par tick** : 1 870 fois
   plus lent à 60 piles. Défaut du sim, pas réglage. (§3) — état au
   2026-09-06 : tient toujours (`Map::stockpile_tiles` et `attempts` bornés
   dans `try_start_haul`, voir le code) ; combiné à l'index de régions, la
   campagne normale tourne maintenant en **28,8 s** contre les dizaines de
   minutes d'origine (§9).
2. **Difficulté** (**réglée le 2026-09-05**, voir « Après réglage » en §4) —
   « difficile » éteignait **30 colonies sur 30**, 25 avant le jour 10 : le
   premier raid y faisait trois pillards armés contre trois colons qui n'ont pas
   encore d'arme. La première bande est maintenant plafonnée à deux têtes à
   toutes les difficultés : 24 colonies sur 30 passent le jour 10 et 8 voient le
   jour 30. (§4) — état au 2026-09-06 : tient toujours, mesuré à nouveau
   (§9) : **24/30** au jour 10 (identique), **7/30** encore vivantes au jour 30
   (8/30 le 2026-09-05, dans le bruit d'une campagne à trente graines).
3. **Menace** (**réglée le 2026-09-05**, voir « Après réglage » en §5) — une
   bande valait 1,9 pillard au premier raid comme au neuvième : tripler sa
   richesse ne changeait la taille des raids que de 3 %. La richesse compte
   maintenant **deux fois** au-delà de 2 000, et une colonie trois fois plus
   riche reçoit une tête de plus. (§5) — état au 2026-09-06 : tient toujours,
   2,2 à 2,3 pillards par bande sur les cinq campagnes (§9), contre 1,7 à 2,0
   le 2026-09-05.
4. **Feu** (**réglé le 2026-09-05**, voir « Ce qui a été fait » en §6) — médiane
   3 cases brûlées, maximum 2 339 sur une carte qui en compte 4 096, et rien
   entre les deux. Le feu suit maintenant le vent : le pire incendie de la
   campagne normale tombe à 534 cases (13 %), et la tranche « quelques dizaines
   de cases », jusque-là vide, se remplit. (§6) — état au 2026-09-06 : tient
   toujours, et même mieux : maximum à **121 cases (3 %)** en normale sur la
   nouvelle mesure (§9), médiane à 2.
5. **Soins** (**corrigé le 2026-09-05**, voir le journal du plan) — pour deux
   colons tués au combat, un troisième mourait de ses plaies après, faute de
   débit de pansement. Rapport stable à 0,5. (§7) — état au 2026-09-06 : tient
   toujours et s'est amélioré : rapport blessures/raid à **0,13** en normale
   sur la nouvelle mesure (§9), contre 0,55 le 2026-09-05 et 0,17 le
   2026-09-05 après réglage — la médecine à trois technologies (constat
   ouvert n°3 ci-dessous) y est sans doute pour quelque chose.

## Constats ouverts au 2026-09-06

Cinq points, chiffrés sur les campagnes du §9, chacun rattaché à une
constante ou un mécanisme précis, avec une proposition **non appliquée**.
Trois d'entre eux ont été repris le **2026-09-06 dans la journée** (§10) : le
n°2 est corrigé, les n°3 et n°5 sont mesurés — leur texte d'origine est gardé
tel quel, suivi de ce que la mesure a donné, y compris quand elle contredit
l'hypothèse écrite. Les n°1, n°3 et n°4 ont ensuite été traités **dans le
joueur scripté**, le même jour : voir le **§11**, qui donne le détail de
chaque correction et son effet mesuré, et le §2 pour le tableau d'arrivée.

1. ~~**La campagne automne-hiver s'est effondrée depuis le 2026-09-05.**~~
   **Corrigé pour moitié le 2026-09-06, voir §11.2.** Le texte d'origine :
   28/30 colonies éteintes contre 12/30 alors, et surtout **0 colon armé sur
   74 vivants au total, sur les 30 graines** (19/55 le 2026-09-05) : aucune
   graine ne finit avec un arc ou une épée en main. C'est la seule des cinq
   campagnes qui démarre en automne (`--day-of-year 30`, `SetCalendar`), donc
   la seule où l'objectif « une tunique par colon » (`craft::plan`, §1) est
   posé **dès le tick 0** et le reste toute la partie de trente jours ; il se
   dispute le même `WorkType::Build` — et la même réserve de bois — que
   l'enceinte, la forge et les arcs (`craft::RECIPES`, `crates/sim/src/craft.rs`).

   **L'hypothèse était la bonne, et le correctif tient.** La tunique ne part
   plus qu'après un arc par colon **et** l'enceinte payée : les colons armés
   passent de **0 sur 4** à **5 sur 16**, le stock de vivres de **0,0** à
   **8,1 jours**, les colons au jour 20 de 0,7 à 1,1, et l'extinction de
   **28/30 à 24/30**. Ce qui reste ouvert est le rapport à la campagne
   normale : 24/30 contre 11,8/30 de moyenne en normale (§2), soit **2,0 fois**
   — la cible du jour était « au plus le double », elle est atteinte de
   justesse et pas avec de la marge. L'automne-hiver reste la campagne la plus
   dure des cinq, et c'est probablement dans l'ordre des choses : rien n'y
   pousse. Reste à trancher : les morts de froid **montent** légèrement (6 → 8
   sur 182), ce qui est la contrepartie assumée de la tunique retardée. À
   mesurer avant de régler : une variante où la tunique redevient prioritaire
   **en hiver seulement** (saison 3), l'arc étant déjà en main à ce
   moment-là.
2. ~~**Des graines retombent sous le seuil de perf promis par l'index de
   régions.**~~ **Corrigé le 2026-09-06, voir §10.1.** Le §3 visait « aucune
   graine sous 100 000 ticks/s » ; trois graines n'y étaient plus :
   chaude/graine 8 à **58 584 ticks/s**, normale/graine 12 à **79 734**,
   froide/graine 8 à **97 253** (§9). **L'hypothèse écrite ici — le balayage
   minier de la métallurgie — était fausse** : quatorze des quinze graines qui
   atteignent la métallurgie n'ont pas un seul rocher dans le rayon de minage,
   le balayage ne trouve rien et ne coûte rien. Le vrai coupable était l'ordre
   des questions dans `try_start_butcher`, `try_start_cook` et
   `try_start_tame` — la charge cherchée avant l'endroit où la porter — soit
   98 % des A\* de la graine chaude 8, et des A\* qui **aboutissent**, donc
   invisibles à l'index de régions. Les trois graines sont maintenant à
   173 285, 181 665 et 240 668 ticks/s, aucune graine des cinq campagnes n'est
   sous 100 000, et le tableau du §9 est identique colonne par colonne.
3. **Le rapport ne voit ni la forge, ni le minerai, ni l'épée.** `research.rs`
   compte maintenant six technologies (`Tech::ALL`, `Preservation`, `Archery`
   et `Masonry` en plus des trois d'origine) et le joueur scripté en vise
   trois — Agriculture, Médecine, **Métallurgie** — contre deux le 2026-09-05 ;
   la distribution des technologies acquises passe d'un chiffre binaire 0/2 à
   surtout 0/3 (15/30 colonies à trois technologies en campagne normale, §9).
   Mais `campaign --json` n'exporte ni `Map::forge_count()`, ni le nombre
   d'épées produites ou portées : impossible de dire si une colonie qui
   recherche la métallurgie bâtit sa forge avant de mourir, ou si la
   recherche est un investissement perdu. Proposition : ajouter
   `forges_built` et `swords_equipped` aux champs JSON de `Run`
   (`crates/sim-cli/src/campaign.rs`).

   **Corrigé le 2026-09-06, voir §11.1 — la chaîne démarre enfin, mais elle
   s'arrête au lingot.** Les deux blocages du joueur scripté sont levés : la
   forge se plante hors entrepôt, le rayon de minage s'élargit jusqu'au
   premier rocher atteignable, et l'entrepôt s'agrandit pour que le minerai
   ait une case à lui. Campagne normale, sur les **14** colonies qui paient la
   métallurgie : **11 bâtissent leur forge** (contre 1 sur 15), **6 fondent au
   moins un lingot** (contre 0), **1 forge une épée** (contre 0). Sur les cinq
   campagnes : 36 forges, 49 lingots, 2 épées, contre 4 forges, 0 lingot,
   0 épée. La moitié qu'on visait est tenue pour la forge (11/14), tenue de
   justesse pour le lingot (6/14), **manquée pour l'épée** (1/14, on visait
   un quart). Le pourquoi est chiffré au §11.1 : une épée demande quatre
   lingots, donc douze minerais, donc cinq veines minées **et** ramenées, dans
   une colonie qui reçoit 6,6 bandes en trente jours. Un contrôle en
   **soixante** jours ne règle rien — 27 colonies sur 30 sont éteintes au
   jour 60 —, ce qui répond à la question laissée ouverte ci-dessous : ce
   n'est pas la durée qui manque, c'est la survie.

   Le texte de la mesure du 2026-09-06 (§10.2) reste ci-dessous tel quel.

   **Mesuré le 2026-09-06 (§10.2), et la réponse est franche : la recherche
   est un investissement perdu.** `campaign` exporte désormais forges,
   lingots, épées produites, épées portées et jour d'acquisition de la
   métallurgie. Quinze colonies sur trente paient la métallurgie (jour 16 en
   moyenne), **une seule** pose sa forge, **aucune** ne fond un lingot ni ne
   forge une épée ; la seule épée de la campagne a été ramassée sur un pillard
   mort par un colon qui n'a **aucune** technologie. Deux blocages du joueur
   scripté, indépendants, expliquent tout : la forge est proposée sur trois
   cases **de l'entrepôt**, que `Command::Build` refuse dès qu'elles portent
   une pile, et il n'y a aucun rocher dans `MINE_RADIUS` sur quatorze des
   quinze graines. Le constat reste ouvert sur ces deux réglages, qui ne sont
   pas appliqués (ils déplaceraient le tableau du §9).
4. ~~**L'apprivoisement n'aboutit que dans un quart des colonies.**~~
   **Mesuré et corrigé le 2026-09-06, voir §11.3 — et ce n'était ni le seuil
   de baies ni la traque.** Le texte d'origine : le joueur scripté le tente
   dès le jour 8 si les baies dépassent 30 (`TAME_DAY`, `TAME_BERRIES`) ; le
   taux de réussite reste bas et stable sur les cinq campagnes : 7/30, 5/30,
   7/30, 8/30, et 1/30 en automne-hiver (§9) — jamais la majorité, même en
   trente jours. Proposition : compter, dans le harnais, les `Command::Tame`
   envoyés face aux marquages qui aboutissent réellement.

   **Le comptage a été ajouté** (`Run::tame_orders` et `Run::tamed`, au
   résumé et au JSON), et il dit autre chose que ce qu'on cherchait :
   l'apprivoisement **marche**. Campagne normale, joueur corrigé : **78
   marquages, 50 bêtes effectivement apprivoisées** — et pourtant seulement
   **10 colonies sur 30** finissent avec du bétail. Cinquante bêtes prises,
   dix qui restent : **quarante meurent**. La contre-épreuve est nette et
   tient en une commande — la même campagne en `--difficulty 0`, où le
   storyteller n'envoie aucune bande : **26 marquages, 24 bêtes prises, 24
   colonies vivantes sur 29 avec du bétail**, c'est-à-dire *toutes* celles qui
   ont apprivoisé. Ce n'est donc pas le marquage qui borne le bétail, c'est le
   **raid** (voir §11.3 pour ce que ça dit du sim et la proposition qui va
   avec).
5. ~~**La réputation et le tribut ne sont mesurés nulle part.**~~ **Mesurés le
   2026-09-06, voir §10.2.** `plan` envoie un tribut dès qu'une tribu déteste
   la colonie (`GIFT_GOODWILL` = −40, §1), et le rapport exporte maintenant la
   réputation finale **envers chacune des trois factions** — une moyenne
   d'ensemble mélangerait ceux qui nous attaquent et celui qui nous vend du
   grain — ainsi que les tributs offerts. Ce qu'on y lit : la réputation bouge
   vraiment (Guilde à **+43** en moyenne, tribus à −17,6 et −15,1, de −46 à
   +11 selon la graine), mais le tribut reste rare — **18** en campagne
   normale, concentrés sur **cinq** colonies sur trente, faute d'atteindre à
   la fois le seuil de −40 et les 80 bois qu'il exige. Reste ouvert, pour
   trancher son utilité : compter en face la réputation **perdue** par raid.

---

## 1. La méthode

### Le joueur scripté

`campaign::plan` est une fonction **pure** de la `Sim` vers une liste de
`Command`, appelée toutes les `PLAN_INTERVAL` (600) ticks — dix secondes de jeu.
Elle n'a aucune mémoire : « le feu de camp est-il déjà bâti ? » se relit dans la
carte, ce qui la rend idempotente, testable et déterministe. Ce qu'elle fait,
dans cet ordre :

Les lignes marquées **(2026-09-06)** ont changé ce jour-là : voir le **§11**,
qui dit ce qui a été corrigé et ce que la mesure a donné.

| Étape | Déclencheur | Ce qui part |
|---|---|---|
| Zones | une seule fois | stockage 4×4, culture 5×5 |
| Coupe | tant que `bois < 100` | rectangle 21×21 autour du repère |
| Récolte | un passage sur dix | rectangle 51×51 |
| Priorités | une seule fois | un cultivateur, un bâtisseur (priorité 1) |
| Confort | `bois ≥ 40` | feu de camp, un lit par colon, poste de fabrication |
| Enceinte | `bois ≥ 100` | porte **puis** l'enceinte de bois (48 cases de pourtour), puis 3 pièges devant la porte |
| Recherche | jour 5, `bois ≥ 40` | établi, puis agriculture, médecine, métallurgie |
| Entrepôt **(2026-09-06)** | métallurgie acquise | l'entrepôt passe de 4×4 à 6×6 : le minerai a besoin d'une case à lui |
| Minage **(2026-09-06)** | métallurgie acquise | veines d'abord, rochers ordinaires tant que la pierre manque ; rayon **élargi** de 12 cases jusqu'à la carte entière, quatre marques à la fois |
| Forge **(2026-09-06)** | métallurgie et `pierre ≥ 25` | une case libre **hors entrepôt et hors culture**, sans pile ni élément, atteignable ; une autre au passage suivant si le plan n'est pas sorti |
| Fabrication **(2026-09-06)** | permanent | un arc par colon (objectif qui ne redescend jamais) ; la tunique **seulement après** un arc par colon **et** l'enceinte payée ; lingots et épée dès que la forge est debout |
| Chasse | `viande + repas < 10 × colons` | une bête à la fois, la plus proche **atteignable** |
| Élevage **(2026-09-06)** | `baies ≥ 30` (plus de jour fixe) | un lapin, à défaut un cerf ; marque relevée dès qu'elle ne peut plus rien donner, changement de bête tous les deux jours tant que rien n'est pris |
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
joueur scripté. « avant réglages » reprend telles quelles les mesures du
2026-09-05 (avant les cinq corrections des §3-§7) ; « après » est la mesure du
2026-09-06, révision `661d1b3`, cinq campagnes relancées avec les mêmes graines
et les mêmes commandes (§9 pour le détail graine par graine et les JSON bruts).

| | normale (avant) | normale (après) | difficile (avant) | difficile (après) | froide (avant) | froide (après) | chaude (avant) | chaude (après) | automne-hiver (avant) | automne-hiver (après) |
|---|---|---|---|---|---|---|---|---|---|---|
| colonies éteintes | 14/30 | 6/30 | **30/30** | 23/30 | 12/30 | 19/30 | 20/30 | 16/30 | 12/30 | **28/30** |
| colonies à ≥ 3 colons | 10/30 | **17/30** | 0/30 | 2/30 | 10/30 | 9/30 | 6/30 | 10/30 | 13/30 | **1/30** |
| colons vivants (moy. fin) | 1,6 | 2,5 | 0,0 | 0,6 | 1,6 | 1,1 | 0,9 | 1,4 | 1,8 | **0,1** |
| colons au jour 10 / 20 | 2,3 / 1,8 | 3,0 / 2,8 | 0,2 / 0,0 | 2,4 / 1,6 | 2,0 / 1,5 | 2,2 / 1,4 | 2,2 / 1,2 | 3,0 / 1,9 | 2,3 / 1,8 | 1,6 / 0,7 |
| morts au total | 187 | 200 | 118 | 202 | 187 | 186 | 177 | 193 | 180 | 169 |
| dont raid / blessures | 57 % / 31 % | 86 % / 11 % | 77 % / 14 % | 84 % / 13 % | 56 % / 37 % | 80 % / 18 % | 61 % / 29 % | 81 % / 17 % | 60 % / 27 % | 76 % / 14 % |
| dont froid | 0 % | 0 % | 0 % | 0 % | 2 % | 0 % | 0 % | 0 % | 6 % | 4 % |
| raids reçus / colonie | 5,9 | 6,8 | 2,0 | 5,7 | 6,1 | 5,1 | 5,0 | 6,0 | 6,1 | 3,9 |
| raids repoussés (part) | n.d. | 98 % | n.d. | 92 % | n.d. | 95 % | n.d. | 96 % | n.d. | 86 % |
| pillards par bande | 1,9 | 2,2 | 2,7 | 2,3 | 1,7 | 2,3 | 1,9 | 2,3 | 2,0 | 2,2 |
| richesse finale (moy.) | 1 436 | 2 196 | 332 | 1 244 | 2 562 | 2 093 | 1 018 | 1 503 | 3 240 | 1 288 |
| vivres en stock (jours) | 10,2 | 14,0 | 0,0 | 2,4 | 20,5 | 13,0 | 5,6 | 5,8 | **30,1** | **0,0** |
| technologies acquises (moy.) | 0,8 | 1,57 | 0,0 | 1,13 | 0,8 | 0,77 | 0,8 | 0,87 | 0,8 | 0,87 |
| bétail (colonies à ≥ 1) | n.d. | 7/30 | n.d. | 5/30 | n.d. | 7/30 | n.d. | 8/30 | n.d. | 1/30 |
| feux (départs) | 71 | 76 | 60 | 65 | 39 | 31 | 76 | 96 | 33 | 29 |
| cases brûlées (total) | 8 877 | 309 | 13 818 | 1 021 | 39 | 31 | 9 835 | 966 | 33 | 28 |
| colons armés / vivants | 23/49 | 43/74 | 0/0 | 12/18 | 25/49 | 14/34 | 16/28 | 25/43 | 19/55 | **0/4** |
| humeur finale (vivantes) | 52 % | 53 % | — | 40 % | 35 % | 31 % | 49 % | 52 % | 51 % | 40 % |

### Joueur scripté corrigé le 2026-09-06

Le tableau ci-dessus est celui du joueur scripté **d'avant** les trois
corrections du §11 (forge et minage, tuniques, apprivoisement). Voici les mêmes
cinq campagnes, mêmes graines, mêmes commandes, avec le joueur corrigé — c'est
la colonne à lire aujourd'hui. Les chiffres du 2026-09-06 « après » ci-dessus
restent le point de comparaison.

| | normale | difficile | froide | chaude | automne-hiver |
|---|---|---|---|---|---|
| colonies éteintes | 12/30 | 17/30 | 20/30 | 13/30 | **24/30** |
| colonies à ≥ 3 colons | 10/30 | 6/30 | 5/30 | 13/30 | 3/30 |
| colons vivants (moy. fin) | 1,7 | 1,1 | 0,9 | 1,7 | 0,5 |
| colons au jour 10 / 20 | 2,9 / 2,5 | 2,4 / 1,6 | 2,1 / 1,0 | 2,9 / 2,1 | 2,0 / 1,1 |
| morts au total | 209 | 216 | 182 | 191 | 182 |
| dont raid / blessures | 83 % / 14 % | 82 % / 15 % | 81 % / 16 % | 84 % / 12 % | 79 % / 12 % |
| dont froid | 0 % | 0 % | 0 % | 0 % | 4 % |
| raids reçus / colonie | 6,6 | 6,5 | 4,7 | 6,4 | 4,5 |
| raids repoussés (part) | 97 % | 94 % | 93 % | 97 % | 92 % |
| pillards par bande | 2,2 | 2,3 | 2,2 | 2,2 | 2,4 |
| richesse finale (moy.) | 1 842 | 1 611 | 2 175 | 1 696 | 1 791 |
| vivres en stock (jours) | 11,3 | 4,4 | 19,5 | 11,6 | **8,1** |
| technologies acquises (moy.) | 1,47 | 1,23 | 0,90 | 1,30 | 0,47 |
| bétail (colonies à ≥ 1) | **10/30** | 8/30 | 9/30 | **11/30** | **9/30** |
| bétail (colonies **vivantes**) | **8/18** | 4/13 | 7/10 | **10/17** | 3/6 |
| marquages → bêtes prises | 78 → 50 | 67 → 41 | 68 → 45 | 80 → 58 | 70 → 43 |
| feux (départs) | 72 | 72 | 40 | 102 | 32 |
| cases brûlées (total) | 1 446 | 218 | 40 | 1 065 | 32 |
| colons armés / vivants | 32/52 | 20/32 | 17/27 | 33/52 | **5/16** |
| **forges / lingots / épées** | **11 / 16 / 1** | 5 / 6 / 0 | 7 / 13 / 1 | 10 / 9 / 0 | 3 / 5 / 0 |
| **colonies à la métallurgie : forge / lingot / épée** | **11 / 6 / 1 sur 14** | 5 / 3 / 0 sur 9 | 7 / 6 / 1 sur 7 | 10 / 4 / 0 sur 12 | 3 / 2 / 0 sur 3 |
| humeur finale (vivantes) | 46 % | 45 % | 37 % | 48 % | 38 % |
| durée totale, 30 graines | 34,7 s | 30,9 s | 24,5 s | 32,5 s | 31,6 s |
| ticks/s moyen | 373 487 | 419 879 | 529 217 | 399 334 | 410 048 |
| graine la plus lente | 15 : 101 360 | 15 : 111 225 | 11 : 162 040 | 6 : 126 463 | 6 : 105 597 |

Le critère de perf du §3 tient toujours : **aucune graine sous 100 000
ticks/s**, la pire à 101 360. Le joueur corrigé mine, ce qui promène les colons
plus loin, et il perd donc environ 15 % de débit sur la campagne normale
(449 938 → 373 487 ticks/s) : c'est du travail utile en plus, pas une
régression de code.

Deux garde-fous de bonne foi tiennent toujours sur les cinq campagnes du
joueur corrigé : la colonne « morts inexpliquées » est restée à **0**, et le
total des morts déduites égale exactement celui annoncé par le sim
(209 = 209, 216 = 216, 182 = 182, 191 = 191, 182 = 182), `lost_events` = 0
partout.

**Comment lire les écarts d'extinction.** Ils sont, pour l'essentiel, du bruit
de graine, et il faut le dire avant de commenter quoi que ce soit. Mesuré
exprès (quatre blocs de trente graines, `--seed 1 / 31 / 61 / 91`, campagne
normale, même binaire des deux côtés) :

| bloc de graines | éteintes, joueur d'avant | éteintes, joueur corrigé |
|---|---|---|
| 1 → 30 | **6/30** | 12/30 |
| 31 → 60 | **15/30** | 14/30 |
| 61 → 90 | 13/30 | **9/30** |
| 91 → 120 | 11/30 | 12/30 |
| **moyenne** | **11,3/30** | **11,8/30** |

Le joueur d'avant va de 6 à 15 colonies éteintes selon le bloc de graines : un
écart de neuf colonies sur trente, **sur le même code**. Les deux joueurs sont
à un demi-point l'un de l'autre en moyenne, ce qui veut dire qu'aucune des
trois corrections ne change la survie — ni en bien ni en mal — et que le
« 6/30 → 12/30 » du bloc 1 ne dit rien d'autre que « le bloc 1 était clément
pour l'ancien joueur ». Les colonnes qui, elles, sortent franchement du bruit
sont le bétail (7/30 partout avant, 8 à 12/30 après) et la chaîne du métal
(1 à 2 forges par bloc avant, 6 à 11 après ; **zéro** lingot avant, 6 à 18
après).

Perf (mesurée sans contention cette fois, une campagne à la fois, contre les
cinq en même temps le 2026-09-05 — §1) :

| | normale | difficile | froide | chaude | automne-hiver |
|---|---|---|---|---|---|
| durée totale, 30 graines | **28,8 s** | 17,0 s | 29,3 s | 30,4 s | 16,5 s |
| ticks/s moyen | 449 938 | 760 474 | 442 155 | 426 007 | 784 409 |
| graine la plus lente | 12 : **79 734** ticks/s | 8 : 175 041 | 8 : 97 253 | 8 : **58 584** | 11 : 195 034 |

Ces trois chiffres en gras sont ceux du constat ouvert n°2, **corrigé le même
jour** : voir le §10.1 pour la cause et les vitesses d'arrivée (aucune graine
sous 100 000 ticks/s). Le reste du tableau, lui, ne bouge pas d'une colonne —
c'est la condition qu'on s'était fixée.

La ligne « technologies acquises » se lit avec une réserve encore plus forte
qu'avant : `research.rs` compte maintenant **six** technologies (`Tech::ALL` :
Agriculture, Médecine, Préservation, Archerie, Maçonnerie, Métallurgie), le
joueur scripté en vise **trois** (agriculture, médecine puis métallurgie,
`plan` §1), jamais les six. Le résultat, toujours binaire, a changé de forme :
sur les trente graines de la campagne normale, quatorze colonies en ont zéro,
quinze en ont exactement **trois** (Métallurgie comprise) et une seule s'arrête
à deux — contre « zéro ou deux, jamais un seul cas intermédiaire » le
2026-09-05. Une colonie qui pose son établi et survit assez longtemps
recherche maintenant jusqu'à la forge ; voir le constat ouvert n°3 en tête de
ce document sur ce que ces trois technologies produisent réellement (forge
bâtie, épée en main).

Deux vérifications de bonne foi tiennent toujours sur les cinq nouvelles
campagnes : la colonne « morts inexpliquées » est restée à **0**, et le total
des morts déduites égale exactement celui annoncé par le sim (200 = 200,
202 = 202, 186 = 186, 193 = 193, 169 = 169). Aucun événement n'a été perdu
(`lost_events` = 0 partout).

Une graine sur trente (la 7, en 64×64) ne reçoit **toujours aucun** raid des
trente jours et perd ses trois colons de faim, à l'identique dans les cinq
campagnes (`raids: 0`, `deaths: {"famine": 3}` dans les cinq JSON) : la colonie
y naît sur un morceau de terre isolé, où `find_entry_tile` ne trouve pas
d'entrée. Il ne fausse rien, mais il rappelle qu'une carte sur trente est
injouable telle quelle.

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

### Le même défaut ailleurs : le poste hors d'atteinte (corrigé le 2026-09-06)

**C'est un défaut du sim, pas un réglage** — le troisième de la famille, après
le rangement et la lutte contre le feu (§6, « Le coût de la lutte »).

Profil `sample` sur une graine de campagne tombée à **2 600 ticks/s** : **88 %
des piles** dans `do_butcher` → `path_adjacent_for` → `path::find_path_for`.
Le mécanisme, une fois de plus, est celui de l'A\* qui **échoue** : il explore
toute la région où se tient le colon avant de rendre `None`, là où celui qui
aboutit s'arrête sur sa cible.

Ce qui le déclenchait est particulier à cette famille de travaux : un job qui
vise un **poste** (poste de fabrication, forge, feu de camp) retenait le poste
le plus proche de sa charge **sans vérifier qu'un chemin y menait**. Le colon
partait chercher sa dépouille, la ramassait, découvrait le mur dans `do_butcher`,
la reposait — et recommençait au tick suivant, huit A\* ratés à chaque tour (une
par voisine du poste). Un poste muré, ou simplement laissé hors de l'enceinte
qu'on vient de fermer, suffisait. Les recherches qui visent un poste sans rien
porter (`try_start_research`) ou une cible mouvante (`try_start_hunt`) avaient
la même note sans même la boucle : six candidats fois huit voisines, quarante-
huit A\* ratés par tick et par colon inactif.

Trois pièces, les mêmes partout, dans `crates/sim/src/jobs.rs` :

1. **Le poste est vérifié au démarrage** (`Sim::reach_station`) : on retient le
   plus proche **atteignable**, départagé par `(distance, x, y)` comme partout
   ailleurs. Plus de ramasse-repose.
2. **Un budget par recherche.** `PATH_ATTEMPTS` = 6 **candidats examinés** pour
   tout l'appel — et non six A\*, sans quoi un poste muré (huit voisines) serait
   indémontrable, donc jamais inscriptible au tableau des inatteignables. Une
   liste locale à l'appel retient les postes démontrés hors d'atteinte : la
   démonstration coûte cher et ne dépend pas de la charge à porter.
3. **Une cadence de réessai, pour le colon qui tourne à vide.**
   `jobs::RETRY_TICKS` = 30 : entre deux essais, ni les murs, ni les postes, ni
   les régions de la carte ne bougent. **Sans état ajouté** —
   `(tick + pawn.id) % 30` et `Pawn::idle_ticks`, tous deux déjà sérialisés,
   rien de plus au snapshot — et la phase est décalée par colon, ce qu'on ne
   pouvait pas faire pour le feu (§6) : aucun de ces travaux n'enchaîne deux
   questions dans le même tick.

   La condition « à vide » n'est pas un raffinement, c'est une correction.
   Freinée sans condition, la cadence ne faisait pas attendre le colon : elle le
   faisait **tomber sur le travail suivant** de `WorkType::ORDER`, où la
   recherche à l'établi est avant-dernière et le rangement dernier. Mesuré sur
   les trente graines : 46 technologies acquises → 22. `Pawn::idle_ticks`
   retombe à zéro dès qu'un colon prend un chemin : celui qui enchaîne les
   besognes cherche à chaque tick comme avant, celui qui n'a rien trouvé au
   tick précédent attend son tour.

Traités : dépeçage, fabrication (donc la fonte, même code), recherche à
l'établi, chasse, réarmement des pièges, abattage et apprivoisement (leur
cadence se pose au dispatch de `WorkType::Farm`).

**Pas la cuisine**, et c'est instructif. Elle a le même défaut — le feu de camp
retenu sans vérification, la découverte du mur dans `do_cook` — mais c'est le
seul de ces travaux que le scénario `demo` exerce, donc le seul qui ne puisse
pas recevoir la cadence sans déplacer le hash de référence. La vérification lui
a été posée seule, puis retirée : **sans cadence, elle coûte plus cher que la
boucle qu'elle supprime** (graine 3 de la campagne, 71 000 → 581 000 A\*). La
boucle ne se paie qu'une fois par aller-retour du colon ; la vérification, elle,
se paie à **chaque** recherche. Les trois pièces vont ensemble ou pas du tout.

### Mesure (après) — le poste hors d'atteinte

Banc : `crates/sim/tests/jobs_perf.rs`. Un réduit de roche à dix cases de trois
colons, le poste de fabrication au milieu ; ses huit voisines sont
franchissables et pourtant hors d'atteinte — c'est le pire cas. Soixante
dépouilles au sol, un objectif d'arcs et le bois pour un. 600 ticks, `release` :

| scène | A\* avant | A\* après | ticks/s avant | ticks/s après |
|---|---|---|---|---|
| 96×96, 60 dépouilles | 2 718 | **634** | 377 | **1 549** |
| 96×96, 10 dépouilles | 2 718 | **634** | 382 | **1 564** |
| 192×192, 60 dépouilles (200 ticks) | 306 | **136** | 269 | **586** |

(A\* toutes recherches confondues, comptées par un compteur posé dans
`path::find_path_for` le temps de la mesure ; le test, lui, lit
`Sim::job_paths`, qui ne compte que les recherches bornées : 629 des 634.)
Le plafond que le test impose vaut `colons × recherches × (poste + candidats) ×
ticks / RETRY_TICKS` = 1 680 ; la mesure est à 629, et elle ne bouge ni avec le
nombre de dépouilles ni avec la surface. Un poste atteignable ajouté à la scène
est bien utilisé : la viande tombe au pied du poste dans les mêmes 600 ticks.

### Ce qui reste (non traité)

**La campagne de trente graines ne valide pas ce correctif, et il faut le dire
net.** Elle passe de 1 100 s à **921 s**, mais le critère « aucune graine sous
100 000 ticks/s » n'est **pas** atteint : les cinq mêmes graines (3, 6, 8, 12,
18) restent lentes, la pire à 832 ticks/s.

| | avant | après |
|---|---|---|
| campagne, 30 graines × 30 jours | 1 100 s | **921 s** |
| graines sous 100 000 ticks/s | 5 | 5 |
| graine la plus lente | 8, **1 058 ticks/s** | 8, **832 ticks/s** |
| colons vivants au jour 30 | 52 | **69** |
| technologies acquises | 46 | **50** |

Deux raisons, et aucune n'est un détail. D'abord, ces graines sont dominées par
des A\* qui échouent venus de recherches **hors de ce constat**. Ensuite, la
comparaison au chronomètre est faussée : les colonies ne meurent plus au même
moment. La graine 8 met 519 s au lieu de 408 — et finit avec **trois colons
vivants au lieu de zéro**. Une colonie éteinte au jour 12 simule dix-huit jours
de ticks vides ; une colonie vivante travaille, et cherche, jusqu'au bout.

Compteurs par site d'appel, posés le temps d'une mesure (A\* sur 432 000 ticks,
carte 64×64). La colonne « après » est celle de la variante où **la cuisine
aussi** avait reçu la vérification du poste : c'est cette mesure-là qui a fait
la retirer, et c'est aussi la seule qui montre ce que la boucle de `do_cook`
coûtait :

| site d'appel | graine 3 avant | graine 3 après | graine 8 avant | graine 8 après |
|---|---|---|---|---|
| `do_butcher` (la boucle du constat) | 374 965 | **12** | 92 849 | **10** |
| `do_cook` (même boucle, cuisine traitée) | 63 251 | **150** | 253 395 | **139** |
| `try_start_hunt` | 937 530 | **3 794** | 4 | 6 |
| `try_start_butcher` | 262 644 | 909 872 | 14 497 | 485 308 |
| `try_start_work` (travail désigné) | 1 134 056 | 307 312 | 19 965 | 155 429 |
| `try_start_farm` | 980 666 | 341 815 | 418 130 | 477 716 |
| `try_start_haul` | 266 427 | 209 945 | 24 270 | 319 892 |
| **total, tous sites** | **4 150 000** | **2 540 000** | 1 150 000 | 1 970 000 |

Ce que ça dit, dans l'ordre :

1. **Les boucles visées sont mortes.** `do_butcher` et `do_cook` passent de
   centaines de milliers d'A\* à une douzaine : le colon ne ramasse plus une
   charge pour la reposer. `try_start_hunt` perd 99,6 % de sa note grâce à la
   seule cadence. (La ligne `do_cook` est celle de la variante retirée : dans le
   code livré, la cuisine garde sa boucle, faute de pouvoir espacer ses essais.)
2. **Le coût s'est déplacé, pas seulement effacé.** `try_start_butcher` monte,
   parce que la vérification du poste se paie à chaque recherche là où la boucle
   se payait à chaque aller-retour. Le solde reste bon quand la cadence mord
   (graine 3 : 4,15 M → 2,54 M d'A\* au total) et il faut la cadence pour cela —
   c'est la démonstration que la cuisine, laissée sans, a faite à l'envers.
3. **Le temps n'y suit pas le compte.** La graine 3 lance 39 % d'A\* en moins et
   met pourtant trois fois plus longtemps : sa colonie survit (quatre colons au
   jour 30 contre trois), s'étend, et chaque A\* qui échoue explore une région
   plus grande. Sur les trente graines, 70 colons vivants à la fin contre 52, et
   50 technologies contre 46 — la simulation fait plus de travail utile.

Ce qui tient les cinq graines lentes, ce sont `try_start_work`,
`try_start_haul`, `try_start_farm` et `try_start_deliver` : elles ne visent pas
un poste mais une désignation, une pile, un chantier, tous **déjà bornés** à
`PATH_ATTEMPTS` candidats. Ce qui les rend chères, c'est l'enceinte que le
joueur scripté referme — tout ce qui reste dehors est à jamais inatteignable, et
chaque colon le redemande.

Deux voies, et une seule est bonne :

1. Étendre `RETRY_TICKS` à ces recherches. Trente fois moins cher dans le cas
   pathologique, mais c'est un **changement de comportement** — un colon
   désœuvré ne chercherait plus de quoi couper qu'un tick sur trente — et le
   hash du scénario `demo` bouge, puisque le scénario exerce précisément ces
   travaux-là. À décider, pas à glisser dans un correctif de performance.
2. **Un index de régions sur `Map`** (composantes connexes, tenues comme
   `refresh_indoor` l'est déjà). Un A\* échoue si et seulement si la cible n'est
   pas dans la région du marcheur : la question devient O(1), la réponse est
   **exactement la même**, et tous les sites du tableau ci-dessus en profitent
   d'un coup — y compris la cuisine, qui pourrait alors recevoir sa
   vérification. C'est la vraie correction, et elle ne change pas une décision
   de colon.

### La vraie correction : l'index de régions (2026-09-06)

C'est la seconde voie qui a été prise, et elle tient ses promesses : la
campagne de trente graines passe de **1 033 s à 31 s**, aucune graine ne reste
sous 100 000 ticks/s, et les trente colonies finissent **ligne pour ligne**
identiques — mêmes morts, mêmes raids, mêmes richesses, mêmes technologies.

Mais elle ne les tient qu'au deuxième essai, et ce que le premier a appris vaut
d'être écrit : **ce n'était pas l'enceinte, c'étaient les pièges.**

#### La structure

`crates/sim/src/regions.rs`, tenu dans `Map` sur le patron de la couche
« intérieur ». Deux couches d'un `u16` par case (0 = infranchissable), une par
sorte de marcheur (`path::Walker`) :

| couche | ce qui ferme | qui la lit |
|---|---|---|
| `anyone` | murs, rochers, eau profonde, arbres, feux de camp, établis. **Les portes ouvrent.** | pillard, bête, marchand |
| `colonist` | la même chose **plus les pièges armés** — un membre de la colonie ne marche jamais dessus | les colons |

La seconde n'est bâtie que s'il y a un piège armé sur la carte ; sinon elle
serait la copie de la première, et les questions y retombent. **Le feu reste
dehors**, et c'est exact : il renchérit la route (`FIRE_PATH_COST_MULT`), il ne
la ferme pas — il ne peut donc jamais rendre une cible inatteignable.

Trois détails qui comptent :

1. **Quatre voisines suffisent** là où l'A\* en a huit. Une diagonale n'est
   prise que si ses deux orthogonales le sont (pas de coupe de coin) : tout
   chemin à huit directions se double d'un chemin à quatre, et les deux
   découpages en composantes sont le même.
2. **L'invalidation suit la franchissabilité, pas la carte.** `set_feature` et
   `set_terrain` périment l'index quand un mur se bâtit, une porte se perce, un
   rocher se mine, un arbre tombe, un piège s'arme ou se désarme — et
   seulement alors. Un buisson cueilli, un plant semé, un sol de bois coulé, un
   lit posé ne périment rien, exactement comme pour `room_key`.
3. **Une couche périmée se tait.** Le recalcul se fait au début de
   `Sim::update`, comme `refresh_indoor` ; si la carte change **pendant** un
   tick, l'index reste périmé pour le reste de ce tick et toute question rend
   « je ne sais pas », donc l'A\* tranche comme avant. C'est ce qui interdit
   qu'une couche en retard refuse un chemin qui vient de s'ouvrir.

Coût de reconstruction, `--release`, comparé à ce qu'il évite :

| carte | une couche | deux couches | un seul A\* **raté** |
|---|---|---|---|
| 64×64 | 0,058 ms | 0,084 ms | 0,29 ms |
| 128×128 | 0,133 ms | 0,218 ms | 1,21 ms |
| 192×192 | 0,224 ms | 0,481 ms | 2,74 ms |

Une reconstruction **complète** coûte le cinquième d'un unique A\* qui échoue,
et elle n'est payée qu'après un changement de carte — une fois par tick au
plus, jamais par colon. La question, elle, coûte 10 ns : deux lectures et une
comparaison.

#### La surprise : ce n'était pas l'enceinte

La première version n'avait que la couche de base — c'était le plan, les pièges
devant rester une exception que l'A\* traiterait comme avant. Mesurée sur la
campagne, elle ne règle presque rien :

| | témoin | couche de base seule | deux couches |
|---|---|---|---|
| campagne, 30 graines × 30 jours | 1 033 s | 885 s | **31 s** |
| graines sous 100 000 ticks/s | 5 | 4 | **0** |
| graine la plus lente | 8, **742 ticks/s** | 8, **837 ticks/s** | 8, **116 756 ticks/s** |

Une seule des cinq graines lentes est guérie (la 6, 14 000 → 296 000 ticks/s) :
celle-là avait bien une cible derrière un mur. Les quatre autres ne bougent
pas.

Profil `sample` sur la campagne en cours, version couche de base : **56 % des
piles** dans `do_cook` → `path_adjacent_for` → `path::find_path_for`, et 41 %
de plus dans `find_job` → `try_start`. Des A\* qui échouent, donc, malgré
l'index — ce qui ne laisse qu'une explication, par élimination : la cible est
dans la même région de base que le colon, et pourtant hors d'atteinte **pour
lui**. Le seul obstacle du sim qui dépend de qui passe est le piège armé.

Et le joueur scripté en pose trois. Relire le tableau du §1 : « porte **puis**
l'enceinte de bois, puis 3 pièges devant la porte ». La porte est l'unique
ouverture d'un pourtour de 48 cases ; les trois cases devant elle sont les
trois seules par où l'on sort — et ce sont précisément celles que la colonie
vient de hérisser de pointes. **La colonie se mure pour elle-même.** Un colon
resté dehors ne rentre plus ; un feu de camp dedans n'est plus atteignable
depuis dehors. Pour la carte, en revanche, rien n'est fermé : porte et pièges
sont franchissables, la couche de base voit une région unique et ne peut rien
démontrer.

D'où la seconde couche, qui n'était pas prévue et que la mesure a imposée. Elle
ne coûte que là où il y a des pièges, et elle est exacte pour la même raison
que la première : retirer des cases à un marcheur ne peut que **séparer**,
jamais joindre.

#### Les points d'usage

Trois, et tous en amont d'un A\* :

1. `path::find_path_for`, juste après le test de franchissabilité de la cible :
   régions différentes ⇒ `None` immédiat. Tous les appelants en profitent,
   `try_start_work` / `haul` / `farm` / `deliver` compris, sans qu'une ligne y
   bouge.
2. `jobs::path_adjacent_for` et `jobs::reach_adjacent` : les voisines de la
   cible qui ne communiquent pas avec le marcheur sont rayées **avant** le tri.
   Un poste muré, qui coûtait ses huit A\*, n'en coûte plus aucun.
3. `jobs::reach_tile` : la démonstration se fait sans A\*. Le **budget** est
   quand même consommé — le candidat a bien été examiné — mais `Sim::job_paths`
   ne bouge pas, puisqu'il compte les A\* lancés. C'est ce qui permet aux tests
   d'attendre zéro.

#### Ce que ça donne

Les cinq graines lentes, `--release` (les 432 000 ticks d'une graine) :

| graine | avant | après |
|---|---|---|
| 3 | 3 948 ticks/s | **179 925** |
| 6 | 14 027 | **295 890** |
| 8 | **742** | **116 756** |
| 12 | 7 518 | **355 263** |
| 18 | 1 881 | **428 146** |

Les vingt-cinq autres ne perdent rien (l'index leur coûte un booléen par tick
et deux lectures par recherche) : la médiane monte plutôt de quelques pour
cent, et la campagne entière passe de 12 549 à **414 624 ticks/s**.

Banc de tests (`crates/sim/tests/regions.rs`), A\* de recherche de travail sur
600 ticks, mesurés des deux côtés :

| scène | avant | après |
|---|---|---|
| réduit de roche scellé (postes, dépouilles, bois dedans) | 629 | **0** |
| porte piégée : la colonie murée pour elle-même | 860 | **0** |

`bench --size 128 --ticks 100000` : `demo` 892 416 → **1 066 730** ticks/s,
`demo+12` 450 985 → **483 468**, à vide 3 642 362 → 3 741 751 (bruit).

#### Aucune décision n'a changé

C'est la condition de tout le reste, et elle est vérifiée de quatre façons
indépendantes :

- `verify --seed 1 --size 64 --ticks 10000 --scenario demo` : **OK**, et le
  hash final vaut `2fe88821b6299966` avant comme après ;
- `fuzz --seed 1 --size 24 --ticks 20000 --runs 4 --commands-per-tick 6` : les
  quatre hashes sont bit-à-bit ceux d'avant ;
- la campagne de trente graines rend un tableau identique **colonne par
  colonne**, la seule qui bouge étant celle des millisecondes ;
- un test (`snapshot_roundtrip_recomputes_regions`) fait tourner côte à côte
  une sim dont l'index est calculé et la même relue d'un snapshot, dont l'index
  repart périmé : mêmes hashes, cent ticks plus loin comme au premier.

#### Pourquoi une couche hors snapshot est ici légitime

L'invariant « pas de cache non sérialisé qui influence le futur » vise les
caches qui **décident** : `Map::stockpile_tiles` dit où un colon porte sa
charge, elle voyage donc avec l'état. L'index de régions ne décide rien. Il
répond à une question dont la réponse est **déjà entièrement contenue** dans
`tiles` et `features` — « ces deux cases communiquent-elles pour ce
marcheur ? » — et la seule chose qu'il autorise est de ne pas lancer un A\* qui
aurait rendu `None`. Il est donc `#[serde(skip)]`, hors du hash et hors de
l'égalité de deux cartes (`PartialEq` toujours vrai, comme `WorkCounter`), et
une carte relue le recalcule à son premier tick. Entre-temps il se tait, ce qui
est la seule chose qu'une couche périmée ait le droit de faire.

#### Ce qui reste

- **La cuisine a sa vérification de poste au démarrage (corrigé le
  2026-09-06).** Les trois pièces posées ensemble, comme partout ailleurs :
  le feu vérifié par `Sim::reach_station` avant tout A\*, un budget de
  candidats examinés, et la cadence de `RETRY_TICKS` pour le colon qui tourne
  à vide. Le hash du scénario `demo` en est changé — c'était le prix connu de
  ce correctif, assumé cette fois : `verify --seed 1 --size 64 --ticks 10000
  --scenario demo` reste `OK` (deux sims comparées, pas un hash figé). Mesuré
  sur un feu de camp muré, trois colons, 600 ticks
  (`crates/sim/tests/cooking_and_heat.rs`) : **39** A\* lancés par la recherche
  de travail, aucun vivre ramassé puis reposé.
- **Le découpage est global, pas hiérarchique.** Un changement de carte fait
  repayer la carte entière ; à 0,2 ms sur 128×128 et une poignée de changements
  par seconde de jeu, la note est invisible. Elle cesserait de l'être sur une
  carte dix fois plus grande, où il faudrait un découpage par blocs, invalidé
  bloc par bloc.

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

---

## 9. Campagnes du 2026-09-06

(Le §8 existait déjà — biais du joueur scripté — donc cette nouvelle tranche
prend le numéro suivant plutôt que de réutiliser « §8 ».)

Cinq commandes, chacune lancée seule (pas en parallèle, contrairement au
2026-09-05 — §1) sur la révision `661d1b3` :

```bash
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --difficulty 2 --json
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --difficulty 3 --json
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --difficulty 2 --climate -50 --json
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --difficulty 2 --climate 300 --json
cargo run -p sim-cli --release -- campaign --seeds 30 --days 30 --size 64 --difficulty 2 --day-of-year 30 --json
```

Chacune a tourné en 16 à 31 secondes (colonne « durée totale » du §2) — à
comparer aux 4 à 43 minutes du 2026-09-05, contendues à cinq en même temps sur
la même machine. Les tableaux du §2 ci-dessus donnent la synthèse ; ce qui suit
est le détail par graine des cinq campagnes, pour qui veut vérifier un chiffre
sans relancer les commandes.

### Normale (`--difficulty 2`)

| seed | fin | j10 | j20 | morts | raids/raiders | richesse | vivres (j) | tech | bétail | feux/brûlées | armés | humeur | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 4 | 3 | 4 | 6 | 8/17 | 2061 | 4.3 | 3 | 1 | 2/2 | 0 | 51 % | 579 |
| 2 | 1 | 3 | 3 | 9 | 8/15 | 2473 | 85.2 | 3 | 0 | 6/43 | 1 | 48 % | 314 |
| 3 | 0 | 4 | 0 | 7 | 5/14 | 2564 | 0.0 | 3 | 0 | 3/3 | 0 | 0 % | 495 |
| 4 | 4 | 2 | 2 | 6 | 8/14 | 1745 | 0.0 | 0 | 0 | 2/2 | 0 | 37 % | 340 |
| 5 | 2 | 4 | 3 | 8 | 8/20 | 2859 | 36.5 | 3 | 0 | 4/9 | 2 | 60 % | 708 |
| 6 | 2 | 3 | 4 | 8 | 8/15 | 1464 | 10.9 | 0 | 0 | 1/1 | 2 | 64 % | 1516 |
| 7 | 0 | 0 | 0 | 3 | 0/0 | 0 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 313 |
| 8 | 4 | 2 | 2 | 6 | 7/15 | 2866 | 11.4 | 3 | 0 | 4/5 | 1 | 57 % | 2788 |
| 9 | 3 | 2 | 2 | 7 | 7/13 | 2513 | 30.2 | 3 | 0 | 3/4 | 3 | 55 % | 226 |
| 10 | 0 | 5 | 0 | 6 | 4/10 | 763 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 525 |
| 11 | 3 | 3 | 3 | 7 | 8/18 | 2350 | 22.6 | 0 | 0 | 2/2 | 3 | 45 % | 631 |
| 12 | 2 | 4 | 4 | 8 | 7/21 | 4070 | 28.4 | 3 | 0 | 2/2 | 1 | 68 % | 5418 |
| 13 | 5 | 4 | 5 | 5 | 7/16 | 2364 | 23.3 | 3 | 1 | 1/1 | 5 | 64 % | 743 |
| 14 | 0 | 2 | 0 | 6 | 5/8 | 1495 | 0.0 | 2 | 0 | 9/121 | 0 | 0 % | 133 |
| 15 | 2 | 3 | 4 | 8 | 7/18 | 2253 | 15.7 | 3 | 0 | 6/10 | 2 | 46 % | 614 |
| 16 | 4 | 3 | 4 | 5 | 5/10 | 1139 | 0.0 | 0 | 0 | 0/0 | 0 | 52 % | 2044 |
| 17 | 3 | 2 | 3 | 7 | 8/19 | 4460 | 9.1 | 3 | 1 | 8/15 | 1 | 62 % | 612 |
| 18 | 3 | 3 | 2 | 7 | 7/15 | 2349 | 0.0 | 3 | 0 | 2/2 | 0 | 44 % | 910 |
| 19 | 4 | 3 | 4 | 7 | 8/19 | 3002 | 13.0 | 0 | 1 | 2/2 | 4 | 59 % | 285 |
| 20 | 0 | 4 | 5 | 8 | 6/15 | 740 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 860 |
| 21 | 4 | 3 | 4 | 6 | 8/19 | 1266 | 6.1 | 0 | 1 | 0/0 | 4 | 55 % | 324 |
| 22 | 2 | 3 | 2 | 8 | 7/16 | 2874 | 8.7 | 3 | 0 | 1/1 | 2 | 50 % | 358 |
| 23 | 5 | 3 | 4 | 5 | 7/16 | 3027 | 24.8 | 3 | 1 | 1/1 | 5 | 72 % | 812 |
| 24 | 0 | 3 | 0 | 5 | 3/6 | 532 | 0.0 | 0 | 0 | 4/22 | 0 | 0 % | 122 |
| 25 | 3 | 4 | 4 | 6 | 8/19 | 2092 | 0.0 | 0 | 0 | 2/2 | 0 | 50 % | 1709 |
| 26 | 3 | 2 | 3 | 7 | 8/15 | 1232 | 0.0 | 0 | 0 | 0/0 | 0 | 48 % | 1263 |
| 27 | 3 | 3 | 4 | 7 | 8/23 | 3782 | 30.1 | 0 | 0 | 4/5 | 3 | 45 % | 934 |
| 28 | 3 | 3 | 3 | 7 | 8/17 | 920 | 0.0 | 0 | 0 | 0/0 | 0 | 33 % | 2094 |
| 29 | 3 | 4 | 3 | 7 | 8/19 | 4045 | 47.3 | 3 | 0 | 6/53 | 3 | 43 % | 266 |
| 30 | 2 | 2 | 3 | 8 | 7/14 | 2581 | 12.5 | 3 | 1 | 0/0 | 1 | 63 % | 850 |

### Difficile (`--difficulty 3`)

| seed | fin | j10 | j20 | morts | raids/raiders | richesse | vivres (j) | tech | bétail | feux/brûlées | armés | humeur | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 4 | 0 | 5 | 3/7 | 231 | 0.0 | 2 | 0 | 2/3 | 0 | 0 % | 203 |
| 2 | 0 | 4 | 0 | 7 | 5/11 | 884 | 0.0 | 0 | 0 | 1/2 | 0 | 0 % | 308 |
| 3 | 0 | 4 | 0 | 5 | 4/12 | 1549 | 0.0 | 2 | 0 | 1/422 | 0 | 0 % | 243 |
| 4 | 0 | 0 | 0 | 5 | 2/4 | 251 | 0.0 | 0 | 0 | 3/3 | 0 | 0 % | 148 |
| 5 | 0 | 5 | 0 | 7 | 5/18 | 927 | 0.0 | 3 | 0 | 1/1 | 0 | 0 % | 600 |
| 6 | 5 | 2 | 4 | 5 | 8/18 | 1868 | 10.9 | 0 | 1 | 2/2 | 5 | 65 % | 2048 |
| 7 | 0 | 0 | 0 | 3 | 0/0 | 0 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 320 |
| 8 | 0 | 2 | 5 | 10 | 8/21 | 2030 | 0.0 | 2 | 0 | 4/11 | 0 | 0 % | 2468 |
| 9 | 0 | 3 | 3 | 8 | 5/12 | 1347 | 0.0 | 3 | 1 | 3/32 | 0 | 0 % | 158 |
| 10 | 0 | 0 | 0 | 4 | 3/7 | 368 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 210 |
| 11 | 0 | 2 | 4 | 8 | 8/21 | 1205 | 0.0 | 0 | 0 | 2/2 | 0 | 0 % | 463 |
| 12 | 0 | 0 | 0 | 4 | 2/5 | 782 | 0.0 | 0 | 0 | 4/402 | 0 | 0 % | 389 |
| 13 | 3 | 3 | 3 | 7 | 8/17 | 2645 | 33.0 | 3 | 0 | 0/0 | 3 | 40 % | 269 |
| 14 | 0 | 2 | 1 | 7 | 6/12 | 1811 | 0.0 | 2 | 0 | 4/4 | 0 | 0 % | 150 |
| 15 | 2 | 3 | 3 | 8 | 10/27 | 2740 | 20.7 | 3 | 0 | 6/6 | 2 | 69 % | 1187 |
| 16 | 2 | 2 | 3 | 7 | 8/15 | 1139 | 0.0 | 0 | 0 | 0/0 | 0 | 14 % | 1568 |
| 17 | 0 | 3 | 2 | 8 | 7/18 | 2336 | 0.0 | 2 | 0 | 8/21 | 0 | 0 % | 277 |
| 18 | 0 | 3 | 0 | 6 | 5/8 | 1067 | 0.0 | 1 | 0 | 2/2 | 0 | 0 % | 108 |
| 19 | 0 | 3 | 3 | 9 | 6/14 | 1046 | 0.0 | 3 | 0 | 3/3 | 0 | 0 % | 168 |
| 20 | 0 | 3 | 0 | 7 | 5/10 | 566 | 0.0 | 0 | 1 | 0/0 | 0 | 0 % | 386 |
| 21 | 2 | 4 | 2 | 7 | 8/16 | 1137 | 6.0 | 0 | 1 | 4/4 | 2 | 9 % | 221 |
| 22 | 0 | 2 | 0 | 6 | 4/7 | 1199 | 0.0 | 2 | 1 | 0/0 | 0 | 0 % | 106 |
| 23 | 0 | 3 | 2 | 8 | 7/12 | 1073 | 0.0 | 3 | 0 | 2/3 | 0 | 0 % | 138 |
| 24 | 0 | 3 | 2 | 10 | 8/17 | 2551 | 0.0 | 3 | 0 | 3/3 | 0 | 0 % | 255 |
| 25 | 2 | 3 | 3 | 8 | 9/21 | 1659 | 0.0 | 0 | 0 | 2/2 | 0 | 35 % | 1307 |
| 26 | 2 | 2 | 3 | 8 | 8/17 | 1270 | 0.0 | 0 | 0 | 0/0 | 0 | 46 % | 1320 |
| 27 | 0 | 2 | 4 | 9 | 8/17 | 2254 | 0.0 | 0 | 0 | 4/5 | 0 | 0 % | 393 |
| 28 | 0 | 4 | 0 | 7 | 5/13 | 157 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 980 |
| 29 | 0 | 0 | 0 | 4 | 2/5 | 955 | 0.0 | 0 | 0 | 2/86 | 0 | 0 % | 76 |
| 30 | 0 | 0 | 0 | 5 | 3/7 | 281 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 555 |

### Froide (`--climate -50`)

| seed | fin | j10 | j20 | morts | raids/raiders | richesse | vivres (j) | tech | bétail | feux/brûlées | armés | humeur | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 4 | 3 | 3 | 6 | 7/15 | 2598 | 9.0 | 3 | 0 | 0/0 | 0 | 34 % | 611 |
| 2 | 0 | 3 | 3 | 9 | 7/14 | 2043 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 621 |
| 3 | 0 | 0 | 0 | 5 | 2/6 | 1961 | 0.0 | 1 | 0 | 1/1 | 0 | 0 % | 198 |
| 4 | 0 | 0 | 0 | 4 | 2/4 | 75 | 0.0 | 0 | 0 | 2/2 | 0 | 0 % | 146 |
| 5 | 0 | 2 | 0 | 6 | 4/8 | 962 | 0.0 | 1 | 0 | 0/0 | 0 | 0 % | 326 |
| 6 | 5 | 3 | 4 | 6 | 7/19 | 2825 | 16.7 | 0 | 1 | 0/0 | 1 | 52 % | 3466 |
| 7 | 0 | 0 | 0 | 3 | 0/0 | 0 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 256 |
| 8 | 0 | 3 | 3 | 8 | 6/15 | 3605 | 0.0 | 3 | 0 | 0/0 | 0 | 0 % | 4442 |
| 9 | 0 | 2 | 0 | 5 | 3/6 | 1171 | 0.0 | 1 | 1 | 1/1 | 0 | 0 % | 103 |
| 10 | 3 | 4 | 5 | 7 | 8/21 | 2494 | 28.9 | 0 | 1 | 2/2 | 3 | 39 % | 1633 |
| 11 | 0 | 4 | 1 | 9 | 6/15 | 2583 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 678 |
| 12 | 0 | 0 | 0 | 4 | 2/4 | 972 | 0.0 | 0 | 0 | 3/3 | 0 | 0 % | 66 |
| 13 | 3 | 2 | 2 | 6 | 9/23 | 4363 | 35.9 | 3 | 1 | 0/0 | 3 | 23 % | 1454 |
| 14 | 0 | 2 | 1 | 8 | 6/14 | 3526 | 0.0 | 1 | 0 | 1/1 | 0 | 0 % | 1944 |
| 15 | 0 | 2 | 3 | 10 | 8/18 | 4480 | 0.0 | 3 | 1 | 1/1 | 0 | 0 % | 398 |
| 16 | 2 | 2 | 3 | 7 | 6/11 | 1785 | 0.0 | 0 | 0 | 0/0 | 0 | 11 % | 1359 |
| 17 | 0 | 0 | 0 | 4 | 2/5 | 1694 | 0.0 | 1 | 0 | 0/0 | 0 | 0 % | 182 |
| 18 | 0 | 0 | 0 | 5 | 2/5 | 1024 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 67 |
| 19 | 3 | 4 | 2 | 7 | 8/21 | 5009 | 71.5 | 0 | 0 | 1/1 | 1 | 42 % | 1435 |
| 20 | 3 | 2 | 2 | 7 | 8/12 | 2378 | 41.6 | 0 | 0 | 1/1 | 3 | 39 % | 480 |
| 21 | 3 | 1 | 3 | 7 | 8/14 | 1369 | 13.3 | 0 | 1 | 2/2 | 3 | 32 % | 328 |
| 22 | 0 | 0 | 0 | 3 | 1/2 | 676 | 0.0 | 0 | 0 | 2/2 | 0 | 0 % | 61 |
| 23 | 1 | 3 | 3 | 9 | 7/19 | 4603 | 156.7 | 2 | 1 | 2/2 | 0 | 30 % | 1289 |
| 24 | 0 | 3 | 0 | 5 | 3/6 | 610 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 268 |
| 25 | 0 | 2 | 0 | 5 | 4/8 | 485 | 0.0 | 0 | 0 | 3/3 | 0 | 0 % | 385 |
| 26 | 0 | 3 | 0 | 7 | 5/9 | 301 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 933 |
| 27 | 0 | 4 | 0 | 6 | 3/9 | 903 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 674 |
| 28 | 4 | 5 | 2 | 6 | 8/17 | 1464 | 0.0 | 0 | 0 | 2/2 | 0 | 9 % | 3173 |
| 29 | 0 | 3 | 0 | 5 | 3/7 | 1088 | 0.0 | 1 | 0 | 2/2 | 0 | 0 % | 187 |
| 30 | 3 | 3 | 3 | 7 | 7/20 | 5732 | 15.1 | 3 | 0 | 1/1 | 0 | 25 % | 2126 |

### Chaude (`--climate 300`)

| seed | fin | j10 | j20 | morts | raids/raiders | richesse | vivres (j) | tech | bétail | feux/brûlées | armés | humeur | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 4 | 4 | 5 | 6 | 8/22 | 1823 | 4.6 | 3 | 1 | 8/9 | 0 | 59 % | 733 |
| 2 | 0 | 5 | 0 | 7 | 6/19 | 1129 | 0.0 | 0 | 1 | 5/49 | 0 | 0 % | 587 |
| 3 | 0 | 3 | 2 | 8 | 7/16 | 2142 | 0.0 | 3 | 0 | 4/7 | 0 | 0 % | 1573 |
| 4 | 4 | 4 | 3 | 6 | 9/18 | 1285 | 0.0 | 0 | 0 | 2/2 | 0 | 57 % | 434 |
| 5 | 3 | 4 | 3 | 7 | 7/16 | 2413 | 23.9 | 3 | 1 | 9/39 | 3 | 73 % | 677 |
| 6 | 2 | 3 | 4 | 8 | 9/20 | 1495 | 2.4 | 0 | 1 | 1/1 | 2 | 47 % | 2044 |
| 7 | 0 | 0 | 0 | 3 | 0/0 | 0 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 305 |
| 8 | 3 | 3 | 4 | 7 | 8/19 | 2638 | 10.3 | 0 | 0 | 6/6 | 2 | 55 % | 7374 |
| 9 | 3 | 4 | 3 | 7 | 6/17 | 2964 | 25.2 | 3 | 1 | 10/12 | 3 | 66 % | 635 |
| 10 | 5 | 4 | 5 | 5 | 8/19 | 1396 | 3.0 | 0 | 0 | 1/1 | 5 | 63 % | 1259 |
| 11 | 0 | 4 | 0 | 7 | 5/12 | 895 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 370 |
| 12 | 0 | 4 | 0 | 6 | 4/10 | 1287 | 0.0 | 0 | 0 | 7/118 | 0 | 0 % | 2741 |
| 13 | 0 | 5 | 0 | 7 | 5/15 | 999 | 0.0 | 0 | 0 | 2/2 | 0 | 0 % | 695 |
| 14 | 3 | 3 | 2 | 7 | 7/15 | 3773 | 18.8 | 3 | 0 | 7/162 | 2 | 50 % | 1165 |
| 15 | 0 | 3 | 0 | 6 | 4/8 | 979 | 0.0 | 1 | 0 | 5/78 | 0 | 0 % | 154 |
| 16 | 0 | 2 | 0 | 4 | 4/6 | 302 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 652 |
| 17 | 0 | 2 | 1 | 9 | 7/15 | 2166 | 0.0 | 3 | 0 | 5/65 | 0 | 0 % | 360 |
| 18 | 0 | 4 | 0 | 5 | 4/9 | 1239 | 0.0 | 2 | 0 | 0/0 | 0 | 0 % | 114 |
| 19 | 0 | 4 | 5 | 9 | 8/24 | 2258 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 1110 |
| 20 | 0 | 3 | 0 | 7 | 5/9 | 448 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 432 |
| 21 | 0 | 0 | 0 | 3 | 1/2 | 30 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 85 |
| 22 | 4 | 3 | 3 | 6 | 7/16 | 3214 | 21.5 | 3 | 1 | 2/2 | 4 | 57 % | 446 |
| 23 | 2 | 3 | 3 | 7 | 8/15 | 1832 | 21.0 | 0 | 1 | 2/2 | 2 | 51 % | 274 |
| 24 | 0 | 0 | 0 | 5 | 3/6 | 256 | 0.0 | 0 | 0 | 4/168 | 0 | 0 % | 97 |
| 25 | 0 | 3 | 4 | 9 | 7/16 | 862 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 1414 |
| 26 | 3 | 4 | 2 | 7 | 9/16 | 1218 | 0.0 | 0 | 0 | 2/2 | 0 | 47 % | 1603 |
| 27 | 2 | 3 | 3 | 8 | 8/18 | 2807 | 31.5 | 0 | 0 | 7/11 | 2 | 40 % | 396 |
| 28 | 3 | 2 | 3 | 6 | 8/17 | 528 | 0.0 | 0 | 0 | 0/0 | 0 | 37 % | 1795 |
| 29 | 0 | 0 | 0 | 3 | 1/2 | 413 | 0.0 | 0 | 0 | 2/225 | 0 | 0 % | 47 |
| 30 | 2 | 3 | 2 | 8 | 8/16 | 2291 | 10.6 | 2 | 1 | 1/1 | 0 | 27 % | 829 |

### Automne-hiver (`--day-of-year 30`)

| seed | fin | j10 | j20 | morts | raids/raiders | richesse | vivres (j) | tech | bétail | feux/brûlées | armés | humeur | ms |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| 1 | 0 | 3 | 0 | 7 | 5/10 | 1143 | 0.0 | 3 | 0 | 0/0 | 0 | 0 % | 386 |
| 2 | 0 | 3 | 0 | 7 | 5/10 | 905 | 0.0 | 3 | 0 | 1/1 | 0 | 0 % | 527 |
| 3 | 0 | 2 | 0 | 5 | 3/8 | 2276 | 0.0 | 3 | 0 | 0/0 | 0 | 0 % | 428 |
| 4 | 1 | 2 | 4 | 8 | 8/15 | 4431 | 0.0 | 0 | 0 | 0/0 | 0 | 39 % | 283 |
| 5 | 0 | 2 | 0 | 5 | 4/7 | 781 | 0.0 | 2 | 0 | 0/0 | 0 | 0 % | 279 |
| 6 | 0 | 0 | 0 | 4 | 2/4 | 408 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 682 |
| 7 | 0 | 0 | 0 | 3 | 0/0 | 0 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 320 |
| 8 | 0 | 0 | 0 | 3 | 1/2 | 744 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 171 |
| 9 | 0 | 3 | 1 | 8 | 5/14 | 2569 | 0.0 | 3 | 0 | 2/2 | 0 | 0 % | 654 |
| 10 | 0 | 0 | 0 | 3 | 1/2 | 164 | 0.0 | 0 | 0 | 2/2 | 0 | 0 % | 161 |
| 11 | 0 | 3 | 3 | 9 | 8/22 | 3429 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 2215 |
| 12 | 0 | 0 | 0 | 4 | 2/5 | 967 | 0.0 | 0 | 0 | 4/4 | 0 | 0 % | 368 |
| 13 | 0 | 3 | 0 | 7 | 5/12 | 983 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 1000 |
| 14 | 0 | 2 | 0 | 5 | 3/7 | 1823 | 0.0 | 2 | 0 | 0/0 | 0 | 0 % | 147 |
| 15 | 0 | 0 | 0 | 4 | 3/5 | 881 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 120 |
| 16 | 0 | 0 | 0 | 4 | 2/3 | 243 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 465 |
| 17 | 0 | 0 | 0 | 4 | 2/5 | 1673 | 0.0 | 0 | 0 | 1/0 | 0 | 0 % | 219 |
| 18 | 0 | 0 | 0 | 3 | 1/2 | 809 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 60 |
| 19 | 0 | 0 | 0 | 5 | 3/8 | 520 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 552 |
| 20 | 0 | 2 | 2 | 8 | 6/11 | 1614 | 0.0 | 1 | 1 | 1/1 | 0 | 0 % | 527 |
| 21 | 0 | 2 | 0 | 5 | 3/5 | 200 | 0.0 | 0 | 0 | 3/3 | 0 | 0 % | 126 |
| 22 | 0 | 4 | 0 | 5 | 3/8 | 1544 | 0.0 | 2 | 0 | 1/1 | 0 | 0 % | 291 |
| 23 | 0 | 4 | 0 | 7 | 6/17 | 1327 | 0.0 | 0 | 0 | 2/2 | 0 | 0 % | 1069 |
| 24 | 0 | 2 | 2 | 8 | 5/11 | 2348 | 0.0 | 3 | 0 | 5/5 | 0 | 0 % | 414 |
| 25 | 0 | 4 | 3 | 8 | 6/16 | 900 | 0.0 | 0 | 0 | 1/1 | 0 | 0 % | 1363 |
| 26 | 0 | 3 | 0 | 7 | 5/10 | 681 | 0.0 | 0 | 0 | 0/0 | 0 | 0 % | 840 |
| 27 | 0 | 0 | 0 | 4 | 2/4 | 449 | 0.0 | 0 | 0 | 3/3 | 0 | 0 % | 194 |
| 28 | 3 | 2 | 2 | 7 | 8/11 | 1098 | 0.0 | 0 | 0 | 0/0 | 0 | 40 % | 1234 |
| 29 | 0 | 0 | 0 | 4 | 3/8 | 1252 | 0.0 | 1 | 0 | 0/0 | 0 | 0 % | 144 |
| 30 | 0 | 3 | 3 | 8 | 6/16 | 2477 | 0.0 | 3 | 0 | 0/0 | 0 | 0 % | 1264 |

Colonne « feux/brûlées » : nombre de départs de feu observés puis cases
brûlées au total sur la graine. « vivres (j) » : jours de vivres en stock
rapportés au nombre de colons vivants en fin de partie (0 si la colonie est
éteinte, cf. `food_days_tenths` dans `crates/sim-cli/src/campaign.rs`). Les
cinq fichiers `--json` bruts (`campaign --seeds 30 --days 30 --size 64
--json`, avec les mêmes options que ci-dessus) se régénèrent en moins d'une
minute chacun ; ce sont eux qui ont servi à ce tableau et à celui du §2.

---

## 10. Mesures du 2026-09-06 (suite)

Deux choses ce jour-là, dans cet ordre : **les trois graines lentes** (constat
ouvert n°2), qui se sont révélées être un défaut du sim et non du joueur
scripté ; puis **ce que le rapport ne mesurait pas** (constats ouverts n°3 et
n°5), maintenant exporté — et dont la première lecture est franche.

### 10.1 Les trois graines lentes : l'ordre des questions

#### Ce qu'on cherchait, et ce qu'on a trouvé à la place

Le §9 laissait trois graines sous le seuil de 100 000 ticks/s que l'index de
régions avait promis : chaude/8 à **58 584**, normale/12 à **79 734**,
froide/8 à **97 253**. L'hypothèse écrite était le balayage minier ajouté par
la métallurgie (`designate_rocks`, `MINE_RADIUS` = 12). **Elle est fausse**, et
c'est la mesure qui l'a dit : sur les quinze graines de la campagne normale qui
acquièrent la métallurgie, **quatorze n'ont pas un seul rocher** dans le rayon
de minage (§10.2) — le balayage ne trouve rien et ne coûte rien.

Rejouer une graine seule ne demande aucune option nouvelle : `--seed S` est la
**première** graine et `--seeds 1` n'en joue qu'une, donc

```bash
cargo run -p sim-cli --release -- campaign --seeds 1 --seed 8 --days 30 --size 64 --climate 300
```

est exactement la graine chaude 8 du §9, aux millisecondes près.

Profil `sample` (5 s, chaude/graine 8) : **3 765 échantillons sur 3 856
(98 %)** dans `tick_pawn` → `find_job` → `try_start`, et l'essentiel dans
`path::find_path_for`. Des A\*, donc, comme les trois fois précédentes — mais
pas du tout les mêmes.

Compteurs posés par site d'appel le temps d'une mesure (A\* **lancés**,
c'est-à-dire ceux que l'index de régions n'a pas déjà écartés, sur les 432 000
ticks d'une graine) :

| site d'appel | chaude/8 | normale/12 | froide/8 |
|---|---|---|---|
| `try_start_tame` | **157 434** | 39 235 | 61 652 |
| `try_start_butcher` | **111 756** | **68 622** | **97 952** |
| `try_start_cook` | 1 150 | 2 717 | 452 |
| `try_start_work` | 540 | 941 | 454 |
| tous les autres réunis | ~4 800 | ~4 600 | ~2 900 |
| **total** | **275 634** | **116 152** | **163 439** |

Deux sites font 98 %, 93 % et 98 % du total. Et le chiffre qui a tout
retourné : sur ces 275 634 A\* de la graine chaude 8, **41 seulement
échouent**. Ce ne sont donc ni des A\* ratés (le cas des trois correctifs
précédents, celui que l'index de régions sait supprimer), ni un balayage. Ce
sont des recherches qui **aboutissent** — et qui ne servent à rien.

#### Le mécanisme, deux fois le même

Une recherche de travail qui porte une charge d'un point à un autre pose deux
questions : *puis-je atteindre la charge ?* et *puis-je atteindre l'endroit où
la porter ?* Les deux doivent être vraies. Les poser dans le mauvais ordre ne
change rien au résultat — et tout au prix, dès que la seconde est
définitivement fausse.

1. **`try_start_butcher` et `try_start_cook` : la charge avant le poste.**
   Le code demandait d'abord un chemin vers la dépouille (ou le vivre), puis un
   poste où la porter. Le commentaire justifiait cet ordre — « le test le moins
   cher, une recherche contre huit pour un poste » — et c'était vrai **avant**
   l'index de régions. Depuis, un poste dont aucune voisine ne communique avec
   le colon se démontre hors d'atteinte en O(1), sans un seul A\* : la question
   du poste est devenue la **moins** chère des deux, et l'ordre s'est inversé
   sans que personne ne le remarque.

   Or c'est exactement la situation que le joueur scripté fabrique : il referme
   son enceinte et pose trois pièges devant l'unique porte (§3, « la surprise :
   ce n'était pas l'enceinte »). Un colon resté dehors a ses dépouilles sous la
   main et son poste de fabrication enfermé **pour toujours**. Compteurs sur la
   graine chaude 8 : **117 545** fois la dépouille atteinte, **117 544** fois
   aucun poste derrière. Un aller pour rien, à chaque tick, pendant trente
   jours.

2. **`try_start_tame` : la bête avant le fourrage.**
   Même inversion, cause différente. Le code vérifiait d'abord que la bête
   marquée était joignable — un A\* qui aboutit, elle broute à côté — puis
   cherchait un chemin vers la pile de fourrage. Quand cette pile devient
   injoignable, `find_path_for` le dit **gratuitement** (la cible est
   infranchissable, ou dans une autre région) : tout le coût de l'appel est
   dans la question posée en premier. Et le marquage, lui, ne s'efface jamais —
   `plan` ne remarque une bête que s'il n'y en a plus aucune de marquée (§1).
   **157 434 A\*** sur la graine chaude 8, pour zéro tentative
   d'apprivoisement.

   Ce qui enterre le fourrage n'est d'ailleurs pas anecdotique : le joueur
   scripté plante son feu de camp, son poste de fabrication et **sa forge** à
   l'intérieur ou au bord de son entrepôt 4×4 (§10.2) — et une pile sous un
   élément infranchissable n'est plus atteignable par personne.

Un dernier fil relie les deux : la cadence `RETRY_TICKS` ne les freinait pas.
Elle ne s'applique qu'au colon qui **tourne à vide** (`Sim::job_retry_due`, et
c'est délibéré, §3), or ces colonies-là sont actives — elles cultivent, elles
rangent. Un colon occupé repose donc les deux questions **à chaque tick**.

#### La correction

La même des deux côtés, et c'est celle du rangement et de l'inhumation avant
elle : **la question la moins chère d'abord.**

- `Sim::stations_out_of_reach` (`crates/sim/src/jobs.rs`) : l'index de régions
  démontre-t-il qu'aucune voisine d'aucun poste ne communique avec le colon ?
  Une lecture de tableau par voisine, aucun A\*. Posée en tête de
  `try_start_butcher` et de `try_start_cook`, avant la moindre recherche vers
  la charge. Comme partout dans `regions`, seul « non » est une démonstration :
  index périmé ou case de départ inconnue rendent « peut-être », et tout se
  passe comme avant.
- `try_start_tame` (`crates/sim/src/livestock.rs`) : le chemin vers le fourrage
  est sorti de la boucle des bêtes. Il n'en dépendait pas — mêmes `from`, mêmes
  coordonnées de pile, aucune mutation entre deux tours —, le sortir ne change
  donc aucune décision.
- Au passage, `try_start_tame` et `try_start_slaughter` passent enfin par
  `reach_tile` / `reach_adjacent`, comme toutes les autres recherches à cible
  mouvante. C'étaient les deux dernières à appeler `colonist_adjacent` en
  direct, donc les deux dernières **invisibles à `Sim::job_paths`** : le défaut
  n'était pas mesurable par le compteur qui existait précisément pour ça.
  Budget identique au nombre de candidats examinés, aucune décision ne change.

#### Ce que ça donne

| | avant (§9) | après |
|---|---|---|
| chaude, graine 8 | **58 584** ticks/s | **173 285** |
| normale, graine 12 | **79 734** | **181 665** |
| froide, graine 8 | **97 253** | **240 668** |
| campagne normale, 30 graines | 28,8 s — 449 938 ticks/s | **24,5 s — 529 693** |
| campagne chaude | 30,4 s — 426 007 | **22,8 s — 568 346** |
| campagne froide | 29,3 s — 442 155 | **24,5 s — 528 440** |
| graine la plus lente, toutes campagnes | 8 : **58 584** | 6 (froide) : **124 388** |

**Aucune graine ne reste sous 100 000 ticks/s**, sur les cinq campagnes.

#### Aucune décision n'a changé

Vérifié de quatre façons, comme pour l'index de régions :

- les **cinq** campagnes de trente graines rendent un JSON identique **octet
  pour octet** hors `elapsed_ms` (comparaison de deux binaires, l'un compilé à
  la révision `17603dd`, l'autre sur l'arbre corrigé) — le tableau du §9 tient
  donc colonne par colonne ;
- `verify --seed 1 --size 64 --ticks 10000 --scenario demo` : **OK**, et
  `run` sur le même scénario rend le même hash final, `5fdc5754c55cc434`, avec
  les mêmes hashes intermédiaires tous les mille ticks ;
- `fuzz --seed 1 --size 24 --ticks 20000 --runs 4 --commands-per-tick 6` : la
  sortie entière est identique, durée mise à part ;
- `cargo test --workspace` et `cargo clippy --workspace --all-targets` passent.

#### Le banc

`crates/sim/tests/stations_perf.rs`. Trois scènes minimales — le seul poste de
fabrication, le seul feu de camp, le seul entrepôt et ses baies, chacun scellé
dans un réduit de roche, la charge (ou la bête) au pied des colons — et un
garde-fou par famille qui vérifie que le travail se fait encore quand la chose
est à portée. Six cents ticks, trois colons :

| scène | A\* avant | A\* après |
|---|---|---|
| poste de fabrication scellé, dépouilles sous la main | 37 | **0** |
| feu de camp scellé, vivres sous la main | 37 | **0** |
| fourrage scellé, bête sous la main | 36 | **0** |

Le « avant » est mesuré sur la révision `17603dd` **avec le seul comptage
ajouté** (sans la correction), pour que les deux colonnes parlent du même
compteur. Les chiffres sont petits parce que la scène l'est : les colons y sont
désœuvrés, donc freinés par `RETRY_TICKS`. Dans une colonie qui travaille, le
frein ne s'applique pas — d'où les 111 756 et 157 434 de la campagne.

### 10.2 Ce que le rapport ne mesurait pas

`campaign` exporte maintenant, au tableau, au résumé et au JSON : **forges**
debout en fin de partie, **lingots** et **épées** produits (comptés au journal —
`EventKind::ItemCrafted` d'`ItemKind::Metal` et `WeaponCrafted` d'`ItemKind::Sword`
—, parce qu'un lingot se consomme et qu'une épée se perd avec son porteur),
**épées portées** en fin de partie, **réputation** finale envers les trois
factions, **tributs** offerts, et le **jour** où la métallurgie est tombée.

Deux campagnes rejouées avec ces colonnes (30 graines × 30 jours, 64×64) :

| | normale | chaude (+30 °C) |
|---|---|---|
| colonies à 3 technologies | 15/30 | 7/30 |
| métallurgie acquise (jour moyen) | **16,0** | 14,7 |
| **forges bâties** | **1** | **1** |
| **lingots fondus** | **0** | **0** |
| **épées forgées** | **0** | **0** |
| épées portées en fin | 1 (sur 74 vivants) | 0 (sur 43) |
| réputation finale (tribu, tribu, Guilde) | −17,6 / −15,1 / **+43,1** | −17,2 / −12,0 / **+39,0** |
| colonies détestées d'une tribu (< −40) | 4/30 | 6/30 |
| **tributs offerts** | **18**, par 5 colonies | **12**, par 4 colonies |

**Le joueur scripté ne forge pas.** C'est net : quinze colonies sur trente
paient la métallurgie (3 500 points de recherche, la plus chère des six) et une
seule pose sa forge ; aucune ne fond un lingot, aucune ne forge une épée. La
seule épée de la campagne est portée par un colon de la graine **21**, qui n'a
acquis **aucune** technologie : elle a été **ramassée sur un pillard mort**
(`storyteller::WEAPON_OPTIONS` arme les bandes à l'épée au-delà de
`SWORD_THREAT_POINTS`), pas fabriquée. La recherche est donc, en l'état, un
investissement entièrement perdu.

**Pourquoi**, et ce ne sont pas les quatorze jours qui restent après le jour 16
qui manquent — deux blocages indépendants, tous deux dans le joueur scripté :

1. **La forge est plantée dans l'entrepôt.** `plan` lui propose trois cases,
   `(ax+3, ay+3)`, `(ax+4, ay+3)` et `(ax+3, ay+4)`, toutes **à l'intérieur**
   du stockage 4×4 posé en `(ax+2 … ax+5, ay+2 … ay+5)`. Or `Command::Build`
   refuse une case qui porte une pile (`crates/sim/src/lib.rs`), et un entrepôt
   qui sert en porte toujours une. Relevé en fin de partie sur la graine 22,
   qui a 69 pierres en stock et pas de forge : `(35,35)` porte 55 cuirs,
   `(36,35)` 58 bois, `(35,36)` 3 cuirs. L'ordre est refusé **en silence** —
   `build_free` teste `build::can_place`, qui ignore les piles — et il repart
   identique au passage suivant, indéfiniment. La graine 15 est l'unique
   exception de la campagne : sa case `(35,35)` était libre au moment où la
   pierre a passé le seuil.
2. **Il n'y a pas de rocher à miner.** `MINE_RADIUS` = 12 autour du repère, et
   sur les quinze graines qui atteignent la métallurgie, **quatorze n'ont aucun
   rocher** dans ce carré (la quinzième en a deux). Le minage ajouté avec le
   métal ne se déclenche donc jamais : la pierre qu'on voit en stock — 24 à 69
   unités selon les graines — vient des **largages** (`SUPPLY_TABLE`), pas de
   la pioche. Et sans veine minée, pas de minerai : `minerai = 0` sur les
   quinze graines, donc pas un lingot même là où la forge existe.

Proposition (non appliquée, elle changerait le tableau du §9) : sortir les
cases candidates de la forge de l'entrepôt — le poste de fabrication et
l'établi, eux, tombent hors zone et se bâtissent bien —, et porter
`MINE_RADIUS` à la moitié de la carte ou faire chercher le rocher le plus
proche sans rayon. À mesurer ensuite : la chaîne minerai → lingot → épée
tient-elle en trente jours, ou faut-il une campagne de soixante ?

**La réputation, elle, bouge — et pas dans le même sens selon l'interlocuteur.**
La Guilde grimpe à **+43** en moyenne (chaque bande repoussée la fait monter,
et la colonie en repousse 6,6 sur 6,7) ; les deux tribus tombent à −17,6 et
−15,1, avec un écart réel d'une graine à l'autre (de −46 à +11) — ce n'est donc
pas une constante déguisée. Quatre colonies sur trente finissent détestées
(< −40) d'au moins une tribu.

**Le tribut est rare et ne renverse rien.** Dix-huit tributs en campagne
normale, soit 720 bois offerts, mais concentrés sur **cinq** colonies : les
autres n'atteignent jamais le seuil `GIFT_GOODWILL` = −40 **et** les 80 bois
qu'il faut en caisse. Les deux plus généreuses (graines 9 et 29, six tributs
chacune) finissent l'une à −8 et l'autre à **−46** : le même effort ne donne
pas le même résultat, et sur la seconde il ne suffit pas à sortir la tribu de
la détestation. Proposition : compter, en face, la réputation **perdue** par
raid, pour savoir si +goodwill par tribut peut seulement compenser le rythme
des bandes.

### 10.3 État des constats ouverts

- n°2 (graines lentes) : **traité**, §10.1.
- n°3 (forge, minerai, épée invisibles) : **mesuré**, §10.2 — et la réponse est
  que la chaîne ne démarre pas. Deux blocages du joueur scripté restent à
  corriger, avec la mesure qui va avec. → **corrigés le même jour, §11.1.**
- n°5 (réputation et tribut) : **mesurés**, §10.2.
- n°1 (effondrement de l'automne-hiver) et n°4 (apprivoisement) : inchangés,
  toujours ouverts. Le n°4 gagne toutefois une piste solide : le défaut de
  §10.1 montre qu'un fourrage enseveli condamne **toutes** les tentatives
  d'apprivoisement d'une partie, sans rien annoncer. → **traités le même jour,
  §11.2 et §11.3.**

---

## 11. Joueur scripté du 2026-09-06

Cette tranche corrige **l'instrument, pas le jeu** : tout tient dans
`crates/sim-cli/src/campaign.rs`, aucune constante de `crates/sim` n'est
touchée. Les trois constats visés (n°1 automne-hiver, n°3 chaîne du métal,
n°4 apprivoisement) décrivaient tous, à la relecture, un défaut du **joueur**
que le rapport prenait pour un défaut du jeu. Le tableau d'arrivée est au §2,
« Joueur scripté corrigé le 2026-09-06 ».

Une précaution avant tout chiffre : **les écarts de survie entre les deux
joueurs sont du bruit de graine**, et la mesure de bruit du §2 (quatre blocs
de trente graines, même code) le montre — l'ancien joueur va de 6 à 15
colonies éteintes selon le bloc. Ce qui suit ne commente donc que ce qui sort
de ce bruit.

### 11.1 La chaîne du métal : trois blocages, pas deux

Le §10.2 en avait trouvé deux (la forge dans l'entrepôt, le rayon de minage).
Il y en avait un troisième, que seule la correction des deux premiers a rendu
visible.

**a) La forge tombait dans l'entrepôt.** `plan` proposait trois cases fixes,
`(ax+3, ay+3)`, `(ax+4, ay+3)`, `(ax+3, ay+4)`, toutes dans le stockage 4×4.
`Command::Build` refuse **en silence** une case qui porte une pile
(`crates/sim/src/lib.rs`), et `build::can_place` — que le joueur interrogeait —
ne regarde ni les piles ni les zones. Deux gestes :

- `build_free` teste désormais la pile lui-même (`has_pile`) et **saute** la
  case au lieu de réémettre un ordre voué au refus. Ce garde-fou vaut pour
  tout ce que le joueur bâtit, pas seulement la forge ;
- `forge_spots` construit la liste des candidates au lieu de la coder en dur :
  dans l'enceinte, **hors `Zone::Stockpile` et hors `Zone::Growing`**,
  franchissable, sans élément, sans pile, atteignable par un colon, et
  triée par distance au poste de fabrication. La liste est longue : si le plan
  n'apparaît pas, le passage suivant prend la case d'après, sans mémoire.

**b) Le rayon de minage était fixe.** `MINE_RADIUS` = 12 autour du repère, et
quatorze des quinze graines qui payaient la métallurgie n'avaient pas un
rocher dedans. Le rayon **double** maintenant tant qu'il ne voit ni rocher
libre ni marque déjà posée, jusqu'à couvrir la carte ; il s'arrête au premier
rayon qui donne. Les marques restent bornées à `ROCKS_PER_PASS` = 4 en attente,
et l'atteignabilité passe par l'**index de régions** (`Map::same_region_for`,
marcheur `COLONIST`) au lieu d'un A\* — même réponse, 10 ns au lieu de 0,29 ms
(§3), avec repli sur l'A\* si l'index est périmé. Les **veines d'abord** : le
minerai ne se gâte pas et il attend la forge, la pierre ne sert qu'aux vingt
unités de la forge.

**c) L'entrepôt n'avait plus une case pour le minerai** — c'est le troisième,
et il n'a été visible qu'une fois les deux autres levés. Une case d'entrepôt ne
tient qu'**un seul genre** (`Sim::dest_accepts`) ; à seize cases, un entrepôt
qui porte déjà bois, pierre, baies, légumes, repas, viande, cuir, dépouilles,
cadavres, arcs et tuniques n'en a plus une pour le minerai. Les piles restent
alors au pied des rochers, où **rien ne fusionne** (`Sim::spawn_item` ne
fusionne que sur la même case) — et comme `craft::ORE_PER_INGOT` exige trois
minerais **dans une seule pile** alors qu'un rocher veiné en rend deux ou
trois, un rocher sur deux était perdu. Le joueur agrandit donc son entrepôt à
6×6 quand la métallurgie tombe, et **seulement** à ce moment (c'est la seule
entorse au biais n°4 du §8). Mesuré sur la campagne normale, colonies qui
fondent au moins un lingot : **4 sur 14** à seize cases, **6 sur 14** à
trente-six ; forges bâties, 9 sur 14 puis 11 sur 14.

Un détail d'ordre, trouvé par le test : l'agrandissement et le plan de forge ne
peuvent pas partir dans le **même** passage. `forge_spots` lit les zones telles
qu'elles sont, et la commande d'agrandissement n'est pas encore appliquée : la
forge se planterait dans l'entrepôt de demain. Le plan attend donc que
l'entrepôt soit peint.

#### Ce que ça donne

| campagne normale, 30 graines | joueur d'avant | joueur corrigé |
|---|---|---|
| colonies à la métallurgie | 15 | 14 |
| **forges bâties** | **1** | **11** |
| **lingots fondus** | **0** | **16** |
| **épées forgées** | **0** | **1** |
| colonies qui fondent ≥ 1 lingot | 0 sur 15 | **6 sur 14** |
| colonies qui forgent ≥ 1 épée | 0 sur 15 | 1 sur 14 |

Sur les cinq campagnes : **36 forges, 49 lingots, 2 épées**, contre 4 forges,
0 lingot, 0 épée. La chaîne démarre, et elle démarre partout : la campagne
froide, qui n'a que sept colonies à la métallurgie, en a **sept** avec une
forge et **six** avec un lingot.

#### Ce qui ne suit pas : l'épée

L'objectif qu'on s'était fixé — un quart des colonies à la métallurgie avec une
épée — n'est **pas** atteint : 1 sur 14 en normale, 2 sur 45 toutes campagnes
confondues. Le compte est implacable : une épée demande
`craft::METAL_PER_SWORD` = 4 lingots, donc `4 × ORE_PER_INGOT` = **12
minerais**, donc **cinq veines** minées à 360 ticks pièce, ramenées et
fusionnées, dans une colonie qui reçoit 6,6 bandes de pillards en trente jours
et qui compte 1,7 colon vivant à la fin. Les seize lingots de la campagne
normale sont répartis sur six colonies : moins de trois chacune, pour quatre
qu'il faudrait.

Deux fausses pistes éliminées par la mesure, et elles valent d'être écrites :

- **marquer plus de rochers ne sert à rien.** `ROCKS_PER_PASS` porté de 4 à 8 :
  bloc de graines 1, 6 colonies à un lingot au lieu de 6 ; bloc 61, 2 au lieu
  de 4. Le goulot n'est pas la file de marques, c'est le colon ;
- **miner plus tôt fait pire.** Creuser dès que la métallurgie est *à l'étude*
  plutôt qu'une fois acquise paraissait gratuit ; le minage est du
  `WorkType::Designated`, qui passe **avant** `WorkType::Research` dans
  `work::ORDER`, et la recherche s'en trouve retardée : bloc 61, colonies à la
  métallurgie 11 → 7, forges 8 → 3, lingots 18 → 0. Écarté.

Et la question que le §10.2 laissait ouverte — « la chaîne tient-elle en trente
jours, ou faut-il une campagne de soixante ? » — a maintenant sa réponse :
**ce n'est pas la durée qui manque.** Campagne normale en `--days 60`,
30 graines, joueur corrigé : 13 forges, 21 lingots, **1 épée**, et surtout
**27 colonies éteintes sur 30** au jour 60, 6 colons vivants en tout. Doubler
la partie ne double pas la production, elle laisse simplement le temps aux
raids de finir le travail. Si l'on veut voir une colonie s'armer d'acier, c'est
la survie qu'il faut regarder, pas le calendrier.

### 11.2 La tunique passe après l'arc et après l'enceinte

L'objectif « une tunique par colon » était posé dès le premier passage en
automne, et il ne bougeait plus. La tunique se taille au **même poste**, par le
**même `WorkType::Build`** et par le **même bâtisseur** que l'arc et que
l'enceinte. `craft::RECIPES` met bien l'arc avant la tunique, donc la tunique
ne double jamais l'arc **quand l'arc est faisable** — mais un arc coûte douze
bois en une seule pile, et pendant que l'enceinte en réclame 48 × 5, il ne
l'est pas. La tunique, elle, ne coûte que du cuir, que rien d'autre ne dispute :
c'était donc toujours elle qui partait. Deux conditions ajoutées :

1. `sim.colony_total(ItemKind::Bow) >= n` — un arc par colon **déjà dans la
   colonie**, portés compris ;
2. `bois > dette de l'enceinte`, la dette étant la somme des `missing()` des
   plans de mur, de porte et de piège.

**Sur l'ordre d'arme annulé par un ordre d'habit** — la piste était à vérifier,
et la vérification est négative, ce qui mérite d'être écrit : `Command::SetCraftTarget`
range l'objectif dans `craft_targets[kind]`, un emplacement par genre
(`crates/sim/src/lib.rs`) ; il n'abandonne aucun travail en cours et le tunique
n'écrase pas l'arc. Il restait un vrai risque d'annulation, mais il venait
d'ailleurs : le joueur réémettait `SetCraftTarget { Bow, n }` avec `n` = colons
**vivants**, donc un colon tué **abaissait** la demande d'arcs — et la colonie
qui perd du monde est précisément celle qui en a besoin. L'objectif d'armes ne
redescend donc plus (`.max(n)`), et un test le vérifie.

#### Ce que ça donne

| campagne automne-hiver, 30 graines | joueur d'avant | joueur corrigé |
|---|---|---|
| **colons armés / vivants** | **0 / 4** | **5 / 16** |
| colonies éteintes | 28/30 | **24/30** |
| colons au jour 10 / 20 | 1,6 / 0,7 | **2,0 / 1,1** |
| vivres en stock (jours) | **0,0** | **8,1** |
| colonies à ≥ 3 colons | 1/30 | 3/30 |
| morts de froid | 6 sur 169 | 8 sur 182 |

L'objectif du jour — « un taux d'extinction du même ordre que la normale, au
plus le double » — est atteint de justesse : 24/30 contre 11,8/30 en moyenne en
normale (§2), soit **2,0 fois**. Les morts de froid montent de deux : c'est la
contrepartie assumée d'une tunique retardée, et elle est petite devant les
douze colons vivants gagnés.

### 11.3 L'apprivoisement : ce n'était pas le marquage

Trois changements, tous dans `plan` :

1. **plus de jour fixe** (`TAME_DAY` supprimé) : c'est le fourrage qui commande,
   `baies ≥ 30` ;
2. **un lapin, puis un cerf** : le lapin est la bête du débutant
   (`livestock::TAME_BASE_NUM`), mais toutes les cartes n'en portent pas à
   portée ;
3. **la marque se relève** dès qu'elle ne peut plus rien donner (bête morte,
   partie, ou devenue inatteignable), et on **change de bête** tous les deux
   jours tant que rien n'est pris — la bête démarquée redevient candidate au
   passage suivant, celle qu'on marque à la place est forcément une autre
   (`nearest_wild` écarte ce qui est déjà marqué).

Un quatrième geste, découvert en route et qui n'a rien d'un détail : la chasse
et l'apprivoisement se décidaient **sur le même état**, dans le même lot de
commandes, et `nearest_wild` pouvait rendre la **même bête** aux deux. Or les
deux marquages sont exclusifs (`animals::set_hunted`) et `Command::Tame`
s'applique après : la colonie se volait son propre gibier. La bête marquée à la
chasse dans le passage courant est maintenant exclue des candidates à
l'apprivoisement.

**Le comptage demandé par le constat n°4 a été ajouté** : `Run::tame_orders`
(les `Command::Tame { on: true }` émis) et `Run::tamed` (les
`EventKind::Tamed` du journal), au résumé et au JSON.

#### Ce que ça donne, et ce que ça révèle

| campagne normale, 30 graines | joueur d'avant | joueur corrigé |
|---|---|---|
| colonies avec du bétail | 7/30 | **10/30** |
| colonies **vivantes** avec du bétail | — | **8/18** |
| marquages envoyés | — | 78 |
| **bêtes effectivement apprivoisées** | — | **50** |

Les quatre blocs de graines du §2 donnent 8, 10, 12 et 10 colonies vivantes sur
18, 16, 21 et 18 : autour de la moitié, contre 7/30 partout pour le joueur
d'avant. L'objectif « la majorité des colonies vivantes » est donc **frôlé sans
être tenu** — et le comptage dit pourquoi, ce qui est plus intéressant que le
chiffre.

**Cinquante bêtes apprivoisées pour dix qui restent : quarante meurent.**
L'apprivoisement, lui, marche très bien. La contre-épreuve tient en une
commande — la même campagne en `--difficulty 0`, où le storyteller n'envoie
aucune bande :

| | normale (difficulté 2) | paisible (difficulté 0) |
|---|---|---|
| marquages | 78 | **26** |
| bêtes prises | 50 | 24 |
| colonies vivantes | 18 | 29 |
| **colonies vivantes avec du bétail** | 8 | **24** |

Sans raid, **toutes** les colonies qui apprivoisent gardent leur bête, et il
suffit de 26 marquages pour 24 prises (1,08 marquage par bête) contre 78 pour
50 (1,56) : les marquages en trop de la campagne normale sont exactement les
remises de marque après la mort d'une bête.

#### Ce que ça dit du sim (non corrigé, proposition seulement)

Le bétail meurt parce qu'il est **dehors**. Une bête de la colonie tient
`livestock::LIVESTOCK_RANGE` = 12 cases autour du barycentre des colons, quand
l'enceinte du joueur scripté a un demi-côté de 6 : elle paît donc, par
construction, **hors des murs**, sur le chemin des pillards, et elle porte la
faction `Colony`, donc elle est une cible. Aucune conduite du joueur ne peut
l'éviter : il n'a pas d'ordre pour rappeler une bête, pas d'enclos, et
`Command::Slaughter` ne fait que la tuer plus tôt.

Proposition, **non appliquée** (elle déplacerait le tableau du §2) : donner à
la bête de la colonie une raison de rentrer. Le moins invasif serait de borner
son errance à la **pièce** de la colonie quand il y en a une — la couche
`indoor` existe déjà et `LIVESTOCK_RANGE` est la seule constante en cause —, ou
à défaut de la faire fuir vers le barycentre des colons quand un pillard entre
sur la carte, comme les colons se replient. À mesurer d'abord, comme toujours :
compter les bêtes tuées **par un pillard** face à celles qui meurent de faim,
en ajoutant une cause au harnais comme il en existe une pour les colons. Tant
que ce chiffre n'existe pas, « le raid tue le bétail » reste une déduction, pas
une mesure.

### 11.4 Ce qui a changé dans le code, et ce qui le vérifie

Tout est dans `crates/sim-cli/src/campaign.rs` :

- `build_free` refuse une case qui porte une pile (le refus silencieux de
  `Command::Build`) ; `has_pile` ;
- `colonist_can_reach` : l'atteignabilité par l'index de régions, repli A\* ;
- `designate_rocks` prend une `Feature` au lieu d'un booléen, élargit son rayon
  et compte ses marques par espèce de rocher (`scan_rocks`) ;
- `forge_spots` : les candidates de la forge, hors zones et hors piles ;
- `STOCKPILE_SIDE_METAL` : l'entrepôt à 6×6 quand la métallurgie tombe ;
- `nearest_wild` prend une portée et une liste d'exclusion ;
- `TAME_DAY` disparaît, `TAME_RETRY_DAYS` apparaît ;
- l'objectif d'arcs ne redescend plus, la tunique attend l'arc et l'enceinte ;
- `Run::tame_orders` / `Run::tamed`, au tableau, au résumé et au JSON.

Cinq tests, un par correction, dans le module de tests du même fichier :
`la_forge_evite_l_entrepot_la_culture_et_les_piles` (la forge n'est ni en zone
ni sur une pile, le plan **apparaît**, et une pile posée dessus fait choisir
une autre case au passage suivant), `le_minage_elargit_son_rayon_jusqu_au_rocher`,
`les_tuniques_attendent_l_arc_et_l_enceinte` (y compris : l'objectif d'arcs
n'est pas abaissé par une mort), `l_apprivoisement_repose_sa_marque_sur_une_autre_bete`
(marque reposée après la mort de la bête, cerf à défaut de lapin) et
`la_chasse_et_l_apprivoisement_ne_visent_pas_la_meme_bete`.

### 11.5 État des constats ouverts au soir du 2026-09-06

- n°1 (automne-hiver) : **corrigé**, §11.2. Reste à trancher la tunique en
  hiver.
- n°2 (graines lentes) : corrigé, §10.1. Tient toujours : aucune graine des
  cinq campagnes sous 100 000 ticks/s (pire : 101 360).
- n°3 (chaîne du métal) : **corrigé jusqu'au lingot**, §11.1. L'épée reste
  hors d'atteinte, et la cause mesurée est la survie de la colonie, pas la
  durée de la partie.
- n°4 (apprivoisement) : **corrigé**, §11.3 — et il ouvre un constat neuf, sur
  le sim cette fois : le bétail paît hors des murs et se fait tuer.
- n°5 (réputation et tribut) : mesurés, §10.2. Inchangé.
