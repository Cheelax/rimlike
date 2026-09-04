/**
 * `WorldClient` piloté par un transport factice.
 *
 * Comme `LockstepClient`, la connexion monde est une logique pure : tout ce
 * qui entre passe par `Transport.onMessage`, tout ce qui sort par
 * `Transport.send`. Un faux transport suffit donc à éprouver le protocole du
 * monde (`docs/protocol.md` §11) sans serveur, sans WebSocket et sans DOM.
 */

import { describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
  type Settlement,
  type WorldInfo,
} from "@rimlike/protocol";

import type { Transport } from "../src/net/Transport";
import { WorldClient, type WorldClientState, type WorldError } from "../src/net/WorldClient";

class FakeTransport implements Transport {
  readonly sent: string[] = [];
  closed = false;
  private message: ((text: string) => void) | null = null;
  private onClosed: (() => void) | null = null;

  send(text: string): void {
    this.sent.push(text);
  }

  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }

  onClose(cb: () => void): void {
    this.onClosed = cb;
  }

  close(): void {
    this.closed = true;
    this.onClosed?.();
  }

  deliver(message: ServerMessage): void {
    this.message?.(encodeMessage(message));
  }

  /** Livre une trame brute, y compris illisible. */
  raw(text: string): void {
    this.message?.(text);
  }

  /** Les messages émis, décodés. Le codec fait foi, pas une comparaison de texte. */
  messages(): ClientMessage[] {
    return this.sent.map((text) => {
      const decoded = decodeClientMessage(text);
      if (decoded === null) throw new Error(`trame client illisible : ${text}`);
      return decoded;
    });
  }
}

const GLOBE: WorldInfo = { seed: 1, subdivisions: 4, tiles: 2562 };

const ALICE: Settlement = {
  tile: 1732,
  owner: "alice",
  room: "tile-1732",
  seed: 2007225770,
  createdAt: 1757000000000,
};

interface Harness {
  transport: FakeTransport;
  client: WorldClient;
  states: WorldClientState[];
  errors: WorldError[];
  settled: { tile: number; room: string; seed: number }[];
}

function harness(expected: WorldInfo = GLOBE): Harness {
  const transport = new FakeTransport();
  const states: WorldClientState[] = [];
  const errors: WorldError[] = [];
  const settled: { tile: number; room: string; seed: number }[] = [];
  const client = new WorldClient({
    transport,
    name: "bob",
    expected,
    onState: (state) => states.push(state),
    onSettled: (message) => settled.push({ tile: message.tile, room: message.room, seed: message.seed }),
    onError: (error) => errors.push(error),
  });
  return { transport, client, states, errors, settled };
}

/** Entre dans le monde et laisse le harnais prêt à jouer les actions. */
function joined(): Harness {
  const h = harness();
  h.client.join();
  h.transport.deliver({
    type: "world_welcome",
    playerId: 2,
    name: "bob",
    settlements: [ALICE],
    players: ["alice", "bob"],
    world: GLOBE,
  });
  return h;
}

describe("WorldClient", () => {
  it("envoie `world_join` avec son nom et la version du protocole", () => {
    const { transport, client } = harness();
    expect(client.state.phase).toBe("connecting");

    client.join();

    expect(transport.messages()).toEqual([{ type: "world_join", name: "bob", protocol: PROTOCOL_VERSION }]);
    expect(client.state.phase).toBe("connecting");
  });

  it("passe à `connected` sur `world_welcome`, avec colonies et joueurs", () => {
    const { client } = joined();
    const state = client.state;

    expect(state.phase).toBe("connected");
    expect(state.playerId).toBe(2);
    expect(state.name).toBe("bob");
    expect(state.settlements).toEqual([ALICE]);
    expect(state.players).toEqual(["alice", "bob"]);
    expect(state.world).toEqual(GLOBE);
    expect(state.lastError).toBeNull();
    expect(client.settlementAt(1732)).toEqual(ALICE);
    expect(client.settlementAt(7)).toBeUndefined();
  });

  it("remplace la liste entière à chaque `world_settlements`", () => {
    const { transport, client } = joined();
    const carol: Settlement = { tile: 40, owner: "carol", room: "tile-40", seed: 9, createdAt: 2 };

    transport.deliver({ type: "world_settlements", settlements: [carol] });

    // Liste complète, pas de delta (docs/protocol.md §11.5) : l'ancienne s'en va.
    expect(client.state.settlements).toEqual([carol]);
    expect(client.settlementAt(1732)).toBeUndefined();

    transport.deliver({ type: "world_settlements", settlements: [] });
    expect(client.state.settlements).toEqual([]);
  });

  it("met à jour les joueurs présents sur `world_players`", () => {
    const { transport, client } = joined();

    transport.deliver({ type: "world_players", players: ["bob"] });

    expect(client.state.players).toEqual(["bob"]);
  });

  it("envoie `settle` et rend la salle et la graine du `settled` reçu", () => {
    const { transport, client, settled } = joined();

    client.settle(40);

    expect(transport.messages().at(-1)).toEqual({ type: "settle", tile: 40 });
    transport.deliver({ type: "settled", tile: 40, room: "tile-40", seed: 123456 });
    expect(settled).toEqual([{ tile: 40, room: "tile-40", seed: 123456 }]);
  });

  it("envoie `visit`, `abandon` et `world_leave` tels quels", () => {
    const { transport, client, settled } = joined();

    client.visit(1732);
    client.abandon(1732);
    client.leave();

    expect(transport.messages().slice(1)).toEqual([
      { type: "visit", tile: 1732 },
      { type: "abandon", tile: 1732 },
      { type: "world_leave" },
    ]);
    // `visit` répond lui aussi `settled` : c'est le même chemin d'entrée en salle.
    transport.deliver({ type: "settled", tile: 1732, room: "tile-1732", seed: 2007225770 });
    expect(settled).toEqual([{ tile: 1732, room: "tile-1732", seed: 2007225770 }]);
  });

  it("remonte un `world_error` sans quitter le monde", () => {
    const { transport, client, errors } = joined();

    transport.deliver({ type: "world_error", code: "occupied", message: "la case 1732 est déjà colonisée" });

    expect(errors).toEqual([{ code: "occupied", message: "la case 1732 est déjà colonisée" }]);
    // Un refus de monde n'est pas une déconnexion (§11.7) : on reste connecté,
    // la liste des colonies est intacte, une autre case reste choisissable.
    expect(client.state.phase).toBe("connected");
    expect(client.state.settlements).toEqual([ALICE]);
    expect(transport.closed).toBe(false);
  });

  it("répond `pong` au `ping` du serveur", () => {
    const { transport, client } = joined();

    transport.deliver({ type: "ping" });

    expect(transport.messages().at(-1)).toEqual({ type: "pong" });
    expect(client.state.phase).toBe("connected");
  });

  it("refuse un globe qui n'est pas celui téléchargé", () => {
    const { transport, client, errors } = harness();
    client.join();

    transport.deliver({
      type: "world_welcome",
      playerId: 1,
      name: "bob",
      settlements: [],
      players: ["bob"],
      world: { seed: 99, subdivisions: 4, tiles: 2562 },
    });

    expect(client.state.phase).not.toBe("connected");
    expect(errors).toHaveLength(1);
    expect(errors[0].code).toBe("world_mismatch");
    expect(errors[0].message).toContain("graine 99");
    // Fatal : chaque case cliquée désignerait autre chose que ce qui est affiché.
    expect(transport.closed).toBe(true);
    expect(client.state.phase).toBe("closed");
  });

  it("détecte aussi une subdivision ou un nombre de cases différents", () => {
    const { transport, client, errors } = harness();
    client.join();

    transport.deliver({
      type: "world_welcome",
      playerId: 1,
      name: "bob",
      settlements: [],
      players: ["bob"],
      world: { seed: 1, subdivisions: 5, tiles: 10242 },
    });

    expect(errors[0].message).toContain("subdivision 5");
    expect(errors[0].message).toContain("10242 cases");
    expect(client.state.phase).toBe("closed");
  });

  it("signale une erreur de salle et une trame illisible sans se taire", () => {
    const { transport, client, errors } = harness();
    client.join();

    transport.deliver({ type: "error", code: "version_mismatch", message: "version incompatible" });
    expect(errors.at(-1)?.code).toBe("version_mismatch");

    // Une trame que le codec rejette ne doit pas passer inaperçue.
    transport.raw("{ pas du json");
    expect(errors.at(-1)?.code).toBe("bad_message");
    expect(client.state.phase).toBe("connecting");
  });

  it("passe à `closed` quand le transport tombe", () => {
    const { transport, client, states } = joined();

    transport.close();

    expect(client.state.phase).toBe("closed");
    expect(states.at(-1)?.phase).toBe("closed");
  });

  it("garde son état figé : le HUD ne peut pas le modifier", () => {
    const { client } = joined();
    const state = client.state;

    expect(Object.isFrozen(state)).toBe(true);
    expect(() => {
      (state as { phase: string }).phase = "closed";
    }).toThrow();
  });
});
