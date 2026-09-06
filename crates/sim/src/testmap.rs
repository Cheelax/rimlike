//! Cartes dessinées en ASCII pour les tests. Exposé (pas seulement `cfg(test)`)
//! pour que les tests d'intégration du crate puissent l'utiliser.

use crate::map::{Feature, Map, Terrain};

/// `.` herbe · `#` roche · `%` roche veinée (minerai) · `~` eau peu profonde ·
/// `T` arbre · `b` buisson mûr · `,` terre · `W` eau profonde.
pub fn map_from(rows: &[&str]) -> Map {
    let h = rows.len() as u32;
    let w = rows[0].len() as u32;
    let mut tiles = Vec::with_capacity((w * h) as usize);
    let mut features = Vec::with_capacity((w * h) as usize);
    for r in rows {
        assert_eq!(r.len() as u32, w, "lignes de longueur inégale");
        for c in r.chars() {
            let (t, f) = match c {
                '#' => (Terrain::Gravel, Feature::Rock),
                '%' => (Terrain::Gravel, Feature::OreRock),
                '~' => (Terrain::ShallowWater, Feature::None),
                'W' => (Terrain::DeepWater, Feature::None),
                'T' => (Terrain::Grass, Feature::Tree),
                'b' => (Terrain::Grass, Feature::Bush),
                ',' => (Terrain::Dirt, Feature::None),
                _ => (Terrain::Grass, Feature::None),
            };
            tiles.push(t as u8);
            features.push(f as u8);
        }
    }
    Map::from_layers(w, h, tiles, features)
}
