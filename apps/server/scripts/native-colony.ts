/**
 * Démonstrateur de colonie continue, isolé du relais et du monde de production.
 * pnpm dev:native -- --map demo --directory /tmp/rimlike-native-demo --seconds 2
 */
import { NativeCheckpointStore } from "../src/native-checkpoints.js";
import { NativeColonies } from "../src/native-colonies.js";

function argumentsFrom(argv: readonly string[]): Map<string, string> {
  const values = new Map<string, string>();
  const allowed = new Set(["map", "directory", "seed", "size", "day-scale", "seconds"]);
  const args = argv[0] === "--" ? argv.slice(1) : argv;
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i]?.replace(/^--/, "");
    const value = args[i + 1];
    if (!args[i]?.startsWith("--") || !key || !allowed.has(key) || !value || values.has(key)) {
      throw new Error("Options : --map NOM --directory DOSSIER [--seed 1 --size 64 --day-scale 30 --seconds 0]");
    }
    values.set(key, value);
  }
  return values;
}
function integer(values: Map<string, string>, key: string, fallback: number, min: number, max: number): number {
  const value = Number(values.get(key) ?? fallback);
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error("Option numérique invalide : " + key);
  return value;
}

async function main(): Promise<void> {
  const args = argumentsFrom(process.argv.slice(2));
  const map = args.get("map");
  const directory = args.get("directory");
  if (!map || !directory) throw new Error("--map et --directory sont obligatoires ; aucun état existant n'est remplacé");
  const disk = new NativeCheckpointStore(directory);
  const duration = integer(args, "seconds", 0, 0, 86400);
  let finish: (error?: Error) => void = () => {};
  const finished = new Promise<Error | undefined>((resolve) => { finish = resolve; });
  const runtime = await NativeColonies.open({ store: disk, onError: (error) => finish(error) });
  let timer: ReturnType<typeof setTimeout> | undefined;
  const signal = () => finish();
  process.once("SIGINT", signal);
  process.once("SIGTERM", signal);
  // L'horloge métier est unref ; ce garde maintient le démon en vie jusqu'au signal.
  const keepAlive = setInterval(() => {}, 60_000);
  try {
    const checkpoint = await disk.read(map);
    const state = checkpoint ? await runtime.restore(map) : await runtime.create(map, {
      seed: integer(args, "seed", 1, 0, Number.MAX_SAFE_INTEGER),
      width: integer(args, "size", 64, 8, 192),
      height: integer(args, "size", 64, 8, 192),
      biome: 4,
      dayScale: integer(args, "day-scale", 30, 1, 120),
    });
    console.log(JSON.stringify({ event: checkpoint ? "restored" : "created", map, ...state }));
    runtime.start();
    if (duration > 0) timer = setTimeout(signal, duration * 1000);
    const error = await finished;
    runtime.stop();
    if (error) throw error;
    await runtime.close();
    const saved = await disk.read(map);
    console.log(JSON.stringify({ event: "saved", map, tick: saved?.tick, hash: saved?.hash,
      skippedPulses: runtime.skippedPulses, directory: disk.directory }));
  } finally {
    if (timer) clearTimeout(timer);
    clearInterval(keepAlive);
    process.off("SIGINT", signal);
    process.off("SIGTERM", signal);
    await runtime.close();
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
