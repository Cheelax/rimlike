/**
 * Géométrie du globe : géodésique icosaédrique et son dual hexagonal.
 *
 * Le monde est un icosaèdre subdivisé `n` fois et projeté sur la sphère
 * unité. Les **cases** du jeu ne sont pas ses triangles mais les cellules de
 * son **dual** : une case par sommet de la géodésique, son polygone étant
 * formé des centres des faces incidentes. Les 12 sommets de l'icosaèdre
 * d'origine ont 5 faces incidentes, donc 5 voisins : ce sont les 12
 * pentagones inévitables de tout pavage hexagonal de la sphère. Tous les
 * autres sommets ont 6 voisins.
 *
 * Nombre de cases : `10 * 4^n + 2` (12, 42, 162, 642, 2562, 10242…).
 *
 * Repère : sphère unité, axe **+Y vers le nord** (convention Three.js, le
 * client peut poser les positions telles quelles). La latitude vaut
 * `asin(y)`, la longitude `atan2(x, z)` : longitude 0 sur le méridien +Z,
 * croissante vers +X (est).
 */

/** Point ou direction dans l'espace. Les centres et sommets sont unitaires. */
export type Vec3 = readonly [x: number, y: number, z: number];

/** Subdivision par défaut du globe de jeu : 10 242 cases. */
export const DEFAULT_SUBDIVISIONS = 5;

/** Subdivision maximale acceptée (2 621 442 cases : bien au-delà du besoin). */
const MAX_SUBDIVISIONS = 8;

/**
 * Angle entre deux sommets voisins de l'icosaèdre d'origine, en radians :
 * `acos(1 / sqrt(5))` ≈ 1,10715 rad (63,43°). Chaque subdivision le divise
 * approximativement par deux.
 */
export const ICOSAHEDRON_EDGE_ANGLE = Math.acos(1 / Math.sqrt(5));

/** Maillage triangulaire indexé sur la sphère unité. */
export interface Mesh {
  /** Sommets, tous de norme 1. */
  readonly positions: readonly Vec3[];
  /** Faces, indices de sommets, orientées dans le sens antihoraire vu de l'extérieur. */
  readonly faces: readonly (readonly [number, number, number])[];
  /** Arêtes dédupliquées, chaque paire donnée avec le plus petit indice en premier. */
  readonly edges: readonly (readonly [number, number])[];
}

/** Géométrie d'une case du globe (cellule du dual). */
export interface TileGeometry {
  /** Indice de la case, égal à son indice de sommet dans la géodésique. */
  readonly id: number;
  /** Centre de la case, vecteur unitaire. */
  readonly center: Vec3;
  /** Latitude en degrés, dans [-90, 90]. */
  readonly lat: number;
  /** Longitude en degrés, dans (-180, 180]. */
  readonly lon: number;
  /** Voisins (5 pour les 12 pentagones, 6 sinon), ordonnés autour du centre. */
  readonly neighbors: readonly number[];
  /**
   * Sommets du polygone de la case, dans le même ordre que `neighbors` :
   * `polygon[i]` est le centre de la face incidente qui joint `neighbors[i]`
   * à `neighbors[i + 1]`. Ces sommets sont partagés à l'identique par les
   * cases adjacentes, donc les polygones pavent la sphère sans trou.
   */
  readonly polygon: readonly Vec3[];
  /** Aire du polygone sphérique, en stéradians (la sphère entière vaut 4π). */
  readonly area: number;
}

const DEG_PER_RAD = 180 / Math.PI;

/** Produit scalaire. */
export function dot(a: Vec3, b: Vec3): number {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

/** Produit vectoriel. */
export function cross(a: Vec3, b: Vec3): Vec3 {
  return [
    a[1] * b[2] - a[2] * b[1],
    a[2] * b[0] - a[0] * b[2],
    a[0] * b[1] - a[1] * b[0],
  ];
}

/** Norme euclidienne. */
export function length(v: Vec3): number {
  return Math.sqrt(dot(v, v));
}

/** Vecteur unitaire de même direction. Lève sur le vecteur nul. */
export function normalize(v: Vec3): Vec3 {
  const l = length(v);
  if (l === 0) {
    throw new RangeError("normalisation du vecteur nul");
  }
  return [v[0] / l, v[1] / l, v[2] / l];
}

/**
 * Angle entre deux vecteurs unitaires, en radians. La forme
 * `2 * atan2(|a - b|, |a + b|)` reste précise pour les angles très petits
 * comme très proches de π, contrairement à `acos(a · b)`.
 */
export function angleBetween(a: Vec3, b: Vec3): number {
  const dx = a[0] - b[0];
  const dy = a[1] - b[1];
  const dz = a[2] - b[2];
  const sx = a[0] + b[0];
  const sy = a[1] + b[1];
  const sz = a[2] + b[2];
  return 2 * Math.atan2(Math.sqrt(dx * dx + dy * dy + dz * dz), Math.sqrt(sx * sx + sy * sy + sz * sz));
}

/** Latitude et longitude d'un vecteur unitaire, en degrés. */
export function toLatLon(v: Vec3): { readonly lat: number; readonly lon: number } {
  const y = v[1] < -1 ? -1 : v[1] > 1 ? 1 : v[1];
  return {
    lat: Math.asin(y) * DEG_PER_RAD,
    lon: Math.atan2(v[0], v[2]) * DEG_PER_RAD,
  };
}

/**
 * Aire d'un triangle sphérique de sommets unitaires, en stéradians, par la
 * formule de Van Oosterom & Strackee (excès sphérique sous forme d'`atan2`,
 * stable même pour les triangles très fins).
 */
export function sphericalTriangleArea(a: Vec3, b: Vec3, c: Vec3): number {
  const numerator = Math.abs(dot(a, cross(b, c)));
  const denominator = 1 + dot(a, b) + dot(b, c) + dot(c, a);
  return 2 * Math.atan2(numerator, denominator);
}

/**
 * Aire d'un polygone sphérique convexe, en stéradians : somme des triangles
 * de l'éventail partant du premier sommet.
 */
export function sphericalPolygonArea(polygon: readonly Vec3[]): number {
  let area = 0;
  for (let i = 1; i + 1 < polygon.length; i += 1) {
    area += sphericalTriangleArea(polygon[0] as Vec3, polygon[i] as Vec3, polygon[i + 1] as Vec3);
  }
  return area;
}

/** Nombre de cases (sommets de la géodésique) pour `subdivisions` subdivisions. */
export function tileCount(subdivisions: number): number {
  assertSubdivisions(subdivisions);
  return 10 * 4 ** subdivisions + 2;
}

function assertSubdivisions(subdivisions: number): void {
  if (!Number.isInteger(subdivisions) || subdivisions < 0 || subdivisions > MAX_SUBDIVISIONS) {
    throw new RangeError(`subdivisions doit être un entier dans [0, ${MAX_SUBDIVISIONS}]`);
  }
}

/** Arêtes dédupliquées d'une liste de faces. */
function buildEdges(faces: readonly (readonly [number, number, number])[]): (readonly [number, number])[] {
  const seen = new Set<number>();
  const edges: (readonly [number, number])[] = [];
  const add = (a: number, b: number): void => {
    const lo = a < b ? a : b;
    const hi = a < b ? b : a;
    // Clé entière exacte tant qu'il y a moins de 10^7 sommets (10^7 * 10^7
    // dépasserait 2^53, mais lo * 10^7 + hi reste très en dessous ici).
    const key = lo * 10_000_000 + hi;
    if (!seen.has(key)) {
      seen.add(key);
      edges.push([lo, hi]);
    }
  };
  for (const face of faces) {
    add(face[0], face[1]);
    add(face[1], face[2]);
    add(face[2], face[0]);
  }
  return edges;
}

/**
 * Icosaèdre régulier inscrit dans la sphère unité : 12 sommets, 20 faces,
 * 30 arêtes. Les faces sont orientées dans le sens antihoraire vues de
 * l'extérieur, ce qui permet d'ordonner l'éventail des faces autour d'un
 * sommet lors du passage au dual.
 */
export function icosahedron(): Mesh {
  const t = (1 + Math.sqrt(5)) / 2;
  const raw: Vec3[] = [
    [-1, t, 0],
    [1, t, 0],
    [-1, -t, 0],
    [1, -t, 0],
    [0, -1, t],
    [0, 1, t],
    [0, -1, -t],
    [0, 1, -t],
    [t, 0, -1],
    [t, 0, 1],
    [-t, 0, -1],
    [-t, 0, 1],
  ];
  const faces: (readonly [number, number, number])[] = [
    [0, 11, 5],
    [0, 5, 1],
    [0, 1, 7],
    [0, 7, 10],
    [0, 10, 11],
    [1, 5, 9],
    [5, 11, 4],
    [11, 10, 2],
    [10, 7, 6],
    [7, 1, 8],
    [3, 9, 4],
    [3, 4, 2],
    [3, 2, 6],
    [3, 6, 8],
    [3, 8, 9],
    [4, 9, 5],
    [2, 4, 11],
    [6, 2, 10],
    [8, 6, 7],
    [9, 8, 1],
  ];
  return {
    positions: raw.map(normalize),
    faces,
    edges: buildEdges(faces),
  };
}

/**
 * Subdivise chaque triangle en quatre, en reprojetant les nouveaux sommets
 * sur la sphère. Les milieux d'arête sont mutualisés via une table indexée
 * par la paire de sommets (indices, pas coordonnées) : la déduplication est
 * donc exacte, sans tolérance flottante.
 */
export function subdivide(mesh: Mesh, n: number): Mesh {
  if (!Number.isInteger(n) || n < 0) {
    throw new RangeError("n doit être un entier >= 0");
  }
  let positions = mesh.positions.slice();
  let faces = mesh.faces.slice();

  for (let step = 0; step < n; step += 1) {
    const nextPositions: Vec3[] = positions.slice();
    const nextFaces: (readonly [number, number, number])[] = [];
    const midpoints = new Map<number, number>();

    const midpoint = (a: number, b: number): number => {
      const lo = a < b ? a : b;
      const hi = a < b ? b : a;
      const key = lo * 10_000_000 + hi;
      const cached = midpoints.get(key);
      if (cached !== undefined) {
        return cached;
      }
      const pa = positions[lo] as Vec3;
      const pb = positions[hi] as Vec3;
      const index = nextPositions.length;
      nextPositions.push(normalize([pa[0] + pb[0], pa[1] + pb[1], pa[2] + pb[2]]));
      midpoints.set(key, index);
      return index;
    };

    for (const face of faces) {
      const [a, b, c] = face;
      const ab = midpoint(a, b);
      const bc = midpoint(b, c);
      const ca = midpoint(c, a);
      // Même orientation que la face d'origine pour les quatre enfants.
      nextFaces.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]);
    }

    positions = nextPositions;
    faces = nextFaces;
  }

  return { positions, faces, edges: buildEdges(faces) };
}

/**
 * Passe au dual : une case par sommet de la géodésique.
 *
 * Pour chaque sommet `v`, on fait tourner chaque face incidente pour la
 * mettre sous la forme `(v, a, b)`. L'orientation antihoraire garantit que
 * `b` suit `a` dans la ronde autour de `v` : la table `a → (b, face)` est
 * donc un cycle qu'il suffit de parcourir pour obtenir les voisins ordonnés
 * et, en parallèle, les centres de faces qui forment le polygone. Le
 * parcours démarre au voisin d'indice le plus petit, pour que l'ordre soit
 * reproductible.
 */
export function buildTiles(mesh: Mesh): TileGeometry[] {
  const positions = mesh.positions;
  const faceCenters: Vec3[] = mesh.faces.map((face) => {
    const a = positions[face[0]] as Vec3;
    const b = positions[face[1]] as Vec3;
    const c = positions[face[2]] as Vec3;
    return normalize([a[0] + b[0] + c[0], a[1] + b[1] + c[1], a[2] + b[2] + c[2]]);
  });

  const incident: number[][] = Array.from({ length: positions.length }, () => []);
  for (let f = 0; f < mesh.faces.length; f += 1) {
    const face = mesh.faces[f] as readonly [number, number, number];
    (incident[face[0]] as number[]).push(f);
    (incident[face[1]] as number[]).push(f);
    (incident[face[2]] as number[]).push(f);
  }

  const tiles: TileGeometry[] = [];
  for (let v = 0; v < positions.length; v += 1) {
    const fan = incident[v] as number[];
    const nextNeighbor = new Map<number, number>();
    const faceOfNeighbor = new Map<number, number>();
    let smallest = Number.POSITIVE_INFINITY;

    for (const f of fan) {
      const face = mesh.faces[f] as readonly [number, number, number];
      let a: number;
      let b: number;
      if (face[0] === v) {
        a = face[1];
        b = face[2];
      } else if (face[1] === v) {
        a = face[2];
        b = face[0];
      } else {
        a = face[0];
        b = face[1];
      }
      nextNeighbor.set(a, b);
      faceOfNeighbor.set(a, f);
      if (a < smallest) {
        smallest = a;
      }
    }

    const neighbors: number[] = [];
    const polygon: Vec3[] = [];
    let current = smallest;
    for (let k = 0; k < nextNeighbor.size; k += 1) {
      const face = faceOfNeighbor.get(current);
      const next = nextNeighbor.get(current);
      if (face === undefined || next === undefined) {
        throw new Error(`éventail de faces incomplet autour du sommet ${v}`);
      }
      neighbors.push(current);
      polygon.push(faceCenters[face] as Vec3);
      current = next;
    }
    if (current !== smallest) {
      throw new Error(`éventail de faces non cyclique autour du sommet ${v}`);
    }

    const center = positions[v] as Vec3;
    const { lat, lon } = toLatLon(center);
    tiles.push({
      id: v,
      center,
      lat,
      lon,
      neighbors,
      polygon,
      area: sphericalPolygonArea(polygon),
    });
  }

  return tiles;
}

/**
 * Grille de cases du globe : icosaèdre, `subdivisions` subdivisions, puis
 * dual. Les identifiants de case sont stables pour un `subdivisions` donné
 * (ils ne dépendent d'aucun aléa), donc ils peuvent servir de clés
 * persistantes côté serveur monde.
 */
export function geodesicGrid(subdivisions: number): TileGeometry[] {
  assertSubdivisions(subdivisions);
  return buildTiles(subdivide(icosahedron(), subdivisions));
}

/**
 * Estimation analytique de l'angle entre deux cases voisines, en radians.
 * Chaque subdivision divise les arêtes en deux ; la distorsion de la
 * projection sur la sphère fait varier les arêtes réelles d'environ ±15 %
 * autour de cette valeur.
 */
export function estimatedTileAngle(subdivisions: number): number {
  assertSubdivisions(subdivisions);
  return ICOSAHEDRON_EDGE_ANGLE / 2 ** subdivisions;
}
