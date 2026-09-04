# rimlike

Jeu de gestion de colonie à la RimWorld, multijoueur sur un globe partagé.
Sim déterministe en Rust (WASM + natif), client Three.js/React, serveur Node.

Plan complet : [docs/PLAN.md](docs/PLAN.md).

## Démarrer

Prérequis : Rust via rustup (la toolchain est pinnée par `rust-toolchain.toml`),
`wasm-pack`, Node 22+, pnpm.

```bash
pnpm install
pnpm dev        # compile le WASM puis lance Vite
pnpm test       # tests natifs du sim, dont le test de déterminisme
pnpm lint       # clippy (anti-float, anti-HashMap) + tsc
```

## Structure

- `crates/sim` : la simulation. Aucun flottant, aucune horloge, aucune dépendance au rendu.
- `crates/sim-wasm` : frontière wasm-bindgen, seule porte entre Rust et JS.
- `apps/client` : rendu et UI.
- `docs/` : plan, décisions.
