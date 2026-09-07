//! Ce que le plancher de ressources ne doit **jamais** casser.
//!
//! `Map::ensure_resources` complète une carte pauvre (voir `MIN_TREES`,
//! `MIN_ROCKS`, `MIN_WATER`, `MIN_SOIL`). Deux promesses tiennent la jouabilité
//! de ce qu'il ajoute, et ce fichier ne prouve que celles-là :
//!
//! 1. **il n'enferme personne** : un arbre ou un rocher forcé ne coupe jamais
//!    la carte, donc ce que la colonie atteint depuis le centre ne perd que les
//!    cases posées, jamais un morceau de carte ;
//! 2. **il compte la pierre, pas le minerai** : `MIN_ROCKS` promet des rochers
//!    **ordinaires** (`Feature::Rock`), les seuls qui rendent de la pierre
//!    (`jobs::yield_of`) — une veine (`Feature::OreRock`) ne bâtit ni forge
//!    (20 pierre) ni tombe (5).
//!
//! Les deux défauts corrigés ici avaient une reproduction déterministe, et
//! chacune est devenue un test. Tout est recalculé sur place, jamais lu dans le
//! sim : un test ne doit pas croire la mesure de ce qu'il mesure.

use sim::{Biome, Feature, MIN_ROCKS, Map, Terrain};

/// Les huit voisins, dans l'ordre de l'A\*.
const DIRS: [(i32, i32); 8] = [
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (1, -1),
    (-1, 1),
    (-1, -1),
];

/// Cases franchissables atteignables depuis le centre, mêmes règles que
/// `path::find_path` : huit directions, jamais de coupe de coin.
fn reachable(m: &Map) -> Vec<bool> {
    let (w, h) = (m.width(), m.height());
    let mut seen = vec![false; (w * h) as usize];
    let Some(start) = m.nearest_passable(w / 2, h / 2) else {
        return seen;
    };
    seen[m.index(start.0, start.1)] = true;
    let mut stack = vec![start];
    while let Some((x, y)) = stack.pop() {
        for (dx, dy) in DIRS {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            if !m.in_bounds(nx, ny) {
                continue;
            }
            let (nx, ny) = (nx as u32, ny as u32);
            if seen[m.index(nx, ny)] || !m.passable(nx, ny) {
                continue;
            }
            if dx != 0 && dy != 0 && (!m.passable(x, ny) || !m.passable(nx, y)) {
                continue;
            }
            seen[m.index(nx, ny)] = true;
            stack.push((nx, ny));
        }
    }
    seen
}

/// **Terre** atteignable depuis le centre, l'eau retirée : la mesure de la
/// fiche, et la borne que `Map::ensure_resources` s'impose (on ne plante rien
/// dans un lac).
fn reachable_land(m: &Map) -> u32 {
    let seen = reachable(m);
    (0..seen.len())
        .filter(|&i| seen[i] && !Terrain::from_u8(m.tiles()[i]).is_water())
        .count() as u32
}

/// Cases atteignables, l'eau basse comprise : elle est franchissable, et c'est
/// la bonne question quand on cherche un obstacle — la mare forcée ne doit pas
/// se confondre avec un mur.
fn reachable_tiles(m: &Map) -> u32 {
    reachable(m).iter().filter(|&&s| s).count() as u32
}

/// Cases devenues infranchissables entre les deux cartes : exactement les
/// obstacles que le plancher a posés.
fn blockers_added(bare: &Map, full: &Map) -> u32 {
    let mut n = 0;
    for y in 0..bare.height() {
        for x in 0..bare.width() {
            if bare.passable(x, y) && !full.passable(x, y) {
                n += 1;
            }
        }
    }
    n
}

/// Rochers **ordinaires** bordés par une case atteignable : ceux dont un colon
/// peut tirer de la pierre. Les veines sont exclues exprès.
fn reachable_stone(m: &Map) -> u32 {
    let seen = reachable(m);
    let mut n = 0;
    for y in 0..m.height() {
        for x in 0..m.width() {
            if m.feature(x, y) != Feature::Rock {
                continue;
            }
            let touches = DIRS.iter().any(|&(dx, dy)| {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                m.in_bounds(nx, ny) && seen[m.index(nx as u32, ny as u32)]
            });
            if touches {
                n += 1;
            }
        }
    }
    n
}

/// La graine de carte d'une partie : `Sim::new_in_biome` la dérive du premier
/// tirage, pour que la génération de terrain et celle du jeu ne se décalent pas
/// l'une l'autre. Les deux reproductions de la fiche sont écrites avec des
/// graines de **partie** ; c'est par ici qu'on retrouve leur carte.
fn map_seed(seed: u64) -> u64 {
    sim::Rng::new(seed).next_u64()
}

/// La carte d'une partie, avant et après le plancher.
fn before_after(seed: u64, w: u32, h: u32, b: Biome) -> (Map, Map) {
    let s = map_seed(seed);
    (Map::generate_bare(s, w, h, b), Map::generate(s, w, h, b))
}

/// Les biomes qu'on peut fonder : tous sauf l'océan, qui retombe sur le tempéré
/// et ferait donc un doublon.
fn settleable() -> impl Iterator<Item = Biome> {
    Biome::ALL.into_iter().filter(|b| *b != Biome::Ocean)
}

/// Le balayage : 20 graines × 3 tailles × tous les biomes fondables, soit 540
/// cartes. Les tailles encadrent ce qui se joue — la minuscule où la garantie
/// est bornée par la place, et deux tailles courantes.
const SEEDS: std::ops::RangeInclusive<u64> = 1..=20;
const SIZES: [(u32, u32); 3] = [(16, 16), (48, 48), (64, 64)];

/// Cases de terre atteignable par rocher promis (`map::OPEN_PER_ROCK`, privé) :
/// la promesse est bornée par la place, comme dans
/// `biomes.rs::every_biome_keeps_a_colony_playable`.
const OPEN_PER_ROCK: u32 = 96;
/// En dessous de tant de cases de terre atteignable, la carte ne promet rien
/// (`map::MIN_OPEN`, privé) : la colonie tient sur un îlot.
const MIN_OPEN: u32 = 64;

/// **Reproduction du défaut de connexité.** Avec cette carte, l'affleurement
/// forcé tombait dans les couloirs d'une clairière de forêt boréale et faisait
/// passer la terre atteignable depuis le centre de 1 547 cases à **10** : les
/// trois colons naissaient murés, sans un arbre à couper.
///
/// La règle vérifiée est celle du contrat : dix obstacles posés retirent dix
/// cases, pas un morceau de carte.
#[test]
fn the_boreal_clearing_is_not_walled_in() {
    let (bare, full) = before_after(77, 48, 48, Biome::BorealForest);
    let posed = blockers_added(&bare, &full);
    assert_eq!(
        reachable_land(&bare),
        1_547,
        "la carte de la fiche a changé"
    );
    assert_eq!(posed, 10, "obstacles posés");
    assert_eq!(
        reachable_land(&full),
        1_547 - posed,
        "le plancher a retiré plus que ce qu'il a posé"
    );
}

/// **Reproduction du défaut de la pierre.** Cette carte de montagne offre 245
/// cases de terre atteignable et quatre **veines** autour du centre — et pas un
/// rocher ordinaire. Le plancher s'en croyait quitte : les veines ne rendent
/// que du minerai, la colonie n'avait donc ni forge ni tombe possibles.
#[test]
fn ore_veins_do_not_pass_for_stone() {
    let (bare, full) = before_after(439, 16, 16, Biome::Mountain);
    let veins = (0..bare.width() * bare.height())
        .filter(|&i| Feature::from_u8(bare.features()[i as usize]) == Feature::OreRock)
        .count();
    assert!(veins >= 4, "la carte de la fiche a changé : {veins} veines");
    let open = reachable_land(&bare);
    let want = MIN_ROCKS.min(open / OPEN_PER_ROCK);
    assert!(want > 0, "{open} cases de terre : la carte promet {want}");
    assert_eq!(reachable_stone(&bare), 0, "la carte de la fiche a changé");
    assert!(
        reachable_stone(&full) >= want,
        "{} rochers ordinaires atteignables pour {want} promis",
        reachable_stone(&full)
    );
}

/// Le contrat, sur 540 cartes : ce que le plancher ajoute ne retire de
/// l'atteignable que les cases qu'il pose.
///
/// **Mesuré** : la perte est nulle partout, jamais seulement bornée — chaque
/// obstacle est posé sur une case dont `Map::cuts_a_passage` démontre qu'elle
/// n'est pas un passage, et la mare comme le potager ne touchent pas à la
/// franchissabilité. Le test affirme l'inégalité, qui est la promesse.
#[test]
fn the_resource_floor_never_seals_a_map() {
    for (w, h) in SIZES {
        for seed in SEEDS {
            for b in settleable() {
                let (bare, full) = before_after(seed, w, h, b);
                let posed = blockers_added(&bare, &full);
                let before = reachable_tiles(&bare);
                let after = reachable_tiles(&full);
                assert!(
                    after + posed >= before,
                    "{} graine {seed} {w}x{h} : {before} cases atteignables, {after} après {posed} obstacles",
                    b.name(),
                );
            }
        }
    }
}

/// La promesse de pierre, sur les mêmes 540 cartes : au moins `MIN_ROCKS`
/// rochers **ordinaires** atteignables, bornés par la place comme le reste.
///
/// Le compte se fait sur la terre atteignable de la carte **d'avant** le
/// plancher, parce que c'est là-dessus que `Map::ensure_resources` calcule ce
/// qu'il promet.
#[test]
fn every_settleable_map_has_stone_within_reach() {
    for (w, h) in SIZES {
        for seed in SEEDS {
            for b in settleable() {
                let (bare, full) = before_after(seed, w, h, b);
                let open = reachable_land(&bare);
                // En dessous, la carte ne promet rien : voir `MIN_OPEN`.
                if open < MIN_OPEN {
                    continue;
                }
                let want = MIN_ROCKS.min(open / OPEN_PER_ROCK);
                assert!(
                    reachable_stone(&full) >= want,
                    "{} graine {seed} {w}x{h} : {} rochers ordinaires atteignables pour {want} promis sur {open} cases de terre",
                    b.name(),
                    reachable_stone(&full),
                );
            }
        }
    }
}

/// **Le relevé qui a servi à écrire les deux tests ci-dessus.** Ignoré par
/// défaut (il n'affirme rien, il mesure) :
/// `cargo test -p sim --release --test playability measure -- --ignored --nocapture`.
///
/// Relevé le 2026-09-07, après correction : pire perte d'atteignabilité 0 case
/// sur les 540 cartes, pire manque de pierre 0 rocher. Avant correction : la
/// forêt boréale (graine 77, 48×48) perdait 1 537 cases, et la banquise
/// (graine 15, 48×48) n'offrait que 7 rochers ordinaires pour 10 promis — trois
/// veines suffisaient à la faire passer pour servie.
#[test]
#[ignore]
fn measure() {
    for (seed, w, h, b) in [
        (77u64, 48u32, 48u32, Biome::BorealForest),
        (439, 16, 16, Biome::Mountain),
        (15, 48, 48, Biome::Ice),
    ] {
        let (bare, full) = before_after(seed, w, h, b);
        println!(
            "{} graine {seed} {w}x{h} : atteignable {} -> {}, terre {} -> {}, obstacles posés {}, pierre atteignable {} pour {} promis",
            b.name(),
            reachable_tiles(&bare),
            reachable_tiles(&full),
            reachable_land(&bare),
            reachable_land(&full),
            blockers_added(&bare, &full),
            reachable_stone(&full),
            MIN_ROCKS.min(reachable_land(&bare) / OPEN_PER_ROCK),
        );
    }
    let mut worst_loss = (0i64, String::new());
    let mut worst_stone = (i64::MAX, String::new());
    for (w, h) in SIZES {
        for seed in SEEDS {
            for b in settleable() {
                let (bare, full) = before_after(seed, w, h, b);
                let posed = blockers_added(&bare, &full) as i64;
                let lost = reachable_tiles(&bare) as i64 - posed - reachable_tiles(&full) as i64;
                if lost > worst_loss.0 {
                    worst_loss = (lost, format!("{} graine {seed} {w}x{h}", b.name()));
                }
                let open = reachable_land(&bare);
                if open < MIN_OPEN {
                    continue;
                }
                let want = MIN_ROCKS.min(open / OPEN_PER_ROCK) as i64;
                let miss = reachable_stone(&full) as i64 - want;
                if miss < worst_stone.0 {
                    worst_stone = (
                        miss,
                        format!(
                            "{} graine {seed} {w}x{h} ({} pierre pour {want} promis)",
                            b.name(),
                            reachable_stone(&full)
                        ),
                    );
                }
            }
        }
    }
    println!(
        "pire perte d'atteignabilité : {} ({})",
        worst_loss.0, worst_loss.1
    );
    println!(
        "pire manque de pierre : {} ({})",
        worst_stone.0, worst_stone.1
    );
}
