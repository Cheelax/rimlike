# Mesures locales du moteur natif — 19 septembre 2026

Mesures via Node → stdin/stdout encadrés → Rust release, WSL Linux local,
16 processeurs logiques, environ 16 Gio de RAM. D'autres campagnes CPU tournaient
en parallèle. Aucune extrapolation de capacité VPS.

| Données brutes | Scénario | Cartes | Ticks/carte | Lot global p95 | RSS Rust finale |
|---|---|---:|---:|---:|---:|
| [fresh-16.json](fresh-16.json) | neuves 128×128, K30 | 16 | 1 200 | 0,94 ms | 4,63 Mio |
| [fresh-64.json](fresh-64.json) | neuves 128×128, K30 | 64 | 36 000 | 0,56 ms | 10,75 Mio |
| [raid-64.json](raid-64.json) | même veille 64×64, K30, 3 colons/6 pillards | 64 | 20 000 | 0,55 ms | 4,75 Mio |
| [mature-64.json](mature-64.json) | même colonie construite 64×64, K30, 10 colons | 64 | 3 600 | 5,83 ms | 5,5 Mio |

Chaque lot fait avancer **toutes** les cartes de trois ticks. Budget à 60 ticks/s :
50 ms pour ce lot global. Les durées sont mesurées après chaque aller-retour IPC,
pas seulement à l'intérieur de Rust. La capture des snapshots est mesurée séparément ;
elle n'inclut pas leur écriture sur disque. La RSS n'inclut pas Node.

## Colonie construite

[`mature-seed1.bin`](mature-seed1.bin) est un snapshot postcard de la graine 1 après
30 jours avec le joueur scripté présent : dix colons, un animal apprivoisé,
enceinte, trois technologies, richesse 2 985, neuf raids reçus.
[`mature-seed1-campaign.json`](mature-seed1-campaign.json) en conserve le bilan.

Créé au seuil 150, avec pillage, avant le correctif de recherche d'abri éloigné.
La mesure `mature-64.json` et le test de reprise utilisent le moteur corrigé.
Il s'agit d'un état initial reproductible, pas d'une nouvelle campagne d'équilibrage.

```bash
cargo +1.88.0 run -p sim-cli --release -- campaign --seed 1 --seeds 1 --days 30 --size 64 --day-scale 30 --json --snapshot-out /tmp/colonie-jour30.bin
pnpm bench:native -- --maps 64 --ticks 3600 --batch 3 --snapshot ../../docs/benchmarks/2026-09-19/mature-seed1.bin
```

Le premier appel sert à produire **une nouvelle** colonie sur le code courant ;
pour reproduire exactement la mesure archivée, réutiliser le snapshot fourni.
Les chemins relatifs de `--snapshot` partent de `apps/server`, cwd du script pnpm.

Le test `apps/client/test/native-process-parity.test.ts` charge ce snapshot dans le
vrai processus natif et dans WASM, avance 3 600 ticks, puis compare leurs hashes.
La même opération dans le navigateur a donné :
`568549c66d8b8c79` au tick 12 960 000,
`f39647185fe5bfbc` au tick 12 963 600, dix colons dans les deux cas.

## Boucle réelle et disque

[`runtime-64.json`](runtime-64.json) mesure la classe `NativeColonies` complète :
64 reprises de la colonie construite, 1 200 lots de trois ticks, écritures atomiques
et fsync. Le script [`bench-runtime.mjs`](bench-runtime.mjs) utilise les modules
Node compilés et un répertoire temporaire distinct des sauvegardes utilisateur.

- Restauration des 64 cartes : **78,4 ms**.
- 3 600 ticks par carte : **14,16 s** ; lot global p50 **12,55 ms**, p95 **19,02 ms**.
- Un seul lot dépasse 50 ms : **402,25 ms**, au checkpoint commun des 64 cartes.
- Une sauvegarde explicite des 64 cartes : **368,77 ms**.
- RSS Node finale : **66,30 Mio**, non additionnée à une mesure Rust simultanée.
- Tick final 12 963 600, hash `f39647185fe5bfbc`, également retrouvés sur disque.

Cette mesure est plus proche de la future boucle serveur que le benchmark IPC
qui envoie ses requêtes ensemble. Elle révèle un problème concret de cadence :
les échéances de checkpoints des cartes restaurées au même tick sont alignées.
Il faut étaler ces écritures avant le raccordement réseau ; le p95 seul masque
ce pic. Le banc avance manuellement sans attendre les pulses et ne mesure donc
pas directement un nombre de pulses sautés. En horloge réelle, une opération
en cours fait ignorer les pulses suivants, sans créer une file infinie.

```bash
pnpm build:native
pnpm --filter server run build:server
node docs/benchmarks/2026-09-19/bench-runtime.mjs
```

Le contrôle [`clock-64.json`](clock-64.json) utilise ensuite la vraie horloge
pendant **63 secondes**, sans joueur, avec le checkpoint par défaut à 3 600 ticks :
**3 744 ticks** avancés par colonie, **sept pulses sautés**, puis les 64 fichiers
retrouvés au tick **12 967 344** et au hash **793b3add25bb2d6b**. Le retard est
observable, sans accumulation d'une file de travail ; les colonies ne se
désynchronisent pas entre elles dans cet essai. Cela confirme concrètement la nécessité
d'étaler les sauvegardes, même quand le coût usuel de simulation tient le budget.

## Limites

Les 64 colonies construites sont des copies du même état ; pas 64 histoires
différentes. Une minute de simulation sans combat en cours ne couvre ni une ville
très étendue, ni un raid simultané sur chaque carte, ni la concurrence avec le réseau
et le disque. Les premiers benchmarks précèdent le correctif d'abri éloigné, la
mesure construite le suit. Les données restent utiles pour mesurer la frontière
native et choisir les prochains scénarios, pas pour annoncer une capacité commerciale.
