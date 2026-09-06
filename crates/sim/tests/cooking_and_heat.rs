//! Deux corrections indépendantes, réunies parce qu'elles viennent du même
//! ménage : la cuisine garde son poste (`CAMPAIGN-FINDINGS.md`, §3, « Ce qui
//! reste »), et un colon en nage retire enfin son manteau (`docs/PLAN.md`,
//! phase 5, « pas de gestion de la chaleur excessive »).
//!
//! ## Cuisine
//!
//! `try_start_cook` retenait son feu de camp **sans vérifier qu'un chemin y
//! menait** — le seul des travaux à poste qui gardait ce défaut
//! (dépeçage, fabrication, recherche, chasse et réarmement l'ont perdu le
//! 2026-09-06). Un colon partait chercher son vivre cru, le ramassait,
//! découvrait le mur dans `do_cook`, le reposait — et recommençait au tick
//! suivant. La correction applique le même patron que `try_start_butcher` :
//! le feu est vérifié **au démarrage** (`Sim::reach_station`), un budget borne
//! les candidats examinés, et `jobs::RETRY_TICKS` espace les essais du colon
//! qui tourne à vide. Elle change le hash du scénario `demo` — c'est le prix
//! assumé de corriger le dernier de ces travaux.
//!
//! ## Chaleur excessive
//!
//! Au-dessus de `climate::UNDRESS_ABOVE` pendant `climate::UNDRESS_TICKS`
//! d'affilée, un colon retire son habit et le laisse tomber au sol — il ne
//! le reprend que si le ressenti retombe sous `climate::DRESS_TEMP`, via le
//! job d'habillage déjà en place. Les deux seuils sont assez loin l'un de
//! l'autre (26 °C contre 6 °C) pour qu'aucun colon n'oscille entre les deux.

use sim::climate::{HOT_MOOD_TEMP, UNDRESS_TICKS};
use sim::farm::{MEALS_TARGET, RAW_PER_MEAL};
use sim::jobs::RETRY_TICKS;
use sim::testmap::map_from;
use sim::{Climate, Command, Feature, ItemKind, Job, Map, Pawn, Sim, Zone};

const DAY: u64 = sim::TICKS_PER_DAY as u64;

fn run_until(s: &mut Sim, max: u64, mut pred: impl FnMut(&Sim) -> bool) -> bool {
    for _ in 0..max {
        if pred(s) {
            return true;
        }
        s.step(&[]);
    }
    pred(s)
}

/// Les colons de la colonie, bêtes apprivoisées exclues (voir
/// `Pawn::is_colonist`).
fn colonists(s: &Sim) -> Vec<Pawn> {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist())
        .cloned()
        .collect()
}

/// Carte plate `size × size`, en terre nue : au-dessus de
/// `fire::GRASS_FIRE_TEMP`, de l'herbe prendrait feu et brouillerait la
/// mesure (voir `tests/jobs_perf.rs`).
fn flat_map(size: u32) -> Map {
    let rows: Vec<String> = (0..size).map(|_| ",".repeat(size as usize)).collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    map_from(&refs)
}

// ----------------------------------------------------------------------
// Cuisine : le feu de camp vérifié avant de partir chercher le vivre
// ----------------------------------------------------------------------

/// Côté intérieur du réduit muré.
const ROOM: u32 = 5;
/// Distance du réduit au centre de la carte, en cases.
const GAP: u32 = 10;
/// Colons posés par `Sim::from_map`.
const COLONISTS: u64 = 3;
/// `jobs::PATH_ATTEMPTS`, qui n'est pas public : les candidats qu'une
/// recherche a le droit d'examiner, feux et vivres confondus.
const PATH_ATTEMPTS: u64 = 6;
/// Voisines d'une case : le feu muré coûte ses huit voisines pour être
/// démontré hors d'atteinte, une fois par salve.
const NEIGHBOURS: u64 = 8;
/// Un seul feu de camp dans la scène, et une seule recherche bornée active
/// (la cuisine : pas d'établi, pas de gibier marqué, pas de poste de
/// fabrication).
const STATIONS: u64 = 1;
const SEARCHES: u64 = 1;
/// Cinq secondes de jeu : assez pour que les trois colons relancent leur
/// recherche des dizaines de fois (voir `tests/jobs_perf.rs`).
const TICKS: u64 = 600;
/// Même plafond que `tests/jobs_perf.rs` : par colon et par salve, la
/// recherche examine le feu muré une fois (ses huit voisines) et n'a plus
/// droit qu'à ses `PATH_ATTEMPTS` essais pour la suite.
///
/// Mesuré : **39** A\* sur les 840 permis.
const CEILING: u64 =
    TICKS * COLONISTS * SEARCHES * (STATIONS * NEIGHBOURS + PATH_ATTEMPTS) / RETRY_TICKS;

/// Un feu de camp seul dans un réduit muré (ses huit voisines sont
/// franchissables et pourtant hors d'atteinte), et un tas de vivres crus bien
/// en vue, loin du réduit.
fn walled_campfire_scene(size: u32) -> Sim {
    let mut s = Sim::from_map(1, flat_map(size));
    let (cx, cy) = (size / 2, size / 2);
    let x0 = cx + GAP;
    let y0 = cy - ROOM / 2;
    for y in y0 - 1..y0 + ROOM + 1 {
        for x in x0 - 1..x0 + ROOM + 1 {
            let inside = (x0..x0 + ROOM).contains(&x) && (y0..y0 + ROOM).contains(&y);
            if !inside {
                s.map_mut().set_feature(x, y, Feature::Rock);
            }
        }
    }
    s.map_mut()
        .set_feature(x0 + ROOM / 2, y0 + ROOM / 2, Feature::Campfire);
    assert_eq!(s.map().campfire_count(), 1, "feu de camp manquant");
    // Bien plus qu'un repas (`RAW_PER_MEAL`), pour que la pile ne s'épuise
    // jamais d'elle-même pendant la mesure.
    s.spawn_item(ItemKind::Berries, 8 * RAW_PER_MEAL, cx, cy + 2);
    s
}

#[test]
fn cooking_checks_the_station_before_picking_ingredients() {
    let mut s = walled_campfire_scene(40);
    let before_paths = s.job_paths();
    let initial_berries = s.colony_total(ItemKind::Berries);
    for tick in 0..TICKS {
        s.step(&[]);
        // La preuve directe : si le feu était retenu sans vérification, un
        // colon entrerait en `Job::Cook`, ramasserait le vivre, puis
        // l'abandonnerait en découvrant le mur. Avec la vérification au
        // démarrage, ce job ne devrait jamais être assigné dans cette scène.
        assert!(
            !s.pawns().iter().any(|p| matches!(p.job, Job::Cook { .. })),
            "un colon est parti cuisiner vers un feu muré, tick {tick}"
        );
        assert_eq!(
            s.colony_total(ItemKind::Berries),
            initial_berries,
            "un vivre a été ramassé puis reposé, tick {tick}"
        );
    }
    let paths = s.job_paths() - before_paths;
    assert!(
        paths <= CEILING,
        "feu muré : {paths} A* lancés par la recherche de travail, plafond {CEILING}"
    );
}

#[test]
fn cooking_still_works_when_the_campfire_is_reachable() {
    let mut s = Sim::from_map(2, flat_map(24));
    s.map_mut().set_feature(12, 12, Feature::Campfire);
    s.spawn_item(ItemKind::Berries, 8 * RAW_PER_MEAL, 10, 10);
    assert!(
        run_until(&mut s, 3 * DAY, |s| s
            .items()
            .iter()
            .any(|i| i.kind == ItemKind::Meal && i.count > 0)),
        "la cuisine n'a rien produit avec un feu atteignable : {:?}",
        s.items()
    );
    assert!(
        s.colony_total(ItemKind::Meal) <= MEALS_TARGET + RAW_PER_MEAL,
        "la cuisine a largement dépassé son objectif : {}",
        s.colony_total(ItemKind::Meal)
    );
}

// ----------------------------------------------------------------------
// Chaleur excessive : se découvrir, et se rhabiller si le froid revient
// ----------------------------------------------------------------------

/// Habille trois colons de manteaux dans un froid glacial — un stockage
/// déjà garni, pas une fabrication : ce n'est pas ce que ces tests mesurent —
/// puis impose le climat demandé. Les trois vivent en plein air, sans pièce
/// ni feu : le ressenti est directement `outdoor_temperature()` plus
/// l'isolation du manteau.
fn dressed_colonists(seed: u64, climate_after: Climate) -> Sim {
    let mut s = Sim::from_map_with_climate(seed, flat_map(32), Climate::new(-150, 0));
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 14,
        y0: 14,
        x1: 17,
        y1: 17,
    }]);
    s.spawn_item(ItemKind::Coat, 3, 15, 15);
    assert!(
        run_until(&mut s, DAY, |s| colonists(s)
            .iter()
            .all(|p| p.apparel == Some(ItemKind::Coat))),
        "graine {seed} : un colon n'a pas endossé son manteau au grand froid : {:?}",
        colonists(&s).iter().map(|p| p.apparel).collect::<Vec<_>>()
    );
    s.step(&[Command::SetClimate {
        base_temperature: climate_after.base_temperature,
        amplitude: climate_after.amplitude,
    }]);
    s
}

/// Statistique sur dix graines : après trois jours de canicule forcée
/// (`Climate::new(300, 0)`, aucun écart saisonnier), plus aucun colon ne
/// porte de manteau.
#[test]
fn colonists_undress_in_the_heat() {
    for seed in 1..=10u64 {
        let mut s = dressed_colonists(seed, Climate::new(300, 0));
        for _ in 0..3 * DAY {
            s.step(&[]);
        }
        let apparel: Vec<Option<ItemKind>> = colonists(&s).iter().map(|p| p.apparel).collect();
        assert!(
            apparel.iter().all(Option::is_none),
            "graine {seed} : encore couvert après trois jours de canicule : {apparel:?}"
        );
    }
}

/// Même mesure, climat glacial (`Climate::new(-100, 0)`) : personne ne
/// retire rien.
#[test]
fn colonists_keep_their_coat_in_the_cold() {
    for seed in 1..=10u64 {
        let mut s = dressed_colonists(seed, Climate::new(-100, 0));
        for _ in 0..3 * DAY {
            s.step(&[]);
        }
        let apparel: Vec<Option<ItemKind>> = colonists(&s).iter().map(|p| p.apparel).collect();
        assert!(
            apparel.iter().all(|a| *a == Some(ItemKind::Coat)),
            "graine {seed} : un manteau a disparu par grand froid : {apparel:?}"
        );
    }
}

/// La raison d'être de la règle : moins de chaleur excessive, pas seulement
/// moins de manteaux.
///
/// Témoin propre plutôt qu'un interrupteur ajouté au sim pour l'occasion :
/// **le même colon, le même run**, avant et après qu'il se soit découvert.
/// La phase « habillé » (les six cents premiers ticks après le basculement en
/// climat chaud, `UNDRESS_TICKS`) est exactement ce que le sim faisait hier
/// — le manteau reste porté par forte chaleur ; la phase « déshabillé », qui
/// suit, est la règle nouvelle. Le ressenti est identique pour les trois
/// colons (plein air, pas de pièce) : les compter tous les trois ne fait que
/// grossir l'échantillon.
#[test]
fn undressing_reduces_heat_injuries() {
    let mut s = dressed_colonists(1, Climate::new(300, 0));
    let mut dressed_ticks: u64 = 0;
    let mut dressed_hot_ticks: u64 = 0;
    let mut undressed_ticks: u64 = 0;
    let mut undressed_hot_ticks: u64 = 0;
    for _ in 0..2 * DAY {
        s.step(&[]);
        for p in colonists(&s) {
            let excessive = p.comfort > HOT_MOOD_TEMP;
            if p.apparel.is_some() {
                dressed_ticks += 1;
                dressed_hot_ticks += u64::from(excessive);
            } else {
                undressed_ticks += 1;
                undressed_hot_ticks += u64::from(excessive);
            }
        }
    }
    assert!(dressed_ticks > 0, "aucun tick habillé mesuré");
    assert!(undressed_ticks > 0, "aucun tick déshabillé mesuré");
    // Taux pour mille, en entiers : la comparaison des deux phases n'a pas
    // besoin d'un seul flottant.
    let dressed_rate = dressed_hot_ticks * 1000 / dressed_ticks;
    let undressed_rate = undressed_hot_ticks * 1000 / undressed_ticks;
    assert!(
        undressed_rate < dressed_rate,
        "le déshabillage ne réduit pas la chaleur excessive : habillé {dressed_hot_ticks}/{dressed_ticks} ({dressed_rate}‰) contre déshabillé {undressed_hot_ticks}/{undressed_ticks} ({undressed_rate}‰)"
    );
}

/// Un colon déshabillé par la chaleur reprend son manteau si le froid
/// revient : le job d'habillage existant (`Sim::try_start_wear`) le reprend
/// au sol ou en stock, comme n'importe quel habit quitté. Le retour du froid
/// est simulé par `Command::SetClimate` — le même mécanisme qu'utilise une
/// vraie nuit d'hiver pour faire chuter le ressenti, en plus rapide et sans
/// dépendre de l'heure où le test démarre.
#[test]
fn undressed_colonists_dress_again_at_night_if_cold() {
    let mut s = dressed_colonists(1, Climate::new(300, 0));
    assert!(
        run_until(&mut s, 2 * u64::from(UNDRESS_TICKS), |s| colonists(s)
            .iter()
            .all(|p| p.apparel.is_none())),
        "un colon garde son manteau malgré la chaleur : {:?}",
        colonists(&s).iter().map(|p| p.apparel).collect::<Vec<_>>()
    );
    s.step(&[Command::SetClimate {
        base_temperature: -120,
        amplitude: 0,
    }]);
    assert!(
        run_until(&mut s, DAY, |s| colonists(s)
            .iter()
            .all(|p| p.apparel == Some(ItemKind::Coat))),
        "un colon déshabillé n'a pas repris son manteau au retour du froid : {:?}",
        colonists(&s).iter().map(|p| p.apparel).collect::<Vec<_>>()
    );
}
