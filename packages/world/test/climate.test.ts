import { describe, expect, it } from "vitest";

import {
  Biome,
  CLIMATE_AMPLITUDE_MAX,
  CLIMATE_AMPLITUDE_MIN,
  CLIMATE_BASE_MAX,
  CLIMATE_BASE_MIN,
  climateForTile,
} from "../src/index.js";

/** Un fragment de `Tile` : seuls les trois champs lus par `climateForTile`. */
function tile(temperature: number, lat: number, biome: Biome = Biome.Grassland) {
  return { temperature, lat, biome };
}

describe("climateForTile", () => {
  it("donne un climat doux et peu contrasté à l'équateur", () => {
    // 26 °C, latitude nulle : amplitude minimale (équateur), ±4 °C.
    const climate = climateForTile(tile(26, 0, Biome.Grassland));
    expect(climate.baseTemperature).toBe(260);
    expect(climate.amplitude).toBe(40);
  });

  it("donne un climat glacial et très contrasté au pôle", () => {
    // -34 °C à 90° de latitude : amplitude maximale (pôle), ±20 °C.
    const climate = climateForTile(tile(-34, 90, Biome.Ice));
    expect(climate.baseTemperature).toBe(-340);
    expect(climate.amplitude).toBe(200);
  });

  it("rend un désert plus contrasté qu'une case au même climat mais un autre biome", () => {
    const desert = climateForTile(tile(18, 30, Biome.Desert));
    const grassland = climateForTile(tile(18, 30, Biome.Grassland));
    expect(desert.baseTemperature).toBe(grassland.baseTemperature);
    expect(desert.amplitude).toBe(grassland.amplitude + 30);
  });

  it("borne base et amplitude aux limites acceptées par le sim", () => {
    // Une température aberrante (hors de tout ce que le globe peut produire)
    // doit être rognée plutôt que transportée telle quelle.
    expect(climateForTile(tile(500, 0)).baseTemperature).toBe(CLIMATE_BASE_MAX);
    expect(climateForTile(tile(-500, 0)).baseTemperature).toBe(CLIMATE_BASE_MIN);

    // Le cas le plus extrême que la formule puisse produire (pôle et désert,
    // climatiquement impossible ensemble mais non exclu par cette fonction
    // pure) reste très en dessous du plafond : la borne est une protection,
    // pas un seuil jamais atteint aujourd'hui.
    const worst = climateForTile(tile(0, 90, Biome.Desert));
    expect(worst.amplitude).toBeGreaterThanOrEqual(CLIMATE_AMPLITUDE_MIN);
    expect(worst.amplitude).toBeLessThanOrEqual(CLIMATE_AMPLITUDE_MAX);
    expect(worst.amplitude).toBeLessThan(CLIMATE_AMPLITUDE_MAX);
  });

  it("arrondit à l'entier et accepte une latitude négative comme positive", () => {
    const north = climateForTile(tile(12.34, 45));
    const south = climateForTile(tile(12.34, -45));
    expect(north.baseTemperature).toBe(123);
    expect(north.amplitude).toBe(south.amplitude);
  });
});
