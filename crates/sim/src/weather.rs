//! Météo de la carte. Elle change toute seule au fil des jours et n'a que
//! deux effets pour l'instant : la pluie fait pousser les plants deux fois
//! plus vite, l'orage plombe l'humeur de tout le monde.

use serde::{Deserialize, Serialize};

use crate::{Sim, TICKS_PER_DAY};

/// Temps courant. Les valeurs sont un contrat avec
/// `apps/client/src/render/terrain.ts` (`WEATHER_LABELS`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Weather {
    Clear = 0,
    Rain = 1,
    Storm = 2,
}

impl Weather {
    pub fn from_u8(v: u8) -> Weather {
        match v {
            1 => Weather::Rain,
            2 => Weather::Storm,
            _ => Weather::Clear,
        }
    }

    /// Il tombe de l'eau : les cultures en profitent.
    pub fn is_wet(self) -> bool {
        matches!(self, Weather::Rain | Weather::Storm)
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

    /// Tire une nouvelle météo quand la précédente a fait son temps.
    pub(crate) fn tick_weather(&mut self) {
        if self.tick < self.weather_until {
            return;
        }
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
    }
}
