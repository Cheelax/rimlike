//! L'échelle du jour (`Sim::day_scale`, `docs/time.md`) : un test par famille
//! de constantes, plus le snapshot qui porte l'échelle.
//!
//! Ce que ces tests protègent, dans l'ordre du classement :
//! - **travail** : un chantier prend K fois plus de ticks ;
//! - **physique** : la marche prend le même nombre de ticks ;
//! - **jours** : la faim tombe au même point du jour ;
//! - **snapshot** : l'échelle voyage avec l'état, et un tampon d'avant se relit
//!   à l'échelle 1.

use sim::pawn::HUNGRY;
use sim::testmap::map_from;
use sim::{Biome, BuildKind, Command, ItemKind, Material, Sim, WorkType};

/// Clairière sans buisson ni arbre : rien à manger, rien à couper. Les colons
/// n'y font que ce qu'on leur demande.
fn bare(scale: u32) -> Sim {
    let map = map_from(&[
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
        "............",
    ]);
    Sim::from_map_scaled(1, map, scale)
}

// ----------------------------------------------------------------------
// Famille « travail » : un chantier s'étire avec l'échelle
// ----------------------------------------------------------------------

/// Ticks **de travail effectif** pour bâtir un mur de bois, à l'échelle
/// donnée : ceux où la barre de progression du chantier avance, et eux seuls.
/// La marche, la livraison et l'attente ne comptent pas — ce sont des durées
/// physiques, et c'est justement ce que la comparaison doit isoler.
fn build_work_ticks(scale: u32) -> u64 {
    let mut s = bare(scale);
    s.spawn_item(ItemKind::Wood, 20, 6, 6);
    // Un seul bâtisseur : les trois colons n'ont ni la même compétence ni la
    // même humeur, et laisser le sim choisir ferait comparer deux ouvriers
    // différents plutôt que deux échelles.
    let others: Vec<u32> = s.pawns().iter().skip(1).map(|p| p.id).collect();
    let off: Vec<Command> = others
        .iter()
        .flat_map(|&pawn| {
            [WorkType::Build, WorkType::Haul].map(|work| Command::SetPriority {
                pawn,
                work,
                priority: 0,
            })
        })
        .collect();
    s.step(&off);
    s.step(&[Command::Build {
        kind: BuildKind::Wall,
        material: Material::Wood,
        x0: 4,
        y0: 2,
        x1: 4,
        y1: 2,
    }]);
    assert_eq!(s.blueprints().len(), 1, "le plan de mur n'est pas posé");
    let mut working = 0;
    let mut before = 0;
    for _ in 0..40 * u64::from(s.ticks_per_day()) {
        if s.blueprints().is_empty() {
            return working;
        }
        s.step(&[]);
        let now = s.blueprints().first().map_or(0, |b| b.progress);
        if now > before {
            working += 1;
        }
        before = now;
    }
    panic!("le mur n'a jamais été bâti à l'échelle {scale}");
}

#[test]
fn un_chantier_prend_quatre_fois_plus_de_ticks_a_l_echelle_quatre() {
    let one = build_work_ticks(1);
    let four = build_work_ticks(4);
    assert!(one > 0, "aucun tick de travail mesuré à l'échelle 1");
    // Le rapport n'est pas entier à l'unité près : le dernier tick d'une barre
    // de progression déborde le seuil, et ce débordement ne se multiplie pas
    // par quatre. Un pour cent de marge suffit à le couvrir, et laisse le test
    // échouer si l'échelle n'était pas appliquée (rapport 1) ou appliquée deux
    // fois (rapport 16).
    let ratio = four * 1000 / one;
    assert!(
        (3_960..=4_040).contains(&ratio),
        "un mur doit coûter quatre fois plus de ticks de travail à K = 4 : \
         {four} contre {one}, soit un rapport de {ratio} millièmes"
    );
}

// ----------------------------------------------------------------------
// Famille « physique » : la marche ne bouge pas
// ----------------------------------------------------------------------

/// Ticks mis par un colon pour rejoindre une case à dix pas, à l'échelle
/// donnée. L'ordre du joueur n'est pas interruptible par la faim
/// (`Job::Move { manual: true }`) : la mesure ne dépend que de la vitesse.
fn walk_ticks(scale: u32) -> u64 {
    let mut s = bare(scale);
    let id = s.pawns()[0].id;
    let from = s.pawns()[0].tile();
    let target = (from.0.saturating_sub(5), from.1);
    s.step(&[Command::MoveTo {
        pawn: id,
        x: target.0,
        y: target.1,
    }]);
    let start = s.tick();
    for _ in 0..10_000 {
        if s.pawns()[0].tile() == target && !s.pawns()[0].is_moving() {
            return s.tick() - start;
        }
        s.step(&[]);
    }
    panic!("le colon n'a jamais atteint {target:?} à l'échelle {scale}");
}

#[test]
fn la_marche_prend_le_meme_nombre_de_ticks_a_toutes_les_echelles() {
    let one = walk_ticks(1);
    let four = walk_ticks(4);
    assert!(one > 0, "la marche n'a pris aucun tick");
    assert_eq!(
        one, four,
        "la marche est physique : elle ne doit pas s'étirer ({one} contre {four})"
    );
}

// ----------------------------------------------------------------------
// Famille « en jours » : la faim tombe au même point du jour
// ----------------------------------------------------------------------

/// Millièmes de jour de jeu écoulés avant que le premier colon ait faim, à
/// l'échelle donnée. Rien à manger sur la carte : personne ne vient fausser la
/// mesure en se servant.
fn hungry_at_permille_of_day(scale: u32) -> u64 {
    let mut s = bare(scale);
    let day = u64::from(s.ticks_per_day());
    for _ in 0..2 * day {
        if s.pawns()[0].hunger < HUNGRY {
            return s.tick() * 1000 / day;
        }
        s.step(&[]);
    }
    panic!("personne n'a eu faim en deux jours à l'échelle {scale}");
}

#[test]
fn la_faim_tombe_au_meme_point_du_jour_a_toutes_les_echelles() {
    let one = hungry_at_permille_of_day(1);
    let four = hungry_at_permille_of_day(4);
    assert!(one > 0, "la faim est tombée au tick 0");
    assert_eq!(
        one, four,
        "la faim est en jours : elle doit tomber au même point du jour \
         ({one} ‰ contre {four} ‰)"
    );
}

// ----------------------------------------------------------------------
// L'échelle dans l'état
// ----------------------------------------------------------------------

#[test]
fn l_echelle_un_est_l_identite_octet_pour_octet() {
    let plain = Sim::new(7, 32, 32);
    let scaled = Sim::new_scaled(7, 32, 32, Biome::default(), 1);
    assert_eq!(plain.day_scale(), 1);
    assert_eq!(
        plain.snapshot(),
        scaled.snapshot(),
        "à l'échelle 1, le champ ne doit pas écrire un seul octet"
    );
    assert_eq!(plain.state_hash(), scaled.state_hash());
    assert_eq!(plain.ticks_per_day(), sim::TICKS_PER_DAY);
}

#[test]
fn une_echelle_hors_bornes_retombe_sur_un() {
    assert_eq!(
        Sim::new_scaled(1, 16, 16, Biome::default(), 0).day_scale(),
        1
    );
    assert_eq!(
        Sim::new_scaled(1, 16, 16, Biome::default(), 121).day_scale(),
        1
    );
    assert_eq!(
        Sim::new_scaled(1, 16, 16, Biome::default(), 120).day_scale(),
        120
    );
}

#[test]
fn un_snapshot_porte_l_echelle_et_rejoue_au_meme_hash() {
    let mut a = Sim::new_scaled(3, 48, 48, Biome::default(), 30);
    assert_eq!(a.ticks_per_day(), 30 * sim::TICKS_PER_DAY);
    for _ in 0..3_000 {
        a.step(&[]);
    }
    let bytes = a.snapshot();
    let mut b = Sim::restore(&bytes).expect("snapshot valide");
    assert_eq!(b.day_scale(), 30, "l'échelle n'a pas voyagé avec l'état");
    assert_eq!(a, b);
    for _ in 0..3_000 {
        a.step(&[]);
        b.step(&[]);
    }
    assert_eq!(
        a.state_hash(),
        b.state_hash(),
        "une partie restaurée à l'échelle 30 ne rejoue pas la même chose"
    );
}

/// Un snapshot **d'avant l'échelle du jour** est exactement un snapshot à
/// l'échelle 1 amputé de son dernier champ — c'est-à-dire d'aucun octet. Pour
/// que le test dise quelque chose, on fabrique le cas depuis une partie à
/// l'échelle 30 : on retire l'octet de l'échelle, et le tampon obtenu est
/// celui qu'aurait écrit le sim d'avant. Il se relit, à l'échelle 1.
#[test]
fn un_snapshot_d_avant_se_relit_a_l_echelle_un() {
    let s = Sim::new_scaled(4, 32, 32, Biome::default(), 30);
    let bytes = s.snapshot();
    assert_eq!(
        bytes.last(),
        Some(&30u8),
        "l'échelle doit être le dernier octet du snapshot"
    );
    let older = &bytes[..bytes.len() - 1];
    let restored = Sim::restore(older).expect("un snapshot d'avant se relit");
    assert_eq!(restored.day_scale(), 1);
    assert_eq!(restored.ticks_per_day(), sim::TICKS_PER_DAY);
}

/// Une échelle hors bornes trouvée dans un tampon retombe sur 1, comme un
/// biome inconnu retombe sur le tempéré.
#[test]
fn une_echelle_hors_bornes_dans_un_snapshot_retombe_sur_un() {
    let s = Sim::new_scaled(4, 32, 32, Biome::default(), 120);
    let mut bytes = s.snapshot();
    assert_eq!(bytes.last(), Some(&120u8));
    // 127 : encore un octet de varint, mais au-delà de `DAY_SCALE_MAX`.
    *bytes.last_mut().unwrap() = 127;
    let restored = Sim::restore(&bytes).expect("le tampon reste lisible");
    assert_eq!(restored.day_scale(), 1);
}
