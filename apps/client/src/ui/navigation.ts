/** Navigation de présentation : aucune règle de simulation. */
export type PanelId = "work" | "craft" | "research" | "trade" | "factions" | "journal" | "options" | "help" | "caravan" | "stock";
export type DockGroup = "orders" | "build" | "colony" | "world" | "game";
export const DOCK_GROUPS: readonly { id: DockGroup; label: string; symbol: string }[] = [
  { id: "orders", label: "Ordres", symbol: "cursor" },
  { id: "build", label: "Construire", symbol: "build" },
  { id: "colony", label: "Colonie", symbol: "colony" },
  { id: "world", label: "Monde", symbol: "world" },
  { id: "game", label: "Menu", symbol: "menu" },
];
export interface DockAction {
  id: string;
  group: DockGroup;
  label: string;
  hint: string;
  key?: string;
  active?: boolean;
  disabledReason?: string;
  run(): void;
}
export function filterActions(actions: readonly DockAction[], group: DockGroup, query: string): readonly DockAction[] {
  const normalize = (s: string) => s.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  const words = normalize(query.trim()).split(/\s+/).filter(Boolean);
  return actions.filter((a) => words.length ? words.every((word) => normalize(`${a.label} ${a.hint} ${a.disabledReason ?? ""}`).includes(word)) : a.group === group);
}
export function nextPanel(current: PanelId | null, panel: PanelId, value: boolean | ((open: boolean) => boolean)): PanelId | null {
  const open = typeof value === "function" ? value(current === panel) : value;
  return open ? panel : current === panel ? null : current;
}
export function isTextEntry(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && (target.matches("input, select, textarea") || target.isContentEditable);
}
