import { useEffect, useRef, useState } from "react";
import { DOCK_GROUPS, filterActions, type DockAction, type DockGroup } from "./navigation";
import { Icon } from "./Icon";

interface Props {
  actions: readonly DockAction[];
  toolLabel: string;
  toolGroup: DockGroup;
  selected: boolean;
  activePanel: string | null;
  onSelect(): void;
  material: number;
  onMaterial(value: number): void;
}
export function CommandDock({ actions, toolLabel, toolGroup, selected, activePanel, onSelect, material, onMaterial }: Props) {
  const [open, setOpen] = useState<DockGroup | null>(null);
  const [query, setQuery] = useState("");
  const root = useRef<HTMLElement>(null);
  const trigger = useRef<HTMLButtonElement | null>(null);
  useEffect(() => { setOpen(null); setQuery(""); }, [toolLabel, activePanel]);
  useEffect(() => {
    if (open === null) return;
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault(); event.stopImmediatePropagation();
      setOpen(null); trigger.current?.focus();
    };
    const outside = (event: PointerEvent) => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) setOpen(null);
    };
    window.addEventListener("keydown", key, true);
    window.addEventListener("pointerdown", outside);
    return () => { window.removeEventListener("keydown", key, true); window.removeEventListener("pointerdown", outside); };
  }, [open]);
  const matches = open === null ? [] : filterActions(actions, open, query);
  return (
    <nav className="command-dock" aria-label="Commandes de la colonie" ref={root}>
      {open !== null && <section className="command-drawer" aria-label={DOCK_GROUPS.find((g) => g.id === open)?.label} id="command-drawer">
        <div className="command-heading">
          <div><span className="eyebrow">Actions de la colonie</span><h2>{query ? "Toutes les commandes" : DOCK_GROUPS.find((g) => g.id === open)?.label}</h2></div>
          <button className="icon-button" aria-label="Fermer les commandes" onClick={() => { setOpen(null); trigger.current?.focus(); }}><Icon name="close" /></button>
        </div>
        <label className="command-search"><Icon name="search" size={17} /><input type="search" aria-label="Rechercher une commande" placeholder="Rechercher parmi toutes les commandes…" value={query} onChange={(e) => setQuery(e.target.value)} /></label>
        {open === "build" && !query && <div className="material-choice"><span>Matériau</span>{["Bois", "Pierre"].map((label, i) => <button key={label} aria-pressed={material === i} onClick={() => onMaterial(i)}>{label}</button>)}<kbd>T</kbd></div>}
        <div className="command-grid">
          {matches.map((a) => <button key={a.id} className={`command-card${a.active ? " active" : ""}`} aria-pressed={a.active ?? false} disabled={!!a.disabledReason} onClick={() => { a.run(); setOpen(null); setQuery(""); }}>
            <span className="command-card-title">{a.label}{a.key && <kbd>{a.key}</kbd>}</span>
            <span className={a.disabledReason ? "command-lock" : "command-description"}>{a.disabledReason ?? a.hint}</span>
          </button>)}
          {matches.length === 0 && <p className="command-empty">Aucune commande trouvée. Essayez « mur », « recherche » ou « sauvegarder ».</p>}
        </div>
      </section>}
      <div className="dock-bar">
        <button className={`dock-select${selected ? " active" : ""}`} aria-label="Sélectionner — S" title="Sélection · S" onClick={() => { onSelect(); setOpen(null); }}><Icon name="cursor" /><span>Sélection</span></button>
        {DOCK_GROUPS.map((g) => <button key={g.id} className={`dock-tab${open === g.id ? " open" : ""}${!selected && toolGroup === g.id ? " tool-active" : ""}`} aria-expanded={open === g.id} aria-controls="command-drawer" onClick={(e) => { trigger.current = e.currentTarget; setOpen(open === g.id ? null : g.id); setQuery(""); }}><Icon name={g.symbol} /><span>{g.label}</span></button>)}
      </div>
      {!selected && <div className="active-tool-label">{toolLabel}<span>Échap pour quitter</span></div>}
    </nav>
  );
}
