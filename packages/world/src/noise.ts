/**
 * Bruit de valeur 3D et fBm, évalués sur des vecteurs de l'espace.
 *
 * Pourquoi de la 3D pour un globe : un bruit 2D en (latitude, longitude) a des
 * coutures — discontinuité au méridien 180° et pincement aux pôles. En
 * échantillonnant un bruit 3D sur les vecteurs unitaires des centres de cases,
 * le champ est continu partout sur la sphère, sans cas particulier.
 *
 * Aucune table globale mutable : la valeur d'un nœud du réseau est calculée à
 * la demande par une fonction de hachage des coordonnées entières et du seed.
 * Le bruit est donc réentrant, sans état, et n'a pas besoin d'initialisation.
 */

import { mix32 } from "./rng.js";

/** Taille de l'espace des entiers non signés sur 32 bits. */
const UINT32_RANGE = 4_294_967_296;

/** Facteur de fréquence entre deux octaves successives. */
export const FBM_LACUNARITY = 2;

/** Facteur d'amplitude entre deux octaves successives. */
export const FBM_GAIN = 0.5;

/**
 * Valeur pseudo-aléatoire dans [0, 1) attachée au nœud entier (ix, iy, iz) du
 * réseau, pour un seed donné. Purement entière sur 32 bits, donc identique
 * dans tous les moteurs JS.
 */
export function latticeValue(ix: number, iy: number, iz: number, seed: number): number {
  let h = mix32(seed);
  h = mix32((h ^ Math.imul(ix | 0, 0x27d4eb2f)) >>> 0);
  h = mix32((h ^ Math.imul(iy | 0, 0x165667b1)) >>> 0);
  h = mix32((h ^ Math.imul(iz | 0, 0x9e3779b1)) >>> 0);
  return h / UINT32_RANGE;
}

/**
 * Interpolation lissée (« smootherstep ») : dérivées première et seconde
 * nulles aux bornes, ce qui évite les arêtes visibles aux frontières des
 * cellules du réseau.
 */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/**
 * Bruit de valeur 3D dans [0, 1) : interpolation trilinéaire lissée entre les
 * huit sommets de la cellule du réseau contenant (x, y, z).
 */
export function valueNoise3(x: number, y: number, z: number, seed: number): number {
  const x0 = Math.floor(x);
  const y0 = Math.floor(y);
  const z0 = Math.floor(z);
  const tx = smootherstep(x - x0);
  const ty = smootherstep(y - y0);
  const tz = smootherstep(z - z0);
  const x1 = x0 + 1;
  const y1 = y0 + 1;
  const z1 = z0 + 1;

  const c000 = latticeValue(x0, y0, z0, seed);
  const c100 = latticeValue(x1, y0, z0, seed);
  const c010 = latticeValue(x0, y1, z0, seed);
  const c110 = latticeValue(x1, y1, z0, seed);
  const c001 = latticeValue(x0, y0, z1, seed);
  const c101 = latticeValue(x1, y0, z1, seed);
  const c011 = latticeValue(x0, y1, z1, seed);
  const c111 = latticeValue(x1, y1, z1, seed);

  const x00 = c000 + (c100 - c000) * tx;
  const x10 = c010 + (c110 - c010) * tx;
  const x01 = c001 + (c101 - c001) * tx;
  const x11 = c011 + (c111 - c011) * tx;
  const y0v = x00 + (x10 - x00) * ty;
  const y1v = x01 + (x11 - x01) * ty;
  return y0v + (y1v - y0v) * tz;
}

/**
 * Bruit fractal (somme d'octaves), normalisé dans [0, 1].
 *
 * Chaque octave double la fréquence et divise l'amplitude par deux ; la somme
 * est divisée par la somme des amplitudes, donc le résultat reste borné quel
 * que soit le nombre d'octaves. Chaque octave utilise un sous-seed dérivé, ce
 * qui évite qu'elles soient des copies homothétiques du même champ.
 */
export function fbm(x: number, y: number, z: number, octaves: number, seed: number): number {
  if (!Number.isInteger(octaves) || octaves < 1) {
    throw new RangeError("octaves doit être un entier >= 1");
  }
  let amplitude = 1;
  let frequency = 1;
  let sum = 0;
  let norm = 0;
  for (let octave = 0; octave < octaves; octave += 1) {
    const octaveSeed = mix32((seed ^ Math.imul(octave + 1, 0x85ebca6b)) >>> 0);
    sum += amplitude * valueNoise3(x * frequency, y * frequency, z * frequency, octaveSeed);
    norm += amplitude;
    amplitude *= FBM_GAIN;
    frequency *= FBM_LACUNARITY;
  }
  return sum / norm;
}
