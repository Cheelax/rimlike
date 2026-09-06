//! Une charge portée ne se cherche pas avant de savoir où la porter.
//!
//! `crates/sim-cli/CAMPAIGN-FINDINGS.md`, §10. Trois graines de campagne
//! restaient sous les 100 000 ticks/s promis par l'index de régions, et le
//! profil montrait presque tout le temps dans des A\* qui **aboutissent** —
//! donc ni un balayage, ni le cas déjà corrigé du poste hors d'atteinte. Ce
//! qu'il manquait était l'**ordre des questions** :
//!
//! - `try_start_butcher` et `try_start_cook` cherchaient d'abord un chemin vers
//!   la charge (la dépouille, le vivre) et **ensuite** un poste où la porter.
//!   Quand la colonie se referme sur ses pièges, un colon resté dehors a ses
//!   dépouilles sous la main et son poste hors d'atteinte pour toujours : il
//!   payait la recherche vers la charge à chaque tick pour apprendre à chaque
//!   fois la même chose. **111 756 A\*** sur la seule graine 8 en climat chaud ;
//! - `try_start_tame` cherchait d'abord un chemin vers la **bête** et ensuite
//!   vers le fourrage. Une pile de baies devenue injoignable — un feu de camp
//!   ou une forge bâtis par-dessus, l'entrepôt laissé de l'autre côté d'un
//!   mur — condamnait de la même façon toutes les tentatives à venir, sans que
//!   le marquage de la bête ne s'efface jamais. **157 434 A\***.
//!
//! La correction est la même des deux côtés, et c'est celle du rangement et de
//! l'inhumation avant elle : **la question la moins chère d'abord**. Le poste
//! passe devant la charge (`Sim::stations_out_of_reach`, une lecture de l'index
//! de régions par voisine, aucun A\*), le fourrage passe devant la bête. Aucune
//! décision ne change — la campagne de trente graines rend un tableau
//! identique colonne par colonne —, seul l'ordre des vérifications change.
//!
//! Ces tests mesurent du **travail** (`Sim::job_paths`, A\* lancés par la
//! recherche de travail), jamais du temps, comme `jobs_perf.rs`. Ils attendent
//! **zéro** : une cible dont l'index de régions démontre qu'elle est hors
//! d'atteinte ne doit pas coûter un seul A\*, ni pour elle, ni pour la charge
//! qu'on aurait voulu lui porter. Mesuré sur les mêmes scènes avant correction
//! (même révision, mêmes compteurs) : **37, 37 et 36** A\* pour six cents
//! ticks — soit une salve par colon et par `RETRY_TICKS`, indéfiniment. Le
//! chiffre paraît petit parce que la scène est petite : sur une carte de jeu,
//! chacune de ces salves explore toute la région du colon, et un colon occupé
//! n'attend pas `RETRY_TICKS` (voir `Sim::job_retry_due`) — d'où les 111 756 et
//! 157 434 A\* de la campagne.

use sim::testmap::map_from;
use sim::{Command, Feature, ItemKind, Job, Sim, Species, Zone};

/// Dix secondes de jeu : une vingtaine de salves par colon.
const TICKS: u64 = 600;
/// Côté intérieur du réduit scellé.
const ROOM: u32 = 5;
/// Distance des colons au réduit.
const GAP: u32 = 10;
/// Côté de la carte. Assez grande pour que le réduit tienne à `GAP` du centre,
/// assez petite pour que `cargo test` en `debug` reste rapide.
const SIZE: u32 = 48;
/// Baies posées pour l'apprivoisement : de quoi tenir plusieurs tentatives
/// (`livestock::TAME_FOOD` par essai).
const BERRIES: u32 = 30;
/// Dépouilles et vivres posés au pied des colons. Peu importe le nombre : ce
/// qu'on mesure ne doit dépendre ni de lui ni de la surface.
const NEARBY: u32 = 4;

/// Ce qu'on enferme dans le réduit — ou ce qu'on pose à portée de main quand la
/// scène sert de garde-fou.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Sealed {
    /// Le seul poste de fabrication de la carte, muré.
    CraftingSpot,
    /// Le seul feu de camp, muré.
    Campfire,
    /// Le seul entrepôt de la carte et ses baies, murés.
    Fodder,
}

/// Carte plate de terre nue — l'herbe prendrait feu et la lutte contre
/// l'incendie brouillerait la mesure. `Sim::from_map` pose trois colons au
/// centre ; tout est repéré par rapport à lui.
///
/// Un carré de terre ceint de roche tient ce que `what` désigne. Ses voisines
/// sont **franchissables** et pourtant hors d'atteinte : c'est exactement ce
/// que l'index de régions sait démontrer, et exactement ce que les recherches
/// corrigées ne doivent plus payer.
///
/// `reachable` refait la même scène avec la chose posée à côté des colons : le
/// garde-fou du lot, qui vérifie qu'on n'a pas simplement arrêté le travail.
fn scene(what: Sealed, reachable: bool) -> Sim {
    let rows: Vec<String> = (0..SIZE).map(|_| ",".repeat(SIZE as usize)).collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    let mut s = Sim::from_map(1, map_from(&refs));
    let (cx, cy) = (SIZE / 2, SIZE / 2);
    let (x0, y0) = (cx + GAP, cy - ROOM / 2);
    for y in y0 - 1..y0 + ROOM + 1 {
        for x in x0 - 1..x0 + ROOM + 1 {
            let inside = (x0..x0 + ROOM).contains(&x) && (y0..y0 + ROOM).contains(&y);
            if !inside {
                s.map_mut().set_feature(x, y, Feature::Rock);
            }
        }
    }
    // Le lieu de travail : au fond du réduit, ou à trois cases des colons.
    let (tx, ty) = if reachable {
        (cx - 3, cy)
    } else {
        (x0 + ROOM / 2, y0 + ROOM / 2)
    };
    match what {
        Sealed::CraftingSpot => {
            s.map_mut().set_feature(tx, ty, Feature::CraftingSpot);
            for k in 0..NEARBY {
                s.spawn_item(ItemKind::DeerCorpse, 1, cx - 2 + k, cy + 3);
            }
        }
        Sealed::Campfire => {
            s.map_mut().set_feature(tx, ty, Feature::Campfire);
            for k in 0..NEARBY {
                s.spawn_item(ItemKind::Berries, 20, cx - 2 + k, cy + 3);
            }
        }
        Sealed::Fodder => {
            // L'entrepôt et son fourrage : `try_start_tame` n'accepte que des
            // baies **rangées** (`Zone::Stockpile`).
            s.step(&[Command::SetZone {
                zone: Zone::Stockpile,
                x0: tx as i32,
                y0: ty as i32,
                x1: tx as i32,
                y1: ty as i32,
            }]);
            s.spawn_item(ItemKind::Berries, BERRIES, tx, ty);
            // La bête, elle, est au pied des colons : c'est la recherche qu'on
            // ne doit plus payer pour rien.
            let rabbit = s.spawn_animal(cx - 2, cy + 3, Species::Rabbit);
            s.step(&[Command::Tame {
                animal: rabbit,
                on: true,
            }]);
            assert!(
                s.pawns().iter().any(|p| p.id == rabbit && p.tame_marked),
                "le lapin n'est pas marqué"
            );
        }
    }
    // L'index de régions se recalcule au début du tick : un tour à vide, et la
    // scène est prête à être mesurée.
    s.step(&[]);
    s
}

/// A\* lancés par la recherche de travail pendant `TICKS` ticks.
fn paths(what: Sealed) -> u64 {
    let mut s = scene(what, false);
    let before = s.job_paths();
    for _ in 0..TICKS {
        s.step(&[]);
    }
    s.job_paths() - before
}

#[test]
fn un_poste_scelle_ne_fait_plus_chercher_la_depouille() {
    let paths = paths(Sealed::CraftingSpot);
    assert_eq!(
        paths, 0,
        "poste muré, dépouilles sous la main : {paths} A* lancés (37 avant correction)"
    );
}

#[test]
fn un_feu_scelle_ne_fait_plus_chercher_le_vivre() {
    let paths = paths(Sealed::Campfire);
    assert_eq!(
        paths, 0,
        "feu muré, vivres sous la main : {paths} A* lancés (37 avant correction)"
    );
}

#[test]
fn un_fourrage_scelle_ne_fait_plus_chercher_la_bete() {
    let paths = paths(Sealed::Fodder);
    assert_eq!(
        paths, 0,
        "fourrage muré, bête sous la main : {paths} A* lancés (36 avant correction)"
    );
}

#[test]
fn un_poste_a_portee_est_bien_utilise() {
    // Le garde-fou : poser la question du poste en premier ne doit pas empêcher
    // le dépeçage quand le poste est là.
    let mut s = scene(Sealed::CraftingSpot, true);
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
        s.items()
            .iter()
            .any(|i| i.kind == ItemKind::Meat && i.count > 0),
        "le dépeçage n'a rien produit"
    );
}

#[test]
fn un_fourrage_a_portee_envoie_bien_l_eleveur() {
    // Le même garde-fou pour l'apprivoisement : le fourrage d'abord ne veut pas
    // dire le fourrage jamais.
    let mut s = scene(Sealed::Fodder, true);
    let mut tamed = false;
    for _ in 0..TICKS {
        s.step(&[]);
        tamed |= s.pawns().iter().any(|p| matches!(p.job, Job::Tame { .. }));
    }
    assert!(tamed, "aucun colon n'est parti apprivoiser");
}
