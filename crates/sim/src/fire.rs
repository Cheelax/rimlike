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

use serde::{Deserialize, Serialize};

use crate::climate::FREEZING;
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

/// Chance qu'une case à intensité `SPREAD_MIN` ou plus enflamme un voisin
/// combustible donné, par évaluation.
///
/// **Posé sur la géométrie, puis mesuré.** Une case passe environ
/// `(FIRE_BURN_TICKS - FIRE_GROWTH) / FIRE_INTERVAL` = 75 évaluations à
/// intensité ≥ 2 avant de s'éteindre : à 1/40, elle finit par prendre un
/// voisin donné dans `1 - (39/40)^75` ≈ 85 % des cas. Mesure sur dix graines,
/// un bosquet de 8×8 arbres allumé en son centre, météo forcée :
///
/// | temps  | cases brûlées / 640 | durée moyenne |
/// |---|---|---|
/// | clair  | **628** (98 %) | 3 984 ticks |
/// | pluie  | 0 | 44 ticks |
/// | neige  | 0 | 44 ticks |
///
/// Un bosquet part donc entièrement en quelques milliers de ticks à sec, et
/// pas du tout dès qu'il tombe quelque chose : la pluie divise la propagation
/// par `WET_SPREAD_DIVISOR` **et** éteint une case sur quatre par évaluation,
/// si bien qu'un foyer ne vit pas assez longtemps pour atteindre
/// `SPREAD_MIN`.
pub const FIRE_SPREAD_NUM: u32 = 1;
pub const FIRE_SPREAD_DEN: u32 = 40;

/// Sous la pluie (ou la neige), la chance de propagation est divisée par ce
/// facteur.
pub const WET_SPREAD_DIVISOR: u32 = 4;

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

/// La pile brûle-t-elle ? **Tout sauf la pierre** : le bois, les vivres, le
/// cuir, les habits, les armes (un arc et un gourdin sont en bois, un épieu
/// aussi pour l'essentiel) et jusqu'aux dépouilles. Une règle d'un mot est
/// plus facile à retenir qu'une liste, et il n'existe aucun objet
/// incombustible en dehors du tas de cailloux.
pub fn item_burns(kind: ItemKind) -> bool {
    kind != ItemKind::Stone
}

/// Chance qu'une case en feu s'éteigne d'elle-même à chaque évaluation, en
/// `(numérateur, dénominateur)`. Rien par temps clair et doux ; la pluie et
/// l'orage éteignent une fois sur quatre ; le gel autant ; la neige, qui
/// tombe forcément sous zéro, cumule les deux et éteint trois fois sur quatre.
pub fn quench_chance(weather: Weather, freezing: bool) -> (u32, u32) {
    let wet = match weather {
        Weather::Clear => 0,
        Weather::Rain | Weather::Storm => 1,
        Weather::Snow => 2,
    };
    (wet + u32::from(freezing), QUENCH_DEN)
}

/// Chance de propagation vers un voisin combustible donné, par évaluation :
/// `FIRE_SPREAD_NUM / FIRE_SPREAD_DEN`, divisée par `WET_SPREAD_DIVISOR`
/// quand il tombe de l'eau.
pub fn spread_chance(wet: bool) -> (u32, u32) {
    let den = if wet {
        FIRE_SPREAD_DEN * WET_SPREAD_DIVISOR
    } else {
        FIRE_SPREAD_DEN
    };
    (FIRE_SPREAD_NUM, den)
}

/// Intensité d'une case selon le temps qu'elle a passé à brûler : 1 au
/// départ, un cran de plus tous les `FIRE_GROWTH` ticks, plafonnée à
/// `FIRE_MAX`.
pub fn level_for(ticks: u32) -> u8 {
    (ticks / FIRE_GROWTH + 1).min(u32::from(FIRE_MAX)) as u8
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
        let (spread_num, spread_den) = spread_chance(wet);
        let (quench_num, quench_den) = quench_chance(self.weather, outdoor < FREEZING);

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
                if self.map.fire_at(nx, ny) != 0
                    || !self.tile_has_fuel(nx, ny, outdoor)
                    || !self.rng.chance(spread_num, spread_den)
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

    /// Le foyer que le colon `i` irait combattre : le plus proche de lui parmi
    /// ceux qui sont dans `FIREFIGHT_RADIUS` du barycentre des colons, non
    /// réservés et **atteignables**. Ne mute rien, ce qui permet de poser la
    /// question avant de faire lâcher son travail à quelqu'un.
    ///
    /// Court-circuité par `Map::fire_count` : sans feu sur la carte, un colon
    /// inactif ne compare rien.
    pub(crate) fn fire_to_fight(&self, i: usize) -> Option<(u32, u32)> {
        if self.map.fire_count() == 0 {
            return None;
        }
        let center = self.colony_center()?;
        let from = self.pawns[i].tile();
        let mut fires: Vec<(u32, u32, u32)> = Vec::new();
        for f in &self.burning {
            if chebyshev(center, (f.x, f.y)) > FIREFIGHT_RADIUS || self.is_reserved(f.x, f.y) {
                continue;
            }
            fires.push((chebyshev(from, (f.x, f.y)), f.x, f.y));
        }
        fires.sort_unstable();
        fires
            .iter()
            .take(crate::jobs::PATH_ATTEMPTS)
            .find(|&&(_, x, y)| self.path_beside_fire(from, (x, y)).is_some())
            .map(|&(_, x, y)| (x, y))
    }

    /// Part battre les flammes du foyer choisi par `fire_to_fight`. La case est
    /// réservée comme celle d'un travail désigné : deux colons ne battent pas
    /// le même foyer.
    pub(crate) fn try_start_firefight(&mut self, i: usize) -> bool {
        let Some((x, y)) = self.fire_to_fight(i) else {
            return false;
        };
        let from = self.pawns[i].tile();
        let Some(p) = self.path_beside_fire(from, (x, y)) else {
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
    fn path_beside_fire(&self, from: (u32, u32), at: (u32, u32)) -> Option<Vec<path::Tile>> {
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
        neighbours
            .iter()
            .find_map(|&(_, x, y)| path::find_path_for(&self.map, from, (x, y), Walker::COLONIST))
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
    /// - et seulement un tick sur `FIRE_INTERVAL`, comme le feu lui-même : la
    ///   recherche coûte un A*, et rien ne bouge entre deux évaluations.
    pub(crate) fn drop_work_for_fire(&mut self, i: usize) {
        if self.map.fire_count() == 0
            || self.tick % FIRE_INTERVAL != 0
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
        if self.fire_to_fight(i).is_some() {
            self.abandon_job(i);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn la_neige_eteint_plus_vite_que_la_pluie() {
        let (rain, den) = quench_chance(Weather::Rain, false);
        let (snow, _) = quench_chance(Weather::Snow, true);
        let (clear, _) = quench_chance(Weather::Clear, false);
        assert_eq!(clear, 0, "un temps clair et doux n'éteint rien");
        assert!(snow > rain, "{snow}/{den} devrait dépasser {rain}/{den}");
        assert!(rain > 0);
    }

    #[test]
    fn la_pluie_ralentit_la_propagation() {
        let (num, dry) = spread_chance(false);
        let (_, wet) = spread_chance(true);
        assert_eq!(num, FIRE_SPREAD_NUM);
        assert_eq!(wet, dry * WET_SPREAD_DIVISOR);
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
