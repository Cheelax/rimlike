/**
 * Mesure l'ensemble Node -> pipes -> Rust, avec les mêmes petits lots que
 * le lockstep. Ce relevé local ne remplace pas la mesure sur le VPS.
 *
 * pnpm bench:native --maps 16 --size 128 --ticks 1200 --batch 3
 */
import { readFileSync } from "node:fs";
import { basename } from "node:path";
import { performance } from "node:perf_hooks";
import { NativeSimProcess } from "../src/native-sim.js";

function option(name: string, fallback: number, low: number, high: number): number {
  const at = process.argv.indexOf("--" + name);
  const n = at < 0 ? fallback : Number(process.argv[at + 1]);
  if (!Number.isSafeInteger(n) || n < low || n > high) throw new Error(`--${name} attendu entre ${low} et ${high}`);
  return n;
}
const maps = option("maps", 16, 1, 128);
const size = option("size", 128, 8, 192);
const ticks = option("ticks", 1200, 3, 360_000);
const batch = option("batch", 3, 1, 6000);
const dayScale = option("day-scale", 30, 1, 120);
const snapshotArg = process.argv.indexOf("--snapshot");
const snapshotFile = snapshotArg < 0 ? null : process.argv[snapshotArg + 1];
if (snapshotArg >= 0 && (!snapshotFile || snapshotFile.startsWith("--"))) throw new Error("--snapshot attend un fichier");
const sourceSnapshot = snapshotFile ? readFileSync(snapshotFile) : null;
const native = await NativeSimProcess.start({ timeoutMs: 60_000 });
function rssKiB(): number | null {
  if (process.platform !== "linux") return null;
  const match = /^VmRSS:\s+(\d+) kB$/m.exec(readFileSync(`/proc/${native.pid}/status`, "utf8"));
  return match ? Number(match[1]) : null;
}
try {
  const emptyRss = rssKiB();
  const begin = performance.now();
  const initial = [];
  for (let i = 0; i < maps; i++) {
    initial.push(sourceSnapshot
      ? await native.restore("map-" + i, sourceSnapshot)
      : await native.create("map-" + i, { seed: 100 + i, width: size, height: size, biome: 4, dayScale }));
  }
  const createMs = performance.now() - begin;
  const loadedRss = rssKiB();
  const batches: number[] = [];
  const startTick = initial[0]!.tick;
  let current = startTick;
  let advanced = 0;
  const runStart = performance.now();
  while (advanced < ticks) {
    const count = Math.min(batch, ticks - advanced);
    const frames: Uint8Array[][] = Array.from({ length: count }, () => []);
    const before = performance.now();
    await Promise.all(initial.map((_, i) => native.step("map-" + i, current, frames)));
    batches.push(performance.now() - before);
    current += count;
    advanced += count;
  }
  const elapsedMs = performance.now() - runStart;
  const finalRss = rssKiB();
  const checkpointStart = performance.now();
  const snapshots = await Promise.all(initial.map((_, i) => native.snapshot("map-" + i)));
  const checkpointMs = performance.now() - checkpointStart;
  batches.sort((a, b) => a - b);
  const result = {
    protocol: 1, maps, size: initial[0]!.width, height: initial[0]!.height,
    ticks_per_map: ticks, start_tick: startTick, batch_ticks: batch, day_scale: initial[0]!.day_scale,
    source: snapshotFile ? basename(snapshotFile) : "fresh-colonies",
    create_ms: createMs, elapsed_ms: elapsedMs, ticks_per_second: maps * ticks * 1000 / elapsedMs,
    all_maps_batch_p50_ms: batches[Math.floor(batches.length * 0.5)],
    all_maps_batch_p95_ms: batches[Math.min(batches.length - 1, Math.floor(batches.length * 0.95))],
    realtime_batch_budget_ms: batch * 1000 / 60,
    native_empty_rss_kib: emptyRss, native_loaded_rss_kib: loadedRss, native_final_rss_kib: finalRss,
    initial_snapshot_bytes: initial.reduce((n, s) => n + s.snapshot_bytes, 0),
    checkpoint_bytes: snapshots.reduce((n, s) => n + s.data.length, 0),
    checkpoint_ms: checkpointMs,
    note: sourceSnapshot
      ? "Même snapshot restauré sur toutes les cartes, machine locale. Pas un dimensionnement VPS."
      : "Colonies neuves en forêt tempérée, machine locale. Pas un dimensionnement VPS ni une charge de fin de partie.",
  };
  console.log(JSON.stringify(result, null, 2));
} finally { await native.close(); }
