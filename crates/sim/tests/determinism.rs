//! Le test qui protège tout le projet : deux simulations nourries des mêmes
//! entrées doivent produire exactement le même état.

use sim::{Command, Sim};

const TICKS: u64 = 10_000;

#[test]
fn same_seed_same_commands_same_hash() {
    let mut a = Sim::new(0xDEAD_BEEF, 64, 64);
    let mut b = Sim::new(0xDEAD_BEEF, 64, 64);
    for t in 0..TICKS {
        let cmds = if t % 97 == 0 {
            vec![Command::Nop]
        } else {
            vec![]
        };
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
    for _ in 0..TICKS / 2 {
        a.step(&[]);
    }
    let bytes = a.snapshot();
    let mut b = Sim::restore(&bytes).expect("snapshot valide");
    assert_eq!(a, b);
    for _ in 0..TICKS / 2 {
        a.step(&[]);
        b.step(&[]);
    }
    assert_eq!(a.state_hash(), b.state_hash());
}

#[test]
fn corrupt_snapshot_is_rejected() {
    assert!(Sim::restore(&[0xFF, 0xFF, 0xFF]).is_err());
}

#[test]
fn map_has_every_terrain() {
    let s = Sim::new(7, 128, 128);
    let tiles = s.map().tiles();
    for t in 0..5u8 {
        assert!(tiles.contains(&t), "terrain {t} absent de la carte de test");
    }
}
