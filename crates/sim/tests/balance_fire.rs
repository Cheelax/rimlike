//! Équilibrage du feu : combien de bois part réellement en fumée, et selon
//! quel temps.
//!
//! Ces tests-là ne vérifient pas un mécanisme (c'est le rôle de
//! `tests/fire.rs`), ils **mesurent une distribution** sur vingt graines,
//! comme `first_raid_is_dangerous_but_survivable` le fait pour les raids. La
//! règle « on mesure avant de régler » (`AGENTS.md`) vit ici : toute retouche
//! des constantes de `sim::fire` doit relancer ce fichier et reporter les
//! chiffres dans `crates/sim-cli/CAMPAIGN-FINDINGS.md` §6.
//!
//! La scène est la même partout : un **bosquet dense de 20×20 arbres** posé
//! sur de la terre nue, allumé en son centre, et laissé brûler jusqu'au bout.
//! La terre nue autour isole la mesure : ce qui brûle est ce que le bosquet
//! s'est transmis à lui-même, jamais ce que l'herbe alentour a rapporté —
//! l'herbe ne prend qu'au-dessus de `GRASS_FIRE_TEMP` et fausserait la
//! comparaison chaud / froid.
//!
//! Les trois colons naissent au centre de la carte, **enfermés dans un enclos
//! de roche**. Ce n'est pas de la cruauté, c'est ce qui rend le test
//! mesurable et rapide : leur barycentre ne bouge plus, le bosquet reste donc
//! toujours au-delà de `FIREFIGHT_RADIUS`, personne ne vient éteindre, et
//! surtout `fire_to_fight` s'arrête au filtre de distance. Sans l'enclos, les
//! colons dérivent, le bosquet entre dans leur rayon et chaque colon inactif
//! relance jusqu'à quarante-huit A\* **par tick** : mesuré, le même incendie
//! passe de 0,3 à 66 secondes en `debug`.
//!
//! Le climat est imposé sans amplitude saisonnière : la température annoncée
//! est celle qu'il fait, à la courbe journalière près (±4 °C).

use sim::fire::FIREFIGHT_RADIUS;
use sim::testmap::map_from;
use sim::{Climate, Command, EventKind, Feature, Sim, Weather};

/// Carte : assez large pour que l'enclos des colons, au centre, reste à plus
/// de `FIREFIGHT_RADIUS` du bord droit du bosquet.
const WIDTH: u32 = 104;
const HEIGHT: u32 = 28;
/// Côté du bosquet, en cases : 400 arbres au total.
const SIDE: u32 = 20;
/// Coin haut-gauche du bosquet.
const X0: u32 = 2;
const Y0: u32 = 4;
/// Enclos de roche : mur de `PEN_LOW..=PEN_HIGH` en x comme en y, cœur de
/// terre nue à l'intérieur. Le centre de la carte (52, 14) tombe dedans, donc
/// `spawn_starting_pawns` y pose les trois colons.
const PEN_LOW: (u32, u32) = (49, 11);
const PEN_HIGH: (u32, u32) = (55, 17);
/// Arbres du bosquet.
const TREES: u32 = SIDE * SIDE;
/// Graines mesurées. Vingt, comme les autres tests statistiques du dépôt.
const SEEDS: u64 = 20;
/// Un incendie de bosquet dure quelques milliers de ticks ; au-delà, c'est que
/// quelque chose ne s'éteint pas.
const MAX_TICKS: u64 = 60_000;

/// Plein été : 30 °C.
const HOT: i32 = 300;
/// Froid mais sec : moyenne à 0 °C, soit −4 à +4 °C sur la journée. Il gèle
/// une partie de la nuit, il ne tombe rien.
const COLD: i32 = 0;
/// Le climat de la campagne froide : −5 °C, il gèle en permanence.
const FROZEN: i32 = -50;

/// La case est-elle un mur de l'enclos ?
fn pen_wall(x: u32, y: u32) -> bool {
    let inside = (PEN_LOW.0..=PEN_HIGH.0).contains(&x) && (PEN_LOW.1..=PEN_HIGH.1).contains(&y);
    let core = (PEN_LOW.0 + 1..PEN_HIGH.0).contains(&x) && (PEN_LOW.1 + 1..PEN_HIGH.1).contains(&y);
    inside && !core
}

/// Bosquet de `SIDE`×`SIDE` arbres sur une carte de terre nue, enclos des
/// colons au centre, climat et météo imposés.
fn grove(seed: u64, base_temperature: i32, weather: Weather) -> Sim {
    let rows: Vec<String> = (0..HEIGHT)
        .map(|y| {
            (0..WIDTH)
                .map(|x| {
                    if (X0..X0 + SIDE).contains(&x) && (Y0..Y0 + SIDE).contains(&y) {
                        'T'
                    } else if pen_wall(x, y) {
                        '#'
                    } else {
                        ','
                    }
                })
                .collect()
        })
        .collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    let mut s =
        Sim::from_map_with_climate(seed, map_from(&refs), Climate::new(base_temperature, 0));
    s.force_weather(weather, u64::MAX);
    s
}

/// Allume le cœur du bosquet et laisse faire jusqu'à extinction complète.
/// Renvoie le nombre d'arbres consumés.
fn burn_grove(seed: u64, base_temperature: i32, weather: Weather) -> u32 {
    let mut s = grove(seed, base_temperature, weather);
    // Les colons sont dans l'enclos : leur barycentre ne peut pas s'approcher
    // du bosquet de plus de la moitié du côté de l'enclos.
    let center = s.colony_center().expect("colonie éteinte");
    assert!(
        (PEN_LOW.0..=PEN_HIGH.0).contains(&center.0)
            && (PEN_LOW.1..=PEN_HIGH.1).contains(&center.1),
        "les colons ne sont pas nés dans l'enclos ({center:?})"
    );
    assert!(
        sim::map::chebyshev((PEN_LOW.0, center.1), (X0 + SIDE - 1, Y0 + SIDE / 2))
            > FIREFIGHT_RADIUS,
        "le bosquet est à portée des colons : ils viendraient l'éteindre"
    );
    s.step(&[Command::Ignite {
        x: X0 + SIDE / 2,
        y: Y0 + SIDE / 2,
    }]);
    // Le tick de l'ordre est aussi un tick d'évaluation : sous la pluie, la
    // case peut être éteinte dans le même souffle. C'est l'événement qui dit
    // que l'ordre a porté, pas le compteur de feux.
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::FireStarted && e.arg == sim::fire::CAUSE_ORDER),
        "graine {seed} : l'ordre n'a rien allumé"
    );
    let mut ticks = 0;
    while s.map().fire_count() > 0 && ticks < MAX_TICKS {
        s.step(&[]);
        ticks += 1;
    }
    assert_eq!(
        s.map().fire_count(),
        0,
        "graine {seed} : le bosquet brûle encore après {MAX_TICKS} ticks"
    );
    let mut burned = 0;
    for y in Y0..Y0 + SIDE {
        for x in X0..X0 + SIDE {
            if s.map().feature(x, y) != Feature::Tree {
                burned += 1;
            }
        }
    }
    burned
}

/// Les vingt mesures triées, et leur médiane.
fn distribution(base_temperature: i32, weather: Weather) -> (Vec<u32>, u32) {
    let mut v: Vec<u32> = (1..=SEEDS)
        .map(|seed| burn_grove(seed, base_temperature, weather))
        .collect();
    v.sort_unstable();
    let median = (v[v.len() / 2 - 1] + v[v.len() / 2]) / 2;
    (v, median)
}

fn percent(tiles: u32) -> u32 {
    tiles * 100 / TREES
}

/// Bande visée pour un feu de forêt livré à lui-même : assez pour faire mal,
/// pas de quoi remettre la carte à zéro.
const BAND_LOW: u32 = TREES * 15 / 100;
const BAND_HIGH: u32 = TREES * 60 / 100;

fn report(label: &str, v: &[u32], median: u32) {
    let in_band = v
        .iter()
        .filter(|&&b| (BAND_LOW..=BAND_HIGH).contains(&b))
        .count();
    println!(
        "{label} : médiane {median} ({} %), min {} ({} %), max {} ({} %), \
         {in_band}/{SEEDS} graines dans 15-60 % — {v:?}",
        percent(median),
        v[0],
        percent(v[0]),
        v[v.len() - 1],
        percent(v[v.len() - 1]),
    );
}

// ----------------------------------------------------------------------
// Été : dangereux, mais pas une remise à zéro de la carte
// ----------------------------------------------------------------------

#[test]
fn summer_wildfire_eats_a_share_of_the_grove_not_all_of_it() {
    let (v, median) = distribution(HOT, Weather::Clear);
    report("été 30 °C", &v, median);
    let in_band = v
        .iter()
        .filter(|&&b| (BAND_LOW..=BAND_HIGH).contains(&b))
        .count();
    assert!(
        (BAND_LOW..=BAND_HIGH).contains(&median),
        "médiane {median} arbres ({} %) hors de la bande 15-60 % visée",
        percent(median)
    );
    // Mesuré 17 graines sur 20 ; la borne est à « la majorité », pour que le
    // test tienne quand un autre réglage décale la suite de tirages.
    assert!(
        in_band > SEEDS as usize / 2,
        "seulement {in_band} graines sur {SEEDS} brûlent 15 à 60 % du bosquet : {v:?}"
    );
    // Mesuré 168 arbres (42 %) au pire.
    assert!(
        v[v.len() - 1] <= BAND_HIGH,
        "la pire graine rase {} % du bosquet : le feu ne s'arrête plus tout seul",
        percent(v[v.len() - 1])
    );
}

// ----------------------------------------------------------------------
// Froid sec : moins vite, mais le feu existe encore
// ----------------------------------------------------------------------

#[test]
fn a_dry_cold_fire_still_spreads() {
    // Il gèle une partie de la nuit : le feu prend, moins bien. Mesuré :
    // médiane 73 arbres, contre 0 avant (le gel éteignait tout).
    let (v, median) = distribution(COLD, Weather::Clear);
    report("froid sec 0 °C", &v, median);
    assert!(
        median >= 3,
        "médiane {median} arbre(s) par 0 °C sec : le froid éteint tout au lieu \
         de ralentir — {v:?}"
    );

    // Le climat de la campagne froide : il gèle en permanence, et c'est là que
    // la campagne mesurait « exactement une case par départ, trente-neuf pour
    // trente-neuf feux ». On juge sur la moyenne plutôt que sur la médiane :
    // la moitié des départs s'éteint encore sans rien prendre, c'est l'autre
    // moitié qui doit exister. Mesuré : 278 arbres pour vingt feux, soit 13,9
    // par feu (médiane 5, maximum 45).
    let (frozen, frozen_median) = distribution(FROZEN, Weather::Clear);
    report("gel sec −5 °C", &frozen, frozen_median);
    let frozen_total: u32 = frozen.iter().sum();
    assert!(
        frozen_total >= 3 * SEEDS as u32,
        "{frozen_total} arbres pour {SEEDS} feux par −5 °C sec : c'est encore le \
         régime « une case par départ » — {frozen:?}"
    );
    // Et il reste petit : bien sous la bande d'un feu d'été (médiane mesurée
    // 5 arbres, contre 112 par 30 °C). C'est un feu qui coûte, pas un incendie.
    assert!(
        frozen_median < BAND_LOW,
        "un feu de gel ({frozen_median} arbres) vaut déjà un feu d'été : \
         le froid ne ralentit plus rien"
    );
}

// ----------------------------------------------------------------------
// Pluie : ça n'a jamais lieu
// ----------------------------------------------------------------------

#[test]
fn rain_still_kills_a_wildfire_in_the_egg() {
    let (v, median) = distribution(HOT, Weather::Rain);
    report("pluie 30 °C", &v, median);
    assert!(
        median <= 2,
        "médiane {median} arbres sous la pluie : l'averse n'éteint plus rien"
    );
    assert!(
        v[v.len() - 1] < BAND_LOW,
        "la pire graine brûle {} % du bosquet sous la pluie",
        percent(v[v.len() - 1])
    );

    // Et la neige, qui tombe forcément sous zéro, n'est pas moins efficace.
    let (snow, snow_median) = distribution(FROZEN, Weather::Rain);
    report("neige −5 °C", &snow, snow_median);
    assert!(
        snow_median <= 2 && snow[snow.len() - 1] < BAND_LOW,
        "la neige laisse passer un incendie : {snow:?}"
    );
}
