---
slug: biome-en-solo
status: done
claimed_by: codex
claimed_at: 2026-09-07
layer: client
scope:
  - apps/client/src (sauf wasm/ et CraftingPanel.tsx)
  - apps/client/test
  - docs/GUIDE.md
  - docs/tasks/biome-en-solo.md
contract: "Ajout du biome au message init solo entre SimBridge et le Worker ; aucun changement Rust, WASM ou protocole réseau."
acceptance:
  - pnpm --filter client typecheck && pnpm --filter client test && pnpm --filter client build
done_in: PR #8 (task/biome-en-solo)
---

# Choisir le biome en solo

Sur l'accueil, présenter « Biome » à côté de « Difficulté » : les neuf biomes
fondables (sans l'océan), libellés de `BIOME_NAMES`, forêt tempérée (4) par
défaut. Mémoriser le choix sous `rimlike.solo.biome.v1`, avec lecture tolérante
et écriture protégée comme `settings.ts`.

Le biome traverse la session solo, `SimBridge`, le message `init` du Worker,
puis `SimHandle.create({ biome })` et `WasmSim.new_in_biome`. En multi et dans
le monde, le biome reste imposé par le serveur. Charger un snapshot doit
retrouver son biome, lisible dans le HUD et par `rpc("biome")`.

## Acceptation et vérification

- Module pur `soloBiome.ts` : liste, validation et persistance testées dans
  `soloBiome.test.ts`, y compris les valeurs invalides et le stockage indisponible.
- Test du câblage solo : biome 6 transmis à la fabrique ; snapshot restauré
  avec son biome et frame du HUD cohérent.
- Guide : deux lignes dans « Démarrer une partie » et retrait de l'affirmation
  obsolète « solo toujours en forêt tempérée » en §6.
- Préfixer chaque commande pnpm par
  `export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH`.
- Navigateur, à effectuer par l'orchestrateur : accueil → Biome : désert →
  Partie solo → `await window.__rimlike.rpc('biome')` vaut 6, carte sableuse,
  HUD « désert ». Recharger l'accueil : le choix désert est mémorisé.
- Sauver ce désert, recharger l'accueil, démarrer une toundra puis Charger :
  le RPC, la carte et le HUD retrouvent le désert sauvegardé.
- Ne pas commiter, pousser ni ouvrir de port dans cette sandbox. L'orchestrateur
  relit, vérifie au navigateur et commite depuis la branche `task/biome-en-solo`.

## Résultat

Implémenté dans `App.tsx`, `styles.css`, `soloBiome.ts`, `worker/SimBridge.ts`,
`worker/protocol.ts` et `worker/sim.worker.ts`. Commentaires actualisés dans
`net/SimLike.ts` et `sim/SimHandle.ts`. HUD et restauration existants conservés :
ils lisent le biome du sim courant. Fixture `worker-protocol.test.ts` complétée
avec le champ solo ; intention des tests existants inchangée.

19 nouveaux tests dans `soloBiome.test.ts` et `soloBiome-worker.test.ts`.
Le test Worker utilise la glue WASM existante sans la modifier, observe la
fabrique et vérifie Sauver / Charger avec deux biomes différents.

Validation : typecheck et build client réussis. Suite client : **425 tests
réussis, 31 fichiers réussis ; 2 fichiers en échec au chargement**
(`lockstep.test.ts`, `worldflow.test.ts`) car `apps/server/src/server.ts` ne
résout pas `@rimlike/protocol` dans ce worktree. Dépendances serveur hors
périmètre : suite complète à relancer par l'orchestrateur dans son environnement.
Build : avertissement Vite de bundle supérieur à 500 Ko, sans échec.
Vérification visuelle laissée à l'orchestrateur ; fichiers non commités.

Vérification par l'orchestrateur hors sandbox (2026-09-07) : suite client complète 474 tests verts, typecheck et build verts.
