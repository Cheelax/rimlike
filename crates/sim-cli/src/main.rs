//! `rimlike-sim` : outil natif pour mesurer, vérifier et déboguer le sim
//! hors navigateur. Ne dépend que du crate `sim` ; les arguments sont
//! analysés à la main (voir `cli.rs`).

mod campaign;
mod cli;
mod commands;
mod fuzzgen;
mod scenario;

use std::process::ExitCode;

const USAGE: &str = "\
rimlike-sim — outil natif pour le sim rimlike (mesure, vérification, débogage)

USAGE :
    rimlike-sim <sous-commande> [options]

SOUS-COMMANDES :
    run       exécute la simulation et affiche des rapports périodiques
    verify    compare deux sims indépendantes tick par tick
    snapshot  vérifie qu'un aller-retour snapshot/restore ne change rien
    bench     mesure les ticks/s de plusieurs scénarios
    fuzz      bombarde des sims de commandes aléatoires, cherche désyncs et paniques
    campaign  joue des colonies entières avec un joueur scripté et mesure la partie longue

Ajouter --help après une sous-commande pour son aide détaillée, par exemple :
    rimlike-sim run --help
";

fn main() -> ExitCode {
    let args: Vec<String> = std::env::args().skip(1).collect();

    let Some(sub) = args.first() else {
        eprint!("{USAGE}");
        return ExitCode::from(2);
    };

    if sub == "--help" || sub == "-h" {
        print!("{USAGE}");
        return ExitCode::SUCCESS;
    }

    let rest = &args[1..];
    let code = match sub.as_str() {
        "run" => commands::run(rest),
        "verify" => commands::verify(rest),
        "snapshot" => commands::snapshot(rest),
        "bench" => commands::bench(rest),
        "fuzz" => commands::fuzz(rest),
        "campaign" => campaign::campaign(rest),
        other => {
            eprintln!("erreur : sous-commande inconnue : « {other} »");
            eprintln!();
            eprint!("{USAGE}");
            2
        }
    };
    ExitCode::from(code)
}
