import { useEffect, useRef, useState } from "react";
import { PAWN_STRIDE, Renderer, type TilePos, type TileRect } from "./render/Renderer";
import { DESIGNATION, ITEM_NAMES, JOB_LABELS, ZONE } from "./render/terrain";
import { SimHandle } from "./sim/SimHandle";

const TICKS_PER_SECOND = 60;
const BASE_TICK_MS = 1000 / TICKS_PER_SECOND;
/** Rattrapage maximal par frame : au-delà on lâche du temps plutôt que de geler. */
const MAX_TICKS_PER_FRAME = 8;
const CLICK_TOLERANCE_PX = 5;
const SAVE_KEY = "rimlike.save.v1";

type Tool = "select" | "chop" | "mine" | "harvest" | "stockpile" | "cancel";

const TOOLS: { id: Tool; label: string; key: string; color: number }[] = [
  { id: "select", label: "Sélection", key: "S", color: 0xffffff },
  { id: "chop", label: "Couper", key: "C", color: 0xff9a2e },
  { id: "mine", label: "Miner", key: "M", color: 0xff9a2e },
  { id: "harvest", label: "Récolter", key: "H", color: 0xff9a2e },
  { id: "stockpile", label: "Stockage", key: "Z", color: 0x4a90d9 },
  { id: "cancel", label: "Annuler", key: "X", color: 0xff4040 },
];

interface PawnInfo {
  id: number;
  tile: TilePos;
  hunger: number;
  rest: number;
  mood: number;
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
  stored: number[];
  selected: PawnInfo | null;
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
  stored: [0, 0, 0],
  selected: null,
};

interface Actions {
  save(): void;
  load(): void;
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
  const rendererRef = useRef<Renderer | null>(null);
  const actionsRef = useRef<Actions | null>(null);
  const [tool, setToolState] = useState<Tool>("select");
  const [stats, setStats] = useState<Stats>(INITIAL);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const setTool = (t: Tool) => {
    toolRef.current = t;
    setToolState(t);
    rendererRef.current?.setLeftDragPans(t === "select");
  };

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    let disposed = false;
    let raf = 0;
    let interval = 0;
    let renderer: Renderer | undefined;
    let sim: SimHandle | undefined;
    const cleanups: Array<() => void> = [];

    (async () => {
      const created = await SimHandle.create({ seed: 42n, width: 128, height: 128 });
      if (disposed) {
        created.dispose();
        return;
      }
      sim = created;
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
      let curPawns = sim.pawns();
      let last = performance.now();
      let acc = 0;
      let ticksInWindow = 0;
      let framesInWindow = 0;
      let windowStart = last;

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
        if (!paused) acc += dt;
        last = now;
        const tickMs = BASE_TICK_MS / speed;
        let n = 0;
        while (acc >= tickMs && n < MAX_TICKS_PER_FRAME) {
          acc -= tickMs;
          n++;
        }
        if (acc > tickMs * MAX_TICKS_PER_FRAME) acc = 0;
        for (let i = 0; i < n; i++) {
          prevPawns = curPawns;
          sim!.step(1);
          curPawns = sim!.pawns();
        }
        ticksInWindow += n;
        framesInWindow++;
        syncStatic();
        renderer!.syncItems(sim!.items());
        const alpha = paused ? 1 : Math.min(acc / tickMs, 1);
        renderer!.syncPawns(curPawns, prevPawns, alpha);
        renderer!.setTimeOfDay(sim!.timeOfDay() / sim!.ticksPerDay());
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
      raf = requestAnimationFrame(loop);

      // --- Sauvegarde ---
      const flash = (msg: string) => {
        setNotice(msg);
        window.setTimeout(() => setNotice(null), 1800);
      };
      actionsRef.current = {
        save() {
          try {
            localStorage.setItem(SAVE_KEY, bytesToBase64(sim!.snapshot()));
            flash("Partie sauvegardée");
          } catch (e) {
            flash(`Sauvegarde impossible : ${String(e)}`);
          }
        },
        load() {
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
              sim?.dispose();
              sim = next;
              mapVersion = -1;
              overlayVersion = -1;
              prevPawns = null;
              curPawns = sim.pawns();
              selected = null;
              renderer?.setSelected(null);
              flash("Partie chargée");
            })
            .catch((e: unknown) => flash(`Chargement impossible : ${String(e)}`));
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
      const applyTool = (rect: TileRect) => {
        if (!sim) return;
        switch (toolRef.current) {
          case "chop":
            sim.designate(DESIGNATION.Chop, rect.x0, rect.y0, rect.x1, rect.y1);
            break;
          case "mine":
            sim.designate(DESIGNATION.Mine, rect.x0, rect.y0, rect.x1, rect.y1);
            break;
          case "harvest":
            sim.designate(DESIGNATION.Harvest, rect.x0, rect.y0, rect.x1, rect.y1);
            break;
          case "stockpile":
            sim.setZone(ZONE.Stockpile, rect.x0, rect.y0, rect.x1, rect.y1);
            break;
          case "cancel":
            sim.designate(DESIGNATION.None, rect.x0, rect.y0, rect.x1, rect.y1);
            sim.setZone(ZONE.None, rect.x0, rect.y0, rect.x1, rect.y1);
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
          const tile = renderer.pickTile(e.clientX, e.clientY);
          if (tile) sim.moveTo(selected, tile.x, tile.y);
        }
      });
      on(canvas, "pointerleave", () => renderer?.setHover(null));
      on(canvas, "contextmenu", (e: MouseEvent) => e.preventDefault());
      on(window, "keydown", (e: KeyboardEvent) => {
        if (e.target instanceof HTMLInputElement) return;
        if (e.code === "Space") {
          paused = !paused;
          e.preventDefault();
          return;
        }
        const k = e.key.toUpperCase();
        const toolHit = TOOLS.find((t) => t.key === k);
        if (toolHit && !e.metaKey && !e.ctrlKey) {
          setTool(toolHit.id);
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
            speed = Number(k);
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
          renderer,
          pawns: () => curPawns,
          setTool,
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
        if (!sim) return;
        const now = performance.now();
        const dt = (now - windowStart) / 1000;
        const tpd = sim.ticksPerDay();
        const tod = sim.timeOfDay() / tpd;
        const minutes = Math.floor(tod * 24 * 60);
        const hh = String(Math.floor(minutes / 60)).padStart(2, "0");
        const mm = String(minutes % 60).padStart(2, "0");
        let info: PawnInfo | null = null;
        if (selected !== null) {
          for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
            if (curPawns[o] !== selected) continue;
            const ck = curPawns[o + 8];
            info = {
              id: selected,
              tile: { x: Math.floor(curPawns[o + 1] / 256), y: Math.floor(curPawns[o + 2] / 256) },
              hunger: curPawns[o + 4] / 10,
              rest: curPawns[o + 5] / 10,
              mood: curPawns[o + 6] / 10,
              job: JOB_LABELS[curPawns[o + 7]] ?? "?",
              carrying: ck >= 0 ? `${curPawns[o + 9]} ${ITEM_NAMES[ck]}` : null,
            };
          }
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
          stored: Array.from(sim.storedTotals()),
          selected: info,
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
      for (const c of cleanups) c();
      renderer?.dispose();
      sim?.dispose();
      actionsRef.current = null;
      rendererRef.current = null;
    };
  }, []);

  if (error) return <div className="error">{error}</div>;

  const sel = stats.selected;
  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      <div className="hud">
        <div>
          jour <b>{stats.day}</b> · <b>{stats.hour}</b> · tick {stats.tick}
          {stats.paused ? <b> · PAUSE</b> : ` · x${stats.speed}`}
        </div>
        <div>
          stock : {ITEM_NAMES.map((n, i) => `${stats.stored[i] ?? 0} ${n}`).join(" · ")}
        </div>
        <div className="help">
          {stats.tps} tps · {stats.fps} fps · hash {stats.hash}
        </div>
        <div className="help">glisser droit ou flèches : déplacer · molette : zoom · Q/E : tourner · espace : pause · 1/2/3 : vitesse</div>
      </div>

      {sel && (
        <div className="panel">
          <div className="panel-title">
            Colon {sel.id} · ({sel.tile.x}, {sel.tile.y})
          </div>
          <div className="panel-job">{sel.job}{sel.carrying ? ` · porte ${sel.carrying}` : ""}</div>
          <Bar label="Faim" value={sel.hunger} />
          <Bar label="Repos" value={sel.rest} />
          <Bar label="Humeur" value={sel.mood} />
          <div className="help">clic droit sur une case : y aller</div>
        </div>
      )}

      <div className="toolbar">
        {TOOLS.map((t) => (
          <button key={t.id} className={t.id === tool ? "active" : ""} onClick={() => setTool(t.id)} title={`Touche ${t.key}`}>
            {t.label} <span className="key">{t.key}</span>
          </button>
        ))}
        <span className="sep" />
        <button onClick={() => actionsRef.current?.save()}>Sauver</button>
        <button onClick={() => actionsRef.current?.load()}>Charger</button>
      </div>
      {tool !== "select" && (
        <div className="tool-hint">
          {tool === "stockpile"
            ? "Tracez un rectangle pour créer une zone de stockage"
            : tool === "cancel"
              ? "Tracez un rectangle pour annuler désignations et zones"
              : "Tracez un rectangle sur les éléments à traiter"}{" "}
          · clic droit ou Échap pour revenir à la sélection
        </div>
      )}
      {notice && <div className="notice">{notice}</div>}
    </>
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
