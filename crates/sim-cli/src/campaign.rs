//! Sous-commande `campaign` : mesurer la **partie longue**.
//!
//! Le fuzz (`fuzzgen`) bombarde le sim de commandes aberrantes et cherche des
//! paniques. Le bench mesure des ticks/s. Ni l'un ni l'autre ne dit ce que vit
//! une colonie **dirigée** : ce module joue trente jours par graine avec un
//! joueur scripté, puis résume ce qu'il en reste.
//!
//! Deux moitiés, à ne pas confondre :
//!
//! 1. `plan` — le **joueur scripté**. Une fonction **pure** de l'état vers une
//!    liste de commandes, appelée toutes les `PLAN_INTERVAL` ticks. Aucune
//!    mémoire : tout ce qu'il faut savoir (« ai-je déjà bâti le feu de camp ? »)
//!    se relit dans la `Sim`. C'est ce qui la rend testable et déterministe.
//! 2. `play_seed` — le **harnais de mesure**. Il joue une graine, observe les
//!    colons à chaque tick (pour attribuer une cause à chaque mort) et vide le
//!    journal d'événements régulièrement (il est borné à 32 entrées).
//!
//! Cette tranche **mesure**, elle ne règle rien : aucune constante du sim n'est
//! touchée ici, et les constatations vont dans `CAMPAIGN-FINDINGS.md`.

// `clippy.toml` interdit `Instant` pour `crates/sim` (aucune horloge dans le
// sim). Ce crate n'est pas le sim : il mesure du temps réel, c'est son rôle.
#![allow(clippy::disallowed_types)]

use std::time::Instant;

use sim::climate::{Climate, HYPOTHERMIA_TEMP, Season, YEAR_DAYS};
use sim::craft::METAL_PER_SWORD;
use sim::factions;
use sim::health::BLOOD_MAX;
use sim::map::chebyshev;
use sim::pawn::{NEED_MAX, STARVING};
use sim::{
    BuildKind, Command, Designation, Difficulty, EventKind, Faction, Feature, ItemKind, Material,
    Sim, Species, TICKS_PER_DAY, Tech, WorkType, Zone, build, path,
};

use crate::cli::{CliError, Options, wants_help};
use crate::commands::{check_size, ticks_per_sec};

// ----------------------------------------------------------------------
// Le joueur scripté
// ----------------------------------------------------------------------

/// Cadence de décision du joueur : dix secondes de jeu. Un joueur attentif ne
/// regarde pas son écran soixante fois par seconde.
pub const PLAN_INTERVAL: u64 = 600;

/// Demi-côté du carré de coupe : une désignation de 21 cases de côté autour du
/// repère, soit tout le bois d'un rayon raisonnable.
const CHOP_RADIUS: i32 = 10;
/// Demi-côté du carré de récolte des buissons.
const HARVEST_RADIUS: i32 = 25;
/// Les buissons repoussent : on repasse une désignation de récolte un passage
/// sur dix (une fois par heure de jeu), pas à chaque passage — le rectangle
/// couvre 2 601 cases.
const HARVEST_EVERY: u64 = 10;
/// Côté de la zone de stockage.
const STOCKPILE_SIDE: i32 = 4;
/// Côté de l'entrepôt **une fois la métallurgie acquise**. Une case d'entrepôt
/// ne tient qu'**un seul genre** (`Sim::dest_accepts`) : à seize cases, un
/// entrepôt qui porte déjà bois, pierre, baies, légumes, repas, viande, cuir,
/// dépouilles, cadavres, arcs et tuniques n'a plus de place pour le minerai.
/// Les piles restent alors au pied des rochers, où **rien ne fusionne** —
/// `Sim::spawn_item` ne fusionne que sur la même case — et un rocher qui rend
/// deux minerais est perdu, puisque `craft::ORE_PER_INGOT` en exige trois
/// **dans une seule pile**. Mesuré sur la campagne normale, colonies qui
/// fondent au moins un lingot : **4 sur 14** à seize cases, **7 sur 12** à
/// trente-six. C'est le seul endroit où ce joueur agrandit son entrepôt, et il
/// ne le fait que quand un genre nouveau arrive (biais n°4 du §8).
const STOCKPILE_SIDE_METAL: i32 = 6;
/// Côté de la zone de culture.
const GROWING_SIDE: i32 = 5;
/// Demi-côté de l'enceinte : 13 cases de côté, angles compris.
const WALL_RADIUS: i32 = 6;
/// Pièges posés devant la porte.
const TRAPS: u32 = 3;

/// Bois qu'il faut en stock avant de bâtir le confort de base (feu de camp,
/// lits, poste de fabrication).
const WOOD_FOR_BASE: u32 = 40;
/// Bois qu'il faut avant de lancer l'enceinte : les 40 du confort de base plus
/// 60. L'enceinte en demande bien plus (48 cases à 5 bois) : elle se remplit au
/// fil des coupes, et c'est précisément ce qu'on veut mesurer.
const WOOD_FOR_WALLS: u32 = 100;
/// Bois qu'on ne troque ni n'offre jamais.
const WOOD_RESERVE: u32 = 40;
/// Cuir gardé pour une tunique.
const LEATHER_RESERVE: u32 = 6;
/// Jour où l'on pose l'établi de recherche.
const RESEARCH_DAY: u64 = 5;
/// Demi-côté du **premier** carré où l'on cherche des rochers à miner : un
/// joueur commence par regarder autour de lui. Le rayon double tant que rien
/// n'apparaît, jusqu'à couvrir la carte (voir `designate_rocks`) — sans quoi
/// quatorze graines sur quinze n'ont pas un rocher à portée et la chaîne du
/// métal ne démarre jamais (`CAMPAIGN-FINDINGS.md` §10.2).
const MINE_RADIUS: i32 = 12;
/// Rochers marqués d'un coup. Chaque case marquée est une commande, et un
/// joueur ne désigne pas une montagne entière : deux rochers ordinaires
/// suffisent à bâtir la forge (15 pierres chacun).
const ROCKS_PER_PASS: usize = 4;
/// Pierre qu'il faut en stock avant de bâtir la forge (20, plus la marge du
/// transport en cours).
const STONE_FOR_FORGE: u32 = 25;
/// Baies qu'il faut en stock pour se permettre d'apprivoiser. C'est la seule
/// condition : une tentative coûte `livestock::TAME_FOOD` unités, et c'est le
/// fourrage qui commande, pas le calendrier.
const TAME_BERRIES: u32 = 30;
/// Distance au repère au-delà de laquelle on ne marque plus une bête à
/// apprivoiser. **Mesuré, et le résultat est contre-intuitif** : borner la
/// traque à 16 ou 24 cases ne protège pas l'éleveur, elle le fait tourner en
/// rond. Une bête paît, donc elle dérive ; passée la borne, le joueur lève sa
/// marque et en pose une autre, qui dérive à son tour. Campagne normale,
/// 30 graines : borne 16 → **169 marquages pour 35 bêtes prises**, borne 24 →
/// 128 pour 39, **sans borne → 75 pour 52**. Le joueur voit la carte entière
/// et ne change de bête que quand celle-ci ne peut plus rien donner.
const TAME_RANGE: u32 = u32::MAX;
/// Jours au bout desquels on change de bête si la marque n'a rien donné. Le
/// sim, lui, retente tout seul sur la même bête toutes les
/// `livestock::TAME_RETRY` (trois heures de jeu) : ce délai-ci est celui du
/// joueur qui se lasse d'un cerf qui fuit et va en marquer un autre.
const TAME_RETRY_DAYS: u64 = 2;
/// Viande et repas visés par colon : en dessous, on marque du gibier.
const MEAT_PER_COLONIST: u32 = 10;
/// Jours de vivres en dessous desquels on achète au marchand.
const TRADE_FOOD_DAYS: u32 = 3;
/// Quantité maximale achetée d'un coup.
const TRADE_MAX_UNITS: u32 = 20;
/// Réputation en dessous de laquelle on offre un tribut.
const GIFT_GOODWILL: i32 = -40;
/// Bois offert en tribut.
const GIFT_WOOD: u32 = 40;

/// Repère de la colonie : la case franchissable la plus proche du centre de la
/// carte, c'est-à-dire là où les colons sont nés
/// (`Sim::spawn_starting_pawns`). **Fixe** pour toute la partie : un repère
/// qui suivrait le barycentre des colons ferait danser les zones et les murs
/// d'un passage à l'autre.
fn anchor(sim: &Sim) -> Option<(i32, i32)> {
    let (cx, cy) = (sim.map().width() / 2, sim.map().height() / 2);
    sim.map()
        .nearest_passable(cx, cy)
        .map(|(x, y)| (x as i32, y as i32))
}

/// Colons vivants, dans l'ordre des ids.
fn colonist_ids(sim: &Sim) -> Vec<u32> {
    sim.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .map(|p| p.id)
        .collect()
}

/// Jours de vivres en stock, en dixièmes : un colon consomme `NEED_MAX` de
/// nutrition par jour (`pawn::HUNGER_DECAY × TICKS_PER_DAY`). 0 sans colon.
fn food_days_tenths(stored: &[u32; ItemKind::COUNT], colonists: u32) -> u32 {
    if colonists == 0 {
        return 0;
    }
    let mut nutrition: u64 = 0;
    for (k, &count) in stored.iter().enumerate() {
        if let Some(n) = ItemKind::from_u8(k as u8).nutrition() {
            nutrition += u64::from(n) * u64::from(count);
        }
    }
    (nutrition * 10 / (u64::from(NEED_MAX) * u64::from(colonists))) as u32
}

/// Fait en sorte que `count` exemplaires de `kind` soient **planifiés ou déjà
/// bâtis** parmi `tiles`, en prenant les premières cases de la liste. Une case
/// qui porte déjà un plan compte comme faite : sans ça, le passage suivant
/// planifierait la case de secours, et la colonie se retrouverait avec deux
/// feux de camp pour un demandé. Une case occupée par autre chose est
/// simplement sautée.
///
/// C'est ce qui rend `plan` idempotent sans mémoire : une fois la chose bâtie,
/// plus rien n'est émis.
///
/// **La pile au sol compte comme un occupant** (corrigé le 2026-09-06).
/// `build::can_place` ne regarde que le terrain et l'élément, mais
/// `Command::Build` refuse en plus, et **en silence**, une case qui porte une
/// pile (`crates/sim/src/lib.rs`). Sans ce test, le joueur reproposait
/// indéfiniment la même case occupée et le plan n'apparaissait jamais : c'est
/// ce qui a empêché toutes les forges de sortir de terre (§10.2), leurs trois
/// cases candidates étant **dans** l'entrepôt. Le sauter ici fait passer à la
/// case suivante de la liste, ce qui est exactement ce qu'un joueur ferait.
fn build_free(
    sim: &Sim,
    cmds: &mut Vec<Command>,
    kind: BuildKind,
    tiles: &[(i32, i32)],
    count: u32,
) {
    let mut left = count;
    for &(x, y) in tiles {
        if left == 0 {
            return;
        }
        if !sim.map().in_bounds(x, y) {
            continue;
        }
        let (ux, uy) = (x as u32, y as u32);
        if sim.blueprints().iter().any(|b| (b.x, b.y) == (ux, uy)) {
            left -= 1;
            continue;
        }
        if !build::can_place(sim.map(), kind, ux, uy) || has_pile(sim, ux, uy) {
            continue;
        }
        cmds.push(Command::Build {
            kind,
            material: Material::Wood,
            x0: x,
            y0: y,
            x1: x,
            y1: y,
        });
        left -= 1;
    }
}

/// Une pile au sol sur cette case ? C'est le seul refus de `Command::Build`
/// qu'aucune fonction publique du sim ne sait dire.
fn has_pile(sim: &Sim, x: u32, y: u32) -> bool {
    sim.items().iter().any(|s| (s.x, s.y) == (x, y))
}

/// Un colon peut-il rejoindre cette case ? La question passe par l'index de
/// régions de la carte (`map::same_region_for`, marcheur `COLONIST` : il
/// contourne ses propres pièges), qui répond en O(1) et **exactement** comme
/// l'A\* — voir `CAMPAIGN-FINDINGS.md` §3. Index périmé (la carte vient de
/// changer dans le tick) : on retombe sur l'A\*, comme le sim lui-même.
fn colonist_can_reach(sim: &Sim, from: (u32, u32), to: (u32, u32)) -> bool {
    if from == to {
        return true;
    }
    match sim.map().same_region_for(from, to, path::Walker::COLONIST) {
        Some(same) => same,
        None => path::find_path_for(sim.map(), from, to, path::Walker::COLONIST).is_some(),
    }
}

/// Marque au minage les rochers de l'espèce `wanted` (veinés ou ordinaires)
/// les plus proches du repère. Les candidats sont triés par `(distance, x, y)`,
/// jamais « le premier trouvé », et une case déjà désignée n'est pas remarquée :
/// `plan` reste idempotent sans mémoire.
///
/// Trois garde-fous, et ce sont eux qui comptent (le premier constat du rapport
/// de campagne, celui du gibier inatteignable, se rejouait ici mot pour mot) :
///
/// 1. **la file est bornée à `max`** : tant qu'il reste des rochers marqués
///    de cette espèce, on n'en marque pas d'autres. Sans cela, un joueur qui
///    repasse toutes les `PLAN_INTERVAL` marquait quatre rochers de plus par
///    passage, indéfiniment ;
/// 2. **on ne marque que ce qu'un colon peut atteindre** : un rocher au cœur
///    d'une montagne ou de l'autre côté d'un lac ne sera jamais miné, et chaque
///    colon désœuvré recalculerait son chemin vers lui à chaque tick. La
///    question passe par l'index de régions, pas par un A\* ;
/// 3. **le rayon s'élargit, il ne s'invente pas.** On part de `MINE_RADIUS` et
///    on double tant qu'on n'a rien vu, jusqu'à couvrir la carte. C'est le
///    second blocage du §10.2 : à rayon fixe, quatorze des quinze graines qui
///    payaient la métallurgie n'avaient **aucun** rocher à portée, donc ni
///    pierre pour la forge ni minerai pour le lingot. Le balayage ne coûte que
///    lorsqu'il ne trouve rien, et il s'arrête au premier rayon qui donne.
///
/// Mesuré : sans les deux premiers, la campagne de six graines × 30 jours
/// passait de 63 s à 246 s, une graine à elle seule prenant 213 s.
fn designate_rocks(
    sim: &Sim,
    cmds: &mut Vec<Command>,
    at: (i32, i32),
    wanted: Feature,
    max: usize,
) {
    let from = (at.0.max(0) as u32, at.1.max(0) as u32);
    let full = sim.map().width().max(sim.map().height()) as i32;
    let mut radius = MINE_RADIUS;
    // On s'arrête au premier rayon qui donne de quoi travailler — un rocher
    // libre ou une marque déjà posée. Sinon on regarde plus loin, jusqu'à la
    // carte entière ; au-delà, il n'y a rien à trouver.
    let (mut found, mut pending) = scan_rocks(sim, at, wanted, radius, from);
    while found.is_empty() && pending == 0 && radius < full {
        radius = radius.saturating_mul(2);
        let next = scan_rocks(sim, at, wanted, radius, from);
        found = next.0;
        pending = next.1;
    }
    if pending >= max {
        return;
    }
    found.sort_unstable();
    let mut left = max - pending;
    for &(_, x, y) in found.iter().take(MINE_CANDIDATES) {
        if left == 0 {
            return;
        }
        if !minable(sim, from, (x, y)) {
            continue;
        }
        cmds.push(Command::Designate {
            kind: Designation::Mine,
            x0: x as i32,
            y0: y as i32,
            x1: x as i32,
            y1: y as i32,
        });
        left -= 1;
    }
}

/// Rochers de l'espèce voulue dans le carré de demi-côté `radius` autour de
/// `at` : ceux qui sont libres, triables par `(distance, x, y)`, et le nombre
/// de ceux déjà marqués. Aucune décision ici, seulement un relevé.
fn scan_rocks(
    sim: &Sim,
    at: (i32, i32),
    wanted: Feature,
    radius: i32,
    from: (u32, u32),
) -> (Vec<(u32, u32, u32)>, usize) {
    let mut found: Vec<(u32, u32, u32)> = Vec::new();
    let mut pending = 0usize;
    for y in at.1 - radius..=at.1 + radius {
        for x in at.0 - radius..=at.0 + radius {
            if !sim.map().in_bounds(x, y) {
                continue;
            }
            let (ux, uy) = (x as u32, y as u32);
            if sim.map().feature(ux, uy) != wanted {
                continue;
            }
            match sim.map().designation(ux, uy) {
                Designation::Mine => pending += 1,
                Designation::None => found.push((chebyshev((ux, uy), from), ux, uy)),
                _ => {}
            }
        }
    }
    (found, pending)
}

/// Rochers éprouvés avant de renoncer : chaque essai coûte huit questions à
/// l'index de régions, comme pour le gibier (`WILD_CANDIDATES`).
const MINE_CANDIDATES: usize = 8;

/// Un colon peut-il venir taper sur ce rocher ? Le rocher lui-même est
/// infranchissable : c'est une case **voisine** qu'il faut pouvoir rejoindre.
fn minable(sim: &Sim, from: (u32, u32), rock: (u32, u32)) -> bool {
    for (dx, dy) in [
        (0i32, -1i32),
        (0, 1),
        (-1, 0),
        (1, 0),
        (-1, -1),
        (1, -1),
        (-1, 1),
        (1, 1),
    ] {
        let (nx, ny) = (rock.0 as i32 + dx, rock.1 as i32 + dy);
        if !sim.map().in_bounds(nx, ny) {
            continue;
        }
        let (nx, ny) = (nx as u32, ny as u32);
        if sim.map().passable(nx, ny) && colonist_can_reach(sim, from, (nx, ny)) {
            return true;
        }
    }
    false
}

/// Cases candidates pour la forge, dans l'ordre où un joueur les essaierait :
/// **hors entrepôt et hors zone de culture** (les piles y refusent le plan,
/// §10.2), dans l'enceinte, libres de tout élément, franchissables et
/// atteignables, les plus proches du poste de fabrication d'abord — c'est là
/// que le colon fera l'aller-retour minerai → lingot → épée.
///
/// La liste est **longue** exprès : `build_free` prend la première case qui
/// tient et passe à la suivante au passage d'après si le plan n'est pas
/// apparu. Une case libérée par un rangeur redevient candidate d'elle-même,
/// sans mémoire.
fn forge_spots(sim: &Sim, ax: i32, ay: i32) -> Vec<(i32, i32)> {
    let from = (ax.max(0) as u32, ay.max(0) as u32);
    // Le poste de fabrication du plan (§2) : la forge lui fait face.
    let near = (ax + 3, ay - 3);
    let mut spots: Vec<(u32, i32, i32)> = Vec::new();
    for y in ay - WALL_RADIUS + 1..=ay + WALL_RADIUS - 1 {
        for x in ax - WALL_RADIUS + 1..=ax + WALL_RADIUS - 1 {
            if !sim.map().in_bounds(x, y) {
                continue;
            }
            let (ux, uy) = (x as u32, y as u32);
            // Une zone posée par le joueur est un endroit où les piles
            // tombent : l'entrepôt s'en remplit, la culture aussi à la
            // récolte. On n'y plante rien d'infranchissable.
            if sim.map().zone(ux, uy) != Zone::None {
                continue;
            }
            if !sim.map().passable(ux, uy)
                || !build::can_place(sim.map(), BuildKind::Forge, ux, uy)
                || has_pile(sim, ux, uy)
            {
                continue;
            }
            // Le chemin de la porte à l'entrepôt ne doit pas se refermer sur
            // un mur de forge : on garde les cases qui touchent l'enceinte ou
            // qui bordent le poste, jamais le plein milieu.
            let ring = chebyshev((ux, uy), from) >= (WALL_RADIUS - 2) as u32;
            let beside = chebyshev((ux, uy), (near.0.max(0) as u32, near.1.max(0) as u32)) <= 2;
            if !ring && !beside {
                continue;
            }
            if !colonist_can_reach(sim, from, (ux, uy)) {
                continue;
            }
            spots.push((
                chebyshev((ux, uy), (near.0.max(0) as u32, near.1.max(0) as u32)),
                x,
                y,
            ));
        }
    }
    spots.sort_unstable();
    spots.into_iter().map(|(_, x, y)| (x, y)).collect()
}

/// Bêtes candidates qu'on regarde avant de renoncer : au-delà, la bête est
/// trop loin pour qu'un joueur s'y intéresse, et chaque essai coûte un A*.
const WILD_CANDIDATES: usize = 4;

/// Un colon peut-il rejoindre cette case depuis le repère ? Le joueur voit la
/// carte : il ne marque pas le cerf de l'autre rive.
fn reachable(sim: &Sim, from: (u32, u32), to: (u32, u32)) -> bool {
    from == to || sim::path::find_path(sim.map(), from, to).is_some()
}

/// La bête sauvage **atteignable** la plus proche du repère, parmi les espèces
/// voulues, à `range` cases au plus et hors des ids `exclude`. Les candidates
/// sont triées par `(distance, id)` — jamais « la première trouvée » — et les
/// `WILD_CANDIDATES` premières sont éprouvées dans cet ordre.
///
/// `exclude` sert à ne pas viser deux fois la même bête dans un seul passage :
/// la chasse et l'apprivoisement se décident à la suite sur le **même** état,
/// et `Command::Tame` annule un `Command::Hunt` posé au même tick (les deux
/// marquages sont exclusifs, `animals::set_hunted`). La colonie se volait ainsi
/// son propre gibier.
fn nearest_wild(
    sim: &Sim,
    at: (i32, i32),
    species: &[Species],
    range: u32,
    exclude: &[u32],
) -> Option<u32> {
    let from = (at.0.max(0) as u32, at.1.max(0) as u32);
    let mut candidates: Vec<(u32, u32, (u32, u32))> = sim
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Animal && p.is_alive() && !p.hunted && !p.tame_marked)
        .filter(|p| p.species.is_some_and(|s| species.contains(&s)))
        .filter(|p| !exclude.contains(&p.id) && chebyshev(p.tile(), from) <= range)
        .map(|p| (chebyshev(p.tile(), from), p.id, p.tile()))
        .collect();
    candidates.sort_unstable();
    candidates
        .iter()
        .take(WILD_CANDIDATES)
        .find(|&&(_, _, tile)| reachable(sim, from, tile))
        .map(|&(_, id, _)| id)
}

/// Ce qu'un joueur attentif — mais pas génial — ferait de cette colonie
/// maintenant. **Fonction pure** : mêmes états, mêmes commandes.
///
/// Ce qu'il ne fait pas, et qui fausse d'autant la mesure : il ne pilote aucun
/// combat, ne soigne personne à la main, ne déplace jamais un colon et
/// n'annule jamais un chantier. Il ne mine qu'**après la métallurgie**, et
/// seulement de quoi bâtir sa forge puis creuser ses veines (voir §3 bis) :
/// avant cela, pas une pierre, donc ni tombe ni épieu.
pub fn plan(sim: &Sim) -> Vec<Command> {
    let mut cmds = Vec::new();
    let Some((ax, ay)) = anchor(sim) else {
        return cmds;
    };
    let tick = sim.tick();
    let pass = tick / PLAN_INTERVAL;
    let day = tick / u64::from(TICKS_PER_DAY);
    let stored = sim.stored_totals();
    let wood = stored[ItemKind::Wood as usize];
    let colonists = colonist_ids(sim);
    let n = colonists.len() as u32;
    if n == 0 {
        // Colonie éteinte : plus personne à commander. Le harnais continue de
        // tourner (le storyteller, la météo et le feu, eux, ne s'arrêtent pas).
        return cmds;
    }

    // ------------------------------------------------------------------
    // 1. L'installation : zones, désignations, priorités
    // ------------------------------------------------------------------
    if sim.map().stockpile_count() == 0 {
        cmds.push(Command::SetZone {
            zone: Zone::Stockpile,
            x0: ax + 2,
            y0: ay + 2,
            x1: ax + 1 + STOCKPILE_SIDE,
            y1: ay + 1 + STOCKPILE_SIDE,
        });
    }
    if sim.map().growing_count() == 0 {
        cmds.push(Command::SetZone {
            zone: Zone::Growing,
            x0: ax + 1,
            y0: ay - GROWING_SIDE,
            x1: ax + GROWING_SIDE,
            y1: ay - 1,
        });
    }
    // La coupe : on remarque le bois tant qu'il en manque pour l'enceinte.
    if wood < WOOD_FOR_WALLS {
        cmds.push(Command::Designate {
            kind: Designation::Chop,
            x0: ax - CHOP_RADIUS,
            y0: ay - CHOP_RADIUS,
            x1: ax + CHOP_RADIUS,
            y1: ay + CHOP_RADIUS,
        });
    }
    // La récolte : les buissons repoussent, on repasse de temps en temps.
    if pass % HARVEST_EVERY == 0 {
        cmds.push(Command::Designate {
            kind: Designation::Harvest,
            x0: ax - HARVEST_RADIUS,
            y0: ay - HARVEST_RADIUS,
            x1: ax + HARVEST_RADIUS,
            y1: ay + HARVEST_RADIUS,
        });
    }
    // Un cultivateur et un bâtisseur attitrés. Émis seulement si la priorité
    // n'est pas déjà la bonne : sans ça, deux commandes par passage à vide.
    for (rank, &id) in colonists.iter().enumerate().take(2) {
        let work = if rank == 0 {
            WorkType::Farm
        } else {
            WorkType::Build
        };
        let already = sim
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .is_some_and(|p| p.priorities[work as usize] == 1);
        if !already {
            cmds.push(Command::SetPriority {
                pawn: id,
                work,
                priority: 1,
            });
        }
    }

    // ------------------------------------------------------------------
    // 2. Le bâti : confort de base, puis enceinte et pièges
    // ------------------------------------------------------------------
    if wood >= WOOD_FOR_BASE {
        if sim.map().campfire_count() == 0 {
            build_free(
                sim,
                &mut cmds,
                BuildKind::Campfire,
                &[(ax - 3, ay + 3), (ax - 4, ay + 3), (ax - 3, ay + 4)],
                1,
            );
        }
        let beds = sim.map().bed_count();
        if beds < n {
            let row: Vec<(i32, i32)> = (0..8).map(|k| (ax - 3 + k, ay - 3)).collect();
            build_free(sim, &mut cmds, BuildKind::Bed, &row, n - beds);
        }
        if sim.map().crafting_spot_count() == 0 {
            build_free(
                sim,
                &mut cmds,
                BuildKind::CraftingSpot,
                &[(ax + 3, ay - 3), (ax + 4, ay - 3), (ax + 3, ay - 4)],
                1,
            );
        }
    }
    if wood >= WOOD_FOR_WALLS {
        // La porte **avant** les murs : le plan de porte occupe la case, et le
        // rectangle de mur la saute (`Command::Build` ignore une case déjà
        // planifiée). Sans ça, l'enceinte se refermerait sur la colonie.
        let door = (ax, ay + WALL_RADIUS);
        build_free(sim, &mut cmds, BuildKind::Door, &[door], 1);
        for (x0, y0, x1, y1) in [
            (
                ax - WALL_RADIUS,
                ay - WALL_RADIUS,
                ax + WALL_RADIUS,
                ay - WALL_RADIUS,
            ),
            (
                ax - WALL_RADIUS,
                ay + WALL_RADIUS,
                ax + WALL_RADIUS,
                ay + WALL_RADIUS,
            ),
            (
                ax - WALL_RADIUS,
                ay - WALL_RADIUS + 1,
                ax - WALL_RADIUS,
                ay + WALL_RADIUS - 1,
            ),
            (
                ax + WALL_RADIUS,
                ay - WALL_RADIUS + 1,
                ax + WALL_RADIUS,
                ay + WALL_RADIUS - 1,
            ),
        ] {
            cmds.push(Command::Build {
                kind: BuildKind::Wall,
                material: Material::Wood,
                x0,
                y0,
                x1,
                y1,
            });
        }
        // Les pièges une fois la porte debout : trois cases en enfilade juste
        // devant, là où passe qui vient frapper.
        if sim.map().in_bounds(door.0, door.1)
            && sim.map().feature(door.0 as u32, door.1 as u32).is_door()
        {
            let line: Vec<(i32, i32)> = (-1..=1).map(|k| (ax + k, ay + WALL_RADIUS + 1)).collect();
            build_free(sim, &mut cmds, BuildKind::SpikeTrap, &line, TRAPS);
        }
    }

    // ------------------------------------------------------------------
    // 3. Recherche : établi au jour 5, agriculture puis médecine
    // ------------------------------------------------------------------
    if day >= RESEARCH_DAY && sim.map().research_bench_count() == 0 && wood >= WOOD_FOR_BASE {
        build_free(
            sim,
            &mut cmds,
            BuildKind::ResearchBench,
            &[(ax - 3, ay - 3), (ax - 4, ay - 3), (ax - 3, ay - 4)],
            1,
        );
    }
    if sim.map().research_bench_count() > 0 {
        let r = sim.research();
        let wanted = if !r.is_done(Tech::Agriculture) {
            Some(Tech::Agriculture)
        } else if !r.is_done(Tech::Medicine) {
            Some(Tech::Medicine)
        } else if !r.is_done(Tech::Metallurgy) {
            // La métallurgie en troisième : c'est la seule qui ouvre quelque
            // chose (la forge, donc le lingot, donc l'épée), et la plus chère.
            Some(Tech::Metallurgy)
        } else {
            None
        };
        if let Some(tech) = wanted
            && r.current() != Some(tech)
        {
            cmds.push(Command::SetResearch { tech: tech as u8 });
        }
    }

    // ------------------------------------------------------------------
    // 3 bis. Le métal : forge, veines, lingots et épées
    // ------------------------------------------------------------------
    // Rien de tout cela avant la métallurgie : la forge serait refusée. C'est
    // aussi le seul moment où ce joueur mine — jusque-là il ne touche pas un
    // rocher (voir l'en-tête de `plan`).
    if sim.research().is_done(Tech::Metallurgy) {
        // L'entrepôt s'agrandit avec le minerai : voir `STOCKPILE_SIDE_METAL`.
        // Le coin `(ax, ay)` sert de témoin — il est franchissable par
        // construction (`anchor`), donc l'ordre ne repart pas au passage
        // suivant.
        let stock_ready = sim.map().zone(ax.max(0) as u32, ay.max(0) as u32) == Zone::Stockpile;
        if !stock_ready {
            cmds.push(Command::SetZone {
                zone: Zone::Stockpile,
                x0: ax,
                y0: ay,
                x1: ax + STOCKPILE_SIDE_METAL - 1,
                y1: ay + STOCKPILE_SIDE_METAL - 1,
            });
        }
        // **Les veines d'abord.** Le minerai est ce qui manque partout — un
        // rocher sur `map::ORE_IN_ROCKS` est veiné —, il ne se gâte pas et il
        // attendra la forge sans rien coûter. La pierre, elle, ne sert qu'aux
        // vingt unités de la forge : on ne la creuse que tant qu'elle manque.
        designate_rocks(sim, &mut cmds, (ax, ay), Feature::OreRock, ROCKS_PER_PASS);
        if sim.map().forge_count() == 0 {
            if stored[ItemKind::Stone as usize] < STONE_FOR_FORGE {
                designate_rocks(sim, &mut cmds, (ax, ay), Feature::Rock, ROCKS_PER_PASS);
            } else if stock_ready {
                // Hors entrepôt et hors culture : c'est tout le correctif
                // du §10.2. La liste est longue, `build_free` prend la
                // première case tenable et le passage suivant réessaie sur
                // une autre si le plan n'est pas apparu.
                //
                // **Après** l'agrandissement de l'entrepôt, jamais dans le
                // même passage : `forge_spots` lit les zones telles qu'elles
                // sont, et l'agrandissement n'a pas encore été appliqué —
                // la forge tomberait dans l'entrepôt de demain.
                build_free(
                    sim,
                    &mut cmds,
                    BuildKind::Forge,
                    &forge_spots(sim, ax, ay),
                    1,
                );
            }
        } else {
            // Forge debout : on demande de quoi armer la colonie — les
            // lingots d'abord, l'épée suit.
            let ingots = METAL_PER_SWORD * n;
            if sim.craft_targets()[ItemKind::Metal as usize] != ingots {
                cmds.push(Command::SetCraftTarget {
                    kind: ItemKind::Metal,
                    target: ingots,
                });
            }
            if sim.craft_targets()[ItemKind::Sword as usize] != n {
                cmds.push(Command::SetCraftTarget {
                    kind: ItemKind::Sword,
                    target: n,
                });
            }
        }
    }

    // ------------------------------------------------------------------
    // 4. Fabrication : un arc par colon, une tunique par colon en automne
    // ------------------------------------------------------------------
    // **L'objectif d'armes ne redescend jamais.** Il valait `n` au sens strict :
    // un colon tué faisait retomber la demande, et l'arc que le bâtisseur
    // taillait pour un autre devenait sans objet — la colonie qui perd du monde
    // est précisément celle qui a besoin d'armes. On ne l'abaisse plus.
    let bows_wanted = sim.craft_targets()[ItemKind::Bow as usize].max(n);
    if sim.craft_targets()[ItemKind::Bow as usize] != bows_wanted {
        cmds.push(Command::SetCraftTarget {
            kind: ItemKind::Bow,
            target: bows_wanted,
        });
    }
    // **La tunique passe après l'arc et après l'enceinte** (corrigé le
    // 2026-09-06). Elle se taille au même poste, par le même `WorkType::Build`
    // et par le même bâtisseur que les arcs et les murs : posée dès le tick 0
    // dans la campagne d'automne, elle prenait leur tour (§ constat n°1 —
    // 0 colon armé sur 74). Deux conditions, donc :
    //
    // 1. un arc par colon **déjà dans la colonie** (`colony_total` compte les
    //    arcs portés comme ceux rangés) ;
    // 2. de quoi finir l'enceinte : tant que les plans de mur, de porte et de
    //    piège réclament plus de bois qu'il n'y en a en caisse, le bâtisseur a
    //    mieux à faire qu'un vêtement.
    let wall_debt: u32 = sim
        .blueprints()
        .iter()
        .filter(|b| {
            matches!(
                b.kind,
                BuildKind::Wall | BuildKind::Door | BuildKind::SpikeTrap
            )
        })
        .map(|b| b.missing())
        .sum();
    let armed_enough = sim.colony_total(ItemKind::Bow) >= n;
    if sim.season() == Season::Autumn
        && armed_enough
        && wood > wall_debt
        && sim.craft_targets()[ItemKind::Tunic as usize] != n
    {
        cmds.push(Command::SetCraftTarget {
            kind: ItemKind::Tunic,
            target: n,
        });
    }

    // ------------------------------------------------------------------
    // 5. Chasse et apprivoisement
    // ------------------------------------------------------------------
    // Un gibier marqué que plus personne ne peut atteindre (il a détalé de
    // l'autre côté de l'eau) ne sera jamais chassé : la marque resterait pour
    // toujours et chaque colon armé recalculerait son chemin à chaque tick.
    // C'est le premier constat du rapport : on démarque, comme le ferait un
    // joueur qui voit son chasseur tourner en rond.
    let anchor_tile = (ax.max(0) as u32, ay.max(0) as u32);
    let mut hunting = false;
    for p in sim.pawns() {
        if !p.hunted || !p.is_alive() {
            continue;
        }
        if reachable(sim, anchor_tile, p.tile()) {
            hunting = true;
        } else {
            cmds.push(Command::Hunt {
                animal: p.id,
                on: false,
            });
        }
    }
    let meat = stored[ItemKind::Meat as usize] + stored[ItemKind::Meal as usize];
    if meat < MEAT_PER_COLONIST * n && !hunting {
        // Une bête à la fois : marquer toute la harde enverrait la colonie
        // entière courir après les cerfs.
        if let Some(animal) = nearest_wild(
            sim,
            (ax, ay),
            &[Species::Rabbit, Species::Deer],
            u32::MAX,
            &[],
        ) {
            cmds.push(Command::Hunt { animal, on: true });
        }
    }
    // **L'apprivoisement se relance** (corrigé le 2026-09-06). Il ne partait
    // qu'une fois, au jour `TAME_DAY`, sur un lapin, et la marque restait
    // posée jusqu'à la fin de la partie même si la bête mourait de vieillesse
    // dans un coin de carte inatteignable : 7 colonies sur 30 finissaient avec
    // du bétail (constat ouvert n°4). Trois changements :
    //
    // 1. **dès que les baies suffisent**, sans attendre un jour fixe — c'est le
    //    fourrage qui commande, pas le calendrier ;
    // 2. **un lapin, puis un cerf** : le lapin est la bête du débutant
    //    (`livestock::TAME_BASE_NUM`), mais toutes les cartes n'en portent pas ;
    // 3. **on relève la marque** dès qu'elle ne peut plus rien donner (bête
    //    morte, partie, ou de l'autre côté de l'eau), et on **change de bête**
    //    tous les `TAME_RETRY_DAYS` jours tant qu'aucune n'est apprivoisée : la
    //    bête démarquée redevient candidate au passage suivant, celle qu'on
    //    marque à la place est forcément une autre (`nearest_wild` écarte ce
    //    qui est déjà marqué).
    if sim.livestock_count() == 0 && stored[ItemKind::Berries as usize] >= TAME_BERRIES {
        let switch = day % TAME_RETRY_DAYS == 0 && tick % u64::from(TICKS_PER_DAY) == 0;
        let mut standing = false;
        for p in sim.pawns() {
            if !p.tame_marked || !p.is_alive() {
                continue;
            }
            if !switch && reachable(sim, anchor_tile, p.tile()) {
                standing = true;
            } else {
                cmds.push(Command::Tame {
                    animal: p.id,
                    on: false,
                });
            }
        }
        // Le gibier marqué dans ce même passage n'est pas candidat : un
        // `Tame` posé sur lui annulerait la chasse qu'on vient d'ordonner.
        let hunted_now: Vec<u32> = cmds
            .iter()
            .filter_map(|c| match c {
                Command::Hunt { animal, on: true } => Some(*animal),
                _ => None,
            })
            .collect();
        if !standing
            && let Some(animal) =
                nearest_wild(sim, (ax, ay), &[Species::Rabbit], TAME_RANGE, &hunted_now).or_else(
                    || nearest_wild(sim, (ax, ay), &[Species::Deer], TAME_RANGE, &hunted_now),
                )
        {
            cmds.push(Command::Tame { animal, on: true });
        }
    }

    // ------------------------------------------------------------------
    // 6. Troc : des vivres contre du bois ou du cuir en excès
    // ------------------------------------------------------------------
    if sim.trader().is_some() && food_days_tenths(&stored, n) < TRADE_FOOD_DAYS * 10 {
        // Le meilleur genre comestible proposé, au sens de la nutrition par
        // unité : c'est ce qu'un joueur regarde.
        let mut best: Option<(u32, ItemKind, u32, u32)> = None;
        for (kind, count, price) in sim.trader_offers() {
            let Some(nutrition) = kind.nutrition() else {
                continue;
            };
            if best.is_none_or(|(bn, bk, _, _)| (nutrition, kind as u32) > (bn, bk as u32)) {
                best = Some((nutrition, kind, count, price));
            }
        }
        if let Some((_, take, available, price)) = best {
            let take_count = available.min(TRADE_MAX_UNITS);
            let cost = price.saturating_mul(take_count);
            let prices = sim.buy_prices();
            for (give, reserve) in [
                (ItemKind::Wood, WOOD_RESERVE),
                (ItemKind::Leather, LEATHER_RESERVE),
            ] {
                let unit = prices[give as usize].max(1);
                // La colonie peut payer plus, jamais moins (voir
                // `Command::Trade`) : on arrondit à l'unité supérieure.
                let give_count = cost.div_ceil(unit);
                if give_count > 0 && stored[give as usize] >= give_count.saturating_add(reserve) {
                    cmds.push(Command::Trade {
                        give,
                        give_count,
                        take,
                        take_count,
                    });
                    break;
                }
            }
        }
    }

    // ------------------------------------------------------------------
    // 7. Tribut : payer sa paix à une tribu qui nous en veut trop
    // ------------------------------------------------------------------
    if wood >= GIFT_WOOD + WOOD_RESERVE {
        for f in factions::FACTIONS {
            if factions::is_tribe(f.id) && sim.faction_goodwill(f.id) < GIFT_GOODWILL {
                cmds.push(Command::Gift {
                    faction: f.id,
                    kind: ItemKind::Wood,
                    count: GIFT_WOOD,
                });
                // Un tribut à la fois : deux d'un coup videraient la réserve.
                break;
            }
        }
    }

    cmds
}

// ----------------------------------------------------------------------
// Causes de mort
// ----------------------------------------------------------------------

/// Ce à quoi on attribue la mort d'un colon. Le sim n'en garde aucune trace
/// (`EventKind::ColonistDied` ne porte que l'id) : la cause est **déduite** du
/// dernier état observé du colon, au tick d'avant sa disparition.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Cause {
    Raid,
    /// Mort de ses plaies alors qu'il ne restait plus un ennemi sur la carte :
    /// une hémorragie que personne n'a pansée, le plus souvent au lendemain
    /// d'un raid.
    Wounds,
    Starvation,
    Cold,
    Illness,
    Fire,
    Brawl,
    Unknown,
}

const CAUSE_COUNT: usize = 8;

impl Cause {
    /// Dans l'ordre d'affichage.
    const ALL: [Cause; CAUSE_COUNT] = [
        Cause::Raid,
        Cause::Wounds,
        Cause::Starvation,
        Cause::Cold,
        Cause::Illness,
        Cause::Fire,
        Cause::Brawl,
        Cause::Unknown,
    ];

    fn label(self) -> &'static str {
        match self {
            Cause::Raid => "raid",
            Cause::Wounds => "blessures",
            Cause::Starvation => "famine",
            Cause::Cold => "froid",
            Cause::Illness => "maladie",
            Cause::Fire => "feu",
            Cause::Brawl => "rixe",
            Cause::Unknown => "inconnue",
        }
    }
}

/// Dernier état connu d'un colon vivant, relevé à chaque tick. Assez pour
/// attribuer une cause à sa mort au tick suivant, pas plus : ce n'est pas une
/// copie de `Pawn`.
struct Watched {
    id: u32,
    hunger: u32,
    comfort: i32,
    sick: bool,
    quarrel: bool,
    on_fire: bool,
    hurt: bool,
    enemy: bool,
}

impl Watched {
    /// Cause déduite, dans un ordre de priorité assumé : le feu d'abord (une
    /// case qui brûle sous les pieds ne laisse pas de doute), la famine
    /// ensuite (un ventre vide tue tout seul, raid ou pas), puis le raid — un
    /// blessé avec un pillard encore debout sur la carte —, puis le froid, la
    /// maladie, les plaies qu'aucun ennemi n'explique plus (le lendemain d'un
    /// raid) et la rixe. Toute mort qu'aucun de ces états n'explique tombe dans
    /// `Unknown` — c'est le compteur à surveiller : s'il grossit, c'est la
    /// déduction qui est fautive, pas le sim.
    fn cause(&self) -> Cause {
        if self.on_fire {
            Cause::Fire
        } else if self.hunger <= STARVING {
            Cause::Starvation
        } else if self.enemy && self.hurt {
            Cause::Raid
        } else if self.comfort < HYPOTHERMIA_TEMP {
            Cause::Cold
        } else if self.sick {
            Cause::Illness
        } else if self.hurt {
            Cause::Wounds
        } else if self.quarrel {
            Cause::Brawl
        } else {
            Cause::Unknown
        }
    }
}

fn observe(sim: &Sim, out: &mut Vec<Watched>) {
    out.clear();
    for p in sim.pawns() {
        if !p.is_colonist() || !p.is_alive() {
            continue;
        }
        let (x, y) = p.tile();
        out.push(Watched {
            id: p.id,
            hunger: p.hunger,
            comfort: p.comfort,
            sick: p.sick,
            quarrel: p.quarrel_ticks > 0,
            on_fire: sim.map().fire_at(x, y) > 0,
            hurt: !p.injuries.is_empty() || p.blood < BLOOD_MAX,
            enemy: p.enemy_present,
        });
    }
}

// ----------------------------------------------------------------------
// Le harnais de mesure
// ----------------------------------------------------------------------

/// Le journal du sim est borné à 32 entrées : on le vide plus souvent que ça
/// ne se remplit. Un trou de `seq` serait compté dans `lost`.
const EVENT_POLL: u64 = 60;

/// Ce qu'une graine a donné.
struct Run {
    seed: u64,
    colonists_end: u32,
    /// `None` si la campagne s'arrête avant ce jour-là.
    colonists_day10: Option<u32>,
    colonists_day20: Option<u32>,
    deaths: [u32; CAUSE_COUNT],
    raids: u32,
    /// Pillards entrés en tout : `EventKind::Raid` porte la taille de la bande
    /// dans son `arg`. C'est la mesure de l'escalade — le nombre de raids, lui,
    /// ne dépend que de l'échéance, pas des points de menace.
    raiders: u32,
    raids_repelled: u32,
    wealth: u32,
    food_days_tenths: u32,
    techs: u32,
    livestock: u32,
    fires: u32,
    burned: u32,
    mood_percent: u32,
    /// Colons vivants qui portent une arme en fin de partie. Le joueur scripté
    /// vise un arc par colon (`SetCraftTarget`) dès le premier passage : cet
    /// écart-là dit si la chaîne fabrication → équipement tient sa promesse.
    armed: u32,
    /// Chantiers encore ouverts en fin de partie. L'enceinte fait 48 murs et
    /// une porte : un chiffre qui reste haut dit que la colonie n'a jamais fini
    /// de se fermer, ce qui change la lecture des morts en raid.
    blueprints_left: u32,
    /// Forges debout en fin de partie (`Map::forge_count`). Le joueur scripté
    /// vise la métallurgie en troisième technologie : sans ce chiffre, on ne
    /// sait pas si la recherche a servi à quelque chose ou si elle s'est
    /// arrêtée au parchemin.
    forges: u32,
    /// Lingots fondus sur toute la partie (`EventKind::ItemCrafted`, `arg` =
    /// `ItemKind::Metal`). Compté au journal et non au stock : un lingot
    /// consommé par une épée ne se voit plus en stock, et c'est bien la
    /// **production** qu'on mesure.
    ingots: u32,
    /// Épées forgées sur toute la partie (`EventKind::WeaponCrafted`, `arg` =
    /// `ItemKind::Sword`).
    swords: u32,
    /// Colons vivants qui portent une **épée** en fin de partie. À comparer à
    /// `armed`, qui compte toutes les armes : c'est l'écart entre « la colonie
    /// s'arme » et « la colonie est allée au bout de la chaîne du métal ».
    swordsmen: u32,
    /// Réputation finale envers les trois factions, dans l'ordre des ids
    /// (`factions::FACTIONS` : deux tribus puis la Guilde).
    goodwill: [i32; factions::FACTION_COUNT],
    /// Tributs offerts sur toute la partie (`EventKind::Gift`). Le joueur en
    /// envoie un dès qu'une tribu passe sous `GIFT_GOODWILL` : ce compteur, lu
    /// à côté de `goodwill`, dit si le bois offert a acheté quelque chose.
    tributes: u32,
    /// `Command::Tame { on: true }` envoyés sur toute la partie, et bêtes
    /// réellement apprivoisées. Le second est un sous-ensemble du premier :
    /// leur rapport dit où se perd l'élevage.
    tame_orders: u32,
    tamed: u32,
    /// Jour où la métallurgie est tombée, `None` si elle n'a jamais été
    /// acquise. À lire avec `forges` : une technologie obtenue au jour 28 ne
    /// laisse pas le temps de miner vingt-cinq pierres.
    metallurgy_day: Option<u32>,
    /// Événements annoncés par le sim mais lus trop tard (journal débordé).
    /// Doit rester à 0 : sinon les comptes de raids sont sous-évalués.
    lost_events: u32,
    /// Morts annoncées par le sim, à comparer à la somme de `deaths`.
    deaths_announced: u32,
    /// Temps réel qu'a coûté cette graine : le coût par tick varie d'un facteur
    /// cinquante d'une colonie à l'autre, c'est une mesure à part entière.
    elapsed_ms: u128,
}

impl Run {
    fn deaths_total(&self) -> u32 {
        self.deaths.iter().sum()
    }
}

/// Ce que le journal du sim a raconté depuis le début de la partie. Le journal
/// étant borné, ce compteur est la seule mémoire de ce qui s'est passé.
#[derive(Default)]
struct Journal {
    next_seq: u32,
    raids: u32,
    raiders: u32,
    raids_repelled: u32,
    fires: u32,
    burned: u32,
    deaths_announced: u32,
    /// Lingots et épées **produits**, et tributs offerts : trois faits qui ne
    /// laissent aucune trace lisible dans l'état final (un lingot se consomme,
    /// une épée se perd avec son porteur, un tribut ne laisse qu'un delta de
    /// réputation). Le journal est la seule mémoire qu'on en ait.
    ingots: u32,
    swords: u32,
    tributes: u32,
    /// Bêtes **effectivement** apprivoisées (`EventKind::Tamed`). À lire en
    /// face de `Run::tame_orders` : c'est ce couple que réclamait le constat
    /// ouvert n°4 — savoir si le chiffre du bétail est borné par le marquage
    /// (le joueur ne tente pas) ou par la traque (il tente et échoue).
    tamed: u32,
    /// Tick où la métallurgie a été acquise (`EventKind::ResearchDone`,
    /// `arg` = `Tech::Metallurgy`). C'est elle qui ouvre la forge : savoir
    /// **quand** elle tombe est la moitié de la réponse à « la colonie
    /// forge-t-elle ? ».
    metallurgy_tick: Option<u64>,
    lost: u32,
}

impl Journal {
    /// Lit les événements pas encore vus. Un `seq` manquant veut dire que le
    /// journal a débordé entre deux lectures : compté dans `lost`.
    fn drain(&mut self, sim: &Sim) {
        for e in sim.events() {
            if e.seq < self.next_seq {
                continue;
            }
            self.lost += e.seq - self.next_seq;
            self.next_seq = e.seq + 1;
            match e.kind {
                EventKind::Raid => {
                    self.raids += 1;
                    self.raiders += e.arg;
                }
                EventKind::RaidRepelled => self.raids_repelled += 1,
                EventKind::FireStarted => self.fires += 1,
                EventKind::FireOut => self.burned += e.arg,
                EventKind::ColonistDied => self.deaths_announced += 1,
                // `arg` porte le genre fabriqué : les armes passent par
                // `WeaponCrafted`, tout le reste par `ItemCrafted`.
                EventKind::ItemCrafted if e.arg == ItemKind::Metal as u32 => self.ingots += 1,
                EventKind::WeaponCrafted if e.arg == ItemKind::Sword as u32 => self.swords += 1,
                EventKind::Gift => self.tributes += 1,
                EventKind::Tamed => self.tamed += 1,
                EventKind::ResearchDone if e.arg == Tech::Metallurgy as u32 => {
                    self.metallurgy_tick.get_or_insert(e.tick);
                }
                _ => {}
            }
        }
    }
}

/// Ce qui règle une campagne. Groupé pour ne pas promener six paramètres.
struct Settings {
    seeds: u64,
    first_seed: u64,
    days: u64,
    size: u32,
    difficulty: Difficulty,
    /// Moyenne annuelle imposée par `Command::SetClimate`, en dixièmes de °C.
    /// `None` : la carte garde son climat tempéré.
    climate: Option<i32>,
    /// Jour de l'année où la partie commence (`Command::SetCalendar`), comme le
    /// serveur monde l'impose à l'ouverture d'une colonie. `None` : jour 0,
    /// c'est-à-dire le premier jour du printemps.
    ///
    /// L'année fait `climate::YEAR_DAYS` (60) jours, quatre saisons de quinze :
    /// une campagne de trente jours partie de 0 ne voit **que** le printemps et
    /// l'été. Pour mesurer l'automne et l'hiver — les tuniques, le premier gel,
    /// les cultures tuées par le froid — il faut partir de 30.
    day_of_year: Option<u32>,
}

fn play_seed(seed: u64, s: &Settings) -> Run {
    let mut sim = Sim::new(seed, s.size, s.size);
    let total = u64::from(TICKS_PER_DAY) * s.days;

    let mut deaths = [0u32; CAUSE_COUNT];
    let mut journal = Journal::default();
    let mut colonists_day10 = None;
    let mut colonists_day20 = None;
    let mut tame_orders = 0u32;
    let start = Instant::now();

    let mut prev: Vec<Watched> = Vec::new();
    let mut cur: Vec<Watched> = Vec::new();
    observe(&sim, &mut prev);

    for t in 0..total {
        let mut cmds = Vec::new();
        if t == 0 {
            // La mise en place, comme le serveur monde la ferait : difficulté
            // puis climat, avant la première décision du joueur.
            cmds.push(Command::SetDifficulty {
                level: s.difficulty,
            });
            if let Some(base) = s.climate {
                cmds.push(Command::SetClimate {
                    base_temperature: base,
                    amplitude: Climate::TEMPERATE_AMPLITUDE,
                });
            }
            // Le calendrier **après** le climat, dans cet ordre : c'est celui
            // que le serveur monde impose à l'hôte (voir `AGENTS.md`).
            if let Some(day) = s.day_of_year {
                cmds.push(Command::SetCalendar { day_of_year: day });
            }
        }
        if t % PLAN_INTERVAL == 0 {
            cmds.append(&mut plan(&sim));
        }
        tame_orders += cmds
            .iter()
            .filter(|c| matches!(c, Command::Tame { on: true, .. }))
            .count() as u32;
        sim.step(&cmds);

        observe(&sim, &mut cur);
        // Un colon présent au tick d'avant et absent maintenant est mort :
        // `Sim::remove_dead` l'a retiré à la fin du tick. Rien d'autre ne fait
        // disparaître un colon ici (aucune caravane n'est formée).
        for w in &prev {
            if !cur.iter().any(|c| c.id == w.id) {
                deaths[w.cause() as usize] += 1;
            }
        }
        std::mem::swap(&mut prev, &mut cur);

        let tick = sim.tick();
        if tick % EVENT_POLL == 0 {
            journal.drain(&sim);
        }
        if tick == 10 * u64::from(TICKS_PER_DAY) {
            colonists_day10 = Some(colonist_ids(&sim).len() as u32);
        }
        if tick == 20 * u64::from(TICKS_PER_DAY) {
            colonists_day20 = Some(colonist_ids(&sim).len() as u32);
        }
    }

    // Dernière lecture : les événements des soixante derniers ticks.
    journal.drain(&sim);

    let colonists = colonist_ids(&sim);
    let n = colonists.len() as u32;
    let mood_total: u64 = sim
        .pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .map(|p| u64::from(p.mood()))
        .sum();
    let mood_percent = if n == 0 {
        0
    } else {
        (mood_total * 100 / (u64::from(NEED_MAX) * u64::from(n))) as u32
    };
    let techs = Tech::ALL
        .iter()
        .filter(|&&t| sim.research().is_done(t))
        .count() as u32;
    let armed = sim
        .pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive() && p.weapon.is_some())
        .count() as u32;
    let swordsmen = sim
        .pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive() && p.weapon == Some(ItemKind::Sword))
        .count() as u32;
    let mut goodwill = [0i32; factions::FACTION_COUNT];
    for (k, f) in factions::FACTIONS.iter().enumerate() {
        goodwill[k] = sim.faction_goodwill(f.id);
    }

    Run {
        seed,
        colonists_end: n,
        colonists_day10,
        colonists_day20,
        deaths,
        raids: journal.raids,
        raiders: journal.raiders,
        raids_repelled: journal.raids_repelled,
        wealth: sim.wealth(),
        food_days_tenths: food_days_tenths(&sim.stored_totals(), n),
        techs,
        livestock: sim.livestock_count(),
        fires: journal.fires,
        burned: journal.burned,
        mood_percent,
        armed,
        blueprints_left: sim.blueprints().len() as u32,
        forges: sim.map().forge_count(),
        ingots: journal.ingots,
        swords: journal.swords,
        swordsmen,
        goodwill,
        tributes: journal.tributes,
        tame_orders,
        tamed: journal.tamed,
        metallurgy_day: journal
            .metallurgy_tick
            .map(|t| (t / u64::from(TICKS_PER_DAY)) as u32),
        lost_events: journal.lost,
        deaths_announced: journal.deaths_announced,
        elapsed_ms: start.elapsed().as_millis(),
    }
}

// ----------------------------------------------------------------------
// Sortie
// ----------------------------------------------------------------------

fn difficulty_label(d: Difficulty) -> &'static str {
    match d {
        Difficulty::Peaceful => "paisible",
        Difficulty::Easy => "facile",
        Difficulty::Normal => "normal",
        Difficulty::Hard => "difficile",
    }
}

/// Moyenne en dixièmes, sur des entiers : la sortie doit être identique d'une
/// machine à l'autre.
fn mean_tenths(values: impl Iterator<Item = u64>, count: usize) -> u64 {
    if count == 0 {
        return 0;
    }
    let total: u64 = values.sum();
    total * 10 / count as u64
}

/// Moyenne de valeurs **déjà exprimées en dixièmes** : on divise, on ne
/// remultiplie pas. `mean_tenths` sur `food_days_tenths` donnerait des
/// dixièmes de dixième, et « 18,6 jours de vivres » s'afficherait « 186,0 ».
fn mean_of_tenths(values: impl Iterator<Item = u64>, count: usize) -> u64 {
    if count == 0 {
        return 0;
    }
    let total: u64 = values.sum();
    total / count as u64
}

fn tenths(v: u64) -> String {
    format!("{},{}", v / 10, v % 10)
}

/// La même moyenne en dixièmes, sur des valeurs **signées** : une réputation
/// va de −100 à +100, et c'est presque toujours du côté négatif qu'elle vit.
fn mean_tenths_signed(values: impl Iterator<Item = i64>, count: usize) -> i64 {
    if count == 0 {
        return 0;
    }
    let total: i64 = values.sum();
    total * 10 / count as i64
}

fn signed_tenths(v: i64) -> String {
    let sign = if v < 0 { "−" } else { "" };
    let v = v.unsigned_abs();
    format!("{sign}{},{}", v / 10, v % 10)
}

/// Moyenne d'un jalon sur les graines qui l'ont atteint, « — » si aucune.
fn mean_milestone(runs: &[Run], pick: impl Fn(&Run) -> Option<u32>) -> String {
    let values: Vec<u64> = runs.iter().filter_map(|r| pick(r).map(u64::from)).collect();
    if values.is_empty() {
        return "—".to_string();
    }
    let count = values.len();
    tenths(mean_tenths(values.into_iter(), count))
}

/// Un jalon qui n'a pas eu lieu (campagne plus courte que le jour visé)
/// s'écrit « — », pas 0 : une colonie qui n'a jamais atteint le jour 20 n'y a
/// pas perdu tout le monde.
fn milestone(v: Option<u32>) -> String {
    match v {
        Some(k) => k.to_string(),
        None => "—".to_string(),
    }
}

/// Réputation envers les trois factions, dans l'ordre des ids : deux tribus
/// puis la Guilde. Une seule colonne pour trois chiffres — les lire séparément
/// n'apprendrait rien, c'est leur écart qui parle.
fn goodwill_cell(g: &[i32; factions::FACTION_COUNT]) -> String {
    g.iter().map(i32::to_string).collect::<Vec<_>>().join("/")
}

fn print_table(runs: &[Run]) {
    println!(
        "{:>6} {:>4} {:>4} {:>4} {:>6} {:>5} {:>5} {:>4} {:>4} {:>4} {:>4} {:>4} {:>4} {:>6} {:>6} {:>5} {:>9} {:>6} {:>7} {:>7} {:>5} {:>6} {:>6} {:>6} {:>6} {:>6} {:>7} {:>11} {:>6} {:>6} {:>8} {:>7}",
        "graine",
        "fin",
        "j10",
        "j20",
        "morts",
        "raid",
        "bles.",
        "fam",
        "frd",
        "mal",
        "feu",
        "rix",
        "?",
        "raids",
        "têtes",
        "rep.",
        "richesse",
        "techs",
        "vivres",
        "bétail",
        "feux",
        "brûlé",
        "armés",
        "forges",
        "ling.",
        "épées",
        "portées",
        "réputation",
        "trib.",
        "humeur",
        "chantier",
        "ms"
    );
    for r in runs {
        println!(
            "{:>6} {:>4} {:>4} {:>4} {:>6} {:>5} {:>5} {:>4} {:>4} {:>4} {:>4} {:>4} {:>4} {:>6} {:>6} {:>5} {:>9} {:>6} {:>7} {:>7} {:>5} {:>6} {:>6} {:>6} {:>6} {:>6} {:>7} {:>11} {:>6} {:>6} {:>8} {:>7}",
            r.seed,
            r.colonists_end,
            milestone(r.colonists_day10),
            milestone(r.colonists_day20),
            r.deaths_total(),
            r.deaths[Cause::Raid as usize],
            r.deaths[Cause::Wounds as usize],
            r.deaths[Cause::Starvation as usize],
            r.deaths[Cause::Cold as usize],
            r.deaths[Cause::Illness as usize],
            r.deaths[Cause::Fire as usize],
            r.deaths[Cause::Brawl as usize],
            r.deaths[Cause::Unknown as usize],
            r.raids,
            r.raiders,
            r.raids_repelled,
            r.wealth,
            r.techs,
            tenths(u64::from(r.food_days_tenths)),
            r.livestock,
            r.fires,
            r.burned,
            r.armed,
            r.forges,
            r.ingots,
            r.swords,
            r.swordsmen,
            goodwill_cell(&r.goodwill),
            r.tributes,
            r.mood_percent,
            r.blueprints_left,
            r.elapsed_ms
        );
    }
}

fn print_summary(runs: &[Run], ticks: u64, elapsed: std::time::Duration) {
    let n = runs.len();
    let wiped = runs.iter().filter(|r| r.colonists_end == 0).count();
    let deaths_total: u32 = runs.iter().map(|r| r.deaths_total()).sum();
    let announced: u32 = runs.iter().map(|r| r.deaths_announced).sum();
    let lost: u32 = runs.iter().map(|r| r.lost_events).sum();

    println!();
    println!("résumé :");
    println!(
        "  colons vivants en fin  : moyenne {} (min {}, max {}) — colonies éteintes {wiped}/{n}",
        tenths(mean_tenths(
            runs.iter().map(|r| u64::from(r.colonists_end)),
            n
        )),
        runs.iter().map(|r| r.colonists_end).min().unwrap_or(0),
        runs.iter().map(|r| r.colonists_end).max().unwrap_or(0),
    );
    println!(
        "  colons au jour 10 / 20 : {} / {}",
        mean_milestone(runs, |r| r.colonists_day10),
        mean_milestone(runs, |r| r.colonists_day20),
    );
    print!("  morts par cause        : {deaths_total} au total");
    if deaths_total > 0 {
        for cause in Cause::ALL {
            let k: u32 = runs.iter().map(|r| r.deaths[cause as usize]).sum();
            if k > 0 {
                print!(", {} {k} ({} %)", cause.label(), k * 100 / deaths_total);
            }
        }
    }
    println!();
    println!(
        "  morts annoncées par le sim : {announced} (déduites : {deaths_total}) — événements perdus : {lost}"
    );
    println!(
        "  raids reçus / repoussés: {} / {} par colonie",
        tenths(mean_tenths(runs.iter().map(|r| u64::from(r.raids)), n)),
        tenths(mean_tenths(
            runs.iter().map(|r| u64::from(r.raids_repelled)),
            n
        )),
    );
    // La taille des bandes, pas leur nombre : c'est elle que les points de
    // menace du storyteller sont censés faire grossir.
    let raids: u32 = runs.iter().map(|r| r.raids).sum();
    let raiders: u32 = runs.iter().map(|r| r.raiders).sum();
    println!(
        "  pillards entrés        : {raiders} en {raids} bandes — {} par bande",
        tenths(mean_tenths(
            std::iter::once(u64::from(raiders)),
            raids.max(1) as usize
        )),
    );
    println!(
        "  richesse finale        : moyenne {} (min {}, max {})",
        tenths(mean_tenths(runs.iter().map(|r| u64::from(r.wealth)), n)),
        runs.iter().map(|r| r.wealth).min().unwrap_or(0),
        runs.iter().map(|r| r.wealth).max().unwrap_or(0),
    );
    println!(
        "  vivres en stock        : moyenne {} jours — colonies sous un jour : {}/{n}",
        tenths(mean_of_tenths(
            runs.iter().map(|r| u64::from(r.food_days_tenths)),
            n
        )),
        runs.iter()
            .filter(|r| r.colonists_end > 0 && r.food_days_tenths < 10)
            .count(),
    );
    println!(
        "  technologies acquises  : moyenne {} — aucune : {}/{n}",
        tenths(mean_tenths(runs.iter().map(|r| u64::from(r.techs)), n)),
        runs.iter().filter(|r| r.techs == 0).count(),
    );
    println!(
        "  bétail                 : moyenne {} — au moins une bête : {}/{n} (dont vivantes : {})",
        tenths(mean_tenths(runs.iter().map(|r| u64::from(r.livestock)), n)),
        runs.iter().filter(|r| r.livestock > 0).count(),
        runs.iter()
            .filter(|r| r.livestock > 0 && r.colonists_end > 0)
            .count(),
    );
    // Le couple que demandait le constat n°4 : ce qu'on a tenté, ce qui a pris.
    println!(
        "  apprivoisement         : {} marquages pour {} bêtes prises — colonies vivantes au bétail : {}/{}",
        runs.iter().map(|r| r.tame_orders).sum::<u32>(),
        runs.iter().map(|r| r.tamed).sum::<u32>(),
        runs.iter()
            .filter(|r| r.livestock > 0 && r.colonists_end > 0)
            .count(),
        runs.iter().filter(|r| r.colonists_end > 0).count(),
    );
    println!(
        "  incendies              : {} feux, {} cases brûlées — colonies touchées : {}/{n}",
        runs.iter().map(|r| r.fires).sum::<u32>(),
        runs.iter().map(|r| r.burned).sum::<u32>(),
        runs.iter().filter(|r| r.fires > 0).count(),
    );
    // Les deux chiffres qui disent si la colonie a eu le temps de se préparer :
    // des colons armés, et une enceinte finie plutôt qu'un chantier abandonné.
    println!(
        "  colons armés en fin    : {} sur {} vivants — colonies sans une arme : {}/{n}",
        runs.iter().map(|r| u64::from(r.armed)).sum::<u64>(),
        runs.iter().map(|r| u64::from(r.colonists_end)).sum::<u64>(),
        runs.iter()
            .filter(|r| r.colonists_end > 0 && r.armed == 0)
            .count(),
    );
    // La chaîne du métal, de bout en bout : la technologie ne dit rien tant
    // qu'on ne sait pas si la forge est sortie de terre, si elle a fondu quelque
    // chose, et si ce quelque chose a fini dans une main.
    println!(
        "  chaîne du métal        : {} forges, {} lingots, {} épées — colonies à la forge : {}/{n}, épée en main : {} sur {} vivants",
        runs.iter().map(|r| r.forges).sum::<u32>(),
        runs.iter().map(|r| r.ingots).sum::<u32>(),
        runs.iter().map(|r| r.swords).sum::<u32>(),
        runs.iter().filter(|r| r.forges > 0).count(),
        runs.iter().map(|r| u64::from(r.swordsmen)).sum::<u64>(),
        runs.iter().map(|r| u64::from(r.colonists_end)).sum::<u64>(),
    );
    // Ce que la ligne précédente ne dit pas : le **moment**. Une métallurgie
    // acquise la veille de la fin n'ouvre rien.
    println!(
        "  métallurgie            : acquise par {}/{n} colonies, au jour moyen {}",
        runs.iter().filter(|r| r.metallurgy_day.is_some()).count(),
        mean_milestone(runs, |r| r.metallurgy_day),
    );
    // La diplomatie : ce que le tribut a coûté, et où en est la réputation.
    // Moyenne **par faction**, dans l'ordre des ids (deux tribus, la Guilde) :
    // une moyenne d'ensemble mélangerait ceux qui nous attaquent et celui qui
    // nous vend du grain.
    let means: Vec<String> = (0..factions::FACTION_COUNT)
        .map(|k| {
            signed_tenths(mean_tenths_signed(
                runs.iter().map(|r| i64::from(r.goodwill[k])),
                n,
            ))
        })
        .collect();
    println!(
        "  réputation finale      : {} (deux tribus, Guilde) — colonies détestées d'une tribu : {}/{n}",
        means.join(" / "),
        runs.iter()
            .filter(|r| r
                .goodwill
                .iter()
                .enumerate()
                .any(|(k, &g)| factions::is_tribe(factions::FACTIONS[k].id) && g < GIFT_GOODWILL))
            .count(),
    );
    println!(
        "  tributs offerts        : {} en tout — colonies qui en ont offert : {}/{n}",
        runs.iter().map(|r| r.tributes).sum::<u32>(),
        runs.iter().filter(|r| r.tributes > 0).count(),
    );
    println!(
        "  chantiers non finis    : moyenne {} — colonies au chantier propre : {}/{n}",
        tenths(mean_tenths(
            runs.iter().map(|r| u64::from(r.blueprints_left)),
            n
        )),
        runs.iter().filter(|r| r.blueprints_left == 0).count(),
    );
    println!("  humeur moyenne finale  : {} % (colonies vivantes)", {
        let alive: Vec<u64> = runs
            .iter()
            .filter(|r| r.colonists_end > 0)
            .map(|r| u64::from(r.mood_percent))
            .collect();
        let count = alive.len();
        tenths(mean_tenths(alive.into_iter(), count))
    });
    println!(
        "  perf                   : {ticks} ticks en {} ms, {:.0} ticks/s",
        elapsed.as_millis(),
        ticks_per_sec(ticks, elapsed)
    );
}

/// Un jalon absent devient `null` : le JSON ne mentira pas plus que le tableau.
fn json_milestone(v: Option<u32>) -> String {
    match v {
        Some(k) => k.to_string(),
        None => "null".to_string(),
    }
}

fn print_json(runs: &[Run], s: &Settings, ticks: u64, elapsed: std::time::Duration) {
    println!("{{");
    print!(
        "  \"campaign\": {{\"seeds\": {}, \"days\": {}, \"size\": {}, \"difficulty\": \"{}\", \"climate\": ",
        s.seeds,
        s.days,
        s.size,
        difficulty_label(s.difficulty)
    );
    match s.climate {
        Some(c) => print!("{c}"),
        None => print!("null"),
    }
    println!(
        ", \"day_of_year\": {}, \"ticks\": {ticks}, \"elapsed_ms\": {}}},",
        s.day_of_year.unwrap_or(0),
        elapsed.as_millis()
    );
    println!("  \"runs\": [");
    for (i, r) in runs.iter().enumerate() {
        let comma = if i + 1 == runs.len() { "" } else { "," };
        let deaths: Vec<String> = Cause::ALL
            .iter()
            .map(|&c| format!("\"{}\": {}", c.label(), r.deaths[c as usize]))
            .collect();
        let goodwill: Vec<String> = r.goodwill.iter().map(i32::to_string).collect();
        println!(
            "    {{\"seed\": {}, \"colonists_end\": {}, \"colonists_day10\": {}, \"colonists_day20\": {}, \"deaths\": {{{}}}, \"raids\": {}, \"raiders\": {}, \"raids_repelled\": {}, \"wealth\": {}, \"food_days_tenths\": {}, \"techs\": {}, \"livestock\": {}, \"fires\": {}, \"burned_tiles\": {}, \"mood_percent\": {}, \"armed\": {}, \"blueprints_left\": {}, \"forges\": {}, \"ingots\": {}, \"swords\": {}, \"swordsmen\": {}, \"goodwill\": [{}], \"tributes\": {}, \"tame_orders\": {}, \"tamed\": {}, \"metallurgy_day\": {}, \"lost_events\": {}, \"deaths_announced\": {}, \"elapsed_ms\": {}}}{comma}",
            r.seed,
            r.colonists_end,
            json_milestone(r.colonists_day10),
            json_milestone(r.colonists_day20),
            deaths.join(", "),
            r.raids,
            r.raiders,
            r.raids_repelled,
            r.wealth,
            r.food_days_tenths,
            r.techs,
            r.livestock,
            r.fires,
            r.burned,
            r.mood_percent,
            r.armed,
            r.blueprints_left,
            r.forges,
            r.ingots,
            r.swords,
            r.swordsmen,
            goodwill.join(", "),
            r.tributes,
            r.tame_orders,
            r.tamed,
            json_milestone(r.metallurgy_day),
            r.lost_events,
            r.deaths_announced,
            r.elapsed_ms,
        );
    }
    println!("  ]");
    println!("}}");
}

// ----------------------------------------------------------------------
// Sous-commande
// ----------------------------------------------------------------------

const CAMPAIGN_HELP: &str = "\
rimlike-sim campaign — joue des colonies entières avec un joueur scripté et mesure

USAGE :
    rimlike-sim campaign [--seeds N] [--days D] [--size W] [--difficulty L]
                         [--climate T] [--day-of-year J] [--seed S] [--json]

OPTIONS :
    --seeds N        nombre de graines jouées (défaut 30)
    --days D         jours de jeu par graine (défaut 30)
    --size W         carte carrée W x W (défaut 96)
    --difficulty L   0 paisible, 1 facile, 2 normal (défaut), 3 difficile
    --climate T      moyenne annuelle imposée, en dixièmes de °C (SetClimate) ;
                     absente, la carte garde son climat tempéré (120)
    --day-of-year J  jour de l'année au démarrage (SetCalendar), 0 à 59 ;
                     absent, la partie commence au jour 0, premier jour du
                     printemps. L'année fait 60 jours, quatre saisons de 15 :
                     une campagne de 30 jours partie de 0 ne voit que le
                     printemps et l'été ; partir de 30 donne automne et hiver
    --seed S         première graine (défaut 1 ; la graine r est S + r)
    --json           sortie machine (drapeau, sans valeur)

Chaque graine est jouée par le même joueur scripté : zone de stockage et de
culture, coupe et récolte, feu de camp, lits, poste de fabrication, enceinte de
bois avec porte et pièges, établi de recherche, arcs (puis tuniques une fois
la colonie armée et l'enceinte payée), minage et forge après la métallurgie,
chasse quand la viande manque, apprivoisement relancé tant qu'aucune bête n'est
prise, troc de vivres et tribut aux tribus hostiles. Il ne pilote aucun combat
et ne soigne personne à la main.

Affiche une ligne par graine (colons vivants en fin et aux jours 10 et 20,
morts par cause déduite, raids reçus et repoussés, richesse, technologies,
jours de vivres, bétail, incendies, chaîne du métal — forges debout, lingots
et épées produits, épées portées —, réputation envers les trois factions et
tributs offerts) puis un résumé, qui donne en plus les marquages
d'apprivoisement envoyés face aux bêtes réellement prises. Sort toujours en 0 : c'est une mesure, pas un
test.
";

pub fn campaign(args: &[String]) -> u8 {
    if wants_help(args) {
        print!("{CAMPAIGN_HELP}");
        return 0;
    }
    match campaign_inner(args) {
        Ok(code) => code,
        Err(e) => {
            eprintln!("erreur : {}", e.0);
            eprintln!();
            eprint!("{CAMPAIGN_HELP}");
            2
        }
    }
}

fn campaign_inner(args: &[String]) -> Result<u8, CliError> {
    // `--json` est un drapeau : il n'a pas de valeur, alors que `Options`
    // n'accepte que des paires `--nom valeur`. On le retire avant l'analyse.
    let mut json = false;
    let mut rest: Vec<String> = Vec::with_capacity(args.len());
    for a in args {
        if a == "--json" {
            json = true;
        } else {
            rest.push(a.clone());
        }
    }
    let opts = Options::parse(&rest)?;
    opts.forbid_unknown(&[
        "seeds",
        "days",
        "size",
        "difficulty",
        "climate",
        "seed",
        "day-of-year",
    ])?;
    let seeds = opts.u64_or("seeds", 30)?;
    if seeds == 0 {
        return Err(CliError::new("--seeds doit être un entier positif"));
    }
    let days = opts.u64_or("days", 30)?;
    if days == 0 {
        return Err(CliError::new("--days doit être un entier positif"));
    }
    let size = u32::try_from(opts.u64_or("size", 96)?)
        .map_err(|_| CliError::new("--size est démesuré"))?;
    check_size(size)?;
    let level = opts.u64_or("difficulty", 2)?;
    if level > 3 {
        return Err(CliError::new(
            "--difficulty doit valoir 0 (paisible), 1, 2 ou 3 (difficile)",
        ));
    }
    let raw_climate = opts.string("climate", "");
    let climate = if raw_climate.is_empty() {
        None
    } else {
        Some(raw_climate.parse::<i32>().map_err(|_| {
            CliError::new(format!(
                "--climate doit être un entier (dixièmes de °C), reçu « {raw_climate} »"
            ))
        })?)
    };
    let raw_day = opts.string("day-of-year", "");
    let day_of_year = if raw_day.is_empty() {
        None
    } else {
        let day = raw_day.parse::<u32>().map_err(|_| {
            CliError::new(format!(
                "--day-of-year doit être un entier, reçu « {raw_day} »"
            ))
        })?;
        if day >= YEAR_DAYS {
            return Err(CliError::new(format!(
                "--day-of-year doit être dans 0..{YEAR_DAYS} (l'année fait {YEAR_DAYS} jours)"
            )));
        }
        Some(day)
    };
    let settings = Settings {
        seeds,
        first_seed: opts.u64_or("seed", 1)?,
        days,
        size,
        difficulty: Difficulty::from_u8(level as u8),
        climate,
        day_of_year,
    };

    let ticks_per_seed = u64::from(TICKS_PER_DAY) * days;
    if !json {
        println!(
            "campagne : {seeds} graines, {days} jours ({ticks_per_seed} ticks), carte {size}x{size}, difficulté {}, climat {}, départ au jour {}",
            difficulty_label(settings.difficulty),
            match climate {
                Some(c) => format!("{c} dixièmes"),
                None => "tempéré (défaut)".to_string(),
            },
            day_of_year.unwrap_or(0)
        );
    }

    let start = Instant::now();
    let mut runs = Vec::with_capacity(seeds as usize);
    for r in 0..seeds {
        runs.push(play_seed(settings.first_seed.wrapping_add(r), &settings));
    }
    let elapsed = start.elapsed();
    let ticks = ticks_per_seed * seeds;

    if json {
        print_json(&runs, &settings, ticks, elapsed);
    } else {
        print_table(&runs);
        print_summary(&runs, ticks, elapsed);
    }
    Ok(0)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sim::testmap::map_from;
    use sim::{Feature, ItemKind};

    /// Une clairière large : de la place pour l'enceinte, des arbres à l'ouest,
    /// des buissons à l'est. Le repère (`anchor`) tombe au centre.
    fn clearing() -> Sim {
        let mut rows = Vec::new();
        for y in 0..24 {
            let mut row = String::new();
            for x in 0..24 {
                row.push(if x < 3 && (2..8).contains(&y) {
                    'T'
                } else if x > 20 && (2..8).contains(&y) {
                    'b'
                } else {
                    '.'
                });
            }
            rows.push(row);
        }
        let refs: Vec<&str> = rows.iter().map(|s| s.as_str()).collect();
        Sim::from_map(1, map_from(&refs))
    }

    fn has_zone(cmds: &[Command], wanted: Zone) -> bool {
        cmds.iter()
            .any(|c| matches!(c, Command::SetZone { zone, .. } if *zone == wanted))
    }

    fn has_designation(cmds: &[Command], wanted: Designation) -> bool {
        cmds.iter()
            .any(|c| matches!(c, Command::Designate { kind, .. } if *kind == wanted))
    }

    fn has_build(cmds: &[Command], wanted: BuildKind) -> bool {
        cmds.iter()
            .any(|c| matches!(c, Command::Build { kind, .. } if *kind == wanted))
    }

    #[test]
    fn le_joueur_installe_la_colonie_au_premier_passage() {
        let s = clearing();
        let cmds = plan(&s);
        assert!(
            has_zone(&cmds, Zone::Stockpile),
            "pas de stockage : {cmds:?}"
        );
        assert!(has_zone(&cmds, Zone::Growing), "pas de culture : {cmds:?}");
        assert!(has_designation(&cmds, Designation::Chop), "pas de coupe");
        assert!(
            has_designation(&cmds, Designation::Harvest),
            "pas de récolte"
        );
        // Un cultivateur et un bâtisseur attitrés, pas plus.
        let priorities: Vec<&Command> = cmds
            .iter()
            .filter(|c| matches!(c, Command::SetPriority { .. }))
            .collect();
        assert_eq!(priorities.len(), 2, "priorités : {priorities:?}");
        // Un arc par colon, et rien de bâti sans bois.
        assert!(cmds.contains(&Command::SetCraftTarget {
            kind: ItemKind::Bow,
            target: 3
        }));
        assert!(!has_build(&cmds, BuildKind::Campfire), "bâti sans bois");
        assert!(!has_build(&cmds, BuildKind::Wall), "muré sans bois");
    }

    #[test]
    fn le_joueur_ne_repete_pas_ce_qui_est_deja_fait() {
        let mut s = clearing();
        let first = plan(&s);
        s.step(&first);
        let second = plan(&s);
        assert!(
            !has_zone(&second, Zone::Stockpile),
            "zone de stockage reposée : {second:?}"
        );
        assert!(
            !has_zone(&second, Zone::Growing),
            "zone de culture reposée : {second:?}"
        );
        assert!(
            !second
                .iter()
                .any(|c| matches!(c, Command::SetPriority { .. })),
            "priorités réémises : {second:?}"
        );
        assert!(
            !second
                .iter()
                .any(|c| matches!(c, Command::SetCraftTarget { .. })),
            "objectif de fabrication réémis : {second:?}"
        );
    }

    /// La métallurgie ouvre une chaîne entière : on mine (ce que ce joueur ne
    /// faisait jamais), on bâtit la forge, puis on demande lingots et épées.
    /// Rien de tout cela avant la technologie — la forge serait refusée.
    #[test]
    fn la_forge_et_les_veines_attendent_la_metallurgie() {
        let mut s = installed();
        store_wood(&mut s, 200);
        assert!(
            !has_designation(&plan(&s), Designation::Mine),
            "on mine sans métallurgie"
        );
        assert!(!has_build(&plan(&s), BuildKind::Forge), "forge sans techno");

        s.research_mut().complete(Tech::Metallurgy);
        // Sans pierre en stock : on marque des rochers, on ne bâtit pas encore.
        let (ax, ay) = anchor(&s).expect("repère");
        s.map_mut()
            .set_feature((ax + 8) as u32, ay as u32, Feature::Rock);
        let cmds = plan(&s);
        assert!(
            has_designation(&cmds, Designation::Mine),
            "aucun rocher marqué : {cmds:?}"
        );
        assert!(!has_build(&cmds, BuildKind::Forge), "forge sans pierre");
        // Ce passage-là agrandit aussi l'entrepôt (voir `STOCKPILE_SIDE_METAL`) :
        // la forge attend qu'il soit peint pour ne pas tomber dedans.
        s.step(&cmds);

        // La pierre rentrée, la forge se plante et les objectifs suivent.
        let (ax, ay) = anchor(&s).expect("repère");
        s.spawn_item(
            ItemKind::Stone,
            STONE_FOR_FORGE + 5,
            (ax + 2) as u32,
            (ay + 2) as u32,
        );
        let cmds = plan(&s);
        let forge = forge_tile(&cmds).expect("pas de forge");
        s.step(&cmds);
        s.map_mut().set_feature(forge.0, forge.1, Feature::Forge);
        s.map_mut()
            .set_feature((ax + 8) as u32, (ay + 1) as u32, Feature::OreRock);
        let cmds = plan(&s);
        let colonists = colonist_ids(&s).len() as u32;
        assert!(
            cmds.contains(&Command::SetCraftTarget {
                kind: ItemKind::Sword,
                target: colonists
            }),
            "aucune épée demandée : {cmds:?}"
        );
        assert!(
            cmds.contains(&Command::SetCraftTarget {
                kind: ItemKind::Metal,
                target: METAL_PER_SWORD * colonists
            }),
            "aucun lingot demandé : {cmds:?}"
        );
        assert!(
            has_designation(&cmds, Designation::Mine),
            "veine ignorée : {cmds:?}"
        );
    }

    /// Joue le premier passage du joueur : c'est lui qui pose les zones.
    fn installed() -> Sim {
        let mut s = clearing();
        let cmds = plan(&s);
        s.step(&cmds);
        assert!(s.map().stockpile_count() > 0, "zone de stockage absente");
        s
    }

    /// Pose `count` bois **dans** la zone de stockage, seule chose que
    /// `stored_totals` compte.
    fn store_wood(s: &mut Sim, count: u32) {
        let (ax, ay) = anchor(s).expect("repère");
        let mut left = count;
        for dy in 0..STOCKPILE_SIDE {
            for dx in 0..STOCKPILE_SIDE {
                if left == 0 {
                    return;
                }
                let n = left.min(75);
                s.spawn_item(
                    ItemKind::Wood,
                    n,
                    (ax + 2 + dx) as u32,
                    (ay + 2 + dy) as u32,
                );
                left -= n;
            }
        }
    }

    #[test]
    fn quarante_bois_declenchent_le_confort_de_base() {
        let mut s = installed();
        store_wood(&mut s, 60);
        assert!(
            s.stored_totals()[ItemKind::Wood as usize] >= WOOD_FOR_BASE,
            "le bois n'est pas rangé : {:?}",
            s.stored_totals()
        );
        let cmds = plan(&s);
        assert!(has_build(&cmds, BuildKind::Campfire), "{cmds:?}");
        assert!(has_build(&cmds, BuildKind::Bed), "{cmds:?}");
        assert!(has_build(&cmds, BuildKind::CraftingSpot), "{cmds:?}");
        // 60 bois : pas encore de quoi lancer l'enceinte.
        assert!(!has_build(&cmds, BuildKind::Wall), "{cmds:?}");
    }

    #[test]
    fn cent_bois_declenchent_l_enceinte_et_sa_porte() {
        let mut s = installed();
        store_wood(&mut s, 150);
        assert!(s.stored_totals()[ItemKind::Wood as usize] >= WOOD_FOR_WALLS);
        let cmds = plan(&s);
        let walls = cmds
            .iter()
            .filter(|c| {
                matches!(
                    c,
                    Command::Build {
                        kind: BuildKind::Wall,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(walls, 4, "quatre segments d'enceinte attendus : {cmds:?}");
        assert!(has_build(&cmds, BuildKind::Door), "pas de porte : {cmds:?}");
        // La porte est émise avant les murs, sinon l'enceinte se referme.
        let door_at = cmds
            .iter()
            .position(|c| {
                matches!(
                    c,
                    Command::Build {
                        kind: BuildKind::Door,
                        ..
                    }
                )
            })
            .expect("porte");
        let wall_at = cmds
            .iter()
            .position(|c| {
                matches!(
                    c,
                    Command::Build {
                        kind: BuildKind::Wall,
                        ..
                    }
                )
            })
            .expect("mur");
        assert!(door_at < wall_at, "la porte est planifiée après les murs");
    }

    #[test]
    fn les_pieges_attendent_que_la_porte_soit_debout() {
        let mut s = installed();
        store_wood(&mut s, 150);
        assert!(
            !has_build(&plan(&s), BuildKind::SpikeTrap),
            "pièges posés sans porte"
        );
        let (ax, ay) = anchor(&s).expect("repère");
        s.map_mut()
            .set_feature(ax as u32, (ay + WALL_RADIUS) as u32, Feature::DoorWood);
        let cmds = plan(&s);
        let traps = cmds
            .iter()
            .filter(|c| {
                matches!(
                    c,
                    Command::Build {
                        kind: BuildKind::SpikeTrap,
                        ..
                    }
                )
            })
            .count();
        assert_eq!(traps, TRAPS as usize, "{cmds:?}");
    }

    #[test]
    fn la_chasse_se_declenche_quand_la_viande_manque() {
        // Sans viande ni repas en stock, le tout premier passage marque déjà du
        // gibier : deux lapins posés ici, c'est le plus proche du repère qui
        // doit partir, pas le premier venu de la liste.
        let mut s = clearing();
        let (ax, ay) = anchor(&s).expect("repère");
        let far = s.spawn_animal((ax + 8) as u32, ay as u32, Species::Rabbit);
        let near = s.spawn_animal((ax + 2) as u32, ay as u32, Species::Rabbit);
        let cmds = plan(&s);
        assert!(
            cmds.contains(&Command::Hunt {
                animal: near,
                on: true
            }),
            "le gibier le plus proche n'est pas marqué (loin : {far}) : {cmds:?}"
        );
        // Une bête à la fois : un gibier déjà marqué suffit.
        s.step(&cmds);
        assert!(
            !plan(&s).iter().any(|c| matches!(c, Command::Hunt { .. })),
            "deuxième marquage alors qu'une chasse est en cours"
        );
    }

    #[test]
    fn le_tribut_part_quand_une_tribu_nous_deteste() {
        let mut s = installed();
        store_wood(&mut s, 150);
        assert!(
            !plan(&s).iter().any(|c| matches!(c, Command::Gift { .. })),
            "tribut offert à une tribu qui nous tolère"
        );
        // Les deux tribus nous détestent : un seul tribut part quand même.
        s.set_goodwill(0, -60);
        s.set_goodwill(1, -60);
        let cmds = plan(&s);
        let gifts = cmds
            .iter()
            .filter(|c| matches!(c, Command::Gift { .. }))
            .count();
        assert_eq!(gifts, 1, "un seul tribut à la fois : {cmds:?}");
    }

    /// Ce que le rapport ne voyait pas : la forge, le lingot, l'épée. Aucun
    /// des trois ne se lit dans l'état final — un lingot se consomme, une épée
    /// se perd avec son porteur, une forge peut brûler —, ils se comptent donc
    /// au journal, et c'est ce comptage qu'on vérifie ici.
    #[test]
    fn le_journal_compte_les_lingots_et_les_epees() {
        let mut s = clearing();
        let (ax, ay) = anchor(&s).expect("repère");
        // De quoi tenir sans que la faim interrompe l'atelier.
        s.spawn_item(ItemKind::Berries, 200, ax as u32, (ay + 1) as u32);
        s.map_mut()
            .set_feature((ax + 5) as u32, ay as u32, Feature::CraftingSpot);
        s.map_mut()
            .set_feature((ax + 5) as u32, (ay + 2) as u32, Feature::Forge);
        assert_eq!(s.map().forge_count(), 1, "la forge n'est pas debout");
        s.spawn_item(ItemKind::Ore, 12, (ax + 3) as u32, ay as u32);
        // Quatre lingots posés d'avance : l'épée n'attend pas la fonte, le test
        // tient en trois jours de jeu.
        s.spawn_item(
            ItemKind::Metal,
            METAL_PER_SWORD,
            (ax + 3) as u32,
            (ay + 1) as u32,
        );
        s.step(&[
            Command::SetCraftTarget {
                kind: ItemKind::Metal,
                target: METAL_PER_SWORD + 2,
            },
            Command::SetCraftTarget {
                kind: ItemKind::Sword,
                target: 1,
            },
        ]);
        let mut journal = Journal::default();
        for _ in 0..3 * u64::from(TICKS_PER_DAY) {
            s.step(&[]);
            if s.tick() % EVENT_POLL == 0 {
                journal.drain(&s);
            }
        }
        journal.drain(&s);
        assert!(journal.ingots > 0, "aucun lingot compté");
        assert!(journal.swords > 0, "aucune épée comptée");
        assert_eq!(journal.lost, 0, "journal débordé");
    }

    /// Le tribut et la réputation, l'autre angle mort : `Command::Gift` ne
    /// laisse qu'un `EventKind::Gift` derrière lui, et la réputation qu'il
    /// achète ne se lit que faction par faction.
    #[test]
    fn le_journal_compte_les_tributs_et_la_reputation_suit() {
        let mut s = installed();
        store_wood(&mut s, 150);
        s.set_goodwill(0, -60);
        let before = s.faction_goodwill(0);
        let cmds = plan(&s);
        assert!(
            cmds.iter().any(|c| matches!(c, Command::Gift { .. })),
            "aucun tribut émis : {cmds:?}"
        );
        s.step(&cmds);
        let mut journal = Journal::default();
        journal.drain(&s);
        assert_eq!(journal.tributes, 1, "tribut non compté");
        assert!(
            s.faction_goodwill(0) > before,
            "la réputation n'a pas bougé : {before} → {}",
            s.faction_goodwill(0)
        );
        // Les trois factions sont bien lisibles une à une : c'est ce que le
        // rapport exporte désormais.
        assert_eq!(factions::FACTIONS.len(), factions::FACTION_COUNT);
    }

    /// Vide la carte de sa faune de départ. `Sim::from_map` en pose déjà
    /// (deux lapins et un cerf sur `clearing`), et le premier passage du
    /// joueur en marque un au gibier : sans ce coup de balai, un test qui
    /// croit éprouver « le lapin qu'on vient de poser » éprouve en fait celui
    /// d'à côté.
    fn clear_animals(s: &mut Sim) {
        let ids: Vec<u32> = s
            .pawns()
            .iter()
            .filter(|p| p.faction == Faction::Animal)
            .map(|p| p.id)
            .collect();
        for id in ids {
            if let Some(p) = s.pawn_mut(id) {
                p.gone = true;
            }
        }
        s.step(&[]);
        assert!(
            !s.pawns().iter().any(|p| p.faction == Faction::Animal),
            "la faune de départ n'a pas été retirée"
        );
    }

    /// Case de la forge demandée par ce lot de commandes, s'il y en a une.
    fn forge_tile(cmds: &[Command]) -> Option<(u32, u32)> {
        cmds.iter().find_map(|c| match c {
            Command::Build {
                kind: BuildKind::Forge,
                x0,
                y0,
                ..
            } => Some((*x0 as u32, *y0 as u32)),
            _ => None,
        })
    }

    /// **Correction n°1 du 2026-09-06.** La forge était proposée sur trois
    /// cases de l'entrepôt ; `Command::Build` refuse en silence une case qui
    /// porte une pile, et un entrepôt qui sert en porte toujours une. Le plan
    /// ne sortait jamais (une forge sur trente colonies, §10.2).
    #[test]
    fn la_forge_evite_l_entrepot_la_culture_et_les_piles() {
        let mut s = installed();
        store_wood(&mut s, 200);
        s.research_mut().complete(Tech::Metallurgy);
        let (ax, ay) = anchor(&s).expect("repère");
        s.spawn_item(
            ItemKind::Stone,
            STONE_FOR_FORGE + 5,
            (ax + 2) as u32,
            (ay + 2) as u32,
        );
        // Le premier passage agrandit l'entrepôt et ne plante rien : les zones
        // que lit `forge_spots` ne connaissent pas encore l'agrandissement.
        let first = plan(&s);
        assert!(
            forge_tile(&first).is_none(),
            "forge plantée avant que l'entrepôt ne soit agrandi : {first:?}"
        );
        s.step(&first);
        let cmds = plan(&s);
        let (fx, fy) = forge_tile(&cmds).expect("aucune forge demandée");
        assert_ne!(
            s.map().zone(fx, fy),
            Zone::Stockpile,
            "forge plantée dans l'entrepôt ({fx}, {fy})"
        );
        assert_ne!(
            s.map().zone(fx, fy),
            Zone::Growing,
            "forge plantée dans la culture ({fx}, {fy})"
        );
        assert!(
            !has_pile(&s, fx, fy),
            "forge plantée sur une pile ({fx}, {fy})"
        );
        // Et l'ordre passe vraiment : c'est tout ce qui manquait.
        s.step(&cmds);
        assert!(
            s.blueprints().iter().any(|b| (b.x, b.y) == (fx, fy)),
            "le plan de forge n'est pas apparu"
        );

        // Une pile posée sur la case retenue ne bloque plus rien : le passage
        // suivant en propose une autre.
        let mut s = installed();
        store_wood(&mut s, 200);
        s.research_mut().complete(Tech::Metallurgy);
        s.spawn_item(
            ItemKind::Stone,
            STONE_FOR_FORGE + 5,
            (ax + 2) as u32,
            (ay + 2) as u32,
        );
        s.step(&plan(&s));
        s.spawn_item(ItemKind::Leather, 3, fx, fy);
        assert!(has_pile(&s, fx, fy));
        let (gx, gy) = forge_tile(&plan(&s)).expect("aucune forge de repli");
        assert_ne!((gx, gy), (fx, fy), "la case occupée est reproposée");
    }

    /// **Correction n°1 bis.** Le rayon de minage s'élargit : à 12 cases fixes,
    /// quatorze des quinze graines qui payaient la métallurgie n'avaient pas un
    /// rocher à portée (§10.2).
    #[test]
    fn le_minage_elargit_son_rayon_jusqu_au_rocher() {
        let mut s = installed();
        store_wood(&mut s, 200);
        s.research_mut().complete(Tech::Metallurgy);
        // Rien dans le rayon de départ : le seul rocher est au-delà.
        assert!(
            !has_designation(&plan(&s), Designation::Mine),
            "un rocher marqué là où il n'y en a pas"
        );
        let (ax, ay) = anchor(&s).expect("repère");
        let far = ((ax + MINE_RADIUS - 1).min(s.map().width() as i32 - 2)) as u32;
        assert!(
            (far as i32) < ax + MINE_RADIUS,
            "le rocher de contrôle doit rester sur la carte"
        );
        s.map_mut().set_feature(far, ay as u32, Feature::Rock);
        // Ce rocher-là est dans le rayon de départ : il part tout de suite.
        assert!(
            has_designation(&plan(&s), Designation::Mine),
            "rocher proche ignoré"
        );
        // Sur une carte plus grande, un rocher **hors** du rayon de départ est
        // trouvé quand même : c'est l'élargissement qui est éprouvé ici.
        let mut wide = Sim::new(1, 64, 64);
        wide.step(&plan(&wide));
        wide.research_mut().complete(Tech::Metallurgy);
        let (wx, wy) = anchor(&wide).expect("repère");
        // On efface d'abord tout rocher naturel, pour que le seul candidat
        // soit celui qu'on pose, et qu'il soit hors de portée initiale.
        for y in 0..wide.map().height() {
            for x in 0..wide.map().width() {
                if wide.map().feature(x, y).is_rock() {
                    wide.map_mut().set_feature(x, y, Feature::None);
                }
            }
        }
        assert!(
            !has_designation(&plan(&wide), Designation::Mine),
            "carte sans rocher, et pourtant une désignation"
        );
        let far_x = (wx + MINE_RADIUS + 6) as u32;
        wide.map_mut().set_feature(far_x, wy as u32, Feature::Rock);
        let cmds = plan(&wide);
        assert!(
            cmds.iter().any(|c| matches!(
                c,
                Command::Designate {
                    kind: Designation::Mine,
                    x0,
                    ..
                } if *x0 == far_x as i32
            )),
            "le rocher hors rayon n'est pas marqué : {cmds:?}"
        );
    }

    /// **Correction n°2 du 2026-09-06.** La tunique se taille au même poste,
    /// par le même `WorkType::Build`, que l'arc et l'enceinte. Posée dès le
    /// tick 0 en automne, elle prenait leur tour : 0 colon armé sur 74 en
    /// campagne automne-hiver (constat ouvert n°1).
    #[test]
    fn les_tuniques_attendent_l_arc_et_l_enceinte() {
        let mut s = installed();
        store_wood(&mut s, 200);
        // On se place en automne, comme la cinquième campagne.
        s.step(&[Command::SetCalendar {
            day_of_year: 2 * (YEAR_DAYS / 4),
        }]);
        assert_eq!(s.season(), Season::Autumn, "le décor n'est pas l'automne");
        let n = colonist_ids(&s).len() as u32;

        // Sans un seul arc, aucune tunique — mais l'arc, lui, est bien demandé
        // (l'objectif a été posé au premier passage, celui d'`installed`).
        assert_eq!(
            s.craft_targets()[ItemKind::Bow as usize],
            n,
            "l'objectif d'arcs n'est pas posé"
        );
        let cmds = plan(&s);
        assert!(
            !cmds.iter().any(|c| matches!(
                c,
                Command::SetCraftTarget {
                    kind: ItemKind::Tunic,
                    ..
                }
            )),
            "tunique demandée sans un arc en main : {cmds:?}"
        );
        s.step(&cmds);

        // Les arcs rentrés, mais l'enceinte encore à payer : toujours rien.
        let (ax, ay) = anchor(&s).expect("repère");
        s.spawn_item(ItemKind::Bow, n, (ax + 2) as u32, (ay + 3) as u32);
        assert!(
            s.blueprints()
                .iter()
                .any(|b| b.kind == BuildKind::Wall && b.missing() > 0),
            "l'enceinte devrait être en chantier"
        );
        let wall_debt: u32 = s
            .blueprints()
            .iter()
            .filter(|b| b.kind == BuildKind::Wall)
            .map(|b| b.missing())
            .sum();
        assert!(
            wall_debt > s.stored_totals()[ItemKind::Wood as usize],
            "il faut que l'enceinte réclame plus de bois qu'il n'y en a"
        );
        assert!(
            !plan(&s).iter().any(|c| matches!(
                c,
                Command::SetCraftTarget {
                    kind: ItemKind::Tunic,
                    ..
                }
            )),
            "tunique demandée alors que l'enceinte réclame le bois"
        );

        // L'enceinte payée : la tunique passe enfin.
        let ids: Vec<u32> = s.blueprints().iter().map(|b| b.id).collect();
        for id in ids {
            let (x, y) = s
                .blueprints()
                .iter()
                .find(|b| b.id == id)
                .map(|b| (b.x, b.y))
                .expect("chantier");
            s.step(&[Command::CancelBuild {
                x0: x as i32,
                y0: y as i32,
                x1: x as i32,
                y1: y as i32,
            }]);
        }
        // `plan` reposerait l'enceinte : on la lit après coup, sur le lot lui-même.
        let cmds = plan(&s);
        assert!(
            cmds.contains(&Command::SetCraftTarget {
                kind: ItemKind::Tunic,
                target: n
            }),
            "tunique toujours refusée une fois armé et l'enceinte payée : {cmds:?}"
        );
        // Et l'ordre d'arme n'a été annulé par rien : il ne redescend jamais.
        s.step(&cmds);
        let before = s.craft_targets()[ItemKind::Bow as usize];
        let ids: Vec<u32> = colonist_ids(&s);
        if let Some(p) = s.pawn_mut(ids[0]) {
            p.gone = true;
        }
        s.step(&[]);
        let after = plan(&s);
        assert!(
            !after.iter().any(|c| matches!(
                c,
                Command::SetCraftTarget {
                    kind: ItemKind::Bow,
                    target
                } if *target < before
            )),
            "l'objectif d'arcs a été abaissé par une mort : {after:?}"
        );
    }

    /// **Correction n°3 du 2026-09-06.** La marque d'apprivoisement était posée
    /// une fois pour toutes : bête morte ou partie, la colonie n'en marquait
    /// plus jamais d'autre (constat ouvert n°4).
    #[test]
    fn l_apprivoisement_repose_sa_marque_sur_une_autre_bete() {
        let mut s = installed();
        clear_animals(&mut s);
        let (ax, ay) = anchor(&s).expect("repère");
        s.spawn_item(
            ItemKind::Berries,
            TAME_BERRIES + 10,
            (ax + 2) as u32,
            (ay + 2) as u32,
        );
        // De la viande en réserve : sans elle, la chasse marque le lapin avant
        // l'apprivoisement et le test n'éprouverait plus rien.
        s.spawn_item(ItemKind::Meat, 200, (ax + 3) as u32, (ay + 2) as u32);
        let first = s.spawn_animal((ax + 2) as u32, ay as u32, Species::Rabbit);
        let second = s.spawn_animal((ax + 4) as u32, ay as u32, Species::Rabbit);
        let cmds = plan(&s);
        assert!(
            cmds.contains(&Command::Tame {
                animal: first,
                on: true
            }),
            "le lapin le plus proche n'est pas marqué : {cmds:?}"
        );
        s.step(&cmds);
        // Marque debout : on n'en pose pas une deuxième.
        assert!(
            !plan(&s).iter().any(|c| matches!(c, Command::Tame { .. })),
            "deuxième marquage alors que le premier tient"
        );
        // La bête meurt : la marque repart sur l'autre, sans attendre.
        if let Some(p) = s.pawn_mut(first) {
            p.gone = true;
        }
        s.step(&[]);
        let cmds = plan(&s);
        assert!(
            cmds.contains(&Command::Tame {
                animal: second,
                on: true
            }),
            "aucune marque reposée après la mort de la bête : {cmds:?}"
        );

        // À défaut de lapin, un cerf fait l'affaire.
        let mut s = installed();
        clear_animals(&mut s);
        s.spawn_item(
            ItemKind::Berries,
            TAME_BERRIES + 10,
            (ax + 2) as u32,
            (ay + 2) as u32,
        );
        s.spawn_item(ItemKind::Meat, 200, (ax + 3) as u32, (ay + 2) as u32);
        let deer = s.spawn_animal((ax + 3) as u32, ay as u32, Species::Deer);
        assert!(
            plan(&s).contains(&Command::Tame {
                animal: deer,
                on: true
            }),
            "le cerf n'est jamais marqué"
        );
    }

    /// La chasse et l'apprivoisement se décident sur le **même** état : sans
    /// précaution, les deux visaient la même bête et le `Tame` annulait le
    /// `Hunt` posé au tick d'avant dans le même lot.
    #[test]
    fn la_chasse_et_l_apprivoisement_ne_visent_pas_la_meme_bete() {
        let mut s = installed();
        clear_animals(&mut s);
        let (ax, ay) = anchor(&s).expect("repère");
        s.spawn_item(
            ItemKind::Berries,
            TAME_BERRIES + 10,
            (ax + 2) as u32,
            (ay + 2) as u32,
        );
        let only = s.spawn_animal((ax + 2) as u32, ay as u32, Species::Rabbit);
        let cmds = plan(&s);
        assert!(
            cmds.contains(&Command::Hunt {
                animal: only,
                on: true
            }),
            "sans viande, la bête devrait être marquée au gibier : {cmds:?}"
        );
        assert!(
            !cmds.contains(&Command::Tame {
                animal: only,
                on: true
            }),
            "la même bête est marquée à la chasse et à l'apprivoisement : {cmds:?}"
        );
    }

    #[test]
    fn une_colonie_eteinte_ne_recoit_plus_d_ordres() {
        let mut s = clearing();
        let ids: Vec<u32> = s.pawns().iter().map(|p| p.id).collect();
        for id in ids {
            if let Some(p) = s.pawn_mut(id) {
                p.gone = true;
            }
        }
        s.step(&[]);
        assert!(plan(&s).is_empty(), "ordres émis sans colon");
    }

    #[test]
    fn une_campagne_courte_tourne_sans_panique() {
        // Équivalent de `campaign --seeds 2 --days 2`, sur une carte réduite
        // pour que `cargo test` (en debug) reste rapide.
        let args: Vec<String> = ["--seeds", "2", "--days", "2", "--size", "48"]
            .iter()
            .map(|s| s.to_string())
            .collect();
        assert_eq!(campaign_inner(&args).map_err(|e| e.0), Ok(0));
    }

    #[test]
    fn une_campagne_dhiver_tourne_sans_panique() {
        // Départ en automne (jour 30) et climat froid imposé : le chemin
        // `SetClimate` puis `SetCalendar` est celui du serveur monde, et c'est
        // le seul moyen de mesurer une saison froide sur trente jours.
        let args: Vec<String> = [
            "--seeds",
            "1",
            "--days",
            "2",
            "--size",
            "48",
            "--climate",
            "-50",
            "--day-of-year",
            "30",
        ]
        .iter()
        .map(|s| s.to_string())
        .collect();
        assert_eq!(campaign_inner(&args).map_err(|e| e.0), Ok(0));
    }

    #[test]
    fn les_options_invalides_sont_refusees() {
        let bad: Vec<Vec<String>> = vec![
            vec!["--seeds".into(), "0".into()],
            vec!["--days".into(), "0".into()],
            vec!["--size".into(), "0".into()],
            vec!["--difficulty".into(), "4".into()],
            vec!["--climate".into(), "chaud".into()],
            // L'année fait 60 jours : 60 est déjà hors bornes.
            vec!["--day-of-year".into(), "60".into()],
            vec!["--day-of-year".into(), "hiver".into()],
            vec!["--inconnue".into(), "1".into()],
        ];
        for args in bad {
            assert!(campaign_inner(&args).is_err(), "acceptée à tort : {args:?}");
        }
    }
}
