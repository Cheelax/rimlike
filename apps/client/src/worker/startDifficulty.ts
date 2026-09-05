import { DIFFICULTY } from "../render/terrain";

/**
 * Décide si le sim neuf doit recevoir la dose de menace choisie par l'hôte,
 * juste après le climat hérité de la case (`worker/startClimate.ts`) — même
 * schéma : fonction pure, isolée du Worker, testable avec un encodeur factice.
 *
 * Contrairement au climat, la difficulté ne vient jamais du réseau : elle
 * n'existe que côté client, mémorisée par `LockstepClient.startGame` au
 * moment où l'hôte clique « Démarrer », puis lue une seule fois par
 * `consumeStartDifficulty` dès que son propre sim est adopté. Un non-hôte
 * n'appelle jamais `startGame` : `difficulty` lui arrive toujours `null`.
 *
 * Normal (`DIFFICULTY.Normal`) n'émet rien non plus, même choisi explicitement
 * par l'hôte : c'est déjà la valeur par défaut du sim
 * (`sim::storyteller::Difficulty::default`), une commande de plus ne
 * changerait rien à l'état.
 */
export function setDifficultyOnStart(
  isHost: boolean,
  difficulty: number | null,
  encodeSetDifficulty: (level: number) => Uint8Array,
): Uint8Array | null {
  return isHost && difficulty !== null && difficulty !== DIFFICULTY.Normal
    ? encodeSetDifficulty(difficulty)
    : null;
}
