import { afterEach, describe, expect, it } from "vitest";
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NativeColonies, type NativeColoniesOptions } from "../src/native-colonies.js";
import { NativeCheckpointStore } from "../src/native-checkpoints.js";
import { NativeSimProcess } from "../src/native-sim.js";

const live: NativeColonies[] = [];
const processes: NativeSimProcess[] = [];
const directories: string[] = [];
const options = { seed: 19, width: 32, height: 32, biome: 4, dayScale: 30 };
const nop = () => new Uint8Array([0]); // Command::Nop, première variante postcard.

afterEach(async () => {
  await Promise.allSettled(live.splice(0).map((runtime) => runtime.close()));
  await Promise.all(processes.splice(0).map((engine) => engine.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function store(): Promise<NativeCheckpointStore> {
  const directory = await mkdtemp(join(tmpdir(), "rimlike-native-test-"));
  directories.push(directory);
  return new NativeCheckpointStore(directory);
}
async function runtime(options: NativeColoniesOptions = {}): Promise<NativeColonies> {
  const result = await NativeColonies.open(options);
  live.push(result);
  return result;
}
async function engine(): Promise<NativeSimProcess> {
  const result = await NativeSimProcess.start();
  processes.push(result);
  return result;
}

describe("colonies autonomes", () => {
  it("avance sans joueur, dans un ordre stable et à 60 ticks/s", async () => {
    let pulse: () => void = () => { throw new Error("horloge non démarrée"); };
    let interval = 0;
    let stops = 0;
    const r = await runtime({ clock: (callback, ms) => { pulse = callback; interval = ms; return () => { stops++; }; } });
    await r.create("tile-9", options);
    await r.create("tile-2", options);
    r.start();
    r.start();
    expect(interval).toBe(50);
    pulse();
    expect((await r.inspect("tile-9")).tick).toBe(3);
    expect((await r.inspect("tile-2")).tick).toBe(3);
    const bundle = await r.advance();
    expect(bundle.map((b) => [b.map, b.from, b.to])).toEqual([["tile-2", 3, 6], ["tile-9", 3, 6]]);
    r.stop();
    expect(stops).toBe(1);
    expect(r.running).toBe(false);
  });

  it("copie les commandes et conserve leur ordre pour le moteur", async () => {
    const r = await runtime();
    const control = await engine();
    await r.create("a", options);
    await control.create("a", options);
    const command = nop();
    r.submit("a", command);
    command[0] = 255;
    r.submit("a", nop());
    const [bundle] = await r.advance();
    expect(bundle?.commands).toEqual([nop(), nop()]);
    await control.step("a", 0, [[nop(), nop()], [], []]);
    expect((await r.inspect("a")).hash).toBe((await control.inspect("a")).hash);
    expect((await r.advance())[0]?.commands).toEqual([]);
  });

  it("reprend exactement un checkpoint après arrêt du processus", async () => {
    const disk = await store();
    const first = await runtime({ store: disk, bundleTicks: 60, checkpointEveryTicks: 120 });
    await first.create("tile-8", options);
    await first.advance();
    await first.advance();
    const saved = await first.inspect("tile-8");
    expect((await disk.read("tile-8"))?.tick).toBe(120);
    await first.close();
    const second = await runtime({ store: disk, bundleTicks: 60 });
    expect(await second.restore("tile-8")).toEqual(saved);
    const control = await engine();
    await control.restore("control", (await disk.read("tile-8"))!.data);
    await second.advance();
    await control.step("control", 120, Array.from({ length: 60 }, () => []));
    expect((await second.inspect("tile-8")).hash).toBe((await control.inspect("control")).hash);
  });

  it("ne remplace jamais un checkpoint existant par une nouvelle colonie", async () => {
    const disk = await store();
    const first = await runtime({ store: disk });
    await first.create("tile-1", options);
    await first.advance();
    await first.close();
    const before = await readFile(join(disk.directory, "tile-1.json"), "utf8");
    const second = await runtime({ store: disk });
    await expect(second.create("tile-1", options)).rejects.toMatchObject({ code: "already_exists" });
    expect(await readFile(join(disk.directory, "tile-1.json"), "utf8")).toBe(before);
    expect((await second.restore("tile-1")).tick).toBe(3);
  });

  it("termine les ordres admis et sauvegarde avant un arrêt idempotent", async () => {
    const disk = await store();
    const r = await runtime({ store: disk });
    await r.create("a", options);
    r.submit("a", nop());
    const close = r.close();
    expect(r.close()).toBe(close);
    await close;
    expect((await disk.read("a"))?.tick).toBe(3);
    await expect(r.advance()).rejects.toMatchObject({ code: "closed" });
    expect(() => r.submit("a", nop())).toThrow("fermées");
  });

  it("sérialise les avances concurrentes sans rejouer un lot", async () => {
    const r = await runtime();
    await r.create("a", options);
    const batches = await Promise.all(Array.from({ length: 20 }, () => r.advance()));
    expect(batches.map((b) => b[0]?.from)).toEqual(Array.from({ length: 20 }, (_, i) => i * 3));
    expect((await r.inspect("a")).tick).toBe(60);
  });

  it("borne la charge et les pulses sans empiler le retard", async () => {
    let pulse = () => {};
    const r = await runtime({ clock: (callback) => { pulse = callback; return () => {}; } });
    await r.create("a", options);
    for (let i = 0; i < 256; i++) r.submit("a", nop());
    expect(() => r.submit("a", nop())).toThrow("Trop de commandes");
    expect(() => r.submit("missing", nop())).toThrow("non chargée");
    expect(() => r.submit("a", new Uint8Array())).toThrow("hors bornes");
    r.start();
    pulse();
    pulse();
    pulse();
    expect(r.skippedPulses).toBe(2);
    expect((await r.inspect("a")).tick).toBe(3);
  });

  it("arrête l'horloge et signale une commande refusée par Rust", async () => {
    const errors: Error[] = [];
    let stops = 0;
    const disk = await store();
    const r = await runtime({ store: disk, onError: (error) => errors.push(error),
      clock: () => () => { stops++; } });
    await r.create("a", options);
    r.start();
    r.submit("a", new Uint8Array([255]));
    await expect(r.advance()).rejects.toMatchObject({ code: "invalid_command" });
    expect(r.running).toBe(false);
    expect(stops).toBe(1);
    expect(errors).toHaveLength(1);
    expect((await disk.read("a"))?.tick).toBe(0);
    await expect(r.close()).rejects.toMatchObject({ code: "invalid_command" });
  });

  it("remonte une écriture impossible et ne prétend pas avoir conservé l'état", async () => {
    const disk = await store();
    const blocker = join(disk.directory, "file");
    await writeFile(blocker, "not a directory");
    const broken = new NativeCheckpointStore(join(blocker, "child"));
    await expect(runtime({ store: broken })).rejects.toThrow();
  });

  it("un échec de checkpoint conserve le précédent et arrête la boucle", async () => {
    const disk = await store();
    class FullDisk extends NativeCheckpointStore {
      writes = 0;
      override async write(...args: Parameters<NativeCheckpointStore["write"]>): Promise<void> {
        if (++this.writes > 1) throw new Error("Disque plein");
        await super.write(...args);
      }
    }
    const full = new FullDisk(disk.directory);
    const errors: Error[] = [];
    const r = await runtime({ store: full, checkpointEveryTicks: 3, onError: (error) => errors.push(error) });
    await r.create("a", options);
    r.start();
    await expect(r.advance()).rejects.toThrow("Disque plein");
    expect(r.running).toBe(false);
    expect(errors).toHaveLength(1);
    expect((await disk.read("a"))?.tick).toBe(0);
    await expect(r.close()).rejects.toThrow("Disque plein");
  });

  it("refuse une cadence invalide avant de démarrer un processus", async () => {
    for (const value of [0, 6001, 1.5, Number.NaN]) {
      await expect(NativeColonies.open({ bundleTicks: value })).rejects.toThrow("Cadence");
    }
    await expect(NativeColonies.open({ bundleTicks: 3, checkpointEveryTicks: 2 })).rejects.toThrow("Cadence");
  });
});

describe("exclusivité des sauvegardes natives", () => {
  it("refuse deux écrivains et libère le dossier après l'arrêt", async () => {
    const disk = await store();
    const first = await runtime({ store: disk });
    await first.create("a", options);
    await first.advance();
    await expect(runtime({ store: new NativeCheckpointStore(disk.directory) })).rejects.toThrow("déjà utilisé");
    await first.close();
    const second = await runtime({ store: new NativeCheckpointStore(disk.directory) });
    expect((await second.restore("a")).tick).toBe(3);
    await second.close();
    expect(await readdir(disk.directory)).toEqual(["a.json"]);
  });

  it("un verrou après crash est conservé et exige une vérification de l'opérateur", async () => {
    const disk = await store();
    const file = join(disk.directory, ".writer.lock");
    const marker = JSON.stringify({ token: "previous-process", pid: 999999, host: "another-host" });
    await writeFile(file, marker);
    await expect(runtime({ store: disk })).rejects.toThrow("arrêt brutal");
    expect(await readFile(file, "utf8")).toBe(marker);
  });

  it("libère le verrou si le processus Rust ne démarre pas", async () => {
    const disk = await store();
    await expect(runtime({ store: disk, process: { binary: join(disk.directory, "absent-binary") } })).rejects.toThrow();
    expect(await readdir(disk.directory)).toEqual([]);
    const valid = await runtime({ store: disk });
    await valid.create("a", options);
    await valid.close();
  });

  it("ne supprime jamais un verrou dont le propriétaire a changé", async () => {
    const disk = await store();
    const r = await runtime({ store: disk });
    const file = join(disk.directory, ".writer.lock");
    await writeFile(file, JSON.stringify({ token: "different-owner" }));
    await expect(r.close()).rejects.toThrow("propriétaire");
    expect(JSON.parse(await readFile(file, "utf8")).token).toBe("different-owner");
  });

  it("libère le dossier après une erreur métier et permet la reprise du dernier checkpoint", async () => {
    const disk = await store();
    const first = await runtime({ store: disk });
    await first.create("a", options);
    first.submit("a", new Uint8Array([255]));
    await expect(first.advance()).rejects.toMatchObject({ code: "invalid_command" });
    await expect(first.close()).rejects.toMatchObject({ code: "invalid_command" });
    const second = await runtime({ store: new NativeCheckpointStore(disk.directory) });
    expect((await second.restore("a")).tick).toBe(0);
  });
});

describe("checkpoints natifs", () => {
  it("vérifie octets, version et métadonnées avant de restaurer", async () => {
    const disk = await store();
    const r = await runtime({ store: disk });
    await r.create("a", options);
    await r.close();
    const file = join(disk.directory, "a.json");
    const original = JSON.parse(await readFile(file, "utf8"));
    for (const patch of [{ version: 999 }, { protocolVersion: 1 }, { map: "../b" }, { data: "!" }, { sha256: "0".repeat(64) }]) {
      await writeFile(file, JSON.stringify({ ...original, ...patch }));
      await expect(disk.read("a")).rejects.toThrow();
    }
    await writeFile(file, JSON.stringify(original));
    expect((await disk.read("a"))?.tick).toBe(0);
    expect(await readdir(disk.directory)).toEqual(["a.json"]);
  });

  it("refuse un hash d'état falsifié et permet ensuite la restauration correcte", async () => {
    const disk = await store();
    const first = await runtime({ store: disk });
    await first.create("a", options);
    await first.close();
    const file = join(disk.directory, "a.json");
    const original = await readFile(file, "utf8");
    await writeFile(file, JSON.stringify({ ...JSON.parse(original), hash: "0000000000000000" }));
    const second = await runtime({ store: disk });
    await expect(second.restore("a")).rejects.toThrow("ne correspond pas");
    expect(second.mapCount).toBe(0);
    await writeFile(file, original);
    expect((await second.restore("a")).tick).toBe(0);
  });

  it("refuse la traversée de répertoire et distingue absent de corrompu", async () => {
    const disk = await store();
    expect(await disk.read("missing")).toBeNull();
    for (const map of ["../outside", "", "/tmp/a", "a/b", "a\\b", "x".repeat(81)]) {
      await expect(disk.read(map)).rejects.toThrow("Nom de carte");
    }
    await writeFile(join(disk.directory, "a.json"), "{broken");
    await expect(disk.read("a")).rejects.toThrow();
    expect(await readFile(join(disk.directory, "a.json"), "utf8")).toBe("{broken");
  });
});
