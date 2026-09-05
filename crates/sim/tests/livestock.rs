//! Élevage : apprivoiser, garder, reproduire, abattre.
//!
//! Les cartes sont dessinées à la main (`sim::testmap`) : une prairie d'herbe
//! pour la pâture, la même en terre battue pour la famine.

use sim::animals::GRAZE_RANGE;
use sim::livestock::{
    LIVESTOCK_RANGE, MAX_LIVESTOCK, TAME_BASE_DEN, TAME_BASE_NUM, TAME_FOOD, tame_chance,
};
use sim::map::chebyshev;
use sim::pawn::NEED_MAX;
use sim::storyteller::{THREAT_PER_COLONIST, WEALTH_CACHE_TICKS};
use sim::testmap::map_from;
use sim::{
    Command, EventKind, Faction, Feature, ItemKind, Job, Pawn, Sim, Species, TICKS_PER_DAY, Zone,
};

const DAY: u64 = TICKS_PER_DAY as u64;

/// Prairie de 32 × 16 : de l'herbe partout, donc de la pâture partout. Les
/// colons naissent au centre, vers (16, 8).
fn pasture() -> Sim {
    Sim::from_map(1, map_from(&[&".".repeat(32) as &str; 16]))
}

/// La même en terre battue : pas un brin d'herbe, pas un buisson. Une bête
/// n'y trouve rien à paître.
fn barrens(seed: u64) -> Sim {
    Sim::from_map(seed, map_from(&[&",".repeat(32) as &str; 16]))
}

fn find_pawn(s: &Sim, id: u32) -> Option<&Pawn> {
    s.pawns().iter().find(|p| p.id == id)
}

/// Garde les **colons** en pleine forme sans rien poser sur la carte : ces
/// tests parlent d'élevage, pas de faim ni de sommeil. Les bêtes, elles, ne
/// sont pas touchées : leur faim est justement le sujet.
fn top_up_colonists(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.is_colonist())
        .map(|p| p.id)
        .collect();
    for id in ids {
        if let Some(p) = s.pawn_mut(id) {
            p.hunger = NEED_MAX;
            p.rest = NEED_MAX;
        }
    }
}

/// Avance jusqu'à ce que le prédicat soit vrai, colons nourris et reposés.
fn run_fed(s: &mut Sim, max: u64, mut pred: impl FnMut(&Sim) -> bool) -> bool {
    for _ in 0..max {
        if pred(s) {
            return true;
        }
        top_up_colonists(s);
        s.step(&[]);
    }
    pred(s)
}

/// Fait passer une bête dans la colonie **sans jouer l'apprivoisement** :
/// c'est l'état d'arrivée qu'on veut observer, pas le chemin qui y mène (celui
/// -là est éprouvé par `a_marked_rabbit_gets_tamed_eventually`). Même esprit
/// que `Sim::map_mut` : les tests posent l'état, le jeu passe par des
/// `Command`.
fn make_livestock(s: &mut Sim, id: u32) {
    let p = s.pawn_mut(id).expect("la bête existe");
    p.faction = Faction::Colony;
    p.hunted = false;
    p.tame_marked = false;
    p.hunger = NEED_MAX;
    p.job = Job::Idle;
}

/// Bêtes apprivoisées vivantes d'une espèce.
fn herd(s: &Sim, species: Species) -> Vec<u32> {
    s.pawns()
        .iter()
        .filter(|p| p.is_livestock() && p.is_alive() && p.species == Some(species))
        .map(|p| p.id)
        .collect()
}

fn events_of(s: &Sim, kind: EventKind, arg: u32) -> usize {
    s.events()
        .iter()
        .filter(|e| e.kind == kind && e.arg == arg)
        .count()
}

// ----------------------------------------------------------------------
// Marquage et ration
// ----------------------------------------------------------------------

#[test]
fn taming_needs_food_and_marks_the_animal() {
    let mut s = pasture();
    let rabbit = s.spawn_animal(4, 12, Species::Rabbit);
    s.step(&[Command::Tame {
        animal: rabbit,
        on: true,
    }]);
    assert!(
        find_pawn(&s, rabbit).is_some_and(|p| p.tame_marked && !p.hunted),
        "le marqueur d'apprivoisement n'est pas posé"
    );

    // Sans stockage ni fourrage, personne ne bouge : on n'amadoue pas un
    // lapin les mains vides.
    for _ in 0..DAY / 4 {
        top_up_colonists(&mut s);
        s.step(&[]);
        assert!(
            !s.pawns().iter().any(|p| matches!(p.job, Job::Tame { .. })),
            "un colon part apprivoiser sans ration au tick {}",
            s.tick()
        );
    }

    // Un stockage et trente baies : un colon prend sa ration et s'y met.
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 18,
        y0: 8,
        x1: 19,
        y1: 9,
    }]);
    s.spawn_item(ItemKind::Berries, 30, 18, 8);
    assert!(
        run_fed(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Tame { picked: true, .. }))),
        "personne n'a emporté de ration : {:?}",
        s.pawns().iter().map(|p| p.job.code()).collect::<Vec<_>>()
    );
    let carried = s
        .pawns()
        .iter()
        .find(|p| matches!(p.job, Job::Tame { picked: true, .. }))
        .and_then(|p| p.carrying);
    assert_eq!(
        carried,
        Some((ItemKind::Berries, TAME_FOOD)),
        "la ration n'est pas de {TAME_FOOD} baies"
    );
    assert!(
        s.stored_totals()[ItemKind::Berries as usize] <= 30 - TAME_FOOD,
        "la ration n'a pas été prélevée au stock"
    );
}

#[test]
fn hunt_and_tame_marks_are_exclusive() {
    let mut s = pasture();
    let deer = s.spawn_animal(4, 12, Species::Deer);

    s.step(&[Command::Hunt {
        animal: deer,
        on: true,
    }]);
    assert!(find_pawn(&s, deer).is_some_and(|p| p.hunted && !p.tame_marked));

    // Marquer pour l'apprivoisement retire la chasse…
    s.step(&[Command::Tame {
        animal: deer,
        on: true,
    }]);
    assert!(find_pawn(&s, deer).is_some_and(|p| p.tame_marked && !p.hunted));

    // …et inversement.
    s.step(&[Command::Hunt {
        animal: deer,
        on: true,
    }]);
    assert!(find_pawn(&s, deer).is_some_and(|p| p.hunted && !p.tame_marked));

    // Un chasseur en route lâche prise dès qu'on préfère amadouer la bête.
    let hunter = s.pawns()[0].id;
    s.pawn_mut(hunter).expect("le colon existe").weapon = Some(ItemKind::Club);
    assert!(
        run_fed(&mut s, DAY, |s| s.pawns().iter().any(
            |p| matches!(p.job, Job::Hunt { target } if target == deer)
        )),
        "aucun colon n'a pris le job de chasse"
    );
    s.step(&[Command::Tame {
        animal: deer,
        on: true,
    }]);
    assert!(
        !s.pawns().iter().any(|p| matches!(p.job, Job::Hunt { .. })),
        "un chasseur poursuit une bête qu'on veut apprivoiser"
    );

    // Une bête de la colonie ne se chasse plus et ne se marque plus : elle
    // s'abat. Et une bête sauvage ne s'abat pas.
    let rabbit = s.spawn_animal(6, 12, Species::Rabbit);
    s.step(&[Command::Slaughter { animal: rabbit }]);
    assert!(
        find_pawn(&s, rabbit).is_some_and(|p| !p.slaughter_marked),
        "une bête sauvage a été marquée pour l'abattoir"
    );
    make_livestock(&mut s, rabbit);
    s.step(&[
        Command::Hunt {
            animal: rabbit,
            on: true,
        },
        Command::Tame {
            animal: rabbit,
            on: true,
        },
    ]);
    assert!(
        find_pawn(&s, rabbit).is_some_and(|p| !p.hunted && !p.tame_marked),
        "une bête apprivoisée reste marquable"
    );
    s.step(&[Command::Slaughter { animal: rabbit }]);
    assert!(
        find_pawn(&s, rabbit).is_some_and(|p| p.slaughter_marked),
        "une bête de la colonie refuse l'abattoir"
    );
}

// ----------------------------------------------------------------------
// La chance d'apprivoiser : mesurée, pas devinée
// ----------------------------------------------------------------------

/// Trois jours, trente baies (donc six tentatives au plus), un lapin marqué,
/// dix graines. **C'est la mesure qui a fixé `TAME_BASE_NUM`** : la campagne
/// complète (20 graines, les trois espèces, trois valeurs de base) est
/// tabulée dans la documentation de cette constante. Au réglage retenu, le
/// lapin passe 20 fois sur 20 en 1,7 tentative moyenne ; le seuil est ici à 8
/// sur 10 parce que le dé reste un dé et qu'on ne veut pas d'un test qui se
/// casse au premier décalage du flux d'aléa.
#[test]
fn a_marked_rabbit_gets_tamed_eventually() {
    // Le barème lui-même : le lapin part à 375 ‰ par tentative au niveau 0.
    assert_eq!(
        tame_chance(Species::Rabbit, 0),
        TAME_BASE_NUM * Species::Rabbit.tame_percent() / 100
    );
    assert!(tame_chance(Species::Rabbit, 0) * 3 > TAME_BASE_DEN);

    let mut tamed = 0;
    for seed in 1..=10u64 {
        let mut s = Sim::from_map(seed, map_from(&[&".".repeat(32) as &str; 16]));
        s.step(&[Command::SetZone {
            zone: Zone::Stockpile,
            x0: 18,
            y0: 8,
            x1: 19,
            y1: 9,
        }]);
        s.spawn_item(ItemKind::Berries, 30, 18, 8);
        let rabbit = s.spawn_animal(12, 10, Species::Rabbit);
        s.step(&[Command::Tame {
            animal: rabbit,
            on: true,
        }]);
        if run_fed(&mut s, 3 * DAY, |s| {
            find_pawn(s, rabbit).is_some_and(|p| p.is_livestock())
        }) {
            tamed += 1;
            assert!(
                events_of(&s, EventKind::Tamed, Species::Rabbit as u32) >= 1,
                "graine {seed} : pas d'événement Tamed"
            );
        }
    }
    assert!(
        tamed >= 8,
        "seulement {tamed} lapins apprivoisés sur 10 graines en trois jours"
    );
}

// ----------------------------------------------------------------------
// La vie d'une bête de la colonie
// ----------------------------------------------------------------------

#[test]
fn tamed_animals_stay_near_home() {
    let mut s = pasture();
    // Un lapin au coin de la carte, à quinze cases du centre.
    let rabbit = s.spawn_animal(31, 15, Species::Rabbit);
    make_livestock(&mut s, rabbit);
    let home = s.colony_center().expect("la colonie est vivante");
    assert!(
        chebyshev(home, (31, 15)) > LIVESTOCK_RANGE,
        "le lapin est déjà à la maison, le test ne prouve rien"
    );

    assert!(
        run_fed(&mut s, DAY, |s| {
            let home = s.colony_center().expect("la colonie est vivante");
            find_pawn(s, rabbit).is_some_and(|p| chebyshev(home, p.tile()) <= LIVESTOCK_RANGE)
        }),
        "le lapin n'est pas rentré : {:?}",
        find_pawn(&s, rabbit).map(|p| p.tile())
    );

    // Et il y reste : la case visée est toujours dans le rayon, à la tolérance
    // près du pas de pâture (le barycentre bouge, lui aussi).
    for _ in 0..DAY {
        top_up_colonists(&mut s);
        s.step(&[]);
        let home = s.colony_center().expect("la colonie est vivante");
        let p = find_pawn(&s, rabbit).expect("le lapin est vivant");
        assert!(
            chebyshev(home, p.tile()) <= LIVESTOCK_RANGE + GRAZE_RANGE as u32,
            "le lapin s'est échappé en {:?} (maison {home:?})",
            p.tile()
        );
        assert!(!p.leaving, "une bête de la colonie ne quitte pas la carte");
    }
}

#[test]
fn tamed_boars_defend_the_colony() {
    let mut s = pasture();
    // Le sanglier et le lapin loin des colons (au centre) : ce qui arrive au
    // pillard ne peut venir que d'eux.
    let boar = s.spawn_animal(30, 3, Species::Boar);
    let rabbit = s.spawn_animal(30, 12, Species::Rabbit);
    make_livestock(&mut s, boar);
    make_livestock(&mut s, rabbit);
    let raider = s.spawn_pawn(29, 3, Faction::Raider);
    if let Some(p) = s.pawn_mut(raider) {
        p.hunger = NEED_MAX;
        p.rest = NEED_MAX;
    }

    let mut charged = false;
    let mut hurt = false;
    for _ in 0..DAY / 2 {
        top_up_colonists(&mut s);
        s.step(&[]);
        charged |= find_pawn(&s, boar).is_some_and(|p| matches!(p.job, Job::Attack { .. }));
        hurt |= find_pawn(&s, raider).is_none_or(|p| !p.injuries.is_empty());
        assert!(
            find_pawn(&s, rabbit).is_none_or(|p| !matches!(p.job, Job::Attack { .. })),
            "un lapin de garde s'est mis à charger"
        );
        if charged && hurt {
            break;
        }
    }
    assert!(charged, "le sanglier apprivoisé n'a pas défendu la colonie");
    assert!(hurt, "le sanglier n'a pas touché le pillard");
    // Aucune compétence de combat ne monte chez une bête, et son coup ne doit
    // rien à une arme : elle frappe du boutoir.
    if let Some(p) = find_pawn(&s, boar) {
        assert_eq!(p.melee.level, 0, "une bête a gagné un niveau de mêlée");
        assert_eq!(p.melee.xp, 0);
        assert!(p.weapon.is_none());
    }
}

// ----------------------------------------------------------------------
// Reproduction
// ----------------------------------------------------------------------

#[test]
fn rabbits_breed_up_to_the_cap() {
    let period = u64::from(Species::Rabbit.breed_days()) * DAY;

    // Deux lapins et le temps : un troisième naît.
    let mut s = pasture();
    for k in 0..2 {
        let id = s.spawn_animal(14 + k, 10, Species::Rabbit);
        make_livestock(&mut s, id);
    }
    assert_eq!(herd(&s, Species::Rabbit).len(), 2);
    assert!(
        run_fed(&mut s, period + DAY, |s| herd(s, Species::Rabbit).len() > 2),
        "aucune naissance en {} jours",
        Species::Rabbit.breed_days() + 1
    );
    assert!(
        events_of(&s, EventKind::Born, Species::Rabbit as u32) >= 1,
        "pas d'événement Born : {:?}",
        s.events()
    );
    assert_eq!(
        s.livestock_count() as usize,
        herd(&s, Species::Rabbit).len(),
        "le compte du troupeau ne suit pas"
    );
    // Un seul lapin ne fait pas de petit.
    let mut alone = pasture();
    let lone = alone.spawn_animal(14, 10, Species::Rabbit);
    make_livestock(&mut alone, lone);
    assert!(
        !run_fed(&mut alone, period + DAY, |s| herd(s, Species::Rabbit).len()
            > 1),
        "un lapin seul s'est reproduit"
    );

    // Au plafond, plus rien ne naît.
    let mut full = pasture();
    for k in 0..MAX_LIVESTOCK {
        let id = full.spawn_animal(2 + k, 2, Species::Rabbit);
        make_livestock(&mut full, id);
    }
    assert_eq!(herd(&full, Species::Rabbit).len(), MAX_LIVESTOCK as usize);
    assert!(
        !run_fed(&mut full, period + DAY, |s| herd(s, Species::Rabbit).len()
            > MAX_LIVESTOCK as usize),
        "le plafond de {MAX_LIVESTOCK} bêtes a été dépassé"
    );
}

// ----------------------------------------------------------------------
// Abattage
// ----------------------------------------------------------------------

#[test]
fn slaughter_yields_a_carcass() {
    let mut s = pasture();
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 18,
        y0: 8,
        x1: 19,
        y1: 9,
    }]);
    s.map_mut().set_feature(18, 11, Feature::CraftingSpot);
    let rabbit = s.spawn_animal(15, 9, Species::Rabbit);
    make_livestock(&mut s, rabbit);
    s.step(&[Command::Slaughter { animal: rabbit }]);
    assert!(find_pawn(&s, rabbit).is_some_and(|p| p.slaughter_marked));

    assert!(
        run_fed(&mut s, DAY, |s| find_pawn(s, rabbit).is_none()),
        "le lapin n'a pas été abattu : {:?}",
        find_pawn(&s, rabbit).map(|p| p.job.code())
    );
    assert_eq!(
        events_of(&s, EventKind::Slaughtered, Species::Rabbit as u32),
        1,
        "pas d'événement Slaughtered : {:?}",
        s.events()
    );
    assert_eq!(
        events_of(&s, EventKind::AnimalHunted, Species::Rabbit as u32),
        0,
        "un abattage a été annoncé comme une chasse"
    );
    // La dépouille est celle d'une bête chassée : le dépeçage existant la
    // débite au poste et en tire de la viande.
    assert!(
        run_fed(&mut s, 2 * DAY, |s| s.colony_total(ItemKind::Meat) > 0),
        "la dépouille n'a pas donné de viande : {:?}",
        s.items()
            .iter()
            .map(|i| (i.kind, i.count))
            .collect::<Vec<_>>()
    );
    assert!(s.colony_total(ItemKind::Meat) <= Species::Rabbit.meat());
}

// ----------------------------------------------------------------------
// Faim
// ----------------------------------------------------------------------

/// Sans herbe et sans réserve, le troupeau meurt : l'élevage demande de la
/// place herbeuse — ou du fourrage. **Mesuré** sur la terre battue : la faim
/// d'un lapin est à sec au bout de deux jours, puis la famine des colons
/// (`combat::STARVE_DAMAGE_INTERVAL`) a raison de ses 150 PV en un tiers de
/// jour de plus ; un sanglier (800 PV) tient jusqu'au quatrième jour.
#[test]
fn starving_livestock_dies_without_grass() {
    let mut s = barrens(1);
    let rabbit = s.spawn_animal(15, 9, Species::Rabbit);
    make_livestock(&mut s, rabbit);
    // Deux jours plus tard, la bête a le ventre vide mais tient debout.
    for _ in 0..2 * DAY {
        top_up_colonists(&mut s);
        s.step(&[]);
    }
    let starving = find_pawn(&s, rabbit).expect("le lapin est encore là");
    assert!(
        starving.hunger == 0,
        "le lapin a trouvé à manger sur la terre battue : faim = {}",
        starving.hunger
    );
    // Puis elle s'éteint, et laisse sa dépouille comme n'importe quelle bête.
    assert!(
        run_fed(&mut s, 2 * DAY, |s| find_pawn(s, rabbit).is_none()),
        "le lapin a survécu quatre jours sans rien manger"
    );
    assert!(
        s.items().iter().any(|i| i.kind == ItemKind::RabbitCorpse),
        "aucune dépouille : {:?}",
        s.items().iter().map(|i| i.kind).collect::<Vec<_>>()
    );

    // Témoin : la même bête sur de l'herbe traverse les quatre jours.
    let mut green = pasture();
    let grazer = green.spawn_animal(15, 9, Species::Rabbit);
    make_livestock(&mut green, grazer);
    for _ in 0..4 * DAY {
        top_up_colonists(&mut green);
        green.step(&[]);
    }
    let fed = find_pawn(&green, grazer).expect("le lapin a paissé");
    assert!(
        fed.hunger > 0 && fed.injuries.is_empty(),
        "le lapin a maigri en pleine prairie : faim = {}",
        fed.hunger
    );

    // Et sur la terre battue, une réserve de baies remplace la pâture : c'est
    // ce qui fait passer l'hiver à un troupeau.
    let mut stocked = barrens(2);
    stocked.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 18,
        y0: 8,
        x1: 19,
        y1: 9,
    }]);
    stocked.spawn_item(ItemKind::Berries, 60, 18, 8);
    let barn = stocked.spawn_animal(15, 9, Species::Rabbit);
    make_livestock(&mut stocked, barn);
    let before = stocked.stored_totals()[ItemKind::Berries as usize];
    for _ in 0..3 * DAY {
        top_up_colonists(&mut stocked);
        stocked.step(&[]);
    }
    assert!(
        find_pawn(&stocked, barn).is_some(),
        "le lapin est mort de faim devant le silo"
    );
    assert!(
        stocked.stored_totals()[ItemKind::Berries as usize] < before,
        "la bête n'a pas touché à la réserve"
    );
}

// ----------------------------------------------------------------------
// Snapshot
// ----------------------------------------------------------------------

#[test]
fn snapshot_keeps_livestock() {
    let mut s = pasture();
    let kept = s.spawn_animal(14, 9, Species::Rabbit);
    let marked = s.spawn_animal(16, 9, Species::Deer);
    make_livestock(&mut s, kept);
    s.step(&[
        Command::Tame {
            animal: marked,
            on: true,
        },
        Command::Slaughter { animal: kept },
    ]);
    assert!(find_pawn(&s, kept).is_some_and(|p| p.slaughter_marked));
    assert!(find_pawn(&s, marked).is_some_and(|p| p.tame_marked));

    let bytes = s.snapshot();
    let mut back = Sim::restore(&bytes).expect("snapshot relu");
    assert_eq!(back.state_hash(), s.state_hash(), "hash après relecture");
    let after = find_pawn(&back, kept).expect("la bête a survécu au snapshot");
    assert!(after.is_livestock() && after.slaughter_marked);
    assert_eq!(after.species, Some(Species::Rabbit));
    assert!(find_pawn(&back, marked).is_some_and(|p| p.tame_marked));
    assert_eq!(back.livestock_count(), 1);

    // Et le futur reste identique : élevage compris.
    for _ in 0..2000 {
        s.step(&[]);
        back.step(&[]);
    }
    assert_eq!(back.state_hash(), s.state_hash(), "les futurs divergent");
}

// ----------------------------------------------------------------------
// Déterminisme
// ----------------------------------------------------------------------

/// Le scénario de référence (`tests/determinism.rs`) émet bien `Tame` et
/// `Slaughter`, mais rien ne garantit qu'un apprivoisement y aboutisse : sa
/// carte est couverte de désignations et le dé reste un dé. Ce test-ci
/// **impose** un troupeau des deux côtés et compare les hashes : la pâture
/// dirigée, l'horloge de reproduction, la faim, l'abattage et la ration
/// entrent tous dans la comparaison.
#[test]
fn livestock_is_deterministic() {
    fn stocked(seed: u64) -> Sim {
        let mut s = Sim::from_map(seed, map_from(&[&".".repeat(32) as &str; 16]));
        s.step(&[Command::SetZone {
            zone: Zone::Stockpile,
            x0: 18,
            y0: 8,
            x1: 19,
            y1: 9,
        }]);
        s.spawn_item(ItemKind::Berries, 60, 18, 8);
        s.map_mut().set_feature(18, 11, Feature::CraftingSpot);
        // Deux lapins de la colonie (donc un couple qui se reproduira), un
        // sanglier de la colonie, et un cerf sauvage à apprivoiser.
        for k in 0..2 {
            let id = s.spawn_animal(14 + k, 10, Species::Rabbit);
            make_livestock(&mut s, id);
        }
        let boar = s.spawn_animal(20, 12, Species::Boar);
        make_livestock(&mut s, boar);
        s.spawn_animal(6, 4, Species::Deer);
        s
    }

    let mut a = stocked(7);
    let mut b = stocked(7);
    assert_eq!(a.state_hash(), b.state_hash(), "départs différents");
    let deer = a
        .pawns()
        .iter()
        .find(|p| p.faction == Faction::Animal && p.species == Some(Species::Deer))
        .map(|p| p.id)
        .expect("un cerf sauvage");
    let boar = a
        .pawns()
        .iter()
        .find(|p| p.is_livestock() && p.species == Some(Species::Boar))
        .map(|p| p.id)
        .expect("un sanglier apprivoisé");

    for t in 0..4 * DAY {
        let mut cmds: Vec<Command> = Vec::new();
        if t == 10 {
            cmds.push(Command::Tame {
                animal: deer,
                on: true,
            });
        }
        if t == 3 * DAY {
            cmds.push(Command::Slaughter { animal: boar });
            // Un id qui ne désigne rien : consommé et ignoré des deux côtés.
            cmds.push(Command::Slaughter { animal: u32::MAX });
        }
        a.step(&cmds);
        b.step(&cmds);
        if t % 1000 == 0 {
            assert_eq!(a.state_hash(), b.state_hash(), "désync au tick {t}");
        }
    }
    assert_eq!(a, b, "les deux sims ont divergé");
    // Le scénario a bien produit de l'élevage : un troupeau vivant, une
    // naissance, et le sanglier passé à l'abattoir.
    assert!(a.livestock_count() >= 2, "le troupeau a disparu");
    assert!(
        events_of(&a, EventKind::Born, Species::Rabbit as u32) >= 1,
        "aucune naissance : {:?}",
        a.events()
    );
    assert!(
        find_pawn(&a, boar).is_none(),
        "le sanglier n'a pas été abattu"
    );
}

/// Un troupeau enrichit la colonie sans l'exposer : il pèse dans
/// `Sim::wealth` (modestement) et **pas** dans les points de menace, où trois
/// bêtes comptées comme trois colons vaudraient 120 points de raid.
#[test]
fn livestock_counts_in_wealth_but_not_in_threat() {
    // Terre battue : rien à couper, rien à récolter, donc une richesse qui ne
    // bouge que de ce qu'on y met.
    let mut s = barrens(3);
    for _ in 0..WEALTH_CACHE_TICKS {
        top_up_colonists(&mut s);
        s.step(&[]);
    }
    let wealth_before = s.wealth();
    let threat_before = s.threat_points();

    let mut expected = 0;
    for k in 0..3 {
        let id = s.spawn_animal(14 + k, 9, Species::Rabbit);
        make_livestock(&mut s, id);
        expected += Species::Rabbit.wealth_value();
    }
    for _ in 0..WEALTH_CACHE_TICKS {
        top_up_colonists(&mut s);
        s.step(&[]);
    }
    assert_eq!(
        s.wealth(),
        wealth_before + expected,
        "le troupeau ne pèse pas ce qu'il doit dans la richesse"
    );
    assert!(
        s.threat_points() < threat_before + THREAT_PER_COLONIST,
        "trois lapins ont été comptés comme des colons : {} → {}",
        threat_before,
        s.threat_points()
    );
}
