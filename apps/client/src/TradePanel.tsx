/**
 * Le panneau « Troc » : l'étal du marchand à gauche, ce que la colonie a en
 * stockage à droite, une balance en bas. Purement présentationnel, comme
 * `CraftingPanel` et `CaravanPanel` : il reçoit l'étal et le stock du dernier
 * `frame`, prévalide localement ce qu'un troc vaudrait (`trade.ts::tradeBalance`)
 * et laisse `App.tsx` encoder et émettre la commande — un troc refusé par le
 * sim (`crates/sim/src/trade.rs`) est silencieux, d'où la prévalidation ici.
 */

import { useEffect, useState } from "react";
import { ITEM_NAMES } from "./render/terrain";
import { tradeBalance, type TradeOffer } from "./trade";

export interface TradePanelProps {
  readonly traderName: string;
  /** Étal du marchand, décodé (`tradeOffers(frame.traderOffers)`). */
  readonly offers: readonly TradeOffer[];
  /** Stock rangé par genre, index = `items::ItemKind` (le `stored` du `frame`). */
  readonly stored: readonly number[];
  /** Prix unitaire d'achat par genre, index = `items::ItemKind` (le `buyPrices` du `frame`). */
  readonly buyPrices: readonly number[];
  readonly onTrade: (give: number, giveCount: number, take: number, takeCount: number) => void;
  readonly onClose: () => void;
}

export function TradePanel({ traderName, offers, stored, buyPrices, onTrade, onClose }: TradePanelProps) {
  const [sellKind, setSellKind] = useState<number | null>(null);
  const [sellCount, setSellCount] = useState(0);
  const [giveKind, setGiveKind] = useState<number | null>(null);
  const [giveCount, setGiveCount] = useState(0);

  // Un troc conclu (ou le marchand qui repart) change l'étal : un lot choisi
  // qui en disparaît ne doit pas laisser une sélection fantôme.
  useEffect(() => {
    if (sellKind !== null && !offers.some((o) => o.kind === sellKind)) {
      setSellKind(null);
      setSellCount(0);
    }
  }, [offers, sellKind]);

  const sellLot = offers.find((o) => o.kind === sellKind) ?? null;

  const balance =
    sellLot !== null && giveKind !== null
      ? tradeBalance({
          give: giveKind,
          giveCount,
          take: sellLot.kind,
          takeCount: sellCount,
          stored,
          available: sellLot.count,
          buyPrices,
          sellPrice: sellLot.sellPrice,
        })
      : null;
  const canPropose = balance !== null && balance.ok;

  return (
    <div className="trade-panel" onContextMenu={(e) => e.preventDefault()}>
      <div className="panel-title">Troc · {traderName}</div>
      <div className="trade-columns">
        <div className="trade-col">
          <div className="panel-section">Il vend</div>
          <ul className="trade-list">
            {offers.map((offer) => (
              <li key={offer.kind} className={offer.kind === sellKind ? "selected" : ""}>
                <label>
                  <input
                    type="radio"
                    name="trade-sell"
                    checked={offer.kind === sellKind}
                    onChange={() => {
                      setSellKind(offer.kind);
                      setSellCount(Math.min(1, offer.count));
                    }}
                  />
                  <span>
                    <span className="trade-name">{ITEM_NAMES[offer.kind] ?? "?"}</span>
                    <span className="help">
                      {offer.count} dispo · {offer.sellPrice} / unité
                    </span>
                  </span>
                </label>
                {offer.kind === sellKind && (
                  <input
                    type="number"
                    min={1}
                    max={offer.count}
                    value={sellCount}
                    onChange={(e) => {
                      const raw = e.target.valueAsNumber;
                      const value = Number.isFinite(raw) ? Math.max(0, Math.min(Math.floor(raw), offer.count)) : 0;
                      setSellCount(value);
                    }}
                  />
                )}
              </li>
            ))}
            {offers.length === 0 && <li className="empty">rien à l'étal</li>}
          </ul>
        </div>
        <div className="trade-col">
          <div className="panel-section">Vous donnez</div>
          <ul className="trade-list">
            {ITEM_NAMES.map((name, kind) => {
              const stock = stored[kind] ?? 0;
              if (stock === 0) return null;
              return (
                <li key={kind} className={kind === giveKind ? "selected" : ""}>
                  <label>
                    <input
                      type="radio"
                      name="trade-give"
                      checked={kind === giveKind}
                      onChange={() => {
                        setGiveKind(kind);
                        setGiveCount(Math.min(1, stock));
                      }}
                    />
                    <span>
                      <span className="trade-name">{name}</span>
                      <span className="help">
                        {stock} en stock · {buyPrices[kind] ?? 0} / unité
                      </span>
                    </span>
                  </label>
                  {kind === giveKind && (
                    <input
                      type="number"
                      min={1}
                      max={stock}
                      value={giveCount}
                      onChange={(e) => {
                        const raw = e.target.valueAsNumber;
                        const value = Number.isFinite(raw) ? Math.max(0, Math.min(Math.floor(raw), stock)) : 0;
                        setGiveCount(value);
                      }}
                    />
                  )}
                </li>
              );
            })}
            {stored.every((n) => n === 0) && <li className="empty">rien en stockage</li>}
          </ul>
        </div>
      </div>

      <div className={`trade-balance${balance === null ? "" : balance.ok ? " ok" : " bad"}`}>
        {sellLot === null || giveKind === null ? (
          "Choisissez un lot et un genre à donner"
        ) : (
          <>
            <div>
              Vous offrez {balance!.paid} · il demande {balance!.cost}
            </div>
            <div>{balance!.ok ? "Marché acceptable" : (balance!.reason ?? "Choisissez une quantité des deux côtés")}</div>
          </>
        )}
      </div>

      <button
        className="wide primary"
        disabled={!canPropose}
        onClick={() => {
          if (sellLot === null || giveKind === null) return;
          onTrade(giveKind, giveCount, sellLot.kind, sellCount);
          // L'événement 28 et l'étal rafraîchi suffisent : on ne garde que les
          // genres choisis, prêts pour un prochain troc.
          setGiveCount(0);
          setSellCount(0);
        }}
      >
        Proposer
      </button>
      <button className="wide" onClick={onClose}>
        Fermer
      </button>
    </div>
  );
}
