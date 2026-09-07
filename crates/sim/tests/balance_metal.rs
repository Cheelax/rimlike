//! Équilibrage de la chaîne du métal : minerai → lingot → épée.
//!
//! Le constat de départ est au §11.1 de `crates/sim-cli/CAMPAIGN-FINDINGS.md` :
//! une colonie qui paie les 3 500 points de la métallurgie, bâtit sa forge et
//! mine ses veines ne forgeait **pas** d'épée — une sur quatorze en campagne
//! normale, une de plus entre le jour 30 et le jour 60. La cause n'était ni la
//! durée de la partie ni le nombre de rochers marqués, mais une règle de
//! `Sim::craft_picks` : une recette exigeait ses ingrédients **dans une seule
//! pile**. Or une veine rend deux ou trois minerais (`jobs::ORE_YIELD_MIN`), un
//! lingot en coûte trois, et les lingots tombent **un par un** au pied de la
//! forge avant d'être rangés chacun sur la case d'entrepôt la plus proche. Le
//! compte d'une épée dans la même pile n'arrivait jamais.
//!
//! Ce fichier tient les deux bouts : les deux premiers tests décrivent la règle
//! (« plusieurs piles, plusieurs voyages »), le troisième mesure ce qu'elle
//! donne sur vingt graines, le quatrième vérifie qu'on n'a pas payé la chaîne
//! du métal avec la survie de la colonie.
//!
//! Conventions : voir `gameplay.rs` et `metal.rs`, dont ce fichier reprend le
//! `run_until` et la clairière.

use sim::craft::{METAL_PER_SWORD, ORE_PER_INGOT};
use sim::map::{Feature, Map};
use sim::testmap::map_from;
use sim::{Command, Designation, Difficulty, EventKind, ItemKind, Sim, TICKS_PER_DAY, Tech, Zone};

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

/// Clairière plate : rien à couper, rien à cueillir. Ce qui s'y passe vient des
/// piles qu'on y pose et des ateliers qu'on y plante.
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

/// De quoi tenir plusieurs jours sans que la faim vienne interrompre l'atelier.
fn feed(s: &mut Sim) {
    s.spawn_item(ItemKind::Berries, 200, 1, 6);
}

/// Piles d'un genre encore au sol, par quantité, dans l'ordre de la liste.
fn piles(s: &Sim, kind: ItemKind) -> Vec<u32> {
    s.items()
        .iter()
        .filter(|i| i.kind == kind)
        .map(|i| i.count)
        .collect()
}

/// Journal complet d'une partie : le tampon du sim n'en garde que trente-deux
/// (`MAX_EVENTS`), et une colonie de quinze jours en produit bien plus. On le
/// vide au fil des ticks, comme le fait le harnais de campagne.
#[derive(Default)]
struct Log {
    seen: u32,
    ingots: u32,
    swords: u32,
}

impl Log {
    fn poll(&mut self, s: &Sim) {
        for e in s.events() {
            if e.seq < self.seen {
                continue;
            }
            self.seen = e.seq + 1;
            if e.kind == EventKind::ItemCrafted && e.arg == ItemKind::Metal as u32 {
                self.ingots += 1;
            }
            if e.kind == EventKind::WeaponCrafted && e.arg == ItemKind::Sword as u32 {
                self.swords += 1;
            }
        }
    }
}

// ----------------------------------------------------------------------
// La règle : plusieurs piles, plusieurs voyages
// ----------------------------------------------------------------------

/// `METAL_PER_SWORD` lingots rangés **un par case** font une épée. C'est le cas
/// réel : `do_craft` pose la pièce finie au pied de l'atelier et un rangeur
/// l'emporte vers la case d'entrepôt libre la plus proche de **là où elle est
/// tombée** — trois fontes successives donnent donc trois piles de un, jamais
/// une pile de trois.
#[test]
fn crafting_draws_ingredients_from_several_stockpile_piles() {
    let mut s = clearing();
    feed(&mut s);
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: 4,
        y0: 1,
        x1: 7,
        y1: 1,
    }]);
    // Un lingot par case, autant de cases que l'épée demande de lingots.
    for k in 0..METAL_PER_SWORD {
        s.spawn_item(ItemKind::Metal, 1, 4 + k, 1);
    }
    assert_eq!(
        piles(&s, ItemKind::Metal),
        vec![1; METAL_PER_SWORD as usize],
        "le décor du test doit être des piles de un"
    );

    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Sword,
        target: 1,
    }]);
    assert!(
        run_until(&mut s, 3 * DAY, |s| s.colony_total(ItemKind::Sword) >= 1),
        "aucune épée forgée : lingots {:?}",
        piles(&s, ItemKind::Metal)
    );
    assert_eq!(
        s.colony_total(ItemKind::Metal),
        0,
        "l'épée coûte son compte de lingots, pris sur autant de piles"
    );
}

/// La fonte n'attend pas une pile de trois. Une veine rend deux ou trois
/// minerais (`jobs::ORE_YIELD_MIN`) et rien ne fusionne les piles d'un entrepôt
/// entre elles : exiger le compte du lingot dans **une** pile perdait un rocher
/// sur deux.
///
/// Le décor est la version la plus dure du cas réel : des piles d'**une** unité,
/// une par case, autant qu'il en faut pour le lingot plus une de reste.
#[test]
fn smelting_does_not_wait_for_a_single_pile_of_three() {
    let mut s = clearing();
    feed(&mut s);
    s.map_mut().set_feature(9, 5, Feature::Forge);
    let scattered = ORE_PER_INGOT + 1;
    for k in 0..scattered {
        s.spawn_item(ItemKind::Ore, 1, 2 + k, 4);
    }
    assert_eq!(
        piles(&s, ItemKind::Ore),
        vec![1; scattered as usize],
        "le décor du test doit être des piles de un"
    );

    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Metal,
        target: 1,
    }]);
    assert!(
        run_until(&mut s, 2 * DAY, |s| s.colony_total(ItemKind::Metal) >= 1),
        "aucun lingot fondu : minerai {:?}",
        piles(&s, ItemKind::Ore)
    );
    assert_eq!(
        s.colony_total(ItemKind::Ore),
        1,
        "le lingot coûte son compte de minerais, pris sur autant de piles"
    );
}

// ----------------------------------------------------------------------
// La mesure : une colonie outillée forge son épée
// ----------------------------------------------------------------------

/// Les veines du scénario ciblé : cinq rochers à une dizaine de cases du
/// centre, comme une carte 64×64 en offre autour d'un repère.
const VEINS: [(u32, u32); 5] = [(6, 16), (26, 16), (16, 6), (16, 26), (9, 9)];

/// Carte 32×32 sans arbre ni buisson : seul le métal doit décider de l'issue.
fn metal_map() -> Map {
    let rows: Vec<String> = (0..32).map(|_| ".".repeat(32)).collect();
    let refs: Vec<&str> = rows.iter().map(|s| s.as_str()).collect();
    let mut m = map_from(&refs);
    for &(x, y) in &VEINS {
        m.set_feature(x, y, Feature::OreRock);
    }
    m
}

/// La colonie du §11.1, mais sans ses malheurs : métallurgie acquise, forge et
/// poste debout, entrepôt 6×6, cinq veines marquées, aucune bande. Ce qui reste
/// est exactement la chaîne minerai → lingot → épée.
fn metallurgy_colony(seed: u64) -> Sim {
    let mut s = Sim::from_map(seed, metal_map());
    s.research_mut().complete(Tech::Metallurgy);
    s.map_mut().set_feature(14, 14, Feature::CraftingSpot);
    s.map_mut().set_feature(18, 14, Feature::Forge);
    s.step(&[
        Command::SetDifficulty {
            level: Difficulty::Peaceful,
        },
        Command::SetZone {
            zone: Zone::Stockpile,
            x0: 13,
            y0: 17,
            x1: 18,
            y1: 22,
        },
        // Les objectifs du joueur scripté de `campaign` : de quoi armer les
        // trois colons, soit `METAL_PER_SWORD` lingots et une épée chacun.
        Command::SetCraftTarget {
            kind: ItemKind::Metal,
            target: METAL_PER_SWORD * 3,
        },
        Command::SetCraftTarget {
            kind: ItemKind::Sword,
            target: 3,
        },
    ]);
    for &(x, y) in &VEINS {
        s.step(&[Command::Designate {
            kind: Designation::Mine,
            x0: x as i32,
            y0: y as i32,
            x1: x as i32,
            y1: y as i32,
        }]);
    }
    s
}

/// Statistique sur vingt graines : une colonie qui a payé la métallurgie, bâti
/// sa forge et marqué cinq veines forge son épée en quinze jours, et pas une
/// fois sur vingt.
///
/// **Mesuré**, mêmes graines, même scénario : 60 lingots et **0 épée sur 20**
/// avant ; 77 lingots et **17 épées sur 20** avec le seul prélèvement sur le
/// stock ; 77 lingots et **20 épées sur 20** une fois `METAL_PER_SWORD` passé
/// de quatre à trois — les trois graines qui manquaient étaient celles dont les
/// cinq veines ne rendaient que dix minerais, soit trois lingots.
///
/// La cible du jour était la majorité (11/20) ; le seuil est posé aux
/// **trois quarts**, assez bas pour absorber le bruit de graine, assez haut
/// pour qu'une régression de moitié fasse rougir le test.
#[test]
fn a_metallurgy_colony_forges_a_sword_in_fifteen_days() {
    const SEEDS: u64 = 20;
    let (mut with_sword, mut with_ingot) = (0u32, 0u32);
    for seed in 1..=SEEDS {
        let mut s = metallurgy_colony(seed);
        let mut log = Log::default();
        // Quinze jours au plus : on s'arrête à l'épée, ce qu'on mesure est
        // « en moins de quinze jours », pas ce qui se passe après.
        'days: for _ in 0..15 {
            // Les baies se gâtent en trois jours : on ravitaille chaque matin
            // pour que la faim ne se mêle pas de la mesure.
            s.spawn_item(ItemKind::Berries, 60, 12, 12);
            for _ in 0..DAY {
                s.step(&[]);
                log.poll(&s);
                if log.swords > 0 {
                    break 'days;
                }
            }
        }
        if log.ingots > 0 {
            with_ingot += 1;
        }
        if log.swords > 0 {
            with_sword += 1;
        }
    }
    assert_eq!(
        with_ingot, SEEDS as u32,
        "{with_ingot}/{SEEDS} colonies seulement fondent un lingot : la fonte a régressé"
    );
    assert!(
        with_sword * 4 >= SEEDS as u32 * 3,
        "seulement {with_sword}/{SEEDS} colonies forgent une épée en quinze jours"
    );
}

// ----------------------------------------------------------------------
// La contrepartie : la survie
// ----------------------------------------------------------------------

/// Aller chercher un ingrédient sur plusieurs piles, c'est plus de voyages :
/// autant de temps que le colon ne passe ni à manger, ni à bâtir, ni à se
/// battre. Ce test borne la facture là où elle se paierait — une colonie
/// ordinaire, en difficulté normale, avec un objectif d'armes posé comme le
/// fait le joueur scripté.
///
/// **Mesuré** après la correction : **40 colons vivants** au jour 10 sur les
/// douze graines, **2 colonies éteintes**. La contre-épreuve en grand est la
/// campagne du §11.4 de `CAMPAIGN-FINDINGS.md` — mêmes trente graines avant et
/// après, 12/30 puis 10/30 colonies éteintes, 209 puis 211 morts —, c'est elle
/// qui dit que la survie n'a pas bougé. Ici les seuils sont larges (24 colons,
/// au plus 5 colonies éteintes) : ce qu'on surveille est une dérive franche,
/// pas le chiffre exact, et le bruit de graine est connu pour être large
/// (`CAMPAIGN-FINDINGS.md` §2).
#[test]
fn survival_is_unchanged() {
    const SEEDS: u64 = 12;
    let (mut alive, mut wiped) = (0u32, 0u32);
    for seed in 1..=SEEDS {
        let mut s = Sim::new(seed, 32, 32);
        let (cx, cy) = s.colony_center().expect("colonie sans centre");
        s.step(&[
            Command::SetDifficulty {
                level: Difficulty::Normal,
            },
            // Un arc par colon : la fabrication tourne pendant que les bandes
            // arrivent, c'est le cas où des voyages en plus coûteraient cher.
            Command::SetCraftTarget {
                kind: ItemKind::Bow,
                target: 3,
            },
        ]);
        s.spawn_item(ItemKind::Berries, 200, cx, cy);
        for day in 0..10 {
            if day % 2 == 0 {
                let (cx, cy) = s.colony_center().unwrap_or((cx, cy));
                s.spawn_item(ItemKind::Berries, 120, cx, cy);
            }
            for _ in 0..DAY {
                s.step(&[]);
            }
        }
        let n = s
            .pawns()
            .iter()
            .filter(|p| p.is_colonist() && p.is_alive())
            .count() as u32;
        alive += n;
        if n == 0 {
            wiped += 1;
        }
    }
    assert!(
        alive >= 24,
        "{alive} colons vivants au jour 10 sur {SEEDS} graines : la survie a reculé"
    );
    assert!(
        wiped <= 5,
        "{wiped}/{SEEDS} colonies éteintes au jour 10 (max 5 tolérées)"
    );
}

/// Une collecte déjà commencée survit au chargement : les unités déposées
/// ne doivent ni disparaître du compteur ni être demandées une seconde fois.
#[test]
fn snapshot_resumes_a_partially_delivered_ingredient() {
    use sim::Job;
    use sim::craft::CraftStage;

    let mut s = clearing();
    feed(&mut s);
    s.map_mut().set_feature(8, 3, Feature::CraftingSpot);
    for k in 0..METAL_PER_SWORD {
        s.spawn_item(ItemKind::Metal, 1, 3 + k, 1);
    }
    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Sword,
        target: 1,
    }]);
    assert!(
        run_until(&mut s, DAY, |s| {
            s.pawns().iter().any(|p| {
        matches!(p.job, Job::Craft { stage: CraftStage::FetchPartial { got, .. }, .. } if got > 0)
    })
        }),
        "aucune collecte partielle observée"
    );

    let mut restored = Sim::restore(&s.snapshot()).expect("snapshot de collecte partielle");
    let mut finished = false;
    for tick in 0..2 * DAY {
        s.step(&[]);
        restored.step(&[]);
        if tick % 300 == 0 {
            assert_eq!(
                s.state_hash(),
                restored.state_hash(),
                "divergence après reprise au tick {tick}"
            );
        }
        if s.colony_total(ItemKind::Sword) > 0 {
            finished = true;
            break;
        }
    }
    assert!(finished, "l'épée doit se terminer avec les piles restantes");
    assert_eq!(s.state_hash(), restored.state_hash());
    assert_eq!(restored.colony_total(ItemKind::Metal), 0);
}

/// L'ancienne variante Fetch se relit sans changer ses octets et continue
/// son travail : un ancien colon qui revenait chargé n'a rien à récolter à nouveau.
#[test]
fn legacy_fetch_job_still_finishes_after_loading() {
    use sim::Job;
    use sim::craft::CraftStage;

    let mut s = clearing();
    feed(&mut s);
    let pawn = s.pawns().iter().find(|p| p.is_colonist()).unwrap();
    let id = pawn.id;
    let (x, y) = pawn.tile();
    let spot = (x + 1, y);
    s.map_mut()
        .set_feature(spot.0, spot.1, Feature::CraftingSpot);
    let pawn = s.pawn_mut(id).unwrap();
    pawn.path.clear();
    pawn.carrying = Some((ItemKind::Metal, METAL_PER_SWORD));
    pawn.job = Job::Craft {
        spot,
        recipe: ItemKind::Sword,
        stage: CraftStage::Fetch {
            index: 0,
            item: 999,
            carried: true,
        },
    };
    let mut restored = Sim::restore(&s.snapshot()).unwrap();
    assert!(run_until(&mut restored, DAY, |s| s
        .colony_total(ItemKind::Sword)
        == 1));
}
