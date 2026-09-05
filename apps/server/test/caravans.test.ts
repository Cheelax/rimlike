/**
 * Tests de `CaravanRegistry` et de `WorldClock`, sans réseau ni timer :
 * l'horloge de jeu est une variable que le test avance à la main, et toute la
 * progression d'une caravane en découle.
 *
 * Le globe de test est à la subdivision 2 (162 cases) : instantané à générer,
 * et il a deux continents séparés par l'océan — de quoi vérifier qu'une
 * caravane ne prend pas la mer.
 */

import { describe, expect, it } from "vitest";

import { CARAVAN_HISTORY_HOURS, WORLD_HOUR_MS, type CaravanSummary } from "@rimlike/protocol";
import { findRoute, movementCost } from "@rimlike/world";

import { CaravanRegistry } from "../src/caravans.js";
import { DEFAULT_WORLD_SEED, WorldClock, sharedWorld } from "../src/world.js";

const SUBDIVISIONS = 2;
const globe = sharedWorld(SUBDIVISIONS, DEFAULT_WORLD_SEED);

const landTiles = globe.tiles.filter((tile) => movementCost(tile.biome) !== null).map((tile) => tile.id);
const homeTile = landTiles[0]!;
/** Cases atteignables depuis `homeTile`, de la plus proche à la plus lointaine. */
const reachable = landTiles
  .map((id) => ({ id, route: id === homeTile ? null : findRoute(globe, homeTile, id) }))
  .filter((entry): entry is { id: number; route: NonNullable<ReturnType<typeof findRoute>> } => entry.route !== null)
  .sort((a, b) => a.route.hours - b.route.hours || a.id - b.id);
/** Une destination à plusieurs étapes : de quoi observer `currentTile` bouger. */
const farTile = reachable.find((entry) => entry.route.tiles.length >= 3)!;
/** Une case terrestre sur un autre continent : aucune route, l'océan bloque. */
const unreachableTile = landTiles.find((id) => id !== homeTile && findRoute(globe, homeTile, id) === null)!;

const summary: CaravanSummary = { pawns: 2, items: [[0, 30]] };
const manifest = new Uint8Array([1, 2, 3, 250]);

/** Un registre dont l'horloge de jeu est une variable du test. */
function registry(historyHours = CARAVAN_HISTORY_HOURS): {
  readonly caravans: CaravanRegistry;
  set: (hours: number) => void;
} {
  let hours = 0;
  const caravans = new CaravanRegistry({ world: globe, hours: () => hours, historyHours });
  return {
    caravans,
    set: (value: number) => {
      hours = value;
    },
  };
}

/** Expédie une caravane vers `toTile` et rend son identifiant. */
function depart(caravans: CaravanRegistry, toTile: number, owner = "alice"): string {
  const result = caravans.depart({ owner, fromTile: homeTile, toTile, manifest, summary });
  expect(result.ok).toBe(true);
  if (!result.ok) {
    throw new Error("départ refusé");
  }
  return result.caravan.id;
}

describe("globe de test", () => {
  it("a de quoi voyager et de quoi rester bloqué", () => {
    expect(reachable.length).toBeGreaterThan(2);
    expect(farTile.route.tiles.length).toBeGreaterThanOrEqual(3);
    expect(unreachableTile).toBeGreaterThanOrEqual(0);
  });
});

describe("horloge du monde", () => {
  it("compte les heures de jeu au rythme de hourMs", () => {
    let real = 1_000_000;
    const clock = new WorldClock({ hourMs: 1000, now: () => real });
    expect(clock.hours()).toBe(0);
    real += 500;
    expect(clock.hours()).toBe(0.5);
    real += 2500;
    expect(clock.hours()).toBe(3);
    expect(clock.worldStartedAt).toBe(1_000_000);
  });

  it("vaut 30 s par heure de jeu par défaut", () => {
    expect(new WorldClock().hourMs).toBe(WORLD_HOUR_MS);
    expect(WORLD_HOUR_MS).toBe(30_000);
  });

  it("ne vieillit pas pendant que le serveur est éteint", () => {
    let real = 1_000;
    const first = new WorldClock({ hourMs: 100, now: () => real, worldStartedAt: 1_000 });
    real += 1000; // 10 h de jeu
    const saved = first.toJSON();
    expect(saved.hoursOffset).toBe(10);

    // Le serveur reste éteint une éternité, puis redémarre.
    real += 10_000_000;
    const second = new WorldClock({
      hourMs: 100,
      now: () => real,
      worldStartedAt: saved.worldStartedAt,
      hoursOffset: saved.hoursOffset,
    });
    expect(second.hours()).toBe(10);
    expect(second.worldStartedAt).toBe(1_000);
    real += 500;
    expect(second.hours()).toBe(15);
  });

  it("refuse une heure de jeu de durée nulle ou négative", () => {
    expect(() => new WorldClock({ hourMs: 0 })).toThrow(RangeError);
    expect(() => new WorldClock({ hourMs: -1 })).toThrow(RangeError);
  });
});

describe("expédier une caravane", () => {
  it("prend l'itinéraire du globe et en déduit l'heure d'arrivée", () => {
    const { caravans, set } = registry();
    set(100);
    const result = caravans.depart({
      owner: "alice",
      fromTile: homeTile,
      toTile: farTile.id,
      manifest,
      summary,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const caravan = result.caravan;
    expect(caravan.id).toBe("c1");
    expect(caravan.owner).toBe("alice");
    expect(caravan.route).toEqual(farTile.route.tiles);
    expect(caravan.route[0]).toBe(homeTile);
    expect(caravan.route.at(-1)).toBe(farTile.id);
    expect(caravan.departedAt).toBe(100);
    expect(caravan.arrivesAt).toBe(100 + farTile.route.hours);
    expect(caravan.status).toBe("travelling");
    expect(caravan.progress).toBe(0);
    expect(caravan.currentTile).toBe(homeTile);
    expect(caravan.summary).toEqual(summary);
    expect(caravans.count).toBe(1);
  });

  it("refuse l'océan, la même case et une case hors du globe", () => {
    const { caravans } = registry();
    const refuse = (fromTile: number, toTile: number): string => {
      const result = caravans.depart({ owner: "alice", fromTile, toTile, manifest, summary });
      expect(result.ok).toBe(false);
      return result.ok ? "" : result.code;
    };
    expect(refuse(homeTile, unreachableTile)).toBe("caravan_no_route");
    expect(refuse(homeTile, homeTile)).toBe("caravan_same_tile");
    expect(refuse(homeTile, 162)).toBe("bad_tile");
    expect(refuse(-1, homeTile)).toBe("bad_tile");
    expect(caravans.count).toBe(0);
  });

  it("ne réutilise jamais un identifiant", () => {
    const { caravans } = registry();
    const first = depart(caravans, farTile.id);
    const second = depart(caravans, reachable[0]!.id);
    expect(first).not.toBe(second);
  });
});

describe("progression", () => {
  it("interpole linéairement et suit les cases de l'itinéraire", () => {
    const { caravans, set } = registry();
    const id = depart(caravans, farTile.id);
    const hours = farTile.route.hours;
    const steps = farTile.route.tiles.length - 1;

    for (const fraction of [0, 0.25, 0.5, 0.75, 1]) {
      set(hours * fraction);
      const caravan = caravans.get(id)!;
      expect(caravan.progress).toBeCloseTo(fraction, 10);
      const index = Math.min(steps, Math.floor(fraction * steps));
      expect(caravan.currentTile).toBe(farTile.route.tiles[index]);
    }
  });

  it("borne l'avancement à [0, 1] même si l'horloge dépasse l'arrivée", () => {
    const { caravans, set } = registry();
    const id = depart(caravans, farTile.id);
    set(farTile.route.hours * 10);
    const caravan = caravans.get(id)!;
    expect(caravan.progress).toBe(1);
    expect(caravan.currentTile).toBe(farTile.id);
  });

  it("n'arrive qu'à l'heure dite", () => {
    const { caravans, set } = registry();
    const id = depart(caravans, farTile.id);
    const hours = farTile.route.hours;

    set(hours - 0.001);
    expect(caravans.advance().arrived).toEqual([]);
    expect(caravans.get(id)!.status).toBe("travelling");
    expect(caravans.hasMoving).toBe(true);

    set(hours);
    const advanced = caravans.advance();
    expect(advanced.changed).toBe(true);
    expect(advanced.arrived.map((c) => c.id)).toEqual([id]);
    expect(advanced.arrived[0]!.currentTile).toBe(farTile.id);
    expect(caravans.get(id)!.status).toBe("arrived");
    expect(caravans.hasMoving).toBe(false);

    // Une arrivée n'est annoncée qu'une fois.
    expect(caravans.advance().arrived).toEqual([]);
  });
});

describe("annuler une caravane", () => {
  it("fait demi-tour depuis la position courante avant la moitié", () => {
    const { caravans, set } = registry();
    const id = depart(caravans, farTile.id);
    const quarter = farTile.route.hours * 0.25;
    set(quarter);
    const position = caravans.get(id)!.currentTile;

    const result = caravans.cancel(id, "alice");
    expect(result.ok).toBe(true);
    if (!result.ok) {
      return;
    }
    const back = findRoute(globe, position, homeTile)!;
    expect(result.caravan.status).toBe("returning");
    expect(result.caravan.fromTile).toBe(position);
    expect(result.caravan.toTile).toBe(homeTile);
    expect(result.caravan.route).toEqual(back.tiles);
    expect(result.caravan.departedAt).toBe(quarter);
    expect(result.caravan.arrivesAt).toBe(quarter + back.hours);

    // Elle rentre, et rentrer est une arrivée comme une autre.
    set(quarter + back.hours);
    expect(caravans.advance().arrived.map((c) => c.id)).toEqual([id]);
    expect(caravans.get(id)!.status).toBe("arrived");
    expect(caravans.pendingArrivals(homeTile).map((a) => a.id)).toEqual([id]);
  });

  it("refuse après la moitié, une caravane déjà arrivée, un inconnu et un autre propriétaire", () => {
    const { caravans, set } = registry();
    const id = depart(caravans, farTile.id);
    expect(caravans.cancel("c404", "alice")).toEqual({ ok: false, code: "caravan_not_found" });
    expect(caravans.cancel(id, "bob")).toEqual({ ok: false, code: "not_owner" });

    set(farTile.route.hours * 0.5);
    expect(caravans.cancel(id, "alice")).toEqual({ ok: false, code: "caravan_too_late" });
    expect(caravans.get(id)!.status).toBe("travelling");

    set(farTile.route.hours);
    caravans.advance();
    expect(caravans.cancel(id, "alice")).toEqual({ ok: false, code: "caravan_too_late" });
  });

  it("ne s'annule pas deux fois : une caravane qui rentre garde son cap", () => {
    const { caravans, set } = registry();
    const id = depart(caravans, farTile.id);
    set(farTile.route.hours * 0.1);
    expect(caravans.cancel(id, "alice").ok).toBe(true);
    expect(caravans.cancel(id, "alice")).toEqual({ ok: false, code: "caravan_too_late" });
  });
});

describe("arrivée et livraison", () => {
  it("garde l'arrivée en attente jusqu'à la confirmation de l'hôte", () => {
    const { caravans, set } = registry();
    const id = depart(caravans, farTile.id);
    expect(caravans.pendingArrivals(farTile.id)).toEqual([]);
    expect(caravans.arrivalOf(id)).toBeUndefined();

    set(farTile.route.hours);
    caravans.advance();
    // Tant que l'hôte n'a pas répondu, l'arrivée reste réémissible.
    for (let attempt = 0; attempt < 3; attempt += 1) {
      expect(caravans.pendingArrivals(farTile.id)).toEqual([
        { id, tile: farTile.id, manifest, summary },
      ]);
    }
    expect(caravans.arrivalOf(id)).toEqual({ id, tile: farTile.id, manifest, summary });

    expect(caravans.markDelivered(id)).toBe(true);
    expect(caravans.get(id)!.status).toBe("delivered");
    expect(caravans.pendingArrivals(farTile.id)).toEqual([]);
    expect(caravans.arrivalOf(id)).toBeUndefined();
    // Deux confirmations ne comptent que pour une.
    expect(caravans.markDelivered(id)).toBe(false);
    expect(caravans.markDelivered("c404")).toBe(false);
  });

  it("oublie une caravane livrée au bout de CARAVAN_HISTORY_HOURS", () => {
    const { caravans, set } = registry(24);
    const id = depart(caravans, farTile.id);
    set(farTile.route.hours);
    caravans.advance();
    caravans.markDelivered(id);

    set(farTile.route.hours + 23);
    expect(caravans.advance().changed).toBe(false);
    expect(caravans.count).toBe(1);

    set(farTile.route.hours + 24);
    expect(caravans.advance().changed).toBe(true);
    expect(caravans.count).toBe(0);
    expect(caravans.get(id)).toBeUndefined();
  });
});

describe("sérialisation", () => {
  it("fait l'aller-retour, manifeste et heures compris", () => {
    const { caravans, set } = registry();
    const flying = depart(caravans, farTile.id);
    const arrived = depart(caravans, reachable[0]!.id, "bob");
    set(reachable[0]!.route.hours);
    caravans.advance();

    const json = JSON.parse(JSON.stringify(caravans.toJSON())) as ReturnType<CaravanRegistry["toJSON"]>;
    let hours = reachable[0]!.route.hours;
    const back = new CaravanRegistry({ world: globe, hours: () => hours });
    back.restore(json);

    expect(back.count).toBe(2);
    expect(back.get(flying)).toEqual(caravans.get(flying));
    expect(back.get(arrived)).toEqual(caravans.get(arrived));
    expect(back.arrivalOf(arrived)?.manifest).toEqual(manifest);
    // Le compteur d'identifiants aussi : pas de collision après un redémarrage.
    const next = back.depart({ owner: "alice", fromTile: homeTile, toTile: farTile.id, manifest, summary });
    expect(next.ok && next.caravan.id).toBe("c3");

    // La caravane en vol reprend sa route avec la même heure d'arrivée.
    hours = farTile.route.hours;
    expect(back.advance().arrived.map((c) => c.id)).toEqual([flying]);
  });

  it("refuse un manifeste illisible ou une case inexistante", () => {
    const { caravans } = registry();
    depart(caravans, farTile.id);
    const json = caravans.toJSON();
    const fresh = (): CaravanRegistry => new CaravanRegistry({ world: globe, hours: () => 0 });

    expect(() =>
      fresh().restore({ ...json, caravans: [{ ...json.caravans[0]!, manifest: "pas du base64!" }] }),
    ).toThrow(/illisible/);
    expect(() =>
      fresh().restore({ ...json, caravans: [{ ...json.caravans[0]!, toTile: 9999 }] }),
    ).toThrow(/inexistante/);
  });
});
