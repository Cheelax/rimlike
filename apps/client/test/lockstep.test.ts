/**
 * Le lockstep du client, éprouvé contre le **vrai** serveur relais
 * (`apps/server`) sur un port éphémère et de vrais WebSockets.
 *
 * Le sim est remplacé par un `FakeSim` déterministe : ce qui est vérifié ici
 * est la couche réseau, pas le gameplay. Un `FakeSim` retient la suite exacte
 * des `(tick, commande)` qu'on lui a appliquées et en dérive son hash : deux
 * clients convergents ont donc la même suite et le même hash, et un client
 * saboté est repéré par le serveur.
 *
 * Horloge : les salles tournent à `tickRate` 600 (un bundle toutes les 5 ms au
 * lieu de 50) pour atteindre le tick 300 — période d'envoi des hashes — en une
 * demi-seconde. Rien d'autre ne change : le client est piloté par les messages,
 * pas par une horloge.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { encodeMessage, type ServerMessage } from "@rimlike/protocol";

import { startServer, type RunningServer } from "../../server/src/server.js";
import { LockstepClient, type LockstepError, type LockstepState } from "../src/net/LockstepClient";
import type { SimLike } from "../src/net/SimLike";
import type { Transport } from "../src/net/Transport";
import { WsTransport } from "../src/net/WsTransport";

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);

const hex = (data: Uint8Array): string => Array.from(data, (b) => b.toString(16).padStart(2, "0")).join("");

/** FNV-1a 32 bits, en hexadécimal : un hash d'état à peu de frais. */
function fnv1a(text: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(16).padStart(8, "0");
}

interface FakeState {
  seed: number;
  tick: number;
  /** `tick:octets` par commande appliquée, dans l'ordre. */
  applied: string[];
}

/**
 * Sim déterministe et sans WASM : son état est la suite des commandes
 * appliquées et le tick courant. `salt` sert à fabriquer un client saboté,
 * dont le hash diffère à état égal.
 */
class FakeSim implements SimLike {
  private constructor(
    private readonly inner: FakeState,
    private readonly salt: string,
  ) {}

  static fresh(seed: number, salt = ""): FakeSim {
    return new FakeSim({ seed, tick: 0, applied: [] }, salt);
  }

  static fromSnapshot(data: Uint8Array, salt = ""): FakeSim {
    return new FakeSim(JSON.parse(new TextDecoder().decode(data)) as FakeState, salt);
  }

  tick(): number {
    return this.inner.tick;
  }

  step(n: number): void {
    this.inner.tick += n;
  }

  applyEncoded(data: Uint8Array): void {
    this.inner.applied.push(`${this.inner.tick}:${hex(data)}`);
  }

  hash(): string {
    return fnv1a(`${this.salt}|${this.inner.seed}|${this.inner.tick}|${this.inner.applied.join(",")}`);
  }

  snapshot(): Uint8Array {
    return new TextEncoder().encode(JSON.stringify(this.inner));
  }

  /** Suite des `(tick, commande)` appliqués : la comparaison qui compte. */
  trace(): readonly string[] {
    return this.inner.applied;
  }
}

/** Un client, son transport et ce que ses callbacks ont vu. */
interface Session {
  readonly name: string;
  readonly client: LockstepClient;
  readonly states: LockstepState[];
  readonly errors: LockstepError[];
  fake(): FakeSim;
}

let server: RunningServer;
const sessions: Session[] = [];

async function join(room: string, name: string, salt = ""): Promise<Session> {
  const transport = await WsTransport.connect(server.url);
  const states: LockstepState[] = [];
  const errors: LockstepError[] = [];
  const client = new LockstepClient({
    transport,
    createSim: (seed) => Promise.resolve(FakeSim.fresh(seed, salt)),
    restoreSim: (data) => Promise.resolve(FakeSim.fromSnapshot(data, salt)),
    onState: (state) => states.push(state),
    onError: (error) => errors.push(error),
  });
  const session: Session = {
    name,
    client,
    states,
    errors,
    fake: () => {
      const sim = client.sim;
      if (sim === null) {
        throw new Error(`${name} n'a pas de sim`);
      }
      return sim as FakeSim;
    },
  };
  sessions.push(session);
  client.join(room, name);
  return session;
}

/** Attend une condition, sans faire avancer les sims. */
async function waitFor(label: string, done: () => boolean, timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!done()) {
    if (Date.now() > deadline) {
      throw new Error(`délai dépassé en attendant : ${label}`);
    }
    await sleep(2);
  }
}

/**
 * Fait tourner les clients jusqu'à ce que `done` soit vrai, en pompant comme
 * le ferait la boucle de rendu (au plus 64 ticks par passage).
 */
async function pumpUntil(list: readonly Session[], label: string, done: () => boolean, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    for (const session of list) {
      session.client.pump(64);
    }
    if (done()) {
      return;
    }
    if (Date.now() > deadline) {
      throw new Error(`délai dépassé en attendant : ${label} (ticks ${list.map((s) => s.client.tick).join(", ")})`);
    }
    await sleep(2);
  }
}

const reachedTick = (list: readonly Session[], target: number) => (): boolean =>
  list.every((s) => s.client.tick >= target);

beforeEach(async () => {
  // Horloge accélérée : 3 ticks toutes les 5 ms au lieu de toutes les 50 ms.
  server = await startServer({ port: 0, log: () => {}, roomOptions: { tickRate: 600 } });
});

afterEach(async () => {
  for (const session of sessions) {
    session.client.close();
  }
  sessions.length = 0;
  await server.close();
});

describe("lockstep contre le vrai serveur", () => {
  it("garde deux clients au même état et à la même suite de commandes", async () => {
    const alice = await join("demo", "alice");
    await waitFor("alice en lobby", () => alice.client.state.phase === "lobby");
    expect(alice.client.state.isHost).toBe(true);

    const bob = await join("demo", "bob");
    await waitFor("deux joueurs annoncés", () => alice.client.state.players.length === 2);
    expect(bob.client.state.isHost).toBe(false);

    alice.client.startGame(4242, 32, 32);
    await waitFor("les deux sims créés", () => alice.client.sim !== null && bob.client.sim !== null);
    expect(alice.client.state.seed).toBe(4242);

    // Une commande n'est pas appliquée au clic : elle repasse par le serveur.
    alice.client.issue(bytes(0xa1));
    expect(alice.fake().trace()).toEqual([]);

    const both = [alice, bob] as const;
    await pumpUntil(both, "la commande d'alice revient", () => alice.fake().trace().length === 1);
    expect(bob.fake().trace().length).toBe(1);

    // Puis chacun joue, à des moments différents.
    bob.client.issue(bytes(0xb1));
    await pumpUntil(both, "tick 15 atteint", reachedTick(both, 15));
    bob.client.issue(bytes(0xb2));
    alice.client.issue(bytes(0xa2));

    await pumpUntil(
      both,
      "quatre commandes appliquées de part et d'autre",
      () => alice.fake().trace().length === 4 && bob.fake().trace().length === 4,
    );
    await pumpUntil(both, "tick 60 atteint", reachedTick(both, 60));

    expect(alice.fake().trace()).toEqual(bob.fake().trace());
    expect(alice.client.tick).toBe(bob.client.tick);
    expect(alice.fake().hash()).toBe(bob.fake().hash());
    expect(alice.errors).toEqual([]);
    expect(bob.errors).toEqual([]);
  });

  it("rattrape un joueur qui rejoint en cours par le snapshot du host", async () => {
    const alice = await join("demo", "alice");
    await waitFor("alice en lobby", () => alice.client.state.phase === "lobby");
    const bob = await join("demo", "bob");
    await waitFor("deux joueurs annoncés", () => alice.client.state.players.length === 2);

    alice.client.startGame(7, 32, 32);
    await waitFor("les deux sims créés", () => alice.client.sim !== null && bob.client.sim !== null);

    alice.client.issue(bytes(0xa1));
    const pair = [alice, bob] as const;
    await pumpUntil(pair, "tick 30 atteint", reachedTick(pair, 30));

    // Carol arrive : le host répond tout seul à `request_snapshot`.
    const carol = await join("demo", "carol");
    await pumpUntil(
      [alice, bob, carol],
      "carol restaurée depuis le snapshot",
      () => carol.client.sim !== null && carol.client.tick > 0,
    );
    expect(carol.client.state.phase).toBe("running");
    // Le rejeu part de l'état du host : la suite des commandes est déjà là.
    expect(carol.fake().trace()).toEqual(alice.fake().trace());

    bob.client.issue(bytes(0xb1));
    const all = [alice, bob, carol] as const;
    await pumpUntil(
      all,
      "la commande de bob vue par les trois",
      () => all.every((s) => s.fake().trace().length === 2),
    );
    const target = Math.max(...all.map((s) => s.client.tick)) + 15;
    await pumpUntil(all, `tick ${target} atteint`, reachedTick(all, target));

    expect(carol.fake().trace()).toEqual(alice.fake().trace());
    expect(carol.fake().hash()).toBe(alice.fake().hash());
    expect(bob.fake().hash()).toBe(alice.fake().hash());
    for (const session of all) {
      expect(session.errors).toEqual([]);
    }
  });

  it("fait remonter une désync à tout le monde quand un client dérive", async () => {
    const alice = await join("demo", "alice");
    await waitFor("alice en lobby", () => alice.client.state.phase === "lobby");
    // Même état, hash différent : exactement ce que le serveur doit voir.
    const bob = await join("demo", "bob", "saboté");
    await waitFor("deux joueurs annoncés", () => alice.client.state.players.length === 2);

    alice.client.startGame(1, 32, 32);
    await waitFor("les deux sims créés", () => alice.client.sim !== null && bob.client.sim !== null);

    const both = [alice, bob] as const;
    // Les hashes partent au premier multiple de HASH_EVERY_TICKS (300).
    await pumpUntil(both, "tick 300 atteint", reachedTick(both, 300), 10000);
    await pumpUntil(
      both,
      "désync signalée aux deux",
      () => alice.client.state.desync !== null && bob.client.state.desync !== null,
    );

    const desync = alice.client.state.desync!;
    expect(desync.tick).toBe(300);
    expect(Object.keys(desync.hashes).length).toBe(2);
    expect(new Set(Object.values(desync.hashes)).size).toBe(2);
    expect(server.room("demo")?.state).toBe("desynced");
    // L'état des deux reste identique : seul le hash annoncé diffère.
    expect(bob.fake().trace()).toEqual(alice.fake().trace());
  });
});

/** Transport de laboratoire : on injecte les trames serveur à la main. */
class FakeTransport implements Transport {
  readonly sent: string[] = [];
  private message: ((text: string) => void) | null = null;
  private closed: (() => void) | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }

  onClose(cb: () => void): void {
    this.closed = cb;
  }

  close(): void {
    this.closed?.();
  }

  deliver(message: ServerMessage): void {
    this.message?.(encodeMessage(message));
  }
}

describe("file de bundles", () => {
  async function ready(): Promise<{ transport: FakeTransport; client: LockstepClient; errors: LockstepError[] }> {
    const transport = new FakeTransport();
    const errors: LockstepError[] = [];
    const client = new LockstepClient({
      transport,
      createSim: (seed) => Promise.resolve(FakeSim.fresh(seed)),
      restoreSim: (data) => Promise.resolve(FakeSim.fromSnapshot(data)),
      onError: (error) => errors.push(error),
    });
    client.join("demo", "alice");
    transport.deliver({
      type: "welcome",
      protocol: 1,
      playerId: 1,
      isHost: true,
      players: [{ id: 1, name: "alice" }],
      state: "lobby",
      tick: 0,
    });
    transport.deliver({ type: "start", seed: 5, width: 16, height: 16, tick: 0 });
    await waitFor("sim créé", () => client.sim !== null);
    return { transport, client, errors };
  }

  it("signale un trou au lieu de sauter des ticks", async () => {
    const { transport, client, errors } = await ready();
    transport.deliver({ type: "bundle", from: 0, to: 2, ticks: [] });
    transport.deliver({ type: "bundle", from: 6, to: 8, ticks: [] });

    expect(errors.map((e) => e.code)).toEqual(["history_gap"]);
    // On exécute ce qu'on a, et on s'arrête net au bord du trou.
    expect(client.pump(64)).toBe(3);
    expect(client.tick).toBe(3);
    expect(errors.length).toBe(2);
    // La boucle de rendu repasse ici à chaque frame : pas de déluge de toasts.
    client.pump(64);
    client.pump(64);
    expect(errors.length).toBe(2);
  });

  it("borne le rattrapage par appel et garde le reste en file", async () => {
    const { transport, client } = await ready();
    transport.deliver({ type: "bundle", from: 0, to: 2, ticks: [] });
    transport.deliver({ type: "bundle", from: 3, to: 5, ticks: [] });

    expect(client.pump(2)).toBe(2);
    expect(client.tick).toBe(2);
    expect(client.lag).toBe(4);
    expect(client.pump(64)).toBe(4);
    expect(client.tick).toBe(6);
    expect(client.lag).toBe(0);
    expect(client.pump(64)).toBe(0);
  });

  it("applique les commandes d'un tick dans l'ordre du bundle", async () => {
    const { transport, client } = await ready();
    transport.deliver({
      type: "bundle",
      from: 0,
      to: 2,
      ticks: [
        {
          tick: 1,
          commands: [
            { player: 2, payload: bytes(0x22) },
            { player: 1, payload: bytes(0x11) },
          ],
        },
      ],
    });
    client.pump(64);
    expect((client.sim as FakeSim).trace()).toEqual(["1:22", "1:11"]);
  });

  it("ignore les ticks déjà appliqués d'un bundle rejoué", async () => {
    const { transport, client, errors } = await ready();
    const snapshot = FakeSim.fresh(5);
    snapshot.step(4);
    transport.deliver({ type: "snapshot", tick: 4, data: snapshot.snapshot() });
    await waitFor("sim restauré", () => client.tick === 4);

    transport.deliver({
      type: "bundle",
      from: 3,
      to: 5,
      ticks: [
        { tick: 3, commands: [{ player: 1, payload: bytes(0x33) }] },
        { tick: 5, commands: [{ player: 1, payload: bytes(0x55) }] },
      ],
    });
    expect(client.pump(64)).toBe(2);
    expect(client.tick).toBe(6);
    expect((client.sim as FakeSim).trace()).toEqual(["5:55"]);
    // Un bundle de rejeu commence avant notre tick : ce n'est pas un trou.
    expect(errors).toEqual([]);
  });

  it("stocke frozenTicks reçu par un snapshot, consommé une seule fois", async () => {
    const { transport, client } = await ready();
    const snapshot = FakeSim.fresh(5);
    snapshot.step(4);
    transport.deliver({ type: "snapshot", tick: 4, data: snapshot.snapshot(), frozenTicks: 3000 });
    await waitFor("sim restauré", () => client.tick === 4);

    expect(client.state.frozenTicks).toBe(3000);
    // Idempotence : le deuxième appel ne renvoie plus la valeur.
    expect(client.consumeFrozenTicks()).toBe(3000);
    expect(client.consumeFrozenTicks()).toBe(0);
    expect(client.state.frozenTicks).toBe(0);
  });

  it("sans le champ frozenTicks, l'état reste à 0", async () => {
    const { transport, client } = await ready();
    const snapshot = FakeSim.fresh(5);
    snapshot.step(4);
    transport.deliver({ type: "snapshot", tick: 4, data: snapshot.snapshot() });
    await waitFor("sim restauré", () => client.tick === 4);

    expect(client.state.frozenTicks).toBe(0);
    expect(client.consumeFrozenTicks()).toBe(0);
  });

  it("répond à une demande de snapshot avec son tick courant", async () => {
    const { transport, client } = await ready();
    transport.deliver({ type: "bundle", from: 0, to: 2, ticks: [] });
    client.pump(64);
    transport.sent.length = 0;
    transport.deliver({ type: "request_snapshot", forPlayer: 3 });

    const sent = JSON.parse(transport.sent[0]!) as { type: string; tick: number; forPlayer: number };
    expect(sent.type).toBe("snapshot");
    expect(sent.tick).toBe(3);
    expect(sent.forPlayer).toBe(3);
  });

  it("répond au ping du serveur", async () => {
    const { transport, client } = await ready();
    transport.sent.length = 0;
    transport.deliver({ type: "ping" });
    expect(transport.sent.map((t) => JSON.parse(t) as { type: string })).toEqual([{ type: "pong" }]);
    expect(client.state.phase).toBe("running");
  });

  it("garde l'état exposé en lecture seule", async () => {
    const { client } = await ready();
    const state = client.state;
    expect(Object.isFrozen(state)).toBe(true);
    expect(Object.isFrozen(state.players)).toBe(true);
  });
});
