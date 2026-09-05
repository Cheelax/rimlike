/**
 * `GET /rooms` côté client (`docs/protocol.md` §2, « Découverte des salles ») :
 * un `fetch` factice suffit, cette couche ne fait qu'interroger et valider —
 * pas de serveur réel ici (voir `worldflow.test.ts` pour la couche connectée).
 */

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  fetchRooms,
  roomDay,
  roomDisplayName,
  roomsEndpoint,
  roomStateLabel,
  type RoomInfo,
} from "../src/net/roomsFetch";

function jsonResponse(body: unknown, init: { ok?: boolean; status?: number } = {}): Response {
  const ok = init.ok ?? true;
  const status = init.status ?? (ok ? 200 : 500);
  return {
    ok,
    status,
    json: () => Promise.resolve(body),
  } as unknown as Response;
}

const SIMPLE_ROOM: RoomInfo = {
  name: "demo",
  state: "lobby",
  players: 1,
  maxPlayers: 4,
  tick: 0,
  isTile: false,
  createdAt: 1_757_000_000_000,
};

const TILE_ROOM: RoomInfo = {
  name: "tile-1732",
  state: "running",
  players: 2,
  maxPlayers: 4,
  tick: 1806,
  isTile: true,
  tile: 1732,
  ownerName: "alice",
  seed: 2_007_225_770,
  createdAt: 1_757_000_000_000,
};

describe("fetchRooms", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("parse une réponse valide", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ rooms: [SIMPLE_ROOM, TILE_ROOM], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await fetchRooms("ws://localhost:8787");

    expect(result.truncated).toBe(false);
    expect(result.rooms).toEqual([SIMPLE_ROOM, TILE_ROOM]);
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(fetchMock.mock.calls[0][0]).toBe("http://localhost:8787/rooms");
  });

  it("signale une réponse dont `rooms` n'est pas un tableau", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rooms: "pas un tableau", truncated: false })));
    await expect(fetchRooms("ws://localhost:8787")).rejects.toThrow(/rooms/);
  });

  it("signale une entrée de salle malformée (état hors de l'énumération)", async () => {
    const bad = { ...SIMPLE_ROOM, state: "en pause" };
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rooms: [bad], truncated: false })));
    await expect(fetchRooms("ws://localhost:8787")).rejects.toThrow(/rooms/);
  });

  it("signale une réponse sans `truncated`", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({ rooms: [] })));
    await expect(fetchRooms("ws://localhost:8787")).rejects.toThrow(/truncated/);
  });

  it("signale un statut HTTP d'erreur", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(jsonResponse({}, { ok: false, status: 503 })));
    await expect(fetchRooms("ws://localhost:8787")).rejects.toThrow(/503/);
  });

  it("signale une erreur réseau proprement, sans planter", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("fetch failed")));
    await expect(fetchRooms("ws://localhost:8787")).rejects.toThrow(/injoignable/);
  });

  it("encode `state` et `q` dans l'URL", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ rooms: [], truncated: false }));
    vi.stubGlobal("fetch", fetchMock);

    await fetchRooms("ws://localhost:8787", { state: "lobby", q: "alice" });

    const url = fetchMock.mock.calls[0][0] as string;
    expect(url).toBe("http://localhost:8787/rooms?state=lobby&q=alice");
  });

  it("ignore un `q` vide plutôt que de l'encoder", () => {
    expect(roomsEndpoint("ws://localhost:8787", { q: "" })).toBe("http://localhost:8787/rooms");
  });
});

describe("libellé d'une salle", () => {
  it("une salle simple garde son nom tel quel", () => {
    expect(roomDisplayName(SIMPLE_ROOM)).toBe("demo");
  });

  it("une salle « case » se lit « Colonie de ⟨ownerName⟩ · case N »", () => {
    expect(roomDisplayName(TILE_ROOM)).toBe("Colonie de alice · case 1732");
  });

  it("une salle « case » dont la colonie a été abandonnée reste identifiable", () => {
    const { ownerName: _ownerName, ...abandoned } = TILE_ROOM;
    expect(roomDisplayName(abandoned)).toBe("Colonie abandonnée · case 1732");
  });

  it("les trois états ont un libellé distinct", () => {
    expect(roomStateLabel("lobby")).toBe("en attente");
    expect(roomStateLabel("running")).toBe("en cours");
    expect(roomStateLabel("desynced")).toBe("désynchronisée");
  });

  it("le tick se convertit en jour de jeu (jour 1 au tick 0)", () => {
    expect(roomDay(0)).toBe(1);
    expect(roomDay(14_400)).toBe(2);
    expect(roomDay(1806)).toBe(1);
  });
});
