/**
 * Outillage partagé par les tests d'intégration : un client WebSocket qui
 * garde tout ce qu'il reçoit et sait attendre une condition. Ce fichier n'est
 * pas une suite de tests (pas de `.test.ts`), vitest ne le collecte pas.
 */

import { expect } from "vitest";
import { WebSocket } from "ws";

import {
  decodeServerMessage,
  encodeMessage,
  type ClientMessage,
  type ServerMessage,
} from "@rimlike/protocol";

export class TestClient {
  private readonly waiters = new Set<() => void>();
  readonly received: ServerMessage[] = [];
  closed = false;

  private constructor(private readonly socket: WebSocket) {}

  static async connect(url: string): Promise<TestClient> {
    const socket = new WebSocket(url);
    const client = new TestClient(socket);
    socket.on("message", (data: unknown) => {
      const message = decodeServerMessage(String(data));
      if (message === null) {
        throw new Error(`trame serveur invalide : ${String(data)}`);
      }
      client.received.push(message);
      // Le heartbeat applicatif : on répond comme un vrai client.
      if (message.type === "ping") {
        client.send({ type: "pong" });
      }
      client.notify();
    });
    socket.on("close", () => {
      client.closed = true;
      client.notify();
    });
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    return client;
  }

  send(message: ClientMessage): void {
    this.socket.send(encodeMessage(message));
  }

  /** Envoie une trame brute, pour tester la validation du serveur. */
  sendRaw(text: string): void {
    this.socket.send(text);
  }

  ofType<T extends ServerMessage["type"]>(type: T): Array<Extract<ServerMessage, { type: T }>> {
    return this.received.filter((m): m is Extract<ServerMessage, { type: T }> => m.type === type);
  }

  /** Attend qu'une condition sur les messages reçus soit vraie. */
  async waitUntil(label: string, predicate: () => boolean, timeoutMs = 4000): Promise<void> {
    if (predicate()) {
      return;
    }
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters.delete(check);
        reject(new Error(`délai dépassé en attendant : ${label}`));
      }, timeoutMs);
      const check = (): void => {
        if (!predicate()) {
          return;
        }
        clearTimeout(timer);
        this.waiters.delete(check);
        resolve();
      };
      this.waiters.add(check);
    });
  }

  /** Attend le prochain message d'un type donné et le renvoie. */
  async next<T extends ServerMessage["type"]>(type: T): Promise<Extract<ServerMessage, { type: T }>> {
    const seen = this.ofType(type).length;
    await this.waitUntil(`message ${type}`, () => this.ofType(type).length > seen);
    return this.ofType(type)[seen]!;
  }

  /**
   * Le n-ième message d'un type, attendu s'il n'est pas encore là. À préférer
   * à `next` quand plusieurs messages arrivent en rafale : `next` compte à
   * partir de l'instant de l'appel et attendrait alors un message de plus.
   */
  async nth<T extends ServerMessage["type"]>(
    type: T,
    index = 0,
  ): Promise<Extract<ServerMessage, { type: T }>> {
    await this.waitUntil(`message ${type} n°${index + 1}`, () => this.ofType(type).length > index);
    return this.ofType(type)[index]!;
  }

  close(): void {
    this.socket.close();
  }

  private notify(): void {
    for (const check of [...this.waiters]) {
      check();
    }
  }
}

/** Suite plate `[player, premier octet]` des commandes reçues, dans l'ordre. */
export function commandOrder(client: TestClient): Array<[number, number]> {
  return client
    .ofType("bundle")
    .flatMap((b) => b.ticks)
    .flatMap((t) => t.commands.map((c): [number, number] => [c.player, c.payload[0]!]));
}

/** Les bundles doivent se suivre sans trou ni recouvrement. */
export function assertContiguous(client: TestClient): void {
  const bundles = client.ofType("bundle");
  for (let i = 1; i < bundles.length; i += 1) {
    expect(bundles[i]!.from).toBe(bundles[i - 1]!.to + 1);
  }
}

export const bytes = (...values: number[]): Uint8Array => new Uint8Array(values);
