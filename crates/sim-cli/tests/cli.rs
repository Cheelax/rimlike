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
    for sub in ["run", "verify", "snapshot", "bench"] {
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
