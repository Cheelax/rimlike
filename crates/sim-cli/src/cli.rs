//! Analyse d'arguments à la main : `--option valeur`, sans dépendance externe.

/// Erreur d'utilisation (argument manquant, invalide ou inconnu). Toujours
/// traduite en code de sortie 2 par `main`, avec le message d'aide de la
/// sous-commande.
pub struct CliError(pub String);

impl CliError {
    pub fn new(msg: impl Into<String>) -> CliError {
        CliError(msg.into())
    }
}

/// `true` si `--help` ou `-h` apparaît n'importe où dans les arguments d'une
/// sous-commande. Vérifié avant l'analyse stricte des paires `--option valeur`.
pub fn wants_help(args: &[String]) -> bool {
    args.iter().any(|a| a == "--help" || a == "-h")
}

/// Options `--nom valeur` d'une sous-commande, dans l'ordre de la ligne de
/// commande. Une poignée d'options au plus par appel : un `Vec` parcouru
/// linéairement suffit, pas besoin de table de hachage.
pub struct Options {
    pairs: Vec<(String, String)>,
}

impl Options {
    /// Découpe `args` en paires `--nom valeur`. Rejette un nom sans valeur ou
    /// un argument qui ne commence pas par `--`.
    pub fn parse(args: &[String]) -> Result<Options, CliError> {
        let mut pairs = Vec::new();
        let mut i = 0;
        while i < args.len() {
            let arg = &args[i];
            let Some(name) = arg.strip_prefix("--") else {
                return Err(CliError::new(format!(
                    "argument inattendu : « {arg} » (attendu : --option valeur)"
                )));
            };
            if name.is_empty() {
                return Err(CliError::new("« -- » seul n'est pas une option valide"));
            }
            let Some(value) = args.get(i + 1) else {
                return Err(CliError::new(format!(
                    "l'option --{name} attend une valeur"
                )));
            };
            pairs.push((name.to_string(), value.clone()));
            i += 2;
        }
        Ok(Options { pairs })
    }

    /// Vérifie qu'aucune option reçue n'est absente de `allowed`.
    pub fn forbid_unknown(&self, allowed: &[&str]) -> Result<(), CliError> {
        for (name, _) in &self.pairs {
            if !allowed.contains(&name.as_str()) {
                return Err(CliError::new(format!("option inconnue : --{name}")));
            }
        }
        Ok(())
    }

    fn raw(&self, name: &str) -> Option<&str> {
        self.pairs
            .iter()
            .rev()
            .find(|(k, _)| k == name)
            .map(|(_, v)| v.as_str())
    }

    pub fn string(&self, name: &str, default: &str) -> String {
        self.raw(name).unwrap_or(default).to_string()
    }

    pub fn require_u64(&self, name: &str) -> Result<u64, CliError> {
        let raw = self
            .raw(name)
            .ok_or_else(|| CliError::new(format!("option --{name} manquante")))?;
        raw.parse::<u64>().map_err(|_| {
            CliError::new(format!(
                "--{name} doit être un entier positif, reçu « {raw} »"
            ))
        })
    }

    pub fn require_u32(&self, name: &str) -> Result<u32, CliError> {
        let raw = self
            .raw(name)
            .ok_or_else(|| CliError::new(format!("option --{name} manquante")))?;
        raw.parse::<u32>().map_err(|_| {
            CliError::new(format!(
                "--{name} doit être un entier positif, reçu « {raw} »"
            ))
        })
    }

    pub fn u64_or(&self, name: &str, default: u64) -> Result<u64, CliError> {
        match self.raw(name) {
            None => Ok(default),
            Some(raw) => raw.parse::<u64>().map_err(|_| {
                CliError::new(format!(
                    "--{name} doit être un entier positif, reçu « {raw} »"
                ))
            }),
        }
    }
}
