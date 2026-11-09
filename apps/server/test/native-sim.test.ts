import { afterEach, describe, expect, it } from "vitest";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  NativeFrameReader, NativeSimProcess, defaultNativeBinary, MAX_NATIVE_FRAME_BYTES,
} from "../src/native-sim.js";

const live: NativeSimProcess[] = [];
afterEach(async () => { await Promise.all(live.splice(0).map((p) => p.close())); });

async function start(): Promise<NativeSimProcess> {
  if (!existsSync(defaultNativeBinary())) {
    throw new Error("Construire le moteur avant ces tests : pnpm build:native");
  }
  const process = await NativeSimProcess.start();
  live.push(process);
  return process;
}
const options = { seed: 17, width: 32, height: 32, biome: 4, dayScale: 30 };

describe("processus natif réel", () => {
  it("fait vivre deux cartes indépendantes puis restaure un checkpoint", async () => {
    const process = await start();
    const [a, b] = await Promise.all([process.create("a", options), process.create("b", options)]);
    expect(a.hash).toBe(b.hash);
    const tick = await process.step("a", 0, Array.from({ length: 600 }, () => []));
    expect(tick).toBe(600);
    expect((await process.inspect("b")).tick).toBe(0);
    const checkpoint = await process.snapshot("a");
    const restored = await process.restore("c", checkpoint.data);
    expect(restored.tick).toBe(600);
    expect(restored.hash).toBe((await process.inspect("a")).hash);
    await Promise.all(["a", "c"].map((map) => process.step(map, 600, [[], [], []])));
    expect((await process.inspect("a")).hash).toBe((await process.inspect("c")).hash);
    expect(await process.remove("b")).toBe(true);
    expect(await process.remove("b")).toBe(false);
    await expect(process.inspect("b")).rejects.toMatchObject({ code: "not_found" });
  });

  it("refuse le tick incorrect, le doublon et une commande invalide sans altérer la carte", async () => {
    const process = await start();
    const before = await process.create("a", options);
    await expect(process.create("a", options)).rejects.toMatchObject({ code: "already_exists" });
    await expect(process.step("a", 99, [[]])).rejects.toMatchObject({ code: "tick_mismatch" });
    await expect(process.step("a", 0, [[new Uint8Array([0])], [new Uint8Array([255])]]))
      .rejects.toMatchObject({ code: "invalid_command" });
    expect(await process.inspect("a")).toEqual(before);
    expect(await process.step("a", 0, [[]])).toBe(1);
  });

  it("un arrêt rejette les demandes futures et close reste idempotent", async () => {
    const process = await start();
    await process.create("a", options);
    process.terminate();
    await expect(process.inspect("a")).rejects.toMatchObject({ code: "closed" });
    await Promise.all([process.close(), process.close()]);
  });

  it("un processus muet expire et est arrêté", async () => {
    await expect(NativeSimProcess.start({ binary: process.execPath,
      args: [fileURLToPath(new URL("./fixtures/native-stall.cjs", import.meta.url))], timeoutMs: 100,
    })).rejects.toMatchObject({ code: "timeout" });
  });

  it("un arrêt rejette aussi les requêtes déjà en vol", async () => {
    const process = await start();
    await process.create("a", options);
    const pending = process.step("a", 0, Array.from({ length: 6000 }, () => []));
    process.terminate();
    await expect(pending).rejects.toMatchObject({ code: "closed" });
  });

  it("signale un exécutable absent", async () => {
    await expect(NativeSimProcess.start({ binary: "/rimlike-native-absent" })).rejects.toThrow();
  });
});

function frame(text: string): Buffer {
  const bytes = Buffer.from(text);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

describe("décodage du flux natif", () => {
  it("reconstitue des en-têtes et contenus coupés à chaque octet", () => {
    const reader = new NativeFrameReader();
    const got: string[] = [];
    const bytes = Buffer.concat([frame("première"), frame("deuxième"), frame("{}")]);
    for (const byte of bytes) reader.push(new Uint8Array([byte]), (payload) => got.push(payload.toString()));
    expect(got).toEqual(["première", "deuxième", "{}"]);
  });

  it("accepte plusieurs réponses et un début de trame dans un même fragment", () => {
    const reader = new NativeFrameReader();
    const got: string[] = [];
    const bytes = Buffer.concat([frame("a"), frame("bbbb")]);
    reader.push(bytes.subarray(0, 7), (payload) => got.push(payload.toString()));
    expect(got).toEqual(["a"]);
    reader.push(bytes.subarray(7), (payload) => got.push(payload.toString()));
    expect(got).toEqual(["a", "bbbb"]);
  });

  it("refuse la taille nulle ou excessive avant toute allocation du contenu", () => {
    for (const length of [0, MAX_NATIVE_FRAME_BYTES + 1]) {
      const header = Buffer.alloc(4);
      header.writeUInt32BE(length);
      expect(() => new NativeFrameReader().push(header, () => {})).toThrow("hors bornes");
    }
  });
});
