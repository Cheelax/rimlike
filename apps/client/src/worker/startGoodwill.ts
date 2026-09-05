import type { GoodwillValues } from "@rimlike/protocol";

/**
 * Décide si l'ouverture d'une colonie doit émettre la réputation imposée par
 * le serveur monde (`docs/protocol.md` §14 « Réputation partagée »). Fonction
 * pure, isolée du Worker : elle ne connaît ni le WASM ni `postMessage`,
 * seulement ce que `sim.worker.ts` lui passe, donc testable avec un encodeur
 * factice — même schéma que `startClimate.ts`/`startCalendar.ts`/`fastForward.ts`.
 *
 * Contrairement à `climate`/`dayOfYear`, `goodwill` n'est **jamais** omis dans
 * une salle « case » : `undefined` (ou `null`) ne signifie donc ici qu'une
 * chose, « salle hors monde », jamais « rien à faire ».
 *
 * Appelée une fois par sim adopté, **après** `FastForward` (§14.1 : la
 * réputation imposée est déjà celle de l'instant présent, la faire revieillir
 * du temps gelé la compterait deux fois) et **avant** les marchands en
 * attente (leurs prix dépendent de la réputation de la Guilde), avec
 * `goodwill` déjà **consommé** (`LockstepClient.consumeGoodwill`) : deux
 * appels successifs avec la même colonie ne redonnent jamais une valeur non
 * nulle, donc jamais deux émissions. Seul l'hôte émet : un non-hôte recevra la
 * commande dans un bundle, comme n'importe quel ordre du lockstep.
 *
 * `goodwill` vient indifféremment de `start.goodwill` (colonie neuve) ou de
 * `snapshot.goodwill` (colonie gelée qui rouvre) : les deux chemins sont
 * mutuellement exclusifs (§11.6), jamais les deux à la fois pour une même
 * ouverture.
 */
export function goodwillCommands(
  goodwill: GoodwillValues | null | undefined,
  isHost: boolean,
  encodeSetGoodwill: (a: number, b: number, c: number) => Uint8Array,
): Uint8Array[] {
  if (!isHost || goodwill === null || goodwill === undefined) {
    return [];
  }
  return [encodeSetGoodwill(goodwill[0], goodwill[1], goodwill[2])];
}
