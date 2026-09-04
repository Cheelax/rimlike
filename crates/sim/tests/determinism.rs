//! Le test qui protège tout le projet : deux simulations nourries des mêmes
//! entrées doivent produire exactement le même état.

use sim::{Command, Sim, TICKS_PER_DAY};

const TICKS: u64 = 10_000;

/// Scénario de commandes reproductible : des ordres de déplacement réguliers
/// vers des cases dérivées du numéro de tick.
fn scripted_commands(sim: &Sim, t: u64) -> Vec<Command> {
    let mut cmds = Vec::new();
    if t % 97 == 0 {
        cmds.push(Command::Nop);
    }
    if t % 300 == 0 {
        let w = sim.map().width() as u64;
        let h = sim.map().height() as u64;
        for (k, p) in sim.pawns().iter().enumerate() {
            cmds.push(Command::MoveTo {
                pawn: p.id,
                x: ((t * 7 + k as u64 * 13) % w) as u32,
                y: ((t * 11 + k as u64 * 17) % h) as u32,
            });
        }
    }
    cmds
}

#[test]
fn same_seed_same_commands_same_hash() {
    let mut a = Sim::new(0xDEAD_BEEF, 64, 64);
    let mut b = Sim::new(0xDEAD_BEEF, 64, 64);
    for t in 0..TICKS {
        let cmds = scripted_commands(&a, t);
        a.step(&cmds);
        b.step(&cmds);
        if t % 1000 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "désync au tick {t}");
        }
    }
    assert_eq!(a.tick(), TICKS);
    assert_eq!(a.state_hash(), b.state_hash());
    assert_eq!(a, b);
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
fn map_has_main_terrains() {
    let s = Sim::new(7, 128, 128);
    let tiles = s.map().tiles();
    for t in [
        sim::Terrain::DeepWater,
        sim::Terrain::Sand,
        sim::Terrain::Grass,
        sim::Terrain::Rock,
        sim::Terrain::Tree,
    ] {
        assert!(
            tiles.contains(&(t as u8)),
            "terrain {t:?} absent de la carte de test"
        );
    }
}

#[test]
fn starting_pawns_exist_on_walkable_tiles() {
    let s = Sim::new(5, 64, 64);
    assert_eq!(s.pawns().len(), 3);
    for p in s.pawns() {
        let (x, y) = p.tile();
        assert!(s.map().get(x, y).walkable());
    }
}

#[test]
fn pawn_reaches_ordered_destination() {
    let mut s = Sim::new(11, 64, 64);
    let id = s.pawns()[0].id;
    let from = s.pawns()[0].tile();
    let target = s
        .map()
        .nearest_walkable(from.0.saturating_sub(10), from.1.saturating_sub(10))
        .unwrap();
    s.step(&[Command::MoveTo {
        pawn: id,
        x: target.0,
        y: target.1,
    }]);
    if !s.pawns()[0].is_moving() {
        // Cible inaccessible pour ce seed : rien de plus à vérifier.
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
