import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig({
  plugins: [react()],
  build: { target: "es2022" },
  // Le Worker de simulation charge le WASM via `new URL(..., import.meta.url)`
  // et est déclaré `{ type: "module" }` : il lui faut une sortie ES, pas l'IIFE
  // par défaut (où `import.meta.url` n'existe pas).
  worker: { format: "es" },
});
