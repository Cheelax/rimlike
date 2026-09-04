//! Boucle de ressources et besoins, sur des cartes dessinées à la main.

use sim::pawn::RESTED;
use sim::pawn::{HUNGRY, NEED_MAX, TIRED};
use sim::testmap::map_from;
use sim::{BuildKind, Command, Designation, Feature, ItemKind, Job, Material, Sim, Terrain, Zone};

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

/// Petite clairière : arbres à gauche, rochers en haut, buissons à droite,
/// colons au centre.
fn clearing() -> Sim {
    let map = map_from(&[
        "###.........",
        "T...........",
        "T..........b",
        "T..........b",
        "............",
        "............",
        "............",
        "............",
    ]);
    Sim::from_map(1, map)
}

#[test]
fn chop_produces_wood_then_hauled_to_stockpile() {
    let mut s = clearing();
    s.step(&[
        Command::Designate {
            kind: Designation::Chop,
            x0: 0,
            y0: 1,
            x1: 0,
            y1: 3,
        },
        Command::SetZone {
            zone: Zone::Stockpile,
            x0: 8,
            y0: 5,
            x1: 9,
            y1: 6,
        },
    ]);
    assert_eq!(s.map().designation_count(), 3);
    assert_eq!(s.map().stockpile_count(), 4);

    assert!(
        run_until(&mut s, DAY, |s| s.map().feature(0, 1) == Feature::None),
        "premier arbre jamais coupé"
    );
    assert!(
        s.items().iter().any(|i| i.kind == ItemKind::Wood),
        "pas de bois après la coupe"
    );
    assert!(
        run_until(&mut s, 2 * DAY, |s| s.stored_totals()
            [ItemKind::Wood as usize]
            >= 60),
        "bois pas rangé : rangé = {:?}, objets = {:?}",
        s.stored_totals(),
        s.items()
    );
    assert_eq!(s.map().designation_count(), 0);
    // Les piles rangées sont fusionnées : 60 bois tiennent sur une seule case.
    let stored: Vec<_> = s
        .items()
        .iter()
        .filter(|i| s.map().zone(i.x, i.y) == Zone::Stockpile)
        .collect();
    assert_eq!(stored.len(), 1, "{stored:?}");
}

#[test]
fn mine_and_harvest_yield_and_bush_regrows() {
    let mut s = clearing();
    s.step(&[
        Command::Designate {
            kind: Designation::Mine,
            x0: 0,
            y0: 0,
            x1: 2,
            y1: 0,
        },
        Command::Designate {
            kind: Designation::Harvest,
            x0: 11,
            y0: 2,
            x1: 11,
            y1: 3,
        },
    ]);
    assert_eq!(s.map().designation_count(), 5);
    assert!(run_until(&mut s, 2 * DAY, |s| s.map().designation_count() == 0));
    let stone: u32 = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Stone)
        .map(|i| i.count)
        .sum();
    let berries: u32 = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Berries)
        .map(|i| i.count)
        .sum();
    assert_eq!(stone, 45);
    assert!(
        berries > 0 && berries <= 16,
        "baies = {berries} (des colons ont pu manger)"
    );
    assert_eq!(s.map().feature(11, 2), Feature::BushUnripe);
    assert!(run_until(&mut s, DAY + 10, |s| s.map().feature(11, 2)
        == Feature::Bush));
}

#[test]
fn hungry_pawn_eats_available_berries() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Berries, 20, 6, 6);
    let id = s.pawns()[0].id;
    s.pawn_mut(id).unwrap().hunger = HUNGRY - 1;
    assert!(run_until(&mut s, 600, |s| s.pawns()[0].hunger > HUNGRY + 500_000));
    let left: u32 = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Berries)
        .map(|i| i.count)
        .sum();
    assert!((15..20).contains(&left), "baies restantes = {left}");
}

#[test]
fn tired_pawn_sleeps_then_wakes_rested() {
    let mut s = clearing();
    let id = s.pawns()[0].id;
    s.pawn_mut(id).unwrap().rest = TIRED - 1;
    s.step(&[]);
    s.step(&[]);
    assert!(matches!(s.pawns()[0].job, Job::Sleep { in_bed: false }));
    assert!(run_until(&mut s, DAY, |s| !matches!(
        s.pawns()[0].job,
        Job::Sleep { .. }
    )));
    assert!(s.pawns()[0].rest >= NEED_MAX * 9 / 10);
    assert!(!s.pawns()[0].last_sleep_in_bed);
}

#[test]
fn needs_decay_and_mood_follows() {
    let mut s = clearing();
    let h0 = s.pawns()[0].hunger;
    let m0 = s.pawns()[0].mood();
    for _ in 0..DAY / 2 {
        s.step(&[]);
    }
    assert!(s.pawns()[0].hunger < h0);
    assert!(s.pawns()[0].mood() <= m0);
}

#[test]
fn manual_move_interrupts_work_and_cancel_clears_designations() {
    let mut s = clearing();
    s.step(&[Command::Designate {
        kind: Designation::Chop,
        x0: 0,
        y0: 1,
        x1: 0,
        y1: 3,
    }]);
    assert!(run_until(&mut s, 600, |s| {
        s.pawns().iter().any(|p| matches!(p.job, Job::Work { .. }))
    }));
    let worker = s
        .pawns()
        .iter()
        .find(|p| matches!(p.job, Job::Work { .. }))
        .unwrap()
        .id;
    s.step(&[Command::MoveTo {
        pawn: worker,
        x: 10,
        y: 7,
    }]);
    let p = s.pawns().iter().find(|p| p.id == worker).unwrap();
    assert_eq!(p.job, Job::Move { manual: true });
    s.step(&[Command::Designate {
        kind: Designation::None,
        x0: 0,
        y0: 0,
        x1: 11,
        y1: 7,
    }]);
    assert_eq!(s.map().designation_count(), 0);
    // Personne ne travaille plus une fois les désignations retirées.
    for _ in 0..5 {
        s.step(&[]);
    }
    assert!(s.pawns().iter().all(|p| !matches!(p.job, Job::Work { .. })));
}

fn wall(x0: i32, y0: i32, x1: i32, y1: i32) -> Command {
    Command::Build {
        kind: BuildKind::Wall,
        material: Material::Wood,
        x0,
        y0,
        x1,
        y1,
    }
}

#[test]
fn wall_gets_delivered_then_built() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Wood, 20, 6, 6);
    s.step(&[wall(4, 5, 6, 5)]);
    assert_eq!(s.blueprints().len(), 3);
    assert!(s.blueprints().iter().all(|b| b.needed == 5));
    assert!(
        run_until(&mut s, 2 * DAY, |s| s.blueprints().is_empty()),
        "chantiers restants : {:?}",
        s.blueprints()
    );
    for x in 4..=6 {
        assert_eq!(s.map().feature(x, 5), Feature::WallWood);
        assert!(!s.map().passable(x, 5));
    }
    let wood: u32 = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Wood)
        .map(|i| i.count)
        .sum();
    assert_eq!(wood, 5, "15 bois consommés sur 20");
    assert!(s.pawns().iter().all(|p| p.carrying.is_none()));
}

#[test]
fn full_wall_blocks_paths_and_pawns_replan_safely() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Wood, 40, 3, 3);
    // Mur complet sur la colonne 9 : coupe la carte en deux.
    s.step(&[wall(9, 0, 9, 7)]);
    assert_eq!(s.blueprints().len(), 8);
    // Un colon est envoyé de l'autre côté pendant les travaux.
    let id = s.pawns()[0].id;
    s.step(&[Command::MoveTo {
        pawn: id,
        x: 11,
        y: 4,
    }]);
    assert!(run_until(&mut s, 3 * DAY, |s| s.blueprints().is_empty()));
    assert_eq!(sim::path::find_path(s.map(), (2, 4), (11, 4)), None);
    // Personne ne garde un chemin qui traverse le mur, personne n'est bloqué dedans.
    for p in s.pawns() {
        assert!(
            p.path
                .iter()
                .all(|&(x, y)| s.map().passable(u32::from(x), u32::from(y)))
        );
        let (x, y) = p.tile();
        assert!(s.map().passable(x, y), "colon {} coincé dans un mur", p.id);
    }
}

#[test]
fn floor_door_and_bed_blueprints_apply() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Wood, 40, 6, 6);
    s.step(&[
        Command::Build {
            kind: BuildKind::Floor,
            material: Material::Wood,
            x0: 8,
            y0: 6,
            x1: 8,
            y1: 6,
        },
        Command::Build {
            kind: BuildKind::Door,
            material: Material::Wood,
            x0: 8,
            y0: 7,
            x1: 8,
            y1: 7,
        },
        Command::Build {
            kind: BuildKind::Bed,
            material: Material::Stone,
            x0: 9,
            y0: 7,
            x1: 9,
            y1: 7,
        },
    ]);
    assert_eq!(s.blueprints().len(), 3);
    assert!(
        s.blueprints().iter().all(|b| b.material == Material::Wood),
        "un lit est en bois"
    );
    assert!(
        run_until(&mut s, 2 * DAY, |s| s.blueprints().is_empty()),
        "{:?}",
        s.blueprints()
    );
    assert_eq!(s.map().get(8, 6), Terrain::WoodFloor);
    assert_eq!(s.map().feature(8, 7), Feature::DoorWood);
    assert!(s.map().passable(8, 7));
    assert_eq!(s.map().feature(9, 7), Feature::Bed);
    let wood: u32 = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Wood)
        .map(|i| i.count)
        .sum();
    assert_eq!(wood, 40 - 3 - 10 - 12);
}

#[test]
fn cancel_build_refunds_delivered_materials() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Wood, 20, 6, 6);
    s.step(&[wall(4, 5, 6, 5)]);
    assert!(run_until(&mut s, DAY, |s| s
        .blueprints()
        .iter()
        .any(|b| b.delivered > 0)));
    s.step(&[Command::CancelBuild {
        x0: 0,
        y0: 0,
        x1: 11,
        y1: 7,
    }]);
    assert!(s.blueprints().is_empty());
    // Les livreurs en route lâchent leur chargement au tick suivant.
    for _ in 0..3 {
        s.step(&[]);
    }
    let wood: u32 = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Wood)
        .map(|i| i.count)
        .sum();
    let carried: u32 = s
        .pawns()
        .iter()
        .filter_map(|p| p.carrying)
        .map(|(_, n)| n)
        .sum();
    assert_eq!(wood + carried, 20);
    assert!(
        s.map()
            .features()
            .iter()
            .all(|&f| f != Feature::WallWood as u8)
    );
}

#[test]
fn tired_pawn_walks_to_bed_and_sleeps_better() {
    let mut s = clearing();
    s.map_mut().set_feature(9, 6, Feature::Bed);
    let id = s.pawns()[0].id;
    s.pawn_mut(id).unwrap().rest = TIRED - 1;
    assert!(run_until(&mut s, 600, |s| {
        let p = &s.pawns()[0];
        matches!(p.job, Job::Sleep { in_bed: true }) && !p.is_moving() && p.tile() == (9, 6)
    }));
    let asleep_at = s.tick();
    assert!(run_until(&mut s, DAY, |s| !matches!(
        s.pawns()[0].job,
        Job::Sleep { .. }
    )));
    let bed_duration = s.tick() - asleep_at;
    assert!(s.pawns()[0].last_sleep_in_bed);
    assert!(s.pawns()[0].rest >= RESTED);

    // Sans lit : sommeil au sol, plus long, humeur moins bonne.
    let mut g = clearing();
    let id = g.pawns()[0].id;
    g.pawn_mut(id).unwrap().rest = TIRED - 1;
    assert!(run_until(&mut g, 600, |s| matches!(
        s.pawns()[0].job,
        Job::Sleep { .. }
    )));
    let asleep_at = g.tick();
    assert!(run_until(&mut g, DAY, |s| !matches!(
        s.pawns()[0].job,
        Job::Sleep { .. }
    )));
    let ground_duration = g.tick() - asleep_at;
    assert!(!g.pawns()[0].last_sleep_in_bed);
    assert!(
        bed_duration < ground_duration,
        "lit {bed_duration} vs sol {ground_duration}"
    );

    let idb = s.pawns()[0].id;
    let idg = g.pawns()[0].id;
    s.pawn_mut(idb).unwrap().hunger = 500_000;
    g.pawn_mut(idg).unwrap().hunger = 500_000;
    assert!(s.pawns()[0].mood() > g.pawns()[0].mood());
}

#[test]
fn growing_zone_is_sown_grows_and_is_harvested() {
    let mut s = clearing();
    s.step(&[Command::SetZone {
        zone: Zone::Growing,
        x0: 4,
        y0: 5,
        x1: 5,
        y1: 6,
    }]);
    assert_eq!(s.map().growing_count(), 4);
    assert!(
        run_until(&mut s, DAY, |s| s.crops().len() == 4),
        "semis : {:?}",
        s.crops()
    );
    assert!(run_until(&mut s, 3 * DAY, |s| {
        s.map().features().contains(&(Feature::CropRipe as u8))
    }));
    // Récolté, puis peut-être déjà mangé cru par des colons affamés.
    assert!(run_until(&mut s, DAY, |s| {
        s.items().iter().any(|i| i.kind == ItemKind::Vegetables)
            || s.pawns().iter().any(|p| p.last_meal_quality == -1)
    }));
}

#[test]
fn campfire_cooks_meals_from_raw_food() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Wood, 20, 6, 6);
    s.spawn_item(ItemKind::Berries, 30, 3, 6);
    s.step(&[Command::Build {
        kind: BuildKind::Campfire,
        material: Material::Stone,
        x0: 8,
        y0: 3,
        x1: 8,
        y1: 3,
    }]);
    assert_eq!(
        s.blueprints()[0].material,
        Material::Wood,
        "un feu est en bois"
    );
    assert!(run_until(&mut s, 2 * DAY, |s| s.map().feature(8, 3)
        == Feature::Campfire));
    assert!(!s.map().passable(8, 3));
    assert!(
        run_until(&mut s, DAY, |s| {
            s.items().iter().any(|i| i.kind == ItemKind::Meal)
                || s.pawns().iter().any(|p| p.last_meal_quality == 1)
        }),
        "aucun repas cuisiné"
    );
}

#[test]
fn hungry_pawn_prefers_meal_and_it_lifts_mood() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Vegetables, 20, 6, 6);
    s.spawn_item(ItemKind::Meal, 2, 7, 6);
    let id = s.pawns()[0].id;
    s.pawn_mut(id).unwrap().hunger = HUNGRY - 1;
    assert!(run_until(&mut s, 600, |s| s.pawns()[0].last_meal_quality == 1));
    assert!(s.pawns()[0].hunger > 900_000);
    let veg: u32 = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Vegetables)
        .map(|i| i.count)
        .sum();
    assert_eq!(veg, 20, "les légumes crus restent tant qu'il y a des repas");

    let mut g = clearing();
    g.spawn_item(ItemKind::Vegetables, 20, 6, 6);
    let id = g.pawns()[0].id;
    g.pawn_mut(id).unwrap().hunger = HUNGRY - 1;
    assert!(run_until(&mut g, 600, |s| s.pawns()[0].last_meal_quality == -1));
    assert!(s.pawns()[0].mood() > g.pawns()[0].mood());
}

#[test]
fn unreachable_food_spoils() {
    // Une poche fermée par des rochers en haut à droite : (11, 0).
    let map = map_from(&[
        "..........#.",
        "..........##",
        "............",
        "............",
        "............",
        "............",
    ]);
    let mut s = Sim::from_map(1, map);
    s.spawn_item(ItemKind::Berries, 10, 11, 0);
    let life = u64::from(ItemKind::Berries.shelf_life().unwrap());
    for _ in 0..life - 1 {
        s.step(&[]);
    }
    assert!(s.items().iter().any(|i| i.kind == ItemKind::Berries));
    s.step(&[]);
    s.step(&[]);
    assert!(s.items().iter().all(|i| i.kind != ItemKind::Berries));
    assert!(s.pawns().iter().all(|p| p.carrying.is_none()));
}
