import { afterEach, describe, expect, it, vi } from "vitest";
import { FIRST_STEPS, loadFirstSteps, nextStep, saveFirstSteps, type FirstStepId, type FirstStepsFrame, type FirstStepsMapLayers } from "../src/firstSteps";
import { ANIMAL_STRIDE, BLUEPRINT_STRIDE, BUILD_KIND, DESIGNATION, FACTION, FEATURE, ZONE } from "../src/render/terrain";
import { PAWN_STRIDE } from "../src/render/Renderer";
import { TOOLS } from "../src/tools";

function pawn(id: number, faction: number = FACTION.Colony): number[] {
  const row = Array<number>(PAWN_STRIDE).fill(0);
  row[0] = id;
  row[10] = faction;
  return row;
}
function plans(...kinds: number[]): Int32Array {
  return Int32Array.from(kinds.flatMap((kind, i) => {
    const row = Array<number>(BLUEPRINT_STRIDE).fill(0);
    row[0] = i + 1;
    row[1] = kind;
    row[3] = i;
    return row;
  }));
}
function fixture(): { frame: FirstStepsFrame; layers: FirstStepsMapLayers } {
  return {
    frame: { stored: new Uint32Array(19), craftTargets: new Uint32Array(19), blueprints: new Int32Array(), pawns: Int32Array.from([...pawn(1), ...pawn(2), ...pawn(3)]), animals: new Int32Array() },
    layers: { features: new Uint8Array(64), zones: new Uint8Array(64), designations: new Uint8Array(64) },
  };
}
function complete(id: FirstStepId, frame: FirstStepsFrame, layers: FirstStepsMapLayers): boolean {
  return FIRST_STEPS.find((step) => step.id === id)!.isComplete(frame, layers);
}

describe("conditions des premiers pas", () => {
  it("présente sept étapes dans l'ordre prévu et commence par le stockage", () => {
    const { frame, layers } = fixture();
    expect(FIRST_STEPS.map((step) => step.id)).toEqual(["stockpile", "chop", "campfire", "beds", "growing", "bow", "enclosure"]);
    expect(nextStep(frame, layers)?.id).toBe("stockpile");
    for (const step of FIRST_STEPS) {
      expect(step.title.trim()).not.toBe("");
      expect(step.instruction.trim()).not.toBe("");
      expect(step.isComplete(frame, layers)).toBe(false);
      for (const id of step.tools) expect(TOOLS.some((tool) => tool.id === id)).toBe(true);
    }
  });
  it("demande une zone de stockage, pas une culture ni du bois", () => {
    const { frame, layers } = fixture();
    frame.stored[0] = 12;
    layers.zones[0] = ZONE.Growing;
    expect(complete("stockpile", frame, layers)).toBe(false);
    layers.zones[1] = ZONE.Stockpile;
    expect(nextStep(frame, layers)?.id).toBe("campfire");
  });
  it("passe du stockage à la coupe dès qu'une seule case est tracée", () => {
    const { frame, layers } = fixture();
    layers.zones[63] = ZONE.Stockpile;
    expect(nextStep(frame, layers)?.id).toBe("chop");
  });
  it("valide une désignation de coupe, mais pas de minage ou de récolte", () => {
    const { frame, layers } = fixture();
    layers.designations.set([DESIGNATION.Mine, DESIGNATION.Harvest]);
    expect(complete("chop", frame, layers)).toBe(false);
    layers.designations[63] = DESIGNATION.Chop;
    expect(complete("chop", frame, layers)).toBe(true);
  });
  it("valide du bois en stock, mais pas une autre ressource", () => {
    const { frame, layers } = fixture();
    frame.stored[1] = 100;
    expect(complete("chop", frame, layers)).toBe(false);
    frame.stored[0] = 1;
    expect(complete("chop", frame, layers)).toBe(true);
  });
  it("valide le plan d'un feu de camp puis son bâtiment", () => {
    const { frame, layers } = fixture();
    expect(complete("campfire", { ...frame, blueprints: plans(BUILD_KIND.Bed) }, layers)).toBe(false);
    expect(complete("campfire", { ...frame, blueprints: plans(BUILD_KIND.Campfire) }, layers)).toBe(true);
    layers.features[0] = FEATURE.Campfire;
    expect(complete("campfire", frame, layers)).toBe(true);
  });
  it("additionne lits construits et plans jusqu'au nombre de colons", () => {
    const { frame, layers } = fixture();
    layers.features[0] = FEATURE.Bed;
    expect(complete("beds", { ...frame, blueprints: plans(BUILD_KIND.Bed) }, layers)).toBe(false);
    expect(complete("beds", { ...frame, blueprints: plans(BUILD_KIND.Bed, BUILD_KIND.Bed) }, layers)).toBe(true);
  });
  it("ne demande pas de lit pour le bétail, les animaux, les pillards ou les marchands", () => {
    const { frame, layers } = fixture();
    const animals = new Int32Array(ANIMAL_STRIDE * 2);
    animals[0] = 4;
    animals[ANIMAL_STRIDE] = 5;
    const mixed = { ...frame, pawns: Int32Array.from([...frame.pawns, ...pawn(4), ...pawn(5, FACTION.Animal), ...pawn(6, FACTION.Raider), ...pawn(7, FACTION.Trader)]), animals, blueprints: plans(BUILD_KIND.Bed, BUILD_KIND.Bed, BUILD_KIND.Bed) };
    expect(complete("beds", mixed, layers)).toBe(true);
    expect(complete("beds", { ...mixed, pawns: Int32Array.from([...mixed.pawns, ...pawn(8)]) }, layers)).toBe(false);
  });
  it("ne valide pas les lits quand il n'y a plus de colon", () => {
    const { frame, layers } = fixture();
    expect(complete("beds", { ...frame, pawns: new Int32Array() }, layers)).toBe(false);
  });
  it("demande une zone de culture, pas seulement une plante", () => {
    const { frame, layers } = fixture();
    layers.features[0] = FEATURE.Crop;
    layers.zones[0] = ZONE.Stockpile;
    expect(complete("growing", frame, layers)).toBe(false);
    layers.zones[1] = ZONE.Growing;
    expect(complete("growing", frame, layers)).toBe(true);
  });
  it("demande à la fois un poste construit et un objectif d'arcs positif", () => {
    const { frame, layers } = fixture();
    frame.craftTargets[8] = 1;
    expect(complete("bow", { ...frame, blueprints: plans(BUILD_KIND.CraftingSpot) }, layers)).toBe(false);
    layers.features[0] = FEATURE.CraftingSpot;
    expect(complete("bow", frame, layers)).toBe(true);
    frame.craftTargets[8] = 0;
    frame.craftTargets[6] = 1;
    expect(complete("bow", frame, layers)).toBe(false);
  });
  it("exige vingt murs et une porte, en plans ou construits et de tout matériau", () => {
    const { frame, layers } = fixture();
    layers.features.fill(FEATURE.WallWood, 0, 10);
    layers.features.fill(FEATURE.WallStone, 10, 19);
    layers.features[20] = FEATURE.DoorStone;
    expect(complete("enclosure", frame, layers)).toBe(false);
    const plannedWall = { ...frame, blueprints: plans(BUILD_KIND.Wall) };
    expect(complete("enclosure", plannedWall, layers)).toBe(true);
    layers.features[20] = FEATURE.None;
    expect(complete("enclosure", plannedWall, layers)).toBe(false);
    expect(complete("enclosure", { ...frame, blueprints: plans(BUILD_KIND.Wall, BUILD_KIND.Door) }, layers)).toBe(true);
    layers.features[20] = FEATURE.DoorWood;
    expect(complete("enclosure", plannedWall, layers)).toBe(true);
  });
  it("revient à null quand toutes les conditions sont remplies, sans muter le frame", () => {
    const { frame, layers } = fixture();
    layers.zones.set([ZONE.Stockpile, ZONE.Growing]);
    layers.designations[0] = DESIGNATION.Chop;
    layers.features.set([FEATURE.Campfire, FEATURE.Bed, FEATURE.Bed, FEATURE.Bed, FEATURE.CraftingSpot, FEATURE.DoorWood]);
    layers.features.fill(FEATURE.WallStone, 6, 26);
    frame.craftTargets[8] = 1;
    const before = structuredClone({ frame, layers });
    expect(nextStep(frame, layers)).toBeNull();
    expect({ frame, layers }).toEqual(before);
  });
  it("garde les coches de session quand une désignation ou un stock disparaît", () => {
    const { frame, layers } = fixture();
    expect(nextStep(frame, layers, ["stockpile", "chop"])?.id).toBe("campfire");
    expect(nextStep(frame, layers, FIRST_STEPS.map((step) => step.id))).toBeNull();
  });
});

afterEach(() => vi.unstubAllGlobals());
function storage() {
  const values = new Map<string, string>();
  vi.stubGlobal("localStorage", {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  });
  return values;
}

describe("persistance tolérante des premiers pas", () => {
  it("active le guide au premier lancement", () => {
    storage();
    expect(loadFirstSteps()).toBeNull();
  });
  it.each(["terminé", "masqué"] as const)("mémorise %s et permet de revoir le guide", (status) => {
    const values = storage();
    saveFirstSteps(status);
    expect(values.get("rimlike.firststeps.v1")).toBe(JSON.stringify(status));
    expect(loadFirstSteps()).toBe(status);
    saveFirstSteps(null);
    expect(loadFirstSteps()).toBeNull();
  });
  it.each(["{illisible", "null", "true", "1", '"inconnu"', '{}', '[]'])("ignore la valeur invalide %s", (raw) => {
    storage().set("rimlike.firststeps.v1", raw);
    expect(loadFirstSteps()).toBeNull();
  });
  it("tolère les lectures, écritures et suppressions bloquées", () => {
    const fail = () => { throw new Error("stockage bloqué"); };
    vi.stubGlobal("localStorage", { getItem: fail, setItem: fail, removeItem: fail });
    expect(loadFirstSteps()).toBeNull();
    expect(() => saveFirstSteps("masqué")).not.toThrow();
    expect(() => saveFirstSteps(null)).not.toThrow();
  });
  it("tolère l'absence de localStorage", () => {
    vi.stubGlobal("localStorage", undefined);
    expect(loadFirstSteps()).toBeNull();
    expect(() => saveFirstSteps("terminé")).not.toThrow();
  });
});
