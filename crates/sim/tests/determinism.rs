//! Le test qui protège tout le projet : deux simulations nourries des mêmes
//! entrées doivent produire exactement le même état.

use sim::{
    BuildKind, Command, Designation, Faction, ItemKind, Material, Sim, TICKS_PER_DAY, WorkType,
    Zone,
};

const TICKS: u64 = 10_000;

/// Tick où le scénario gèle puis dégèle la carte, et durée du gel : l'avance
/// rapide consomme du RNG (la météo est retirée) et touche à tout l'état, elle
/// a donc sa place dans le scénario de référence.
const FAST_FORWARD_AT: u64 = 8_000;
const FAST_FORWARD_TICKS: u32 = 3_000;

/// Scénario de commandes reproductible : déplacements, désignations et zones
/// dérivés du numéro de tick.
fn scripted_commands(sim: &Sim, t: u64) -> Vec<Command> {
    let mut cmds = Vec::new();
    let w = sim.map().width() as i32;
    let h = sim.map().height() as i32;
    if t % 97 == 0 {
        cmds.push(Command::Nop);
    }
    if t == 10 {
        cmds.push(Command::SetZone {
            zone: Zone::Stockpile,
            x0: w / 2 - 3,
            y0: h / 2 - 3,
            x1: w / 2 + 3,
            y1: h / 2 + 3,
        });
    }
    if t % 500 == 20 {
        let k = (t / 500) as i32;
        cmds.push(Command::Designate {
            kind: if k % 3 == 0 {
                Designation::Chop
            } else if k % 3 == 1 {
                Designation::Harvest
            } else {
                Designation::Mine
            },
            x0: 0,
            y0: 0,
            x1: w - 1,
            y1: h - 1,
        });
    }
    if t == 40 {
        cmds.push(Command::Build {
            kind: BuildKind::Wall,
            material: Material::Wood,
            x0: w / 2 - 6,
            y0: h / 2 - 6,
            x1: w / 2 + 6,
            y1: h / 2 - 6,
        });
    }
    if t % 1500 == 700 {
        let k = (t / 1500) as i32;
        cmds.push(Command::Build {
            kind: if k % 2 == 0 {
                BuildKind::Floor
            } else {
                BuildKind::Bed
            },
            material: Material::Wood,
            x0: w / 2 + k,
            y0: h / 2 + 4,
            x1: w / 2 + k + 1,
            y1: h / 2 + 4,
        });
    }
    if t == 60 {
        cmds.push(Command::SetZone {
            zone: Zone::Growing,
            x0: w / 2 + 2,
            y0: h / 2 + 2,
            x1: w / 2 + 5,
            y1: h / 2 + 4,
        });
        cmds.push(Command::Build {
            kind: BuildKind::Campfire,
            material: Material::Wood,
            x0: w / 2 - 2,
            y0: h / 2 + 6,
            x1: w / 2 - 2,
            y1: h / 2 + 6,
        });
    }
    if t == 90 {
        // Les priorités de travail changent l'ordre des recherches de job.
        if let Some(p) = sim.pawns().first() {
            cmds.push(Command::SetPriority {
                pawn: p.id,
                work: WorkType::Haul,
                priority: 1,
            });
        }
    }
    if t == 6000 {
        // Le combat consomme du RNG : les deux sims doivent rester identiques.
        cmds.push(Command::TriggerRaid);
    }
    if t == 4000 {
        cmds.push(Command::CancelBuild {
            x0: w / 2 - 6,
            y0: h / 2 - 6,
            x1: w / 2 - 3,
            y1: h / 2 - 6,
        });
    }
    if t == 7000 {
        // Une caravane part : deux colons et du bois quittent la carte, et le
        // manifeste encodé entre dans l'état (donc dans le hash).
        let travellers: Vec<u32> = sim
            .pawns()
            .iter()
            .filter(|p| p.faction == Faction::Colony && p.is_alive() && !p.is_downed())
            .take(2)
            .map(|p| p.id)
            .collect();
        if travellers.len() == 2 {
            cmds.push(Command::FormCaravan {
                pawns: travellers,
                items: vec![(ItemKind::Wood, 15)],
            });
        }
    }
    if t == 7010 {
        // L'hôte a expédié le manifeste : tout le monde vide la file au même tick.
        cmds.push(Command::ClearDepartures { count: 1 });
    }
    if t == FAST_FORWARD_AT {
        // La colonie rouvre après une absence : le rattrapage est une commande
        // comme les autres, appliquée au même tick chez tout le monde.
        cmds.push(Command::FastForward {
            ticks: FAST_FORWARD_TICKS,
        });
    }
    if t % 900 == 0 {
        for (k, p) in sim.pawns().iter().enumerate() {
            cmds.push(Command::MoveTo {
                pawn: p.id,
                x: ((t * 7 + k as u64 * 13) % w as u64) as u32,
                y: ((t * 11 + k as u64 * 17) % h as u64) as u32,
            });
        }
    }
    cmds
}

#[test]
fn same_seed_same_commands_same_hash() {
    let mut a = Sim::new(0xDEAD_BEEF, 64, 64);
    let mut b = Sim::new(0xDEAD_BEEF, 64, 64);
    let mut caravan_left = false;
    for t in 0..TICKS {
        let cmds = scripted_commands(&a, t);
        a.step(&cmds);
        b.step(&cmds);
        if t == 7005 {
            caravan_left = a.departures().len() == 1;
        }
        if t == 7015 {
            assert!(
                a.departures().is_empty(),
                "la file des départs n'a pas été vidée"
            );
        }
        if t % 1000 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "désync au tick {t}");
        }
    }
    assert!(caravan_left, "le scénario n'a pas fait partir de caravane");
    // Les ticks joués, plus ceux que l'avance rapide a sautés.
    assert_eq!(a.tick(), TICKS + u64::from(FAST_FORWARD_TICKS));
    assert_eq!(a.state_hash(), b.state_hash());
    assert_eq!(a, b);
    // Le scénario a bien produit du gameplay, pas seulement de la marche.
    assert!(
        !a.items().is_empty(),
        "aucun objet produit en {TICKS} ticks"
    );
}

#[test]
fn different_seeds_diverge() {
    let a = Sim::new(1, 32, 32);
    let b = Sim::new(2, 32, 32);
    assert_ne!(a.state_hash(), b.state_hash());
    assert_ne!(a.map().tiles(), b.map().tiles());
}

#[test]
fn hash_changes_with_ticks() {
    let mut a = Sim::new(3, 32, 32);
    let h0 = a.state_hash();
    a.step(&[]);
    assert_ne!(h0, a.state_hash());
}

#[test]
fn snapshot_roundtrip_then_identical_future() {
    let mut a = Sim::new(42, 48, 48);
    for t in 0..TICKS / 2 {
        a.step(&scripted_commands(&a, t));
    }
    let bytes = a.snapshot();
    let mut b = Sim::restore(&bytes).expect("snapshot valide");
    assert_eq!(a, b);
    for t in TICKS / 2..TICKS {
        let cmds = scripted_commands(&a, t);
        a.step(&cmds);
        b.step(&cmds);
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

#[test]
fn corrupt_snapshot_is_rejected() {
    assert!(Sim::restore(&[0xFF, 0xFF, 0xFF]).is_err());
}

#[test]
fn map_has_main_terrains_and_features() {
    let s = Sim::new(7, 128, 128);
    let tiles = s.map().tiles();
    for t in [
        sim::Terrain::DeepWater,
        sim::Terrain::Sand,
        sim::Terrain::Grass,
        sim::Terrain::Gravel,
    ] {
        assert!(tiles.contains(&(t as u8)), "terrain {t:?} absent");
    }
    let features = s.map().features();
    for f in [sim::Feature::Tree, sim::Feature::Rock, sim::Feature::Bush] {
        assert!(features.contains(&(f as u8)), "élément {f:?} absent");
    }
}

#[test]
fn starting_pawns_exist_on_passable_tiles() {
    let s = Sim::new(5, 64, 64);
    assert_eq!(s.pawns().len(), 3);
    for p in s.pawns() {
        let (x, y) = p.tile();
        assert!(s.map().passable(x, y));
    }
}

#[test]
fn pawn_reaches_ordered_destination() {
    let mut s = Sim::new(11, 64, 64);
    let id = s.pawns()[0].id;
    let from = s.pawns()[0].tile();
    let target = s
        .map()
        .nearest_passable(from.0.saturating_sub(10), from.1.saturating_sub(10))
        .unwrap();
    s.step(&[Command::MoveTo {
        pawn: id,
        x: target.0,
        y: target.1,
    }]);
    if !s.pawns()[0].is_moving() {
        return;
    }
    for _ in 0..TICKS {
        s.step(&[]);
        if s.pawns()[0].tile() == target {
            return;
        }
        if !s.pawns()[0].is_moving() {
            break;
        }
    }
    panic!(
        "le pawn n'a pas atteint {target:?}, il est en {:?}",
        s.pawns()[0].tile()
    );
}

#[test]
fn time_of_day_wraps() {
    let mut s = Sim::new(1, 16, 16);
    let t0 = s.time_of_day();
    for _ in 0..TICKS_PER_DAY {
        s.step(&[]);
    }
    assert_eq!(s.time_of_day(), t0);
}
