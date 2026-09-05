/**
 * Factions PNJ et réputation (`crates/sim/src/factions.rs`) : logique pure,
 * sans sim ni rendu — les trois factions fixes, le palier de réputation
 * affiché et l'estimation d'un tribut avant de l'émettre.
 *
 * `FACTIONS` recopie `sim::factions::FACTIONS`/`FACTION_NAMES` en constantes
 * plutôt que de les relire par `WasmSim.faction_name`/`faction_kind` (statiques
 * réservées à qui a déjà initialisé le module WASM, donc pas atteignables
 * depuis les tests, qui tournent sous Node sans WASM — voir
 * `apps/client/vitest.config.ts`) : à modifier des deux côtés si le sim change
 * un nom, un genre ou l'ordre des trois factions (contrat `AGENTS.md`).
 */

/** Contrat avec `sim::factions::FactionKind` : 0 pillards (tribu), 1 guilde. */
export const FACTION_KIND = { Raiders: 0, Guild: 1 } as const;

export interface FactionInfo {
  /** Index dans `sim::factions::FACTIONS`, aussi l'`arg` des événements 41-43. */
  readonly id: number;
  readonly name: string;
  readonly kind: number;
  /** Nom féminin (« la Fraternité », « la Guilde ») : accord des phrases d'événement. */
  readonly feminine: boolean;
}

/**
 * Les trois factions, dans l'ordre de leurs ids (`sim::factions::FACTIONS`) :
 * 0 Clan des Cendres et 1 Fraternité du Fer (pillards), 2 Guilde des
 * Colporteurs (marchands).
 */
export const FACTIONS: readonly FactionInfo[] = [
  { id: 0, name: "Clan des Cendres", kind: FACTION_KIND.Raiders, feminine: false },
  { id: 1, name: "Fraternité du Fer", kind: FACTION_KIND.Raiders, feminine: true },
  { id: 2, name: "Guilde des Colporteurs", kind: FACTION_KIND.Guild, feminine: true },
];

/** Nom d'une faction, chaîne vide si l'id n'en désigne aucune (comme `WasmSim.faction_name`). */
export function factionName(id: number): string {
  return FACTIONS[id]?.name ?? "";
}

/** « le Clan des Cendres », « la Fraternité du Fer » : article défini + nom. */
export function factionDefinite(id: number): string {
  const f = FACTIONS[id];
  if (!f) return "";
  return `${f.feminine ? "la" : "le"} ${f.name}`;
}

/** « au Clan des Cendres », « à la Fraternité du Fer » : pour « offert à ». */
export function factionDative(id: number): string {
  const f = FACTIONS[id];
  if (!f) return "";
  return f.feminine ? `à la ${f.name}` : `au ${f.name}`;
}

/** « du Clan des Cendres », « de la Fraternité du Fer » : pour « le raid de ». */
export function factionGenitive(id: number): string {
  const f = FACTIONS[id];
  if (!f) return "";
  return f.feminine ? `de la ${f.name}` : `du ${f.name}`;
}

/** Contrat avec `sim::factions::{HOSTILE_GOODWILL, ALLY_GOODWILL}`. */
export const HOSTILE_GOODWILL = -50;
export const ALLY_GOODWILL = 50;

export type RelationLabel = "hostile" | "méfiant" | "allié";

/**
 * Palier de réputation (`sim::factions::Relation`) : hostile strictement sous
 * `HOSTILE_GOODWILL`, allié à partir de `ALLY_GOODWILL`, méfiant entre les
 * deux (bornes incluses côté méfiant, comme `Relation::of`).
 */
export function relationLabel(goodwill: number): RelationLabel {
  if (goodwill < HOSTILE_GOODWILL) return "hostile";
  if (goodwill >= ALLY_GOODWILL) return "allié";
  return "méfiant";
}

/**
 * Gain de réputation estimé pour un tribut (`Command::Gift`), à partir du prix
 * d'achat du genre cédé (`frame.buyPrices`) : une approximation de
 * `crates/sim/src/factions.rs::GIFT_VALUE_PER_POINT` (20 de valeur par point),
 * le sim utilisant sa propre table de valeur (`trade::item_value`), pas
 * forcément égale au prix d'achat affiché. Au moins 1 dès que les deux
 * facteurs sont positifs ; 0 si l'un des deux est nul ou négatif (rien à
 * offrir, ou genre sans valeur connue).
 */
export function giftGain(buyPrice: number, count: number): number {
  if (buyPrice <= 0 || count <= 0) return 0;
  return Math.max(1, Math.floor((buyPrice * count) / 20));
}
