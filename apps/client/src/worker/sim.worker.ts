/**
 * Le Worker de simulation : il possède le WASM, le sim, et en multi le
 * `LockstepClient` avec sa WebSocket. Le thread principal ne fait plus que
 * rendre et écouter les entrées.
 *
 * Ce fichier ne contient aucune règle de cadence : elle est dans `SimRunner`,
 * testable sans navigateur. Ici on ne fait que du câblage — un `setInterval`,
 * la création des sims, le transport, et `postMessage`.
 *
 * Pourquoi : `requestAnimationFrame` ne tourne pas dans un onglet masqué. Les
 * timers d'un Worker dédié, si. En solo le temps ne se fige plus, en multi le
 * client ne décroche plus du lockstep (docs/PLAN.md §7, risque « onglet en
 * arrière-plan »).
 */

import { LockstepClient } from "../net/LockstepClient";
import { WebSocketTransport } from "../net/Transport";
import { SimHandle } from "../sim/SimHandle";
import { SimRunner, type RunnerOutput, type RunnerSim } from "./SimRunner";
import { transferablesOf, type MainToWorker, type WorkerToMain } from "./protocol";

/** Période du battement du Worker. Le pas de temps reste calculé sur l'horloge réelle. */
const INTERVAL_MS = 16;

/**
 * Le minimum de la portée globale d'un Worker dédié. Le `lib` du projet est
 * celui du DOM (`self` y est une `Window`) : plutôt que d'y ajouter
 * « WebWorker » et ses conflits, on décrit ici ce qu'on utilise.
 */
interface WorkerScope {
  postMessage(message: WorkerToMain, transfer?: ArrayBuffer[]): void;
  addEventListener(type: "message", listener: (event: MessageEvent<MainToWorker>) => void): void;
}
const ctx = self as unknown as WorkerScope;

function post(message: WorkerToMain): void {
  const transfer = transferablesOf(message);
  if (transfer.length > 0) ctx.postMessage(message, transfer);
  else ctx.postMessage(message);
}

function fail(e: unknown): void {
  post({ type: "error", message: e instanceof Error ? (e.stack ?? e.message) : String(e) });
}

/**
 * Méthodes et propriétés de `SimHandle` joignables par le crochet de debug.
 * Liste explicite : le RPC ne doit pas pouvoir atteindre `dispose` ni les
 * champs internes (la mémoire WASM entière ne se clone pas).
 */
const SIM_API: ReadonlySet<string> = new Set([
  "width",
  "height",
  "step",
  "applyEncoded",
  "pendingLen",
  "moveTo",
  "designate",
  "setZone",
  "build",
  "cancelBuild",
  "attack",
  "setPriority",
  "triggerRaid",
  "tick",
  "ticksPerDay",
  "timeOfDay",
  "weather",
  "hash",
  "mapVersion",
  "overlayVersion",
  "storedTotals",
  "snapshot",
  "tiles",
  "features",
  "zones",
  "designations",
  "pawns",
  "items",
  "blueprints",
  "events",
  "priorities",
]);

/** Idem pour le `LockstepClient`, préfixé `lockstep.` côté appelant. */
const LOCKSTEP_API: ReadonlySet<string> = new Set(["issue", "pump", "lag", "state", "tick", "startGame"]);

/** Vrai pour les tampons qu'il faut copier avant de les renvoyer. */
function isTypedArray(value: unknown): value is { slice(): unknown } {
  return ArrayBuffer.isView(value) && !(value instanceof DataView);
}

/**
 * Appelle une méthode, ou lit une propriété (`width`, `lag`, `state` sont des
 * accesseurs). Les tampons reviennent copiés : les vues du sim pointent sur la
 * mémoire WASM, qu'un clone structuré recopierait en entier.
 */
function callOn(target: object, method: string, args: readonly unknown[]): unknown {
  const value = (target as Record<string, unknown>)[method];
  const result =
    typeof value === "function" ? (value as (...a: unknown[]) => unknown).apply(target, [...args]) : value;
  return isTypedArray(result) ? result.slice() : result;
}

// --- État du Worker ---

let runner: SimRunner | null = null;
let lockstep: LockstepClient | null = null;
let timer: ReturnType<typeof setInterval> | null = null;
let started = false;

function stopTimer(): void {
  if (timer !== null) clearInterval(timer);
  timer = null;
}

/** Un battement : on avance, puis on émet ce qui a changé. */
function beat(): void {
  if (runner === null) return;
  let output: RunnerOutput;
  try {
    output = runner.advance(performance.now());
  } catch (e) {
    // Une exception du sim est définitive : mieux vaut s'arrêter net et
    // l'afficher que boucler sur elle soixante fois par seconde.
    stopTimer();
    fail(e);
    return;
  }
  if (output.map) post(output.map);
  if (output.overlays) post(output.overlays);
  if (output.frame) post(output.frame);
}

async function init(message: Extract<MainToWorker, { type: "init" }>): Promise<void> {
  if (message.mode === "solo") {
    runner = new SimRunner();
    runner.setSim(await SimHandle.create({ seed: BigInt(message.seed), width: message.width, height: message.height }));
  } else {
    lockstep = new LockstepClient({
      transport: new WebSocketTransport(message.server),
      createSim: (seed, width, height) => SimHandle.create({ seed: BigInt(seed), width, height }),
      restoreSim: (bytes) => SimHandle.restore(bytes),
      onState: (state) => post({ type: "net", state }),
      // La fabrique ne produit que des `SimHandle` : le runner a besoin de ses
      // tampons, que `SimLike` n'expose pas.
      onSim: (sim) => runner?.setSim(sim as RunnerSim),
    });
    runner = new SimRunner({ lockstep });
    lockstep.join(message.room, message.name);
  }
  timer = setInterval(beat, INTERVAL_MS);
}

function handle(message: MainToWorker): void {
  switch (message.type) {
    case "init":
      if (started) return; // un seul `init` par Worker
      started = true;
      void init(message).catch(fail);
      return;
    case "issue":
      // Seul chemin des actions du joueur. En multi la commande part au
      // serveur et revient dans un bundle : jamais appliquée au clic.
      if (lockstep) lockstep.issue(message.bytes);
      else runner?.sim?.applyEncoded(message.bytes);
      return;
    case "setPaused":
      runner?.setPaused(message.paused);
      return;
    case "setSpeed":
      runner?.setSpeed(message.speed);
      return;
    case "startGame":
      lockstep?.startGame(message.seed, message.width, message.height);
      return;
    case "save": {
      const sim = runner?.sim;
      if (!sim) return;
      post({ type: "saved", bytes: sim.snapshot() });
      return;
    }
    case "load":
      // Le chargement est réservé au solo : l'horloge du multi ne s'arrête pas.
      if (lockstep) return;
      void SimHandle.restore(message.bytes).then(
        (sim) => {
          runner?.setSim(sim);
          post({ type: "loaded" });
        },
        // Une sauvegarde illisible n'est pas fatale : le sim en cours continue.
        (e: unknown) => post({ type: "loaded", error: e instanceof Error ? e.message : String(e) }),
      );
      return;
    case "debug":
      debug(message);
      return;
  }
}

/**
 * Crochet de dev : `window.__rimlike.rpc(...)` aboutit ici.
 *
 * Un `frame` est réclamé après l'appel : un scénario joué en pause depuis la
 * console (`rpc("step", 5000)`) doit se voir à l'écran sans qu'il faille
 * relancer le temps.
 */
function debug(message: Extract<MainToWorker, { type: "debug" }>): void {
  const { id, method, args } = message;
  try {
    if (method.startsWith("lockstep.")) {
      const name = method.slice("lockstep.".length);
      if (lockstep === null) throw new Error("pas de lockstep : la partie est en solo");
      if (!LOCKSTEP_API.has(name)) throw new Error(`méthode lockstep inconnue : ${name}`);
      post({ type: "debugResult", id, value: callOn(lockstep, name, args) });
      return;
    }
    const sim = runner?.sim;
    if (!sim) throw new Error("pas de sim : la partie n'a pas démarré");
    if (!SIM_API.has(method)) throw new Error(`méthode de sim inconnue : ${method}`);
    if (method === "step" && lockstep !== null) {
      throw new Error("step est refusé en multijoueur : seul lockstep.pump avance le sim");
    }
    post({ type: "debugResult", id, value: callOn(sim, method, args) });
    runner?.requestFrame();
  } catch (e) {
    post({ type: "debugResult", id, value: null, error: e instanceof Error ? e.message : String(e) });
  }
}

ctx.addEventListener("message", (event) => {
  try {
    handle(event.data);
  } catch (e) {
    fail(e);
  }
});
