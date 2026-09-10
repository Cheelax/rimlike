//! Défense passive : les pièges à pointes.
//!
//! Un piège est une case franchissable que les hostiles et les bêtes ne
//! voient pas et que les colons contournent. Ces tests vérifient les quatre
//! faces de cette phrase — il blesse qui entre dessus, il ne blesse pas les
//! siens, il se réarme, il traverse le snapshot — puis mesurent ce qu'une
//! ligne de pièges change vraiment à un raid.
//!
//! Depuis la fiche `colonie-tient-seule` (2026-09-10), le fichier porte aussi
//! la **défense active** : la prévenance qui sépare l'annonce d'une bande de
//! sa mise en marche, et la décision tactique de la colonie — tenir la porte
//! ou veiller (voir `combat::Stance`).

use sim::combat::{REARM_TICKS, Stance, TRAP_SEVERITY};
use sim::health::BLEED_FRACTION;
use sim::map::chebyshev;
use sim::path;
use sim::pawn::{HP_MAX, NEED_MAX};
use sim::storyteller::SIEGE_TICKS;
use sim::testmap::map_from;
use sim::traits::Trait;
use sim::{
    Biome, BodyPart, Command, Designation, EventKind, Faction, Feature, ItemKind, Job, Map, Pawn,
    RaidKind, Sim, WorkType,
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

// ----------------------------------------------------------------------
// La colonie tient seule : prévenance, tenir la porte, veille
// ----------------------------------------------------------------------
//
// Fiche `docs/tasks/colonie-tient-seule.md`, phase 6. Trois règles, et un
// décor commun : une enceinte de bois avec une porte au sud, une prairie
// autour, la bande qui vient du sud. Rien n'est téléporté, rien n'est rendu
// invulnérable : ce que ces tests vérifient, ce sont des **marches**.

/// Demi-côté de l'enceinte des tests.
const PEN: u32 = 4;
/// Le centre de l'enceinte, et de la carte.
const PEN_CENTER: (u32, u32) = (10, 6);
/// La porte, au milieu du mur sud, et la case intérieure qui la touche.
const PEN_DOOR: (u32, u32) = (10, 10);
const PEN_THRESHOLD: (u32, u32) = (10, 9);

/// Prairie de 21 × 21, sans un pawn.
fn meadow() -> Sim {
    let mut s = Sim::from_map(1, map_from(&[&".".repeat(21) as &str; 21]));
    clear_pawns(&mut s);
    s
}

/// L'enceinte : un carré de murs de bois de demi-côté `PEN`, une porte au
/// milieu du mur sud (`sealed` à vrai la remplace par un mur : rien n'entre,
/// rien ne sort).
fn enclose(s: &mut Sim, sealed: bool) {
    let (cx, cy) = PEN_CENTER;
    for d in 0..=2 * PEN {
        s.map_mut()
            .set_feature(cx - PEN + d, cy - PEN, Feature::WallWood);
        s.map_mut()
            .set_feature(cx - PEN + d, cy + PEN, Feature::WallWood);
        s.map_mut()
            .set_feature(cx - PEN, cy - PEN + d, Feature::WallWood);
        s.map_mut()
            .set_feature(cx + PEN, cy - PEN + d, Feature::WallWood);
    }
    if !sealed {
        s.map_mut()
            .set_feature(PEN_DOOR.0, PEN_DOOR.1, Feature::DoorWood);
    }
    s.map_mut().refresh_indoor();
    assert!(s.map().indoor_count() > 0, "l'enceinte ne ferme pas");
}

/// Un colon posé là, sans trait (les traits de départ sont tirés au sort et
/// un couard ne se défend jamais : ces tests-là parlent du reste), repu et
/// reposé.
fn colonist_at(s: &mut Sim, x: u32, y: u32) -> u32 {
    let id = s.spawn_pawn(x, y, Faction::Colony);
    let p = s.pawn_mut(id).expect("le colon vient d'être posé");
    p.traits = [None, None];
    p.hunger = NEED_MAX;
    p.rest = NEED_MAX;
    id
}

/// Un pillard posé là, avec son arme, et qui **ne bouge pas** : `Job::Wait`
/// jusqu'à `until`. C'est la bande pendant la prévenance, jouée à la main
/// pour que le test ne dépende d'aucun tirage.
fn raider_at(s: &mut Sim, x: u32, y: u32, weapon: Option<ItemKind>, until: u64) -> u32 {
    let id = s.spawn_pawn(x, y, Faction::Raider);
    let p = s.pawn_mut(id).expect("le pillard vient d'être posé");
    p.hunger = NEED_MAX;
    p.rest = NEED_MAX;
    p.weapon = weapon;
    p.job = Job::Wait { until };
    id
}

fn colonists_outside(s: &Sim) -> Vec<u32> {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .filter(|p| {
            let (x, y) = p.tile();
            s.map().room(x, y) == 0
        })
        .map(|p| p.id)
        .collect()
}

fn living_colonists(s: &Sim) -> usize {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .count()
}

// ----------------------------------------------------------------------
// La prévenance
// ----------------------------------------------------------------------

/// Une bande annoncée par le **récit** se masse à son point d'entrée et ne
/// bouge pas d'une heure de jeu. C'est le délai qu'un colon parti au bois a
/// pour rentrer.
#[test]
fn la_bande_annoncee_attend_une_heure_de_jeu_avant_de_se_mettre_en_marche() {
    let mut s = Sim::new(1, 48, 48);
    let warning = s.raid_warning_ticks();
    assert_eq!(
        warning,
        u64::from(s.ticks_per_day()) / 24,
        "la prévenance est une heure de jeu"
    );
    let n = s.spawn_raid();
    assert!(n > 0, "aucune bande n'est entrée");
    let posted: Vec<(u32, u32)> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider)
        .map(|p| p.tile())
        .collect();
    for p in s.pawns().iter().filter(|p| p.faction == Faction::Raider) {
        assert!(
            matches!(p.job, Job::Wait { until } if until >= warning),
            "un pillard entre sans prévenance : {:?}",
            p.job
        );
    }
    // Ils ne bougent pas d'une case tant que l'heure n'est pas passée.
    for _ in 0..warning - 1 {
        s.step(&[]);
    }
    let still: Vec<(u32, u32)> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider)
        .map(|p| p.tile())
        .collect();
    assert_eq!(still, posted, "la bande a bougé pendant la prévenance");
    // Puis la marche commence.
    assert!(
        run_until(&mut s, 900, |s| s
            .pawns()
            .iter()
            .filter(|p| p.faction == Faction::Raider)
            .any(|p| !matches!(p.job, Job::Wait { .. }))),
        "la bande n'a jamais quitté son poste d'attente"
    );
}

/// La prévenance est un délai **de jeu** : elle suit l'échelle du jour
/// (`docs/time.md`, famille « jours »). Le siège, lui, ajoute son attente en
/// temps réel par-dessus.
#[test]
fn la_prevenance_suit_l_echelle_du_jour_et_le_siege_s_y_ajoute() {
    let one = Sim::new(1, 32, 32);
    let thirty = Sim::new_scaled(1, 32, 32, Biome::TemperateForest, 30);
    assert_eq!(one.raid_warning_ticks(), 600);
    assert_eq!(thirty.raid_warning_ticks(), 600 * 30);

    // Sur plusieurs graines, le récit tire les trois genres : une bande
    // attend soit la prévenance seule, soit la prévenance **plus** le siège.
    let mut plain = 0;
    let mut siege = 0;
    for seed in 1..=40u64 {
        let mut s = Sim::new(seed, 48, 48);
        let warning = s.raid_warning_ticks();
        if s.spawn_raid() == 0 {
            continue;
        }
        let until = s
            .pawns()
            .iter()
            .find(|p| p.faction == Faction::Raider)
            .and_then(|p| match p.job {
                Job::Wait { until } => Some(until),
                _ => None,
            })
            .expect("la bande attend");
        if until == warning {
            plain += 1;
        } else if until == warning + SIEGE_TICKS {
            siege += 1;
        } else {
            panic!("graine {seed} : attente inattendue de {until} ticks");
        }
    }
    assert!(plain > 0 && siege > 0, "{plain} charges, {siege} sièges");
}

/// Un raid **forcé** (`Command::TriggerRaid`) n'a pas de prévenance : c'est un
/// outil de débogage, il pose la bande devant vous. Les bancs d'équilibrage
/// qui déclenchent leur raid à la main mesurent donc toujours la même chose.
#[test]
fn un_raid_force_entre_sur_le_champ() {
    let mut s = Sim::new(1, 48, 48);
    assert!(s.trigger_raid_of(RaidKind::Rush) > 0);
    assert!(
        s.pawns()
            .iter()
            .filter(|p| p.faction == Faction::Raider)
            .all(|p| !matches!(p.job, Job::Wait { .. })),
        "un raid forcé attend alors qu'il ne devrait pas"
    );
}

// ----------------------------------------------------------------------
// Tenir la porte
// ----------------------------------------------------------------------

/// Rapport de force favorable : la colonie **tient la porte**. Elle se
/// rassemble côté intérieur du seuil et ne franchit pas la porte pour aller
/// chercher un pillard qui rôde dehors — ce que `defend_if_threatened`
/// faisait sans réfléchir, à huit cases, où que soit le colon.
#[test]
fn tenir_la_porte_ne_fait_sortir_personne() {
    let mut s = meadow();
    enclose(&mut s, false);
    for dx in 0..3u32 {
        colonist_at(&mut s, 9 + dx, 5);
    }
    // Un seul pillard à mains nues, planté cinq cases sous la porte : bien
    // dans le rayon de défense d'avant (`DEFEND_RADIUS` = 8).
    let lurker = raider_at(&mut s, PEN_DOOR.0, PEN_DOOR.1 + 5, None, u64::MAX);
    s.step(&[]);
    assert_eq!(
        s.raid_stance(),
        Stance::Hold,
        "trois colons contre un pillard"
    );

    for _ in 0..800 {
        s.step(&[]);
        assert!(
            colonists_outside(&s).is_empty(),
            "un colon a franchi la porte au tick {} : {:?}",
            s.tick(),
            s.pawns()
                .iter()
                .filter(|p| p.is_colonist())
                .map(|p| (p.id, p.tile(), p.job.clone()))
                .collect::<Vec<_>>()
        );
    }
    // Ils se sont rassemblés au seuil, et le rôdeur n'a pas une égratignure.
    let near = s
        .pawns()
        .iter()
        .filter(|p| p.is_colonist())
        .filter(|p| chebyshev(p.tile(), PEN_THRESHOLD) <= 2)
        .count();
    assert!(near >= 2, "seulement {near} colons au seuil");
    assert_eq!(injuries(&s, lurker), 0, "quelqu'un est sorti le frapper");
}

/// Et ils frappent quand même ce qui **se présente** : au seuil (la case de
/// la porte) comme à l'intérieur. Tenir la porte n'est pas se cacher.
#[test]
fn tenir_la_porte_frappe_ce_qui_se_presente_au_seuil() {
    let mut s = meadow();
    enclose(&mut s, false);
    for dx in 0..3u32 {
        colonist_at(&mut s, 9 + dx, 5);
    }
    let intruder = raider_at(&mut s, PEN_DOOR.0, PEN_DOOR.1, None, u64::MAX);
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Hold);
    assert!(
        run_until(&mut s, 1_200, |s| injuries(s, intruder) > 0),
        "le pillard planté sur la porte n'a jamais été frappé"
    );
    assert!(
        colonists_outside(&s).is_empty(),
        "on frappe le seuil sans le franchir"
    );
}

// ----------------------------------------------------------------------
// La veille
// ----------------------------------------------------------------------

/// Rapport de force défavorable et une enceinte : **veille**. Le colon parti
/// travailler dehors lâche son chantier, rentre, et ne ressort pas tant que
/// la bande est là. Le travail reprend quand elle n'est plus.
#[test]
fn la_veille_ramene_le_colon_au_travail_et_le_travail_reprend_apres() {
    let mut s = meadow();
    enclose(&mut s, false);
    colonist_at(&mut s, 9, 5);
    let outside = colonist_at(&mut s, 4, 16);
    // Du bois à couper là où il est : sans travail, « rentrer » ne prouve
    // rien.
    s.map_mut().set_feature(3, 16, Feature::Tree);
    s.map_mut().set_feature(5, 17, Feature::Tree);
    s.step(&[Command::Designate {
        kind: Designation::Chop,
        x0: 2,
        y0: 15,
        x1: 6,
        y1: 18,
    }]);
    assert!(
        run_until(&mut s, 900, |s| matches!(
            find_pawn(s, outside).map(|p| p.job.clone()),
            Some(Job::Work { .. }) | Some(Job::Move { .. })
        )),
        "le colon dehors n'a jamais pris son chantier"
    );

    // Six épieux contre deux paires de poings : la colonie ne tient pas.
    let band: Vec<u32> = (0..6u32)
        .map(|k| raider_at(&mut s, 4 + k, 20, Some(ItemKind::Spear), u64::MAX))
        .collect();
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Watch, "six épieux, deux colons");

    assert!(
        run_until(&mut s, 2_000, |s| colonists_outside(s).is_empty()),
        "le colon n'est pas rentré : {:?}",
        find_pawn(&s, outside).map(|p| (p.tile(), p.job.clone()))
    );
    // Et il ne ressort pas : pas de chantier repris sous la menace.
    for _ in 0..1_200 {
        s.step(&[]);
        assert!(
            colonists_outside(&s).is_empty(),
            "un colon est ressorti travailler pendant la veille"
        );
    }
    assert_eq!(living_colonists(&s), 2, "la veille a coûté un colon");
    assert!(
        s.pawns()
            .iter()
            .filter(|p| p.is_colonist())
            .all(|p| !matches!(p.job, Job::Work { .. })),
        "un colon travaille encore"
    );

    // La bande s'en va : le travail reprend.
    for id in band {
        s.pawn_mut(id).expect("pillard vivant").gone = true;
    }
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Free);
    assert!(
        run_until(&mut s, 4_000, |s| !colonists_outside(s).is_empty()),
        "personne n'est retourné au bois après le départ de la bande"
    );
}

/// L'enceinte **fermée** est le bouclier, et la veille le rend gratuit : la
/// bande ne trouve personne à atteindre, elle repart, et pas un colon n'y
/// laisse la vie.
#[test]
fn une_enceinte_sans_porte_fait_repartir_la_bande_sans_mort() {
    let mut s = meadow();
    enclose(&mut s, true);
    for dx in 0..2u32 {
        colonist_at(&mut s, 9 + dx, 5);
    }
    for k in 0..6u32 {
        raider_at(&mut s, 8 + k, 20, Some(ItemKind::Spear), 0);
    }
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Watch);
    assert!(
        run_until(&mut s, 6_000, |s| !s
            .pawns()
            .iter()
            .any(|p| p.faction == Faction::Raider && p.is_alive())),
        "la bande n'est jamais repartie"
    );
    assert_eq!(living_colonists(&s), 2, "la veille a coûté un colon");
    assert!(
        s.pawns()
            .iter()
            .filter(|p| p.is_colonist())
            .all(|p| p.injuries.is_empty()),
        "un colon a été blessé derrière des murs pleins"
    );
}

// ----------------------------------------------------------------------
// Les garde-fous
// ----------------------------------------------------------------------

/// **Pas d'enceinte, rien ne change.** Une colonie à ciel ouvert se bat où
/// elle est, exactement comme avant cette fiche : c'est la règle, et c'est
/// aussi ce qui protège d'un comportement non mesuré les colonies de
/// campagne qui n'ont pas fini leurs murs.
#[test]
fn sans_enceinte_le_colon_charge_comme_avant() {
    let mut s = meadow();
    let hero = colonist_at(&mut s, 10, 6);
    raider_at(&mut s, 10, 12, None, u64::MAX);
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Free, "aucune pièce sur la carte");
    assert!(
        run_until(&mut s, 300, |s| matches!(
            find_pawn(s, hero).map(|p| p.job.clone()),
            Some(Job::Attack { .. })
        )),
        "le colon n'a pas chargé : {:?}",
        find_pawn(&s, hero).map(|p| p.job.clone())
    );
}

/// **Un couard reste un couard.** Il rentre comme les autres — se mettre à
/// l'abri n'est pas se battre — mais il ne prend jamais les armes de
/// lui-même, même sur un intrus au milieu de la pièce.
#[test]
fn un_couard_rentre_mais_ne_se_bat_toujours_pas() {
    let mut s = meadow();
    enclose(&mut s, false);
    let brave = colonist_at(&mut s, 9, 5);
    let coward = colonist_at(&mut s, 4, 16);
    s.pawn_mut(coward).expect("le couard").traits = [Some(Trait::Coward), None];
    let intruder = raider_at(&mut s, PEN_CENTER.0, PEN_CENTER.1, None, u64::MAX);
    s.step(&[]);

    // Il rentre.
    assert!(
        run_until(&mut s, 2_000, |s| find_pawn(s, coward)
            .map(|p| s.map().room(p.tile().0, p.tile().1) != 0)
            .unwrap_or(false)),
        "le couard n'est pas rentré"
    );
    // Mais il ne charge pas, alors que le brave, lui, s'y est mis.
    assert!(
        !matches!(
            find_pawn(&s, coward).map(|p| p.job.clone()),
            Some(Job::Attack { .. })
        ),
        "le couard a chargé"
    );
    assert!(
        run_until(&mut s, 600, |s| matches!(
            find_pawn(s, brave).map(|p| p.job.clone()),
            Some(Job::Attack { .. })
        )) || find_pawn(&s, intruder).is_none(),
        "le brave n'a pas défendu la pièce"
    );
}

/// **Un ordre du joueur prime toujours.** Pendant la veille, un déplacement
/// manuel sort le colon, et une attaque désignée l'envoie sur un pillard que
/// la posture lui interdirait de choisir tout seul.
#[test]
fn un_ordre_du_joueur_passe_avant_la_posture() {
    let mut s = meadow();
    enclose(&mut s, false);
    let scout = colonist_at(&mut s, 9, 5);
    colonist_at(&mut s, 11, 5);
    let lurker = raider_at(
        &mut s,
        PEN_DOOR.0 + 2,
        PEN_DOOR.1 + 4,
        Some(ItemKind::Spear),
        u64::MAX,
    );
    for k in 0..5u32 {
        raider_at(&mut s, 2 + k, 20, Some(ItemKind::Spear), u64::MAX);
    }
    s.step(&[]);
    assert_eq!(s.raid_stance(), Stance::Watch);

    // Sans ordre, personne ne sort.
    for _ in 0..400 {
        s.step(&[]);
    }
    assert!(colonists_outside(&s).is_empty());

    // Un déplacement manuel, et il sort.
    s.step(&[Command::MoveTo {
        pawn: scout,
        x: 4,
        y: 16,
    }]);
    assert!(
        run_until(&mut s, 1_200, |s| find_pawn(s, scout)
            .map(|p| s.map().room(p.tile().0, p.tile().1) == 0)
            .unwrap_or(false)),
        "l'ordre de déplacement n'a pas sorti le colon : {:?}",
        find_pawn(&s, scout).map(|p| (p.tile(), p.job.clone()))
    );

    // Une attaque désignée sur le rôdeur, et il y va.
    s.step(&[Command::Attack {
        pawn: scout,
        target: lurker,
    }]);
    assert!(
        matches!(
            find_pawn(&s, scout).map(|p| p.job.clone()),
            Some(Job::Attack { .. })
        ),
        "l'ordre d'attaque a été refusé : {:?}",
        find_pawn(&s, scout).map(|p| p.job.clone())
    );
    assert!(
        run_until(&mut s, 3_000, |s| injuries(s, lurker) > 0
            || find_pawn(s, lurker).is_none()),
        "le colon envoyé au combat n'a jamais frappé"
    );
}

/// **Un colon à terre dehors reste dehors.** La veille est une marche : on
/// ne téléporte personne derrière les murs, et un blessé qui ne tient plus
/// debout ne marche pas. C'est un cas du rapport, pas un cas à masquer.
#[test]
fn un_colon_a_terre_dehors_n_est_pas_teleporte() {
    let mut s = meadow();
    enclose(&mut s, false);
    colonist_at(&mut s, 9, 5);
    let fallen = colonist_at(&mut s, 4, 16);
    for k in 0..6u32 {
        raider_at(
            &mut s,
            16 + k % 3,
            19 + k / 3,
            Some(ItemKind::Spear),
            u64::MAX,
        );
    }
    // Vidé de son sang sans être mort : la conscience tombe sous
    // `health::DOWNED_CONSCIOUSNESS` et il s'écroule là où il est.
    s.pawn_mut(fallen).expect("le blessé").blood = 250;
    s.inflict_injury(fallen, BodyPart::LeftLeg, 300);
    s.step(&[]);
    assert!(
        find_pawn(&s, fallen).is_some_and(|p| p.is_downed()),
        "le colon devrait être à terre"
    );
    let where_he_fell = find_pawn(&s, fallen).expect("il est là").tile();
    assert_eq!(s.raid_stance(), Stance::Watch);

    for _ in 0..600 {
        s.step(&[]);
        let Some(p) = find_pawn(&s, fallen) else {
            break;
        };
        if p.is_downed() {
            assert_eq!(
                p.tile(),
                where_he_fell,
                "un colon à terre a changé de case tout seul"
            );
        }
    }
}
