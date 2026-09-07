/**
 * Pause automatique du menu Options : quand un événement grave du sim
 * survient (raid, colon à terre, incendie…), la partie se met en pause
 * toute seule, comme un appui sur `Espace`. Module pur, sans DOM ni sim —
 * comme `eventFocus.ts` — et sans React : `App.tsx` appelle `shouldAutoPause`
 * au moment de traiter chaque événement (`notifyEvents`) et déclenche la
 * pause existante (`bridge.setPaused`) lui-même.
 *
 * `AUTO_PAUSE_EVENTS` est la source unique des genres concernés, de leur
 * libellé dans Options et de leur valeur par défaut — comme `SHORTCUTS` est
 * bâti sur `TOOLS` (`shortcuts.ts`) : jamais recopié à la main, pour que le
 * panneau Options ne puisse pas diverger de la liste réellement surveillée.
 * `AutoPauseSettings.events` indexe donc par `kind` plutôt que par des champs
 * nommés, pour la même raison.
 *
 * Solo seulement : `shouldAutoPause` renvoie toujours faux en multijoueur
 * (l'horloge du serveur ne s'arrête jamais, voir AGENTS.md « Conventions
 * côté client »), c'est le module qui l'impose, pas seulement le panneau
 * Options qui grise ses cases.
 */

/** Un genre d'événement du sim (`sim::EventKind`, voir AGENTS.md) surveillé par la pause automatique. */
export interface AutoPauseEvent {
  /** `sim::EventKind` : 21 raid annoncé, 1 raid, 8 colon à terre, 36 incendie déclaré, 26 marchand arrivé. */
  kind: number;
  /** Libellé affiché devant la case à cocher, dans Options → Pause automatique. */
  label: string;
  /** Coché par défaut au premier lancement (avant toute sauvegarde locale). */
  defaultOn: boolean;
}

/**
 * Raid annoncé, raid, colon à terre et incendie sont activés par défaut : ce
 * sont les alertes qui demandent une décision immédiate. Le marchand est
 * désactivé par défaut : sa visite n'est jamais urgente, une pause à chaque
 * fois serait plus gênante qu'utile.
 */
export const AUTO_PAUSE_EVENTS: readonly AutoPauseEvent[] = [
  { kind: 21, label: "Raid annoncé", defaultOn: true },
  { kind: 1, label: "Raid", defaultOn: true },
  { kind: 8, label: "Colon à terre", defaultOn: true },
  { kind: 36, label: "Incendie déclaré", defaultOn: true },
  { kind: 26, label: "Marchand arrivé", defaultOn: false },
];

export interface AutoPauseSettings {
  /** Interrupteur général : aucune pause automatique s'il est faux, quelles que soient les cases cochées ci-dessous. */
  enabled: boolean;
  /** Un booléen par genre d'`AUTO_PAUSE_EVENTS`, indexé par `kind` (clé JSON en chaîne à la relecture). */
  events: Record<number, boolean>;
}

export const DEFAULT_AUTO_PAUSE: AutoPauseSettings = {
  enabled: true,
  events: Object.fromEntries(AUTO_PAUSE_EVENTS.map((e) => [e.kind, e.defaultOn])),
};

const KEY = "rimlike.autopause.v1";

function cloneDefault(): AutoPauseSettings {
  return { enabled: DEFAULT_AUTO_PAUSE.enabled, events: { ...DEFAULT_AUTO_PAUSE.events } };
}

/**
 * Relit les réglages, valeurs inconnues ramenées au défaut champ par champ —
 * même patron que `settings.ts::loadGraphics` — puis un booléen par genre
 * connu d'`AUTO_PAUSE_EVENTS` : un genre absent ou corrompu retombe sur son
 * propre `defaultOn`, sans faire perdre les autres. `localStorage`
 * indisponible ou JSON invalide : le défaut complet.
 */
export function loadAutoPause(): AutoPauseSettings {
  try {
    const raw = localStorage.getItem(KEY);
    if (raw === null) return cloneDefault();
    const parsed = JSON.parse(raw) as Partial<{ enabled: unknown; events: unknown }>;
    const rawEvents =
      parsed.events !== null && typeof parsed.events === "object" ? (parsed.events as Record<string, unknown>) : {};
    const events: Record<number, boolean> = {};
    for (const def of AUTO_PAUSE_EVENTS) {
      const v = rawEvents[String(def.kind)];
      events[def.kind] = typeof v === "boolean" ? v : def.defaultOn;
    }
    return {
      enabled: typeof parsed.enabled === "boolean" ? parsed.enabled : DEFAULT_AUTO_PAUSE.enabled,
      events,
    };
  } catch {
    return cloneDefault();
  }
}

export function saveAutoPause(settings: AutoPauseSettings): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(settings));
  } catch {
    /* stockage indisponible : le réglage ne survit pas au rechargement */
  }
}

/**
 * Faut-il mettre la partie en pause pour cet événement ? Jamais en multi
 * (`isMulti`), jamais si l'interrupteur général est coupé, sinon la case du
 * genre concerné — absente d'`AUTO_PAUSE_EVENTS` (genre non surveillé) :
 * toujours faux.
 */
export function shouldAutoPause(kind: number, settings: AutoPauseSettings, isMulti: boolean): boolean {
  if (isMulti || !settings.enabled) return false;
  return settings.events[kind] === true;
}
