/**
 * Échelle du jour imposée par le serveur (`docs/protocol.md` §3.2) : le chemin
 * `start.dayScale` → `createSim(seed, w, h, biome, dayScale)`, tel que
 * `sim.worker.ts` le câble vers `SimHandle.create`.
 *
 * Le même schéma que `startbiome.test.ts`, et pour la même raison : l'échelle
 * n'est **pas** une consigne à émettre en commande, elle se fixe à la
 * construction du sim. On vérifie donc la fabrique, pas les octets envoyés.
 */

import { describe, expect, it } from "vitest";

import {
  DEFAULT_DAY_SCALE,
  PROTOCOL_VERSION,
  WORLD_DAY_SCALE,
  encodeMessage,
  type ServerMessage,
} from "@rimlike/protocol";
import { Biome } from "@rimlike/world";

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

/** Sim factice qui retient l'échelle de sa construction, comme le ferait `new_scaled`. */
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

interface Lobby {
  transport: FakeTransport;
  client: LockstepClient;
  /** Échelle passée à chaque construction, dans l'ordre. */
  built: (number | undefined)[];
  sim: () => FakeSim | null;
}

/** Un client en lobby dont la fabrique note les échelles demandées. */
function lobby(isHost = true): Lobby {
  const transport = new FakeTransport();
  const built: (number | undefined)[] = [];
  const client = new LockstepClient({
    transport,
    createSim: (_seed, _width, _height, _biome, dayScale) => {
      built.push(dayScale);
      return Promise.resolve(new FakeSim(dayScale));
    },
    restoreSim: () => Promise.resolve(new FakeSim()),
  });
  client.join("tile-1732", isHost ? "alice" : "bob");
  transport.deliver({
    type: "welcome",
    protocol: PROTOCOL_VERSION,
    playerId: isHost ? 1 : 3,
    isHost,
    players: [{ id: 1, name: "alice" }, { id: 3, name: "bob" }],
    state: "lobby",
    tick: 0,
  });
  return { transport, client, built, sim: () => client.sim as FakeSim | null };
}

describe("start.dayScale : le serveur impose le rythme", () => {
  it("construit le sim avec l'échelle du start, à côté du biome", async () => {
    const state = lobby();
    state.transport.deliver({
      type: "start",
      seed: 5,
      width: 16,
      height: 16,
      tick: 0,
      biome: Biome.Desert,
      dayScale: WORLD_DAY_SCALE,
    });
    await waitFor("sim adopté", () => state.sim() !== null);

    expect(state.built).toEqual([WORLD_DAY_SCALE]);
    expect(state.sim()?.builtWith).toBe(WORLD_DAY_SCALE);
    // Aucune commande : l'échelle ne s'impose pas par le lockstep.
    expect(state.transport.sent.map((t) => (JSON.parse(t) as { type: string }).type)).not.toContain("command");
  });

  it("l'invité construit la même échelle que l'hôte", async () => {
    const host = lobby(true);
    const guest = lobby(false);
    for (const state of [host, guest]) {
      state.transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, dayScale: 30 });
      await waitFor("sim adopté", () => state.sim() !== null);
    }
    expect(host.built).toEqual(guest.built);
    expect(host.built).toEqual([30]);
  });

  it("l'échelle reste lisible dans l'état : elle ne se consomme pas", async () => {
    const state = lobby();
    state.transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, dayScale: 12 });
    await waitFor("sim adopté", () => state.sim() !== null);

    expect(state.client.state.dayScale).toBe(12);
    expect(state.client.state.dayScale).toBe(12);
  });

  it("un start sans dayScale vaut l'échelle 1, jamais « je ne sais pas »", async () => {
    const state = lobby();
    // Avant tout `start`, l'état annonce déjà le défaut : contrairement au
    // biome, il n'y a pas de « nul » — un serveur muet joue à l'échelle 1.
    expect(state.client.state.dayScale).toBe(DEFAULT_DAY_SCALE);
    state.transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim adopté", () => state.sim() !== null);

    // `undefined` à la fabrique : c'est le sim qui porte son défaut, comme
    // pour le biome — le client ne le devine pas à sa place.
    expect(state.built).toEqual([undefined]);
    expect(state.client.state.dayScale).toBe(1);
  });
});

describe("snapshot.dayScale : informatif, jamais reconstruit", () => {
  it("mémorise l'échelle d'une réouverture sans la passer à restoreSim", async () => {
    const state = lobby();
    state.transport.deliver({
      type: "snapshot",
      tick: 900,
      data: new Uint8Array([1, 2, 3]),
      frozenTicks: 90_000,
      dayScale: WORLD_DAY_SCALE,
    });
    await waitFor("sim restauré", () => state.sim() !== null);

    expect(state.built).toEqual([]);
    expect(state.client.state.dayScale).toBe(WORLD_DAY_SCALE);
    // Et le temps gelé, lui, reste une consigne à consommer une fois.
    expect(state.client.consumeFrozenTicks()).toBe(90_000);
    expect(state.client.state.dayScale).toBe(WORLD_DAY_SCALE);
  });

  it("un snapshot de rejoignant, sans le champ, ne remet pas l'échelle à 1", async () => {
    // Le `snapshot` relayé par l'hôte en cours de partie (§8) ne porte pas
    // l'échelle : celle du `start` reçu avant reste la bonne.
    const state = lobby();
    state.transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0, dayScale: 30 });
    await waitFor("sim adopté", () => state.sim() !== null);
    state.transport.deliver({ type: "snapshot", tick: 120, data: new Uint8Array([1]) });
    await waitFor("sim restauré", () => state.client.state.tick === 120);

    expect(state.client.state.dayScale).toBe(30);
  });
});
