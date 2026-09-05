//! Météo de la carte. Elle change toute seule au fil des jours : la pluie fait
//! pousser les plants deux fois plus vite, l'orage plombe l'humeur de tout le
//! monde, et chaque temps refroidit plus ou moins la carte (`climate`). Sous
//! le gel, la pluie tombe en neige.

use serde::{Deserialize, Serialize};

use crate::climate::{FREEZING, RAIN_CHILL, STORM_CHILL, WEATHER_NOISE};
use crate::{Sim, TICKS_PER_DAY};

/// Temps courant. Les valeurs sont un contrat avec
/// `apps/client/src/render/terrain.ts` (`WEATHER_LABELS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Weather {
    Clear = 0,
    Rain = 1,
    Storm = 2,
    /// La pluie quand il gèle. Mêmes effets qu'elle sur la croissance, plus un
    /// petit coup au moral.
    Snow = 3,
}

/// Nombre de temps différents (taille des tableaux indexés par `Weather`).
pub const WEATHER_COUNT: usize = 4;

impl Weather {
    pub fn from_u8(v: u8) -> Weather {
        match v {
            1 => Weather::Rain,
            2 => Weather::Storm,
            3 => Weather::Snow,
            _ => Weather::Clear,
        }
    }

    /// Il tombe de l'eau : les cultures en profitent.
    pub fn is_wet(self) -> bool {
        matches!(self, Weather::Rain | Weather::Storm | Weather::Snow)
    }

    /// Refroidissement apporté par ce temps, en dixièmes de degré. La neige
    /// refroidit comme la pluie qu'elle remplace : passer de l'une à l'autre
    /// ne change pas la température, donc rien ne peut osciller.
    pub fn temperature_offset(self) -> i32 {
        match self {
            Weather::Clear => 0,
            Weather::Rain | Weather::Snow => RAIN_CHILL,
            Weather::Storm => STORM_CHILL,
        }
    }
}

impl Sim {
    pub fn weather(&self) -> Weather {
        self.weather
    }

    /// Impose une météo jusqu'à un tick donné (tests et scénarios).
    pub fn force_weather(&mut self, w: Weather, until: u64) {
        self.weather = w;
        self.weather_until = until;
    }

    /// Bruit de température de la période météo courante, en dixièmes.
    pub fn weather_noise(&self) -> i32 {
        self.weather_noise
    }

    /// Tire une nouvelle météo quand la précédente a fait son temps, puis
    /// tranche entre pluie et neige. Le bruit de température est tiré **après**
    /// la durée : les deux premiers tirages restent ceux d'avant les saisons,
    /// donc la suite des temps d'une graine donnée n'a pas bougé.
    pub(crate) fn tick_weather(&mut self) {
        if self.tick >= self.weather_until {
            let roll = self.rng.below(100);
            self.weather = if roll < 60 {
                Weather::Clear
            } else if roll < 90 {
                Weather::Rain
            } else {
                Weather::Storm
            };
            let duration = TICKS_PER_DAY / 4 + self.rng.below(3 * TICKS_PER_DAY / 4);
            self.weather_until = self.tick + u64::from(duration);
            self.weather_noise = self.rng.range_i32(-WEATHER_NOISE, WEATHER_NOISE + 1);
        }
        self.freeze_or_thaw();
    }

    /// La pluie devient neige quand il gèle, et redevient pluie au dégel.
    fn freeze_or_thaw(&mut self) {
        match self.weather {
            Weather::Rain if self.outdoor_temperature() < FREEZING => self.weather = Weather::Snow,
            Weather::Snow if self.outdoor_temperature() >= FREEZING => self.weather = Weather::Rain,
            _ => {}
        }
    }
}
