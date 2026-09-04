import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * Relais de développement pour `GET /world`.
 *
 * Le serveur relais ne pose **aucun en-tête CORS** sur `GET /world`
 * (`apps/server/src/server.ts`), donc un `fetch` depuis l'origine de Vite
 * (`http://localhost:5173`) vers `http://localhost:8787` est refusé par le
 * navigateur. La WebSocket, elle, n'est pas soumise à cette règle : seul le
 * globe pose problème.
 *
 * Ce relais tient dans `apps/client` et n'existe qu'en développement
 * (`apply: "serve"`) : il n'entre pas dans le build. En production le client
 * est censé être servi par le serveur monde lui-même, ou celui-ci finira par
 * annoncer un `Access-Control-Allow-Origin` — dans les deux cas
 * `worldFetch.ts` appelle `/world` directement.
 *
 * Usage : `GET /__world?target=http://localhost:8787`.
 */
function worldProxy(): Plugin {
  return {
    name: "rimlike-world-proxy",
    apply: "serve",
    configureServer(server) {
      server.middlewares.use("/__world", (request, response) => {
        void (async () => {
          const target = new URL(request.url ?? "/", "http://localhost").searchParams.get("target");
          if (target === null || !/^https?:\/\//.test(target)) {
            response.statusCode = 400;
            response.end(JSON.stringify({ ok: false, error: "paramètre `target` http(s) attendu" }));
            return;
          }
          try {
            const upstream = await fetch(`${target}/world`, { headers: { accept: "application/json" } });
            const body = new Uint8Array(await upstream.arrayBuffer());
            response.statusCode = upstream.status;
            response.setHeader("content-type", "application/json; charset=utf-8");
            // Le globe ne change pas : on laisse le navigateur le garder d'un
            // rechargement à l'autre, comme le prévoit `docs/protocol.md` §11.1.
            const etag = upstream.headers.get("etag");
            if (etag !== null) response.setHeader("etag", etag);
            response.setHeader("cache-control", upstream.headers.get("cache-control") ?? "no-store");
            response.end(body);
          } catch (e) {
            response.statusCode = 502;
            response.end(JSON.stringify({ ok: false, error: e instanceof Error ? e.message : String(e) }));
          }
        })();
      });
    },
  };
}

export default defineConfig({
  plugins: [react(), worldProxy()],
  build: { target: "es2022" },
  // Le Worker de simulation charge le WASM via `new URL(..., import.meta.url)`
  // et est déclaré `{ type: "module" }` : il lui faut une sortie ES, pas l'IIFE
  // par défaut (où `import.meta.url` n'existe pas).
  worker: { format: "es" },
});
