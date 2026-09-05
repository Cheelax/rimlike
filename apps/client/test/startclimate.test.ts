/**
 * Climat hérité de la case à la fondation d'une colonie (`docs/protocol.md`
 * §11.6 « Le climat, hérité une fois ») : la fonction pure de décision
 * (`worker/startClimate.ts`), puis son câblage avec `LockstepClient` tel que
 * `sim.worker.ts` le fait dans `onSim` — sans Worker ni WASM, avec un
 * `FakeTransport` et un encodeur factice, comme `fastforward-reopen.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { encodeMessage, type ServerMessage } from "@rimlike/protocol";

import { LockstepClient } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";
import { formatClimate } from "../src/render/terrain";
import { setClimateOnStart } from "../src/worker/startClimate";

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
const fakeEncode = (base: number, amplitude: number): Uint8Array =>
  new Uint8Array([0xc1, (base + 5000) & 0xff, ((base + 5000) >> 8) & 0xff, amplitude & 0xff]);

describe("setClimateOnStart (fonction pure)", () => {
  it("émet le climat pour l'hôte quand la case en fournit un", () => {
    expect(setClimateOnStart(true, { baseTemperature: -340, amplitude: 200 }, fakeEncode)).toEqual(
      fakeEncode(-340, 200),
    );
  });

  it("n'émet rien pour un non-hôte", () => {
    expect(setClimateOnStart(false, { baseTemperature: 120, amplitude: 150 }, fakeEncode)).toBeNull();
  });

  it("n'émet rien sans climat (salle hors monde)", () => {
    expect(setClimateOnStart(true, null, fakeEncode)).toBeNull();
  });
});

describe("formatClimate", () => {
  it("arrondit les dixièmes en degrés entiers", () => {
    expect(formatClimate({ baseTemperature: 123, amplitude: 153 })).toBe("12 °C en moyenne, ± 15 °C");
    expect(formatClimate({ baseTemperature: -340, amplitude: 200 })).toBe("-34 °C en moyenne, ± 20 °C");
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
 * `start`, on consomme le climat et on décide, une fois, s'il part par `issue`.
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
      const bytes = setClimateOnStart(client.state.isHost, climate, fakeEncode);
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
  it("hôte : exactement une émission égale à encodeSetClimate(base, amplitude)", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: -340, amplitude: 200 },
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([fakeEncode(-340, 200)]);
    const sentTypes = transport.sent.map((t) => (JSON.parse(t) as { type: string }).type);
    expect(sentTypes).toContain("command");
    expect(client.state.climate).toBeNull();
  });

  it("non-hôte : aucune émission, la commande viendra dans un bundle", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(false);
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: 120, amplitude: 150 },
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("salle hors monde : un start sans climat n'émet rien", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });
});

describe("LockstepClient : start.climate", () => {
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

  it("mémorise le climat du start et ne le rend qu'une fois", () => {
    const { transport, client } = plainClient();
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: 260, amplitude: 40 },
    });
    expect(client.state.climate).toEqual({ baseTemperature: 260, amplitude: 40 });
    expect(client.consumeStartClimate()).toEqual({ baseTemperature: 260, amplitude: 40 });
    expect(client.consumeStartClimate()).toBeNull();
    expect(client.state.climate).toBeNull();
  });

  it("sans climat dans le start, l'état reste nul", () => {
    const { transport, client } = plainClient();
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    expect(client.state.climate).toBeNull();
    expect(client.consumeStartClimate()).toBeNull();
  });
});
