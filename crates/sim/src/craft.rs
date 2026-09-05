//! Fabrication d'armes et de vêtements au poste de travail.
//!
//! Un poste (`Feature::CraftingSpot`, bâti par `BuildKind::CraftingSpot`) est
//! infranchissable : on travaille à côté, comme au feu de camp. Le joueur ne
//! lance pas une fabrication à la main, il pose un **objectif** par genre
//! (`Command::SetCraftTarget`) et les colons fabriquent tant que la colonie a
//! moins d'exemplaires que demandé. Sans ordre, rien ne se fabrique : tous les
//! objectifs valent 0 au départ.
//!
//! Le travail est celui d'un constructeur (`WorkType::Build`) : ajouter un
//! type de travail changerait `WORK_TYPES`, donc les tampons de priorités et
//! de compétences, pour un gain de pilotage discutable.

use serde::{Deserialize, Serialize};

use crate::items::ItemKind;

/// Ingrédients au plus dans une recette. Un colon ne portant qu'une pile à la
/// fois, c'est aussi le nombre d'allers-retours d'une fabrication.
pub const MAX_INGREDIENTS: usize = 2;

/// De quoi fabriquer un objet : ce qu'il consomme et le temps qu'il prend.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Recipe {
    pub output: ItemKind,
    /// Genres et quantités, dans l'ordre où le colon va les chercher.
    pub inputs: &'static [(ItemKind, u32)],
    /// Durée du travail au poste, en ticks à vitesse nominale.
    pub work_ticks: u32,
}

/// Toutes les recettes connues. **L'ordre compte** : c'est celui dans lequel
/// un colon choisit quoi fabriquer quand plusieurs objectifs ne sont pas
/// atteints, donc il fait partie du déterminisme.
pub const RECIPES: [Recipe; 5] = [
    Recipe {
        output: ItemKind::Club,
        inputs: &[(ItemKind::Wood, 8)],
        work_ticks: 240,
    },
    Recipe {
        output: ItemKind::Spear,
        inputs: &[(ItemKind::Wood, 6), (ItemKind::Stone, 4)],
        work_ticks: 360,
    },
    Recipe {
        output: ItemKind::Bow,
        inputs: &[(ItemKind::Wood, 12)],
        work_ticks: 480,
    },
    // Les vêtements viennent après les armes : à objectifs multiples et stock
    // partagé, la colonie s'arme d'abord. Le cuir vient de la chasse, il n'est
    // disputé par aucune autre recette.
    Recipe {
        output: ItemKind::Tunic,
        inputs: &[(ItemKind::Leather, 6)],
        work_ticks: 300,
    },
    Recipe {
        output: ItemKind::Coat,
        inputs: &[(ItemKind::Leather, 12)],
        work_ticks: 500,
    },
];

/// Recette produisant ce genre, s'il en existe une.
pub fn recipe_for(kind: ItemKind) -> Option<&'static Recipe> {
    RECIPES.iter().find(|r| r.output == kind)
}

/// Durée d'un dépeçage au poste, en ticks à vitesse nominale.
///
/// Le dépeçage n'est **pas** une recette de `RECIPES` : son ingrédient est
/// n'importe quel genre de dépouille et sa production dépend de l'espèce
/// (`animals::Species::meat` et `leather`), deux choses que `Recipe`, qui a des
/// genres fixes, ne sait pas dire. Il n'a pas non plus d'objectif réglable
/// (`Command::SetCraftTarget` ne s'y applique pas) : dès qu'une dépouille
/// existe et qu'un poste est libre, on débite — la viande se gâte vite.
/// C'est du travail de cuisine (`WorkType::Cook`), juste après la cuisine
/// elle-même.
pub const BUTCHER_TICKS: u32 = 120;

/// Où en est une fabrication. Remplace le couple `picked`/`progress` de la
/// cuisine : avec deux ingrédients, il faut savoir lequel on va chercher.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum CraftStage {
    /// Va chercher l'ingrédient d'indice `index` de la recette. `item` est la
    /// pile réservée, `carried` dit si elle est déjà en main (le colon
    /// rapporte alors la charge au poste).
    Fetch { index: u8, item: u32, carried: bool },
    /// Au poste, en train de tailler. `progress` en centièmes de tick, comme
    /// tous les avancements de travail.
    Work { progress: u32 },
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_recettes_sont_coherentes() {
        for r in &RECIPES {
            assert!(
                r.output.is_weapon() || r.output.is_apparel(),
                "{:?} n'est ni une arme ni un vêtement",
                r.output
            );
            assert!(!r.inputs.is_empty(), "recette sans ingrédient");
            assert!(r.inputs.len() <= MAX_INGREDIENTS);
            assert!(r.inputs.iter().all(|&(_, n)| n > 0));
            // Un genre au plus une fois : le colon retrouve la pile réservée
            // pour l'ingrédient suivant par son genre (`Sim::next_ingredient`).
            for (a, &(kind, _)) in r.inputs.iter().enumerate() {
                assert!(
                    !r.inputs[a + 1..].iter().any(|&(k, _)| k == kind),
                    "{kind:?} demandé deux fois par la même recette"
                );
            }
            assert!(r.work_ticks > 0);
            assert_eq!(recipe_for(r.output), Some(r));
        }
        assert_eq!(recipe_for(ItemKind::Wood), None);
    }
}
