import { useEffect, useRef, useState } from "react";
import { BUNDLE_INTERVAL_MS } from "@rimlike/protocol";
import { LockstepClient, type LockstepState } from "./net/LockstepClient";
import { WebSocketTransport } from "./net/Transport";
import { PAWN_STRIDE, Renderer, type TilePos, type TileRect } from "./render/Renderer";
import {
  BLUEPRINT_STRIDE,
  BUILD_KIND,
  DESIGNATION,
  EVENT_STRIDE,
  eventLabel,
  ITEM_NAMES,
  JOB_LABELS,
  MATERIAL_NAMES,
  PRIORITY_STRIDE,
  WEATHER_LABELS,
  WORK_LABELS,
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
import { SimHandle } from "./sim/SimHandle";

const TICKS_PER_SECOND = 60;
const BASE_TICK_MS = 1000 / TICKS_PER_SECOND;
/** Rattrapage maximal par frame : au-delà on lâche du temps plutôt que de geler. */
const MAX_TICKS_PER_FRAME = 8;
/** En multi, au-delà de ce retard on rattrape plus fort (borné, jamais infini). */
const CATCHUP_LAG_TICKS = 60;
const MAX_TICKS_CATCHUP = 30;
const CLICK_TOLERANCE_PX = 5;
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

interface PawnInfo {
  id: number;
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
  const lockstepRef = useRef<LockstepClient | null>(null);
  const [tool, setToolState] = useState<Tool>("select");
  const [material, setMaterialState] = useState<number>(0);
  const [stats, setStats] = useState<Stats>(INITIAL);
  const [showWork, setShowWork] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [form, setForm] = useState<JoinForm>(() => joinFromUrl() ?? { server: DEFAULT_SERVER, room: "demo", name: "joueur" });
  const [session, setSession] = useState<Session | null>(() => {
    const url = joinFromUrl();
    return url === null ? null : { mode: "multi", ...url };
  });
  const [net, setNet] = useState<LockstepState | null>(null);
  const [seed, setSeed] = useState<number>(DEFAULT_SEED);

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

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !session) return;
    let disposed = false;
    let raf = 0;
    let interval = 0;
    let renderer: Renderer | undefined;
    let sim: SimHandle | undefined;
    let lockstep: LockstepClient | null = null;
    const cleanups: Array<() => void> = [];
    const toastTimers: number[] = [];
    /** Identifiants de toast réseau, hors de la plage des `seq` du sim. */
    let netToastId = -1;

    (async () => {
      renderer = new Renderer(canvas);
      rendererRef.current = renderer;
      renderer.setLeftDragPans(toolRef.current === "select");

      // --- État de la boucle ---
      let speed = 1;
      let paused = false;
      let selected: number | null = null;
      let mapVersion = -1;
      let overlayVersion = -1;
      let prevPawns: Int32Array | null = null;
      let curPawns: Int32Array = new Int32Array(0);
      let last = performance.now();
      let acc = 0;
      let ticksInWindow = 0;
      let framesInWindow = 0;
      let windowStart = last;
      let lastEventSeq = -1;
      /** Instant du dernier tick appliqué en multi, pour l'interpolation. */
      let lastAppliedAt: number | null = null;

      const pushToast = (text: string) => {
        const id = netToastId--;
        setToasts((prev) => [...prev, { id, text }]);
        toastTimers.push(window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== id)), TOAST_MS));
      };

      /** Branche un sim (neuf, chargé ou restauré) sur le rendu. */
      const adopt = (next: SimHandle) => {
        sim?.dispose();
        sim = next;
        mapVersion = -1;
        overlayVersion = -1;
        prevPawns = null;
        curPawns = next.pawns();
        lastAppliedAt = null;
        selected = null;
        renderer?.setSelected(null);
        // Les événements déjà dans l'état sont du passé : on ne les notifie pas.
        const evs = next.events();
        lastEventSeq = evs.length >= EVENT_STRIDE ? evs[evs.length - EVENT_STRIDE] : -1;
      };

      if (session.mode === "solo") {
        const created = await SimHandle.create({ seed: 42n, width: MAP_SIZE, height: MAP_SIZE });
        if (disposed) {
          created.dispose();
          return;
        }
        adopt(created);
      } else {
        // Multi : le sim n'existe qu'au démarrage de la salle (ou au snapshot
        // reçu si l'on rejoint en cours). Le lobby s'affiche d'ici là.
        lockstep = new LockstepClient({
          transport: new WebSocketTransport(session.server),
          createSim: (s, width, height) => SimHandle.create({ seed: BigInt(s), width, height }),
          restoreSim: (bytes) => SimHandle.restore(bytes),
          onState: (state) => setNet(state),
          // La fabrique ne produit que des `SimHandle` : le rendu a besoin de
          // ses tampons, que `SimLike` n'expose pas.
          onSim: (next) => {
            if (disposed) {
              (next as SimHandle).dispose();
              return;
            }
            adopt(next as SimHandle);
          },
          onError: (e) => pushToast(`Serveur : ${e.message}`),
        });
        lockstepRef.current = lockstep;
        lockstep.join(session.room, session.name);
      }

      const syncStatic = () => {
        const mv = sim!.mapVersion();
        if (mv !== mapVersion) {
          mapVersion = mv;
          renderer!.setMap(sim!.width, sim!.height, sim!.tiles(), sim!.features());
        }
        const ov = sim!.overlayVersion();
        if (ov !== overlayVersion) {
          overlayVersion = ov;
          renderer!.setOverlays(sim!.zones(), sim!.designations());
        }
      };

      const tickAndRender = (now: number) => {
        const dt = now - last;
        last = now;
        framesInWindow++;
        if (!sim) return; // multi : en lobby, il n'y a rien à montrer
        const tickMs = BASE_TICK_MS / speed;
        let n = 0;
        if (lockstep) {
          // Pas d'accumulateur : l'horloge est celle des bundles du serveur.
          // On n'avance que sur ce qui est reçu, et le rattrapage est borné.
          const budget = lockstep.lag > CATCHUP_LAG_TICKS ? MAX_TICKS_CATCHUP : MAX_TICKS_PER_FRAME;
          n = lockstep.pump(budget);
          if (n > 0) {
            prevPawns = curPawns;
            curPawns = sim.pawns();
            lastAppliedAt = now;
          }
        } else {
          if (!paused) acc += dt;
          while (acc >= tickMs && n < MAX_TICKS_PER_FRAME) {
            acc -= tickMs;
            n++;
          }
          if (acc > tickMs * MAX_TICKS_PER_FRAME) acc = 0;
          for (let i = 0; i < n; i++) {
            prevPawns = curPawns;
            sim.step(1);
            curPawns = sim.pawns();
          }
        }
        ticksInWindow += n;
        syncStatic();
        renderer!.syncItems(sim.items());
        renderer!.syncBlueprints(sim.blueprints());
        const alpha = lockstep
          ? // Fraction du temps écoulé depuis le dernier bundle appliqué.
            lastAppliedAt === null
            ? 1
            : Math.min((now - lastAppliedAt) / BUNDLE_INTERVAL_MS, 1)
          : paused
            ? 1
            : Math.min(acc / tickMs, 1);
        renderer!.syncPawns(curPawns, prevPawns, alpha);
        renderer!.setWeather(sim.weather());
        renderer!.setTimeOfDay(sim.timeOfDay() / sim.ticksPerDay());
        renderer!.render(dt / 1000);
      };

      const loop = (now: number) => {
        try {
          tickAndRender(now);
        } catch (e) {
          setError(e instanceof Error ? (e.stack ?? e.message) : String(e));
          return;
        }
        raf = requestAnimationFrame(loop);
      };
      // Le chargement du WASM ne compte pas comme du temps de jeu.
      last = performance.now();
      windowStart = last;
      raf = requestAnimationFrame(loop);

      /**
       * Seul chemin des actions du joueur. En solo la commande entre dans le
       * sim local, en multi elle part au serveur et revient dans un bundle :
       * jamais appliquée au clic (docs/protocol.md §5).
       */
      const issue = (payload: Uint8Array) => {
        if (lockstep) lockstep.issue(payload);
        else sim?.applyEncoded(payload);
      };

      // --- Sauvegarde (solo seulement : l'horloge du multi ne s'arrête pas) ---
      const flash = (msg: string) => {
        setNotice(msg);
        window.setTimeout(() => setNotice(null), 1800);
      };
      actionsRef.current = {
        save() {
          if (lockstep) return;
          try {
            localStorage.setItem(SAVE_KEY, bytesToBase64(sim!.snapshot()));
            flash("Partie sauvegardée");
          } catch (e) {
            flash(`Sauvegarde impossible : ${String(e)}`);
          }
        },
        load() {
          if (lockstep) return;
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
          SimHandle.restore(base64ToBytes(b64))
            .then((next) => {
              if (disposed) {
                next.dispose();
                return;
              }
              adopt(next);
              flash("Partie chargée");
            })
            .catch((e: unknown) => flash(`Chargement impossible : ${String(e)}`));
        },
        triggerRaid() {
          issue(encodeTriggerRaid());
        },
        setPriority(pawn, work, priority) {
          issue(encodeSetPriority(pawn, work, priority));
        },
        currentPriority(pawn, work) {
          // Valeur vivante du sim, pas celle affichée (rafraîchie toutes les 500 ms) :
          // deux clics rapprochés doivent s'enchaîner correctement.
          if (!sim) return null;
          const pr = sim.priorities();
          for (let o = 0; o + PRIORITY_STRIDE <= pr.length; o += PRIORITY_STRIDE) {
            if (pr[o] === pawn) return pr[o + 1 + work];
          }
          return null;
        },
      };

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
      /** Camp d'un pawn, lu dans le dernier tampon du sim. `-1` s'il a disparu. */
      const factionOf = (id: number) => {
        for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
          if (curPawns[o] === id) return curPawns[o + 10];
        }
        return -1;
      };
      const applyTool = (rect: TileRect) => {
        if (!sim) return;
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
        down = { x: e.clientX, y: e.clientY, button: e.button, tile: renderer?.pickTile(e.clientX, e.clientY) ?? null };
        if (toolRef.current !== "select" && e.button === 0 && down.tile) {
          renderer?.setDragRect({ x0: down.tile.x, y0: down.tile.y, x1: down.tile.x, y1: down.tile.y }, toolColor());
        }
      });
      on(canvas, "pointermove", (e: PointerEvent) => {
        const tile = renderer?.pickTile(e.clientX, e.clientY) ?? null;
        renderer?.setHover(tile);
        if (down && down.button === 0 && toolRef.current !== "select" && down.tile && tile) {
          renderer?.setDragRect({ x0: down.tile.x, y0: down.tile.y, x1: tile.x, y1: tile.y }, toolColor());
        }
      });
      on(canvas, "pointerup", (e: PointerEvent) => {
        if (!down) return;
        const start = down;
        down = null;
        renderer?.setDragRect(null);
        if (!renderer || !sim) return;
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
      on(canvas, "pointerleave", () => renderer?.setHover(null));
      on(canvas, "contextmenu", (e: MouseEvent) => e.preventDefault());
      on(window, "keydown", (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.code === "Space") {
          // Pas de pause en multi : l'horloge du serveur ne s'arrête jamais.
          if (!lockstep) paused = !paused;
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
            renderer?.rotate(-1);
            break;
          case "E":
            renderer?.rotate(1);
            break;
          case "1":
          case "2":
          case "3":
            if (!lockstep) speed = Number(k);
            break;
          case "ESCAPE":
            if (toolRef.current !== "select") setTool("select");
            else {
              selected = null;
              renderer?.setSelected(null);
            }
            break;
        }
      });

      // --- Crochet de debug (dev uniquement) : window.__rimlike ---
      if (import.meta.env.DEV) {
        const debug = {
          get sim() {
            return sim;
          },
          get lockstep() {
            return lockstep;
          },
          renderer,
          pawns: () => curPawns,
          setTool,
          setMaterial,
          actions: actionsRef,
          get paused() {
            return paused;
          },
          set paused(v: boolean) {
            paused = v;
          },
          get speed() {
            return speed;
          },
          set speed(v: number) {
            speed = v;
          },
          get selected() {
            return selected;
          },
          set selected(v: number | null) {
            selected = v;
            renderer?.setSelected(v);
          },
        };
        (window as unknown as { __rimlike?: unknown }).__rimlike = debug;
      }

      // --- HUD ---
      interval = window.setInterval(() => {
        const now = performance.now();
        const dt = (now - windowStart) / 1000;
        if (!sim) {
          setStats((prev) => ({ ...prev, tps: 0, fps: Math.round(framesInWindow / dt), lag: lockstep?.lag ?? 0 }));
          framesInWindow = 0;
          windowStart = now;
          return;
        }
        const tpd = sim.ticksPerDay();
        const tod = sim.timeOfDay() / tpd;
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
          const ck = curPawns[o + 8];
          const mood = curPawns[o + 6] / 10;
          info = {
            id: curPawns[o],
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
          };
        }
        // Notifications : un toast par événement du sim jamais vu.
        const events = sim.events();
        for (let o = 0; o + EVENT_STRIDE <= events.length; o += EVENT_STRIDE) {
          const seq = events[o];
          if (seq <= lastEventSeq) continue;
          lastEventSeq = seq;
          const text = eventLabel(events[o + 2], events[o + 3]);
          if (!text) continue;
          setToasts((prev) => [...prev, { id: seq, text }]);
          toastTimers.push(
            window.setTimeout(() => setToasts((prev) => prev.filter((t) => t.id !== seq)), TOAST_MS),
          );
        }
        setStats({
          tick: sim.tick(),
          day: Math.floor(sim.tick() / tpd) + 1,
          hour: `${hh}:${mm}`,
          hash: sim.hash(),
          tps: Math.round(ticksInWindow / dt),
          fps: Math.round(framesInWindow / dt),
          speed,
          paused,
          weather: sim.weather(),
          stored: Array.from(sim.storedTotals()),
          blueprints: sim.blueprints().length / BLUEPRINT_STRIDE,
          colonists,
          hostiles,
          selected: info,
          // Relu dans le tampon du sim : jamais une copie qui dériverait.
          priorities: Array.from(sim.priorities()),
          lag: lockstep?.lag ?? 0,
        });
        ticksInWindow = 0;
        framesInWindow = 0;
        windowStart = now;
      }, 500);
    })().catch((e: unknown) => setError(e instanceof Error ? (e.stack ?? e.message) : String(e)));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(interval);
      for (const t of toastTimers) clearTimeout(t);
      for (const c of cleanups) c();
      lockstep?.close();
      renderer?.dispose();
      sim?.dispose();
      actionsRef.current = null;
      rendererRef.current = null;
      lockstepRef.current = null;
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
  const running = !multi || (net !== null && net.phase === "running" && net.ready);
  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      {session === null ? (
        <HomeScreen
          form={form}
          onChange={setForm}
          onSolo={() => setSession({ mode: "solo" })}
          onJoin={() => setSession({ mode: "multi", ...form })}
        />
      ) : (
        multi &&
        !running && (
          <Lobby
            room={session.mode === "multi" ? session.room : ""}
            net={net}
            seed={seed}
            onSeed={setSeed}
            // Le serveur n'accepte qu'un entier positif comme graine.
            onStart={() => lockstepRef.current?.startGame(Math.max(0, Math.floor(seed)), MAP_SIZE, MAP_SIZE)}
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
                {sel.hostile ? "Ennemi" : "Colon"} {sel.id} · ({sel.tile.x}, {sel.tile.y})
              </div>
              <div className="panel-job">{sel.job}{sel.carrying ? ` · porte ${sel.carrying}` : ""}</div>
              <Bar label="PV" value={sel.hp} />
              <Bar label="Faim" value={sel.hunger} />
              <Bar label="Repos" value={sel.rest} />
              <Bar label="Humeur" value={sel.mood} />
              <div className="panel-mood">
                {sel.moodLabel}
                {sel.breaking ? <b> · craque !</b> : ""}
              </div>
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
                      <th>Colon {row.id}</th>
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

/** Écran d'accueil : solo tout de suite, ou connexion à un serveur relais. */
function HomeScreen({
  form,
  onChange,
  onSolo,
  onJoin,
}: {
  form: JoinForm;
  onChange: (f: JoinForm) => void;
  onSolo: () => void;
  onJoin: () => void;
}) {
  const ready = form.server.trim() !== "" && form.room.trim() !== "" && form.name.trim() !== "";
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
          Salle
          <input value={form.room} onChange={(e) => onChange({ ...form, room: e.target.value })} />
        </label>
        <label>
          Nom
          <input value={form.name} onChange={(e) => onChange({ ...form, name: e.target.value })} />
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
        <div className="help">Paramètres d'URL acceptés : ?server=…&amp;room=…&amp;name=…</div>
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
  onStart,
}: {
  room: string;
  net: LockstepState | null;
  seed: number;
  onSeed: (v: number) => void;
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
            {net.lastError ? net.lastError.message : "Le serveur a fermé la connexion."} Rechargez la page pour
            réessayer.
          </div>
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
                value={seed}
                onChange={(e) => onSeed(Number.isFinite(e.target.valueAsNumber) ? e.target.valueAsNumber : 0)}
              />
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
