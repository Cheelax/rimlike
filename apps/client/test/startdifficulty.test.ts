/**
 * Dose de menace du storyteller, choisie par l'hôte à la fondation d'une
 * partie (`worker/startDifficulty.ts`) : la fonction pure de décision, puis
 * son câblage avec `LockstepClient` tel que `sim.worker.ts` le fait dans
 * `onSim`, juste après le climat — sans Worker ni WASM, même schéma que
 * `startclimate.test.ts`.
 */

import { describe, expect, it } from "vitest";

import { encodeMessage, type ServerMessage } from "@rimlike/protocol";

import { LockstepClient } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";
import { DIFFICULTY } from "../src/render/terrain";
import { setClimateOnStart } from "../src/worker/startClimate";
import { setDifficultyOnStart } from "../src/worker/startDifficulty";

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
const fakeEncodeDifficulty = (level: number): Uint8Array => new Uint8Array([0xd1, level]);
const fakeEncodeClimate = (base: number, amplitude: number): Uint8Array =>
  new Uint8Array([0xc1, (base + 5000) & 0xff, ((base + 5000) >> 8) & 0xff, amplitude & 0xff]);

describe("setDifficultyOnStart (fonction pure)", () => {
  it("émet pour l'hôte quand la difficulté n'est pas Normale", () => {
    expect(setDifficultyOnStart(true, DIFFICULTY.Hard, fakeEncodeDifficulty)).toEqual(
      fakeEncodeDifficulty(DIFFICULTY.Hard),
    );
    expect(setDifficultyOnStart(true, DIFFICULTY.Peaceful, fakeEncodeDifficulty)).toEqual(
      fakeEncodeDifficulty(DIFFICULTY.Peaceful),
    );
  });

  it("n'émet rien pour un non-hôte, quelle que soit la difficulté", () => {
    expect(setDifficultyOnStart(false, DIFFICULTY.Hard, fakeEncodeDifficulty)).toBeNull();
    expect(setDifficultyOnStart(false, null, fakeEncodeDifficulty)).toBeNull();
  });

  it("n'émet rien pour Normal, même choisie explicitement par l'hôte : c'est déjà le défaut du sim", () => {
    expect(setDifficultyOnStart(true, DIFFICULTY.Normal, fakeEncodeDifficulty)).toBeNull();
  });

  it("n'émet rien sans difficulté mémorisée (aucun `startGame` appelé)", () => {
    expect(setDifficultyOnStart(true, null, fakeEncodeDifficulty)).toBeNull();
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
 * Reproduit le câblage de `sim.worker.ts` : dès qu'un sim est adopté, le
 * climat part en premier, puis la difficulté — chacun au plus une fois.
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
      const difficulty = client.consumeStartDifficulty();
      const difficultyBytes = setDifficultyOnStart(client.state.isHost, difficulty, fakeEncodeDifficulty);
      if (difficultyBytes) {
        issued.push(difficultyBytes);
        client.issue(difficultyBytes);
      }
      calls += 1;
    },
  });
  client.join("demo", isHost ? "alice" : "bob");
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
  it("hôte : le climat part, puis la difficulté, dans cet ordre, une seule fois chacun", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    // Choisie dans le lobby, avant même que le serveur n'échoie le `start`.
    client.startGame(5, 16, 16, DIFFICULTY.Hard);
    transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      climate: { baseTemperature: -340, amplitude: 200 },
    });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([fakeEncodeClimate(-340, 200), fakeEncodeDifficulty(DIFFICULTY.Hard)]);
    const sentTypes = transport.sent.map((t) => (JSON.parse(t) as { type: string }).type);
    expect(sentTypes).toContain("command");
  });

  it("hôte : Normal ne part pas, même choisie explicitement dans le lobby", async () => {
    const { transport, client, issued, onSimCalls } = lobbyAs(true);
    client.startGame(5, 16, 16, DIFFICULTY.Normal);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("non-hôte : aucune émission, la difficulté choisie par l'hôte revient dans un bundle", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(false);
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("hôte : réouverture d'une colonie gelée sans `startGame`, rien à émettre", async () => {
    const { transport, issued, onSimCalls } = lobbyAs(true);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array() });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });
});
