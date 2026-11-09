// Test de fumée de l'hébergement (rimlike-ctl smoke) : un vrai client
// WebSocket qui parle le protocole (docs/protocol.md), sans navigateur.
//
//   node smoke.mjs <ws(s)://hôte> create   crée une salle nommée, la démarre,
//                                          fournit un snapshot de conservation,
//                                          et un joueur du monde (jeton gardé)
//   node smoke.mjs <ws(s)://hôte> check    rouvre cette salle et ce joueur :
//                                          à lancer APRÈS un redémarrage pour
//                                          prouver la persistance
//   node smoke.mjs <ws(s)://hôte> all      create puis check (reconnexion)
//
// Tourne dans l'image serveur (node 22 + ws). Derrière Cloudflare Access,
// CF_ACCESS_CLIENT_ID / CF_ACCESS_CLIENT_SECRET (jeton de service) sont
// envoyés en en-têtes s'ils sont définis. L'état entre create et check est
// dans SMOKE_STATE (défaut ./smoke.json) ; il contient le jeton du joueur de
// test du monde, rien d'autre.
import { readFileSync, writeFileSync } from "node:fs";
import WebSocket from "ws";

const PROTOCOL_VERSION = 3;
const [url = "ws://127.0.0.1:8790", step = "all"] = process.argv.slice(2);
const stateFile = process.env.SMOKE_STATE ?? "./smoke.json";
const httpBase = url.replace(/^ws/, "http").replace(/\/$/, "");
const headers = {};
if (process.env.CF_ACCESS_CLIENT_ID && process.env.CF_ACCESS_CLIENT_SECRET) {
  headers["CF-Access-Client-Id"] = process.env.CF_ACCESS_CLIENT_ID;
  headers["CF-Access-Client-Secret"] = process.env.CF_ACCESS_CLIENT_SECRET;
}

const log = (...args) => console.log(`[smoke ${new Date().toISOString().slice(11, 19)}]`, ...args);
function check(condition, label) {
  if (!condition) throw new Error(`ÉCHEC : ${label}`);
  log(`ok — ${label}`);
}

class Client {
  constructor(socket) {
    this.socket = socket;
    this.received = [];
    this.waiters = new Set();
    socket.on("message", (data) => {
      const message = JSON.parse(String(data));
      this.received.push(message);
      if (message.type === "ping") this.send({ type: "pong" });
      for (const w of [...this.waiters]) w();
    });
    socket.on("close", () => {
      this.closed = true;
      for (const w of [...this.waiters]) w();
    });
  }
  static connect() {
    return new Promise((resolve, reject) => {
      const socket = new WebSocket(url, { headers, handshakeTimeout: 15000 });
      socket.once("open", () => resolve(new Client(socket)));
      socket.once("unexpected-response", (_req, res) => reject(new Error(`upgrade refusé : HTTP ${res.statusCode} ${res.headers.location ?? ""}`)));
      socket.once("error", reject);
    });
  }
  send(message) {
    this.socket.send(JSON.stringify(message));
  }
  /** Le n-ième message d'un type (0 = premier), attendu au besoin. */
  nth(type, index = 0, timeoutMs = 15000) {
    const pick = () => {
      const errors = this.received.filter((m) => m.type === "error" || m.type === "world_error");
      if (errors.length > 0) throw new Error(`erreur serveur : ${JSON.stringify(errors[0])}`);
      return this.received.filter((m) => m.type === type)[index];
    };
    return new Promise((resolve, reject) => {
      const done = () => {
        try {
          const found = pick();
          if (found !== undefined) {
            cleanup();
            resolve(found);
          } else if (this.closed) {
            cleanup();
            reject(new Error(`connexion fermée en attendant ${type}`));
          }
        } catch (e) {
          cleanup();
          reject(e);
        }
      };
      const timer = setTimeout(() => {
        cleanup();
        reject(new Error(`délai dépassé en attendant ${type}`));
      }, timeoutMs);
      const cleanup = () => {
        clearTimeout(timer);
        this.waiters.delete(done);
      };
      this.waiters.add(done);
      done();
    });
  }
  close() {
    this.socket.close();
  }
}

async function getJson(path) {
  const response = await fetch(`${httpBase}${path}`, { headers, redirect: "manual" });
  check(response.status === 200, `GET ${path} → ${response.status}`);
  return response.json();
}

async function create() {
  const health = await getJson("/health");
  check(health.ok === true, `serveur en bonne santé (globe seed ${health.world?.seed}, ${health.world?.tiles} cases)`);

  const world = await Client.connect();
  world.send({ type: "world_join", name: "smoke-test", protocol: PROTOCOL_VERSION });
  const welcome = await world.nth("world_welcome");
  check(typeof welcome.token === "string", `nouveau joueur du monde (clé ${welcome.playerKey.slice(0, 8)}…), jeton reçu`);
  world.close();

  const room = `smoke-${Date.now().toString(36)}`;
  const payload = Buffer.from(`rimlike-smoke ${room}`).toString("base64");
  const host = await Client.connect();
  host.send({ type: "join", room, name: "smoke-host", protocol: PROTOCOL_VERSION });
  const hello = await host.nth("welcome");
  check(hello.isHost === true && hello.state === "lobby", `salle « ${room} » créée, hôte`);
  host.send({ type: "start", seed: 4242, width: 32, height: 32 });
  const start = await host.nth("start");
  check(start.dayScale !== undefined, `partie démarrée (échelle du jour ${start.dayScale})`);
  // Le serveur réclame un snapshot de conservation toutes les 1 800 ticks
  // (30 s réelles) : c'est lui qui rend la salle persistante.
  log("attente de la demande de snapshot de conservation (≈ 30 s)…");
  await host.nth("request_snapshot", 0, 60000);
  const bundles = host.received.filter((m) => m.type === "bundle");
  const tick = bundles[bundles.length - 1].to;
  host.send({ type: "snapshot", tick, data: payload });
  const pongs = host.received.filter((m) => m.type === "pong").length;
  host.send({ type: "ping" });
  await host.nth("pong", pongs);
  check(true, `snapshot de conservation fourni au tick ${tick}`);
  host.close();

  writeFileSync(stateFile, JSON.stringify({ room, payload, tick, token: welcome.token, playerKey: welcome.playerKey }, null, 2), { mode: 0o600 });
  log(`état du test écrit dans ${stateFile}`);
}

async function verify() {
  const saved = JSON.parse(readFileSync(stateFile, "utf8"));
  const { rooms } = await getJson("/rooms");
  const listed = rooms.find((r) => r.name === saved.room);
  check(listed !== undefined && listed.state === "running", `salle « ${saved.room} » listée, en jeu (${listed?.players?.length ?? listed?.players ?? "?"} joueur(s))`);

  const world = await Client.connect();
  world.send({ type: "world_join", name: "smoke-test", protocol: PROTOCOL_VERSION, token: saved.token });
  const welcome = await world.nth("world_welcome");
  // playerId numérote la connexion ; playerKey est l'identité stable.
  check(welcome.playerKey === saved.playerKey && welcome.token === undefined, `joueur du monde (clé ${welcome.playerKey.slice(0, 8)}…) retrouvé par son jeton`);
  world.close();

  const guest = await Client.connect();
  guest.send({ type: "join", room: saved.room, name: "smoke-back", protocol: PROTOCOL_VERSION });
  const hello = await guest.nth("welcome");
  check(hello.state === "running" && hello.isHost === true, `salle rouverte (tick ${hello.tick}), le revenant devient hôte`);
  const snapshot = await guest.nth("snapshot");
  check(snapshot.data === saved.payload, `snapshot conservé restitué à l'identique (tick ${snapshot.tick}, gel ${snapshot.frozenTicks ?? 0} ticks)`);
  guest.close();
}

try {
  if (step === "create" || step === "all") await create();
  if (step === "check" || step === "all") await verify();
  log("TOUT EST VERT");
  process.exit(0);
} catch (e) {
  console.error(`[smoke] ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
}
