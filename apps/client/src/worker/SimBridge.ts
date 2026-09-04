/**
 * Le Worker de simulation vu du thread principal : une façade typée qui cache
 * `postMessage` et la correspondance requête / réponse du RPC de debug.
 *
 * Le thread principal ne touche jamais au sim. Il envoie des commandes et des
 * réglages, il reçoit des `frame` : c'est toute la relation.
 */

import type { LockstepState } from "../net/LockstepClient";
import type {
  FrameMessage,
  InitMessage,
  MainToWorker,
  MapMessage,
  OverlaysMessage,
  WorkerToMain,
} from "./protocol";

export interface SimBridgeHandlers {
  readonly onMap: (message: MapMessage) => void;
  readonly onOverlays: (message: OverlaysMessage) => void;
  readonly onFrame: (message: FrameMessage) => void;
  readonly onNet: (state: LockstepState) => void;
  readonly onSaved: (bytes: Uint8Array) => void;
  /** `error` non vide si la sauvegarde était illisible : le sim en cours continue. */
  readonly onLoaded: (error?: string) => void;
  readonly onError: (message: string) => void;
}

/** Ce que l'accueil a choisi, tel qu'il part au Worker. */
export type SimSession =
  | { readonly mode: "solo"; readonly seed: number; readonly width: number; readonly height: number }
  | { readonly mode: "multi"; readonly server: string; readonly room: string; readonly name: string };

export class SimBridge {
  private readonly worker: Worker;
  private readonly pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
  private nextId = 1;
  private disposed = false;

  constructor(private readonly handlers: SimBridgeHandlers) {
    // `new URL(..., import.meta.url)` : c'est la forme que Vite reconnaît pour
    // sortir le Worker en entrée séparée du bundle.
    this.worker = new Worker(new URL("./sim.worker.ts", import.meta.url), { type: "module" });
    this.worker.addEventListener("message", (event: MessageEvent<WorkerToMain>) => this.receive(event.data));
    this.worker.addEventListener("error", (event: ErrorEvent) => {
      this.handlers.onError(event.message || "erreur dans le Worker de simulation");
    });
  }

  /** Premier message : le Worker crée le sim (solo) ou se connecte (multi). */
  start(session: SimSession): void {
    const message: InitMessage =
      session.mode === "solo"
        ? { type: "init", mode: "solo", seed: session.seed, width: session.width, height: session.height }
        : { type: "init", mode: "multi", server: session.server, room: session.room, name: session.name };
    this.post(message);
  }

  /**
   * Seul chemin des actions du joueur. `bytes` est transféré : l'appelant ne
   * doit plus s'en servir après (les `encode*` en fabriquent un neuf à chaque
   * fois).
   */
  issue(bytes: Uint8Array): void {
    this.post({ type: "issue", bytes }, [bytes.buffer as ArrayBuffer]);
  }

  setPaused(paused: boolean): void {
    this.post({ type: "setPaused", paused });
  }

  setSpeed(speed: number): void {
    this.post({ type: "setSpeed", speed });
  }

  startGame(seed: number, width: number, height: number): void {
    this.post({ type: "startGame", seed, width, height });
  }

  /** Réclame un snapshot : `localStorage` n'existe pas dans un Worker. */
  save(): void {
    this.post({ type: "save" });
  }

  load(bytes: Uint8Array): void {
    this.post({ type: "load", bytes }, [bytes.buffer as ArrayBuffer]);
  }

  /** Crochet de dev : exécute une méthode du sim (ou `lockstep.*`) dans le Worker. */
  rpc(method: string, ...args: readonly unknown[]): Promise<unknown> {
    if (this.disposed) return Promise.reject(new Error("Worker de simulation fermé"));
    const id = this.nextId++;
    return new Promise<unknown>((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.post({ type: "debug", id, method, args });
    });
  }

  dispose(): void {
    this.disposed = true;
    for (const { reject } of this.pending.values()) reject(new Error("Worker de simulation fermé"));
    this.pending.clear();
    this.worker.terminate();
  }

  private post(message: MainToWorker, transfer?: ArrayBuffer[]): void {
    if (this.disposed) return;
    if (transfer && transfer.length > 0) this.worker.postMessage(message, transfer);
    else this.worker.postMessage(message);
  }

  private receive(message: WorkerToMain): void {
    switch (message.type) {
      case "map":
        this.handlers.onMap(message);
        return;
      case "overlays":
        this.handlers.onOverlays(message);
        return;
      case "frame":
        this.handlers.onFrame(message);
        return;
      case "net":
        this.handlers.onNet(message.state);
        return;
      case "saved":
        this.handlers.onSaved(message.bytes);
        return;
      case "loaded":
        this.handlers.onLoaded(message.error);
        return;
      case "error":
        this.handlers.onError(message.message);
        return;
      case "debugResult": {
        const waiter = this.pending.get(message.id);
        if (!waiter) return;
        this.pending.delete(message.id);
        if (message.error === undefined) waiter.resolve(message.value);
        else waiter.reject(new Error(message.error));
        return;
      }
    }
  }
}
