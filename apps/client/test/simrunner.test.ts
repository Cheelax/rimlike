/**
 * La cadence du jeu, éprouvée sans navigateur, sans WASM et sans Worker.
 *
 * `SimRunner` n'a ni timer ni `postMessage` : on lui donne une horloge à la
 * main (`advance(nowMs)`) et on regarde ce qu'il répond. Le sim est remplacé
 * par un faux qui compte les ticks et pilote ses numéros de version : ce qui
 * est vérifié ici est la boucle, pas le gameplay.
 */

import { describe, expect, it } from "vitest";

import { HASH_EVERY_FRAMES } from "../src/worker/protocol";
import {
  BASE_TICK_MS,
  MAX_TICKS_PER_STEP,
  SimRunner,
  type LockstepLike,
  type RunnerSim,
} from "../src/worker/SimRunner";

class FakeSim implements RunnerSim {
  readonly width = 4;
  readonly height = 3;
  /** Ticks exécutés au total. */
  ticks = 0;
  mapV = 1;
  overlayV = 1;
  hashCalls = 0;
  disposed = false;
  applied: string[] = [];

  tick(): number {
    return this.ticks;
  }

  step(n: number): void {
    this.ticks += n;
  }

  applyEncoded(bytes: Uint8Array): void {
    this.applied.push(bytes.join(","));
  }

  hash(): string {
    this.hashCalls += 1;
    return `h${this.ticks}`;
  }

  snapshot(): Uint8Array {
    return new Uint8Array([1, 2, 3]);
  }

  mapVersion(): number {
    return this.mapV;
  }

  overlayVersion(): number {
    return this.overlayV;
  }

  private cells(fill: number): Uint8Array {
    return new Uint8Array(this.width * this.height).fill(fill);
  }

  tiles(): Uint8Array {
    return this.cells(3);
  }

  features(): Uint8Array {
    return this.cells(1);
  }

  zones(): Uint8Array {
    return this.cells(2);
  }

  designations(): Uint8Array {
    return this.cells(0);
  }

  /** Ids simulés dans le tampon `pawns` : muable, pour éprouver le cache des noms. */
  pawnIds: number[] = [1];
  /** Nombre d'appels à `pawnName`, pour vérifier qu'il n'est pas fait à chaque frame. */
  nameCalls = 0;

  pawns(): Int32Array {
    const out: number[] = [];
    for (const id of this.pawnIds) out.push(id, 256, 512, 0, 800, 900, 700, 0, -1, 0, 0, 1000);
    return new Int32Array(out);
  }

  items(): Int32Array {
    return new Int32Array([1, 0, 5, 2, 2]);
  }

  blueprints(): Int32Array {
    return new Int32Array(0);
  }

  events(): Int32Array {
    return new Int32Array(0);
  }

  priorities(): Int32Array {
    return new Int32Array([1, 3, 3, 3, 3, 3, 3]);
  }

  skills(): Int32Array {
    return new Int32Array([1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0]);
  }

  health(): Int32Array {
    return new Int32Array([1, 1000, 100, 0]);
  }

  pawnName(id: number): string {
    this.nameCalls += 1;
    return `pawn${id}`;
  }

  storedTotals(): Uint32Array {
    return new Uint32Array([1, 2, 3, 4, 5, 6]);
  }

  weather(): number {
    return 1;
  }

  timeOfDay(): number {
    return 120;
  }

  ticksPerDay(): number {
    return 14400;
  }

  dispose(): void {
    this.disposed = true;
  }
}

/** Lockstep de laboratoire : on décide du retard et de ce que `pump` rend. */
class FakeLockstep implements LockstepLike {
  lag = 0;
  /** Budgets reçus, dans l'ordre. */
  readonly budgets: number[] = [];
  available = 0;

  pump(maxTicks: number): number {
    this.budgets.push(maxTicks);
    const executed = Math.min(maxTicks, this.available);
    this.available -= executed;
    return executed;
  }
}

/** Runner solo prêt à tourner, avec son premier `frame` déjà consommé. */
function soloStarted(): { runner: SimRunner; sim: FakeSim } {
  const runner = new SimRunner();
  const sim = new FakeSim();
  runner.setSim(sim);
  // Premier `advance` : dt nul, il ne sert qu'à poser l'horloge et à émettre
  // la carte, les calques et un `frame` initial.
  runner.advance(0);
  return { runner, sim };
}

describe("SimRunner en solo", () => {
  it("exécute exactement le nombre de ticks que le temps écoulé autorise", () => {
    const { runner, sim } = soloStarted();
    const out = runner.advance(100);
    expect(out.ticks).toBe(Math.floor(100 / BASE_TICK_MS)); // 6
    expect(sim.ticks).toBe(out.ticks);
  });

  it("borne le rattrapage à huit ticks par appel", () => {
    const { runner, sim } = soloStarted();
    // Une seconde d'un coup vaudrait 60 ticks : on en fait 8 et on lâche le reste.
    expect(runner.advance(1000).ticks).toBe(MAX_TICKS_PER_STEP);
    expect(sim.ticks).toBe(MAX_TICKS_PER_STEP);
    // Le temps en trop a été abandonné, pas mis en réserve.
    expect(runner.advance(1020).ticks).toBe(1);
  });

  it("n'exécute rien en pause et gèle l'accumulateur", () => {
    const { runner, sim } = soloStarted();
    runner.setPaused(true);
    const paused = runner.advance(1000);
    expect(paused.ticks).toBe(0);
    expect(paused.frame).toBeNull();
    expect(sim.ticks).toBe(0);
    // À la reprise, la seconde passée en pause n'est pas rattrapée.
    runner.setPaused(false);
    expect(runner.advance(1020).ticks).toBe(1);
    expect(sim.ticks).toBe(1);
  });

  it("respecte la vitesse x3", () => {
    const { runner, sim } = soloStarted();
    runner.setSpeed(3);
    const out = runner.advance(30);
    expect(out.ticks).toBe(Math.floor(30 / (BASE_TICK_MS / 3))); // 5
    expect(sim.ticks).toBe(5);
    // La même durée à x1 n'aurait donné qu'un tick.
    const solo = soloStarted();
    expect(solo.runner.advance(30).ticks).toBe(1);
  });

  it("émet un `frame` par lot de ticks, et aucun sans tick", () => {
    const runner = new SimRunner();
    const sim = new FakeSim();
    runner.setSim(sim);
    // Le premier `frame` part même sans tick : sinon l'écran resterait vide.
    const start = runner.advance(0);
    expect(start.ticks).toBe(0);
    expect(start.frame).not.toBeNull();
    // Trop peu de temps pour un tick : rien à montrer.
    const idle = runner.advance(1);
    expect(idle.ticks).toBe(0);
    expect(idle.frame).toBeNull();
    // Un lot de plusieurs ticks ne donne qu'un `frame`, celui de l'état final.
    const batch = runner.advance(100);
    expect(batch.ticks).toBe(6);
    expect(batch.frame?.tick).toBe(6);
  });

  it("n'émet carte et calques qu'au changement de version", () => {
    const runner = new SimRunner();
    const sim = new FakeSim();
    runner.setSim(sim);
    const first = runner.advance(0);
    expect(first.map?.mapVersion).toBe(1);
    expect(first.overlays?.overlayVersion).toBe(1);
    expect(first.map?.tiles).toEqual(sim.tiles());

    const same = runner.advance(100);
    expect(same.ticks).toBe(6);
    expect(same.map).toBeNull();
    expect(same.overlays).toBeNull();

    sim.mapV = 2;
    const changed = runner.advance(200);
    expect(changed.map?.mapVersion).toBe(2);
    expect(changed.overlays).toBeNull();

    sim.overlayV = 7;
    const overlaid = runner.advance(300);
    expect(overlaid.map).toBeNull();
    expect(overlaid.overlays?.overlayVersion).toBe(7);
  });

  it("ne porte le hash qu'un `frame` sur trente", () => {
    const { runner, sim } = soloStarted();
    // Le `frame` initial comptait pour un : le prochain hash est trente plus loin.
    expect(sim.hashCalls).toBe(1);
    const hashes: (string | null)[] = [];
    for (let i = 1; i <= HASH_EVERY_FRAMES; i++) {
      const out = runner.advance(i * 100);
      expect(out.frame).not.toBeNull();
      hashes.push(out.frame!.hash);
    }
    expect(hashes.filter((h) => h !== null).length).toBe(1);
    // Et c'est bien le trentième d'après le premier.
    expect(hashes[HASH_EVERY_FRAMES - 1]).not.toBeNull();
    expect(sim.hashCalls).toBe(2);
  });

  it("libère le sim précédent et réémet tout à l'adoption du suivant", () => {
    const { runner, sim } = soloStarted();
    runner.advance(100);
    const next = new FakeSim();
    runner.setSim(next);
    expect(sim.disposed).toBe(true);
    expect(next.disposed).toBe(false);
    // Versions oubliées : la carte et les calques repartent, `frame` compris.
    const out = runner.advance(101);
    expect(out.ticks).toBe(0);
    expect(out.map).not.toBeNull();
    expect(out.overlays).not.toBeNull();
    expect(out.frame).not.toBeNull();
  });

  it("ne recalcule les noms que si la liste des ids change", () => {
    const { runner, sim } = soloStarted();
    expect(sim.nameCalls).toBe(1); // premier `frame` : un pawn, un appel
    const first = runner.advance(100);
    expect(first.frame?.names).toEqual({ 1: "pawn1" });
    expect(sim.nameCalls).toBe(1); // même id : pas de nouvel appel

    // Même liste d'ids sur plusieurs frames : toujours pas de recalcul.
    runner.advance(200);
    runner.advance(300);
    expect(sim.nameCalls).toBe(1);

    // Un pawn de plus : la liste change, les noms sont recalculés.
    sim.pawnIds = [1, 2];
    const grown = runner.advance(400);
    expect(grown.frame?.names).toEqual({ 1: "pawn1", 2: "pawn2" });
    expect(sim.nameCalls).toBe(3); // les deux ids relus

    // Un pawn disparu : la liste change encore, même sans en ajouter.
    sim.pawnIds = [2];
    const shrunk = runner.advance(500);
    expect(shrunk.frame?.names).toEqual({ 2: "pawn2" });
  });

  it("ne fait rien tant qu'aucun sim n'est adopté", () => {
    const runner = new SimRunner();
    const out = runner.advance(1000);
    expect(out).toEqual({ ticks: 0, map: null, overlays: null, frame: null });
  });
});

describe("SimRunner en multi", () => {
  it("laisse l'horloge au serveur et borne le rattrapage à huit ticks", () => {
    const lockstep = new FakeLockstep();
    const runner = new SimRunner({ lockstep });
    const sim = new FakeSim();
    runner.setSim(sim);
    runner.advance(0);

    // Rien reçu : le temps qui passe n'avance pas le sim d'un pouce.
    expect(runner.advance(1000).ticks).toBe(0);
    expect(sim.ticks).toBe(0);

    lockstep.available = 20;
    const out = runner.advance(1016);
    expect(out.ticks).toBe(MAX_TICKS_PER_STEP);
    expect(lockstep.budgets.at(-1)).toBe(MAX_TICKS_PER_STEP);
  });

  it("rattrape plus fort au-delà de soixante ticks de retard", () => {
    const lockstep = new FakeLockstep();
    const runner = new SimRunner({ lockstep });
    runner.setSim(new FakeSim());
    runner.advance(0);
    lockstep.lag = 61;
    lockstep.available = 100;
    expect(runner.advance(16).ticks).toBe(30);
    expect(lockstep.budgets.at(-1)).toBe(30);
  });

  it("refuse la pause et les vitesses : l'horloge du serveur ne s'arrête pas", () => {
    const lockstep = new FakeLockstep();
    const runner = new SimRunner({ lockstep });
    runner.setSim(new FakeSim());
    runner.setPaused(true);
    runner.setSpeed(3);
    expect(runner.paused).toBe(false);
    expect(runner.speed).toBe(1);
    runner.advance(0);
    lockstep.available = 3;
    expect(runner.advance(16).ticks).toBe(3);
  });

  it("reporte le retard du lockstep dans le `frame`", () => {
    const lockstep = new FakeLockstep();
    const runner = new SimRunner({ lockstep });
    runner.setSim(new FakeSim());
    lockstep.lag = 12;
    const out = runner.advance(0);
    expect(out.frame?.lag).toBe(12);
  });
});
