/**
 * Overlay d'aide des raccourcis (touche `?` ou `F1`, bouton « ? » de la
 * barre) : purement présentationnel, comme les autres panneaux
 * (`FactionsPanel.tsx`). Le tableau vient de `SHORTCUTS` (`shortcuts.ts`),
 * lui-même tiré de la barre d'outils et des bascules de panneaux — jamais une
 * recopie à la main qui pourrait diverger. Ne met rien en pause : `App.tsx`
 * ne touche pas `paused` en l'ouvrant.
 */

import { SHORTCUTS, type ShortcutGroup } from "./shortcuts";

export interface HelpPanelProps {
  readonly onClose: () => void;
}

const GROUP_ORDER: readonly ShortcutGroup[] = ["caméra", "sélection", "outils", "panneaux", "partie"];
const GROUP_LABELS: Readonly<Record<ShortcutGroup, string>> = {
  "caméra": "Caméra",
  "sélection": "Sélection",
  "outils": "Outils",
  "panneaux": "Panneaux",
  "partie": "Partie",
};

export function HelpPanel({ onClose }: HelpPanelProps) {
  return (
    <div className="help-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Aide</div>
      <div className="help-panel-mouse">
        <div>Glisser gauche : trace un rectangle si un outil est actif, sinon déplace la caméra.</div>
        <div>Glisser droit, ou les flèches : déplace toujours la caméra.</div>
        <div>Molette : zoom.</div>
        <div>Clic droit (avec un colon sélectionné) : déplacement, ou attaque sur un ennemi ou un animal.</div>
      </div>
      {GROUP_ORDER.map((group) => {
        const rows = SHORTCUTS.filter((s) => s.group === group);
        if (rows.length === 0) return null;
        return (
          <div key={group}>
            <div className="panel-section">{GROUP_LABELS[group]}</div>
            <table className="help-table">
              <tbody>
                {rows.map((s) => (
                  <tr key={`${group}:${s.keys}`}>
                    <td>
                      <kbd>{s.keys}</kbd>
                    </td>
                    <td>{s.action}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        );
      })}
      <button className="wide" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}
