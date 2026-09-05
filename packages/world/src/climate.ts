/**
 * Climat imposé au sim d'une colonie, dérivé de la case du globe qui la
 * porte.
 *
 * Le sim connaît son propre climat (`crates/sim/src/climate.rs`,
 * `Command::SetClimate { base_temperature, amplitude }`) : une moyenne
 * annuelle et un écart été/hiver, en **dixièmes de degré Celsius entiers**
 * (contrat partagé avec `crates/sim`, voir `AGENTS.md`). Le globe, lui,
 * connaît la température annuelle de chaque case (`Tile.temperature`, en °C,
 * déjà fonction de la latitude et de l'altitude, `docs/world.md` §3). Ce
 * module relie les deux : c'est le serveur monde qui appelle
 * `climateForTile` pour fabriquer le `climate` du `start` diffusé à une
 * salle « case » (`docs/protocol.md` §3.2 et §11.6), jamais le client.
 */

import { Biome, type Tile } from "./biomes.js";

/**
 * Climat d'une case, dans la forme attendue par `Command::SetClimate` :
 * dixièmes de degré Celsius entiers.
 */
export interface TileClimate {
  /** Moyenne annuelle, en dixièmes de °C. */
  readonly baseTemperature: number;
  /** Écart été/hiver, en dixièmes de °C. */
  readonly amplitude: number;
}

/**
 * Bornes acceptées par `Climate::sanitized` côté sim (`TEMPERATURE_MIN/MAX`,
 * `Climate::AMPLITUDE_MAX`), en dixièmes de °C. Un climat hors de ces bornes
 * serait de toute façon rogné par le sim ; `climateForTile` le fait déjà pour
 * ne jamais transporter un nombre qui ment sur ce qui sera réellement
 * appliqué.
 */
export const CLIMATE_BASE_MIN = -2000;
export const CLIMATE_BASE_MAX = 2000;
export const CLIMATE_AMPLITUDE_MIN = 0;
export const CLIMATE_AMPLITUDE_MAX = 1000;

/** Amplitude à l'équateur, en dixièmes de °C : ±4 °C. */
const AMPLITUDE_EQUATOR = 40;
/** Part de l'amplitude liée à la latitude, en dixièmes de °C : jusqu'à ±16 °C de plus au pôle. */
const AMPLITUDE_LATITUDE_SPAN = 160;
/** Surplus d'amplitude d'un désert, en dixièmes de °C : ±3 °C de plus. */
const AMPLITUDE_DESERT_BONUS = 30;

function clamp(value: number, min: number, max: number): number {
  return value < min ? min : value > max ? max : value;
}

/**
 * Climat à imposer au sim d'une colonie fondée sur `tile`.
 *
 * - `baseTemperature` reprend `tile.temperature` (moyenne annuelle, en °C)
 *   telle quelle, juste convertie en dixièmes et arrondie à l'entier le plus
 *   proche.
 * - `amplitude` grandit avec la latitude — ±4 °C à l'équateur, jusqu'à ±20 °C
 *   au pôle, une courbe en sinus de la latitude comme la formule de
 *   température du globe (`docs/world.md` §3) — et gagne ±3 °C de plus en
 *   désert (`Biome.Desert`) : plus grand écart thermique jour/nuit et
 *   saisonnier d'un climat sec, seule granularité que porte le sim (été/hiver,
 *   pas jour/nuit).
 *
 * `tile.lat` est en **degrés** (`docs/world.md` §2) ; converti en radians
 * avant `Math.sin`.
 *
 * Les deux valeurs sont bornées aux limites acceptées par le sim
 * (`CLIMATE_BASE_*`, `CLIMATE_AMPLITUDE_*`). Aucune case du globe actuel ne
 * peut aujourd'hui les atteindre — la température va de -30 °C - bruit à
 * 32 °C + bruit (`docs/world.md` §3), et l'amplitude maximale (pôle et
 * désert, climatiquement impossible ensemble mais non exclu par cette
 * fonction pure) est 40 + 160 + 30 = 230 dixièmes — mais la borne protège si
 * la calibration du globe change un jour.
 */
export function climateForTile(tile: Pick<Tile, "temperature" | "lat" | "biome">): TileClimate {
  const baseTemperature = clamp(Math.round(tile.temperature * 10), CLIMATE_BASE_MIN, CLIMATE_BASE_MAX);

  const latitudeRadians = (tile.lat * Math.PI) / 180;
  let amplitude = AMPLITUDE_EQUATOR + AMPLITUDE_LATITUDE_SPAN * Math.abs(Math.sin(latitudeRadians));
  if (tile.biome === Biome.Desert) {
    amplitude += AMPLITUDE_DESERT_BONUS;
  }

  return {
    baseTemperature,
    amplitude: clamp(Math.round(amplitude), CLIMATE_AMPLITUDE_MIN, CLIMATE_AMPLITUDE_MAX),
  };
}
