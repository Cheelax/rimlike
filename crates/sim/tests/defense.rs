//! Défense passive : les pièges à pointes.
//!
//! Un piège est une case franchissable que les hostiles et les bêtes ne
//! voient pas et que les colons contournent. Ces tests vérifient les quatre
//! faces de cette phrase — il blesse qui entre dessus, il ne blesse pas les
//! siens, il se réarme, il traverse le snapshot — puis mesurent ce qu'une
//! ligne de pièges change vraiment à un raid.

use sim::combat::{REARM_TICKS, TRAP_SEVERITY};
use sim::health::BLEED_FRACTION;
use sim::path;
use sim::pawn::HP_MAX;
use sim::testmap::map_from;
use sim::{
    Command, Designation, EventKind, Faction, Feature, ItemKind, Job, Map, Pawn, Sim, WorkType,
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

fn find_pawn(s: &Sim, id: u32) -> Option<&Pawn> {
    s.pawns().iter().find(|p| p.id == id)
}

/// Vide la carte de tous ses pawns — les trois colons du départ **et** la
/// faune. Un cerf qui broute déclencherait les pièges d'un test qui compte les
/// événements ; on repose ensuite exactement les pawns dont on a besoin.
fn clear_pawns(s: &mut Sim) {
    let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
    for id in ids {
        s.pawn_mut(id).expect("pawn de départ").gone = true;
    }
    s.step(&[]);
    assert!(s.pawns().is_empty(), "il reste {:?}", s.pawns());
}

/// Ne retire que la faune : les colons du départ restent en place.
fn clear_wildlife(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Animal)
        .map(|p| p.id)
        .collect();
    for id in ids {
        s.pawn_mut(id).expect("bête vivante").gone = true;
    }
    s.step(&[]);
    assert_eq!(s.animal_count(), 0, "il reste des bêtes");
}

/// Couloir muré de trois cases utiles : un seul chemin de la gauche à la
/// droite, et il passe par (4, 1). La carte est vidée de ses pawns.
fn corridor() -> Sim {
    let map = map_from(&["#########", "#.......#", "#########"]);
    let mut s = Sim::from_map(1, map);
    clear_pawns(&mut s);
    s
}

/// Blessures d'un pawn encore sur la carte (vide s'il n'y est plus).
fn injuries(s: &Sim, id: u32) -> usize {
    find_pawn(s, id).map_or(0, |p| p.injuries.len())
}

/// Fait tourner le sim jusqu'à `stop` (ou `ticks` ticks) en surveillant à
/// chaque tick qu'aucun colon ne pose le pied sur `trap`. C'est la seule
/// preuve possible : un piège armé n'empale pas les siens, donc l'absence de
/// blessure ne dit rien — seule la trajectoire parle.
fn step_watching(
    s: &mut Sim,
    ticks: u64,
    trap: (u32, u32),
    mut stop: impl FnMut(&Sim) -> bool,
) -> bool {
    for _ in 0..ticks {
        if stop(s) {
            return true;
        }
        s.step(&[]);
        assert!(
            !s.pawns()
                .iter()
                .any(|p| p.faction == Faction::Colony && p.tile() == trap),
            "un colon a marché sur le piège armé au tick {}",
            s.tick()
        );
    }
    stop(s)
}

// ----------------------------------------------------------------------
// Le chemin
// ----------------------------------------------------------------------

/// Le contrat de `path::Walker`, sans passer par le jeu : c'est la brique sur
/// laquelle tout le reste repose.
#[test]
fn armed_traps_block_the_colony_path_and_nobody_else() {
    let mut m = map_from(&["#####", "#...#", "#####"]);
    // Sans piège, les deux marcheurs voient la même carte.
    let bare = path::find_path(&m, (1, 1), (3, 1));
    assert_eq!(
        bare,
        path::find_path_for(&m, (1, 1), (3, 1), path::Walker::COLONIST)
    );
    assert!(bare.is_some());

    m.set_feature(2, 1, Feature::SpikeTrap);
    assert!(
        path::find_path(&m, (1, 1), (3, 1)).is_some(),
        "un pillard ne voit pas le piège"
    );
    assert_eq!(
        path::find_path_for(&m, (1, 1), (3, 1), path::Walker::COLONIST),
        None,
        "un colon devrait refuser de traverser"
    );
    // La case de départ, elle, n'est jamais testée : un colon posé sur un
    // piège (piège réarmé sous ses pieds, snapshot bricolé) doit pouvoir en
    // sortir.
    assert!(
        path::find_path_for(&m, (2, 1), (3, 1), path::Walker::COLONIST).is_some(),
        "un colon coincé sur un piège ne peut plus bouger"
    );

    // Un piège déclenché n'est plus un obstacle pour personne.
    m.set_feature(2, 1, Feature::SpikeTrapSprung);
    assert_eq!(
        path::find_path_for(&m, (1, 1), (3, 1), path::Walker::COLONIST),
        bare,
        "un piège déclenché barre encore la route"
    );
}

// ----------------------------------------------------------------------
// Déclenchement
// ----------------------------------------------------------------------

#[test]
fn a_raider_stepping_on_a_trap_is_hurt_and_the_trap_springs() {
    let mut s = corridor();
    let colonist = s.spawn_pawn(7, 1, Faction::Colony);
    let raider = s.spawn_pawn(1, 1, Faction::Raider);
    s.map_mut().set_feature(4, 1, Feature::SpikeTrap);
    assert_eq!(s.map().trap_count(), 1);
    assert!(
        s.map().passable(4, 1),
        "un piège reste franchissable : c'est tout son intérêt"
    );

    // Le pillard fonce sur le colon, et le seul chemin passe sur les pointes.
    assert!(
        run_until(&mut s, 600, |s| s
            .events()
            .iter()
            .any(|e| e.kind == EventKind::TrapSprung)),
        "le piège n'a jamais claqué : pillard = {:?}",
        find_pawn(&s, raider)
    );
    let event = s
        .events()
        .iter()
        .find(|e| e.kind == EventKind::TrapSprung)
        .expect("événement trouvé juste au-dessus");
    assert_eq!(event.arg, raider, "le piège s'est refermé sur un autre");

    assert_eq!(s.map().feature(4, 1), Feature::SpikeTrapSprung);
    assert_eq!(s.map().trap_count(), 0);
    assert_eq!(s.map().sprung_trap_count(), 1);

    let p = find_pawn(&s, raider).expect("le pillard survit au premier piège");
    assert_eq!(p.injuries.len(), 1, "une seule blessure : {:?}", p.injuries);
    let wound = p.injuries[0];
    assert!(wound.part.is_leg(), "{:?} n'est pas une jambe", wound.part);
    assert_eq!(wound.severity, TRAP_SEVERITY);
    assert_eq!(
        wound.bleeding,
        TRAP_SEVERITY / BLEED_FRACTION,
        "un piège saigne comme un coup d'épieu"
    );
    assert_eq!(injuries(&s, colonist), 0, "le colon a été blessé");
}

#[test]
fn colonists_never_step_on_armed_traps() {
    // Mur de roche en x = 5. Deux passages : (5, 1) est piégé, (5, 6) est
    // libre. Les colons naissent à gauche (le centre de la carte tombe sur le
    // mur, la case franchissable la plus proche est à gauche) et l'arbre à
    // couper est à droite.
    let detour = split_map(true);
    let mut s = Sim::from_map(1, detour);
    clear_wildlife(&mut s);
    s.map_mut().set_feature(5, 1, Feature::SpikeTrap);
    s.spawn_item(ItemKind::Berries, 200, 2, 4);
    let colonists: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    assert!(!colonists.is_empty(), "carte sans colon");
    assert!(
        colonists
            .iter()
            .all(|&id| find_pawn(&s, id).is_some_and(|p| p.tile().0 < 5)),
        "les colons devraient naître à gauche du mur : {:?}",
        s.pawns()
    );
    s.step(&[Command::Designate {
        kind: Designation::Chop,
        x0: 8,
        y0: 4,
        x1: 8,
        y1: 4,
    }]);
    // Il y a un autre chemin : le travail se fait, par le passage libre, et
    // aucun colon ne met le pied sur les pointes en route.
    assert!(
        step_watching(&mut s, DAY, (5, 1), |s| s.map().feature(8, 4)
            == Feature::None),
        "l'arbre n'a pas été coupé alors qu'un détour existait"
    );
    assert_eq!(
        s.map().feature(5, 1),
        Feature::SpikeTrap,
        "le piège a claqué sur un colon"
    );
    assert!(
        colonists.iter().all(|&id| injuries(&s, id) == 0),
        "un colon s'est blessé : {:?}",
        s.pawns()
    );

    // Même carte, passage libre muré : le piège est le seul chemin. Le colon
    // renonce au travail plutôt que d'y aller.
    let mut g = Sim::from_map(1, split_map(false));
    clear_wildlife(&mut g);
    g.map_mut().set_feature(5, 1, Feature::SpikeTrap);
    g.spawn_item(ItemKind::Berries, 200, 2, 4);
    let stuck: Vec<u32> = g
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    g.step(&[Command::Designate {
        kind: Designation::Chop,
        x0: 8,
        y0: 4,
        x1: 8,
        y1: 4,
    }]);
    step_watching(&mut g, DAY, (5, 1), |_| false);
    assert_eq!(
        g.map().feature(8, 4),
        Feature::Tree,
        "un colon a traversé le piège pour aller couper"
    );
    assert_eq!(
        g.map().feature(5, 1),
        Feature::SpikeTrap,
        "le piège a claqué sur un colon"
    );
    assert!(
        stuck.iter().all(|&id| injuries(&g, id) == 0),
        "un colon s'est blessé : {:?}",
        g.pawns()
    );
}

/// Mur de roche en x = 5, percé en (5, 1) et — si `lower_gap` — en (5, 6).
/// Un arbre à couper en (8, 4), de l'autre côté.
fn split_map(lower_gap: bool) -> Map {
    let lower = if lower_gap {
        "..........."
    } else {
        ".....#....."
    };
    map_from(&[
        ".....#.....",
        "...........",
        ".....#.....",
        ".....#.....",
        ".....#..T..",
        ".....#.....",
        lower,
        ".....#.....",
    ])
}

// ----------------------------------------------------------------------
// Réarmement
// ----------------------------------------------------------------------

#[test]
fn traps_are_rearmed() {
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
    let mut s = Sim::from_map(1, map);
    clear_wildlife(&mut s);
    s.map_mut().set_feature(9, 6, Feature::SpikeTrapSprung);
    assert_eq!(s.map().sprung_trap_count(), 1);
    // Du bois en réserve, et de quoi manger : le réarmement ne doit toucher ni
    // l'un ni l'autre.
    s.spawn_item(ItemKind::Wood, 40, 2, 2);
    s.spawn_item(ItemKind::Berries, 200, 3, 2);
    let wood = s.colony_total(ItemKind::Wood);

    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .any(|p| matches!(p.job, Job::RearmTrap { .. }))),
        "personne ne s'est chargé du piège"
    );
    // Réservé comme un chantier : deux colons ne remontent pas le même piège.
    assert_eq!(
        s.pawns()
            .iter()
            .filter(|p| matches!(p.job, Job::RearmTrap { .. }))
            .count(),
        1,
        "deux colons sur le même piège"
    );
    assert!(
        run_until(&mut s, DAY, |s| s.map().feature(9, 6) == Feature::SpikeTrap),
        "le piège n'a pas été réarmé en une journée"
    );
    assert_eq!(s.map().trap_count(), 1);
    assert_eq!(s.map().sprung_trap_count(), 0);
    assert_eq!(
        s.colony_total(ItemKind::Wood),
        wood,
        "le réarmement a consommé du bois"
    );
    assert!(
        s.pawns()
            .iter()
            .all(|p| !matches!(p.job, Job::RearmTrap { .. })),
        "le job survit au piège réarmé"
    );
    // Le réarmement est du travail de constructeur : il fait progresser la
    // compétence correspondante.
    assert!(
        s.pawns()
            .iter()
            .any(|p| p.skills[WorkType::Build as usize].xp >= REARM_TICKS),
        "aucun colon n'a gagné d'XP de construction"
    );
}

// ----------------------------------------------------------------------
// Marchands
// ----------------------------------------------------------------------

#[test]
fn neutral_trader_ignores_traps() {
    let mut s = corridor();
    let colonist = s.spawn_pawn(7, 1, Faction::Colony);
    let trader = s.spawn_pawn(1, 1, Faction::Trader);
    // Un marchand qui reste : sans échéance, il repartirait au premier tick.
    s.pawn_mut(trader).expect("le marchand existe").leaves_at = 10_000;
    s.map_mut().set_feature(4, 1, Feature::SpikeTrap);
    s.step(&[Command::MoveTo {
        pawn: trader,
        x: 6,
        y: 1,
    }]);
    assert!(
        run_until(&mut s, 600, |s| find_pawn(s, trader)
            .is_some_and(|p| p.tile() == (6, 1))),
        "le marchand n'a pas traversé le couloir : {:?}",
        find_pawn(&s, trader)
    );
    assert_eq!(injuries(&s, trader), 0, "le marchand s'est empalé");
    assert_eq!(
        s.map().feature(4, 1),
        Feature::SpikeTrap,
        "le piège a claqué sous un invité"
    );
    assert!(
        !s.events().iter().any(|e| e.kind == EventKind::TrapSprung),
        "un piège s'est déclenché sans victime"
    );
    assert_eq!(injuries(&s, colonist), 0);

    // Le même marchand poussé à bout : il se bat comme un pillard, et ne
    // connaît plus la maison.
    let mut g = corridor();
    g.spawn_pawn(7, 1, Faction::Colony);
    let angry = g.spawn_pawn(1, 1, Faction::Trader);
    {
        let p = g.pawn_mut(angry).expect("le marchand existe");
        p.leaves_at = 10_000;
        p.hostile = true;
    }
    g.map_mut().set_feature(4, 1, Feature::SpikeTrap);
    assert!(
        run_until(&mut g, 600, |g| g
            .events()
            .iter()
            .any(|e| e.kind == EventKind::TrapSprung)),
        "le marchand hostile a franchi le piège sans mal"
    );
    assert_eq!(g.map().feature(4, 1), Feature::SpikeTrapSprung);
    assert!(
        find_pawn(&g, angry).is_none_or(|p| !p.injuries.is_empty()),
        "le marchand hostile n'a rien pris"
    );
}

// ----------------------------------------------------------------------
// Ce qu'une ligne de pièges change à un raid (mesure statistique)
// ----------------------------------------------------------------------

/// Colonie murée de roche, une seule entrée de trois cases à gauche
/// ((5, 7), (5, 8), (5, 9)). Le centre de la carte est dedans : les trois
/// colons du départ y naissent.
fn fort_map() -> Map {
    map_from(&[
        "........................",
        "........................",
        "........................",
        ".....#############......",
        ".....#...........#......",
        ".....#...........#......",
        ".....#...........#......",
        ".................#......",
        ".................#......",
        ".................#......",
        ".....#...........#......",
        ".....#...........#......",
        ".....#...........#......",
        ".....#############......",
        "........................",
        "........................",
    ])
}

/// Ce qu'a coûté un raid : PV perdus par la colonie (un mort compte pour
/// `HP_MAX`) et nombre de pillards piégés mis à terre ou tués.
struct Toll {
    hp_lost: u32,
    trapped_down: u32,
}

/// Joue le même raid — trois pillards lâchés devant l'entrée — avec ou sans
/// pièges dans le goulet, et compte les dégâts.
fn raid_toll(seed: u64, traps: bool) -> Toll {
    let mut s = Sim::from_map(seed, fort_map());
    // De quoi tenir trois jours sans sortir du fort.
    s.spawn_item(ItemKind::Berries, 200, 12, 8);
    if traps {
        for y in 7..=9 {
            s.map_mut().set_feature(5, y, Feature::SpikeTrap);
        }
    }
    let colonists: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    // Spawn direct plutôt que `TriggerRaid` : trois pillards, toujours les
    // mêmes, toujours au même endroit, dans les deux parties comparées.
    let raiders: Vec<u32> = (7..=9)
        .map(|y| s.spawn_pawn(1, y, Faction::Raider))
        .collect();

    let mut trapped: Vec<u32> = Vec::new();
    let mut lost: Vec<u32> = Vec::new();
    let mut seen = 0;
    for _ in 0..(3 * DAY) {
        s.step(&[]);
        for e in s.events() {
            if e.seq < seen {
                continue;
            }
            seen = e.seq + 1;
            match e.kind {
                EventKind::TrapSprung if raiders.contains(&e.arg) => {
                    if !trapped.contains(&e.arg) {
                        trapped.push(e.arg);
                    }
                }
                EventKind::RaiderDied => lost.push(e.arg),
                _ => {}
            }
        }
        for p in s.pawns() {
            if p.faction == Faction::Raider && p.is_downed() && !lost.contains(&p.id) {
                lost.push(p.id);
            }
        }
        if !s
            .pawns()
            .iter()
            .any(|p| p.faction == Faction::Raider && p.is_alive())
        {
            break;
        }
    }
    let hp_lost = colonists
        .iter()
        .map(|&id| match find_pawn(&s, id) {
            Some(p) => HP_MAX - p.hp.min(HP_MAX),
            None => HP_MAX,
        })
        .sum();
    Toll {
        hp_lost,
        trapped_down: trapped.iter().filter(|id| lost.contains(id)).count() as u32,
    }
}

/// La mesure qui a fixé `TRAP_SEVERITY` (voir la table dans `sim::combat`).
#[test]
fn a_trap_line_blunts_a_raid() {
    const SEEDS: u64 = 30;
    let (mut with, mut without) = (0u64, 0u64);
    let mut seeds_with_a_victim = 0u32;
    for seed in 1..=SEEDS {
        let armed = raid_toll(seed, true);
        let bare = raid_toll(seed, false);
        with += u64::from(armed.hp_lost);
        without += u64::from(bare.hp_lost);
        if armed.trapped_down > 0 {
            seeds_with_a_victim += 1;
        }
    }
    assert!(
        with < without,
        "les pièges n'épargnent rien : {} PV perdus avec, {} sans (sur {SEEDS} graines)",
        with / SEEDS,
        without / SEEDS
    );
    assert!(
        seeds_with_a_victim * 2 > SEEDS as u32,
        "un piège n'a mis à terre ou tué un pillard que sur {seeds_with_a_victim}/{SEEDS} graines"
    );
}

// ----------------------------------------------------------------------
// Snapshot
// ----------------------------------------------------------------------

#[test]
fn snapshot_keeps_trap_state() {
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
    let mut s = Sim::from_map(1, map);
    clear_wildlife(&mut s);
    s.map_mut().set_feature(2, 6, Feature::SpikeTrap);
    s.map_mut().set_feature(9, 6, Feature::SpikeTrapSprung);
    s.spawn_item(ItemKind::Berries, 200, 3, 2);
    // Un réarmement en cours : le job et son avancement font partie de l'état.
    assert!(
        run_until(&mut s, DAY, |s| s.pawns().iter().any(
            |p| matches!(p.job, Job::RearmTrap { progress, .. } if progress > 0)
        )),
        "aucun réarmement entamé"
    );
    let before: Vec<Job> = s.pawns().iter().map(|p| p.job.clone()).collect();

    let bytes = s.snapshot();
    let mut restored = Sim::restore(&bytes).expect("snapshot relu");
    assert_eq!(restored.map().trap_count(), 1);
    assert_eq!(restored.map().sprung_trap_count(), 1);
    assert_eq!(restored.map().feature(2, 6), Feature::SpikeTrap);
    assert_eq!(restored.map().feature(9, 6), Feature::SpikeTrapSprung);
    let after: Vec<Job> = restored.pawns().iter().map(|p| p.job.clone()).collect();
    assert_eq!(before, after, "le réarmement n'a pas survécu au snapshot");
    assert_eq!(restored, s);
    assert_eq!(restored.state_hash(), s.state_hash());

    // Et la suite est la même de part et d'autre : le piège réarmé aussi.
    for _ in 0..2_000 {
        s.step(&[]);
        restored.step(&[]);
    }
    assert_eq!(s.map().trap_count(), 2, "le piège n'a pas été réarmé");
    assert_eq!(restored.state_hash(), s.state_hash());
}
