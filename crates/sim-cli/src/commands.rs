//! Les quatre sous-commandes : `run`, `verify`, `snapshot`, `bench`.

// `clippy.toml` interdit `Instant` pour `crates/sim` (aucune horloge dans le
// sim). Ce crate n'est pas le sim : il mesure du temps réel, c'est son rôle.
#![allow(clippy::disallowed_types)]

use std::time::Instant;

use sim::{Command, Faction, Rng, Sim};

use crate::cli::{CliError, Options, wants_help};
use crate::fuzzgen;
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

const FUZZ_HELP: &str = "\
rimlike-sim fuzz — bombarde deux sims de commandes aléatoires et compare

USAGE :
    rimlike-sim fuzz --seed N --size W --ticks T [--commands-per-tick K] [--runs R] [--snapshot-every S]

OPTIONS :
    --seed N               graine de base (le run r utilise la graine N + r)
    --size W                carte carrée W x W
    --ticks T               nombre de ticks par run
    --commands-per-tick K   commandes aléatoires générées par tick (défaut 2)
    --runs R                nombre de runs indépendants (défaut 1)
    --snapshot-every S      aller-retour snapshot/restore tous les S ticks (défaut 1500)

Pour chaque run, deux sims indépendantes de même graine et de même taille
reçoivent exactement les mêmes commandes, tirées parmi toutes les variantes
de `Command` avec des paramètres tantôt valides, tantôt aberrants :
coordonnées hors carte (négatives, énormes), rectangles inversés, ids de
pawns inventés, priorités hors bornes, colon qui s'attaque lui-même, raids
fréquents, annulations de chantier sur toute la carte...

Les hashes des deux sims sont comparés tous les 100 ticks et à la fin du run.
Un aller-retour snapshot/restore est vérifié tous les --snapshot-every ticks
(égalité structurelle et de hash avec la sim d'origine). Toute panique du sim
est attrapée (le hook de panique est rendu silencieux le temps du fuzz, puis
restauré).

Sort en 0 si tous les runs sont OK, avec un résumé (commandes par variante,
colons/pillards/objets/chantiers de fin de run). Sort en 1 à la première
désync, panique ou snapshot invalide, avec un rapport détaillé : graine,
tick, commande(s) en cause, message de panique le cas échéant, et les 10
dernières commandes générées.
";

pub fn fuzz(args: &[String]) -> u8 {
    if wants_help(args) {
        print!("{FUZZ_HELP}");
        return 0;
    }
    match fuzz_inner(args) {
        Ok(code) => code,
        Err(e) => fail(&e, FUZZ_HELP),
    }
}

/// Fenêtre glissante des 10 dernières commandes générées (tick, commande),
/// pour le rapport en cas de problème. Un `Vec` borné : pas besoin de plus.
struct RecentCommands {
    entries: Vec<(u64, Command)>,
}

impl RecentCommands {
    fn new() -> RecentCommands {
        RecentCommands {
            entries: Vec::with_capacity(10),
        }
    }

    fn push(&mut self, tick: u64, cmd: Command) {
        self.entries.push((tick, cmd));
        if self.entries.len() > 10 {
            self.entries.remove(0);
        }
    }

    fn format(&self) -> String {
        let mut out = String::new();
        for (tick, cmd) in &self.entries {
            out.push_str(&format!("    tick {tick} : {cmd:?}\n"));
        }
        out
    }
}

/// Message porté par une panique attrapée via `catch_unwind`.
fn panic_message(payload: &(dyn std::any::Any + Send)) -> String {
    if let Some(s) = payload.downcast_ref::<&str>() {
        (*s).to_string()
    } else if let Some(s) = payload.downcast_ref::<String>() {
        s.clone()
    } else {
        "panique sans message exploitable".to_string()
    }
}

/// Reconstruit l'état d'avant le tick `target_tick` en rejouant le run depuis
/// zéro. La génération de commandes est entièrement déterministe (même
/// graine, mêmes `sim.pawns()` observés à chaque tick), donc ce replay
/// redonne exactement l'état qu'avait la sim juste avant ce tick — sans
/// jamais cloner la sim dans la boucle chaude, ce qui dominerait le coût
/// d'un run entier pour un diagnostic qui ne sert presque jamais.
fn reconstruct_pre_state(
    run_seed: u64,
    size: u32,
    commands_per_tick: u64,
    target_tick: u64,
) -> Sim {
    let mut sim = Sim::new(run_seed, size, size);
    let mut cmd_rng = Rng::new(run_seed);
    for _ in 0..target_tick {
        let mut cmds = Vec::with_capacity(commands_per_tick as usize);
        for _ in 0..commands_per_tick {
            let (cmd, _) = fuzzgen::random_command(&mut cmd_rng, &sim, size);
            cmds.push(cmd);
        }
        sim.step(&cmds);
    }
    sim
}

/// Essaie d'isoler, parmi les commandes du tick fautif, celle qui panique à
/// elle seule quand on la rejoue depuis une copie de l'état d'avant le tick.
/// Ce n'est qu'un indice : une panique qui n'apparaît qu'en combinant
/// plusieurs commandes du même tick ne sera pas isolée (`None`).
fn find_culprit(pre_state: &Sim, cmds: &[Command]) -> Option<usize> {
    for (i, cmd) in cmds.iter().enumerate() {
        let mut probe = pre_state.clone();
        let single = [cmd.clone()];
        let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| probe.step(&single)));
        if result.is_err() {
            return Some(i);
        }
    }
    None
}

fn panic_report(
    seed: u64,
    tick: u64,
    cmds: &[Command],
    recent: &RecentCommands,
    payload: &(dyn std::any::Any + Send),
    pre_state: &Sim,
) -> String {
    let mut out = String::new();
    out.push_str(&format!("PANIQUE : seed {seed}, tick {tick}\n"));
    out.push_str(&format!("  message : {}\n", panic_message(payload)));
    match find_culprit(pre_state, cmds) {
        Some(i) => out.push_str(&format!(
            "  commande fautive (isolée) : [{i}] {:?}\n",
            cmds[i]
        )),
        None => out.push_str(
            "  aucune commande seule ne reproduit la panique isolément (combinaison nécessaire)\n",
        ),
    }
    out.push_str(&format!("  commandes du tick {tick} ({}) :\n", cmds.len()));
    for (i, cmd) in cmds.iter().enumerate() {
        out.push_str(&format!("    [{i}] {cmd:?}\n"));
    }
    out.push_str("  10 dernières commandes générées :\n");
    out.push_str(&recent.format());
    out
}

fn desync_report(seed: u64, tick: u64, recent: &RecentCommands) -> String {
    let mut out = String::new();
    out.push_str(&format!("DÉSYNC : seed {seed}, tick {tick}\n"));
    out.push_str("  10 dernières commandes générées :\n");
    out.push_str(&recent.format());
    out
}

fn snapshot_report(seed: u64, tick: u64, recent: &RecentCommands) -> String {
    let mut out = String::new();
    out.push_str(&format!(
        "SNAPSHOT INVALIDE : seed {seed}, tick {tick} (aller-retour snapshot/restore diverge)\n"
    ));
    out.push_str("  10 dernières commandes générées :\n");
    out.push_str(&recent.format());
    out
}

/// Issue d'un run de fuzz : soit tout va bien (hash final, nombre de
/// commandes générées, et quelques stats de fin de run), soit un rapport de
/// problème déjà formaté.
enum FuzzOutcome {
    Ok {
        hash: u64,
        commands: u64,
        colons: usize,
        pillards: usize,
        objets: usize,
        chantiers: usize,
    },
    Problem(String),
}

fn fuzz_one_run(
    run_seed: u64,
    size: u32,
    ticks: u64,
    commands_per_tick: u64,
    snapshot_every: u64,
    variant_counts: &mut [u64; fuzzgen::VARIANT_COUNT],
) -> FuzzOutcome {
    let mut a = Sim::new(run_seed, size, size);
    let mut b = Sim::new(run_seed, size, size);
    let mut cmd_rng = Rng::new(run_seed);
    let mut recent = RecentCommands::new();
    let mut total_commands = 0u64;

    for t in 0..ticks {
        let mut cmds = Vec::with_capacity(commands_per_tick as usize);
        for _ in 0..commands_per_tick {
            let (cmd, variant) = fuzzgen::random_command(&mut cmd_rng, &a, size);
            variant_counts[variant] += 1;
            total_commands += 1;
            recent.push(t, cmd.clone());
            cmds.push(cmd);
        }

        if let Err(payload) =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| a.step(&cmds)))
        {
            let pre_state = reconstruct_pre_state(run_seed, size, commands_per_tick, t);
            return FuzzOutcome::Problem(panic_report(
                run_seed, t, &cmds, &recent, &*payload, &pre_state,
            ));
        }
        if let Err(payload) =
            std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| b.step(&cmds)))
        {
            let pre_state = reconstruct_pre_state(run_seed, size, commands_per_tick, t);
            return FuzzOutcome::Problem(panic_report(
                run_seed, t, &cmds, &recent, &*payload, &pre_state,
            ));
        }

        if a.tick() % 100 == 0 && a.state_hash() != b.state_hash() {
            return FuzzOutcome::Problem(desync_report(run_seed, a.tick(), &recent));
        }

        if a.tick() % snapshot_every == 0 {
            match Sim::restore(&a.snapshot()) {
                Ok(restored) => {
                    if restored != a || restored.state_hash() != a.state_hash() {
                        return FuzzOutcome::Problem(snapshot_report(run_seed, a.tick(), &recent));
                    }
                }
                Err(e) => {
                    return FuzzOutcome::Problem(format!(
                        "SNAPSHOT INVALIDE : seed {run_seed}, tick {} : {e}\n",
                        a.tick()
                    ));
                }
            }
        }
    }

    if a.state_hash() != b.state_hash() {
        return FuzzOutcome::Problem(desync_report(run_seed, a.tick(), &recent));
    }

    let hash = a.state_hash();
    let (colons, pillards, objets, chantiers) = counts(&a);
    FuzzOutcome::Ok {
        hash,
        commands: total_commands,
        colons,
        pillards,
        objets,
        chantiers,
    }
}

fn fuzz_inner(args: &[String]) -> Result<u8, CliError> {
    let opts = Options::parse(args)?;
    opts.forbid_unknown(&[
        "seed",
        "size",
        "ticks",
        "commands-per-tick",
        "runs",
        "snapshot-every",
    ])?;
    let seed = opts.require_u64("seed")?;
    let size = opts.require_u32("size")?;
    check_size(size)?;
    let ticks = opts.require_u64("ticks")?;
    let commands_per_tick = opts.u64_or("commands-per-tick", 2)?;
    let runs = opts.u64_or("runs", 1)?;
    if runs == 0 {
        return Err(CliError::new("--runs doit être un entier positif"));
    }
    let snapshot_every = opts.u64_or("snapshot-every", 1500)?;
    if snapshot_every == 0 {
        return Err(CliError::new(
            "--snapshot-every doit être un entier positif",
        ));
    }

    println!(
        "fuzz : carte {size}x{size}, {ticks} ticks, {runs} runs, seed de base {seed}, {commands_per_tick} commandes/tick, snapshot tous les {snapshot_every} ticks"
    );

    // Rendu silencieux le temps du fuzz : les paniques attrapées sont
    // rapportées à la main, un message par défaut sur stderr noierait le
    // rapport structuré. Toujours restauré avant de sortir.
    let previous_hook = std::panic::take_hook();
    std::panic::set_hook(Box::new(|_| {}));

    let mut variant_counts = [0u64; fuzzgen::VARIANT_COUNT];
    let mut total_ticks = 0u64;
    let mut total_commands = 0u64;
    let mut problem = None;
    let start = Instant::now();

    for r in 0..runs {
        let run_seed = seed.wrapping_add(r);
        match fuzz_one_run(
            run_seed,
            size,
            ticks,
            commands_per_tick,
            snapshot_every,
            &mut variant_counts,
        ) {
            FuzzOutcome::Ok {
                hash,
                commands,
                colons,
                pillards,
                objets,
                chantiers,
            } => {
                total_ticks += ticks;
                total_commands += commands;
                println!("run {r} : OK, {ticks} ticks, {commands} commandes, hash {hash:016x}");
                println!(
                    "  colons={colons} pillards={pillards} objets={objets} chantiers={chantiers}"
                );
            }
            FuzzOutcome::Problem(report) => {
                problem = Some(report);
                break;
            }
        }
    }
    let elapsed = start.elapsed();

    std::panic::set_hook(previous_hook);

    if let Some(report) = problem {
        print!("{report}");
        return Ok(1);
    }

    println!();
    println!("résumé :");
    println!("  runs                : {runs}");
    println!("  ticks au total      : {total_ticks}");
    println!("  commandes au total  : {total_commands}");
    println!("  durée               : {} ms", elapsed.as_millis());
    println!("  commandes par variante :");
    for (name, count) in fuzzgen::VARIANT_NAMES.iter().zip(variant_counts.iter()) {
        println!("    {name:<12} {count}");
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
