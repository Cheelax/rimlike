//! Les quatre sous-commandes : `run`, `verify`, `snapshot`, `bench`.

// `clippy.toml` interdit `Instant` pour `crates/sim` (aucune horloge dans le
// sim). Ce crate n'est pas le sim : il mesure du temps réel, c'est son rôle.
#![allow(clippy::disallowed_types)]

use std::time::Instant;

use sim::{Faction, Sim};

use crate::cli::{CliError, Options, wants_help};
use crate::scenario::{Scenario, spawn_extra_pawns};

fn parse_scenario(opts: &Options) -> Result<Scenario, CliError> {
    let raw = opts.string("scenario", "none");
    Scenario::parse(&raw).ok_or_else(|| {
        CliError::new(format!(
            "--scenario invalide : « {raw} » (attendu : none|demo)"
        ))
    })
}

fn check_size(size: u32) -> Result<(), CliError> {
    if size == 0 {
        return Err(CliError::new("--size doit être un entier positif"));
    }
    Ok(())
}

/// Colons vivants, pillards vivants, objets au sol, chantiers en cours.
fn counts(sim: &Sim) -> (usize, usize, usize, usize) {
    let mut colons = 0;
    let mut pillards = 0;
    for p in sim.pawns() {
        if !p.is_alive() {
            continue;
        }
        match p.faction {
            Faction::Colony => colons += 1,
            Faction::Raider => pillards += 1,
        }
    }
    (colons, pillards, sim.items().len(), sim.blueprints().len())
}

fn ticks_per_sec(ticks: u64, elapsed: std::time::Duration) -> f64 {
    let secs = elapsed.as_secs_f64();
    if secs > 0.0 { ticks as f64 / secs } else { 0.0 }
}

const RUN_HELP: &str = "\
rimlike-sim run — exécute la simulation et affiche des rapports périodiques

USAGE :
    rimlike-sim run --seed N --size W --ticks T [--scenario none|demo] [--report-every K]

OPTIONS :
    --seed N            graine du générateur aléatoire (entier)
    --size W            carte carrée W x W
    --ticks T           nombre de ticks à exécuter
    --scenario S         none (défaut) ou demo (rejoue scripted_commands)
    --report-every K     une ligne de rapport tous les K ticks (défaut 1000)
";

pub fn run(args: &[String]) -> u8 {
    if wants_help(args) {
        print!("{RUN_HELP}");
        return 0;
    }
    match run_inner(args) {
        Ok(code) => code,
        Err(e) => fail(&e, RUN_HELP),
    }
}

fn run_inner(args: &[String]) -> Result<u8, CliError> {
    let opts = Options::parse(args)?;
    opts.forbid_unknown(&["seed", "size", "ticks", "scenario", "report-every"])?;
    let seed = opts.require_u64("seed")?;
    let size = opts.require_u32("size")?;
    check_size(size)?;
    let ticks = opts.require_u64("ticks")?;
    let scenario = parse_scenario(&opts)?;
    let report_every = opts.u64_or("report-every", 1000)?;
    if report_every == 0 {
        return Err(CliError::new("--report-every doit être un entier positif"));
    }

    println!(
        "run : carte {size}x{size}, {ticks} ticks, seed {seed}, scénario {}",
        scenario.name_str()
    );
    println!("tick, ms, ticks/s, colons, pillards, objets, chantiers, hash");

    let mut sim = Sim::new(seed, size, size);
    let start = Instant::now();
    for t in 0..ticks {
        let cmds = scenario.commands(&sim, t);
        sim.step(&cmds);
        let tick = sim.tick();
        if tick % report_every == 0 {
            let elapsed = start.elapsed();
            let (colons, pillards, objets, chantiers) = counts(&sim);
            println!(
                "{tick}, {}, {:.1}, {colons}, {pillards}, {objets}, {chantiers}, {:016x}",
                elapsed.as_millis(),
                ticks_per_sec(tick, elapsed),
                sim.state_hash()
            );
        }
    }
    let elapsed = start.elapsed();

    println!();
    println!("résumé :");
    println!("  durée totale      : {} ms", elapsed.as_millis());
    println!("  ticks/s moyens    : {:.1}", ticks_per_sec(ticks, elapsed));
    println!("  hash final        : {:016x}", sim.state_hash());
    println!("  snapshot (octets) : {}", sim.snapshot().len());
    let events = sim.events();
    println!("  événements ({}) :", events.len());
    for e in events {
        println!(
            "    seq={} tick={} kind={:?} arg={}",
            e.seq, e.tick, e.kind, e.arg
        );
    }
    Ok(0)
}

const VERIFY_HELP: &str = "\
rimlike-sim verify — compare deux sims indépendantes nourries des mêmes entrées

USAGE :
    rimlike-sim verify --seed N --size W --ticks T [--scenario none|demo]

OPTIONS :
    --seed N            graine du générateur aléatoire (entier)
    --size W            carte carrée W x W
    --ticks T           nombre de ticks à exécuter
    --scenario S         none (défaut) ou demo (rejoue scripted_commands)

Affiche OK et sort en 0 si les hashes sont identiques tous les 500 ticks et à
la fin ; sinon affiche le premier tick divergent et sort en 1.
";

pub fn verify(args: &[String]) -> u8 {
    if wants_help(args) {
        print!("{VERIFY_HELP}");
        return 0;
    }
    match verify_inner(args) {
        Ok(code) => code,
        Err(e) => fail(&e, VERIFY_HELP),
    }
}

fn verify_inner(args: &[String]) -> Result<u8, CliError> {
    let opts = Options::parse(args)?;
    opts.forbid_unknown(&["seed", "size", "ticks", "scenario"])?;
    let seed = opts.require_u64("seed")?;
    let size = opts.require_u32("size")?;
    check_size(size)?;
    let ticks = opts.require_u64("ticks")?;
    let scenario = parse_scenario(&opts)?;

    let mut a = Sim::new(seed, size, size);
    let mut b = Sim::new(seed, size, size);
    for t in 0..ticks {
        // Les commandes ne sont calculées qu'une fois : les deux sims reçoivent
        // exactement la même liste, comme le ferait le lockstep.
        let cmds = scenario.commands(&a, t);
        a.step(&cmds);
        b.step(&cmds);
        if a.tick() % 500 == 0 && a.state_hash() != b.state_hash() {
            println!("désync au tick {}", a.tick());
            return Ok(1);
        }
    }
    if a.state_hash() != b.state_hash() {
        println!("désync au tick {}", a.tick());
        return Ok(1);
    }
    println!("OK");
    Ok(0)
}

const SNAPSHOT_HELP: &str = "\
rimlike-sim snapshot — vérifie qu'un aller-retour snapshot/restore ne change rien

USAGE :
    rimlike-sim snapshot --seed N --size W --ticks T --at A

OPTIONS :
    --seed N   graine du générateur aléatoire (entier)
    --size W   carte carrée W x W
    --ticks T  nombre total de ticks à exécuter
    --at A     tick auquel prendre le snapshot (0 <= A <= T)

Exécute jusqu'à A, prend un snapshot, restaure dans une seconde sim, continue
les deux jusqu'à T, puis compare le hash et l'égalité structurelle. Sort en 0
si tout concorde, en 1 sinon.
";

pub fn snapshot(args: &[String]) -> u8 {
    if wants_help(args) {
        print!("{SNAPSHOT_HELP}");
        return 0;
    }
    match snapshot_inner(args) {
        Ok(code) => code,
        Err(e) => fail(&e, SNAPSHOT_HELP),
    }
}

fn snapshot_inner(args: &[String]) -> Result<u8, CliError> {
    let opts = Options::parse(args)?;
    opts.forbid_unknown(&["seed", "size", "ticks", "at"])?;
    let seed = opts.require_u64("seed")?;
    let size = opts.require_u32("size")?;
    check_size(size)?;
    let ticks = opts.require_u64("ticks")?;
    let at = opts.require_u64("at")?;
    if at > ticks {
        return Err(CliError::new("--at doit être inférieur ou égal à --ticks"));
    }

    let mut a = Sim::new(seed, size, size);
    for _ in 0..at {
        a.step(&[]);
    }
    let bytes = a.snapshot();
    let mut b =
        Sim::restore(&bytes).map_err(|e| CliError::new(format!("snapshot invalide : {e}")))?;
    for _ in at..ticks {
        a.step(&[]);
        b.step(&[]);
    }

    let hash_a = a.state_hash();
    let hash_b = b.state_hash();
    let hashes_match = hash_a == hash_b;
    let structurally_equal = a == b;

    println!("snapshot pris au tick {at} ({} octets)", bytes.len());
    println!("hash a               : {hash_a:016x}");
    println!("hash b               : {hash_b:016x}");
    println!("hashes identiques    : {hashes_match}");
    println!("égalité structurelle : {structurally_equal}");

    if hashes_match && structurally_equal {
        println!("OK");
        Ok(0)
    } else {
        println!("ÉCHEC");
        Ok(1)
    }
}

/// Graine fixe du bench : reproductible d'une machine à l'autre, la
/// comparaison porte sur les ticks/s, pas sur le contenu de la partie.
const BENCH_SEED: u64 = 0xB1E1_C0DE;
/// Colons ajoutés au tick 1 pour le troisième scénario du bench.
const BENCH_EXTRA_PAWNS: u32 = 12;

const BENCH_HELP: &str = "\
rimlike-sim bench — mesure les ticks/s de plusieurs scénarios

USAGE :
    rimlike-sim bench --size W --ticks T

OPTIONS :
    --size W   carte carrée W x W
    --ticks T  nombre de ticks à exécuter par scénario

Mesure trois scénarios sur une graine fixe : none (aucune commande), demo
(scripted_commands) et demo+12 (demo avec 12 colons de plus spawnés au tick 1).
En --release, c'est la référence de perf du projet.
";

pub fn bench(args: &[String]) -> u8 {
    if wants_help(args) {
        print!("{BENCH_HELP}");
        return 0;
    }
    match bench_inner(args) {
        Ok(code) => code,
        Err(e) => fail(&e, BENCH_HELP),
    }
}

fn bench_inner(args: &[String]) -> Result<u8, CliError> {
    let opts = Options::parse(args)?;
    opts.forbid_unknown(&["size", "ticks"])?;
    let size = opts.require_u32("size")?;
    check_size(size)?;
    let ticks = opts.require_u64("ticks")?;

    println!("bench : carte {size}x{size}, {ticks} ticks, seed {BENCH_SEED:#x}");
    println!("{:<10} {:>14} {:>12}", "scénario", "ticks/s", "durée (ms)");

    let scenarios: [(&str, Scenario, u32); 3] = [
        ("none", Scenario::None, 0),
        ("demo", Scenario::Demo, 0),
        ("demo+12", Scenario::Demo, BENCH_EXTRA_PAWNS),
    ];
    for (label, scenario, extra_pawns) in scenarios {
        let mut sim = Sim::new(BENCH_SEED, size, size);
        let start = Instant::now();
        for t in 0..ticks {
            let cmds = scenario.commands(&sim, t);
            sim.step(&cmds);
            if t == 0 && extra_pawns > 0 {
                spawn_extra_pawns(&mut sim, extra_pawns);
            }
        }
        let elapsed = start.elapsed();
        println!(
            "{:<10} {:>14.1} {:>12}",
            label,
            ticks_per_sec(ticks, elapsed),
            elapsed.as_millis()
        );
    }
    Ok(0)
}

/// Affiche l'erreur et l'aide de la sous-commande sur stderr, code 2.
fn fail(e: &CliError, help: &str) -> u8 {
    eprintln!("erreur : {}", e.0);
    eprintln!();
    eprint!("{help}");
    2
}
