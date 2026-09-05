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
  private closed: ((code?: number, reason?: string) => void) | null = null;

  /**
   * Construction synchrone, comme `WebSocketTransport` : les trames envoyées
   * avant l'ouverture attendent dans `backlog`, vidé dès l'événement `open`.
   * De quoi servir de fabrique à `ReconnectingTransport` (`() => Transport`,
   * forcément synchrone) ; `connect` reste la façon la plus simple d'attendre
   * la connexion dans un test qui n'a pas besoin de reconnexion.
   */
  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.on("open", () => {
      for (const text of this.backlog.splice(0)) {
        this.socket.send(text);
      }
    });
    this.socket.on("message", (data: unknown) => this.message?.(String(data)));
    this.socket.on("close", (code: number, reason: Buffer) => this.closed?.(code, reason.toString()));
    this.socket.on("error", (err: Error) => this.closed?.(1006, err.message));
  }

  /** Résout quand la socket est ouverte : les tests n'ont pas à attendre. */
  static async connect(url: string): Promise<WsTransport> {
    const transport = new WsTransport(url);
    await new Promise<void>((resolve, reject) => {
      transport.socket.once("open", resolve);
      transport.socket.once("error", reject);
    });
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

  onClose(cb: (code?: number, reason?: string) => void): void {
    this.closed = cb;
  }

  close(): void {
    this.backlog.length = 0;
    this.socket.close();
  }

  /**
   * Coupe la connexion sans négociation, sans passer par `close()` : simule
   * une vraie coupure réseau (câble arraché, processus tué) pour éprouver la
   * reconnexion (`reconnect.test.ts`, `lockstep.test.ts`) plutôt qu'une
   * fermeture volontaire, qui n'en déclenche aucune.
   */
  simulateDrop(): void {
    this.socket.terminate();
  }
}
