/**
 * Ce que la couche réseau attend d'un sim : le strict nécessaire au lockstep.
 *
 * `SimHandle` l'implémente pour de vrai. Les tests branchent un faux sim
 * déterministe, ce qui permet d'éprouver le lockstep sans WASM ni rendu.
 */
export interface SimLike {
  /** Nombre de ticks déjà appliqués, donc prochain tick à exécuter. */
  tick(): number;
  /** Avance de `n` ticks. En lockstep, toujours `step(1)` par tick. */
  step(n: number): void;
  /** Met en attente une commande encodée ; appliquée au prochain `step`. */
  applyEncoded(bytes: Uint8Array): void;
  /** Hash d'état, comparé par le serveur pour détecter une désync. */
  hash(): string;
  /** État complet, pour le joueur qui rejoint en cours. */
  snapshot(): Uint8Array;
}

/** Fabrique un sim neuf quand la partie démarre. */
export type CreateSim = (seed: number, width: number, height: number) => Promise<SimLike>;

/** Rebâtit un sim depuis le snapshot du host (rejoint en cours). */
export type RestoreSim = (bytes: Uint8Array) => Promise<SimLike>;
