/**
 * Le fil, réduit à quatre fonctions. `LockstepClient` ne connaît que cette
 * interface : il ne sait pas s'il parle à un `WebSocket` du navigateur, au
 * paquet `ws` sous Node (tests, voir `WsTransport.ts`) ou à rien du tout.
 *
 * Les trames sont du texte : le protocole v1 est du JSON (voir
 * `docs/protocol.md` §2). Le passage au binaire ne changera que le codec.
 */
export interface Transport {
  send(text: string): void;
  onMessage(cb: (text: string) => void): void;
  onClose(cb: () => void): void;
  close(): void;
}

/**
 * Implémentation navigateur. Les trames envoyées avant l'ouverture de la
 * socket sont gardées puis émises dans l'ordre : le client peut appeler
 * `join` tout de suite après la construction.
 */
export class WebSocketTransport implements Transport {
  private readonly socket: WebSocket;
  private readonly backlog: string[] = [];
  private message: ((text: string) => void) | null = null;
  private closed: (() => void) | null = null;

  constructor(url: string) {
    this.socket = new WebSocket(url);
    this.socket.addEventListener("open", () => {
      for (const text of this.backlog.splice(0)) {
        this.socket.send(text);
      }
    });
    this.socket.addEventListener("message", (event: MessageEvent<unknown>) => {
      if (typeof event.data === "string") {
        this.message?.(event.data);
      }
    });
    // Une erreur de WebSocket est toujours suivie d'un `close` : un seul chemin.
    this.socket.addEventListener("close", () => this.closed?.());
  }

  send(text: string): void {
    if (this.socket.readyState === WebSocket.OPEN) {
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
