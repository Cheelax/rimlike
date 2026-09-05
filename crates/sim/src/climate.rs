//! Climat, saisons et température.
//!
//! Tout est en **dixièmes de degré Celsius**, en entiers : `120` vaut 12 °C,
//! `-50` vaut −5 °C. Aucune trigonométrie, aucun flottant : la courbe annuelle
//! et la courbe journalière sont deux tables d'entiers (`YEAR_CURVE`,
//! `DAY_CURVE`), interpolées par jour et par heure.
//!
//! La température d'une case est la somme de quatre termes :
//!
//! 1. la moyenne annuelle du `Climate` de la carte (`base_temperature`) ;
//! 2. la saison : `amplitude × YEAR_CURVE[jour] / CURVE_SCALE` ;
//! 3. l'heure : `DAY_CURVE[heure]`, ±4 °C entre la nuit et l'après-midi ;
//! 4. la météo (pluie et neige −2 °C, orage −4 °C) plus un bruit lent tiré au
//!    sort à chaque changement de météo (±3 °C), qui évite deux années
//!    strictement superposables.
//!
//! S'y ajoute, pour une case **intérieure**, l'isolation de la pièce et la
//! chaleur des feux de camp qu'elle contient (voir `Map::refresh_indoor`).
//!
//! La température **ressentie** d'un colon (`Pawn::comfort`) est celle de sa
//! case plus l'isolation de son vêtement (`Pawn::insulation_tenths`). Rien
//! d'autre ne change : humeur et hypothermie lisent `comfort` comme avant.
//! Limite assumée de cette tranche : au-dessus de `HOT_MOOD_TEMP`, l'isolation
//! joue contre son porteur et personne ne se déshabille — la gestion de la
//! chaleur viendra avec les toits.
//!
//! Le climat est un champ de `Sim` : une salle du globe reçoit le sien par
//! `Command::SetClimate`, en lockstep, sans changer la construction de la
//! carte (`docs/PLAN.md` §3, biomes du globe).

use serde::{Deserialize, Serialize};

use crate::map::Feature;
use crate::pawn::Faction;
use crate::weather::Weather;
use crate::{DAY_START_OFFSET, EventKind, Sim, TICKS_PER_DAY};

/// Jours d'une année de jeu : quatre saisons de `SEASON_DAYS`.
pub const YEAR_DAYS: u32 = 60;
/// Durée d'une saison, en jours.
pub const SEASON_DAYS: u32 = YEAR_DAYS / 4;
/// Dénominateur de `YEAR_CURVE` : la courbe va de `-CURVE_SCALE` à `+CURVE_SCALE`.
pub const CURVE_SCALE: i32 = 1000;

/// Courbe annuelle, un point par jour : `1000 × sin(2π j / 60)` arrondi.
/// Elle vaut 0 au premier jour du printemps (la partie commence là, à la
/// moyenne annuelle et en hausse), +1000 au premier jour de l'été et −1000 au
/// premier jour de l'hiver. Conséquence voulue : chaque saison est plus chaude
/// que la suivante jusqu'à l'hiver — été > printemps > automne > hiver en
/// moyenne — et la colonie n'est pas fondée dans le gel.
const YEAR_CURVE: [i16; YEAR_DAYS as usize] = [
    0, 105, 208, 309, 407, 500, 588, 669, 743, 809, 866, 914, 951, 978, 995, 1000, 995, 978, 951,
    914, 866, 809, 743, 669, 588, 500, 407, 309, 208, 105, 0, -105, -208, -309, -407, -500, -588,
    -669, -743, -809, -866, -914, -951, -978, -995, -1000, -995, -978, -951, -914, -866, -809,
    -743, -669, -588, -500, -407, -309, -208, -105,
];

/// Écart à la moyenne du jour, heure par heure (dixièmes) : le plus froid vers
/// 3 h, le plus chaud vers 15 h.
const DAY_CURVE: [i16; 24] = [
    -28, -35, -39, -40, -39, -35, -28, -20, -10, 0, 10, 20, 28, 35, 39, 40, 39, 35, 28, 20, 10, 0,
    -10, -20,
];

/// Gain d'une case intérieure, hors chauffage : quatre murs coupent le vent.
pub const INDOOR_INSULATION: i32 = 60;
/// Gain apporté par chaque feu de camp de la **même** pièce.
pub const CAMPFIRE_HEAT: i32 = 80;
/// Gain total maximal d'une pièce : entasser les feux ne fait pas un four.
pub const INDOOR_MAX_BONUS: i32 = 250;

/// Refroidissement dû à la pluie (et à la neige, qui la remplace au gel).
pub const RAIN_CHILL: i32 = -20;
/// Refroidissement dû à l'orage.
pub const STORM_CHILL: i32 = -40;
/// Amplitude du bruit tiré à chaque changement de météo.
pub const WEATHER_NOISE: i32 = 30;

/// Le gel : plus rien ne pousse en dessous.
pub const FREEZING: i32 = 0;
/// En dessous, les plants poussent deux fois moins vite.
pub const COLD_GROWTH: i32 = 80;
/// En dessous, un plant peut mourir de froid.
pub const CROP_KILL_TEMP: i32 = -50;
/// Chance par tick et par plant qu'un plant gelé meure (`1 / N`).
pub const CROP_KILL_CHANCE: u32 = 600;
/// Un buisson récolté ne repousse pas sous le gel : sa repousse est repoussée
/// de deux heures, jamais annulée.
pub const FROST_REGROW_DELAY: u32 = TICKS_PER_DAY / 12;

/// En dessous, le colon a froid : l'humeur baisse.
pub const COLD_MOOD_TEMP: i32 = 50;
/// En dessous de cette température de case, un colon va chercher un vêtement
/// en stockage ; au-dessus, il a mieux à faire que traverser la carte pour un
/// manteau dont il n'a pas l'usage.
///
/// **Mesuré avant d'être réglé.** Le climat tempéré par défaut tourne autour de
/// 12 °C : sur une première journée de printemps, la température extérieure va
/// de 7,7 à 16 °C, et son minimum du jour reste entre 6,8 et 10 °C sur dix
/// graines. Un seuil posé à 12 °C aurait donc envoyé la colonie s'habiller
/// **46 % du temps** (6 600 ticks sur 14 400 sous 12 °C, graine 1) en plein
/// climat doux — précisément le gaspillage qu'on veut éviter. À 6 °C, aucune de
/// ces journées ne déclenche quoi que ce soit, et le seuil reste au-dessus de
/// celui où le froid pèse sur l'humeur (`COLD_MOOD_TEMP`, 5 °C) : le colon part
/// chercher son manteau **avant** de commencer à grelotter.
pub const DRESS_TEMP: i32 = 60;
/// En dessous, le froid blesse (hypothermie) et l'humeur s'effondre.
pub const HYPOTHERMIA_TEMP: i32 = -50;
/// Au-dessus, le colon a trop chaud.
pub const HOT_MOOD_TEMP: i32 = 320;
/// Un colon sous `HYPOTHERMIA_TEMP` prend une blessure de froid tous ces ticks.
pub const HYPOTHERMIA_INTERVAL: u64 = 200;
/// Sévérité ajoutée par chaque atteinte du froid.
pub const COLD_SEVERITY: u32 = 5;

/// Malus d'humeur du froid, du grand froid et de la chaleur.
pub const COLD_MOOD_MALUS: i64 = 60_000;
pub const FREEZING_MOOD_MALUS: i64 = 150_000;
pub const HOT_MOOD_MALUS: i64 = 60_000;
/// Malus d'humeur quand il neige sur la carte.
pub const SNOW_MOOD_MALUS: i64 = 20_000;

/// Bornes de température, en dixièmes : elles bornent aussi bien un climat
/// aberrant reçu par `Command::SetClimate` que le résultat d'un vieux snapshot.
pub const TEMPERATURE_MIN: i32 = -2_000;
pub const TEMPERATURE_MAX: i32 = 2_000;

/// Saison courante, déduite du jour de l'année. Les valeurs sont un contrat
/// avec le client (`arg` de `EventKind::SeasonChanged`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Season {
    Spring = 0,
    Summer = 1,
    Autumn = 2,
    Winter = 3,
}

impl Season {
    pub const ALL: [Season; 4] = [
        Season::Spring,
        Season::Summer,
        Season::Autumn,
        Season::Winter,
    ];

    pub fn from_u8(v: u8) -> Season {
        match v {
            1 => Season::Summer,
            2 => Season::Autumn,
            3 => Season::Winter,
            _ => Season::Spring,
        }
    }
}

/// Climat d'une carte : sa moyenne annuelle et l'écart entre le cœur de l'été
/// et celui de l'hiver, en dixièmes de degré. Le défaut est tempéré
/// (12 °C ± 15 °C).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Climate {
    /// Température moyenne annuelle.
    pub base_temperature: i32,
    /// Écart maximal à la moyenne, atteint au cœur de l'été et de l'hiver.
    pub amplitude: i32,
}

impl Climate {
    /// Moyenne annuelle d'une carte tempérée : 12 °C.
    pub const TEMPERATE_BASE: i32 = 120;
    /// Écart saisonnier d'une carte tempérée : ±15 °C.
    pub const TEMPERATE_AMPLITUDE: i32 = 150;
    /// Amplitude maximale acceptée : au-delà, le chiffre ne veut plus rien dire.
    pub const AMPLITUDE_MAX: i32 = 1_000;

    pub fn new(base_temperature: i32, amplitude: i32) -> Climate {
        Climate {
            base_temperature,
            amplitude,
        }
        .sanitized()
    }

    /// Ramène un climat dans des bornes utilisables : `Command::SetClimate`
    /// vient du réseau, elle peut porter n'importe quel `i32`.
    pub fn sanitized(self) -> Climate {
        Climate {
            base_temperature: self
                .base_temperature
                .clamp(TEMPERATURE_MIN, TEMPERATURE_MAX),
            amplitude: self.amplitude.clamp(0, Climate::AMPLITUDE_MAX),
        }
    }
}

impl Default for Climate {
    fn default() -> Climate {
        Climate {
            base_temperature: Climate::TEMPERATE_BASE,
            amplitude: Climate::TEMPERATE_AMPLITUDE,
        }
    }
}

/// Jour de l'année d'un tick donné. Même décalage que `Sim::time_of_day` :
/// la partie commence le matin du premier jour du printemps.
#[inline]
pub fn day_of_tick(tick: u64) -> u32 {
    ((tick + u64::from(DAY_START_OFFSET)) / u64::from(TICKS_PER_DAY) % u64::from(YEAR_DAYS)) as u32
}

/// Saison d'un jour de l'année.
#[inline]
pub fn season_of_day(day: u32) -> Season {
    Season::from_u8((day / SEASON_DAYS).min(3) as u8)
}

impl Sim {
    pub fn climate(&self) -> Climate {
        self.climate
    }

    /// Impose un climat (tests et scénarios ; le jeu passe par
    /// `Command::SetClimate`). La valeur est bornée par `Climate::sanitized`.
    pub fn set_climate(&mut self, climate: Climate) {
        self.climate = climate.sanitized();
    }

    /// Jour de l'année courant, dans `0..YEAR_DAYS`.
    pub fn day_of_year(&self) -> u32 {
        day_of_tick(self.tick())
    }

    pub fn season(&self) -> Season {
        season_of_day(self.day_of_year())
    }

    /// Température extérieure de la carte, en dixièmes de degré. Lue une fois
    /// par tick par `Sim::update`, puis passée à qui en a besoin.
    #[inline]
    pub fn outdoor_temperature(&self) -> i32 {
        // Les modulos sur la longueur des tables épargnent deux contrôles de
        // bornes dans un chemin joué à chaque tick.
        let day = self.day_of_year() as usize % YEAR_CURVE.len();
        let hour = (self.time_of_day() * 24 / TICKS_PER_DAY) as usize % DAY_CURVE.len();
        // En `i64` : un snapshot abîmé pourrait porter un climat démesuré, et
        // une multiplication qui déborde serait une panique.
        let seasonal =
            i64::from(self.climate.amplitude) * i64::from(YEAR_CURVE[day]) / i64::from(CURVE_SCALE);
        let total = i64::from(self.climate.base_temperature)
            + seasonal
            + i64::from(DAY_CURVE[hour])
            + i64::from(self.weather().temperature_offset())
            + i64::from(self.weather_noise)
            // Vague de froid ou canicule du storyteller, le temps qu'elle dure.
            + i64::from(self.temperature_swing());
        total.clamp(i64::from(TEMPERATURE_MIN), i64::from(TEMPERATURE_MAX)) as i32
    }

    /// Température d'une case, en dixièmes de degré. Une case extérieure a la
    /// température extérieure : **un feu de camp posé dehors ne réchauffe
    /// rien** (trop simple pour l'instant ; il faudra un rayon de chaleur).
    /// Hors carte : la température extérieure.
    pub fn tile_temperature(&self, x: u32, y: u32) -> i32 {
        self.outdoor_temperature() + self.indoor_bonus(x, y)
    }

    /// Gain de température apporté par la pièce d'une case, 0 dehors.
    #[inline]
    pub(crate) fn indoor_bonus(&self, x: u32, y: u32) -> i32 {
        if self.map().indoor_count() == 0 || !self.map().in_bounds(x as i32, y as i32) {
            return 0;
        }
        let room = self.map().room(x, y);
        if room == 0 {
            return 0;
        }
        let fires = i32::try_from(self.map().room_campfires(room)).unwrap_or(i32::MAX);
        INDOOR_INSULATION
            .saturating_add(CAMPFIRE_HEAT.saturating_mul(fires))
            .min(INDOOR_MAX_BONUS)
    }

    /// Numéro de version de la couche « intérieur » : il change à chaque
    /// recalcul effectif, le client s'en sert pour rebâtir son rendu.
    pub fn indoor_version(&self) -> u32 {
        self.map().indoor_version()
    }

    /// Événements du calendrier : changement de saison, et première gelée de
    /// l'automne. Appelée une fois par tick, après la météo (`outdoor` en
    /// dépend).
    ///
    /// Deux raccourcis pour que ce chemin, joué à chaque tick, ne coûte
    /// presque rien : une saison ne peut changer qu'au **premier tick d'un
    /// jour** (un modulo, et on passe), et `frost_announced` est reposé à
    /// chaque changement de saison — il ne vaut `false` que pendant l'automne
    /// et avant la première gelée, si bien que la comparaison de température
    /// suffit le reste de l'année.
    pub(crate) fn tick_climate(&mut self, outdoor: i32) {
        let tick = self.tick();
        if (tick + u64::from(DAY_START_OFFSET)) % u64::from(TICKS_PER_DAY) == 0 && tick > 0 {
            let season = season_of_day(day_of_tick(tick));
            if season != season_of_day(day_of_tick(tick - 1)) {
                self.push_event(EventKind::SeasonChanged, season as u32);
                // Hors automne, il n'y a pas de première gelée à guetter.
                self.frost_announced = season != Season::Autumn;
            }
        }
        if outdoor < FREEZING && !self.frost_announced {
            self.frost_announced = true;
            let day = self.day_of_year();
            self.push_event(EventKind::FirstFrost, day);
        }
    }

    /// Recopie la température ressentie dans un pawn vivant, et fait payer le
    /// grand froid aux colons. Les pillards ne ressentent rien : ils viennent
    /// et repartent. `outdoor` est calculé une seule fois par tick : la
    /// température extérieure est la même pour tout le monde.
    ///
    /// Le ressenti est la température de la case **plus l'isolation du
    /// vêtement** : tout ce qui lit `comfort` (l'humeur, l'hypothermie
    /// ci-dessous) profite du manteau sans le savoir.
    pub(crate) fn tick_comfort(&mut self, i: usize, outdoor: i32) {
        let (x, y) = self.pawns[i].tile();
        let comfort = outdoor + self.indoor_bonus(x, y) + self.pawns[i].insulation_tenths();
        self.pawns[i].comfort = comfort;
        self.pawns[i].in_snow = self.weather() == Weather::Snow;
        if self.pawns[i].faction == Faction::Colony
            && comfort < HYPOTHERMIA_TEMP
            && self.tick() % HYPOTHERMIA_INTERVAL == 0
        {
            // Rester dehors par −5 °C se paie, manteau ou pas : l'habit
            // remonte le ressenti, il ne rend pas invulnérable. L'atteinte
            // guérit comme les autres une fois au chaud.
            self.pawns[i].chill_torso();
        }
    }

    /// Remet la température ressentie de tout le monde à jour d'un coup.
    /// Utilisée par l'avance rapide, qui ne joue aucun tick.
    pub(crate) fn refresh_comfort(&mut self) {
        let outdoor = self.outdoor_temperature();
        let snow = self.weather() == Weather::Snow;
        for i in 0..self.pawns.len() {
            if !self.pawns[i].is_alive() {
                continue;
            }
            let (x, y) = self.pawns[i].tile();
            self.pawns[i].comfort =
                outdoor + self.indoor_bonus(x, y) + self.pawns[i].insulation_tenths();
            self.pawns[i].in_snow = snow;
        }
    }

    /// Le froid gèle un plant : il disparaît de la carte et de `crops`.
    pub(crate) fn kill_crop(&mut self, x: u32, y: u32) {
        if matches!(self.map().feature(x, y), Feature::Crop | Feature::CropRipe) {
            self.map_mut().set_feature(x, y, Feature::None);
        }
    }
}

/// Avancement d'un plant en un tick, selon la température de sa case et la
/// pluie : rien sous le gel, moitié entre 0 et 8 °C (un tick sur deux à sec,
/// un point au lieu de deux sous la pluie), plein régime au-dessus.
pub fn growth_step(temperature: i32, wet: bool, tick: u64) -> u32 {
    if temperature < FREEZING {
        return 0;
    }
    if temperature < COLD_GROWTH {
        return if wet { 1 } else { (tick % 2) as u32 };
    }
    if wet { 2 } else { 1 }
}
