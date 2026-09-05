//! Combattre le feu ne doit plus coûter quarante-huit A\* par colon et par
//! tick.
//!
//! Constat n°6 de `crates/sim-cli/CAMPAIGN-FINDINGS.md` : profil `sample` sur
//! un incendie, **99 % des échantillons** dans `find_job` →
//! `try_start_firefight` → `path_beside_fire` → `path::find_path_for`. Un colon
//! inactif relançait sa recherche **à chaque tick** tant qu'un foyer brûlait
//! dans son rayon, et cette recherche valait jusqu'à six foyers × huit voisines
//! = quarante-huit recherches de chemin. Le même incendie coûtait 0,3 s ou
//! 66 s en `debug` selon que des colons étaient à portée ou non ; les tests
//! statistiques du feu ont dû enfermer les colons dans un enclos de roche pour
//! tourner.
//!
//! Ce qui coûte n'est pas l'A\* qui **aboutit** — il s'arrête sur sa cible —
//! mais celui qui **échoue** : il explore toute la région où se tient le colon
//! avant de rendre `None`. D'où la scène ci-dessous : un réduit de roche
//! hermétique, où alternent colonnes d'arbres en feu et colonnes de terre nue.
//! Les colonnes de terre sont franchissables, ne brûlent pas et jouxtent les
//! flammes : ce sont exactement les voisines que `path_beside_fire` retient…
//! et aucune n'est atteignable. Un foyer de ce réduit est donc le pire cas
//! possible, et il y en a autant qu'on veut.
//!
//! Les trois colons y restent **inactifs**, et il le faut : un colon qui a
//! trouvé des flammes à sa portée les combat et ne cherche plus rien. Le
//! bosquet libre du décor est petit et proche exprès — assez pour prouver que
//! la lutte marche encore, trop petit pour occuper trois colons six cents
//! ticks.
//!
//! Ces tests mesurent du **travail** (`Sim::firefight_paths`, A\* lancés par la
//! lutte), jamais du temps : un chronomètre ne veut rien dire en intégration
//! continue. Ce qu'ils vérifient tient en une phrase — le coût de la lutte par
//! tick ne dépend ni du nombre de foyers, ni de la surface de la carte, et le
//! feu est quand même combattu.

use sim::fire::FIREFIGHT_RETRY;
use sim::testmap::map_from;
use sim::{Feature, Job, Sim, Weather};

/// Cinq secondes de jeu : assez pour que les trois colons éteignent le bosquet
/// libre et relancent ensuite leur recherche des centaines de fois.
const TICKS: u64 = 600;
/// Deux secondes de jeu : la tranche courte, pour la comparaison de surfaces —
/// sur une carte quatre fois plus grande, chaque A\* qui échoue coûte quatre
/// fois plus cher, et la conclusion se lit aussi bien sur deux cents ticks.
const SHORT: u64 = 200;
/// Colons posés par `Sim::from_map`.
const COLONISTS: u64 = 3;
/// `jobs::PATH_ATTEMPTS`, qui n'est pas public : la borne d'essais d'une
/// recherche, foyers et voisines confondus.
const PATH_ATTEMPTS: u64 = 6;

/// Distance des colons au mur du réduit, en cases. Bien à l'intérieur de
/// `fire::FIREFIGHT_RADIUS` (25) : les foyers murés **sont** l'affaire des
/// colons, c'est tout le problème.
const GAP: u32 = 15;
/// Colonnes d'arbres du réduit. Le réduit grandit ensuite en hauteur, pas en
/// largeur : c'est ce qui garde ses foyers dans le rayon de lutte quand on en
/// demande deux cents.
const ROOM_COLS: u32 = 4;
/// Bosquet libre, à quatre cases des colons : deux cases de côté, quatre
/// arbres, atteignables. C'est lui qui prouve qu'accélérer la lutte ne l'a pas
/// arrêtée.
const GROVE: u32 = 2;
const GROVE_GAP: u32 = 4;

/// Carte plate `size × size` de terre nue — l'herbe prendrait feu au-dessus de
/// `GRASS_FIRE_TEMP` et l'incendie sortirait du décor. `Sim::from_map` y pose
/// trois colons au centre. Tout est repéré par rapport à ce centre pour que la
/// même scène tienne à n'importe quelle taille de carte.
///
/// `fires` foyers en tout : `fires` arbres dans le réduit muré, plus les quatre
/// du bosquet libre.
fn scene(size: u32, fires: u32) -> Sim {
    assert!(fires % ROOM_COLS == 0, "réduit incomplet");
    let rows = fires / ROOM_COLS;
    let (cx, cy) = (size / 2, size / 2);
    // Réduit : intérieur en colonnes alternées arbre / terre nue, ceint d'un
    // mur de roche d'une case.
    let x0 = cx + GAP;
    let y0 = cy - rows / 2;
    let room_x = x0..x0 + 2 * ROOM_COLS + 1;
    let room_y = y0..y0 + rows;
    let wall_x = x0 - 1..x0 + 2 * ROOM_COLS + 2;
    let wall_y = y0 - 1..y0 + rows + 1;
    // Bosquet libre, du côté opposé.
    let grove_x = cx - GROVE_GAP - GROVE..cx - GROVE_GAP;
    let grove_y = cy..cy + GROVE;

    let rows_ascii: Vec<String> = (0..size)
        .map(|y| {
            (0..size)
                .map(|x| {
                    if room_x.contains(&x) && room_y.contains(&y) {
                        // Une colonne sur deux porte un arbre ; l'autre reste
                        // de la terre nue, franchissable et hors d'atteinte.
                        if (x - x0) % 2 == 1 { 'T' } else { ',' }
                    } else if wall_x.contains(&x) && wall_y.contains(&y) {
                        '#'
                    } else if grove_x.contains(&x) && grove_y.contains(&y) {
                        'T'
                    } else {
                        ','
                    }
                })
                .collect()
        })
        .collect();
    let refs: Vec<&str> = rows_ascii.iter().map(String::as_str).collect();
    let mut s = Sim::from_map(1, map_from(&refs));
    // Temps sec et stable : ni la pluie ni la foudre ne doivent décider du
    // résultat.
    s.force_weather(Weather::Clear, u64::MAX);
    // Un tick pour que la couche « intérieur » et les colons soient posés.
    s.step(&[]);
    for y in room_y {
        for x in room_x.clone().skip(1).step_by(2) {
            assert!(s.ignite(x, y), "l'arbre muré n'a pas pris ({x}, {y})");
        }
    }
    for y in grove_y {
        for x in grove_x.clone() {
            assert!(s.ignite(x, y), "l'arbre libre n'a pas pris ({x}, {y})");
        }
    }
    assert_eq!(
        s.map().fire_count(),
        fires + GROVE * GROVE,
        "foyers manquants"
    );
    let center = s.colony_center().expect("colonie éteinte");
    assert!(
        sim::map::chebyshev(center, (x0 + 2 * ROOM_COLS - 1, y0 + rows - 1))
            <= sim::fire::FIREFIGHT_RADIUS,
        "le réduit est hors du rayon de lutte, la scène ne mesure rien : {center:?}"
    );
    s
}

/// A\* lancés par la lutte pendant `TICKS` ticks de la scène.
fn paths(size: u32, fires: u32) -> u64 {
    paths_for(size, fires, TICKS)
}

fn paths_for(size: u32, fires: u32, ticks: u64) -> u64 {
    let mut s = scene(size, fires);
    let before = s.firefight_paths();
    for _ in 0..ticks {
        s.step(&[]);
    }
    s.firefight_paths() - before
}

/// Plafond : par colon et par **salve** (un tick sur `FIREFIGHT_RETRY`), la
/// recherche a droit à `PATH_ATTEMPTS` A\*, pas un de plus — et une seule
/// recherche par colon et par salve, `drop_work_for_fire` et `find_job` se
/// partageant la réponse. Mesuré : **461** A\* (40 foyers comme 200) sur les
/// 1 080 permis, contre **10 688** et **11 208** avant correction — et le
/// scénario passe de 49 à 1 153 ticks/s en `release`.
const CEILING: u64 = TICKS * COLONISTS * PATH_ATTEMPTS / FIREFIGHT_RETRY;

#[test]
fn un_foyer_inatteignable_ne_relance_plus_un_a_star_par_tick() {
    let paths = paths(96, 40);
    assert!(
        paths <= CEILING,
        "réduit de 40 foyers : {paths} A* lancés, plafond {CEILING}"
    );
}

#[test]
fn le_cout_de_la_lutte_ne_depend_pas_du_nombre_de_foyers() {
    // Cinq fois plus de foyers murés : avant, la borne d'essais tenait déjà le
    // **nombre** de foyers examinés, mais chacun coûtait ses huit voisines.
    let peu = paths(96, 40);
    let beaucoup = paths(96, 200);
    assert!(
        beaucoup <= peu * 3 / 2,
        "cinq fois plus de foyers ont multiplié la lutte : {peu} → {beaucoup}"
    );
    assert!(
        beaucoup <= CEILING,
        "réduit de 200 foyers : {beaucoup} A* lancés, plafond {CEILING}"
    );
}

#[test]
fn le_cout_de_la_lutte_ne_depend_pas_de_la_surface() {
    // Quatre fois la surface (96×96 → 192×192). Le compteur ne voit pas le
    // prix d'un A\*, seulement leur nombre — mais c'est bien la surface qui
    // fait ce prix quand la recherche échoue, puisqu'elle explore toute la
    // région du colon avant de rendre `None`. C'est aussi pour cela que cette
    // comparaison-là tourne sur `SHORT` ticks et non `TICKS` : sur 192×192,
    // chaque A\* qui échoue explore 36 864 cases, et le test en `debug` y
    // passerait plus d'une minute pour la même conclusion.
    let petite = paths_for(96, 40, SHORT);
    let grande = paths_for(192, 40, SHORT);
    assert!(
        grande <= petite * 3 / 2,
        "quadrupler la surface a multiplié la lutte : {petite} → {grande}"
    );
}

#[test]
fn le_feu_est_quand_meme_combattu() {
    // Le garde-fou du lot : borner la recherche ne doit pas empêcher les
    // colons d'aller battre les flammes qu'ils peuvent atteindre.
    let mut s = scene(96, 40);
    let (cx, cy) = (48, 48);
    let grove_x = cx - GROVE_GAP - GROVE..cx - GROVE_GAP;
    let grove_y = cy..cy + GROVE;
    let mut fought = false;
    for _ in 0..TICKS {
        s.step(&[]);
        fought |= s
            .pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Firefight { .. }));
    }
    assert!(fought, "aucun colon n'est parti battre les flammes");
    // Une case éteinte, c'est un arbre du bosquet libre qui ne brûle plus et
    // qui est encore debout : `FIRE_BURN_TICKS` (900) dépasse la durée du
    // test, aucun foyer ne s'éteint donc de lui-même.
    let saved = grove_y
        .flat_map(|y| grove_x.clone().map(move |x| (x, y)))
        .filter(|&(x, y)| s.map().fire_at(x, y) == 0 && s.map().feature(x, y) == Feature::Tree)
        .count();
    assert!(saved > 0, "aucun foyer du bosquet libre n'a été éteint");
}

#[test]
fn le_compteur_de_mesure_ne_touche_pas_a_letat() {
    // `Sim::firefight_paths` compte du travail, pas de l'état : deux sims
    // arrivées au même endroit restent égales et de même hash, et un
    // aller-retour de snapshot ne fait pas revenir le compteur.
    let mut a = scene(96, 40);
    for _ in 0..300 {
        a.step(&[]);
    }
    let b = Sim::restore(&a.snapshot()).expect("snapshot relisible");
    assert_eq!(a.state_hash(), b.state_hash());
    assert_eq!(a, b);
    assert!(a.firefight_paths() > 0);
    assert_eq!(
        b.firefight_paths(),
        0,
        "le compteur ne sort pas du snapshot"
    );
}
