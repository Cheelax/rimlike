//! Le feu : ce qui brûle, à quelle vitesse, comment ça se propage et comment
//! la colonie s'y oppose.
//!
//! L'état tient en trois morceaux :
//!
//! - une couche `fire` dans `Map`, un octet par case (0 éteint, 1 à
//!   `FIRE_MAX`), lue en zéro-copie par le client comme `zones` ou `indoor`,
//!   avec son compteur (`Map::fire_count`) et son numéro de version ;
//! - la liste `Sim::burning`, une entrée par case en feu, qui porte le temps
//!   passé à brûler. C'est **elle** qu'on parcourt : jamais la carte. Sans
//!   feu, la liste est vide et l'évaluation ne coûte rien ;
//! - `Sim::fires_lit`, le nombre de cases enflammées depuis le début de
//!   l'incendie en cours, annoncé par `EventKind::FireOut` quand tout est
//!   éteint.
//!
//! La dynamique n'est évaluée qu'un tick sur `FIRE_INTERVAL` : le feu n'a
//! pas besoin de la précision du tick, et un incendie de forêt ne doit pas
//! peser sur les 59 autres soixantièmes de seconde.
//!
//! Trois départs possibles : la foudre pendant un orage, une escarbille de
//! feu de camp par temps chaud et sec, et `Command::Ignite` (débogage et
//! futur outil du joueur). La propagation, elle, est silencieuse : un seul
//! `FireStarted` par incendie, un seul `FireOut` à la fin.
//!
//! **Le feu suit le vent.** C'est ce qui l'empêche d'être un processus de
//! branchement surcritique : une case en feu prend presque sûrement sa voisine
//! sous le vent, rarement celles des côtés, presque jamais celle d'amont
//! (`CROSS_SPREAD_DIVISOR`, `BACK_SPREAD_DIVISOR`). Un incendie court donc en
//! panache, traverse ce qu'il a devant lui et s'arrête — au lieu de s'étaler
//! en tache jusqu'à manquer de combustible. Le vent n'est **pas** un champ de
//! plus dans `Sim` : il se lit dans le bruit de température de la période
//! météo courante (`wind_direction`), et tourne donc quand le temps change.

use serde::{Deserialize, Serialize};

use crate::climate::{FREEZING, WEATHER_NOISE};
use crate::health::{self, HIT_WEIGHT_TOTAL};
use crate::items::ItemKind;
use crate::jobs::Reservation;
use crate::map::{Feature, Terrain, chebyshev};
use crate::path::{self, Walker};
use crate::pawn::{Faction, Job};
use crate::weather::Weather;
use crate::{EventKind, Sim};

/// Intensité maximale d'un feu. La couche `fire` de `Map` ne porte jamais
/// plus (voir `Map::set_fire`).
pub const FIRE_MAX: u8 = 3;

/// Un tick sur `FIRE_INTERVAL` évalue le feu : croissance, propagation,
/// extinction, brûlures et départs. Toutes les durées ci-dessous sont en
/// ticks et arrondies à ce pas.
pub const FIRE_INTERVAL: u64 = 10;

/// Ticks nécessaires pour monter d'un cran d'intensité : 2,5 s de jeu. Une
/// case atteint donc l'intensité 2 (celle qui propage) à 150 ticks et 3 à 300.
pub const FIRE_GROWTH: u32 = 150;

/// Ticks au bout desquels une case a consommé son combustible et s'éteint :
/// 15 s de jeu. Assez long pour qu'un colon parti à l'autre bout de la
/// colonie arrive à temps (voir `EXTINGUISH_TICKS`), assez court pour qu'un
/// incendie avance et ne stagne pas.
pub const FIRE_BURN_TICKS: u32 = 900;

/// À partir de cette intensité, une case enflamme ses voisines.
pub const SPREAD_MIN: u8 = 2;

/// Chance qu'une case à intensité `SPREAD_MIN` ou plus enflamme le voisin
/// **sous le vent**, par évaluation. Les trois autres directions divisent ce
/// chiffre (voir `CROSS_SPREAD_DIVISOR` et `BACK_SPREAD_DIVISOR`).
///
/// **Posé sur la géométrie, puis mesuré.** Une case passe
/// `(FIRE_BURN_TICKS - FIRE_GROWTH) / FIRE_INTERVAL` = 75 évaluations à
/// intensité ≥ 2 avant de s'éteindre : à 1/40, elle finit par prendre le
/// voisin sous le vent dans `1 - (39/40)^75` ≈ 85 % des cas. Un front avance
/// donc presque sûrement, et c'est voulu : un départ de feu doit coûter
/// quelque chose. Ce qu'il ne doit plus faire, c'est s'élargir dans les quatre
/// directions à la fois — voir `CROSS_SPREAD_DIVISOR`.
pub const FIRE_SPREAD_NUM: u32 = 1;
pub const FIRE_SPREAD_DEN: u32 = 40;

/// Le feu suit le vent. Vers les deux côtés, la chance de propagation est
/// divisée par ce facteur ; vers l'amont, par `BACK_SPREAD_DIVISOR`.
///
/// **C'est ce qui empêche l'incendie d'être un processus de branchement
/// surcritique.** Sans vent, une case en feu tire 75 fois vers chacune de ses
/// quatre voisines : l'espérance d'allumages dépasse 1,9 et le feu croît
/// jusqu'à manquer de combustible (mesuré : 99 % d'un bosquet de 20×20).
/// Avec le vent, l'espérance vers l'aval reste 0,85 mais tombe à 0,46 de
/// chaque côté et à 0,10 en amont : le feu court en panache au lieu de
/// s'étaler en tache, et il s'arrête quand il a traversé le bosquet.
///
/// Mesure, vingt graines, bosquet de 20×20 arbres isolé sur de la terre nue,
/// allumé au centre, 30 °C, temps clair, personne pour éteindre
/// (`crates/sim/tests/balance_fire.rs`) :
///
/// | côtés / amont | médiane brûlée | min | max | dans 15-60 % |
/// |---|---|---|---|---|
/// | 1 / 1 (sans vent) | 399 (99 %) | 397 | 400 | 0/20 |
/// | 2 / 4 | 350 (87 %) | 124 | 390 (97 %) | 2/20 |
/// | 2 / 8 | 175 (43 %) | 112 | 351 (88 %) | 15/20 |
/// | 3 / 6 | 162 (40 %) | 1 | 248 (62 %) | 17/20 |
/// | 3 / 12 | 125 (31 %) | 1 | 237 (59 %) | 17/20 |
/// | **3 / 16** | **112 (28 %)** | 1 | **168 (42 %)** | **17/20** |
/// | 4 / 8 | 80 (20 %) | 1 | 179 | 13/20 |
///
/// 3 / 16 tient la bande 15-60 % pour dix-sept graines sur vingt **et** garde
/// la pire à 42 % : c'est le seul palier qui laisse de la marge des deux
/// côtés. Élargir le panache (2 sur les côtés) laisse repasser des graines
/// au-dessus de 85 % ; le rétrécir (4) fait mourir treize feux sur vingt avant
/// d'avoir pris. Le facteur d'amont compte autant que celui des côtés : à
/// côtés égaux, passer de 6 à 16 en amont fait tomber le pire cas de 62 % à
/// 42 % — c'est le retour de flamme qui remplissait la tache.
pub const CROSS_SPREAD_DIVISOR: u32 = 3;
pub const BACK_SPREAD_DIVISOR: u32 = 16;

/// Sous la pluie (ou la neige), la chance de propagation est divisée par ce
/// facteur.
pub const WET_SPREAD_DIVISOR: u32 = 4;

/// Sous `FREEZING`, elle l'est par celui-ci. Le gel **ne tue plus** un feu
/// (voir `quench_chance`) : du bois sec brûle par −10 °C, il brûle seulement
/// plus lentement. C'est la différence entre « le feu n'existe pas en hiver »
/// et « le feu est moins vif en hiver ».
///
/// Même bosquet, même mesure, temps clair et sec :
///
/// | climat | médiane brûlée | moyenne | maximum |
/// |---|---|---|---|
/// | 30 °C | 112 (28 %) | 105 | 168 |
/// | 0 °C (il gèle la nuit) | 73 (18 %) | 63 | 139 |
/// | −5 °C (il gèle toujours) | **5 (1 %)** | **13,9** | 45 |
///
/// Avant, la troisième ligne valait 0 partout : sous zéro, une case avait une
/// chance sur quatre de s'éteindre par évaluation et n'atteignait jamais
/// `SPREAD_MIN`. Le feu d'hiver reste huit fois plus petit que celui d'été,
/// mais il existe — et une moitié des départs s'éteint encore sans rien
/// prendre, ce qui est le bon régime pour un accident d'hiver.
pub const COLD_SPREAD_DIVISOR: u32 = 2;

/// Dénominateur des chances d'extinction naturelle (voir `quench_chance`).
pub const QUENCH_DEN: u32 = 4;

/// Multiplicateur de coût d'une case en feu pour la recherche de chemin
/// (`path::Walker::avoids_fire`). Les coûts sont en centièmes, 100 pour une
/// case d'herbe : à 50, contourner un brasier vaut la peine jusqu'à une
/// cinquantaine de cases de détour. Ce n'est **pas** un mur : un colon
/// enfermé par les flammes traverse plutôt que de rester planté.
pub const FIRE_PATH_COST_MULT: u32 = 50;

/// Au-dessus de cette température (en dixièmes de degré, soit 20 °C), et
/// seulement par temps sec, l'herbe compte comme combustible. En dessous, un
/// pré ne prend pas : c'est ce qui évite qu'un feu de camp d'hiver rase la
/// carte.
pub const GRASS_FIRE_TEMP: i32 = 200;

/// Sévérité d'une brûlure par cran d'intensité et par évaluation. Une case à
/// l'intensité maximale coûte donc 36 points de sévérité toutes les
/// `FIRE_INTERVAL` ticks, soit un peu plus de 200 par seconde de jeu : rester
/// dans les flammes tue en quelques secondes, les traverser en courant se
/// paie sans être fatal. La blessure **ne saigne pas** (une brûlure ne
/// s'ouvre pas) mais reste à panser comme les autres : elle appelle un
/// camarade et cicatrise au rythme ordinaire.
pub const BURN_SEVERITY: u32 = 12;

/// Ticks de travail pour battre **un cran** d'intensité : une case à 3 demande
/// trois fois ça. Un colon à cinq cases met environ 70 ticks à arriver et 240
/// à éteindre un brasier complet, bien avant les `FIRE_BURN_TICKS` qui
/// consumeraient la case.
pub const EXTINGUISH_TICKS: u32 = 80;

/// Vitesse à laquelle on bat les flammes, en centièmes de tick. Neutre, comme
/// celle du soin (`health::TEND_STEP`) : lutter contre le feu n'est pas un
/// `WorkType` (en ajouter un changerait `WORK_TYPES` et les tampons de
/// priorités), donc ni l'humeur ni la compétence ne la modulent.
pub const EXTINGUISH_STEP: u32 = 100;

/// Au-delà de cette distance au barycentre des colons, un feu n'est pas leur
/// affaire : la forêt qui brûle à l'autre bout de la carte brûlera sans eux.
pub const FIREFIGHT_RADIUS: u32 = 25;

/// Cadence de réévaluation de la lutte, en ticks. C'est celle du feu
/// (`FIRE_INTERVAL`), et pour la même raison : entre deux évaluations, ni les
/// foyers, ni les murs, ni les distances ne changent — un colon inactif qui
/// relance sa recherche à chaque tick paie dix fois le même prix pour la même
/// réponse.
///
/// **Sans état.** Le pas se lit dans `Sim::tick`, pas dans un champ de `Pawn` :
/// `tick % FIREFIGHT_RETRY == 0` suffit et vaut pour tout le monde en même
/// temps. Décaler la phase par colon (`(tick + id) % …`) étalerait mieux la
/// charge, mais casserait l'enchaînement `drop_work_for_fire` → `find_job`
/// **dans le même tick** dont dépend l'interruption de travail : un colon
/// lâcherait sa besogne sans pouvoir prendre les flammes.
pub const FIREFIGHT_RETRY: u64 = FIRE_INTERVAL;

/// Chance par évaluation qu'un éclair mette le feu pendant un orage.
///
/// **Mesurée, pas déduite.** `weather::tick_weather` tire une durée d'orage de
/// `TICKS_PER_DAY / 4` à `TICKS_PER_DAY`, soit 9 000 ticks en moyenne — mais
/// deux périodes d'orage consécutives se suivent parfois, ce qui allonge les
/// orages réellement vécus. Vingt jours de jeu sur vingt graines, carte boisée,
/// météo naturelle :
///
/// | dénominateur | orages | impacts | impacts par orage |
/// |---|---|---|---|
/// |   900 | 67 | 94 | 1,40 |
/// | **1 200** | 74 | 76 | **1,03** |
///
/// 1 200 est donc le palier qui tient le contrat « environ un impact par
/// orage ». Sur deux jours d'orage forcé, 17 graines sur 20 voient un départ
/// (voir `lightning_strikes_during_storms`). L'éclair ne tombe que sur une
/// case combustible : `LIGHTNING_DRAWS` tirages, sinon il tombe dans l'eau.
pub const LIGHTNING_NUM: u32 = 1;
pub const LIGHTNING_DEN: u32 = 1_200;
/// Tirages de case pour un éclair avant d'abandonner.
pub const LIGHTNING_DRAWS: u32 = 8;

/// Au-dessus de cette température (15 °C) et par temps sec, un feu de camp
/// peut lâcher une escarbille sur une case voisine.
pub const CAMPFIRE_SPARK_TEMP: i32 = 150;

/// Chance par évaluation qu'un feu de camp mette le feu à côté de lui.
///
/// **Mesurée avant d'être réglée** (voir
/// `campfire_can_start_a_fire_in_dry_heat`). Cinq jours d'été font 72 000
/// ticks, soit 7 200 évaluations : le dénominateur *est* le contrat « environ
/// un départ par cinq jours de feu de camp entouré d'herbe sèche ». Vingt
/// graines, 30 °C imposés, temps clair forcé, un feu de camp au milieu d'un
/// pré :
///
/// | dénominateur | 1 jour | 2 jours | 5 jours |
/// |---|---|---|---|
/// | 4 000 | 10/20 | 16/20 | 18/20 |
/// | **7 200** | 7/20 | 10/20 | **16/20** |
///
/// 4 000 tenait mieux le test statistique mais faisait presque deux départs
/// par cinq jours : un feu de camp devenait une bombe. À 7 200, l'espérance
/// vaut exactement un départ sur la période visée, et 16 graines sur 20 en
/// voient au moins un — le sim étant déterministe, ce chiffre-là ne bouge plus.
pub const CAMPFIRE_SPARK_NUM: u32 = 1;
pub const CAMPFIRE_SPARK_DEN: u32 = 7_200;

/// Cause annoncée par `EventKind::FireStarted` (`arg`).
pub const CAUSE_LIGHTNING: u32 = 0;
pub const CAUSE_CAMPFIRE: u32 = 1;
pub const CAUSE_ORDER: u32 = 2;

/// Voisines considérées pour la propagation : les quatre orthogonales. Un feu
/// ne saute pas en diagonale entre deux murs.
const NEIGHBOURS: [(i32, i32); 4] = [(0, -1), (0, 1), (-1, 0), (1, 0)];

/// Une case qui brûle. `ticks` est le temps passé en feu : il décide de
/// l'intensité (`FIRE_GROWTH`) et du moment où le combustible est consommé
/// (`FIRE_BURN_TICKS`). L'intensité elle-même vit dans la couche `fire` de
/// `Map`, que le client lit ; ce champ-là est la mémoire du foyer.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Fire {
    pub x: u32,
    pub y: u32,
    pub ticks: u32,
}

/// L'élément posé sur la case brûle-t-il ? Tout ce qui est en bois ou
/// végétal : arbres, buissons (mûrs ou non), plants, murs et portes de bois,
/// lits, postes de fabrication, établis, pièges à pointes. Pas la pierre
/// (murs, portes, tombes), pas la roche, et **pas le feu de camp** : c'est
/// déjà un feu, maîtrisé.
pub fn feature_burns(f: Feature) -> bool {
    matches!(
        f,
        Feature::Tree
            | Feature::Bush
            | Feature::BushUnripe
            | Feature::Crop
            | Feature::CropRipe
            | Feature::WallWood
            | Feature::DoorWood
            | Feature::Bed
            | Feature::CraftingSpot
            | Feature::ResearchBench
            | Feature::SpikeTrap
            | Feature::SpikeTrapSprung
    )
}

/// Le sol brûle-t-il ? Le plancher de bois toujours ; l'herbe seulement quand
/// elle est sèche et qu'il fait chaud (`GRASS_FIRE_TEMP`). Le reste — sable,
/// terre, gravier, dalle, eau — jamais.
///
/// La condition de l'herbe vaut aussi bien pour l'allumage que pour la
/// suite : un pré qui prend, puis une averse ou un coup de froid, et le feu
/// n'a plus de quoi brûler. C'est voulu, et c'est ce qui rend l'herbe sèche
/// dangereuse **l'été seulement**.
pub fn terrain_burns(t: Terrain, temperature: i32, wet: bool) -> bool {
    match t {
        Terrain::WoodFloor => true,
        Terrain::Grass => !wet && temperature > GRASS_FIRE_TEMP,
        Terrain::DeepWater
        | Terrain::ShallowWater
        | Terrain::Sand
        | Terrain::Dirt
        | Terrain::Gravel
        | Terrain::StoneFloor => false,
    }
}

/// La pile brûle-t-elle ? **Tout sauf le minéral** : la pierre, le minerai et
/// le lingot ne prennent pas ; le bois, les vivres, le cuir, les habits, les
/// armes (un arc et un gourdin sont en bois, un épieu aussi pour l'essentiel,
/// et une épée a un manche) et jusqu'aux dépouilles, oui.
pub fn item_burns(kind: ItemKind) -> bool {
    !matches!(kind, ItemKind::Stone | ItemKind::Ore | ItemKind::Metal)
}

/// Chance qu'une case en feu s'éteigne d'elle-même à chaque évaluation, en
/// `(numérateur, dénominateur)`. **Seul ce qui tombe du ciel éteint** : rien
/// par temps clair, la pluie et l'orage une fois sur quatre, la neige deux
/// fois sur quatre.
///
/// Le froid, lui, n'éteint plus rien. Il éteignait : une case gelée avait une
/// chance sur quatre de s'éteindre par évaluation, soit une espérance de vie
/// de 40 ticks quand il en faut `FIRE_GROWTH` = 150 pour atteindre
/// `SPREAD_MIN`. Aucun feu ne franchissait donc jamais le premier palier sous
/// zéro — mesuré en campagne : **exactement une case brûlée par départ**,
/// trente-neuf pour trente-neuf feux. Le froid ralentit maintenant la
/// propagation (`COLD_SPREAD_DIVISOR`) au lieu de la supprimer.
pub fn quench_chance(weather: Weather) -> (u32, u32) {
    let wet = match weather {
        Weather::Clear => 0,
        Weather::Rain | Weather::Storm => 1,
        Weather::Snow => 2,
    };
    (wet, QUENCH_DEN)
}

/// Direction du vent, en décalage de case. Elle se lit dans le bruit de
/// température de la période météo courante (`Sim::weather_noise`, tiré par
/// `tick_weather` à chaque changement de temps) : **aucun champ de plus dans
/// `Sim`**, et le vent tourne naturellement quand le temps change, quelques
/// heures à une journée. Un incendie qui dure assez longtemps voit donc son
/// panache s'infléchir.
pub fn wind_direction(weather_noise: i32) -> (i32, i32) {
    // `weather_noise` vit dans `-WEATHER_NOISE..WEATHER_NOISE` : quatre
    // tranches égales, une par direction. La saturation et le `clamp` sont là
    // pour un vieux snapshot au bruit aberrant, pas pour le jeu ; le `max(1)`
    // pour qui rétrécirait un jour `WEATHER_NOISE`.
    let width = (2 * WEATHER_NOISE / NEIGHBOURS.len() as i32).max(1);
    let slice = weather_noise
        .saturating_add(WEATHER_NOISE)
        .clamp(0, 2 * WEATHER_NOISE - 1)
        / width;
    NEIGHBOURS[(slice as usize).min(NEIGHBOURS.len() - 1)]
}

/// Chance de propagation d'une case en feu vers la voisine `offset`, par
/// évaluation : `FIRE_SPREAD_NUM / FIRE_SPREAD_DEN` sous le vent, divisée
/// par `CROSS_SPREAD_DIVISOR` sur les côtés et `BACK_SPREAD_DIVISOR` à
/// contre-vent, puis encore par `WET_SPREAD_DIVISOR` s'il tombe de l'eau et
/// par `COLD_SPREAD_DIVISOR` s'il gèle.
pub fn spread_chance(offset: (i32, i32), wind: (i32, i32), wet: bool, cold: bool) -> (u32, u32) {
    let wind_divisor = if offset == wind {
        1
    } else if offset == (-wind.0, -wind.1) {
        BACK_SPREAD_DIVISOR
    } else {
        CROSS_SPREAD_DIVISOR
    };
    let mut den = FIRE_SPREAD_DEN * wind_divisor;
    if wet {
        den *= WET_SPREAD_DIVISOR;
    }
    if cold {
        den *= COLD_SPREAD_DIVISOR;
    }
    (FIRE_SPREAD_NUM, den)
}

/// Intensité d'une case selon le temps qu'elle a passé à brûler : 1 au
/// départ, un cran de plus tous les `FIRE_GROWTH` ticks, plafonnée à
/// `FIRE_MAX`.
pub fn level_for(ticks: u32) -> u8 {
    (ticks / FIRE_GROWTH + 1).min(u32::from(FIRE_MAX)) as u8
}

/// Un foyer à battre et le chemin pour aller se poster à côté. Les deux vont
/// ensemble : qui trouve l'un a payé l'autre.
type FireTarget = ((u32, u32), Vec<path::Tile>);

/// Ce que la lutte contre le feu apprend pendant **une salve** — un tick — et
/// rien de plus. `Sim::update` en crée une par tick, la passe à chaque colon
/// dans l'ordre des indices, et la jette à la fin.
///
/// Ce n'est **pas** de l'état : rien n'en sort, elle n'entre ni dans le
/// snapshot ni dans le hash, et le tick suivant repart d'une salve vide. Elle
/// est déterministe pour la même raison que le reste du sim : les colons sont
/// parcourus par indice, toujours dans le même ordre, donc ce que le colon 0 y
/// écrit, le colon 1 le lit — partout, et à toutes les exécutions.
#[derive(Debug, Default)]
pub(crate) struct Salvo {
    /// Foyers dont un colon a démontré, ce tick-ci, qu'aucune de leurs
    /// voisines n'est atteignable. Les autres ne relancent pas l'A\* qui vient
    /// d'échouer : c'est le plus cher de tous, il explore **toute** la région
    /// où se tient le colon avant de rendre `None`, et ses camarades partent
    /// du même bout de carte. La liste est courte par construction — on n'y
    /// inscrit un foyer qu'en dépensant des essais, eux-mêmes bornés.
    blocked: Vec<(u32, u32)>,
    /// Réponse déjà calculée pour un colon dans ce tick, et le colon en
    /// question : `drop_work_for_fire` pose la question, `find_job` la repose
    /// aussitôt après, pour le même colon et sur un état que rien n'a bougé
    /// entre les deux.
    memo: Option<(u32, Option<FireTarget>)>,
}

impl Salvo {
    fn is_blocked(&self, x: u32, y: u32) -> bool {
        self.blocked.contains(&(x, y))
    }

    fn block(&mut self, x: u32, y: u32) {
        self.blocked.push((x, y));
    }

    fn recall(&self, pawn: u32) -> Option<Option<FireTarget>> {
        match &self.memo {
            Some((id, found)) if *id == pawn => Some(found.clone()),
            _ => None,
        }
    }

    fn remember(&mut self, pawn: u32, found: Option<FireTarget>) {
        self.memo = Some((pawn, found));
    }
}

/// Ce que `Sim::path_beside_fire` a pu conclure. La différence entre les deux
/// derniers n'est pas cosmétique : seul `Unreachable` est une **démonstration**,
/// et seule une démonstration autorise à inscrire le foyer au tableau des
/// inatteignables de la salve.
enum Beside {
    /// Chemin trouvé vers une voisine tenable du foyer.
    Path(Vec<path::Tile>),
    /// Toutes les voisines tenables ont été essayées, aucune n'est atteignable.
    Unreachable,
    /// Le budget d'A\* s'est épuisé avant la fin : on ne sait pas.
    OutOfBudget,
}

impl Sim {
    // ------------------------------------------------------------------
    // Lecture
    // ------------------------------------------------------------------

    /// Cases en feu, dans l'ordre où elles se sont enflammées.
    pub fn burning(&self) -> &[Fire] {
        &self.burning
    }

    /// Cases enflammées depuis le début de l'incendie en cours : c'est l'`arg`
    /// que portera `EventKind::FireOut`.
    pub fn fires_lit(&self) -> u32 {
        self.fires_lit
    }

    // ------------------------------------------------------------------
    // Allumage
    // ------------------------------------------------------------------

    /// Met le feu à une case si elle porte du combustible et ne brûle pas
    /// déjà. Renvoie vrai si elle a pris. C'est le point de passage unique :
    /// la foudre, l'escarbille, `Command::Ignite` et la propagation appellent
    /// tous celui-ci.
    pub fn ignite(&mut self, x: u32, y: u32) -> bool {
        if !self.map.in_bounds(x as i32, y as i32) || self.map.fire_at(x, y) != 0 {
            return false;
        }
        let outdoor = self.outdoor_temperature();
        if !self.tile_has_fuel(x, y, outdoor) {
            return false;
        }
        self.map.set_fire(x, y, 1);
        self.burning.push(Fire { x, y, ticks: 0 });
        self.fires_lit = self.fires_lit.saturating_add(1);
        // Ceux qui traversaient cette case refont leur chemin : le feu n'est
        // pas un mur, mais on ne marche pas dedans si on peut l'éviter.
        self.replan_paths_through(x, y);
        true
    }

    /// `Command::Ignite` : allume, et annonce le départ comme un ordre.
    pub(crate) fn ignite_command(&mut self, x: u32, y: u32) {
        if self.ignite(x, y) {
            self.push_event(EventKind::FireStarted, CAUSE_ORDER);
        }
    }

    /// La case porte-t-elle de quoi brûler ? L'élément d'abord (le cas le plus
    /// courant), le sol ensuite, les piles en dernier — c'est le seul test qui
    /// parcourt une liste.
    pub(crate) fn tile_has_fuel(&self, x: u32, y: u32, temperature: i32) -> bool {
        if !self.map.in_bounds(x as i32, y as i32) {
            return false;
        }
        if feature_burns(self.map.feature(x, y)) {
            return true;
        }
        if terrain_burns(self.map.get(x, y), temperature, self.weather.is_wet()) {
            return true;
        }
        self.items
            .iter()
            .any(|s| (s.x, s.y) == (x, y) && item_burns(s.kind))
    }

    // ------------------------------------------------------------------
    // Dynamique
    // ------------------------------------------------------------------

    /// Évaluation du feu, un tick sur `FIRE_INTERVAL`. Sans case en feu, sans
    /// orage et sans feu de camp par temps chaud et sec, elle ne fait rien.
    pub(crate) fn tick_fire(&mut self, outdoor: i32) {
        if self.tick % FIRE_INTERVAL != 0 {
            return;
        }
        if self.map.fire_count() > 0 {
            self.burn_step(outdoor);
        }
        self.strike_lightning(outdoor);
        self.spark_from_campfire(outdoor);
    }

    /// Un tour de feu : propagation, croissance, consommation, extinction,
    /// puis brûlures. La propagation est calculée **avant** toute
    /// modification, pour qu'une case allumée ce tour-ci n'enflamme pas déjà
    /// ses propres voisines.
    fn burn_step(&mut self, outdoor: i32) {
        let wet = self.weather.is_wet();
        let cold = outdoor < FREEZING;
        let wind = wind_direction(self.weather_noise);
        let (quench_num, quench_den) = quench_chance(self.weather);

        // 1. Qui prend, à partir de qui brûle assez fort.
        let mut caught: Vec<(u32, u32)> = Vec::new();
        for k in 0..self.burning.len() {
            let (x, y) = (self.burning[k].x, self.burning[k].y);
            if self.map.fire_at(x, y) < SPREAD_MIN {
                continue;
            }
            for (dx, dy) in NEIGHBOURS {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if !self.map.in_bounds(nx, ny) {
                    continue;
                }
                let (nx, ny) = (nx as u32, ny as u32);
                let (num, den) = spread_chance((dx, dy), wind, wet, cold);
                if self.map.fire_at(nx, ny) != 0
                    || !self.tile_has_fuel(nx, ny, outdoor)
                    || !self.rng.chance(num, den)
                {
                    continue;
                }
                caught.push((nx, ny));
            }
        }

        // 2. Les foyers existants vieillissent.
        let mut k = 0;
        while k < self.burning.len() {
            let (x, y) = (self.burning[k].x, self.burning[k].y);
            self.burning[k].ticks = self.burning[k].ticks.saturating_add(FIRE_INTERVAL as u32);
            let ticks = self.burning[k].ticks;
            // Le combustible a pu disparaître entre-temps (un colon a coupé
            // l'arbre, la récolte est passée) : une case sans rien à brûler
            // s'éteint aussitôt.
            if !self.tile_has_fuel(x, y, outdoor) {
                self.burning.remove(k);
                self.map.set_fire(x, y, 0);
                continue;
            }
            if quench_num > 0 && self.rng.chance(quench_num, quench_den) {
                self.burning.remove(k);
                self.map.set_fire(x, y, 0);
                continue;
            }
            if ticks >= FIRE_BURN_TICKS {
                self.burning.remove(k);
                self.consume_tile(x, y);
                self.map.set_fire(x, y, 0);
                continue;
            }
            self.map.set_fire(x, y, level_for(ticks));
            k += 1;
        }

        // 3. Les nouvelles cases prennent (les doublons sont refusés par
        //    `ignite`, qui teste l'intensité courante).
        for (x, y) in caught {
            self.ignite(x, y);
        }

        self.burn_pawns();
        self.note_fire_out();
    }

    /// Le combustible d'une case part en fumée. Les piles inflammables
    /// disparaissent (les jobs qui les visaient ne les retrouvent pas et
    /// s'arrêtent d'eux-mêmes, comme pour un vivre périmé), l'élément avec, et
    /// il ne reste qu'un carré de terre nue là où poussait l'herbe ou où
    /// craquait un plancher.
    fn consume_tile(&mut self, x: u32, y: u32) {
        self.items
            .retain(|s| (s.x, s.y) != (x, y) || !item_burns(s.kind));
        if feature_burns(self.map.feature(x, y)) {
            self.map.set_feature(x, y, Feature::None);
            // Un plant brûlé sort des cultures, un buisson brûlé ne repoussera
            // pas : ces deux listes suivent la carte.
            self.crops.retain(|c| (c.x, c.y) != (x, y));
            self.regrow.retain(|r| (r.x, r.y) != (x, y));
        }
        if matches!(self.map.get(x, y), Terrain::Grass | Terrain::WoodFloor) {
            self.map.set_terrain(x, y, Terrain::Dirt);
        }
    }

    /// Brûle qui se tient dans les flammes, **tout camp confondu** : colon,
    /// pillard, marchand ou bête. Aucun modificateur de dégâts, comme pour un
    /// piège à pointes : le feu ne choisit pas qui passe.
    fn burn_pawns(&mut self) {
        for i in 0..self.pawns.len() {
            if !self.pawns[i].is_alive() {
                continue;
            }
            let (x, y) = self.pawns[i].tile();
            if !self.map.in_bounds(x as i32, y as i32) {
                continue;
            }
            let level = self.map.fire_at(x, y);
            if level == 0 {
                continue;
            }
            let part = health::part_for_roll(self.rng.below(HIT_WEIGHT_TOTAL));
            // Une brûlure ne saigne pas : elle fait mal et cicatrise, point.
            self.pawns[i].add_injury(part, BURN_SEVERITY * u32::from(level), 0);
            // Une bête qui prend feu détale, sanglier compris : personne à
            // charger (même règle que `Sim::inflict_injury`).
            self.animal_hit(i, None);
        }
    }

    /// Annonce la fin d'un incendie quand la dernière case s'éteint, avec le
    /// nombre de cases qui ont brûlé. Appelée par tout ce qui peut éteindre :
    /// l'évaluation, un colon qui bat les flammes, l'avance rapide.
    pub(crate) fn note_fire_out(&mut self) {
        if self.map.fire_count() == 0 && self.fires_lit > 0 {
            let burned = core::mem::take(&mut self.fires_lit);
            self.push_event(EventKind::FireOut, burned);
        }
    }

    /// La foudre pendant un orage. Le tirage de chance vient **avant** la
    /// recherche d'une case combustible : hors orage, ce chemin ne coûte qu'un
    /// test d'égalité.
    fn strike_lightning(&mut self, outdoor: i32) {
        if self.weather != Weather::Storm
            || self.map.width() == 0
            || self.map.height() == 0
            || !self.rng.chance(LIGHTNING_NUM, LIGHTNING_DEN)
        {
            return;
        }
        for _ in 0..LIGHTNING_DRAWS {
            let x = self.rng.below(self.map.width());
            let y = self.rng.below(self.map.height());
            if self.map.fire_at(x, y) != 0 || !self.tile_has_fuel(x, y, outdoor) {
                continue;
            }
            if self.ignite(x, y) {
                self.push_event(EventKind::FireStarted, CAUSE_LIGHTNING);
            }
            return;
        }
    }

    /// Une escarbille de feu de camp. Quatre court-circuits avant tout
    /// balayage : pas de feu de camp, temps humide, temps froid, et enfin le
    /// tirage de chance — la carte n'est parcourue qu'une fois tous les
    /// quelques jours de jeu.
    fn spark_from_campfire(&mut self, outdoor: i32) {
        if self.map.campfire_count() == 0
            || self.weather.is_wet()
            || outdoor <= CAMPFIRE_SPARK_TEMP
            || !self.rng.chance(CAMPFIRE_SPARK_NUM, CAMPFIRE_SPARK_DEN)
        {
            return;
        }
        let mut fires: Vec<(u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::Campfire {
                    fires.push((x, y));
                }
            }
        }
        if fires.is_empty() {
            return;
        }
        let (cx, cy) = fires[self.rng.below(fires.len() as u32) as usize];
        let mut targets: Vec<(u32, u32)> = Vec::new();
        for (dx, dy) in NEIGHBOURS {
            let (nx, ny) = (cx as i32 + dx, cy as i32 + dy);
            if !self.map.in_bounds(nx, ny) {
                continue;
            }
            let (nx, ny) = (nx as u32, ny as u32);
            if self.map.fire_at(nx, ny) == 0 && self.tile_has_fuel(nx, ny, outdoor) {
                targets.push((nx, ny));
            }
        }
        if targets.is_empty() {
            return;
        }
        let (x, y) = targets[self.rng.below(targets.len() as u32) as usize];
        if self.ignite(x, y) {
            self.push_event(EventKind::FireStarted, CAUSE_CAMPFIRE);
        }
    }

    // ------------------------------------------------------------------
    // Avance rapide
    // ------------------------------------------------------------------

    /// Tout ce qui brûlait a fini de brûler. L'avance rapide ne simule rien
    /// (voir `fastforward`) : on applique la consommation du combustible aux
    /// cases en feu et on éteint, **sans propagation**. Une colonie laissée
    /// deux mois avec un début d'incendie retrouve donc les cases déjà en feu
    /// réduites en terre nue, et pas une de plus — supposer une propagation
    /// dont personne n'a vu la météo serait inventer.
    pub(crate) fn burn_out(&mut self) {
        if self.burning.is_empty() {
            return;
        }
        let tiles = core::mem::take(&mut self.burning);
        for f in &tiles {
            self.consume_tile(f.x, f.y);
            self.map.set_fire(f.x, f.y, 0);
        }
        self.note_fire_out();
    }

    // ------------------------------------------------------------------
    // Lutte contre le feu
    // ------------------------------------------------------------------

    /// Le foyer que le colon `i` irait combattre, et le chemin pour aller le
    /// battre : le plus proche de lui parmi ceux qui sont dans
    /// `FIREFIGHT_RADIUS` du barycentre des colons, non réservés et
    /// **atteignables**. Rend le chemin avec le foyer parce que celui qui pose
    /// la question l'a déjà payé : le calculer deux fois doublait la note.
    ///
    /// Quatre court-circuits, du plus grossier au plus fin, avant qu'un seul
    /// A\* ne parte :
    ///
    /// 1. `Map::fire_count` : sans feu sur la carte, un colon inactif ne
    ///    compare rien ;
    /// 2. la distance au barycentre : aucun foyer à `FIREFIGHT_RADIUS` et la
    ///    liste des candidats est vide — la forêt qui brûle à l'autre bout de
    ///    la carte ne coûte pas une recherche de chemin ;
    /// 3. la mémoire de la salve (`Salvo`) : un foyer qu'un camarade vient de
    ///    juger inatteignable **ce tick-ci** n'est pas retesté, et une réponse
    ///    déjà calculée pour ce colon dans ce tick est rendue telle quelle ;
    /// 4. le budget d'A\* : `PATH_ATTEMPTS` recherches de chemin pour tout
    ///    l'appel, foyers et voisines confondus. Un colon qui a épuisé ses
    ///    essais passe à la suite — il repassera à la prochaine salve.
    pub(crate) fn fire_to_fight(&mut self, i: usize, salvo: &mut Salvo) -> Option<FireTarget> {
        let pawn = self.pawns[i].id;
        // `drop_work_for_fire` pose la question, `find_job` la repose aussitôt
        // après pour le même colon, sur un état que rien n'a bougé entre les
        // deux : la deuxième fois est gratuite.
        if let Some(found) = salvo.recall(pawn) {
            return found;
        }
        let found = self.search_fire_to_fight(i, salvo);
        salvo.remember(pawn, found.clone());
        found
    }

    fn search_fire_to_fight(&mut self, i: usize, salvo: &mut Salvo) -> Option<FireTarget> {
        if self.map.fire_count() == 0 {
            return None;
        }
        let center = self.colony_center()?;
        let from = self.pawns[i].tile();
        let mut fires: Vec<(u32, u32, u32)> = Vec::new();
        for f in &self.burning {
            if chebyshev(center, (f.x, f.y)) > FIREFIGHT_RADIUS
                || self.is_reserved(f.x, f.y)
                || salvo.is_blocked(f.x, f.y)
            {
                continue;
            }
            fires.push((chebyshev(from, (f.x, f.y)), f.x, f.y));
        }
        // Rien à portée : on sort **avant** le tri comme avant le premier A\*.
        if fires.is_empty() {
            return None;
        }
        fires.sort_unstable();
        // Même ordre qu'ailleurs — `(distance, x, y)` — et même borne que le
        // rangement : les `PATH_ATTEMPTS` foyers les plus proches, pas un de
        // plus. Le budget, lui, est partagé par tout l'appel.
        let candidates: Vec<(u32, u32, u32)> = fires
            .iter()
            .take(crate::jobs::PATH_ATTEMPTS)
            .copied()
            .collect();
        let mut budget = crate::jobs::PATH_ATTEMPTS;
        for (_, x, y) in candidates {
            match self.path_beside_fire(from, (x, y), &mut budget) {
                Beside::Path(p) => return Some(((x, y), p)),
                // Démonstration faite, et elle a coûté cher : aucun autre colon
                // de la salve ne la refera.
                Beside::Unreachable => salvo.block(x, y),
                Beside::OutOfBudget => break,
            }
        }
        None
    }

    /// Part battre les flammes du foyer choisi par `fire_to_fight`. La case est
    /// réservée comme celle d'un travail désigné : deux colons ne battent pas
    /// le même foyer.
    ///
    /// La lutte n'est réévaluée qu'un tick sur `FIREFIGHT_RETRY`, comme
    /// l'interruption de travail (`drop_work_for_fire`) et pour la même raison :
    /// rien
    /// ne bouge dans l'incendie entre deux évaluations du feu, un colon
    /// inactif qui recherche à chaque tick paie soixante fois le même prix
    /// pour la même réponse. Le pas est **le même pour tout le monde** (le
    /// tick, pas l'identité du colon) : c'est ce qui fait que
    /// `drop_work_for_fire` lâche le travail et que `find_job` enchaîne sur les
    /// flammes dans le même tick.
    pub(crate) fn try_start_firefight(&mut self, i: usize, salvo: &mut Salvo) -> bool {
        if self.tick % FIREFIGHT_RETRY != 0 {
            return false;
        }
        let Some(((x, y), p)) = self.fire_to_fight(i, salvo) else {
            return false;
        };
        let pawn = self.pawns[i].id;
        self.reservations.push(Reservation { x, y, pawn });
        self.pawns[i].set_path(p);
        self.pawns[i].job = Job::Firefight {
            at: (x, y),
            progress: 0,
        };
        true
    }

    /// Chemin vers une voisine **qui ne brûle pas** : on bat les flammes
    /// depuis le bord du foyer, jamais depuis le foyer. C'est pour cela que la
    /// fonction ne peut pas être `path_adjacent_for` : celle-là accepterait
    /// une voisine en feu, franchissable mais intenable.
    ///
    /// Chaque A\* lancé retire un essai à `budget` et s'ajoute à
    /// `Sim::firefight_paths`. La distinction entre `Unreachable` et
    /// `OutOfBudget` n'est pas cosmétique : seule la première autorise à
    /// inscrire le foyer au tableau des inatteignables de la salve.
    fn path_beside_fire(&mut self, from: (u32, u32), at: (u32, u32), budget: &mut usize) -> Beside {
        let mut neighbours: Vec<(u32, u32, u32)> = Vec::new();
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let (nx, ny) = (at.0 as i32 + dx, at.1 as i32 + dy);
                if !self.map.in_bounds(nx, ny) {
                    continue;
                }
                let (nx, ny) = (nx as u32, ny as u32);
                if self.map.fire_at(nx, ny) != 0 || !self.map.passable_for(nx, ny, Walker::COLONIST)
                {
                    continue;
                }
                neighbours.push((chebyshev(from, (nx, ny)), nx, ny));
            }
        }
        neighbours.sort_unstable();
        for (_, x, y) in neighbours {
            if *budget == 0 {
                return Beside::OutOfBudget;
            }
            *budget -= 1;
            self.count_firefight_path(1);
            if let Some(p) = path::find_path_for(&self.map, from, (x, y), Walker::COLONIST) {
                return Beside::Path(p);
            }
        }
        // Aucune voisine tenable, ou toutes essayées en vain : le foyer est
        // hors d'atteinte pour ce colon, et donc pour ses camarades — ils
        // partent du même bout de carte.
        Beside::Unreachable
    }

    /// Bat les flammes depuis une case voisine. `EXTINGUISH_TICKS` par cran
    /// d'intensité, et la case retombe à zéro d'un coup : **le combustible est
    /// conservé** — un arbre sauvé des flammes reste un arbre.
    pub(crate) fn do_firefight(&mut self, i: usize, at: (u32, u32), progress: u32) {
        let level = if self.map.in_bounds(at.0 as i32, at.1 as i32) {
            self.map.fire_at(at.0, at.1)
        } else {
            0
        };
        if level == 0 {
            // Éteint par la pluie, ou consumé : il n'y a plus rien à battre.
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), at) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + EXTINGUISH_STEP;
        if progress < EXTINGUISH_TICKS * u32::from(level) * 100 {
            self.pawns[i].job = Job::Firefight { at, progress };
            return;
        }
        self.map.set_fire(at.0, at.1, 0);
        self.burning.retain(|f| (f.x, f.y) != at);
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
        self.note_fire_out();
    }

    /// Un colon lâche tout quand le feu menace la colonie. Mêmes exceptions
    /// que la famine : on ne quitte pas un repas, un lit, un ordre du joueur
    /// ni un combat, et on ne réquisitionne pas un colon en pleine crise de
    /// moral ou à terre. Une fois le job rendu, `Sim::tick_pawn` enchaîne sur
    /// `find_job` **dans le même tick** : le colon repart aussitôt sur les
    /// flammes.
    ///
    /// Deux garde-fous, sans lesquels un feu inaccessible (dans une pièce
    /// murée, de l'autre côté d'un étang) paralyserait la colonie :
    ///
    /// - on n'interrompt que si `fire_to_fight` trouve un foyer **atteignable**
    ///   — sinon chacun lâcherait son travail à chaque tick pour rien ;
    /// - et seulement un tick sur `FIREFIGHT_RETRY`, comme le feu lui-même : la
    ///   recherche coûte un A*, et rien ne bouge entre deux évaluations. C'est
    ///   la même cadence que `try_start_firefight`, et il le faut : la réponse
    ///   calculée ici est celle que `find_job` réutilise dans le même tick
    ///   (voir `Salvo`).
    pub(crate) fn drop_work_for_fire(&mut self, i: usize, salvo: &mut Salvo) {
        if self.map.fire_count() == 0
            || self.tick % FIREFIGHT_RETRY != 0
            || self.pawns[i].faction != Faction::Colony
            || matches!(
                self.pawns[i].job,
                Job::Firefight { .. }
                    | Job::Eat { .. }
                    | Job::Sleep { .. }
                    | Job::Move { manual: true }
                    | Job::Attack { .. }
                    | Job::Break { .. }
                    | Job::Downed
                    | Job::Idle
            )
        {
            return;
        }
        if self.fire_to_fight(i, salvo).is_some() {
            self.abandon_job(i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_neige_eteint_plus_vite_que_la_pluie() {
        let (rain, den) = quench_chance(Weather::Rain);
        let (snow, _) = quench_chance(Weather::Snow);
        let (clear, _) = quench_chance(Weather::Clear);
        assert_eq!(clear, 0, "un temps clair n'éteint rien");
        assert!(snow > rain, "{snow}/{den} devrait dépasser {rain}/{den}");
        assert!(rain > 0);
    }

    #[test]
    fn la_pluie_et_le_froid_ralentissent_la_propagation() {
        let wind = (1, 0);
        let (num, dry) = spread_chance(wind, wind, false, false);
        let (_, wet) = spread_chance(wind, wind, true, false);
        let (_, cold) = spread_chance(wind, wind, false, true);
        let (_, both) = spread_chance(wind, wind, true, true);
        assert_eq!(num, FIRE_SPREAD_NUM);
        assert_eq!(dry, FIRE_SPREAD_DEN);
        assert_eq!(wet, dry * WET_SPREAD_DIVISOR);
        assert_eq!(cold, dry * COLD_SPREAD_DIVISOR);
        assert_eq!(both, dry * WET_SPREAD_DIVISOR * COLD_SPREAD_DIVISOR);
    }

    #[test]
    fn le_feu_suit_le_vent() {
        let wind = (0, 1);
        let (_, down) = spread_chance(wind, wind, false, false);
        let (_, cross) = spread_chance((1, 0), wind, false, false);
        let (_, back) = spread_chance((0, -1), wind, false, false);
        assert!(down < cross, "le feu devrait courir sous le vent");
        assert!(
            cross < back,
            "il devrait remonter le vent encore moins vite"
        );
    }

    #[test]
    fn le_vent_couvre_les_quatre_directions() {
        let mut seen: Vec<(i32, i32)> = Vec::new();
        for noise in -WEATHER_NOISE..WEATHER_NOISE {
            let d = wind_direction(noise);
            assert!(NEIGHBOURS.contains(&d), "direction {d:?} hors des voisines");
            if !seen.contains(&d) {
                seen.push(d);
            }
        }
        assert_eq!(
            seen.len(),
            NEIGHBOURS.len(),
            "une direction n'est jamais tirée"
        );
        // Un bruit aberrant (vieux snapshot, climat trafiqué) reste une
        // direction valable.
        for noise in [i32::MIN, -1_000, 1_000, i32::MAX] {
            assert!(NEIGHBOURS.contains(&wind_direction(noise)));
        }
    }

    #[test]
    fn l_intensite_monte_par_paliers_et_plafonne() {
        assert_eq!(level_for(0), 1);
        assert_eq!(level_for(FIRE_GROWTH - 1), 1);
        assert_eq!(level_for(FIRE_GROWTH), 2);
        assert_eq!(level_for(2 * FIRE_GROWTH), FIRE_MAX);
        assert_eq!(level_for(100 * FIRE_GROWTH), FIRE_MAX);
    }
}
