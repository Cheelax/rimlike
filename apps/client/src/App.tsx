import { useEffect, useRef, useState } from "react";
import { Renderer } from "./render/Renderer";
import { SimHandle } from "./sim/SimHandle";

const TICKS_PER_SECOND = 60;
const TICK_MS = 1000 / TICKS_PER_SECOND;
/** Rattrapage maximal par frame : au-delà on lâche du temps plutôt que de geler. */
const MAX_TICKS_PER_FRAME = 8;

interface Stats {
  tick: number;
  hash: string;
  tps: number;
  fps: number;
}

export function App() {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [stats, setStats] = useState<Stats>({ tick: 0, hash: "", tps: 0, fps: 0 });
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let disposed = false;
    let raf = 0;
    let interval = 0;
    let renderer: Renderer | undefined;
    let sim: SimHandle | undefined;

    (async () => {
      const created = await SimHandle.create({ seed: 42n, width: 128, height: 128 });
      if (disposed || !canvasRef.current) {
        created.dispose();
        return;
      }
      sim = created;
      renderer = new Renderer(canvasRef.current);
      renderer.setMap(sim.width, sim.height, sim.tiles());

      let last = performance.now();
      let acc = 0;
      let ticksInWindow = 0;
      let framesInWindow = 0;
      let windowStart = last;

      const loop = (now: number) => {
        try {
          tickAndRender(now);
        } catch (e) {
          setError(e instanceof Error ? (e.stack ?? e.message) : String(e));
          return;
        }
        raf = requestAnimationFrame(loop);
      };

      const tickAndRender = (now: number) => {
        acc += now - last;
        last = now;
        let n = 0;
        while (acc >= TICK_MS && n < MAX_TICKS_PER_FRAME) {
          acc -= TICK_MS;
          n++;
        }
        if (acc > TICK_MS * MAX_TICKS_PER_FRAME) acc = 0;
        if (n > 0) sim!.step(n);
        ticksInWindow += n;
        framesInWindow++;
        renderer!.render();
      };
      raf = requestAnimationFrame(loop);

      interval = window.setInterval(() => {
        const now = performance.now();
        const dt = (now - windowStart) / 1000;
        setStats({
          tick: sim!.tick(),
          hash: sim!.hash(),
          tps: Math.round(ticksInWindow / dt),
          fps: Math.round(framesInWindow / dt),
        });
        ticksInWindow = 0;
        framesInWindow = 0;
        windowStart = now;
      }, 500);
    })().catch((e: unknown) => setError(e instanceof Error ? e.stack ?? e.message : String(e)));

    return () => {
      disposed = true;
      cancelAnimationFrame(raf);
      clearInterval(interval);
      renderer?.dispose();
      sim?.dispose();
    };
  }, []);

  if (error) return <div className="error">{error}</div>;

  return (
    <>
      <canvas ref={canvasRef} className="scene" />
      <div className="hud">
        <div>tick <b>{stats.tick}</b> · {stats.tps} tps · {stats.fps} fps</div>
        <div>hash <b>{stats.hash}</b></div>
        <div>glisser pour déplacer · molette pour zoomer</div>
      </div>
    </>
  );
}
