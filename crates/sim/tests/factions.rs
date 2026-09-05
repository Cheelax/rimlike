//! Factions PNJ et réputation : qui attaque, qui vend, à quel prix, et ce que
//! la colonie peut y changer.
//!
//! Toutes les cartes sont dessinées à la main et la colonie est nourrie une
//! fois par jour : ce qui est mesuré ici, ce sont les raids, les tributs et les
//! marchands, jamais la famine.

use sim::factions::{
    ALLY_GOODWILL, FACTION_COUNT, FACTION_NAMES, GIFT_VALUE_PER_POINT, GUILD, HOSTILE_GOODWILL,
    RAID_LED, RAID_REPELLED_GUILD, RAID_REPELLED_OTHER, START_GOODWILL, TRADE_DONE, TRADER_ANGERED,
    TRADER_KILLED,
};
use sim::health::SEVERITY_MAX;
use sim::testmap::map_from;
use sim::trade::{ALLY_SELL_NUM, SELL_DEN, item_value, value_buy, value_sell};
use sim::{
    BodyPart, Command, EventKind, Faction, ItemKind, RaidKind, Relation, Sim, TICKS_PER_DAY,
};

const DAY: u64 = TICKS_PER_DAY as u64;

/// Clairière dégagée de douze cases sur huit : trois colons au centre, un coin
/// en zone de stockage (les tributs et les trocs se prélèvent **en
/// stockage**), et de quoi manger.
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

/// Range une réserve dans le stockage du coin nord-ouest.
fn store(s: &mut Sim, kind: ItemKind, count: u32) {
    s.spawn_item(kind, count, 0, 0);
    assert_eq!(
        s.stored_totals()[kind as usize],
        count,
        "la réserve n'est pas en stockage"
    );
}

/// De quoi tenir une journée de plus.
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

fn raiders(s: &Sim) -> usize {
    s.pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider && p.is_alive())
        .count()
}

fn colonists(s: &Sim) -> usize {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .count()
}

fn count_events(s: &Sim, kind: EventKind) -> usize {
    s.events().iter().filter(|e| e.kind == kind).count()
}

/// Tue tous les pillards présents et laisse le sim faire le ménage, puis un
/// tick de plus : c'est au tick suivant la dernière mort que le storyteller
/// tranche le sort de la bande (`Sim::resolve_raid`).
fn wipe_raiders(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider && p.is_alive())
        .map(|p| p.id)
        .collect();
    for id in ids {
        s.inflict_injury(id, BodyPart::Torso, SEVERITY_MAX);
    }
    s.step(&[]);
    s.step(&[]);
    assert_eq!(raiders(s), 0, "des pillards ont survécu au coup de grâce");
}

// ----------------------------------------------------------------------
// Qui mène les raids
// ----------------------------------------------------------------------

/// Une bande appartient à une tribu, et attaquer se paie : la tribu qui mène
/// perd `RAID_LED` de réputation, l'autre ne paie rien. Le tirage est pondéré
/// par l'hostilité — mesuré sur quarante graines, pas supposé.
#[test]
fn raids_are_led_by_a_hostile_tribe_and_cost_goodwill() {
    // Tribu 1 alliée : elle est écartée du tirage, la bande vient donc
    // forcément de la tribu 0.
    let mut s = colony(1);
    s.set_goodwill(0, -80);
    s.set_goodwill(1, ALLY_GOODWILL + 10);
    assert!(s.spawn_raid() > 0, "aucun pillard : {:?}", s.pawns());
    assert_eq!(s.last_raid_faction(), Some(0), "bande sans propriétaire");
    assert_eq!(s.goodwill()[0], -80 + RAID_LED, "le raid n'a rien coûté");
    assert_eq!(
        s.goodwill()[1],
        ALLY_GOODWILL + 10,
        "la tribu alliée a payé pour l'autre"
    );

    // Le poids est `100 − réputation` : à −100 contre +40, la tribu 0 doit
    // mener environ 200/260 des bandes. On mesure, avec de la marge.
    const SEEDS: u64 = 40;
    let mut led_by_zero = 0;
    for seed in 1..=SEEDS {
        let mut s = colony(seed);
        s.set_goodwill(0, -100);
        s.set_goodwill(1, 40);
        assert!(s.spawn_raid() > 0);
        if s.last_raid_faction() == Some(0) {
            led_by_zero += 1;
        }
    }
    assert!(
        (24..SEEDS).contains(&led_by_zero),
        "{led_by_zero}/{SEEDS} bandes menées par la tribu détestée : \
         le tirage n'est pas pondéré (attendu ~31, jamais 40)"
    );
}

/// Une tribu alliée n'attaque plus : le storyteller ne fait plus entrer aucune
/// bande quand les deux sont amies. `Command::TriggerRaid`, lui, reste un
/// **outil de débogage** et ignore les alliances — sinon il cesserait d'être un
/// outil dès la première paix signée.
#[test]
fn allied_tribes_never_raid() {
    // L'outil de débogage passe outre, sur trente graines.
    for seed in 1..=30u64 {
        let mut s = colony(seed);
        s.set_goodwill(0, ALLY_GOODWILL + 10);
        s.set_goodwill(1, ALLY_GOODWILL + 40);
        let spawned = s.trigger_raid_of(RaidKind::Rush);
        assert!(spawned > 0, "graine {seed} : TriggerRaid n'a rien fait");
        assert!(
            s.last_raid_faction().is_some(),
            "graine {seed} : bande sans propriétaire"
        );
    }

    // Le chemin naturel, lui, s'arrête net : rien n'entre, quelle que soit la
    // patience. Trois graines suffisent pour l'affirmer si le témoin, lui, voit
    // bien des bandes : six jours couvrent la grâce de trois jours et au moins
    // une échéance de plus (`Difficulty::Hard` : 1,5 à 3 jours).
    const DAYS: u64 = 6;
    for seed in 1..=3u64 {
        let mut allied = colony(seed);
        allied.set_difficulty(sim::Difficulty::Hard);
        allied.set_goodwill(0, ALLY_GOODWILL);
        allied.set_goodwill(1, ALLY_GOODWILL);
        run_fed(&mut allied, DAYS * DAY);
        assert_eq!(
            count_events(&allied, EventKind::Raid),
            0,
            "graine {seed} : une bande est entrée malgré deux tribus alliées"
        );
        assert!(
            colonists(&allied) > 0,
            "graine {seed} : colonie éteinte, l'absence de raid ne prouve rien"
        );

        let mut hostile = colony(seed);
        hostile.set_difficulty(sim::Difficulty::Hard);
        run_fed(&mut hostile, DAYS * DAY);
        assert!(
            count_events(&hostile, EventKind::Raid) > 0,
            "graine {seed} : aucune bande sans alliance non plus, le témoin ne dit rien"
        );
    }
}

/// Repousser une bande, c'est se faire une réputation de place forte : la
/// Guilde y gagne, et la tribu rivale apprécie qu'on ait saigné celle d'en
/// face.
#[test]
fn repelling_a_raid_pleases_the_guild_and_the_other_tribe() {
    let mut s = colony(3);
    // Tribu 1 alliée : la bande vient de la tribu 0, sans ambiguïté.
    s.set_goodwill(0, -80);
    s.set_goodwill(1, ALLY_GOODWILL);
    s.set_goodwill(GUILD, 0);
    assert!(s.spawn_raid() > 0);
    assert_eq!(s.last_raid_faction(), Some(0));
    let led = s.goodwill()[0];
    assert_eq!(
        count_events(&s, EventKind::RaidRepelled),
        0,
        "raid en cours"
    );

    wipe_raiders(&mut s);

    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::RaidRepelled && e.arg == 0),
        "raid repoussé non annoncé, ou annoncé pour la mauvaise tribu : {:?}",
        s.events()
    );
    assert_eq!(s.goodwill()[GUILD as usize], RAID_REPELLED_GUILD);
    assert_eq!(s.goodwill()[1], ALLY_GOODWILL + RAID_REPELLED_OTHER);
    assert_eq!(s.goodwill()[0], led, "la tribu battue s'est bonifiée");

    // Une seule annonce par bande : le drapeau est retombé.
    run_fed(&mut s, 10);
    assert_eq!(count_events(&s, EventKind::RaidRepelled), 1);
}

// ----------------------------------------------------------------------
// Payer sa paix
// ----------------------------------------------------------------------

/// Le tribut : la marchandise part, la réputation monte, et une tribu qu'on
/// paie régulièrement finit alliée — elle n'attaque plus.
#[test]
fn gifts_buy_peace() {
    let mut s = colony(4);
    s.set_goodwill(0, 40);
    // 100 cuirs valent 400, soit vingt points de réputation
    // (`GIFT_VALUE_PER_POINT`) : de quoi franchir le seuil d'alliance.
    store(&mut s, ItemKind::Leather, 100);
    let expected = (item_value(ItemKind::Leather) * 100 / GIFT_VALUE_PER_POINT) as i32;
    assert_eq!(expected, 20, "barème du tribut changé sans le test");

    s.step(&[Command::Gift {
        faction: 0,
        kind: ItemKind::Leather,
        count: 100,
    }]);

    assert_eq!(
        s.stored_totals()[ItemKind::Leather as usize],
        0,
        "le tribut est resté au chaud"
    );
    assert_eq!(s.goodwill()[0], 40 + expected);
    assert_eq!(
        s.relation(0),
        Relation::Ally,
        "seuil d'alliance non franchi"
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::Gift && e.arg == 0),
        "tribut non annoncé : {:?}",
        s.events()
    );
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::RelationChanged && e.arg == 0),
        "franchissement de seuil non annoncé : {:?}",
        s.events()
    );

    // La paix achetée tient : les deux tribus alliées, plus une bande n'entre.
    s.set_goodwill(1, ALLY_GOODWILL);
    assert_eq!(s.spawn_raid(), 0, "une bande est entrée chez des alliés");

    // Ce qu'on n'a pas, on ne l'offre pas : rien ne bouge, ni stock ni
    // réputation. Une faction inventée non plus.
    let before = *s.goodwill();
    store(&mut s, ItemKind::Leather, 5);
    s.step(&[Command::Gift {
        faction: 0,
        kind: ItemKind::Leather,
        count: 6,
    }]);
    s.step(&[Command::Gift {
        faction: 200,
        kind: ItemKind::Leather,
        count: 5,
    }]);
    assert_eq!(s.stored_totals()[ItemKind::Leather as usize], 5);
    assert_eq!(
        *s.goodwill(),
        before,
        "un tribut refusé a changé la réputation"
    );
}

// ----------------------------------------------------------------------
// La Guilde
// ----------------------------------------------------------------------

/// La Guilde sert mieux ses alliés : 110 % au lieu de 120 %. Le tarif d'achat,
/// lui, ne bouge pas — et un troc qui ne passait pas passe.
#[test]
fn guild_prices_drop_when_allied() {
    let mut s = colony(5);
    let bow = ItemKind::Bow;
    let base = value_sell(bow);
    let ally = item_value(bow) * ALLY_SELL_NUM / SELL_DEN;
    assert!(
        ally < base,
        "un allié ne paie pas moins cher : {ally} / {base}"
    );
    assert_eq!(
        s.sell_price(bow),
        base,
        "la colonie n'est pas encore alliée"
    );

    s.set_goodwill(GUILD, ALLY_GOODWILL);
    assert_eq!(s.sell_price(bow), ally);
    assert_eq!(
        s.buy_prices()[ItemKind::Wood as usize],
        value_buy(ItemKind::Wood),
        "la marge d'achat a bougé"
    );

    // Vu du client : l'étal affiche le tarif de l'allié.
    let id = s
        .trigger_trader_visit()
        .expect("un marchand doit pouvoir entrer");
    s.pawn_mut(id).expect("le marchand est là").wares = vec![(bow, 2)];
    assert_eq!(s.trader_offers(), vec![(bow, 2, ally)]);

    // Et le troc lui-même : `ally` bois suffisent (un bois vaut un point à
    // l'achat), là où le tarif ordinaire en demanderait `base`.
    store(&mut s, ItemKind::Wood, base);
    assert_eq!(value_buy(ItemKind::Wood), 1, "barème du bois changé");
    s.step(&[Command::Trade {
        give: ItemKind::Wood,
        give_count: ally,
        take: bow,
        take_count: 1,
    }]);
    assert!(
        s.items().iter().any(|i| i.kind == bow),
        "l'arc n'est pas arrivé au sol : {:?}",
        s.items()
    );
    assert_eq!(
        s.goodwill()[GUILD as usize],
        ALLY_GOODWILL + TRADE_DONE,
        "un client fidèle ne compte pas"
    );

    // La même offre au tarif ordinaire : refusée, en silence.
    let mut poor = colony(5);
    let poor_id = poor
        .trigger_trader_visit()
        .expect("un marchand doit pouvoir entrer");
    poor.pawn_mut(poor_id).expect("le marchand est là").wares = vec![(bow, 2)];
    store(&mut poor, ItemKind::Wood, base);
    poor.step(&[Command::Trade {
        give: ItemKind::Wood,
        give_count: ally,
        take: bow,
        take_count: 1,
    }]);
    assert!(
        !poor.items().iter().any(|i| i.kind == bow),
        "le tarif ordinaire s'est aligné sur celui de l'allié"
    );
}

/// Une Guilde hostile n'envoie plus personne : ni de son propre chef, ni sur
/// ordre de débogage. C'est l'inverse du choix fait pour `TriggerRaid`, et pour
/// la même raison : ici, **ne pas venir** est ce qu'il faut pouvoir observer.
#[test]
fn bad_reputation_keeps_traders_away() {
    let mut s = colony(6);
    s.set_goodwill(GUILD, HOSTILE_GOODWILL - 30);
    assert_eq!(s.relation(GUILD), Relation::Hostile);
    assert!(
        s.trigger_trader_visit().is_none(),
        "la Guilde hostile a quand même envoyé quelqu'un"
    );

    // Huit jours : la visite naturelle tombe entre le quatrième et le septième
    // (`trade::TRADER_MIN_DAYS`). Personne ne doit venir.
    for _ in 0..8 * DAY {
        if s.tick() % DAY == 0 {
            feed(&mut s);
        }
        s.step(&[]);
        assert!(
            !s.pawns().iter().any(|p| p.faction == Faction::Trader),
            "un marchand est venu au tick {} malgré la rancune",
            s.tick()
        );
    }
    assert_eq!(count_events(&s, EventKind::TraderVisit), 0);

    // La réputation réparée, la porte se rouvre.
    s.set_goodwill(GUILD, 0);
    assert!(
        s.trigger_trader_visit().is_some(),
        "la Guilde boude encore une colonie qui n'a plus rien à se reprocher"
    );
}

/// Ce qu'on fait à un marchand se paie à la Guilde entière : la main levée,
/// puis la mort.
#[test]
fn hurting_a_trader_costs_the_guild_twice() {
    let mut s = colony(7);
    s.set_goodwill(GUILD, 0);
    let id = s
        .trigger_trader_visit()
        .expect("un marchand doit pouvoir entrer");
    let colon = s
        .pawns()
        .iter()
        .find(|p| p.is_colonist())
        .expect("un colon")
        .id;

    s.step(&[Command::Attack {
        pawn: colon,
        target: id,
    }]);
    assert_eq!(s.goodwill()[GUILD as usize], TRADER_ANGERED);
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::TraderAngered),
        "colère non annoncée : {:?}",
        s.events()
    );
    let after_anger = s.goodwill()[GUILD as usize];

    s.inflict_injury(id, BodyPart::Torso, SEVERITY_MAX);
    s.step(&[]);
    assert!(
        s.events().iter().any(|e| e.kind == EventKind::TraderDied),
        "mort non annoncée : {:?}",
        s.events()
    );
    assert_eq!(
        s.goodwill()[GUILD as usize],
        (after_anger + TRADER_KILLED).max(sim::factions::GOODWILL_MIN)
    );
    assert_eq!(s.relation(GUILD), Relation::Hostile);
}

// ----------------------------------------------------------------------
// Le temps, et les représailles
// ----------------------------------------------------------------------

/// Les rancunes s'estompent d'un point par jour, et pas au-delà de zéro : une
/// alliance se gagne, elle ne s'attend pas.
#[test]
fn grudges_fade_over_time() {
    let mut s = colony(8);
    // En paisible : ce qui est mesuré ici est le seul effet du temps, pas la
    // réputation qu'un raid ferait payer à la tribu 0 au troisième jour.
    s.set_difficulty(sim::Difficulty::Peaceful);
    s.set_goodwill(0, -60);
    s.set_goodwill(1, 30);
    s.set_goodwill(GUILD, -20);

    run_fed(&mut s, 2 * DAY + 1);
    assert_eq!(s.goodwill()[0], -58, "deux jours, deux points");
    assert_eq!(s.goodwill()[GUILD as usize], -18);
    assert_eq!(
        s.goodwill()[1],
        30,
        "le temps s'est fait des amis tout seul"
    );

    // Le plafond : à −1, un jour suffit, et les suivants ne donnent rien.
    s.set_goodwill(0, -1);
    run_fed(&mut s, 3 * DAY);
    assert_eq!(s.goodwill()[0], 0);

    // Et le franchissement du seuil hostile, dans ce sens-là aussi, s'annonce.
    let mut s = colony(9);
    s.set_difficulty(sim::Difficulty::Peaceful);
    s.set_goodwill(0, HOSTILE_GOODWILL - 1);
    assert_eq!(s.relation(0), Relation::Hostile);
    run_fed(&mut s, DAY + 1);
    assert_eq!(s.goodwill()[0], HOSTILE_GOODWILL);
    assert_eq!(s.relation(0), Relation::Wary);
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::RelationChanged && e.arg == 0),
        "retour à la méfiance non annoncé : {:?}",
        s.events()
    );
}

/// Une tribu qui bascule sous le seuil hostile ne l'oublie pas : elle avance le
/// prochain raid, sans court-circuiter le storyteller. Témoin à l'appui — la
/// même carte, la même bande, mais sans franchissement de seuil, reste calme.
#[test]
fn crossing_below_hostile_triggers_a_reprisal() {
    // La tribu 0 passe de −45 à −55 en menant sa bande : le seuil est franchi.
    let mut s = colony(10);
    s.set_goodwill(0, HOSTILE_GOODWILL + 5);
    s.set_goodwill(1, ALLY_GOODWILL);
    assert!(s.spawn_raid() > 0);
    assert_eq!(s.last_raid_faction(), Some(0));
    assert_eq!(s.relation(0), Relation::Hostile);
    assert!(
        s.events()
            .iter()
            .any(|e| e.kind == EventKind::RelationChanged && e.arg == 0),
        "basculement non annoncé : {:?}",
        s.events()
    );

    // La bande est réglée tout de suite : ce qui suit ne doit rien à un combat
    // en cours (une mort de colon accorderait un répit au storyteller).
    wipe_raiders(&mut s);
    let before = count_events(&s, EventKind::Raid);
    run_fed(&mut s, 2 * DAY);
    assert!(
        count_events(&s, EventKind::Raid) > before,
        "aucune représaille en deux jours : {:?}",
        s.events()
    );

    // Témoin : sans franchissement (−20 → −30), la grâce de trois jours tient.
    let mut calm = colony(10);
    calm.set_goodwill(0, -20);
    calm.set_goodwill(1, ALLY_GOODWILL);
    assert!(calm.spawn_raid() > 0);
    assert_eq!(calm.relation(0), Relation::Wary);
    wipe_raiders(&mut calm);
    let before = count_events(&calm, EventKind::Raid);
    run_fed(&mut calm, 2 * DAY);
    assert_eq!(
        count_events(&calm, EventKind::Raid),
        before,
        "une bande est venue sans représailles à venger : {:?}",
        calm.events()
    );
}

// ----------------------------------------------------------------------
// Snapshot
// ----------------------------------------------------------------------

/// La réputation fait partie de l'état : elle survit à un aller-retour de
/// snapshot, et deux sims repartis du même snapshot restent d'accord.
#[test]
fn snapshot_keeps_goodwill() {
    let mut s = colony(11);
    s.set_goodwill(0, -77);
    s.set_goodwill(1, 55);
    s.set_goodwill(GUILD, 12);
    assert!(s.spawn_raid() > 0, "aucune bande à retrouver");
    let led = s.last_raid_faction().expect("une bande est entrée");

    let bytes = s.snapshot();
    let mut back = Sim::restore(&bytes).expect("snapshot relu");
    assert_eq!(back.goodwill(), s.goodwill());
    assert_eq!(back.last_raid_faction(), Some(led));
    assert_eq!(back.state_hash(), s.state_hash());

    // Le drapeau « bande en cours » voyage aussi : les deux annoncent le même
    // sort au même tick.
    for _ in 0..300 {
        s.step(&[]);
        back.step(&[]);
    }
    assert_eq!(back.state_hash(), s.state_hash(), "les deux sims divergent");
    assert_eq!(back.goodwill(), s.goodwill());

    // Un snapshot amputé de la fin est refusé net, jamais relu de travers.
    let short = &bytes[..bytes.len() - 1];
    assert!(Sim::restore(short).is_err(), "snapshot tronqué accepté");
}

/// Les noms et la réputation de départ sont un contrat avec le client
/// (`WasmSim::faction_name`, `WasmSim::goodwill`).
#[test]
fn the_three_factions_are_the_ones_the_client_expects() {
    let s = colony(12);
    assert_eq!(s.goodwill().len(), FACTION_COUNT);
    assert_eq!(s.goodwill(), &START_GOODWILL);
    assert_eq!(FACTION_NAMES[0], "Clan des Cendres");
    assert_eq!(FACTION_NAMES[1], "Fraternité du Fer");
    assert_eq!(FACTION_NAMES[GUILD as usize], "Guilde des Colporteurs");
    assert_eq!(s.last_raid_faction(), None, "aucune bande encore venue");
    // Un id inventé n'a pas d'avis, et ne panique pas.
    assert_eq!(s.faction_goodwill(200), 0);
    assert_eq!(s.relation(200), Relation::Wary);
}
