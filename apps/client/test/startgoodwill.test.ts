/**
 * Réputation partagée à l'ouverture d'une colonie (`docs/protocol.md` §14
 * « Réputation partagée ») : la fonction pure de décision
 * (`worker/startGoodwill.ts`), puis son câblage avec `LockstepClient` tel que
 * `sim.worker.ts` le fait dans `onSim`, **après** `FastForward` et **avant**
 * les marchands en attente — sans Worker ni WASM, avec un `FakeTransport` et
 * des encodeurs factices, même schéma que `starttraders.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { encodeMessage, type GoodwillValues, type ServerMessage } from "@rimlike/protocol";

import { LockstepClient } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";
import { fastForwardOnReopen } from "../src/worker/fastForward";
import { setCalendarOnStart } from "../src/worker/startCalendar";
import { setClimateOnStart } from "../src/worker/startClimate";
import { setDifficultyOnStart } from "../src/worker/startDifficulty";
import { goodwillCommands } from "../src/worker/startGoodwill";
import { pendingTraderCommands } from "../src/worker/startTraders";

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

/** Encodeurs factices : des octets reconnaissables, pas de WASM. */
const fakeEncodeClimate = (base: number, amplitude: number): Uint8Array =>
  new Uint8Array([0xc1, (base + 5000) & 0xff, ((base + 5000) >> 8) & 0xff, amplitude & 0xff]);
const fakeEncodeCalendar = (dayOfYear: number): Uint8Array => new Uint8Array([0xc2, dayOfYear & 0xff]);
const fakeEncodeDifficulty = (level: number): Uint8Array => new Uint8Array([0xd1, level]);
const fakeEncodeFastForward = (ticks: number): Uint8Array => new Uint8Array([0xff, ticks & 0xff, (ticks >> 8) & 0xff]);
const fakeEncodeGoodwill = (a: number, b: number, c: number): Uint8Array =>
  new Uint8Array([0xc3, a & 0xff, b & 0xff, c & 0xff]);
const fakeEncodeTrader = (): Uint8Array => new Uint8Array([0xe1]);

describe("goodwillCommands (fonction pure)", () => {
  it("émet une commande pour l'hôte quand la colonie porte une réputation", () => {
    expect(goodwillCommands([-45, 12, 55], true, fakeEncodeGoodwill)).toEqual([fakeEncodeGoodwill(-45, 12, 55)]);
  });

  it("n'émet rien pour un non-hôte, même avec une réputation", () => {
    expect(goodwillCommands([-45, 12, 55], false, fakeEncodeGoodwill)).toEqual([]);
  });

  it("n'émet rien sans réputation (salle hors monde) : undefined ou null", () => {
    expect(goodwillCommands(undefined, true, fakeEncodeGoodwill)).toEqual([]);
    expect(goodwillCommands(null, true, fakeEncodeGoodwill)).toEqual([]);
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
    return 4;
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
 * Reproduit le câblage complet de `sim.worker.ts` : climat, calendrier,
 * difficulté, avance rapide, **réputation**, puis marchands en attente,
 * chacun consommé et décidé une seule fois par sim adopté, dans cet ordre
 * fixe (`docs/protocol.md` §14.1).
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
      const climate = client.consumeStartClimate();
      const climateBytes = setClimateOnStart(client.state.isHost, climate, fakeEncodeClimate);
      if (climateBytes) {
        issued.push(climateBytes);
        client.issue(climateBytes);
      }
      const dayOfYear = client.consumeStartDayOfYear();
      const calendarBytes = setCalendarOnStart(client.state.isHost, dayOfYear, fakeEncodeCalendar);
      if (calendarBytes) {
        issued.push(calendarBytes);
        client.issue(calendarBytes);
      }
      const difficulty = client.consumeStartDifficulty();
      const difficultyBytes = setDifficultyOnStart(client.state.isHost, difficulty, fakeEncodeDifficulty);
      if (difficultyBytes) {
        issued.push(difficultyBytes);
        client.issue(difficultyBytes);
      }
      const frozen = client.consumeFrozenTicks();
      const fastForwardBytes = fastForwardOnReopen(client.state.isHost, frozen, fakeEncodeFastForward);
      if (fastForwardBytes) {
        issued.push(fastForwardBytes);
        client.issue(fastForwardBytes);
      }
      const goodwill = client.consumeGoodwill();
      for (const goodwillBytes of goodwillCommands(goodwill, client.state.isHost, fakeEncodeGoodwill)) {
        issued.push(goodwillBytes);
        client.issue(goodwillBytes);
      }
      const pendingTraders = client.consumePendingTraders();
      for (const traderBytes of pendingTraderCommands(pendingTraders, client.state.isHost, fakeEncodeTrader)) {
        issued.push(traderBytes);
        client.issue(traderBytes);
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

describe("câblage à la fondation (comme sim.worker.ts) : start.goodwill", () => {
  it("hôte : climat, calendrier puis réputation, avant les marchands en attente", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    const goodwill: GoodwillValues = [-45, 12, 55];
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: -340, amplitude: 200 },
      dayOfYear: 45,
      goodwill,
      pendingTraders: 1,
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([
      fakeEncodeClimate(-340, 200),
      fakeEncodeCalendar(45),
      fakeEncodeGoodwill(-45, 12, 55),
      fakeEncodeTrader(),
    ]);
    const sentTypes = transport.sent.map((t) => (JSON.parse(t) as { type: string }).type);
    expect(sentTypes.filter((t) => t === "command")).toHaveLength(4);
    expect(client.state.goodwill).toBeNull();
  });

  it("non-hôte : aucune émission, la commande viendra dans un bundle", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(false);
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: -340, amplitude: 200 },
      dayOfYear: 45,
      goodwill: [-45, 12, 55],
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("salle hors monde : un start sans goodwill n'émet rien de plus", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });
});

describe("câblage à la réouverture (comme sim.worker.ts) : snapshot.goodwill, après FastForward et avant les marchands", () => {
  it("hôte : avance rapide, puis réputation, puis marchands en attente", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({
      type: "snapshot",
      tick: 4,
      data: new Uint8Array(),
      frozenTicks: 3000,
      goodwill: [10, -30, 70],
      pendingTraders: 2,
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([
      fakeEncodeFastForward(3000),
      fakeEncodeGoodwill(10, -30, 70),
      fakeEncodeTrader(),
      fakeEncodeTrader(),
    ]);
    expect(client.state.frozenTicks).toBe(0);
    expect(client.state.goodwill).toBeNull();
    expect(client.state.pendingTraders).toBe(0);
  });

  it("non-hôte : aucune émission, même avec une réputation à imposer", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(false);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), frozenTicks: 3000, goodwill: [10, -30, 70] });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });
});

describe("LockstepClient : start.goodwill / snapshot.goodwill", () => {
  function plainClient(): { transport: FakeTransport; client: LockstepClient } {
    const transport = new FakeTransport();
    const client = new LockstepClient({
      transport,
      createSim: () => Promise.resolve(new FakeSim()),
      restoreSim: () => Promise.resolve(new FakeSim()),
    });
    client.join("tile-9", "alice");
    transport.deliver({
      type: "welcome",
      protocol: 2,
      playerId: 1,
      isHost: true,
      players: [{ id: 1, name: "alice" }],
      state: "lobby",
      tick: 0,
    });
    return { transport, client };
  }

  it("mémorise la réputation du start et ne la rend qu'une fois", () => {
    const { transport, client } = plainClient();
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, goodwill: [-45, 12, 55] });
    expect(client.state.goodwill).toEqual([-45, 12, 55]);
    expect(client.consumeGoodwill()).toEqual([-45, 12, 55]);
    expect(client.consumeGoodwill()).toBeNull();
    expect(client.state.goodwill).toBeNull();
  });

  it("sans goodwill dans le start, l'état reste nul", () => {
    const { transport, client } = plainClient();
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    expect(client.state.goodwill).toBeNull();
    expect(client.consumeGoodwill()).toBeNull();
  });

  it("mémorise la réputation du snapshot et ne la rend qu'une fois", () => {
    const { transport, client } = plainClient();
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), goodwill: [10, -30, 70] });
    expect(client.state.goodwill).toEqual([10, -30, 70]);
    expect(client.consumeGoodwill()).toEqual([10, -30, 70]);
    expect(client.consumeGoodwill()).toBeNull();
  });
});
