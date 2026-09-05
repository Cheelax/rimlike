import { describe, expect, it } from "vitest";
import * as THREE from "three";
import { PropBatch, PropLibrary, WALL_HEIGHT, blueprintKey, doorRotation } from "../src/render/props";
import { BUILD_KIND, FEATURE, ITEM_NAMES, TERRAIN } from "../src/render/terrain";

describe("catalogue de props modulaires", () => {
  it("garde toutes les constructions et piles dans leur case, plans compris", () => {
    const library = new PropLibrary();
    const keys = [
      ...Object.values(FEATURE).filter((v) => v >= FEATURE.WallWood).map((v) => `feature:${v}`),
      ...ITEM_NAMES.map((_, i) => `item:${i}`),
      `floor:${TERRAIN.WoodFloor}`, `floor:${TERRAIN.StoneFloor}`,
    ];
    for (const key of keys) {
      const geometry = library.geometry(key);
      const box = geometry.boundingBox!;
      expect(box.min.x, key).toBeGreaterThanOrEqual(-0.501);
      expect(box.max.x, key).toBeLessThanOrEqual(0.501);
      expect(box.min.z, key).toBeGreaterThanOrEqual(-0.501);
      expect(box.max.z, key).toBeLessThanOrEqual(0.501);
      expect(box.min.y, key).toBeGreaterThanOrEqual(-0.001);
      expect(geometry.getAttribute("position").count / 3, key).toBeLessThan(2500);
      expect(library.geometry(key, true).boundingBox).toEqual(box);
    }
    expect(library.geometry(`feature:${FEATURE.WallStone}`).boundingBox!.max.y).toBeCloseTo(WALL_HEIGHT);
    library.dispose();
  });

  it("utilise les formes finies pour tous les types de chantier", () => {
    const library = new PropLibrary();
    for (const kind of Object.values(BUILD_KIND)) for (const material of [0, 1]) {
      const key = blueprintKey(kind, material);
      const final = library.geometry(key);
      const ghost = library.geometry(key, true);
      expect(ghost.getAttribute("position").array).toEqual(final.getAttribute("position").array);
      expect(ghost.hasAttribute("color")).toBe(false);
    }
    library.dispose();
  });

  it("oriente les portes sans confondre deux rangées aux bords de la carte", () => {
    expect(doorRotation(1, 1, 3, 3, (i) => i === 3 || i === 5)).toBe(0);
    expect(doorRotation(1, 1, 3, 3, (i) => i === 1 || i === 7)).toBe(Math.PI / 2);
    expect(doorRotation(0, 1, 3, 3, (i) => i === 2 || i === 6)).toBe(Math.PI / 2);
    expect(doorRotation(2, 1, 3, 3, (i) => i === 6 || i === 2)).toBe(Math.PI / 2);
    expect(doorRotation(1, 1, 3, 3, () => false)).toBe(0);
  });

  it("distingue la tombe vide de la tombe occupée par une stèle plus haute", () => {
    const library = new PropLibrary();
    const empty = library.geometry(`feature:${FEATURE.Grave}`).boundingBox!;
    const filled = library.geometry(`feature:${FEATURE.GraveFilled}`).boundingBox!;
    expect(filled.max.y).toBeGreaterThan(empty.max.y);
    // La tombe n'existe qu'en pierre (contrat sim) : les deux matériaux de
    // plan pointent vers la même géométrie.
    expect(blueprintKey(BUILD_KIND.Grave, 0)).toBe(blueprintKey(BUILD_KIND.Grave, 1));
    library.dispose();
  });

  it("établi de recherche : bois forcé (contrat sim), une seule géométrie quel que soit le matériau demandé", () => {
    const library = new PropLibrary();
    expect(blueprintKey(BUILD_KIND.ResearchBench, 0)).toBe(`feature:${FEATURE.ResearchBench}`);
    expect(blueprintKey(BUILD_KIND.ResearchBench, 0)).toBe(blueprintKey(BUILD_KIND.ResearchBench, 1));
    library.dispose();
  });

  it("réutilise les instances, ne tronque pas 3000 plans et actualise leurs bornes", () => {
    const library = new PropLibrary(), batch = new PropBatch(library, true);
    const entries = Array.from({ length: 3000 }, (_, i) => ({ key: `feature:${FEATURE.WallWood}`, x: i, z: 0 }));
    batch.sync(entries);
    const mesh = batch.group.children[0] as THREE.InstancedMesh;
    expect(mesh.count).toBe(3000);
    const array = mesh.instanceMatrix;
    batch.sync([{ ...entries[0], x: 9000 }]);
    expect(batch.group.children[0]).toBe(mesh);
    expect(mesh.instanceMatrix).toBe(array);
    expect(mesh.count).toBe(1);
    expect(mesh.boundingSphere!.center.x).toBeCloseTo(9000);
    batch.sync([]);
    expect(mesh.visible).toBe(false);
    batch.dispose(); library.dispose();
  });
});
