/**
 * Encodage des commandes du joueur, sans les appliquer.
 *
 * Ce sont les octets postcard que le serveur relaie tels quels et que
 * `SimHandle.applyEncoded` relit chez chaque client. Solo comme multi passent
 * par ici : un seul chemin, donc pas de divergence entre les deux modes.
 *
 * Ces fonctions appellent des fonctions associées du WASM : elles supposent
 * l'init wasm-bindgen faite, c'est-à-dire un `SimHandle.create`/`restore`
 * déjà résolu. C'est toujours le cas dans l'application (on encode en
 * réaction à une action du joueur, donc bien après le chargement).
 */
import { WasmSim } from "../wasm/sim.js";

/** Commande vide, pour éprouver le lockstep sans gameplay. */
export function encodeNop(): Uint8Array {
  return WasmSim.encode_nop();
}

export function encodeMoveTo(pawn: number, x: number, y: number): Uint8Array {
  return WasmSim.encode_move_to(pawn, x, y);
}

/** `kind` suit `DESIGNATION` de `render/terrain.ts`. */
export function encodeDesignate(kind: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  return WasmSim.encode_designate(kind, x0, y0, x1, y1);
}

/** `zone` suit `ZONE` de `render/terrain.ts`. */
export function encodeSetZone(zone: number, x0: number, y0: number, x1: number, y1: number): Uint8Array {
  return WasmSim.encode_set_zone(zone, x0, y0, x1, y1);
}

/** `kind` suit `BUILD_KIND`, `material` suit `MATERIAL`. */
export function encodeBuild(
  kind: number,
  material: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): Uint8Array {
  return WasmSim.encode_build(kind, material, x0, y0, x1, y1);
}

export function encodeCancelBuild(x0: number, y0: number, x1: number, y1: number): Uint8Array {
  return WasmSim.encode_cancel_build(x0, y0, x1, y1);
}

export function encodeAttack(pawn: number, target: number): Uint8Array {
  return WasmSim.encode_attack(pawn, target);
}

/** Outil de dev : fait entrer un raid tout de suite. */
export function encodeTriggerRaid(): Uint8Array {
  return WasmSim.encode_trigger_raid();
}

/** `work` suit `sim::WorkType`, `priority` : 1 haute … 4 basse, 0 désactivé. */
export function encodeSetPriority(pawn: number, work: number, priority: number): Uint8Array {
  return WasmSim.encode_set_priority(pawn, work, priority);
}
