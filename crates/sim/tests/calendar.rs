//! `Command::SetCalendar` : le serveur monde impose le jour de l'année d'une
//! colonie neuve, comme il impose son climat (`Command::SetClimate`,
//! `docs/protocol.md` §11.6). Ces tests couvrent ce que `docs/PLAN.md` et
//! `AGENTS.md` exigent d'une commande de calendrier : elle ne touche ni au
//! tick ni à `time_of_day`, elle est bornée par un simple modulo, et
//! `Command::FastForward` continue de fonctionner après elle exactement comme
//! avant.

use sim::{Command, EventKind, Season, Sim, TICKS_PER_DAY, YEAR_DAYS};

#[test]
fn set_calendar_moves_day_of_year_and_season() {
    let mut winter = Sim::new(3, 16, 16);
    winter.step(&[Command::SetCalendar { day_of_year: 45 }]);
    assert_eq!(winter.day_of_year(), 45);
    assert_eq!(winter.season(), Season::Winter);

    let mut summer = Sim::new(3, 16, 16);
    summer.step(&[Command::SetCalendar { day_of_year: 15 }]);
    assert_eq!(summer.day_of_year(), 15);
    assert_eq!(summer.season(), Season::Summer);

    // Même seed, même tick (un seul `step` de chaque côté) : seule la
    // commande diffère, donc seule la température saisonnière doit varier.
    assert!(
        winter.outdoor_temperature() < summer.outdoor_temperature(),
        "hiver {} vs été {} au jour imposé",
        winter.outdoor_temperature(),
        summer.outdoor_temperature()
    );
}

#[test]
fn set_calendar_does_not_touch_tick_or_time_of_day() {
    let mut with_calendar = Sim::new(1, 16, 16);
    let mut without = Sim::new(1, 16, 16);
    with_calendar.step(&[Command::SetCalendar { day_of_year: 45 }]);
    without.step(&[Command::Nop]);

    assert_eq!(with_calendar.tick(), without.tick());
    assert_eq!(with_calendar.time_of_day(), without.time_of_day());
    assert_ne!(
        with_calendar.day_of_year(),
        without.day_of_year(),
        "la commande doit bien avoir changé le jour"
    );
}

#[test]
fn set_calendar_wraps_value_beyond_year_days() {
    let mut a = Sim::new(5, 16, 16);
    let mut b = Sim::new(5, 16, 16);
    a.step(&[Command::SetCalendar { day_of_year: 45 }]);
    b.step(&[Command::SetCalendar {
        day_of_year: 45 + YEAR_DAYS * 7,
    }]);
    assert_eq!(a.day_of_year(), 45);
    assert_eq!(b.day_of_year(), 45);
    // Un multiple de `YEAR_DAYS` de plus ne doit rien changer d'autre à
    // l'état : mêmes deux sims au bit près.
    assert_eq!(a, b);

    // Valeur aux bornes de `u32` : ni panique, ni jour hors bornes.
    let mut extreme = Sim::new(5, 16, 16);
    extreme.step(&[Command::SetCalendar {
        day_of_year: u32::MAX,
    }]);
    assert!(extreme.day_of_year() < YEAR_DAYS);
}

#[test]
fn fast_forward_after_set_calendar_continues_from_imposed_day() {
    let mut s = Sim::new(7, 16, 16);
    s.step(&[Command::SetCalendar { day_of_year: 50 }]);
    let before = s.day_of_year();
    assert_eq!(before, 50);

    s.step(&[Command::FastForward {
        ticks: TICKS_PER_DAY * 3,
    }]);
    assert_eq!(
        s.day_of_year(),
        (before + 3) % YEAR_DAYS,
        "l'avance rapide part bien de la valeur imposée"
    );
}

#[test]
fn set_calendar_emits_season_changed_when_season_differs() {
    let mut s = Sim::new(9, 16, 16);
    assert_eq!(s.season(), Season::Spring, "on commence au printemps");

    s.step(&[Command::SetCalendar { day_of_year: 45 }]); // hiver
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::SeasonChanged && e.arg == Season::Winter as u32),
        "aucun SeasonChanged malgré le changement de saison : {:?}",
        s.events()
    );
}

#[test]
fn set_calendar_does_not_emit_season_changed_when_season_is_unchanged() {
    let mut s = Sim::new(9, 16, 16);
    // Jour 5 : toujours le printemps, comme au départ.
    s.step(&[Command::SetCalendar { day_of_year: 5 }]);
    assert_eq!(s.season(), Season::Spring);
    assert!(
        !s.events()
            .iter()
            .any(|e| e.kind == EventKind::SeasonChanged),
        "aucun changement de saison ne devait être annoncé"
    );
}
