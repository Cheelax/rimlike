/**
 * Transport sur le paquet `ws`, pour les tests Node de `LockstepClient`.
 *
 * Volontairement dans son propre fichier : rien de l'application ne l'importe,
 * donc `ws` (qui dépend des modules Node) n'entre jamais dans le bundle du
 * navigateur. `Transport.ts` porte l'implémentation navigateur.
 */
import { WebSocket } from "ws";

import type { Transport } from "./Transport";

export class WsTransport implements Transport {
  private readonly socket: WebSocket;
  private readonly backlog: string[] = [];
  private message: ((text: string) => void) | null = null;
  private closed: (() => void) | null = null;

  private constructor(socket: WebSocket) {
    this.socket = socket;
    this.socket.on("message", (data: unknown) => this.message?.(String(data)));
    this.socket.on("close", () => this.closed?.());
    this.socket.on("error", () => this.closed?.());
  }

  /** Résout quand la socket est ouverte : les tests n'ont pas à attendre. */
  static async connect(url: string): Promise<WsTransport> {
    const socket = new WebSocket(url);
    const transport = new WsTransport(socket);
    await new Promise<void>((resolve, reject) => {
      socket.once("open", () => resolve());
      socket.once("error", reject);
    });
    for (const text of transport.backlog.splice(0)) {
      socket.send(text);
    }
    return transport;
  }

  send(text: string): void {
    if (this.socket.readyState === this.socket.OPEN) {
      this.socket.send(text);
    } else {
      this.backlog.push(text);
    }
  }

  onMessage(cb: (text: string) => void): void {
    this.message = cb;
  }

  onClose(cb: () => void): void {
    this.closed = cb;
  }

  close(): void {
    this.backlog.length = 0;
    this.socket.close();
  }
}
