/**
 * Décide si la réouverture d'une colonie gelée doit émettre l'avance rapide
 * (`docs/protocol.md` §11.6). Fonction pure, isolée du Worker : elle ne
 * connaît ni le WASM ni `postMessage`, seulement ce que `sim.worker.ts` lui
 * passe, donc testable avec un encodeur factice.
 *
 * Appelée une fois par sim adopté, juste après une `snapshot`, avec le
 * `frozenTicks` déjà **consommé** (`LockstepClient.consumeFrozenTicks`) : deux
 * appels successifs avec la même colonie ne redonnent jamais `frozenTicks` > 0,
 * donc jamais deux émissions. Seul l'hôte émet : un non-hôte recevra la
 * commande dans un bundle, comme n'importe quel ordre du lockstep.
 */
export function fastForwardOnReopen(
  isHost: boolean,
  frozenTicks: number,
  encodeFastForward: (ticks: number) => Uint8Array,
): Uint8Array | null {
  return isHost && frozenTicks > 0 ? encodeFastForward(frozenTicks) : null;
}
