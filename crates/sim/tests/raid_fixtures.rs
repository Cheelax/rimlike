//! Les mêmes snapshots sont rejoués dans apps/client/test/raid-parity.test.ts.
//! Régénérer explicitement avec l'exemple raid_fixtures quand le comportement change.
use sim::{Job, Sim};

#[test]
fn la_veille_et_la_defense_rejouent_les_empreintes_natives() {
    for (name, bytes, ticks, hash, stance) in [
        (
            "veille",
            include_bytes!("fixtures/raid-watch.bin").as_slice(),
            include_str!("fixtures/raid-watch.ticks"),
            include_str!("fixtures/raid-watch.hash"),
            2,
        ),
        (
            "défense",
            include_bytes!("fixtures/raid-hold.bin").as_slice(),
            include_str!("fixtures/raid-hold.ticks"),
            include_str!("fixtures/raid-hold.hash"),
            1,
        ),
        (
            "retour éloigné",
            include_bytes!("fixtures/raid-return.bin").as_slice(),
            include_str!("fixtures/raid-return.ticks"),
            include_str!("fixtures/raid-return.hash"),
            2,
        ),
    ] {
        let mut s = Sim::restore(bytes).unwrap();
        assert_eq!(s.raid_status()[0], stance);
        if stance == 1 {
            assert!(
                s.pawns()
                    .iter()
                    .any(|p| matches!(p.job, Job::Defend { .. }))
            );
        }
        for _ in 0..ticks.trim().parse::<u32>().unwrap() {
            s.step(&[]);
        }
        assert_eq!(format!("{:016x}", s.state_hash()), hash.trim(), "{name}");
        if name == "retour éloigné" {
            assert_eq!(s.raid_status()[1], 6, "le préavis n'est pas encore terminé");
            assert_eq!(s.pawns().iter().filter(|p| p.is_colonist()).count(), 3);
            assert!(
                s.pawns()
                    .iter()
                    .filter(|p| p.is_colonist())
                    .all(|p| s.map().room(p.tile().0, p.tile().1) != 0)
            );
        }
    }
}
