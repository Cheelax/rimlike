/**
 * Le panneau « Factions » : les trois factions PNJ fixes
 * (`crates/sim/src/factions.rs`), chacune avec sa jauge de réputation et un
 * mini-formulaire de tribut. Purement présentationnel, comme les autres
 * panneaux : il reçoit `goodwill` et `lastRaidFaction` du dernier `frame`, le
 * stock et les prix d'achat, et laisse `App.tsx` encoder et émettre
 * `Command::Gift`. L'aperçu du gain de réputation (`factions.ts::giftGain`)
 * est une approximation : le sim seul décide vraiment
 * (`crates/sim/src/factions.rs::GIFT_VALUE_PER_POINT`).
 */

import { useState } from "react";
import { FACTION_KIND, FACTIONS, giftGain, relationLabel, type RelationLabel } from "./factions";
import { ITEM_NAMES } from "./render/terrain";

export interface FactionsPanelProps {
  /** Réputation par faction, dans l'ordre des ids (`frame.goodwill`, −100..=100). */
  readonly goodwill: readonly number[];
  /** Tribu du dernier raid, −1 si aucune (`frame.lastRaidFaction`). */
  readonly lastRaidFaction: number;
  /** Stock rangé par genre, index = `items::ItemKind` (le `stored` du `frame`). */
  readonly stored: readonly number[];
  /** Prix unitaire d'achat par genre, index = `items::ItemKind` (le `buyPrices` du `frame`). */
  readonly buyPrices: readonly number[];
  readonly onGift: (faction: number, kind: number, count: number) => void;
  readonly onClose: () => void;
}

/** Classe CSS du palier, en anglais pour ne pas dépendre de l'accent de `relationLabel`. */
const RELATION_CLASS: Readonly<Record<RelationLabel, string>> = {
  hostile: "hostile",
  "méfiant": "wary",
  "allié": "ally",
};

export function FactionsPanel({
  goodwill,
  lastRaidFaction,
  stored,
  buyPrices,
  onGift,
  onClose,
}: FactionsPanelProps) {
  return (
    <div className="factions-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Factions</div>
      <div className="help">Une tribu alliée ne vous attaque plus ; la Guilde alliée vend moins cher.</div>
      <ul className="faction-list">
        {FACTIONS.map((faction) => {
          const value = goodwill[faction.id] ?? 0;
          const label = relationLabel(value);
          const cls = RELATION_CLASS[label];
          const pct = Math.max(0, Math.min(100, Math.round(((value + 100) / 200) * 100)));
          return (
            <li key={faction.id} className="faction-row">
              <div className="faction-head">
                <span className="faction-name">{faction.name}</span>
                <span className="help">{faction.kind === FACTION_KIND.Guild ? "guilde" : "tribu"}</span>
              </div>
              <div className="faction-gauge">
                <span className="bar-track">
                  <span className={`bar-fill ${cls}`} style={{ width: `${pct}%` }} />
                </span>
                <span className={`faction-relation ${cls}`}>
                  {value} · {label}
                </span>
              </div>
              {lastRaidFaction === faction.id && <div className="faction-lastraid">a mené le dernier raid</div>}
              <GiftForm faction={faction.id} stored={stored} buyPrices={buyPrices} onGift={onGift} />
            </li>
          );
        })}
      </ul>
      <button className="wide" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}

interface GiftFormProps {
  readonly faction: number;
  readonly stored: readonly number[];
  readonly buyPrices: readonly number[];
  readonly onGift: (faction: number, kind: number, count: number) => void;
}

/**
 * Le mini-formulaire de tribut d'une faction : genre en stockage (quantité
 * disponible), quantité à offrir, aperçu du gain de réputation
 * (`giftGain`). Recalculé à chaque rendu depuis `stored` : pas d'état à
 * synchroniser si un genre choisi disparaît du stock entre deux `frame`, le
 * bouton se grise simplement (comme `TradePanel` le fait pour son étal).
 */
function GiftForm({ faction, stored, buyPrices, onGift }: GiftFormProps) {
  const options = ITEM_NAMES.map((name, kind) => ({ kind, name, stock: stored[kind] ?? 0 })).filter(
    (o) => o.stock > 0,
  );
  const [kind, setKind] = useState<number | null>(null);
  const [count, setCount] = useState(0);

  const selected = kind !== null ? (options.find((o) => o.kind === kind) ?? null) : null;
  const stock = selected?.stock ?? 0;
  const gain = selected !== null ? giftGain(buyPrices[selected.kind] ?? 0, count) : 0;
  const canGift = selected !== null && count > 0 && count <= stock;

  if (options.length === 0) {
    return <div className="faction-gift help">rien en stockage à offrir</div>;
  }

  return (
    <div className="faction-gift">
      <div className="faction-gift-row">
        <select
          value={kind ?? ""}
          onChange={(e) => {
            const next = e.target.value === "" ? null : Number(e.target.value);
            setKind(next);
            setCount(next !== null ? Math.min(1, stored[next] ?? 0) : 0);
          }}
        >
          <option value="">choisir un genre</option>
          {options.map((o) => (
            <option key={o.kind} value={o.kind}>
              {o.name} ({o.stock})
            </option>
          ))}
        </select>
        <input
          type="number"
          min={0}
          max={stock}
          value={count}
          disabled={selected === null}
          onChange={(e) => {
            const raw = e.target.valueAsNumber;
            setCount(Number.isFinite(raw) ? Math.max(0, Math.min(Math.floor(raw), stock)) : 0);
          }}
        />
        <button disabled={!canGift} onClick={() => selected && onGift(faction, selected.kind, count)}>
          Offrir
        </button>
      </div>
      {selected !== null && count > 0 && <div className="help">≈ +{gain} de réputation</div>}
    </div>
  );
}
