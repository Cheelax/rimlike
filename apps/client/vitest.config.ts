/**
 * Config de test à part de `vite.config.ts` : les tests tournent sous Node,
 * sur la logique réseau pure (`src/net`), sans React ni WASM ni DOM. Éviter
 * d'hériter du plugin React garde la suite rapide et sans surprise.
 */
import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["test/**/*.test.ts"],
  },
});
