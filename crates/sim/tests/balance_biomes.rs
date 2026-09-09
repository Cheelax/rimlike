//! Un biome doit rester **jouable**, pas seulement ressembler à lui-même.
//!
//! `tests/biomes.rs` prouve la signature d'une carte (le désert est sableux, la
//! jungle est impénétrable). Ce fichier-ci mesure autre chose : une colonie
//! posée dessus **peut-elle y manger** ? La question s'est posée pour le
//! désert, où la campagne éteignait 30 colonies sur 30 par famine (voir
//! `crates/sim-cli/CAMPAIGN-FINDINGS.md` §13).
//!
//! Ce n'est pas un doublon de la campagne, et ça ne la remplace pas : la
//! campagne joue des colonies entières en 64×64 sur trente jours avec un joueur
//! qui bâtit, forge et troque, et c'est elle qui porte le chiffre de référence
//! de l'équilibrage. Ce banc-ci joue un **joueur maigre** sur un petit format
//! (voir `SIZE`), pour que la famine — et elle seule — décide, et pour que le
//! tout tienne dans `cargo test`.
//!
//! La règle du dépôt s'applique ici comme partout : « on mesure avant de
//! régler » (`AGENTS.md`). Les relevés `#[ignore]` en bas de fichier sont ceux
//! qui ont servi à trancher entre les pistes ; ils sont gardés pour qu'une
//! retouche de `biome::DESERT` ou du plancher d'oasis se recalibre avec, et pas
//! à l'intuition.
//!
//! Le même critère vaut pour la toundra depuis le 2026-09-09 (§14 du rapport) :
//! elle passait pour injouable sur une mesure d'avant le correctif du plancher
//! qui murait les colonies, et elle survit en fait 19 fois sur 20 ici — ses
//! buissons nourrissent. Le test la garde à ce niveau.
//!
//! La banquise, elle, reste à **0/20** après la tranche du gibier du
//! 2026-09-09 (`crates/sim-cli/CAMPAIGN-FINDINGS.md` §14.2), et son test de
//! survie est ici, `#[ignore]`, avec la mesure qui dit pourquoi : ce n'est plus
//! sa table qui bloque — `BiomeTable::game_density` fait tomber la famine de
//! 47 morts sur 62 à 0 sur 59 quand la colonie peut tirer — c'est que **le
//! joueur de ce fichier ne fabrique jamais d'arme**, et qu'un colon à mains
//! nues ne chasse pas.

use sim::{Biome, Command, Designation, Feature, Sim, Terrain, Zone};

/// Graines mesurées par le test statistique. Vingt, comme les autres tests
/// d'équilibrage du dépôt (`balance_fire.rs`, `balance_threat.rs`).
const SEEDS: u64 = 20;
/// Côté de la carte jouée, et durée d'une partie.
///
/// **Ces deux nombres sont un compromis de coût, et il est mesuré.** La
/// campagne de référence joue 64×64 sur 30 jours ; ici, jouer quarante colonies
/// à ce format coûte 40 s en `release` mais **sept minutes en `debug`**, et
/// `cargo test --workspace` tourne en `debug` — le reste de la suite du sim
/// tient en 190 s au total, le plus lourd de ses fichiers en 53 s. À 24×24 sur
/// dix jours, le signal est intact et le fichier rentre dans ce budget.
///
/// Intact, parce que ce qu'on mesure ici est une **famine**, et elle tombe
/// avant le jour 10 : sans le potager garanti, le désert éteint 20 colonies sur
/// 20 dès ce format (`measure_desert_vs_temperate`). Le chiffre à trente jours,
/// celui qui dit de combien le désert reste plus dur que la forêt, est du
/// ressort de la campagne, pas d'un test : `crates/sim-cli/CAMPAIGN-FINDINGS.md`
/// §13.
const SIZE: u32 = 24;
/// Voir `SIZE`.
const DAYS: u32 = 10;
/// Le plus petit format que le jeu propose réellement : la campagne mesure en
/// 64×64, le client démarre en 128×128 (`apps/client/src/App.tsx`, `MAP_SIZE`).
/// Tout ce qui décrit la **composition** d'une carte se mesure ici, et non sur
/// le petit format du banc de survie : ce que le plancher de jouabilité ajoute
/// est un nombre **absolu** de cases, donc sa part dépend de la surface.
const PLAYED: u32 = 64;

/// Colons vivants.
fn colonists(s: &Sim) -> u32 {
    s.pawns()
        .iter()
        .filter(|p| p.is_colonist() && p.is_alive())
        .count() as u32
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

/// Cases franchissables atteignables depuis le centre. Recalculé ici plutôt
/// que lu dans le sim : un test ne doit pas croire la mesure de ce qu'il
/// mesure (même remplissage que `tests/biomes.rs`).
fn reachable(s: &Sim) -> Vec<bool> {
    let m = s.map();
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

/// Ce dont une colonie peut manger, compté au jour 1.
struct Larder {
    /// Cases de sol **libres** (semables tout de suite) et atteignables.
    sowable: u32,
    /// Cases de sol atteignables, sous un arbre ou un buisson comprises : ce
    /// que la colonie aura quand elle aura coupé.
    soil: u32,
    /// Buissons à baies atteignables (8 baies la récolte, elles repoussent).
    bushes: u32,
    /// Bêtes sauvages sur la carte (viande à la chasse).
    animals: u32,
    /// Cases de sol libres dans le rectangle de culture du joueur scripté de
    /// la campagne : un carré de 5 posé en haut à droite du centre.
    in_plot: u32,
}

/// Rayon du rectangle de culture du joueur scripté (`campaign.rs`,
/// `GROWING_SIDE`). Recopié : la campagne est hors du périmètre de cette
/// tranche, et c'est justement ce rectangle-là que la carte doit rendre
/// cultivable.
const GROWING_SIDE: i32 = 5;

fn larder(s: &Sim) -> Larder {
    let m = s.map();
    let seen = reachable(s);
    let touches = |x: u32, y: u32| {
        DIRS.iter().any(|&(dx, dy)| {
            let (nx, ny) = (x as i32 + dx, y as i32 + dy);
            m.in_bounds(nx, ny) && seen[m.index(nx as u32, ny as u32)]
        })
    };
    let (mut sowable, mut soil, mut bushes) = (0, 0, 0);
    for y in 0..m.height() {
        for x in 0..m.width() {
            if m.is_soil(x, y) && touches(x, y) {
                soil += 1;
                if m.feature(x, y) == Feature::None && seen[m.index(x, y)] {
                    sowable += 1;
                }
            }
            if m.feature(x, y) == Feature::Bush && touches(x, y) {
                bushes += 1;
            }
        }
    }
    let animals = s
        .pawns()
        .iter()
        .filter(|p| p.is_alive() && p.species.is_some() && !p.is_colonist())
        .count() as u32;
    let (ax, ay) = m
        .nearest_passable(m.width() / 2, m.height() / 2)
        .map(|(x, y)| (x as i32, y as i32))
        .unwrap_or((0, 0));
    let mut in_plot = 0;
    for y in ay - GROWING_SIDE..=ay - 1 {
        for x in ax + 1..=ax + GROWING_SIDE {
            if m.in_bounds(x, y)
                && m.is_soil(x as u32, y as u32)
                && m.feature(x as u32, y as u32) == Feature::None
            {
                in_plot += 1;
            }
        }
    }
    Larder {
        sowable,
        soil,
        bushes,
        animals,
        in_plot,
    }
}

// ----------------------------------------------------------------------
// Le joueur scripté du test
// ----------------------------------------------------------------------
//
// Volontairement minuscule, et surtout **le même sur tous les biomes** : il
// pose ses zones aux mêmes coordonnées relatives, coupe, récolte et chasse
// dans le même rayon. Ce n'est pas le joueur de `sim-cli campaign` (qui bâtit
// une enceinte, forge et troque) : ici la seule question est la nourriture, et
// un joueur plus riche ne ferait que brouiller la comparaison désert /
// tempéré. Il ne triche pas en cherchant du sol cultivable : son potager tombe
// où il tombe, exactement comme celui de la campagne.

/// Un passage de planification par heure de jeu.
const PLAN_INTERVAL: u64 = 600;
/// Demi-côté du carré de coupe et de récolte.
const GATHER_RADIUS: i32 = 12;

/// Les ordres du tour, s'il y en a.
fn plan(s: &Sim) -> Vec<Command> {
    let mut cmds = Vec::new();
    let m = s.map();
    let Some((ax, ay)) = m
        .nearest_passable(m.width() / 2, m.height() / 2)
        .map(|(x, y)| (x as i32, y as i32))
    else {
        return cmds;
    };
    if colonists(s) == 0 {
        return cmds;
    }
    if m.stockpile_count() == 0 {
        cmds.push(Command::SetZone {
            zone: Zone::Stockpile,
            x0: ax + 2,
            y0: ay + 2,
            x1: ax + 5,
            y1: ay + 5,
        });
    }
    if m.growing_count() == 0 {
        cmds.push(Command::SetZone {
            zone: Zone::Growing,
            x0: ax + 1,
            y0: ay - GROWING_SIDE,
            x1: ax + GROWING_SIDE,
            y1: ay - 1,
        });
    }
    // Couper et récolter : les buissons repoussent, on repasse.
    for kind in [Designation::Chop, Designation::Harvest] {
        cmds.push(Command::Designate {
            kind,
            x0: ax - GATHER_RADIUS,
            y0: ay - GATHER_RADIUS,
            x1: ax + GATHER_RADIUS,
            y1: ay + GATHER_RADIUS,
        });
    }
    // Un feu de camp pour cuisiner, dès qu'il y a du bois.
    if m.campfire_count() == 0 && s.stored_totals()[sim::ItemKind::Wood as usize] >= 20 {
        cmds.push(Command::Build {
            kind: sim::BuildKind::Campfire,
            material: sim::Material::Wood,
            x0: ax - 2,
            y0: ay,
            x1: ax - 2,
            y1: ay,
        });
    }
    // La chasse : toute bête sauvage est du gibier, tant qu'il n'y a pas de
    // quoi manger trois jours.
    let stored = s.stored_totals();
    let raw = stored[sim::ItemKind::Berries as usize]
        + stored[sim::ItemKind::Vegetables as usize]
        + stored[sim::ItemKind::Meat as usize];
    if raw < 60 {
        for p in s.pawns() {
            if p.is_alive() && !p.is_colonist() && p.species.is_some() && !p.hunted {
                cmds.push(Command::Hunt {
                    animal: p.id,
                    on: true,
                });
            }
        }
    }
    cmds
}

/// Ce qu'une partie jouée laisse voir : les colons debout à la fin, et de quoi
/// comprendre pourquoi les autres sont morts.
struct Played {
    end: u32,
    /// Colons vivants au soir de chaque jour.
    daily: Vec<u32>,
    /// Nourriture crue et repas en stock au soir de chaque jour.
    food: Vec<u32>,
    /// Plants en terre au soir de chaque jour.
    crops: Vec<u32>,
}

/// Joue une colonie entière.
fn play(seed: u64, biome: Biome) -> Played {
    let mut s = Sim::new_in_biome(seed, SIZE, SIZE, biome);
    let ticks = u64::from(DAYS) * u64::from(sim::TICKS_PER_DAY);
    let mut p = Played {
        end: 0,
        daily: Vec::new(),
        food: Vec::new(),
        crops: Vec::new(),
    };
    let mut tick = 0;
    while tick < ticks {
        let cmds = if tick % PLAN_INTERVAL == 0 {
            plan(&s)
        } else {
            Vec::new()
        };
        s.step(&cmds);
        tick += 1;
        if tick % u64::from(sim::TICKS_PER_DAY) == 0 {
            let stored = s.stored_totals();
            p.daily.push(colonists(&s));
            p.food.push(
                stored[sim::ItemKind::Berries as usize]
                    + stored[sim::ItemKind::Vegetables as usize]
                    + stored[sim::ItemKind::Meat as usize]
                    + stored[sim::ItemKind::Meal as usize] * sim::farm::RAW_PER_MEAL,
            );
            p.crops.push(s.crops().len() as u32);
        }
    }
    p.end = colonists(&s);
    p
}

/// Une partie jouée, plus ce qui départage « il n'y a rien à manger » de
/// « personne n'a d'arc » : bêtes sauvages encore sur la carte et colons armés,
/// au soir de chaque jour.
struct IceTrace {
    played: Played,
    wild: Vec<u32>,
    armed: Vec<u32>,
    /// Premier jour où un colon porte une arme, `0` si jamais.
    first_weapon_day: u32,
    /// Morts dont le ventre était vide au tick d'avant.
    starved: u32,
    /// Morts qui avaient une blessure au tick d'avant (le sanglier, le plus
    /// souvent : c'est la seule bête qui rend les coups).
    hurt: u32,
    /// Les autres.
    other: u32,
}

/// Joue une colonie de banquise en relevant le goulot. Même joueur et mêmes
/// réglages que `play` : c'est la même partie, simplement mieux observée.
fn ice_trace(seed: u64, armed_player: bool) -> IceTrace {
    let mut s = Sim::new_in_biome(seed, SIZE, SIZE, Biome::Ice);
    let ticks = u64::from(DAYS) * u64::from(sim::TICKS_PER_DAY);
    let mut played = Played {
        end: 0,
        daily: Vec::new(),
        food: Vec::new(),
        crops: Vec::new(),
    };
    let (mut wild, mut armed) = (Vec::new(), Vec::new());
    let mut first_weapon_day = 0;
    let (mut starved, mut hurt, mut other) = (0u32, 0u32, 0u32);
    // Dernier état connu de chaque colon vivant : (id, ventre vide, blessé).
    // Le sim ne garde pas la cause d'une mort, elle se déduit du tick d'avant
    // — même méthode que `campaign.rs`, en beaucoup plus grossier.
    let mut watched: Vec<(u32, bool, bool)> = Vec::new();
    let mut tick = 0;
    while tick < ticks {
        let cmds = if tick % PLAN_INTERVAL != 0 {
            Vec::new()
        } else if armed_player {
            plan_armed(&s)
        } else {
            plan(&s)
        };
        s.step(&cmds);
        tick += 1;
        for &(id, empty, was_hurt) in &watched {
            if s.pawns().iter().any(|p| p.id == id && p.is_alive()) {
                continue;
            }
            if empty {
                starved += 1;
            } else if was_hurt {
                hurt += 1;
            } else {
                other += 1;
            }
        }
        watched = s
            .pawns()
            .iter()
            .filter(|p| p.is_colonist() && p.is_alive())
            .map(|p| (p.id, p.hunger == 0, p.hp < p.max_hp()))
            .collect();
        if tick % u64::from(sim::TICKS_PER_DAY) != 0 {
            continue;
        }
        let day = (tick / u64::from(sim::TICKS_PER_DAY)) as u32;
        let stored = s.stored_totals();
        played.daily.push(colonists(&s));
        played.food.push(
            stored[sim::ItemKind::Berries as usize]
                + stored[sim::ItemKind::Vegetables as usize]
                + stored[sim::ItemKind::Meat as usize]
                + stored[sim::ItemKind::Meal as usize] * sim::farm::RAW_PER_MEAL,
        );
        played.crops.push(s.crops().len() as u32);
        wild.push(
            s.pawns()
                .iter()
                .filter(|p| p.is_alive() && p.species.is_some() && !p.is_colonist())
                .count() as u32,
        );
        let with_weapon = s
            .pawns()
            .iter()
            .filter(|p| p.is_colonist() && p.is_alive() && p.weapon.is_some())
            .count() as u32;
        if with_weapon > 0 && first_weapon_day == 0 {
            first_weapon_day = day;
        }
        armed.push(with_weapon);
    }
    played.end = colonists(&s);
    IceTrace {
        played,
        wild,
        armed,
        first_weapon_day,
        starved,
        hurt,
        other,
    }
}

/// **Instrument de diagnostic, pas le joueur du banc.** Le joueur de `plan`
/// marque du gibier mais ne fabrique jamais d'arme — et « un colon à mains
/// nues ne chasse pas » (`jobs.rs::try_start_hunt`). Sur un biome qui mange
/// autre chose que de la viande, ça ne se voyait pas ; sur la banquise, c'est
/// tout le sujet. Ce joueur-ci ajoute les deux ordres qui manquent, et **rien
/// d'autre** : un poste de fabrication dès qu'il y a dix bois, et un arc par
/// colon. Il ne sert qu'aux relevés `#[ignore]`, pour séparer « il n'y a pas
/// assez de gibier » de « personne ne peut le tirer ».
fn plan_armed(s: &Sim) -> Vec<Command> {
    let mut cmds = plan(s);
    let m = s.map();
    let Some((ax, ay)) = m
        .nearest_passable(m.width() / 2, m.height() / 2)
        .map(|(x, y)| (x as i32, y as i32))
    else {
        return cmds;
    };
    if m.crafting_spot_count() == 0 && s.stored_totals()[sim::ItemKind::Wood as usize] >= 10 {
        cmds.push(Command::Build {
            kind: sim::BuildKind::CraftingSpot,
            material: sim::Material::Wood,
            x0: ax + 2,
            y0: ay - 2,
            x1: ax + 2,
            y1: ay - 2,
        });
    }
    let alive = colonists(s);
    if s.craft_targets()[sim::ItemKind::Bow as usize] < alive {
        cmds.push(Command::SetCraftTarget {
            kind: sim::ItemKind::Bow,
            target: alive,
        });
    }
    cmds
}

/// Colonies vivantes après `DAYS` jours, sur `SEEDS` graines.
fn survivors(biome: Biome) -> (u32, Vec<u64>) {
    let mut count = 0;
    let mut which = Vec::new();
    for seed in 1..=SEEDS {
        if play(seed, biome).end > 0 {
            count += 1;
            which.push(seed);
        }
    }
    (count, which)
}

// ----------------------------------------------------------------------
// Les tests
// ----------------------------------------------------------------------

/// **Le critère de la tranche** : une colonie du désert survit au moins la
/// moitié aussi souvent qu'une colonie tempérée, sur les mêmes graines et avec
/// le même joueur.
///
/// La moitié, et pas l'égalité : le désert doit rester dur. Ce qu'on refuse,
/// c'est qu'il soit **impossible** — avant cette tranche il éteignait
/// 0 colonie sur 20 ici (30 sur 30 en campagne, voir
/// `crates/sim-cli/CAMPAIGN-FINDINGS.md` §13), toutes par famine, parce que le
/// sable ne se cultive pas et qu'aucun buisson n'y pousse.
///
/// # Pourquoi le témoin n'est pas toujours joué
///
/// Le tempéré ne peut pas survivre plus de `SEEDS` fois. Donc dès que le désert
/// passe la moitié des graines **en absolu**, il a forcément passé la moitié du
/// tempéré, quel que soit le tempéré : la comparaison est gagnée sans la jouer.
/// Le témoin n'est donc calculé que si le désert reste sous cette barre — et là
/// il tranche entre « le désert est injouable » et « c'est le sim entier qui a
/// durci ». Ça divise le coût du test par deux dans le cas qui passe, et ce
/// fichier joue quarante colonies : en `debug` chaque colonie économisée
/// compte (voir `SIZE` et `DAYS`).
#[test]
fn desert_colonies_survive_often_enough() {
    let (desert, d_seeds) = survivors(Biome::Desert);
    if desert * 2 >= SEEDS as u32 {
        return;
    }
    let (temperate, t_seeds) = survivors(Biome::TemperateForest);
    // Le témoin doit tenir. Le joueur de ce fichier est maigre — il ne bâtit
    // ni enceinte, ni lit, ni arc — et sort à 18 colonies sur 20 en tempéré
    // (relevé du 2026-09-07) ; en dessous du tiers, c'est le témoin qui est
    // cassé, pas le désert, et la comparaison ne veut plus rien dire.
    assert!(
        temperate * 3 >= SEEDS as u32,
        "le témoin tempéré ne survit que {temperate}/{SEEDS} fois : la mesure \
         du désert ne veut plus rien dire (graines {t_seeds:?})"
    );
    assert!(
        desert * 2 >= temperate,
        "désert {desert}/{SEEDS} (graines {d_seeds:?}) contre tempéré \
         {temperate}/{SEEDS} (graines {t_seeds:?}) : moins de la moitié"
    );
}

/// **La toundra reste jouable** : au moins la moitié du témoin tempéré, sur les
/// mêmes graines et avec le même joueur — même critère et même économie de
/// témoin que le désert.
///
/// Elle n'a pas une case de sol (la neige ne se cultive pas, `Map::is_soil`),
/// mais ses buissons sont plus nombreux que ceux du tempéré (34 à 81
/// atteignables en 64×64 contre 0 à 66, relevé `measure_larder` du 2026-09-09)
/// et ils repoussent : la colonie vit de baies, puis de chasse. Mesuré à 19/20
/// ici et 22/30 en campagne le 2026-09-09 (`crates/sim-cli/CAMPAIGN-FINDINGS.md`
/// §14) — le 4/20 qui l'avait fait déclarer injouable datait d'avant le
/// correctif du plancher qui murait les colonies (§13.9). Ce test empêche
/// qu'une retouche de `biome::TUNDRA` ou du plancher la fasse retomber sans
/// qu'on le voie.
#[test]
fn tundra_colonies_survive_often_enough() {
    let (tundra, t_seeds) = survivors(Biome::Tundra);
    if tundra * 2 >= SEEDS as u32 {
        return;
    }
    let (temperate, w_seeds) = survivors(Biome::TemperateForest);
    assert!(
        temperate * 3 >= SEEDS as u32,
        "le témoin tempéré ne survit que {temperate}/{SEEDS} fois : la mesure \
         de la toundra ne veut plus rien dire (graines {w_seeds:?})"
    );
    assert!(
        tundra * 2 >= temperate,
        "toundra {tundra}/{SEEDS} (graines {t_seeds:?}) contre tempéré \
         {temperate}/{SEEDS} (graines {w_seeds:?}) : moins de la moitié"
    );
}

/// **Le critère de la fiche `banquise-survivable`, et il n'est pas atteint.**
/// Même patron que le désert et la toundra : au moins la moitié du témoin
/// tempéré, mêmes graines, même joueur, témoin joué seulement si nécessaire.
///
/// Il part `#[ignore]` parce qu'il **échoue** : la banquise reste à **0/20**
/// ici, quelle que soit l'abondance du gibier — mesuré de 1 000 à 8 000 pour
/// mille, voir `measure_ice_bottleneck` et le §14.2 du rapport. Ce n'est pas
/// la table qui bloque, et c'est tout l'intérêt de le laisser écrit :
///
/// 1. **Le joueur de ce fichier ne chasse pas.** Il marque du gibier
///    (`Command::Hunt`), mais « un colon à mains nues ne chasse pas »
///    (`jobs.rs::try_start_hunt`) et il ne fabrique jamais d'arme. Sur les
///    autres biomes ça ne se voyait pas — on y mange des baies ; ici c'est
///    tout le repas. Résultat : **60 morts de faim sur 60**, à toutes les
///    valeurs de `game_density`.
/// 2. **Armé, on ne meurt plus de faim, on meurt du sanglier.** Avec un poste
///    de fabrication et un arc par colon (`plan_armed`, relevé seulement), la
///    famine tombe de 47 morts sur 62 à 27 sur 59 à 2 000 pour mille et à 0
///    sur 59 à 8 000 — l'entrée de table fait donc exactement ce qu'on lui
///    demande — mais les colonies vivantes ne bougent pas (2 à 6 sur 20) :
///    une bête sur trois est un sanglier, il charge, et ce joueur n'a ni lit
///    ni médecine.
///
/// Lever `#[ignore]` demandera donc autre chose que la table : un joueur de
/// banc qui s'arme et se soigne, ou une chasse au petit gibier à mains nues.
/// C'est écrit ici plutôt que nulle part pour que le jour où l'un des deux
/// arrive, la mesure soit déjà en place.
#[test]
#[ignore]
fn ice_colonies_survive_often_enough() {
    let (ice, i_seeds) = survivors(Biome::Ice);
    if ice * 2 >= SEEDS as u32 {
        return;
    }
    let (temperate, w_seeds) = survivors(Biome::TemperateForest);
    assert!(
        temperate * 3 >= SEEDS as u32,
        "le témoin tempéré ne survit que {temperate}/{SEEDS} fois : la mesure \
         de la banquise ne veut plus rien dire (graines {w_seeds:?})"
    );
    assert!(
        ice * 2 >= temperate,
        "banquise {ice}/{SEEDS} (graines {i_seeds:?}) contre tempéré \
         {temperate}/{SEEDS} (graines {w_seeds:?}) : moins de la moitié"
    );
}

/// Le potager garanti (`map::MIN_SOIL`) tient sa promesse sur un désert : la
/// colonie a de quoi semer **dès le premier jour**, sans avoir à couper le
/// bosquet d'abord.
#[test]
fn a_desert_always_has_a_plot_to_sow() {
    let mut wide = 0;
    for seed in 1..=SEEDS {
        let l = larder(&Sim::new_in_biome(seed, PLAYED, PLAYED, Biome::Desert));
        assert!(
            l.sowable >= sim::MIN_SOIL,
            "désert (graine {seed}) : {} cases semables, moins que les {} promises",
            l.sowable,
            sim::MIN_SOIL
        );
        wide += u32::from(l.in_plot >= 8);
    }
    // Le potager doit aussi tomber **là où un joueur le pose**, à côté de sa
    // colonie : c'est ce qui a manqué au premier réglage (`MIN_SOIL` à 25 ne
    // mettait que quatre plants en terre dans le rectangle du joueur, et la
    // colonie s'éteignait quand même — voir `measure_trajectories`). La
    // spirale part du centre, donc le compte suit, mais pas toujours : sur une
    // graine sur vingt (la 18) le centre tombe dans une cuvette de gravier, le
    // sable le plus proche est à cinq cases, et l'oasis se pose de côté.
    assert!(
        wide * 10 >= 9 * SEEDS as u32,
        "seulement {wide}/{SEEDS} déserts posent leur oasis là où le joueur \
         sème : le potager n'est plus assez central"
    );
}

/// **Le plancher de sol ne verdit jamais une carte tempérée**, pas même une
/// carte tempérée que le bruit a laissée sans un carré de terre.
///
/// La preuve est directe : seul `Map::force_soil` change du sable en herbe
/// **sans rien poser dessus** (un arbre forcé, lui, laisse son
/// `Feature::Tree`). Il suffit donc de compter, entre la composition nue et la
/// carte réellement jouée, les cases passées de `Sand` à `Grass` et restées
/// libres. Sur une carte tempérée ce compte est zéro, à **toutes** les tailles
/// et sur toutes les graines, parce que le plancher ne regarde pas la graine :
/// il ne s'arme que là où la **table** du biome interdit toute case cultivable
/// (`BiomeTable::has_no_soil`).
///
/// C'est mesuré, et ça n'a pas toujours été vrai : le premier jet déclenchait
/// le plancher sur le simple compte du sol atteignable, et verdissait une carte
/// tempérée sur quarante en 24×24 (graine 26, six cases). Une carte tempérée
/// pauvre est un autre problème que le désert, et cette tranche ne l'ouvre pas.
#[test]
fn the_soil_floor_never_greens_a_temperate_map() {
    for size in [16u32, 24, 32, 48, 64, 96, 128] {
        for seed in 1..=40u64 {
            // `Sim::new` tire la graine de la carte de son `Rng` : on la relit
            // ici pour comparer la même carte (voir
            // `tests/biomes.rs::measure_floor_impact`).
            let mut rng = sim::Rng::new(seed);
            let map_seed = rng.next_u64();
            let bare = sim::Map::generate_bare(map_seed, size, size, Biome::TemperateForest);
            let real = Sim::new(seed, size, size);
            let m = real.map();
            let mut greened = 0;
            for y in 0..size {
                for x in 0..size {
                    if Terrain::from_u8(bare.tiles()[bare.index(x, y)]) == Terrain::Sand
                        && m.get(x, y) == Terrain::Grass
                        && m.feature(x, y) == Feature::None
                    {
                        greened += 1;
                    }
                }
            }
            assert_eq!(
                greened, 0,
                "{size}x{size} (graine {seed}) : le plancher de sol a verdi \
                 {greened} cases d'une carte tempérée"
            );
        }
    }
}

/// L'oasis ne fait pas du désert une prairie : la carte **réellement jouée**,
/// plancher compris, reste sableuse et sans forêt.
///
/// `tests/biomes.rs::each_biome_has_its_signature` mesure la composition nue
/// (`Map::generate_bare`), que cette tranche n'a pas touchée ; ces bornes-ci
/// portent sur la carte finale, la seule que le joueur voit. Elles sont plus
/// larges que celles de la composition nue, justement parce que le plancher a
/// le droit de compléter : sable au-dessus de la moitié de la carte, arbres
/// sous les 2 % (relevé du 2026-09-07 : sable de 758 à 951 pour mille, herbe de
/// 11 à 12, arbres 4).
///
/// La mesure se fait sur une carte **de taille jouée** (`PLAYED`), pas sur le
/// petit format du banc de survie : ce que le plancher ajoute est un nombre
/// **absolu** de cases, donc sa part dépend de la surface. Les vingt arbres du
/// bosquet forcé font 4 pour mille d'un 64×64 et 35 pour mille d'un 24×24 — sur
/// une carte de poche, ce n'est pas l'oasis qui est trop verte, c'est la carte
/// qui est trop petite pour qu'un plancher absolu ait un sens.
#[test]
fn the_oasis_keeps_the_desert_a_desert() {
    for seed in 1..=SEEDS {
        let s = Sim::new_in_biome(seed, PLAYED, PLAYED, Biome::Desert);
        let m = s.map();
        let (mut sand, mut trees) = (0u32, 0u32);
        for y in 0..m.height() {
            for x in 0..m.width() {
                if m.get(x, y) == Terrain::Sand {
                    sand += 1;
                }
                if m.feature(x, y) == Feature::Tree {
                    trees += 1;
                }
            }
        }
        let n = m.width() * m.height();
        assert!(
            sand * 1000 / n > 500,
            "désert (graine {seed}) : plus que {} pour mille de sable",
            sand * 1000 / n
        );
        assert!(
            trees * 1000 / n < 20,
            "désert (graine {seed}) : {} pour mille d'arbres, ce n'est plus un désert",
            trees * 1000 / n
        );
    }
}

// ----------------------------------------------------------------------
// Les relevés
// ----------------------------------------------------------------------

/// De quoi une colonie peut manger au jour 1, par biome. Ignoré par défaut (il
/// n'affirme rien, il mesure) :
/// `cargo test -p sim --test balance_biomes larder -- --ignored --nocapture`.
#[test]
#[ignore]
fn measure_larder() {
    for b in Biome::ALL {
        let mut sowable = (u32::MAX, 0u32, 0u64);
        let mut soil = (u32::MAX, 0u32);
        let mut bushes = (u32::MAX, 0u32, 0u64);
        let mut animals = (u32::MAX, 0u32);
        let mut plot = (u32::MAX, 0u32, 0u64);
        for seed in 1..=SEEDS {
            let l = larder(&Sim::new_in_biome(seed, PLAYED, PLAYED, b));
            sowable = (
                sowable.0.min(l.sowable),
                sowable.1.max(l.sowable),
                sowable.2 + u64::from(l.sowable),
            );
            soil = (soil.0.min(l.soil), soil.1.max(l.soil));
            bushes = (
                bushes.0.min(l.bushes),
                bushes.1.max(l.bushes),
                bushes.2 + u64::from(l.bushes),
            );
            animals = (animals.0.min(l.animals), animals.1.max(l.animals));
            plot = (
                plot.0.min(l.in_plot),
                plot.1.max(l.in_plot),
                plot.2 + u64::from(l.in_plot),
            );
        }
        println!(
            "{:16} semable {}-{} (moy {}) | sol {}-{} | buissons {}-{} (moy {}) | bêtes {}-{} | potager {}-{} (moy {})",
            b.name(),
            sowable.0,
            sowable.1,
            sowable.2 / SEEDS,
            soil.0,
            soil.1,
            bushes.0,
            bushes.1,
            bushes.2 / SEEDS,
            animals.0,
            animals.1,
            plot.0,
            plot.1,
            plot.2 / SEEDS,
        );
    }
}

/// Jour par jour, ce que devient une colonie de désert et de tempéré avec le
/// joueur de ce fichier : colons debout, nourriture crue en stock, plants en
/// terre. C'est le relevé qui dit **pourquoi** une colonie s'éteint.
#[test]
#[ignore]
fn measure_trajectories() {
    for b in [Biome::Desert, Biome::TemperateForest] {
        println!("== {}", b.name());
        for seed in 1..=SEEDS {
            let p = play(seed, b);
            println!(
                "  graine {seed:2} fin {} | colons {:?}\n     vivres {:?}\n     plants {:?}",
                p.end, p.daily, p.food, p.crops
            );
        }
    }
}

/// Les deux seuls chiffres du critère : désert et tempéré, mêmes graines. Le
/// relevé qu'on relance quand on règle `map::MIN_SOIL` ou la table du désert —
/// il est vingt fois plus court que `measure_survival`.
#[test]
#[ignore]
fn measure_desert_vs_temperate() {
    for b in [Biome::TemperateForest, Biome::Desert] {
        let (alive, which) = survivors(b);
        println!("{:16} {alive}/{SEEDS} vivantes {which:?}", b.name());
    }
}

/// **Le relevé qui a réglé `biome::ICE::game_density`** : banquise et tempéré,
/// mêmes graines, comme `measure_desert_vs_temperate` mais pour la glace. On
/// le relance après avoir changé la valeur de la table — c'est vingt fois plus
/// court que `measure_survival`.
#[test]
#[ignore]
fn measure_ice_vs_temperate() {
    for b in [Biome::TemperateForest, Biome::Ice] {
        let (alive, which) = survivors(b);
        println!("{:16} {alive}/{SEEDS} vivantes {which:?}", b.name());
    }
}

/// Jour par jour sur la **banquise** : colons debout, vivres, bêtes sauvages
/// encore sur la carte, et l'arme du premier chasseur. C'est le relevé qui dit
/// si le goulot est la nourriture ou le temps de s'armer — la question que la
/// fiche `banquise-survivable` pose quand la survie plafonne.
#[test]
#[ignore]
fn measure_ice_trajectories() {
    for seed in 1..=SEEDS {
        let t = ice_trace(seed, false);
        println!(
            "  graine {seed:2} fin {} | colons {:?}\n     vivres {:?}\n     bêtes {:?}\n     armés {:?} | première arme jour {}",
            t.played.end, t.played.daily, t.played.food, t.wild, t.armed, t.first_weapon_day
        );
    }
}

/// **Le relevé qui sépare les deux goulots de la banquise** : la même colonie,
/// jouée par le joueur du banc puis par `plan_armed` (le même, plus un poste de
/// fabrication et un arc par colon). Si le second survit et pas le premier,
/// c'est le temps de s'armer qui tue, pas la table.
#[test]
#[ignore]
fn measure_ice_bottleneck() {
    for armed in [false, true] {
        let (mut alive, mut wood, mut first) = (0u32, 0u32, Vec::new());
        let (mut starved, mut hurt, mut other) = (0u32, 0u32, 0u32);
        // Colons-jours : la somme des colons debout au soir de chaque jour.
        // Le compte de colonies vivantes saute de deux ou trois sur un tirage
        // à vingt graines ; celui-ci bouge doucement, et il dit combien de
        // temps la colonie tient.
        let mut colonist_days = 0u32;
        for seed in 1..=SEEDS {
            let t = ice_trace(seed, armed);
            alive += u32::from(t.played.end > 0);
            wood += u32::from(t.armed.iter().any(|&a| a > 0));
            starved += t.starved;
            hurt += t.hurt;
            other += t.other;
            colonist_days += t.played.daily.iter().sum::<u32>();
            if t.first_weapon_day > 0 {
                first.push(t.first_weapon_day);
            }
        }
        println!(
            "banquise {} : {alive}/{SEEDS} vivantes | {colonist_days} colons-jours | {wood}/{SEEDS} colonies ont eu une arme | morts : {starved} de faim, {hurt} blessés, {other} autres | premiers jours {first:?}",
            if armed { "avec arc " } else { "joueur du banc" }
        );
    }
}

/// Colonies vivantes par biome après un mois, avec le joueur scripté de ce
/// fichier. Le relevé qui a servi à écrire le critère ci-dessus.
#[test]
#[ignore]
fn measure_survival() {
    for b in Biome::ALL {
        let (alive, which) = survivors(b);
        println!("{:16} {alive}/{SEEDS} vivantes {which:?}", b.name());
    }
}

/// La part de sable d'une carte de désert, avec le sol de l'oasis. C'est la
/// borne que `tests/biomes.rs::each_biome_has_its_signature` surveille.
#[test]
#[ignore]
fn measure_desert_signature() {
    for seed in 1..=8u64 {
        let s = Sim::new_in_biome(seed, PLAYED, PLAYED, Biome::Desert);
        let m = s.map();
        let (mut sand, mut grass, mut trees) = (0u32, 0u32, 0u32);
        for y in 0..m.height() {
            for x in 0..m.width() {
                match m.get(x, y) {
                    Terrain::Sand => sand += 1,
                    Terrain::Grass => grass += 1,
                    _ => {}
                }
                if m.feature(x, y) == Feature::Tree {
                    trees += 1;
                }
            }
        }
        let n = m.width() * m.height();
        println!(
            "graine {seed} : sable {} herbe {} arbres {} (pour mille)",
            sand * 1000 / n,
            grass * 1000 / n,
            trees * 1000 / n
        );
    }
}

/// Relevé de mise au point : combien de cartes **tempérées** le plancher de sol
/// verdit, par taille, sur quarante graines — et le voisinage du centre d'une
/// carte de désert, case par case.
#[test]
#[ignore]
fn measure_greening() {
    for size in [16u32, 24, 32, 48, 64, 96, 128] {
        let mut touched = Vec::new();
        for seed in 1..=40u64 {
            let mut rng = sim::Rng::new(seed);
            let map_seed = rng.next_u64();
            let bare = sim::Map::generate_bare(map_seed, size, size, Biome::TemperateForest);
            let real = Sim::new(seed, size, size);
            let m = real.map();
            let mut greened = 0;
            for y in 0..size {
                for x in 0..size {
                    if Terrain::from_u8(bare.tiles()[bare.index(x, y)]) == Terrain::Sand
                        && m.get(x, y) == Terrain::Grass
                        && m.feature(x, y) == Feature::None
                    {
                        greened += 1;
                    }
                }
            }
            if greened > 0 {
                touched.push((seed, greened));
            }
        }
        println!(
            "{size}x{size} : {} cartes verdies {touched:?}",
            touched.len()
        );
    }
    for seed in [18u64, 1] {
        let s = Sim::new_in_biome(seed, PLAYED, PLAYED, Biome::Desert);
        let m = s.map();
        let (ax, ay) = m.nearest_passable(m.width() / 2, m.height() / 2).unwrap();
        println!("désert graine {seed} : centre ({ax}, {ay})");
        for dy in -7i32..=7 {
            let mut row = String::new();
            for dx in -7i32..=7 {
                let (x, y) = (ax as i32 + dx, ay as i32 + dy);
                if !m.in_bounds(x, y) {
                    row.push(' ');
                    continue;
                }
                let (x, y) = (x as u32, y as u32);
                row.push(match (m.get(x, y), m.feature(x, y)) {
                    (_, Feature::Tree) => 'T',
                    (_, f) if f.is_rock() => 'R',
                    (Terrain::Grass, _) => 'g',
                    (Terrain::Sand, _) => '.',
                    (Terrain::Gravel, _) => ',',
                    (t, _) if t.is_water() => '~',
                    _ => '?',
                });
            }
            println!("  {row}");
        }
    }
}
