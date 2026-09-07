---
slug: test-salle-gelee-instable
status: open
claimed_by:
claimed_at:
layer: serveur
scope:
  - apps/server/test/room-persistence.test.ts
  - apps/server/src/room-persistence.ts (seulement si le test révèle un vrai défaut)
contract: aucun
acceptance:
  - export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH; for i in 1 2 3 4 5 6 7 8; do pnpm test:server >/dev/null 2>&1 || echo "échec $i"; done
done_in:
---

# Un test de salle gelée échoue une fois sur deux

**Constat** (2026-09-07, agent de câblage du biome) : `apps/server/test/room-persistence.test.ts`
› « rouvre une salle vidée et conserve son gel à travers plusieurs arrêts sans visite » échoue
environ une fois sur deux, indépendamment des changements en cours (vérifié en remisant).

**Mission** : trouver la course (horloge injectée incomplète ? écriture atomique en vol à
l'arrêt ? ordre de deux minuteurs ?) et la corriger dans le test si c'est le test, dans le code
si c'est le code ; le dire. Huit exécutions consécutives vertes pour clore.
