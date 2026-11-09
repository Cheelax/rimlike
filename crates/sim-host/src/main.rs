//! stdout est exclusivement réservé au protocole binaire.
fn main() {
    if let Err(error) = sim_host::serve(&mut std::io::stdin().lock(), &mut std::io::stdout().lock())
    {
        eprintln!("rimlike-native : {error}");
        std::process::exit(1);
    }
}
