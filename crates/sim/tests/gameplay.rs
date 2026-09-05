//! Boucle de ressources et besoins, sur des cartes dessinées à la main.

use sim::combat::HEAL_INTERVAL;
use sim::farm::GROW_TICKS;
use sim::fastforward::{FROZEN_HUNGER, FROZEN_REST};
use sim::health::{BLEED_TICKS, BLOOD_MAX, DOWNED_BLOOD};
use sim::pawn::RESTED;
use sim::pawn::{
    BREAK_TICKS, HP_MAX, HP_WOUNDED, HUNGER_DECAY, HUNGRY, MOOD_BREAK, NEED_MAX, REST_DECAY, TIRED,
};
use sim::testmap::map_from;
use sim::{
    BodyPart, BuildKind, CaravanManifest, Command, Designation, EventKind, Faction, Feature,
    ItemKind, Job, MAX_ANIMALS, MAX_FAST_FORWARD, Material, Pawn, Sim, Species, TICKS_PER_DAY,
    Terrain, Weather, WorkType, Zone,
};

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

/// Même clairière, avec une cellule de roche fermée au centre. Le colon 0 y
/// naît (c'est la case la plus proche du centre) et personne ne peut l'y
/// rejoindre : les deux autres apparaissent au deuxième anneau. Sert à
/// observer une blessure sans qu'un camarade vienne la panser.
fn walled_clearing() -> Sim {
    let map = map_from(&[
        "............",
        "............",
        "............",
        ".....###....",
        ".....#.#....",
        ".....###....",
        "............",
        "............",
    ]);
    Sim::from_map(1, map)
}

fn find_pawn(s: &Sim, id: u32) -> Option<&Pawn> {
    s.pawns().iter().find(|p| p.id == id)
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

// ----------------------------------------------------------------------
// Menaces
// ----------------------------------------------------------------------

fn has_event(s: &Sim, kind: EventKind) -> bool {
    s.events().iter().any(|e| e.kind == kind)
}

fn raiders(s: &Sim) -> usize {
    s.pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider)
        .count()
}

fn colonists(s: &Sim) -> usize {
    s.pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .count()
}

#[test]
fn raid_spawns_hostiles_and_colony_defends() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Berries, 60, 6, 6);
    s.step(&[Command::TriggerRaid]);
    // Trois colons donnent deux pillards.
    assert_eq!(raiders(&s), 2, "pillards : {:?}", s.pawns());
    assert!(has_event(&s, EventKind::Raid));
    let colonists_before = colonists(&s);

    assert!(
        run_until(&mut s, 2 * DAY, |s| raiders(s) == 0),
        "pillards encore là : {:?}",
        s.pawns()
    );
    // Il ne reste que des vivants, et personne d'hostile (la faune reste).
    assert!(
        s.pawns()
            .iter()
            .all(|p| p.faction != Faction::Raider && p.is_alive())
    );
    assert!(colonists(&s) > 0, "la colonie a été anéantie");
    assert!(
        colonists(&s) <= colonists_before,
        "des colons sont apparus de nulle part"
    );
    assert!(
        has_event(&s, EventKind::RaiderDied) || has_event(&s, EventKind::RaiderLeft),
        "aucun pillard mort ni parti : {:?}",
        s.events()
    );
}

#[test]
fn starvation_wounds_then_kills_and_leaves_a_corpse() {
    let mut s = clearing();
    let id = s.pawns()[0].id;
    s.pawn_mut(id).unwrap().hunger = 0;
    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.hp < HP_WOUNDED)),
        "le colon affamé n'est pas blessé"
    );
    assert!(
        run_until(&mut s, 3 * DAY, |s| !s.pawns().iter().any(|p| p.id == id)),
        "le colon affamé n'est pas mort"
    );
    assert!(s.items().iter().any(|i| i.kind == ItemKind::Corpse));
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::ColonistDied && e.arg == id),
        "événements : {:?}",
        s.events()
    );
    // Le deuil est celui de la colonie : les bêtes ne pleurent personne.
    assert!(
        s.pawns()
            .iter()
            .filter(|p| p.faction == Faction::Colony)
            .all(|p| p.grief_ticks > 0)
    );
}

#[test]
fn wounded_pawn_heals_when_fed() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Berries, 60, 6, 6);
    let id = s.pawns()[0].id;
    s.inflict_injury(id, BodyPart::Torso, 200);
    assert_eq!(
        s.pawns()[0].hp,
        HP_MAX - 200,
        "les PV dérivent des blessures"
    );
    assert!(
        run_until(&mut s, DAY, |s| find_pawn(s, id)
            .is_some_and(|p| p.hp > 950)),
        "PV = {}",
        s.pawns()[0].hp
    );
}

#[test]
fn attack_order_targets_enemy() {
    let mut s = clearing();
    s.step(&[Command::TriggerRaid]);
    let colonist = s
        .pawns()
        .iter()
        .find(|p| p.faction == Faction::Colony)
        .unwrap()
        .id;
    let raider = s
        .pawns()
        .iter()
        .find(|p| p.faction == Faction::Raider)
        .unwrap()
        .id;
    s.step(&[Command::Attack {
        pawn: colonist,
        target: raider,
    }]);
    let p = s.pawns().iter().find(|p| p.id == colonist).unwrap();
    assert_eq!(p.job, Job::Attack { target: raider });
}

#[test]
fn first_raid_waits_for_grace_period() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Berries, 200, 6, 6);
    for _ in 0..3 * DAY - 1 {
        s.step(&[]);
        assert!(
            !has_event(&s, EventKind::Raid),
            "raid au tick {} : trop tôt",
            s.tick()
        );
    }
    assert!(
        run_until(&mut s, DAY, |s| has_event(s, EventKind::Raid)),
        "aucun raid après la période de grâce"
    );
}

// ----------------------------------------------------------------------
// Confort et pilotage
// ----------------------------------------------------------------------

#[test]
fn priorities_disable_and_reorder_work() {
    // (a) Cuisine désactivée pour le colon 0 : les autres s'en chargent.
    let mut s = clearing();
    s.map_mut().set_feature(8, 3, Feature::Campfire);
    s.spawn_item(ItemKind::Berries, 30, 3, 6);
    let id0 = s.pawns()[0].id;
    s.step(&[Command::SetPriority {
        pawn: id0,
        work: WorkType::Cook,
        priority: 0,
    }]);
    let mut someone_else_cooked = false;
    for _ in 0..DAY {
        s.step(&[]);
        for p in s.pawns() {
            let cooking = matches!(p.job, Job::Cook { .. });
            assert!(
                !(cooking && p.id == id0),
                "le colon 0 cuisine malgré une priorité nulle, tick {}",
                s.tick()
            );
            someone_else_cooked |= cooking;
        }
    }
    assert!(someone_else_cooked, "personne n'a cuisiné");

    // (b) Rangement avant travail désigné, les autres colons au repos.
    let mut s = clearing();
    s.spawn_item(ItemKind::Wood, 20, 6, 6);
    let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
    let mut cmds = vec![
        Command::Designate {
            kind: Designation::Chop,
            x0: 0,
            y0: 1,
            x1: 0,
            y1: 1,
        },
        Command::SetZone {
            zone: Zone::Stockpile,
            x0: 8,
            y0: 5,
            x1: 9,
            y1: 6,
        },
        Command::SetPriority {
            pawn: ids[0],
            work: WorkType::Haul,
            priority: 1,
        },
        Command::SetPriority {
            pawn: ids[0],
            work: WorkType::Designated,
            priority: 4,
        },
    ];
    for &id in &ids[1..] {
        for work in WorkType::ALL {
            cmds.push(Command::SetPriority {
                pawn: id,
                work,
                priority: 0,
            });
        }
    }
    s.step(&cmds);
    let mut first: Option<Job> = None;
    for _ in 0..DAY {
        let job = s.pawns()[0].job.clone();
        if !matches!(job, Job::Idle | Job::Move { .. }) {
            first = Some(job);
            break;
        }
        s.step(&[]);
    }
    assert!(
        matches!(first, Some(Job::Haul { .. })),
        "premier travail du colon 0 : {first:?}"
    );
}

#[test]
fn low_mood_triggers_break_then_relief() {
    let mut s = clearing();
    let id = s.pawns()[0].id;
    let p = s.pawn_mut(id).unwrap();
    p.hunger = 0;
    p.last_sleep_in_bed = false;
    assert!(
        s.pawns()[0].mood() < MOOD_BREAK,
        "humeur = {}",
        s.pawns()[0].mood()
    );
    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| matches!(p.job, Job::Break { .. }))),
        "le colon désespéré n'a pas craqué"
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::ColonistBreak && e.arg == id),
        "événements : {:?}",
        s.events()
    );
    for _ in 0..u64::from(BREAK_TICKS) + 5 {
        s.step(&[]);
    }
    let p = s
        .pawns()
        .iter()
        .find(|p| p.id == id)
        .expect("le colon est encore vivant");
    assert!(
        !matches!(p.job, Job::Break { .. }),
        "crise sans fin : {:?}",
        p.job
    );
    assert!(p.relief_ticks > 0, "le colon ne s'est pas défoulé");
}

#[test]
fn mood_changes_work_speed() {
    /// Un plan de sol, du bois à côté, et seul le colon 0 sait construire.
    fn setup(happy: bool) -> Sim {
        let mut s = clearing();
        s.spawn_item(ItemKind::Wood, 10, 7, 6);
        let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
        let p = s.pawn_mut(ids[0]).unwrap();
        // Même niveau des deux côtés : seule l'humeur doit expliquer l'écart.
        p.skills[WorkType::Build as usize].level = 5;
        if happy {
            p.hunger = 950_000;
            p.last_meal_quality = 1;
            p.last_sleep_in_bed = true;
        } else {
            p.hunger = 250_000;
            p.last_sleep_in_bed = false;
        }
        let mut cmds = vec![Command::Build {
            kind: BuildKind::Floor,
            material: Material::Wood,
            x0: 8,
            y0: 6,
            x1: 8,
            y1: 6,
        }];
        for &id in &ids[1..] {
            cmds.push(Command::SetPriority {
                pawn: id,
                work: WorkType::Build,
                priority: 0,
            });
        }
        s.step(&cmds);
        s
    }
    fn floor_done_at(s: &mut Sim) -> u64 {
        assert!(
            run_until(s, 2 * DAY, |s| s.blueprints().is_empty()),
            "sol jamais bâti : {:?}",
            s.blueprints()
        );
        s.tick()
    }
    let mut sad = setup(false);
    let mut happy = setup(true);
    let sad_at = floor_done_at(&mut sad);
    let happy_at = floor_done_at(&mut happy);
    assert!(
        happy_at < sad_at,
        "heureux {happy_at} vs morose {sad_at} : l'humeur ne change rien"
    );
}

#[test]
fn rain_doubles_crop_growth() {
    fn ripe_at(w: Weather) -> u64 {
        let mut s = clearing();
        s.force_weather(w, u64::MAX);
        s.step(&[Command::SetZone {
            zone: Zone::Growing,
            x0: 5,
            y0: 5,
            x1: 5,
            y1: 5,
        }]);
        assert!(
            run_until(&mut s, 4 * DAY, |s| s
                .map()
                .features()
                .contains(&(Feature::CropRipe as u8))),
            "aucun plant mûr par temps {w:?}"
        );
        s.tick()
    }
    let wet = ripe_at(Weather::Rain);
    let dry = ripe_at(Weather::Clear);
    assert!(
        wet * 100 <= dry * 60,
        "pluie {wet} vs sec {dry} : la pluie n'accélère pas assez"
    );
}

#[test]
fn weather_eventually_changes() {
    let mut s = Sim::new(7, 32, 32);
    // Un drapeau par temps, neige comprise : `Weather::Snow` indexe ce tableau.
    let mut seen = [false; sim::weather::WEATHER_COUNT];
    for _ in 0..6 * DAY {
        seen[s.weather() as usize] = true;
        s.step(&[]);
    }
    assert!(
        seen.iter().filter(|&&v| v).count() >= 2,
        "météo figée : {seen:?}"
    );
}

#[test]
fn wanderer_joins_after_a_few_days() {
    let mut s = clearing();
    let mut joined_at: Option<(usize, usize)> = None;
    // Le journal est borné : on suit les `seq` déjà vus, comme le client.
    let mut last_seq: i64 = -1;
    for t in 0..6 * DAY {
        // Sans nourriture sur la carte, on les garde en vie à la main.
        if t % 1000 == 0 {
            let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
            for id in ids {
                if let Some(p) = s.pawn_mut(id) {
                    p.hunger = NEED_MAX;
                }
            }
        }
        let before = colonists(&s);
        s.step(&[]);
        let mut fresh = false;
        for e in s.events() {
            if i64::from(e.seq) > last_seq {
                last_seq = i64::from(e.seq);
                fresh |= e.kind == EventKind::WandererJoined;
            }
        }
        if fresh && joined_at.is_none() {
            joined_at = Some((before, colonists(&s)));
        }
    }
    let Some((before, after)) = joined_at else {
        panic!("aucun voyageur en six jours");
    };
    // Un raid a pu coûter un colon avant : ce qui compte est le colon gagné.
    assert_eq!(after, before + 1, "le voyageur n'a pas rejoint la colonie");
}

// ----------------------------------------------------------------------
// Noms et compétences
// ----------------------------------------------------------------------

#[test]
fn starting_pawns_have_names_and_random_skill_levels() {
    let a = Sim::new(5, 64, 64);
    assert_eq!(colonists(&a), 3);
    for p in a.pawns() {
        assert!(!p.name.is_empty(), "pawn sans nom : {p:?}");
        for skill in &p.skills {
            assert!(skill.level <= 8, "niveau hors bornes : {}", skill.level);
        }
    }

    // Même seed : mêmes noms, mêmes niveaux.
    let b = Sim::new(5, 64, 64);
    let names_a: Vec<&str> = a.pawns().iter().map(|p| p.name.as_str()).collect();
    let names_b: Vec<&str> = b.pawns().iter().map(|p| p.name.as_str()).collect();
    assert_eq!(names_a, names_b, "même seed, noms différents");
    let levels_a: Vec<[u8; sim::WORK_TYPES]> = a
        .pawns()
        .iter()
        .map(|p| p.skills.map(|s| s.level))
        .collect();
    let levels_b: Vec<[u8; sim::WORK_TYPES]> = b
        .pawns()
        .iter()
        .map(|p| p.skills.map(|s| s.level))
        .collect();
    assert_eq!(levels_a, levels_b, "même seed, niveaux différents");

    // Seed différente : au moins une différence, nom ou niveau.
    let c = Sim::new(6, 64, 64);
    let names_c: Vec<&str> = c.pawns().iter().map(|p| p.name.as_str()).collect();
    let levels_c: Vec<[u8; sim::WORK_TYPES]> = c
        .pawns()
        .iter()
        .map(|p| p.skills.map(|s| s.level))
        .collect();
    assert!(
        names_a != names_c || levels_a != levels_c,
        "deux seeds différentes donnent exactement le même résultat"
    );
}

#[test]
fn higher_skill_level_speeds_up_chopping() {
    fn chop_duration(level: u8) -> u64 {
        let mut s = clearing();
        let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
        let worker = ids[0];
        s.pawn_mut(worker).unwrap().skills[WorkType::Designated as usize].level = level;
        // Personne d'autre ne coupe : la différence de durée ne vient que du niveau.
        let mut cmds = vec![Command::Designate {
            kind: Designation::Chop,
            x0: 0,
            y0: 1,
            x1: 0,
            y1: 1,
        }];
        for &id in &ids[1..] {
            cmds.push(Command::SetPriority {
                pawn: id,
                work: WorkType::Designated,
                priority: 0,
            });
        }
        s.step(&cmds);
        assert!(
            run_until(&mut s, DAY, |s| s.map().feature(0, 1) == Feature::None),
            "arbre jamais coupé (niveau {level})"
        );
        s.tick()
    }
    let slow = chop_duration(0);
    let fast = chop_duration(20);
    assert!(
        fast < slow,
        "niveau 20 ({fast} ticks) pas plus rapide que niveau 0 ({slow} ticks)"
    );
}

#[test]
fn work_xp_levels_up_and_emits_event() {
    let mut s = clearing();
    let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
    let worker = ids[0];
    let level = 3;
    {
        let p = s.pawn_mut(worker).unwrap();
        p.skills[WorkType::Designated as usize].level = level;
        p.skills[WorkType::Designated as usize].xp = sim::work::xp_to_next(level) - 3;
    }
    // Seul `worker` peut couper : c'est bien sa compétence qui doit progresser.
    let mut cmds = vec![Command::Designate {
        kind: Designation::Chop,
        x0: 0,
        y0: 1,
        x1: 0,
        y1: 1,
    }];
    for &id in &ids[1..] {
        cmds.push(Command::SetPriority {
            pawn: id,
            work: WorkType::Designated,
            priority: 0,
        });
    }
    s.step(&cmds);
    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .find(|p| p.id == worker)
            .is_some_and(
                |p| p.skills[WorkType::Designated as usize].level == level + 1
            )),
        "le colon n'est pas monté de niveau"
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::LevelUp && e.arg == worker),
        "aucun événement LevelUp pour ce colon : {:?}",
        s.events()
    );
}

// ----------------------------------------------------------------------
// Santé détaillée : blessures, colons à terre, sauvetage et soins
// ----------------------------------------------------------------------

#[test]
fn wounds_bleed_then_close_and_heal() {
    let mut s = walled_clearing();
    let id = s.pawns()[0].id;
    assert_eq!(
        s.pawns()[0].tile(),
        (6, 4),
        "le blessé n'est pas dans sa cellule"
    );
    s.inflict_injury(id, BodyPart::LeftLeg, 80);
    {
        let p = &s.pawns()[0];
        assert_eq!(p.injuries.len(), 1);
        assert_eq!(p.injuries[0].bleeding, 20, "saignement = sévérité / 4");
        assert_eq!(p.hp, HP_MAX - 80, "les PV dérivent de la sévérité");
        assert_eq!(p.blood, BLOOD_MAX);
    }

    // Tant que la plaie est ouverte, le sang baisse.
    for _ in 0..400 {
        s.step(&[]);
    }
    let bleeding_blood = s.pawns()[0].blood;
    assert!(bleeding_blood < BLOOD_MAX, "le sang n'a pas baissé");
    assert!(
        s.pawns()[0].is_bleeding(),
        "la plaie s'est refermée bien trop tôt"
    );

    // Puis elle se referme d'elle-même, sans que personne n'ait pansé.
    assert!(
        run_until(&mut s, u64::from(BLEED_TICKS) + 200, |s| !s.pawns()[0]
            .is_bleeding()),
        "la plaie saigne encore après {BLEED_TICKS} ticks"
    );
    let low = s.pawns()[0].blood;
    assert!(low < bleeding_blood, "le sang n'a pas continué de baisser");
    assert!(
        low >= DOWNED_BLOOD && !s.pawns()[0].is_downed(),
        "une plaie modérée ne doit pas mettre à terre : sang = {low}"
    );
    assert!(
        s.pawns()[0].injuries[0].severity > 0,
        "la blessure a guéri avant d'avoir fini de saigner"
    );
    assert!(
        s.pawns()[0].injuries.iter().all(|i| !i.tended),
        "personne ne peut atteindre la cellule"
    );

    // La blessure finit par disparaître et le sang se refait.
    let bound = 2 * 80 * HEAL_INTERVAL;
    assert!(
        run_until(&mut s, bound, |s| s.pawns()[0].injuries.is_empty()),
        "blessure toujours là après {bound} ticks : {:?}",
        s.pawns()[0].injuries
    );
    assert_eq!(s.pawns()[0].hp, HP_MAX, "les PV ne sont pas revenus au max");
    assert!(s.pawns()[0].blood > low, "le sang ne s'est pas refait");
}

#[test]
fn heavy_bleeding_downs_then_rescue_and_tend() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Berries, 200, 6, 6);
    s.map_mut().set_feature(8, 6, Feature::Bed);
    let id = s.pawns()[0].id;
    // Deux plaies ouvertes sur un colon déjà à moitié vidé de son sang.
    s.inflict_injury(id, BodyPart::Torso, 60);
    s.inflict_injury(id, BodyPart::LeftLeg, 60);
    s.pawn_mut(id).unwrap().blood = 305;

    assert!(
        run_until(&mut s, 300, |s| find_pawn(s, id)
            .is_some_and(|p| p.is_downed())),
        "le colon exsangue ne s'écroule pas"
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::ColonistDowned && e.arg == id),
        "aucun événement d'écroulement : {:?}",
        s.events()
    );

    // Un camarade vient le chercher et le dépose dans le lit.
    assert!(
        run_until(&mut s, 3000, |s| s
            .events()
            .iter()
            .any(|e| e.kind == EventKind::ColonistRescued && e.arg == id)),
        "personne ne l'a porté au lit"
    );
    assert_eq!(
        find_pawn(&s, id).map(|p| p.tile()),
        Some((8, 6)),
        "le blessé n'est pas sur la case du lit"
    );

    // Puis on le panse : plus rien ne saigne.
    assert!(
        run_until(&mut s, 3000, |s| s
            .events()
            .iter()
            .any(|e| e.kind == EventKind::ColonistTended && e.arg == id)),
        "personne ne l'a soigné"
    );
    let p = find_pawn(&s, id).expect("le blessé est encore là");
    assert!(!p.is_bleeding(), "il saigne encore après le soin");
    assert!(p.injuries.iter().all(|i| i.tended));

    // Le sang se refait, il se relève, et il est toujours vivant.
    assert!(
        run_until(&mut s, 2 * DAY, |s| find_pawn(s, id)
            .is_some_and(|p| !p.is_downed())),
        "toujours à terre : {:?}",
        find_pawn(&s, id).map(|p| (p.blood, p.hp))
    );
    assert!(find_pawn(&s, id).is_some(), "le colon secouru est mort");
}

#[test]
fn untended_massive_bleeding_kills() {
    let mut s = walled_clearing();
    let id = s.pawns()[0].id;
    s.inflict_injury(id, BodyPart::Torso, 400);
    let mut was_downed = false;
    for _ in 0..2000 {
        if find_pawn(&s, id).is_none() {
            break;
        }
        was_downed |= find_pawn(&s, id).is_some_and(|p| p.is_downed());
        s.step(&[]);
    }
    assert!(was_downed, "il n'est jamais tombé avant de mourir");
    assert!(
        find_pawn(&s, id).is_none(),
        "le colon isolé n'est pas mort de son hémorragie : {:?}",
        find_pawn(&s, id).map(|p| (p.blood, p.hp))
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::ColonistDied && e.arg == id),
        "événements : {:?}",
        s.events()
    );
    assert!(
        s.items()
            .iter()
            .any(|i| i.kind == ItemKind::Corpse && (i.x, i.y) == (6, 4)),
        "pas de cadavre dans la cellule : {:?}",
        s.items()
    );
}

#[test]
fn raiders_ignore_downed_colonists() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Berries, 200, 6, 6);
    let id = s.pawns()[0].id;
    // Plaie légère mais colon exsangue : il reste à terre longtemps.
    s.inflict_injury(id, BodyPart::LeftLeg, 40);
    s.pawn_mut(id).unwrap().blood = 200;
    s.step(&[]);
    assert!(
        find_pawn(&s, id).is_some_and(|p| p.is_downed()),
        "le colon n'est pas à terre avant le raid"
    );
    let before = find_pawn(&s, id).map(|p| p.total_severity()).unwrap_or(0);

    s.step(&[Command::TriggerRaid]);
    assert_eq!(raiders(&s), 2, "pillards : {:?}", s.pawns());
    let mut fought = false;
    for _ in 0..4000 {
        if raiders(&s) == 0 {
            break;
        }
        s.step(&[]);
        let p = find_pawn(&s, id).expect("le colon à terre a été achevé");
        assert!(
            p.total_severity() <= before,
            "un pillard l'a frappé au sol : {} > {before}",
            p.total_severity()
        );
        assert!(p.is_downed(), "il s'est relevé pendant le raid");
        fought |= s
            .pawns()
            .iter()
            .any(|q| q.id != id && matches!(q.job, Job::Attack { .. }));
    }
    assert!(fought, "les colons debout ne se sont jamais battus");
}

#[test]
fn mobility_slows_walking() {
    fn travel(injured: bool) -> u64 {
        let mut s = clearing();
        let id = s.pawns()[0].id;
        if injured {
            s.inflict_injury(id, BodyPart::LeftLeg, 400);
            assert!(s.pawns()[0].mobility_percent() < 100);
            assert!(
                s.pawns()[0].hp > HP_WOUNDED,
                "seule la mobilité doit expliquer l'écart"
            );
        }
        s.step(&[Command::MoveTo {
            pawn: id,
            x: 0,
            y: 7,
        }]);
        let start = s.tick();
        assert!(
            run_until(&mut s, DAY, |s| find_pawn(s, id)
                .is_some_and(|p| p.tile() == (0, 7))),
            "le colon n'atteint pas sa destination (blessé : {injured})"
        );
        s.tick() - start
    }
    let fast = travel(false);
    let slow = travel(true);
    assert!(
        slow > fast,
        "jambe blessée {slow} ticks, jambe saine {fast} ticks"
    );
}

/// Statistique sur plusieurs graines : un premier raid reste dangereux (des
/// blessés, parfois un mort) sans être une hécatombe systématique. Le seuil
/// « 3 jours » borne le pire cas (pillards qui traînent) sans jamais couper
/// un combat encore en cours : `run_until` s'arrête dès que la carte n'a
/// plus de pillard vivant.
#[test]
fn first_raid_is_dangerous_but_survivable() {
    const SEEDS: u64 = 12;
    let mut wiped_out = 0u32;
    let mut total_deaths = 0u32;
    let mut wounded_survivors = 0u32;
    for seed in 1..=SEEDS {
        let mut s = Sim::new(seed, 32, 32);
        // Baies au centre de la carte : la faim ne doit pas peser sur l'issue
        // du combat, seul le combat lui-même compte.
        let (bx, by) = s
            .map()
            .nearest_passable(16, 16)
            .expect("carte 32x32 sans centre franchissable");
        s.spawn_item(ItemKind::Berries, 60, bx, by);
        let before = colonists(&s);
        s.step(&[Command::TriggerRaid]);
        run_until(&mut s, 3 * DAY, |s| raiders(s) == 0);
        let after = colonists(&s);
        total_deaths += before.saturating_sub(after) as u32;
        if after == 0 {
            wiped_out += 1;
        }
        if s.pawns()
            .iter()
            .any(|p| p.faction == Faction::Colony && !p.injuries.is_empty())
        {
            wounded_survivors += 1;
        }
    }
    assert!(
        wiped_out <= 2,
        "colonie anéantie sur {wiped_out}/{SEEDS} graines (max 2 tolérées)"
    );
    assert!(
        total_deaths <= SEEDS as u32,
        "{total_deaths} morts au total sur {SEEDS} graines : moyenne > 1,0"
    );
    assert!(
        wounded_survivors >= 4,
        "seulement {wounded_survivors}/{SEEDS} graines avec un blessé qui survit"
    );
}

// ----------------------------------------------------------------------
// Armes : fabrication, équipement, tir
// ----------------------------------------------------------------------

/// Le « bill » de fabrication : on pose un objectif, les colons taillent
/// jusqu'à l'atteindre, puis s'arrêtent d'eux-mêmes.
#[test]
fn craft_target_produces_weapons() {
    let mut s = clearing();
    // Poste posé à la main : le chantier est déjà couvert par les tests de
    // construction, ce qui compte ici est ce qui s'y fabrique.
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    assert_eq!(s.map().crafting_spot_count(), 1);
    s.spawn_item(ItemKind::Wood, 40, 6, 6);
    // De quoi ne pas mourir de faim pendant deux jours de taille.
    s.spawn_item(ItemKind::Berries, 200, 5, 6);

    // Sans ordre, rien ne se fabrique.
    for _ in 0..600 {
        s.step(&[]);
    }
    assert_eq!(s.colony_total(ItemKind::Club), 0, "gourdin sans ordre");

    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Club,
        target: 2,
    }]);
    assert_eq!(s.craft_targets()[ItemKind::Club as usize], 2);
    assert!(
        run_until(&mut s, 2 * DAY, |s| s.colony_total(ItemKind::Club) >= 2),
        "gourdins fabriqués : {}, bois restant : {}",
        s.colony_total(ItemKind::Club),
        s.colony_total(ItemKind::Wood)
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::WeaponCrafted && e.arg == ItemKind::Club as u32),
        "aucun événement de fabrication : {:?}",
        s.events()
    );
    // 8 bois par gourdin, pas un de plus.
    assert_eq!(s.colony_total(ItemKind::Wood), 40 - 16);

    // L'objectif est atteint : on arrête, même avec du bois plein les bras.
    for _ in 0..DAY {
        s.step(&[]);
        assert_eq!(
            s.colony_total(ItemKind::Club),
            2,
            "fabrication en trop au tick {}",
            s.tick()
        );
    }
    assert!(
        s.pawns()
            .iter()
            .all(|p| !matches!(p.job, Job::Craft { .. }))
    );
}

/// Un colon prend la meilleure arme rangée : l'arc avant le gourdin, et il ne
/// redescend jamais en gamme.
#[test]
fn colonists_equip_best_weapon() {
    let mut s = clearing();
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 8,
        y0: 5,
        x1: 9,
        y1: 6,
    }]);
    s.spawn_item(ItemKind::Club, 1, 8, 5);
    s.spawn_item(ItemKind::Bow, 1, 9, 5);

    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .any(|p| p.weapon.is_some())),
        "personne ne s'est armé"
    );
    assert!(
        s.pawns().iter().any(|p| p.weapon == Some(ItemKind::Bow)),
        "le gourdin est parti avant l'arc : {:?}",
        s.pawns().iter().map(|p| p.weapon).collect::<Vec<_>>()
    );
    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .filter(|p| p.weapon.is_some())
            .count()
            == 2),
        "le gourdin est resté en rayon"
    );
    let armed: Vec<Option<ItemKind>> = s.pawns().iter().map(|p| p.weapon).collect();
    assert_eq!(
        armed.iter().filter(|w| **w == Some(ItemKind::Bow)).count(),
        1
    );
    assert_eq!(
        armed.iter().filter(|w| **w == Some(ItemKind::Club)).count(),
        1
    );
    assert!(
        !s.items().iter().any(|i| i.kind.is_weapon()),
        "une arme traîne encore : {:?}",
        s.items()
    );

    // Un archer ne troque pas son arc contre un gourdin.
    let archer = s
        .pawns()
        .iter()
        .find(|p| p.weapon == Some(ItemKind::Bow))
        .expect("un colon a l'arc")
        .id;
    s.spawn_item(ItemKind::Club, 1, 8, 5);
    for _ in 0..600 {
        s.step(&[]);
        assert_eq!(
            find_pawn(&s, archer).and_then(|p| p.weapon),
            Some(ItemKind::Bow),
            "l'archer a lâché son arc"
        );
    }

    // Le colon aux mains nues, lui, monte en gamme : il prend le gourdin.
    assert!(
        s.pawns()
            .iter()
            .filter(|p| p.weapon == Some(ItemKind::Club))
            .count()
            >= 2
    );
}

/// Un arc a besoin d'une ligne de vue dégagée : le mur de rochers protège
/// autant qu'un bouclier, et une fois abattu la cible saigne sans contact.
#[test]
fn bow_needs_line_of_sight_and_range() {
    // Colonne de rochers en x = 4 : la carte est coupée en deux.
    let map = map_from(&[
        "....#...............",
        "....#...............",
        "....#...............",
        "....#...............",
        "....#...............",
        "....#...............",
        "....#...............",
    ]);
    let mut s = Sim::from_map(1, map);
    let archer = s.spawn_pawn(1, 3, Faction::Colony);
    let raider = s.spawn_pawn(7, 3, Faction::Raider);
    {
        let p = s.pawn_mut(archer).expect("l'archer existe");
        p.weapon = Some(ItemKind::Bow);
        p.ranged.level = 20;
    }
    {
        // Cible à terre : elle ne bouge pas, ne riposte pas, et les autres
        // colons l'ignorent (ils n'achèvent que ce qu'ils ont déjà pris pour
        // cible). Seul l'archer la vise, sur ordre du joueur. `Downed` est posé
        // à la main : sinon les colons du centre la verraient debout le temps
        // d'un tick et lui tomberaient dessus.
        let p = s.pawn_mut(raider).expect("le pillard existe");
        p.blood = 200;
        p.job = Job::Downed;
    }
    s.step(&[]);
    assert!(
        find_pawn(&s, raider).is_some_and(|p| p.is_downed()),
        "la cible devrait être à terre"
    );

    // Derrière le mur : pas une flèche.
    s.step(&[Command::Attack {
        pawn: archer,
        target: raider,
    }]);
    for _ in 0..600 {
        s.step(&[]);
    }
    assert_eq!(
        find_pawn(&s, archer).map(|p| p.ranged.xp),
        Some(0),
        "l'archer a tiré à travers le mur"
    );
    assert_eq!(
        find_pawn(&s, raider).map(|p| p.total_severity()),
        Some(0),
        "la cible a pris des dégâts derrière le mur"
    );

    // Le mur tombe : la vue est dégagée, les flèches partent.
    for y in 0..7 {
        s.map_mut().set_feature(4, y, Feature::None);
    }
    assert!(sim::combat::line_of_sight(s.map(), (1, 3), (7, 3)));
    s.step(&[Command::Attack {
        pawn: archer,
        target: raider,
    }]);
    let mut contact = false;
    let hurt = run_until(&mut s, 4 * u64::from(sim::combat::RANGED_COOLDOWN), |s| {
        let (Some(a), Some(r)) = (find_pawn(s, archer), find_pawn(s, raider)) else {
            return true;
        };
        contact |= sim::map::chebyshev(a.tile(), r.tile()) <= 1;
        r.total_severity() > 0
    });
    assert!(hurt, "aucune flèche n'a porté à découvert");
    assert!(!contact, "l'archer est allé au corps à corps");
    assert!(
        find_pawn(&s, archer).is_some_and(|p| p.ranged.xp > 0),
        "les tirs ne forment pas au tir"
    );
}

/// Les pillards arrivent armés, et ce qu'ils portent finit sur le sol de la
/// colonie quand ils y laissent leur peau.
#[test]
fn armed_raiders_drop_weapons() {
    // Carte pleine taille : sur la clairière de douze cases de large, un
    // pillard qui décroche atteint le bord avant de succomber à ses plaies.
    // La graine est choisie pour qu'un pillard y laisse sa peau : sur la
    // graine 1 les deux décrochent à temps et repartent avec leurs armes,
    // ce qui est un déroulement légitime mais ne prouve rien sur le butin.
    let mut s = Sim::new(2, 32, 32);
    let (bx, by) = s
        .map()
        .nearest_passable(16, 16)
        .expect("carte 32x32 sans centre franchissable");
    s.spawn_item(ItemKind::Berries, 200, bx, by);
    s.step(&[Command::TriggerRaid]);
    let armed: Vec<ItemKind> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider)
        .filter_map(|p| p.weapon)
        .collect();
    assert_eq!(
        armed,
        vec![ItemKind::Club, ItemKind::Spear],
        "les deux premiers pillards portent gourdin puis épieu"
    );

    assert!(
        run_until(&mut s, 3 * DAY, |s| raiders(s) == 0),
        "pillards encore là : {:?}",
        s.pawns()
    );
    let looted = s.items().iter().any(|i| i.kind.is_weapon())
        || s.pawns().iter().any(|p| p.weapon.is_some());
    assert!(
        looted,
        "aucune arme récupérée après le raid : objets {:?}, morts {:?}",
        s.items(),
        s.events()
    );
}

// ----------------------------------------------------------------------
// Caravanes : sortir d'une carte, entrer sur une autre
// ----------------------------------------------------------------------

/// Total d'un genre posé au sol, toutes piles confondues.
fn on_ground(s: &Sim, kind: ItemKind) -> u32 {
    s.items()
        .iter()
        .filter(|i| i.kind == kind)
        .map(|i| i.count)
        .sum()
}

/// Le contrat complet du sim avec le futur serveur monde : deux colons et des
/// marchandises quittent une carte dans un manifeste, et débarquent sur une
/// autre avec de nouveaux ids.
#[test]
fn caravan_departs_with_stock_and_arrives_elsewhere() {
    let mut a = clearing();
    a.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 8,
        y0: 5,
        x1: 9,
        y1: 6,
    }]);
    a.spawn_item(ItemKind::Wood, 60, 8, 5);
    a.spawn_item(ItemKind::Berries, 20, 9, 5);
    assert_eq!(a.stored_totals()[ItemKind::Wood as usize], 60);

    let travellers: Vec<u32> = a.pawns().iter().take(2).map(|p| p.id).collect();
    let names: Vec<String> = a.pawns().iter().take(2).map(|p| p.name.clone()).collect();
    let skills: Vec<u8> = a
        .pawns()
        .iter()
        .take(2)
        .map(|p| p.skills[WorkType::Build as usize].level)
        .collect();
    let before = a.pawns().len();

    a.step(&[Command::FormCaravan {
        pawns: travellers.clone(),
        items: vec![(ItemKind::Wood, 40), (ItemKind::Berries, 20)],
    }]);

    assert_eq!(a.pawns().len(), before - 2, "les partants sont restés");
    assert!(travellers.iter().all(|&id| find_pawn(&a, id).is_none()));
    assert_eq!(
        a.stored_totals()[ItemKind::Wood as usize],
        20,
        "40 bois prélevés sur 60"
    );
    assert_eq!(a.stored_totals()[ItemKind::Berries as usize], 0);
    assert_eq!(a.departures().len(), 1);
    assert!(
        a.events()
            .iter()
            .any(|e| e.kind == EventKind::CaravanDeparted && e.arg == 2),
        "pas d'événement de départ : {:?}",
        a.events()
    );

    let manifest = CaravanManifest::decode(&a.departures()[0]).expect("manifeste lisible");
    assert_eq!(manifest.pawns.len(), 2);
    assert_eq!(
        manifest.items,
        vec![(ItemKind::Wood, 40), (ItemKind::Berries, 20)]
    );
    for (k, p) in manifest.pawns.iter().enumerate() {
        assert_eq!(p.name, names[k], "nom perdu en route");
        assert_eq!(p.skills[WorkType::Build as usize].level, skills[k]);
        assert_eq!(p.job, Job::Idle);
        assert!(p.path.is_empty() && p.carrying.is_none());
    }

    // Arrivée sur une tout autre carte.
    let mut b = Sim::new(9, 48, 48);
    let existing: Vec<u32> = b.pawns().iter().map(|p| p.id).collect();
    b.step(&[Command::ArriveCaravan {
        manifest: a.departures()[0].clone(),
    }]);

    assert_eq!(b.pawns().len(), existing.len() + 2);
    let newcomers: Vec<&Pawn> = b
        .pawns()
        .iter()
        .filter(|p| !existing.contains(&p.id))
        .collect();
    assert_eq!(newcomers.len(), 2, "ids en collision avec ceux de la carte");
    assert_ne!(newcomers[0].id, newcomers[1].id);
    for p in &newcomers {
        assert_eq!(p.faction, Faction::Colony);
        let (x, y) = p.tile();
        assert!(
            b.map().passable(x, y),
            "colon débarqué sur une case infranchissable ({x}, {y})"
        );
    }
    assert_eq!(on_ground(&b, ItemKind::Wood), 40);
    assert_eq!(on_ground(&b, ItemKind::Berries), 20);
    assert!(
        b.events()
            .iter()
            .any(|e| e.kind == EventKind::CaravanArrived && e.arg == 2),
        "pas d'événement d'arrivée : {:?}",
        b.events()
    );

    // L'hôte a expédié : la file se vide par commande, en lockstep.
    a.step(&[Command::ClearDepartures { count: 1 }]);
    assert!(a.departures().is_empty());
}

/// Tout ce qui ne part pas : listes vides, ids inventés, pillards, colons à
/// terre. Et ce qui part quand même : une demande plus grosse que le stock.
#[test]
fn caravan_rejects_invalid_requests() {
    let mut s = clearing();
    let id = s.pawns()[0].id;
    let colonists = s.pawns().len();

    s.step(&[Command::FormCaravan {
        pawns: Vec::new(),
        items: vec![(ItemKind::Wood, 5)],
    }]);
    s.step(&[Command::FormCaravan {
        pawns: vec![9999],
        items: Vec::new(),
    }]);
    s.step(&[Command::FormCaravan {
        pawns: vec![id, id],
        items: Vec::new(),
    }]);
    assert!(s.departures().is_empty(), "une demande invalide est partie");
    assert_eq!(s.pawns().len(), colonists);

    // Un pillard n'est pas de la colonie.
    let mut r = clearing();
    r.step(&[Command::TriggerRaid]);
    let raider = r
        .pawns()
        .iter()
        .find(|p| p.faction == Faction::Raider)
        .map(|p| p.id)
        .expect("un pillard est entré");
    r.step(&[Command::FormCaravan {
        pawns: vec![raider],
        items: Vec::new(),
    }]);
    assert!(
        r.departures().is_empty(),
        "un pillard est parti en caravane"
    );

    // Un colon à terre ne marche pas jusqu'au globe.
    let mut d = clearing();
    let downed = d.pawns()[0].id;
    d.inflict_injury(downed, BodyPart::LeftLeg, 40);
    d.pawn_mut(downed).expect("le colon existe").blood = 200;
    d.step(&[]);
    assert!(find_pawn(&d, downed).is_some_and(|p| p.is_downed()));
    d.step(&[Command::FormCaravan {
        pawns: vec![downed],
        items: Vec::new(),
    }]);
    assert!(
        d.departures().is_empty(),
        "un colon à terre est parti en caravane"
    );

    // Plus de bois demandé qu'il n'en existe : on part avec ce qu'il y a, et
    // un genre absent du stock ne figure pas au manifeste.
    let mut t = clearing();
    t.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 8,
        y0: 5,
        x1: 9,
        y1: 6,
    }]);
    t.spawn_item(ItemKind::Wood, 12, 8, 5);
    let one = t.pawns()[0].id;
    t.step(&[Command::FormCaravan {
        pawns: vec![one],
        items: vec![(ItemKind::Wood, 999), (ItemKind::Stone, 5)],
    }]);
    let manifest = CaravanManifest::decode(&t.departures()[0]).expect("manifeste lisible");
    assert_eq!(manifest.items, vec![(ItemKind::Wood, 12)]);
    assert_eq!(t.stored_totals()[ItemKind::Wood as usize], 0);

    // Un manifeste illisible n'entre pas et ne panique pas. Le hash change
    // (le tick avance) : c'est l'état hors tick qu'on compare.
    let mut u = clearing();
    let pawns_before = u.pawns().len();
    let items_before = u.items().len();
    let truncated = manifest.encode()[..3].to_vec();
    for bytes in [vec![0xff, 0x00, 0x42], Vec::new(), truncated] {
        u.step(&[Command::ArriveCaravan { manifest: bytes }]);
    }
    assert_eq!(u.pawns().len(), pawns_before, "un corrompu a fait entrer");
    assert_eq!(u.items().len(), items_before);
    assert!(
        !u.events()
            .iter()
            .any(|e| e.kind == EventKind::CaravanArrived)
    );
}

/// Le colon voyage entier : blessures, sang, compétences et priorités sont
/// dans le manifeste et se retrouvent à l'arrivée.
#[test]
fn caravan_roundtrip_preserves_health_and_skills() {
    let mut a = clearing();
    let id = a.pawns()[0].id;
    let name = a.pawns()[0].name.clone();
    {
        let p = a.pawn_mut(id).expect("le colon existe");
        p.skills[WorkType::Cook as usize].level = 15;
        p.priorities[WorkType::Haul as usize] = 1;
    }
    a.inflict_injury(id, BodyPart::LeftArm, 300);
    let severity = a.pawns()[0].total_severity();
    assert!(severity > 0 && !a.pawns()[0].is_downed());

    a.step(&[Command::FormCaravan {
        pawns: vec![id],
        items: Vec::new(),
    }]);
    let manifest = CaravanManifest::decode(&a.departures()[0]).expect("manifeste lisible");
    assert_eq!(manifest.version, sim::MANIFEST_VERSION);
    assert_eq!(manifest.pawns.len(), 1);
    assert_eq!(manifest.pawns[0].injuries.len(), 1);

    let mut b = Sim::new(9, 48, 48);
    let existing: Vec<u32> = b.pawns().iter().map(|p| p.id).collect();
    b.step(&[Command::ArriveCaravan {
        manifest: a.departures()[0].clone(),
    }]);
    let p = b
        .pawns()
        .iter()
        .find(|p| !existing.contains(&p.id))
        .expect("le voyageur a débarqué");

    assert_eq!(p.name, name, "nom perdu en route");
    assert_eq!(p.skills[WorkType::Cook as usize].level, 15);
    assert_eq!(p.priorities[WorkType::Haul as usize], 1);
    assert_eq!(p.injuries.len(), 1);
    assert_eq!(p.injuries[0].part, BodyPart::LeftArm);
    // Le tick d'arrivée cicatrise déjà un peu : la blessure a bien voyagé.
    assert!(
        p.injuries[0].severity + 5 >= severity && p.injuries[0].severity <= severity,
        "sévérité {} loin des {severity} du départ",
        p.injuries[0].severity
    );
    assert!(p.hp < HP_MAX, "les PV dérivent des blessures");
    assert!(p.blood < BLOOD_MAX, "la plaie saigne toujours");
}

// ----------------------------------------------------------------------
// Avance rapide d'une carte gelée
// ----------------------------------------------------------------------

/// Remet faim et repos au maximum : ces tests-là regardent le storyteller,
/// pas la famine.
fn feed(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    for id in ids {
        if let Some(p) = s.pawn_mut(id) {
            p.hunger = NEED_MAX;
            p.rest = NEED_MAX;
        }
    }
}

/// Vrai si un pillard apparaît dans les `ticks` qui suivent.
fn raid_within(s: &mut Sim, ticks: u64) -> bool {
    for _ in 0..ticks {
        feed(s);
        s.step(&[]);
        if raiders(s) > 0 {
            return true;
        }
    }
    false
}

#[test]
fn fast_forward_murit_les_plants_et_gate_les_vivres() {
    let mut s = clearing();
    s.step(&[
        Command::SetZone {
            zone: Zone::Growing,
            x0: 4,
            y0: 5,
            x1: 5,
            y1: 6,
        },
        Command::Designate {
            kind: Designation::Harvest,
            x0: 11,
            y0: 2,
            x1: 11,
            y1: 3,
        },
    ]);
    assert!(
        run_until(&mut s, 2 * DAY, |s| s.crops().len() == 4
            && s.map().feature(11, 2) == Feature::BushUnripe),
        "semis ou récolte inachevés : {:?}",
        s.crops()
    );
    assert!(
        s.crops().iter().all(|c| c.growth < GROW_TICKS),
        "les plants sont déjà mûrs avant le gel"
    );
    s.spawn_item(ItemKind::Berries, 20, 0, 7);
    // Les piles déjà là au moment du gel : aucune ne doit survivre à quatre
    // jours (les baies tiennent trois jours). On suit les ids, parce qu'un
    // colon qui lâche sa charge repose une pile **fraîche** au dégel.
    let perishable: Vec<u32> = s
        .items()
        .iter()
        .filter(|i| i.kind == ItemKind::Berries)
        .map(|i| i.id)
        .collect();
    assert!(!perishable.is_empty(), "aucune baie sur la carte");

    s.step(&[Command::FastForward {
        ticks: 4 * TICKS_PER_DAY,
    }]);

    assert!(
        s.crops()
            .iter()
            .all(|c| c.growth == GROW_TICKS && s.map().feature(c.x, c.y) == Feature::CropRipe),
        "des plants n'ont pas mûri : {:?}",
        s.crops()
    );
    assert_eq!(
        s.map().feature(11, 2),
        Feature::Bush,
        "le buisson récolté n'a pas repoussé"
    );
    assert!(
        s.items().iter().all(|i| !perishable.contains(&i.id)),
        "des baies ont tenu quatre jours : {:?}",
        s.items()
    );
    assert!(
        has_event(&s, EventKind::FastForwarded),
        "événements : {:?}",
        s.events()
    );
}

#[test]
fn fast_forward_soigne_les_blesses_et_remonte_les_besoins() {
    // Cellule fermée : personne ne vient panser ni nourrir le blessé.
    let mut s = walled_clearing();
    let id = s.pawns()[0].id;
    s.inflict_injury(id, BodyPart::Torso, 200);
    {
        let p = s.pawn_mut(id).unwrap();
        // Assez vidé de son sang pour s'écrouler au tick suivant.
        p.blood = DOWNED_BLOOD - 1;
        p.hunger = 0;
        p.rest = 0;
        p.grief_ticks = 3 * DAY as u32;
        p.relief_ticks = 100;
    }
    s.step(&[]);
    assert!(
        find_pawn(&s, id).is_some_and(|p| p.is_downed() && p.is_bleeding()),
        "le blessé devrait être à terre et saigner : {:?}",
        find_pawn(&s, id)
    );

    // Deux jours gelés : 480 points de cicatrisation, bien plus que les 200
    // de la blessure.
    s.step(&[Command::FastForward {
        ticks: 2 * TICKS_PER_DAY,
    }]);

    let p = find_pawn(&s, id).expect("le blessé n'a pas survécu au gel");
    assert!(!p.is_bleeding(), "la plaie saigne encore");
    assert_eq!(p.blood, BLOOD_MAX, "le sang ne s'est pas refait");
    assert!(
        p.injuries.is_empty(),
        "blessures restantes : {:?}",
        p.injuries
    );
    assert_eq!(p.hp, HP_MAX, "les PV n'ont pas suivi les blessures");
    assert!(!p.is_downed(), "le colon aurait dû se relever");
    assert!(!matches!(p.job, Job::Downed), "job = {:?}", p.job);
    // La colonie s'est débrouillée hors écran : besoins raisonnables, à un
    // tick de décroissance près (celui du `step` qui porte la commande).
    assert!(
        p.hunger >= FROZEN_HUNGER - HUNGER_DECAY,
        "faim = {}, attendue proche de {FROZEN_HUNGER}",
        p.hunger
    );
    assert!(
        p.rest >= FROZEN_REST - REST_DECAY,
        "repos = {}, attendu proche de {FROZEN_REST}",
        p.rest
    );
    // Le deuil s'écoule du temps passé, il ne s'efface pas.
    assert!(
        p.grief_ticks > DAY as u32 - 100 && p.grief_ticks < DAY as u32,
        "deuil = {}, attendu proche d'un jour",
        p.grief_ticks
    );
    assert_eq!(p.relief_ticks, 0, "le bonus d'humeur aurait dû expirer");
}

#[test]
fn fast_forward_renvoie_les_pillards() {
    let mut s = clearing();
    s.spawn_item(ItemKind::Berries, 60, 6, 6);
    s.step(&[Command::TriggerRaid]);
    assert_eq!(raiders(&s), 2, "pillards : {:?}", s.pawns());
    let colony_before = colonists(&s);

    s.step(&[Command::FastForward {
        ticks: TICKS_PER_DAY,
    }]);

    assert_eq!(
        raiders(&s),
        0,
        "les pillards campent encore : {:?}",
        s.pawns()
    );
    assert_eq!(
        colonists(&s),
        colony_before,
        "la colonie a changé de taille"
    );
    assert!(
        has_event(&s, EventKind::RaiderLeft),
        "événements : {:?}",
        s.events()
    );
    assert!(
        !s.items().iter().any(|i| i.kind == ItemKind::Corpse),
        "un pillard parti ne laisse pas de cadavre"
    );
}

#[test]
fn fast_forward_ne_declenche_pas_de_raid_en_rafale() {
    // Une colonie gelée dix jours ne doit encaisser aucun raid au dégel : les
    // échéances du storyteller ont glissé du temps gelé, elles ne se sont pas
    // accumulées. Le premier raid, programmé entre le 3e et le 3,5e jour,
    // reste donc à plus de deux jours du dégel.
    let mut frozen = clearing();
    frozen.step(&[Command::FastForward {
        ticks: 10 * TICKS_PER_DAY,
    }]);
    assert_eq!(frozen.tick(), 10 * DAY + 1);
    assert!(
        !raid_within(&mut frozen, 2 * DAY),
        "un raid a suivi le dégel : les dix jours gelés ont été rejoués"
    );

    // Sans gel, la même colonie est bien attaquée dans un laps de temps de jeu
    // plus court : le test compare deux histoires, pas deux hasards.
    let mut base = clearing();
    assert!(
        raid_within(&mut base, 4 * DAY),
        "aucun raid en quatre jours : le test ne prouverait rien"
    );
}

#[test]
fn fast_forward_est_borne_et_ignore_zero() {
    assert_eq!(MAX_FAST_FORWARD, 60 * TICKS_PER_DAY);
    let mut s = clearing();
    s.step(&[Command::FastForward { ticks: u32::MAX }]);
    // Le tick du `step` lui-même s'ajoute à l'avance tronquée.
    assert_eq!(s.tick(), u64::from(MAX_FAST_FORWARD) + 1);
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::FastForwarded && e.arg == 60),
        "événements : {:?}",
        s.events()
    );

    let mut z = clearing();
    z.step(&[Command::FastForward { ticks: 0 }]);
    assert_eq!(z.tick(), 1, "une avance nulle n'avance rien");
    assert!(
        !has_event(&z, EventKind::FastForwarded),
        "une avance nulle n'est pas un événement"
    );
}

// ----------------------------------------------------------------------
// Saisons, température et intérieur
// ----------------------------------------------------------------------

/// Une année entière en soixante bonds d'un jour. Chaque bond tombe **pile**
/// sur le premier tick d'un jour (`day × TICKS_PER_DAY - décalage de départ`),
/// donc le tick de calendrier qui suit voit bien le changement de saison :
/// c'est le seul moyen de traverser 864 000 ticks sans les jouer.
#[test]
fn seasons_cycle_and_temperature_follows() {
    let mut s = Sim::new(9, 24, 24);
    // `time_of_day()` au tick 0, c'est le décalage de départ du sim.
    let offset = u64::from(s.time_of_day());
    let mut last_seq: i64 = -1;
    let mut season_args: Vec<u32> = Vec::new();
    let mut frosts = 0;
    let mut sum = [0i64; 4];
    let mut count = [0i64; 4];

    assert_eq!(s.season(), sim::Season::Spring, "on commence au printemps");
    assert_eq!(s.day_of_year(), 0);

    for day in 1..=u64::from(sim::YEAR_DAYS) {
        let target = day * DAY - offset;
        let jump = (target - s.tick()) as u32;
        s.step(&[Command::FastForward { ticks: jump }]);
        assert_eq!(s.tick(), target + 1);
        assert_eq!(u64::from(s.day_of_year()), day % u64::from(sim::YEAR_DAYS));
        // Le journal est borné : on suit les `seq` déjà vus, comme le client.
        for e in s.events() {
            if i64::from(e.seq) <= last_seq {
                continue;
            }
            last_seq = i64::from(e.seq);
            match e.kind {
                EventKind::SeasonChanged => season_args.push(e.arg),
                EventKind::FirstFrost => frosts += 1,
                _ => {}
            }
        }
        sum[s.season() as usize] += i64::from(s.outdoor_temperature());
        count[s.season() as usize] += 1;
    }

    assert_eq!(
        season_args,
        vec![
            sim::Season::Summer as u32,
            sim::Season::Autumn as u32,
            sim::Season::Winter as u32,
            sim::Season::Spring as u32,
        ],
        "les quatre saisons doivent défiler dans l'ordre"
    );
    assert!(
        count.iter().all(|&c| c > 0),
        "saison jamais visitée : {count:?}"
    );
    let avg: Vec<i64> = (0..4).map(|k| sum[k] / count[k]).collect();
    assert!(
        avg[sim::Season::Summer as usize] > avg[sim::Season::Winter as usize] + 100,
        "été {} vs hiver {} : l'écart saisonnier ne se voit pas",
        avg[sim::Season::Summer as usize],
        avg[sim::Season::Winter as usize]
    );
    assert!(
        avg[sim::Season::Winter as usize] < 0,
        "l'hiver tempéré doit passer sous 0 °C : {avg:?}"
    );
    assert_eq!(frosts, 1, "une seule première gelée par automne");
}

/// Sous le gel, un champ ne pousse plus et finit par mourir. Amplitude nulle :
/// le test ne dépend que du froid, pas de la date.
#[test]
fn crops_stop_growing_in_frost_and_can_die() {
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
    let mut s = Sim::from_map_with_climate(1, map, sim::Climate::new(-100, 0));
    assert!(s.outdoor_temperature() < -50, "{}", s.outdoor_temperature());
    s.step(&[Command::SetZone {
        zone: Zone::Growing,
        x0: 4,
        y0: 5,
        x1: 5,
        y1: 6,
    }]);
    assert!(
        run_until(&mut s, DAY, |s| !s.crops().is_empty()),
        "rien n'a été semé"
    );

    let mut deaths = 0;
    let mut previous = s.crops().len();
    for _ in 0..DAY {
        s.step(&[]);
        let now = s.crops().len();
        deaths += previous.saturating_sub(now);
        previous = now;
        assert!(
            s.crops().iter().all(|c| c.growth == 0),
            "un plant a poussé sous le gel : {:?}",
            s.crops()
        );
        assert!(
            !s.map().features().contains(&(Feature::CropRipe as u8)),
            "un plant a mûri sous le gel"
        );
    }
    assert!(deaths > 0, "aucun plant n'a gelé en une journée");
}

/// Quatre murs et un feu font une pièce, et la pièce est plus chaude. Le bord
/// de la carte, lui, compte comme ouvert : une zone qui l'atteint reste dehors.
#[test]
fn walls_and_campfire_make_a_room_warmer() {
    let map = map_from(&[
        "..............",
        "..............",
        "..............",
        "..............",
        "..............",
        "..............",
        "..............",
        "..............",
        "..............",
        "..............",
    ]);
    let mut s = Sim::from_map(3, map);
    // Anneau de murs 5×5 en pleine carte : intérieur 3×3 (4..6, 4..6).
    for x in 3..=7u32 {
        for y in 3..=7u32 {
            if x == 3 || x == 7 || y == 3 || y == 7 {
                s.map_mut().set_feature(x, y, Feature::WallWood);
            }
        }
    }
    s.map_mut().set_feature(4, 4, Feature::Campfire);
    // Deuxième « pièce » adossée au bord de la carte : elle ne compte pas.
    for (x, y) in [(3, 0), (3, 1), (0, 2), (1, 2), (2, 2), (3, 2)] {
        s.map_mut().set_feature(x, y, Feature::WallWood);
    }
    s.step(&[]);

    assert!(s.map().is_indoor(5, 5), "le centre de la pièce est dedans");
    assert_eq!(
        s.map().indoor_count(),
        9,
        "3×3, la case du feu comprise : un feu ne délimite rien"
    );
    assert!(
        !s.map().is_indoor(1, 1),
        "une zone qui touche le bord est dehors"
    );
    assert!(!s.map().is_indoor(11, 8), "la plaine est dehors");

    let outdoor = s.outdoor_temperature();
    assert_eq!(s.tile_temperature(11, 8), outdoor, "dehors = extérieur");
    assert_eq!(
        s.tile_temperature(5, 5),
        outdoor + 60 + 80,
        "isolation + un feu de camp"
    );
    assert!(s.tile_temperature(5, 5) > s.tile_temperature(11, 8));

    // Une porte ferme la pièce autant qu'un mur, bien qu'on la traverse : rien
    // ne change, donc rien n'est recalculé.
    let version = s.map().indoor_version();
    s.map_mut().set_feature(3, 5, Feature::DoorWood);
    s.step(&[]);
    assert_eq!(
        s.map().indoor_version(),
        version,
        "une porte à la place d'un mur ne change aucune pièce"
    );
    assert!(s.map().is_indoor(5, 5), "une porte ne perce pas la pièce");
    assert_eq!(s.tile_temperature(5, 5), s.outdoor_temperature() + 60 + 80);

    // Un trou dans le mur, et la pièce n'en est plus une.
    s.map_mut().set_feature(3, 5, Feature::None);
    s.step(&[]);
    assert!(s.map().indoor_version() > version, "couche non recalculée");
    assert!(!s.map().is_indoor(5, 5), "la pièce est éventrée");
    assert_eq!(s.map().indoor_count(), 0);
    assert_eq!(s.tile_temperature(5, 5), s.outdoor_temperature());

    // Rebouché : la pièce revient, et la couche est refaite.
    let version = s.map().indoor_version();
    s.map_mut().set_feature(3, 5, Feature::WallWood);
    s.step(&[]);
    assert!(s.map().indoor_version() > version, "couche non recalculée");
    assert!(s.map().is_indoor(5, 5));
    assert_eq!(s.tile_temperature(5, 5), s.outdoor_temperature() + 60 + 80);
}

/// Par −15 °C, dehors on prend le froid et le moral s'effondre ; dans une pièce
/// chauffée, non.
#[test]
fn cold_hurts_mood_and_causes_hypothermia_indoors_is_safer() {
    let map = map_from(&[
        "....................",
        "....................",
        "............#######.",
        "............#.....#.",
        "............#.....#.",
        "............#.....#.",
        "............#.....#.",
        "............#.....#.",
        "............#######.",
        "....................",
        "....................",
        "....................",
    ]);
    let mut s = Sim::from_map_with_climate(4, map, sim::Climate::new(-150, 0));
    // Trois feux dans la pièce : le gain d'une pièce est plafonné à +25 °C.
    for x in 13..=15u32 {
        s.map_mut().set_feature(x, 3, Feature::Campfire);
    }
    let inside = s.spawn_pawn(15, 5, Faction::Colony);
    let outside = s.pawns()[0].id;
    s.step(&[]);
    assert!(s.map().is_indoor(15, 5), "le colon abrité doit être dedans");
    assert!(!s.map().is_indoor(
        find_pawn(&s, outside).unwrap().tile().0,
        find_pawn(&s, outside).unwrap().tile().1
    ));

    for _ in 0..2_000 {
        s.step(&[]);
    }

    let warm = find_pawn(&s, inside).expect("le colon abrité est là");
    let cold = find_pawn(&s, outside).expect("le colon exposé est là");
    assert!(
        warm.comfort > cold.comfort + 200,
        "abrité {} vs exposé {}",
        warm.comfort,
        cold.comfort
    );
    assert!(
        cold.comfort < -50,
        "dehors il devrait geler : {}",
        cold.comfort
    );
    assert!(
        warm.comfort > -50,
        "la pièce chauffée devrait protéger : {}",
        warm.comfort
    );
    assert!(
        cold.total_severity() > 0,
        "aucune atteinte du froid dehors : {:?}",
        cold.injuries
    );
    assert!(
        cold.injuries
            .iter()
            .any(|i| i.part == BodyPart::Torso && i.bleeding == 0 && i.tended),
        "l'atteinte du froid est une usure du torse, pansée et sans saignement : {:?}",
        cold.injuries
    );
    assert!(
        warm.injuries.is_empty(),
        "le colon abrité ne devrait rien avoir : {:?}",
        warm.injuries
    );
    assert!(
        warm.mood() > cold.mood(),
        "abrité {} vs exposé {}",
        warm.mood(),
        cold.mood()
    );
}

/// Le climat s'impose à la construction comme en cours de partie, et les
/// valeurs venues du réseau sont bornées avant de toucher quoi que ce soit.
#[test]
fn climate_is_configurable_and_bounded() {
    let hot = sim::Climate::new(300, 0);
    let mut s = Sim::new_with_climate(2, 16, 16, hot);
    assert_eq!(s.climate(), hot);
    assert!(
        s.outdoor_temperature() > 200,
        "climat chaud : {}",
        s.outdoor_temperature()
    );

    // Une commande aberrante ne doit ni paniquer ni faire déborder un calcul.
    s.step(&[Command::SetClimate {
        base_temperature: i32::MIN,
        amplitude: i32::MAX,
    }]);
    assert_eq!(
        s.climate(),
        sim::Climate {
            base_temperature: sim::climate::TEMPERATURE_MIN,
            amplitude: sim::Climate::AMPLITUDE_MAX,
        }
    );
    let cold = s.outdoor_temperature();
    assert!(
        (sim::climate::TEMPERATURE_MIN..=sim::climate::TEMPERATURE_MAX).contains(&cold),
        "température hors bornes : {cold}"
    );
}

// ----------------------------------------------------------------------
// Faune, chasse et dépeçage
// ----------------------------------------------------------------------

/// Bêtes vivantes sur la carte.
fn animals(s: &Sim) -> Vec<u32> {
    s.pawns()
        .iter()
        .filter(|p| p.faction == Faction::Animal && p.is_alive())
        .map(|p| p.id)
        .collect()
}

/// Total d'un genre possédé par la colonie, au sol comme rangé.
fn owned(s: &Sim, kind: ItemKind) -> u32 {
    s.colony_total(kind)
}

/// Garde tout le monde en vie sans poser de nourriture sur la carte : la
/// chasse doit rester le seul repas disponible quand on veut l'observer.
fn top_up_hunger(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    for id in ids {
        if let Some(p) = s.pawn_mut(id) {
            p.hunger = NEED_MAX;
        }
    }
}

#[test]
fn animals_spawn_graze_and_flee() {
    let mut s = Sim::new(3, 48, 48);
    let herd = animals(&s);
    assert!(!herd.is_empty(), "aucune bête au départ");
    assert!(herd.len() <= 4, "troupeau de départ trop gros : {herd:?}");
    let center = (24u32, 24u32);
    for p in s.pawns().iter().filter(|p| p.faction == Faction::Animal) {
        let species = p.species.expect("une bête a une espèce");
        assert_ne!(species, Species::Boar, "pas de sanglier au premier jour");
        assert_eq!(p.name, species.label(), "le nom d'une bête est son espèce");
        assert_eq!(p.flee_until, 0, "une bête démarre calme");
        assert_eq!(p.hp, species.max_hp(), "PV de départ de l'espèce");
        assert!(
            sim::map::chebyshev(center, p.tile()) >= 12,
            "bête posée sur la colonie : {:?}",
            p.tile()
        );
    }

    // Elles paissent : au bout de quelques pas de pâture, au moins une a bougé.
    let start: Vec<(u32, u32)> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Animal)
        .map(|p| p.tile())
        .collect();
    assert!(
        run_until(&mut s, 1000, |s| {
            let now: Vec<(u32, u32)> = s
                .pawns()
                .iter()
                .filter(|p| p.faction == Faction::Animal)
                .map(|p| p.tile())
                .collect();
            now != start
        }),
        "la faune est restée plantée"
    );

    // Un coup reçu et la bête détale.
    let victim = animals(&s)[0];
    s.inflict_injury(victim, BodyPart::Torso, 20);
    let tick = s.tick();
    let fleeing = find_pawn(&s, victim).expect("la bête est vivante");
    assert!(
        fleeing.flee_until > tick,
        "la bête frappée ne fuit pas : flee_until = {}, tick = {tick}",
        fleeing.flee_until
    );

    // Un raid ne se détourne pas sur le gibier : les PV de la faune ne bougent
    // pas d'un coup de pillard.
    let mut r = Sim::new(4, 48, 48);
    let before: Vec<(u32, u32)> = r
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Animal)
        .map(|p| (p.id, p.hp))
        .collect();
    assert!(!before.is_empty(), "aucune bête à observer");
    r.spawn_item(ItemKind::Berries, 200, 24, 24);
    r.step(&[Command::TriggerRaid]);
    for _ in 0..2 * DAY {
        r.step(&[]);
        for &(id, hp) in &before {
            if let Some(p) = find_pawn(&r, id) {
                assert_eq!(p.hp, hp, "un pillard s'en est pris à une bête");
                assert!(p.injuries.is_empty());
            }
        }
    }
    assert!(
        animals(&r).len() <= MAX_ANIMALS as usize,
        "plafond de faune dépassé"
    );
}

/// La chaîne complète : un colon armé abat le gibier marqué, la dépouille est
/// rangée puis débitée au poste, viande et cuir en sortent, la viande crue se
/// mange (mal) et se cuisine.
#[test]
fn armed_colonist_hunts_and_carcass_is_butchered() {
    let mut s = clearing();
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 8,
        y0: 5,
        x1: 9,
        y1: 6,
    }]);
    // Une massue plutôt qu'un arc : un cerf court plus vite qu'un colon, mais
    // la clairière est petite et il s'y retrouve acculé.
    s.spawn_item(ItemKind::Club, 1, 8, 5);
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    let deer = s.spawn_animal(2, 6, Species::Deer);

    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .any(|p| p.weapon.is_some())),
        "personne ne s'est armé"
    );
    s.step(&[Command::Hunt {
        animal: deer,
        on: true,
    }]);
    assert!(
        find_pawn(&s, deer).is_some_and(|p| p.hunted),
        "le marqueur de chasse n'est pas posé"
    );

    let mut hunted = false;
    let mut saw_carcass = false;
    let mut dead = false;
    for _ in 0..DAY {
        top_up_hunger(&mut s);
        s.step(&[]);
        hunted |= s
            .pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Hunt { target } if target == deer));
        dead |= find_pawn(&s, deer).is_none();
        saw_carcass |= s.items().iter().any(|i| i.kind.is_animal_corpse());
        if owned(&s, ItemKind::Meat) > 0 && owned(&s, ItemKind::Leather) > 0 {
            break;
        }
    }
    assert!(hunted, "aucun colon n'a pris le job de chasse");
    assert!(dead, "le cerf a survécu à la journée");
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::AnimalHunted && e.arg == Species::Deer as u32),
        "pas d'événement de chasse : {:?}",
        s.events()
    );
    assert!(saw_carcass, "aucune dépouille n'est tombée");
    assert!(
        !s.items().iter().any(|i| i.kind.is_animal_corpse()),
        "la dépouille n'a pas été débitée : {:?}",
        s.items()
    );
    assert_eq!(
        owned(&s, ItemKind::Leather),
        Species::Deer.leather(),
        "cuir du cerf"
    );
    let meat = owned(&s, ItemKind::Meat);
    assert!(
        meat > 0 && meat <= Species::Deer.meat(),
        "viande = {meat} (des colons ont pu en manger)"
    );

    // Un colon affamé se rabat sur la viande crue, et le fait savoir.
    s.spawn_item(ItemKind::Meat, 40, 8, 6);
    let glutton = s.pawns()[0].id;
    s.pawn_mut(glutton).expect("le colon existe").hunger = HUNGRY - 1;
    assert!(
        run_until(&mut s, DAY, |s| find_pawn(s, glutton)
            .is_some_and(|p| p.last_meal_quality == -1 && p.hunger > HUNGRY)),
        "personne n'a mangé de viande crue"
    );

    // Avec un feu, la viande devient repas comme n'importe quel cru.
    s.map_mut().set_feature(4, 2, Feature::Campfire);
    s.spawn_item(ItemKind::Meat, 40, 8, 6);
    assert!(
        run_until(&mut s, 2 * DAY, |s| owned(s, ItemKind::Meal) > 0),
        "aucun repas cuisiné à partir de viande : {:?}",
        s.items()
    );
}

/// À mains nues, on ne court pas après un cerf.
#[test]
fn unarmed_colonists_do_not_hunt() {
    let mut s = clearing();
    let deer = s.spawn_animal(2, 6, Species::Deer);
    s.spawn_item(ItemKind::Berries, 200, 6, 6);
    s.step(&[Command::Hunt {
        animal: deer,
        on: true,
    }]);
    assert!(
        s.pawns().iter().all(|p| p.weapon.is_none()),
        "un colon est armé, le test ne prouve rien"
    );
    for _ in 0..DAY / 4 {
        s.step(&[]);
        assert!(
            !s.pawns().iter().any(|p| matches!(p.job, Job::Hunt { .. })),
            "un colon désarmé est parti chasser au tick {}",
            s.tick()
        );
    }
    assert!(
        find_pawn(&s, deer).is_some(),
        "le cerf est mort sans chasseur"
    );
}

/// Le sanglier ne détale pas : il charge celui qui l'a piqué.
#[test]
fn boar_fights_back() {
    let mut s = clearing();
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 8,
        y0: 5,
        x1: 9,
        y1: 6,
    }]);
    s.spawn_item(ItemKind::Club, 1, 8, 5);
    s.spawn_item(ItemKind::Berries, 200, 6, 6);
    let boar = s.spawn_animal(3, 5, Species::Boar);
    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .any(|p| p.weapon.is_some())),
        "personne ne s'est armé"
    );
    s.step(&[Command::Hunt {
        animal: boar,
        on: true,
    }]);

    let mut charged = false;
    let mut wounded = false;
    for _ in 0..DAY {
        s.step(&[]);
        charged |= find_pawn(&s, boar).is_some_and(|p| matches!(p.job, Job::Attack { .. }));
        charged |= s
            .events()
            .iter()
            .any(|e| e.kind == EventKind::BoarAttacks && e.arg == boar);
        wounded |= s
            .pawns()
            .iter()
            .any(|p| p.faction == Faction::Colony && !p.injuries.is_empty());
        if charged && wounded {
            break;
        }
    }
    assert!(charged, "le sanglier n'a pas riposté : {:?}", s.events());
    assert!(wounded, "le sanglier n'a blessé personne");
}
