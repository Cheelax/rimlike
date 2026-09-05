//! Scénario `demo` : recopie fidèle de `scripted_commands` dans
//! `crates/sim/tests/determinism.rs`, pour rejouer la même charge de jeu hors
//! des tests (mesure de perf, vérification manuelle, snapshots).

use sim::{BuildKind, Command, Designation, Faction, Material, Sim, WorkType, Zone};

/// Scénario appliqué tick par tick par `run`, `verify` et `bench`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    /// Aucune commande : mesure le coût de la simulation seule (météo,
    /// pousse, storyteller, IA des colons livrés à eux-mêmes).
    None,
    /// Rejoue `scripted_commands`.
    Demo,
}

impl Scenario {
    pub fn parse(raw: &str) -> Option<Scenario> {
        match raw {
            "none" => Some(Scenario::None),
            "demo" => Some(Scenario::Demo),
            _ => None,
        }
    }

    pub fn name_str(self) -> &'static str {
        match self {
            Scenario::None => "none",
            Scenario::Demo => "demo",
        }
    }

    /// Commandes à appliquer au tick `t`. Vide pour `None`.
    pub fn commands(self, sim: &Sim, t: u64) -> Vec<Command> {
        match self {
            Scenario::None => Vec::new(),
            Scenario::Demo => scripted_commands(sim, t),
        }
    }
}

/// Recopie de `scripted_commands` (`crates/sim/tests/determinism.rs`) :
/// zone de stockage, désignations tournantes, plans de mur, culture, feu de
/// camp, climat imposé à 100, ordres de déplacement, raid déclenché à 6000,
/// annulation à 4000. Toute modification du scénario de test doit être
/// reportée ici.
fn scripted_commands(sim: &Sim, t: u64) -> Vec<Command> {
    let mut cmds = Vec::new();
    let w = sim.map().width() as i32;
    let h = sim.map().height() as i32;
    if t % 97 == 0 {
        cmds.push(Command::Nop);
    }
    if t == 10 {
        cmds.push(Command::SetZone {
            zone: Zone::Stockpile,
            x0: w / 2 - 3,
            y0: h / 2 - 3,
            x1: w / 2 + 3,
            y1: h / 2 + 3,
        });
    }
    if t % 500 == 20 {
        let k = (t / 500) as i32;
        cmds.push(Command::Designate {
            kind: if k % 3 == 0 {
                Designation::Chop
            } else if k % 3 == 1 {
                Designation::Harvest
            } else {
                Designation::Mine
            },
            x0: 0,
            y0: 0,
            x1: w - 1,
            y1: h - 1,
        });
    }
    if t == 40 {
        cmds.push(Command::Build {
            kind: BuildKind::Wall,
            material: Material::Wood,
            x0: w / 2 - 6,
            y0: h / 2 - 6,
            x1: w / 2 + 6,
            y1: h / 2 - 6,
        });
    }
    if t % 1500 == 700 {
        let k = (t / 1500) as i32;
        cmds.push(Command::Build {
            kind: if k % 2 == 0 {
                BuildKind::Floor
            } else {
                BuildKind::Bed
            },
            material: Material::Wood,
            x0: w / 2 + k,
            y0: h / 2 + 4,
            x1: w / 2 + k + 1,
            y1: h / 2 + 4,
        });
    }
    if t == 60 {
        cmds.push(Command::SetZone {
            zone: Zone::Growing,
            x0: w / 2 + 2,
            y0: h / 2 + 2,
            x1: w / 2 + 5,
            y1: h / 2 + 4,
        });
        cmds.push(Command::Build {
            kind: BuildKind::Campfire,
            material: Material::Wood,
            x0: w / 2 - 2,
            y0: h / 2 + 6,
            x1: w / 2 - 2,
            y1: h / 2 + 6,
        });
    }
    if t == 90 {
        // Les priorités de travail changent l'ordre des recherches de job.
        if let Some(p) = sim.pawns().first() {
            cmds.push(Command::SetPriority {
                pawn: p.id,
                work: WorkType::Haul,
                priority: 1,
            });
        }
    }
    if t == 100 {
        // Climat imposé, comme une case du globe le ferait.
        cmds.push(Command::SetClimate {
            base_temperature: 60,
            amplitude: 300,
        });
    }
    if t == 6000 {
        // Le combat consomme du RNG : les deux sims doivent rester identiques.
        cmds.push(Command::TriggerRaid);
    }
    if t == 4000 {
        cmds.push(Command::CancelBuild {
            x0: w / 2 - 6,
            y0: h / 2 - 6,
            x1: w / 2 - 3,
            y1: h / 2 - 6,
        });
    }
    if t % 900 == 0 {
        for (k, p) in sim.pawns().iter().enumerate() {
            cmds.push(Command::MoveTo {
                pawn: p.id,
                x: ((t * 7 + k as u64 * 13) % w as u64) as u32,
                y: ((t * 11 + k as u64 * 17) % h as u64) as u32,
            });
        }
    }
    cmds
}

/// Ajoute `count` colons de plus, sur des cases franchissables en anneaux
/// concentriques autour du centre de la carte — même stratégie que les colons
/// de départ (`Sim::spawn_starting_pawns`, privée au sim), reconstruite ici à
/// partir de l'API publique.
pub fn spawn_extra_pawns(sim: &mut Sim, count: u32) {
    let (cx, cy) = (sim.map().width() / 2, sim.map().height() / 2);
    let Some(center) = sim.map().nearest_passable(cx, cy) else {
        return;
    };
    let max_r = sim.map().width().max(sim.map().height()) as i32 + 1;
    let mut spawned = 0;
    let mut r: i32 = 0;
    while spawned < count && r < max_r {
        for dy in -r..=r {
            for dx in -r..=r {
                if spawned >= count || (dx.abs() != r && dy.abs() != r) {
                    continue;
                }
                let x = center.0 as i32 + dx;
                let y = center.1 as i32 + dy;
                if sim.map().in_bounds(x, y) && sim.map().passable(x as u32, y as u32) {
                    sim.spawn_pawn(x as u32, y as u32, Faction::Colony);
                    spawned += 1;
                }
            }
        }
        r += 1;
    }
}
