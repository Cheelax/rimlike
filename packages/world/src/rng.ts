/**
 * Générateur pseudo-aléatoire seedé, en arithmétique 32 bits.
 *
 * Toute source d'aléa du paquet passe par ici : `Math.random` est interdit,
 * sinon deux générations du même seed divergeraient. L'algorithme est
 * mulberry32 — un état de 32 bits, un pas par tirage, avalanche suffisante
 * pour de la génération de monde (ce n'est pas un générateur cryptographique).
 *
 * Toutes les opérations sont exprimées avec `Math.imul`, `^`, `>>>` : elles
 * sont exactes sur 32 bits dans tous les moteurs JS, donc la suite de valeurs
 * est identique partout (contrairement à `Math.sin`/`Math.cos`, voir
 * `docs/world.md`).
 */

/** Taille de l'espace des entiers non signés sur 32 bits. */
const UINT32_RANGE = 4_294_967_296;

/** Interface minimale d'un flux aléatoire seedé. */
export interface Rng {
  /** Prochain flottant dans [0, 1). */
  next(): number;
  /** Prochain entier dans [0, `bound`), `bound` entier >= 1. */
  int(bound: number): number;
  /** Élément tiré uniformément dans un tableau non vide. */
  pick<T>(values: readonly T[]): T;
}

/**
 * Mélange d'avalanche 32 bits (variante de `lowbias32`). Sert à dériver des
 * sous-seeds indépendants d'un seed maître sans corrélation visible.
 */
export function mix32(value: number): number {
  let x = value >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return x >>> 0;
}

/**
 * Dérive un sous-seed d'un seed maître et d'un « sel » (une constante par
 * sous-système : élévation, humidité, température…). Deux sels distincts
 * donnent des champs de bruit décorrélés à partir du même seed de monde.
 */
export function deriveSeed(seed: number, salt: number): number {
  return mix32((mix32(seed) ^ Math.imul(salt | 0, 0x9e3779b1)) >>> 0);
}

/**
 * Crée un flux aléatoire déterministe. Deux appels avec le même seed donnent
 * exactement la même suite de valeurs.
 */
export function createRng(seed: number): Rng {
  let state = (seed | 0) >>> 0;

  const next = (): number => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1) >>> 0;
    t = (t ^ (t + Math.imul(t ^ (t >>> 7), t | 61))) >>> 0;
    return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
  };

  const int = (bound: number): number => {
    if (!Number.isInteger(bound) || bound < 1) {
      throw new RangeError("bound doit être un entier >= 1");
    }
    return Math.floor(next() * bound);
  };

  const pick = <T,>(values: readonly T[]): T => {
    if (values.length === 0) {
      throw new RangeError("pick sur un tableau vide");
    }
    return values[int(values.length)] as T;
  };

  return { next, int, pick };
}
