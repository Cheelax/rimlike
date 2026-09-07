//! Deux ateliers, deux colons, deux recettes : la colonie ne fabrique plus en
//! file indienne.
//!
//! Le défaut est dans le choix de la recette. `Sim::try_start_craft` retenait
//! la première recette **faisable** — objectif non atteint, atelier bâti,
//! ingrédients en réserve — puis cherchait un atelier libre pour elle, et
//! s'arrêtait là s'il n'y en avait pas. Or « faisable » ne dit rien de l'état
//! des ateliers : un objectif de gourdins, du bois en réserve et le seul poste
//! de fabrication déjà réservé par un camarade, et la forge d'à côté restait
//! froide — avec son minerai, et avec deux colons pour la tenir. La colonie
//! attendait que le premier lâche son poste pour découvrir qu'elle avait un
//! second atelier.
//!
//! La correction : l'atelier **libre et atteignable** entre dans le choix de la
//! recette, et une recette dont tous les ateliers sont pris passe son tour. Ce
//! qu'elle ne change pas — et les deux derniers tests sont là pour ça — c'est
//! l'ordre de `craft::RECIPES`, qui fait partie du déterminisme : à ateliers
//! libres, la colonie s'arme toujours dans le même ordre.
//!
//! Mesuré sur la scène ci-dessous, à la même graine : la **première fonte**
//! commençait au tick **1 915** (les cinq gourdins finis, un par un, sur le
//! seul poste), elle commence au tick **89**.

use sim::craft::ORE_PER_INGOT;
use sim::testmap::map_from;
use sim::{Command, Feature, ItemKind, Job, Sim};

/// Côté de la carte : de la place pour poser les deux ateliers de part et
/// d'autre des colons, sans rien d'autre à faire dessus.
const SIZE: u32 = 24;
/// Gourdins demandés, et piles de bois posées : de quoi occuper le poste de
/// fabrication bien au-delà de la fenêtre mesurée. C'est ce qui rend le défaut
/// visible — tant que l'objectif de gourdins n'est pas atteint, c'est lui que
/// la recherche retenait.
const CLUBS: u32 = 5;
/// Bûches par pile, soit un gourdin (`craft::RECIPES`).
const WOOD_PER_CLUB: u32 = 8;
/// Lingots demandés, et minerai posé pour les tenir.
const INGOTS: u32 = 2;

/// Dix secondes de jeu : le temps qu'un colon rejoigne la forge, y porte son
/// minerai et le fonde (`craft::SMELT_TICKS`), avec de la marge.
const TICKS: u64 = 900;
/// Cinq secondes de jeu. Le second atelier doit démarrer là-dedans : avant
/// correction il attendait le tick 1 915.
const SOON: u64 = 300;

/// Clairière plate : rien à couper, rien à cueillir, rien à ranger (aucun
/// entrepôt). Tout ce qui s'y passe vient des piles posées et des deux
/// ateliers plantés de part et d'autre des trois colons de `Sim::from_map`.
///
/// Un seul poste de fabrication et une seule forge : c'est le cœur de la
/// scène. Le premier colon réserve le poste pour son gourdin, et la question
/// est de savoir ce que fait le deuxième.
fn workshop() -> Sim {
    let rows: Vec<String> = (0..SIZE).map(|_| ",".repeat(SIZE as usize)).collect();
    let refs: Vec<&str> = rows.iter().map(String::as_str).collect();
    let mut s = Sim::from_map(1, map_from(&refs));
    let (cx, cy) = (SIZE / 2, SIZE / 2);
    // De quoi tenir la fenêtre mesurée sans que la faim vienne vider l'atelier.
    s.spawn_item(ItemKind::Berries, 200, cx, cy + 1);
    s.map_mut().set_feature(cx + 4, cy, Feature::CraftingSpot);
    s.map_mut().set_feature(cx - 4, cy, Feature::Forge);
    // Le bois du côté du poste, le minerai du côté de la forge : chacun a sa
    // charge sous la main, personne ne traverse la scène pour rien.
    for k in 0..CLUBS {
        s.spawn_item(ItemKind::Wood, WOOD_PER_CLUB, cx + 2 + k, cy + 3);
    }
    for k in 0..INGOTS * ORE_PER_INGOT {
        s.spawn_item(ItemKind::Ore, 1, cx - 2 - k, cy + 3);
    }
    assert_eq!(s.map().crafting_spot_count(), 1, "un seul poste");
    assert_eq!(s.map().forge_count(), 1, "une seule forge");
    s
}

/// Objectifs du joueur : des gourdins **et** des lingots, dans cet ordre.
fn order(s: &mut Sim) {
    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Club,
        target: CLUBS,
    }]);
    s.step(&[Command::SetCraftTarget {
        kind: ItemKind::Metal,
        target: INGOTS,
    }]);
}

/// Ce qu'un colon fabrique en ce moment, pour chaque colon au travail.
fn crafting(s: &Sim) -> Vec<ItemKind> {
    s.pawns()
        .iter()
        .filter_map(|p| match p.job {
            Job::Craft { recipe, .. } => Some(recipe),
            _ => None,
        })
        .collect()
}

// ----------------------------------------------------------------------
// Le défaut
// ----------------------------------------------------------------------

/// Le second colon fond son lingot **pendant** que le premier taille son
/// gourdin. Avant correction, la forge n'était touchée qu'au tick 1 915, les
/// cinq gourdins finis : la recherche retenait le gourdin, ne trouvait pas de
/// poste libre, et rendait « rien à faire » sans regarder la recette suivante.
#[test]
fn un_poste_pris_ne_bloque_pas_la_forge() {
    let mut s = workshop();
    order(&mut s);
    let mut together = None;
    for t in 0..SOON {
        s.step(&[]);
        let jobs = crafting(&s);
        if jobs.contains(&ItemKind::Club) && jobs.contains(&ItemKind::Metal) {
            together = Some(t);
            break;
        }
    }
    assert!(
        together.is_some(),
        "personne n'est allé à la forge en {SOON} ticks pendant que le poste taillait : {:?}",
        crafting(&s)
    );
}

/// Et le lingot sort pour de bon : la fonte n'est pas seulement commencée, elle
/// aboutit sans que la colonie ait fini ses gourdins.
#[test]
fn la_forge_produit_pendant_que_le_poste_taille() {
    let mut s = workshop();
    order(&mut s);
    for _ in 0..TICKS {
        s.step(&[]);
        if s.colony_total(ItemKind::Metal) >= 1 {
            break;
        }
    }
    assert!(
        s.colony_total(ItemKind::Metal) >= 1,
        "aucun lingot fondu en {TICKS} ticks"
    );
    assert!(
        s.colony_total(ItemKind::Club) < CLUBS,
        "les gourdins étaient tous finis : la scène ne mesure plus la concurrence"
    );
}

// ----------------------------------------------------------------------
// Ce que la correction ne change pas
// ----------------------------------------------------------------------

/// L'ordre de `craft::RECIPES` fait partie du déterminisme : à ateliers libres,
/// c'est toujours l'arme qui passe la première. Le premier colon à trouver du
/// travail prend le gourdin, jamais le lingot.
#[test]
fn a_ateliers_libres_l_ordre_des_recettes_ne_change_pas() {
    let mut s = workshop();
    order(&mut s);
    let mut first = None;
    for _ in 0..SOON {
        s.step(&[]);
        let jobs = crafting(&s);
        if let Some(&kind) = jobs.first()
            && first.is_none()
        {
            first = Some(kind);
        }
        if first.is_some() {
            break;
        }
    }
    assert_eq!(
        first,
        Some(ItemKind::Club),
        "la première recette prise n'est plus celle de la table"
    );
}

/// Une recette dont l'atelier n'est pas bâti reste **sautée**, pas attendue :
/// c'est la règle d'avant, et elle vaut toujours. Sans forge sur la carte, un
/// objectif de lingots n'empêche pas la colonie de tailler ses gourdins.
#[test]
fn un_objectif_sans_atelier_ne_bloque_toujours_rien() {
    let mut s = workshop();
    s.map_mut()
        .set_feature(SIZE / 2 - 4, SIZE / 2, Feature::None);
    assert_eq!(s.map().forge_count(), 0, "la forge devait disparaître");
    order(&mut s);
    let mut clubbed = false;
    for _ in 0..SOON {
        s.step(&[]);
        clubbed |= crafting(&s).contains(&ItemKind::Club);
    }
    assert!(clubbed, "l'objectif de lingots a bloqué les gourdins");
}
