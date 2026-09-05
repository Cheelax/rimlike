/**
 * Cible d'un événement du sim (toast ou ligne du Journal), pour recentrer la
 * caméra dessus (`Renderer.focusOn`) et sélectionner le pawn concerné, le cas
 * échéant. Logique pure : ni DOM, ni sim, ni React — `ctx` est le seul lien
 * avec l'état du jeu, fourni par l'appelant (`App.tsx`) et interrogé au
 * moment du calcul, jamais mémorisé ici.
 *
 * Principe : toute cible « pawn » pointe vers sa position **courante**
 * (`ctx.pawnById`), jamais celle qu'il avait au moment de l'événement — un
 * pillard a marché depuis, un colon secouru a changé de lit. C'est pour ça
 * que le type ne porte qu'un id, jamais de coordonnées : les positions
 * figées n'auraient plus de sens quand le joueur clique, parfois bien après
 * l'annonce (le Journal garde ses entrées toute la session). Une cible dont
 * le pawn a disparu (mort, parti) redevient `null` d'elle-même : c'est
 * `ctx.pawnById` qui en décide, pas une liste figée à la réception.
 */

/** Recherches sans DOM fournies par l'appelant, toujours sur l'état courant. */
export interface EventFocusCtx {
  /** Position courante d'un pawn (colon, pillard, marchand ou bête). `null` s'il a disparu. */
  pawnById(id: number): { x: number; y: number } | null;
  /** Premier pawn vivant d'une faction (`sim::pawn::Faction`), par ordre du tampon `pawns`. `null` si aucun. */
  firstPawnOfFaction(faction: number): { id: number; x: number; y: number } | null;
  /** Première case en feu rencontrée dans la couche `fire`. `null` si rien ne brûle. */
  firstBurningTile(): { x: number; y: number } | null;
  /** Id du marchand actuellement présent sur la carte (`frame.traderPresent`). `null` s'il n'y en a pas. */
  traderId(): number | null;
}

/** Cible d'un événement, ou `null` s'il n'y en a pas de pertinente à montrer. */
export type EventTarget = { kind: "pawn"; id: number } | { kind: "tile"; x: number; y: number } | null;

/** `sim::pawn::Faction::Raider` (voir AGENTS.md, tableau des contrats). */
const FACTION_RAIDER = 1;

/** Cible d'id de pawn générique : `null` si `id` ne répond plus dans `ctx`. */
function pawnTarget(id: number, ctx: EventFocusCtx): EventTarget {
  return ctx.pawnById(id) ? { kind: "pawn", id } : null;
}

/**
 * Cible d'un événement lié au marchand (26, 27, 29) : le marchand **courant**
 * (`ctx.traderId`), pas `arg` — un marchand mort ou reparti a déjà quitté le
 * tampon `pawns` au moment où le joueur clique (`TraderDied` est émis au
 * moment même où `Sim::remove_dead` le retire, voir `crates/sim/src/trade.rs`) :
 * `arg` n'y ramènerait jamais rien, autant chercher le marchand qui pourrait
 * encore y répondre.
 */
function traderTarget(ctx: EventFocusCtx): EventTarget {
  const id = ctx.traderId();
  return id !== null ? pawnTarget(id, ctx) : null;
}

/**
 * Cible d'un événement du sim (`sim::EventKind`, voir AGENTS.md). Chaque
 * genre est classé d'après le commentaire de son `arg` dans
 * `crates/sim/src/lib.rs` :
 *
 * - **pawn** (arg = id d'un pawn encore potentiellement présent) : à terre
 *   (8), secouru (9), soigné (10), malade (23), dispute (32), rixe (33), ami
 *   perdu (34, le survivant), piège déclenché (35, la victime), sanglier
 *   charge (19), voyageur rejoint (5), colon craque (6) — tous des pawns
 *   vivants au moment de l'événement, pas retirés dans le même tick.
 * - **pawn via le marchand courant** : visite (26), fureur (27), mort (29).
 * - **pawn via la première cible d'une faction** : raid en approche (21) et
 *   raid (1) mènent au premier pillard trouvé (faction 1), sinon `null` — ni
 *   l'un ni l'autre ne portent l'id d'un pillard précis dans `arg`.
 * - **tile** : premier départ de feu (36), vers la première case qui brûle.
 * - **`null`** partout ailleurs, notamment : mort d'un colon (2) ou d'un
 *   pillard (3), pillard qui fuit (4) — retirés du tampon `pawns` au même
 *   tick que l'événement, donc jamais retrouvables ; les genres, comptes et
 *   distances sans pawn (raid abouti, artisanat, chasse, caravane, largage,
 *   météo, tribut, réputation…) ; les événements explicitement sans lieu
 *   (niveau 7, saison 15, gel 16, recherche 31, troc 28, incendie éteint 37).
 */
export function eventTarget(kind: number, arg: number, ctx: EventFocusCtx): EventTarget {
  switch (kind) {
    case 5: // WandererJoined
    case 6: // ColonistBreak
    case 8: // ColonistDowned
    case 9: // ColonistRescued
    case 10: // ColonistTended
    case 19: // BoarAttacks
    case 23: // Illness
    case 32: // Quarrel
    case 33: // Brawl
    case 34: // FriendLost
    case 35: // TrapSprung
      return pawnTarget(arg, ctx);
    case 26: // TraderVisit
    case 27: // TraderAngered
    case 29: // TraderDied
      return traderTarget(ctx);
    case 1: // Raid
    case 21: {
      // RaidIncoming
      const raider = ctx.firstPawnOfFaction(FACTION_RAIDER);
      return raider ? { kind: "pawn", id: raider.id } : null;
    }
    case 36: {
      // FireStarted
      const tile = ctx.firstBurningTile();
      return tile ? { kind: "tile", x: tile.x, y: tile.y } : null;
    }
    default:
      return null;
  }
}
