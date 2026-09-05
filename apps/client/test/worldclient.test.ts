/**
 * `WorldClient` piloté par un transport factice.
 *
 * Comme `LockstepClient`, la connexion monde est une logique pure : tout ce
 * qui entre passe par `Transport.onMessage`, tout ce qui sort par
 * `Transport.send`. Un faux transport suffit donc à éprouver le protocole du
 * monde (`docs/protocol.md` §11) sans serveur, sans WebSocket et sans DOM.
 *
 * L'identité (jeton + clé, `net/identity.ts`) passe par `localStorage` : on
 * pose un faux `Storage` sur `globalThis` avant chaque test (l'environnement
 * de test est Node, sans DOM), ce que `identity.ts` lit par défaut.
 */

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  PROTOCOL_VERSION,
  decodeClientMessage,
  encodeMessage,
  type Caravan,
  type CaravanArriveMessage,
  type ClientMessage,
  type Merchant,
  type ServerMessage,
  type Settlement,
  type WorldInfo,
  type WorldPlayerInfo,
} from "@rimlike/protocol";

import { loadIdentity, saveIdentity, identityScope } from "../src/net/identity";
import type { Transport } from "../src/net/Transport";
import { WorldClient, type WorldClientState, type WorldError } from "../src/net/WorldClient";

/**
 * Un `Storage` en mémoire, posé sur `globalThis.localStorage` pour la durée
 * d'un test. Pas de `implements Storage` : l'interface DOM porte un index de
 * signature (`[name: string]: any`) qu'une classe ordinaire ne satisfait pas ;
 * la forme suffit, castée au moment de l'assigner à `globalThis`.
 */
class FakeStorage {
  private readonly map = new Map<string, string>();

  get length(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }

  getItem(key: string): string | null {
    return this.map.has(key) ? this.map.get(key)! : null;
  }

  key(index: number): string | null {
    return [...this.map.keys()][index] ?? null;
  }

  removeItem(key: string): void {
    this.map.delete(key);
  }

  setItem(key: string, value: string): void {
    this.map.set(key, value);
  }
}

let fakeStorage: FakeStorage;

beforeEach(() => {
  fakeStorage = new FakeStorage();
  (globalThis as { localStorage?: Storage }).localStorage = fakeStorage as unknown as Storage;
});

afterEach(() => {
  delete (globalThis as { localStorage?: Storage }).localStorage;
});

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

/** Le serveur de test : sert aussi de clé de stockage à l'identité. */
const SERVER_URL = "ws://localhost:9999";

const GLOBE: WorldInfo = { seed: 1, subdivisions: 4, tiles: 2562 };

const ALICE_KEY = "alice-key";
const BOB_KEY = "bob-key";

const ALICE: Settlement = {
  tile: 1732,
  owner: ALICE_KEY,
  ownerName: "alice",
  room: "tile-1732",
  seed: 2007225770,
  createdAt: 1757000000000,
};

const PLAYERS: WorldPlayerInfo[] = [
  { key: ALICE_KEY, name: "alice", online: true },
  { key: BOB_KEY, name: "bob", online: true },
];

const CONVOY: Caravan = {
  id: "c7",
  owner: ALICE_KEY,
  ownerName: "alice",
  fromTile: 1732,
  toTile: 1810,
  route: [1732, 1745, 1799, 1810],
  departedAt: 412.5,
  arrivesAt: 436.5,
  progress: 0.25,
  currentTile: 1732,
  summary: {
    pawns: 3,
    items: [
      [0, 40],
      [4, 12],
    ],
  },
  status: "travelling",
};

const MERCHANT: Merchant = {
  id: "m1",
  name: "Compagnie du Levant",
  tile: 1745,
  toTile: 1810,
  status: "travelling",
  progress: 0.25,
};

interface Harness {
  transport: FakeTransport;
  client: WorldClient;
  states: WorldClientState[];
  errors: WorldError[];
  settled: { tile: number; room: string; seed: number }[];
  arrivals: CaravanArriveMessage[];
}

function harness(expected: WorldInfo = GLOBE): Harness {
  const transport = new FakeTransport();
  const states: WorldClientState[] = [];
  const errors: WorldError[] = [];
  const settled: { tile: number; room: string; seed: number }[] = [];
  const arrivals: CaravanArriveMessage[] = [];
  const client = new WorldClient({
    transport,
    name: "bob",
    serverUrl: SERVER_URL,
    expected,
    onState: (state) => states.push(state),
    onSettled: (message) => settled.push({ tile: message.tile, room: message.room, seed: message.seed }),
    onCaravanArrive: (message) => arrivals.push(message),
    onError: (error) => errors.push(error),
  });
  return { transport, client, states, errors, settled, arrivals };
}

/** Entre dans le monde et laisse le harnais prêt à jouer les actions. */
function joined(): Harness {
  const h = harness();
  h.client.join();
  h.transport.deliver({
    type: "world_welcome",
    playerId: 2,
    playerKey: BOB_KEY,
    name: "bob",
    settlements: [ALICE],
    players: PLAYERS,
    world: GLOBE,
  });
  return h;
}

describe("WorldClient", () => {
  it("envoie `world_join` avec son nom et la version du protocole, sans jeton la première fois", () => {
    const { transport, client } = harness();
    expect(client.state.phase).toBe("connecting");

    client.join();

    expect(transport.messages()).toEqual([{ type: "world_join", name: "bob", protocol: PROTOCOL_VERSION }]);
    expect(client.state.phase).toBe("connecting");
  });

  it("envoie `world_join` avec le jeton stocké pour ce serveur, s'il y en a un", () => {
    saveIdentity(identityScope(SERVER_URL, "bob"), { token: "s3cr3t-token", playerKey: BOB_KEY });
    const { transport, client } = harness();

    client.join();

    expect(transport.messages()).toEqual([
      { type: "world_join", name: "bob", protocol: PROTOCOL_VERSION, token: "s3cr3t-token" },
    ]);
  });

  it("passe à `connected` sur `world_welcome`, avec notre clé, les colonies et les joueurs", () => {
    const { client } = joined();
    const state = client.state;

    expect(state.phase).toBe("connected");
    expect(state.playerId).toBe(2);
    expect(state.playerKey).toBe(BOB_KEY);
    expect(state.name).toBe("bob");
    expect(state.settlements).toEqual([ALICE]);
    expect(state.players).toEqual(PLAYERS);
    expect(state.world).toEqual(GLOBE);
    expect(state.lastError).toBeNull();
    expect(client.settlementAt(1732)).toEqual(ALICE);
    expect(client.settlementAt(7)).toBeUndefined();
  });

  it("mémorise le jeton reçu à la création d'un nouveau joueur, et le range dans le stockage", () => {
    const { transport, client } = harness();
    client.join();

    transport.deliver({
      type: "world_welcome",
      playerId: 3,
      playerKey: "carol-key",
      name: "bob",
      token: "brand-new-token",
      settlements: [],
      players: [{ key: "carol-key", name: "bob", online: true }],
      world: GLOBE,
    });

    expect(client.state.token).toBe("brand-new-token");
    expect(client.state.playerKey).toBe("carol-key");
    // Rangé pour ce serveur : une prochaine connexion (donc un nouveau
    // `WorldClient`) le relira via `join()`.
    expect(loadIdentity(identityScope(SERVER_URL, "bob"))).toEqual({ token: "brand-new-token", playerKey: "carol-key" });
    // Jamais affiché en clair : seule la longueur transparaît.
    expect(client.identitySummary).toEqual({ playerKey: "carol-key", tokenLength: "brand-new-token".length });
  });

  it("ne range rien de nouveau à la reconnexion d'un joueur déjà connu (pas de `token` dans `world_welcome`)", () => {
    saveIdentity(identityScope(SERVER_URL, "bob"), { token: "old-token", playerKey: ALICE_KEY });
    const { client } = harness();
    client.join();

    expect(loadIdentity(identityScope(SERVER_URL, "bob"))).toEqual({ token: "old-token", playerKey: ALICE_KEY });
  });

  it("`bad_token` : oublie le jeton stocké, prévient et refait un `world_join` sans jeton, une seule fois", () => {
    saveIdentity(identityScope(SERVER_URL, "bob"), { token: "stale-token", playerKey: ALICE_KEY });
    const { transport, client, errors } = harness();
    client.join();
    expect(transport.messages().at(-1)).toEqual({
      type: "world_join",
      name: "bob",
      protocol: PROTOCOL_VERSION,
      token: "stale-token",
    });

    transport.deliver({ type: "world_error", code: "bad_token", message: "jeton de joueur inconnu" });

    // Le jeton périmé a disparu du stockage : un nouveau `WorldClient` sur ce
    // serveur ne le reproposera pas.
    expect(loadIdentity(identityScope(SERVER_URL, "bob"))).toBeNull();
    expect(client.identitySummary).toBeNull();
    // Prévenu par un message clair, pas le texte brut du serveur.
    expect(errors.at(-1)).toEqual({
      code: "bad_token",
      message: "Identité inconnue de ce serveur : nouvelle identité créée",
    });
    // Un second `world_join` est bien reparti, sans jeton cette fois.
    expect(transport.messages().at(-1)).toEqual({ type: "world_join", name: "bob", protocol: PROTOCOL_VERSION });
    expect(transport.messages()).toHaveLength(2);

    // Un second refus (improbable : le second `world_join` n'a pas de jeton à
    // refuser) ne redéclenche pas de troisième tentative : pas de boucle.
    transport.deliver({ type: "world_error", code: "bad_token", message: "jeton de joueur inconnu" });
    expect(transport.messages()).toHaveLength(2);
  });

  it("remplace la liste entière à chaque `world_settlements`", () => {
    const { transport, client } = joined();
    const carol: Settlement = { tile: 40, owner: "carol-key", ownerName: "carol", room: "tile-40", seed: 9, createdAt: 2 };

    transport.deliver({ type: "world_settlements", settlements: [carol] });

    // Liste complète, pas de delta (docs/protocol.md §11.5) : l'ancienne s'en va.
    expect(client.state.settlements).toEqual([carol]);
    expect(client.settlementAt(1732)).toBeUndefined();

    transport.deliver({ type: "world_settlements", settlements: [] });
    expect(client.state.settlements).toEqual([]);
  });

  it("met à jour les joueurs présents sur `world_players`, avec leur présence", () => {
    const { transport, client } = joined();

    transport.deliver({
      type: "world_players",
      players: [{ key: BOB_KEY, name: "bob", online: true }, { key: ALICE_KEY, name: "alice", online: false }],
    });

    expect(client.state.players).toEqual([
      { key: BOB_KEY, name: "bob", online: true },
      { key: ALICE_KEY, name: "alice", online: false },
    ]);
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

  it("remplace la liste entière à chaque `world_caravans`", () => {
    const { transport, client } = joined();
    expect(client.state.caravans).toEqual([]);

    transport.deliver({ type: "world_caravans", caravans: [CONVOY] });

    expect(client.state.caravans).toEqual([CONVOY]);
    expect(client.caravanById("c7")).toEqual(CONVOY);
    expect(client.caravanById("c9")).toBeUndefined();

    // Liste complète comme `world_settlements` : pas de delta (§12.4).
    transport.deliver({ type: "world_caravans", caravans: [] });
    expect(client.state.caravans).toEqual([]);
  });

  it("garde les marchands à jour et remplace la liste entière à chaque world_caravans", () => {
    const { transport, client } = joined();
    expect(client.state.merchants).toEqual([]);

    transport.deliver({ type: "world_caravans", caravans: [], merchants: [MERCHANT] });

    expect(client.state.merchants).toEqual([MERCHANT]);
    expect(client.merchantById("m1")).toEqual(MERCHANT);
    expect(client.merchantById("m9")).toBeUndefined();

    // Liste complète, comme les caravanes des joueurs (§13.4) : pas de delta.
    transport.deliver({ type: "world_caravans", caravans: [], merchants: [] });
    expect(client.state.merchants).toEqual([]);
  });

  it("un world_caravans sans le champ merchants (ancien serveur) laisse la liste inchangée", () => {
    const { transport, client } = joined();

    transport.deliver({ type: "world_caravans", caravans: [], merchants: [MERCHANT] });
    expect(client.state.merchants).toEqual([MERCHANT]);

    // Un serveur qui ne connaît pas les marchands n'envoie pas le champ : on
    // reste compatible en gardant la dernière liste connue plutôt que de la
    // vider (§13.4).
    transport.deliver({ type: "world_caravans", caravans: [] });
    expect(client.state.merchants).toEqual([MERCHANT]);
  });

  it("garde les caravanes à jour même hors de l'écran Monde", () => {
    const { transport, client, states } = joined();

    transport.deliver({ type: "world_caravans", caravans: [{ ...CONVOY, progress: 0.75, currentTile: 1799 }] });

    // La connexion monde survit à l'entrée dans une colonie : c'est ce qui
    // rend le retour au globe immédiat et à jour.
    expect(states.at(-1)?.caravans[0].currentTile).toBe(1799);
    expect(client.state.caravans[0].progress).toBe(0.75);
  });

  it("envoie `caravan_depart` avec son manifeste et son résumé", () => {
    const { transport, client } = joined();

    client.sendDepart({
      fromTile: 1732,
      toTile: 1810,
      manifest: new Uint8Array([5, 0, 0, 0, 3]),
      summary: { pawns: 3, items: [[0, 40]] },
    });

    // Le manifeste voyage en base64 sur le fil : c'est le codec qui le dit,
    // pas une comparaison de texte.
    const sent = transport.sent.at(-1) ?? "";
    expect(JSON.parse(sent).manifest).toBe("BQAAAAM=");
    expect(transport.messages().at(-1)).toEqual({
      type: "caravan_depart",
      fromTile: 1732,
      toTile: 1810,
      manifest: new Uint8Array([5, 0, 0, 0, 3]),
      summary: { pawns: 3, items: [[0, 40]] },
    });
  });

  it("déclenche le rappel d'arrivée, puis émet `caravan_delivered`", () => {
    const { transport, client, arrivals } = joined();

    transport.deliver({
      type: "caravan_arrive",
      id: "c7",
      tile: 1810,
      manifest: new Uint8Array([5, 0, 0, 0, 3]),
      summary: { pawns: 3, items: [[0, 40]] },
    });

    expect(arrivals).toHaveLength(1);
    expect(arrivals[0].id).toBe("c7");
    expect(arrivals[0].tile).toBe(1810);
    expect(arrivals[0].manifest).toEqual(new Uint8Array([5, 0, 0, 0, 3]));

    // La confirmation part **après** que l'appelant a émis sa commande : tant
    // qu'elle manque, le serveur réémet l'arrivée (§12.5).
    client.deliverCaravan("c7");
    expect(transport.messages().at(-1)).toEqual({ type: "caravan_delivered", id: "c7" });
  });

  it("envoie `caravan_cancel` tel quel", () => {
    const { transport, client } = joined();

    client.cancelCaravan("c7");

    expect(transport.messages().at(-1)).toEqual({ type: "caravan_cancel", id: "c7" });
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
      playerKey: BOB_KEY,
      name: "bob",
      settlements: [],
      players: [{ key: BOB_KEY, name: "bob", online: true }],
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
      playerKey: BOB_KEY,
      name: "bob",
      settlements: [],
      players: [{ key: BOB_KEY, name: "bob", online: true }],
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

  it("expose une identité stockée absente comme `null`, sans stockage disponible", () => {
    delete (globalThis as { localStorage?: Storage }).localStorage;
    const { transport, client } = harness();

    // Le prochain accès lève dans certains environnements : `join()` doit
    // rester silencieux (mode sans mémoire) plutôt que de faire planter le client.
    expect(() => client.join()).not.toThrow();
    expect(transport.messages()).toEqual([{ type: "world_join", name: "bob", protocol: PROTOCOL_VERSION }]);
    expect(client.identitySummary).toBeNull();
  });

  describe("reconnexion (docs/protocol.md §11.2, §11.3)", () => {
    it("reconnect() rejoue world_join avec le même jeton", () => {
      saveIdentity(identityScope(SERVER_URL, "bob"), { token: "s3cr3t-token", playerKey: BOB_KEY });
      const { transport, client } = harness();
      client.join();
      transport.deliver({ type: "world_welcome", playerId: 2, playerKey: BOB_KEY, name: "bob", settlements: [], players: PLAYERS, world: GLOBE });
      transport.sent.length = 0;

      client.reconnect();

      expect(client.state.phase).toBe("connecting");
      expect(client.state.reconnecting).toBe(true);
      expect(client.state.attempts).toBe(1);
      expect(transport.messages()).toEqual([
        { type: "world_join", name: "bob", protocol: PROTOCOL_VERSION, token: "s3cr3t-token" },
      ]);
    });

    it("un world_welcome après reconnect() remet reconnecting et attempts à zéro et rafraîchit l'état", () => {
      const { transport, client } = joined();
      client.reconnect();
      client.reconnect();
      expect(client.state.attempts).toBe(2);

      transport.deliver({
        type: "world_welcome",
        playerId: 2,
        playerKey: BOB_KEY,
        name: "bob",
        settlements: [ALICE],
        players: PLAYERS,
        world: GLOBE,
      });

      expect(client.state.phase).toBe("connected");
      expect(client.state.reconnecting).toBe(false);
      expect(client.state.attempts).toBe(0);
      expect(client.state.settlements).toEqual([ALICE]);
    });
  });
});
