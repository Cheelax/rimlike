//! Le feu : ce qui brûle, ce qui se propage, ce que la pluie éteint et ce que
//! les colons vont combattre.

use sim::fire::{
    self, CAUSE_CAMPFIRE, CAUSE_LIGHTNING, CAUSE_ORDER, FIREFIGHT_RADIUS, GRASS_FIRE_TEMP,
};
use sim::testmap::map_from;
use sim::{
    Climate, Command, EventKind, Faction, Feature, ItemKind, Job, Sim, TICKS_PER_DAY, Terrain,
    Weather,
};

const DAY: u64 = TICKS_PER_DAY as u64;

/// Carte plate d'herbe, avec un carré d'arbres posé en `(x0, y0)`.
fn forest_map(width: u32, height: u32, x0: u32, y0: u32, side: u32) -> sim::Map {
    let rows: Vec<String> = (0..height)
        .map(|y| {
            (0..width)
                .map(|x| {
                    if x >= x0 && x < x0 + side && y >= y0 && y < y0 + side {
                        'T'
                    } else {
                        '.'
                    }
                })
                .collect()
        })
        .collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    map_from(&refs)
}

/// Bosquet de 8×8 arbres blotti à gauche d'une carte très longue : le
/// barycentre des colons, au centre, est à plus de `FIREFIGHT_RADIUS` de
/// l'arbre le plus proche. Personne ne viendra éteindre quoi que ce soit.
fn distant_forest() -> Sim {
    let map = forest_map(100, 20, 2, 6, 8);
    let mut s = Sim::from_map(1, map);
    // Temps sec et stable : les tirages de météo ne doivent pas décider du
    // résultat du test.
    s.force_weather(Weather::Clear, u64::MAX);
    s
}

/// Cases du bosquet qui ne portent plus d'arbre.
fn burned_tiles(s: &Sim, x0: u32, y0: u32, side: u32) -> u32 {
    let mut n = 0;
    for y in y0..y0 + side {
        for x in x0..x0 + side {
            if s.map().feature(x, y) != Feature::Tree {
                n += 1;
            }
        }
    }
    n
}

fn saw_event(s: &Sim, kind: EventKind, arg: u32) -> bool {
    s.events().iter().any(|e| e.kind == kind && e.arg == arg)
}

fn run_until(s: &mut Sim, max: u64, mut pred: impl FnMut(&Sim) -> bool) -> bool {
    for _ in 0..max {
        if pred(s) {
            return true;
        }
        s.step(&[]);
    }
    pred(s)
}

// ----------------------------------------------------------------------
// Table de combustibilité
// ----------------------------------------------------------------------

#[test]
fn fuel_table_is_what_we_say() {
    // Tout ce qui est en bois ou végétal brûle.
    for f in [
        Feature::Tree,
        Feature::Bush,
        Feature::BushUnripe,
        Feature::Crop,
        Feature::CropRipe,
        Feature::WallWood,
        Feature::DoorWood,
        Feature::Bed,
        Feature::CraftingSpot,
        Feature::ResearchBench,
        Feature::SpikeTrap,
        Feature::SpikeTrapSprung,
    ] {
        assert!(fire::feature_burns(f), "{f:?} devrait brûler");
    }
    // La pierre non, la roche non plus, et surtout pas le feu de camp : c'est
    // déjà un feu, maîtrisé.
    for f in [
        Feature::None,
        Feature::Rock,
        Feature::WallStone,
        Feature::DoorStone,
        Feature::Grave,
        Feature::GraveFilled,
        Feature::Campfire,
    ] {
        assert!(!fire::feature_burns(f), "{f:?} ne devrait pas brûler");
    }

    // Le plancher de bois brûle par tous les temps.
    assert!(fire::terrain_burns(Terrain::WoodFloor, -200, true));
    // L'herbe seulement quand il fait chaud **et** sec.
    assert!(fire::terrain_burns(
        Terrain::Grass,
        GRASS_FIRE_TEMP + 1,
        false
    ));
    assert!(!fire::terrain_burns(Terrain::Grass, GRASS_FIRE_TEMP, false));
    assert!(!fire::terrain_burns(
        Terrain::Grass,
        GRASS_FIRE_TEMP + 1,
        true
    ));
    // Le reste, jamais.
    for t in [
        Terrain::DeepWater,
        Terrain::ShallowWater,
        Terrain::Sand,
        Terrain::Dirt,
        Terrain::Gravel,
        Terrain::StoneFloor,
    ] {
        assert!(!fire::terrain_burns(t, 400, false), "{t:?}");
    }

    // Les piles : tout sauf la pierre, armes et dépouilles comprises.
    for kind in [
        ItemKind::Wood,
        ItemKind::Berries,
        ItemKind::Vegetables,
        ItemKind::Meal,
        ItemKind::Corpse,
        ItemKind::Club,
        ItemKind::Spear,
        ItemKind::Bow,
        ItemKind::DeerCorpse,
        ItemKind::Meat,
        ItemKind::Leather,
        ItemKind::Tunic,
        ItemKind::Coat,
    ] {
        assert!(fire::item_burns(kind), "{kind:?} devrait brûler");
    }
    assert!(!fire::item_burns(ItemKind::Stone), "la pierre ne brûle pas");
}

// ----------------------------------------------------------------------
// Propagation
// ----------------------------------------------------------------------

#[test]
fn fire_spreads_through_a_forest_and_burns_it_down() {
    let mut s = distant_forest();
    // Au cœur du bosquet.
    s.step(&[Command::Ignite { x: 5, y: 9 }]);
    assert_eq!(s.map().fire_count(), 1, "l'ordre n'a rien allumé");
    assert!(saw_event(&s, EventKind::FireStarted, CAUSE_ORDER));

    assert!(
        run_until(&mut s, 30_000, |s| s.map().fire_count() == 0),
        "l'incendie brûle encore après 30 000 ticks"
    );
    assert_eq!(
        s.map().feature(5, 9),
        Feature::None,
        "l'arbre du foyer est toujours là"
    );
    assert_eq!(
        s.map().get(5, 9),
        Terrain::Dirt,
        "il ne reste pas de terre nue là où l'arbre a brûlé"
    );
    let burned = burned_tiles(&s, 2, 6, 8);
    assert!(
        burned >= 20,
        "seulement {burned} cases brûlées sur 64 : le feu ne s'est pas propagé"
    );
    let out = s
        .events()
        .iter()
        .rev()
        .find(|e| e.kind == EventKind::FireOut)
        .copied()
        .expect("aucun FireOut annoncé");
    assert!(
        out.arg >= burned,
        "FireOut annonce {} cases pour {burned} arbres consumés",
        out.arg
    );
}

#[test]
fn rain_puts_fires_out() {
    let mut dry = distant_forest();
    dry.step(&[Command::Ignite { x: 5, y: 9 }]);
    run_until(&mut dry, 30_000, |s| s.map().fire_count() == 0);
    let dry_burned = burned_tiles(&dry, 2, 6, 8);

    let mut wet = distant_forest();
    wet.force_weather(Weather::Rain, u64::MAX);
    wet.step(&[Command::Ignite { x: 5, y: 9 }]);
    assert_eq!(wet.map().fire_count(), 1, "la pluie a empêché l'allumage");
    assert!(
        run_until(&mut wet, 30_000, |s| s.map().fire_count() == 0),
        "l'incendie brûle encore sous la pluie"
    );
    let wet_burned = burned_tiles(&wet, 2, 6, 8);

    assert!(
        wet_burned < dry_burned,
        "sous la pluie {wet_burned} cases brûlées, à sec {dry_burned} : \
         la pluie ne change rien"
    );
    assert!(
        dry_burned >= 20,
        "témoin à sec trop faible : {dry_burned} cases"
    );
}

// ----------------------------------------------------------------------
// Lutte
// ----------------------------------------------------------------------

/// Clairière avec un arbre isolé, à cinq cases du centre où naissent les
/// colons.
fn clearing_with_a_tree() -> Sim {
    let map = forest_map(20, 12, 15, 6, 1);
    let mut s = Sim::from_map(1, map);
    s.force_weather(Weather::Clear, u64::MAX);
    s
}

#[test]
fn colonists_fight_nearby_fires() {
    let mut s = clearing_with_a_tree();
    let center = s.colony_center().expect("colonie éteinte");
    assert!(
        sim::map::chebyshev(center, (15, 6)) <= FIREFIGHT_RADIUS,
        "l'arbre n'est pas dans le rayon de lutte : {center:?}"
    );
    s.step(&[Command::Ignite { x: 15, y: 6 }]);
    assert_eq!(s.map().fire_count(), 1);

    assert!(
        run_until(&mut s, 800, |s| s
            .pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Firefight { .. }))),
        "aucun colon n'est parti battre les flammes"
    );
    assert!(
        run_until(&mut s, 2_000, |s| s.map().fire_count() == 0),
        "le feu n'est jamais éteint"
    );
    assert_eq!(
        s.map().feature(15, 6),
        Feature::Tree,
        "l'arbre a brûlé alors que les colons l'ont éteint à temps"
    );
    assert!(saw_event(&s, EventKind::FireOut, 1));
}

#[test]
fn far_fires_are_ignored() {
    let mut s = distant_forest();
    let center = s.colony_center().expect("colonie éteinte");
    assert!(
        sim::map::chebyshev(center, (9, 9)) > FIREFIGHT_RADIUS,
        "le bosquet est trop près : {center:?}"
    );
    s.step(&[Command::Ignite { x: 5, y: 9 }]);
    let mut seen_firefight = false;
    for _ in 0..6_000 {
        if s.map().fire_count() == 0 {
            break;
        }
        seen_firefight |= s
            .pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Firefight { .. }));
        s.step(&[]);
    }
    assert!(
        !seen_firefight,
        "un colon a traversé la carte pour un feu de forêt qui ne le regarde pas"
    );
    assert!(
        burned_tiles(&s, 2, 6, 8) > 0,
        "le bosquet n'a pas brûlé du tout"
    );
}

// ----------------------------------------------------------------------
// Brûlures
// ----------------------------------------------------------------------

#[test]
fn standing_in_fire_burns() {
    let map = map_from(&[
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
    ]);
    let mut s = Sim::from_map(1, map);
    s.force_weather(Weather::Clear, u64::MAX);
    // Une pile de bois : voilà le combustible de la case, sans arbre qui la
    // rendrait infranchissable.
    s.spawn_item(ItemKind::Wood, 20, 2, 2);
    let id = s.spawn_pawn(2, 2, Faction::Colony);
    // Le tick 0 est un tick d'évaluation (`fire::FIRE_INTERVAL`) : la case
    // prend feu et brûle son occupant dans le même souffle.
    s.step(&[Command::Ignite { x: 2, y: 2 }]);
    let p = s.pawns().iter().find(|p| p.id == id).expect("colon perdu");
    assert!(
        !p.injuries.is_empty(),
        "le colon planté dans les flammes n'a rien senti"
    );
    assert!(
        p.injuries.iter().all(|i| i.bleeding == 0),
        "une brûlure ne saigne pas : {:?}",
        p.injuries
    );
    assert!(p.hp < sim::pawn::HP_MAX, "les PV n'ont pas bougé");
}

// ----------------------------------------------------------------------
// Départs de feu
// ----------------------------------------------------------------------

/// Feu de camp au milieu d'un pré, climat imposé et météo forcée.
fn campfire_meadow(seed: u64, base_temperature: i32, weather: Weather) -> Sim {
    let map = forest_map(16, 16, 0, 0, 0);
    let mut s = Sim::from_map(seed, map);
    s.set_climate(Climate::new(base_temperature, 0));
    s.force_weather(weather, u64::MAX);
    s.map_mut().set_feature(2, 2, Feature::Campfire);
    s
}

/// Le feu de camp a-t-il lâché une escarbille pendant `ticks` ticks ? Les
/// événements sont relus par tranches : la file du sim est bornée
/// (`MAX_EVENTS`), on ne peut pas attendre la fin pour regarder.
fn campfire_started_a_fire(s: &mut Sim, ticks: u64) -> bool {
    let mut seen = false;
    for _ in 0..ticks / 100 {
        for _ in 0..100 {
            s.step(&[]);
        }
        seen |= saw_event(s, EventKind::FireStarted, CAUSE_CAMPFIRE);
        if seen {
            return true;
        }
    }
    seen
}

#[test]
fn campfire_can_start_a_fire_in_dry_heat() {
    const SEEDS: u64 = 20;
    // Cinq jours d'été : 30 °C, pas une goutte.
    let mut hot = 0;
    for seed in 1..=SEEDS {
        let mut s = campfire_meadow(seed, 300, Weather::Clear);
        if campfire_started_a_fire(&mut s, 5 * DAY) {
            hot += 1;
        }
    }
    assert!(
        hot > SEEDS / 2,
        "seulement {hot} graines sur {SEEDS} ont vu un départ de feu de camp \
         en cinq jours d'été"
    );

    // Le même feu de camp sous la pluie, puis en plein gel : jamais.
    for seed in 1..=SEEDS {
        let mut wet = campfire_meadow(seed, 300, Weather::Rain);
        assert!(
            !campfire_started_a_fire(&mut wet, 5 * DAY),
            "graine {seed} : une escarbille sous la pluie"
        );
        let mut cold = campfire_meadow(seed, -100, Weather::Clear);
        assert!(
            !campfire_started_a_fire(&mut cold, 5 * DAY),
            "graine {seed} : une escarbille par −10 °C"
        );
    }
}

#[test]
fn lightning_strikes_during_storms() {
    const SEEDS: u64 = 20;
    let mut struck = 0;
    for seed in 1..=SEEDS {
        // Une carte largement boisée : l'éclair doit tomber sur du
        // combustible, pas dans l'herbe (qui, sous l'orage, est trempée).
        let map = forest_map(16, 16, 0, 0, 13);
        let mut s = Sim::from_map(seed, map);
        s.force_weather(Weather::Storm, u64::MAX);
        let mut seen = false;
        for _ in 0..(2 * DAY / 100) {
            for _ in 0..100 {
                s.step(&[]);
            }
            if saw_event(&s, EventKind::FireStarted, CAUSE_LIGHTNING) {
                seen = true;
                break;
            }
        }
        if seen {
            struck += 1;
        }
    }
    assert!(
        struck > SEEDS / 2,
        "seulement {struck} graines sur {SEEDS} ont vu la foudre allumer \
         quelque chose en deux jours d'orage"
    );

    // Sans orage, la foudre ne tombe jamais.
    let map = forest_map(16, 16, 0, 0, 13);
    let mut clear = Sim::from_map(1, map);
    clear.force_weather(Weather::Clear, u64::MAX);
    for _ in 0..(2 * DAY) {
        clear.step(&[]);
        assert!(
            !saw_event(&clear, EventKind::FireStarted, CAUSE_LIGHTNING),
            "un éclair par temps clair"
        );
    }
}

// ----------------------------------------------------------------------
// Persistance
// ----------------------------------------------------------------------

#[test]
fn snapshot_keeps_fire() {
    let mut s = distant_forest();
    s.step(&[Command::Ignite { x: 5, y: 9 }]);
    for _ in 0..400 {
        s.step(&[]);
    }
    assert!(s.map().fire_count() > 0, "plus rien ne brûle à sauvegarder");

    let bytes = s.snapshot();
    let mut back = Sim::restore(&bytes).expect("snapshot illisible");
    assert_eq!(back.state_hash(), s.state_hash());
    assert_eq!(back.map().fire_count(), s.map().fire_count());
    assert_eq!(back.burning(), s.burning());
    assert_eq!(back.fires_lit(), s.fires_lit());

    // Et l'incendie repart pareil des deux côtés.
    for _ in 0..1_000 {
        s.step(&[]);
        back.step(&[]);
    }
    assert_eq!(back.state_hash(), s.state_hash(), "les deux feux divergent");
}

#[test]
fn fast_forward_burns_the_current_fire_out() {
    let mut s = distant_forest();
    s.step(&[Command::Ignite { x: 5, y: 9 }]);
    for _ in 0..100 {
        s.step(&[]);
    }
    let lit = s.map().fire_count();
    assert!(lit > 0);
    s.step(&[Command::FastForward {
        ticks: 10 * DAY as u32,
    }]);
    assert_eq!(
        s.map().fire_count(),
        0,
        "l'avance rapide a laissé la carte en feu"
    );
    assert!(s.burning().is_empty());
    assert_eq!(
        s.map().feature(5, 9),
        Feature::None,
        "la case en feu n'a pas consommé son combustible"
    );
    assert!(saw_event(&s, EventKind::FireOut, lit));
}
