---
slug: snapshot-tick-invalide
status: done
claimed_by: codex
claimed_at: 2026-09-07
layer: serveur
scope:
  - apps/server/src/room-persistence.ts
  - apps/server/src/persistence.ts
  - apps/server/test/*
  - docs/protocol.md (une phrase)
  - docs/tasks/snapshot-tick-invalide.md
contract: aucun changement de message ni de format de fichier
acceptance:
  - export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm test:server
  - export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm --filter server typecheck
done_in: PR #9 (task/snapshot-tick-invalide)
---

# Un snapshot hostile ne doit pas condamner le fichier commun

**Constat P1 :** le codec accepte `snapshot.tick = 1e20` avec
`Number.isInteger`, la conservation l'écrit, puis `readSavedRooms` le refuse
au redémarrage avec `Number.isSafeInteger` : `WorldStore.load` met alors tout
le fichier en quarantaine (colonies, identités et salles perdues au chargement).

**Mission :** valider à la conservation toutes les métadonnées exigées à la
lecture, borner les octets, ignorer et journaliser individuellement les salles
corrompues du fichier commun, avec tests sans port.

**Contraintes :** branche `task/snapshot-tick-invalide`, périmètre strict
ci-dessus ; aucun changement de `packages/`, client ou Rust, aucun commit,
push ni port depuis cette sandbox ; livraison et tests réseau par l'orchestrateur.

## Résultat

La réception et la lecture partagent la validation du tick et de la graine
(entiers sûrs non négatifs), des dimensions (1 à 4096), du nom de salle et des
dates ; le protocole ne définit pas de plafond de tick inférieur à
`Number.MAX_SAFE_INTEGER` (la borne de 60 jours concerne `frozenTicks` seulement).
Un snapshot invalide est ignoré sans créer d'entrée ni remplacer le dernier
snapshot valide.

Les octets persistés ont un plafond de 8 388 608, aligné sur la limite réseau
par défaut ; la limite réseau configurable reste appliquée en amont par le
serveur sur la trame JSON, et ce plafond de conservation reste fixe même si
l'exploitant augmente `MAX_SNAPSHOT_BYTES`.
La lecture borne la longueur base64 avant décodage, puis le nombre réel
d'octets, pour couvrir aussi un dépassement dans le dernier quartet.

Chaque entrée invalide ou doublon de nom est ignoré et journalisé par son index
via le logger de `WorldStore` ; la première entrée valide gagne, les suivantes
continuent à être lues et la prochaine sauvegarde n'inclut que les salles valides.
Un tableau `rooms` lui-même mal formé, un JSON illisible ou un monde incohérent
gardent le traitement de quarantaine existant.

Tests ajoutés dans `apps/server/test/room-persistence.test.ts` : réception réelle
du message décodé par `Room.handle` sans transport, refus du tick `1e20` avant
et après un snapshot valide, métadonnées invalides, bornes sûres, taille des
octets, fichiers corrompus chargés sans renommage et sans perte des colonies,
identités, snapshots monde et autres salles, doublons, réécriture nettoyée.

**Validation locale réussie :** 52 tests sans port (42 de salles nommées,
10 de persistance existante), 10 tests réseau exclus, typecheck serveur et
`git diff --check` réussis.

```bash
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm --filter server exec vitest run test/room-persistence.test.ts -t 'fichier commun et horloge injectée'
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm --filter server exec vitest run test/persistence.test.ts -t 'résolution de la configuration|WorldState :|WorldStore :|migration d.un fichier v1'
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm --filter server typecheck
```

**À exécuter par l'orchestrateur :** `pnpm test:server` et
`pnpm --filter server typecheck`, avec le même préfixe PATH.
Fichiers laissés modifiés, sans commit ni push ; aucun port ouvert.

Vérification par l'orchestrateur hors sandbox (2026-09-07) : trois passages de `pnpm test:server` (210 tests), typecheck serveur, protocole 65 tests.
