//! Conservation par le froid et enterrement des morts, sur des cartes
//! dessinées à la main. Style et conventions : voir `gameplay.rs` (non touché
//! par ce fichier, qui reste séparé comme demandé).

use sim::items::FRESHNESS_MAX;
use sim::pawn::{CORPSE_MOOD_MALUS, CORPSE_MOOD_MALUS_CAP};
use sim::testmap::map_from;
use sim::{Climate, EventKind, Feature, ItemKind, Sim, TICKS_PER_DAY};

const DAY: u64 = TICKS_PER_DAY as u64;

fn run_until(s: &mut Sim, max: u64, mut pred: impl FnMut(&Sim) -> bool) -> bool {
    for _ in 0..max {
        if pred(s) {
            return true;
        }
        s.step(&[]);
    }
    pred(s)
}

/// Poche fermée par des rochers en haut à droite, case (11, 0) : les mêmes
/// dessin et raisonnement que `gameplay::unreachable_food_spoils` (elle
/// touche le bord de la carte, donc `Map::refresh_indoor` ne la compte jamais
/// comme une pièce chauffée — aucun bonus n'entre dans la température lue
/// ici, seul le climat imposé compte).
fn pocket_map() -> sim::Map {
    map_from(&[
        "..........#.",
        "..........##",
        "............",
        "............",
        "............",
        "............",
    ])
}

/// Petite clairière plate, sans obstacle : sert aux tombes et à la fusion de
/// piles, où seule la position des colons/objets compte.
fn open_map() -> sim::Map {
    map_from(&[
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
    ])
}

/// Trois cases figées (chaude, fraîche, gelée), choisies pour rester dans
/// leur bande quel que soit l'aléa du jour/de la météo sur la fenêtre du
/// test — et bien avant le premier événement extrême du storyteller (8 jours,
/// `storyteller::EXTREME_MIN_DAYS`), qui pourrait sinon faire déraper un cas
/// limite. Amplitude nulle : pas de dérive saisonnière à prendre en compte.
#[test]
fn cold_slows_spoilage_and_frost_stops_it() {
    let mut hot = Sim::from_map_with_climate(1, pocket_map(), Climate::new(280, 0));
    let mut cool = Sim::from_map_with_climate(1, pocket_map(), Climate::new(100, 0));
    let mut frozen = Sim::from_map_with_climate(1, pocket_map(), Climate::new(-200, 0));

    for s in [&mut hot, &mut cool, &mut frozen] {
        s.spawn_item(ItemKind::Berries, 10, 11, 0);
    }
    let hot_id = hot
        .items()
        .iter()
        .find(|i| i.kind == ItemKind::Berries)
        .expect("les baies n'ont pas été posées")
        .id;

    let life = u64::from(ItemKind::Berries.shelf_life().unwrap());
    // Large marge, mais toujours sous les 8 jours du premier événement
    // extrême du storyteller : le test reste déterministe sans avoir à
    // neutraliser cet aléa-là.
    let total = life + 2 * DAY;
    assert!(total < 8 * DAY, "fenêtre de test trop large : {total}");

    let mut hot_freshness_samples = Vec::new();
    for t in 0..total {
        if t % (DAY / 4) == 0
            && let Some(i) = hot.items().iter().find(|i| i.id == hot_id)
        {
            hot_freshness_samples.push(i.freshness);
        }
        hot.step(&[]);
        cool.step(&[]);
        frozen.step(&[]);
    }

    assert!(
        hot.items().iter().all(|i| i.kind != ItemKind::Berries),
        "les baies au chaud auraient dû pourrir : {:?}",
        hot.items()
    );
    assert!(
        cool.items().iter().any(|i| i.kind == ItemKind::Berries),
        "les baies au frais ont disparu trop vite : {:?}",
        cool.items()
    );
    let frozen_stack = frozen
        .items()
        .iter()
        .find(|i| i.kind == ItemKind::Berries)
        .expect("les baies gelées ont disparu");
    assert_eq!(
        frozen_stack.freshness, FRESHNESS_MAX,
        "le gel n'a pas empêché la moindre perte"
    );

    assert!(
        hot_freshness_samples.len() >= 2,
        "pas assez d'échantillons : {hot_freshness_samples:?}"
    );
    assert!(
        hot_freshness_samples.windows(2).all(|w| w[1] <= w[0]),
        "la fraîcheur au chaud est remontée : {hot_freshness_samples:?}"
    );
    assert!(
        hot_freshness_samples.last() < hot_freshness_samples.first(),
        "la fraîcheur au chaud n'a jamais décru : {hot_freshness_samples:?}"
    );
}

#[test]
fn merged_stacks_keep_lowest_freshness() {
    // Climat chaud et constant : une seule évaluation de péremption
    // (`SPOILAGE_INTERVAL` = 60 ticks) suffit à faire baisser la fraîcheur.
    let mut s = Sim::from_map_with_climate(1, open_map(), Climate::new(280, 0));
    s.spawn_item(ItemKind::Berries, 10, 5, 5);
    let id = s.items()[0].id;
    for _ in 0..120 {
        s.step(&[]);
    }
    let degraded = s
        .items()
        .iter()
        .find(|i| i.id == id)
        .expect("la pile existe encore")
        .freshness;
    assert!(
        degraded < FRESHNESS_MAX,
        "la fraîcheur n'a pas bougé : {degraded}"
    );

    // Une pile fraîche du même genre, au même endroit : la fusion doit
    // garder la fraîcheur la plus basse, pas la moyenne ni la plus haute.
    s.spawn_item(ItemKind::Berries, 5, 5, 5);
    let merged = s
        .items()
        .iter()
        .find(|i| (i.x, i.y) == (5, 5) && i.kind == ItemKind::Berries)
        .expect("pile fusionnée absente");
    assert_eq!(merged.count, 15, "la fusion n'a pas additionné les comptes");
    assert_eq!(
        merged.freshness, degraded,
        "la fusion n'a pas gardé la fraîcheur la plus basse"
    );
}

#[test]
fn colonists_bury_corpses_in_graves() {
    let mut s = Sim::from_map(1, open_map());
    s.map_mut().set_feature(2, 2, Feature::Grave);
    s.spawn_item(ItemKind::Corpse, 1, 6, 6);

    // Un tick suffit pour que `Pawn::corpses_on_map` se recopie et pèse sur
    // l'humeur (voir `Sim::update`).
    s.step(&[]);
    let mood_before = s.pawns()[0].mood();

    assert!(
        run_until(&mut s, DAY, |s| s.map().feature(2, 2)
            == Feature::GraveFilled),
        "la tombe n'a jamais été remplie"
    );
    assert!(
        s.items().iter().all(|i| i.kind != ItemKind::Corpse),
        "le cadavre est encore au sol : {:?}",
        s.items()
    );
    assert!(
        s.events().iter().any(|e| e.kind == EventKind::Buried),
        "événement Buried absent : {:?}",
        s.events()
    );

    // Encore un tick pour que `corpses_on_map` retombe à zéro.
    s.step(&[]);
    let mood_after = s.pawns()[0].mood();
    assert!(
        mood_after > mood_before,
        "l'humeur n'a pas remonté après l'enterrement : {mood_before} -> {mood_after}"
    );
}

#[test]
fn corpses_on_the_ground_hurt_mood() {
    let mut s = Sim::from_map(1, open_map());
    s.step(&[]);
    let mood_clean = s.pawns()[0].mood();

    s.spawn_item(ItemKind::Corpse, 1, 6, 2);
    s.step(&[]);
    let mood_one_corpse = s.pawns()[0].mood();
    assert!(
        mood_one_corpse < mood_clean,
        "un cadavre au sol ne pèse pas sur l'humeur : {mood_clean} -> {mood_one_corpse}"
    );
    assert_eq!(
        i64::from(mood_clean) - i64::from(mood_one_corpse),
        CORPSE_MOOD_MALUS,
        "malus inattendu pour un seul cadavre"
    );

    // Trois cadavres de plus, à des cases distinctes (les piles ne fusionnent
    // pas) : le plafond doit tenir.
    for dx in 0..3u32 {
        s.spawn_item(ItemKind::Corpse, 1, 6 + dx, 3);
    }
    s.step(&[]);
    let mood_many = s.pawns()[0].mood();
    assert_eq!(
        i64::from(mood_clean) - i64::from(mood_many),
        CORPSE_MOOD_MALUS_CAP,
        "le plafond de malus n'a pas tenu avec quatre cadavres"
    );
}
