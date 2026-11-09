/**
 * Real NativeColonies loop + durable disk checkpoints, compiled Node modules.
 * From repository root: pnpm build:native && pnpm --filter server run build:server
 * node docs/benchmarks/2026-09-19/bench-runtime.mjs
 * Leaves a uniquely named /tmp directory for inspection; never touches user saves.
 */
import { readFile, mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { performance } from "node:perf_hooks";

const base = new URL("./", import.meta.url);
const root = new URL("../../../", base);
const { NativeCheckpointStore } = await import(new URL("apps/server/dist/apps/server/src/native-checkpoints.js", root));
const { NativeColonies } = await import(new URL("apps/server/dist/apps/server/src/native-colonies.js", root));
const { NativeSimProcess } = await import(new URL("apps/server/dist/apps/server/src/native-sim.js", root));
const binary = fileURLToPath(new URL("target/release/rimlike-native", root));
const directory = await mkdtemp(join(tmpdir(), "rimlike-runtime-bench-"));
const store = new NativeCheckpointStore(directory);
const release = await store.acquireWriter();
const processOptions = { binary, timeoutMs: 60_000 };
let source;
const seedEngine = await NativeSimProcess.start(processOptions);
try {
  source = await seedEngine.restore("source", new Uint8Array(await readFile(new URL("mature-seed1.bin", base))));
  const snapshot = await seedEngine.snapshot("source");
  for (let i = 0; i < 64; i++) await store.write("map-" + i, source, snapshot);
} finally {
  await seedEngine.close();
  await release();
}
const runtime = await NativeColonies.open({ process: processOptions, store, checkpointEveryTicks: 3600 });
let result;
try {
  const restoreStart = performance.now();
  for (let i = 0; i < 64; i++) await runtime.restore("map-" + i);
  const restoreMs = performance.now() - restoreStart;
  const batches = [];
  const runStart = performance.now();
  for (let i = 0; i < 1200; i++) {
    const before = performance.now();
    const applied = await runtime.advance();
    if (applied.length !== 64 || applied.some(b => b.to !== source.tick + (i + 1) * 3)) throw new Error("Divergent batch");
    batches.push(performance.now() - before);
  }
  const elapsedMs = performance.now() - runStart;
  const end = await runtime.inspect("map-0");
  const saved = await store.read("map-0");
  if (saved.tick !== end.tick || saved.hash !== end.hash) throw new Error("Checkpoint mismatch");
  const checkpointBatchMs = batches.at(-1);
  batches.sort((a, b) => a - b);
  const beforeCheckpoint = performance.now();
  await runtime.checkpoint();
  const explicitCheckpointMs = performance.now() - beforeCheckpoint;
  result = {
    maps: 64, source: "mature-seed1.bin", ticks_per_map: 3600, batch_ticks: 3,
    start_tick: source.tick, end_tick: end.tick, hash: end.hash,
    restore_ms: restoreMs, elapsed_ms: elapsedMs,
    all_maps_batch_p50_ms: batches[600], all_maps_batch_p95_ms: batches[1140],
    all_maps_batch_max_ms: batches.at(-1),
    batches_over_50_ms: batches.filter(ms => ms > 50).length,
    periodic_checkpoint_batch_ms: checkpointBatchMs,
    explicit_all_maps_checkpoint_ms: explicitCheckpointMs,
    node_rss_bytes: process.memoryUsage().rss,
    directory,
    note: "Boucle NativeColonies séquentielle réelle, checkpoints fsync inclus. 64 copies, WSL local chargé, avance manuelle sans attente d'horloge ; ni réseau ni mesure VPS.",
  };
} finally { await runtime.close(); }
console.log(JSON.stringify(result, null, 2));
