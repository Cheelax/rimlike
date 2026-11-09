use base64::{Engine as _, engine::general_purpose::STANDARD};
use sim::{Command, Difficulty};
use sim_host::{Host, MAX_FRAME_BYTES, MAX_TICKS, Operation, read_frame, serve};
use std::io::{Cursor, Read};

fn create(map: &str) -> Operation {
    Operation::Create {
        map: map.into(),
        seed: 1,
        width: 32,
        height: 32,
        biome: 4,
        day_scale: 30,
    }
}
fn inspect(host: &mut Host, map: &str) -> serde_json::Value {
    host.execute(Operation::Inspect { map: map.into() })
        .unwrap()
}
fn encoded(command: &Command) -> String {
    STANDARD.encode(postcard::to_allocvec(command).unwrap())
}

#[test]
fn deux_cartes_sont_independantes_et_deterministes() {
    let mut host = Host::default();
    let a = host.execute(create("a")).unwrap();
    let b = host.execute(create("b")).unwrap();
    assert_eq!(a, b);
    let frames = vec![
        vec![encoded(&Command::SetDifficulty {
            level: Difficulty::Hard
        })];
        30
    ];
    host.execute(Operation::Step {
        map: "a".into(),
        expected_tick: 0,
        frames: frames.clone(),
    })
    .unwrap();
    assert_eq!(inspect(&mut host, "b"), b);
    host.execute(Operation::Step {
        map: "b".into(),
        expected_tick: 0,
        frames,
    })
    .unwrap();
    assert_eq!(inspect(&mut host, "a"), inspect(&mut host, "b"));
}

#[test]
fn le_mauvais_tick_et_une_commande_tardive_invalide_ne_modifient_rien() {
    let mut host = Host::default();
    let before = host.execute(create("a")).unwrap();
    let error = host
        .execute(Operation::Step {
            map: "a".into(),
            expected_tick: 9,
            frames: vec![vec![]],
        })
        .unwrap_err();
    assert_eq!(error.code, "tick_mismatch");
    let good = encoded(&Command::SetDifficulty {
        level: Difficulty::Hard,
    });
    let error = host
        .execute(Operation::Step {
            map: "a".into(),
            expected_tick: 0,
            frames: vec![vec![good], vec![STANDARD.encode([255])]],
        })
        .unwrap_err();
    assert_eq!(error.code, "invalid_command");
    assert_eq!(inspect(&mut host, "a"), before);
}

#[test]
fn les_octets_apres_une_commande_sont_refuses() {
    let mut host = Host::default();
    host.execute(create("a")).unwrap();
    let mut bytes = postcard::to_allocvec(&Command::Nop).unwrap();
    bytes.push(0);
    assert_eq!(
        host.execute(Operation::Step {
            map: "a".into(),
            expected_tick: 0,
            frames: vec![vec![STANDARD.encode(bytes)]],
        })
        .unwrap_err()
        .code,
        "invalid_command"
    );
    assert_eq!(inspect(&mut host, "a")["tick"], 0);
}

#[test]
fn sauvegarder_restaurer_et_reprendre_garde_le_hash() {
    let mut host = Host::default();
    host.execute(create("a")).unwrap();
    host.execute(Operation::Step {
        map: "a".into(),
        expected_tick: 0,
        frames: vec![vec![]; 2_000],
    })
    .unwrap();
    let snapshot = host
        .execute(Operation::Snapshot { map: "a".into() })
        .unwrap();
    let restored = host
        .execute(Operation::Restore {
            map: "b".into(),
            data: snapshot["data"].as_str().unwrap().into(),
        })
        .unwrap();
    assert_eq!(restored, inspect(&mut host, "a"));
    for map in ["a", "b"] {
        host.execute(Operation::Step {
            map: map.into(),
            expected_tick: 2_000,
            frames: vec![vec![]; 1_000],
        })
        .unwrap();
    }
    assert_eq!(inspect(&mut host, "a"), inspect(&mut host, "b"));
}

#[test]
fn la_restauration_native_rejoue_un_raid_sauvegarde() {
    let mut host = Host::default();
    let state = host
        .execute(Operation::Restore {
            map: "raid".into(),
            data: STANDARD.encode(include_bytes!("../../sim/tests/fixtures/raid-hold.bin")),
        })
        .unwrap();
    assert_eq!(state["raid_status"][0], 1);
    host.execute(Operation::Step {
        map: "raid".into(),
        expected_tick: state["tick"].as_u64().unwrap(),
        frames: vec![vec![]; 1_200],
    })
    .unwrap();
    assert_eq!(
        inspect(&mut host, "raid")["hash"],
        include_str!("../../sim/tests/fixtures/raid-hold.hash").trim()
    );
}

#[test]
fn les_limites_sont_explicites_et_une_carte_existante_ne_se_remplace_pas() {
    let mut host = Host::default();
    host.execute(create("a")).unwrap();
    assert_eq!(
        host.execute(create("a")).unwrap_err().code,
        "already_exists"
    );
    assert_eq!(
        host.execute(Operation::Inspect {
            map: "inconnue".into()
        })
        .unwrap_err()
        .code,
        "not_found"
    );
    assert_eq!(
        host.execute(Operation::Step {
            map: "a".into(),
            expected_tick: 0,
            frames: vec![vec![]; MAX_TICKS + 1]
        })
        .unwrap_err()
        .code,
        "invalid_request"
    );
    assert_eq!(
        host.execute(Operation::Restore {
            map: "b".into(),
            data: "pas du base64".into()
        })
        .unwrap_err()
        .code,
        "decode_failed"
    );
    assert!(
        host.execute(Operation::Create {
            map: "b".into(),
            seed: 1,
            width: 0,
            height: 32,
            biome: 4,
            day_scale: 30
        })
        .is_err()
    );
    assert!(
        host.execute(Operation::Create {
            map: "b".into(),
            seed: 1,
            width: 32,
            height: 32,
            biome: 42,
            day_scale: 30
        })
        .is_err()
    );
    assert!(
        host.execute(Operation::Create {
            map: "b".into(),
            seed: 1,
            width: 32,
            height: 32,
            biome: 4,
            day_scale: 0
        })
        .is_err()
    );
    assert_eq!(
        host.execute(Operation::Remove { map: "a".into() }).unwrap()["removed"],
        true
    );
    assert_eq!(
        host.execute(Operation::Remove { map: "a".into() }).unwrap()["removed"],
        false
    );
    host.execute(create("a")).unwrap();
}

fn frame(bytes: &[u8]) -> Vec<u8> {
    let mut out = (bytes.len() as u32).to_be_bytes().to_vec();
    out.extend_from_slice(bytes);
    out
}

struct Fragmented(Cursor<Vec<u8>>);
impl Read for Fragmented {
    fn read(&mut self, into: &mut [u8]) -> std::io::Result<usize> {
        let n = into.len().min(1);
        self.0.read(&mut into[..n])
    }
}

#[test]
fn le_transport_accepte_des_fragments_et_plusieurs_requetes_d_affilee() {
    let mut input = frame(br#"{"id":1,"request":{"op":"ping"}}"#);
    input.extend(frame(b"invalid json"));
    input.extend(frame(br#"{"id":2,"request":{"op":"shutdown"}}"#));
    let mut output = Vec::new();
    serve(&mut Fragmented(Cursor::new(input)), &mut output).unwrap();
    let mut reader = Cursor::new(output);
    let first: serde_json::Value =
        serde_json::from_slice(&read_frame(&mut reader).unwrap().unwrap()).unwrap();
    assert_eq!(first["id"], 1);
    assert_eq!(first["result"]["protocol"], 1);
    let invalid: serde_json::Value =
        serde_json::from_slice(&read_frame(&mut reader).unwrap().unwrap()).unwrap();
    assert_eq!(invalid["ok"], false);
    assert!(invalid["id"].is_null());
    let last: serde_json::Value =
        serde_json::from_slice(&read_frame(&mut reader).unwrap().unwrap()).unwrap();
    assert_eq!(last["id"], 2);
    assert_eq!(last["result"]["shutdown"], true);
    assert!(read_frame(&mut reader).unwrap().is_none());
}

#[test]
fn une_trame_tronquee_ou_surdimensionnee_ferme_le_canal() {
    for bytes in [
        vec![0, 1],
        frame(b"test")[..6].to_vec(),
        ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec(),
        vec![0; 4],
    ] {
        assert!(read_frame(&mut Cursor::new(bytes)).is_err());
    }
    assert!(read_frame(&mut Cursor::new(Vec::new())).unwrap().is_none());
}
