# Le temps du sim : les constantes en ticks, classées

Le sim compte en **ticks**, toujours 60 par seconde (`TICKS_PER_SECOND`, non
négociable : c'est la cadence du lockstep, du client et du serveur). Depuis
l'échelle du jour (`docs/PLAN.md` §6, fiche `docs/tasks/echelle-du-jour.md`),
une partie porte un facteur **`K` (`Sim::day_scale`, 1..=120)** fixé à sa
création, qui **étire le jour et le travail sans toucher à la physique**.

- `Sim::ticks_per_day()` vaut `TICKS_PER_DAY × K` (14 400 × K).
- `TICKS_PER_DAY` **reste la constante de K = 1** : c'est l'unité dans laquelle
  les durées « en jours » sont écrites, et ce que lisent les tests.
- **K = 1 est l'identité au bit près** : à K = 1 toute mise à l'échelle est une
  multiplication par 1, et le champ `day_scale` n'écrit **aucun octet** dans le
  snapshot (voir `DayScale` dans `crates/sim/src/lib.rs`). Les empreintes
  `sim::scenario::DEMO_HASH`, `TUNDRA_IDLE_HASH` et celles de
  `crates/sim/tests/biomes.rs` ne bougent pas.

Ce fichier est l'**inventaire** : chaque constante en ticks du sim, sa famille,
et la raison en une ligne. C'est lui qui fait foi quand on ajoute une durée.

## Les quatre familles

| famille | ce que c'est | ce que K en fait |
|---|---|---|
| **travail** | un effort ou une maturation qui dure : bâtir, couper, soigner, chercher, s'épuiser au froid | **× K** au point d'usage |
| **physique** | ce qui se voit à l'écran comme un mouvement ou une action instantanée : marcher, frapper, fuir, brûler | **rien** : le tick reste le tick |
| **jours** | déjà écrite en `TICKS_PER_DAY` ou en jours | **suit par construction** dès que la source devient `ticks_per_day()` |
| **calcul** | pas une durée de jeu : une cadence d'évaluation, un pas de calcul, un budget | **rien** — et on vérifie que le résultat **par jour** ne dépend pas de K |

La question qui tranche un cas ambigu (fiche) : *est-ce que ça se voit à l'écran
comme un mouvement ou une action instantanée ?* → physique. *Ou comme un effort
qui dure ?* → travail.

**La règle d'écriture d'une durée de travail.** Toutes les barres de progression
du sim comparent un avancement en centièmes de tick à `X_TICKS * 100` : la mise
à l'échelle se fait sur le **seuil** (`self.scaled(X_TICKS) * 100`), jamais sur
le pas. Multiplier un seuil est exact ; diviser un pas tomberait à zéro.

**La règle d'écriture d'un besoin.** `HUNGER_DECAY` et compagnie valent
`NEED_MAX / TICKS_PER_DAY`, soit 69 points par tick : divisé par K = 30 il ne
resterait que 2 (au lieu de 2,31), et la faim mettrait 15 % de jour de trop à
tomber. Le sim garde donc le **montant de K = 1** et ne l'applique qu'**un tick
sur K** (`Sim::needs_step`, qui lit le tick — déjà dans l'état, aucun champ
nouveau) : même total par jour de jeu à toutes les échelles, aucune division
entière, et l'identité à K = 1 puisque `tick % 1 == 0` est toujours vrai.

---

## La table

### `lib.rs` — la racine

| constante | famille | raison |
|---|---|---|
| `TICKS_PER_SECOND` = 60 | physique | la cadence du monde ; l'échelle du jour existe précisément pour ne pas y toucher |
| `TICKS_PER_DAY` = 14 400 | jours | l'unité de K = 1 ; le sim lit `Sim::ticks_per_day()` = `TICKS_PER_DAY × K` |
| `DAY_START_OFFSET` = `TICKS_PER_DAY × 3/10` | jours | on commence le matin : une fraction de jour, recalculée depuis l'échelle |
| `Sim::time_of_day()` | jours | modulo `ticks_per_day()` |

### `pawn.rs` — les besoins

| constante | famille | raison |
|---|---|---|
| `BASE_SPEED` = 18 | physique | 4,2 cases/s : la marche est ce qu'on regarde, elle ne change pas |
| `HUNGER_DECAY` = `NEED_MAX / TICKS_PER_DAY` | jours | la faim tombe en un jour de jeu ; appliquée un tick sur K (voir la règle des besoins) |
| `REST_DECAY` = `NEED_MAX × 2 / (3 × TICKS_PER_DAY)` | jours | idem : un jour et demi d'éveil |
| `REST_RECOVERY` = `NEED_MAX × 3 / TICKS_PER_DAY` | jours | idem : un tiers de jour de sommeil |
| `BREAK_TICKS` = `TICKS_PER_DAY / 4` | jours | un quart de journée de crise |
| `RELIEF_TICKS` = `TICKS_PER_DAY` | jours | un jour de soulagement |

### `map.rs`, `build.rs` — le chantier

| constante | famille | raison |
|---|---|---|
| `Designation::work_ticks` (couper 240, miner 360, récolter 120) | **travail** | trois efforts, trois barres de progression |
| `BuildKind::work_ticks` (mur 300, porte 400, sol 150, lit 500, feu 200, poste 200, tombe 200, établi 400, piège 150, forge 400) | **travail** | dix chantiers ; c'est le mur de 75 s à K = 30 de la fiche |
| `research::MASONRY_WORK_PERCENT` = 75 | calcul | un pourcentage de la durée : il suit ce qu'il modifie |

### `farm.rs`, `craft.rs` — la nourriture et l'atelier

| constante | famille | raison |
|---|---|---|
| `SOW_TICKS` = 90, `HARVEST_TICKS` = 120, `COOK_TICKS` = 180 | **travail** | semer, récolter, cuisiner : trois gestes qui durent |
| `GROW_TICKS` = `TICKS_PER_DAY × 3/2` | jours | un plant mûrit en un jour et demi, quelle que soit l'échelle |
| `SMELT_TICKS` = 300, `BUTCHER_TICKS` = 120 | **travail** | fondre et dépecer |
| `Recipe::work_ticks` (gourdin, épieu, arc, tunique, manteau, lingot, épée) | **travail** | la fabrication est du travail, recette par recette |

### `health.rs`, `combat.rs` — le sang et les plaies

| constante | famille | raison |
|---|---|---|
| `TEND_TICKS` = 240 | **travail** | panser est un geste de soignant ; c'est le seul de la santé qui soit du travail au sens strict |
| `HEMOSTASIS_TICKS` = `TEND_TICKS / 4` | **travail** | fraction de `TEND_TICKS`, elle le suit |
| `BLEED_TICKS` = `TICKS_PER_DAY / 6` | **physique** | **cas tranché** : une plaie coule le temps d'un combat, et c'est en ticks qu'elle tue (`BLEED_INTERVAL`). L'étirer d'un facteur 30 rendrait mortelle la moindre égratignure ; la garder physique laisse la plaie se refermer au rythme du raid qui l'a faite |
| `BLEED_INTERVAL` = 100, `BLOOD_REGEN_INTERVAL` = 40 | **physique** | l'hémorragie et le sang qui se refait sont l'autre moitié du même cas : ils restent avec le combat |
| `STARVE_DAMAGE_INTERVAL` = 28 | **travail** | **cas tranché** : mourir de faim prend deux jours de jeu, pas 28 ticks. Non étirée, la famine tuerait en 1/30 de jour à K = 30 — c'est une attrition, pas un coup |
| `HEAL_INTERVAL` = 60, `HEAL_INTERVAL_BED` = 30 | **travail** | la convalescence est la maturation type : elle se compte en jours de lit |
| `ATTACK_COOLDOWN` = 60, `RANGED_COOLDOWN` = 90 | physique | un coup par seconde : la cadence du combat est ce qui se voit |
| `REARM_TICKS` = 100 | **travail** | remettre les pointes d'un piège en place |
| `GRACE_DAYS` = 3 | jours | trois jours de répit avant le premier raid |
| `GRIEF_TICKS` = `TICKS_PER_DAY × 2` | jours | deux jours de deuil |
| `MAX_RAIDERS`, `FLEE_HP`, `TRAP_SEVERITY`, dégâts, portées | — | pas des durées |

### `climate.rs`, `weather.rs` — le calendrier et le temps qu'il fait

| constante | famille | raison |
|---|---|---|
| `YEAR_DAYS` = 60, `SEASON_DAYS` = 15 | jours | l'année est en jours : c'est elle que K allonge en heures réelles |
| `day_of_tick`, `season`, `hour` | jours | fonctions du tick divisé par `ticks_per_day()` |
| `FROST_REGROW_DELAY` = `TICKS_PER_DAY / 12` | jours | deux heures de jeu avant qu'un buisson gelé reparte |
| `UNDRESS_TICKS` = 600 | **travail** | **cas tranché** : ce n'est pas un geste (retirer son manteau), c'est le temps qu'il faut passer *au chaud* avant de le retirer — une exposition qui dure |
| `HYPOTHERMIA_INTERVAL` = 200 | **travail** | **cas tranché** : geler est une attrition, comme la famine. Non étirée, elle tuerait 30 fois plus vite par jour de jeu que la cicatrisation ne répare — le commentaire de `tick_injuries` dit déjà que ces deux-là se comparent |
| durée d'une période météo (`TICKS_PER_DAY/4` à `TICKS_PER_DAY`) | jours | du quart de jour au jour |
| températures, malus d'humeur, seuils | — | pas des durées |

### `fire.rs` — le feu

| constante | famille | raison |
|---|---|---|
| `FIRE_INTERVAL` = 10, `FIREFIGHT_RETRY` | calcul | cadence d'évaluation de l'incendie ; les ticks brûlés sont comptés par `FIRE_INTERVAL`, le résultat par jour ne dépend donc pas de K |
| `FIRE_BURN_TICKS` = 900, `FIRE_GROWTH`, diviseurs de propagation | physique | une case brûle en 15 s et le feu court : c'est ce qu'on regarde brûler |
| `EXTINGUISH_TICKS` = 80 | **physique** | **cas tranché** : battre les flammes est du travail, mais il court contre un feu qui, lui, ne ralentit pas. À K = 30 une case prendrait 40 s à éteindre pendant que le foyer voisin s'allume en 2 s : la colonie brûlerait par construction |
| `LIGHTNING_DEN` = 1 200, `CAMPFIRE_SPARK_DEN` = 7 200 | **travail** | **cas tranché** : ce sont des chances *par évaluation*, mais leur contrat mesuré est en jours (« un impact par orage », « un départ par cinq jours »). Le dénominateur est multiplié par K, sinon un jour de jeu compterait K fois plus de départs de feu |
| `LIGHTNING_DRAWS`, `QUENCH_DEN`, `FIRE_PATH_COST_MULT` | calcul | tirages et coûts, pas des durées |

### `animals.rs`, `livestock.rs` — les bêtes

| constante | famille | raison |
|---|---|---|
| `FLEE_TICKS` = 600, `FLEE_REPLAN` = 30 | physique | une bête détale : dix secondes de course, replanifiée deux fois par seconde |
| `GRAZE_MIN` = 90, `GRAZE_SPAN` = 91 | physique | le pas d'une bête qui broute est un déplacement |
| `RETREAT_INTERVAL` = 30 | physique | le repli du bétail vers l'enceinte est un déplacement |
| délai d'un troupeau (`TICKS_PER_DAY + below(TICKS_PER_DAY)`, puis 2 à 4 jours) | jours | la faune arrive tous les deux à quatre jours |
| `TAME_TICKS` = 300, `SLAUGHTER_TICKS` = 60 | **travail** | apprivoiser et abattre |
| `TAME_RETRY` = `TICKS_PER_DAY / 8` | jours | on retente trois heures plus tard |
| `LIVESTOCK_HUNGER_DECAY` | jours | même règle que la faim des colons (un tick sur K) |
| `FEED_INTERVAL` = 300, `BREED_INTERVAL` = 600 | calcul | deux portes d'évaluation : la vraie échéance est `breed_days × ticks_per_day()` |
| période de gestation `breed_days × TICKS_PER_DAY` | jours | la gestation est en jours |

### `jobs.rs` — la recherche de travail

| constante | famille | raison |
|---|---|---|
| `RETRY_TICKS` = 30 | calcul | **cas tranché** : c'est une borne de latence, pas une durée de jeu. Un colon sans travail réessaie une demi-seconde plus tard, à K = 1 comme à K = 30 ; l'étirer ferait attendre 15 s à un colon devant un tas de bois |
| `PATH_ATTEMPTS` = 6, budgets d'A\* | calcul | des candidats, pas des ticks |
| `BREAK_WANDER_INTERVAL` = 30 | physique | l'errance d'une crise est un déplacement (la crise, elle, dure `BREAK_TICKS`) |
| flânerie d'un colon sans travail (90 ticks, `idle_wander`) | physique | un colon qui traîne fait un pas de temps en temps : c'est du mouvement |
| `SPOILAGE_INTERVAL` = 60 | calcul | cadence d'évaluation : la perte est `elapsed / durée de vie`, et la durée de vie est en jours — le total par jour est le même à toutes les échelles |
| repousse d'un buisson (`self.tick + TICKS_PER_DAY`) | jours | un jour |

### `items.rs` — la péremption

| constante | famille | raison |
|---|---|---|
| `shelf_life` (baies 3 j, légumes 4 j, repas 2 j, viande 2 j, cadavre 3 j) | jours | écrites en `TICKS_PER_DAY` |
| `FRESHNESS_MAX` = 1 000 000 | calcul | une échelle en millionièmes, pas un temps |

### `social.rs` — la vie de colonie

| constante | famille | raison |
|---|---|---|
| `CHAT_TICKS` = 90 | **travail** | **cas tranché** : un temps passé ensemble, pas un geste |
| `CHAT_COOLDOWN` = 1 200 | **travail** | **cas tranché, et c'est lui qui décide** : la dispute et la rixe se tirent *par bavardage*. Laissé en ticks réels, un jour de jeu à K = 30 compterait 30 fois plus de conversations, donc 30 fois plus de rixes |
| `SOCIAL_TICKS`, `QUARREL_TICKS` = `TICKS_PER_DAY` | jours | un bonus d'humeur par jour |
| `MAX_GRIEF_TICKS` = `GRIEF_TICKS × 2` | jours | suit le deuil |

### `research.rs` — la recherche

| constante | famille | raison |
|---|---|---|
| `Tech::cost` (2 000 à 3 500 points) | **travail** | c'est le seuil d'un effort : il est multiplié par K, comme celui d'un chantier |
| `RESEARCH_SESSION` = 600 | **travail** | une séance à l'établi ; non étirée, un chercheur lâcherait sa place 30 fois plus souvent par jour |
| `RESEARCH_STEP` = 20, `PROGRESS_SCALE` = 100 | calcul | des centièmes de point par tick |
| `AGRICULTURE_BONUS_INTERVAL` = 4 | calcul | un tick de pousse sur quatre compte double : un pas de calcul dont la cible (`GROW_TICKS`) est en jours |

### `storyteller.rs`, `trade.rs`, `factions.rs` — ce qui arrive à la colonie

| constante | famille | raison |
|---|---|---|
| `DAYS_PER_THREAT` = 2, `SUPPLY/ILLNESS/EXTREME_MIN_DAYS` et `_SPAN_DAYS`, `TRADER_MIN_DAYS`, `TRADER_SPAN_DAYS` | jours | écrites en jours, converties par `ticks_per_day()` |
| cadence des raids (`Difficulty::raid_delay`, `TICKS_PER_DAY × n`) | jours | deux à trois jours entre deux bandes |
| `REPRISAL_MIN`, `REPRISAL_SPAN`, `RAID_DEATH_RESPITE` | jours | fractions de jour |
| `ILLNESS_TICKS`, `ILLNESS_TENDED_TICKS`, `EXTREME_TICKS` | jours | une maladie dure deux jours, un coup de temps un jour |
| `TRADER_STAY`, `TRADER_GRUDGE_EXTRA`, `TRADER_GRUDGE_TICKS` | jours | un jour d'étal, quinze jours de rancune |
| `FADE_PER_DAY` = 1 | jours | un point par jour, déclenché sur `ticks_per_day()` |
| `SIEGE_TICKS` = 1 200 | **physique** | **cas tranché** : « le temps de fermer une porte » — vingt secondes réelles données au joueur pendant l'assaut. Ce délai n'a de sens qu'en temps réel |
| `WEALTH_CACHE_TICKS` = 600 | calcul | fraîcheur d'un cache ; non étiré il est simplement plus frais à grand K |

### `fastforward.rs` — la carte gelée

| constante | famille | raison |
|---|---|---|
| `MAX_FAST_FORWARD` = `TICKS_PER_DAY × 60` | jours | soixante jours de jeu, quelle que soit l'échelle |
| `ticks / TICKS_PER_DAY` (rancunes, événement) | jours | comptage de jours écoulés |
| `ticks / HEAL_INTERVAL` (cicatrisation d'un coup) | travail | suit `HEAL_INTERVAL` |
| `FROZEN_HUNGER`, `FROZEN_REST` | — | des niveaux, pas des durées |

### `path.rs`, `map.rs` — le déplacement

| constante | famille | raison |
|---|---|---|
| coûts de terrain, `Walker`, diagonales | physique | la marche, encore : c'est elle que l'échelle du jour rend relativement gratuite (voir `CAMPAIGN-FINDINGS.md` §15) |

---

## Compte

| famille | entrées de la table |
|---|---|
| travail (× K) | 24 |
| physique (inchangée) | 18 |
| jours (suit par construction) | 30 |
| calcul (inchangée, vérifiée) | 13 |

Les entrées comptent des **lignes de la table**, pas des constantes : une
ligne comme `BuildKind::work_ticks` en porte dix à elle seule.

## Ce que la mesure a trouvé aux frontières

Deux croisements de familles se voient à la campagne (`CAMPAIGN-FINDINGS.md`
§15.4 et §15.5), et il faut les connaître avant de ranger une durée nouvelle :

- **l'hémostase contre le saignement** : `HEMOSTASIS_TICKS` est du travail, le
  saignement est physique. À K = 30, la compression arrive après que le blessé
  se soit vidé, et les morts de blessures passent de 9 % à 33 %. Le §15.4
  propose de reclasser `HEMOSTASIS_TICKS` en physique — **non appliqué**.
- **la météo contre le feu** : une période de temps sec est en jours, un
  incendie est physique. À K = 30, aucune averse ne tombe plus pendant la vie
  d'un feu, et la surface brûlée double. Le §15.5 laisse le constat ouvert —
  **rien n'est appliqué**.

La leçon générale : quand une durée d'une famille **court contre** une durée
de l'autre, l'échelle change le vainqueur. Un classement isolément défendable
peut être faux en couple.

## Ce que l'échelle ne touche pas, et pourquoi c'est voulu

À K = 30, un colon traverse la carte en autant de secondes qu'avant, mais cela
ne lui coûte plus qu'un trentième de journée : **le déplacement devient
relativement gratuit**. C'est la conséquence assumée de la décision (plan §6),
pas un effet de bord — et c'est ce que la campagne du §15 de
`CAMPAIGN-FINDINGS.md` mesure.

De même, un raid se joue en secondes réelles : les colons frappent, saignent et
fuient au même rythme qu'à K = 1, dans une journée trente fois plus longue.
