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
    Sim, Species, TICKS_PER_DAY, Tech, WorkType, Zone, build,
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
/// Demi-côté du carré où l'on cherche des rochers à miner : un joueur ne va
/// pas creuser au bout de la carte.
const MINE_RADIUS: i32 = 12;
/// Rochers marqués d'un coup. Chaque case marquée est une commande, et un
/// joueur ne désigne pas une montagne entière : deux rochers ordinaires
/// suffisent à bâtir la forge (15 pierres chacun).
const ROCKS_PER_PASS: usize = 4;
/// Pierre qu'il faut en stock avant de bâtir la forge (20, plus la marge du
/// transport en cours).
const STONE_FOR_FORGE: u32 = 25;
/// Jour où l'on tente un apprivoisement.
const TAME_DAY: u64 = 8;
/// Baies qu'il faut en stock pour se permettre d'apprivoiser.
const TAME_BERRIES: u32 = 30;
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
        if !build::can_place(sim.map(), kind, ux, uy) {
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

/// Marque au minage les rochers les plus proches du repère — veinés
/// (`want_ore`) ou ordinaires. Les candidats sont triés par `(distance, x, y)`,
/// jamais « le premier trouvé », et une case déjà désignée n'est pas remarquée :
/// `plan` reste idempotent sans mémoire.
///
/// Deux garde-fous, et ce sont eux qui comptent (le premier constat du rapport
/// de campagne, celui du gibier inatteignable, se rejouait ici mot pour mot) :
///
/// 1. **la file est bornée à `max`** : tant qu'il reste des rochers marqués
///    dans le rayon, on n'en marque pas d'autres. Sans cela, un joueur qui
///    repasse toutes les `PLAN_INTERVAL` marquait quatre rochers de plus par
///    passage, indéfiniment ;
/// 2. **on ne marque que ce qu'un colon peut atteindre** : un rocher au cœur
///    d'une montagne ou de l'autre côté d'un lac ne sera jamais miné, et chaque
///    colon désœuvré recalculerait son chemin vers lui à chaque tick.
///
/// Mesuré : sans eux, la campagne de six graines × 30 jours passait de 63 s à
/// 246 s, une graine à elle seule prenant 213 s.
fn designate_rocks(sim: &Sim, cmds: &mut Vec<Command>, at: (i32, i32), want_ore: bool, max: usize) {
    let from = (at.0.max(0) as u32, at.1.max(0) as u32);
    let wanted = if want_ore {
        Feature::OreRock
    } else {
        Feature::Rock
    };
    let mut found: Vec<(u32, u32, u32)> = Vec::new();
    let mut pending = 0usize;
    for y in at.1 - MINE_RADIUS..=at.1 + MINE_RADIUS {
        for x in at.0 - MINE_RADIUS..=at.0 + MINE_RADIUS {
            if !sim.map().in_bounds(x, y) {
                continue;
            }
            let (ux, uy) = (x as u32, y as u32);
            if sim.map().designation(ux, uy) == Designation::Mine {
                pending += 1;
                continue;
            }
            if sim.map().feature(ux, uy) != wanted
                || sim.map().designation(ux, uy) != Designation::None
            {
                continue;
            }
            found.push((chebyshev((ux, uy), from), ux, uy));
        }
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

/// Rochers éprouvés avant de renoncer : chaque essai coûte un A\*, comme pour
/// le gibier (`WILD_CANDIDATES`).
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
        if sim.map().passable(nx, ny) && reachable(sim, from, (nx, ny)) {
            return true;
        }
    }
    false
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
/// voulues. Les candidates sont triées par `(distance, id)` — jamais « la
/// première trouvée » — et les `WILD_CANDIDATES` premières sont éprouvées dans
/// cet ordre.
fn nearest_wild(sim: &Sim, at: (i32, i32), species: &[Species]) -> Option<u32> {
    let from = (at.0.max(0) as u32, at.1.max(0) as u32);
    let mut candidates: Vec<(u32, u32, (u32, u32))> = sim
        .pawns()
        .iter()
        .filter(|p| p.faction == Faction::Animal && p.is_alive() && !p.hunted && !p.tame_marked)
        .filter(|p| p.species.is_some_and(|s| species.contains(&s)))
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
        if sim.map().forge_count() == 0 {
            if stored[ItemKind::Stone as usize] < STONE_FOR_FORGE {
                designate_rocks(sim, &mut cmds, (ax, ay), false, ROCKS_PER_PASS);
            } else {
                build_free(
                    sim,
                    &mut cmds,
                    BuildKind::Forge,
                    &[(ax + 3, ay + 3), (ax + 4, ay + 3), (ax + 3, ay + 4)],
                    1,
                );
            }
        } else {
            // Forge debout : on ne creuse plus que les veines, et on demande
            // de quoi armer la colonie — les lingots d'abord, l'épée suit.
            designate_rocks(sim, &mut cmds, (ax, ay), true, ROCKS_PER_PASS);
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
    if sim.craft_targets()[ItemKind::Bow as usize] != n {
        cmds.push(Command::SetCraftTarget {
            kind: ItemKind::Bow,
            target: n,
        });
    }
    if sim.season() == Season::Autumn && sim.craft_targets()[ItemKind::Tunic as usize] != n {
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
        if let Some(animal) = nearest_wild(sim, (ax, ay), &[Species::Rabbit, Species::Deer]) {
            cmds.push(Command::Hunt { animal, on: true });
        }
    }
    if day >= TAME_DAY
        && stored[ItemKind::Berries as usize] >= TAME_BERRIES
        && sim.livestock_count() == 0
        && !sim.pawns().iter().any(|p| p.tame_marked && p.is_alive())
        && let Some(animal) = nearest_wild(sim, (ax, ay), &[Species::Rabbit])
    {
        cmds.push(Command::Tame { animal, on: true });
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

fn print_table(runs: &[Run]) {
    println!(
        "{:>6} {:>4} {:>4} {:>4} {:>6} {:>5} {:>5} {:>4} {:>4} {:>4} {:>4} {:>4} {:>4} {:>6} {:>6} {:>5} {:>9} {:>6} {:>7} {:>7} {:>5} {:>6} {:>6} {:>6} {:>8} {:>7}",
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
        "humeur",
        "chantier",
        "ms"
    );
    for r in runs {
        println!(
            "{:>6} {:>4} {:>4} {:>4} {:>6} {:>5} {:>5} {:>4} {:>4} {:>4} {:>4} {:>4} {:>4} {:>6} {:>6} {:>5} {:>9} {:>6} {:>7} {:>7} {:>5} {:>6} {:>6} {:>6} {:>8} {:>7}",
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
        "  bétail                 : moyenne {} — au moins une bête : {}/{n}",
        tenths(mean_tenths(runs.iter().map(|r| u64::from(r.livestock)), n)),
        runs.iter().filter(|r| r.livestock > 0).count(),
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
        println!(
            "    {{\"seed\": {}, \"colonists_end\": {}, \"colonists_day10\": {}, \"colonists_day20\": {}, \"deaths\": {{{}}}, \"raids\": {}, \"raiders\": {}, \"raids_repelled\": {}, \"wealth\": {}, \"food_days_tenths\": {}, \"techs\": {}, \"livestock\": {}, \"fires\": {}, \"burned_tiles\": {}, \"mood_percent\": {}, \"armed\": {}, \"blueprints_left\": {}, \"lost_events\": {}, \"deaths_announced\": {}, \"elapsed_ms\": {}}}{comma}",
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
bois avec porte et pièges, établi de recherche, arcs puis tuniques, chasse
quand la viande manque, apprivoisement, troc de vivres et tribut aux tribus
hostiles. Il ne pilote aucun combat et ne soigne personne à la main.

Affiche une ligne par graine (colons vivants en fin et aux jours 10 et 20,
morts par cause déduite, raids reçus et repoussés, richesse, technologies,
jours de vivres, bétail, incendies) puis un résumé. Sort toujours en 0 : c'est
une mesure, pas un test.
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

        // La pierre rentrée, la forge se plante et les objectifs suivent.
        let (ax, ay) = anchor(&s).expect("repère");
        s.spawn_item(
            ItemKind::Stone,
            STONE_FOR_FORGE + 5,
            (ax + 2) as u32,
            (ay + 2) as u32,
        );
        let cmds = plan(&s);
        assert!(
            has_build(&cmds, BuildKind::Forge),
            "pas de forge : {cmds:?}"
        );
        s.step(&cmds);
        s.map_mut()
            .set_feature((ax + 3) as u32, (ay + 3) as u32, Feature::Forge);
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
