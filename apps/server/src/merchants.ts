/**
 * Les marchands itinérants du globe : des caravanes marchandes **PNJ** qui
 * circulent de colonie en colonie et s'arrêtent un jour de monde à chaque
 * étape. Voir `docs/protocol.md` §13.
 *
 * Ils sont **100 % serveur** : aucun client ne les crée, ne les déplace ni ne
 * les fait visiter, et rien de ce qu'un client envoie ne les touche. La seule
 * chose qui en sort vers un client est un `trader_arrival` adressé à l'hôte de
 * la colonie visitée, à charge pour lui d'émettre `Command::TriggerTraderVisit`
 * en lockstep — le serveur ne simule toujours pas.
 *
 * `MerchantRegistry` est **pure** : pas de réseau, pas de disque, pas de timer.
 * Elle ne connaît le temps que par la fonction `hours()` qu'on lui injecte (les
 * heures de jeu du monde, `WorldClock`) et les colonies que par `settlements()`.
 *
 * Comme pour les caravanes des joueurs (`caravans.ts`), **rien n'est incrémenté
 * à chaque tick** : l'avancement se dérive de `departedAt`, `arrivesAt` et de
 * l'heure courante. Un serveur qui redémarre reprend donc exactement où il en
 * était, sans rattrapage ni dérive, et deux diffusions à la même heure de jeu
 * donnent la même vue.
 *
 * Le tirage (nom de compagnie, case de naissance) passe par le RNG déterministe
 * de `@rimlike/world` : un identifiant de marchand donne toujours le même flux,
 * dérivé de la graine du globe, donc rien de son état aléatoire n'a besoin
 * d'être persisté — seul le compteur d'identifiants l'est.
 */

import { MERCHANT_COUNT, MERCHANT_STAY_HOURS, type Merchant, type MerchantStatus } from "@rimlike/protocol";
import { createRng, deriveSeed, findRoute, movementCost, type World } from "@rimlike/world";

/**
 * Noms de compagnie tirés à la naissance d'un marchand. Une petite liste
 * suffit : deux marchands sur le même globe se croisent rarement, et un doublon
 * ne prête à aucune confusion (l'identité est `id`, jamais le nom).
 */
export const MERCHANT_COMPANY_NAMES: readonly string[] = [
  "Compagnie du Levant",
  "Comptoir des Cimes",
  "Caravane du Sel",
  "Maison Vaubert",
  "Convoi des Trois Rivières",
  "Guilde des Colporteurs",
  "Attelage du Nord",
  "Frères Malbec",
];

/**
 * Sel du RNG des marchands : décorrèle leur tirage de tout autre usage de la
 * graine du globe (élévation, humidité…), qui a déjà le sien.
 */
const MERCHANT_SALT = 0x4d_41_52_43;

/** Une arrivée à annoncer : exactement la charge d'un `trader_arrival`. */
export interface MerchantArrival {
  readonly merchantId: string;
  readonly merchantName: string;
  /** Case d'arrivée, qui porte forcément une colonie au moment de l'arrivée. */
  readonly tile: number;
}

/** Ce que fait un tick de monde du côté des marchands. */
export interface MerchantTickResult {
  /** Les marchands qui viennent d'atteindre une colonie, dans l'ordre de naissance. */
  readonly arrivals: readonly MerchantArrival[];
  /** Vrai si quoi que ce soit a changé (naissance, départ, arrivée, fin de séjour). */
  readonly changed: boolean;
}

/** Forme JSON d'un marchand : son état interne, tel quel. */
export interface MerchantJson {
  readonly id: string;
  readonly name: string;
  /** Case de départ du trajet en cours, ou case de séjour quand il visite. */
  readonly fromTile: number;
  readonly toTile: number;
  readonly route: readonly number[];
  readonly departedAt: number;
  readonly arrivesAt: number;
  readonly status: MerchantStatus;
  /** Heure de jeu de fin de séjour, `null` hors visite. */
  readonly visitEndsAt: number | null;
  /** Colonies visitées depuis la naissance, pour le journal et le diagnostic. */
  readonly visits: number;
}

export interface MerchantRegistryJson {
  /** Prochain numéro d'identifiant : les identifiants ne se réutilisent pas. */
  readonly nextId: number;
  readonly merchants: readonly MerchantJson[];
}

export interface MerchantRegistryOptions {
  readonly world: World;
  /** Heures de jeu écoulées depuis la création du monde. */
  readonly hours: () => number;
  /** Cases des colonies fondées, à lire à chaque tick. L'ordre fixe le départage. */
  readonly settlements: () => readonly number[];
  /** Marchands entretenus en permanence. Défaut : `MERCHANT_COUNT` ; 0 en supprime tout. */
  readonly count?: number;
  /** Durée d'un séjour, en heures de jeu. Défaut : `MERCHANT_STAY_HOURS`. */
  readonly stayHours?: number;
}

/** État interne, mutable : la vue diffusée est recalculée à la demande. */
interface StoredMerchant {
  readonly id: string;
  readonly name: string;
  fromTile: number;
  toTile: number;
  route: number[];
  departedAt: number;
  arrivesAt: number;
  status: MerchantStatus;
  visitEndsAt: number | null;
  visits: number;
}

/** Un marchand qui n'a aucune colonie où aller attend sur place. */
function isWaiting(merchant: StoredMerchant): boolean {
  return merchant.status === "travelling" && merchant.toTile === merchant.fromTile;
}

export class MerchantRegistry {
  private readonly world: World;
  private readonly hours: () => number;
  private readonly settlements: () => readonly number[];
  private readonly countTarget: number;
  private readonly stayHours: number;
  /** Cases terrestres du globe, calculées une fois : la naissance y pioche. */
  private readonly landTiles: readonly number[];
  /** Marchands par identifiant, dans leur ordre de naissance (`Map` ordonnée). */
  private readonly merchants = new Map<string, StoredMerchant>();
  private nextId = 1;

  constructor(options: MerchantRegistryOptions) {
    this.world = options.world;
    this.hours = options.hours;
    this.settlements = options.settlements;
    const count = options.count ?? MERCHANT_COUNT;
    if (!Number.isInteger(count) || count < 0) {
      throw new RangeError("count doit être un entier >= 0");
    }
    this.countTarget = count;
    const stayHours = options.stayHours ?? MERCHANT_STAY_HOURS;
    if (!Number.isFinite(stayHours) || stayHours < 0) {
      throw new RangeError("stayHours doit être un nombre >= 0");
    }
    this.stayHours = stayHours;
    this.landTiles = this.world.tiles
      .filter((tile) => movementCost(tile.biome) !== null)
      .map((tile) => tile.id);
  }

  /** Marchands vivants sur ce globe. */
  get count(): number {
    return this.merchants.size;
  }

  /** Marchands entretenus par ce serveur (`WORLD_MERCHANTS`). */
  get target(): number {
    return this.countTarget;
  }

  /** Vrai si au moins un marchand est en chemin, donc si son avancement change. */
  get hasMoving(): boolean {
    for (const merchant of this.merchants.values()) {
      if (merchant.status === "travelling" && !isWaiting(merchant)) {
        return true;
      }
    }
    return false;
  }

  /** Tous les marchands, dans l'ordre de naissance. */
  list(): Merchant[] {
    const now = this.hours();
    return [...this.merchants.values()].map((merchant) => this.view(merchant, now));
  }

  get(id: string): Merchant | undefined {
    const merchant = this.merchants.get(id);
    return merchant === undefined ? undefined : this.view(merchant, this.hours());
  }

  /**
   * Un tick de monde : entretenir la population, faire arriver ce qui devait
   * arriver, relancer ce qui a fini sa visite, et retenter une destination pour
   * ceux qui attendaient faute de colonie.
   */
  tick(): MerchantTickResult {
    const now = this.hours();
    const arrivals: MerchantArrival[] = [];
    let changed = false;

    // Population : on complète, et on retire l'excédent d'un `WORLD_MERCHANTS`
    // revu à la baisse entre deux démarrages (les plus jeunes d'abord).
    while (this.merchants.size < this.countTarget && this.spawn(now) !== null) {
      changed = true;
    }
    while (this.merchants.size > this.countTarget) {
      const last = [...this.merchants.keys()].at(-1)!;
      this.merchants.delete(last);
      changed = true;
    }

    const settled = new Set(this.settlements());
    for (const merchant of this.merchants.values()) {
      if (merchant.status === "visiting") {
        if (merchant.visitEndsAt !== null && now >= merchant.visitEndsAt) {
          this.leave(merchant, now);
          changed = true;
        }
        continue;
      }
      if (isWaiting(merchant)) {
        // Aucune colonie où aller la dernière fois : on retente à chaque tick.
        if (this.leave(merchant, now)) {
          changed = true;
        }
        continue;
      }
      if (now < merchant.arrivesAt) {
        continue;
      }
      const tile = merchant.toTile;
      merchant.fromTile = tile;
      merchant.route = [tile];
      merchant.departedAt = now;
      merchant.arrivesAt = now;
      changed = true;
      if (settled.has(tile)) {
        merchant.status = "visiting";
        merchant.visitEndsAt = now + this.stayHours;
        merchant.visits += 1;
        arrivals.push({ merchantId: merchant.id, merchantName: merchant.name, tile });
      } else {
        // La colonie a été abandonnée pendant le trajet : personne à qui
        // vendre, on repart sans s'arrêter (et sans annoncer d'arrivée).
        merchant.visitEndsAt = null;
        this.leave(merchant, now);
      }
    }
    return { arrivals, changed };
  }

  /** État complet : c'est ce que `WorldState` fait écrire (`docs/protocol.md` §13). */
  toJSON(): MerchantRegistryJson {
    return {
      nextId: this.nextId,
      merchants: [...this.merchants.values()].map((merchant) => ({
        id: merchant.id,
        name: merchant.name,
        fromTile: merchant.fromTile,
        toTile: merchant.toTile,
        route: [...merchant.route],
        departedAt: merchant.departedAt,
        arrivesAt: merchant.arrivesAt,
        status: merchant.status,
        visitEndsAt: merchant.visitEndsAt,
        visits: merchant.visits,
      })),
    };
  }

  /**
   * Remplace le contenu par celui d'une sauvegarde. Une entrée incohérente
   * (case disparue, statut inconnu, itinéraire vide) est **ignorée**, pas levée
   * : un marchand est un PNJ jetable, il renaît au prochain tick — mettre tout
   * le fichier du monde en quarantaine (donc perdre des colonies) pour lui
   * serait hors de proportion. C'est la différence avec `CaravanRegistry`, dont
   * chaque entrée porte le manifeste d'un joueur.
   */
  restore(json: MerchantRegistryJson): void {
    this.merchants.clear();
    for (const entry of json.merchants) {
      if (entry.status !== "travelling" && entry.status !== "visiting") {
        continue;
      }
      if (!this.hasTile(entry.fromTile) || !this.hasTile(entry.toTile)) {
        continue;
      }
      if (!Array.isArray(entry.route) || entry.route.length === 0 || !entry.route.every((id) => this.hasTile(id))) {
        continue;
      }
      if (!Number.isFinite(entry.departedAt) || !Number.isFinite(entry.arrivesAt)) {
        continue;
      }
      this.merchants.set(entry.id, {
        id: entry.id,
        name: entry.name,
        fromTile: entry.fromTile,
        toTile: entry.toTile,
        route: [...entry.route],
        departedAt: entry.departedAt,
        arrivesAt: entry.arrivesAt,
        status: entry.status,
        visitEndsAt: typeof entry.visitEndsAt === "number" ? entry.visitEndsAt : null,
        visits: Number.isInteger(entry.visits) && entry.visits >= 0 ? entry.visits : 0,
      });
    }
    this.nextId = Math.max(json.nextId, this.merchants.size + 1);
  }

  // --- Interne ---

  private hasTile(tileId: number): boolean {
    return Number.isInteger(tileId) && tileId >= 0 && tileId < this.world.tiles.length;
  }

  /**
   * Fait naître un marchand sur une case terrestre **libre**, tirée avec le RNG
   * du globe. Le flux est dérivé de `(graine du globe, numéro du marchand)` :
   * deux serveurs partis du même fichier font naître les mêmes compagnies.
   * `null` si le globe n'a aucune case terrestre (impossible en pratique).
   */
  private spawn(now: number): StoredMerchant | null {
    if (this.landTiles.length === 0) {
      return null;
    }
    const index = this.nextId++;
    const rng = createRng(deriveSeed(this.world.seed, MERCHANT_SALT + index));
    const name = rng.pick(MERCHANT_COMPANY_NAMES);
    const settled = new Set(this.settlements());
    const free = this.landTiles.filter((id) => !settled.has(id));
    // Un globe entièrement colonisé n'existera jamais, mais on ne tire pas
    // dans un tableau vide : la case de naissance retombe alors sur la terre.
    const tile = rng.pick(free.length > 0 ? free : this.landTiles);
    const merchant: StoredMerchant = {
      id: `m${index}`,
      name,
      fromTile: tile,
      toTile: tile,
      route: [tile],
      departedAt: now,
      arrivesAt: now,
      status: "travelling",
      visitEndsAt: null,
      visits: 0,
    };
    this.merchants.set(merchant.id, merchant);
    // Une destination tout de suite s'il y a déjà une colonie ; sinon il
    // attend sur place et retentera au prochain tick.
    this.leave(merchant, now);
    return merchant;
  }

  /**
   * Colonies joignables à pied depuis `from`, par un simple parcours du graphe
   * des voisins terrestres. C'est le court-circuit de `leave` : sur un globe où
   * aucune colonie n'est sur le continent du marchand, un `findRoute` par
   * colonie explorerait tout ce continent **pour chacune**, à chaque tick du
   * monde, alors qu'un seul parcours répond pour toutes. L'A* ne sert plus
   * qu'à mesurer la durée des trajets qui existent vraiment.
   */
  private reachableSettlements(from: number): number[] {
    const wanted = new Set(this.settlements());
    if (wanted.size === 0) {
      return [];
    }
    const tiles = this.world.tiles;
    const seen = new Uint8Array(tiles.length);
    const queue: number[] = [from];
    const found: number[] = [];
    seen[from] = 1;
    for (let head = 0; head < queue.length; head += 1) {
      const current = queue[head]!;
      if (current !== from && wanted.has(current)) {
        found.push(current);
      }
      for (const neighbor of tiles[current]!.neighbors) {
        if (seen[neighbor] === 1 || movementCost(tiles[neighbor]!.biome) === null) {
          continue;
        }
        seen[neighbor] = 1;
        queue.push(neighbor);
      }
    }
    return found;
  }

  /**
   * Met le marchand en route vers la colonie fondée la plus proche, hors celle
   * qu'il quitte. Renvoie faux — et le laisse en attente sur sa case — si
   * aucune colonie n'est joignable par voie terrestre : le globe n'en a
   * peut-être aucune, ou aucune sur son continent.
   */
  private leave(merchant: StoredMerchant, now: number): boolean {
    const from = merchant.fromTile;
    let best: { readonly toTile: number; readonly tiles: number[]; readonly hours: number } | null = null;
    for (const tile of this.reachableSettlements(from)) {
      const route = findRoute(this.world, from, tile);
      if (route === null) {
        continue;
      }
      // Départage stable : la plus proche, puis le plus petit identifiant.
      if (best === null || route.hours < best.hours || (route.hours === best.hours && tile < best.toTile)) {
        best = { toTile: tile, tiles: route.tiles, hours: route.hours };
      }
    }
    merchant.status = "travelling";
    merchant.visitEndsAt = null;
    merchant.departedAt = now;
    if (best === null) {
      merchant.toTile = from;
      merchant.route = [from];
      merchant.arrivesAt = now;
      return false;
    }
    merchant.toTile = best.toTile;
    merchant.route = best.tiles;
    merchant.arrivesAt = now + best.hours;
    return true;
  }

  /**
   * Vue diffusable : `tile` et `progress` sont dérivés du temps, jamais
   * stockés — même interpolation linéaire que `CaravanRegistry.view`. Un
   * marchand en visite est à 1 (il est arrivé), un marchand en attente à 0 (il
   * n'est parti nulle part).
   */
  private view(merchant: StoredMerchant, now: number): Merchant {
    const total = merchant.arrivesAt - merchant.departedAt;
    let progress: number;
    if (merchant.status === "visiting") {
      progress = 1;
    } else if (isWaiting(merchant)) {
      progress = 0;
    } else {
      const raw = total <= 0 ? 1 : (now - merchant.departedAt) / total;
      progress = Math.min(1, Math.max(0, raw));
    }
    const steps = merchant.route.length - 1;
    const index = Math.min(steps, Math.max(0, Math.floor(progress * steps)));
    return {
      id: merchant.id,
      name: merchant.name,
      tile: merchant.route[index]!,
      toTile: merchant.toTile,
      status: merchant.status,
      progress,
    };
  }
}
