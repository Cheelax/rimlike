import { useEffect, useMemo, useRef, useState } from "react";
import { TICKS_PER_DAY, type SettledMessage } from "@rimlike/protocol";
import { BIOME_NAMES, findRoute, type World } from "@rimlike/world";
import { CaravanPanel, type CaravanColonist, type CaravanDestination } from "./CaravanPanel";
import { ColonistBar, type ColonistBadge } from "./ColonistBar";
import { CraftingPanel } from "./CraftingPanel";
import { eventTarget, type EventFocusCtx, type EventTarget } from "./eventFocus";
import { factionDefinite } from "./factions";
import { FactionsPanel } from "./FactionsPanel";
import { HelpPanel } from "./HelpPanel";
import { JournalPanel, type JournalEntry, type JournalFilter } from "./JournalPanel";
import { Minimap, type MinimapHandle } from "./Minimap";
import { decodeResearch, researchPercent, TECH_METALLURGY, TECHS } from "./research";
import { ResearchPanel } from "./ResearchPanel";
import { decodeOpinions, opinionLabel, sortOpinions, type Opinion } from "./social";
import { TradePanel } from "./TradePanel";
import {
  CaravanDispatcher,
  manifestSummary,
  tileOfRoom,
  type DispatchedDeparture,
} from "./net/CaravanDispatcher";
import type { LockstepError, LockstepState } from "./net/LockstepClient";
import { fetchRooms, roomDisplayName, roomDay, roomStateLabel, type RoomInfo } from "./net/roomsFetch";
import { ReconnectingTransport, WebSocketTransport } from "./net/Transport";
import { WorldClient, type WorldClientState } from "./net/WorldClient";
import { fetchWorld, type WorldProgress } from "./net/worldFetch";
import { WorldScreen, type CaravanOrder } from "./WorldScreen";
import {
  HEAT_COLD,
  HEAT_HOT,
  PAWN_COLORS,
  PAWN_FLAGS,
  PAWN_STRIDE,
  Renderer,
  type TilePos,
  type TileRect,
} from "./render/Renderer";
import { acquireGl, type SharedGl } from "./render/gl";
import { DEFAULT_GRAPHICS, effectivePixelRatio, loadGraphics, saveGraphics, type GraphicsSettings } from "./settings";
import {
  ANIMAL_FLAG,
  ANIMAL_STRIDE,
  APPAREL_NAMES,
  BLUEPRINT_STRIDE,
  BUILD_KIND,
  clampCraftTarget,
  DESIGNATION,
  DIFFICULTY,
  DIFFICULTY_LABELS,
  EVENT_STRIDE,
  eventLabel,
  FEATURE,
  formatInjury,
  formatTemperature,
  formatTraderLeaves,
  formatWealth,
  freshnessLevel,
  freshnessPercent,
  hKeyAction,
  HEALTH_STRIDE,
  ITEM_NAMES,
  JOB_LABELS,
  MATERIAL,
  MATERIAL_NAMES,
  PRIORITY_STRIDE,
  SEASON_LABELS,
  sickHoursRemaining,
  SKILL_STRIDE,
  SLAUGHTER_HINT,
  SPECIES_LABELS,
  SPECIES_MAX_HP,
  TAME_HINT,
  TERRAIN,
  TRAIT_HINTS,
  TRAIT_LABELS,
  visibleStock,
  WEAPON_NAMES,
  WEATHER_LABELS,
  WORK_LABELS,
  xpToNext,
  ZONE,
} from "./render/terrain";
import {
  encodeArriveCaravan,
  encodeAttack,
  encodeBuild,
  encodeCancelBuild,
  encodeClearDepartures,
  encodeDesignate,
  encodeFormCaravan,
  encodeGift,
  encodeHunt,
  encodeIgnite,
  encodeMoveTo,
  encodeSetCraftTarget,
  encodeSetDifficulty,
  encodeSetPriority,
  encodeSetResearch,
  encodeSetZone,
  encodeSlaughter,
  encodeTame,
  encodeTrade,
  encodeTriggerRaid,
} from "./sim/commands";
import { initSim, SimHandle } from "./sim/SimHandle";
import { selectInRect, spreadTargets, toggle, type RectPawn } from "./selection";
import { hasSeenHelp, KEY, markHelpSeen } from "./shortcuts";
import { tradeOffers } from "./trade";
import { TOOLS, type Tool } from "./tools";
import { SimBridge } from "./worker/SimBridge";
import type { FrameMessage } from "./worker/protocol";

const CLICK_TOLERANCE_PX = 5;
/** Écart de rendu borné : au retour d'un onglet masqué, la pluie ne bondit pas. */
const MAX_RENDER_DT_MS = 100;
const SAVE_KEY = "rimlike.save.v1";
/** Contrat avec `pawn::Faction` et `pawn::HP_MAX`. */
const FACTION_COLONY = 0;
const FACTION_RAIDER = 1;
const FACTION_ANIMAL = 2;
const FACTION_TRADER = 3;
const HP_MAX = 1000;
/** Durée d'affichage d'une notification. */
const TOAST_MS = 6000;
/** Durée du rappel « Appuyez sur ? pour l'aide » (première partie solo, `shortcuts.ts`). */
const HELP_HINT_MS = 4000;
/** Contrat avec `pawn::Job::code()` : la crise de moral. */
const JOB_BREAK = 14;
/** Le Journal ne garde que les événements les plus récents (mission §3). */
const MAX_JOURNAL_ENTRIES = 200;
/** Couleur du rectangle de sélection multi-colons (Maj + glisser gauche), comme l'anneau de sélection. */
const SELECT_RECT_COLOR = 0xffe066;
/**
 * Éléments infranchissables pour `spreadTargets` (clic droit à plusieurs
 * colons) : même contrat que `map::Feature::passable` côté sim
 * (`crates/sim/src/map.rs`), pas la peine d'y ajouter `Grave`/`SpikeTrap`
 * (franchissables là-bas). N'affecte que le choix d'une case voisine : la
 * marche réelle revient au sim (`MoveTo` pathfinde pour de vrai).
 */
const BLOCKING_FEATURES = new Set<number>([
  FEATURE.Tree,
  FEATURE.Rock,
  FEATURE.WallWood,
  FEATURE.WallStone,
  FEATURE.Campfire,
  FEATURE.CraftingSpot,
  FEATURE.ResearchBench,
  FEATURE.OreRock,
  FEATURE.Forge,
]);

const DEFAULT_SERVER = "ws://localhost:8787";
const DEFAULT_SEED = 42;
const MAP_SIZE = 128;
const MULTI_DISABLED = "indisponible en multijoueur";
/** Période de sondage de `GET /rooms` tant que l'accueil est affiché (§2 du protocole). */
const ROOMS_POLL_MS = 5000;
/** Attente avant de resonder `GET /rooms` après un changement d'adresse de serveur. */
const ROOMS_SERVER_DEBOUNCE_MS = 500;

/** Boutons du menu Options → Graphismes (`GraphicsSettings`, voir `settings.ts`). */
const PIXEL_RATIO_OPTIONS: readonly GraphicsSettings["pixelRatio"][] = ["auto", 1, 1.5, 2];
const PROP_DENSITY_OPTIONS: readonly GraphicsSettings["propDensity"][] = ["haute", "moyenne", "basse"];

/** Étiquette d'humeur, en pourcentage. */
function moodLabel(mood: number): string {
  if (mood >= 70) return "heureux";
  if (mood >= 40) return "bien";
  if (mood >= 20) return "morose";
  return "au bord de la crise";
}

/**
 * Noms des joueurs connus comme déviants (`docs/protocol.md` §7), pour le
 * bandeau de désync : « vous » pour soi-même, le nom d'affichage pour les
 * autres (repli sur l'id si la liste de joueurs n'a pas suivi). Vide sans
 * majorité jamais connue (`outliers` toujours vide à deux joueurs, ou avant
 * trois hashes) : dans ce cas on ne sait pas dire qui diverge.
 */
function outlierNames(net: LockstepState): string {
  if (net.outliers.length === 0) return "on ne sait pas qui";
  return net.outliers
    .map((id) => (id === net.playerId ? "vous" : (net.players.find((p) => p.id === id)?.name ?? `#${id}`)))
    .join(", ");
}

/** Priorité suivante (`dir` 1) ou précédente (`dir` -1) : 1→2→3→4→0→1. */
function nextPriority(p: number, dir: 1 | -1): number {
  if (dir === 1) return p === 0 ? 1 : p === 4 ? 0 : p + 1;
  return p === 1 ? 0 : p === 0 ? 4 : p - 1;
}

const BUILD_TOOL_KIND: Partial<Record<Tool, number>> = {
  wall: BUILD_KIND.Wall,
  door: BUILD_KIND.Door,
  floor: BUILD_KIND.Floor,
  bed: BUILD_KIND.Bed,
  campfire: BUILD_KIND.Campfire,
  craftingSpot: BUILD_KIND.CraftingSpot,
  researchBench: BUILD_KIND.ResearchBench,
  forge: BUILD_KIND.Forge,
  grave: BUILD_KIND.Grave,
  spikeTrap: BUILD_KIND.SpikeTrap,
};
const WOOD_ONLY: ReadonlySet<Tool> = new Set<Tool>(["bed", "campfire", "craftingSpot", "researchBench", "spikeTrap"]);
/** Tombes et forge n'existent qu'en pierre (contrat sim) : jamais le matériau courant du joueur. */
const STONE_ONLY: ReadonlySet<Tool> = new Set<Tool>(["grave", "forge"]);

/** Une ligne de blessure du panneau Santé, depuis `pawn_injuries` (voir `pawnInjuries`). */
interface InjuryInfo {
  part: number;
  severity: number;
  bleeding: number;
  tended: boolean;
}

/** Une ligne de compétence du panneau Compétences, vide pour un pillard. */
interface SkillInfo {
  work: number;
  level: number;
  xp: number;
  xpToNext: number;
}

interface PawnInfo {
  id: number;
  name: string;
  tile: TilePos;
  hunger: number;
  rest: number;
  mood: number;
  moodLabel: string;
  breaking: boolean;
  hp: number;
  hostile: boolean;
  job: string;
  carrying: string | null;
  /** Drapeau `PAWN_FLAGS.DOWNED` : à terre, hors combat. */
  downed: boolean;
  /** Pourcentage 0-100, dérivé de `health::BLOOD_MAX`. */
  blood: number;
  /** Pourcentage 0-100, déjà tel quel côté sim. */
  consciousness: number;
  /** Rafraîchi à part par `rpc("pawnInjuries", id)`, au plus 4 fois par seconde. */
  injuries: InjuryInfo[];
  /** Vide pour un pillard : le tampon `skills` ne les concerne pas. */
  skills: SkillInfo[];
  /**
   * Heures de maladie restantes (`sim-wasm::pawn_sick`, converties par
   * `sickHoursRemaining`), 0 si le colon va bien. Rafraîchie à part par
   * `rpc("pawnSick", id)`, même rythme que les blessures.
   */
  sickHours: number;
  /** Genre d'arme équipée (`sim::ItemKind`), -1 à mains nues. Lu dans `frame.weapons`. */
  weapon: number;
  /** Genre d'habit porté (`sim::ItemKind` 14 tunique, 15 manteau), -1 le dos nu. Lu dans `frame.apparel`. */
  apparel: number;
  /** Traits de caractère (`sim::Trait`, 0 à 11), 0 à 2 valeurs. Lus dans `frame.traits`. */
  traits: number[];
  /** Niveaux de combat, rafraîchis à part par `rpc("pawnCombatSkills", id)`, même rythme que les blessures. */
  meleeLevel: number;
  meleeXp: number;
  rangedLevel: number;
  rangedXp: number;
  /** Température ressentie, en dixièmes de degré, rafraîchie par `rpc("pawnComfort", id)` au même rythme. */
  comfort: number;
  /**
   * Vrai pour une bête **sauvage** (`pawn::Faction::Animal`, lue dans
   * `frame.animals`) : le panneau se réduit à PV/sang/chasse/apprivoisement.
   * Faux pour une bête de la colonie (voir `livestock`).
   */
  animal: boolean;
  /** Espèce (`sim::animals::Species`), -1 si ni `animal` ni `livestock`. */
  species: number;
  /** Marquée gibier (bit `ANIMAL_FLAG.Hunted`), sans effet si `animal` est faux. */
  hunted: boolean;
  /** Marquée pour apprivoisement (bit `ANIMAL_FLAG.TameMarked`), sans effet si `animal` est faux. */
  tameMarked: boolean;
  /**
   * Vrai pour une bête **de la colonie** (faction 0 avec espèce ≥ 0,
   * `sim::livestock::Pawn::is_livestock`) : panneau dédié, bouton Abattre
   * seulement.
   */
  livestock: boolean;
  /** Marquée pour l'abattoir (bit `ANIMAL_FLAG.SlaughterMarked`), sans effet si `livestock` est faux. */
  slaughterMarked: boolean;
  /** Vrai pour le marchand de passage (`pawn::Faction::Trader`) : « Marchand » dans le panneau, bouton Troc. */
  trader: boolean;
  /**
   * Avis sur les camarades (`sim::social::Opinion`), triés par avis
   * décroissant. Rafraîchi à part par `rpc("pawnOpinions", id)`, une fois par
   * seconde (pas au rythme des autres accesseurs ponctuels : un avis ne bouge
   * qu'à la fin d'un bavardage, pas en continu). Vide pour un pillard, un
   * marchand ou une bête.
   */
  relations: Opinion[];
}

interface Stats {
  tick: number;
  day: number;
  hour: string;
  hash: string;
  tps: number;
  fps: number;
  /** Tirages du dernier rendu (`Renderer.drawCalls`), pour le menu Options → Graphismes. */
  drawCalls: number;
  speed: number;
  paused: boolean;
  weather: number;
  /** Saison courante, suivant `sim::climate::Season` (0 printemps … 3 hiver). */
  season: number;
  /** Jour de l'année courant, dans `0..yearDays`. */
  dayOfYear: number;
  /** Jours d'une année de jeu (quatre saisons), constant. */
  yearDays: number;
  /** Température extérieure, en dixièmes de degré (`frame.temperature`). */
  temperature: number;
  stored: number[];
  blueprints: number;
  colonists: number;
  hostiles: number;
  /** Bêtes vivantes (`frame.animals`), ni colons ni ennemis (HUD : « N bêtes »). */
  beasts: number;
  selected: PawnInfo | null;
  /**
   * Sélection courante, ordonnée (voir `selection.ts`) : `selected` ci-dessus
   * en est le premier id (ou l'unique). Surligne toutes les pastilles
   * concernées dans `ColonistBar`, et pilote le panneau « N colons
   * sélectionnés » quand elle en compte plusieurs.
   */
  selection: number[];
  /** Copie du tampon des priorités : `[id, p0..p5]` par colon. */
  priorities: number[];
  /** Nom de chaque pawn vivant, par id (voir `FrameMessage.names`). */
  names: Record<number, string>;
  /** Les colons de la colonie, de quoi composer une caravane. */
  colonistList: CaravanColonist[];
  /** Manifestes de caravane en attente d'expédition (`Sim::departures`). */
  departures: number;
  /** Retard du lockstep, en ticks. Toujours 0 en solo. */
  lag: number;
  /** Objectifs de fabrication courants, indexés par `ItemKind` (`frame.craftTargets`). */
  craftTargets: number[];
  /** Un `Feature::CraftingSpot` existe sur la carte (compté dans `features`). */
  hasCraftingSpot: boolean;
  /**
   * Un `Feature::ResearchBench` existe sur la carte, compté dans `features`
   * au changement de `map_version` seulement (voir `craftingSpotCount`, même
   * schéma). Sans lui, aucun colon ne peut faire avancer une recherche.
   */
  hasResearchBench: boolean;
  /**
   * Un `Feature::Forge` existe sur la carte, compté dans `features` au
   * changement de `map_version`, même schéma que `hasCraftingSpot` et
   * `hasResearchBench`. Sans elle, aucun colon ne peut fondre de lingot.
   */
  hasForge: boolean;
  /** Une pastille par colon de la colonie, pour `ColonistBar` (voir §2 de la mission). */
  colonistBadges: ColonistBadge[];
  /** Ticks d'un jour de jeu (`frame.ticksPerDay`), pour l'horodatage du Journal. */
  ticksPerDay: number;
  /** Dose de menace courante, suivant `render/terrain.ts::DIFFICULTY` (`frame.difficulty`). */
  difficulty: number;
  /** Richesse de la colonie (`frame.wealth`), affichée dans le HUD stock. */
  wealth: number;
  /** Id du marchand présent (`frame.traderPresent`), −1 s'il n'y en a pas. */
  traderPresent: number;
  /** Ticks avant que le marchand ne reprenne la route (`frame.traderLeavesIn`), 0 si absent. */
  traderLeavesIn: number;
  /** Étal du marchand, à plat : `[genre, quantité, prix de vente] × n` (`frame.traderOffers`). */
  traderOffers: number[];
  /** Prix unitaire d'achat par genre, indexé par `ItemKind` (`frame.buyPrices`). */
  buyPrices: number[];
  /**
   * Fraîcheur la plus basse par genre, en ‰ restant, indexée par `ItemKind`
   * (`frame.foodFreshness`) : −1 si aucune pile de ce genre, ou genre non
   * périssable. Pilote la pastille de fraîcheur du HUD stock.
   */
  foodFreshness: number[];
  /**
   * Copie de `frame.researchState` (`sim-wasm::research_state`), 19 entiers :
   * `[courante, (avancement, coût, acquise) × 6]`, décodée par
   * `research.ts::decodeResearch` là où elle sert (HUD, `ResearchPanel`).
   */
  researchState: number[];
  /**
   * Cases en feu (`frame.fireCount`, lui-même `sim-wasm::fire_count`), à zéro
   * s'il n'y a aucun incendie : pilote la ligne rouge « Feu : N case(s) » du
   * HUD. La couche elle-même (les flammes) est portée au Renderer par
   * `SimBridge.onFire`, pas par cet état.
   */
  fireCount: number;
  /**
   * Bêtes de la colonie vivantes (`frame.livestockCount`), tous genres
   * confondus : pilote la ligne « Bétail : N » du HUD, affichée seulement
   * au-dessus de zéro.
   */
  livestockCount: number;
  /**
   * Réputation de la colonie auprès des trois factions PNJ, dans l'ordre des
   * ids (`frame.goodwill`, −100..=100) : voir `FactionsPanel` et
   * `apps/client/src/factions.ts`.
   */
  goodwill: number[];
  /** Tribu du dernier raid (`frame.lastRaidFaction`), −1 si aucune. */
  lastRaidFaction: number;
}

const INITIAL: Stats = {
  tick: 0,
  day: 1,
  hour: "00:00",
  hash: "",
  tps: 0,
  fps: 0,
  drawCalls: 0,
  speed: 1,
  paused: false,
  weather: 0,
  season: 0,
  dayOfYear: 0,
  yearDays: 60,
  temperature: 120,
  stored: new Array(ITEM_NAMES.length).fill(0),
  blueprints: 0,
  colonists: 0,
  hostiles: 0,
  beasts: 0,
  selected: null,
  selection: [],
  priorities: [],
  names: {},
  colonistList: [],
  departures: 0,
  lag: 0,
  craftTargets: new Array(ITEM_NAMES.length).fill(0),
  hasCraftingSpot: false,
  hasResearchBench: false,
  hasForge: false,
  colonistBadges: [],
  ticksPerDay: TICKS_PER_DAY,
  difficulty: DIFFICULTY.Normal,
  wealth: 0,
  traderPresent: -1,
  traderLeavesIn: 0,
  traderOffers: [],
  buyPrices: new Array(ITEM_NAMES.length).fill(0),
  foodFreshness: new Array(ITEM_NAMES.length).fill(-1),
  // 255 = aucune recherche en cours, six technologies à 0/0/non acquise.
  researchState: [255, ...new Array(TECHS.length * 3).fill(0)],
  fireCount: 0,
  livestockCount: 0,
  // Réputation de départ (`sim::factions::START_GOODWILL`) : les deux tribus
  // se méfient, la Guilde a entendu parler de la colonie en bien.
  goodwill: [-20, -20, 10],
  lastRaidFaction: -1,
};

interface Actions {
  save(): void;
  load(): void;
  triggerRaid(): void;
  setPriority(pawn: number, work: number, priority: number): void;
  currentPriority(pawn: number, work: number): number | null;
  /**
   * Sélectionne un colon, comme un clic sur son pawn dans la scène
   * (`ColonistBar`). `additive` (Maj + clic) l'ajoute à la sélection en cours
   * ou l'en retire, au lieu de la remplacer.
   */
  selectPawn(id: number, additive?: boolean): void;
  /** Centre la caméra sur un colon, sans changer le zoom (`ColonistBar`, double clic). */
  focusPawn(id: number): void;
  /**
   * Cible d'un événement du sim (`eventFocus.ts`), recalculée sur l'état
   * courant à chaque appel : jamais mémorisée, pour qu'un pawn mort depuis
   * redevienne `null` même longtemps après (mission « clic sur un événement »).
   */
  resolveEventTarget(kind: number, arg: number): EventTarget;
  /**
   * Recentre la caméra sur la cible d'un événement et sélectionne le pawn
   * visé, le cas échéant ; silencieux sans cible (`resolveEventTarget` a
   * renvoyé `null`). Résout la cible à l'instant de l'appel : sert le clic
   * sur une ligne du Journal (`kind`/`arg` toujours disponibles, la cible n'y
   * est jamais figée).
   */
  focusEvent(kind: number, arg: number): void;
  /**
   * Comme `focusEvent`, mais à partir d'une cible déjà résolue : sert le clic
   * sur un toast, dont `target` est figé à la réception (comme `text`) —
   * seule la position d'un pawn est encore relue ici, courante.
   */
  activateTarget(target: EventTarget): void;
}

interface Toast {
  id: number;
  text: string;
  /**
   * Cible figée à la réception, comme `text` (`JournalPanel.tsx`) : un toast
   * vit quelques secondes, la fraîcheur n'y est pas un enjeu comme pour le
   * Journal. `null` pour les toasts hors sim (réseau, monde) et les genres
   * sans lieu.
   */
  target: EventTarget;
}

/**
 * Mode de jeu choisi à l'accueil. Rien ne démarre avant ce choix. La
 * difficulté solo est choisie avant même de créer la session (accueil), donc
 * elle y voyage plutôt que d'être relue d'un état qui pourrait changer entre
 * le clic et l'effet qui démarre le Worker (voir `HomeScreen`).
 */
type Session =
  | { mode: "solo"; difficulty: number }
  | { mode: "multi"; server: string; room: string; name: string };

/**
 * Session « monde partagé » : elle survit à l'entrée dans une colonie. Tant
 * qu'elle existe, le globe reste chargé et la connexion monde ouverte, ce qui
 * rend le retour à l'écran Monde immédiat.
 */
interface WorldSession {
  server: string;
  name: string;
}

interface JoinForm {
  server: string;
  room: string;
  name: string;
}

/**
 * Paramètres de connexion lus dans l'URL (`?server=…&room=…&name=…`).
 * `room` suffit à déclencher la connexion directe : pratique pour ouvrir deux
 * onglets sur la même salle.
 */
function joinFromUrl(): JoinForm | null {
  const params = new URLSearchParams(window.location.search);
  const room = params.get("room");
  if (room === null || room === "") return null;
  return {
    server: params.get("server") ?? DEFAULT_SERVER,
    room,
    name: params.get("name") ?? "joueur",
  };
}

/**
 * Entrée directe dans le monde partagé (`?server=…&name=…&world=1`). Prioritaire
 * sur `room` : on choisit sa case sur le globe plutôt que de nommer une salle.
 */
function worldFromUrl(): WorldSession | null {
  const params = new URLSearchParams(window.location.search);
  const world = params.get("world");
  if (world === null || world === "" || world === "0") return null;
  return { server: params.get("server") ?? DEFAULT_SERVER, name: params.get("name") ?? "joueur" };
}

/** Où en est le chargement du globe, avant que l'écran Monde n'existe. */
type GlobeLoad =
  | { kind: "loading"; progress: WorldProgress | null }
  | { kind: "ready" }
  | { kind: "failed"; message: string };

function bytesToBase64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) {
    s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  }
  return btoa(s);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export function App() {
  /**
   * Conteneur de la scène de colonie. Il ne contient pas de canevas à lui : le
   * seul canevas WebGL de l'onglet vient de `render/gl.ts` et s'y installe tant
   * que la colonie est à l'écran (voir l'effet « canevas partagé » plus bas).
   * C'est aussi lui qui reçoit les entrées souris, et non le canevas, pour que
   * l'écran Monde ne les voie jamais pendant qu'on joue.
   */
  const sceneHostRef = useRef<HTMLDivElement>(null);
  const toolRef = useRef<Tool>("select");
  const materialRef = useRef<number>(0);
  const rendererRef = useRef<Renderer | null>(null);
  /** Contexte WebGL partagé de la partie en cours (`render/gl.ts`), pour le menu Options → Graphismes (`setPixelRatio`). */
  const glRef = useRef<SharedGl | null>(null);
  const actionsRef = useRef<Actions | null>(null);
  const bridgeRef = useRef<SimBridge | null>(null);
  const minimapRef = useRef<MinimapHandle | null>(null);
  /**
   * Dernier message `map` reçu (voir `onMap` dans l'effet de la partie), pour
   * repeindre le fond de la mini-carte dès qu'elle apparaît même si `onMap`
   * a déjà eu lieu avant son montage (en multi, la carte arrive au démarrage
   * de l'hôte, avant que `running` ne fasse apparaître la mini-carte pour un
   * rejoignant). Voir l'effet juste avant le `return` de ce composant.
   */
  const lastMapRef = useRef<{ width: number; height: number; tiles: Uint8Array; features: Uint8Array } | null>(null);
  /**
   * Journal des événements depuis le début de la session : alimenté par la
   * même boucle que les toasts (`notifyEvents`, dans l'effet de la partie),
   * jamais un second lecteur de `sim.events()`. Lu directement en rendu (donc
   * pas de `useState` qui dériverait), rafraîchi visuellement au rythme du
   * HUD (`setStats` force un rendu toutes les 500 ms).
   */
  const eventLogRef = useRef<JournalEntry[]>([]);
  const [tool, setToolState] = useState<Tool>("select");
  const [material, setMaterialState] = useState<number>(0);
  const [stats, setStats] = useState<Stats>(INITIAL);
  const [showWork, setShowWork] = useState(false);
  const [showCraft, setShowCraft] = useState(false);
  const [showResearch, setShowResearch] = useState(false);
  /** Panneau Troc (bouton dans la barre, pas de raccourci : `T` est déjà pris par le matériau). */
  const [showTrade, setShowTrade] = useState(false);
  /** Panneau Factions (bouton dans la barre, pas de raccourci : `F` est déjà pris par l'outil Feu). */
  const [showFactions, setShowFactions] = useState(false);
  const [showJournal, setShowJournal] = useState(false);
  const [journalFilter, setJournalFilter] = useState<JournalFilter>("all");
  /**
   * Menu « Options » (dose de menace, en cours de partie) : touche `O` est
   * prise par l'outil Sol, donc bouton dans la barre pour l'ouvrir, `Échap`
   * pour le fermer. `showOptionsRef` le rend lisible depuis le gestionnaire de
   * `keydown`, fermé sur `[session]` et donc jamais à jour d'un état React lu
   * directement (voir `toolRef`, même besoin).
   */
  const [showOptions, setShowOptionsState] = useState(false);
  const showOptionsRef = useRef(false);
  const setShowOptions = (v: boolean) => {
    showOptionsRef.current = v;
    setShowOptionsState(v);
  };
  /**
   * Aide des raccourcis (touche `?`/`F1`, bouton « ? » de la barre) : ouverte
   * et fermée par un effet à part (voir plus bas, comme la touche `V` de la
   * Caravane), donc valable même hors partie. `showHelpRef` la rend lisible
   * depuis le gestionnaire de `keydown` de la partie, qui la ferme en
   * priorité sur `Échap` (même besoin que `showOptionsRef`).
   */
  const [showHelp, setShowHelpState] = useState(false);
  const showHelpRef = useRef(false);
  const setShowHelp = (v: boolean) => {
    showHelpRef.current = v;
    setShowHelpState(v);
  };
  /**
   * Réglages graphiques (menu Options → Graphismes, §settings.ts) : relus au
   * premier rendu, sauvés à chaque changement. `pixelRatio` et `propDensity`
   * s'appliquent à la volée (`gl.ts::setPixelRatio`,
   * `Renderer.setPropDensity`) ; `shadows` ne s'applique qu'au prochain
   * chargement (`gl.ts` lit `loadGraphics().shadows` avant de créer le
   * renderer), le panneau le rappelle.
   */
  const [graphics, setGraphicsState] = useState<GraphicsSettings>(() => loadGraphics());
  const updateGraphics = (patch: Partial<GraphicsSettings>) => {
    const next: GraphicsSettings = { ...graphics, ...patch };
    setGraphicsState(next);
    saveGraphics(next);
    if (patch.pixelRatio !== undefined) {
      glRef.current?.setPixelRatio(effectivePixelRatio(next.pixelRatio, window.devicePixelRatio));
    }
    if (patch.propDensity !== undefined) {
      rendererRef.current?.setPropDensity(next.propDensity);
    }
  };
  /**
   * Armé par le bouton « Mettre le feu (débogage) » (dev uniquement) : le
   * prochain clic gauche sur la carte émet `encodeIgnite`, puis se désarme
   * (un clic droit l'annule aussi). Pas de raccourci clavier. `igniteArmedRef`
   * le rend lisible depuis le gestionnaire de `pointerup`, comme `toolRef` et
   * `showOptionsRef` pour le même besoin.
   */
  const [igniteArmed, setIgniteArmedState] = useState(false);
  const igniteArmedRef = useRef(false);
  const setIgniteArmed = (v: boolean) => {
    igniteArmedRef.current = v;
    setIgniteArmedState(v);
  };
  const [notice, setNotice] = useState<string | null>(null);
  /** Mode d'affichage des températures (touche I, bouton « Chaleur »). */
  const [heatMode, setHeatMode] = useState(false);
  /**
   * Vrai entre le clic sur « Resynchroniser » (ou une réparation automatique
   * déjà en cours) et la confirmation qui nous concerne : affiche
   * « resynchronisation… » à la place du bouton, remis à faux dès qu'on n'est
   * plus déviant ou que la demande est refusée (`docs/protocol.md` §7).
   */
  const [resyncPending, setResyncPending] = useState(false);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<JoinForm>(() => joinFromUrl() ?? { server: DEFAULT_SERVER, room: "demo", name: "joueur" });
  const [worldSession, setWorldSession] = useState<WorldSession | null>(() => worldFromUrl());
  const [session, setSession] = useState<Session | null>(() => {
    if (worldFromUrl() !== null) return null;
    const url = joinFromUrl();
    return url === null ? null : { mode: "multi", ...url };
  });
  const [net, setNet] = useState<LockstepState | null>(null);
  const [seed, setSeed] = useState<number>(DEFAULT_SEED);
  /** Dose de menace choisie à l'accueil, pour la prochaine partie solo. */
  const [homeDifficulty, setHomeDifficulty] = useState<number>(DIFFICULTY.Normal);
  /** Dose de menace choisie par l'hôte dans le lobby, pour la prochaine partie multi. */
  const [multiDifficulty, setMultiDifficulty] = useState<number>(DIFFICULTY.Normal);
  // --- Salles ouvertes : sondage de `GET /rooms`, tant que l'accueil est affiché ---
  const [rooms, setRooms] = useState<readonly RoomInfo[]>([]);
  const [roomsTruncated, setRoomsTruncated] = useState(false);
  /** Message d'erreur bref (serveur injoignable), jamais un toast répété à chaque sondage. */
  const [roomsError, setRoomsError] = useState<string | null>(null);
  const [roomFilter, setRoomFilter] = useState("");
  const [roomsLobbyOnly, setRoomsLobbyOnly] = useState(false);
  /** Adresse serveur effective pour le sondage, mise à jour 500 ms après la dernière frappe. */
  const [roomsServer, setRoomsServer] = useState(form.server);
  /**
   * Case présélectionnée en entrant dans l'écran Monde depuis « Salles
   * ouvertes » (bouton Rejoindre d'une salle « case »). Remise à `null` en
   * quittant le monde ou en repartant du bouton « Monde partagé » ordinaire.
   */
  const [initialWorldTile, setInitialWorldTile] = useState<number | null>(null);
  // --- Monde partagé : le globe et la connexion vivent en dehors de la partie ---
  const worldRef = useRef<WorldClient | null>(null);
  const [globe, setGlobe] = useState<World | null>(null);
  const [globeLoad, setGlobeLoad] = useState<GlobeLoad>({ kind: "loading", progress: null });
  const [worldNet, setWorldNet] = useState<WorldClientState | null>(null);
  /** Graine imposée par la case, reçue avec `settled`. `null` hors monde. */
  const [imposedSeed, setImposedSeed] = useState<number | null>(null);
  /** Identifiants des toasts du monde, hors de portée de ceux du sim et du réseau. */
  const worldToastId = useRef(-1_000_000);
  // --- Caravanes : le panneau, la destination, et l'expéditeur ---
  const [caravanOpen, setCaravanOpen] = useState(false);
  /** Vrai pendant qu'on choisit la case d'arrivée sur le globe. */
  const [caravanPicking, setCaravanPicking] = useState(false);
  const [caravanTo, setCaravanTo] = useState<number | null>(null);
  /** Manifestes sortis du sim sans destination connue (voir `CaravanDispatcher`). */
  const [caravanWaiting, setCaravanWaiting] = useState(0);
  const dispatcherRef = useRef<CaravanDispatcher | null>(null);
  /**
   * Case et rôle de la salle en cours, lus par la connexion monde — qui vit
   * dans un autre effet et ne doit pas se rouvrir à chaque changement d'hôte.
   */
  const roomTileRef = useRef<number | null>(null);
  const isHostRef = useRef(false);

  const multi = session?.mode === "multi";
  /** Case du globe jouée en ce moment, `null` en solo ou en salle nommée. */
  const roomTile = session?.mode === "multi" ? tileOfRoom(session.room) : null;
  roomTileRef.current = roomTile;

  /**
   * Qui a le globe à l'écran, et qui a la colonie. Les deux écrans restent
   * montés en même temps (revenir au monde ne doit pas retélécharger le globe),
   * mais un seul des deux tient le canevas WebGL partagé : c'est ce booléen qui
   * arbitre, ici et dans la prop `visible` passée à `WorldScreen`.
   */
  const globeVisible =
    worldSession !== null && globe !== null && (session === null || caravanPicking);
  const sceneVisible = session !== null && !globeVisible;

  /** Une notification de monde, hors de la plage des `seq` du sim. */
  const worldToast = (text: string) => {
    const id = worldToastId.current--;
    setToasts((prev) => [...prev, { id, text, target: null }]);
    window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS);
  };

  const setTool = (t: Tool) => {
    toolRef.current = t;
    setToolState(t);
    rendererRef.current?.setLeftDragPans(t === "select");
  };
  const setMaterial = (m: number) => {
    materialRef.current = m;
    setMaterialState(m);
  };

  /**
   * Le monde partagé : télécharge le globe une fois (`GET /world`), puis ouvre
   * la connexion monde **sur le thread principal**. Le Worker, lui, n'ouvrira
   * la sienne qu'au moment d'entrer dans une salle.
   *
   * Cette connexion reste ouverte pendant la partie : c'est ce que le
   * protocole prévoit (§11.3, monde et salle cohabitent), elle continue de
   * recevoir `world_settlements` pendant qu'on joue, et le retour au globe est
   * immédiat. La fermer imposerait un `world_join` et un nouvel écran d'attente
   * à chaque aller-retour.
   */
  useEffect(() => {
    if (worldSession === null) return;
    let cancelled = false;
    let client: WorldClient | null = null;
    const timers: number[] = [];
    setGlobeLoad({ kind: "loading", progress: null });

    const toast = (text: string) => {
      const id = worldToastId.current--;
      setToasts((prev) => [...prev, { id, text, target: null }]);
      timers.push(window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS));
    };
    /**
     * Arrivées déjà injectées depuis cette connexion monde. Le serveur réémet
     * une arrivée tant qu'il n'a pas la confirmation et assume le doublon
     * (§12.5) : mieux vaut un convoi confirmé deux fois que des colons
     * débarqués deux fois. Vivent ici (pas dans l'effet de la partie) : cette
     * connexion survit aux allers-retours entre colonies.
     */
    const deliveredCaravans = new Set<string>();

    void (async () => {
      try {
        const { world } = await fetchWorld(worldSession.server, (progress) => {
          if (!cancelled) setGlobeLoad({ kind: "loading", progress });
        });
        if (cancelled) return;
        setGlobe(world);
        setGlobeLoad({ kind: "ready" });
        // Enveloppée dans `ReconnectingTransport` : la connexion monde tombe
        // et se reconnecte indépendamment de celle de la salle (`docs/protocol.md`
        // §11.3), avec le même délai exponentiel plafonné qu'elle
        // (`net/Transport.ts`). `onReconnect` rejoue `world_join` avec le même
        // jeton (`WorldClient.reconnect`) dès qu'un `Transport` neuf existe.
        const worldTransport = new ReconnectingTransport({
          factory: () => new WebSocketTransport(worldSession.server),
        });
        client = new WorldClient({
          transport: worldTransport,
          name: worldSession.name,
          serverUrl: worldSession.server,
          // Vérification de cohérence : le `world_welcome` doit annoncer le
          // globe qu'on vient de télécharger, sinon les cases ne désignent rien.
          expected: { seed: world.seed, subdivisions: world.subdivisions, tiles: world.tiles.length },
          onState: (state) => {
            if (!cancelled) setWorldNet(state);
          },
          onSettled: (settled: SettledMessage) => {
            if (cancelled) return;
            // Réponse à `settle` comme à `visit` : on quitte le globe et on
            // entre dans la salle de la case, en mode multi ordinaire.
            setImposedSeed(settled.seed);
            setSession({ mode: "multi", server: worldSession.server, room: settled.room, name: worldSession.name });
          },
          onError: (error) => {
            if (!cancelled) toast(`Monde : ${error.message}`);
          },
          onCaravanArrive: (arrival) => {
            // Le serveur l'envoie aussi sur la connexion de salle (le Worker),
            // qui l'ignore désormais (docs/protocol.md §12.4, §12.7) : c'est
            // ici, sur la connexion monde, que le flux d'arrivée se joue.
            //
            // Il faut être en train de jouer précisément cette colonie, sinon
            // il n'y a pas de sim où injecter le convoi : la garde ci-dessous
            // couvre le cas (rare) où cette connexion reste associée à une
            // colonie qu'on ne joue plus dans cet onglet — l'arrivée attend,
            // le serveur la réémettra à la réouverture (§12.5).
            if (roomTileRef.current !== arrival.tile || !isHostRef.current) return;
            if (!deliveredCaravans.has(arrival.id)) {
              const bridge = bridgeRef.current;
              if (bridge === null) return;
              try {
                // Commande lockstep comme un clic du joueur : l'effet arrive
                // avec le bundle, on n'applique rien localement.
                bridge.issue(encodeArriveCaravan(arrival.manifest));
              } catch (e) {
                toast(`Caravane : arrivée impossible (${e instanceof Error ? e.message : String(e)})`);
                return;
              }
              deliveredCaravans.add(arrival.id);
            }
            // Confirmer **après** avoir émis la commande : tant que le
            // serveur n'a pas ce message, il garde l'arrivée.
            client?.deliverCaravan(arrival.id);
          },
        });
        worldTransport.onReconnect(() => client?.reconnect());
        worldRef.current = client;
        client.join();
      } catch (e) {
        if (!cancelled) setGlobeLoad({ kind: "failed", message: e instanceof Error ? e.message : String(e) });
      }
    })();

    return () => {
      cancelled = true;
      for (const t of timers) clearTimeout(t);
      worldRef.current = null;
      client?.close();
      setGlobe(null);
      setWorldNet(null);
      setImposedSeed(null);
    };
  }, [worldSession]);

  /** L'accueil, tel qu'affiché plus bas : ni partie, ni monde en cours. */
  const homeVisible = session === null && worldSession === null;

  // --- Salles ouvertes : `GET /rooms` en sondage, adresse serveur débattue à part ---
  useEffect(() => {
    const t = window.setTimeout(() => setRoomsServer(form.server), ROOMS_SERVER_DEBOUNCE_MS);
    return () => window.clearTimeout(t);
  }, [form.server]);

  useEffect(() => {
    if (!homeVisible) return;
    let cancelled = false;
    const poll = () => {
      void fetchRooms(roomsServer).then(
        (res) => {
          if (cancelled) return;
          setRooms(res.rooms);
          setRoomsTruncated(res.truncated);
          setRoomsError(null);
        },
        (e: unknown) => {
          // Serveur injoignable : une ligne discrète dans l'accueil, jamais
          // un toast répété à chaque sondage de 5 s.
          if (cancelled) return;
          setRoomsError(e instanceof Error ? e.message : String(e));
        },
      );
    };
    poll();
    const id = window.setInterval(poll, ROOMS_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [homeVisible, roomsServer]);

  // Crochet de dev : la dernière liste reçue, seulement pendant que l'accueil
  // est affiché (voir « Vérifier dans le navigateur », `AGENTS.md`).
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const hook = window as unknown as { __rimlike?: Record<string, unknown> };
    if (!homeVisible) {
      if (hook.__rimlike) delete hook.__rimlike.rooms;
      return;
    }
    hook.__rimlike ??= {};
    hook.__rimlike.rooms = rooms;
    return () => {
      if (hook.__rimlike) delete hook.__rimlike.rooms;
    };
  }, [homeVisible, rooms]);

  /**
   * Le canevas WebGL unique (`render/gl.ts`) passe d'un écran à l'autre : la
   * colonie le prend quand elle est affichée, le globe le lui reprend le temps
   * de viser une case d'arrivée. `detach(host)` ne fait rien si le canevas est
   * déjà parti ailleurs, et `attach` deux fois de suite sur le même conteneur
   * ne fait que remesurer : StrictMode monte deux fois sans conséquence.
   */
  useEffect(() => {
    const host = sceneHostRef.current;
    if (host === null || !sceneVisible) return;
    const gl = acquireGl();
    gl.attach(host);
    return () => {
      gl.detach(host);
      gl.release();
    };
  }, [sceneVisible]);

  /**
   * Crochet de dev sur le contexte partagé : `window.__rimlike.gl.renderer.info.memory`
   * dit combien de géométries et de textures vivent sur le GPU. Un aller-retour
   * globe → colonie → globe doit ramener ces compteurs à leur valeur de départ.
   */
  useEffect(() => {
    if (!import.meta.env.DEV) return;
    const gl = acquireGl();
    // Rendu tout de suite : le crochet garde une référence (l'objet est
    // mémoïsé, il ne disparaît pas) sans compter pour un écran, sans quoi le
    // compteur d'utilisateurs ne retomberait jamais à zéro en développement.
    gl.release();
    const hook = window as unknown as { __rimlike?: Record<string, unknown> };
    hook.__rimlike ??= {};
    hook.__rimlike.gl = gl;
    // Volontairement sans nettoyage : le contexte vit aussi longtemps que
    // l'onglet, et le crochet doit rester lisible depuis les deux écrans.
  }, []);

  useEffect(() => {
    const host = sceneHostRef.current;
    if (!host || !session) return;
    const isMulti = session.mode === "multi";
    let disposed = false;
    let raf = 0;
    let interval = 0;
    const cleanups: Array<() => void> = [];
    const toastTimers: number[] = [];
    /** Identifiants de toast réseau, hors de la plage des `seq` du sim. */
    let netToastId = -1;

    // Le contexte WebGL est unique et partagé avec l'écran Monde (`render/gl.ts`) :
    // on l'emprunte, on ne le crée pas — et on le rend en fin d'effet.
    const gl = acquireGl();
    const renderer = new Renderer(gl, host);
    rendererRef.current = renderer;
    glRef.current = gl;
    // Réglages graphiques mémorisés, appliqués dès le lancement de la partie
    // (pas seulement à l'ouverture du menu Options) : densité des props et
    // rapport de pixels. Les ombres, elles, sont déjà tranchées par
    // `acquireGl` avant même la création de ce renderer (voir `gl.ts`).
    const savedGraphics = loadGraphics();
    renderer.setPropDensity(savedGraphics.propDensity);
    gl.setPixelRatio(effectivePixelRatio(savedGraphics.pixelRatio, window.devicePixelRatio));
    renderer.setLeftDragPans(toolRef.current === "select");

    // Première partie solo lancée sur ce navigateur : un rappel discret vers
    // l'aide des raccourcis, jamais répété ensuite (`shortcuts.ts`). Solo
    // seulement (mission) : une partie multi rejointe en premier ne compte
    // pas, l'hôte l'a peut-être déjà vu ailleurs.
    if (!isMulti && !hasSeenHelp()) {
      markHelpSeen();
      setNotice("Appuyez sur ? pour l'aide");
      window.setTimeout(() => setNotice(null), HELP_HINT_MS);
    }

    // --- État vu du thread principal. Le sim, lui, vit dans le Worker ---
    let speed = 1;
    let paused = false;
    /**
     * Sélection courante, ordonnée (voir `selection.ts`) : `selected` reste le
     * premier id (ou l'unique), gardé pour tout ce qui n'affiche qu'un seul
     * colon (panneau simple, `focusPawn`, `__rimlike.selected`). Ne jamais
     * assigner l'un ou l'autre à la main ailleurs que dans `applySelection`,
     * seule à tenir `renderer.setSelection` à jour.
     */
    let selection: number[] = [];
    let selected: number | null = null;
    /** Dernier `frame` reçu : seule source de l'état affiché. */
    let lastFrame: FrameMessage | null = null;
    let prevPawns: Int32Array | null = null;
    let curPawns: Int32Array = new Int32Array(0);
    /** Instant de réception du dernier `frame`, pour l'interpolation. */
    let lastFrameAt: number | null = null;
    /** Écart réel entre deux `frame`, lissé : dénominateur de l'interpolation. */
    let frameIntervalMs = 0;
    /** Dernier hash reçu : un `frame` sur trente le porte. */
    let lastHash = "";
    let netState: LockstepState | null = null;
    let netReady = false;
    let netError: LockstepError | null = null;
    let lastEventSeq = -1;
    /** Dernier `frozenTicks` déjà annoncé par toast, pour ne le dire qu'une fois. */
    let lastFrozenTicksNotified = 0;
    /** Dernier `lastResyncTick` déjà annoncé par toast, pour ne le dire qu'une fois. */
    let lastResyncNotified: number | null = null;
    /** Dernier `lastReconnectAt` déjà annoncé par toast, pour ne le dire qu'une fois. */
    let lastReconnectNotified: number | null = null;
    /**
     * Vrai tant qu'au moins un genre périssable est sous 20 % de fraîcheur :
     * un seul toast par passage sous ce seuil (§4 mission tombes), pas un par
     * demi-seconde tant que ça dure. Remis à faux dès que plus aucun genre
     * n'y est, pour qu'une rechute ultérieure retoaste.
     */
    let lowFreshnessActive = false;
    /**
     * Vrai jusqu'au premier `frame` d'un sim neuf, chargé ou restauré : rien à
     * interpoler depuis l'état d'avant, et ses événements sont du passé.
     */
    let freshSim = true;
    /** Priorités cliquées, en attente de confirmation par un `frame`. */
    const pendingPriority = new Map<string, number>();
    /**
     * Blessures du colon sélectionné, rafraîchies par `rpc("pawnInjuries", id)`
     * au rythme du HUD (2 fois par seconde, sous la limite de 4 imposée par le
     * sim) plutôt qu'à chaque frame : le tampon `health` ne porte qu'un compte.
     */
    let selectedInjuries: InjuryInfo[] = [];
    let selectedInjuriesId: number | null = null;
    /**
     * Compétences de combat du colon sélectionné, rafraîchies par
     * `rpc("pawnCombatSkills", id)` au même rythme que les blessures : elles ne
     * sont pas dans le tampon `skills`, qui suit `WorkType` (`sim-wasm::pawn_combat_skills`).
     */
    let selectedCombat = { meleeLevel: 0, meleeXp: 0, rangedLevel: 0, rangedXp: 0 };
    let selectedCombatId: number | null = null;
    /** Ressenti du colon sélectionné, rafraîchi par `rpc("pawnComfort", id)` au même rythme. */
    let selectedComfort = 0;
    let selectedComfortId: number | null = null;
    /** Ticks de maladie restants du colon sélectionné, rafraîchis au même rythme. */
    let selectedSick = 0;
    let selectedSickId: number | null = null;
    /**
     * Avis du colon sélectionné sur ses camarades (`sim::social::Opinion`),
     * rafraîchis par `rpc("pawnOpinions", id)` au moment où le panneau
     * s'ouvre (changement de sélection) puis une fois par seconde tant qu'il
     * reste ouvert — plus rare que les autres accesseurs ponctuels
     * ci-dessus (2×/s) : un avis ne bouge qu'à la fin d'un bavardage, jamais
     * en continu, pas la peine d'interroger le sim aussi souvent.
     */
    let selectedRelations: Opinion[] = [];
    let selectedRelationsId: number | null = null;
    /** Dernier instant (`performance.now()`) où `pawnOpinions` a été relu. */
    let relationsRefreshedAt = -Infinity;
    /**
     * Ticks de maladie restants par id, pour le point vert de `ColonistBar` :
     * pas dans le tampon `pawns` (`sim-wasm::PAWN_STRIDE` ne bouge pas), donc
     * rafraîchi ici par colon vivant, au rythme du HUD (2×/s) plutôt qu'à
     * chaque frame. Un tick de retard entre le changement d'état et la
     * pastille, comme les blessures ou le ressenti du colon sélectionné.
     */
    const sickById = new Map<number, number>();
    let lastRenderAt = performance.now();
    let framesInWindow = 0;
    let windowStart = lastRenderAt;

    const pushToast = (text: string) => {
      const id = netToastId--;
      setToasts((prev) => [...prev, { id, text, target: null }]);
      toastTimers.push(window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS));
    };
    const flash = (msg: string) => {
      setNotice(msg);
      window.setTimeout(() => setNotice(null), 1800);
    };
    const showError = (e: unknown) => {
      if (!disposed) setError(e instanceof Error ? (e.stack ?? e.message) : String(e));
    };
    /**
     * Seul point qui change `selection`/`selected` : tient `renderer` à jour
     * dans la foulée (`Renderer.setSelection`), jamais l'inverse. Une sélection
     * à un id se comporte exactement comme avant (`selected` = cet id).
     */
    const applySelection = (ids: number[]) => {
      selection = ids;
      selected = ids.length > 0 ? ids[0] : null;
      renderer.setSelection(selection);
    };

    /** Oublie une priorité cliquée dès que le sim la renvoie. */
    const confirmPriorities = (buf: Int32Array) => {
      if (pendingPriority.size === 0) return;
      for (let o = 0; o + PRIORITY_STRIDE <= buf.length; o += PRIORITY_STRIDE) {
        for (let w = 0; w + 1 < PRIORITY_STRIDE; w++) {
          const key = `${buf[o]}:${w}`;
          if (pendingPriority.get(key) === buf[o + 1 + w]) pendingPriority.delete(key);
        }
      }
    };

    /**
     * Un toast par événement du sim jamais vu. `goodwill` et `lastRaidFaction`
     * sont ceux du `frame` courant : `eventLabel` (pure, sans sim) ne les
     * connaît pas de lui-même, ils sont ceux au moment de l'affichage, pas
     * forcément ceux du tick de l'événement (mission « factions » §4).
     */
    const notifyEvents = (
      events: Int32Array,
      names: Record<number, string>,
      fresh: boolean,
      goodwill: ArrayLike<number>,
      lastRaidFaction: number,
    ) => {
      if (fresh) {
        // Ce qu'un sim neuf porte déjà est du passé : on ne le notifie pas.
        lastEventSeq = events.length >= EVENT_STRIDE ? events[events.length - EVENT_STRIDE] : -1;
        return;
      }
      for (let o = 0; o + EVENT_STRIDE <= events.length; o += EVENT_STRIDE) {
        const seq = events[o];
        if (seq <= lastEventSeq) continue;
        lastEventSeq = seq;
        const tick = events[o + 1];
        const kind = events[o + 2];
        const arg = events[o + 3];
        let text = eventLabel(kind, arg, names, goodwill);
        // L'annonce de raid (21) ne porte que la manière d'aborder la colonie
        // (`arg`) : la tribu qui la mène est un champ à part du `frame`
        // (`lastRaidFaction`), posé par le sim au même tick que l'événement —
        // `eventLabel` ne le voit pas, on la complète ici plutôt que d'ajouter
        // un paramètre de plus à une fonction pure pour un seul genre.
        if (kind === 21 && lastRaidFaction >= 0) {
          text += ` — mené par ${factionDefinite(lastRaidFaction)}`;
        }
        if (!text) continue;
        const target = eventTarget(kind, arg, buildEventFocusCtx());
        setToasts((prev) => [...prev, { id: seq, text, target }]);
        toastTimers.push(
          window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== seq)), TOAST_MS),
        );
        // Journal : même texte que le toast, figé avec les `names` de l'instant
        // (voir l'en-tête de `JournalPanel.tsx`) — pas un second lecteur d'événements.
        // `arg` voyage aussi : `JournalPanel` recalcule sa cible à chaque rendu
        // (`resolveTarget`), jamais figée comme `text`, pour qu'un pawn mort
        // depuis redevienne non cliquable même longtemps après (mission
        // « clic sur un événement » §3).
        const log = eventLogRef.current;
        log.push({ seq, tick, kind, arg, text });
        if (log.length > MAX_JOURNAL_ENTRIES) log.splice(0, log.length - MAX_JOURNAL_ENTRIES);
      }
    };

    /**
     * L'expéditeur des caravanes, créé juste après le pont (il lit la file des
     * départs par RPC). Déclaré avant lui parce que `onFrame` s'en sert.
     */
    let dispatcher: CaravanDispatcher | null = null;
    /** Nombre de `Feature::CraftingSpot` sur la carte, recompté à chaque `map`. */
    let craftingSpotCount = 0;
    /**
     * Nombre de `Feature::ResearchBench` sur la carte, recompté à chaque `map`
     * seulement (comme `craftingSpotCount`), jamais à chaque frame.
     */
    let researchBenchCount = 0;
    /** Nombre de `Feature::Forge` sur la carte, même schéma que `researchBenchCount`. */
    let forgeCount = 0;
    /**
     * Dernière couche « feu » reçue (`onFire`), pour la mini-carte : elle ne
     * la peint qu'à la cadence du HUD (voir l'intervalle plus bas), jamais à
     * chaque `onFire` (`fireVersion` change bien plus souvent que ça).
     */
    let lastFire: Uint8Array | null = null;

    /**
     * Recherches sans DOM pour `eventTarget` (`eventFocus.ts`), toujours sur
     * l'état **courant** (`curPawns`, `lastFrame`, `lastFire`, `lastMapRef`) :
     * reconstruit à chaque appel, jamais mémorisé, pour qu'un pawn mort ou
     * une case qui ne brûle plus se voient tout de suite, même bien après
     * l'événement (le Journal garde ses entrées toute la session).
     */
    const buildEventFocusCtx = (): EventFocusCtx => ({
      pawnById(id) {
        for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
          if (curPawns[o] === id) return { x: curPawns[o + 1] / 256, y: curPawns[o + 2] / 256 };
        }
        return null;
      },
      firstPawnOfFaction(faction) {
        for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
          if (curPawns[o + 10] === faction) {
            return { id: curPawns[o], x: curPawns[o + 1] / 256, y: curPawns[o + 2] / 256 };
          }
        }
        return null;
      },
      firstBurningTile() {
        const map = lastMapRef.current;
        if (!map || !lastFire) return null;
        for (let i = 0; i < lastFire.length; i++) {
          if (lastFire[i] !== 0) return { x: i % map.width, y: Math.floor(i / map.width) };
        }
        return null;
      },
      traderId() {
        return lastFrame && lastFrame.traderPresent >= 0 ? lastFrame.traderPresent : null;
      },
    });

    // --- Le Worker de simulation ---
    const bridge = new SimBridge({
      onMap: (m) => {
        renderer.setMap(m.width, m.height, m.tiles, m.features);
        // Même rappel que le fond 3D : le fond de la mini-carte ne se
        // recalcule, lui aussi, qu'au changement de `mapVersion` (mission
        // mini-carte §1). Gardé à part pour la repeindre dès son montage,
        // même si `onMap` a déjà eu lieu avant (voir `lastMapRef`, un
        // rejoignant multi peut monter la mini-carte après coup).
        lastMapRef.current = { width: m.width, height: m.height, tiles: m.tiles, features: m.features };
        minimapRef.current?.setMap(m.width, m.height, m.tiles, m.features);
        let spots = 0;
        let benches = 0;
        let forges = 0;
        for (const f of m.features) {
          if (f === FEATURE.CraftingSpot) spots++;
          else if (f === FEATURE.ResearchBench) benches++;
          else if (f === FEATURE.Forge) forges++;
        }
        craftingSpotCount = spots;
        researchBenchCount = benches;
        forgeCount = forges;
      },
      onOverlays: (m) => renderer.setOverlays(m.zones, m.designations),
      onIndoor: (m) => renderer.setIndoor(m.indoor),
      onFire: (m) => {
        renderer.setFire(m.fire);
        // Seulement mémorisé : la mini-carte ne le peint qu'à la cadence du
        // HUD (~500 ms, voir l'intervalle plus bas), jamais à ce rythme-ci
        // (`fireVersion` peut changer bien plus souvent qu'un incendie actif).
        lastFire = m.fire;
      },
      onFrame: (f) => {
        const now = performance.now();
        if (freshSim) {
          // Les pawns d'avant ne sont pas ceux d'après : aucune interpolation,
          // et les priorités cliquées sur l'ancienne colonie n'ont plus cours.
          prevPawns = null;
          frameIntervalMs = 0;
          pendingPriority.clear();
        } else {
          if (lastFrameAt !== null) {
            // Lissé : l'écart varie d'un battement du Worker à l'autre.
            const gap = now - lastFrameAt;
            frameIntervalMs = frameIntervalMs === 0 ? gap : frameIntervalMs * 0.8 + gap * 0.2;
          }
          prevPawns = curPawns;
        }
        lastFrameAt = now;
        curPawns = f.pawns;
        lastFrame = f;
        if (f.hash !== null) lastHash = f.hash;
        renderer.syncItems(f.items);
        renderer.syncBlueprints(f.blueprints);
        renderer.setWeather(f.weather);
        renderer.setTimeOfDay(f.timeOfDay / f.ticksPerDay);
        renderer.setNames(f.names);
        renderer.setWeapons(f.weapons);
        renderer.setApparel(f.apparel);
        renderer.setAnimals(f.animals);
        confirmPriorities(f.priorities);
        notifyEvents(f.events, f.names, freshSim, f.goodwill, f.lastRaidFaction);
        freshSim = false;
        // Vider la file des départs est le travail de l'hôte de la case, et de
        // lui seul (docs/protocol.md §12.7). Hors de ce cas, `pump(0)` ne coûte
        // rien et remet l'expéditeur à zéro.
        const mine = roomTileRef.current !== null && (netState?.isHost ?? false);
        void dispatcher?.pump(mine ? f.departures : 0).catch(() => {
          // Worker fermé ou WASM pas encore prêt : le prochain `frame` reprend
          // la file là où elle en est, rien n'est perdu.
        });
      },
      onNet: (state) => {
        netState = state;
        isHostRef.current = state.isHost;
        setNet(state);
        // Un sim restauré depuis le snapshot du host repart de zéro côté rendu.
        if (state.ready && !netReady) freshSim = true;
        netReady = state.ready;
        if (state.lastError !== null && state.lastError !== netError) {
          netError = state.lastError;
          pushToast(`Serveur : ${state.lastError.message}`);
          // Un refus muet, pas une resynchronisation en cours (§7) : on peut
          // reproposer le bouton tout de suite plutôt que d'attendre en vain.
          if (state.lastError.code === "host_cannot_resync" || state.lastError.code === "resync_cooldown") {
            setResyncPending(false);
          }
        }
        // Réouverture d'une colonie gelée (§11.6) : annoncé dès reçu, avant
        // même que l'hôte n'ait émis l'avance rapide. L'événement 13 du sim
        // confirmera ensuite le compte exact de jours depuis le tampon d'events.
        if (state.frozenTicks > 0 && state.frozenTicks !== lastFrozenTicksNotified) {
          lastFrozenTicksNotified = state.frozenTicks;
          const days = Math.floor(state.frozenTicks / TICKS_PER_DAY);
          pushToast(`Colonie rouverte : ${days} jour${days > 1 ? "s" : ""} ont passé`);
        }
        // On n'est plus déviant : la réparation (manuelle ou automatique) a
        // abouti, il n'y a plus rien « en cours » à afficher.
        if (!state.isOutlier) setResyncPending(false);
        if (state.lastResyncTick !== null && state.lastResyncTick !== lastResyncNotified) {
          lastResyncNotified = state.lastResyncTick;
          pushToast(`Resynchronisé au tick ${state.lastResyncTick}`);
        }
        // Reconnexion aboutie (`docs/protocol.md` §4, §8) : les commandes
        // données pendant la coupure n'ont jamais quitté ce client (§5), on ne
        // le tait pas.
        if (state.lastReconnectAt !== null && state.lastReconnectAt !== lastReconnectNotified) {
          lastReconnectNotified = state.lastReconnectAt;
          const lost = state.lastReconnectLostCommands;
          pushToast(
            lost > 0
              ? `Connexion perdue : ${lost} commande${lost > 1 ? "s" : ""} non envoyée${lost > 1 ? "s" : ""}`
              : "Connexion rétablie",
          );
        }
      },
      onSaved: (bytes) => {
        try {
          localStorage.setItem(SAVE_KEY, bytesToBase64(bytes));
          flash("Partie sauvegardée");
        } catch (e) {
          flash(`Sauvegarde impossible : ${String(e)}`);
        }
      },
      onLoaded: (failure) => {
        if (failure !== undefined) {
          flash(`Chargement impossible : ${failure}`);
          return;
        }
        freshSim = true;
        applySelection([]);
        flash("Partie chargée");
      },
      onError: showError,
    });
    bridgeRef.current = bridge;
    // Journal neuf pour cette session (solo neuf, ou nouvelle salle multi) :
    // pas remis à zéro par un `load` ou une resynchronisation en cours de jeu.
    eventLogRef.current = [];
    bridge.start(
      session.mode === "solo"
        ? { mode: "solo", seed: DEFAULT_SEED, width: MAP_SIZE, height: MAP_SIZE, difficulty: session.difficulty }
        : { mode: "multi", server: session.server, room: session.room, name: session.name },
    );
    // Les `encode*` sont des fonctions du WASM : le thread principal en garde
    // une instance rien que pour encoder. Le sim, lui, n'existe que côté Worker.
    void initSim().catch(showError);

    /**
     * Les manifestes sortent du sim (donc du Worker) par RPC, partent sur la
     * connexion monde, puis quittent la file par une **commande** — au même
     * tick chez tout le monde. Voir `net/CaravanDispatcher.ts`.
     */
    dispatcher = new CaravanDispatcher({
      readDeparture: async (index) => {
        const bytes = await bridge.rpc("departure", index);
        return bytes instanceof Uint8Array ? bytes : new Uint8Array(0);
      },
      describe: (manifest) => manifestSummary(SimHandle.describeManifest(manifest)),
      sendDepart: (departure) => {
        const fromTile = roomTileRef.current;
        if (fromTile === null) return;
        // Par la connexion **monde** (thread principal) : le serveur accepte
        // désormais `caravan_depart` de n'importe quelle connexion d'un joueur
        // présent dans la salle de `fromTile` (docs/protocol.md §12.3, §12.7).
        // Suppose une connexion monde ouverte (toujours le cas pour une salle
        // `tile-N`, atteinte par le globe) ; sans elle, silencieusement rien
        // ne part — cas hors du flux monde, non pris en charge ici.
        worldRef.current?.sendDepart({ fromTile, ...departure });
      },
      issue: (bytes) => bridge.issue(bytes),
      encodeClear: encodeClearDepartures,
      onWaiting: (count) => setCaravanWaiting(count),
    });
    dispatcherRef.current = dispatcher;

    // --- Boucle de rendu : plus un seul tick ici, uniquement du rendu ---
    const draw = (now: number) => {
      framesInWindow++;
      const dt = Math.min(now - lastRenderAt, MAX_RENDER_DT_MS);
      lastRenderAt = now;
      if (lastFrame === null) return; // accueil ou lobby : rien à montrer
      const alpha =
        paused || lastFrameAt === null
          ? 1
          : Math.min((now - lastFrameAt) / Math.max(frameIntervalMs, 1), 1);
      renderer.syncPawns(curPawns, prevPawns, alpha);
      renderer.render(dt / 1000);
    };
    const loop = (now: number) => {
      try {
        draw(now);
      } catch (e) {
        showError(e);
        return;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);

    /**
     * Seul chemin des actions du joueur : les octets partent au Worker, qui
     * les applique au sim en solo et les envoie au serveur en multi — où elles
     * reviennent dans un bundle, jamais appliquées au clic (docs/protocol.md §5).
     */
    const issue = (payload: Uint8Array) => bridge.issue(payload);
    /** Vrai dès que le sim tourne : avant, il n'y a rien à commander. */
    const live = () => lastFrame !== null;

    /**
     * Recentre la caméra sur une cible déjà résolue (`eventTarget`) et
     * sélectionne le pawn visé, le cas échéant ; silencieux sans cible. Sert
     * le clic sur un toast (`target` figé à la réception, mais la position
     * d'un pawn est encore relue ici, **courante**) et sur une ligne du
     * Journal (`focusEvent`, qui résout `target` juste avant d'appeler ceci).
     */
    const applyEventTarget = (target: EventTarget) => {
      if (!target) return;
      if (target.kind === "tile") {
        // +0.5 : centre de la case, comme le clic sur la mini-carte (`Minimap.tsx`).
        renderer.focusOn(target.x + 0.5, target.y + 0.5);
        return;
      }
      // Pawn : sa position courante, jamais celle qu'il avait à l'événement.
      const pos = buildEventFocusCtx().pawnById(target.id);
      if (!pos) return;
      renderer.focusOn(pos.x, pos.y);
      applySelection([target.id]);
    };

    // --- Sauvegarde (solo seulement : l'horloge du multi ne s'arrête pas) ---
    const actions: Actions = {
      save() {
        // `localStorage` n'existe pas dans un Worker : il rend les octets, on écrit.
        if (isMulti) return;
        bridge.save();
      },
      load() {
        if (isMulti) return;
        let b64: string | null = null;
        try {
          b64 = localStorage.getItem(SAVE_KEY);
        } catch {
          /* stockage indisponible */
        }
        if (!b64) {
          flash("Aucune sauvegarde");
          return;
        }
        bridge.load(base64ToBytes(b64));
      },
      triggerRaid() {
        if (!live()) return;
        issue(encodeTriggerRaid());
      },
      setPriority(pawn, work, priority) {
        if (!live()) return;
        pendingPriority.set(`${pawn}:${work}`, priority);
        issue(encodeSetPriority(pawn, work, priority));
      },
      currentPriority(pawn, work) {
        // Valeur du dernier `frame` (moins de 20 ms), corrigée des clics pas
        // encore revenus : deux clics rapprochés s'enchaînent correctement.
        const waiting = pendingPriority.get(`${pawn}:${work}`);
        if (waiting !== undefined) return waiting;
        const pr = lastFrame?.priorities;
        if (!pr) return null;
        for (let o = 0; o + PRIORITY_STRIDE <= pr.length; o += PRIORITY_STRIDE) {
          if (pr[o] === pawn) return pr[o + 1 + work];
        }
        return null;
      },
      selectPawn(id, additive) {
        applySelection(additive ? toggle(selection, id) : [id]);
      },
      focusPawn(id) {
        // Position courante du colon dans le dernier tampon reçu ; silencieux
        // s'il a disparu entre-temps (mort, parti en caravane).
        for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
          if (curPawns[o] === id) {
            renderer.focusOn(curPawns[o + 1] / 256, curPawns[o + 2] / 256);
            break;
          }
        }
      },
      resolveEventTarget(kind, arg) {
        return eventTarget(kind, arg, buildEventFocusCtx());
      },
      focusEvent(kind, arg) {
        applyEventTarget(eventTarget(kind, arg, buildEventFocusCtx()));
      },
      activateTarget(target) {
        applyEventTarget(target);
      },
    };
    actionsRef.current = actions;

    // --- Entrées ---
    let down: {
      x: number;
      y: number;
      button: number;
      tile: TilePos | null;
      /** Maj + glisser gauche en mode Sélection : rectangle multi-colons plutôt que panoramique. */
      rectSelect: boolean;
    } | null = null;
    const on = <K extends keyof HTMLElementEventMap>(
      target: HTMLElement | Window,
      type: K | keyof WindowEventMap,
      fn: (e: never) => void,
    ) => {
      target.addEventListener(type as string, fn as EventListener);
      cleanups.push(() => target.removeEventListener(type as string, fn as EventListener));
    };
    const toolColor = () => TOOLS.find((t) => t.id === toolRef.current)?.color ?? 0xffffff;
    /** Camp d'un pawn, lu dans le dernier tampon reçu. `-1` s'il a disparu. */
    const factionOf = (id: number) => {
      for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
        if (curPawns[o] === id) return curPawns[o + 10];
      }
      return -1;
    };
    /**
     * Espèce et marquage gibier d'une bête **sauvage**, lus dans le dernier
     * `frame.animals` reçu (stride 3 : id, espèce, drapeaux). `null` si l'id
     * n'est pas celui d'une bête sauvage vivante — en particulier une bête de
     * la colonie (faction 0) n'y répond jamais : elle ne se chasse plus.
     */
    const animalOf = (id: number | null): { species: number; hunted: boolean } | null => {
      if (id === null || factionOf(id) !== FACTION_ANIMAL) return null;
      const buf = lastFrame?.animals;
      if (!buf) return null;
      for (let o = 0; o + ANIMAL_STRIDE <= buf.length; o += ANIMAL_STRIDE) {
        if (buf[o] === id) return { species: buf[o + 1], hunted: (buf[o + 2] & ANIMAL_FLAG.Hunted) !== 0 };
      }
      return null;
    };
    /**
     * Vrai pour une bête **de la colonie** (`sim::livestock`, faction 0 avec
     * une espèce), lue dans `frame.animals` comme `animalOf` — mais sans se
     * limiter à la faune sauvage, puisque c'est justement l'inverse qu'on
     * cherche ici. Exclut le bétail du rectangle de sélection et des ordres
     * multi-colons, comme un pillard ou une bête sauvage.
     */
    const isLivestockId = (id: number): boolean => {
      if (factionOf(id) !== FACTION_COLONY) return false;
      const buf = lastFrame?.animals;
      if (!buf) return false;
      for (let o = 0; o + ANIMAL_STRIDE <= buf.length; o += ANIMAL_STRIDE) {
        if (buf[o] === id) return true;
      }
      return false;
    };
    /** Pawns du tampon courant, prêts pour `selectInRect` (Maj + glisser gauche). */
    const pawnsForSelect = (): RectPawn[] => {
      const out: RectPawn[] = [];
      for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
        const id = curPawns[o];
        out.push({
          id,
          x: Math.floor(curPawns[o + 1] / 256),
          y: Math.floor(curPawns[o + 2] / 256),
          faction: curPawns[o + 10],
          livestock: isLivestockId(id),
        });
      }
      return out;
    };
    /**
     * Case franchissable pour `spreadTargets` (clic droit à plusieurs colons) :
     * même contrat que `map::Terrain::walkable` et `map::Feature::passable`
     * côté sim (`crates/sim/src/map.rs`) — pas la peine d'appeler le sim pour
     * choisir une case voisine, la marche réelle lui revient de toute façon
     * (`MoveTo` pathfinde pour de vrai, ceci ne fait que répartir les destinations).
     */
    const isFreeTile = (x: number, y: number): boolean => {
      const map = lastMapRef.current;
      if (!map || x < 0 || y < 0 || x >= map.width || y >= map.height) return false;
      const i = y * map.width + x;
      if (map.tiles[i] === TERRAIN.DeepWater) return false;
      return !BLOCKING_FEATURES.has(map.features[i]);
    };
    const applyTool = (rect: TileRect) => {
      if (!live()) return;
      switch (toolRef.current) {
        case "chop":
          issue(encodeDesignate(DESIGNATION.Chop, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "mine":
          issue(encodeDesignate(DESIGNATION.Mine, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "harvest":
          issue(encodeDesignate(DESIGNATION.Harvest, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "stockpile":
          issue(encodeSetZone(ZONE.Stockpile, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "growing":
          issue(encodeSetZone(ZONE.Growing, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "wall":
        case "door":
        case "floor":
        case "bed":
        case "campfire":
        case "craftingSpot":
          issue(
            encodeBuild(
              BUILD_TOOL_KIND[toolRef.current]!,
              materialRef.current,
              rect.x0,
              rect.y0,
              rect.x1,
              rect.y1,
            ),
          );
          break;
        case "researchBench":
          // L'établi n'existe qu'en bois (contrat sim, qui l'imposerait de
          // toute façon) : jamais `materialRef.current`, comme la tombe force
          // la pierre juste en dessous.
          issue(encodeBuild(BUILD_KIND.ResearchBench, MATERIAL.Wood, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "forge":
          // La forge n'existe qu'en pierre (contrat sim, qui l'imposerait de
          // toute façon) : jamais `materialRef.current`, même schéma que la
          // tombe. Refusée en silence par le sim sans `Tech::Metallurgy`, mais
          // l'outil est déjà grisé dans ce cas (voir le rendu de la barre).
          issue(encodeBuild(BUILD_KIND.Forge, MATERIAL.Stone, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "grave":
          // Les tombes n'existent qu'en pierre (contrat sim, qui l'imposerait
          // de toute façon) : jamais `materialRef.current`, pour ne pas
          // laisser croire que le choix du joueur y change quoi que ce soit.
          issue(encodeBuild(BUILD_KIND.Grave, MATERIAL.Stone, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "spikeTrap":
          // Le piège n'existe qu'en bois (contrat sim, qui l'imposerait de
          // toute façon) : jamais `materialRef.current`, même schéma que
          // l'établi de recherche et la tombe ci-dessus.
          issue(encodeBuild(BUILD_KIND.SpikeTrap, MATERIAL.Wood, rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "cancel":
          issue(encodeDesignate(DESIGNATION.None, rect.x0, rect.y0, rect.x1, rect.y1));
          issue(encodeSetZone(ZONE.None, rect.x0, rect.y0, rect.x1, rect.y1));
          issue(encodeCancelBuild(rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "select":
          break;
      }
    };
    on(host, "pointerdown", (e: PointerEvent) => {
      const tile = renderer.pickTile(e.clientX, e.clientY);
      // Maj + glisser gauche en mode Sélection : rectangle multi-colons plutôt
      // que panoramique (`AGENTS.md`) ; sans Maj, le glisser gauche continue
      // de déplacer la caméra comme avant (`setLeftDragPans` seul décide).
      const rectSelect = toolRef.current === "select" && e.button === 0 && e.shiftKey;
      down = { x: e.clientX, y: e.clientY, button: e.button, tile, rectSelect };
      if (rectSelect) renderer.setPanSuspended(true);
      if (tile && e.button === 0 && (rectSelect || toolRef.current !== "select")) {
        renderer.setDragRect({ x0: tile.x, y0: tile.y, x1: tile.x, y1: tile.y }, rectSelect ? SELECT_RECT_COLOR : toolColor());
      }
    });
    on(host, "pointermove", (e: PointerEvent) => {
      const tile = renderer.pickTile(e.clientX, e.clientY);
      renderer.setHover(tile);
      if (down && down.button === 0 && down.tile && tile && (down.rectSelect || toolRef.current !== "select")) {
        renderer.setDragRect(
          { x0: down.tile.x, y0: down.tile.y, x1: tile.x, y1: tile.y },
          down.rectSelect ? SELECT_RECT_COLOR : toolColor(),
        );
      }
    });
    on(host, "pointerup", (e: PointerEvent) => {
      if (!down) return;
      const start = down;
      down = null;
      renderer.setDragRect(null);
      if (start.rectSelect) renderer.setPanSuspended(false);
      if (!live()) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_TOLERANCE_PX;
      // Outil de débogage « Mettre le feu » : prend la main sur le clic quel
      // que soit l'outil courant, puis se désarme (mission incendies §4).
      // Clic droit : annule sans rien émettre, comme le reste des outils.
      if (igniteArmedRef.current) {
        if (start.button === 0) {
          if (!moved && start.tile) issue(encodeIgnite(start.tile.x, start.tile.y));
          setIgniteArmed(false);
        } else if (start.button === 2) {
          setIgniteArmed(false);
        }
        return;
      }
      if (start.rectSelect) {
        // Les colons (faction 0, pas de bête) dont la case tombe dans le
        // rectangle remplacent la sélection courante. Un glisser sans colon
        // dedans ne vide pas la sélection en cours (comme un clic à vide en
        // mode outil ne fait rien).
        if (start.tile) {
          const end = renderer.pickTile(e.clientX, e.clientY) ?? start.tile;
          const ids = selectInRect(pawnsForSelect(), { x0: start.tile.x, y0: start.tile.y, x1: end.x, y1: end.y });
          if (ids.length > 0) applySelection(ids);
        }
        return;
      }
      if (toolRef.current !== "select") {
        if (start.button === 0 && start.tile) {
          const end = renderer.pickTile(e.clientX, e.clientY) ?? start.tile;
          applyTool({
            x0: Math.min(start.tile.x, end.x),
            y0: Math.min(start.tile.y, end.y),
            x1: Math.max(start.tile.x, end.x),
            y1: Math.max(start.tile.y, end.y),
          });
        } else if (start.button === 2 && !moved) {
          setTool("select");
        }
        return;
      }
      if (moved) return;
      if (start.button === 0) {
        const picked = renderer.pickPawn(e.clientX, e.clientY);
        if (e.shiftKey) {
          // Maj + clic dans le vide : rien à ajouter ni retirer, on ne vide
          // pas la sélection en cours.
          if (picked !== null) applySelection(toggle(selection, picked));
        } else {
          applySelection(picked === null ? [] : [picked]);
        }
      } else if (start.button === 2 && selection.length > 0 && selected !== null) {
        const colonists = selection.filter((id) => factionOf(id) === FACTION_COLONY && !isLivestockId(id));
        if (colonists.length > 1) {
          // Plusieurs colons sélectionnés : une cible ennemie (ou une bête) les
          // envoie tous l'attaquer ; sinon chacun vers sa propre case autour de
          // celle visée (`spreadTargets`), pour ne pas s'empiler dessus.
          const target = renderer.pickPawn(e.clientX, e.clientY);
          const targetFaction = target !== null ? factionOf(target) : -1;
          const canAttack = targetFaction === FACTION_RAIDER || targetFaction === FACTION_ANIMAL;
          if (target !== null && canAttack) {
            for (const id of colonists) issue(encodeAttack(id, target));
          } else {
            const tile = renderer.pickTile(e.clientX, e.clientY);
            if (tile) {
              const targets = spreadTargets(tile, colonists.length, isFreeTile);
              for (let i = 0; i < colonists.length; i++) {
                const dest = targets[i] ?? tile;
                issue(encodeMoveTo(colonists[i], dest.x, dest.y));
              }
            }
          }
        } else {
          // Un seul colon (ou une sélection à un seul pawn, quel qu'il soit) :
          // comportement inchangé. Clic droit sur un ennemi ou un animal, avec
          // un colon sélectionné : ordre d'attaque. Sinon : déplacement (une
          // bête sélectionnée ne reçoit pas d'ordre d'attaque, le sim
          // l'ignorerait de toute façon).
          const target = renderer.pickPawn(e.clientX, e.clientY);
          const targetFaction = target !== null ? factionOf(target) : -1;
          const canAttack =
            factionOf(selected) !== FACTION_ANIMAL &&
            (targetFaction === FACTION_RAIDER || targetFaction === FACTION_ANIMAL);
          if (target !== null && canAttack) {
            issue(encodeAttack(selected, target));
          } else {
            const tile = renderer.pickTile(e.clientX, e.clientY);
            if (tile) issue(encodeMoveTo(selected, tile.x, tile.y));
          }
        }
      }
    });
    on(host, "pointerleave", () => renderer.setHover(null));
    on(host, "contextmenu", (e: MouseEvent) => e.preventDefault());
    on(window, "keydown", (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.code === "Space") {
        // Pas de pause en multi : l'horloge du serveur ne s'arrête jamais.
        if (!isMulti) {
          paused = !paused;
          bridge.setPaused(paused);
        }
        e.preventDefault();
        return;
      }
      const k = e.key.toUpperCase();
      if ((e.metaKey || e.ctrlKey) && k === KEY.selectAll) {
        // Ctrl/Cmd + A : tous les colons de la colonie (faction 0, pas de bête).
        e.preventDefault();
        const ids: number[] = [];
        for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
          const id = curPawns[o];
          if (curPawns[o + 10] === FACTION_COLONY && !isLivestockId(id)) ids.push(id);
        }
        applySelection(ids);
        return;
      }
      if (e.metaKey || e.ctrlKey) return;
      if (k === "H") {
        // La touche H bascule la chasse quand un animal est sélectionné ;
        // sinon elle garde son sens historique (outil Récolter). Voir
        // `hKeyAction`, testé sans DOM dans `terrain.test.ts`.
        const animal = animalOf(selected);
        if (hKeyAction(animal ? animal.species : -1) === "hunt" && selected !== null && animal !== null) {
          issue(encodeHunt(selected, !animal.hunted));
        } else {
          setTool("harvest");
        }
        return;
      }
      const toolHit = TOOLS.find((t) => t.key === k);
      if (toolHit) {
        setTool(toolHit.id);
        return;
      }
      if (k === KEY.material) {
        setMaterial(materialRef.current === 0 ? 1 : 0);
        return;
      }
      if (k === KEY.work) {
        setShowWork((v) => !v);
        return;
      }
      if (k === KEY.craft) {
        setShowCraft((v) => !v);
        return;
      }
      if (k === KEY.research) {
        setShowResearch((v) => !v);
        return;
      }
      if (k === KEY.journal) {
        setShowJournal((v) => !v);
        return;
      }
      if (k === KEY.heat) {
        setHeatMode((v) => !v);
        return;
      }
      switch (k) {
        case "Q":
          renderer.rotate(-1);
          break;
        case "E":
          renderer.rotate(1);
          break;
        case "1":
        case "2":
        case "3":
          if (!isMulti) {
            speed = Number(k);
            bridge.setSpeed(speed);
          }
          break;
        case "ESCAPE":
          // L'aide se ferme en tout premier (elle recouvre le reste), puis le
          // menu Options : ni l'un ni l'autre n'a bougé l'outil ou la
          // sélection pendant qu'il était ouvert. L'outil « Mettre le feu »
          // désarmé ensuite, avant l'outil courant.
          if (showHelpRef.current) setShowHelp(false);
          else if (showOptionsRef.current) setShowOptions(false);
          else if (igniteArmedRef.current) setIgniteArmed(false);
          else if (toolRef.current !== "select") setTool("select");
          else applySelection([]);
          break;
      }
    });

    // --- Crochet de debug (dev uniquement) : window.__rimlike ---
    if (import.meta.env.DEV) {
      const debug = {
        /**
         * Exécute une méthode de `SimHandle` dans le Worker, ou du
         * `LockstepClient` si elle est préfixée `lockstep.`. Asynchrone :
         * le sim n'est plus sur ce thread.
         */
        rpc: (method: string, ...args: unknown[]) => bridge.rpc(method, ...args),
        /** Même chemin que l'UI. Le tampon est copié : l'appelant garde le sien. */
        issue: (bytes: Uint8Array) => bridge.issue(bytes.slice()),
        get frame() {
          return lastFrame;
        },
        get net() {
          return netState;
        },
        renderer,
        setTool,
        setMaterial,
        actions,
        get paused() {
          return paused;
        },
        set paused(v: boolean) {
          paused = v;
          bridge.setPaused(v);
        },
        get speed() {
          return speed;
        },
        set speed(v: number) {
          speed = v;
          bridge.setSpeed(v);
        },
        get selected() {
          return selected;
        },
        set selected(v: number | null) {
          applySelection(v === null ? [] : [v]);
        },
        /** Sélection courante, ordonnée (`selection.ts`) : copie, jamais la référence interne. */
        get selection() {
          return selection.slice();
        },
        set selection(ids: number[]) {
          applySelection(ids.slice());
        },
        /** Copie du Journal des événements accumulé depuis le début de la session. */
        eventLog: () => eventLogRef.current.slice(),
      };
      // `WorldScreen` publie `__rimlike.world` de son côté, et l'effet du
      // canevas partagé `__rimlike.gl` : le crochet de la partie ne doit pas
      // les emporter en remplaçant l'objet.
      const hook = window as unknown as { __rimlike?: Record<string, unknown> };
      const world = hook.__rimlike?.world;
      const sharedGl = hook.__rimlike?.gl;
      const entries = debug as unknown as Record<string, unknown>;
      if (world !== undefined) entries.world = world;
      if (sharedGl !== undefined) entries.gl = sharedGl;
      hook.__rimlike = entries;
    }

    // --- HUD ---
    interval = window.setInterval(() => {
      const now = performance.now();
      const dt = (now - windowStart) / 1000;
      const fps = Math.round(framesInWindow / dt);
      framesInWindow = 0;
      windowStart = now;
      const f = lastFrame;
      if (f === null) {
        setStats((prev) => ({ ...prev, tps: 0, fps, drawCalls: renderer.drawCalls, lag: netState?.lag ?? 0 }));
        return;
      }
      const tod = f.timeOfDay / f.ticksPerDay;
      const minutes = Math.floor(tod * 24 * 60);
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      let info: PawnInfo | null = null;
      let colonists = 0;
      let hostiles = 0;
      let beasts = 0;
      // Sang par id : le panneau Caravane l'affiche pour chaque colon, une
      // recherche linéaire par colon coûterait un balayage de plus par tour.
      const bloodById = new Map<number, number>();
      for (let h = 0; h + HEALTH_STRIDE <= f.health.length; h += HEALTH_STRIDE) {
        bloodById.set(f.health[h], f.health[h + 1] / 10);
      }
      // Arme équipée par id, depuis `frame.weapons` : pas de RPC, c'est déjà là.
      const weaponById = new Map<number, number>();
      for (let w = 0; w + 2 <= f.weapons.length; w += 2) {
        weaponById.set(f.weapons[w], f.weapons[w + 1]);
      }
      // Habit porté par id, depuis `frame.apparel` : même contrat que `weaponById`.
      const apparelById = new Map<number, number>();
      for (let a = 0; a + 2 <= f.apparel.length; a += 2) {
        apparelById.set(f.apparel[a], f.apparel[a + 1]);
      }
      // Traits par id, depuis `frame.traits` (stride 3, `-1` filtré) : même
      // contrat que `weaponById`/`apparelById`, sans RPC.
      const traitsById = new Map<number, number[]>();
      for (let t = 0; t + 3 <= f.traits.length; t += 3) {
        traitsById.set(
          f.traits[t],
          [f.traits[t + 1], f.traits[t + 2]].filter((v) => v >= 0),
        );
      }
      // Espèce et drapeaux par id, depuis `frame.animals` : pas de RPC non
      // plus. Couvre les bêtes sauvages **et** de la colonie (la faction du
      // tampon `pawns` les départage) : jamais `!== 0` sur les drapeaux, la
      // chasse seule n'en vaut plus la valeur entière (`ANIMAL_FLAG`).
      const animalById = new Map<number, { species: number; flags: number }>();
      for (let a = 0; a + ANIMAL_STRIDE <= f.animals.length; a += ANIMAL_STRIDE) {
        animalById.set(f.animals[a], { species: f.animals[a + 1], flags: f.animals[a + 2] });
      }
      const colonistList: CaravanColonist[] = [];
      const colonistBadges: ColonistBadge[] = [];
      for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
        const pid = curPawns[o];
        const faction = curPawns[o + 10];
        const hostile = faction === FACTION_RAIDER;
        const isAnimal = faction === FACTION_ANIMAL;
        // Le marchand n'est ni un colon (pas embarquable en caravane, pas de
        // pastille dans `ColonistBar`), ni un ennemi, ni une bête : sa
        // présence se lit à part, dans `frame.traderPresent`.
        const isTrader = faction === FACTION_TRADER;
        // Bête **de la colonie** (faction 0 avec espèce ≥ 0, `sim::livestock`) :
        // ni colon, ni gibier, ni pillard, ni marchand. Comme le marchand, à
        // exclure de chaque compte et de chaque liste de « colons » ci-dessous.
        const isLivestock = faction === FACTION_COLONY && animalById.has(pid);
        if (hostile) hostiles++;
        else if (isAnimal) beasts++;
        else if (!isTrader && !isLivestock) colonists++;
        if (!hostile && !isAnimal && !isTrader && !isLivestock) {
          const flags = curPawns[o + 3];
          const name = f.names[pid] ?? "";
          colonistList.push({
            id: pid,
            name,
            downed: (flags & PAWN_FLAGS.DOWNED) !== 0,
            hp: (curPawns[o + 11] * 100) / HP_MAX,
            blood: bloodById.get(pid) ?? 0,
          });
          const colorHex = PAWN_COLORS[pid % PAWN_COLORS.length];
          colonistBadges.push({
            id: pid,
            name,
            initial: (name || "?").charAt(0).toUpperCase(),
            color: `#${colorHex.toString(16).padStart(6, "0")}`,
            hp: (curPawns[o + 11] * 100) / HP_MAX,
            downed: (flags & PAWN_FLAGS.DOWNED) !== 0,
            sleeping: (flags & PAWN_FLAGS.SLEEPING) !== 0,
            mood: curPawns[o + 6] / 10,
            job: JOB_LABELS[curPawns[o + 7]] ?? "?",
            sick: (sickById.get(pid) ?? 0) > 0,
            traits: traitsById.get(pid) ?? [],
          });
        }
        if (pid !== selected) continue;
        const id = pid;
        const ck = curPawns[o + 8];
        const mood = curPawns[o + 6] / 10;
        let blood = 0;
        let consciousness = 0;
        for (let h = 0; h + HEALTH_STRIDE <= f.health.length; h += HEALTH_STRIDE) {
          if (f.health[h] !== id) continue;
          blood = f.health[h + 1] / 10;
          consciousness = f.health[h + 2];
          break;
        }
        const skills: SkillInfo[] = [];
        if (!hostile && !isAnimal && !isTrader && !isLivestock) {
          for (let s = 0; s + SKILL_STRIDE <= f.skills.length; s += SKILL_STRIDE) {
            if (f.skills[s] !== id) continue;
            for (let w = 0; w < WORK_LABELS.length; w++) {
              const level = f.skills[s + 1 + w * 2];
              const xp = f.skills[s + 1 + w * 2 + 1];
              skills.push({ work: w, level, xp, xpToNext: xpToNext(level) });
            }
            break;
          }
        }
        const animalInfo = animalById.get(id);
        const species = animalInfo?.species ?? -1;
        const flags = animalInfo?.flags ?? 0;
        // Le PV brut se lit sur l'échelle de l'espèce (`Species::max_hp`),
        // pour une bête sauvage comme pour une bête de la colonie — jamais
        // `HP_MAX` (colons, pillards et marchand seulement).
        const maxHp = isAnimal || isLivestock ? (SPECIES_MAX_HP[species] ?? HP_MAX) : HP_MAX;
        info = {
          id,
          name: f.names[id] ?? "",
          tile: { x: Math.floor(curPawns[o + 1] / 256), y: Math.floor(curPawns[o + 2] / 256) },
          hunger: curPawns[o + 4] / 10,
          rest: curPawns[o + 5] / 10,
          mood,
          moodLabel: moodLabel(mood),
          breaking: curPawns[o + 7] === JOB_BREAK,
          hp: (curPawns[o + 11] * 100) / maxHp,
          hostile,
          job: JOB_LABELS[curPawns[o + 7]] ?? "?",
          carrying: ck >= 0 ? `${curPawns[o + 9]} ${ITEM_NAMES[ck]}` : null,
          downed: (curPawns[o + 3] & PAWN_FLAGS.DOWNED) !== 0,
          blood,
          consciousness,
          injuries: selectedInjuriesId === id ? selectedInjuries : [],
          skills,
          weapon: weaponById.get(id) ?? -1,
          apparel: apparelById.get(id) ?? -1,
          traits: traitsById.get(id) ?? [],
          ...(selectedCombatId === id
            ? selectedCombat
            : { meleeLevel: 0, meleeXp: 0, rangedLevel: 0, rangedXp: 0 }),
          comfort: selectedComfortId === id ? selectedComfort : 0,
          sickHours: selectedSickId === id ? sickHoursRemaining(selectedSick) : 0,
          animal: isAnimal,
          species,
          hunted: (flags & ANIMAL_FLAG.Hunted) !== 0,
          tameMarked: (flags & ANIMAL_FLAG.TameMarked) !== 0,
          livestock: isLivestock,
          slaughterMarked: (flags & ANIMAL_FLAG.SlaughterMarked) !== 0,
          trader: isTrader,
          relations: selectedRelationsId === id ? selectedRelations : [],
        };
      }
      // Blessures, compétences de combat et ressenti du colon sélectionné :
      // rafraîchis ici (2 fois par seconde), affichés à la prochaine passe
      // pour ne pas attendre l'aller-retour.
      if (info !== null) {
        if (selectedInjuriesId !== info.id) {
          selectedInjuriesId = info.id;
          selectedInjuries = [];
        }
        if (selectedCombatId !== info.id) {
          selectedCombatId = info.id;
          selectedCombat = { meleeLevel: 0, meleeXp: 0, rangedLevel: 0, rangedXp: 0 };
        }
        if (selectedComfortId !== info.id) {
          selectedComfortId = info.id;
          selectedComfort = 0;
        }
        if (selectedSickId !== info.id) {
          selectedSickId = info.id;
          selectedSick = 0;
        }
        if (selectedRelationsId !== info.id) {
          selectedRelationsId = info.id;
          selectedRelations = [];
          // Sélection neuve : on relit tout de suite, pas au bout d'une seconde.
          relationsRefreshedAt = -Infinity;
        }
        const id = info.id;
        void bridge
          .rpc("pawnInjuries", id)
          .then((raw) => {
            if (selectedInjuriesId !== id) return; // sélection changée entre-temps
            const buf = raw as Int32Array;
            const list: InjuryInfo[] = [];
            for (let o = 0; o + 4 <= buf.length; o += 4) {
              list.push({ part: buf[o], severity: buf[o + 1], bleeding: buf[o + 2], tended: buf[o + 3] !== 0 });
            }
            selectedInjuries = list;
          })
          .catch(() => {
            /* colon disparu entre-temps : rien à afficher au prochain tour */
          });
        void bridge
          .rpc("pawnCombatSkills", id)
          .then((raw) => {
            if (selectedCombatId !== id) return; // sélection changée entre-temps
            const buf = raw as Int32Array;
            if (buf.length < 4) return; // id disparu entre-temps
            selectedCombat = { meleeLevel: buf[0], meleeXp: buf[1], rangedLevel: buf[2], rangedXp: buf[3] };
          })
          .catch(() => {
            /* colon disparu entre-temps : rien à afficher au prochain tour */
          });
        void bridge
          .rpc("pawnComfort", id)
          .then((raw) => {
            if (selectedComfortId !== id) return; // sélection changée entre-temps
            selectedComfort = raw as number;
          })
          .catch(() => {
            /* colon disparu entre-temps : rien à afficher au prochain tour */
          });
        void bridge
          .rpc("pawnSick", id)
          .then((raw) => {
            if (selectedSickId !== id) return; // sélection changée entre-temps
            selectedSick = raw as number;
          })
          .catch(() => {
            /* colon disparu entre-temps : rien à afficher au prochain tour */
          });
        // Une fois par seconde seulement (voir la déclaration de
        // `relationsRefreshedAt`), pas au rythme des autres accesseurs ci-dessus.
        if (now - relationsRefreshedAt >= 1000) {
          relationsRefreshedAt = now;
          void bridge
            .rpc("pawnOpinions", id)
            .then((raw) => {
              if (selectedRelationsId !== id) return; // sélection changée entre-temps
              selectedRelations = sortOpinions(decodeOpinions(raw as Int32Array));
            })
            .catch(() => {
              /* colon disparu entre-temps : rien à afficher au prochain tour */
            });
        }
      } else {
        selectedInjuriesId = null;
        selectedInjuries = [];
        selectedCombatId = null;
        selectedComfortId = null;
        selectedSickId = null;
        selectedRelationsId = null;
        selectedRelations = [];
      }
      // Pastille « malade » de la barre des colons : un `pawnSick` par colon
      // vivant, comme les autres accesseurs ponctuels ci-dessus (pas dans le
      // tampon `pawns`, `PAWN_STRIDE` ne bouge pas). Rafraîchi ici, affiché à
      // la prochaine passe du HUD (500 ms), sans bloquer `setStats` en attendant.
      for (const c of colonistList) {
        const pid = c.id;
        void bridge
          .rpc("pawnSick", pid)
          .then((raw) => sickById.set(pid, raw as number))
          .catch(() => {
            /* colon disparu entre-temps : la pastille garde sa dernière valeur connue */
          });
      }
      // Pastille de fraîcheur du HUD stock : un toast discret la première
      // fois qu'un genre périssable passe sous 20 % (`freshnessLevel`), pas
      // un par demi-seconde tant que ça dure (voir `lowFreshnessActive`).
      const lowFreshness = f.foodFreshness.some((v) => v >= 0 && freshnessLevel(v) === "bad");
      if (lowFreshness && !lowFreshnessActive) {
        lowFreshnessActive = true;
        pushToast("Des vivres vont se perdre");
      } else if (!lowFreshness) {
        lowFreshnessActive = false;
      }
      // Mini-carte : pawns, feu et rectangle de vue, à la cadence du HUD
      // seulement (jamais à chaque frame, voir l'en-tête de `Minimap.tsx`).
      minimapRef.current?.update(curPawns, f.animals, lastFire, renderer.viewBounds());
      setStats({
        tick: f.tick,
        day: Math.floor(f.tick / f.ticksPerDay) + 1,
        hour: `${hh}:${mm}`,
        hash: lastHash,
        // Ticks par seconde mesurés dans le Worker, images par seconde ici.
        tps: f.tps,
        fps,
        // Échantillonné à la cadence du HUD (voir `Renderer.drawCalls`), jamais par frame.
        drawCalls: renderer.drawCalls,
        speed,
        paused,
        weather: f.weather,
        season: f.season,
        dayOfYear: f.dayOfYear,
        yearDays: f.yearDays,
        temperature: f.temperature,
        stored: Array.from(f.stored),
        blueprints: f.blueprints.length / BLUEPRINT_STRIDE,
        colonists,
        hostiles,
        beasts,
        selected: info,
        selection: selection.slice(),
        priorities: Array.from(f.priorities),
        names: f.names,
        colonistList,
        colonistBadges,
        departures: f.departures,
        lag: f.lag,
        craftTargets: Array.from(f.craftTargets),
        hasCraftingSpot: craftingSpotCount > 0,
        hasResearchBench: researchBenchCount > 0,
        hasForge: forgeCount > 0,
        ticksPerDay: f.ticksPerDay,
        difficulty: f.difficulty,
        wealth: f.wealth,
        traderPresent: f.traderPresent,
        traderLeavesIn: f.traderLeavesIn,
        traderOffers: Array.from(f.traderOffers),
        buyPrices: Array.from(f.buyPrices),
        foodFreshness: Array.from(f.foodFreshness),
        researchState: Array.from(f.researchState),
        fireCount: f.fireCount,
        livestockCount: f.livestockCount,
        goodwill: Array.from(f.goodwill),
        lastRaidFaction: f.lastRaidFaction,
      });
    }, 500);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(interval);
      for (const t of toastTimers) clearTimeout(t);
      for (const c of cleanups) c();
      // Fermeture propre de la salle : dernière chance de remonter la
      // réputation avant que `dispose()` ne termine le Worker (§14.4).
      bridge.leave();
      bridge.dispose();
      // Rend les ressources de cet écran, **pas** le contexte partagé : c'est
      // `release` qui décompte, et il ne détruit jamais le renderer.
      renderer.dispose();
      gl.release();
      actionsRef.current = null;
      rendererRef.current = null;
      glRef.current = null;
      bridgeRef.current = null;
      dispatcherRef.current = null;
      isHostRef.current = false;
      // Une carte neuve (nouvelle partie, nouvelle salle) n'a pas encore de
      // `map` : la mini-carte ne doit pas repeindre celle de la partie d'avant
      // (voir l'effet `[running]` juste avant le `return` du composant).
      lastMapRef.current = null;
    };
  }, [session]);

  /**
   * Mode chaleur (touche I, bouton « Chaleur ») : colore les cases par
   * température. `tileTemperatures()` scrute toute la grille côté sim (16 384
   * appels WASM sur 128×128) : on ne l'appelle qu'à ce rythme (2×/s), et
   * seulement pendant que le mode est actif — jamais à chaque frame.
   */
  useEffect(() => {
    rendererRef.current?.setHeatMode(heatMode);
    if (!heatMode) return;
    let cancelled = false;
    const poll = () => {
      const bridge = bridgeRef.current;
      if (bridge === null || cancelled) return;
      void bridge
        .rpc("tileTemperatures")
        .then((raw) => {
          if (cancelled || !(raw instanceof Int32Array)) return;
          rendererRef.current?.setHeatData(raw);
        })
        .catch(() => {
          // Worker fermé ou partie pas encore démarrée : on retentera au prochain battement.
        });
    };
    poll();
    const id = window.setInterval(poll, 500);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [heatMode]);

  /**
   * Itinéraire prévisualisé vers la destination retenue. `findRoute` est le
   * même code que le serveur (`packages/world`) : l'estimation affichée est la
   * bonne, mais c'est la route calculée côté serveur qui voyagera.
   */
  const caravanRoute = useMemo(() => {
    if (globe === null || roomTile === null || caravanTo === null) return null;
    if (globe.tiles[roomTile] === undefined || globe.tiles[caravanTo] === undefined) return null;
    return findRoute(globe, roomTile, caravanTo);
  }, [globe, roomTile, caravanTo]);

  const caravanDestination: CaravanDestination | null =
    globe === null || caravanTo === null || globe.tiles[caravanTo] === undefined
      ? null
      : {
          tile: caravanTo,
          biome: BIOME_NAMES[globe.tiles[caravanTo].biome],
          hours: caravanRoute?.hours ?? null,
          steps: caravanRoute?.tiles.length ?? 0,
          ownerName: worldNet?.settlements.find((s) => s.tile === caravanTo)?.ownerName ?? null,
        };

  /**
   * Forme une caravane : la destination entre dans la file de l'expéditeur
   * **avant** la commande, l'ordre des deux files devant coïncider (le serveur
   * garantit l'ordre des commandes, `docs/protocol.md` §5).
   */
  /**
   * Règle l'objectif de fabrication d'une arme (`render/terrain.ts::WEAPON_NAMES`).
   * Borné à 0..20 par le panneau (`clampCraftTarget`) : le sim, lui, accepte
   * n'importe quel entier.
   */
  const setCraftTarget = (kind: number, target: number) => {
    bridgeRef.current?.issue(encodeSetCraftTarget(kind, clampCraftTarget(target)));
  };

  /**
   * Choisit la technologie cherchée (`ResearchPanel`, clic sur une ligne non
   * acquise), ou l'arrête (255, bouton « Arrêter »). Le sim ignore en silence
   * une technologie déjà acquise ou un numéro invalide.
   */
  const setResearch = (tech: number) => {
    bridgeRef.current?.issue(encodeSetResearch(tech));
  };

  /**
   * Propose un troc au marchand présent (`TradePanel`). Le panneau ne
   * prévalide que pour prévenir : le sim est seul juge (`crates/sim/src/trade.rs`)
   * et refuse en silence un troc mal formé.
   */
  const proposeTrade = (give: number, giveCount: number, take: number, takeCount: number) => {
    bridgeRef.current?.issue(encodeTrade(give, giveCount, take, takeCount));
  };

  /**
   * Offre un tribut à une faction PNJ (`FactionsPanel`). Le sim est seul juge
   * (`crates/sim/src/factions.rs`) et ignore en silence un tribut mal formé ;
   * `giftGain` du panneau n'est qu'une estimation.
   */
  const giftFaction = (faction: number, kind: number, count: number) => {
    bridgeRef.current?.issue(encodeGift(faction, kind, count));
  };

  const formCaravan = (
    pawnIds: readonly number[],
    items: readonly (readonly [number, number])[],
    toTile: number,
    onDispatched?: (departure: DispatchedDeparture) => void,
  ): boolean => {
    const dispatcher = dispatcherRef.current;
    const bridge = bridgeRef.current;
    if (dispatcher === null || bridge === null || roomTile === null) return false;
    // Le serveur refuse une caravane qui n'irait nulle part (`caravan_same_tile`),
    // et les colons seraient déjà sortis de la carte : mieux vaut ne rien former.
    if (toTile === roomTile) return false;
    dispatcher.planDestination(toTile, (departure) => {
      worldToast(`Caravane en route vers la case ${departure.toTile}`);
      onDispatched?.(departure);
    });
    bridge.issue(
      encodeFormCaravan(
        [...pawnIds],
        items.map(([kind]) => kind),
        items.map(([, count]) => count),
      ),
    );
    return true;
  };

  /** Le crochet de dev : tout le flux, sans souris. */
  const sendCaravanOrder = (order: CaravanOrder): Promise<DispatchedDeparture> =>
    new Promise((resolve, reject) => {
      if (roomTile === null) {
        reject(new Error("aucune colonie du monde en cours : il faut être dans une salle tile-N"));
        return;
      }
      if (!isHostRef.current) {
        reject(new Error("seul l'hôte de la salle expédie les caravanes (docs/protocol.md §12.7)"));
        return;
      }
      // Vérifié ici plutôt qu'attendu du serveur : sans route, les colons
      // seraient sortis de la carte pour un convoi que le serveur refuse.
      if (globe !== null && findRoute(globe, roomTile, order.toTile) === null) {
        reject(new Error(`aucune route terrestre entre les cases ${roomTile} et ${order.toTile}`));
        return;
      }
      if (!formCaravan(order.pawnIds, order.items, order.toTile, resolve)) {
        reject(new Error("destination invalide, ou Worker de simulation pas prêt"));
      }
    });

  /**
   * Touche V : ouvrir ou fermer le panneau Caravane. Échap : sortir du mode
   * « choisir la case d'arrivée ». Écouteur à part de celui de la partie, dont
   * les fermetures sont figées à la création de la session.
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.metaKey || e.ctrlKey) return;
      const k = e.key.toUpperCase();
      if (k === "ESCAPE" && caravanPicking) {
        setCaravanPicking(false);
        return;
      }
      if (k === KEY.caravan && roomTile !== null) {
        setCaravanOpen((open) => !open);
        setCaravanPicking(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [caravanPicking, roomTile]);

  /** Quitter la salle referme le panneau : il parle d'une colonie précise. */
  useEffect(() => {
    if (roomTile === null) {
      setCaravanOpen(false);
      setCaravanPicking(false);
      setCaravanTo(null);
    }
  }, [roomTile]);

  /**
   * Touche `?` ou `F1` : ouvre ou ferme l'aide des raccourcis, à tout moment
   * (accueil, lobby, écran Monde ou en partie) — écouteur à part de celui de
   * la partie, comme la touche `V` ci-dessus, puisqu'elle n'a besoin d'aucun
   * état de sim. `Échap` la ferme ; en partie, le gestionnaire de `keydown`
   * de la partie s'en charge aussi en priorité (voir `showHelpRef`), ce
   * doublon est sans effet (`setShowHelp(false)` deux fois de suite).
   */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.target instanceof HTMLInputElement) return;
      if (e.metaKey || e.ctrlKey) return;
      if (e.key === KEY.helpAlt || e.key === KEY.help) {
        e.preventDefault();
        setShowHelp(!showHelpRef.current);
        return;
      }
      if (e.key.toUpperCase() === "ESCAPE" && showHelpRef.current) {
        setShowHelp(false);
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  /**
   * Le marchand reprend la route ou meurt (`frame.traderPresent` passe à −1,
   * §4 de la mission) : le panneau Troc n'a plus personne à qui parler, il se
   * ferme avec un message bref plutôt que de disparaître sans un mot.
   */
  useEffect(() => {
    if (stats.traderPresent < 0 && showTrade) {
      setShowTrade(false);
      setNotice("Le marchand est parti");
      const t = window.setTimeout(() => setNotice(null), 1800);
      return () => window.clearTimeout(t);
    }
  }, [stats.traderPresent, showTrade]);

  if (error) return <div className="error">{error}</div>;

  const sel = stats.selected;
  /**
   * Plusieurs colons sélectionnés (Maj + clic, rectangle, Ctrl/Cmd + A) : le
   * panneau détaillé d'un seul pawn cède la place à la liste courte, plus bas.
   */
  const multiSelection = stats.selection.length > 1;
  // Saison affichée « j.X/Y » : X = jour dans la saison (1-indexé, comme
  // `stats.day`), Y = longueur d'une saison (`sim::climate::SEASON_DAYS`).
  const seasonDays = Math.max(1, Math.floor(stats.yearDays / 4));
  const dayInSeason = (stats.dayOfYear % seasonDays) + 1;
  const workRows: { id: number; prio: number[] }[] = [];
  for (let o = 0; o + PRIORITY_STRIDE <= stats.priorities.length; o += PRIORITY_STRIDE) {
    workRows.push({ id: stats.priorities[o], prio: stats.priorities.slice(o + 1, o + PRIORITY_STRIDE) });
  }
  // Recherche : décodée une fois ici, réutilisée par le HUD et `ResearchPanel`.
  const researchInfo = decodeResearch(stats.researchState);
  const currentTechInfo = researchInfo.techs.find((t) => t.tech === researchInfo.current) ?? null;
  // Seule technologie qui verrouille quelque chose (voir `research.ts`) :
  // grise l'outil Forge de la barre d'outils tant qu'elle n'est pas acquise.
  const metallurgyDone = researchInfo.techs.find((t) => t.tech === TECH_METALLURGY)?.done ?? false;
  const cyclePriority = (pawn: number, work: number, shown: number, dir: 1 | -1) => {
    const current = actionsRef.current?.currentPriority(pawn, work) ?? shown;
    actionsRef.current?.setPriority(pawn, work, nextPriority(current, dir));
  };
  // Le HUD de colonie n'existe que dans une partie : sans session, l'écran est
  // celui de l'accueil ou du monde, qui ont leur propre interface.
  const running = session !== null && (!multi || (net !== null && net.phase === "running" && net.ready));
  const inWorld = worldSession !== null;
  /**
   * La mini-carte se monte en même temps que le HUD (`running`), mais peut
   * apparaître après le `map` déjà reçu par le Worker (un rejoignant multi :
   * la carte arrive au démarrage de l'hôte, avant que `net.ready` ne bascule
   * `running`) : on repeint son fond depuis la dernière carte connue dès
   * qu'elle existe, plutôt que de la laisser vide jusqu'au prochain mur posé.
   */
  useEffect(() => {
    if (!running) return;
    const map = lastMapRef.current;
    if (map) minimapRef.current?.setMap(map.width, map.height, map.tiles, map.features);
  }, [running]);
  /**
   * Quitte la salle et revient au globe, sans retélécharger quoi que ce soit :
   * le Worker (et donc sa connexion) est fermé par le nettoyage de l'effet,
   * mais la connexion monde et le globe restent en place.
   */
  const backToWorld = () => {
    setImposedSeed(null);
    setNet(null);
    setStats(INITIAL);
    setSession(null);
  };
  const quitWorld = () => {
    worldRef.current?.leave();
    setWorldSession(null);
    setNet(null);
    setStats(INITIAL);
    setSession(null);
    setInitialWorldTile(null);
  };
  /**
   * Bouton « Réessayer » du bandeau « Serveur injoignable » (`Lobby`,
   * `docs/protocol.md` §4) : la reconnexion automatique (`ReconnectingTransport`)
   * a épuisé ses `MAX_RECONNECT_ATTEMPTS` tentatives, il n'y a plus de
   * `Transport` vivant à relancer. On repart d'un `session` neuf (même
   * référence de champs, nouvel objet) : l'effet ci-dessous le voit comme un
   * changement, ferme le Worker mort et en ouvre un tout neuf, avec sa propre
   * `ReconnectingTransport` fraîche.
   */
  const retryConnection = () => {
    setSession((prev) => (prev === null ? prev : { ...prev }));
  };
  /**
   * Rejoindre une salle listée par « Salles ouvertes » (§2 du protocole) : une
   * salle simple préremplit le champ salle puis connecte tout de suite avec
   * le nom déjà saisi ; une salle « case » ouvre l'écran Monde avec la case
   * présélectionnée, un bouton « Visiter » y est déjà proposé (même flux que
   * `WorldScreen.onVisit`).
   */
  const joinRoom = (room: RoomInfo) => {
    if (room.players >= room.maxPlayers) return; // grisé côté accueil, refusé ici par sécurité
    if (room.isTile) {
      if (room.tile === undefined) return;
      setInitialWorldTile(room.tile);
      setWorldSession({ server: form.server, name: form.name });
      return;
    }
    setForm({ ...form, room: room.name });
    setSession({ mode: "multi", server: form.server, room: room.name, name: form.name });
  };
  // Graine effective d'un `start` : celle de la case l'emporte (le serveur
  // l'impose de toute façon, docs/protocol.md §11.2).
  const startSeed = Math.max(0, Math.floor(imposedSeed ?? seed));
  return (
    <>
      <div ref={sceneHostRef} className="scene" />
      {/* Hors du bloc `running` exprès : l'aide (touche `?`/`F1`) doit rester
          consultable depuis l'accueil ou le lobby, pas seulement en partie. */}
      {showHelp && <HelpPanel onClose={() => setShowHelp(false)} />}
      {inWorld && globe !== null && worldSession !== null && (
        <WorldScreen
          world={globe}
          net={worldNet}
          name={worldSession.name}
          // Le globe repasse devant la colonie le temps de choisir la case
          // d'arrivée d'une caravane, puis se remasque.
          visible={globeVisible}
          initialTile={initialWorldTile}
          onSettle={(tile) => worldRef.current?.settle(tile)}
          onVisit={(tile) => worldRef.current?.visit(tile)}
          onAbandon={(tile) => worldRef.current?.abandon(tile)}
          onBack={backToWorld}
          onQuit={quitWorld}
          describeIdentity={() => worldRef.current?.identitySummary ?? null}
          onForgetIdentity={() => worldRef.current?.forgetIdentity()}
          pickingFrom={caravanPicking ? roomTile : null}
          onPickTile={(tile) => {
            setCaravanTo(tile);
            setCaravanPicking(false);
            setCaravanOpen(true);
          }}
          onCancelPick={() => setCaravanPicking(false)}
          routePreview={caravanRoute?.tiles ?? null}
          onCancelCaravan={(id) => worldRef.current?.cancelCaravan(id)}
          onSendCaravan={sendCaravanOrder}
        />
      )}
      {session === null && inWorld && globe === null && (
        <GlobeLoading load={globeLoad} server={worldSession?.server ?? ""} onCancel={quitWorld} />
      )}
      {session === null && !inWorld ? (
        <HomeScreen
          form={form}
          onChange={setForm}
          difficulty={homeDifficulty}
          onDifficultyChange={setHomeDifficulty}
          onSolo={() => setSession({ mode: "solo", difficulty: homeDifficulty })}
          onJoin={() => setSession({ mode: "multi", ...form })}
          onWorld={() => {
            setInitialWorldTile(null);
            setWorldSession({ server: form.server, name: form.name });
          }}
          rooms={rooms}
          roomsTruncated={roomsTruncated}
          roomsError={roomsError}
          roomFilter={roomFilter}
          onRoomFilterChange={setRoomFilter}
          roomsLobbyOnly={roomsLobbyOnly}
          onRoomsLobbyOnlyChange={setRoomsLobbyOnly}
          onJoinRoom={joinRoom}
        />
      ) : (
        session !== null &&
        multi &&
        !running && (
          <Lobby
            room={session.mode === "multi" ? session.room : ""}
            net={net}
            seed={seed}
            onSeed={setSeed}
            imposedSeed={imposedSeed}
            difficulty={multiDifficulty}
            onDifficulty={setMultiDifficulty}
            onBackToWorld={inWorld ? backToWorld : null}
            onRetry={retryConnection}
            onGoHome={quitWorld}
            // Le serveur n'accepte qu'un entier positif comme graine.
            onStart={() => bridgeRef.current?.startGame(startSeed, MAP_SIZE, MAP_SIZE, multiDifficulty)}
          />
        )
      )}

      {/* Pendant le choix de la case d'arrivée, le globe reprend tout l'écran :
          le HUD de colonie et sa barre d'outils passeraient par-dessus. */}
      {running && !caravanPicking && (
        <>
          <div className="hud">
            <div>
              jour <b>{stats.day}</b> · <b>{stats.hour}</b> · {SEASON_LABELS[stats.season] ?? "?"} j.{dayInSeason}/
              {seasonDays} · {formatTemperature(stats.temperature)} · {WEATHER_LABELS[stats.weather] ?? "?"} · tick{" "}
              {stats.tick}
              {multi ? "" : stats.paused ? <b> · PAUSE</b> : ` · x${stats.speed}`}
              {stats.difficulty !== DIFFICULTY.Normal ? ` · ${DIFFICULTY_LABELS[stats.difficulty] ?? "?"}` : ""}
            </div>
            {multi && net !== null && (
              <div>
                multi · salle <b>{net.room}</b> · <b>{net.players.length}</b> joueur{net.players.length > 1 ? "s" : ""} ·
                retard <b>{stats.lag}</b> tick{stats.lag > 1 ? "s" : ""}
              </div>
            )}
            <div>
              <b>{stats.colonists}</b> colon{stats.colonists > 1 ? "s" : ""}
              {stats.beasts > 0 ? (
                <>
                  {" · "}
                  <b>{stats.beasts}</b> bête{stats.beasts > 1 ? "s" : ""}
                </>
              ) : (
                ""
              )}
              {stats.livestockCount > 0 ? (
                <>
                  {" · "}
                  Bétail : <b>{stats.livestockCount}</b>
                </>
              ) : (
                ""
              )}
              {stats.hostiles > 0 ? (
                <>
                  {" · "}
                  <b>{stats.hostiles}</b> ennemi{stats.hostiles > 1 ? "s" : ""}
                </>
              ) : (
                ""
              )}
            </div>
            <div>
              stock :{" "}
              {visibleStock(stats.stored).map(({ name, count }, i) => {
                // Fraîcheur de la pile la plus ancienne de ce genre
                // (`stats.foodFreshness`, indexé par `ItemKind` comme `ITEM_NAMES`).
                const freshness = stats.foodFreshness[(ITEM_NAMES as readonly string[]).indexOf(name)] ?? -1;
                return (
                  <span key={name}>
                    {i > 0 ? " · " : ""}
                    {count} {name}
                    {freshness >= 0 && (
                      <span
                        className={`freshness ${freshnessLevel(freshness)}`}
                        title={`Pile la plus ancienne : ${freshnessPercent(freshness)} % de fraîcheur`}
                      >
                        {" "}
                        · {freshnessPercent(freshness)} %
                      </span>
                    )}
                  </span>
                );
              })}
              {stats.blueprints > 0 ? ` · ${stats.blueprints} chantier${stats.blueprints > 1 ? "s" : ""}` : ""}
              {" · richesse "}
              {formatWealth(stats.wealth)}
            </div>
            {stats.traderPresent >= 0 && (
              <div>
                Marchand <b>{stats.names[stats.traderPresent] || "inconnu"}</b> · repart dans{" "}
                {formatTraderLeaves(stats.traderLeavesIn)}
              </div>
            )}
            {currentTechInfo && (
              <div>
                Recherche : <b>{TECHS[currentTechInfo.tech]?.name ?? "?"}</b> ·{" "}
                {researchPercent(currentTechInfo.progress, currentTechInfo.cost)} %
              </div>
            )}
            {stats.fireCount > 0 && (
              <div className="fire-warning">
                Feu : <b>{stats.fireCount}</b> case{stats.fireCount > 1 ? "s" : ""}
              </div>
            )}
            <div className="help">
              {stats.tps} tps · {stats.fps} fps · hash {stats.hash}
              {multi && net !== null && (
                <span
                  className={`hashdot ${net.isOutlier ? "bad" : "good"}`}
                  title={net.isOutlier ? "Votre copie diverge de la majorité (§7)" : "Votre copie concorde avec la majorité"}
                />
              )}
            </div>
            <div className="help">
              glisser droit ou flèches : déplacer · molette : zoom · Q/E : tourner
              {multi ? " · pause et vitesses indisponibles en multijoueur" : " · espace : pause · 1/2/3 : vitesse"}
            </div>
          </div>

          <ColonistBar
            colonists={stats.colonistBadges}
            selection={stats.selection}
            onSelect={(id, additive) => actionsRef.current?.selectPawn(id, additive)}
            onFocus={(id) => actionsRef.current?.focusPawn(id)}
          />

          <Minimap ref={minimapRef} onFocus={(x, y) => rendererRef.current?.focusOn(x, y)} />

          {multiSelection && (
            <div className="panel">
              <div className="panel-title">{stats.selection.length} colons sélectionnés</div>
              <ul className="panel-selection-list">
                {stats.selection.map((id) => (
                  <li key={id}>{stats.names[id] || `Colon ${id}`}</li>
                ))}
              </ul>
              <div className="help">clic droit : y aller tous, ou attaquer un ennemi ou un animal</div>
            </div>
          )}
          {!multiSelection && sel && sel.animal && (
            <div className="panel">
              <div className="panel-title">
                {SPECIES_LABELS[sel.species]
                  ? SPECIES_LABELS[sel.species].charAt(0).toUpperCase() + SPECIES_LABELS[sel.species].slice(1)
                  : "Bête"}{" "}
                (sauvage)
              </div>
              <div className="panel-section">Santé</div>
              <Bar label="PV" value={sel.hp} />
              <Bar label="Sang" value={sel.blood} />
              {sel.downed && <div className="panel-downed">à terre</div>}
              <button
                className="panel-action"
                onClick={() => bridgeRef.current?.issue(encodeHunt(sel.id, !sel.hunted))}
              >
                {sel.hunted ? "Ne plus chasser" : "Chasser"}
              </button>
              <button
                className="panel-action"
                title={TAME_HINT}
                onClick={() => bridgeRef.current?.issue(encodeTame(sel.id, !sel.tameMarked))}
              >
                {sel.tameMarked ? "Ne plus apprivoiser" : "Apprivoiser"}
              </button>
              {(sel.hunted || sel.tameMarked) && (
                <div className="panel-marked">{sel.hunted ? "marqué : chasse" : "marqué : apprivoisement"}</div>
              )}
              <div className="help">touche H : bascule la chasse · clic droit avec un colon sélectionné : attaquer</div>
            </div>
          )}
          {!multiSelection && sel && sel.livestock && (
            <div className="panel">
              <div className="panel-title">
                {SPECIES_LABELS[sel.species]
                  ? SPECIES_LABELS[sel.species].charAt(0).toUpperCase() + SPECIES_LABELS[sel.species].slice(1)
                  : "Bête"}{" "}
                de la colonie
              </div>
              <div className="panel-section">Santé</div>
              <Bar label="PV" value={sel.hp} />
              <Bar label="Faim" value={sel.hunger} />
              <Bar label="Sang" value={sel.blood} />
              {sel.downed && <div className="panel-downed">à terre</div>}
              <button
                className="panel-action"
                title={SLAUGHTER_HINT}
                disabled={sel.slaughterMarked}
                onClick={() => bridgeRef.current?.issue(encodeSlaughter(sel.id))}
              >
                {sel.slaughterMarked ? "Sera abattu" : "Abattre"}
              </button>
            </div>
          )}
          {!multiSelection && sel && !sel.animal && !sel.livestock && (
            <div className="panel">
              <div className="panel-title">
                {sel.hostile
                  ? `Ennemi ${sel.name || "inconnu"}`
                  : sel.trader
                    ? `Marchand ${sel.name || "inconnu"}`
                    : `${sel.name || "Colon " + sel.id} · (${sel.tile.x}, ${sel.tile.y})`}
              </div>
              {sel.trader && (
                <button className="panel-action" onClick={() => setShowTrade(true)}>
                  Troc
                </button>
              )}
              <div className="panel-job">{sel.job}{sel.carrying ? ` · porte ${sel.carrying}` : ""}</div>
              <div className="panel-weapon">Arme : {sel.weapon >= 0 ? WEAPON_NAMES[sel.weapon] ?? "?" : "à mains nues"}</div>
              <div className="panel-apparel">Habit : {sel.apparel >= 0 ? APPAREL_NAMES[sel.apparel] ?? "?" : "rien"}</div>
              {sel.traits.length > 0 && (
                <div className="panel-traits">
                  Traits :{" "}
                  {sel.traits.map((t, i) => (
                    <span key={t}>
                      {i > 0 ? ", " : ""}
                      <span className="panel-trait" title={TRAIT_HINTS[t] ?? ""}>
                        {TRAIT_LABELS[t] ?? "?"}
                      </span>
                    </span>
                  ))}
                </div>
              )}
              <div className={`panel-comfort${sel.comfort < 50 ? " cold" : ""}`}>
                Ressenti : {formatTemperature(sel.comfort)}
              </div>

              {!sel.hostile && (
                <>
                  <div className="panel-section">Besoins</div>
                  <Bar label="PV" value={sel.hp} />
                  <Bar label="Faim" value={sel.hunger} />
                  <Bar label="Repos" value={sel.rest} />
                  <Bar label="Humeur" value={sel.mood} />
                  <div className="panel-mood">
                    {sel.moodLabel}
                    {sel.breaking ? <b> · craque !</b> : ""}
                  </div>
                </>
              )}

              <div className="panel-section">Santé</div>
              <Bar label="Sang" value={sel.blood} />
              <Bar label="Conscience" value={sel.consciousness} />
              {sel.downed && <div className="panel-downed">à terre</div>}
              {sel.sickHours > 0 && <div className="panel-sick">Malade : encore {sel.sickHours} h</div>}
              {sel.injuries.length > 0 && (
                <ul className="panel-injuries">
                  {sel.injuries.map((inj, i) => (
                    <li key={i}>{formatInjury(inj.part, inj.severity, inj.bleeding, inj.tended ? 1 : 0)}</li>
                  ))}
                </ul>
              )}

              <div className="panel-section">Compétences</div>
              <div className="skill-row">
                <span className="skill-label">Mêlée</span>
                <span className="skill-level">niv. {sel.meleeLevel}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${Math.min(100, (sel.meleeXp / xpToNext(sel.meleeLevel)) * 100)}%` }}
                  />
                </span>
              </div>
              <div className="skill-row">
                <span className="skill-label">Tir</span>
                <span className="skill-level">niv. {sel.rangedLevel}</span>
                <span className="bar-track">
                  <span
                    className="bar-fill"
                    style={{ width: `${Math.min(100, (sel.rangedXp / xpToNext(sel.rangedLevel)) * 100)}%` }}
                  />
                </span>
              </div>
              {!sel.hostile &&
                sel.skills.map((s) => (
                  <div className="skill-row" key={s.work}>
                    <span className="skill-label">{WORK_LABELS[s.work]}</span>
                    <span className="skill-level">niv. {s.level}</span>
                    <span className="bar-track">
                      <span
                        className="bar-fill"
                        style={{ width: `${Math.min(100, (s.xp / s.xpToNext) * 100)}%` }}
                      />
                    </span>
                  </div>
                ))}

              {!sel.hostile && !sel.trader && (
                <>
                  <div className="panel-section">Relations</div>
                  {sel.relations.length === 0 ? (
                    <div className="panel-relations-empty">Ne connaît personne encore</div>
                  ) : (
                    <ul className="panel-relations">
                      {sel.relations.map((r) => (
                        <li key={r.other}>
                          {stats.names[r.other] || `Colon ${r.other}`} · {r.value} · {opinionLabel(r.value)}
                        </li>
                      ))}
                    </ul>
                  )}
                </>
              )}

              <div className="help">clic droit : y aller, ou attaquer un ennemi ou un animal</div>
            </div>
          )}

          <div className="toolbar">
            {TOOLS.filter((t) => t.group === "orders").map((t) => (
              <button key={t.id} className={t.id === tool ? "active" : ""} onClick={() => setTool(t.id)} title={`Touche ${t.key}`}>
                {t.label} <span className="key">{t.key}</span>
              </button>
            ))}
            <span className="sep" />
            {TOOLS.filter((t) => t.group === "build").map((t) => {
              // Seul l'outil Forge se grise : la seule construction que la
              // recherche verrouille (`TECH_METALLURGY`, voir `research.ts`).
              const forgeLocked = t.id === "forge" && !metallurgyDone;
              return (
                <button
                  key={t.id}
                  className={t.id === tool ? "active" : ""}
                  disabled={forgeLocked}
                  onClick={() => setTool(t.id)}
                  title={forgeLocked ? "Demande la technologie Métallurgie" : (t.hint ?? `Touche ${t.key}`)}
                >
                  {t.label} {t.key && <span className="key">{t.key}</span>}
                </button>
              );
            })}
            <button
              className={`material ${tool in BUILD_TOOL_KIND ? "lit" : ""}`}
              onClick={() => setMaterial(material === 0 ? 1 : 0)}
              title="Touche T : matériau des constructions"
            >
              {MATERIAL_NAMES[material]} <span className="key">T</span>
            </button>
            <span className="sep" />
            <button
              className={showWork ? "active" : ""}
              onClick={() => setShowWork((v) => !v)}
              title="Touche J : priorités de travail"
            >
              Travail <span className="key">J</span>
            </button>
            <button
              className={showCraft ? "active" : ""}
              onClick={() => setShowCraft((v) => !v)}
              title="Touche K : fabrication d'armes et d'habits"
            >
              Fabrication <span className="key">K</span>
            </button>
            <button
              className={showResearch ? "active" : ""}
              onClick={() => setShowResearch((v) => !v)}
              title="Touche R : recherche technologique"
            >
              Recherche <span className="key">R</span>
            </button>
            <button
              className={heatMode ? "active" : ""}
              onClick={() => setHeatMode((v) => !v)}
              title="Touche I : colore les cases par température"
            >
              Chaleur <span className="key">I</span>
            </button>
            <button
              className={showJournal ? "active" : ""}
              onClick={() => setShowJournal((v) => !v)}
              title="Touche N : journal des événements"
            >
              Journal <span className="key">N</span>
            </button>
            <button
              className={showOptions ? "active" : ""}
              onClick={() => setShowOptions(!showOptions)}
              title="Dose de menace du storyteller · Échap pour fermer"
            >
              Options
            </button>
            <button
              className={showHelp ? "active" : ""}
              onClick={() => setShowHelp(!showHelp)}
              title="Touche ? ou F1 : aide des raccourcis · Échap pour fermer"
            >
              Aide <span className="key">?</span>
            </button>
            <button
              className={caravanOpen ? "active" : ""}
              disabled={roomTile === null}
              onClick={() => {
                setCaravanOpen((v) => !v);
                setCaravanPicking(false);
              }}
              title={
                roomTile === null
                  ? "Réservé aux colonies du monde partagé (salle tile-N)"
                  : "Touche V : former une caravane"
              }
            >
              Caravane <span className="key">V</span>
            </button>
            <button
              className={showTrade ? "active" : ""}
              disabled={stats.traderPresent < 0}
              onClick={() => setShowTrade((v) => !v)}
              title={stats.traderPresent < 0 ? "Aucun marchand de passage" : "Troc avec le marchand présent"}
            >
              Troc
            </button>
            <button
              className={showFactions ? "active" : ""}
              onClick={() => setShowFactions((v) => !v)}
              title="Réputation des trois factions PNJ et tribut"
            >
              Factions
            </button>
            <button onClick={() => actionsRef.current?.save()} disabled={multi} title={multi ? MULTI_DISABLED : undefined}>
              Sauver
            </button>
            <button onClick={() => actionsRef.current?.load()} disabled={multi} title={multi ? MULTI_DISABLED : undefined}>
              Charger
            </button>
            {inWorld && (
              <button onClick={backToWorld} title="Quitter la salle et revenir au globe">
                Retour au monde
              </button>
            )}
            {import.meta.env.DEV && (
              <button onClick={() => actionsRef.current?.triggerRaid()} title="Déclencher un raid (dev)">
                Raid
              </button>
            )}
            {import.meta.env.DEV && (
              <button
                className={igniteArmed ? "active" : ""}
                onClick={() => setIgniteArmed(!igniteArmed)}
                title="Prochain clic gauche sur la carte : met le feu à la case (dev)"
              >
                Mettre le feu (débogage)
              </button>
            )}
          </div>
          {heatMode && (
            <div className="heat-legend">
              <span>{formatTemperature(HEAT_COLD)}</span>
              <span className="heat-legend-bar" />
              <span>{formatTemperature(HEAT_HOT)}</span>
            </div>
          )}
          {tool !== "select" && (
            <div className="tool-hint">
              {tool === "stockpile"
                ? "Tracez un rectangle pour créer une zone de stockage"
                : tool === "growing"
                  ? "Tracez un rectangle sur de l'herbe ou de la terre pour créer une zone de culture"
                  : tool === "cancel"
                    ? "Tracez un rectangle pour annuler désignations, zones et chantiers"
                    : tool in BUILD_TOOL_KIND
                      ? `Tracez un rectangle pour poser des plans de ${TOOLS.find((t) => t.id === tool)?.label.toLowerCase()} en ${WOOD_ONLY.has(tool) ? "bois" : STONE_ONLY.has(tool) ? "pierre" : MATERIAL_NAMES[material]}`
                      : "Tracez un rectangle sur les éléments à traiter"}{" "}
              · clic droit ou Échap pour revenir à la sélection
            </div>
          )}
          {showWork && (
            // Frère du canvas : ses écouteurs souris ne voient pas ces clics.
            <div className="work-panel" onContextMenu={(e) => e.preventDefault()}>
              <div className="panel-title">Travail</div>
              <table className="work-table">
                <thead>
                  <tr>
                    <th />
                    {WORK_LABELS.map((label) => (
                      <th key={label}>{label}</th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {workRows.map((row) => (
                    <tr key={row.id}>
                      <th>{stats.names[row.id] ?? `Colon ${row.id}`}</th>
                      {row.prio.map((p, w) => (
                        <td key={w}>
                          <button
                            className={`work-cell p${p}`}
                            onClick={() => cyclePriority(row.id, w, p, 1)}
                            onContextMenu={(e) => {
                              e.preventDefault();
                              cyclePriority(row.id, w, p, -1);
                            }}
                            title={`${WORK_LABELS[w]} · clic : priorité suivante, clic droit : précédente`}
                          >
                            {p === 0 ? "—" : p}
                          </button>
                        </td>
                      ))}
                    </tr>
                  ))}
                </tbody>
              </table>
              <div className="help">1 = urgent, 4 = quand il n'y a rien d'autre, — = jamais</div>
            </div>
          )}
          {showCraft && (
            <CraftingPanel
              stored={stats.stored}
              targets={stats.craftTargets}
              hasCraftingSpot={stats.hasCraftingSpot}
              hasForge={stats.hasForge}
              onSetTarget={setCraftTarget}
              onClose={() => setShowCraft(false)}
            />
          )}
          {showResearch && (
            <ResearchPanel
              state={researchInfo}
              hasResearchBench={stats.hasResearchBench}
              onSelect={setResearch}
              onStop={() => setResearch(255)}
              onClose={() => setShowResearch(false)}
            />
          )}
          {showTrade && stats.traderPresent >= 0 && (
            <TradePanel
              traderName={stats.names[stats.traderPresent] || "inconnu"}
              offers={tradeOffers(stats.traderOffers)}
              stored={stats.stored}
              buyPrices={stats.buyPrices}
              onTrade={proposeTrade}
              onClose={() => setShowTrade(false)}
            />
          )}
          {showFactions && (
            <FactionsPanel
              goodwill={stats.goodwill}
              lastRaidFaction={stats.lastRaidFaction}
              stored={stats.stored}
              buyPrices={stats.buyPrices}
              onGift={giftFaction}
              onClose={() => setShowFactions(false)}
            />
          )}
          {showJournal && (
            <JournalPanel
              entries={eventLogRef.current}
              ticksPerDay={stats.ticksPerDay}
              filter={journalFilter}
              onFilterChange={setJournalFilter}
              onClose={() => setShowJournal(false)}
              resolveTarget={(kind, arg) => actionsRef.current?.resolveEventTarget(kind, arg) ?? null}
              onActivate={(kind, arg) => actionsRef.current?.focusEvent(kind, arg)}
            />
          )}
          {showOptions && (
            <div className="options-panel" onContextMenu={(e) => e.preventDefault()}>
              <div className="panel-title">Options</div>
              <div className="panel-section">Dose de menace</div>
              {!multi || (net?.isHost ?? false) ? (
                <div className="options-row">
                  {DIFFICULTY_LABELS.map((label, level) => (
                    <button
                      key={level}
                      className={stats.difficulty === level ? "active" : ""}
                      onClick={() => bridgeRef.current?.issue(encodeSetDifficulty(level))}
                    >
                      {label}
                    </button>
                  ))}
                </div>
              ) : (
                <div className="help">réglée par l'hôte : {DIFFICULTY_LABELS[stats.difficulty] ?? "Normal"}</div>
              )}
              {stats.difficulty === DIFFICULTY.Peaceful && (
                <div className="help">paisible : plus aucun raid, le reste de la vie de la colonie continue</div>
              )}
              <div className="panel-section">Graphismes</div>
              <div className="help">Rapport de pixels</div>
              <div className="options-row">
                {PIXEL_RATIO_OPTIONS.map((value) => (
                  <button
                    key={String(value)}
                    className={graphics.pixelRatio === value ? "active" : ""}
                    onClick={() => updateGraphics({ pixelRatio: value })}
                  >
                    {value === "auto" ? "Auto" : `×${value}`}
                  </button>
                ))}
              </div>
              <div className="help">Densité des props</div>
              <div className="options-row">
                {PROP_DENSITY_OPTIONS.map((value) => (
                  <button
                    key={value}
                    className={graphics.propDensity === value ? "active" : ""}
                    onClick={() => updateGraphics({ propDensity: value })}
                  >
                    {value}
                  </button>
                ))}
              </div>
              <div className="help">Ombres</div>
              <div className="options-row">
                <button className={graphics.shadows ? "active" : ""} onClick={() => updateGraphics({ shadows: true })}>
                  Activées
                </button>
                <button className={!graphics.shadows ? "active" : ""} onClick={() => updateGraphics({ shadows: false })}>
                  Désactivées
                </button>
              </div>
              <div className="help">ombres : appliqué au prochain chargement</div>
              <div className="help">
                {stats.fps} fps · {stats.drawCalls} draw calls
              </div>
              <button className="wide" onClick={() => updateGraphics(DEFAULT_GRAPHICS)}>
                Réinitialiser les graphismes
              </button>
              <button className="wide" onClick={() => setShowOptions(false)}>
                Fermer
              </button>
            </div>
          )}
          {caravanOpen && roomTile !== null && !caravanPicking && (
            <CaravanPanel
              fromTile={roomTile}
              colonists={stats.colonistList}
              stored={stats.stored}
              destination={caravanDestination}
              isHost={net?.isHost ?? false}
              waiting={caravanWaiting}
              onPickDestination={() => setCaravanPicking(true)}
              onSend={(pawnIds, items) => {
                if (caravanTo === null) return;
                if (formCaravan(pawnIds, items, caravanTo)) setCaravanOpen(false);
              }}
              onSendWaiting={() => {
                // Les manifestes en attente repartent dès qu'ils ont une
                // destination : `pump` les reprendra au prochain `frame`.
                const dispatcher = dispatcherRef.current;
                if (dispatcher === null || caravanTo === null) return;
                for (let i = 0; i < caravanWaiting; i += 1) {
                  dispatcher.planDestination(caravanTo, (departure) =>
                    worldToast(`Caravane en route vers la case ${departure.toTile}`),
                  );
                }
              }}
              onClose={() => setCaravanOpen(false)}
            />
          )}
        </>
      )}
      {net?.roomDesynced &&
        (net.hostId !== null && net.outliers.includes(net.hostId) ? (
          // §7 : l'hôte ne se resynchronise jamais sur lui-même, la salle
          // reste désynchronisée indéfiniment dans ce cas ; pas de bouton qui
          // ne mènerait à rien (`host_cannot_resync`).
          <div className="banner">
            L'hôte est en désaccord avec la majorité : la partie ne peut pas être réparée automatiquement
          </div>
        ) : (
          <div className="banner">
            Désynchronisation détectée · {outlierNames(net)} · réparation en cours…
            {resyncPending ? (
              " · resynchronisation…"
            ) : (
              <button
                onClick={() => {
                  bridgeRef.current?.rpc("lockstep.requestResync");
                  setResyncPending(true);
                }}
              >
                Resynchroniser
              </button>
            )}
          </div>
        ))}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => {
            const activate = () => {
              if (!t.target) return;
              actionsRef.current?.activateTarget(t.target);
              setToasts((prev) => prev.filter((p) => p.id !== t.id));
            };
            return (
              <div
                key={t.id}
                className={t.target ? "toast clickable" : "toast"}
                role={t.target ? "button" : undefined}
                tabIndex={t.target ? 0 : undefined}
                onClick={t.target ? activate : undefined}
                onKeyDown={
                  t.target
                    ? (e) => {
                        if (e.key === "Enter" || e.key === " ") activate();
                      }
                    : undefined
                }
              >
                {t.text}
              </div>
            );
          })}
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
    </>
  );
}

/**
 * Écran d'accueil : solo tout de suite, une salle nommée sur un serveur relais,
 * ou le monde partagé — où c'est le globe qui décide de la salle.
 */
function HomeScreen({
  form,
  onChange,
  difficulty,
  onDifficultyChange,
  onSolo,
  onJoin,
  onWorld,
  rooms,
  roomsTruncated,
  roomsError,
  roomFilter,
  onRoomFilterChange,
  roomsLobbyOnly,
  onRoomsLobbyOnlyChange,
  onJoinRoom,
}: {
  form: JoinForm;
  onChange: (f: JoinForm) => void;
  /** Dose de menace de la prochaine partie solo (`render/terrain.ts::DIFFICULTY`), défaut Normal. */
  difficulty: number;
  onDifficultyChange: (v: number) => void;
  onSolo: () => void;
  onJoin: () => void;
  onWorld: () => void;
  /** Dernière liste reçue de `GET /rooms` (`docs/protocol.md` §2), non filtrée. */
  rooms: readonly RoomInfo[];
  roomsTruncated: boolean;
  /** Message bref si le sondage échoue ; `null` tant que tout va bien. */
  roomsError: string | null;
  roomFilter: string;
  onRoomFilterChange: (v: string) => void;
  roomsLobbyOnly: boolean;
  onRoomsLobbyOnlyChange: (v: boolean) => void;
  onJoinRoom: (room: RoomInfo) => void;
}) {
  const connectable = form.server.trim() !== "" && form.name.trim() !== "";
  const ready = connectable && form.room.trim() !== "";
  const needle = roomFilter.trim().toLowerCase();
  const visibleRooms = rooms.filter(
    (room) =>
      (!roomsLobbyOnly || room.state === "lobby") &&
      (needle === "" || roomDisplayName(room).toLowerCase().includes(needle)),
  );
  return (
    <div className="overlay">
      <div className="card">
        <div className="card-title">rimlike</div>
        <label>
          Difficulté
          <select value={difficulty} onChange={(e) => onDifficultyChange(Number(e.target.value))}>
            {DIFFICULTY_LABELS.map((label, level) => (
              <option key={level} value={level}>
                {label}
              </option>
            ))}
          </select>
        </label>
        <button className="wide primary" onClick={onSolo}>
          Partie solo
        </button>
        <div className="card-sep">ou</div>
        <div className="card-subtitle">Multijoueur</div>
        <label>
          Serveur
          <input value={form.server} onChange={(e) => onChange({ ...form, server: e.target.value })} />
        </label>
        <label>
          Nom
          <input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} />
        </label>
        <button
          className="wide"
          disabled={!connectable}
          onClick={() => {
            if (connectable) onWorld();
          }}
        >
          Monde partagé
        </button>
        <div className="help">Choisissez votre case sur le globe : le serveur donne la salle et la graine.</div>
        <div className="card-sep">ou</div>
        <label>
          Salle
          <input value={form.room} onChange={(e) => onChange({ ...form, room: e.target.value })} />
        </label>
        <button
          className="wide"
          disabled={!ready}
          onClick={() => {
            if (ready) onJoin();
          }}
        >
          Rejoindre
        </button>
        <div className="help">
          Paramètres d'URL acceptés : ?server=…&amp;room=…&amp;name=… ou ?server=…&amp;name=…&amp;world=1
        </div>

        <div className="card-sep">ou</div>
        <div className="card-subtitle">Salles ouvertes</div>
        <div className="rooms-filters">
          <input
            className="rooms-filter-text"
            placeholder="filtrer par nom…"
            value={roomFilter}
            onChange={(e) => onRoomFilterChange(e.target.value)}
          />
          <label className="rooms-lobby-only">
            <input
              type="checkbox"
              checked={roomsLobbyOnly}
              onChange={(e) => onRoomsLobbyOnlyChange(e.target.checked)}
            />
            en attente seulement
          </label>
        </div>
        {roomsError !== null ? (
          <div className="help">serveur injoignable</div>
        ) : (
          <>
            <ul className="lobby rooms-list">
              {visibleRooms.map((room) => {
                const full = room.players >= room.maxPlayers;
                return (
                  <li key={room.name}>
                    <div className="rooms-room-info">
                      <b>{roomDisplayName(room)}</b>
                      <div className="help">
                        {roomStateLabel(room.state)} · {room.players}/{room.maxPlayers} joueurs · jour{" "}
                        {roomDay(room.tick)}
                      </div>
                    </div>
                    <button className="small" disabled={full} onClick={() => onJoinRoom(room)}>
                      {full ? "Complète" : "Rejoindre"}
                    </button>
                  </li>
                );
              })}
              {visibleRooms.length === 0 && <li className="empty">aucune salle ouverte</li>}
            </ul>
            {roomsTruncated && <div className="help">et d'autres…</div>}
          </>
        )}
      </div>
    </div>
  );
}

/** Chargement du globe : sobre, mais on dit ce qui se passe et où. */
function GlobeLoading({
  load,
  server,
  onCancel,
}: {
  load: GlobeLoad;
  server: string;
  onCancel: () => void;
}) {
  if (load.kind === "failed") {
    return (
      <div className="overlay">
        <div className="card">
          <div className="card-title">Globe indisponible</div>
          <div className="help">{load.message}</div>
          <div className="help">Vérifiez que le serveur monde tourne bien sur {server}.</div>
          <button className="wide" onClick={onCancel}>
            Retour à l'accueil
          </button>
        </div>
      </div>
    );
  }
  const progress = load.kind === "loading" ? load.progress : null;
  const kilobytes = progress === null ? 0 : Math.round(progress.received / 1024);
  return (
    <div className="overlay">
      <div className="card">
        <div className="card-title">Chargement du globe…</div>
        <div className="help">
          {progress === null
            ? `Contact de ${server}`
            : progress.phase === "download"
              ? `Téléchargement : ${kilobytes} Ko`
              : "Désérialisation des cases…"}
        </div>
        <div className="help">Le globe ne se télécharge qu'une fois : il ne change pas.</div>
      </div>
    </div>
  );
}

/** Salle d'attente : composition, puis démarrage par l'hôte. */
function Lobby({
  room,
  net,
  seed,
  onSeed,
  imposedSeed,
  difficulty,
  onDifficulty,
  onBackToWorld,
  onRetry,
  onGoHome,
  onStart,
}: {
  room: string;
  net: LockstepState | null;
  seed: number;
  onSeed: (v: number) => void;
  /** Graine dictée par la case du globe, `null` en salle simple. */
  imposedSeed: number | null;
  /** Dose de menace choisie par l'hôte (`render/terrain.ts::DIFFICULTY`). */
  difficulty: number;
  onDifficulty: (v: number) => void;
  /** Présent en mode monde : de quoi ressortir sans recharger la page. */
  onBackToWorld: (() => void) | null;
  /** Relance une connexion neuve après l'abandon de la reconnexion automatique. */
  onRetry: () => void;
  /** Retour complet à l'accueil (bandeau « Serveur injoignable »). */
  onGoHome: () => void;
  onStart: () => void;
}) {
  if (net === null || net.phase === "connecting") {
    return (
      <div className="overlay">
        <div className="card">
          <div className="card-title">
            {net?.reconnecting ? `Reconnexion à la salle ${room}…` : `Connexion à la salle ${room}…`}
          </div>
          {net?.reconnecting && net.attempts > 0 && (
            <div className="help">Tentative {net.attempts}…</div>
          )}
        </div>
      </div>
    );
  }
  if (net.phase === "closed") {
    // Une coupure ordinaire (fermeture volontaire du serveur, salle détruite)
    // ne passe jamais par `reconnect()` : `reconnecting` reste faux. Une
    // reconnexion qui a fini par abandonner (`ReconnectingTransport`, après
    // `MAX_RECONNECT_ATTEMPTS`) le laisse à vrai — c'est le seul cas où on
    // propose de relancer plutôt que de renvoyer vers le monde ou l'accueil.
    const abandoned = net.reconnecting;
    return (
      <div className="overlay">
        <div className="card">
          <div className="card-title">{abandoned ? "Serveur injoignable" : "Connexion perdue"}</div>
          <div className="help">
            {net.lastError ? net.lastError.message : "Le serveur a fermé la connexion."}
            {abandoned ? ` Après ${net.attempts} tentative${net.attempts > 1 ? "s" : ""} de reconnexion.` : ""}
          </div>
          {abandoned && (
            <button className="wide primary" onClick={onRetry}>
              Réessayer
            </button>
          )}
          {onBackToWorld && (
            <button className="wide" onClick={onBackToWorld}>
              Retour au monde
            </button>
          )}
          <button className="wide" onClick={onGoHome}>
            Retour à l'accueil
          </button>
        </div>
      </div>
    );
  }
  return (
    <div className="overlay">
      <div className="card">
        <div className="card-title">Salle {net.room}</div>
        <ul className="lobby">
          {net.players.map((p) => (
            <li key={p.id}>
              {p.name}
              {p.id === net.hostId ? " · hôte" : ""}
              {p.id === net.playerId ? " · vous" : ""}
            </li>
          ))}
        </ul>
        {net.phase === "running" ? (
          <div className="help">Partie en cours : réception de l'état du host…</div>
        ) : net.isHost ? (
          <>
            <label>
              Graine
              <input
                type="number"
                value={imposedSeed ?? seed}
                disabled={imposedSeed !== null}
                onChange={(e) => onSeed(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0)}
              />
            </label>
            {imposedSeed !== null && (
              <div className="help">Graine imposée par la case : {imposedSeed}</div>
            )}
            <label>
              Difficulté
              <select value={difficulty} onChange={(e) => onDifficulty(Number(e.target.value))}>
                {DIFFICULTY_LABELS.map((label, level) => (
                  <option key={level} value={level}>
                    {label}
                  </option>
                ))}
              </select>
            </label>
            <button className="wide primary" onClick={onStart}>
              Démarrer
            </button>
            <div className="help">Carte 128×128 · pas de pause en multijoueur</div>
          </>
        ) : (
          <div className="help">En attente du démarrage par l'hôte…</div>
        )}
        {net.lastError && <div className="help">Erreur : {net.lastError.message}</div>}
        {onBackToWorld && (
          <button className="wide" onClick={onBackToWorld}>
            Retour au monde
          </button>
        )}
      </div>
    </div>
  );
}

function Bar({ label, value }: { label: string; value: number }) {
  const v = Math.max(0, Math.min(100, value));
  const tone = v < 10 ? "crit" : v < 30 ? "low" : "";
  return (
    <div className="bar">
      <span className="bar-label">{label}</span>
      <span className="bar-track">
        <span className={`bar-fill ${tone}`} style={{ width: `${v}%` }} />
      </span>
      <span className="bar-value">{Math.round(v)}%</span>
    </div>
  );
}
