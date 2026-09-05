//! `Command::SetGoodwill` : le serveur monde impose la réputation de départ
//! d'une colonie neuve envers les trois factions PNJ, comme il impose déjà
//! son climat (`Command::SetClimate`) et son calendrier (`Command::SetCalendar`,
//! voir `tests/calendar.rs`). Ces tests couvrent ce que `AGENTS.md` exige
//! d'une telle commande : les valeurs sont bornées comme `Sim::set_goodwill`,
//! aucun franchissement de seuil n'est annoncé (`EventKind::RelationChanged`),
//! et un raid mené par le storyteller respecte bien la réputation imposée.

use sim::factions::{
    ALLY_GOODWILL, GOODWILL_MAX, GOODWILL_MIN, GUILD, HOSTILE_GOODWILL, START_GOODWILL,
};
use sim::testmap::map_from;
use sim::{Command, EventKind, ItemKind, Sim, TICKS_PER_DAY};

const DAY: u64 = TICKS_PER_DAY as u64;

/// Clairière dégagée de douze cases sur huit, identique à
/// `tests/factions.rs::colony` (jusqu'au coin en zone de stockage, sans quoi
/// les colons désœuvrés ne consommeraient pas le générateur aléatoire de la
/// même façon, et la fenêtre de raid mesurée plus bas ne serait plus
/// comparable à celle du test dont ce fichier reprend le patron).
fn colony(seed: u64) -> Sim {
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
    let mut s = Sim::from_map(seed, map);
    for y in 0..2 {
        for x in 0..3 {
            s.map_mut().set_zone(x, y, sim::Zone::Stockpile);
        }
    }
    feed(&mut s);
    s
}

/// De quoi tenir une journée de plus, posé au centre de la colonie.
fn feed(s: &mut Sim) {
    let (x, y) = s.colony_center().unwrap_or((6, 4));
    s.spawn_item(ItemKind::Berries, 60, x, y);
}

/// Avance de `ticks`, en nourrissant la colonie une fois par jour.
fn run_fed(s: &mut Sim, ticks: u64) {
    for _ in 0..ticks {
        if s.tick() % DAY == 0 {
            feed(s);
        }
        s.step(&[]);
    }
}

fn count_events(s: &Sim, kind: EventKind) -> usize {
    s.events().iter().filter(|e| e.kind == kind).count()
}

fn colonists_alive(s: &Sim) -> usize {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .count()
}

/// Les trois valeurs sont appliquées telles quelles, et chacune bornée comme
/// `Sim::set_goodwill` — y compris aux bornes de `i32`, sans jamais paniquer
/// ni déborder.
#[test]
fn set_goodwill_applies_and_clamps_each_faction() {
    let mut s = Sim::new(1, 16, 16);
    assert_eq!(
        s.goodwill(),
        &START_GOODWILL,
        "réputation de départ inchangée avant la commande"
    );

    s.step(&[Command::SetGoodwill {
        values: [40, -73, 999],
    }]);
    assert_eq!(s.goodwill()[0], 40);
    assert_eq!(s.goodwill()[1], -73);
    assert_eq!(s.goodwill()[2], GOODWILL_MAX, "999 doit être borné");

    s.step(&[Command::SetGoodwill {
        values: [i32::MIN, i32::MAX, 0],
    }]);
    assert_eq!(s.goodwill()[0], GOODWILL_MIN);
    assert_eq!(s.goodwill()[1], GOODWILL_MAX);
    assert_eq!(s.goodwill()[2], 0);
}

/// Un état de départ ne se joue pas comme une évolution : même quand les
/// valeurs imposées franchissent les deux seuils, rien n'est annoncé.
#[test]
fn set_goodwill_emits_no_relation_changed_event() {
    let mut s = Sim::new(2, 16, 16);
    s.step(&[Command::SetGoodwill {
        values: [ALLY_GOODWILL, HOSTILE_GOODWILL - 10, ALLY_GOODWILL + 20],
    }]);
    assert_eq!(
        count_events(&s, EventKind::RelationChanged),
        0,
        "un état de départ imposé ne doit annoncer aucun franchissement de seuil : {:?}",
        s.events()
    );
}

/// Patron de `allied_tribes_never_raid` (`tests/factions.rs`) : une réputation
/// imposée par `Command::SetGoodwill` compte exactement comme une réputation
/// gagnée en jeu pour le tirage du storyteller. Les deux tribus mises à
/// `ALLY_GOODWILL` n'attaquent plus par le chemin naturel, sur trois graines ;
/// un témoin sans la commande montre qu'une bande serait sinon bien entrée.
#[test]
fn set_goodwill_is_respected_by_the_storyteller() {
    const DAYS: u64 = 6;
    for seed in 1..=3u64 {
        let mut allied = colony(seed);
        allied.set_difficulty(sim::Difficulty::Hard);
        allied.step(&[Command::SetGoodwill {
            values: [ALLY_GOODWILL, ALLY_GOODWILL, START_GOODWILL[GUILD as usize]],
        }]);
        run_fed(&mut allied, DAYS * DAY);
        assert_eq!(
            count_events(&allied, EventKind::Raid),
            0,
            "graine {seed} : une bande est entrée malgré une réputation imposée alliée"
        );
        assert!(
            colonists_alive(&allied) > 0,
            "graine {seed} : colonie éteinte, l'absence de raid ne prouve rien"
        );

        // Témoin : la même graine, sans la commande, laisse entrer au moins
        // une bande sur la même fenêtre.
        let mut hostile = colony(seed);
        hostile.set_difficulty(sim::Difficulty::Hard);
        run_fed(&mut hostile, DAYS * DAY);
        assert!(
            count_events(&hostile, EventKind::Raid) > 0,
            "graine {seed} : aucune bande sans réputation imposée non plus, le témoin ne dit rien"
        );
    }
}

/// La réputation imposée fait partie de l'état : elle survit à un
/// aller-retour de snapshot, et deux sims repartis du même snapshot restent
/// d'accord au bit près.
#[test]
fn set_goodwill_survives_snapshot() {
    let mut s = Sim::new(3, 16, 16);
    s.step(&[Command::SetGoodwill {
        values: [60, -60, 5],
    }]);

    let bytes = s.snapshot();
    let mut back = Sim::restore(&bytes).expect("snapshot relu");
    assert_eq!(back.goodwill(), s.goodwill());
    assert_eq!(back.state_hash(), s.state_hash());

    for _ in 0..300 {
        s.step(&[]);
        back.step(&[]);
    }
    assert_eq!(back.state_hash(), s.state_hash(), "les deux sims divergent");
    assert_eq!(back.goodwill(), s.goodwill());
}
