---
slug: moteur-natif-colonies
status: claimed
claimed_by: Codex (session locale du 2026-09-19)
claimed_at: 2026-09-19
layer: serveur
scope:
  - crates/sim-host/, Cargo.toml, Cargo.lock
  - apps/server/src/native-sim.ts, native-colonies.ts, native-checkpoints.ts
  - apps/server/scripts/bench-native.ts, native-colony.ts
  - apps/server/test/native-sim.test.ts, native-colonies.test.ts, fixtures/
  - apps/client/test/native-process-parity.test.ts
  - package.json, apps/server/tsconfig.json, .github/workflows/ci.yml
  - docs/native-sim.md, docs/benchmarks/2026-09-19/
acceptance:
  - cargo test --workspace && cargo clippy --workspace --all-targets -- -D warnings
  - pnpm test:native && pnpm test:server
  - pnpm build:wasm && pnpm test:client
  - pnpm --filter server typecheck && pnpm --filter server run build:server
  - deux exécutions dev:native successives restaurent le même tick et hash puis avancent
  - benchmark Node/IPC/Rust et mémoire sur plusieurs cartes, avec limites explicites
done_in:
---

# Moteur natif, horloge sans navigateur et checkpoints

Brique préparatoire à la phase 6, construite dans la session qui reprend
`colonie-tient-seule`. Aucune salle de production n'y est branchée.

Le serveur doit pouvoir conserver plusieurs simulations, leur appliquer les mêmes
commandes que le WASM, les faire avancer sans joueur et retrouver leur état après
redémarrage. Le transport est privé au serveur, encadré, borné, sans logique métier
dans Node. Une erreur de moteur ou de sauvegarde se signale ; aucun état frais ne
remplace silencieusement une sauvegarde invalide.

Implémenté localement : processus Rust multi-cartes, client Node, boucle autonome,
checkpoints atomiques par carte avec verrou d'écrivain, démonstrateur CLI, benchmarks
sur cartes neuves, raid et colonie construite, et tests de parité directe. Contrat détaillé : [native-sim.md](../native-sim.md).

Validation locale : 432 tests Rust, 244 serveur dont 28 sur la frontière native
et la persistance, 523 client dont six comparaisons natives/WASM ; format, Clippy,
typage et builds de production verts. La version Node compilée restaure réellement
le tick 6 et le hash `53c02a804f62bec5`, puis libère son verrou. Le relais compilé
répond sur `/health` et `/world` en mode mémoire ; cela ne constitue pas un
raccordement de ses salles à la boucle native.

La fiche reste `claimed` jusqu'à revue et fusion. Pour poursuivre vers le jalon
réseau, créer une fiche dédiée à `Room` et au serveur monde : autorité des hashes,
snapshots de reconnexion, retrait du gel, ordres de calendrier/réputation et
caravanes, cohérence entre sauvegardes, packaging Docker, mesure VPS.
