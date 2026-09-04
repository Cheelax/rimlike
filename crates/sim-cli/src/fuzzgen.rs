//! Génère des `Command` aléatoires pour `fuzz` : parcourt toutes les
//! variantes, avec des paramètres tantôt plausibles, tantôt aberrants
//! (coordonnées hors carte, rectangles inversés, ids de pawns inventés,
//! priorités hors bornes, colon qui s'attaque lui-même...). Toute l'entropie
//! passe par `sim::Rng`, comme l'exige le sim.

use sim::{BuildKind, Command, Designation, Material, Rng, Sim, WorkType, Zone};

/// Nombre de variantes de `Command` couvertes par le générateur.
pub const VARIANT_COUNT: usize = 9;

/// Noms des variantes, dans l'ordre choisi par `random_command` (utilisé
/// pour l'indice renvoyé). Sert uniquement à l'affichage des statistiques.
pub const VARIANT_NAMES: [&str; VARIANT_COUNT] = [
    "Nop",
    "MoveTo",
    "Designate",
    "SetZone",
    "Build",
    "CancelBuild",
    "Attack",
    "SetPriority",
    "TriggerRaid",
];

const TRIGGER_RAID_VARIANT: usize = 8;

/// Coordonnée pour les commandes à rectangle (`i32`) : le plus souvent dans
/// la carte ou juste à côté, parfois franchement hors carte, parfois aux
/// bornes de `i32`. Toute l'arithmétique est saturante ou passe par `as`
/// (jamais de panique de débordement ici : une panique du fuzzer masquerait
/// une vraie trouvaille dans le sim).
fn random_coord_i32(rng: &mut Rng, size: u32) -> i32 {
    let size = size.max(1);
    let margin = size.saturating_mul(4).saturating_add(1);
    match rng.below(6) {
        0 => i32::MIN.saturating_add(rng.below(1_000) as i32),
        1 => i32::MAX.saturating_sub(rng.below(1_000) as i32),
        2 => -(i64::from(rng.below(margin)) as i32),
        3 => (i64::from(size) + i64::from(rng.below(margin))) as i32,
        _ => rng.below(size) as i32,
    }
}

/// Coordonnée pour `MoveTo` (`x`, `y` sont des `u32` dans `Command` : pas de
/// négatif possible, mais toujours des valeurs énormes ou hors carte).
fn random_coord_u32(rng: &mut Rng, size: u32) -> u32 {
    let size = size.max(1);
    let margin = size.saturating_mul(4).saturating_add(1);
    match rng.below(4) {
        0 => u32::MAX - rng.below(1_000),
        1 => size.saturating_add(rng.below(margin)),
        _ => rng.below(size),
    }
}

/// Rectangle pour `Designate`/`SetZone`/`Build`/`CancelBuild`. Un tirage sur
/// six couvre toute la carte (« CancelBuild sur tout », désignation massive) ;
/// les autres tirent quatre coins indépendants, ce qui produit aussi, de
/// temps en temps, des rectangles inversés (x0 > x1 ou y0 > y1) — volontaire,
/// `Map::clamp_rect` est censé les normaliser.
fn random_rect_i32(rng: &mut Rng, size: u32) -> (i32, i32, i32, i32) {
    if rng.chance(1, 6) {
        let edge = size.max(1) as i32 - 1;
        (0, 0, edge, edge)
    } else {
        (
            random_coord_i32(rng, size),
            random_coord_i32(rng, size),
            random_coord_i32(rng, size),
            random_coord_i32(rng, size),
        )
    }
}

/// Id de pawn : le plus souvent un id réellement présent dans `sim` (colon
/// ou pillard, vivant ou mort), parfois un id inventé — petit (proche des
/// ids valides, pour cogner sur les cas limites) ou franchement énorme.
fn random_pawn_id(rng: &mut Rng, sim: &Sim) -> u32 {
    let pawns = sim.pawns();
    if !pawns.is_empty() && rng.chance(3, 4) {
        pawns[rng.below(pawns.len() as u32) as usize].id
    } else if rng.chance(1, 2) {
        rng.below(20)
    } else {
        rng.next_u32()
    }
}

/// Tire une commande aléatoire à appliquer telle quelle. Renvoie aussi
/// l'indice de la variante choisie (dans `VARIANT_NAMES`) pour les
/// statistiques de fin de run.
pub fn random_command(rng: &mut Rng, sim: &Sim, size: u32) -> (Command, usize) {
    let mut variant = rng.below(VARIANT_COUNT as u32) as usize;
    // Le raid est ce qui presse le plus de code (combat, IA, morts, RNG) :
    // on le pousse plus souvent que sa part uniforme le voudrait.
    if variant != TRIGGER_RAID_VARIANT && rng.chance(1, 6) {
        variant = TRIGGER_RAID_VARIANT;
    }
    let cmd = match variant {
        0 => Command::Nop,
        1 => Command::MoveTo {
            pawn: random_pawn_id(rng, sim),
            x: random_coord_u32(rng, size),
            y: random_coord_u32(rng, size),
        },
        2 => {
            let (x0, y0, x1, y1) = random_rect_i32(rng, size);
            Command::Designate {
                kind: Designation::from_u8(rng.below(4) as u8),
                x0,
                y0,
                x1,
                y1,
            }
        }
        3 => {
            let (x0, y0, x1, y1) = random_rect_i32(rng, size);
            Command::SetZone {
                zone: Zone::from_u8(rng.below(3) as u8),
                x0,
                y0,
                x1,
                y1,
            }
        }
        4 => {
            let (x0, y0, x1, y1) = random_rect_i32(rng, size);
            Command::Build {
                kind: BuildKind::from_u8(rng.below(5) as u8),
                material: Material::from_u8(rng.below(2) as u8),
                x0,
                y0,
                x1,
                y1,
            }
        }
        5 => {
            let (x0, y0, x1, y1) = random_rect_i32(rng, size);
            Command::CancelBuild { x0, y0, x1, y1 }
        }
        6 => {
            let pawn = random_pawn_id(rng, sim);
            // Un quart du temps la cible est le pawn lui-même : cas limite
            // explicitement voulu (un colon qui s'attaque lui-même).
            let target = if rng.chance(1, 4) {
                pawn
            } else {
                random_pawn_id(rng, sim)
            };
            Command::Attack { pawn, target }
        }
        7 => Command::SetPriority {
            pawn: random_pawn_id(rng, sim),
            work: WorkType::from_u8(rng.below(6) as u8),
            // Bornes valides 0..=4 : le tirage sur 256 cogne largement
            // au-delà pour vérifier que `Sim::apply` sature bien (`.min(4)`).
            priority: rng.below(256) as u8,
        },
        _ => Command::TriggerRaid,
    };
    (cmd, variant)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn covers_every_variant_given_enough_draws() {
        let mut rng = Rng::new(42);
        let sim = Sim::new(1, 16, 16);
        let mut seen = [false; VARIANT_COUNT];
        for _ in 0..2000 {
            let (_, variant) = random_command(&mut rng, &sim, 16);
            seen[variant] = true;
        }
        assert!(seen.iter().all(|&s| s), "variantes manquantes : {seen:?}");
    }

    #[test]
    fn never_panics_on_tiny_map() {
        let mut rng = Rng::new(7);
        let mut sim = Sim::new(7, 1, 1);
        for t in 0..2000u64 {
            let (cmd, _) = random_command(&mut rng, &sim, 1);
            sim.step(&[cmd]);
            let _ = t;
        }
    }
}
