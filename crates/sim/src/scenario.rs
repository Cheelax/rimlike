//! Le scénario de référence du projet : une partie scriptée, reproductible,
//! qui touche à presque tout le sim (zones, chantiers, climat, calendrier,
//! recherche, caravane, gel, troc, chasse, élevage, raid).
//!
//! Une seule source, trois consommateurs : le test de déterminisme
//! (`crates/sim/tests/determinism.rs`), l'outil natif (`rimlike-sim run`,
//! `verify`, `bench`) et la frontière WASM (`WasmSim::step_demo`). Avant, il
//! en existait deux copies, et elles avaient divergé : celle de
//! `crates/sim-cli/src/scenario.rs` s'était arrêtée au climat pendant que
//! celle du test continuait de grandir.
//!
//! Module de sim ordinaire : mêmes lints que le reste du crate (aucun
//! flottant, aucune structure à ordre aléatoire, aucune horloge).

use crate::{
    BuildKind, Command, Designation, Difficulty, Faction, ItemKind, Material, Sim, Tech, WorkType,
    Zone,
};

/// Tick où le scénario gèle puis dégèle la carte, et durée du gel : l'avance
/// rapide consomme du RNG (la météo est retirée) et touche à tout l'état, elle
/// a donc sa place dans le scénario de référence.
pub const FAST_FORWARD_AT: u64 = 8_000;
/// Ticks sautés par l'avance rapide du tick `FAST_FORWARD_AT`.
pub const FAST_FORWARD_TICKS: u32 = 3_000;

/// Empreinte de la partie de référence, épinglée : graine 1, carte 64×64,
/// 10 000 tours de boucle, `Sim::new` (biome tempéré), `demo_commands(&sim, t)`
/// appliqué **avant** le `step` de chaque tick, et rien d'autre (pas de
/// marchand poussé à la main : c'est le test de déterminisme qui en ajoute
/// un, hors commande). Exactement ce que joue
/// `rimlike-sim run --seed 1 --size 64 --ticks 10000 --scenario demo`, dont la
/// ligne « hash final » affiche la même valeur.
///
/// Attention : l'avance rapide du tick 8 000 saute 3 000 ticks, donc
/// `sim.tick()` vaut 13 000 au bout des 10 000 tours de boucle.
///
/// Ce hash **change quand le sim change** : c'est son rôle. Celui qui change
/// le sim met la constante à jour dans le même commit, et écrit pourquoi.
///
/// Historique : jusqu'au 2026-09-10, `rimlike-sim` affichait
/// `402c950b5ca15d90` pour ce scénario. Ce n'était pas la même partie : la
/// copie du scénario vivant dans `sim-cli` avait cessé d'être tenue à jour et
/// ignorait la difficulté, le poste de fabrication, la recherche, le
/// calendrier, la caravane, le gel, l'apprivoisement, la chasse, l'abattoir et
/// le troc. L'unification fait jouer à `demo` le scénario complet, celui du
/// test de déterminisme ; le hash change pour cette raison, pas parce que le
/// sim a bougé.
pub const DEMO_HASH: u64 = 0xe42d_5ed1_4b0c_dc69;
/// Graine de la partie décrite par `DEMO_HASH`.
pub const DEMO_SEED: u64 = 1;
/// Côté de la carte carrée de `DEMO_HASH`.
pub const DEMO_SIZE: u32 = 64;
/// Tours de boucle joués par `DEMO_HASH` (pas le tick final : voir plus haut).
pub const DEMO_TICKS: u64 = 10_000;

/// Empreinte d'une partie **sans aucune commande** sur un autre biome que le
/// tempéré : graine 5, carte 48×48, six jours (`6 × TICKS_PER_DAY` ticks),
/// `Sim::new_in_biome(.., Biome::Tundra)`. Elle vient de
/// `crates/sim/tests/biomes.rs::the_other_biomes_draw_the_same_herds`, qui la
/// lit ici plutôt que d'en garder une copie.
///
/// Elle couvre ce que `DEMO_HASH` ne couvre pas : la génération de carte d'un
/// biome froid, la neige, le gel, et une colonie livrée à elle-même sur la
/// durée. Même règle qu'au-dessus : elle change avec le sim, dans le commit
/// qui change le sim.
pub const TUNDRA_IDLE_HASH: u64 = 0xae9d_b4a0_1cb9_98d6;
/// Graine de la partie décrite par `TUNDRA_IDLE_HASH`.
pub const TUNDRA_IDLE_SEED: u64 = 5;
/// Côté de la carte carrée de `TUNDRA_IDLE_HASH`.
pub const TUNDRA_IDLE_SIZE: u32 = 48;
/// Jours de jeu joués par `TUNDRA_IDLE_HASH`.
pub const TUNDRA_IDLE_DAYS: u64 = 6;

/// Commandes du scénario de référence au tick `t` : déplacements,
/// désignations et zones dérivés du numéro de tick.
pub fn demo_commands(sim: &Sim, t: u64) -> Vec<Command> {
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
    if t == 50 {
        // La difficulté change la dose de menace **et** la cadence des raids :
        // elle fait partie de l'état, donc du hash.
        cmds.push(Command::SetDifficulty {
            level: Difficulty::Hard,
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
        cmds.push(Command::Build {
            kind: BuildKind::CraftingSpot,
            material: Material::Wood,
            x0: w / 2 - 4,
            y0: h / 2 + 6,
            x1: w / 2 - 4,
            y1: h / 2 + 6,
        });
    }
    if t == 70 {
        // Un établi de recherche : les points versés, la technologie acquise
        // et son bonus font partie de l'état, donc du hash.
        cmds.push(Command::Build {
            kind: BuildKind::ResearchBench,
            material: Material::Wood,
            x0: w / 2 - 6,
            y0: h / 2 + 6,
            x1: w / 2 - 6,
            y1: h / 2 + 6,
        });
    }
    if t == 200 {
        cmds.push(Command::SetResearch {
            tech: Tech::Agriculture as u8,
        });
    }
    if t == 7100 {
        // Un colon met la recherche en tête : sur une carte aussi occupée
        // (chantiers, livraisons, rangement), l'établi ne servirait jamais
        // sinon, et le scénario ne dirait rien de `Job::Research`. Après le
        // départ de la caravane (tick 7000) et avant le gel (tick 8000) :
        // ainsi la technologie tombe pendant le scénario, et l'avance rapide
        // applique son bonus de pousse.
        if let Some(p) = sim
            .pawns()
            .iter()
            .find(|p| p.faction == Faction::Colony && p.is_alive())
        {
            cmds.push(Command::SetPriority {
                pawn: p.id,
                work: WorkType::Research,
                priority: 1,
            });
        }
    }
    if t == 9900 {
        // Un numéro qui ne désigne aucune technologie : consommé de la même
        // façon partout, ignoré partout.
        cmds.push(Command::SetResearch { tech: 200 });
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
        // Le climat fait partie de l'état : une case du globe impose le sien en
        // lockstep. Plus rude que le tempéré par défaut (6 °C ± 30), de quoi
        // ralentir la pousse et peser sur l'humeur sans geler la colonie.
        cmds.push(Command::SetClimate {
            base_temperature: 60,
            amplitude: 300,
        });
    }
    if t == 120 {
        // Le calendrier imposé fait aussi partie de l'état : une case du
        // globe reçoit son jour de l'année comme son climat, en lockstep.
        cmds.push(Command::SetCalendar { day_of_year: 30 });
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
    if t == 7000 {
        // Une caravane part : deux colons et du bois quittent la carte, et le
        // manifeste encodé entre dans l'état (donc dans le hash).
        let travellers: Vec<u32> = sim
            .pawns()
            .iter()
            .filter(|p| p.faction == Faction::Colony && p.is_alive() && !p.is_downed())
            .take(2)
            .map(|p| p.id)
            .collect();
        if travellers.len() == 2 {
            cmds.push(Command::FormCaravan {
                pawns: travellers,
                items: vec![(ItemKind::Wood, 15)],
            });
        }
    }
    if t == 7010 {
        // L'hôte a expédié le manifeste : tout le monde vide la file au même tick.
        cmds.push(Command::ClearDepartures { count: 1 });
    }
    if t == FAST_FORWARD_AT {
        // La colonie rouvre après une absence : le rattrapage est une commande
        // comme les autres, appliquée au même tick chez tout le monde.
        cmds.push(Command::FastForward {
            ticks: FAST_FORWARD_TICKS,
        });
    }
    if t == 9000 {
        // Un ordre de fabrication après le dégel : les objectifs font partie
        // de l'état, et la fabrication consomme du stock comme un chantier.
        cmds.push(Command::SetCraftTarget {
            kind: ItemKind::Club,
            target: 2,
        });
        cmds.push(Command::SetCraftTarget {
            kind: ItemKind::Spear,
            target: 1,
        });
    }
    if t == 4000 {
        // L'apprivoisement touche à l'aléa (le dé de la tentative), aux piles
        // de fourrage et à la faction d'un pawn : il a sa place dans le
        // scénario de référence, comme la chasse. Sans animal, rien n'est émis.
        // Qu'il aboutisse ou non, les deux sims doivent en tirer le même état :
        // c'est `livestock::livestock_is_deterministic` (tests/livestock.rs) qui
        // compare deux cartes avec un troupeau **garanti**.
        if let Some(a) = sim.pawns().iter().find(|p| p.faction == Faction::Animal) {
            cmds.push(Command::Tame {
                animal: a.id,
                on: true,
            });
        }
    }
    if t == 4010 {
        // Sans cela, l'apprivoisement n'aurait aucune chance de se jouer : la
        // carte est couverte de désignations, et `WorkType::Designated` passe
        // avant `WorkType::Farm` à priorité égale.
        if let Some(p) = sim.pawns().iter().find(|p| p.is_colonist() && p.is_alive()) {
            cmds.push(Command::SetPriority {
                pawn: p.id,
                work: WorkType::Farm,
                priority: 1,
            });
        }
    }
    if t == 9900 {
        // L'abattoir : sur la première bête de la colonie si le tick 4000 a
        // fini par en donner une, sinon sur un id inventé — qui doit être
        // ignoré de la même façon des deux côtés.
        let animal = sim
            .pawns()
            .iter()
            .find(|p| p.is_livestock())
            .map_or(u32::MAX, |p| p.id);
        cmds.push(Command::Slaughter { animal });
    }
    if t == 9500 {
        // La chasse touche au combat, aux morts et aux dépouilles : elle a sa
        // place dans le scénario de référence. Sans animal (carte pauvre),
        // rien n'est émis, et le scénario reste identique des deux côtés.
        if let Some(a) = sim.pawns().iter().find(|p| p.faction == Faction::Animal) {
            cmds.push(Command::Hunt {
                animal: a.id,
                on: true,
            });
        }
    }
    if t == 9800 {
        // Un vêtement passe par le même poste et le même bill qu'une arme,
        // mais consomme du cuir : si la chasse du tick 9500 a donné quelque
        // chose, la tunique entre dans le hash comme le reste.
        cmds.push(Command::SetCraftTarget {
            kind: ItemKind::Tunic,
            target: 1,
        });
    }
    if t == 5200 {
        // Un troc plausible pendant la visite du tick 5000 : qu'il aboutisse
        // (marchand vivrier, bois en stock) ou non, les deux sims doivent en
        // tirer exactement le même état.
        cmds.push(Command::Trade {
            give: ItemKind::Wood,
            give_count: 30,
            take: ItemKind::Berries,
            take_count: 5,
        });
    }
    if t == 9700 {
        // Un troc qui ne tombe juste sur aucun point : genres invraisemblables,
        // quantités hors de tout stock, et pas forcément de marchand en vue.
        // Il doit être **consommé** (donc lu de la même façon partout) et
        // ignoré, comme un `Hunt` sur un id inventé.
        cmds.push(Command::Trade {
            give: ItemKind::Corpse,
            give_count: u32::MAX,
            take: ItemKind::Bow,
            take_count: u32::MAX,
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
