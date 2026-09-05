/**
 * Avance rapide à la réouverture d'une colonie gelée (`docs/protocol.md`
 * §11.6) : la fonction pure de décision (`worker/fastForward.ts`), puis son
 * câblage avec `LockstepClient` tel que `sim.worker.ts` le fait dans `onSim` —
 * reproduit ici sans Worker ni WASM, avec un `FakeTransport` et un encodeur
 * factice, pour rester dans les tests Node purs de ce paquet.
 */

import { describe, expect, it } from "vitest";

import { encodeMessage, type ServerMessage } from "@rimlike/protocol";

import { LockstepClient } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";
import { fastForwardOnReopen } from "../src/worker/fastForward";

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

/** Encodeur factice : pas de WASM dans ces tests, juste des octets reconnaissables. */
const fakeEncode = (ticks: number): Uint8Array => new Uint8Array([0xff, ticks & 0xff, (ticks >> 8) & 0xff]);

describe("fastForwardOnReopen (fonction pure)", () => {
  it("émet l'avance rapide pour l'hôte avec du temps gelé", () => {
    expect(fastForwardOnReopen(true, 3000, fakeEncode)).toEqual(fakeEncode(3000));
  });

  it("n'émet rien pour un non-hôte, même avec du temps gelé", () => {
    expect(fastForwardOnReopen(false, 3000, fakeEncode)).toBeNull();
  });

  it("n'émet rien sans temps gelé", () => {
    expect(fastForwardOnReopen(true, 0, fakeEncode)).toBeNull();
  });
});

/** Transport de laboratoire : on injecte les trames serveur à la main. */
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

/** Sim minimal : seul le lockstep compte ici, pas le gameplay. */
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
 * Reproduit le câblage de `sim.worker.ts` : dès qu'un sim est adopté après un
 * `snapshot`, on consomme `frozenTicks` et on décide, une fois, si l'avance
 * rapide part par `issue`.
 */
function readyAsHost(isHost: boolean): {
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
      const frozen = client.consumeFrozenTicks();
      const bytes = fastForwardOnReopen(client.state.isHost, frozen, fakeEncode);
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
    protocol: 1,
    playerId: 1,
    isHost,
    players: [{ id: 1, name: isHost ? "alice" : "bob" }],
    state: "running",
    tick: 4,
    seed: 5,
    width: 16,
    height: 16,
  });
  return { transport, client, issued, onSimCalls: () => calls };
}

describe("câblage à la réouverture (comme sim.worker.ts)", () => {
  it("hôte : exactement une émission égale à encodeFastForward(n)", async () => {
    const { transport, client, issued, onSimCalls } = readyAsHost(true);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), frozenTicks: 3000 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([fakeEncode(3000)]);
    // Bien parti au serveur, comme n'importe quelle commande du joueur.
    const sentTypes = transport.sent.map((t) => (JSON.parse(t) as { type: string }).type);
    expect(sentTypes).toContain("command");
    expect(client.state.frozenTicks).toBe(0);
  });

  it("non-hôte : aucune émission", async () => {
    const { transport, issued, onSimCalls } = readyAsHost(false);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), frozenTicks: 3000 });
    await waitFor("sim adopté", () => onSimCalls() === 1);

    expect(issued).toEqual([]);
  });

  it("un deuxième snapshot sans frozenTicks n'émet rien de plus", async () => {
    const { transport, issued, onSimCalls } = readyAsHost(true);
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array(), frozenTicks: 3000 });
    await waitFor("premier sim adopté", () => onSimCalls() === 1);
    expect(issued.length).toBe(1);

    // Colonie rouverte à nouveau, sans temps gelé cette fois (champ absent).
    transport.deliver({ type: "snapshot", tick: 4, data: new Uint8Array() });
    await waitFor("deuxième sim adopté", () => onSimCalls() === 2);
    expect(issued.length).toBe(1);
  });
});
