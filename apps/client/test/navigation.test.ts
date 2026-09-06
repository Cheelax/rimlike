import { describe, expect, it } from "vitest";
import { DOCK_GROUPS, filterActions, nextPanel, type DockAction } from "../src/ui/navigation";
import { TOOLS } from "../src/tools";

const actions: DockAction[] = [
  ...TOOLS.map((tool): DockAction => ({ ...tool, hint: tool.hint ?? "Placer sur la grille", run() {} })),
  { id: "research", group: "colony", label: "Recherche", hint: "Choisir une technologie", run() {} },
  { id: "trade", group: "world", label: "Troc", hint: "Échanger des ressources", disabledReason: "En attente d’un marchand", run() {} },
];

describe("navigation des commandes", () => {
  it("rend chaque outil accessible depuis une rubrique, même sans raccourci", () => {
    const reachable = DOCK_GROUPS.flatMap((group) => filterActions(actions, group.id, "")).map((a) => a.id);
    expect(new Set(reachable).size).toBe(actions.length);
    for (const tool of TOOLS) expect(reachable).toContain(tool.id);
  });
  it("cherche dans toutes les rubriques et ignore les accents et la casse", () => {
    expect(filterActions(actions, "orders", "  ETABLI  RECHERCHE ").map((a) => a.id)).toEqual(["researchBench"]);
    expect(filterActions(actions, "build", "technologie").map((a) => a.id)).toEqual(["research"]);
  });
  it("laisse découvrir les commandes verrouillées par leur prérequis", () => {
    expect(filterActions(actions, "build", "marchand").map((a) => a.id)).toEqual(["trade"]);
  });
  it("ne retourne aucun résultat si les termes ne correspondent pas", () => {
    expect(filterActions(actions, "world", "forge recherche")).toEqual([]);
  });
});

describe("panneau de gestion exclusif", () => {
  it("remplace le panneau courant et le referme par la même bascule", () => {
    const toggle = (open: boolean) => !open;
    const work = nextPanel(null, "work", toggle);
    const research = nextPanel(work, "research", toggle);
    expect(work).toBe("work");
    expect(research).toBe("research");
    expect(nextPanel(research, "research", toggle)).toBeNull();
  });
  it("ignore la fermeture tardive d’un panneau déjà remplacé", () => {
    expect(nextPanel("stock", "trade", false)).toBe("stock");
    expect(nextPanel("stock", "stock", false)).toBeNull();
    expect(nextPanel(null, "help", false)).toBeNull();
  });
});
