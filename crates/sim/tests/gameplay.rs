//! Boucle de ressources et besoins, sur des cartes dessinées à la main.

use sim::pawn::{HUNGRY, NEED_MAX, TIRED};
use sim::testmap::map_from;
use sim::{Command, Designation, Feature, ItemKind, Job, Sim, Zone};

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
    assert_eq!(s.pawns()[0].job, Job::Sleep);
    assert!(run_until(&mut s, DAY, |s| s.pawns()[0].job != Job::Sleep));
    assert!(s.pawns()[0].rest >= NEED_MAX * 9 / 10);
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
