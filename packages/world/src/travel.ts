/**
 * Déplacement sur le globe : coût par biome, distance orthodromique et
 * itinéraire de caravane.
 *
 * Les coûts sont en **heures de jeu par case traversée**. Le serveur monde
 * fait avancer une caravane en consommant ces heures ; le client n'appelle
 * `findRoute` que pour prévisualiser, l'itinéraire qui compte est celui
 * calculé côté serveur.
 */

import { type Vec3, angleBetween } from "./geometry.js";
import { Biome, type World } from "./biomes.js";

/**
 * Coût de traversée d'une case, en heures de jeu. `null` = infranchissable.
 *
 * L'océan est infranchissable : il n'y a pas de bateaux pour l'instant, donc
 * une caravane ne quitte pas son continent (la banquise, elle, se traverse —
 * c'est le seul pont entre deux masses de terre polaires).
 */
export const MOVEMENT_COSTS: Readonly<Record<Biome, number | null>> = {
  [Biome.Ocean]: null,
  [Biome.Mountain]: 24,
  [Biome.Ice]: 14,
  [Biome.Jungle]: 12,
  [Biome.BorealForest]: 9,
  [Biome.TemperateForest]: 8,
  [Biome.Desert]: 8,
  [Biome.Tundra]: 7,
  [Biome.Savanna]: 5,
  [Biome.Grassland]: 4,
};

/**
 * Coût minimal non nul de la table. Sert de facteur à l'heuristique de l'A*
 * et doit rester une borne inférieure : c'est ce qui garantit que
 * l'heuristique n'est jamais optimiste au-delà du vrai coût.
 */
export const MIN_MOVEMENT_COST: number = Object.values(MOVEMENT_COSTS).reduce<number>(
  (min, cost) => (cost !== null && cost < min ? cost : min),
  Number.POSITIVE_INFINITY,
);

/** Coût de traversée d'un biome, en heures. `null` si infranchissable. */
export function movementCost(biome: Biome): number | null {
  return MOVEMENT_COSTS[biome] ?? null;
}

/** Distance orthodromique, en radians et en « cases ». */
export interface GreatCircle {
  /** Angle au centre du globe, en radians. */
  readonly radians: number;
  /** Le même écart exprimé en nombre de cases (angle / angle moyen entre voisins). */
  readonly tiles: number;
}

/** Mesures d'écartement des cases d'un globe. */
export interface TileAngles {
  /** Angle moyen entre deux centres voisins, en radians. */
  readonly mean: number;
  /** Angle maximal entre deux centres voisins, en radians. */
  readonly max: number;
}

/**
 * Mesures d'angles entre voisins, mémoïsées par monde : les parcourir coûte
 * un balayage de toutes les arêtes, et l'A* en a besoin à chaque appel.
 */
const angleCache = new WeakMap<World, TileAngles>();

/**
 * Angle moyen et angle maximal entre deux cases voisines, en radians.
 *
 * Les deux servent à des choses différentes :
 * - la **moyenne** convertit une distance en « cases », un nombre destiné à
 *   l'affichage et aux estimations de durée ;
 * - le **maximum** sert d'échelle à l'heuristique de l'A*. Diviser par le
 *   plus grand pas possible sous-estime le nombre d'étapes, donc garde
 *   l'heuristique admissible. La subdivision déforme les arêtes de ±10 %
 *   autour de la moyenne, l'écart n'est pas négligeable.
 */
export function tileAngles(world: World): TileAngles {
  const cached = angleCache.get(world);
  if (cached !== undefined) {
    return cached;
  }
  let sum = 0;
  let count = 0;
  let max = 0;
  for (const tile of world.tiles) {
    for (const neighbor of tile.neighbors) {
      const angle = angleBetween(tile.center, world.tiles[neighbor].center);
      sum += angle;
      count += 1;
      if (angle > max) {
        max = angle;
      }
    }
  }
  const angles: TileAngles = count > 0 ? { mean: sum / count, max } : { mean: 1, max: 1 };
  angleCache.set(world, angles);
  return angles;
}

/**
 * Angle moyen entre voisins du globe par défaut (n = 5), mesuré une fois :
 * 0,03777 rad, soit 2,16°. La constante évite de générer une grille de
 * 10 242 cases juste pour convertir une distance.
 */
export const DEFAULT_TILE_ANGLE = 0.037_77;

/**
 * Distance orthodromique entre deux points unitaires du globe.
 *
 * Sans `world`, la conversion en cases utilise l'angle moyen du globe par
 * défaut (`DEFAULT_SUBDIVISIONS`) ; passer le monde donne la conversion
 * exacte pour sa subdivision.
 */
export function greatCircleDistance(a: Vec3, b: Vec3, world?: World): GreatCircle {
  const radians = angleBetween(a, b);
  const angle = world === undefined ? DEFAULT_TILE_ANGLE : tileAngles(world).mean;
  return { radians, tiles: radians / angle };
}

/** Itinéraire trouvé : les cases traversées, départ et arrivée compris. */
export interface Route {
  /** Cases de l'itinéraire, `[fromId, …, toId]`. */
  readonly tiles: number[];
  /** Durée totale, en heures de jeu. */
  readonly hours: number;
}

/**
 * Tas binaire minimal (clé flottante, valeur entière), maison pour ne pas
 * ajouter de dépendance. Les deux tableaux sont parallèles : `keys[i]` est la
 * priorité de `items[i]`.
 */
class MinHeap {
  private readonly items: number[] = [];
  private readonly keys: number[] = [];

  get size(): number {
    return this.items.length;
  }

  push(item: number, key: number): void {
    this.items.push(item);
    this.keys.push(key);
    let child = this.items.length - 1;
    while (child > 0) {
      const parent = (child - 1) >> 1;
      if (this.keys[parent] <= this.keys[child]) {
        break;
      }
      this.swap(parent, child);
      child = parent;
    }
  }

  /** Retire et renvoie l'élément de plus petite clé, ou -1 si le tas est vide. */
  pop(): number {
    const size = this.items.length;
    if (size === 0) {
      return -1;
    }
    const top = this.items[0];
    const lastItem = this.items.pop() as number;
    const lastKey = this.keys.pop() as number;
    if (size > 1) {
      this.items[0] = lastItem;
      this.keys[0] = lastKey;
      let parent = 0;
      for (;;) {
        const left = parent * 2 + 1;
        const right = left + 1;
        let smallest = parent;
        if (left < this.items.length && this.keys[left] < this.keys[smallest]) {
          smallest = left;
        }
        if (right < this.items.length && this.keys[right] < this.keys[smallest]) {
          smallest = right;
        }
        if (smallest === parent) {
          break;
        }
        this.swap(parent, smallest);
        parent = smallest;
      }
    }
    return top;
  }

  private swap(a: number, b: number): void {
    const item = this.items[a];
    this.items[a] = this.items[b];
    this.items[b] = item;
    const key = this.keys[a];
    this.keys[a] = this.keys[b];
    this.keys[b] = key;
  }
}

/**
 * Itinéraire le moins coûteux entre deux cases, par A* sur le graphe des
 * voisins. `null` si la destination est inaccessible par voie terrestre, ou
 * si l'une des deux extrémités est infranchissable.
 *
 * Modèle de coût : entrer dans une case coûte le prix de **son** biome ; la
 * case de départ est gratuite. `hours` est donc la somme des coûts des cases
 * après le départ.
 *
 * Heuristique : `distance orthodromique / plus grand pas possible ×
 * MIN_MOVEMENT_COST`. Tout chemin de `k` étapes couvre au plus
 * `k × angleMax` de sphère, donc `k >= angle / angleMax`, et chaque étape
 * coûte au moins `MIN_MOVEMENT_COST` : l'heuristique ne surestime jamais le
 * coût restant, l'A* rend donc un optimum, identique à celui d'un Dijkstra.
 */
export function findRoute(world: World, fromId: number, toId: number): Route | null {
  const tiles = world.tiles;
  const count = tiles.length;
  if (!Number.isInteger(fromId) || !Number.isInteger(toId)) {
    throw new RangeError("les identifiants de case doivent être des entiers");
  }
  if (fromId < 0 || fromId >= count || toId < 0 || toId >= count) {
    throw new RangeError("identifiant de case hors du monde");
  }
  if (movementCost(tiles[fromId].biome) === null || movementCost(tiles[toId].biome) === null) {
    return null;
  }
  if (fromId === toId) {
    return { tiles: [fromId], hours: 0 };
  }

  const goal = tiles[toId].center;
  const scale = MIN_MOVEMENT_COST / tileAngles(world).max;
  const heuristic = (id: number): number => angleBetween(tiles[id].center, goal) * scale;

  const best = new Float64Array(count).fill(Number.POSITIVE_INFINITY);
  const cameFrom = new Int32Array(count).fill(-1);
  const closed = new Uint8Array(count);
  const open = new MinHeap();

  best[fromId] = 0;
  open.push(fromId, heuristic(fromId));

  while (open.size > 0) {
    const current = open.pop();
    if (closed[current] === 1) {
      // Entrée périmée : la case a déjà été traitée avec un meilleur coût.
      continue;
    }
    closed[current] = 1;
    if (current === toId) {
      const path: number[] = [];
      for (let node = toId; node !== -1; node = cameFrom[node]) {
        path.push(node);
      }
      path.reverse();
      return { tiles: path, hours: best[toId] };
    }
    for (const neighbor of tiles[current].neighbors) {
      if (closed[neighbor] === 1) {
        continue;
      }
      const step = movementCost(tiles[neighbor].biome);
      if (step === null) {
        continue;
      }
      const candidate = best[current] + step;
      if (candidate < best[neighbor]) {
        best[neighbor] = candidate;
        cameFrom[neighbor] = current;
        open.push(neighbor, candidate + heuristic(neighbor));
      }
    }
  }

  return null;
}
