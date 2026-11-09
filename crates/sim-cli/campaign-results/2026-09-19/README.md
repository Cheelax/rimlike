# Campagnes du 19 septembre 2026

Données brutes du §17 de [CAMPAIGN-FINDINGS.md](../../CAMPAIGN-FINDINGS.md).
Fichiers conservés sans retoucher les résultats. Les durées reflètent la machine WSL
locale et plusieurs campagnes simultanées ; elles ne dimensionnent pas un serveur.

## Protocole

Graines **1 à 30**, carte **64×64**, **30 jours**, forêt tempérée (biome 4),
difficulté normale (2), calendrier initial 0 (printemps puis été), climat par défaut.
K=1 : 432 000 ticks par graine ; K=30 : 12 960 000. Dans le mode absent,
plus aucun ordre du joueur scripté à partir de **8 × ticks_per_day()**.
La colonne `enclosed_at_absence` est relevée juste avant le premier tick sans ordre.

```bash
cargo +1.88.0 run -p sim-cli --release -- campaign --seed 1 --seeds 30 --days 30 --size 64 --day-scale 1 --json
cargo +1.88.0 run -p sim-cli --release -- campaign --seed 1 --seeds 30 --days 30 --size 64 --day-scale 1 --absent-from 8 --json
# Même paire avec --day-scale 30.
```

Les anciennes sorties omettent `first_seed` et `day_scale` ; leur nom et les
commandes ci-dessus donnent ces paramètres. Les sorties finales les portent.

## Provenance

- `baseline-k*-*.json` : révision **9cb635e**, avant prévenance et décision tactique,
  mais avec le harnais `--absent-from`. Worktree détaché, compilation release propre.
- `threshold-{80,100,120,150}-*.json` : première courbe K=1, base **9e8412f**
  avec `threshold-source.patch`. Le patch porte la valeur 80 ; changer seulement
  `HOLD_RATIO_PERCENT` pour reproduire les autres points. Cette passe précède les
  derniers correctifs de chemins et le pillage ; ne pas la confondre avec la version finale.
  Le point 100 provient de la **reprise confirmée**, après détection d'un premier
  essai dont le binaire était resté à 120. Cet essai mal étiqueté n'est pas archivé.
- `defense-k*-*.json` : correction complète des portes et du confinement, seuil 150,
  **avant pillage**. Mesures intermédiaires sur un binaire figé ; leur patch exact
  n'a pas été conservé séparément. Elles servent à isoler le constat antérieur,
  pas à prétendre que les deux versions ont des trajectoires aléatoires identiques.
- `pillage-k*-*.json` : prévenance, défense, portes fermées et pillage final, seuil 150.
  Base **9e8412f** avec `pillage-source.patch`, figé avant la calibration suivante.
- `ratio{200,250}-k*-*.json` : même base de pillage, avec le seul seuil remplacé
  respectivement par 200 ou 250. Les binaires sont copiés avant chaque campagne :
  une recompilation parallèle ne change jamais le programme d'une mesure en cours.
  `calibration-status.json` indique lesquels sont allés au bout et lesquels ont été
  arrêtés à la fin du créneau. Une ligne non achevée ne fournit aucun résultat de campagne.
- `shelter-k*-*.json` : version finale, seuil 150, avec retour vers une enceinte
  éloignée du barycentre. Base **9e8412f** avec `shelter-source.patch`.
  `shelter-trace-seed17.log/json` rejoue la graine qui a révélé ce défaut.
  `shelter-trace-seed26.log/json` reproduit les famines restantes ; son bilan est
  identique à la graine 26 de la campagne complète, hors durée d'exécution.
  Les deux campagnes finales K=30 sont exécutées par graine, dans un pool commun
  de huit processus. Les 60 fichiers dans `shelter-k30-parts/` sont les sorties
  unitaires intactes ; `merge-parallel.py` les valide et les agrège. Les graines
  restent indépendantes et utilisent le même binaire. `elapsed_ms` est le temps
  mural partagé du pool ; `execution.sum_part_ms` additionne les temps unitaires.
- `trace-seed*.log/json` : diagnostic de graines individuelles au seuil 150,
  K=30, absent depuis le jour 8. Mêmes paramètres, seuls `--seed S --seeds 1 --trace`
  changent. Les traces sont sur stderr, le JSON reste séparé.

Les patches sont des états de mesure, **pas des patches à appliquer au checkout
courant**. Pour reproduire, créer un worktree détaché sur 9e8412f et appliquer
le patch voulu dans ce worktree. Ils couvrent le code nécessaire à la campagne,
pas l'ensemble du client ni le chantier natif.

## Comparaison automatique

Depuis la racine du dépôt :

```bash
# Vérifier la fusion des 60 parties K=30, sans modifier les fichiers :
python3 crates/sim-cli/campaign-results/2026-09-19/merge-parallel.py --wall-ms 719659 --check

node crates/sim-cli/scripts/compare-campaigns.mjs \
  crates/sim-cli/campaign-results/2026-09-19/baseline-k1-present.json \
  crates/sim-cli/campaign-results/2026-09-19/baseline-k1-absent.json \
  crates/sim-cli/campaign-results/2026-09-19/shelter-k1-present.json \
  crates/sim-cli/campaign-results/2026-09-19/shelter-k1-absent.json \
  --legacy-day-scale 1
```

Remplacer K=1 par K=30 pour la cadence du monde. Code 1 signifie qu'un objectif
mesuré échoue, pas que le comparateur est cassé. Les comparaisons JSON conservent
le détail par graine et la cohorte murée commune aux deux versions.

**Lecture des pertes :** `deaths_absent` compte tous les décès après départ,
quelle que soit leur cause. `stolen_units_absent` compte seulement les charges
emportées au bord par des pillards vivants. Le stock extérieur final moins initial
inclut récoltes, rangement, consommation et incendies ; son contraire est une
baisse nette, jamais un compteur de vol. Une absence de champ de vol dans un
ancien fichier signifie « non instrumenté », pas zéro.

`SHA256SUMS` permet de vérifier l'intégrité des données et patches archivés.
