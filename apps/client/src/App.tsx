import { useEffect, useRef, useState } from "react";
import { Renderer, type TilePos } from "./render/Renderer";
import { SimHandle } from "./sim/SimHandle";

const TICKS_PER_SECOND = 60;
const BASE_TICK_MS = 1000 / TICKS_PER_SECOND;
/** Rattrapage maximal par frame : au-delà on lâche du temps plutôt que de geler. */
const MAX_TICKS_PER_FRAME = 8;
const CLICK_TOLERANCE_PX = 5;
const PAWN_STRIDE = 4;

interface Stats {
  tick: number;
  day: number;
  hour: string;
  hash: string;
  tps: number;
  fps: number;
  speed: number;
  paused: boolean;
  selected: number | null;
  selectedTile: TilePos | null;
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
  selected: null,
  selectedTile: null,
};

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats>(INITIAL);
  const [error, setError] = useState<string | null>(null);

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
      renderer.setMap(sim.width, sim.height, sim.tiles());

      // --- État de la boucle ---
      let speed = 1;
      let paused = false;
      let selected: number | null = null;
      let prevPawns: Int32Array | null = null;
      let curPawns = sim.pawns();
      let last = performance.now();
      let acc = 0;
      let ticksInWindow = 0;
      let framesInWindow = 0;
      let windowStart = last;

      const tickAndRender = (now: number) => {
        if (!paused) acc += now - last;
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
        const alpha = paused ? 1 : Math.min(acc / tickMs, 1);
        renderer!.syncPawns(curPawns, prevPawns, alpha);
        renderer!.setTimeOfDay(sim!.timeOfDay() / sim!.ticksPerDay());
        renderer!.render();
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

      // --- Entrées ---
      let down: { x: number; y: number; button: number } | null = null;
      const on = <K extends keyof HTMLElementEventMap>(
        target: HTMLElement | Window,
        type: K | keyof WindowEventMap,
        fn: (e: never) => void,
      ) => {
        target.addEventListener(type as string, fn as EventListener);
        cleanups.push(() => target.removeEventListener(type as string, fn as EventListener));
      };
      on(canvas, "pointerdown", (e: PointerEvent) => {
        down = { x: e.clientX, y: e.clientY, button: e.button };
      });
      on(canvas, "pointerup", (e: PointerEvent) => {
        if (!down) return;
        const moved = Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_TOLERANCE_PX;
        const button = down.button;
        down = null;
        if (moved || !renderer || !sim) return;
        if (button === 0) {
          selected = renderer.pickPawn(e.clientX, e.clientY);
          renderer.setSelected(selected);
        } else if (button === 2 && selected !== null) {
          const tile = renderer.pickTile(e.clientX, e.clientY);
          if (tile) sim.moveTo(selected, tile.x, tile.y);
        }
      });
      on(canvas, "pointermove", (e: PointerEvent) => {
        renderer?.setHover(renderer.pickTile(e.clientX, e.clientY));
      });
      on(canvas, "pointerleave", () => renderer?.setHover(null));
      on(canvas, "contextmenu", (e: MouseEvent) => e.preventDefault());
      on(window, "keydown", (e: KeyboardEvent) => {
        if (e.code === "Space") {
          paused = !paused;
          e.preventDefault();
          return;
        }
        switch (e.key) {
          case "q":
          case "Q":
            renderer?.rotate(-1);
            break;
          case "e":
          case "E":
            renderer?.rotate(1);
            break;
          case "1":
          case "2":
          case "3":
            speed = Number(e.key);
            break;
          case "Escape":
            selected = null;
            renderer?.setSelected(null);
            break;
        }
      });

      // --- Crochet de debug (dev uniquement) : window.__rimlike ---
      if (import.meta.env.DEV) {
        const debug = {
          sim,
          renderer,
          pawns: () => curPawns,
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
        let selectedTile: TilePos | null = null;
        if (selected !== null) {
          for (let o = 0; o + PAWN_STRIDE <= curPawns.length; o += PAWN_STRIDE) {
            if (curPawns[o] === selected) {
              selectedTile = { x: Math.floor(curPawns[o + 1] / 256), y: Math.floor(curPawns[o + 2] / 256) };
            }
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
          selected,
          selectedTile,
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
    };
  }, []);

  if (error) return <div className="error">{error}</div>;

  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      <div className="hud">
        <div>
          jour <b>{stats.day}</b> · <b>{stats.hour}</b> · tick {stats.tick}
          {stats.paused ? <b> · PAUSE</b> : ` · x${stats.speed}`}
        </div>
        <div>
          {stats.tps} tps · {stats.fps} fps · hash <b>{stats.hash}</b>
        </div>
        <div>
          {stats.selected === null
            ? "clic gauche : sélectionner un colon"
            : `colon ${stats.selected} en (${stats.selectedTile?.x}, ${stats.selectedTile?.y}) · clic droit : y aller`}
        </div>
        <div className="help">glisser : déplacer · molette : zoom · Q/E : tourner · espace : pause · 1/2/3 : vitesse</div>
      </div>
    </>
  );
}
