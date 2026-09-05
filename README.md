# rimlike

Jeu de gestion de colonie à la RimWorld, en vue du dessus pseudo-3D, avec un
multijoueur lockstep et un globe partagé où chaque case est une carte de
colonie possible. Sim déterministe en Rust (WASM + natif), client Three.js/React,
serveur relais Node.

**Jouer sans rien installer** : https://cheelax.github.io/rimlike/ (solo complet dans
le navigateur ; le multijoueur et le monde partagé demandent un serveur, voir « Essayer
le multijoueur et le monde » plus bas).

## Ce qu'on peut y faire aujourd'hui

- Diriger une colonie de colons avec besoins (faim, repos, humeur), traits de
  caractère, compétences et montée de niveau.
- Construire (murs, portes, sols, lits, postes), cultiver, cuisiner et conserver
  les vivres par le froid.
- Une santé détaillée : parties du corps, blessures, saignements, soins, colons à
  terre, morts et tombes.
- Des raids gérés par un storyteller à difficulté réglable, des armes (mêlée et
  arc) et des pièges à pointes.
- De la faune à chasser et dépecer (viande, cuir), des vêtements à fabriquer et à
  porter selon la température.
- Des saisons et un climat propre à chaque case du globe.
- De la recherche (technologies à bonus, pas de verrous), des relations entre
  colons (avis, disputes, amitiés).
- Des marchands de passage et du troc, des caravanes entre colonies, des
  marchands itinérants qui circulent sur le globe.
- Un multijoueur lockstep dans une colonie et un monde partagé avec colonies
  gelées (avance rapide au retour) et reconnexion automatique.

Détail complet du point de vue du joueur (contrôles, survie, dangers, monde
partagé) : [docs/GUIDE.md](docs/GUIDE.md).

## Essayer le multijoueur et le monde

Le client publié ne fournit pas de serveur : sur l'écran d'accueil, saisir
l'adresse d'un serveur relais (`ws://...` ou `wss://...`) rejoint une salle
multijoueur ou le monde partagé. Pour un essai local, voir « Démarrer »
ci-dessous puis `AGENTS.md` (sections « Essayer le multijoueur » et « Essayer le
monde partagé »). Pour héberger son propre serveur, voir « Héberger un
serveur » plus bas.

## Démarrer

Prérequis : Rust via rustup (la toolchain est pinnée par `rust-toolchain.toml`),
`wasm-pack`, Node 22+, pnpm.

```bash
pnpm install
pnpm dev          # compile le WASM puis lance Vite sur :5173 (solo direct)
pnpm dev:server   # relais + serveur monde sur :8787, pour le multi et le monde
pnpm test         # cargo test --workspace, dont le test de déterminisme
pnpm lint         # cargo clippy -D warnings + tsc --noEmit
```

Détail des commandes (tests par paquet, variables d'environnement du serveur,
outils en ligne de commande du sim) : `AGENTS.md`.

## Architecture

- `crates/sim` : la simulation, en Rust. Déterministe, sans rendu, sans réseau,
  sans horloge, compilée en natif et en WASM.
- `crates/sim-wasm` : frontière wasm-bindgen, seule porte entre Rust et JavaScript.
- `apps/client` : Vite + React + Three.js. Lit l'état du sim, envoie des commandes.
- `packages/protocol` (types, codec, logique lockstep pure) et `apps/server`
  (relais WebSocket : salles, horloge, ordre des commandes, snapshots) portent le
  multijoueur.
- `packages/world` : géométrie du globe, biomes, itinéraires de caravanes.

Plan complet, phases et journal des décisions : [docs/PLAN.md](docs/PLAN.md).
Protocole réseau : [docs/protocol.md](docs/protocol.md). Le globe :
[docs/world.md](docs/world.md). Guide du joueur : [docs/GUIDE.md](docs/GUIDE.md).
Guide de contribution (ordre de travail, invariants du sim, conventions) :
[AGENTS.md](AGENTS.md).

## Héberger un serveur

Image Docker, variables d'environnement, sauvegarde et restauration, `wss://`
derrière un reverse proxy : [deploy/README.md](deploy/README.md).

## Mode de travail

Le projet est mené avec des agents (Claude, aux côtés du développeur) ; les
décisions d'architecture et d'équilibrage sont consignées et datées dans
`docs/PLAN.md` plutôt que reprises à chaque session.
