# rimlike

Jeu de gestion de colonie à la RimWorld, multijoueur sur un globe partagé.
Sim déterministe en Rust (WASM + natif), client Three.js/React, serveur Node.

Plan complet et journal des décisions : [docs/PLAN.md](docs/PLAN.md).

## Démarrer

Prérequis : Rust via rustup (la toolchain est pinnée par `rust-toolchain.toml`),
`wasm-pack`, Node 22+, pnpm.

```bash
pnpm install
pnpm dev        # compile le WASM puis lance Vite
pnpm test       # tests natifs du sim, dont le test de déterminisme
pnpm lint       # clippy (anti-float, anti-HashMap) + tsc
```

En jeu : glisser droit ou flèches pour déplacer la vue, molette pour zoomer, Q/E pour
tourner, espace pour la pause, 1/2/3 pour la vitesse. Clic gauche pour sélectionner un
colon, clic droit pour l'envoyer quelque part. Outils (C couper, M miner, H récolter,
Z zone de stockage, G zone de culture, X annuler) et constructions (B mur, P porte, O sol,
L lit, F feu de camp, T pour alterner bois et pierre) : tracer un rectangle au glisser
gauche, Échap ou clic droit pour revenir à la sélection. Les colons cherchent seuls le
travail : ils construisent, livrent les matériaux aux chantiers, cuisinent au feu de camp,
exécutent les désignations, sèment et récoltent les cultures, puis rangent les objets dans
les zones de stockage. Un colon affamé mange le meilleur plat disponible, un colon fatigué
va dormir dans un lit libre. La nourriture se gâte avec le temps. Après trois jours, des
pillards attaquent régulièrement : les colons menacés se défendent seuls, et un clic droit
sur un ennemi avec un colon sélectionné ordonne l'attaque. Un colon qui ne mange plus
meurt en deux jours.

## Structure

- `crates/sim` : la simulation. Aucun flottant, aucune horloge, aucune dépendance au rendu.
- `crates/sim-wasm` : frontière wasm-bindgen, seule porte entre Rust et JS.
- `apps/client` : rendu et UI.
- `docs/` : plan, décisions.
