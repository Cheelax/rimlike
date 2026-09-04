/**
 * Couche monde de la phase 4 : géométrie du globe, biomes et itinéraires.
 *
 * Le globe est un icosaèdre subdivisé dont on prend le **dual** : une case de
 * colonie par sommet, donc des hexagones et 12 pentagones. Le paquet ne fait
 * ni I/O ni rendu ; il fournit au serveur monde de quoi générer un globe à
 * partir d'un seed, calculer des itinéraires de caravane, et sérialiser le
 * tout vers le client. Zéro dépendance runtime, utilisable côté navigateur
 * comme côté Node.
 *
 * Voir `docs/world.md` pour le modèle, la calibration et les garanties de
 * déterminisme.
 */

export * from "./rng.js";
export * from "./noise.js";
export * from "./geometry.js";
export * from "./biomes.js";
export * from "./travel.js";
export * from "./serialize.js";
