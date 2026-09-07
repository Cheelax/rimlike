/** Guide de lecture du frame : aucune commande ni règle de simulation. */
import { ANIMAL_STRIDE, BLUEPRINT_STRIDE, BUILD_KIND, DESIGNATION, FACTION, FEATURE, ZONE } from "./render/terrain";
import type { Tool } from "./tools";
import type { FrameMessage, MapMessage, OverlaysMessage } from "./worker/protocol";

export type FirstStepsFrame = Pick<FrameMessage, "stored" | "blueprints" | "pawns" | "animals" | "craftTargets">;
export type FirstStepsMapLayers = Pick<MapMessage, "features"> & Pick<OverlaysMessage, "zones" | "designations">;
export type FirstStepId = "stockpile" | "chop" | "campfire" | "beds" | "growing" | "bow" | "enclosure";
export interface FirstStep {
  readonly id: FirstStepId;
  readonly title: string;
  readonly instruction: string;
  readonly tools: readonly Tool[];
  readonly craft?: boolean;
  readonly isComplete: (frame: FirstStepsFrame, layers: FirstStepsMapLayers) => boolean;
}

/** Contrat `sim-wasm::PAWN_STRIDE`, sans importer le moteur de rendu Three.js. */
const PAWN_STRIDE = 12;
const WOOD = 0;
const BOW = 8;

function buildings(frame: FirstStepsFrame, layers: FirstStepsMapLayers, kind: number, features: readonly number[]): number {
  let count = 0;
  for (const feature of layers.features) if (features.includes(feature)) count++;
  // [id, genre, matériau, x, y, livré, coût, avancement]. Les plans devenus
  // bâtiments disparaissent du tampon dans le même envoi de carte/frame.
  for (let o = 0; o + BLUEPRINT_STRIDE <= frame.blueprints.length; o += BLUEPRINT_STRIDE) {
    if (frame.blueprints[o + 1] === kind) count++;
  }
  return count;
}

function colonists(frame: FirstStepsFrame): number {
  const animals = new Set<number>();
  for (let o = 0; o + ANIMAL_STRIDE <= frame.animals.length; o += ANIMAL_STRIDE) animals.add(frame.animals[o]);
  let count = 0;
  for (let o = 0; o + PAWN_STRIDE <= frame.pawns.length; o += PAWN_STRIDE) {
    if (frame.pawns[o + 10] === FACTION.Colony && !animals.has(frame.pawns[o])) count++;
  }
  return count;
}

export const FIRST_STEPS: readonly FirstStep[] = [
  {
    id: "stockpile", title: "Tracer un stockage",
    instruction: "Tracez une petite zone de stockage près des colons pour y rassembler les ressources.",
    tools: ["stockpile"],
    isComplete: (_, layers) => layers.zones.includes(ZONE.Stockpile),
  },
  {
    id: "chop", title: "Couper des arbres",
    instruction: "Glissez un rectangle sur quelques arbres voisins pour obtenir du bois.",
    tools: ["chop"],
    isComplete: (frame, layers) => frame.stored[WOOD] > 0 || layers.designations.includes(DESIGNATION.Chop),
  },
  {
    id: "campfire", title: "Poser un feu de camp",
    instruction: "Posez un feu de camp sur une case dégagée pour cuisiner et vous réchauffer.",
    tools: ["campfire"],
    isComplete: (frame, layers) => buildings(frame, layers, BUILD_KIND.Campfire, [FEATURE.Campfire]) > 0,
  },
  {
    id: "beds", title: "Un lit par colon",
    instruction: "Posez un lit pour chaque colon afin que tous puissent dormir confortablement.",
    tools: ["bed"],
    isComplete: (frame, layers) => {
      const count = colonists(frame);
      return count > 0 && buildings(frame, layers, BUILD_KIND.Bed, [FEATURE.Bed]) >= count;
    },
  },
  {
    id: "growing", title: "Cultiver",
    instruction: "Tracez une zone de culture sur l’herbe ou la terre pour préparer vos prochaines récoltes.",
    tools: ["growing"],
    isComplete: (_, layers) => layers.zones.includes(ZONE.Growing),
  },
  {
    id: "bow", title: "Préparer un arc",
    instruction: "Construisez un poste de fabrication, puis réglez l’objectif d’arcs à au moins un pour préparer la défense.",
    tools: ["craftingSpot"], craft: true,
    isComplete: (frame, layers) => layers.features.includes(FEATURE.CraftingSpot) && frame.craftTargets[BOW] > 0,
  },
  {
    id: "enclosure", title: "Une enceinte avec porte",
    instruction: "Entourez votre camp d’au moins vingt murs en ménageant une porte pour les passages.",
    tools: ["wall", "door"],
    isComplete: (frame, layers) => buildings(frame, layers, BUILD_KIND.Wall, [FEATURE.WallWood, FEATURE.WallStone]) >= 20
      && buildings(frame, layers, BUILD_KIND.Door, [FEATURE.DoorWood, FEATURE.DoorStone]) > 0,
  },
];

/** Première condition non remplie, dans l'ordre. Les coches de la session
 * peuvent être fournies pour ne pas revenir en arrière quand le bois est consommé. */
export function nextStep(frame: FirstStepsFrame, mapLayers: FirstStepsMapLayers, completed: readonly FirstStepId[] = []): FirstStep | null {
  return FIRST_STEPS.find((step) => !completed.includes(step.id) && !step.isComplete(frame, mapLayers)) ?? null;
}

export type FirstStepsStatus = "terminé" | "masqué" | null;
const STORAGE_KEY = "rimlike.firststeps.v1";

/** Valeur inconnue, corrompue ou stockage bloqué : le guide reste disponible. */
export function loadFirstSteps(): FirstStepsStatus {
  try {
    const status = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? "null") as unknown;
    return status === "terminé" || status === "masqué" ? status : null;
  } catch {
    return null;
  }
}

/** `null` réactive le guide depuis Options, y compris après sa conclusion. */
export function saveFirstSteps(status: FirstStepsStatus): void {
  try {
    if (status === null) localStorage.removeItem(STORAGE_KEY);
    else localStorage.setItem(STORAGE_KEY, JSON.stringify(status));
  } catch {
    /* stockage indisponible : le choix reste valable pour cette session */
  }
}
