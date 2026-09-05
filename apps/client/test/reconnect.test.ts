/**
 * `ReconnectingTransport`, isolé : une fabrique factice et un planificateur
 * injecté (`Scheduler`), aucun vrai délai ni vraie `WebSocket` (voir
 * `net/Transport.ts`). Le vrai serveur intervient plus loin, dans
 * `lockstep.test.ts` (« reconnexion contre le vrai serveur »), pour la partie
 * qu'un transport factice ne peut pas éprouver : que `LockstepClient` reprenne
 * bien au même hash après une coupure.
 */

import { describe, expect, it } from "vitest";

import {
  MAX_RECONNECT_ATTEMPTS,
  RECONNECT_BASE_DELAY_MS,
  RECONNECT_MAX_DELAY_MS,
  ReconnectingTransport,
  type Scheduler,
} from "../src/net/Transport";
import type { Transport } from "../src/net/Transport";

/**
 * Planificateur en mémoire : rien ne s'exécute tant que `advance` ne le
 * demande pas. `nextDelay` lit le délai programmé le plus proche, pour
 * vérifier la croissance exacte sans deviner un instant réel.
 */
class FakeScheduler implements Scheduler {
  private nextId = 1;
  private readonly timers = new Map<number, { at: number; cb: () => void }>();
  private now = 0;

  setTimeout(cb: () => void, ms: number): unknown {
    const id = this.nextId++;
    this.timers.set(id, { at: this.now + ms, cb });
    return id;
  }

  clearTimeout(handle: unknown): void {
    this.timers.delete(handle as number);
  }

  /** Avance l'horloge virtuelle et déclenche, dans l'ordre, tout ce qui devient dû. */
  advance(ms: number): void {
    this.now += ms;
    for (;;) {
      let dueId: number | null = null;
      let dueAt = Infinity;
      for (const [id, timer] of this.timers) {
        if (timer.at <= this.now && timer.at < dueAt) {
          dueId = id;
          dueAt = timer.at;
        }
      }
      if (dueId === null) return;
      const timer = this.timers.get(dueId)!;
      this.timers.delete(dueId);
      timer.cb();
    }
  }

  /** Délai (depuis maintenant) du prochain rappel programmé, `null` si rien n'attend. */
  nextDelay(): number | null {
    let min: number | null = null;
    for (const timer of this.timers.values()) {
      const delay = timer.at - this.now;
      if (min === null || delay < min) min = delay;
    }
    return min;
  }

  get pendingCount(): number {
    return this.timers.size;
  }
}

/** Transport de laboratoire : trames et fermetures déclenchées à la main. */
class FakeTransport implements Transport {
  readonly sent: string[] = [];
  closedByUser = false;
  private message: ((text: string) => void) | null = null;
  private closedCb: ((code?: number, reason?: string) => void) | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }

  onClose(cb: (code?: number, reason?: string) => void): void {
    this.closedCb = cb;
  }

  close(): void {
    this.closedByUser = true;
  }

  /** Simule une trame reçue du serveur. */
  deliver(text: string): void {
    this.message?.(text);
  }

  /** Simule une coupure non demandée (réseau perdu, serveur relancé). */
  drop(code = 1006, reason = "perte réseau"): void {
    this.closedCb?.(code, reason);
  }
}

/** Une fabrique qui garde chaque `FakeTransport` créé, dans l'ordre. */
function fakeFactory(): { factory: () => Transport; created: FakeTransport[] } {
  const created: FakeTransport[] = [];
  return {
    factory: () => {
      const transport = new FakeTransport();
      created.push(transport);
      return transport;
    },
    created,
  };
}

describe("ReconnectingTransport", () => {
  it("rouvre après une fermeture non demandée, une fois le délai écoulé", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    new ReconnectingTransport({ factory, scheduler, random: () => 0.5 });
    expect(created.length).toBe(1);

    created[0]!.drop();
    expect(created.length).toBe(1); // pas encore : le délai n'est pas passé
    scheduler.advance(RECONNECT_BASE_DELAY_MS - 1);
    expect(created.length).toBe(1);
    scheduler.advance(1);
    expect(created.length).toBe(2);
  });

  it("fait croître le délai puis le plafonne à RECONNECT_MAX_DELAY_MS", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    // Gigue nulle (`random` au milieu de son intervalle) : délais exacts.
    new ReconnectingTransport({ factory, scheduler, random: () => 0.5 });

    const delays: number[] = [];
    for (let i = 0; i < 6; i += 1) {
      created[created.length - 1]!.drop();
      delays.push(scheduler.nextDelay()!);
      scheduler.advance(delays[delays.length - 1]!);
    }
    expect(delays).toEqual([1000, 2000, 4000, 8000, RECONNECT_MAX_DELAY_MS, RECONNECT_MAX_DELAY_MS]);
  });

  it("applique une gigue de ±20 % autour du délai de base", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    new ReconnectingTransport({ factory, scheduler, random: () => 1 }); // gigue maximale, +20 %
    created[0]!.drop();
    expect(scheduler.nextDelay()).toBe(Math.round(RECONNECT_BASE_DELAY_MS * 1.2));
  });

  it("close() explicite n'entraîne aucune réouverture", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    const rt = new ReconnectingTransport({ factory, scheduler, random: () => 0.5 });

    rt.close();
    expect(created[0]!.closedByUser).toBe(true);
    // Même si le transport finit par signaler une fermeture après coup (la
    // socket ferme après qu'on l'a demandé) : rien ne se reprogramme.
    created[0]!.drop();
    scheduler.advance(60_000);
    expect(created.length).toBe(1);
    expect(scheduler.pendingCount).toBe(0);
  });

  it("appelle onReconnect dès qu'un transport neuf est créé, pas avant", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    const rt = new ReconnectingTransport({ factory, scheduler, random: () => 0.5 });
    let reconnects = 0;
    rt.onReconnect(() => {
      reconnects += 1;
    });

    created[0]!.drop();
    expect(reconnects).toBe(0); // en attente, pas encore de transport neuf
    scheduler.advance(RECONNECT_BASE_DELAY_MS);
    expect(reconnects).toBe(1);
    expect(created.length).toBe(2);
  });

  it("abandonne après MAX_ATTEMPTS échecs consécutifs", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    const rt = new ReconnectingTransport({ factory, scheduler, random: () => 0.5, maxAttempts: 3 });
    const closedArgs: Array<[number | undefined, string | undefined]> = [];
    rt.onClose((code, reason) => closedArgs.push([code, reason]));

    for (let i = 0; i < 2; i += 1) {
      created[created.length - 1]!.drop(1006, `échec ${i + 1}`);
      scheduler.advance(scheduler.nextDelay()!);
    }
    expect(created.length).toBe(3); // deux tentatives programmées et exécutées
    expect(closedArgs).toEqual([]);

    // Troisième échec consécutif == `maxAttempts` : on abandonne, sans
    // programmer de quatrième tentative.
    created[2]!.drop(1006, "échec 3");
    expect(closedArgs).toEqual([[1006, "échec 3"]]);
    expect(scheduler.pendingCount).toBe(0);
    expect(created.length).toBe(3);
  });

  it("respecte MAX_RECONNECT_ATTEMPTS par défaut", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    const rt = new ReconnectingTransport({ factory, scheduler, random: () => 0.5 });
    let abandoned = false;
    rt.onClose(() => {
      abandoned = true;
    });

    for (let i = 0; i < MAX_RECONNECT_ATTEMPTS - 1; i += 1) {
      created[created.length - 1]!.drop();
      expect(abandoned).toBe(false);
      scheduler.advance(scheduler.nextDelay()!);
    }
    created[created.length - 1]!.drop();
    expect(abandoned).toBe(true);
  });

  it("remet les échecs consécutifs à zéro dès qu'une trame est reçue", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    const rt = new ReconnectingTransport({ factory, scheduler, random: () => 0.5 });

    created[0]!.drop();
    scheduler.advance(RECONNECT_BASE_DELAY_MS);
    expect(rt.attempts).toBe(1);
    created[1]!.deliver("bonjour");
    expect(rt.attempts).toBe(0);

    // Une coupure suivante repart donc du premier délai, pas d'un délai déjà
    // monté par l'échec précédent.
    created[1]!.drop();
    expect(scheduler.nextDelay()).toBe(RECONNECT_BASE_DELAY_MS);
  });

  it("ne renvoie rien pendant l'attente entre deux tentatives", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    const rt = new ReconnectingTransport({ factory, scheduler, random: () => 0.5 });

    created[0]!.drop();
    expect(rt.reconnecting).toBe(true);
    rt.send("perdu");
    expect(created[0]!.sent).toEqual([]);

    scheduler.advance(RECONNECT_BASE_DELAY_MS);
    expect(rt.reconnecting).toBe(false);
    rt.send("reçu");
    expect(created[1]!.sent).toEqual(["reçu"]);
  });

  it("relaie les trames et laisse passer les envois hors coupure", () => {
    const scheduler = new FakeScheduler();
    const { factory, created } = fakeFactory();
    const rt = new ReconnectingTransport({ factory, scheduler });
    const received: string[] = [];
    rt.onMessage((text) => received.push(text));

    rt.send("join");
    expect(created[0]!.sent).toEqual(["join"]);
    created[0]!.deliver("welcome");
    expect(received).toEqual(["welcome"]);
  });
});
