//! Tests d'intégration : lance le binaire `rimlike-sim` et vérifie ses codes
//! de sortie et sa sortie standard.

use std::process::Command;

fn bin() -> Command {
    Command::new(env!("CARGO_BIN_EXE_rimlike-sim"))
}

#[test]
fn verify_demo_2000_ticks_is_ok() {
    let output = bin()
        .args([
            "verify",
            "--seed",
            "1234",
            "--size",
            "48",
            "--ticks",
            "2000",
            "--scenario",
            "demo",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(output.status.success(), "code = {:?}", output.status.code());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.trim().lines().any(|l| l.trim() == "OK"),
        "stdout inattendu : {stdout}"
    );
}

#[test]
fn snapshot_roundtrip_is_ok() {
    let output = bin()
        .args([
            "snapshot", "--seed", "7", "--size", "32", "--ticks", "1000", "--at", "400",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(output.status.success(), "code = {:?}", output.status.code());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.lines().any(|l| l.trim() == "OK"),
        "stdout inattendu : {stdout}"
    );
}

#[test]
fn run_prints_summary_with_16_hex_hash() {
    let output = bin()
        .args([
            "run",
            "--seed",
            "99",
            "--size",
            "24",
            "--ticks",
            "300",
            "--scenario",
            "demo",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(output.status.success(), "code = {:?}", output.status.code());
    let stdout = String::from_utf8_lossy(&output.stdout);
    let hash_line = stdout
        .lines()
        .find(|l| l.contains("hash final"))
        .unwrap_or_else(|| panic!("pas de ligne « hash final » dans : {stdout}"));
    let hash = hash_line
        .rsplit(':')
        .next()
        .expect("une valeur après « : »")
        .trim();
    assert_eq!(hash.len(), 16, "hash « {hash} » n'a pas 16 caractères");
    assert!(
        hash.chars().all(|c| c.is_ascii_hexdigit()),
        "hash « {hash} » n'est pas hexadécimal"
    );
}

#[test]
fn missing_argument_is_exit_code_2_with_help() {
    let output = bin()
        .args(["run", "--size", "10", "--ticks", "10"])
        .output()
        .expect("le binaire doit s'exécuter");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--seed"), "stderr inattendu : {stderr}");
    assert!(stderr.contains("USAGE"), "message d'aide absent : {stderr}");
}

#[test]
fn invalid_argument_is_exit_code_2_with_help() {
    let output = bin()
        .args(["run", "--seed", "abc", "--size", "10", "--ticks", "10"])
        .output()
        .expect("le binaire doit s'exécuter");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--seed"), "stderr inattendu : {stderr}");
    assert!(stderr.contains("USAGE"), "message d'aide absent : {stderr}");
}

#[test]
fn unknown_subcommand_is_exit_code_2() {
    let output = bin()
        .args(["frobnicate"])
        .output()
        .expect("le binaire doit s'exécuter");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn no_arguments_is_exit_code_2() {
    let output = bin().output().expect("le binaire doit s'exécuter");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn top_level_help_exits_zero() {
    let output = bin()
        .args(["--help"])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(output.status.success());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("SOUS-COMMANDES"));
}

#[test]
fn subcommand_help_exits_zero() {
    for sub in ["run", "verify", "snapshot", "bench", "fuzz", "campaign"] {
        let output = bin()
            .args([sub, "--help"])
            .output()
            .expect("le binaire doit s'exécuter");
        assert!(output.status.success(), "sous-commande {sub}");
        let stdout = String::from_utf8_lossy(&output.stdout);
        assert!(
            stdout.contains("USAGE"),
            "aide de {sub} incomplète : {stdout}"
        );
    }
}

#[test]
fn verify_diverges_message_would_exit_1_shape() {
    // On ne provoque pas volontairement une vraie divergence (le sim est
    // déterministe par construction), mais on vérifie qu'un scénario invalide
    // échoue proprement en amont, avec le bon code d'erreur d'utilisation.
    let output = bin()
        .args([
            "verify",
            "--seed",
            "1",
            "--size",
            "16",
            "--ticks",
            "10",
            "--scenario",
            "does-not-exist",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn snapshot_at_greater_than_ticks_is_exit_code_2() {
    let output = bin()
        .args([
            "snapshot", "--seed", "1", "--size", "16", "--ticks", "10", "--at", "20",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert_eq!(output.status.code(), Some(2));
}

#[test]
fn fuzz_runs_and_reports_structured_result() {
    // Le fuzz peut légitimement trouver un bug dans le sim (code 1) : on ne
    // teste que la forme du rapport, jamais le verdict.
    let output = bin()
        .args([
            "fuzz", "--seed", "1", "--size", "32", "--ticks", "1500", "--runs", "2",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    let code = output.status.code();
    assert!(
        code == Some(0) || code == Some(1),
        "code inattendu : {code:?}"
    );
    let stdout = String::from_utf8_lossy(&output.stdout);
    if code == Some(0) {
        assert!(
            stdout.contains("run 0 : OK"),
            "pas de ligne de run OK : {stdout}"
        );
        assert!(
            stdout.contains("résumé :"),
            "pas de résumé final : {stdout}"
        );
        assert!(
            stdout.contains("commandes par variante"),
            "pas de stats par variante : {stdout}"
        );
    } else {
        assert!(
            stdout.contains("PANIQUE :")
                || stdout.contains("DÉSYNC :")
                || stdout.contains("SNAPSHOT INVALIDE :"),
            "rapport de problème absent : {stdout}"
        );
    }
}

#[test]
fn fuzz_with_zero_commands_matches_scenario_none() {
    let run_output = bin()
        .args([
            "run",
            "--seed",
            "5",
            "--size",
            "16",
            "--ticks",
            "300",
            "--scenario",
            "none",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(run_output.status.success());
    let run_stdout = String::from_utf8_lossy(&run_output.stdout);
    let run_hash = run_stdout
        .lines()
        .find(|l| l.contains("hash final"))
        .unwrap_or_else(|| panic!("pas de ligne « hash final » : {run_stdout}"))
        .rsplit(':')
        .next()
        .expect("une valeur après « : »")
        .trim()
        .to_string();

    let fuzz_output = bin()
        .args([
            "fuzz",
            "--seed",
            "5",
            "--size",
            "16",
            "--ticks",
            "300",
            "--commands-per-tick",
            "0",
            "--runs",
            "1",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(
        fuzz_output.status.success(),
        "code = {:?}",
        fuzz_output.status.code()
    );
    let fuzz_stdout = String::from_utf8_lossy(&fuzz_output.stdout);
    let ok_line = fuzz_stdout
        .lines()
        .find(|l| l.starts_with("run 0 : OK"))
        .unwrap_or_else(|| panic!("pas de ligne « run 0 : OK » : {fuzz_stdout}"));
    let fuzz_hash = ok_line
        .rsplit(' ')
        .next()
        .expect("un hash en fin de ligne")
        .trim();

    assert!(
        ok_line.contains("0 commandes"),
        "la ligne devrait annoncer 0 commandes : {ok_line}"
    );
    assert_eq!(
        run_hash, fuzz_hash,
        "hash différent avec --commands-per-tick 0 : {fuzz_stdout}"
    );
}

#[test]
fn bench_prints_three_scenarios() {
    let output = bin()
        .args(["bench", "--size", "16", "--ticks", "50"])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(output.status.success(), "code = {:?}", output.status.code());
    let stdout = String::from_utf8_lossy(&output.stdout);
    for label in ["none", "demo", "demo+12"] {
        assert!(
            stdout.contains(label),
            "scénario « {label} » absent du tableau : {stdout}"
        );
    }
}

#[test]
fn campaign_prints_a_line_per_seed_and_a_summary() {
    let output = bin()
        .args([
            "campaign",
            "--seeds",
            "2",
            "--days",
            "1",
            "--size",
            "32",
            "--difficulty",
            "1",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(output.status.success(), "code = {:?}", output.status.code());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(stdout.contains("graine"), "en-tête absent : {stdout}");
    assert!(stdout.contains("résumé :"), "résumé absent : {stdout}");
    // Une ligne par graine, en plus de l'en-tête.
    let rows = stdout
        .lines()
        .filter(|l| l.trim_start().starts_with('1') || l.trim_start().starts_with('2'))
        .count();
    assert!(rows >= 2, "moins de deux lignes de graine : {stdout}");
}

#[test]
fn campaign_json_is_machine_readable() {
    let output = bin()
        .args([
            "campaign", "--seeds", "1", "--days", "1", "--size", "32", "--json",
        ])
        .output()
        .expect("le binaire doit s'exécuter");
    assert!(output.status.success(), "code = {:?}", output.status.code());
    let stdout = String::from_utf8_lossy(&output.stdout);
    assert!(
        stdout.trim_start().starts_with('{'),
        "pas du JSON : {stdout}"
    );
    assert!(stdout.trim_end().ends_with('}'), "JSON tronqué : {stdout}");
    assert!(stdout.contains("\"runs\""), "pas de runs : {stdout}");
    assert!(
        stdout.contains("\"colonists_end\""),
        "champ manquant : {stdout}"
    );
    // Un mot français dans une sortie machine trahirait un `println!` oublié.
    assert!(!stdout.contains("résumé"), "résumé dans le JSON : {stdout}");
}

#[test]
fn campaign_rejects_an_impossible_difficulty() {
    let output = bin()
        .args(["campaign", "--difficulty", "9"])
        .output()
        .expect("le binaire doit s'exécuter");
    assert_eq!(output.status.code(), Some(2));
    let stderr = String::from_utf8_lossy(&output.stderr);
    assert!(stderr.contains("--difficulty"), "stderr : {stderr}");
}
