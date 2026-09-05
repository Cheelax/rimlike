import type { StartClimate } from "@rimlike/protocol";

/**
 * Décide si la fondation d'une colonie neuve doit émettre le climat hérité de
 * sa case du globe (`docs/protocol.md` §11.6 « Le climat, hérité une fois »).
 * Fonction pure, isolée du Worker : elle ne connaît ni le WASM ni
 * `postMessage`, seulement ce que `sim.worker.ts` lui passe, donc testable
 * avec un encodeur factice — même schéma que `fastForwardOnReopen`.
 *
 * Appelée une fois par sim adopté, juste après un `start`, avec le `climate`
 * déjà **consommé** (`LockstepClient.consumeStartClimate`) : deux appels
 * successifs avec la même colonie ne redonnent jamais un climat non nul, donc
 * jamais deux émissions. Seul l'hôte émet : un non-hôte recevra la commande
 * dans un bundle, comme n'importe quel ordre du lockstep.
 */
export function setClimateOnStart(
  isHost: boolean,
  climate: StartClimate | null,
  encodeSetClimate: (baseTemperature: number, amplitude: number) => Uint8Array,
): Uint8Array | null {
  return isHost && climate !== null ? encodeSetClimate(climate.baseTemperature, climate.amplitude) : null;
}
