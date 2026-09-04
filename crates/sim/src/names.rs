//! Prénoms tirés au sort pour les pawns.
//!
//! Deux listes distinctes : colons (et voyageurs, qui rejoignent la colonie)
//! d'un côté, pillards de l'autre. Les distinguer d'un coup d'œil dans le
//! journal et le rendu suffit ; pas besoin d'un suffixe du genre « le
//! pillard ». Prénoms français et internationaux, sans accents pour rester
//! sobres côté rendu.

use crate::pawn::Faction;
use crate::rng::Rng;

const COLONIST_NAMES: [&str; 40] = [
    "Emma", "Lucas", "Chloe", "Hugo", "Manon", "Louis", "Lea", "Nathan", "Camille", "Thomas",
    "Sarah", "Adam", "Julie", "Maxime", "Ines", "Antoine", "Laura", "Simon", "Marie", "Paul",
    "Anna", "Leo", "Clara", "Gabriel", "Sophie", "Noah", "Alice", "Tom", "Lisa", "Enzo", "Julia",
    "Mathis", "Eva", "Arthur", "Zoe", "Victor", "Rose", "Jules", "Nora", "Theo",
];

/// Liste distincte de celle des colons : un pillard se reconnaît au premier
/// coup d'œil dans le journal, sans avoir à lire son camp.
const RAIDER_NAMES: [&str; 40] = [
    "Rex", "Vesper", "Grim", "Ashby", "Kane", "Silas", "Freya", "Boris", "Ivy", "Dante", "Nyssa",
    "Cole", "Raven", "Reeve", "Marek", "Skye", "Bruno", "Diesel", "Raze", "Skarr", "Talon",
    "Ragnar", "Fenn", "Gunnar", "Bjorn", "Cassia", "Draven", "Maddox", "Orin", "Rook", "Slate",
    "Thane", "Ulric", "Varek", "Wolfe", "Zane", "Freja", "Hawke", "Jarek", "Kestrel",
];

/// Tire un prénom pour un pawn du camp donné.
pub fn pick(rng: &mut Rng, faction: Faction) -> String {
    let list = match faction {
        Faction::Colony => &COLONIST_NAMES,
        Faction::Raider => &RAIDER_NAMES,
    };
    list[rng.below(list.len() as u32) as usize].to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pick_stays_in_the_right_list() {
        let mut rng = Rng::new(1);
        for _ in 0..200 {
            let name = pick(&mut rng, Faction::Colony);
            assert!(COLONIST_NAMES.contains(&name.as_str()), "{name}");
        }
        for _ in 0..200 {
            let name = pick(&mut rng, Faction::Raider);
            assert!(RAIDER_NAMES.contains(&name.as_str()), "{name}");
        }
    }
}
