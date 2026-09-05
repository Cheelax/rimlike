import { MAX_PENDING_TRADERS } from "@rimlike/protocol";

/**
 * Décide combien de `Command::TriggerTraderVisit` émettre à l'ouverture d'une
 * colonie, pour rattraper les marchands arrivés pendant qu'elle était fermée
 * (`docs/protocol.md` §13.5 « Colonie fermée : pendingTraders »). Fonction
 * pure, isolée du Worker : elle ne connaît ni le WASM ni `postMessage`,
 * seulement ce que `sim.worker.ts` lui passe — même schéma que
 * `startClimate.ts`/`startCalendar.ts`/`fastForward.ts`, à ceci près qu'un seul
 * champ peut demander **plusieurs** commandes (0 à `MAX_PENDING_TRADERS`)
 * plutôt qu'au plus une : la fonction renvoie donc un tableau, pas un
 * `Uint8Array | null`.
 *
 * Appelée une fois par sim adopté, **après** `FastForward` (§13.5 : « les
 * marchands en dernier, une visite se jouant dans le présent de la colonie, pas
 * dans le temps qu'elle vient de rattraper »), avec `pendingTraders` déjà
 * **consommé** (`LockstepClient.consumePendingTraders`) : deux appels
 * successifs avec la même colonie ne redonnent jamais une valeur non nulle,
 * donc jamais de double émission. Seul l'hôte émet : un non-hôte recevra les
 * commandes dans un bundle, comme n'importe quel ordre du lockstep.
 *
 * `pendingTraders` vient indifféremment de `start.pendingTraders` (colonie
 * neuve) ou de `snapshot.pendingTraders` (colonie gelée qui rouvre) : les deux
 * chemins sont mutuellement exclusifs (§13.5), jamais additionnés côté serveur
 * — cette fonction n'a donc jamais à en combiner deux.
 *
 * La borne à `MAX_PENDING_TRADERS` est une défense en profondeur : le codec du
 * protocole la vérifie déjà à la réception, mais une valeur qui la dépasserait
 * ici ne doit pas se traduire par une rafale de commandes.
 */
export function pendingTraderCommands(
  pendingTraders: number | undefined,
  isHost: boolean,
  encodeTriggerTraderVisit: () => Uint8Array,
): Uint8Array[] {
  if (!isHost) {
    return [];
  }
  const count = Math.min(MAX_PENDING_TRADERS, Math.max(0, pendingTraders ?? 0));
  return Array.from({ length: count }, () => encodeTriggerTraderVisit());
}
