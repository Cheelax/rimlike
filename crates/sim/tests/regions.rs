//! Savoir en O(1) qu'une cible est inatteignable.
//!
//! `crates/sim-cli/CAMPAIGN-FINDINGS.md`, §3, « ce qui reste » : cinq graines
//! de campagne sur trente restaient sous 1 000 ticks/s, tenues par des
//! recherches de travail déjà bornées à six candidats — mais six A\* qui
//! **échouent**, et un A\* qui échoue explore toute la composante où se tient
//! le colon avant de rendre `None`.
//!
//! Or il échoue si et seulement si la cible n'est pas dans la même composante
//! connexe que le marcheur. L'index de régions (`sim::regions`) répond à cette
//! question en une lecture.
//!
//! **Deux couches, et la seconde est celle qui compte.** Un mur percé d'une
//! porte ne sépare rien : la porte est franchissable pour tout le monde. Ce
//! qui séparait, dans les graines lentes, ce sont les **trois pièges** que le
//! joueur scripté pose juste devant sa porte — les trois seules cases par où
//! l'on sort, et celles qu'aucun colon ne traverse. La colonie se mure pour
//! elle-même sans rien fermer pour la carte. D'où une couche par sorte de
//! marcheur (`path::Walker`).
//!
//! Ces tests vérifient trois choses, dans cet ordre : que l'index dit vrai,
//! qu'il ne coûte rien (il se rebâtit quand la carte change, pas à chaque
//! tick), et surtout qu'il **ne change aucune décision** — c'est la seule
//! raison pour laquelle une couche dérivée a le droit de rester hors du
//! snapshot.

use sim::map::Feature;
use sim::path;
use sim::testmap::map_from;
use sim::{Command, ItemKind, Job, Sim};

/// Cinq secondes de jeu : assez pour que les trois colons relancent leur
/// recherche des centaines de fois.
const TICKS: u64 = 600;

// ----------------------------------------------------------------------
// 1. L'index dit vrai
// ----------------------------------------------------------------------

#[test]
fn regions_split_at_walls_and_join_at_doors() {
    // Un mur de roche plein cadre coupe la carte en deux.
    let mut m = map_from(&["..#..", "..#..", "..#.."]);
    m.refresh_regions();
    assert_eq!(
        m.region_count(),
        2,
        "deux régions de part et d'autre du mur"
    );
    assert_eq!(m.same_region((0, 1), (1, 1)), Some(true), "même côté");
    assert_eq!(
        m.same_region((0, 1), (4, 1)),
        Some(false),
        "de part et d'autre"
    );
    assert_eq!(
        m.region_of(2, 1),
        None,
        "une case infranchissable n'a pas de région"
    );
    assert_eq!(
        m.same_region((0, 1), (2, 1)),
        None,
        "on ne sait rien d'une case infranchissable"
    );
    // Et l'A\* est du même avis, c'est tout ce qui compte.
    assert!(path::find_path(&m, (0, 1), (4, 1)).is_none());

    // Une porte perce le mur : elle est franchissable, donc elle joint.
    m.set_feature(2, 1, Feature::DoorWood);
    assert!(m.regions_dirty(), "la porte a périmé l'index");
    m.refresh_regions();
    assert_eq!(m.region_count(), 1, "la porte a joint les deux régions");
    assert_eq!(m.same_region((0, 1), (4, 1)), Some(true));
    assert!(path::find_path(&m, (0, 1), (4, 1)).is_some());
}

#[test]
fn fire_never_splits_a_region() {
    // Le feu n'est pas un mur mais un surcoût (`fire::FIRE_PATH_COST_MULT`) :
    // le mettre dans l'index le rendrait faux — il ne peut jamais rendre une
    // cible inatteignable, pour personne.
    let mut m = map_from(&["....."]);
    m.set_fire(3, 0, 2);
    m.refresh_regions();
    assert_eq!(m.region_count(), 1, "le feu ne coupe pas une région");
    assert_eq!(m.same_region((0, 0), (4, 0)), Some(true));
    assert!(path::find_path(&m, (0, 0), (4, 0)).is_some());
}

#[test]
fn armed_traps_split_the_colony_only() {
    // Le piège armé est le seul obstacle qui dépend de **qui** passe : la
    // colonie sait où sont ses pointes et ne marche jamais dessus, un pillard
    // l'apprend en marchant. D'où deux couches — et c'est le cas qui tenait
    // les graines lentes de la campagne : le joueur scripté referme son
    // enceinte, pose une porte, puis trois pièges juste devant. Pour la carte,
    // tout communique ; pour la colonie, la maison est murée.
    let mut m = map_from(&["....."]);
    m.set_feature(2, 0, Feature::SpikeTrap);
    m.refresh_regions();
    assert_eq!(m.region_count(), 1, "un piège ne coupe rien pour la carte");
    assert_eq!(
        m.colonist_region_count(),
        2,
        "il coupe en deux pour la colonie"
    );
    assert_eq!(m.same_region((0, 0), (4, 0)), Some(true));
    assert_eq!(
        m.same_region_for((0, 0), (4, 0), path::Walker::COLONIST),
        Some(false),
        "aucun colon ne traverse ses propres pointes"
    );
    // Et les deux A\* sont du même avis, c'est tout ce qui compte.
    assert!(path::find_path_for(&m, (0, 0), (4, 0), path::Walker::COLONIST).is_none());
    assert!(
        path::find_path(&m, (0, 0), (4, 0)).is_some(),
        "un pillard passe"
    );

    // Le piège déclenché n'arrête plus personne : la seconde couche disparaît
    // avec le dernier piège armé, et les questions retombent sur la première.
    m.set_feature(2, 0, Feature::SpikeTrapSprung);
    assert!(m.regions_dirty(), "désarmer un piège périme l'index");
    m.refresh_regions();
    assert_eq!(m.colonist_region_count(), 1);
    assert_eq!(
        m.same_region_for((0, 0), (4, 0), path::Walker::COLONIST),
        Some(true)
    );
}

#[test]
fn the_index_agrees_with_the_a_star_on_a_generated_map() {
    // La propriété qui autorise tout le reste, éprouvée sur une vraie carte
    // (lacs, massifs rocheux, îles) : pour un marcheur sans particularité,
    // « même région » et « il existe un chemin » sont **le même** prédicat.
    // Quarante-neuf paires suffisent à traverser la carte dans tous les sens.
    let mut m = sim::Map::generate(7, 48, 48);
    m.refresh_regions();
    let marks: Vec<(u32, u32)> = (0..7)
        .flat_map(|i| (0..7).map(move |j| (3 + 7 * i, 3 + 7 * j)))
        .collect();
    let mut compared = 0;
    for &a in &marks {
        for &b in &marks {
            let (Some(_), Some(_)) = (m.region_of(a.0, a.1), m.region_of(b.0, b.1)) else {
                continue;
            };
            compared += 1;
            assert_eq!(
                m.same_region(a, b),
                Some(path::find_path(&m, a, b).is_some()),
                "l'index et l'A* divergent entre {a:?} et {b:?}"
            );
        }
    }
    assert!(compared > 100, "trop peu de paires comparées : {compared}");
}

// ----------------------------------------------------------------------
// 2. L'index ne coûte rien
// ----------------------------------------------------------------------

/// Carte plate de terre nue, `size × size`. `Sim::from_map` y pose trois
/// colons au centre ; la terre nue tient l'herbe (donc les feux d'été) à
/// l'écart de la mesure.
fn flat(size: u32) -> Sim {
    let rows: Vec<String> = (0..size).map(|_| ",".repeat(size as usize)).collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    Sim::from_map(1, map_from(&refs))
}

/// Un réduit de roche scellé, à dix cases à l'est des colons, avec tout ce
/// qu'un colon pourrait vouloir dedans : deux postes de fabrication, des
/// dépouilles à débiter, du bois à travailler. Ses cases sont **franchissables
/// et pourtant hors d'atteinte** : c'est le pire cas de la recherche de
/// travail pour la couche de base — un mur, et rien d'autre.
fn sealed_larder(size: u32) -> Sim {
    let mut s = flat(size);
    let (cx, cy) = (size / 2, size / 2);
    let (x0, y0) = (cx + 10, cy - 2);
    let side = 5;
    for y in y0 - 1..y0 + side + 1 {
        for x in x0 - 1..x0 + side + 1 {
            let inside = (x0..x0 + side).contains(&x) && (y0..y0 + side).contains(&y);
            if !inside {
                s.map_mut().set_feature(x, y, Feature::Rock);
            }
        }
    }
    // Deux postes, pas un : le fabricant en réserve un pour la durée de son
    // ouvrage, et un poste réservé n'est plus un poste pour le dépeceur.
    s.map_mut()
        .set_feature(x0 + 2, y0 + 2, Feature::CraftingSpot);
    s.map_mut()
        .set_feature(x0 + 4, y0 + 2, Feature::CraftingSpot);
    for k in 0..4 {
        s.spawn_item(ItemKind::DeerCorpse, 1, x0 + k, y0);
    }
    s.spawn_item(ItemKind::Wood, 60, x0, y0 + 4);
    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Bow,
        target: 5,
    }]);
    s
}

/// La case de la porte du réduit, dans le mur ouest.
fn larder_door(size: u32) -> (u32, u32) {
    (size / 2 + 9, size / 2)
}

#[test]
fn a_blocked_target_costs_no_astar() {
    // Dépeçage et fabrication tournent à chaque salve : les postes, les
    // dépouilles et le bois sont tous derrière le mur. Avant l'index, chaque
    // tour coûtait un A\* par dépouille examinée **plus** les huit voisines de
    // chaque poste, tous explorant la carte entière avant de rendre `None` :
    // **629** sur cette scène, mesurés sur la révision d'avant. Zéro après.
    let mut s = sealed_larder(64);
    let before = s.job_paths();
    for _ in 0..TICKS {
        s.step(&[]);
    }
    assert_eq!(
        s.job_paths() - before,
        0,
        "une cible démontrée hors d'atteinte ne doit lancer aucun A*"
    );
}

#[test]
fn the_index_does_not_stop_the_work() {
    // Le garde-fou : la même scène, mur percé d'une porte. Les colons doivent
    // dépecer, et l'A\* doit reprendre du service.
    let size = 64;
    let mut s = sealed_larder(size);
    let (dx, dy) = larder_door(size);
    s.map_mut().set_feature(dx, dy, Feature::DoorWood);
    let before = s.job_paths();
    let mut butchered = false;
    for _ in 0..TICKS {
        s.step(&[]);
        butchered |= s
            .pawns()
            .iter()
            .any(|p| matches!(p.job, Job::Butcher { .. }));
    }
    assert!(butchered, "aucun colon n'est parti dépecer");
    assert!(
        s.job_paths() > before,
        "la porte ouverte, la recherche doit relancer de vrais A*"
    );
    assert!(
        s.items()
            .iter()
            .any(|i| i.kind == ItemKind::Meat && i.count > 0),
        "le dépeçage n'a rien produit"
    );
}

/// La scène des campagnes, en petit : les colons **dans** l'enceinte, une
/// porte de bois au sud, et les trois pièges que le joueur scripté pose juste
/// devant. Pour la carte, la porte ouvre et les pièges ne ferment rien ; pour
/// la colonie, ces trois cases sont les seules issues et aucun colon ne marche
/// dessus. La maison est murée pour elle-même.
///
/// Tout le travail est dehors : des dépouilles, deux postes de fabrication, du
/// bois, un objectif d'arcs.
fn trapped_door(size: u32) -> Sim {
    let mut s = flat(size);
    let (cx, cy) = (size / 2, size / 2);
    let r = 4;
    for k in 0..=2 * r {
        let (x, y) = (cx - r + k, cy - r);
        s.map_mut().set_feature(x, y, Feature::WallWood);
        s.map_mut().set_feature(x, cy + r, Feature::WallWood);
        s.map_mut()
            .set_feature(cx - r, cy - r + k, Feature::WallWood);
        s.map_mut()
            .set_feature(cx + r, cy - r + k, Feature::WallWood);
    }
    s.map_mut().set_feature(cx, cy + r, Feature::DoorWood);
    for k in 0..3 {
        s.map_mut()
            .set_feature(cx - 1 + k, cy + r + 1, Feature::SpikeTrap);
    }
    for k in 0..4 {
        s.spawn_item(ItemKind::DeerCorpse, 1, 2 + 2 * k, 2);
    }
    s.map_mut().set_feature(4, 6, Feature::CraftingSpot);
    s.map_mut().set_feature(6, 6, Feature::CraftingSpot);
    s.spawn_item(ItemKind::Wood, 60, 8, 2);
    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Bow,
        target: 5,
    }]);
    s
}

#[test]
fn a_trapped_door_seals_the_colony_and_costs_no_astar() {
    // **Le cas qui tenait les cinq graines lentes de la campagne**, et celui
    // qui a imposé une seconde couche à l'index : un mur percé d'une porte ne
    // sépare rien, ce sont les pointes posées devant qui séparent — et elles
    // ne séparent que pour la colonie. Une couche de base voit une région
    // unique et ne peut rien démontrer ; la couche des colons en voit deux et
    // démontre tout. Mesuré sur la révision d'avant : **860** A\* sur ces
    // cinq secondes de jeu. Zéro après.
    let size = 64;
    let mut s = trapped_door(size);
    let (cx, cy) = (size / 2, size / 2);
    let inside = (cx, cy);
    let outside = (4, 2);
    assert_eq!(
        s.map().same_region(inside, outside),
        Some(true),
        "pour la carte, la porte ouvre"
    );
    assert_eq!(
        s.map()
            .same_region_for(inside, outside, path::Walker::COLONIST),
        Some(false),
        "pour la colonie, les pointes ferment"
    );
    let before = s.job_paths();
    for _ in 0..TICKS {
        s.step(&[]);
    }
    assert_eq!(
        s.job_paths() - before,
        0,
        "une colonie murée par ses propres pièges ne doit lancer aucun A*"
    );
    // Et personne n'est sorti : le sim se comporte exactement comme avant, il
    // le fait seulement sans payer.
    for p in s
        .pawns()
        .iter()
        .filter(|p| p.faction == sim::Faction::Colony)
    {
        let t = p.tile();
        assert!(
            t.0 > cx - 4 && t.0 < cx + 4 && t.1 > cy - 4 && t.1 < cy + 4,
            "un colon est sorti de l'enceinte : {t:?}"
        );
    }
}

#[test]
fn index_is_rebuilt_only_on_map_changes() {
    // Une carte nue où rien ne bouge : l'index est bâti une fois, à la
    // construction du sim, et plus jamais.
    let mut s = flat(64);
    assert_eq!(s.region_rebuilds(), 1, "index bâti avant le premier tick");
    for _ in 0..TICKS {
        s.step(&[]);
    }
    assert_eq!(
        s.region_rebuilds(),
        1,
        "l'index s'est rebâti sans qu'aucune case ne change"
    );
    // Un mur, et un seul recalcul de plus.
    s.map_mut().set_feature(10, 10, Feature::WallWood);
    s.step(&[]);
    assert_eq!(s.region_rebuilds(), 2, "un mur bâti, un recalcul");
    for _ in 0..TICKS {
        s.step(&[]);
    }
    assert_eq!(s.region_rebuilds(), 2, "et rien après");
    // Ce qui ne touche pas au passage ne périme rien : un lit posé, un sol de
    // bois coulé, une zone peinte.
    s.map_mut().set_feature(12, 12, Feature::Bed);
    s.map_mut().set_terrain(13, 13, sim::Terrain::WoodFloor);
    s.step(&[]);
    assert_eq!(
        s.region_rebuilds(),
        2,
        "un lit et un sol ne changent aucune franchissabilité"
    );
}

// ----------------------------------------------------------------------
// 3. L'index ne change aucune décision
// ----------------------------------------------------------------------

#[test]
fn a_door_opened_by_a_build_reconnects() {
    let size = 64;
    let mut s = sealed_larder(size);
    let (dx, dy) = larder_door(size);
    let from = s.pawns()[0].tile();
    let inside = (size / 2 + 10, size / 2);
    assert_eq!(
        s.map().same_region(from, inside),
        Some(false),
        "le réduit est scellé"
    );
    assert!(path::find_path(s.map(), from, inside).is_none());

    // La porte est posée comme le ferait la fin d'un chantier : par
    // `Map::set_feature`, qui périme l'index. Le tick suivant le recalcule.
    s.map_mut().set_feature(dx, dy, Feature::DoorWood);
    assert!(s.map().regions_dirty());
    assert_eq!(
        s.map().same_region(from, inside),
        None,
        "index périmé : on ne sait rien, et l'A* tranche"
    );
    // Périmé, l'index ne fait donc **pas** obstacle : le chemin existe déjà.
    assert!(
        path::find_path(s.map(), from, inside).is_some(),
        "une couche périmée ne doit jamais refuser un chemin qui existe"
    );
    s.step(&[]);
    assert_eq!(s.map().same_region(from, inside), Some(true));
    assert!(path::find_path(s.map(), from, inside).is_some());
}

#[test]
fn snapshot_roundtrip_recomputes_regions() {
    let size = 64;
    let mut s = sealed_larder(size);
    for _ in 0..120 {
        s.step(&[]);
    }
    let from = s.pawns()[0].tile();
    let inside = (size / 2 + 10, size / 2);

    let mut back = Sim::restore(&s.snapshot()).expect("snapshot relisible");
    assert_eq!(
        back.state_hash(),
        s.state_hash(),
        "l'index n'entre pas dans le hash"
    );
    // La couche est hors snapshot : elle repart périmée, donc muette.
    assert!(back.map().regions_dirty(), "index absent du snapshot");
    assert_eq!(back.map().same_region(from, inside), None);
    assert_eq!(back.region_rebuilds(), 0, "rien n'a encore été calculé");
    // Et muette, elle ne change rien : la réponse de l'A\* est la même des
    // deux côtés.
    assert_eq!(
        path::find_path(back.map(), from, inside).is_some(),
        path::find_path(s.map(), from, inside).is_some()
    );

    // Le premier tick la recalcule, et elle retrouve exactement le découpage
    // de l'original.
    back.step(&[]);
    s.step(&[]);
    assert_eq!(back.region_rebuilds(), 1);
    assert_eq!(back.map().region_count(), s.map().region_count());
    assert_eq!(back.map().same_region(from, inside), Some(false));
    assert_eq!(
        back.state_hash(),
        s.state_hash(),
        "index recalculé ou non, les deux sims prennent les mêmes décisions"
    );

    // Cent ticks de plus de chaque côté : les futurs ne se séparent pas.
    for _ in 0..100 {
        back.step(&[]);
        s.step(&[]);
    }
    assert_eq!(back.state_hash(), s.state_hash());
}
