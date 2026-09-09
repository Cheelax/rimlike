//! Le biome de la case du globe décide de la composition de la carte.
//!
//! Trois choses à prouver, dans cet ordre :
//!
//! 1. la carte **tempérée** est celle d'avant l'arrivée des biomes, octet pour
//!    octet — c'est la garantie que la bascule n'a rien changé au bruit ;
//! 2. chaque biome a une **signature** mesurable : le désert est sableux, la
//!    jungle est impénétrable, la toundra est blanche ;
//! 3. quel que soit le biome, une colonie y trouve de quoi jouer.

use sim::{Biome, Feature, MIN_ROCKS, MIN_TREES, MIN_WATER, Map, Sim, Terrain};

/// Empreinte des deux couches qui définissent une carte : le sol et les
/// éléments. Le reste (zones, désignations, feu) est vide à la génération.
fn fingerprint(m: &Map) -> u64 {
    let mut bytes = Vec::new();
    bytes.extend_from_slice(m.tiles());
    bytes.extend_from_slice(m.features());
    sim::hash::fnv1a64(&bytes)
}

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

/// Cases franchissables atteignables depuis le centre de la carte, mêmes règles
/// que `path::find_path` : huit directions, jamais de coupe de coin. Recalculé
/// ici plutôt que lu dans le sim : un test ne doit pas croire la mesure de ce
/// qu'il mesure.
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

/// Ce qu'une colonie posée au centre peut atteindre : arbres, rochers, et le
/// nombre de cases où elle peut marcher.
struct Reach {
    trees: u32,
    rocks: u32,
    open: u32,
}

fn reach(m: &Map) -> Reach {
    let seen = reachable(m);
    let touches = |x: u32, y: u32| {
        DIRS.iter().any(|&(dx, dy)| {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            m.in_bounds(nx, ny) && seen[m.index(nx as u32, ny as u32)]
        })
    };
    let mut trees = 0;
    let mut rocks = 0;
    for y in 0..m.height() {
        for x in 0..m.width() {
            let f = m.feature(x, y);
            if (f == Feature::Tree || f.is_rock()) && touches(x, y) {
                if f == Feature::Tree {
                    trees += 1;
                } else {
                    rocks += 1;
                }
            }
        }
    }
    // La **terre** atteignable, l'eau retirée : c'est la borne que
    // `Map::ensure_resources` s'impose (on ne plante rien dans un lac).
    let open = (0..seen.len())
        .filter(|&i| seen[i] && !Terrain::from_u8(m.tiles()[i]).is_water())
        .count() as u32;
    Reach { trees, rocks, open }
}

/// Parts pour mille des sols et des éléments d'une carte.
#[derive(Clone, Copy, Default)]
struct Mix {
    trees: u32,
    bushes: u32,
    rocks: u32,
    ore: u32,
    sand: u32,
    snow: u32,
    grass: u32,
    water: u32,
}

fn mix(m: &Map) -> Mix {
    let mut c = Mix::default();
    for y in 0..m.height() {
        for x in 0..m.width() {
            let f = m.feature(x, y);
            if f == Feature::Tree {
                c.trees += 1;
            } else if f == Feature::Bush {
                c.bushes += 1;
            } else if f.is_rock() {
                c.rocks += 1;
                if f == Feature::OreRock {
                    c.ore += 1;
                }
            }
            match m.get(x, y) {
                Terrain::Sand => c.sand += 1,
                Terrain::Snow => c.snow += 1,
                Terrain::Grass => c.grass += 1,
                t if t.is_water() => c.water += 1,
                _ => {}
            }
        }
    }
    let n = m.width() * m.height();
    let per_mille = |v: u32| v * 1000 / n;
    Mix {
        trees: per_mille(c.trees),
        bushes: per_mille(c.bushes),
        rocks: per_mille(c.rocks),
        ore: per_mille(c.ore),
        sand: per_mille(c.sand),
        snow: per_mille(c.snow),
        grass: per_mille(c.grass),
        water: per_mille(c.water),
    }
}

/// La génération **d'avant l'arrivée des biomes**, recopiée telle quelle :
/// seuils d'élévation 92 / 104 / 114 / 184 / 204, humidité 96 et 150, dés
/// 18/21 puis 5/7 puis 1, un rocher sur `ORE_IN_ROCKS` veiné. C'est le témoin
/// de la tranche : la table `biome::TEMPERATE` doit retomber exactement
/// là-dessus.
///
/// Un témoin recopié vaut mieux qu'une empreinte gelée : il dit *ce* qui ne
/// doit pas changer, et il se compare sur autant de graines et de tailles qu'on
/// veut.
fn legacy_layers(seed: u64, width: u32, height: u32) -> (Vec<u8>, Vec<u8>) {
    use sim::noise;
    const ORE_SEED_SALT: u64 = 0x0FE5_1CA1_0FE5_1CA1;
    let moisture_seed = seed ^ 0x77AA_1234_5678_9ABC;
    let n = (width * height) as usize;
    let mut tiles = Vec::with_capacity(n);
    let mut features = Vec::with_capacity(n);
    for y in 0..height as i32 {
        for x in 0..width as i32 {
            let elevation = noise::fbm3(seed, x, y, 32);
            let moisture = noise::fbm3(moisture_seed, x, y, 32);
            let dice = noise::scatter(seed, x, y) % 100;
            let (t, f) = if elevation < 92 {
                (Terrain::DeepWater, Feature::None)
            } else if elevation < 104 {
                (Terrain::ShallowWater, Feature::None)
            } else if elevation < 114 {
                (Terrain::Sand, Feature::None)
            } else if elevation < 184 {
                if moisture > 150 {
                    let f = if dice < 18 {
                        Feature::Tree
                    } else if dice < 21 {
                        Feature::Bush
                    } else {
                        Feature::None
                    };
                    (Terrain::Grass, f)
                } else if moisture > 96 {
                    let f = if dice < 5 {
                        Feature::Tree
                    } else if dice < 7 {
                        Feature::Bush
                    } else {
                        Feature::None
                    };
                    (Terrain::Grass, f)
                } else {
                    (
                        Terrain::Dirt,
                        if dice < 1 {
                            Feature::Tree
                        } else {
                            Feature::None
                        },
                    )
                }
            } else if elevation < 204 {
                (Terrain::Gravel, Feature::None)
            } else if noise::scatter(seed ^ ORE_SEED_SALT, x, y) % sim::map::ORE_IN_ROCKS == 0 {
                (Terrain::Gravel, Feature::OreRock)
            } else {
                (Terrain::Gravel, Feature::Rock)
            };
            tiles.push(t as u8);
            features.push(f as u8);
        }
    }
    (tiles, features)
}

/// Graines et tailles du témoin : celles des tests du dépôt, plus les tailles
/// jouées (64, 96, 128) et deux dégénérées (1×1, 3×5).
const WITNESS: [(u64, u32, u32); 12] = [
    (1, 1, 1),
    (7, 3, 5),
    (1, 16, 16),
    (1, 24, 24),
    (3, 32, 32),
    (99, 48, 48),
    (7, 64, 64),
    (42, 64, 64),
    (11, 96, 96),
    (5, 128, 128),
    (0xDEAD_BEEF, 64, 64),
    (u64::MAX, 32, 32),
];

#[test]
fn temperate_generation_is_bit_identical_to_before() {
    for (seed, w, h) in WITNESS {
        let (tiles, features) = legacy_layers(seed, w, h);
        let bare = Map::generate_bare(seed, w, h, Biome::TemperateForest);
        assert_eq!(
            bare.tiles(),
            tiles.as_slice(),
            "sols tempérés différents (graine {seed}, {w}x{h})"
        );
        assert_eq!(
            bare.features(),
            features.as_slice(),
            "éléments tempérés différents (graine {seed}, {w}x{h})"
        );
        // L'océan et un octet inconnu retombent sur la même carte.
        for fallback in [Biome::Ocean, Biome::from_u8(200)] {
            assert_eq!(
                fingerprint(&Map::generate_bare(seed, w, h, fallback)),
                fingerprint(&bare),
                "{} ne retombe pas sur le tempéré",
                fallback.name()
            );
        }
    }
}

/// Les cartes tempérées que le plancher de ressources ne touche pas restent
/// celles d'avant **de bout en bout**, `Sim::new` compris : ces empreintes ont
/// été relevées sur le code d'avant la tranche.
///
/// Trois des huit cartes relevées, elles, ont changé — et c'est voulu : le
/// bruit tempéré y laissait la colonie sans un rocher atteignable (mesuré sur
/// 40 graines × 7 tailles : le pire cas est *zéro* rocher à **toutes** les
/// tailles). Voir `MIN_ROCKS`.
const TEMPERATE_UNTOUCHED: [(u64, u32, u32, u64); 5] = [
    (3, 32, 32, 0x1262_9591_af27_6533),
    (7, 64, 64, 0x2428_cf35_a6fd_b633),
    (42, 64, 64, 0xcd57_ed4e_25ec_5e35),
    (11, 96, 96, 0x4856_5faf_17ed_b583),
    (1, 1, 1, 0x0832_8807_b4eb_6fed),
];

#[test]
fn untouched_temperate_maps_keep_their_fingerprint() {
    for (seed, w, h, want) in TEMPERATE_UNTOUCHED {
        let s = Sim::new(seed, w, h);
        assert_eq!(
            fingerprint(s.map()),
            want, // TEMP
            "la carte de Sim::new a bougé (graine {seed}, {w}x{h})"
        );
    }
}

/// `Sim::new` reste tempéré, et `Sim::new_in_biome` avec le tempéré lui est
/// identique — carte comprise, plancher de ressources compris.
#[test]
fn sim_new_is_the_temperate_biome() {
    for (seed, w, h) in WITNESS {
        let a = Sim::new(seed, w, h);
        let b = Sim::new_in_biome(seed, w, h, Biome::TemperateForest);
        assert_eq!(a.biome(), Biome::TemperateForest);
        assert_eq!(fingerprint(a.map()), fingerprint(b.map()));
        assert_eq!(a.state_hash(), b.state_hash());
    }
}

/// Fourchettes **mesurées** sur huit graines en 64×64, en pour mille de la
/// carte (voir le tableau du rapport de tranche). Elles sont larges à dessein :
/// le bruit d'élévation change beaucoup d'une graine à l'autre — la part d'eau
/// d'une carte tempérée va de 61 à 646 pour mille selon la graine — et le test
/// doit dire « le désert est sableux et sans arbres », pas « le désert a 895
/// pour mille de sable ». Une table retouchée doit rester dedans ; sinon c'est
/// que le biome a changé de nature, et il faut le dire.
#[test]
fn each_biome_has_its_signature() {
    for seed in 1..=8u64 {
        for b in Biome::ALL {
            let m = mix(&Map::generate_bare(seed, 64, 64, b));
            let who = format!("{} (graine {seed})", b.name());
            match b.for_colony() {
                Biome::TemperateForest => {
                    assert!((10..=80).contains(&m.trees), "{who} : arbres {}", m.trees);
                    assert!(m.sand < 250, "{who} : sable {}", m.sand);
                    assert!(m.snow == 0, "{who} : neige {}", m.snow);
                    assert!(m.grass > 150, "{who} : herbe {}", m.grass);
                }
                Biome::Ice => {
                    assert!(m.snow > 900, "{who} : neige {}", m.snow);
                    // La table est à zéro : la calotte n'a pas un arbre. Ceux
                    // que la colonie trouvera viennent du bosquet forcé.
                    assert!(m.trees == 0, "{who} : arbres {}", m.trees);
                    assert!(m.bushes == 0, "{who} : buissons {}", m.bushes);
                    assert!(m.grass == 0, "{who} : herbe {}", m.grass);
                }
                Biome::Tundra => {
                    assert!(m.snow > 900, "{who} : neige {}", m.snow);
                    assert!(m.trees < 30, "{who} : arbres {}", m.trees);
                    assert!(m.sand == 0, "{who} : sable {}", m.sand);
                }
                Biome::BorealForest => {
                    assert!(m.trees > 90, "{who} : arbres {}", m.trees);
                    assert!(m.snow == 0, "{who} : neige {}", m.snow);
                    assert!(m.bushes > 10, "{who} : buissons {}", m.bushes);
                }
                Biome::Grassland => {
                    assert!((20..=90).contains(&m.trees), "{who} : arbres {}", m.trees);
                    assert!(m.grass > 250, "{who} : herbe {}", m.grass);
                    assert!(m.bushes > 15, "{who} : buissons {}", m.bushes);
                }
                Biome::Desert => {
                    assert!(m.sand > 700, "{who} : sable {}", m.sand);
                    assert!(m.trees == 0, "{who} : arbres {}", m.trees);
                    assert!(m.bushes == 0, "{who} : buissons {}", m.bushes);
                    assert!(m.water < 100, "{who} : eau {}", m.water);
                }
                Biome::Savanna => {
                    assert!(m.grass > 300, "{who} : herbe {}", m.grass);
                    assert!((10..=60).contains(&m.trees), "{who} : arbres {}", m.trees);
                    assert!(m.bushes > 15, "{who} : buissons {}", m.bushes);
                }
                Biome::Jungle => {
                    assert!(m.trees > 450, "{who} : arbres {}", m.trees);
                    assert!(m.bushes > 70, "{who} : buissons {}", m.bushes);
                    assert!(m.rocks < 20, "{who} : rochers {}", m.rocks);
                }
                Biome::Mountain => {
                    assert!(m.rocks > 70, "{who} : rochers {}", m.rocks);
                    assert!(m.ore > 25, "{who} : veines {}", m.ore);
                }
                Biome::Ocean => unreachable!("l'océan retombe sur le tempéré"),
            }
        }
    }
}

/// Le même bruit, des seuils différents : à graine égale, les biomes se
/// classent toujours dans le même ordre. C'est la mesure la plus solide qu'on
/// puisse écrire ici — elle ne dépend pas de la forme du bruit d'une graine,
/// seulement de la table.
#[test]
fn biomes_rank_the_same_way_on_every_seed() {
    for seed in 1..=8u64 {
        let of = |b: Biome| mix(&Map::generate_bare(seed, 64, 64, b));
        let temperate = of(Biome::TemperateForest);
        let (jungle, boreal) = (of(Biome::Jungle), of(Biome::BorealForest));
        let (desert, tundra) = (of(Biome::Desert), of(Biome::Tundra));
        let (mountain, savanna) = (of(Biome::Mountain), of(Biome::Savanna));
        let grassland = of(Biome::Grassland);
        // La forêt : jungle > taïga > tempéré.
        assert!(jungle.trees > boreal.trees, "graine {seed}");
        assert!(boreal.trees > temperate.trees, "graine {seed}");
        // Les buissons : la prairie et la savane en portent plus que la forêt.
        assert!(grassland.bushes > temperate.bushes, "graine {seed}");
        assert!(savanna.bushes > temperate.bushes, "graine {seed}");
        // Le sable : le désert en couvre tout.
        assert!(desert.sand > temperate.sand, "graine {seed}");
        // La roche : la montagne écrase tout, la jungle n'en a presque pas.
        assert!(mountain.rocks > temperate.rocks, "graine {seed}");
        assert!(mountain.ore > temperate.ore, "graine {seed}");
        assert!(jungle.rocks <= temperate.rocks, "graine {seed}");
        // L'eau : le désert est sec, la jungle est noyée.
        assert!(desert.water <= temperate.water, "graine {seed}");
        // La neige : deux biomes en portent, les autres jamais.
        assert!(tundra.snow > 0 && temperate.snow == 0, "graine {seed}");
    }
}

/// Deux biomes ne rendent jamais la même carte : la signature n'est pas un
/// décor, elle change ce que la colonie a sous les pieds.
#[test]
fn biomes_differ_from_one_another() {
    let prints: Vec<u64> = Biome::ALL
        .iter()
        .map(|&b| fingerprint(&Map::generate_bare(3, 48, 48, b)))
        .collect();
    for (i, a) in Biome::ALL.iter().enumerate() {
        for (k, b) in Biome::ALL.iter().enumerate().skip(i + 1) {
            // Sauf l'océan, qui **est** le tempéré.
            if a.for_colony() == b.for_colony() {
                assert_eq!(prints[i], prints[k]);
            } else {
                assert_ne!(
                    prints[i],
                    prints[k],
                    "{} et {} rendent la même carte",
                    a.name(),
                    b.name()
                );
            }
        }
    }
}

/// Le plancher de jouabilité, sur tous les biomes et plusieurs tailles : des
/// arbres et des rochers atteignables depuis le centre, de l'eau sur la carte,
/// et trois colons posés sur du sol franchissable.
#[test]
fn every_biome_keeps_a_colony_playable() {
    for &(w, h) in &[(48u32, 48u32), (64, 64), (96, 96)] {
        for seed in 1..=5u64 {
            for b in Biome::ALL {
                let s = Sim::new_in_biome(seed, w, h, b);
                let m = s.map();
                let r = reach(m);
                let who = format!("{} (graine {seed}, {w}x{h})", b.name());
                // La promesse est bornée par la place : voir
                // `Map::ensure_resources` (`MIN_OPEN`, `OPEN_PER_TREE`,
                // `OPEN_PER_ROCK`). En dessous de 64 cases atteignables, la
                // carte ne promet rien : la colonie tient sur un îlot.
                if r.open < 64 {
                    continue;
                }
                assert!(
                    r.trees >= MIN_TREES.min(r.open / 48),
                    "{who} : {} arbres atteignables sur {} cases ouvertes",
                    r.trees,
                    r.open
                );
                assert!(
                    r.rocks >= MIN_ROCKS.min(r.open / 96),
                    "{who} : {} rochers atteignables sur {} cases ouvertes",
                    r.rocks,
                    r.open
                );
                let water = m
                    .tiles()
                    .iter()
                    .filter(|&&t| Terrain::from_u8(t).is_water())
                    .count() as u32;
                assert!(water >= MIN_WATER, "{who} : {water} cases d'eau");
                let colonists: Vec<_> = s.pawns().iter().filter(|p| p.is_colonist()).collect();
                assert_eq!(colonists.len(), 3, "{who} : {} colons", colonists.len());
                for p in colonists {
                    let (x, y) = p.tile();
                    assert!(m.passable(x, y), "{who} : un colon posé dans un mur");
                }
            }
        }
    }
}

/// Le biome voyage dans le snapshot : une colonie relue se souvient d'où elle
/// est, et le hash en dépend (deux salles sur des biomes différents ne peuvent
/// pas se croire d'accord).
#[test]
fn biome_survives_snapshot() {
    for b in Biome::ALL {
        let mut s = Sim::new_in_biome(9, 32, 32, b);
        s.step(&[]);
        let restored = Sim::restore(&s.snapshot()).expect("snapshot relisible");
        assert_eq!(restored.biome(), b.for_colony(), "{}", b.name());
        assert_eq!(restored.biome(), s.biome());
        assert_eq!(restored.state_hash(), s.state_hash());
        assert_eq!(restored, s);
    }
    let a = Sim::new_in_biome(9, 32, 32, Biome::Desert);
    let b = Sim::new_in_biome(9, 32, 32, Biome::Jungle);
    assert_ne!(a.state_hash(), b.state_hash());
}

/// Un octet de biome inconnu — vieux client, trame bricolée, valeur ajoutée
/// côté monde et pas encore ici — ne fait pas échouer une partie : il donne la
/// carte tempérée, et `Sim::biome()` le dit.
#[test]
fn unknown_biome_falls_back_to_temperate() {
    for raw in [10u8, 11, 42, 200, 255] {
        let s = Sim::new_in_biome(4, 32, 32, Biome::from_u8(raw));
        assert_eq!(s.biome(), Biome::TemperateForest, "octet {raw}");
        assert_eq!(
            fingerprint(s.map()),
            fingerprint(Sim::new(4, 32, 32).map()),
            "octet {raw}"
        );
    }
    // L'océan est un biome valide du globe, mais jamais une carte de colonie.
    let sea = Sim::new_in_biome(4, 32, 32, Biome::Ocean);
    assert_eq!(sea.biome(), Biome::TemperateForest);
    assert_eq!(sea.state_hash(), Sim::new(4, 32, 32).state_hash());
}

/// Une carte de biome se joue : dix jours sur chaque biome, sans panique, et
/// deux sims nourries des mêmes entrées restent d'accord (le déterminisme ne
/// dépend pas du biome).
#[test]
fn every_biome_plays_and_stays_deterministic() {
    for b in Biome::ALL {
        let mut a = Sim::new_in_biome(2, 48, 48, b);
        let mut c = Sim::new_in_biome(2, 48, 48, b);
        for _ in 0..2_000 {
            a.step(&[]);
            c.step(&[]);
        }
        assert_eq!(a.state_hash(), c.state_hash(), "{}", b.name());
    }
}

/// La neige de départ est un **sol**, pas une météo : elle ne fond pas, aucune
/// carte tempérée n'en porte, et rien n'y pousse (voir `Map::is_soil`, et
/// `climate.rs` qui ne pose jamais de neige au sol — sous `FREEZING` il change
/// la pluie en `Weather::Snow`, et c'est tout).
#[test]
fn snow_is_a_ground_not_a_weather() {
    let cold = Sim::new_in_biome(1, 48, 48, Biome::Tundra);
    let mild = Sim::new_in_biome(1, 48, 48, Biome::TemperateForest);
    assert!(mix(cold.map()).snow > 800);
    assert_eq!(mix(mild.map()).snow, 0);
    let m = cold.map();
    let mut checked = false;
    for y in 0..m.height() {
        for x in 0..m.width() {
            if m.get(x, y) == Terrain::Snow {
                assert!(m.passable(x, y) || !m.feature(x, y).passable());
                assert!(!m.is_soil(x, y), "on ne cultive pas la neige");
                checked = true;
            }
        }
    }
    assert!(checked, "aucune case enneigée trouvée");
}

/// **Le relevé qui a servi à écrire les fourchettes ci-dessus.** Ignoré par
/// défaut (il n'affirme rien, il mesure) : `cargo test -p sim --test biomes
/// measure -- --ignored --nocapture`.
///
/// Il est gardé parce qu'une table retouchée se recalibre avec, et pas à
/// l'intuition (voir `AGENTS.md`, « on mesure avant de régler »).
#[test]
#[ignore]
fn measure() {
    for b in Biome::ALL {
        let mut lo = [u32::MAX; 8];
        let mut hi = [0u32; 8];
        let mut r_lo = (u32::MAX, u32::MAX, u32::MAX);
        for seed in 1..=8u64 {
            let bare = Map::generate_bare(seed, 64, 64, b);
            let m = mix(&bare);
            let v = [
                m.trees, m.bushes, m.rocks, m.ore, m.sand, m.snow, m.grass, m.water,
            ];
            for i in 0..8 {
                lo[i] = lo[i].min(v[i]);
                hi[i] = hi[i].max(v[i]);
            }
            let r = reach(Sim::new_in_biome(seed, 64, 64, b).map());
            r_lo = (r_lo.0.min(r.trees), r_lo.1.min(r.rocks), r_lo.2.min(r.open));
        }
        println!(
            "{:16} arbres {}-{} buiss {}-{} roch {}-{} veine {}-{} sable {}-{} neige {}-{} herbe {}-{} eau {}-{} | min atteign t={} r={} terre={}",
            b.name(),
            lo[0],
            hi[0],
            lo[1],
            hi[1],
            lo[2],
            hi[2],
            lo[3],
            hi[3],
            lo[4],
            hi[4],
            lo[5],
            hi[5],
            lo[6],
            hi[6],
            lo[7],
            hi[7],
            r_lo.0,
            r_lo.1,
            r_lo.2
        );
    }
}

/// Combien de cartes tempérées le plancher de ressources complète, par taille,
/// sur quarante graines. Même usage que `measure` : c'est le relevé, pas une
/// affirmation.
///
/// Relevé le 2026-09-07 : 29/40 en 16×16, 37/40 en 24×24, 36/40 en 32×32,
/// 32/40 en 48×48, 23/40 en 64×64, 15/40 en 96×96, 8/40 en 128×128. C'est
/// beaucoup, et c'est presque toujours la **pierre** : le bruit tempéré laisse
/// souvent la région du centre sans un rocher à miner (voir `MIN_ROCKS`), et
/// une colonie sans pierre ne peut ni forger ni enterrer ses morts.
///
/// Le même relevé compte les cartes où la carte ne promet **rien**, faute de
/// place : 1/40 en 64×64, 0/40 au-delà, mais 8/40 en 16×16 — la colonie y tient
/// sur un îlot cerné d'eau. C'est un défaut antérieur à cette tranche (rien
/// n'empêche `Sim::spawn_starting_pawns` de poser trois colons sur un banc de
/// sable), et le serveur monde a de son côté à ne pas proposer une telle case.
#[test]
#[ignore]
fn measure_floor_impact() {
    for size in [16u32, 24, 32, 48, 64, 96, 128] {
        let mut touched = 0;
        let mut islets = 0;
        let mut which = Vec::new();
        for seed in 1..=40u64 {
            let mut rng = sim::Rng::new(seed);
            let map_seed = rng.next_u64();
            let bare = Map::generate_bare(map_seed, size, size, Biome::TemperateForest);
            let real = Sim::new(seed, size, size);
            if fingerprint(&bare) != fingerprint(real.map()) {
                touched += 1;
                if which.len() < 6 {
                    which.push(seed);
                }
            }
            // Cartes où la carte ne promet rien : moins de 64 cases de terre
            // atteignables depuis le centre (voir `MIN_OPEN`).
            if reach(real.map()).open < 64 {
                islets += 1;
            }
        }
        println!(
            "{size}x{size} : {touched}/40 cartes tempérées complétées {which:?}, {islets}/40 îlots"
        );
    }
}

/// Le seul changement d'état de la tranche est l'octet de biome, ajouté **en
/// fin** de `Sim`.
///
/// La preuve : pour les cartes tempérées que le plancher de ressources ne
/// touche pas, le snapshot d'aujourd'hui privé de son dernier octet a
/// exactement le hash relevé avant la tranche. Rien d'autre n'a bougé dans
/// l'état — ni un champ, ni un ordre, ni un tirage.
#[test]
fn only_the_biome_byte_was_added_to_the_state() {
    // (graine, largeur, hauteur, hash d'état relevé avant la tranche)
    for (seed, w, h, before) in [
        (3u64, 32u32, 32u32, 0xb5c9_796d_d239_6660u64),
        (7, 64, 64, 0x33b3_ebbc_818c_7d61),
        (42, 64, 64, 0xe766_8422_3d11_0ed7),
        (11, 96, 96, 0xf25c_9cd2_2aa1_d1d1),
        (1, 1, 1, 0xad54_5a7d_3cb5_cd96),
    ] {
        let s = Sim::new(seed, w, h);
        let bytes = s.snapshot();
        let (head, tail) = bytes.split_at(bytes.len() - 1);
        assert_eq!(
            tail,
            [Biome::TemperateForest as u8],
            "le dernier octet du snapshot n'est pas le biome (graine {seed})"
        );
        assert_eq!(
            sim::hash::fnv1a64(head),
            before,
            "l'état a changé ailleurs que dans l'octet de biome (graine {seed}, {w}x{h})"
        );
    }
}

/// **Les hardes des biomes à 1000 ne bougent pas.** Empreinte d'état après six
/// jours joués sans une seule commande, sur une graine tempérée et une graine
/// de toundra en 48×48.
///
/// Six jours, parce que la cadence des hardes est de deux à quatre jours
/// (`storyteller.rs`, `next_herd_at`) : la fenêtre en contient deux, plus la
/// première (`Sim::schedule_first_herd`, le lendemain). Tout ce que
/// `BiomeTable::game_density` met à l'échelle passe donc dedans, et l'empreinte
/// le dirait.
///
/// Les valeurs sont relevées le 2026-09-09 sur `main` à `656c2c0`, **avant** la
/// tranche du gibier de la banquise : c'est la preuve que l'entrée nouvelle de
/// la table, à 1000 partout ailleurs, ne change ni le nombre ni l'ordre des
/// tirages des autres biomes.
#[test]
fn the_other_biomes_draw_the_same_herds() {
    for (biome, seed, want) in [
        (Biome::TemperateForest, 5u64, 0x2cfd_cf37_5ca7_51cau64),
        (Biome::Tundra, 5, 0xae9d_b4a0_1cb9_98d6),
    ] {
        let mut s = Sim::new_in_biome(seed, 48, 48, biome);
        for _ in 0..6 * u64::from(sim::TICKS_PER_DAY) {
            s.step(&[]);
        }
        assert_eq!(
            s.state_hash(),
            want,
            "{} (graine {seed}) : six jours joués ne rendent plus la même partie",
            biome.name()
        );
    }
}
