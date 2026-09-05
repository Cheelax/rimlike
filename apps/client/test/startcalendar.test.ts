/**
 * Calendrier hérité du monde à la fondation d'une colonie (`docs/protocol.md`
 * §11.6 « Le calendrier, hérité une fois ») : la fonction pure de décision
 * (`worker/startCalendar.ts`), puis son câblage avec `LockstepClient` tel que
 * `sim.worker.ts` le fait dans `onSim` — sans Worker ni WASM, avec un
 * `FakeTransport` et un encodeur factice, même schéma que
 * `startclimate.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { encodeMessage, type ServerMessage } from "@rimlike/protocol";

import { LockstepClient } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";
import { setCalendarOnStart } from "../src/worker/startCalendar";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

async function waitFor(label: string, done: () => boolean, timeoutMs = 2000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`délai dépassé en attendant : ${label}`);
    }
    await sleep(2);
  }
}

/** Encodeur factice : des octets reconnaissables, pas de WASM. */
const fakeEncode = (dayOfYear: number): Uint8Array => new Uint8Array([0xc2, dayOfYear & 0xff, (dayOfYear >> 8) & 0xff]);

describe("setCalendarOnStart (fonction pure)", () => {
  it("émet le jour de l'année pour l'hôte quand le monde en fournit un", () => {
    expect(setCalendarOnStart(true, 45, fakeEncode)).toEqual(fakeEncode(45));
  });

  it("émet aussi le jour 0 : ce n'est pas un défaut à filtrer côté client", () => {
    // Contrairement à la difficulté (`DIFFICULTY.Normal`), le jour 0 est une
    // valeur du monde comme une autre : le sim par défaut y est déjà, mais
    // rien ne distingue ce cas d'un jour hérité explicitement.
    expect(setCalendarOnStart(true, 0, fakeEncode)).toEqual(fakeEncode(0));
  });

  it("n'émet rien pour un non-hôte", () => {
    expect(setCalendarOnStart(false, 12, fakeEncode)).toBeNull();
  });

  it("n'émet rien sans jour de l'année (salle hors monde)", () => {
    expect(setCalendarOnStart(true, null, fakeEncode)).toBeNull();
  });
});

class FakeTransport implements Transport {
  readonly sent: string[] = [];
  private message: ((text: string) => void) | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }

  onClose(): void {
    // Jamais fermé dans ces tests.
  }

  close(): void {
    // Rien à faire.
  }

  deliver(message: ServerMessage): void {
    this.message?.(encodeMessage(message));
  }
}

class FakeSim implements SimLike {
  tick(): number {
    return 0;
  }

  step(): void {
    // Rien à faire.
  }

  applyEncoded(): void {
    // Rien à faire.
  }

  hash(): string {
    return "h";
  }

  snapshot(): Uint8Array {
    return new Uint8Array();
  }
}

/**
 * Reproduit le câblage de `sim.worker.ts` : dès qu'un sim est adopté après un
 * `start`, on consomme le jour de l'année et on décide, une fois, s'il part
 * par `issue`.
 */
function lobbyAs(isHost: boolean): {
  transport: FakeTransport;
  client: LockstepClient;
  issued: Uint8Array[];
  onSimCalls: () => number;
} {
  const transport = new FakeTransport();
  const issued: Uint8Array[] = [];
  let calls = 0;
  const client = new LockstepClient({
    transport,
    createSim: () => Promise.resolve(new FakeSim()),
    restoreSim: () => Promise.resolve(new FakeSim()),
    onSim: () => {
      const dayOfYear = client.consumeStartDayOfYear();
      const bytes = setCalendarOnStart(client.state.isHost, dayOfYear, fakeEncode);
      if (bytes) {
        issued.push(bytes);
        client.issue(bytes);
      }
      calls += 1;
    },
  });
  client.join("tile-1732", isHost ? "alice" : "bob");
  transport.deliver({
    type: "welcome",
    protocol: 2,
    playerId: 1,
    isHost,
    players: [{ id: 1, name: isHost ? "alice" : "bob" }],
    state: "lobby",
    tick: 0,
  });
  return { transport, client, issued, onSimCalls: () => calls };
}

describe("câblage à la fondation (comme sim.worker.ts)", () => {
  it("hôte : exactement une émission égale à encodeSetCalendar(dayOfYear)", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, dayOfYear: 45 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([fakeEncode(45)]);
    const sentTypes = transport.sent.map((t) => (JSON.parse(t) as { type: string }).type);
    expect(sentTypes).toContain("command");
    expect(client.state.dayOfYear).toBeNull();
  });

  it("non-hôte : aucune émission, la commande viendra dans un bundle", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(false);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, dayOfYear: 12 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("salle hors monde : un start sans dayOfYear n'émet rien", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });
});
