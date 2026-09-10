//! Scénario `demo` : le scénario de référence du sim
//! (`sim::scenario::demo_commands`), rejoué hors des tests (mesure de perf,
//! vérification manuelle, snapshots). Aucune copie ici : ce fichier ne fait
//! que nommer les scénarios de la ligne de commande.

use sim::{Command, Faction, Sim};

/// Scénario appliqué tick par tick par `run`, `verify` et `bench`.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Scenario {
    /// Aucune commande : mesure le coût de la simulation seule (météo,
    /// pousse, storyteller, IA des colons livrés à eux-mêmes).
    None,
    /// Rejoue `sim::scenario::demo_commands`, le scénario de référence du
    /// projet, celui du test de déterminisme. Sur graine 1, carte 64×64 et
    /// 10 000 ticks, son hash final est `sim::scenario::DEMO_HASH`.
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
            Scenario::Demo => sim::scenario::demo_commands(sim, t),
        }
    }
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
