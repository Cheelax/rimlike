//! Équilibrage du bétail : ce qu'une bande de pillards coûte au troupeau.
//!
//! Ces tests-là ne vérifient pas seulement un mécanisme, ils **mesurent un
//! réglage** (`AGENTS.md`, « on mesure avant de régler »). Le scénario est
//! celui du joueur scripté de `crates/sim-cli/CAMPAIGN-FINDINGS.md` §11.3,
//! réduit à ce qui compte : une colonie murée de demi-côté 6 avec une porte,
//! deux bêtes apprivoisées lâchées **dehors** — c'est là qu'on les apprivoise,
//! `animals::WILD_MIN_DISTANCE` valant 12 — et une bande qui entre.
//!
//! Le harnais attribue une **cause** à chaque bête morte, comme
//! `sim-cli/src/campaign.rs` le fait pour les colons : « tuée par un pillard »
//! quand un pillard la serrait au tick d'avant, ou qu'elle saignait déjà une
//! bande sur la carte ; « autrement » sinon (la faim, un sanglier sauvage, le
//! feu). Sans cette colonne, « le raid tue le bétail » resterait une
//! déduction, pas une mesure.
//!
//! Le scénario se joue en **deux décors**, et c'est le second qui compte le
//! plus : murée (`run_seeds`) et **à ciel ouvert** (`run_seeds_open`, ajouté le
//! 2026-09-07). Le diagnostic de campagne du §11.8 a montré que l'enceinte du
//! joueur scripté n'est refermée que cinq fois sur trente : dans les
//! vingt-cinq autres colonies il n'y a aucune pièce, donc aucun enclos, et le
//! repli ne peut rien faire de mieux que serrer le troupeau contre ses maîtres.
//! Un banc qui ne mesurerait que le décor muré parlerait d'une situation rare.
//!
//! Les témoins, sur les mêmes 30 graines :
//!
//! | | bêtes tuées par un pillard | colons perdus sur 90 |
//! |---|---|---|
//! | muré, avant le repli (`KILLED_BEFORE`) | 17 / 60 | 12 |
//! | muré, repli seul et malus de trois cases | 7 / 60 | 18 |
//! | **muré, ciblage par rang** | **0 / 60** | 22 |
//! | muré, sans aucun bétail | — | 25 |
//! | ciel ouvert, malus de trois cases (`KILLED_OPEN_BEFORE`) | 5 / 60 | 16 |
//! | **ciel ouvert, ciblage par rang** | **1 / 60** | 17 |
//! | ciel ouvert, sans aucun bétail | — | 24 |
//!
//! Les lignes « sans aucun bétail » sont celles qui donnent son sens à tout le
//! reste : les 12 colons perdus d'avant n'étaient pas une colonie mieux
//! défendue, c'était un troupeau qui mourait à sa place. Dans les deux décors,
//! la colonie qui élève perd toujours **moins** de colons que celle qui
//! n'élève pas — c'est ce que vérifie `colonist_deaths_do_not_rise` — mais
//! elle ne les échange plus contre ses bêtes.

use sim::combat::LIVESTOCK_TARGET_REACH;
use sim::health::{BodyPart, SEVERITY_MAX};
use sim::livestock::{LIVESTOCK_HUDDLE, LIVESTOCK_RANGE};
use sim::map::chebyshev;
use sim::pawn::NEED_MAX;
use sim::testmap::map_from;
use sim::{Faction, Feature, Job, RaidKind, Sim, Species, TICKS_PER_DAY, Terrain};

const DAY: u64 = TICKS_PER_DAY as u64;
/// Prairie carrée : de l'herbe partout, donc de la pâture partout — dehors
/// comme dedans. Une bête qui rentre n'y perd rien, ce qui isole la mesure de
/// la faim.
const SIZE: u32 = 40;
/// Demi-côté de l'enceinte du joueur scripté (`campaign.rs`).
const WALL: u32 = 6;

// ----------------------------------------------------------------------
// Le scénario
// ----------------------------------------------------------------------

fn pasture(seed: u64) -> Sim {
    Sim::from_map(
        seed,
        map_from(&[&".".repeat(SIZE as usize) as &str; SIZE as usize]),
    )
}

fn center() -> (u32, u32) {
    (SIZE / 2, SIZE / 2)
}

/// Mure la colonie : un carré de bois de demi-côté `WALL` autour du centre,
/// une porte au nord. C'est l'enceinte du joueur scripté, au bardage près.
fn enclose(s: &mut Sim) {
    let (cx, cy) = center();
    let (lo_x, hi_x) = (cx - WALL, cx + WALL);
    let (lo_y, hi_y) = (cy - WALL, cy + WALL);
    for d in 0..=2 * WALL {
        s.map_mut().set_feature(lo_x + d, lo_y, Feature::WallWood);
        s.map_mut().set_feature(lo_x + d, hi_y, Feature::WallWood);
        s.map_mut().set_feature(lo_x, lo_y + d, Feature::WallWood);
        s.map_mut().set_feature(hi_x, lo_y + d, Feature::WallWood);
    }
    s.map_mut().set_feature(cx, lo_y, Feature::DoorWood);
    // Les pièces sont un cache dérivé, normalement recalculé au début du tick.
    s.map_mut().refresh_indoor();
}

/// Retourne l'intérieur de l'enceinte en terre battue : une pièce où il n'y a
/// rien à brouter, donc pas un enclos (`livestock::pasture_room`).
fn strip_the_room(s: &mut Sim) {
    let (cx, cy) = center();
    for y in cy - WALL + 1..=cy + WALL - 1 {
        for x in cx - WALL + 1..=cx + WALL - 1 {
            s.map_mut().set_terrain(x, y, Terrain::Dirt);
        }
    }
}

/// Fait passer une bête dans la colonie sans jouer l'apprivoisement : c'est
/// l'état d'arrivée qu'on observe, pas le chemin qui y mène — celui-là est
/// éprouvé par `tests/livestock.rs`.
fn make_livestock(s: &mut Sim, id: u32) {
    let p = s.pawn_mut(id).expect("la bête existe");
    p.faction = Faction::Colony;
    p.hunted = false;
    p.tame_marked = false;
    p.hunger = NEED_MAX;
}

fn tamed_at(s: &mut Sim, x: u32, y: u32, species: Species) -> u32 {
    let id = s.spawn_animal(x, y, species);
    make_livestock(s, id);
    id
}

/// Deux bêtes apprivoisées, posées **hors des murs** à la distance où on les
/// apprivoise vraiment, de part et d'autre de la colonie.
fn two_tamed(s: &mut Sim, species: Species) {
    let (cx, cy) = center();
    tamed_at(s, cx + WALL + 3, cy, species);
    tamed_at(s, cx - WALL - 3, cy, species);
}

/// Remet faim et repos des **colons** au maximum : ces mesures parlent du
/// troupeau, pas de la famine de ses maîtres.
fn feed_colonists(s: &mut Sim) {
    let ids: Vec<u32> = s
        .pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .map(|p| p.id)
        .collect();
    for id in ids {
        if let Some(p) = s.pawn_mut(id) {
            p.hunger = NEED_MAX;
            p.rest = NEED_MAX;
        }
    }
}

/// Avance de `ticks` ticks, colons nourris et reposés.
fn run_fed(s: &mut Sim, ticks: u64) {
    for _ in 0..ticks {
        feed_colonists(s);
        s.step(&[]);
    }
}

fn living_colonists(s: &Sim) -> u32 {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .count() as u32
}

fn living_livestock(s: &Sim) -> u32 {
    s.pawns()
        .iter()
        .filter(|p| p.is_livestock() && p.is_alive())
        .count() as u32
}

fn raider_alive(s: &Sim) -> bool {
    s.pawns()
        .iter()
        .any(|p| p.faction == Faction::Raider && p.is_alive())
}

/// Numéro de pièce de la case d'une bête, 0 si elle est dehors.
fn room_of(s: &Sim, id: u32) -> u8 {
    let p = s.pawns().iter().find(|p| p.id == id).expect("la bête vit");
    let (x, y) = p.tile();
    s.map().room(x, y)
}

/// La pièce de l'enceinte. Elle se lit au centre, pas au barycentre des
/// colons : ceux-ci franchissent la porte au gré de leurs journées, l'enclos
/// lui ne bouge pas (`livestock::colony_shelter`).
fn enclosure_room(s: &Sim) -> u8 {
    let (cx, cy) = center();
    s.map().room(cx, cy)
}

fn hunger_of(s: &Sim, id: u32) -> u32 {
    s.pawns()
        .iter()
        .find(|p| p.id == id)
        .map(|p| p.hunger)
        .unwrap_or_default()
}

// ----------------------------------------------------------------------
// Le harnais : à quoi meurt une bête
// ----------------------------------------------------------------------

/// Dernier état connu d'une bête vivante, relevé à chaque tick. Assez pour
/// attribuer une cause à sa mort au tick suivant, pas plus.
struct Watched {
    id: u32,
    /// Un pillard était à portée de bras (deux cases : le pas qu'il vient de
    /// faire compte).
    raider_close: bool,
    /// Elle saignait déjà, une bande sur la carte.
    hurt_under_raid: bool,
}

fn observe(s: &Sim, out: &mut Vec<Watched>) {
    out.clear();
    let raid = raider_alive(s);
    let raiders: Vec<(u32, u32)> = s
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Raider && p.is_alive())
        .map(|p| p.tile())
        .collect();
    for p in s.pawns() {
        if !p.is_livestock() || !p.is_alive() {
            continue;
        }
        let me = p.tile();
        out.push(Watched {
            id: p.id,
            raider_close: raiders.iter().any(|&r| chebyshev(me, r) <= 2),
            hurt_under_raid: raid && !p.injuries.is_empty(),
        });
    }
}

#[derive(Default, Clone, Copy)]
struct Tally {
    /// Bêtes mortes un pillard sur le dos.
    killed_by_raiders: u32,
    /// Bêtes mortes autrement : la faim, un sanglier sauvage, le feu.
    died_otherwise: u32,
    livestock_left: u32,
    colonists_lost: u32,
    /// Bêtes à l'abri (`map::indoor`) à l'instant où la bande entre.
    indoors_at_raid: u32,
}

impl Tally {
    fn add(&mut self, o: &Tally) {
        self.killed_by_raiders += o.killed_by_raiders;
        self.died_otherwise += o.died_otherwise;
        self.livestock_left += o.livestock_left;
        self.colonists_lost += o.colonists_lost;
        self.indoors_at_raid += o.indoors_at_raid;
    }
}

/// Une graine du scénario : un jour de calme pour que le troupeau prenne sa
/// place, la bande, puis deux jours pour que tout se décante. `species` à
/// `None` donne le **témoin sans bétail**, qui dit ce que la colonie perd
/// quand elle n'a rien à faire tuer à sa place.
///
/// `enclosed` à faux donne le scénario **à ciel ouvert** : pas un mur, donc
/// pas de pièce, donc aucun enclos où rentrer. C'est la configuration de
/// vingt-cinq colonies de campagne sur trente (voir
/// `CAMPAIGN-FINDINGS.md` §11.8) et celle où le repli ne peut rien faire de
/// mieux que serrer le troupeau contre ses maîtres.
fn run_seed_in(seed: u64, species: Option<Species>, enclosed: bool) -> Tally {
    let mut s = pasture(seed);
    if enclosed {
        enclose(&mut s);
    }
    if let Some(species) = species {
        two_tamed(&mut s, species);
    }
    let mut tally = Tally::default();
    let colonists_start = living_colonists(&s);
    let mut watched: Vec<Watched> = Vec::new();

    for tick in 0..3 * DAY {
        feed_colonists(&mut s);
        observe(&s, &mut watched);
        if tick == DAY {
            tally.indoors_at_raid = s
                .pawns()
                .iter()
                .filter(|p| p.is_livestock() && p.is_alive())
                .filter(|p| {
                    let (x, y) = p.tile();
                    s.map().is_indoor(x, y)
                })
                .count() as u32;
            s.trigger_raid_of(RaidKind::Rush);
        }
        s.step(&[]);
        // Ce qui a disparu depuis le relevé : mort, et pour quelle raison.
        for w in &watched {
            if s.pawns().iter().any(|p| p.id == w.id && p.is_alive()) {
                continue;
            }
            if w.raider_close || w.hurt_under_raid {
                tally.killed_by_raiders += 1;
            } else {
                tally.died_otherwise += 1;
            }
        }
    }
    tally.livestock_left = living_livestock(&s);
    tally.colonists_lost = colonists_start - living_colonists(&s);
    tally
}

fn run_seed(seed: u64, species: Option<Species>) -> Tally {
    run_seed_in(seed, species, true)
}

fn run_seeds(species: Option<Species>) -> Tally {
    let mut total = Tally::default();
    for seed in 1..=30u64 {
        total.add(&run_seed(seed, species));
    }
    total
}

/// Les mêmes trente graines, mais à ciel ouvert.
fn run_seeds_open(species: Option<Species>) -> Tally {
    let mut total = Tally::default();
    for seed in 1..=30u64 {
        total.add(&run_seed_in(seed, species, false));
    }
    total
}

// ----------------------------------------------------------------------
// Le mécanisme, une règle à la fois
// ----------------------------------------------------------------------

/// Le repli, isolé de l'errance bornée : la pièce est en terre battue, donc
/// ce n'est **pas** un enclos (rien à y brouter) et la bête reste dehors tant
/// que rien ne menace. Un pillard entre à l'autre bout de la carte, assez loin
/// pour ne pas décider de l'issue : la bête doit franchir la porte et se
/// mettre à couvert.
#[test]
fn livestock_retreats_indoors_during_a_raid() {
    let (cx, cy) = center();
    for seed in 1..=5u64 {
        let mut s = pasture(seed);
        enclose(&mut s);
        strip_the_room(&mut s);
        let rabbit = tamed_at(&mut s, cx + WALL + 3, cy, Species::Rabbit);
        let room = enclosure_room(&s);
        assert_ne!(room, 0, "graine {seed} : l'enceinte n'est pas une pièce");
        // Le repli commence avec une bête dehors. L'errance au calme peut
        // traverser une pièce nue ; elle n'est pas censée l'éviter absolument.
        assert_eq!(room_of(&s, rabbit), 0);

        // Un pillard au coin le plus éloigné : la menace existe, mais elle
        // n'arrivera pas avant que la bête ait eu le temps de rentrer.
        s.spawn_pawn(1, 1, Faction::Raider);
        let mut sheltered = false;
        for _ in 0..DAY / 4 {
            feed_colonists(&mut s);
            s.step(&[]);
            if !raider_alive(&s) {
                break;
            }
            if room_of(&s, rabbit) == room {
                sheltered = true;
                break;
            }
        }
        assert!(
            sheltered,
            "graine {seed} : la bête n'a pas rejoint la pièce pendant le raid"
        );
    }
}

/// Sans pièce du tout, le repli se rabat sur les colons eux-mêmes : la bête
/// se serre à `LIVESTOCK_HUDDLE` cases du barycentre, sous leur garde.
#[test]
fn livestock_huddles_when_there_is_no_room() {
    let (cx, cy) = center();
    for seed in 1..=5u64 {
        let mut s = pasture(seed);
        let rabbit = tamed_at(&mut s, cx + LIVESTOCK_RANGE - 1, cy, Species::Rabbit);
        s.spawn_pawn(1, 1, Faction::Raider);
        // Observer pendant la menace : une fois les pillards partis, la
        // bête doit pouvoir reprendre sa pâture et quitter le rayon de repli.
        let mut huddled = false;
        for _ in 0..DAY / 4 {
            feed_colonists(&mut s);
            s.step(&[]);
            if !raider_alive(&s) {
                break;
            }
            let home = s.colony_center().expect("colonie vivante");
            let me = s
                .pawns()
                .iter()
                .find(|p| p.id == rabbit)
                .expect("la bête vit")
                .tile();
            if chebyshev(home, me) <= LIVESTOCK_HUDDLE {
                huddled = true;
                break;
            }
        }
        assert!(
            huddled,
            "graine {seed} : la bête ne s'est pas rapprochée pendant le raid"
        );
    }
}

/// L'errance bornée, hors de tout raid : la pièce porte de l'herbe, donc le
/// troupeau y vit et n'en sort plus. C'est la règle qui met les bêtes à
/// l'abri **avant** que la bande n'arrive.
#[test]
fn livestock_grazes_inside_when_the_room_has_grass() {
    let (cx, cy) = center();
    for seed in 1..=5u64 {
        let mut s = pasture(seed);
        enclose(&mut s);
        let rabbit = tamed_at(&mut s, cx + WALL + 3, cy, Species::Rabbit);
        let room = enclosure_room(&s);
        run_fed(&mut s, DAY);
        assert_eq!(
            room_of(&s, rabbit),
            room,
            "graine {seed} : la bête n'est pas rentrée dans l'enclos"
        );
        // Et elle y reste : un jour de plus sans jamais franchir la porte.
        for _ in 0..DAY {
            feed_colonists(&mut s);
            s.step(&[]);
            assert!(
                !raider_alive(&s),
                "graine {seed} : un raid brouille la mesure de l'errance"
            );
            assert_eq!(
                room_of(&s, rabbit),
                room,
                "graine {seed} : la bête est sortie de l'enclos"
            );
        }
        assert!(
            hunger_of(&s, rabbit) > 0,
            "graine {seed} : la bête a maigri dans son enclos"
        );
    }
}

/// Le garde-fou de l'errance bornée : une pièce sans un brin d'herbe ni un
/// grain de fourrage n'est **pas** un enclos. Une bête qui s'y trouve en
/// ressort brouter — une bête n'a pas à mourir de faim enfermée.
#[test]
fn livestock_leaves_a_barren_room_to_graze() {
    let (cx, cy) = center();
    let mut out = 0;
    for seed in 1..=5u64 {
        let mut s = pasture(seed);
        enclose(&mut s);
        strip_the_room(&mut s);
        let rabbit = tamed_at(&mut s, cx + 2, cy + 2, Species::Rabbit);
        assert_ne!(room_of(&s, rabbit), 0, "la bête démarre dans la pièce");
        let mut left = false;
        for _ in 0..3 * DAY {
            feed_colonists(&mut s);
            s.step(&[]);
            if room_of(&s, rabbit) == 0 {
                left = true;
                break;
            }
        }
        out += u32::from(left);
        assert!(
            hunger_of(&s, rabbit) > 0,
            "graine {seed} : la bête est morte de faim dans sa pièce nue"
        );
    }
    assert!(
        out >= 4,
        "seules {out} bêtes sur 5 sont sorties d'une pièce nue : une pièce \
         sans herbe est devenue une prison"
    );
}

/// Le sanglier apprivoisé, lui, ne rentre pas : il charge. La défense passe
/// **avant** le repli dans `livestock_ai`, et c'est ce qui fait d'une bête
/// agressive autre chose qu'un lapin.
#[test]
fn boars_still_defend() {
    let (cx, cy) = center();
    for seed in 1..=5u64 {
        let mut s = pasture(seed);
        enclose(&mut s);
        let boar = tamed_at(&mut s, cx + WALL + 3, cy, Species::Boar);
        // Un pillard juste à côté de la bête, dans son rayon de défense.
        s.spawn_pawn(cx + WALL + 5, cy, Faction::Raider);
        let mut charged = false;
        for _ in 0..DAY / 8 {
            feed_colonists(&mut s);
            s.step(&[]);
            if s.pawns()
                .iter()
                .any(|p| p.id == boar && matches!(p.job, Job::Attack { .. }))
            {
                charged = true;
                break;
            }
        }
        assert!(
            charged,
            "graine {seed} : le sanglier apprivoisé s'est réfugié au lieu de \
             défendre le troupeau"
        );
    }
}

/// Le ciblage par rang, dans ses trois cas. Un pillard vient pour la colonie :
///
/// 1. une bête douze cases plus près que le premier colon **ne le détourne
///    pas** — c'est le cas que la pénalité de trois cases ne savait pas
///    traiter (`combat::LIVESTOCK_TARGET_REACH`) ;
/// 2. une bête **au contact** reste une cible, sinon celle qui bouche une
///    porte serait intouchable ;
/// 3. plus un colon debout, et le troupeau y passe : la règle est un ordre de
///    préférence, pas une immunité.
#[test]
fn a_raider_walks_past_the_herd_to_reach_a_colonist() {
    let (cx, cy) = center();
    for seed in 1..=5u64 {
        // 1. La bête entre le pillard et la colonie, bien plus près de lui.
        let mut s = pasture(seed);
        let rabbit = tamed_at(&mut s, cx + LIVESTOCK_RANGE, cy, Species::Rabbit);
        let raider = s.spawn_pawn(cx + LIVESTOCK_RANGE + 6, cy, Faction::Raider);
        feed_colonists(&mut s);
        s.step(&[]);
        assert_eq!(
            target_of(&s, raider),
            None,
            "graine {seed} : le pillard s'est détourné sur la bête"
        );
        assert!(
            matches!(target_of_any(&s, raider), Some(id) if is_colonist(&s, id)),
            "graine {seed} : le pillard n'a pris aucun colon pour cible"
        );
        // Et la bête vit encore une demi-journée plus tard.
        run_fed(&mut s, DAY / 2);
        assert!(
            s.pawns().iter().any(|p| p.id == rabbit && p.is_alive()),
            "graine {seed} : la bête est morte alors que le pillard visait un colon"
        );

        // 2. Au contact, elle est une cible comme une autre.
        let mut s = pasture(seed);
        let rabbit = tamed_at(&mut s, cx + LIVESTOCK_RANGE, cy, Species::Rabbit);
        let raider = s.spawn_pawn(cx + LIVESTOCK_RANGE + 1, cy, Faction::Raider);
        feed_colonists(&mut s);
        s.step(&[]);
        assert_eq!(
            target_of(&s, raider),
            Some(rabbit),
            "graine {seed} : une bête au contact devrait être visée"
        );

        // 3. Plus un colon du tout : le troupeau devient la cible. La règle
        //    est un ordre de préférence, pas une immunité.
        let mut s = pasture(seed);
        let rabbit = tamed_at(&mut s, cx + LIVESTOCK_RANGE, cy, Species::Rabbit);
        let raider = s.spawn_pawn(cx + LIVESTOCK_RANGE + 6, cy, Faction::Raider);
        let ids: Vec<u32> = s
            .pawns()
            .iter()
            .filter(|p| p.is_colonist())
            .map(|p| p.id)
            .collect();
        for id in ids {
            if let Some(p) = s.pawn_mut(id) {
                p.add_injury(BodyPart::Head, SEVERITY_MAX, 0);
            }
        }
        // Deux ticks : les colons meurent au bout du premier (`remove_dead`),
        // le pillard se choisit une nouvelle cible au second.
        s.step(&[]);
        s.step(&[]);
        assert_eq!(living_colonists(&s), 0, "graine {seed} : colonie éteinte");
        assert_eq!(
            target_of(&s, raider),
            Some(rabbit),
            "graine {seed} : sans colon, le pillard devrait viser la bête"
        );
    }
}

/// La cible d'un pawn, si c'est bien celle du bétail attendu.
fn target_of(s: &Sim, raider: u32) -> Option<u32> {
    match target_of_any(s, raider) {
        Some(id) if !is_colonist(s, id) => Some(id),
        _ => None,
    }
}

fn target_of_any(s: &Sim, raider: u32) -> Option<u32> {
    s.pawns().iter().find(|p| p.id == raider).and_then(|p| {
        if let Job::Attack { target } = p.job {
            Some(target)
        } else {
            None
        }
    })
}

fn is_colonist(s: &Sim, id: u32) -> bool {
    s.pawns()
        .iter()
        .any(|p| p.id == id && p.is_colonist() && p.species.is_none())
}

/// `LIVESTOCK_TARGET_REACH` est bien le contact, et rien de plus : une case de
/// plus et un pillard se détournerait déjà sur ce qui passe à côté de lui.
#[test]
fn livestock_is_only_a_target_at_arms_length() {
    assert_eq!(LIVESTOCK_TARGET_REACH, 1);
}

// ----------------------------------------------------------------------
// La mesure
// ----------------------------------------------------------------------

/// Bêtes tuées par un pillard sur les 30 graines du scénario, **avant** le
/// repli du 2026-09-06 : 17 sur 60 (`crates/sim-cli/CAMPAIGN-FINDINGS.md`
/// §11.3). Le témoin n'est pas rejouable — la règle n'a pas de commutateur et
/// n'en aura pas, ce serait de l'état non sérialisé dans `Sim` — donc c'est le
/// chiffre qui est gravé ici, avec le harnais qui l'a produit juste au-dessus.
const KILLED_BEFORE: u32 = 17;

/// Colons perdus sur les mêmes 30 graines, **avant** : 12 sur 90. Gardé pour
/// mémoire, et parce qu'il est *en dessous* du témoin sans bétail (25) : c'est
/// la mesure de ce que le troupeau encaissait à la place des colons.
const COLONISTS_LOST_BEFORE: u32 = 12;

#[test]
fn raids_kill_fewer_livestock_after_the_change() {
    let t = run_seeds(Some(Species::Rabbit));
    // Le troupeau est à l'abri avant que la bande n'entre : c'est l'errance
    // bornée qui travaille, et c'est elle qu'on vérifie d'abord.
    assert!(
        t.indoors_at_raid >= 55,
        "seulement {} bêtes sur 60 étaient à l'abri à l'arrivée de la bande",
        t.indoors_at_raid
    );
    assert!(
        t.killed_by_raiders * 2 <= KILLED_BEFORE,
        "{} bêtes tuées par un pillard sur 60, contre {KILLED_BEFORE} avant le \
         repli : la moitié n'est pas gagnée (mortes autrement : {}, vivantes : \
         {} sur 60)",
        t.killed_by_raiders,
        t.died_otherwise,
        t.livestock_left
    );
    // Et depuis le ciblage par rang (2026-09-07), plus une seule : la borne
    // de moitié ci-dessus est de l'histoire, celle-ci est le garde-fou.
    assert!(
        t.killed_by_raiders <= 1,
        "{} bêtes tuées par un pillard dans l'enceinte : le ciblage par rang \
         devrait les épargner toutes (mesuré : 0 sur 60)",
        t.killed_by_raiders
    );
    // Et le troupeau ne meurt pas d'autre chose pour autant : rentrer ne doit
    // pas être affamer.
    assert!(
        t.died_otherwise <= 3,
        "{} bêtes mortes hors combat : le repli les enferme loin de l'herbe",
        t.died_otherwise
    );
}

/// L'autre moitié du réglage, et la plus facile à se cacher : le troupeau ne
/// doit pas rentrer **aux frais des colons**.
///
/// La comparaison honnête n'est pas « avant / après » mais « avec troupeau /
/// sans troupeau » : avant le repli, la colonie perdait moins de colons
/// (`COLONISTS_LOST_BEFORE`) uniquement parce que ses bêtes mouraient devant
/// eux. Le critère tenu est donc celui-ci : avoir un troupeau reste un
/// avantage — les colons meurent **moins** qu'une colonie qui n'en a pas —
/// sans que ce soit un échange de vies.
#[test]
fn colonist_deaths_do_not_rise() {
    let none = run_seeds(None);
    let herd = run_seeds(Some(Species::Rabbit));
    assert!(
        herd.colonists_lost <= none.colonists_lost,
        "{} colons perdus avec un troupeau contre {} sans : le bétail replié \
         coûte des colons (avant le repli : {COLONISTS_LOST_BEFORE})",
        herd.colonists_lost,
        none.colonists_lost
    );
    // Le troupeau de sangliers, qui se bat, ne doit pas faire pire non plus.
    let boars = run_seeds(Some(Species::Boar));
    assert!(
        boars.colonists_lost <= none.colonists_lost,
        "{} colons perdus avec des sangliers contre {} sans troupeau",
        boars.colonists_lost,
        none.colonists_lost
    );
}

/// Le scénario **à ciel ouvert** : pas un mur, donc pas de pièce, donc aucun
/// enclos où rentrer. C'est la configuration de vingt-cinq colonies de
/// campagne sur trente (`CAMPAIGN-FINDINGS.md` §11.8, où l'enceinte du joueur
/// scripté n'est refermée que cinq fois sur trente) : le repli n'y peut rien
/// faire de mieux que serrer le troupeau contre ses maîtres, et c'est là que le
/// malus de trois cases lâchait — le troupeau paît à `LIVESTOCK_RANGE` du
/// barycentre, la bande entre par un bord de carte, et la bête est la première
/// chose qu'un pillard croise.
///
/// Bêtes tuées par un pillard sur 60, les mêmes 30 graines :
///
/// | ciblage | tuées | vivantes | colons perdus sur 90 |
/// |---|---|---|---|
/// | malus de trois cases (`KILLED_OPEN_BEFORE`) | 5 | 55 | 16 |
/// | **par rang** | **1** | **59** | 17 |
/// | sans aucun bétail | — | — | 24 |
const KILLED_OPEN_BEFORE: u32 = 5;

#[test]
fn raiders_no_longer_pick_off_a_herd_in_the_open() {
    let herd = run_seeds_open(Some(Species::Rabbit));
    assert!(
        herd.killed_by_raiders * 2 <= KILLED_OPEN_BEFORE,
        "{} bêtes tuées par un pillard à ciel ouvert sur 60, contre \
         {KILLED_OPEN_BEFORE} avec le malus de trois cases (vivantes : {} sur \
         60, mortes autrement : {})",
        herd.killed_by_raiders,
        herd.livestock_left,
        herd.died_otherwise
    );
    // Aucune bête n'est à l'abri : il n'y a pas de pièce. Ce n'est donc pas le
    // repli qui sauve le troupeau ici, c'est bien le choix de cible.
    assert_eq!(
        herd.indoors_at_raid, 0,
        "le scénario à ciel ouvert ne devrait porter aucune pièce"
    );
    // Et pas aux frais des colons : le témoin sans troupeau reste au-dessus.
    let none = run_seeds_open(None);
    assert!(
        herd.colonists_lost <= none.colonists_lost,
        "{} colons perdus avec un troupeau à ciel ouvert contre {} sans",
        herd.colonists_lost,
        none.colonists_lost
    );
}
