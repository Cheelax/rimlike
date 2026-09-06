//! Aucune recherche de travail ne doit relancer un A\* **raté** à chaque tick.
//!
//! `crates/sim-cli/CAMPAIGN-FINDINGS.md`, §3, « le poste hors d'atteinte » :
//! profil sur une graine de campagne à 2 600 ticks/s, 88 % des piles dans
//! `do_butcher` → `path_adjacent_for` → `path::find_path_for`. Un colon
//! retenait le poste de fabrication le plus proche de sa dépouille **sans se
//! demander s'il y menait un chemin** : il allait la chercher, la ramassait,
//! découvrait le mur, la reposait — et recommençait au tick suivant. Chaque
//! tour coûtait les huit voisines du poste, et un A\* qui échoue explore
//! **toute** la région où se tient le colon avant de rendre `None`.
//!
//! Le même patron valait pour la fabrication (`try_start_craft`, découverte
//! dans `pick_ingredient`), et les recherches qui visent un poste sans le
//! porter — recherche à l'établi, chasse, réarmement — relançaient jusqu'à
//! six candidats fois huit voisines, soit quarante-huit A\* ratés, à chaque
//! tick et pour chaque colon inactif.
//!
//! La correction tient en trois pièces, les mêmes partout : le poste est
//! vérifié **au démarrage** (plus de ramasse-repose), un **budget** de
//! `PATH_ATTEMPTS` candidats borne l'appel entier, et `jobs::RETRY_TICKS`
//! espace les tentatives — mais seulement pour le colon qui **tourne à vide**,
//! sinon la cadence ferait tomber les travaux de fin de liste (recherche,
//! rangement) au profit des premiers (voir `Sim::job_retry_due`).
//!
//! Ces tests mesurent du **travail** (`Sim::job_paths`, A\* lancés par la
//! recherche de travail), jamais du temps : un chronomètre ne veut rien dire
//! en intégration continue. Ce qu'ils vérifient tient en une phrase — le coût
//! de la recherche par tick ne dépend ni du nombre de cibles au sol, ni de la
//! surface de la carte, et le travail se fait quand même dès qu'un poste est
//! à portée.

use sim::jobs::RETRY_TICKS;
use sim::testmap::map_from;
use sim::{Command, Feature, ItemKind, Job, Sim};

/// Cinq secondes de jeu : assez pour que les trois colons relancent leur
/// recherche des centaines de fois.
const TICKS: u64 = 600;
/// Deux secondes de jeu : la tranche courte, pour la comparaison de surfaces —
/// sur une carte quatre fois plus grande, chaque A\* qui échoue coûte quatre
/// fois plus cher, et la conclusion se lit aussi bien sur deux cents ticks.
const SHORT: u64 = 200;
/// Colons posés par `Sim::from_map`.
const COLONISTS: u64 = 3;
/// `jobs::PATH_ATTEMPTS`, qui n'est pas public : les candidats qu'une
/// recherche a le droit d'examiner, postes et cibles confondus.
const PATH_ATTEMPTS: u64 = 6;
/// Voisines d'une case. Un poste est infranchissable : on s'en approche, et le
/// candidat le plus cher — un poste muré — vaut ses huit voisines avant de
/// rendre son verdict.
const NEIGHBOURS: u64 = 8;
/// Postes de fabrication de la scène mesurée : **un seul**, et muré. La salve
/// ne l'examine donc qu'une fois par recherche — le tableau des inatteignables
/// interdit de le retester dans le même appel.
const STATIONS: u64 = 1;
/// Recherches bornées que la scène met en jeu : le **dépeçage** (des
/// dépouilles au sol, un poste muré) et la **fabrication** (un objectif d'arcs,
/// du bois au sol, le même poste muré). Chacune a son propre budget, et un
/// colon les essaie toutes les deux dans la même salve — d'où le facteur deux
/// du plafond. Les autres recherches corrigées dorment ici : ni établi, ni
/// gibier marqué, ni piège déclenché sur la carte.
const SEARCHES: u64 = 2;

/// Côté intérieur du réduit muré.
const ROOM: u32 = 5;
/// Distance des colons au réduit, en cases.
const GAP: u32 = 10;
/// Bois posé près des colons : **un seul arc** (douze bûches). Assez pour que
/// la fabrication cherche son atelier à chaque salve, trop peu pour occuper
/// les trois colons — sans quoi aucun n'irait jamais dépecer.
const WOOD: u32 = 12;
/// Dépouilles posées au pied des colons dans la scène du garde-fou. Un colon
/// avance d'une case en une dizaine de ticks : le charnier du nord-ouest est à
/// quarante cases, soit plus que les cinq secondes de jeu mesurées.
const NEARBY: u32 = 5;
/// Objectif de fabrication posé par le joueur.
const BOWS: u32 = 5;

/// Carte plate `size × size` de terre nue — l'herbe prendrait feu au-dessus de
/// `GRASS_FIRE_TEMP` et la lutte contre l'incendie viendrait brouiller la
/// mesure. `Sim::from_map` y pose trois colons au centre, et tout est repéré
/// par rapport à ce centre pour que la même scène tienne à n'importe quelle
/// taille de carte.
///
/// Le réduit est le cœur du décor : un carré de terre nue ceint d'un mur de
/// roche, le poste de fabrication au milieu. Ses huit voisines sont
/// **franchissables** et pourtant hors d'atteinte — exactement ce que
/// `path_adjacent_for` retient, et exactement ce qui coûte cher.
///
/// `open_spot` ajoute **deux** postes à portée de main et un petit tas de
/// dépouilles au pied des colons : c'est le garde-fou du lot, il prouve que
/// borner la recherche n'a pas arrêté le travail. Deux postes et non un : le
/// fabricant en réserve un pour la durée de son ouvrage, et un poste réservé
/// n'est plus un poste pour le dépeceur.
fn scene(size: u32, corpses: u32, open_spot: bool) -> Sim {
    let rows: Vec<String> = (0..size).map(|_| ",".repeat(size as usize)).collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    let mut s = Sim::from_map(1, map_from(&refs));
    let (cx, cy) = (size / 2, size / 2);
    let x0 = cx + GAP;
    let y0 = cy - ROOM / 2;
    for y in y0 - 1..y0 + ROOM + 1 {
        for x in x0 - 1..x0 + ROOM + 1 {
            let inside = (x0..x0 + ROOM).contains(&x) && (y0..y0 + ROOM).contains(&y);
            if !inside {
                s.map_mut().set_feature(x, y, Feature::Rock);
            }
        }
    }
    s.map_mut()
        .set_feature(x0 + ROOM / 2, y0 + ROOM / 2, Feature::CraftingSpot);
    if open_spot {
        // Hors du carré de trois cases où `spawn_starting_pawns` a posé les
        // colons, et assez près pour tenir dans les cinq secondes mesurées.
        s.map_mut()
            .set_feature(cx - 3, cy - 1, Feature::CraftingSpot);
        s.map_mut()
            .set_feature(cx - 3, cy + 1, Feature::CraftingSpot);
        for k in 0..NEARBY {
            s.spawn_item(ItemKind::DeerCorpse, 1, cx - 2 + k, cy + 3);
        }
    }
    assert_eq!(
        s.map().crafting_spot_count(),
        1 + 2 * u32::from(open_spot),
        "postes de fabrication manquants"
    );
    // Une dépouille toutes les deux cases, pour qu'aucune ne fusionne avec sa
    // voisine, loin des colons comme du réduit.
    for k in 0..corpses {
        let x = 1 + 2 * (k % 20);
        let y = 1 + 2 * (k / 20);
        assert!(x < cx && y < cy, "la scène ne tient pas sur la carte");
        s.spawn_item(ItemKind::DeerCorpse, 1, x, y);
    }
    s.spawn_item(ItemKind::Wood, WOOD, cx, cy + 2);
    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Bow,
        target: BOWS,
    }]);
    s
}

/// A\* lancés par la recherche de travail pendant `ticks` ticks de la scène.
fn paths(size: u32, corpses: u32, ticks: u64) -> u64 {
    let mut s = scene(size, corpses, false);
    let before = s.job_paths();
    for _ in 0..ticks {
        s.step(&[]);
    }
    s.job_paths() - before
}

/// Plafond : par colon et par **salve** (un tick sur `RETRY_TICKS`), chacune
/// des deux recherches examine le poste muré une fois — ses huit voisines — et
/// n'a plus droit qu'à ses `PATH_ATTEMPTS` essais pour la suite. Le compte
/// exact est un peu au-dessus : un colon qui part flâner repart d'un
/// `idle_ticks` remis à zéro, donc d'une recherche non freinée à son retour
/// (voir `Sim::job_retry_due`). D'où la marge.
///
/// Mesuré : **629** A\* sur les 1 680 permis, et le même chiffre à 10
/// dépouilles comme à 60, sur 192×192 comme sur 96×96. La même scène lançait
/// **2 718** recherches de chemin avant correction, contre **634** après (tous
/// chemins confondus), et passait de **377 à 1 549 ticks/s** en `release`.
const CEILING: u64 =
    TICKS * COLONISTS * SEARCHES * (STATIONS * NEIGHBOURS + PATH_ATTEMPTS) / RETRY_TICKS;

#[test]
fn un_poste_inatteignable_ne_relance_plus_un_a_star_par_tick() {
    let paths = paths(96, 60, TICKS);
    assert!(
        paths <= CEILING,
        "poste muré, 60 dépouilles : {paths} A* lancés, plafond {CEILING}"
    );
}

#[test]
fn le_cout_de_la_recherche_ne_depend_pas_du_nombre_de_depouilles() {
    // Six fois plus de dépouilles. Avant correction, chacune valait un tour de
    // ramasse-repose supplémentaire : la note suivait le tas.
    let peu = paths(96, 10, TICKS);
    let beaucoup = paths(96, 60, TICKS);
    assert!(
        beaucoup <= peu * 3 / 2,
        "six fois plus de dépouilles ont multiplié la recherche : {peu} → {beaucoup}"
    );
    assert!(
        beaucoup <= CEILING,
        "poste muré, 60 dépouilles : {beaucoup} A* lancés, plafond {CEILING}"
    );
}

#[test]
fn le_cout_de_la_recherche_ne_depend_pas_de_la_surface() {
    // Quatre fois la surface (96×96 → 192×192). Le compteur ne voit pas le
    // prix d'un A\*, seulement leur nombre — mais c'est bien la surface qui
    // fait ce prix quand la recherche échoue, puisqu'elle explore toute la
    // région du colon avant de rendre `None`. C'est aussi pour cela que la
    // comparaison tourne sur `SHORT` ticks : en `debug`, sur 192×192, la même
    // conclusion coûterait une minute de plus pour rien.
    let petite = paths(96, 60, SHORT);
    let grande = paths(192, 60, SHORT);
    assert!(
        grande <= petite * 3 / 2,
        "quadrupler la surface a multiplié la recherche : {petite} → {grande}"
    );
}

#[test]
fn un_poste_atteignable_est_bien_utilise() {
    // Le garde-fou du lot : borner et espacer la recherche ne doit pas
    // empêcher un colon de dépecer au poste qui est à sa portée.
    let mut s = scene(96, 60, true);
    let mut butchered = false;
    let mut crafted = false;
    for _ in 0..TICKS {
        s.step(&[]);
        for p in s.pawns() {
            butchered |= matches!(p.job, Job::Butcher { .. });
            crafted |= matches!(p.job, Job::Craft { .. });
        }
    }
    assert!(butchered, "aucun colon n'est parti dépecer");
    assert!(crafted, "aucun colon n'est parti fabriquer");
    // `craft::BUTCHER_TICKS` vaut 120 : cinq secondes de jeu suffisent
    // largement à débiter une dépouille, viande et cuir au pied du poste.
    assert!(
        s.items()
            .iter()
            .any(|i| i.kind == ItemKind::Meat && i.count > 0),
        "le dépeçage n'a rien produit"
    );
}
