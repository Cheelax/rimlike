# rimlike

Jeu de gestion de colonie à la RimWorld, multijoueur sur un globe partagé.
Sim déterministe en Rust (WASM + natif), client Three.js/React, serveur Node.

**Jouer sans rien installer** : https://cheelax.github.io/rimlike/ (solo complet dans le
navigateur ; le multijoueur et le monde partagé demandent un serveur, voir plus bas).

Plan complet et journal des décisions : [docs/PLAN.md](docs/PLAN.md).
Guide du joueur (contrôles, survie, dangers, monde partagé) : [docs/GUIDE.md](docs/GUIDE.md).

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
meurt en deux jours. La touche J ouvre le tableau des priorités de travail par colon. Un
colon au moral trop bas craque et erre un moment ; la pluie fait pousser les cultures, l'orage
pèse sur le moral ; des voyageurs rejoignent la colonie de temps en temps.

## Multijoueur (expérimental)

```bash
pnpm dev:server
```

puis, dans deux navigateurs, `http://localhost:5173/?server=ws://localhost:8787&room=demo&name=alice`
et la même adresse avec `name=bob`. L'hôte démarre la partie ; chacun voit les actions de
l'autre, la simulation tourne à l'identique chez tous (lockstep déterministe).

## Monde partagé (expérimental)

Avec le serveur lancé, `http://localhost:5173/?server=ws://localhost:8787&name=alice&world=1`
affiche le globe : survolez et cliquez une case terrestre pour vous y installer, ou visitez la
colonie d'un autre joueur. Chaque case a sa propre carte et sa propre graine ; une colonie
fermée reprend là où elle en était quand quelqu'un y revient.

## Structure

- `crates/sim` : la simulation. Aucun flottant, aucune horloge, aucune dépendance au rendu.
- `crates/sim-wasm` : frontière wasm-bindgen, seule porte entre Rust et JS.
- `apps/client` : rendu et UI.
- `packages/protocol` : messages et logique lockstep du multijoueur, sans I/O.
- `apps/server` : serveur relais WebSocket (ne simule pas, ne décode pas les commandes).
- `packages/world` : le globe, ses biomes et les itinéraires de caravanes.
- `docs/` : plan, décisions, protocole réseau.
