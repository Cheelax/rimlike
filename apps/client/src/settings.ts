/**
 * Réglages graphiques du menu Options : mémorisés dans `localStorage`, relus
 * au démarrage. Module pur, sans DOM ni Three.js — comme le repli de
 * `Minimap.tsx`, lecture et écriture sont protégées par try/catch (mode
 * privé, quota dépassé) et retombent silencieusement sur le défaut.
 *
 * Trois réglages, trois façons de s'appliquer (voir `AGENTS.md` et
 * `render/gl.ts`) :
 * - `pixelRatio` : à la volée, `gl.ts::setPixelRatio`.
 * - `propDensity` : à la volée, `Renderer.setPropDensity` (reconstruit les
 *   meshes de la carte, comme un changement de `map_version`).
 * - `shadows` : lu une seule fois par `acquireGl`, avant la création du
 *   renderer — basculer `shadowMap.enabled` en cours de route oblige
 *   Three.js à recompiler tous les matériaux (voir l'en-tête de `gl.ts`).
 */

export interface GraphicsSettings {
  /** `"auto"` = `effectivePixelRatio` plafonne au rapport de l'écran (max 2). */
  pixelRatio: "auto" | 1 | 1.5 | 2;
  /** Densité des props naturalistes non porteurs de sens (voir `Renderer.setPropDensity`). */
  propDensity: "haute" | "moyenne" | "basse";
  /** Ombres portées (`shadowMap.enabled`), lu au démarrage seulement. */
  shadows: boolean;
}

export const DEFAULT_GRAPHICS: GraphicsSettings = {
  pixelRatio: "auto",
  propDensity: "haute",
  shadows: true,
};

const KEY = "rimlike.graphics.v1";

function isPixelRatio(value: unknown): value is GraphicsSettings["pixelRatio"] {
  return value === "auto" || value === 1 || value === 1.5 || value === 2;
}

function isPropDensity(value: unknown): value is GraphicsSettings["propDensity"] {
  return value === "haute" || value === "moyenne" || value === "basse";
}

/**
 * Relit les réglages, valeurs inconnues ramenées au défaut champ par champ
 * (un seul réglage corrompu ne doit pas faire perdre les deux autres).
 * `localStorage` indisponible ou JSON invalide : le défaut complet.
 */
export function loadGraphics(): GraphicsSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return { ...DEFAULT_GRAPHICS };
    const parsed = JSON.parse(raw) as Partial<Record<keyof GraphicsSettings, unknown>>;
    return {
      pixelRatio: isPixelRatio(parsed.pixelRatio) ? parsed.pixelRatio : DEFAULT_GRAPHICS.pixelRatio,
      propDensity: isPropDensity(parsed.propDensity) ? parsed.propDensity : DEFAULT_GRAPHICS.propDensity,
      shadows: typeof parsed.shadows === "boolean" ? parsed.shadows : DEFAULT_GRAPHICS.shadows,
    };
  } catch {
    return { ...DEFAULT_GRAPHICS };
  }
}

export function saveGraphics(settings: GraphicsSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* stockage indisponible : le réglage ne survit pas au rechargement */
  }
}

/** `"auto"` plafonne à 2 (`gl.ts::MAX_PIXEL_RATIO`) : au-delà, du remplissage payé pour rien. */
export function effectivePixelRatio(setting: GraphicsSettings["pixelRatio"], devicePixelRatio: number): number {
  return setting === "auto" ? Math.min(devicePixelRatio, 2) : setting;
}
