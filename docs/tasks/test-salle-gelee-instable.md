---
slug: test-salle-gelee-instable
status: done
claimed_by: codex
claimed_at: 2026-09-07
layer: serveur
scope:
  - apps/server/test/room-persistence.test.ts
  - apps/server/src/room-persistence.ts (seulement si le test révèle un vrai défaut)
contract: aucun
acceptance:
  - export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; for i in 1 2 3 4 5 6 7 8; do pnpm test:server >/dev/null 2>&1 || echo "échec $i"; done
done_in: PR #7 (task/test-salle-gelee-instable)
---

# Un test de salle gelée échoue une fois sur deux

**Constat** (2026-09-07, agent de câblage du biome) : `apps/server/test/room-persistence.test.ts`
› « rouvre une salle vidée et conserve son gel à travers plusieurs arrêts sans visite » échoue
environ une fois sur deux, indépendamment des changements en cours (vérifié en remisant).

**Mission** : trouver la course (horloge injectée incomplète ? écriture atomique en vol à
l'arrêt ? ordre de deux minuteurs ?) et la corriger dans le test si c'est le test, dans le code
si c'est le code ; le dire. Huit exécutions consécutives vertes pour clore.

## Résultat

2026-09-07 — Codex : **course dans le test**, correction limitée à
`apps/server/test/room-persistence.test.ts` ; aucun changement de production.

**Mécanisme précis.** Le commentaire supposait à tort que `alice.closed` impliquait
déjà le départ côté serveur. `TestClient` positionne ce drapeau sur le `close` de
sa propre socket. Dans `ws/lib/websocket.js`, recevoir la trame de fermeture
(`receiverOnConclude`) déclenche la réponse ; l'événement `close` est émis plus
tard par la fermeture locale du transport (`socketOnClose`/`emitClose`). Les deux
sockets peuvent donc notifier leur fermeture dans les deux ordres. Si le client
notifie d'abord, `waitUntil` réveille le test alors que `room.isEmpty` vaut encore
`false`. Le serveur ne retire le joueur que dans `disconnect`, sur son propre
`close`, puis appelle synchroniquement `room.leave` et `dropRoomIfEmpty` : arrêt
de l'horloge, `savedRooms.freeze`, remplacement par une salle gelée.

**Correction.** Après la fermeture client, `expect.poll` attend effectivement
`room.isEmpty` (borne de 4 s), avant toute avance de l'horloge injectée. Utiliser
`alice.waitUntil` pour cette condition serveur serait incorrect : ce helper ne
réévalue ses prédicats qu'aux notifications du client, désormais fermé. La date
attendue du gel est aussi capturée avant le départ et vérifiée dès le premier
arrêt, pour détecter un gel tardif au lieu de prendre le fichier comme référence.

**Autres pistes écartées sur ce chemin.** Les dates de gel utilisent `wallNow`
injecté ; `freeze` ne modifie pas une salle déjà inactive. `WorldStore.save`
annule le minuteur et chaîne les écritures sur `writing`, et `server.close`
attend cette promesse. Le parcours de `rooms` à l'arrêt ne crée pas d'entrée.
La course identifiée survient avant la première avance de temps et l'arrêt.

**Validation locale :** 10 tests sans port réussis (6 tests réseau exclus) et
typecheck serveur réussi ; `git diff --check` réussi. Commandes exécutées :

```bash
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm --filter server exec vitest run test/room-persistence.test.ts -t 'fichier commun et horloge injectée'
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm --filter server typecheck
```

**À exécuter par l'orchestrateur hors sandbox** (aucun port ouvert ici ; la
reproduction réseau et les huit passages restent à confirmer) :

```bash
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; for i in 1 2 3 4 5 6 7 8; do pnpm test:server || break; done
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; pnpm --filter server typecheck
```

Fichiers laissés modifiés, sans commit ni push ; fiche réservée jusqu'à validation
et livraison par l'orchestrateur.

Vérification par l'orchestrateur hors sandbox (2026-09-07) : huit passages de `pnpm test:server` sans échec (178 tests), typecheck serveur vert.
