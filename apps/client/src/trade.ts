/**
 * Logique pure du troc avec le marchand : décodage de son étal
 * (`sim-wasm::trader_offers`) et prévalidation d'une proposition avant de
 * l'émettre. Le sim (`crates/sim/src/trade.rs`) applique exactement la même
 * règle mais refuse un troc en silence : `tradeBalance` sert à prévenir le
 * joueur avant qu'il ne clique, jamais à dupliquer la règle côté serveur.
 *
 * Purement fonctionnel, comme `render/terrain.ts` : ni sim, ni rendu, ni
 * réseau.
 */

/** Un lot de l'étal du marchand, décodé de `frame.traderOffers`. */
export interface TradeOffer {
  /** Genre suivant `sim::ItemKind`. */
  readonly kind: number;
  /** Quantité disponible dans ce lot. */
  readonly count: number;
  /** Prix unitaire de vente : ce que la colonie paie pour une unité de ce genre. */
  readonly sellPrice: number;
}

/**
 * Décodage de `frame.traderOffers` (`sim-wasm::trader_offers`) : `[genre,
 * quantité, prix unitaire de vente] × n`. Tableau vide si le marchand est
 * absent.
 */
export function tradeOffers(buffer: ArrayLike<number>): TradeOffer[] {
  const out: TradeOffer[] = [];
  for (let o = 0; o + 3 <= buffer.length; o += 3) {
    out.push({ kind: buffer[o], count: buffer[o + 1], sellPrice: buffer[o + 2] });
  }
  return out;
}

export interface TradeBalanceInput {
  /** Genre cédé par la colonie, suivant `sim::ItemKind`. */
  readonly give: number;
  readonly giveCount: number;
  /** Genre pris chez le marchand, suivant `sim::ItemKind`. */
  readonly take: number;
  readonly takeCount: number;
  /** Stock de la colonie, indexé par `ItemKind` (`frame.stored`). */
  readonly stored: ArrayLike<number>;
  /** Ce que le marchand a du genre `take` (la quantité du lot choisi, `TradeOffer.count`). */
  readonly available: number;
  /** Prix unitaire d'achat par genre, indexé par `ItemKind` (`frame.buyPrices`, 16 entrées). */
  readonly buyPrices: ArrayLike<number>;
  /** Prix unitaire de vente du genre `take` (`TradeOffer.sellPrice` du lot choisi). */
  readonly sellPrice: number;
}

export interface TradeBalance {
  /** Valeur offerte par la colonie : `buyPrices[give] × giveCount`. */
  readonly paid: number;
  /** Valeur demandée par le marchand : `sellPrice × takeCount`. */
  readonly cost: number;
  /** Vrai si le sim accepterait ce troc (`crates/sim/src/trade.rs`). */
  readonly ok: boolean;
  /** Texte français de refus, `null` si `ok` ou si rien n'est encore choisi des deux côtés. */
  readonly reason: string | null;
}

/**
 * Prévalide un troc avant de l'émettre. Ordre des vérifications identique à
 * celui du sim : comptes positifs (silencieux, `reason` reste `null` tant que
 * rien n'est choisi), stock de la colonie, stock du marchand, puis la valeur
 * offerte contre celle demandée.
 */
export function tradeBalance(input: TradeBalanceInput): TradeBalance {
  const { give, giveCount, takeCount, stored, available, buyPrices, sellPrice } = input;
  const paid = (buyPrices[give] ?? 0) * giveCount;
  const cost = sellPrice * takeCount;
  if (giveCount <= 0 || takeCount <= 0) {
    return { paid, cost, ok: false, reason: null };
  }
  if ((stored[give] ?? 0) < giveCount) {
    return { paid, cost, ok: false, reason: "Pas assez en stockage" };
  }
  if (available < takeCount) {
    return { paid, cost, ok: false, reason: "Le marchand n'en a pas autant" };
  }
  if (paid < cost) {
    return { paid, cost, ok: false, reason: `Offre insuffisante : il manque ${cost - paid} de valeur` };
  }
  return { paid, cost, ok: true, reason: null };
}
