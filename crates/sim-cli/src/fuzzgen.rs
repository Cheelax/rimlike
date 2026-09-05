//! Génère des `Command` aléatoires pour `fuzz` : parcourt toutes les
//! variantes, avec des paramètres tantôt plausibles, tantôt aberrants
//! (coordonnées hors carte, rectangles inversés, ids de pawns inventés,
//! priorités hors bornes, colon qui s'attaque lui-même...). Toute l'entropie
//! passe par `sim::Rng`, comme l'exige le sim.

use sim::{
    BuildKind, CaravanManifest, Command, Designation, Difficulty, ItemKind, MANIFEST_VERSION,
    Material, Pawn, Rng, Sim, WorkType, Zone,
};

/// Nombre de variantes de `Command` couvertes par le générateur.
pub const VARIANT_COUNT: usize = 17;

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
    "FormCaravan",
    "ClearDepartures",
    "ArriveCaravan",
    "FastForward",
    "SetCraftTarget",
    "SetClimate",
    "Hunt",
    "SetDifficulty",
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

/// Quantité d'objets pour une caravane : le plus souvent plausible, parfois
/// nulle (à ignorer) ou énorme (bien au-delà de ce que le stock contient).
fn random_count(rng: &mut Rng) -> u32 {
    match rng.below(5) {
        0 => 0,
        1 => u32::MAX - rng.below(1_000),
        2 => rng.below(100_000),
        _ => rng.below(80),
    }
}

/// Liste de marchandises demandées au départ, parfois vide, avec des genres
/// tirés dans toute la plage de `ItemKind` (cadavres compris) et des doublons
/// possibles. Une quantité aberrante ne coûte rien ici : le départ ne prélève
/// que ce que le stock contient.
fn random_goods(rng: &mut Rng) -> Vec<(ItemKind, u32)> {
    let n = rng.below(4);
    (0..n)
        .map(|_| {
            (
                ItemKind::from_u8(rng.below(ItemKind::COUNT as u32) as u8),
                random_count(rng),
            )
        })
        .collect()
}

/// Marchandises d'un manifeste bricolé. Vides le plus souvent, et petites
/// sinon : chaque arrivée dépose des piles qui restent sur la carte pour de
/// bon, et une campagne n'a pas à ensevelir les 576 cases sous les piles pour
/// éprouver le dépôt. La quantité aberrante reste tirée, mais rarement — elle
/// couvre à elle seule `caravan::MAX_CARAVAN_TILES` cases.
fn random_cargo(rng: &mut Rng) -> Vec<(ItemKind, u32)> {
    if rng.chance(3, 4) {
        return Vec::new();
    }
    let n = 1 + rng.below(2);
    (0..n)
        .map(|_| {
            let kind = ItemKind::from_u8(rng.below(ItemKind::COUNT as u32) as u8);
            let count = match rng.below(16) {
                0 => 0,
                1 => u32::MAX - rng.below(1_000),
                _ => rng.below(40),
            };
            (kind, count)
        })
        .collect()
}

/// Manifeste bricolé de toutes pièces : des colons aux champs volontairement
/// hors bornes (sang, besoins, niveaux, priorités, blessures) pour éprouver
/// l'assainissement à l'arrivée, et parfois une version inconnue, qui doit
/// faire refuser le manifeste au décodage.
fn random_manifest(rng: &mut Rng) -> Vec<u8> {
    let count = rng.below(5);
    let pawns: Vec<Pawn> = (0..count)
        .map(|k| {
            let mut p = Pawn::at_tile(k + 1, rng.below(64), rng.below(64), "Voyageur".to_string());
            p.hunger = rng.next_u32();
            p.rest = rng.next_u32();
            p.blood = rng.next_u32();
            p.hp = rng.next_u32();
            p.grief_ticks = rng.next_u32();
            for prio in &mut p.priorities {
                *prio = rng.below(256) as u8;
            }
            for skill in &mut p.skills {
                skill.level = rng.below(256) as u8;
                skill.xp = rng.next_u32();
            }
            for _ in 0..rng.below(12) {
                p.injuries.push(sim::Injury::new(
                    sim::BodyPart::from_u8(rng.below(8) as u8),
                    rng.below(2_000),
                    rng.below(500),
                ));
            }
            p
        })
        .collect();
    let manifest = CaravanManifest {
        version: if rng.chance(1, 8) {
            rng.below(1_000) as u16
        } else {
            MANIFEST_VERSION
        },
        origin_tick: rng.next_u64(),
        pawns,
        items: random_cargo(rng),
    };
    let mut bytes = manifest.encode();
    // Une fois sur huit, la trame est abîmée après coup : octets en trop ou
    // tronqués, exactement ce que le décodage strict doit refuser.
    match rng.below(8) {
        0 => bytes.push(rng.below(256) as u8),
        1 => {
            bytes.truncate(rng.below(bytes.len() as u32 + 1) as usize);
        }
        _ => {}
    }
    bytes
}

/// Température en dixièmes de degré pour `SetClimate` : le plus souvent une
/// valeur de climat crédible (−40 °C à +40 °C), sinon franchement absurde,
/// jusqu'aux bornes de `i32` — c'est là que se casserait une multiplication.
fn random_temperature(rng: &mut Rng) -> i32 {
    match rng.below(6) {
        0 => i32::MIN.saturating_add(rng.below(1_000) as i32),
        1 => i32::MAX.saturating_sub(rng.below(1_000) as i32),
        2 => -(rng.below(100_000) as i32),
        3 => rng.below(100_000) as i32,
        _ => rng.range_i32(-400, 401),
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
                // 0..=5 : murs, portes, sols, lits, feux et postes de fabrication.
                kind: BuildKind::from_u8(rng.below(6) as u8),
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
        8 => Command::TriggerRaid,
        9 => {
            // Liste de colons parfois vide, parfois pleine d'ids inventés, et
            // de temps en temps deux fois le même (doublon : refus attendu).
            let n = rng.below(4);
            let mut pawns: Vec<u32> = (0..n).map(|_| random_pawn_id(rng, sim)).collect();
            if rng.chance(1, 5)
                && let Some(&first) = pawns.first()
            {
                pawns.push(first);
            }
            Command::FormCaravan {
                pawns,
                items: random_goods(rng),
            }
        }
        10 => Command::ClearDepartures {
            // Bien au-delà de la taille de la file : elle doit saturer.
            count: match rng.below(3) {
                0 => u32::MAX - rng.below(1_000),
                1 => rng.below(1_000_000),
                _ => rng.below(4),
            },
        },
        11 => Command::ArriveCaravan {
            // Un vrai manifeste sur 50, sinon des octets sans queue ni tête refusés au
            // décodage strict : assez pour couvrir l'arrivée sans noyer la carte sous des
            // milliers de piles (voir FUZZ-FINDINGS.md).
            manifest: if rng.below(50) == 0 {
                random_manifest(rng)
            } else {
                (0..rng.below(64)).map(|_| rng.below(256) as u8).collect()
            },
        },
        12 => Command::FastForward {
            // 0 (sans effet), des durées plausibles, et des valeurs aberrantes
            // bien au-delà de `sim::MAX_FAST_FORWARD` : la borne doit tronquer
            // sans jamais faire boucler le sim ni déborder un compteur.
            ticks: match rng.below(6) {
                0 => 0,
                1 => u32::MAX - rng.below(1_000),
                2 => sim::MAX_FAST_FORWARD.saturating_add(rng.below(1_000_000)),
                _ => rng.below(4 * sim::TICKS_PER_DAY),
            },
        },
        13 => Command::SetCraftTarget {
            // Genres tirés dans toute la plage (la plupart n'ont pas de
            // recette : ils doivent être ignorés), objectifs le plus souvent
            // plausibles, parfois énormes — le sim ne fabrique jamais plus vite
            // que le bois ne rentre.
            kind: ItemKind::from_u8(rng.below(ItemKind::COUNT as u32 + 4) as u8),
            target: match rng.below(4) {
                0 => 0,
                1 => u32::MAX - rng.below(1_000),
                _ => rng.below(6),
            },
        },
        14 => Command::SetClimate {
            // Climats plausibles (du désert à la banquise), mais surtout des
            // valeurs qui n'ont aucun sens en degrés : `Climate::sanitized`
            // doit les borner, et aucune température ne doit déborder ensuite.
            base_temperature: random_temperature(rng),
            amplitude: random_temperature(rng),
        },
        15 => Command::Hunt {
            // Le plus souvent un id de pawn réel : le sim doit refuser tout ce
            // qui n'est pas un animal vivant (colon, pillard, mort, id
            // inventé) sans jamais poser de `Job::Hunt` dans le vide.
            animal: random_pawn_id(rng, sim),
            on: rng.chance(1, 2),
        },
        _ => Command::SetDifficulty {
            // Le tirage sur 256 cogne largement au-delà des quatre valeurs
            // valides : `Difficulty::from_u8` doit retomber sur « normal »
            // plutôt que de laisser passer une dose de menace inventée. Le
            // paisible et le difficile passent donc aussi, et une campagne
            // alterne les trois régimes de raid sur la même carte.
            level: Difficulty::from_u8(rng.below(256) as u8),
        },
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
