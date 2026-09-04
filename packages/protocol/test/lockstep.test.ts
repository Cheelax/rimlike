import { describe, expect, it } from "vitest";

import {
  BUNDLE_TICKS,
  BundleHistory,
  HashLedger,
  Scheduler,
  type Bundle,
} from "../src/index.js";

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

/** Liste plate `[player, premier octet]` des commandes d'un bundle. */
function flatten(bundle: Bundle): Array<[number, number]> {
  return bundle.ticks.flatMap((t) => t.commands.map((c): [number, number] => [c.player, c.payload[0]!]));
}

describe("Scheduler", () => {
  it("émet des bundles contigus de BUNDLE_TICKS ticks", () => {
    const scheduler = new Scheduler();
    expect(scheduler.nextBundleFrom).toBe(0);
    const first = scheduler.emitBundle();
    expect(first).toEqual({ from: 0, to: BUNDLE_TICKS - 1, ticks: [] });
    const second = scheduler.emitBundle();
    expect(second.from).toBe(first.to + 1);
    expect(second.to - second.from + 1).toBe(BUNDLE_TICKS);
  });

  it("planifie une commande arrivée pendant le bundle N dans le bundle N+1", () => {
    const scheduler = new Scheduler();
    const bundle0 = scheduler.emitBundle();
    expect(bundle0.ticks).toEqual([]);

    // Arrivée pendant que le bundle 0 est « en cours » : planifiée en 3.
    const tick = scheduler.submit(1, bytes(1), 1000);
    expect(tick).toBe(BUNDLE_TICKS);
    expect(scheduler.pendingCount).toBe(1);

    const bundle1 = scheduler.emitBundle();
    expect(bundle1.from).toBe(BUNDLE_TICKS);
    expect(bundle1.ticks).toHaveLength(1);
    expect(bundle1.ticks[0]!.tick).toBe(BUNDLE_TICKS);
    expect(flatten(bundle1)).toEqual([[1, 1]]);

    // Et elle n'est pas rejouée dans le bundle suivant.
    expect(scheduler.emitBundle().ticks).toEqual([]);
  });

  it("place toutes les commandes d'un bundle sur son premier tick", () => {
    const scheduler = new Scheduler();
    scheduler.submit(1, bytes(1), 10);
    scheduler.submit(2, bytes(2), 20);
    const bundle = scheduler.emitBundle();
    expect(bundle.ticks).toHaveLength(1);
    expect(bundle.ticks[0]!.tick).toBe(bundle.from);
    expect(bundle.ticks[0]!.commands).toHaveLength(2);
  });

  it("ordonne par instant d'arrivée", () => {
    const scheduler = new Scheduler();
    scheduler.submit(3, bytes(30), 300);
    scheduler.submit(1, bytes(10), 100);
    scheduler.submit(2, bytes(20), 200);
    expect(flatten(scheduler.emitBundle())).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
    ]);
  });

  it("départage les arrivées simultanées par playerId croissant", () => {
    const scheduler = new Scheduler();
    scheduler.submit(4, bytes(40), 1000);
    scheduler.submit(2, bytes(20), 1000);
    scheduler.submit(3, bytes(30), 1000);
    scheduler.submit(1, bytes(10), 1000);
    expect(flatten(scheduler.emitBundle())).toEqual([
      [1, 10],
      [2, 20],
      [3, 30],
      [4, 40],
    ]);
  });

  it("garde l'ordre d'arrivée entre deux commandes d'un même joueur", () => {
    const scheduler = new Scheduler();
    scheduler.submit(1, bytes(1), 1000);
    scheduler.submit(1, bytes(2), 1000);
    scheduler.submit(1, bytes(3), 1000);
    expect(flatten(scheduler.emitBundle())).toEqual([
      [1, 1],
      [1, 2],
      [1, 3],
    ]);
  });

  it("produit le même ordre quel que soit l'ordre des appels à instants égaux", () => {
    const submissions: Array<[number, number]> = [
      [2, 20],
      [1, 10],
      [3, 30],
    ];
    const forward = new Scheduler();
    for (const [player, value] of submissions) {
      forward.submit(player, bytes(value), 500);
    }
    const backward = new Scheduler();
    for (const [player, value] of [...submissions].reverse()) {
      backward.submit(player, bytes(value), 500);
    }
    expect(flatten(forward.emitBundle())).toEqual(flatten(backward.emitBundle()));
  });

  it("oublie les commandes en attente d'un joueur parti", () => {
    const scheduler = new Scheduler();
    scheduler.submit(1, bytes(1), 10);
    scheduler.submit(2, bytes(2), 20);
    scheduler.dropPlayer(1);
    expect(flatten(scheduler.emitBundle())).toEqual([[2, 2]]);
  });

  it("accepte un premier tick et une taille de bundle sur mesure", () => {
    const scheduler = new Scheduler({ bundleTicks: 1, startTick: 100 });
    expect(scheduler.emitBundle()).toEqual({ from: 100, to: 100, ticks: [] });
    expect(scheduler.nextBundleFrom).toBe(101);
    expect(() => new Scheduler({ bundleTicks: 0 })).toThrow(RangeError);
  });
});

describe("HashLedger", () => {
  it("ne signale rien quand tout le monde est d'accord", () => {
    const ledger = new HashLedger();
    expect(ledger.report(1, 300, "aaaa")).toBeNull();
    expect(ledger.report(2, 300, "aaaa")).toBeNull();
    expect(ledger.report(3, 300, "aaaa")).toBeNull();
    expect(ledger.report(1, 600, "bbbb")).toBeNull();
    expect(ledger.report(2, 600, "bbbb")).toBeNull();
    expect(ledger.desync).toBeNull();
  });

  it("ne compare pas des ticks différents", () => {
    const ledger = new HashLedger();
    expect(ledger.report(1, 300, "aaaa")).toBeNull();
    expect(ledger.report(2, 600, "bbbb")).toBeNull();
    expect(ledger.desync).toBeNull();
  });

  it("détecte un écart sur un même tick et rend tous les hashes", () => {
    const ledger = new HashLedger();
    expect(ledger.report(1, 300, "aaaa")).toBeNull();
    const report = ledger.report(2, 300, "cccc");
    expect(report).toEqual({ tick: 300, hashes: { 1: "aaaa", 2: "cccc" } });
    expect(ledger.desync).toEqual(report);
  });

  it("ne signale que le premier écart", () => {
    const ledger = new HashLedger();
    ledger.report(1, 300, "aaaa");
    expect(ledger.report(2, 300, "cccc")).not.toBeNull();
    expect(ledger.report(1, 600, "dddd")).toBeNull();
    expect(ledger.report(2, 600, "eeee")).toBeNull();
    expect(ledger.desync?.tick).toBe(300);
  });

  it("expose les hashes d'un tick et oublie un joueur parti", () => {
    const ledger = new HashLedger();
    ledger.report(1, 300, "aaaa");
    ledger.report(2, 300, "aaaa");
    expect(ledger.hashesAt(300)).toEqual({ 1: "aaaa", 2: "aaaa" });
    ledger.removePlayer(2);
    expect(ledger.hashesAt(300)).toEqual({ 1: "aaaa" });
    expect(ledger.hashesAt(999)).toEqual({});
  });

  it("borne la mémoire des ticks", () => {
    const ledger = new HashLedger({ keepTicks: 2 });
    ledger.report(1, 1, "a");
    ledger.report(1, 2, "a");
    ledger.report(1, 3, "a");
    expect(ledger.hashesAt(1)).toEqual({});
    expect(ledger.hashesAt(3)).toEqual({ 1: "a" });
  });
});

describe("BundleHistory", () => {
  const bundle = (from: number): Bundle => ({ from, to: from + 2, ticks: [] });

  it("borne le nombre de bundles conservés", () => {
    const history = new BundleHistory(3);
    for (let i = 0; i < 5; i += 1) {
      history.push(bundle(i * 3));
    }
    expect(history.size).toBe(3);
    expect(history.oldestTick).toBe(6);
    expect(history.nextTick).toBe(15);
    expect(() => new BundleHistory(0)).toThrow(RangeError);
  });

  it("rejoue depuis un tick, bundle contenant ce tick inclus", () => {
    const history = new BundleHistory(10);
    for (let i = 0; i < 4; i += 1) {
      history.push(bundle(i * 3));
    }
    expect(history.since(0).map((b) => b.from)).toEqual([0, 3, 6, 9]);
    expect(history.since(4).map((b) => b.from)).toEqual([3, 6, 9]);
    expect(history.since(5).map((b) => b.from)).toEqual([3, 6, 9]);
    expect(history.since(6).map((b) => b.from)).toEqual([6, 9]);
    expect(history.since(12)).toEqual([]);
  });

  it("dit si le rejeu depuis un tick est complet", () => {
    const history = new BundleHistory(2);
    expect(history.covers(0)).toBe(true);
    history.push(bundle(0));
    history.push(bundle(3));
    history.push(bundle(6));
    expect(history.covers(2)).toBe(false);
    expect(history.covers(3)).toBe(true);
    expect(history.covers(7)).toBe(true);
  });

  it("conserve les commandes du rejeu à l'identique", () => {
    const history = new BundleHistory(10);
    const withCommand: Bundle = {
      from: 0,
      to: 2,
      ticks: [{ tick: 0, commands: [{ player: 1, payload: bytes(7, 8) }] }],
    };
    history.push(withCommand);
    expect(history.since(0)).toEqual([withCommand]);
    history.clear();
    expect(history.size).toBe(0);
    expect(history.oldestTick).toBeNull();
    expect(history.nextTick).toBeNull();
  });
});
