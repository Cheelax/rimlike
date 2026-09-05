//! Le rangement ne doit plus coûter un balayage de carte par pile au sol.
//!
//! Constat n°1 de `crates/sim-cli/CAMPAIGN-FINDINGS.md` : entrepôt saturé, le
//! sim tombait à 714 ticks/s à 60 piles au sol, 1 870 fois sous la même scène
//! entrepôt libre, et le coût était linéaire en piles **et** en surface de
//! carte. Deux défauts : la recherche d'une case de rangement parcourait la
//! carte entière, et la borne `PATH_ATTEMPTS` ne s'armait jamais quand aucune
//! pile n'avait de destination.
//!
//! Ces tests mesurent du **travail** (`Sim::haul_scans`, cases d'entrepôt
//! examinées), jamais du temps : un chronomètre ne veut rien dire en
//! intégration continue. Ce qu'ils vérifient tient en une phrase — le coût du
//! rangement par tick ne dépend ni de la surface de la carte, ni du nombre de
//! piles au sol.

use sim::items::STACK_MAX;
use sim::{Command, ItemKind, Sim, Zone};

/// Entrepôt carré de 4 cases de côté : celui du joueur scripté des campagnes.
const SIDE: u32 = 4;
/// Cases d'entrepôt de la scène.
const SLOTS: u64 = (SIDE * SIDE) as u64;
/// Cinq secondes de jeu : assez pour que les trois colons relancent leur
/// recherche des centaines de fois.
const TICKS: u64 = 600;
/// Colons posés par `Sim::from_map`.
const COLONISTS: u64 = 3;

/// Ce qu'on met dans l'entrepôt avant de lâcher les colons.
#[derive(Clone, Copy, PartialEq, Eq)]
enum Fill {
    /// Rien : tout se range.
    Free,
    /// Une pile pleine par case : plus une seule ne prend quoi que ce soit.
    /// C'est la saturation, le cas mesuré par le rapport.
    Saturated,
    /// Une pile de bois **incomplète** par case : l'entrepôt a encore de la
    /// place, mais pas pour la pierre qui traîne au sol. C'est le cas qui
    /// n'armait jamais `PATH_ATTEMPTS`.
    WoodOnly,
}

/// Carte plate `size × size` : `Sim::from_map` y pose trois colons au centre.
/// L'entrepôt est collé à eux, les `piles` piles au sol sont au loin, dans le
/// coin nord-ouest. Tout est repéré par rapport au centre pour que la même
/// scène tienne à n'importe quelle taille de carte.
fn scene(size: u32, piles: u32, fill: Fill) -> Sim {
    let rows: Vec<String> = (0..size).map(|_| ".".repeat(size as usize)).collect();
    let refs: Vec<&str> = rows.iter().map(|s| s.as_str()).collect();
    let mut s = Sim::from_map(1, sim::testmap::map_from(&refs));
    let (cx, cy) = (size / 2, size / 2);
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: (cx + 2) as i32,
        y0: (cy + 2) as i32,
        x1: (cx + 1 + SIDE) as i32,
        y1: (cy + 1 + SIDE) as i32,
    }]);
    assert_eq!(
        s.map().stockpile_count() as u64,
        SLOTS,
        "entrepôt incomplet"
    );
    let stock: Vec<(u32, u32)> = s.map().stockpile_tiles().to_vec();
    match fill {
        Fill::Free => {}
        Fill::Saturated => {
            for (x, y) in stock {
                s.spawn_item(ItemKind::Wood, STACK_MAX, x, y);
            }
        }
        Fill::WoodOnly => {
            for (x, y) in stock {
                s.spawn_item(ItemKind::Wood, 10, x, y);
            }
        }
    }
    // Les piles au sol : du bois quand l'entrepôt est plein ou vide, de la
    // pierre quand il ne veut plus que du bois.
    let kind = if fill == Fill::WoodOnly {
        ItemKind::Stone
    } else {
        ItemKind::Wood
    };
    // Une pile toutes les deux cases, pour qu'aucune ne fusionne avec sa
    // voisine, à l'écart de l'entrepôt et des colons.
    let mut placed = 0;
    let mut k = 0;
    while placed < piles {
        let x = 1 + 2 * (k % 20);
        let y = 1 + 2 * (k / 20);
        k += 1;
        assert!(x < cx && y < cy, "la scène ne tient pas sur la carte");
        s.spawn_item(kind, 10, x, y);
        placed += 1;
    }
    s
}

/// Cases d'entrepôt examinées pendant `TICKS` ticks de la scène.
fn scans(size: u32, piles: u32, fill: Fill) -> u64 {
    let mut s = scene(size, piles, fill);
    let before = s.haul_scans();
    for _ in 0..TICKS {
        s.step(&[]);
    }
    s.haul_scans() - before
}

/// Plafond : par tick et par colon, un relevé de l'entrepôt (`SLOTS` cases)
/// plus au plus `PATH_ATTEMPTS` = 6 recherches de destination, soit sept
/// passages sur les cases d'entrepôt — plus une marge pour les appels isolés
/// de `do_haul`, qui refont un relevé quand un colon repose son fardeau.
/// Mesuré : 15 040 (entrepôt saturé) et 105 280 (entrepôt qui ne prend plus
/// que du bois) sur les 230 400 permis.
const CEILING: u64 = TICKS * COLONISTS * SLOTS * 8;

#[test]
fn un_entrepot_sature_ne_balaie_plus_la_carte() {
    let scans = scans(96, 60, Fill::Saturated);
    assert!(
        scans <= CEILING,
        "entrepôt saturé : {scans} cases examinées, plafond {CEILING}"
    );
}

#[test]
fn un_entrepot_qui_refuse_le_genre_arme_la_borne_dessais() {
    // Sans le comptage des essais infructueux, cette scène traitait les 60
    // piles à chaque tick et pour chaque colon.
    let scans = scans(96, 60, Fill::WoodOnly);
    assert!(
        scans <= CEILING,
        "entrepôt qui ne prend que du bois : {scans} cases examinées, plafond {CEILING}"
    );
}

#[test]
fn le_cout_du_rangement_ne_depend_pas_de_la_surface() {
    // Quatre fois la surface (96×96 → 192×192) : avant, la note suivait
    // exactement le rapport des surfaces.
    let petite = scans(96, 60, Fill::Saturated);
    let grande = scans(192, 60, Fill::Saturated);
    assert!(
        grande <= petite * 3 / 2,
        "quadrupler la surface a multiplié le rangement : {petite} → {grande}"
    );
}

#[test]
fn le_cout_du_rangement_ne_depend_pas_du_nombre_de_piles() {
    // Six fois plus de piles au sol : avant, la note était linéaire en piles.
    let peu = scans(96, 10, Fill::Saturated);
    let beaucoup = scans(96, 60, Fill::Saturated);
    assert!(
        beaucoup <= peu * 3 / 2,
        "six fois plus de piles ont multiplié le rangement : {peu} → {beaucoup}"
    );
    // Même chose sur le cas qui n'armait pas la borne d'essais.
    let peu = scans(96, 10, Fill::WoodOnly);
    let beaucoup = scans(96, 60, Fill::WoodOnly);
    assert!(
        beaucoup <= peu * 3 / 2,
        "six fois plus de piles, entrepôt qui ne prend que du bois : {peu} → {beaucoup}"
    );
}

#[test]
fn un_entrepot_libre_range_toujours() {
    // Le garde-fou du lot : accélérer le rangement ne doit pas l'arrêter.
    let mut s = scene(96, 10, Fill::Free);
    for _ in 0..6_000 {
        s.step(&[]);
    }
    let stored = s
        .items()
        .iter()
        .filter(|i| s.map().zone(i.x, i.y) == Zone::Stockpile && i.kind == ItemKind::Wood)
        .count();
    assert!(stored > 0, "rien n'a été rangé : {:?}", s.items());
}

#[test]
fn une_case_ajoutee_relance_le_rangement() {
    // L'entrepôt saturé s'agrandit d'une rangée : le rangement doit repartir,
    // sans qu'aucun court-circuit ne reste bloqué sur « plus rien ne rentre ».
    let size = 96;
    let (cx, cy) = (size / 2, size / 2);
    let mut s = scene(size, 10, Fill::Saturated);
    for _ in 0..600 {
        s.step(&[]);
    }
    assert_eq!(s.map().stockpile_count() as u64, SLOTS);
    let y = (cy + 2 + SIDE) as i32;
    s.step(&[Command::SetZone {
        zone: Zone::Stockpile,
        x0: (cx + 2) as i32,
        y0: y,
        x1: (cx + 1 + SIDE) as i32,
        y1: y,
    }]);
    assert_eq!(s.map().stockpile_count() as u64, SLOTS + u64::from(SIDE));
    let neuf = |s: &Sim| s.items().iter().any(|i| i.y == y as u32);
    assert!(
        (0..12_000).any(|_| {
            s.step(&[]);
            neuf(&s)
        }),
        "la rangée ajoutée n'a jamais reçu de pile"
    );
}

#[test]
fn le_compteur_de_mesure_ne_touche_pas_a_letat() {
    // `Sim::haul_scans` compte du travail, pas de l'état : deux sims arrivées
    // au même endroit par des chemins différents restent égales et de même
    // hash, et un aller-retour de snapshot ne le fait pas revenir.
    let mut a = scene(96, 10, Fill::Saturated);
    for _ in 0..300 {
        a.step(&[]);
    }
    let b = Sim::restore(&a.snapshot()).expect("snapshot relisible");
    assert_eq!(a.state_hash(), b.state_hash());
    assert_eq!(a, b);
    assert!(a.haul_scans() > 0);
    assert_eq!(b.haul_scans(), 0, "le compteur ne sort pas du snapshot");
}
