/**
 * Biome hérité de la case à la fondation d'une colonie (`docs/protocol.md`
 * §3.2, §11.6) : le chemin `start.biome` → `createSim(seed, w, h, biome)`, tel
 * que `sim.worker.ts` le câble vers `SimHandle.create`.
 *
 * Sans Worker ni WASM : un `FakeTransport` et une fabrique de sim injectée qui
 * note ce qu'on lui a demandé — même schéma que `startclimate.test.ts`, à une
 * différence près, qui est tout le sujet : le biome n'est **pas** une consigne
 * à émettre en commande, il se fixe à la construction du sim. On vérifie donc
 * la fabrique, pas les octets envoyés.
 */

import { describe, expect, it } from "vitest";

import { DEFAULT_BIOME, encodeMessage, type ServerMessage } from "@rimlike/protocol";
import { Biome, BIOME_NAMES } from "@rimlike/world";

import { LockstepClient } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";

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

/**
 * Sim factice qui retient le biome de sa construction, comme `SimHandle` le
 * passerait à `WasmSim.new_in_biome`. `undefined` = construit par le
 * constructeur ordinaire, donc `DEFAULT_BIOME` côté sim.
 */
class FakeSim implements SimLike {
  constructor(readonly builtWith: number | undefined = undefined) {}

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
 * Un client en lobby dont la fabrique note les biomes demandés, exactement
 * comme `sim.worker.ts` appelle `SimHandle.create({ …, biome })`.
 */
function lobby(): {
  transport: FakeTransport;
  client: LockstepClient;
  /** Biome passé à chaque construction, dans l'ordre. */
  built: (number | undefined)[];
  sim: () => FakeSim | null;
} {
  const transport = new FakeTransport();
  const built: (number | undefined)[] = [];
  const client = new LockstepClient({
    transport,
    createSim: (_seed, _width, _height, biome) => {
      built.push(biome);
      return Promise.resolve(new FakeSim(biome));
    },
    restoreSim: () => Promise.resolve(new FakeSim()),
  });
  client.join("tile-1732", "alice");
  transport.deliver({
    type: "welcome",
    protocol: 2,
    playerId: 1,
    isHost: true,
    players: [{ id: 1, name: "alice" }],
    state: "lobby",
    tick: 0,
  });
  return { transport, client, built, sim: () => client.sim as FakeSim | null };
}

describe("start.biome : la carte hérite de sa case", () => {
  it("construit le sim avec le biome du start", async () => {
    const state = lobby();
    state.transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      biome: Biome.Desert,
    });
    await waitFor("sim adopté", () => state.sim() !== null);

    expect(state.built).toEqual([Biome.Desert]);
    expect(state.sim()?.builtWith).toBe(Biome.Desert);
  });

  it("le biome reste lisible dans l'état : il ne se consomme pas", async () => {
    const state = lobby();
    state.transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, biome: Biome.Tundra });
    await waitFor("sim adopté", () => state.sim() !== null);

    // Contrairement au climat ou à la réputation, rien ne le vide : c'est une
    // propriété de la carte, pas une consigne à n'émettre qu'une fois.
    expect(state.client.state.biome).toBe(Biome.Tundra);
    expect(state.client.state.biome).toBe(Biome.Tundra);
    expect(BIOME_NAMES[Biome.Tundra]).toBe("toundra");
  });

  it("un non-hôte construit le même sim : le biome ne passe pas par une commande", async () => {
    const transport = new FakeTransport();
    const built: (number | undefined)[] = [];
    const client = new LockstepClient({
      transport,
      createSim: (_seed, _width, _height, biome) => {
        built.push(biome);
        return Promise.resolve(new FakeSim(biome));
      },
      restoreSim: () => Promise.resolve(new FakeSim()),
    });
    client.join("tile-1732", "bob");
    transport.deliver({
      type: "welcome",
      protocol: 2,
      playerId: 3,
      isHost: false,
      players: [{ id: 1, name: "alice" }, { id: 3, name: "bob" }],
      state: "lobby",
      tick: 0,
    });
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, biome: Biome.Jungle });
    await waitFor("sim adopté", () => client.sim !== null);

    expect(built).toEqual([Biome.Jungle]);
    // Aucune commande n'est partie : personne n'a à imposer le biome.
    expect(transport.sent.map((t) => (JSON.parse(t) as { type: string }).type)).not.toContain("command");
  });

  it("salle simple : un start sans biome laisse le constructeur ordinaire décider", async () => {
    const state = lobby();
    state.transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => state.sim() !== null);

    // `undefined`, pas `DEFAULT_BIOME` : c'est le sim qui porte son défaut, le
    // client ne le devine pas à sa place.
    expect(state.built).toEqual([undefined]);
    expect(state.client.state.biome).toBeNull();
    // Le défaut du protocole reste la forêt tempérée, pour l'affichage.
    expect(DEFAULT_BIOME).toBe(Biome.TemperateForest);
  });
});

describe("snapshot.biome : informatif, jamais reconstruit", () => {
  it("mémorise le biome d'une réouverture sans le passer à restoreSim", async () => {
    const state = lobby();
    state.transport.deliver({
      type: "snapshot",
      tick: 900,
      data: new Uint8Array([1, 2, 3]),
      frozenTicks: 3000,
      biome: Biome.BorealForest,
    });
    await waitFor("sim restauré", () => state.sim() !== null);

    // Le sim vient du snapshot : la fabrique du sim neuf n'a pas été appelée.
    expect(state.built).toEqual([]);
    expect(state.client.state.biome).toBe(Biome.BorealForest);
    // Et le temps gelé, lui, reste bien une consigne à consommer une fois.
    expect(state.client.consumeFrozenTicks()).toBe(3000);
    expect(state.client.state.biome).toBe(Biome.BorealForest);
  });

  it("un snapshot sans biome (salle simple) laisse l'état nul", async () => {
    const state = lobby();
    state.transport.deliver({ type: "snapshot", tick: 10, data: new Uint8Array([1]) });
    await waitFor("sim restauré", () => state.sim() !== null);

    expect(state.client.state.biome).toBeNull();
  });
});
