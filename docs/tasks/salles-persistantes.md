---
slug: salles-persistantes
status: done
claimed_by: codex
claimed_at: 2026-09-07
layer: serveur
scope:
  - apps/server/src
  - apps/server/test
  - apps/server/README.md
  - docs/protocol.md
  - docs/tasks/salles-persistantes.md
contract: Aucun changement des messages réseau ni du client ; schéma disque v5, versions 1 à 4 relues.
acceptance:
  - pnpm test:server
  - pnpm lint
done_in: PR #3 (task/salles-persistantes)
---

# Salles nommées persistantes

Au redémarrage du relais, les clients reconnectés retrouvaient un lobby neuf.
Conserver le dernier snapshot de l'hôte et son tick dans `WORLD_STATE_FILE`,
puis recréer les salles gelées. Le premier rejoignant devient hôte et reprend
par `welcome`/`snapshot` avec `frozenTicks`, comme le client sait déjà le faire.

## Design

Le fichier v5 ajoute `rooms` à côté de l'état du monde : nom, graine,
dimensions, tick, octets opaques en base64, création, dernière présence et
origine du gel. Les anciens fichiers restent lisibles. Les salles nommées
persistées réclament aussi les snapshots périodiques déjà prévus au protocole
et conservent ceux destinés aux rejoignants. Les salles `tile-N` gardent leur
chemin actuel.

Une salle occupée est datée à l'arrêt propre ; en cas de crash, le dernier
checkpoint sert d'origine. Une salle vidée se gèle au dernier départ. Le temps
réel jusqu'au premier `join` est converti avec `WORLD_HOUR_MS` et borné via
`frozenTicksForHours`. L'horloge lockstep reprend au tick sauvé, sans rejeu.
`ROOM_TTL_HOURS` vaut 72 ; seule la présence renouvelle le TTL, jamais une
sauvegarde ni un redémarrage sans visite. Les salles occupées n'expirent pas.

Le fichier étant commun, lorsqu'il conserve des salles nommées ses écritures
automatiques sont espacées d'au moins `ROOM_PERSIST_MS` (30 s), y compris les
mutations du monde. La programmation ne peut pas être affamée par une rafale.
Les écritures atomiques sont sérialisées et l'arrêt propre force le dernier
état reçu, même si une écriture est déjà en vol. `WORLD_PERSIST=0` désactive
lecture et écriture comme auparavant. Aucun lobby ni partie sans snapshot
n'est sauvé. Les commandes ultérieures au snapshot sauvé restent perdues.

## Vérification

Depuis la racine, avec Node 23 :

```sh
export PATH=/Users/thomas/.nvm/versions/node/v23.5.0/bin:$PATH
pnpm test:server
pnpm lint
pnpm --filter server typecheck
```

`room-persistence.test.ts` utilise une horloge et des minuteurs injectés,
aucun sommeil réel. Six cas traversent de vrais WebSockets ; dix cas testent
la salle, le registre et le fichier sans ouvrir de port.

## Résultat

Implémentation et documentation laissées modifiées pour l'orchestrateur,
sans commit ni push. Aucun fichier suivi de `packages/`, `apps/client/` ou
`crates/` modifié ; `docs/PLAN.md` est laissé à l'orchestrateur.

- 16 nouveaux tests : 10 passent sans réseau ; 6 tests WebSocket sont bloqués
  par la sandbox (`listen EPERM: operation not permitted 127.0.0.1`).
- Les 72 tests existants de `room`, `world` et `caravans` passent.
- `pnpm --filter server typecheck` et `git diff --check` passent.
- `pnpm test:server` lancé : les tests avec écoute réseau échouent dans cette
  sandbox, y compris les tests existants (`listen EPERM`, puis timeout).
- `pnpm lint` : `cargo clippy --workspace --all-targets -- -D warnings`
  passe ; le typecheck client échoue avec `tsc: command not found`, ses
  dépendances étant absentes dans ce worktree.
- L'installation hors ligne a échoué sur `ws@8.21.3` absent du cache ;
  l'installation normale échoue en DNS (`ENOTFOUND registry.npmjs.org`).
  Les dépendances du serveur ont pu être copiées localement depuis le dépôt
  voisin pour exécuter ses tests et son typecheck, sans modifier ce dépôt.

Rien à changer côté client : messages et `PROTOCOL_VERSION` inchangés,
traitement existant de `request_snapshot` et de `snapshot.frozenTicks` réutilisé.
Les deux commandes d'acceptation complètes restent à relancer hors sandbox.

Vérification par l'orchestrateur hors sandbox (2026-09-07) : `pnpm test:server` 177 tests
verts (dont les six WebSocket), typecheck serveur et clippy verts ; l'échec de `pnpm lint` dans
le worktree venait seulement de la glue WASM du client non générée là.
