//! Hôte natif de plusieurs colonies. L'horloge et le transport restent chez
//! l'appelant ; chaque requête décrit explicitement les ticks à exécuter.
//! Aucun état du sim n'est dupliqué dans Node.
use std::collections::BTreeMap;
use std::io::{self, Read, Write};

use base64::{Engine as _, engine::general_purpose::STANDARD};
use serde::{Deserialize, Serialize};
use sim::{Biome, Command, Sim};

pub const PROTOCOL_VERSION: u32 = 1;
pub const MAX_FRAME_BYTES: usize = 16 * 1024 * 1024;
pub const MAX_SNAPSHOT_BYTES: usize = 8 * 1024 * 1024;
pub const MAX_MAPS: usize = 128;
pub const MAX_TICKS: usize = 6_000;
pub const MAX_COMMANDS: usize = 8_192;
pub const MAX_COMMAND_BYTES: usize = 65_536;
pub const MAX_SIDE: u32 = 192;
pub const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;

#[derive(Debug, Deserialize)]
#[serde(deny_unknown_fields)]
pub struct Request {
    pub id: u64,
    pub request: Operation,
}

#[derive(Debug, Deserialize)]
#[serde(tag = "op", rename_all = "snake_case", deny_unknown_fields)]
pub enum Operation {
    Ping,
    Create {
        map: String,
        seed: u64,
        width: u32,
        height: u32,
        biome: u8,
        day_scale: u32,
    },
    Restore {
        map: String,
        data: String,
    },
    Step {
        map: String,
        expected_tick: u64,
        frames: Vec<Vec<String>>,
    },
    Inspect {
        map: String,
    },
    Snapshot {
        map: String,
    },
    Remove {
        map: String,
    },
    Shutdown,
}

#[derive(Debug, Serialize)]
pub struct Response {
    pub id: Option<u64>,
    #[serde(flatten)]
    pub outcome: Outcome,
}

#[derive(Debug, Serialize)]
#[serde(untagged)]
pub enum Outcome {
    Ok { ok: bool, result: serde_json::Value },
    Error { ok: bool, error: HostError },
}

#[derive(Debug, Serialize, PartialEq, Eq)]
pub struct HostError {
    pub code: &'static str,
    pub message: String,
}
impl HostError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}
type Result<T> = std::result::Result<T, HostError>;

#[derive(Default)]
pub struct Host {
    maps: BTreeMap<String, Sim>,
}

fn invalid(message: impl Into<String>) -> HostError {
    HostError::new("invalid_request", message)
}

fn decode(data: &str, max: usize) -> Result<Vec<u8>> {
    if data.len() > max.div_ceil(3) * 4 {
        return Err(invalid("tampon encodé trop grand"));
    }
    let bytes = STANDARD
        .decode(data)
        .map_err(|_| HostError::new("decode_failed", "base64 invalide"))?;
    if bytes.len() > max {
        return Err(invalid("tampon décodé trop grand"));
    }
    Ok(bytes)
}

fn inspect(sim: &Sim) -> serde_json::Value {
    serde_json::json!({
        "tick": sim.tick(), "width": sim.map().width(), "height": sim.map().height(),
        "day_scale": sim.day_scale(), "hash": format!("{:016x}", sim.state_hash()),
        "snapshot_bytes": sim.snapshot().len(),
        "colonists": sim.pawns().iter().filter(|p| p.is_alive() && p.is_colonist()).count(),
        "raid_status": sim.raid_status(),
    })
}

impl Host {
    fn vacant(&self, map: &str) -> Result<()> {
        if map.is_empty() || map.len() > 128 || map.chars().any(char::is_control) {
            return Err(invalid("identifiant de carte invalide"));
        }
        if self.maps.contains_key(map) {
            return Err(HostError::new("already_exists", "carte déjà chargée"));
        }
        if self.maps.len() >= MAX_MAPS {
            return Err(HostError::new("capacity", "capacité de cartes atteinte"));
        }
        Ok(())
    }

    fn sim(&self, map: &str) -> Result<&Sim> {
        self.maps
            .get(map)
            .ok_or_else(|| HostError::new("not_found", "carte inconnue"))
    }

    pub fn execute(&mut self, operation: Operation) -> Result<serde_json::Value> {
        match operation {
            Operation::Ping => Ok(serde_json::json!({
                "protocol": PROTOCOL_VERSION, "maps": self.maps.len(), "max_maps": MAX_MAPS,
                "max_ticks": MAX_TICKS, "max_frame_bytes": MAX_FRAME_BYTES,
            })),
            Operation::Create {
                map,
                seed,
                width,
                height,
                biome,
                day_scale,
            } => {
                self.vacant(&map)?;
                if !(8..=MAX_SIDE).contains(&width) || !(8..=MAX_SIDE).contains(&height) {
                    return Err(invalid("dimensions attendues : 8 à 192 cases"));
                }
                if biome > 9
                    || !(sim::DAY_SCALE_MIN..=sim::DAY_SCALE_MAX).contains(&day_scale)
                    || seed > MAX_SAFE_INTEGER
                {
                    return Err(invalid("biome, échelle ou graine hors bornes"));
                }
                let sim = Sim::new_scaled(seed, width, height, Biome::from_u8(biome), day_scale);
                let state = inspect(&sim);
                self.maps.insert(map, sim);
                Ok(state)
            }
            Operation::Restore { map, data } => {
                self.vacant(&map)?;
                let bytes = decode(&data, MAX_SNAPSHOT_BYTES)?;
                let (sim, remainder) = postcard::take_from_bytes::<Sim>(&bytes)
                    .map_err(|_| HostError::new("decode_failed", "snapshot invalide"))?;
                if !remainder.is_empty() {
                    return Err(HostError::new("decode_failed", "octets après le snapshot"));
                }
                if !(8..=MAX_SIDE).contains(&sim.map().width())
                    || !(8..=MAX_SIDE).contains(&sim.map().height())
                    || sim.tick() > MAX_SAFE_INTEGER
                {
                    return Err(invalid("snapshot hors bornes"));
                }
                let state = inspect(&sim);
                self.maps.insert(map, sim);
                Ok(state)
            }
            Operation::Step {
                map,
                expected_tick,
                frames,
            } => {
                let current = self.sim(&map)?.tick();
                if current != expected_tick {
                    return Err(HostError::new(
                        "tick_mismatch",
                        format!("tick attendu {expected_tick}, réel {current}"),
                    ));
                }
                if frames.is_empty()
                    || frames.len() > MAX_TICKS
                    || frames.iter().map(Vec::len).sum::<usize>() > MAX_COMMANDS
                    || current > MAX_SAFE_INTEGER - MAX_TICKS as u64
                {
                    return Err(invalid("lot de ticks hors bornes"));
                }
                // Décoder TOUT le lot avant le premier pas. Une commande
                // corrompue en fin de lot ne doit jamais appliquer le début.
                let commands: Vec<Vec<Command>> = frames
                    .into_iter()
                    .map(|frame| {
                        frame
                            .into_iter()
                            .map(|data| {
                                let bytes = decode(&data, MAX_COMMAND_BYTES)?;
                                let (command, rest) = postcard::take_from_bytes::<Command>(&bytes)
                                    .map_err(|_| {
                                        HostError::new(
                                            "invalid_command",
                                            "commande postcard invalide",
                                        )
                                    })?;
                                if !rest.is_empty() {
                                    return Err(HostError::new(
                                        "invalid_command",
                                        "octets après une commande",
                                    ));
                                }
                                Ok(command)
                            })
                            .collect::<Result<Vec<_>>>()
                    })
                    .collect::<Result<Vec<_>>>()?;
                let advance =
                    commands
                        .iter()
                        .flatten()
                        .fold(commands.len() as u64, |total, command| {
                            total.saturating_add(match command {
                                Command::FastForward { ticks } => u64::from(*ticks),
                                _ => 0,
                            })
                        });
                if current.saturating_add(advance) > MAX_SAFE_INTEGER {
                    return Err(invalid("tick hors précision JavaScript"));
                }
                let sim = self
                    .maps
                    .get_mut(&map)
                    .expect("carte vérifiée avant décodage");
                for frame in commands {
                    sim.step(&frame);
                }
                Ok(serde_json::json!({ "tick": sim.tick() }))
            }
            Operation::Inspect { map } => Ok(inspect(self.sim(&map)?)),
            Operation::Snapshot { map } => {
                let sim = self.sim(&map)?;
                let bytes = sim.snapshot();
                if bytes.len() > MAX_SNAPSHOT_BYTES {
                    return Err(invalid("snapshot trop grand"));
                }
                Ok(serde_json::json!({ "tick": sim.tick(), "data": STANDARD.encode(bytes) }))
            }
            Operation::Remove { map } => {
                Ok(serde_json::json!({ "removed": self.maps.remove(&map).is_some() }))
            }
            Operation::Shutdown => Ok(serde_json::json!({ "shutdown": true })),
        }
    }
}

/// Préfixe de longueur u32 big-endian, puis UTF-8 JSON. Une trame trop grande
/// ou tronquée ferme le canal : aucune tentative de resynchronisation ambiguë.
pub fn read_frame(input: &mut impl Read) -> io::Result<Option<Vec<u8>>> {
    let mut header = [0u8; 4];
    loop {
        match input.read(&mut header[..1]) {
            Ok(0) => return Ok(None),
            Ok(_) => break,
            Err(e) if e.kind() == io::ErrorKind::Interrupted => continue,
            Err(e) => return Err(e),
        }
    }
    input.read_exact(&mut header[1..])?;
    let size = u32::from_be_bytes(header) as usize;
    if size == 0 || size > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "taille de trame hors bornes",
        ));
    }
    let mut bytes = vec![0u8; size];
    input.read_exact(&mut bytes)?;
    Ok(Some(bytes))
}

pub fn write_frame(output: &mut impl Write, response: &Response) -> io::Result<()> {
    let bytes = serde_json::to_vec(response)?;
    if bytes.len() > MAX_FRAME_BYTES {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "réponse trop grande",
        ));
    }
    output.write_all(&(bytes.len() as u32).to_be_bytes())?;
    output.write_all(&bytes)?;
    output.flush()
}

pub fn serve(input: &mut impl Read, output: &mut impl Write) -> io::Result<()> {
    let mut host = Host::default();
    while let Some(bytes) = read_frame(input)? {
        let (id, result, shutdown) = match serde_json::from_slice::<Request>(&bytes) {
            Ok(request) => {
                let shutdown = matches!(request.request, Operation::Shutdown);
                (Some(request.id), host.execute(request.request), shutdown)
            }
            Err(_) => (None, Err(invalid("requête JSON invalide")), false),
        };
        let outcome = match result {
            Ok(result) => Outcome::Ok { ok: true, result },
            Err(error) => Outcome::Error { ok: false, error },
        };
        write_frame(output, &Response { id, outcome })?;
        if shutdown {
            return Ok(());
        }
    }
    Ok(())
}
