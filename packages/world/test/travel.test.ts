import { describe, expect, it } from "vitest";

import {
  Biome,
  MIN_MOVEMENT_COST,
  MOVEMENT_COSTS,
  createRng,
  findRoute,
  generateWorld,
  greatCircleDistance,
  movementCost,
  tileAngles,
  type Tile,
  type World,
} from "../src/index.js";

const N = 3;
const world = generateWorld(N, 20_260_904);

const passable = (tile: Tile): boolean => movementCost(tile.biome) !== null;

/** Remplace les biomes d'un monde, pour construire un cas de figure précis. */
function withBiomes(source: World, pick: (tile: Tile) => Biome): World {
  return { ...source, tiles: source.tiles.map((tile) => ({ ...tile, biome: pick(tile) })) };
}

/**
 * Dijkstra de référence, écrit ici exprès : naïf, O(N²), sans heuristique.
 * Il sert d'oracle pour l'A* de `findRoute`.
 */
function dijkstraHours(source: World, fromId: number, toId: number): number | null {
  const tiles = source.tiles;
  if (movementCost(tiles[fromId]!.biome) === null) {
    return null;
  }
  const distance = new Array<number>(tiles.length).fill(Number.POSITIVE_INFINITY);
  const settled = new Array<boolean>(tiles.length).fill(false);
  distance[fromId] = 0;
  for (;;) {
    let current = -1;
    for (let i = 0; i < tiles.length; i += 1) {
      if (!settled[i] && (current === -1 || (distance[i] as number) < (distance[current] as number))) {
        current = i;
      }
    }
    if (current === -1 || !Number.isFinite(distance[current] as number)) {
      break;
    }
    settled[current] = true;
    for (const neighbor of tiles[current]!.neighbors) {
      const step = movementCost(tiles[neighbor]!.biome);
      if (step === null) {
        continue;
      }
      const candidate = (distance[current] as number) + step;
      if (candidate < (distance[neighbor] as number)) {
        distance[neighbor] = candidate;
      }
    }
  }
  const total = distance[toId] as number;
  return Number.isFinite(total) ? total : null;
}

describe("coûts de déplacement", () => {
  it("rend l'océan infranchissable et les prairies les plus rapides", () => {
    expect(movementCost(Biome.Ocean)).toBeNull();
    expect(movementCost(Biome.Grassland)).toBe(MIN_MOVEMENT_COST);
    for (const biome of [Biome.Savanna, Biome.Tundra, Biome.Desert, Biome.Jungle, Biome.Mountain]) {
      expect(movementCost(biome)).toBeGreaterThanOrEqual(MIN_MOVEMENT_COST);
    }
  });

  it("classe la montagne comme le terrain le plus lent", () => {
    const costs = Object.values(MOVEMENT_COSTS).filter((cost): cost is number => cost !== null);
    expect(movementCost(Biome.Mountain)).toBe(Math.max(...costs));
    expect(MIN_MOVEMENT_COST).toBe(Math.min(...costs));
  });

  it("donne un coût à chacun des dix biomes", () => {
    const biomes = Object.values(Biome).filter((value): value is Biome => typeof value === "number");
    for (const biome of biomes) {
      const cost = MOVEMENT_COSTS[biome];
      expect(cost === null || cost > 0).toBe(true);
    }
  });
});

describe("distance orthodromique", () => {
  it("mesure 0 sur place et π aux antipodes", () => {
    expect(greatCircleDistance([0, 1, 0], [0, 1, 0]).radians).toBeCloseTo(0, 12);
    expect(greatCircleDistance([0, 1, 0], [0, -1, 0]).radians).toBeCloseTo(Math.PI, 12);
  });

  it("convertit en cases avec l'angle du monde fourni", () => {
    const { mean } = tileAngles(world);
    const a = world.tiles[0]!.center;
    const b = world.tiles[300]!.center;
    const measured = greatCircleDistance(a, b, world);
    expect(measured.tiles).toBeCloseTo(measured.radians / mean, 9);
  });

  it("compte une case, à la distorsion près, entre deux voisins", () => {
    // La subdivision étire les arêtes de ±10 % autour de la moyenne : « une
    // case » n'est donc pas une mesure exacte, seulement un ordre de grandeur.
    for (const tile of world.tiles) {
      for (const id of tile.neighbors) {
        const measured = greatCircleDistance(tile.center, world.tiles[id]!.center, world).tiles;
        expect(measured).toBeGreaterThan(0.85);
        expect(measured).toBeLessThan(1.15);
      }
    }
  });

  it("compte un demi-tour de globe entre deux antipodes", () => {
    // À n = 3 l'angle moyen vaut ~0,151 rad : π / 0,151 ≈ 21 cases.
    const half = greatCircleDistance([0, 1, 0], [0, -1, 0], world).tiles;
    expect(half).toBeGreaterThan(18);
    expect(half).toBeLessThan(24);
  });
});

describe("findRoute", () => {
  it("rend un itinéraire de deux cases entre deux terres voisines", () => {
    const start = world.tiles.find(
      (tile) => passable(tile) && tile.neighbors.some((id) => passable(world.tiles[id]!)),
    );
    expect(start).toBeDefined();
    const target = start!.neighbors.find((id) => passable(world.tiles[id]!)) as number;
    const route = findRoute(world, start!.id, target);
    expect(route).not.toBeNull();
    expect(route!.tiles).toEqual([start!.id, target]);
    expect(route!.hours).toBe(movementCost(world.tiles[target]!.biome));
  });

  it("rend un itinéraire vide et gratuit sur place", () => {
    const tile = world.tiles.find(passable) as Tile;
    expect(findRoute(world, tile.id, tile.id)).toEqual({ tiles: [tile.id], hours: 0 });
  });

  it("refuse de partir de l'océan ou d'y arriver", () => {
    const land = world.tiles.find(passable) as Tile;
    const sea = world.tiles.find((tile) => !passable(tile)) as Tile;
    expect(findRoute(world, sea.id, land.id)).toBeNull();
    expect(findRoute(world, land.id, sea.id)).toBeNull();
  });

  it("refuse les identifiants hors du monde", () => {
    expect(() => findRoute(world, -1, 0)).toThrow(RangeError);
    expect(() => findRoute(world, 0, world.tiles.length)).toThrow(RangeError);
    expect(() => findRoute(world, 0.5, 1)).toThrow(RangeError);
  });

  it("rend le même coût que le Dijkstra de référence sur 20 paires tirées au sort", () => {
    const rng = createRng(20_260_905);
    const landIds = world.tiles.filter(passable).map((tile) => tile.id);
    expect(landIds.length).toBeGreaterThan(50);
    let compared = 0;
    for (let i = 0; i < 20; i += 1) {
      const from = rng.pick(landIds);
      const to = rng.pick(landIds);
      const route = findRoute(world, from, to);
      const reference = dijkstraHours(world, from, to);
      if (reference === null) {
        expect(route).toBeNull();
      } else {
        expect(route).not.toBeNull();
        expect(route!.hours).toBeCloseTo(reference, 9);
        compared += 1;
      }
    }
    expect(compared).toBeGreaterThan(10);
  });

  it("rend un itinéraire cohérent : cases voisines, coûts qui s'additionnent", () => {
    const rng = createRng(777);
    const landIds = world.tiles.filter(passable).map((tile) => tile.id);
    for (let i = 0; i < 20; i += 1) {
      const route = findRoute(world, rng.pick(landIds), rng.pick(landIds));
      if (route === null) {
        continue;
      }
      let hours = 0;
      for (let k = 1; k < route.tiles.length; k += 1) {
        const previous = route.tiles[k - 1] as number;
        const current = route.tiles[k] as number;
        expect(world.tiles[previous]!.neighbors).toContain(current);
        hours += movementCost(world.tiles[current]!.biome) as number;
      }
      expect(hours).toBeCloseTo(route.hours, 9);
      expect(new Set(route.tiles).size).toBe(route.tiles.length);
    }
  });

  it("ne traverse jamais l'océan", () => {
    const rng = createRng(31_337);
    const landIds = world.tiles.filter(passable).map((tile) => tile.id);
    for (let i = 0; i < 40; i += 1) {
      const route = findRoute(world, rng.pick(landIds), rng.pick(landIds));
      if (route === null) {
        continue;
      }
      for (const id of route.tiles) {
        expect(world.tiles[id]!.biome).not.toBe(Biome.Ocean);
        expect(movementCost(world.tiles[id]!.biome)).not.toBeNull();
      }
    }
  });
});

describe("continents séparés", () => {
  // Petit monde à biomes forcés : deux calottes de prairie séparées par une
  // ceinture d'océan de part et d'autre de l'équateur.
  const split = withBiomes(generateWorld(2, 1), (tile) =>
    Math.abs(tile.lat) < 30 ? Biome.Ocean : Biome.Grassland,
  );
  const north = split.tiles.filter((tile) => tile.lat >= 30);
  const south = split.tiles.filter((tile) => tile.lat <= -30);

  it("a bien deux calottes de terre non vides", () => {
    expect(north.length).toBeGreaterThan(10);
    expect(south.length).toBeGreaterThan(10);
  });

  it("relie deux cases de la même calotte", () => {
    const route = findRoute(split, north[0]!.id, north[north.length - 1]!.id);
    expect(route).not.toBeNull();
    expect(route!.tiles[0]).toBe(north[0]!.id);
  });

  it("ne relie pas deux calottes séparées par l'océan", () => {
    for (const from of north.slice(0, 5)) {
      for (const to of south.slice(0, 5)) {
        expect(findRoute(split, from.id, to.id)).toBeNull();
        expect(dijkstraHours(split, from.id, to.id)).toBeNull();
      }
    }
  });

  it("retrouve le passage dès qu'on pose un pont de banquise", () => {
    const bridge = withBiomes(split, (tile) =>
      tile.biome === Biome.Ocean && Math.abs(tile.lon) < 20 ? Biome.Ice : tile.biome,
    );
    const route = findRoute(bridge, north[0]!.id, south[0]!.id);
    expect(route).not.toBeNull();
    expect(route!.tiles.some((id) => bridge.tiles[id]!.biome === Biome.Ice)).toBe(true);
    // Le pont est le seul chemin : il coûte forcément le prix de la banquise.
    expect(route!.hours).toBe(dijkstraHours(bridge, north[0]!.id, south[0]!.id));
  });
});

describe("heuristique de l'A*", () => {
  it("reste admissible : jamais plus grande que le coût réel", () => {
    const rng = createRng(4711);
    const landIds = world.tiles.filter(passable).map((tile) => tile.id);
    const { max } = tileAngles(world);
    for (let i = 0; i < 30; i += 1) {
      const from = rng.pick(landIds);
      const to = rng.pick(landIds);
      const route = findRoute(world, from, to);
      if (route === null) {
        continue;
      }
      const estimate =
        (greatCircleDistance(world.tiles[from]!.center, world.tiles[to]!.center).radians / max) *
        MIN_MOVEMENT_COST;
      expect(estimate).toBeLessThanOrEqual(route.hours + 1e-9);
    }
  });
});
