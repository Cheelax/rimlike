import type { SimLike } from "../net/SimLike";
import init, { WasmSim, type InitOutput } from "../wasm/sim.js";

/** Entiers par pawn dans le tampon `pawns()` ; seul l'id (offset 0) sert ici (`sim-wasm::PAWN_STRIDE`). */
const PAWN_STRIDE = 12;

/**
 * L'init wasm-bindgen n'est pas idempotente si elle est appelée deux fois en
 * parallèle (deux instances, deux mémoires, la seconde écrase la globale).
 * React StrictMode monte deux fois : on mémoïse la promesse.
 */
let initPromise: Promise<InitOutput> | undefined;
function initOnce(): Promise<InitOutput> {
  initPromise ??= init();
  return initPromise;
}

/**
 * Initialise le WASM du thread courant, sans créer de sim.
 *
 * Le Worker le fait implicitement en créant son sim. Le thread principal, lui,
 * n'a plus de sim mais garde besoin du module : les `encode*` de
 * `sim/commands.ts` sont des fonctions du WASM. Une instance qui ne sert qu'à
 * encoder ne coûte que les quelques pages initiales de mémoire.
 */
export function initSim(): Promise<InitOutput> {
  return initOnce();
}

/**
 * Enveloppe fine autour du sim WASM. Garde une référence à la mémoire pour
 * construire des vues zéro-copie sur l'état. Les vues (`tiles`, `features`,
 * `zones`, `designations`) ne doivent pas être conservées entre deux appels
 * au sim ; `pawns` et `items` renvoient des copies.
 *
 * Implémente `SimLike` : c'est par ce contrat que la couche réseau le pilote.
 */
export class SimHandle implements SimLike {
  private constructor(
    private readonly wasm: InitOutput,
    private readonly inner: WasmSim,
  ) {}

  static async create(opts: { seed: bigint; width: number; height: number }): Promise<SimHandle> {
    const wasm = await initOnce();
    return new SimHandle(wasm, new WasmSim(opts.seed, opts.width, opts.height));
  }

  static async restore(bytes: Uint8Array): Promise<SimHandle> {
    const wasm = await initOnce();
    return new SimHandle(wasm, WasmSim.restore(bytes));
  }

  get width(): number {
    return this.inner.width();
  }

  get height(): number {
    return this.inner.height();
  }

  step(n: number): void {
    this.inner.step(n);
  }

  /**
   * Met en attente une commande encodée (voir `sim/commands.ts`). Seul chemin
   * des actions du joueur, en solo comme en multi. Lève si les octets ne sont
   * pas une commande valide.
   */
  applyEncoded(bytes: Uint8Array): void {
    this.inner.apply_encoded(bytes);
  }

  /** Commandes en attente du prochain `step`. */
  pendingLen(): number {
    return this.inner.pending_len();
  }

  moveTo(pawn: number, x: number, y: number): void {
    this.inner.move_to(pawn, x, y);
  }

  designate(kind: number, x0: number, y0: number, x1: number, y1: number): void {
    this.inner.designate(kind, x0, y0, x1, y1);
  }

  setZone(zone: number, x0: number, y0: number, x1: number, y1: number): void {
    this.inner.set_zone(zone, x0, y0, x1, y1);
  }

  build(kind: number, material: number, x0: number, y0: number, x1: number, y1: number): void {
    this.inner.build(kind, material, x0, y0, x1, y1);
  }

  cancelBuild(x0: number, y0: number, x1: number, y1: number): void {
    this.inner.cancel_build(x0, y0, x1, y1);
  }

  attack(pawn: number, target: number): void {
    this.inner.attack(pawn, target);
  }

  /** `work` suit `sim::WorkType`, `priority` : 1 haute … 4 basse, 0 désactivé. */
  setPriority(pawn: number, work: number, priority: number): void {
    this.inner.set_priority(pawn, work, priority);
  }

  triggerRaid(): void {
    this.inner.trigger_raid();
  }

  /**
   * Fait venir un marchand tout de suite (débogage, comme `triggerRaid`). En
   * multi, passe par `encodeTriggerTraderVisit` puis `issue`.
   */
  triggerTraderVisit(): void {
    this.inner.trigger_trader_visit();
  }

  /**
   * Règle la dose de menace du storyteller (`sim::storyteller::Difficulty` :
   * 0 paisible, 1 facile, 2 normal, 3 difficile). Outil de dev/console : en
   * multi, cette commande doit passer par `encodeSetDifficulty` puis `issue`,
   * jamais être appliquée directement (comme `triggerRaid`).
   */
  setDifficulty(level: number): void {
    this.inner.set_difficulty(level);
  }

  /** Dose de menace courante, suivant `sim::storyteller::Difficulty`. */
  difficulty(): number {
    return this.inner.difficulty();
  }

  /**
   * Richesse de la colonie (`sim::Sim::wealth`), en cache côté sim : la lire
   * ne coûte rien et ne désynchronise rien.
   */
  wealth(): number {
    return this.inner.wealth();
  }

  /**
   * Ticks de maladie restants pour un pawn ; 0 s'il va bien ou si l'id est
   * inconnu. Hors du tampon des pawns, comme `pawnWeapon` : `PAWN_STRIDE` ne
   * bouge pas.
   */
  pawnSick(id: number): number {
    return this.inner.pawn_sick(id);
  }

  /**
   * Marque (`on`) ou démarque un animal comme gibier. Outil de dev/console,
   * comme `triggerRaid` : en multi, cette commande doit passer par
   * `encodeHunt` puis `issue`, jamais être appliquée directement.
   */
  hunt(animal: number, on: boolean): void {
    this.inner.hunt(animal, on);
  }

  /**
   * Espèce d'un pawn, suivant `sim::animals::Species` (0 cerf, 1 lapin,
   * 2 sanglier). -1 : ce n'est pas un animal, ou l'id est inconnu. Une bête
   * **apprivoisée** garde son espèce : `pawn_species(id) >= 0` avec une
   * faction 0 dans le tampon `pawns` la distingue d'un colon (`sim::livestock`).
   */
  pawnSpecies(id: number): number {
    return this.inner.pawn_species(id);
  }

  /**
   * Marque (`on`) ou démarque une bête **sauvage** pour l'apprivoisement,
   * exclusif de la chasse. Outil de dev/console, comme `hunt` : en multi,
   * cette commande doit passer par `encodeTame` puis `issue`, jamais être
   * appliquée directement.
   */
  tame(animal: number, on: boolean): void {
    this.inner.tame(animal, on);
  }

  /**
   * Marque une bête **de la colonie** pour l'abattoir ; refusée en silence
   * sur une bête sauvage, et le marquage ne se retire pas. Outil de
   * dev/console, comme `hunt` : en multi, cette commande doit passer par
   * `encodeSlaughter` puis `issue`, jamais être appliquée directement.
   */
  slaughter(animal: number): void {
    this.inner.slaughter(animal);
  }

  /**
   * Bêtes de la colonie vivantes, tous genres confondus (`sim::livestock`).
   * Le détail par espèce se lit dans le tampon `animals` croisé avec la
   * faction du tampon `pawns` (voir `AGENTS.md`).
   */
  livestockCount(): number {
    return this.inner.livestock_count();
  }

  /**
   * Objectif de fabrication d'un genre (`sim::ItemKind` 6 gourdin, 7 épieu,
   * 8 arc, 14 tunique, 15 manteau, 17 lingot, 18 épée). Un genre sans recette
   * est ignoré par le sim.
   */
  setCraftTarget(kind: number, target: number): void {
    this.inner.set_craft_target(kind, target);
  }

  /** Objectifs de fabrication courants, indexés par `ItemKind` (19 entrées). */
  craftTargets(): Uint32Array {
    return this.inner.craft_targets();
  }

  /** Arme équipée d'un pawn, suivant `sim::ItemKind`. -1 : à mains nues, ou id inconnu. */
  pawnWeapon(id: number): number {
    return this.inner.pawn_weapon(id);
  }

  /**
   * Habit porté d'un pawn, suivant `sim::ItemKind` (14 tunique, 15 manteau).
   * -1 : le dos nu, ou id inconnu.
   */
  pawnApparel(id: number): number {
    return this.inner.pawn_apparel(id);
  }

  /** Compétences de combat d'un pawn : `[niveau mêlée, xp, niveau tir, xp]`. Vide si l'id est inconnu. */
  pawnCombatSkills(id: number): Int32Array {
    return this.inner.pawn_combat_skills(id);
  }

  /**
   * Arme équipée de chaque pawn armé, aplatie : `[id, genre]` par pawn qui en
   * porte une. Pas de méthode dédiée côté sim-wasm : le nombre de pawns reste
   * petit (`AGENTS.md`), une recherche par id suffit à chaque frame.
   */
  weapons(): Int32Array {
    const pawns = this.pawns();
    const out: number[] = [];
    for (let o = 0; o + PAWN_STRIDE <= pawns.length; o += PAWN_STRIDE) {
      const id = pawns[o];
      const weapon = this.inner.pawn_weapon(id);
      if (weapon >= 0) out.push(id, weapon);
    }
    return Int32Array.from(out);
  }

  /**
   * Habit de chaque pawn habillé, aplatie : `[id, genre]` par pawn qui en
   * porte un (`sim::ItemKind` 14 tunique, 15 manteau). Même limite que
   * `weapons()` : pas de méthode dédiée côté sim-wasm, une recherche par id
   * suffit tant que le nombre de pawns reste petit.
   */
  apparel(): Int32Array {
    const pawns = this.pawns();
    const out: number[] = [];
    for (let o = 0; o + PAWN_STRIDE <= pawns.length; o += PAWN_STRIDE) {
      const id = pawns[o];
      const kind = this.inner.pawn_apparel(id);
      if (kind >= 0) out.push(id, kind);
    }
    return Int32Array.from(out);
  }

  /**
   * Traits de caractère d'un pawn, suivant `sim::Trait` (0 à 11). 0, 1 ou 2
   * valeurs ; vide si l'id est inconnu ou le pawn n'en a pas (pillards,
   * bêtes).
   */
  pawnTraits(id: number): Int32Array {
    return this.inner.pawn_traits(id);
  }

  /**
   * Traits de chaque colon, aplatis : `[id, t0, t1]` par pawn du tampon
   * `pawns` (`-1` quand un trait est absent). Même limite que
   * `weapons`/`apparel` : pas de méthode dédiée côté sim-wasm, une recherche
   * par id suffit tant que le nombre de pawns reste petit. Contrairement à
   * `weapons`/`apparel`, une ligne existe pour chaque pawn (stride fixe de 3),
   * pas seulement pour ceux qui portent quelque chose : un colon sans trait
   * doit rester distinguable d'un pillard ou d'une bête absent du tampon.
   */
  traits(): Int32Array {
    const pawns = this.pawns();
    const out: number[] = [];
    for (let o = 0; o + PAWN_STRIDE <= pawns.length; o += PAWN_STRIDE) {
      const id = pawns[o];
      const t = this.inner.pawn_traits(id);
      out.push(id, t.length > 0 ? t[0]! : -1, t.length > 1 ? t[1]! : -1);
    }
    return Int32Array.from(out);
  }

  /**
   * Avance rapide abstraite d'une colonie gelée (`docs/protocol.md` §11.6).
   * Réservée au solo et au crochet de dev : en multi la commande passe par
   * `encodeFastForward` puis `issue`, jamais appliquée localement.
   */
  fastForward(ticks: number): void {
    this.inner.fast_forward(ticks);
  }

  // --- Commerce (`crates/sim/src/trade.rs`) ---

  /**
   * Id du marchand avec qui on peut traiter, −1 s'il n'y en a pas (parti,
   * devenu hostile, ou jamais venu). Sa position, son nom et sa santé se
   * lisent dans les tampons habituels : c'est un pawn de faction 3.
   */
  traderPresent(): number {
    return this.inner.trader_present();
  }

  /** Ticks avant que le marchand ne reprenne la route ; 0 s'il n'y en a pas. */
  traderLeavesIn(): number {
    return this.inner.trader_leaves_in();
  }

  /**
   * Étal du marchand, à plat : `[genre, quantité, prix unitaire de vente] × n`
   * par lot. Vide s'il n'y a personne à qui parler.
   */
  traderOffers(): Int32Array {
    return this.inner.trader_offers();
  }

  /**
   * Prix unitaire d'achat par genre, indexé par `ItemKind` (19 entrées) : ce
   * que la colonie touche en cédant une unité. Indépendant de la présence du
   * marchand.
   */
  buyPrices(): Uint32Array {
    return this.inner.buy_prices();
  }

  /**
   * Troque avec le marchand présent : `giveCount` unités de `give` prélevées
   * en stockage contre `takeCount` unités de `take` posées au sol près de lui.
   * Les genres suivent `sim::ItemKind`. Outil de dev/console, comme `hunt` : en
   * multi, cette commande doit passer par `encodeTrade` puis `issue`, jamais
   * être appliquée directement. Un troc refusé par le sim est silencieux
   * (voir `apps/client/src/trade.ts::tradeBalance` pour prévalider côté UI).
   */
  trade(give: number, giveCount: number, take: number, takeCount: number): void {
    this.inner.trade(give, giveCount, take, takeCount);
  }

  // --- Factions PNJ (`crates/sim/src/factions.rs`) ---

  /**
   * Réputation de la colonie auprès des trois factions PNJ, dans l'ordre des
   * ids (0 Clan des Cendres, 1 Fraternité du Fer, 2 Guilde des Colporteurs).
   * Bornée à −100..=100 ; sous −50 la faction est hostile, à partir de +50
   * elle est alliée (`apps/client/src/factions.ts::relationLabel`).
   */
  goodwill(): Int32Array {
    return this.inner.goodwill();
  }

  /** Tribu du dernier raid, −1 si aucune (`sim::factions::Sim::last_raid_faction`). */
  lastRaidFaction(): number {
    return this.inner.last_raid_faction();
  }

  /**
   * Offre un tribut à une faction PNJ : `count` unités de `kind`
   * (`sim::ItemKind`) sont prélevées en stockage, la réputation monte à
   * proportion de leur valeur (`factions.ts::giftGain` pour une estimation
   * côté client). Le sim ignore la commande en silence si la faction est
   * inconnue, la quantité nulle ou le stock insuffisant : relire `goodwill()`
   * après coup pour savoir ce qu'elle a rapporté, comme `trade`. Outil de
   * dev/console : en multi, cette commande doit passer par `encodeGift` puis
   * `issue`, jamais être appliquée directement.
   */
  gift(faction: number, kind: number, count: number): void {
    this.inner.gift(faction, kind, count);
  }

  // --- Recherche (`crates/sim/src/research.rs`) ---

  /**
   * Choisit la technologie cherchée (`sim::research::Tech` : 0 agriculture,
   * 1 médecine, 2 conservation, 3 archerie, 4 maçonnerie), ou 255 pour ne
   * plus rien chercher. Outil de dev/console, comme `setDifficulty` : en
   * multi, cette commande doit passer par `encodeSetResearch` puis `issue`,
   * jamais être appliquée directement.
   */
  setResearch(tech: number): void {
    this.inner.set_research(tech);
  }

  /**
   * Où en est la recherche : `[courante, (avancement, coût, acquise) × 6]`,
   * 19 entiers (`sim::research::Tech::COUNT` = 6). `courante` vaut 255 quand
   * la colonie ne cherche rien ; voir `apps/client/src/research.ts::decodeResearch`.
   */
  researchState(): Uint32Array {
    return this.inner.research_state();
  }

  // --- Caravanes (docs/protocol.md §12) ---

  /**
   * Forme une caravane : les colons choisis quittent la carte, les
   * marchandises sont prélevées en stockage, et le manifeste encodé entre dans
   * la file des départs. `itemKinds` suit `sim::ItemKind`, apparié avec
   * `itemCounts` dans l'ordre.
   *
   * En multi, c'est `encodeFormCaravan` qui sert : cette méthode n'existe que
   * pour le solo et le crochet de dev.
   */
  formCaravan(pawnIds: readonly number[], itemKinds: readonly number[], itemCounts: readonly number[]): void {
    this.inner.form_caravan(Uint32Array.from(pawnIds), Uint8Array.from(itemKinds), Uint32Array.from(itemCounts));
  }

  /** Retire les `count` premiers manifestes de la file des départs. */
  clearDepartures(count: number): void {
    this.inner.clear_departures(count);
  }

  /** Fait entrer un manifeste sur cette carte. */
  arriveCaravan(manifest: Uint8Array): void {
    this.inner.arrive_caravan(manifest);
  }

  /** Manifestes en attente d'expédition vers le serveur monde. */
  departuresCount(): number {
    return this.inner.departures_count();
  }

  /** Copie du manifeste à cet indice, vide si l'indice est hors file. */
  departure(index: number): Uint8Array {
    return this.inner.departure(index);
  }

  /**
   * Résumé d'un manifeste sans décoder le postcard côté TypeScript :
   * `[nb colons, nb genres, genre0, quantité0, …]`, vide si les octets ne sont
   * pas un manifeste lisible.
   *
   * **Statique** : le thread principal résume les manifestes que le Worker lui
   * rend, sans posséder de sim (voir `initSim`).
   */
  static describeManifest(bytes: Uint8Array): Int32Array {
    return WasmSim.describe_manifest(bytes);
  }

  tick(): number {
    return this.inner.tick();
  }

  ticksPerDay(): number {
    return this.inner.ticks_per_day();
  }

  timeOfDay(): number {
    return this.inner.time_of_day();
  }

  /** Météo courante, suivant `sim::Weather`. */
  weather(): number {
    return this.inner.weather();
  }

  /**
   * Impose le climat de la carte (moyenne annuelle et écart saisonnier, en
   * dixièmes de degré). Outil de dev/console : en multi, cette commande doit
   * passer par un `encode*` puis `issue`, jamais être appliquée directement
   * (comme `triggerRaid`, elle pousse dans la file locale du sim).
   */
  setClimate(baseTemperature: number, amplitude: number): void {
    this.inner.set_climate(baseTemperature, amplitude);
  }

  /**
   * Impose le jour de l'année de la carte (`docs/protocol.md` §11.6 « Le
   * calendrier, hérité une fois »). Outil de dev/console, comme `setClimate` :
   * en multi, cette commande doit passer par `encodeSetCalendar` puis
   * `issue`, jamais être appliquée directement.
   */
  setCalendar(dayOfYear: number): void {
    this.inner.set_calendar(dayOfYear);
  }

  /** Saison courante, suivant `sim::climate::Season` (0 printemps … 3 hiver). */
  season(): number {
    return this.inner.season();
  }

  /** Jour de l'année courant, dans `0..yearDays()`. */
  dayOfYear(): number {
    return this.inner.day_of_year();
  }

  /** Jours d'une année de jeu (quatre saisons). */
  yearDays(): number {
    return this.inner.year_days();
  }

  /** Température extérieure de la carte, en dixièmes de degré. */
  outdoorTemperature(): number {
    return this.inner.outdoor_temperature();
  }

  /** Température d'une case, en dixièmes de degré (extérieure, plus l'intérieur). */
  tileTemperature(x: number, y: number): number {
    return this.inner.tile_temperature(x, y);
  }

  /**
   * Température de chaque case de la carte, en dixièmes de degré : un appel
   * `tile_temperature` par case. Coûteux (16 384 appels WASM sur une carte
   * 128×128) : réservé au mode d'affichage « Chaleur », à appeler au plus
   * quelques fois par seconde (voir `App.tsx`), jamais à chaque frame.
   */
  tileTemperatures(): Int32Array {
    const out = new Int32Array(this.width * this.height);
    let i = 0;
    for (let y = 0; y < this.height; y++) {
      for (let x = 0; x < this.width; x++) {
        out[i++] = this.inner.tile_temperature(x, y);
      }
    }
    return out;
  }

  /** Température ressentie par un pawn, en dixièmes de degré. 0 si l'id est inconnu. */
  pawnComfort(id: number): number {
    return this.inner.pawn_comfort(id);
  }

  /** Change à chaque recalcul effectif de la couche « intérieur » (`indoor`). */
  indoorVersion(): number {
    return this.inner.indoor_version();
  }

  /** Couche « intérieur » : un octet par case, 0 dehors, sinon le numéro de pièce. */
  indoor(): Uint8Array {
    return this.view8(this.inner.indoor_ptr());
  }

  /** Change à chaque changement d'intensité du feu (`sim::fire`). */
  fireVersion(): number {
    return this.inner.fire_version();
  }

  /** Cases en feu, à zéro s'il n'y a aucun incendie : rien à dessiner. */
  fireCount(): number {
    return this.inner.fire_count();
  }

  /** Couche « feu » : un octet par case, 0 éteint, sinon l'intensité de 1 à 3. */
  fire(): Uint8Array {
    return this.view8(this.inner.fire_ptr());
  }

  /**
   * Met le feu à une case (débogage et outil du joueur). Sans effet si la
   * case est hors carte, brûle déjà, ou ne porte aucun combustible. Outil de
   * dev/console, comme `hunt` : en multi, cette commande doit passer par
   * `encodeIgnite` puis `issue`, jamais être appliquée directement.
   */
  ignite(x: number, y: number): void {
    this.inner.ignite(x, y);
  }

  hash(): string {
    return this.inner.hash();
  }

  mapVersion(): number {
    return this.inner.map_version();
  }

  overlayVersion(): number {
    return this.inner.overlay_version();
  }

  storedTotals(): Uint32Array {
    return this.inner.stored_totals();
  }

  /**
   * Fraîcheur d'une pile, en ‰ restant (1000 à sa création, 0 juste avant de
   * disparaître) ; −1 si son genre ne périme pas ou si l'id est inconnu.
   * Sert à `SimRunner.foodFreshnessOf` (voir `worker/SimRunner.ts`).
   */
  itemFreshness(id: number): number {
    return this.inner.item_freshness(id);
  }

  snapshot(): Uint8Array {
    return this.inner.snapshot();
  }

  private view8(ptr: number): Uint8Array {
    return new Uint8Array(this.wasm.memory.buffer, ptr, this.inner.tiles_len());
  }

  tiles(): Uint8Array {
    return this.view8(this.inner.tiles_ptr());
  }

  features(): Uint8Array {
    return this.view8(this.inner.features_ptr());
  }

  zones(): Uint8Array {
    return this.view8(this.inner.zones_ptr());
  }

  designations(): Uint8Array {
    return this.view8(this.inner.designations_ptr());
  }

  pawns(): Int32Array {
    return new Int32Array(new Int32Array(this.wasm.memory.buffer, this.inner.pawns_ptr(), this.inner.pawns_len()));
  }

  items(): Int32Array {
    return new Int32Array(new Int32Array(this.wasm.memory.buffer, this.inner.items_ptr(), this.inner.items_len()));
  }

  blueprints(): Int32Array {
    return new Int32Array(
      new Int32Array(this.wasm.memory.buffer, this.inner.blueprints_ptr(), this.inner.blueprints_len()),
    );
  }

  events(): Int32Array {
    return new Int32Array(new Int32Array(this.wasm.memory.buffer, this.inner.events_ptr(), this.inner.events_len()));
  }

  /** Priorités de travail : `[id, p0..p5]` par colon. Copie. */
  priorities(): Int32Array {
    return new Int32Array(
      new Int32Array(this.wasm.memory.buffer, this.inner.priorities_ptr(), this.inner.priorities_len()),
    );
  }

  /** Compétences : `[id, (niveau, xp)×6]` par colon. Copie. */
  skills(): Int32Array {
    return new Int32Array(
      new Int32Array(this.wasm.memory.buffer, this.inner.skills_ptr(), this.inner.skills_len()),
    );
  }

  /** Santé : `[id, sang, conscience %, nombre de blessures]` par pawn. Copie. */
  health(): Int32Array {
    return new Int32Array(
      new Int32Array(this.wasm.memory.buffer, this.inner.health_ptr(), this.inner.health_len()),
    );
  }

  /**
   * Faune vivante : `[id, espèce, drapeaux]` par bête, sauvage et apprivoisée
   * (`sim-wasm::ANIMAL_STRIDE`, `render/terrain.ts::ANIMAL_FLAG`). Copie.
   */
  animals(): Int32Array {
    return new Int32Array(
      new Int32Array(this.wasm.memory.buffer, this.inner.animals_ptr(), this.inner.animals_len()),
    );
  }

  /** Nom du colon ou du pillard, chaîne vide si l'id est inconnu. */
  pawnName(id: number): string {
    return this.inner.pawn_name(id);
  }

  /**
   * Blessures d'un pawn, à plat : `[partie, sévérité, saignement, pansée]`
   * par blessure. Copie ponctuelle : à n'appeler que pour le colon
   * sélectionné, pas à chaque frame.
   */
  pawnInjuries(id: number): Int32Array {
    return this.inner.pawn_injuries(id);
  }

  /**
   * Avis de ce colon sur ses camarades (`crates/sim/src/social.rs`), à plat :
   * `[autre, avis] × n`, trié par id, avis dans `-100..=100`. Vide pour un id
   * inconnu ou un non-colon. Copie ponctuelle, comme `pawnInjuries` : à
   * n'appeler que pour le colon sélectionné, pas à chaque frame.
   */
  pawnOpinions(id: number): Int32Array {
    return this.inner.pawn_opinions(id);
  }

  dispose(): void {
    this.inner.free();
  }
}
