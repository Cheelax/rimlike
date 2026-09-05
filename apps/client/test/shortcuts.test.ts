/**
 * `SHORTCUTS` (`src/shortcuts.ts`) : l'aide ne doit jamais diverger de la
 * vraie barre d'outils (`src/tools.ts`) ni s'attribuer deux fois la même
 * touche dans un même contexte. Module pur, sans DOM.
 */

import { describe, expect, it } from "vitest";

import { SHORTCUTS } from "../src/shortcuts";
import { TOOLS } from "../src/tools";

/**
 * Découpe une colonne « touche(s) » en touches atomiques : un « / » entouré
 * d'espaces sépare des touches indépendantes (« Q / E », « 1 / 2 / 3 »),
 * jamais un « / » collé aux lettres (« Ctrl/Cmd + A » reste une seule touche
 * composée) — convention documentée dans `shortcuts.ts`.
 */
function atomicKeys(keys: string): string[] {
  return keys.split(" / ").map((k) => k.trim());
}

describe("SHORTCUTS", () => {
  it("n'a que des touches et des libellés non vides", () => {
    expect(SHORTCUTS.length).toBeGreaterThan(0);
    for (const s of SHORTCUTS) {
      expect(s.keys.trim().length).toBeGreaterThan(0);
      expect(s.action.trim().length).toBeGreaterThan(0);
    }
  });

  it("n'attribue aucune touche deux fois parmi les outils", () => {
    const seen = new Set<string>();
    for (const s of SHORTCUTS.filter((s) => s.group === "outils")) {
      for (const k of atomicKeys(s.keys)) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it("n'attribue aucune touche deux fois parmi les raccourcis globaux (hors outils)", () => {
    const seen = new Set<string>();
    for (const s of SHORTCUTS.filter((s) => s.group !== "outils")) {
      for (const k of atomicKeys(s.keys)) {
        expect(seen.has(k)).toBe(false);
        seen.add(k);
      }
    }
  });

  it("liste chaque outil de la barre qui a une touche", () => {
    const outilsKeys = new Set(
      SHORTCUTS.filter((s) => s.group === "outils").flatMap((s) => atomicKeys(s.keys)),
    );
    for (const tool of TOOLS.filter((t) => t.key !== "")) {
      expect(outilsKeys.has(tool.key)).toBe(true);
    }
  });
});
