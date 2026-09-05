/**
 * Marchands en attente à l'ouverture d'une colonie (`docs/protocol.md` §13.5
 * « Colonie fermée : pendingTraders ») : la fonction pure de décision
 * (`worker/startTraders.ts`), puis son câblage avec `LockstepClient` tel que
 * `sim.worker.ts` le fait dans `onSim`, **après** `FastForward` — sans Worker
 * ni WASM, avec un `FakeTransport` et des encodeurs factices, même schéma que
 * `fastforward-reopen.test.ts`/`startclimate.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { MAX_PENDING_TRADERS, encodeMessage, type ServerMessage } from "@rimlike/protocol";

import { LockstepClient } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";
import { fastForwardOnReopen } from "../src/worker/fastForward";
import { setCalendarOnStart } from "../src/worker/startCalendar";
import { setClimateOnStart } from "../src/worker/startClimate";
import { setDifficultyOnStart } from "../src/worker/startDifficulty";
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
/** Une seule forme d'octets : le sim ne distingue pas un marchand d'un autre. */
const fakeEncodeTrader = (): Uint8Array => new Uint8Array([0xe1]);

describe("pendingTraderCommands (fonction pure)", () => {
  it("émet une commande par marchand en attente, pour l'hôte", () => {
    expect(pendingTraderCommands(2, true, fakeEncodeTrader)).toEqual([fakeEncodeTrader(), fakeEncodeTrader()]);
    expect(pendingTraderCommands(1, true, fakeEncodeTrader)).toEqual([fakeEncodeTrader()]);
  });

  it("n'émet rien sans marchand en attente", () => {
    expect(pendingTraderCommands(0, true, fakeEncodeTrader)).toEqual([]);
    expect(pendingTraderCommands(undefined, true, fakeEncodeTrader)).toEqual([]);
  });

  it("n'émet rien pour un non-hôte, quel que soit le compte", () => {
    expect(pendingTraderCommands(3, false, fakeEncodeTrader)).toEqual([]);
    expect(pendingTraderCommands(undefined, false, fakeEncodeTrader)).toEqual([]);
  });

  it("borne à MAX_PENDING_TRADERS, même avec une valeur aberrante", () => {
    expect(pendingTraderCommands(MAX_PENDING_TRADERS + 50, true, fakeEncodeTrader)).toHaveLength(MAX_PENDING_TRADERS);
    // Défense en profondeur : le codec du protocole ne devrait jamais laisser
    // passer un nombre négatif, mais la fonction ne doit pas s'y effondrer.
    expect(pendingTraderCommands(-4, true, fakeEncodeTrader)).toEqual([]);
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
 * difficulté, avance rapide, puis marchands en attente, chacun consommé et
 * décidé une seule fois par sim adopté, dans cet ordre fixe.
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

describe("câblage à la fondation (comme sim.worker.ts) : start.pendingTraders", () => {
  it("hôte : une commande par marchand en attente, après le reste", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: -340, amplitude: 200 },
      dayOfYear: 45,
      pendingTraders: 2,
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([
      fakeEncodeClimate(-340, 200),
      fakeEncodeCalendar(45),
      fakeEncodeTrader(),
      fakeEncodeTrader(),
    ]);
    const sentTypes = transport.sent.map((t) => (JSON.parse(t) as { type: string }).type);
    expect(sentTypes.filter((t) => t === "command")).toHaveLength(4);
    expect(client.state.pendingTraders).toBe(0);
  });

  it("non-hôte : aucune émission, les commandes viendront dans un bundle", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(false);
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: -340, amplitude: 200 },
      dayOfYear: 45,
      pendingTraders: 2,
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("salle hors monde : un start sans pendingTraders n'émet rien de plus", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });
});

describe("câblage à la réouverture (comme sim.worker.ts) : snapshot.pendingTraders, après FastForward", () => {
  it("hôte : l'avance rapide part d'abord, puis une commande par marchand en attente", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), frozenTicks: 3000, pendingTraders: 3 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    // L'avance rapide en tête, les marchands ensuite (§13.5) : une visite se
    // joue dans le présent de la colonie, pas dans le temps rattrapé.
    expect(issued).toEqual([
      fakeEncodeFastForward(3000),
      fakeEncodeTrader(),
      fakeEncodeTrader(),
      fakeEncodeTrader(),
    ]);
    expect(client.state.frozenTicks).toBe(0);
    expect(client.state.pendingTraders).toBe(0);
  });

  it("hôte : sans marchand en attente, seule l'avance rapide part", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), frozenTicks: 1500 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([fakeEncodeFastForward(1500)]);
  });

  it("non-hôte : aucune émission, même avec des marchands en attente", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(false);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), frozenTicks: 3000, pendingTraders: 3 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("à la valeur maximale (MAX_PENDING_TRADERS), toutes les commandes partent", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), pendingTraders: MAX_PENDING_TRADERS });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toHaveLength(MAX_PENDING_TRADERS);
  });
});
