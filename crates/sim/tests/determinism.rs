//! Le test qui protège tout le projet : deux simulations nourries des mêmes
//! entrées doivent produire exactement le même état.

use sim::scenario::{self, FAST_FORWARD_TICKS, demo_commands};
use sim::{Command, Faction, Sim, TICKS_PER_DAY};

const TICKS: u64 = 10_000;

/// Tick où un marchand entre sur la carte (hors commande : c'est une méthode
/// du sim, appelée des deux côtés). Assez tôt pour qu'il soit encore là au
/// raid du tick 6000 et à l'avance rapide qui le renvoie chez lui.
const TRADER_AT: u64 = 4_000;

#[test]
fn same_seed_same_commands_same_hash() {
    let mut a = Sim::new(0xDEAD_BEEF, 64, 64);
    let mut b = Sim::new(0xDEAD_BEEF, 64, 64);
    let mut caravan_left = false;
    let mut trader_arrived = false;
    for t in 0..TICKS {
        let cmds = demo_commands(&a, t);
        a.step(&cmds);
        b.step(&cmds);
        if t == TRADER_AT {
            // Le premier marchand n'arriverait qu'au quatrième jour (57 600
            // ticks) : on le fait entrer à la main des deux côtés, hors
            // commande, pour que son apparition (tirages de profil, de
            // quantités et d'étal), sa marche, sa neutralité pendant le raid du
            // tick 6000 et son départ à l'avance rapide entrent dans le hash.
            trader_arrived = a.trigger_trader_visit().is_some();
            b.trigger_trader_visit();
        }
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
    assert!(trader_arrived, "le scénario n'a pas reçu de marchand");

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

/// L'empreinte épinglée du scénario de référence, jouée en natif : graine 1,
/// 64×64, 10 000 tours de boucle, `Sim::new`, commandes avant `step` — la
/// partie que décrit `scenario::DEMO_HASH` et que rejoue
/// `rimlike-sim run --seed 1 --size 64 --ticks 10000 --scenario demo`.
///
/// `apps/client/test/parity.test.ts` rejoue la même partie en **WASM** et
/// compare son hash à la même constante, lue à travers la frontière : la
/// parité natif/WASM se prouve par transitivité.
///
/// Ce test échoue dès que le sim change : c'est son rôle. Celui qui change le
/// sim met la constante à jour dans le même commit, et écrit pourquoi.
#[test]
fn demo_hash_is_pinned() {
    let mut sim = Sim::new(
        scenario::DEMO_SEED,
        scenario::DEMO_SIZE,
        scenario::DEMO_SIZE,
    );
    for t in 0..scenario::DEMO_TICKS {
        let cmds = demo_commands(&sim, t);
        sim.step(&cmds);
    }
    // L'avance rapide du tick 8 000 saute ses ticks sans tour de boucle.
    assert_eq!(
        sim.tick(),
        scenario::DEMO_TICKS + u64::from(FAST_FORWARD_TICKS)
    );
    assert_eq!(
        sim.state_hash(),
        scenario::DEMO_HASH,
        "le scénario de référence ne rend plus la même partie : {:016x} au lieu de {:016x}",
        sim.state_hash(),
        scenario::DEMO_HASH
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
        a.step(&demo_commands(&a, t));
    }
    let bytes = a.snapshot();
    let mut b = Sim::restore(&bytes).expect("snapshot valide");
    assert_eq!(a, b);
    for t in TICKS / 2..TICKS {
        let cmds = demo_commands(&a, t);
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
    // Trois colons, plus la faune de départ (`animals::spawn_starting_animals`).
    assert_eq!(
        s.pawns()
            .iter()
            .filter(|p| p.faction == Faction::Colony)
            .count(),
        3
    );
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
