//! Traits de caractère : attribution et effets.

use sim::testmap::map_from;
use sim::{Command, Designation, Faction, Feature, Job, Sim, Trait, WorkType};

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

/// Champ ouvert, sans obstacle : les trois colons de départ se posent au
/// centre et autour, en anneau (voir `Sim::spawn_starting_pawns`).
fn open_field() -> Sim {
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
    Sim::from_map(1, map)
}

/// Même champ, avec un arbre isolé en (0, 1) : sert aux tests de vitesse de
/// travail (une seule case à couper, comme `gameplay::clearing`).
fn clearing_with_one_tree() -> Sim {
    let map = map_from(&[
        "............",
        "T...........",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
    ]);
    Sim::from_map(1, map)
}

#[test]
fn meme_seed_memes_traits() {
    let a = Sim::new(7, 48, 48);
    let b = Sim::new(7, 48, 48);
    let traits_a: Vec<[Option<Trait>; 2]> = a.pawns().iter().map(|p| p.traits).collect();
    let traits_b: Vec<[Option<Trait>; 2]> = b.pawns().iter().map(|p| p.traits).collect();
    assert_eq!(
        traits_a, traits_b,
        "même graine, mêmes commandes (aucune) : les traits doivent être identiques"
    );
}

#[test]
fn traits_jamais_contradictoires_et_reserves_aux_colons() {
    const CONFLICTS: [(Trait, Trait); 5] = [
        (Trait::Industrious, Trait::Lazy),
        (Trait::Optimist, Trait::Pessimist),
        (Trait::Brawler, Trait::Coward),
        (Trait::Gourmand, Trait::Ascetic),
        (Trait::Tough, Trait::Frail),
    ];
    for seed in 1..=50u64 {
        let mut s = Sim::new(seed, 48, 48);
        // Fait entrer des pillards : ils ne doivent porter aucun trait.
        s.step(&[Command::TriggerRaid]);
        for p in s.pawns() {
            match p.faction {
                Faction::Colony => {
                    if let [Some(a), Some(b)] = p.traits {
                        assert_ne!(a, b, "graine {seed} : deux fois le même trait ({a:?})");
                        for &(x, y) in &CONFLICTS {
                            assert!(
                                !((a, b) == (x, y) || (a, b) == (y, x)),
                                "graine {seed} : paire contradictoire {a:?}/{b:?}"
                            );
                        }
                    }
                }
                Faction::Raider | Faction::Animal => {
                    assert_eq!(
                        p.traits,
                        [None, None],
                        "graine {seed} : un {:?} porte un trait",
                        p.faction
                    );
                }
            }
        }
    }
}

#[test]
fn industrious_finit_une_coupe_strictement_avant_un_lazy() {
    fn chop_duration(trait_: Trait) -> u64 {
        let mut s = clearing_with_one_tree();
        let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
        let worker = ids[0];
        s.pawn_mut(worker).unwrap().traits = [Some(trait_), None];
        // Personne d'autre ne coupe : la différence de durée ne vient que du trait.
        let mut cmds = vec![Command::Designate {
            kind: Designation::Chop,
            x0: 0,
            y0: 1,
            x1: 0,
            y1: 1,
        }];
        for &id in &ids[1..] {
            cmds.push(Command::SetPriority {
                pawn: id,
                work: WorkType::Designated,
                priority: 0,
            });
        }
        s.step(&cmds);
        assert!(
            run_until(&mut s, DAY, |s| s.map().feature(0, 1) == Feature::None),
            "arbre jamais coupé ({trait_:?})"
        );
        s.tick()
    }
    let fast = chop_duration(Trait::Industrious);
    let slow = chop_duration(Trait::Lazy);
    assert!(
        fast < slow,
        "industrious ({fast} ticks) pas plus rapide que lazy ({slow} ticks)"
    );
}

#[test]
fn optimiste_et_pessimiste_diverge_de_120_000_toutes_choses_egales() {
    let mut s = open_field();
    let id = s.pawns()[0].id;
    s.pawn_mut(id).unwrap().traits = [Some(Trait::Optimist), None];
    let optimist = s.pawns().iter().find(|p| p.id == id).unwrap().mood();
    s.pawn_mut(id).unwrap().traits = [Some(Trait::Pessimist), None];
    let pessimist = s.pawns().iter().find(|p| p.id == id).unwrap().mood();
    assert_eq!(
        i64::from(optimist) - i64::from(pessimist),
        120_000,
        "optimiste = {optimist}, pessimiste = {pessimist}"
    );
}

#[test]
fn tough_encaisse_moins_frail_encaisse_plus_pour_un_meme_coup() {
    let mut s = open_field();
    let id = s.pawns()[0].id;

    s.pawn_mut(id).unwrap().traits = [None, None];
    let neutral = s
        .pawns()
        .iter()
        .find(|p| p.id == id)
        .unwrap()
        .damage_from(100);

    s.pawn_mut(id).unwrap().traits = [Some(Trait::Tough), None];
    let tough = s
        .pawns()
        .iter()
        .find(|p| p.id == id)
        .unwrap()
        .damage_from(100);

    s.pawn_mut(id).unwrap().traits = [Some(Trait::Frail), None];
    let frail = s
        .pawns()
        .iter()
        .find(|p| p.id == id)
        .unwrap()
        .damage_from(100);

    assert!(
        tough < neutral,
        "dur à cuire : {tough} pas < neutre {neutral}"
    );
    assert!(frail > neutral, "fragile : {frail} pas > neutre {neutral}");
    assert!(tough < frail, "dur à cuire {tough} pas < fragile {frail}");
}

/// Vrai si le colon a lui-même engagé le pillard, sans qu'on le lui demande.
fn auto_defends(coward: bool) -> bool {
    let mut s = open_field();
    let colonist = s.pawns()[0].id;
    let (cx, cy) = s.pawns()[0].tile();
    s.pawn_mut(colonist).unwrap().traits = if coward {
        [Some(Trait::Coward), None]
    } else {
        [None, None]
    };
    s.spawn_pawn(cx + 1, cy, Faction::Raider);
    s.step(&[]);
    matches!(
        s.pawns().iter().find(|p| p.id == colonist).unwrap().job,
        Job::Attack { .. }
    )
}

#[test]
fn coward_ne_se_defend_pas_seul_mais_obeit_a_un_ordre() {
    assert!(
        auto_defends(false),
        "un colon ordinaire devrait charger seul un pillard adjacent"
    );
    assert!(
        !auto_defends(true),
        "un couard ne devrait jamais se défendre de lui-même"
    );

    let mut s = open_field();
    let colonist = s.pawns()[0].id;
    let (cx, cy) = s.pawns()[0].tile();
    s.pawn_mut(colonist).unwrap().traits = [Some(Trait::Coward), None];
    let raider = s.spawn_pawn(cx + 1, cy, Faction::Raider);
    s.step(&[Command::Attack {
        pawn: colonist,
        target: raider,
    }]);
    let p = s.pawns().iter().find(|p| p.id == colonist).unwrap();
    assert!(
        matches!(p.job, Job::Attack { target } if target == raider),
        "le couard désobéit à l'ordre d'attaque : {:?}",
        p.job
    );
}
