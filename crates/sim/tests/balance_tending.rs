//! Le raid ne doit plus tuer une deuxième fois.
//!
//! Constat n°5 de `crates/sim-cli/CAMPAIGN-FINDINGS.md` : pour deux colons
//! tués pendant un raid, un troisième mourait de ses plaies **après**, faute
//! de débit de pansement — rapport stable à 0,5 sur quatre campagnes.
//!
//! Ce fichier reproduit la mesure en petit : trois colons, un raid déclenché
//! au premier tick, et on compte les morts pendant le combat et les morts
//! après, jusqu'à une journée entière sans un ennemi debout. La scène est plus
//! dure que celle des campagnes (ni enceinte, ni arme, ni piège) : les
//! chiffres absolus y sont plus élevés, ce qui compte est l'écart avant/après.
//!
//! Mesuré sur les soixante graines, la même révision avec et sans la tranche
//! « soins » : **19 morts de leurs plaies pour 13 tués (1,46) → 4 pour 12
//! (0,33)**. Les tués au combat ne bougent pas (−1 sur 13) : c'est le soin
//! qu'on a réglé, pas le combat.

use sim::health::{HEMOSTASIS_TICKS, TEND_TICKS};
use sim::testmap::map_from;
use sim::{BodyPart, Command, Faction, Feature, ItemKind, Job, Sim};

const DAY: u64 = sim::TICKS_PER_DAY as u64;

/// Graines de la mesure statistique. Soixante : une scène de trois colons ne
/// produit qu'une poignée de morts par graine, il en faut le double d'une
/// campagne pour que le compte pèse.
const SEEDS: u64 = 60;
/// Plafond de l'observation : la mesure s'arrête d'elle-même une journée
/// après le dernier ennemi tombé (voir `play`), cette borne n'est là que pour
/// les graines où le conteur enchaîne les bandes.
const WATCH_DAYS: u64 = 5;
/// Journée de calme qui clôt la mesure : c'est la fenêtre où l'on meurt de ses
/// plaies. Une plaie non pansée saigne `health::BLEED_TICKS` — un sixième de
/// jour — donc personne n'échappe au compte.
const QUIET_DAYS: u64 = 1;

// ----------------------------------------------------------------------
// La mesure statistique
// ----------------------------------------------------------------------

/// Bilan d'une graine : morts pendant le combat, morts de leurs plaies après.
#[derive(Clone, Copy, Debug, Default)]
struct Toll {
    /// Un colon blessé disparu alors qu'un pillard était encore debout.
    combat: u32,
    /// Un colon blessé disparu alors qu'il ne restait plus un ennemi : c'est
    /// la mort qu'on cherche à faire reculer.
    wounds: u32,
    /// Toute autre disparition (famine, feu, froid). Doit rester à zéro,
    /// sinon la scène ne mesure pas ce qu'elle croit — c'est le garde-fou du
    /// harnais de `campaign`, repris tel quel.
    other: u32,
}

/// État d'un colon au tick précédent : assez pour attribuer une cause à sa
/// disparition, pas plus.
struct Watched {
    id: u32,
    hurt: bool,
    enemy: bool,
}

fn observe(s: &Sim, out: &mut Vec<Watched>) {
    let enemy = s
        .pawns()
        .iter()
        .any(|p| p.faction == Faction::Raider && p.is_alive());
    out.clear();
    for p in s.pawns() {
        if p.faction != Faction::Colony || !p.is_alive() {
            continue;
        }
        out.push(Watched {
            id: p.id,
            hurt: !p.injuries.is_empty(),
            enemy,
        });
    }
}

/// Trois colons sur une carte engendrée, des vivres à portée et un lit par
/// tête. Rien d'autre : ni enceinte, ni arme, ni piège — seule la suite du
/// raid nous intéresse.
fn raided_colony(seed: u64) -> Sim {
    let mut s = Sim::new(seed, 32, 32);
    let (bx, by) = s
        .map()
        .nearest_passable(16, 16)
        .expect("carte 32x32 sans centre franchissable");
    // De quoi tenir la semaine : la faim ne doit expliquer aucune mort.
    s.spawn_item(ItemKind::Berries, 400, bx, by);
    // Un lit par colon, en anneaux autour du repère : sans lit, personne
    // n'est jamais porté et le secours ne jouerait pas.
    let mut placed = 0;
    for r in 1..8i32 {
        for dy in -r..=r {
            for dx in -r..=r {
                if placed >= 3 || dx.abs().max(dy.abs()) != r {
                    continue;
                }
                let (x, y) = (bx as i32 + dx, by as i32 + dy);
                if !s.map().in_bounds(x, y) {
                    continue;
                }
                let (x, y) = (x as u32, y as u32);
                if s.map().passable(x, y) && s.map().feature(x, y) == Feature::None {
                    s.map_mut().set_feature(x, y, Feature::Bed);
                    placed += 1;
                }
            }
        }
    }
    s
}

/// Joue une graine : un raid au premier tick, puis l'observation tick par
/// tick jusqu'à `QUIET_DAYS` jours **sans un ennemi debout** — la fenêtre où
/// l'on meurt de ses plaies, refermée dès qu'elle est vide. Sans cette sortie,
/// la mesure attraperait les bandes suivantes et ne dirait plus rien du raid
/// qu'on observe.
fn play(seed: u64) -> Toll {
    let mut s = raided_colony(seed);
    let mut toll = Toll::default();
    let mut before: Vec<Watched> = Vec::new();
    observe(&s, &mut before);
    s.step(&[Command::TriggerRaid]);
    let mut quiet = 0;
    for _ in 0..WATCH_DAYS * DAY {
        if s.pawns()
            .iter()
            .any(|p| p.faction == Faction::Raider && p.is_alive())
        {
            quiet = 0;
        } else {
            quiet += 1;
            if quiet > QUIET_DAYS * DAY {
                break;
            }
        }
        for w in &before {
            if s.pawns().iter().any(|p| p.id == w.id && p.is_alive()) {
                continue;
            }
            if w.hurt && w.enemy {
                toll.combat += 1;
            } else if w.hurt {
                toll.wounds += 1;
            } else {
                toll.other += 1;
            }
        }
        observe(&s, &mut before);
        s.step(&[]);
    }
    toll
}

#[test]
fn le_raid_ne_tue_plus_une_deuxieme_fois() {
    let mut t = Toll::default();
    for seed in 1..=SEEDS {
        let seed_toll = play(seed);
        t.combat += seed_toll.combat;
        t.wounds += seed_toll.wounds;
        t.other += seed_toll.other;
    }
    println!(
        "combat {} / plaies {} / autre {} → rapport {}/1000",
        t.combat,
        t.wounds,
        t.other,
        1000 * t.wounds / t.combat.max(1)
    );
    assert_eq!(t.other, 0, "des morts que la scène n'explique pas : {t:?}");
    assert!(
        t.combat > 0,
        "aucun mort au combat : la scène ne mesure rien"
    );
    // Mesuré : 19 morts de leurs plaies pour 13 tués avant la tranche, 4 pour
    // 12 après. Le seuil est posé à un mort de ses plaies pour deux tués :
    // largement au-dessus du résultat, largement en dessous de ce que faisait
    // le sim d'avant, de quoi laisser respirer le bruit de soixante graines.
    assert!(
        2 * t.wounds <= t.combat,
        "{} morts de leurs plaies pour {} tués au combat (rapport {}/1000)",
        t.wounds,
        t.combat,
        1000 * t.wounds / t.combat.max(1)
    );
}

// ----------------------------------------------------------------------
// Les quatre mécanismes, un par un
// ----------------------------------------------------------------------

/// Clairière nue : `Sim::from_map` y pose les trois colons au centre, côte à
/// côte. Le soignant n'a qu'un pas à faire, ce qui rend les durées lisibles.
fn bedside() -> Sim {
    let mut s = Sim::from_map(
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
    );
    s.spawn_item(ItemKind::Berries, 200, 1, 1);
    s
}

/// L'hémostase : le sang s'arrête au quart du geste, pas à la fin. C'est le
/// gros du gain de débit — un soignant seul juge quatre hémorragies dans le
/// temps qu'il mettait à en bander une seule.
#[test]
fn lhemostase_arrete_le_sang_avant_la_fin_du_soin() {
    let mut s = bedside();
    let patient = colonists(&s)[0];
    s.inflict_injury(patient, BodyPart::Torso, 200);
    s.inflict_injury(patient, BodyPart::LeftArm, 120);
    assert!(bleeding(&s, patient), "la scène ne saigne pas");

    // Le soignant part au chevet : on compte à partir de là.
    assert!(
        run_until(&mut s, DAY, |s| tender_of(s, patient).is_some()),
        "personne n'est venu panser"
    );
    let begun = s.tick();
    assert!(
        run_until(&mut s, DAY, |s| !bleeding(s, patient)),
        "le sang coule encore : {:?}",
        injuries(&s, patient)
    );
    let stopped = s.tick() - begun;
    assert!(
        stopped >= u64::from(HEMOSTASIS_TICKS),
        "le sang s'est arrêté en {stopped} ticks, avant même l'hémostase \
         ({HEMOSTASIS_TICKS})"
    );
    assert!(
        stopped < u64::from(TEND_TICKS),
        "le sang s'arrête en {stopped} ticks, soin complet = {TEND_TICKS} : \
         l'hémostase ne sert à rien"
    );
    // La plaie n'est pas encore bandée pour autant : la séance continue.
    assert!(
        injuries(&s, patient).iter().any(|i| !i.tended),
        "tout est déjà pansé : l'hémostase ne se distingue pas du soin complet"
    );
    assert!(
        run_until(&mut s, DAY, |s| injuries(s, patient)
            .iter()
            .all(|i| i.tended)),
        "le soin ne s'est jamais achevé : {:?}",
        injuries(&s, patient)
    );
}

/// Le tri des blessés : celui qui se vide le plus vite passe d'abord, même si
/// l'autre est plus proche ou plus abîmé.
#[test]
fn le_soin_va_dabord_au_plus_gros_saignement() {
    let mut s = bedside();
    let ids = colonists(&s);
    assert!(ids.len() >= 3, "il faut trois colons : {ids:?}");
    let (healer, scratch, bleeder) = (ids[0], ids[1], ids[2]);
    // Une égratignure d'un côté, une hémorragie de l'autre.
    s.inflict_injury(scratch, BodyPart::LeftArm, 40);
    s.inflict_injury(bleeder, BodyPart::Torso, 400);
    assert!(
        time_to_bleed_out(&s, bleeder) < time_to_bleed_out(&s, scratch),
        "le tri lui-même est faux : {} contre {}",
        time_to_bleed_out(&s, bleeder),
        time_to_bleed_out(&s, scratch)
    );

    // Les pawns sont traités dans l'ordre : le premier colon choisit d'abord.
    assert!(
        run_until(&mut s, DAY, |s| tend_target(s, healer).is_some()),
        "le soignant n'est jamais parti"
    );
    assert_eq!(
        tend_target(&s, healer),
        Some(bleeder),
        "le soignant s'occupe de l'égratignure avant l'hémorragie"
    );
}

/// Une hémorragie non pansée tire les dormeurs du lit : sans cela, le blessé
/// se vidait pendant que la colonie dormait — trois des neuf morts qui
/// restaient après l'hémostase, dans la mesure ciblée.
#[test]
fn une_hemorragie_reveille_la_colonie() {
    let mut s = bedside();
    let ids = colonists(&s);
    let patient = ids[2];
    // Toute la colonie tombe de sommeil et va se coucher.
    for &id in &ids {
        s.pawn_mut(id).expect("le colon existe").rest = 0;
    }
    assert!(
        run_until(&mut s, DAY, |s| s
            .pawns()
            .iter()
            .filter(|p| p.is_colonist())
            .all(|p| matches!(p.job, Job::Sleep { .. }))),
        "la colonie ne s'est pas couchée : {:?}",
        jobs(&s)
    );
    // Puis un camarade se met à saigner.
    s.inflict_injury(patient, BodyPart::Torso, 300);
    assert!(
        run_until(&mut s, 600, |s| tender_of(s, patient).is_some()),
        "personne ne s'est levé : {:?}",
        jobs(&s)
    );
    assert!(
        run_until(&mut s, DAY, |s| !bleeding(s, patient)),
        "le sang coule encore : {:?}",
        injuries(&s, patient)
    );
}

/// Le blessé qui saigne se panse **avant** d'être porté au lit. Le transport
/// d'abord, c'était une mort d'après-raid sur quatre : le sang qu'on lui
/// gardait, il le perdait sur le brancard.
#[test]
fn le_saignement_se_panse_avant_le_brancard() {
    let mut s = bedside();
    let patient = colonists(&s)[2];
    s.map_mut().set_feature(1, 6, Feature::Bed);
    // Il tombe **avant** que quiconque ait pu réagir : `Job::Downed` est posé
    // à la main, comme dans les tests de combat. Sinon les camarades le
    // pansent pendant qu'il est encore debout et le brancard n'entre jamais
    // en scène — la mesure ne dirait plus rien.
    s.inflict_injury(patient, BodyPart::Torso, 300);
    {
        let p = s.pawn_mut(patient).expect("le colon existe");
        p.blood = 305;
        p.job = Job::Downed;
    }
    assert!(
        find(&s, patient).is_some_and(|p| p.is_downed()),
        "le blessé n'est pas à terre"
    );
    // On le suit jusqu'à ce que le sang s'arrête, en guettant le brancard.
    let mut carried_while_bleeding = false;
    let stopped = run_until(&mut s, 2 * u64::from(TEND_TICKS), |s| {
        carried_while_bleeding |= carrier_of(s, patient).is_some() && bleeding(s, patient);
        !bleeding(s, patient)
    });
    assert!(
        stopped,
        "le sang coule encore : {:?}",
        injuries(&s, patient)
    );
    assert!(
        !carried_while_bleeding,
        "on l'a porté au lit alors qu'il se vidait encore : {:?}",
        jobs(&s)
    );
}

// ----------------------------------------------------------------------
// Petits outils
// ----------------------------------------------------------------------

fn run_until(s: &mut Sim, max: u64, mut pred: impl FnMut(&Sim) -> bool) -> bool {
    for _ in 0..max {
        if pred(s) {
            return true;
        }
        s.step(&[]);
    }
    pred(s)
}

/// Les colons humains, dans l'ordre où le sim les traite : une bête
/// apprivoisée est aussi de `Faction::Colony`, et la faune peuple la carte.
fn colonists(s: &Sim) -> Vec<u32> {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist())
        .map(|p| p.id)
        .collect()
}

/// Ce que fait chacun, pour les messages d'échec.
fn jobs(s: &Sim) -> Vec<Job> {
    s.pawns().iter().map(|p| p.job.clone()).collect()
}

fn find(s: &Sim, id: u32) -> Option<&sim::Pawn> {
    s.pawns().iter().find(|p| p.id == id)
}

fn injuries(s: &Sim, id: u32) -> Vec<sim::health::Injury> {
    find(s, id).map(|p| p.injuries.clone()).unwrap_or_default()
}

fn bleeding(s: &Sim, id: u32) -> bool {
    find(s, id).is_some_and(|p| p.is_bleeding())
}

fn time_to_bleed_out(s: &Sim, id: u32) -> u32 {
    find(s, id).map_or(u32::MAX, |p| p.ticks_to_bleed_out())
}

/// Le colon qui panse `id`, s'il y en a un.
fn tender_of(s: &Sim, id: u32) -> Option<u32> {
    s.pawns().iter().find_map(|p| match p.job {
        Job::Tend { target, .. } if target == id => Some(p.id),
        _ => None,
    })
}

/// Le colon qui porte `id` au lit, s'il y en a un.
fn carrier_of(s: &Sim, id: u32) -> Option<u32> {
    s.pawns().iter().find_map(|p| match p.job {
        Job::Rescue { target, .. } if target == id => Some(p.id),
        _ => None,
    })
}

/// Qui `id` est-il en train de panser ?
fn tend_target(s: &Sim, id: u32) -> Option<u32> {
    find(s, id).and_then(|p| match p.job {
        Job::Tend { target, .. } => Some(target),
        _ => None,
    })
}
