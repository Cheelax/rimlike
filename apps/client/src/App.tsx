import { useEffect, useRef, useState } from "react";
import type { SettledMessage } from "@rimlike/protocol";
import type { World } from "@rimlike/world";
import type { LockstepError, LockstepState } from "./net/LockstepClient";
import { WebSocketTransport } from "./net/Transport";
import { WorldClient, type WorldClientState } from "./net/WorldClient";
import { fetchWorld, type WorldProgress } from "./net/worldFetch";
import { WorldScreen } from "./WorldScreen";
import { PAWN_FLAGS, PAWN_STRIDE, Renderer, type TilePos, type TileRect } from "./render/Renderer";
import {
  BLUEPRINT_STRIDE,
  BUILD_KIND,
  DESIGNATION,
  EVENT_STRIDE,
  eventLabel,
  formatInjury,
  HEALTH_STRIDE,
  ITEM_NAMES,
  JOB_LABELS,
  MATERIAL_NAMES,
  PRIORITY_STRIDE,
  SKILL_STRIDE,
  WEATHER_LABELS,
  WORK_LABELS,
  xpToNext,
  ZONE,
} from "./render/terrain";
import {
  encodeAttack,
  encodeBuild,
  encodeCancelBuild,
  encodeDesignate,
  encodeMoveTo,
  encodeSetPriority,
  encodeSetZone,
  encodeTriggerRaid,
} from "./sim/commands";
import { initSim } from "./sim/SimHandle";
import { SimBridge } from "./worker/SimBridge";
import type { FrameMessage } from "./worker/protocol";

const CLICK_TOLERANCE_PX = 5;
/** Écart de rendu borné : au retour d'un onglet masqué, la pluie ne bondit pas. */
const MAX_RENDER_DT_MS = 100;
const SAVE_KEY = "rimlike.save.v1";
/** Contrat avec `pawn::Faction` et `pawn::HP_MAX`. */
const FACTION_RAIDER = 1;
const HP_MAX = 1000;
/** Durée d'affichage d'une notification. */
const TOAST_MS = 6000;
/** Contrat avec `pawn::Job::code()` : la crise de moral. */
const JOB_BREAK = 14;

const DEFAULT_SERVER = "ws://localhost:8787";
const DEFAULT_SEED = 42;
const MAP_SIZE = 128;
const MULTI_DISABLED = "indisponible en multijoueur";

/** Étiquette d'humeur, en pourcentage. */
function moodLabel(mood: number): string {
  if (mood >= 70) return "heureux";
  if (mood >= 40) return "bien";
  if (mood >= 20) return "morose";
  return "au bord de la crise";
}

/** Priorité suivante (`dir` 1) ou précédente (`dir` -1) : 1→2→3→4→0→1. */
function nextPriority(p: number, dir: 1 | -1): number {
  if (dir === 1) return p === 0 ? 1 : p === 4 ? 0 : p + 1;
  return p === 1 ? 0 : p === 0 ? 4 : p - 1;
}

type Tool =
  | "select"
  | "chop"
  | "mine"
  | "harvest"
  | "stockpile"
  | "growing"
  | "wall"
  | "door"
  | "floor"
  | "bed"
  | "campfire"
  | "cancel";

const TOOLS: { id: Tool; label: string; key: string; color: number; group: "orders" | "build" }[] = [
  { id: "select", label: "Sélection", key: "S", color: 0xffffff, group: "orders" },
  { id: "chop", label: "Couper", key: "C", color: 0xff9a2e, group: "orders" },
  { id: "mine", label: "Miner", key: "M", color: 0xff9a2e, group: "orders" },
  { id: "harvest", label: "Récolter", key: "H", color: 0xff9a2e, group: "orders" },
  { id: "stockpile", label: "Stockage", key: "Z", color: 0x4a90d9, group: "orders" },
  { id: "growing", label: "Culture", key: "G", color: 0x5cc25c, group: "orders" },
  { id: "wall", label: "Mur", key: "B", color: 0x4ad9ff, group: "build" },
  { id: "door", label: "Porte", key: "P", color: 0x4ad9ff, group: "build" },
  { id: "floor", label: "Sol", key: "O", color: 0x4ad9ff, group: "build" },
  { id: "bed", label: "Lit", key: "L", color: 0x4ad9ff, group: "build" },
  { id: "campfire", label: "Feu", key: "F", color: 0x4ad9ff, group: "build" },
  { id: "cancel", label: "Annuler", key: "X", color: 0xff4040, group: "orders" },
];

const BUILD_TOOL_KIND: Partial<Record<Tool, number>> = {
  wall: BUILD_KIND.Wall,
  door: BUILD_KIND.Door,
  floor: BUILD_KIND.Floor,
  bed: BUILD_KIND.Bed,
  campfire: BUILD_KIND.Campfire,
};
const WOOD_ONLY: ReadonlySet<Tool> = new Set<Tool>(["bed", "campfire"]);

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
}

interface Stats {
  tick: number;
  day: number;
  hour: string;
  hash: string;
  tps: number;
  fps: number;
  speed: number;
  paused: boolean;
  weather: number;
  stored: number[];
  blueprints: number;
  colonists: number;
  hostiles: number;
  selected: PawnInfo | null;
  /** Copie du tampon des priorités : `[id, p0..p5]` par colon. */
  priorities: number[];
  /** Nom de chaque pawn vivant, par id (voir `FrameMessage.names`). */
  names: Record<number, string>;
  /** Retard du lockstep, en ticks. Toujours 0 en solo. */
  lag: number;
}

const INITIAL: Stats = {
  tick: 0,
  day: 1,
  hour: "00:00",
  hash: "",
  tps: 0,
  fps: 0,
  speed: 1,
  paused: false,
  weather: 0,
  stored: [0, 0, 0, 0, 0, 0],
  blueprints: 0,
  colonists: 0,
  hostiles: 0,
  selected: null,
  priorities: [],
  names: {},
  lag: 0,
};

interface Actions {
  save(): void;
  load(): void;
  triggerRaid(): void;
  setPriority(pawn: number, work: number, priority: number): void;
  currentPriority(pawn: number, work: number): number | null;
}

interface Toast {
  id: number;
  text: string;
}

/** Mode de jeu choisi à l'accueil. Rien ne démarre avant ce choix. */
type Session = { mode: "solo" } | { mode: "multi"; server: string; room: string; name: string };

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
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const toolRef = useRef<Tool>("select");
  const materialRef = useRef<number>(0);
  const rendererRef = useRef<Renderer | null>(null);
  const actionsRef = useRef<Actions | null>(null);
  const bridgeRef = useRef<SimBridge | null>(null);
  const [tool, setToolState] = useState<Tool>("select");
  const [material, setMaterialState] = useState<number>(0);
  const [stats, setStats] = useState<Stats>(INITIAL);
  const [showWork, setShowWork] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
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
  // --- Monde partagé : le globe et la connexion vivent en dehors de la partie ---
  const worldRef = useRef<WorldClient | null>(null);
  const [globe, setGlobe] = useState<World | null>(null);
  const [globeLoad, setGlobeLoad] = useState<GlobeLoad>({ kind: "loading", progress: null });
  const [worldNet, setWorldNet] = useState<WorldClientState | null>(null);
  /** Graine imposée par la case, reçue avec `settled`. `null` hors monde. */
  const [imposedSeed, setImposedSeed] = useState<number | null>(null);
  /** Identifiants des toasts du monde, hors de portée de ceux du sim et du réseau. */
  const worldToastId = useRef(-1_000_000);

  const multi = session?.mode === "multi";
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
      setToasts((prev) => [...prev, { id, text }]);
      timers.push(window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS));
    };

    void (async () => {
      try {
        const { world } = await fetchWorld(worldSession.server, (progress) => {
          if (!cancelled) setGlobeLoad({ kind: "loading", progress });
        });
        if (cancelled) return;
        setGlobe(world);
        setGlobeLoad({ kind: "ready" });
        client = new WorldClient({
          transport: new WebSocketTransport(worldSession.server),
          name: worldSession.name,
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
        });
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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;
    const isMulti = session.mode === "multi";
    let disposed = false;
    let raf = 0;
    let interval = 0;
    const cleanups: Array<() => void> = [];
    const toastTimers: number[] = [];
    /** Identifiants de toast réseau, hors de la plage des `seq` du sim. */
    let netToastId = -1;

    const renderer = new Renderer(canvas);
    rendererRef.current = renderer;
    renderer.setLeftDragPans(toolRef.current === "select");

    // --- État vu du thread principal. Le sim, lui, vit dans le Worker ---
    let speed = 1;
    let paused = false;
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
    let lastRenderAt = performance.now();
    let framesInWindow = 0;
    let windowStart = lastRenderAt;

    const pushToast = (text: string) => {
      const id = netToastId--;
      setToasts((prev) => [...prev, { id, text }]);
      toastTimers.push(window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS));
    };
    const flash = (msg: string) => {
      setNotice(msg);
      window.setTimeout(() => setNotice(null), 1800);
    };
    const showError = (e: unknown) => {
      if (!disposed) setError(e instanceof Error ? (e.stack ?? e.message) : String(e));
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

    /** Un toast par événement du sim jamais vu. */
    const notifyEvents = (events: Int32Array, names: Record<number, string>, fresh: boolean) => {
      if (fresh) {
        // Ce qu'un sim neuf porte déjà est du passé : on ne le notifie pas.
        lastEventSeq = events.length >= EVENT_STRIDE ? events[events.length - EVENT_STRIDE] : -1;
        return;
      }
      for (let o = 0; o + EVENT_STRIDE <= events.length; o += EVENT_STRIDE) {
        const seq = events[o];
        if (seq <= lastEventSeq) continue;
        lastEventSeq = seq;
        const text = eventLabel(events[o + 2], events[o + 3], names);
        if (!text) continue;
        setToasts((prev) => [...prev, { id: seq, text }]);
        toastTimers.push(
          window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== seq)), TOAST_MS),
        );
      }
    };

    // --- Le Worker de simulation ---
    const bridge = new SimBridge({
      onMap: (m) => renderer.setMap(m.width, m.height, m.tiles, m.features),
      onOverlays: (m) => renderer.setOverlays(m.zones, m.designations),
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
        confirmPriorities(f.priorities);
        notifyEvents(f.events, f.names, freshSim);
        freshSim = false;
      },
      onNet: (state) => {
        netState = state;
        setNet(state);
        // Un sim restauré depuis le snapshot du host repart de zéro côté rendu.
        if (state.ready && !netReady) freshSim = true;
        netReady = state.ready;
        if (state.lastError !== null && state.lastError !== netError) {
          netError = state.lastError;
          pushToast(`Serveur : ${state.lastError.message}`);
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
        selected = null;
        renderer.setSelected(null);
        flash("Partie chargée");
      },
      onError: showError,
    });
    bridgeRef.current = bridge;
    bridge.start(
      session.mode === "solo"
        ? { mode: "solo", seed: DEFAULT_SEED, width: MAP_SIZE, height: MAP_SIZE }
        : { mode: "multi", server: session.server, room: session.room, name: session.name },
    );
    // Les `encode*` sont des fonctions du WASM : le thread principal en garde
    // une instance rien que pour encoder. Le sim, lui, n'existe que côté Worker.
    void initSim().catch(showError);

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
    };
    actionsRef.current = actions;

    // --- Entrées ---
    let down: { x: number; y: number; button: number; tile: TilePos | null } | null = null;
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
        case "cancel":
          issue(encodeDesignate(DESIGNATION.None, rect.x0, rect.y0, rect.x1, rect.y1));
          issue(encodeSetZone(ZONE.None, rect.x0, rect.y0, rect.x1, rect.y1));
          issue(encodeCancelBuild(rect.x0, rect.y0, rect.x1, rect.y1));
          break;
        case "select":
          break;
      }
    };
    on(canvas, "pointerdown", (e: PointerEvent) => {
      down = { x: e.clientX, y: e.clientY, button: e.button, tile: renderer.pickTile(e.clientX, e.clientY) };
      if (toolRef.current !== "select" && e.button === 0 && down.tile) {
        renderer.setDragRect({ x0: down.tile.x, y0: down.tile.y, x1: down.tile.x, y1: down.tile.y }, toolColor());
      }
    });
    on(canvas, "pointermove", (e: PointerEvent) => {
      const tile = renderer.pickTile(e.clientX, e.clientY);
      renderer.setHover(tile);
      if (down && down.button === 0 && toolRef.current !== "select" && down.tile && tile) {
        renderer.setDragRect({ x0: down.tile.x, y0: down.tile.y, x1: tile.x, y1: tile.y }, toolColor());
      }
    });
    on(canvas, "pointerup", (e: PointerEvent) => {
      if (!down) return;
      const start = down;
      down = null;
      renderer.setDragRect(null);
      if (!live()) return;
      const moved = Math.hypot(e.clientX - start.x, e.clientY - start.y) > CLICK_TOLERANCE_PX;
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
        selected = renderer.pickPawn(e.clientX, e.clientY);
        renderer.setSelected(selected);
      } else if (start.button === 2 && selected !== null) {
        // Clic droit sur un ennemi : ordre d'attaque. Sinon : déplacement.
        const target = renderer.pickPawn(e.clientX, e.clientY);
        if (target !== null && factionOf(target) === FACTION_RAIDER) {
          issue(encodeAttack(selected, target));
        } else {
          const tile = renderer.pickTile(e.clientX, e.clientY);
          if (tile) issue(encodeMoveTo(selected, tile.x, tile.y));
        }
      }
    });
    on(canvas, "pointerleave", () => renderer.setHover(null));
    on(canvas, "contextmenu", (e: MouseEvent) => e.preventDefault());
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
      if (e.metaKey || e.ctrlKey) return;
      const toolHit = TOOLS.find((t) => t.key === k);
      if (toolHit) {
        setTool(toolHit.id);
        return;
      }
      if (k === "T") {
        setMaterial(materialRef.current === 0 ? 1 : 0);
        return;
      }
      if (k === "J") {
        setShowWork((v) => !v);
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
          if (toolRef.current !== "select") setTool("select");
          else {
            selected = null;
            renderer.setSelected(null);
          }
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
          selected = v;
          renderer.setSelected(v);
        },
      };
      // `WorldScreen` publie `__rimlike.world` de son côté : le crochet de la
      // partie ne doit pas l'emporter en le remplaçant.
      const hook = window as unknown as { __rimlike?: Record<string, unknown> };
      const world = hook.__rimlike?.world;
      const entries = debug as unknown as Record<string, unknown>;
      if (world !== undefined) entries.world = world;
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
        setStats((prev) => ({ ...prev, tps: 0, fps, lag: netState?.lag ?? 0 }));
        return;
      }
      const tod = f.timeOfDay / f.ticksPerDay;
      const minutes = Math.floor(tod * 24 * 60);
      const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
      const mm = String(minutes % 60).padStart(2, "0");
      let info: PawnInfo | null = null;
      let colonists = 0;
      let hostiles = 0;
      for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
        const hostile = curPawns[o + 10] === FACTION_RAIDER;
        if (hostile) hostiles++;
        else colonists++;
        if (curPawns[o] !== selected) continue;
        const id = curPawns[o];
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
        if (!hostile) {
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
        info = {
          id,
          name: f.names[id] ?? "",
          tile: { x: Math.floor(curPawns[o + 1] / 256), y: Math.floor(curPawns[o + 2] / 256) },
          hunger: curPawns[o + 4] / 10,
          rest: curPawns[o + 5] / 10,
          mood,
          moodLabel: moodLabel(mood),
          breaking: curPawns[o + 7] === JOB_BREAK,
          hp: (curPawns[o + 11] * 100) / HP_MAX,
          hostile,
          job: JOB_LABELS[curPawns[o + 7]] ?? "?",
          carrying: ck >= 0 ? `${curPawns[o + 9]} ${ITEM_NAMES[ck]}` : null,
          downed: (curPawns[o + 3] & PAWN_FLAGS.DOWNED) !== 0,
          blood,
          consciousness,
          injuries: selectedInjuriesId === id ? selectedInjuries : [],
          skills,
        };
      }
      // Blessures du colon sélectionné : rafraîchies ici (2 fois par seconde),
      // affichées à la prochaine passe pour ne pas attendre l'aller-retour.
      if (info !== null) {
        if (selectedInjuriesId !== info.id) {
          selectedInjuriesId = info.id;
          selectedInjuries = [];
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
      } else {
        selectedInjuriesId = null;
        selectedInjuries = [];
      }
      setStats({
        tick: f.tick,
        day: Math.floor(f.tick / f.ticksPerDay) + 1,
        hour: `${hh}:${mm}`,
        hash: lastHash,
        // Ticks par seconde mesurés dans le Worker, images par seconde ici.
        tps: f.tps,
        fps,
        speed,
        paused,
        weather: f.weather,
        stored: Array.from(f.stored),
        blueprints: f.blueprints.length / BLUEPRINT_STRIDE,
        colonists,
        hostiles,
        selected: info,
        priorities: Array.from(f.priorities),
        names: f.names,
        lag: f.lag,
      });
    }, 500);

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(interval);
      for (const t of toastTimers) clearTimeout(t);
      for (const c of cleanups) c();
      bridge.dispose();
      renderer.dispose();
      actionsRef.current = null;
      rendererRef.current = null;
      bridgeRef.current = null;
    };
  }, [session]);

  if (error) return <div className="error">{error}</div>;

  const sel = stats.selected;
  const workRows: { id: number; prio: number[] }[] = [];
  for (let o = 0; o + PRIORITY_STRIDE <= stats.priorities.length; o += PRIORITY_STRIDE) {
    workRows.push({ id: stats.priorities[o], prio: stats.priorities.slice(o + 1, o + PRIORITY_STRIDE) });
  }
  const cyclePriority = (pawn: number, work: number, shown: number, dir: 1 | -1) => {
    const current = actionsRef.current?.currentPriority(pawn, work) ?? shown;
    actionsRef.current?.setPriority(pawn, work, nextPriority(current, dir));
  };
  // Le HUD de colonie n'existe que dans une partie : sans session, l'écran est
  // celui de l'accueil ou du monde, qui ont leur propre interface.
  const running = session !== null && (!multi || (net !== null && net.phase === "running" && net.ready));
  const inWorld = worldSession !== null;
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
  };
  // Graine effective d'un `start` : celle de la case l'emporte (le serveur
  // l'impose de toute façon, docs/protocol.md §11.2).
  const startSeed = Math.max(0, Math.floor(imposedSeed ?? seed));
  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      {inWorld && globe !== null && worldSession !== null && (
        <WorldScreen
          world={globe}
          net={worldNet}
          name={worldSession.name}
          visible={session === null}
          onSettle={(tile) => worldRef.current?.settle(tile)}
          onVisit={(tile) => worldRef.current?.visit(tile)}
          onAbandon={(tile) => worldRef.current?.abandon(tile)}
          onBack={backToWorld}
          onQuit={quitWorld}
        />
      )}
      {session === null && inWorld && globe === null && (
        <GlobeLoading load={globeLoad} server={worldSession?.server ?? ""} onCancel={quitWorld} />
      )}
      {session === null && !inWorld ? (
        <HomeScreen
          form={form}
          onChange={setForm}
          onSolo={() => setSession({ mode: "solo" })}
          onJoin={() => setSession({ mode: "multi", ...form })}
          onWorld={() => setWorldSession({ server: form.server, name: form.name })}
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
            onBackToWorld={inWorld ? backToWorld : null}
            // Le serveur n'accepte qu'un entier positif comme graine.
            onStart={() => bridgeRef.current?.startGame(startSeed, MAP_SIZE, MAP_SIZE)}
          />
        )
      )}

      {running && (
        <>
          <div className="hud">
            <div>
              jour <b>{stats.day}</b> · <b>{stats.hour}</b> · {WEATHER_LABELS[stats.weather] ?? "?"} · tick {stats.tick}
              {multi ? "" : stats.paused ? <b> · PAUSE</b> : ` · x${stats.speed}`}
            </div>
            {multi && net !== null && (
              <div>
                multi · salle <b>{net.room}</b> · <b>{net.players.length}</b> joueur{net.players.length > 1 ? "s" : ""} ·
                retard <b>{stats.lag}</b> tick{stats.lag > 1 ? "s" : ""}
              </div>
            )}
            <div>
              <b>{stats.colonists}</b> colon{stats.colonists > 1 ? "s" : ""}
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
              {ITEM_NAMES.map((n, i) => [n, stats.stored[i] ?? 0] as const)
                .filter(([n, v]) => n !== "cadavres" || v > 0)
                .map(([n, v]) => `${v} ${n}`)
                .join(" · ")}
              {stats.blueprints > 0 ? ` · ${stats.blueprints} chantier${stats.blueprints > 1 ? "s" : ""}` : ""}
            </div>
            <div className="help">
              {stats.tps} tps · {stats.fps} fps · hash {stats.hash}
            </div>
            <div className="help">
              glisser droit ou flèches : déplacer · molette : zoom · Q/E : tourner
              {multi ? " · pause et vitesses indisponibles en multijoueur" : " · espace : pause · 1/2/3 : vitesse"}
            </div>
          </div>

          {sel && (
            <div className="panel">
              <div className="panel-title">
                {sel.hostile
                  ? `Ennemi ${sel.name || "inconnu"}`
                  : `${sel.name || "Colon " + sel.id} · (${sel.tile.x}, ${sel.tile.y})`}
              </div>
              <div className="panel-job">{sel.job}{sel.carrying ? ` · porte ${sel.carrying}` : ""}</div>

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
              {sel.injuries.length > 0 && (
                <ul className="panel-injuries">
                  {sel.injuries.map((inj, i) => (
                    <li key={i}>{formatInjury(inj.part, inj.severity, inj.bleeding, inj.tended ? 1 : 0)}</li>
                  ))}
                </ul>
              )}

              {!sel.hostile && sel.skills.length > 0 && (
                <>
                  <div className="panel-section">Compétences</div>
                  {sel.skills.map((s) => (
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
                </>
              )}

              <div className="help">clic droit : y aller, ou attaquer un ennemi</div>
            </div>
          )}

          <div className="toolbar">
            {TOOLS.filter((t) => t.group === "orders").map((t) => (
              <button key={t.id} className={t.id === tool ? "active" : ""} onClick={() => setTool(t.id)} title={`Touche ${t.key}`}>
                {t.label} <span className="key">{t.key}</span>
              </button>
            ))}
            <span className="sep" />
            {TOOLS.filter((t) => t.group === "build").map((t) => (
              <button key={t.id} className={t.id === tool ? "active" : ""} onClick={() => setTool(t.id)} title={`Touche ${t.key}`}>
                {t.label} <span className="key">{t.key}</span>
              </button>
            ))}
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
          </div>
          {tool !== "select" && (
            <div className="tool-hint">
              {tool === "stockpile"
                ? "Tracez un rectangle pour créer une zone de stockage"
                : tool === "growing"
                  ? "Tracez un rectangle sur de l'herbe ou de la terre pour créer une zone de culture"
                  : tool === "cancel"
                    ? "Tracez un rectangle pour annuler désignations, zones et chantiers"
                    : tool in BUILD_TOOL_KIND
                      ? `Tracez un rectangle pour poser des plans de ${TOOLS.find((t) => t.id === tool)?.label.toLowerCase()} en ${WOOD_ONLY.has(tool) ? "bois" : MATERIAL_NAMES[material]}`
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
        </>
      )}
      {net?.desync && <div className="banner">Désynchronisation détectée au tick {net.desync.tick}</div>}
      {toasts.length > 0 && (
        <div className="toasts">
          {toasts.map((t) => (
            <div key={t.id} className="toast">
              {t.text}
            </div>
          ))}
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
  onSolo,
  onJoin,
  onWorld,
}: {
  form: JoinForm;
  onChange: (f: JoinForm) => void;
  onSolo: () => void;
  onJoin: () => void;
  onWorld: () => void;
}) {
  const connectable = form.server.trim() !== "" && form.name.trim() !== "";
  const ready = connectable && form.room.trim() !== "";
  return (
    <div className="overlay">
      <div className="card">
        <div className="card-title">rimlike</div>
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
  onBackToWorld,
  onStart,
}: {
  room: string;
  net: LockstepState | null;
  seed: number;
  onSeed: (v: number) => void;
  /** Graine dictée par la case du globe, `null` en salle simple. */
  imposedSeed: number | null;
  /** Présent en mode monde : de quoi ressortir sans recharger la page. */
  onBackToWorld: (() => void) | null;
  onStart: () => void;
}) {
  if (net === null || net.phase === "connecting") {
    return (
      <div className="overlay">
        <div className="card">
          <div className="card-title">Connexion à la salle {room}…</div>
        </div>
      </div>
    );
  }
  if (net.phase === "closed") {
    return (
      <div className="overlay">
        <div className="card">
          <div className="card-title">Connexion perdue</div>
          <div className="help">
            {net.lastError ? net.lastError.message : "Le serveur a fermé la connexion."}{" "}
            {onBackToWorld ? "Revenez au monde pour choisir une autre case." : "Rechargez la page pour réessayer."}
          </div>
          {onBackToWorld && (
            <button className="wide" onClick={onBackToWorld}>
              Retour au monde
            </button>
          )}
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
