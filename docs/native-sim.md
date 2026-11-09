# Moteur natif et colonies autonomes

État du 2026-09-19, sur la branche de travail `task/colonie-tient-seule`.
Le moteur Rust est pilotable par Node, les colonies peuvent avancer sans navigateur
et reprendre un checkpoint disque. **Le relais WebSocket courant reste un relais** :
`Room`, le monde partagé, les caravanes et le Docker de production ne sont pas
encore raccordés à cette boucle. Le jalon complet de la phase 6 reste ouvert.

## Essayer et vérifier

Depuis la racine, avec Rust 1.88.0, Node 22+ et pnpm :

```bash
pnpm build:native
pnpm test:native
pnpm build:wasm
pnpm test:client   # comprend six comparaisons directes processus natif / WASM
pnpm test:server

# Deux exécutions successives : la seconde restaure le tick et le hash de la première.
pnpm dev:native -- --map demo --directory /tmp/rimlike-native-demo --seconds 2
pnpm dev:native -- --map demo --directory /tmp/rimlike-native-demo --seconds 2

# Sans --seconds : tourne jusqu'à SIGINT / SIGTERM ; arrêt = dernier lot + checkpoint.
pnpm dev:native -- --map demo --directory /tmp/rimlike-native-demo
pnpm bench:native --maps 64 --size 128 --ticks 36000 --batch 3 --day-scale 30
# Depuis la racine, le filtre pnpm place le script dans apps/server :
pnpm bench:native --maps 64 --ticks 20000 --snapshot ../../crates/sim/tests/fixtures/raid-watch.bin
```

`--seed`, `--size` et `--day-scale` servent à la création seulement : une reprise
conserve les propriétés du snapshot. Le démonstrateur ne publie aucun port réseau.
Ne pas utiliser son répertoire comme une sauvegarde du monde partagé actuel :
les deux formats et les deux cycles de vie sont distincts.

## Frontière Rust / Node

`crates/sim-host` construit `rimlike-native`. Il possède jusqu'à 128 `Sim`, dans un
`BTreeMap`. `apps/server/src/native-sim.ts` pilote son processus enfant avec
`shell: false`. Le sim reste la source unique des règles ; Node manipule des
commandes postcard opaques, des ticks et des snapshots.

Le chemin de développement pointe vers `target/release/rimlike-native` (suffixe
`.exe` sous Windows). En déploiement, fixer **`RIMLIKE_NATIVE_SIM_BIN`** au chemin
du binaire construit depuis la même révision que le WASM. L'image Docker du relais
n'embarque pas encore ce binaire.

Transport local : longueur **u32 big-endian**, puis JSON UTF-8. Requête
`{ id, request: { op, ... } }`. Réponse
`{ id, ok: true, result }` ou `{ id, ok: false, error: { code, message } }`.
Le stdout est réservé aux trames ; diagnostics sur stderr. Protocole IPC **1**,
indépendant du protocole réseau **4**.

| Opération | Entrée principale | Résultat |
|---|---|---|
| `ping` | — | version et limites |
| `create` | map, seed, width, height, biome, day_scale | état initial ; un nom existant est refusé |
| `restore` | map, data base64 | état restauré ; un nom existant est refusé |
| `step` | map, expected_tick, frames | tick final ; un tableau de commandes par tick |
| `inspect` | map | tick, dimensions, échelle, hash, taille du snapshot, colons, raid_status |
| `snapshot` | map | tick et octets postcard base64 |
| `remove` | map | booléen removed |
| `shutdown` | — | accusé de réception, puis fermeture |

Les commandes de **tout** un lot sont décodées et validées avant le premier tick.
Un mauvais tick ou une commande mal formée en fin de lot ne modifie pas la carte.
Les octets superflus après une commande ou un snapshot sont refusés. Les trames
tronquées ou de longueur invalide ferment le canal ; une requête JSON invalide
dans une trame complète produit une erreur sans décaler les trames suivantes.

| Borne | Valeur |
|---|---:|
| Trame IPC | 16 Mio |
| Snapshot décodé | 8 Mio |
| Commande décodée | 64 Kio |
| Cartes par processus | 128 |
| Dimensions | 8 à 192 par axe |
| Échelle du jour | 1 à 120 |
| Ticks d'un lot | 1 à 6 000 |
| Commandes d'un lot | 8 192 |
| Entiers de tick / graine à la frontière JS | entiers sûrs JavaScript |
| Requêtes Node en vol | 128 et 32 Mio cumulés |
| Délai de réponse par défaut | 10 s, configurable |

Une réponse perdue peut correspondre à un lot déjà exécuté. Une erreur de transport
ou un délai dépassé rend donc le processus inutilisable : toutes les promesses sont
rejetées et le processus est arrêté. Aucun rejeu ni redémarrage silencieux.

La restauration est destinée aux **checkpoints produits par le serveur**, pas aux
snapshots fournis librement par un client. Le décodage postcard et les bornes de carte
ne constituent pas une validation exhaustive d'un état de jeu hostile.

## Boucle autonome et sauvegarde

`NativeColonies` possède le processus, les cartes et une file d'opérations sérialisée.
Par défaut : **3 ticks toutes les 50 ms**, checkpoint toutes les **3 600 ticks**.
Il n'existe pas de compteur de visiteurs : une colonie chargée continue de vivre
quand aucun navigateur n'est connecté.

`submit` copie les octets et les met en attente du prochain lot. Limites par carte :
256 commandes et 1 Mio en attente. Le moteur Rust valide leur contenu au moment du
lot. `advance` rend les intervalles réellement appliqués et les commandes du premier
tick, dans l'ordre lexicographique des noms de cartes.

Deux pulses ne lancent jamais deux avances concurrentes. Sous surcharge, un pulse
est ignoré et `skippedPulses` augmente : le monde ralentit, la file ne grossit pas sans
borne. C'est un signal de capacité à traiter avant le raccordement réseau ; aucune
promesse de tenue à 60 ticks/s sur un VPS chargé n'est faite ici.

Les erreurs du moteur ou de checkpoint arrêtent l'horloge et remontent par
`error` / `onError`. Un arrêt normal attend les opérations en vol, applique un
dernier lot si des ordres restent admis, sauvegarde chaque carte, puis ferme Rust.
`close` est idempotent. Les avances de plusieurs cartes ne sont pas une transaction
globale : en cas d'erreur intermédiaire, les premières peuvent avoir avancé.

`NativeCheckpointStore` écrit un fichier par carte, avec version de fichier **1**,
version réseau, tick, dimensions, échelle, hash du sim, digest SHA-256 des octets et
snapshot base64. Nom de carte limité à 80 caractères ASCII alphanumériques,
tiret ou underscore. Écriture dans un fichier temporaire unique, synchronisation,
renommage atomique, puis synchronisation du répertoire sous Linux.
**Un seul runtime écrivain par répertoire**, garanti par l'ouverture exclusive de
`.writer.lock` avant le lancement de Rust. Une seconde instance est refusée. Le
verrou porte un jeton unique, le PID et l'hôte ; il est libéré après l'arrêt de Rust,
y compris après une erreur de simulation ou un échec de lancement. La libération
refuse d'effacer un verrou dont le propriétaire aurait changé.

Après un arrêt brutal, le verrou peut rester. Il n'est jamais repris automatiquement
sur la seule base d'une date ou d'un PID : vérifier que l'instance indiquée ne tourne
plus, puis retirer ce fichier avant la reprise. Les checkpoints restent intacts.
Une utilisation directe du magasin en écriture doit aussi prendre `acquireWriter()`
et appeler sa fonction de libération ; les lectures seules n'exigent pas le verrou.

À la lecture : limite de taille, version, nom, métadonnées, base64 canonique et SHA-256
sont vérifiés. Après restauration, Rust recalcule le hash et les propriétés du sim.
Un fichier incohérent est refusé et conservé ; il n'est jamais remplacé par une colonie
neuve. Créer sous un nom déjà sauvegardé est refusé : il faut appeler `restore`.

Le monde ne vieillit pas pendant l'arrêt du serveur. La reprise repart au tick sauvegardé,
sans calcul à partir de la date du fichier. La durée perdue après un arrêt brutal reste
bornée par la dernière sauvegarde réussie ; il n'y a pas encore de journal de commandes
durable entre checkpoints. La cohérence entre cartes, transferts et état du globe reste
à concevoir pour le raccordement.

## Preuves et mesures locales

- Rust : framing fragmenté, lots atomiquement validés, cartes indépendantes,
  aller-retour snapshot, reprise d'une scène de raid.
- Node : vrai processus enfant, timeout, arrêt, framing ; horloge sans joueur,
  commandes copiées et ordonnées, saturation, checkpoints périodiques, reprise,
  fichier corrompu, hash falsifié, échec d'écriture et arrêt avec ordres en attente ;
  exclusion de deux écrivains, verrou après crash, lancement échoué et propriétaire changé.
- WASM : mêmes commandes sur banquise, toundra, forêt et désert, aux échelles 1 et 30 ;
  snapshots dans les deux sens ; reprise d'une défense après fermeture du processus.
  Trois fixtures figent une veille à K=30, un défenseur engagé au seuil et le retour
  de colons éloignés de leur enceinte.

Sur la machine WSL locale, **64 cartes neuves de 128×128**, forêt tempérée K=30,
36 000 ticks chacune, lots de 3 : 2 304 000 ticks exécutés en **3,66 s** ;
p95 d'un lot pour les 64 cartes **0,56 ms** face au budget de 50 ms ;
RSS Rust **10,75 Mio** (2 Mio avant cartes), snapshots bruts **6,05 Mio**,
capture de tous les snapshots **19,2 ms**. Les écritures disque et le coût Node ne
sont pas inclus dans cette RSS ni dans le coût de capture.

Une seconde mesure restaure **64 fois la même scène de veille** (64×64, trois colons
et six pillards par carte, K=30), puis exécute 20 000 ticks par carte jusqu'au départ
des pillards : **1,95 s** au total, p95 **0,55 ms** par lot, RSS Rust finale **4,75 Mio**.
Le départ est au tick 3 du snapshot ; le benchmark conserve ce tick au lieu de
supposer que toute carte restaurée repart de zéro. Ce scénario couvre les portes
fermées, les recherches de chemin, le pillage et la fuite.

Une troisième mesure reprend **64 fois une colonie construite de trente jours**
(graine 1, 64×64, dix colons, un animal apprivoisé, trois technologies, enceinte).
Pour 3 600 ticks par carte : **4,45 s**, p50 **3,61 ms**, p95 **5,83 ms** par
lot de 64 cartes, RSS Rust finale **5,5 Mio**, capture des snapshots **10,34 ms**.
Le coût est nettement supérieur à celui des cartes neuves. Snapshot, configuration
de campagne et mesures brutes sont conservés dans
[`benchmarks/2026-09-19/`](benchmarks/2026-09-19/README.md).
La parité de cette reprise est vérifiée en CI et a été observée dans le vrai navigateur :
après 3 600 ticks, Rust et WASM donnent `f39647185fe5bfbc`.

Les cartes neuves ne représentent que dix minutes de vie initiale. La scène construite
est plus chargée, mais ses 64 copies ne couvrent ni diversité des colonies ni combat
simultané généralisé. Ces mesures locales **ne dimensionnent pas le VPS** ; elles
excluent toujours la RSS Node, le réseau et l'écriture durable des checkpoints.

La boucle `NativeColonies` a aussi été mesurée avec les modules Node compilés et
les écritures disque durables : mêmes 64 colonies, p95 **19,02 ms**, RSS Node
**66,30 Mio**. Le lot qui sauvegarde toutes les cartes atteint **402,25 ms** ;
une sauvegarde explicite prend **368,77 ms**. Ce pic impose d'étaler les échéances
de checkpoint avant le raccordement réseau. Le p95 de la frontière IPC seule
ne représente pas ce coût. Le script et les données `runtime-64.json` sont archivés.

## Raccordement restant

1. Exécuter les bundles de `Room` dans la boucle native avant diffusion, avec le même
   ordre des commandes ; choisir le mode explicitement au démarrage.
2. Faire du hash serveur la référence et fournir ses snapshots aux rejoignants et
   aux clients désynchronisés, y compris quand aucun hôte navigateur ne reste.
3. Retirer gel / avance rapide / demandes de snapshots d'hôte uniquement dans ce mode.
4. Raccorder calendrier, climat, réputation, marchands et caravanes au même ordre
   de ticks ; définir une sauvegarde cohérente du globe et des cartes.
5. Étaler les checkpoints pour éviter les pics d'écriture synchronisés, ajouter le
   binaire à l'image, mesurer le vrai VPS et tester départ du dernier joueur,
   retour, crash, redémarrage et transfert de caravane sans duplication.
