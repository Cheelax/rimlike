/**
 * Le panneau « Caravane » : qui part, avec quoi, et vers où.
 *
 * Purement présentationnel — il ne connaît ni le sim, ni le réseau, ni le
 * globe. Il reçoit la liste des colons et le stock du dernier `frame`, la
 * destination déjà choisie, et rend des rappels. C'est `App.tsx` qui encode la
 * commande et `CaravanDispatcher` qui expédie le manifeste
 * (`docs/protocol.md` §12).
 *
 * Le choix de la destination se fait **sur le globe** : le bouton bascule sur
 * l'écran Monde en mode sélection, et la case cliquée revient ici avec son
 * biome et l'itinéraire prévisualisé par `findRoute`.
 */

import { useState } from "react";
import { ITEM_NAMES } from "./render/terrain";

/** Un colon embarquable, tel que le HUD le connaît. */
export interface CaravanColonist {
  readonly id: number;
  readonly name: string;
  /** Un colon à terre ne part pas : le sim refuserait le manifeste en bloc. */
  readonly downed: boolean;
  /** Points de vie, en pourcentage. */
  readonly hp: number;
  /** Sang, en pourcentage. */
  readonly blood: number;
}

/** La case d'arrivée choisie, avec ce que la prévisualisation en dit. */
export interface CaravanDestination {
  readonly tile: number;
  readonly biome: string;
  /** Durée estimée en heures de jeu, `null` s'il n'y a pas de route terrestre. */
  readonly hours: number | null;
  /** Cases traversées, arrivée comprise. */
  readonly steps: number;
  /** Propriétaire de la colonie d'arrivée, `null` si la case est libre. */
  readonly owner: string | null;
}

export interface CaravanPanelProps {
  /** Case de la colonie d'où part la caravane (la salle `tile-N` en cours). */
  readonly fromTile: number;
  readonly colonists: readonly CaravanColonist[];
  /** Stock rangé par genre, index = `items::ItemKind` (le `stored` du `frame`). */
  readonly stored: readonly number[];
  readonly destination: CaravanDestination | null;
  /** Faux si un autre joueur est l'hôte : lui seul expédie les manifestes. */
  readonly isHost: boolean;
  /** Manifestes déjà sortis du sim et sans destination connue. */
  readonly waiting: number;
  readonly onPickDestination: () => void;
  readonly onSend: (pawnIds: number[], items: [number, number][]) => void;
  /** Donne la destination courante aux manifestes restés en attente. */
  readonly onSendWaiting: () => void;
  readonly onClose: () => void;
}

/** Un nombre d'heures de jeu, écrit court : « 28 h » ou « 1 j 4 h ». */
export function formatHours(hours: number): string {
  const total = Math.round(hours);
  if (total < 24) return `${total} h`;
  return `${Math.floor(total / 24)} j ${total % 24} h`;
}

export function CaravanPanel({
  fromTile,
  colonists,
  stored,
  destination,
  isHost,
  waiting,
  onPickDestination,
  onSend,
  onSendWaiting,
  onClose,
}: CaravanPanelProps) {
  const [chosen, setChosen] = useState<readonly number[]>([]);
  /** Quantité demandée par genre, bornée au stock à la saisie. */
  const [amounts, setAmounts] = useState<Readonly<Record<number, number>>>({});

  const toggle = (id: number) => {
    setChosen((prev) => (prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id]));
  };
  const setAmount = (kind: number, raw: number) => {
    const stock = stored[kind] ?? 0;
    const value = Number.isFinite(raw) ? Math.max(0, Math.min(Math.floor(raw), stock)) : 0;
    setAmounts((prev) => ({ ...prev, [kind]: value }));
  };

  // Un colon à terre ne peut pas partir, et un colon coché qui tombe entre
  // deux `frame` doit disparaître de la sélection : le sim refuserait tout.
  const boarding = chosen.filter((id) => colonists.some((c) => c.id === id && !c.downed));
  const items = Object.entries(amounts)
    .map(([kind, count]) => [Number(kind), count] as [number, number])
    .filter(([, count]) => count > 0);
  const routeKnown = destination !== null && destination.hours !== null;
  const canSend = isHost && boarding.length > 0 && routeKnown;

  return (
    <div className="caravan-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Caravane · depuis la case {fromTile}</div>

      <div className="panel-section">Colons ({boarding.length} au départ)</div>
      <ul className="caravan-list">
        {colonists.map((colonist) => (
          <li key={colonist.id} className={colonist.downed ? "downed" : ""}>
            <label>
              <input
                type="checkbox"
                checked={boarding.includes(colonist.id)}
                disabled={colonist.downed}
                onChange={() => toggle(colonist.id)}
              />
              <span className="caravan-name">{colonist.name || `Colon ${colonist.id}`}</span>
              <span className="help">
                {colonist.downed
                  ? "à terre"
                  : `${Math.round(colonist.hp)} % pv · ${Math.round(colonist.blood)} % sang`}
              </span>
            </label>
          </li>
        ))}
        {colonists.length === 0 && <li className="empty">aucun colon dans cette colonie</li>}
      </ul>

      <div className="panel-section">Marchandises</div>
      <div className="caravan-goods">
        {ITEM_NAMES.map((name, kind) => {
          const stock = stored[kind] ?? 0;
          if (stock === 0) return null;
          return (
            <label key={name} className="caravan-good">
              <span>{name}</span>
              <input
                type="number"
                min={0}
                max={stock}
                value={amounts[kind] ?? 0}
                onChange={(e) => setAmount(kind, e.target.valueAsNumber)}
              />
              <span className="help">/ {stock}</span>
            </label>
          );
        })}
        {stored.every((n) => n === 0) && <div className="help">rien de rangé en stockage</div>}
      </div>
      <div className="help">Seul ce qui est rangé en zone de stockage peut partir.</div>

      <div className="panel-section">Destination</div>
      {destination === null ? (
        <div className="help">Aucune case choisie.</div>
      ) : (
        <div className="caravan-destination">
          <div>
            <b>{destination.biome}</b> · case {destination.tile}
          </div>
          <div className="help">
            {destination.owner === null ? "case libre : la caravane y fondera une colonie" : `colonie de ${destination.owner}`}
          </div>
          <div className="help">
            {destination.hours === null
              ? "pas de route terrestre jusqu'ici"
              : `${destination.steps} case(s) · environ ${formatHours(destination.hours)} de voyage`}
          </div>
        </div>
      )}
      <button className="wide" onClick={onPickDestination}>
        Choisir sur le globe
      </button>

      {waiting > 0 && (
        <div className="caravan-waiting">
          {waiting} manifeste{waiting > 1 ? "s" : ""} sans destination (formé
          {waiting > 1 ? "s" : ""} par un autre joueur, ou hôte changé depuis).
          <button className="wide" disabled={!routeKnown || !isHost} onClick={onSendWaiting}>
            Les envoyer vers la case choisie
          </button>
        </div>
      )}

      <div className="world-spacer" />
      {!isHost && <div className="help">Seul l'hôte de la salle expédie les caravanes.</div>}
      <button className="wide primary" disabled={!canSend} onClick={() => onSend(boarding, items)}>
        Envoyer
      </button>
      <button className="wide" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}
