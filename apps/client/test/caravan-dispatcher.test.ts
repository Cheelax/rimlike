/**
 * L'expéditeur de caravanes, éprouvé sans WASM, sans Worker et sans réseau.
 *
 * `CaravanDispatcher` n'a que cinq points de contact avec le monde extérieur,
 * tous injectés : lire un manifeste dans la file du sim, le résumer,
 * l'envoyer, encoder le vidage, émettre la commande. Un journal d'appels
 * suffit donc à vérifier ce qui compte : l'**ordre** (envoyer puis vider) et la
 * **FIFO des destinations** (le n-ième `FormCaravan` va où le n-ième choix le
 * dit), plus le fait qu'un même manifeste ne parte jamais deux fois.
 *
 * Voir `docs/protocol.md` §12.7.
 */

import { describe, expect, it } from "vitest";
import type { CaravanSummary } from "@rimlike/protocol";

import {
  CaravanDispatcher,
  manifestSummary,
  tileOfRoom,
  type DispatchedDeparture,
} from "../src/net/CaravanDispatcher";

/** Manifeste factice : ses octets suffisent à l'identifier. */
const manifest = (tag: number): Uint8Array => new Uint8Array([9, tag]);

interface Harness {
  readonly dispatcher: CaravanDispatcher;
  /** Journal des appels, dans l'ordre : « depart … » puis « clear n ». */
  readonly calls: string[];
  readonly departs: DispatchedDeparture[];
  /** La file du sim, telle que le faux Worker la rendra. */
  queue: Uint8Array[];
  readonly waiting: number[];
}

function harness(queue: Uint8Array[] = []): Harness {
  const calls: string[] = [];
  const departs: DispatchedDeparture[] = [];
  const waiting: number[] = [];
  const state: { queue: Uint8Array[] } = { queue };
  const dispatcher = new CaravanDispatcher({
    readDeparture: (index) => Promise.resolve(state.queue[index] ?? new Uint8Array(0)),
    describe: (bytes): CaravanSummary => ({ pawns: bytes[1], items: [[0, bytes[1] * 10]] }),
    sendDepart: (departure) => {
      calls.push(`depart ${departure.manifest[1]} → ${departure.toTile}`);
      departs.push(departure);
    },
    issue: (bytes) => calls.push(`issue ${bytes.join(",")}`),
    encodeClear: (count) => new Uint8Array([255, count]),
    onWaiting: (count) => waiting.push(count),
  });
  return {
    dispatcher,
    calls,
    departs,
    waiting,
    get queue() {
      return state.queue;
    },
    set queue(next: Uint8Array[]) {
      state.queue = next;
    },
  };
}

describe("tileOfRoom", () => {
  it("reconnaît une salle de case, et elle seule", () => {
    expect(tileOfRoom("tile-0")).toBe(0);
    expect(tileOfRoom("tile-1732")).toBe(1732);
    expect(tileOfRoom("demo")).toBeNull();
    // Même lecture stricte que le serveur : un identifiant n'a qu'une écriture.
    expect(tileOfRoom("tile-007")).toBeNull();
    expect(tileOfRoom("tile-1.5")).toBeNull();
    expect(tileOfRoom("tile-")).toBeNull();
  });
});

describe("manifestSummary", () => {
  it("relit le tampon de `describe_manifest`", () => {
    expect(manifestSummary(new Int32Array([3, 2, 0, 40, 4, 12]))).toEqual({
      pawns: 3,
      items: [
        [0, 40],
        [4, 12],
      ],
    });
  });

  it("rend une caravane vide pour un manifeste illisible", () => {
    // `describe_manifest` rend un tampon vide quand le postcard ne se relit pas.
    expect(manifestSummary(new Int32Array(0))).toEqual({ pawns: 0, items: [] });
  });
});

describe("CaravanDispatcher", () => {
  it("expédie chaque manifeste puis vide la file, dans cet ordre", async () => {
    const h = harness([manifest(1)]);
    h.dispatcher.planDestination(1810);

    await h.dispatcher.pump(1);

    // L'ordre est le contrat : le manifeste part d'abord, la file ne se vide
    // qu'ensuite — et par une commande, pas par une mutation locale.
    expect(h.calls).toEqual(["depart 1 → 1810", "issue 255,1"]);
    expect(h.departs[0].summary).toEqual({ pawns: 1, items: [[0, 10]] });
  });

  it("apparie les destinations aux manifestes dans l'ordre où elles ont été choisies", async () => {
    const h = harness([manifest(1), manifest(2), manifest(3)]);
    h.dispatcher.planDestination(10);
    h.dispatcher.planDestination(20);
    h.dispatcher.planDestination(30);

    await h.dispatcher.pump(3);

    expect(h.calls).toEqual(["depart 1 → 10", "depart 2 → 20", "depart 3 → 30", "issue 255,3"]);
    expect(h.dispatcher.pendingDestinations).toBe(0);
  });

  it("ne réexpédie rien tant que le vidage n'a pas été appliqué", async () => {
    const h = harness([manifest(1)]);
    h.dispatcher.planDestination(1810);
    await h.dispatcher.pump(1);
    h.calls.length = 0;

    // Le `ClearDepartures` revient dans un bundle : d'ici là, le `frame`
    // annonce toujours un départ en file.
    await h.dispatcher.pump(1);
    await h.dispatcher.pump(1);

    expect(h.calls).toEqual([]);
  });

  it("repart de zéro une fois la file vidée", async () => {
    const h = harness([manifest(1)]);
    h.dispatcher.planDestination(10);
    await h.dispatcher.pump(1);
    h.calls.length = 0;

    // Le vidage a été appliqué chez tout le monde : la file est vide.
    h.queue = [];
    await h.dispatcher.pump(0);
    // Puis une nouvelle caravane se forme.
    h.queue = [manifest(2)];
    h.dispatcher.planDestination(20);
    await h.dispatcher.pump(1);

    expect(h.calls).toEqual(["depart 2 → 20", "issue 255,1"]);
  });

  it("expédie un manifeste apparu pendant qu'un vidage est en vol, sans en émettre un second", async () => {
    const h = harness([manifest(1)]);
    h.dispatcher.planDestination(10);
    await h.dispatcher.pump(1);
    h.calls.length = 0;

    // Deuxième caravane formée avant que le premier vidage ne revienne.
    h.queue = [manifest(1), manifest(2)];
    h.dispatcher.planDestination(20);
    await h.dispatcher.pump(2);

    // Elle part, mais aucun second `ClearDepartures` : deux vidages cumulés
    // retireraient des manifestes jamais expédiés.
    expect(h.calls).toEqual(["depart 2 → 20"]);

    // Le premier vidage arrive : la tête de file change, on peut reprendre.
    h.queue = [manifest(2)];
    h.calls.length = 0;
    await h.dispatcher.pump(1);
    expect(h.calls).toEqual(["issue 255,1"]);
  });

  it("garde un manifeste sans destination dans la file du sim, et le signale", async () => {
    const h = harness([manifest(1)]);

    await h.dispatcher.pump(1);

    // Rien n'est envoyé et rien n'est vidé : les colons sont déjà sortis de la
    // carte, jeter le manifeste les perdrait pour de bon.
    expect(h.calls).toEqual([]);
    expect(h.dispatcher.waiting).toBe(1);
    expect(h.waiting).toEqual([1]);

    // Lui donner une destination suffit à le faire partir.
    h.dispatcher.planDestination(77);
    await h.dispatcher.pump(1);
    expect(h.calls).toEqual(["depart 1 → 77", "issue 255,1"]);
    expect(h.dispatcher.waiting).toBe(0);
  });

  it("ne vide qu'un préfixe expédié : un manifeste en attente bloque les suivants", async () => {
    const h = harness([manifest(1), manifest(2)]);
    h.dispatcher.planDestination(10);

    await h.dispatcher.pump(2);

    expect(h.calls).toEqual(["depart 1 → 10", "issue 255,1"]);
    expect(h.dispatcher.waiting).toBe(1);
  });

  it("prévient l'appelant quand sa caravane est partie", async () => {
    const h = harness([manifest(4)]);
    const seen: DispatchedDeparture[] = [];
    h.dispatcher.planDestination(1810, (departure) => seen.push(departure));

    await h.dispatcher.pump(1);

    expect(seen).toHaveLength(1);
    expect(seen[0].toTile).toBe(1810);
    expect(seen[0].manifest).toEqual(manifest(4));
  });

  it("ne fait rien sans départ, et oublie ce qu'il croyait savoir", async () => {
    const h = harness([]);
    await h.dispatcher.pump(0);
    expect(h.calls).toEqual([]);
    expect(h.dispatcher.waiting).toBe(0);
  });

  it("s'arrête à la fin réelle de la file, plus courte que le `frame`", async () => {
    // Le sim a avancé depuis le `frame` : l'indice 1 rend un tampon vide.
    const h = harness([manifest(1)]);
    h.dispatcher.planDestination(10);
    h.dispatcher.planDestination(20);

    await h.dispatcher.pump(2);

    expect(h.calls).toEqual(["depart 1 → 10", "issue 255,1"]);
    expect(h.dispatcher.pendingDestinations).toBe(1);
  });

  it("oublie les destinations choisies quand on quitte la colonie", () => {
    const h = harness([]);
    h.dispatcher.planDestination(10);
    h.dispatcher.planDestination(20);

    h.dispatcher.forgetDestinations();

    expect(h.dispatcher.pendingDestinations).toBe(0);
  });
});
