//! L'inhumation ne doit pas coûter un balayage de carte par colon et par tick.
//!
//! `try_start_bury` avait exactement le défaut du rangement corrigé au commit
//! `4621f65` : la recherche d'une tombe vide parcourait les cases de la carte
//! une par une, à chaque appel, alors qu'un compteur (`Map::grave_count`) ne
//! servait que de garde à l'entrée. Dès qu'une seule tombe était creusée,
//! chaque colon inactif refaisait le balayage complet à chaque tick.
//!
//! Ces tests mesurent du **travail** (`Sim::bury_scans`, tombes examinées),
//! jamais du temps : un chronomètre ne veut rien dire en intégration continue.
//! Ce qu'ils vérifient tient en une phrase — le coût de l'inhumation par tick
//! ne dépend ni de la surface de la carte, ni du nombre de cadavres au sol.

use sim::{EventKind, Feature, ItemKind, Map, Sim, Terrain};

/// Cimetière carré de 4 cases de côté.
const SIDE: u32 = 4;
/// Tombes de la scène.
const GRAVES: u64 = (SIDE * SIDE) as u64;
/// Cinq secondes de jeu : assez pour que les trois colons relancent leur
/// recherche des centaines de fois.
const TICKS: u64 = 600;
/// Colons posés par `Sim::from_map`.
const COLONISTS: u64 = 3;
/// Rayon de l'enceinte de roche qui enferme les colons et leur cimetière.
const WALL: i32 = 8;

/// Carte plate `size × size` : `Sim::from_map` y pose trois colons au centre.
///
/// `walled` mure les colons dans une enceinte de roche avec leurs tombes : les
/// cadavres, eux, restent au loin dans le coin nord-ouest, donc **hors
/// d'atteinte**. C'est le cas pathologique — la recherche échoue et
/// recommence, tick après tick, pour chaque colon — et c'est le seul qui reste
/// stable sur toute la mesure, puisqu'aucune tombe ne se remplit.
fn scene(size: u32, corpses: u32, walled: bool) -> Sim {
    let rows: Vec<String> = (0..size).map(|_| ".".repeat(size as usize)).collect();
    let refs: Vec<&str> = rows.iter().map(|s| s.as_str()).collect();
    let mut s = Sim::from_map(1, sim::testmap::map_from(&refs));
    let (cx, cy) = (size / 2, size / 2);
    for dy in 0..SIDE {
        for dx in 0..SIDE {
            s.map_mut()
                .set_feature(cx + 2 + dx, cy + 2 + dy, Feature::Grave);
        }
    }
    assert_eq!(s.map().grave_count() as u64, GRAVES, "cimetière incomplet");
    if walled {
        for d in -WALL..=WALL {
            for (x, y) in [
                (cx as i32 + d, cy as i32 - WALL),
                (cx as i32 + d, cy as i32 + WALL),
                (cx as i32 - WALL, cy as i32 + d),
                (cx as i32 + WALL, cy as i32 + d),
            ] {
                s.map_mut().set_feature(x as u32, y as u32, Feature::Rock);
            }
        }
    }
    // Un cadavre toutes les deux cases, pour qu'aucun ne fusionne avec son
    // voisin, loin des colons et de leurs tombes.
    for k in 0..corpses {
        let x = 1 + 2 * (k % 20);
        let y = 1 + 2 * (k / 20);
        assert!(x < cx && y < cy, "la scène ne tient pas sur la carte");
        s.spawn_item(ItemKind::Corpse, 1, x, y);
    }
    s
}

/// Tombes examinées pendant `TICKS` ticks de la scène.
fn scans(size: u32, corpses: u32, walled: bool) -> u64 {
    let mut s = scene(size, corpses, walled);
    let before = s.bury_scans();
    for _ in 0..TICKS {
        s.step(&[]);
    }
    s.bury_scans() - before
}

/// Plafond : par tick et par colon, un relevé du cimetière (`GRAVES` tombes)
/// plus au plus `PATH_ATTEMPTS` = 6 recherches de sépulture, soit sept
/// passages sur les tombes — plus une marge. Avant l'index, la même scène
/// examinait les 9 216 cases de la carte à chaque appel.
const CEILING: u64 = TICKS * COLONISTS * GRAVES * 8;

#[test]
fn un_cimetiere_hors_datteinte_ne_balaie_plus_la_carte() {
    let scans = scans(96, 60, true);
    assert!(
        scans <= CEILING,
        "cadavres hors d'atteinte : {scans} tombes examinées, plafond {CEILING}"
    );
}

#[test]
fn le_cout_de_linhumation_ne_depend_pas_de_la_surface() {
    // Quatre fois la surface (96×96 → 192×192) : avant l'index, la note
    // suivait exactement le rapport des surfaces.
    let petite = scans(96, 60, true);
    let grande = scans(192, 60, true);
    assert!(
        grande <= petite * 3 / 2,
        "quadrupler la surface a multiplié l'inhumation : {petite} → {grande}"
    );
}

#[test]
fn le_cout_de_linhumation_ne_depend_pas_du_nombre_de_cadavres() {
    // Non-régression, pas correction : `PATH_ATTEMPTS` bornait déjà les
    // cadavres examinés avant l'index (c'est la seule différence avec le
    // rangement du constat n°1, où la borne ne s'armait jamais). Le test est
    // là pour que ça le reste.
    let peu = scans(96, 10, true);
    let beaucoup = scans(96, 60, true);
    assert!(
        beaucoup <= peu * 3 / 2,
        "six fois plus de cadavres ont multiplié l'inhumation : {peu} → {beaucoup}"
    );
}

#[test]
fn un_cadavre_atteignable_est_toujours_enterre() {
    // Le garde-fou du lot : accélérer la recherche ne doit pas l'arrêter.
    let mut s = scene(96, 4, false);
    let mut buried = false;
    for _ in 0..12_000 {
        s.step(&[]);
        buried |= s.events().iter().any(|e| e.kind == EventKind::Buried);
        if buried {
            break;
        }
    }
    assert!(buried, "aucun cadavre enterré : {:?}", s.items());
    assert!(
        (s.map().grave_count() as u64) < GRAVES,
        "aucune tombe ne s'est remplie"
    );
}

#[test]
fn lindex_suit_les_tombes_creusees_et_remplies() {
    let mut s = scene(32, 0, false);
    let tiles: Vec<(u32, u32)> = s.map().grave_tiles().to_vec();
    assert_eq!(tiles.len() as u64, GRAVES, "index incomplet : {tiles:?}");
    let mut sorted = tiles.clone();
    sorted.sort_unstable();
    assert_eq!(tiles, sorted, "index non trié");
    // Une tombe qu'on remplit sort de l'index ; le compteur suit.
    let (x, y) = tiles[0];
    s.map_mut().set_feature(x, y, Feature::GraveFilled);
    assert_eq!(s.map().grave_tiles().len() as u64, GRAVES - 1);
    assert_eq!(s.map().grave_count() as u64, GRAVES - 1);
    assert!(!s.map().grave_tiles().contains(&(x, y)));
    // Et une tombe qu'on creuse y rentre à sa place, l'ordre tenu.
    s.map_mut().set_feature(x, y, Feature::Grave);
    assert_eq!(s.map().grave_tiles(), tiles.as_slice());
    // L'index survit à un aller-retour de snapshot : il est de l'état.
    let b = Sim::restore(&s.snapshot()).expect("snapshot relisible");
    assert_eq!(b.map().grave_tiles(), tiles.as_slice());
}

#[test]
fn lindex_est_trie_des_la_construction() {
    // Une carte bâtie en couches (`Map::from_layers`, par où passe aussi
    // `Map::generate`) parcourt les éléments **par rangée**, donc en ordre
    // `(y, x)` ; l'index, lui, doit être trié `(x, y)`, l'ordre du tuple, sans
    // quoi la recherche binaire de `set_feature` regarde à côté.
    let (w, h) = (5u32, 4u32);
    let tiles = vec![Terrain::Grass as u8; (w * h) as usize];
    let mut features = vec![Feature::None as u8; (w * h) as usize];
    for &(x, y) in &[(3u32, 0u32), (1, 1), (4, 2), (0, 3)] {
        features[(y * w + x) as usize] = Feature::Grave as u8;
    }
    let mut map = Map::from_layers(w, h, tiles, features);
    assert_eq!(map.grave_count(), 4);
    assert_eq!(map.grave_tiles(), [(0, 3), (1, 1), (3, 0), (4, 2)]);
    // Et la mise à jour retrouve bien ses petits dans cet ordre-là.
    map.set_feature(3, 0, Feature::GraveFilled);
    assert_eq!(map.grave_tiles(), [(0, 3), (1, 1), (4, 2)]);
}

#[test]
fn le_compteur_de_mesure_ne_touche_pas_a_letat() {
    // `Sim::bury_scans` compte du travail, pas de l'état : deux sims arrivées
    // au même endroit par des chemins différents restent égales et de même
    // hash, et un aller-retour de snapshot ne le fait pas revenir.
    let mut a = scene(96, 10, true);
    for _ in 0..300 {
        a.step(&[]);
    }
    let b = Sim::restore(&a.snapshot()).expect("snapshot relisible");
    assert_eq!(a.state_hash(), b.state_hash());
    assert_eq!(a, b);
    assert!(a.bury_scans() > 0);
    assert_eq!(b.bury_scans(), 0, "le compteur ne sort pas du snapshot");
}
