/**
 * Décide si la fondation d'une colonie neuve doit émettre le jour de l'année
 * hérité du monde (`docs/protocol.md` §11.6 « Le calendrier, hérité une
 * fois »). Fonction pure, isolée du Worker : elle ne connaît ni le WASM ni
 * `postMessage`, seulement ce que `sim.worker.ts` lui passe, donc testable
 * avec un encodeur factice — même schéma que `startClimate.ts`.
 *
 * Appelée une fois par sim adopté, juste après un `start`, avec le
 * `dayOfYear` déjà **consommé** (`LockstepClient.consumeStartDayOfYear`) :
 * deux appels successifs avec la même colonie ne redonnent jamais un jour non
 * nul, donc jamais deux émissions. Seul l'hôte émet : un non-hôte recevra la
 * commande dans un bundle, comme n'importe quel ordre du lockstep.
 */
export function setCalendarOnStart(
  isHost: boolean,
  dayOfYear: number | null,
  encodeSetCalendar: (dayOfYear: number) => Uint8Array,
): Uint8Array | null {
  return isHost && dayOfYear !== null ? encodeSetCalendar(dayOfYear) : null;
}
