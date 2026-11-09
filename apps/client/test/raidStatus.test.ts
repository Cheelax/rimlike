import { describe, expect, it } from "vitest";
import { raidNotice } from "../src/raidStatus";

describe("état de défense de la colonie", () => {
  it("reste discret quand aucun hostile ne subsiste", () => {
    expect(raidNotice([0, 0, 0, 0, 0, 0xffffffff], 14400)).toBeNull();
  });

  it("affiche le même préavis de jeu à toutes les échelles", () => {
    for (const scale of [1, 30, 120]) {
      const notice = raidNotice([2, 6, 600 * scale, 20, 200, 9], 14400 * scale)!;
      expect(notice.label).toContain("départ dans 60 min de jeu");
      expect(notice.posture).toBe("Veille · portes fermées");
      expect(notice.target).toBe(9);
    }
  });

  it("lit la posture du sim sans la recalculer depuis le rapport des forces", () => {
    expect(raidNotice([1, 1, 0, 1, 1000, 4], 14400)?.posture).toBe("Défense à la porte");
    expect(raidNotice([2, 1, 0, 1000, 1, 4], 14400)?.posture).toBe("Veille · portes fermées");
  });

  it("signale une colonie exposée et la marche après la fin du préavis", () => {
    const notice = raidNotice([0, 1, 0, 0, 10, 4], 14400)!;
    expect(notice.label).toBe("Raid en cours · 1 ennemi");
    expect(notice.posture).toBe("Colonie exposée");
    expect(notice.detail).toContain("prioritaires");
  });
});
