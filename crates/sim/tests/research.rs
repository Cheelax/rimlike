//! Recherche : l'établi, les points, et ce que chaque technologie change.
//! Style et conventions : voir `gameplay.rs`, dont ce fichier reprend la
//! clairière et le `run_until`.

use sim::build::BuildKind;
use sim::combat::{BOW_RANGE, RANGED_DAMAGE};
use sim::farm::GROW_TICKS;
use sim::items::FRESHNESS_MAX;
use sim::research::{self, NO_TECH, PROGRESS_SCALE, RESEARCH_STEP};
use sim::testmap::map_from;
use sim::{
    Climate, Command, EventKind, Faction, Feature, ItemKind, Job, Material, Sim, TICKS_PER_DAY,
    Tech, WorkType, Zone,
};

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

/// Clairière plate : rien à couper, rien à ranger, aucune zone — un colon
/// inactif n'a donc que la recherche à se mettre sous la dent.
fn clearing() -> Sim {
    Sim::from_map(
        1,
        map_from(&[
            "............",
            "............",
            "............",
            "............",
            "............",
            "............",
            "............",
            "............",
        ]),
    )
}

/// Établi posé en (9, 6), loin des trois cases de naissance des colons
/// ((6, 4) et le premier anneau) : personne ne se retrouve enfermé dessous.
const BENCH: (u32, u32) = (9, 6);

fn clearing_with_bench() -> Sim {
    let mut s = clearing();
    s.map_mut()
        .set_feature(BENCH.0, BENCH.1, Feature::ResearchBench);
    assert_eq!(s.map().research_bench_count(), 1);
    s
}

fn researching(s: &Sim) -> bool {
    s.pawns()
        .iter()
        .any(|p| matches!(p.job, Job::Research { .. }))
}

/// Ne garde que le premier colon : les autres quittent la carte au prochain
/// nettoyage (`gone`), sans cadavre ni deuil. Un seul chercheur rend la durée
/// d'une technologie lisible.
fn keep_one_colonist(s: &mut Sim) -> u32 {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .map(|p| p.id)
        .collect();
    for &id in &ids[1..] {
        s.pawn_mut(id).expect("colon vivant").gone = true;
    }
    s.step(&[]);
    let left = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Colony)
        .count();
    assert_eq!(left, 1, "un seul colon attendu : {:?}", s.pawns());
    ids[0]
}

fn set_research(tech: Tech) -> Command {
    Command::SetResearch { tech: tech as u8 }
}

// ----------------------------------------------------------------------
// L'établi et les points
// ----------------------------------------------------------------------

#[test]
fn research_needs_a_bench_and_a_target() {
    // Une technologie choisie, mais pas d'établi : la commande est bien
    // enregistrée, et rien n'avance.
    let mut no_bench = clearing();
    no_bench.step(&[set_research(Tech::Agriculture)]);
    assert_eq!(no_bench.research().current(), Some(Tech::Agriculture));
    run_until(&mut no_bench, 600, |_| false);
    assert_eq!(no_bench.research().progress_of(Tech::Agriculture), 0);
    assert!(!researching(&no_bench), "personne ne cherche sans établi");

    // Un établi, mais rien à chercher : les colons flânent.
    let mut idle = clearing_with_bench();
    assert_eq!(idle.research().current, NO_TECH);
    run_until(&mut idle, 600, |_| false);
    assert!(
        idle.research().progress.iter().all(|&p| p == 0),
        "avancement sans objectif : {:?}",
        idle.research().progress
    );
    assert!(!researching(&idle), "personne ne cherche sans objectif");

    // Les deux : un colon s'installe et les points rentrent.
    let mut s = clearing_with_bench();
    s.step(&[set_research(Tech::Agriculture)]);
    assert!(
        run_until(&mut s, DAY, |s| s.research().progress_of(Tech::Agriculture)
            > 0),
        "aucun point de recherche : jobs {:?}",
        s.pawns().iter().map(|p| p.job.clone()).collect::<Vec<_>>()
    );
    assert!(researching(&s));
    // Un seul établi : un seul chercheur à la fois, les autres font autre chose.
    assert_eq!(
        s.pawns()
            .iter()
            .filter(|p| matches!(p.job, Job::Research { .. }))
            .count(),
        1,
        "l'établi n'est pas réservé"
    );
}

#[test]
fn finishing_a_tech_fires_an_event_and_clears_current() {
    let mut s = clearing_with_bench();
    let colonist = keep_one_colonist(&mut s);
    s.step(&[set_research(Tech::Agriculture)]);

    // Borne large : au pire (moral bas, compétence nulle, nuits et repas),
    // un colon seul met un peu plus de deux jours ; voir
    // `a_tech_takes_a_day_or_two` pour la cadence visée.
    assert!(
        run_until(&mut s, 6 * DAY, |s| s.research().is_done(Tech::Agriculture)),
        "technologie jamais acquise : {:?}",
        s.research()
    );
    assert_eq!(
        s.research().current,
        NO_TECH,
        "la colonie cherche encore quelque chose"
    );
    assert!(s.research().progress_of(Tech::Agriculture) >= Tech::Agriculture.cost());
    let done = s
        .events()
        .iter()
        .find(|e| e.kind == EventKind::ResearchDone)
        .expect("aucun événement de fin de recherche");
    assert_eq!(done.arg, Tech::Agriculture as u32);

    // Le chercheur lâche l'établi : plus rien à chercher.
    assert!(
        run_until(&mut s, 60, |s| !researching(s)),
        "le colon reste à l'établi sans objectif"
    );
    // Une technologie acquise ne se recherche pas deux fois.
    s.step(&[set_research(Tech::Agriculture)]);
    assert_eq!(s.research().current, NO_TECH);
    // Une autre, si : la commande reprend la main.
    s.step(&[set_research(Tech::Masonry)]);
    assert_eq!(s.research().current(), Some(Tech::Masonry));
    assert_eq!(
        s.pawn_mut(colonist).expect("le colon est là").faction,
        Faction::Colony
    );
}

#[test]
fn a_tech_takes_a_day_or_two() {
    // La cadence est la règle de conception : à un colon seul qui ne fait que
    // chercher, une technologie coûte entre une demi-journée et trois jours,
    // pas trois secondes ni une saison. Mesuré ici plutôt que réglé à
    // l'intuition : 7 115 ticks à quatre dixièmes de point par tick, donc
    // environ 14 000 à deux dixièmes.
    let mut s = clearing_with_bench();
    keep_one_colonist(&mut s);
    s.step(&[set_research(Tech::Agriculture)]);
    let start = s.tick();
    assert!(
        run_until(&mut s, 4 * DAY, |s| s.research().is_done(Tech::Agriculture)),
        "technologie jamais acquise : {:?}",
        s.research()
    );
    let elapsed = s.tick() - start;
    assert!(
        (DAY / 2..=3 * DAY).contains(&elapsed),
        "Agriculture acquise en {elapsed} ticks, attendu entre une demi-journée et trois jours"
    );
}

#[test]
fn research_skill_gains_xp() {
    let mut s = clearing_with_bench();
    s.step(&[set_research(Tech::Archery)]);
    let xp = |s: &Sim| {
        s.pawns()
            .iter()
            .map(|p| p.skills[WorkType::Research as usize].xp)
            .max()
            .unwrap_or(0)
    };
    assert_eq!(xp(&s), 0, "personne n'a encore cherché");
    assert!(
        run_until(&mut s, DAY, |s| xp(s) > 0),
        "chercher ne forme pas à la recherche"
    );
}

// ----------------------------------------------------------------------
// Ce que les technologies changent
// ----------------------------------------------------------------------

#[test]
fn agriculture_speeds_up_crops() {
    /// Tick auquel le premier plant est mûr.
    fn ripe_at(agriculture: bool) -> u64 {
        let mut s = clearing();
        if agriculture {
            s.research_mut().complete(Tech::Agriculture);
        }
        s.step(&[Command::SetZone {
            zone: Zone::Growing,
            x0: 4,
            y0: 5,
            x1: 5,
            y1: 6,
        }]);
        assert!(
            run_until(&mut s, 3 * DAY, |s| s
                .crops()
                .iter()
                .any(|c| c.growth >= GROW_TICKS)),
            "aucun plant mûr : {:?}",
            s.crops()
        );
        s.tick()
    }

    let plain = ripe_at(false);
    let farmed = ripe_at(true);
    assert!(
        farmed < plain,
        "la recherche agricole n'a rien accéléré : {farmed} contre {plain}"
    );
    // Un quart de pousse en plus : la maturité arrive vers les quatre
    // cinquièmes du temps, semis et trajets compris (d'où la fourchette).
    assert!(
        farmed * 100 < plain * 90,
        "gain trop maigre : {farmed} contre {plain}"
    );
}

#[test]
fn preservation_halves_spoilage() {
    /// Poche fermée en (11, 0), inatteignable : les colons ne mangent pas les
    /// baies observées (voir `preservation::pocket_map`).
    fn pocket() -> Sim {
        Sim::from_map_with_climate(
            1,
            map_from(&[
                "..........#.",
                "..........##",
                "............",
                "............",
                "............",
                "............",
            ]),
            // 28 °C : au-dessus de `climate::SPOILAGE_WARM_TEMP`, donc la
            // péremption va son plein train, sans aide du froid.
            Climate::new(280, 0),
        )
    }

    let mut plain = pocket();
    let mut kept = pocket();
    kept.research_mut().complete(Tech::Preservation);
    for s in [&mut plain, &mut kept] {
        s.spawn_item(ItemKind::Berries, 10, 11, 0);
    }

    // La péremption s'évalue par paliers de soixante ticks : on laisse une
    // petite marge au-delà de la durée de vie pour que le dernier palier
    // tombe, sans quoi il resterait un fond de fraîcheur au lot témoin.
    let life = u64::from(ItemKind::Berries.shelf_life().expect("les baies se gâtent"));
    for _ in 0..life + DAY / 10 {
        plain.step(&[]);
        kept.step(&[]);
    }

    assert!(
        plain.items().iter().all(|i| i.kind != ItemKind::Berries),
        "les baies sans conservation auraient dû pourrir : {:?}",
        plain.items()
    );
    let stack = kept
        .items()
        .iter()
        .find(|i| i.kind == ItemKind::Berries)
        .expect("les baies conservées ont disparu");
    // Deux fois plus lent : il doit rester environ la moitié de la fraîcheur.
    assert!(
        (FRESHNESS_MAX * 2 / 5..=FRESHNESS_MAX * 3 / 5).contains(&stack.freshness),
        "fraîcheur inattendue : {}",
        stack.freshness
    );
}

#[test]
fn archery_extends_bow_range() {
    // Portée : huit cases sans recherche, dix avec.
    assert_eq!(research::bow_range(BOW_RANGE, false), BOW_RANGE);
    assert_eq!(
        research::bow_range(BOW_RANGE, true),
        research::ARCHERY_BOW_RANGE
    );
    assert!(research::bow_range(BOW_RANGE, true) > BOW_RANGE);

    // Dégâts : un quart de plus, bornes du tirage comprises.
    for base in [RANGED_DAMAGE.0 as u32, RANGED_DAMAGE.1 as u32 - 1] {
        assert_eq!(research::ranged_damage(base, false), base);
        assert_eq!(research::ranged_damage(base, true), base * 125 / 100);
        assert!(research::ranged_damage(base, true) > base);
    }
}

#[test]
fn masonry_speeds_up_stone_building() {
    // La règle : un quart de temps en moins, et sur la pierre seulement.
    let wall = BuildKind::Wall;
    assert_eq!(
        wall.work_ticks_with(Material::Stone, false),
        wall.work_ticks()
    );
    assert_eq!(
        wall.work_ticks_with(Material::Wood, true),
        wall.work_ticks(),
        "le bois ne profite pas de la maçonnerie"
    );
    assert_eq!(
        wall.work_ticks_with(Material::Stone, true),
        wall.work_ticks() * 3 / 4
    );

    /// Tick auquel un mur de pierre est debout, matériaux déjà sur place.
    fn wall_at(masonry: bool) -> u64 {
        let mut s = clearing();
        if masonry {
            s.research_mut().complete(Tech::Masonry);
        }
        s.spawn_item(ItemKind::Stone, 20, 7, 5);
        s.step(&[Command::Build {
            kind: BuildKind::Wall,
            material: Material::Stone,
            x0: 9,
            y0: 5,
            x1: 9,
            y1: 5,
        }]);
        assert_eq!(s.blueprints().len(), 1, "plan non posé");
        assert!(
            run_until(&mut s, 2 * DAY, |s| s.map().feature(9, 5)
                == Feature::WallStone),
            "mur jamais bâti : {:?}",
            s.blueprints()
        );
        s.tick()
    }

    let plain = wall_at(false);
    let quick = wall_at(true);
    assert!(
        quick < plain,
        "la maçonnerie n'a rien accéléré : {quick} contre {plain}"
    );
}

// ----------------------------------------------------------------------
// Commande et bornes
// ----------------------------------------------------------------------

#[test]
fn set_research_ignores_nonsense() {
    let mut s = clearing_with_bench();
    for tech in [Tech::COUNT as u8, 42, 254] {
        s.step(&[Command::SetResearch { tech }]);
        assert_eq!(s.research().current, NO_TECH, "octet {tech} accepté");
    }
    s.step(&[set_research(Tech::Medicine)]);
    assert_eq!(s.research().current(), Some(Tech::Medicine));
    // Un octet invalide ne remplace pas la recherche en cours.
    s.step(&[Command::SetResearch { tech: 200 }]);
    assert_eq!(s.research().current(), Some(Tech::Medicine));
    // 255 arrête tout.
    s.step(&[Command::SetResearch { tech: NO_TECH }]);
    assert_eq!(s.research().current, NO_TECH);
    // Les points déjà versés restent acquis.
    assert!(
        run_until(&mut s, 60, |s| !researching(s)),
        "le colon reste à l'établi après l'arrêt"
    );
}

#[test]
fn a_tech_costs_what_it_says() {
    for tech in Tech::ALL {
        assert!(tech.cost() >= 2_000, "{tech:?} : {}", tech.cost());
        // À vitesse nominale, une technologie demande dix à quinze mille ticks
        // de chercheur (une journée de jeu en fait 12 480) : de quoi peser
        // sans bloquer une partie.
        let ticks = tech.cost() * PROGRESS_SCALE / RESEARCH_STEP;
        assert!(
            (10_000..=15_000).contains(&ticks),
            "{tech:?} : {ticks} ticks"
        );
    }
}
