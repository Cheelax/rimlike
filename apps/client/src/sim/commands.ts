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

/**
 * Départ d'une caravane : les colons quittent la carte et leur manifeste entre
 * dans la file des départs du sim (`docs/protocol.md` §12.7).
 *
 * `itemKinds` suit `sim::ItemKind` (l'index de `ITEM_NAMES` de `terrain.ts`),
 * apparié avec `itemCounts` dans l'ordre. La destination, elle, n'est pas dans
 * la commande : le voyage appartient au serveur monde, le sim ne connaît que
 * les deux bouts.
 */
export function encodeFormCaravan(
  pawnIds: readonly number[],
  itemKinds: readonly number[],
  itemCounts: readonly number[],
): Uint8Array {
  return WasmSim.encode_form_caravan(
    Uint32Array.from(pawnIds),
    Uint8Array.from(itemKinds),
    Uint32Array.from(itemCounts),
  );
}

/**
 * Vidange des `count` premiers manifestes de la file des départs, à émettre
 * une fois qu'ils sont partis chez le serveur monde. **Commande lockstep** :
 * la lecture de la file est locale mais son vidage doit se faire au même tick
 * chez tout le monde, sinon les sims divergent (`docs/protocol.md` §12.7).
 */
export function encodeClearDepartures(count: number): Uint8Array {
  return WasmSim.encode_clear_departures(count);
}

/** Arrivée d'une caravane : le manifeste voyage **dans** la commande. */
export function encodeArriveCaravan(manifest: Uint8Array): Uint8Array {
  return WasmSim.encode_arrive_caravan(manifest);
}

/**
 * Avance rapide abstraite d'une colonie gelée (`docs/protocol.md` §11.6).
 * `ticks` est le `frozenTicks` du `snapshot` : à n'émettre qu'une fois, par
 * l'hôte, en première commande après la réouverture (voir `worker/sim.worker.ts`
 * et `LockstepClient.consumeFrozenTicks`).
 */
export function encodeFastForward(ticks: number): Uint8Array {
  return WasmSim.encode_fast_forward(ticks);
}

/**
 * Objectif de fabrication d'une arme. `kind` suit `sim::ItemKind` (6 gourdin,
 * 7 épieu, 8 arc) ; un genre sans recette est ignoré par le sim. `target` n'a
 * pas de borne côté sim, mais le panneau Fabrication le contient à 0..20
 * (`render/terrain.ts::clampCraftTarget`).
 */
export function encodeSetCraftTarget(kind: number, target: number): Uint8Array {
  return WasmSim.encode_set_craft_target(kind, target);
}

/**
 * Marque (`on`) ou démarque un animal comme gibier (`sim::Command::Hunt`). La
 * chasse se désigne par bête, pas par rectangle : `animal` est l'id lu dans
 * le tampon `animals` (voir `render/terrain.ts::ANIMAL_STRIDE`).
 */
export function encodeHunt(animal: number, on: boolean): Uint8Array {
  return WasmSim.encode_hunt(animal, on);
}

/**
 * Climat hérité de la case du globe à la fondation d'une colonie neuve
 * (`docs/protocol.md` §11.6 « Le climat, hérité une fois »).
 * `baseTemperature`/`amplitude` viennent de `ServerStartMessage.climate`
 * (dixièmes de °C, `@rimlike/protocol`) : à n'émettre qu'une fois, par
 * l'hôte, en première commande après le `start` (voir `worker/sim.worker.ts`,
 * `worker/startClimate.ts` et `LockstepClient.consumeStartClimate`).
 */
export function encodeSetClimate(baseTemperature: number, amplitude: number): Uint8Array {
  return WasmSim.encode_set_climate(baseTemperature, amplitude);
}
