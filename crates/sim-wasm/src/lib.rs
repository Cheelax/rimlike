//! API minimale exposée au navigateur. Tout ce qui est ici doit rester
//! trivial : la logique vit dans `sim`, testée en natif.

use sim::{BuildKind, Designation, Faction, ItemKind, Job, Material, WorkType, Zone};
use wasm_bindgen::prelude::*;

/// Entiers par pawn dans le tampon de rendu :
/// id, x, y, flags, faim ‰, repos ‰, humeur ‰, code de job, genre porté (-1 = rien),
/// quantité portée, camp, PV.
pub const PAWN_STRIDE: usize = 12;
/// Entiers par pile : id, genre, quantité, x, y.
pub const ITEM_STRIDE: usize = 5;
/// Entiers par chantier : id, type, matériau, x, y, livré, requis, avancement.
pub const BLUEPRINT_STRIDE: usize = 8;
/// Entiers par événement : seq, tick, genre, argument.
pub const EVENT_STRIDE: usize = 4;
/// Entiers par colon dans le tampon des priorités : id, puis une priorité par
/// type de travail (`sim::WORK_TYPES`).
pub const PRIORITY_STRIDE: usize = 1 + sim::WORK_TYPES;
/// Entiers par colon dans le tampon des compétences : id, puis (niveau, xp)
/// par type de travail (`sim::WORK_TYPES`).
pub const SKILL_STRIDE: usize = 1 + 2 * sim::WORK_TYPES;
/// Entiers par pawn dans le tampon de santé : id, sang, conscience %,
/// nombre de blessures. Toutes factions confondues, comme `pawns()`.
pub const HEALTH_STRIDE: usize = 4;

const FLAG_MOVING: i32 = 1;
const FLAG_SLEEPING: i32 = 2;
const FLAG_WORKING: i32 = 4;
const FLAG_STARVING: i32 = 8;
const FLAG_CARRYING: i32 = 16;
const FLAG_DOWNED: i32 = 32;

/// Sérialise une commande en postcard. L'échec est impossible : `Command` est
/// une somme de types de taille fixe et le tampon grandit à la demande.
fn encode(command: &sim::Command) -> Vec<u8> {
    postcard::to_allocvec(command).expect("encodage postcard d'une commande")
}

/// Pourquoi des octets venus du réseau n'ont pas donné de commande.
#[derive(Debug)]
enum CommandError {
    /// postcard n'a pas su relire la commande.
    Decode(postcard::Error),
    /// Commande relue, mais suivie d'octets en trop : trame bricolée.
    Trailing(usize),
}

impl core::fmt::Display for CommandError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            CommandError::Decode(e) => write!(f, "décodage postcard : {e}"),
            CommandError::Trailing(n) => write!(f, "{n} octet(s) en trop après la commande"),
        }
    }
}

/// Relit une commande produite par un `encode_*`. Les octets en trop sont
/// refusés : `postcard::from_bytes` les ignore, on veut ici une trame exacte.
///
/// Séparé de `apply_encoded` pour être testable en natif : construire un
/// `JsError` appelle une fonction JS, indisponible hors WASM.
fn decode_command(bytes: &[u8]) -> Result<sim::Command, CommandError> {
    let (command, rest) = postcard::take_from_bytes(bytes).map_err(CommandError::Decode)?;
    if rest.is_empty() {
        Ok(command)
    } else {
        Err(CommandError::Trailing(rest.len()))
    }
}

#[wasm_bindgen]
pub struct WasmSim {
    inner: sim::Sim,
    pending: Vec<sim::Command>,
    pawn_buffer: Vec<i32>,
    item_buffer: Vec<i32>,
    blueprint_buffer: Vec<i32>,
    event_buffer: Vec<i32>,
    priority_buffer: Vec<i32>,
    skill_buffer: Vec<i32>,
    health_buffer: Vec<i32>,
}

#[wasm_bindgen]
impl WasmSim {
    #[wasm_bindgen(constructor)]
    pub fn new(seed: u64, width: u32, height: u32) -> WasmSim {
        console_error_panic_hook::set_once();
        WasmSim::wrap(sim::Sim::new(seed, width, height))
    }

    /// Avance de `n` ticks. Les commandes en attente sont appliquées au premier.
    pub fn step(&mut self, n: u32) {
        if n == 0 {
            return;
        }
        let cmds = core::mem::take(&mut self.pending);
        self.inner.step(&cmds);
        for _ in 1..n {
            self.inner.step(&[]);
        }
        self.refresh_buffers();
    }

    // --- Commandes (appliquées au prochain tick) ---

    pub fn move_to(&mut self, pawn: u32, x: u32, y: u32) {
        self.pending.push(sim::Command::MoveTo { pawn, x, y });
    }

    /// `kind` : 0 annuler, 1 couper, 2 miner, 3 récolter.
    pub fn designate(&mut self, kind: u8, x0: i32, y0: i32, x1: i32, y1: i32) {
        self.pending.push(sim::Command::Designate {
            kind: Designation::from_u8(kind),
            x0,
            y0,
            x1,
            y1,
        });
    }

    /// `zone` : 0 retirer, 1 stockage.
    pub fn set_zone(&mut self, zone: u8, x0: i32, y0: i32, x1: i32, y1: i32) {
        self.pending.push(sim::Command::SetZone {
            zone: Zone::from_u8(zone),
            x0,
            y0,
            x1,
            y1,
        });
    }

    /// `kind` : 0 mur, 1 porte, 2 sol, 3 lit. `material` : 0 bois, 1 pierre.
    pub fn build(&mut self, kind: u8, material: u8, x0: i32, y0: i32, x1: i32, y1: i32) {
        self.pending.push(sim::Command::Build {
            kind: BuildKind::from_u8(kind),
            material: Material::from_u8(material),
            x0,
            y0,
            x1,
            y1,
        });
    }

    pub fn cancel_build(&mut self, x0: i32, y0: i32, x1: i32, y1: i32) {
        self.pending
            .push(sim::Command::CancelBuild { x0, y0, x1, y1 });
    }

    /// Envoie un colon attaquer un ennemi.
    pub fn attack(&mut self, pawn: u32, target: u32) {
        self.pending.push(sim::Command::Attack { pawn, target });
    }

    /// Règle la priorité d'un travail pour un colon. `work` suit
    /// `sim::WorkType`, `priority` va de 1 (haute) à 4 (basse), 0 désactive.
    pub fn set_priority(&mut self, pawn: u32, work: u8, priority: u8) {
        self.pending.push(sim::Command::SetPriority {
            pawn,
            work: WorkType::from_u8(work),
            priority,
        });
    }

    /// Déclenche un raid tout de suite (outil de dev).
    pub fn trigger_raid(&mut self) {
        self.pending.push(sim::Command::TriggerRaid);
    }

    // --- Encodeurs de commandes (lockstep : encoder sans appliquer) ---
    //
    // Fonctions **associées** : le client doit pouvoir encoder avant même
    // d'avoir un sim, et l'encodage ne dépend d'aucun état. Côté JS :
    // `WasmSim.encode_move_to(...)`. Les octets produits sont relayés tels
    // quels par le serveur (qui ne les décode jamais) puis relus par
    // `apply_encoded` chez tous les clients. Une commande nouvelle doit venir
    // avec son `encode_*`, sinon elle est injouable en multi.

    /// Commande vide, pour éprouver le lockstep sans gameplay.
    pub fn encode_nop() -> Vec<u8> {
        encode(&sim::Command::Nop)
    }

    pub fn encode_move_to(pawn: u32, x: u32, y: u32) -> Vec<u8> {
        encode(&sim::Command::MoveTo { pawn, x, y })
    }

    /// `kind` : 0 annuler, 1 couper, 2 miner, 3 récolter.
    pub fn encode_designate(kind: u8, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8> {
        encode(&sim::Command::Designate {
            kind: Designation::from_u8(kind),
            x0,
            y0,
            x1,
            y1,
        })
    }

    /// `zone` : 0 retirer, 1 stockage, 2 culture.
    pub fn encode_set_zone(zone: u8, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8> {
        encode(&sim::Command::SetZone {
            zone: Zone::from_u8(zone),
            x0,
            y0,
            x1,
            y1,
        })
    }

    /// `kind` : 0 mur, 1 porte, 2 sol, 3 lit, 4 feu. `material` : 0 bois, 1 pierre.
    pub fn encode_build(kind: u8, material: u8, x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8> {
        encode(&sim::Command::Build {
            kind: BuildKind::from_u8(kind),
            material: Material::from_u8(material),
            x0,
            y0,
            x1,
            y1,
        })
    }

    pub fn encode_cancel_build(x0: i32, y0: i32, x1: i32, y1: i32) -> Vec<u8> {
        encode(&sim::Command::CancelBuild { x0, y0, x1, y1 })
    }

    pub fn encode_attack(pawn: u32, target: u32) -> Vec<u8> {
        encode(&sim::Command::Attack { pawn, target })
    }

    pub fn encode_trigger_raid() -> Vec<u8> {
        encode(&sim::Command::TriggerRaid)
    }

    /// `work` suit `sim::WorkType`, `priority` : 1 haute … 4 basse, 0 désactivé.
    pub fn encode_set_priority(pawn: u32, work: u8, priority: u8) -> Vec<u8> {
        encode(&sim::Command::SetPriority {
            pawn,
            work: WorkType::from_u8(work),
            priority,
        })
    }

    /// Décode une commande venue du réseau et la met en attente : elle sera
    /// appliquée au prochain `step`, comme celles des méthodes typées.
    ///
    /// C'est la seule frontière où des octets extérieurs entrent dans le sim,
    /// donc la seule qui valide. Des octets identiques donnent la même
    /// commande chez tous les clients (postcard est canonique à schéma égal),
    /// à condition que tout le monde tourne le même binaire WASM.
    pub fn apply_encoded(&mut self, bytes: &[u8]) -> Result<(), JsError> {
        match decode_command(bytes) {
            Ok(command) => {
                self.pending.push(command);
                Ok(())
            }
            Err(e) => Err(JsError::new(&format!(
                "commande illisible ({} octet(s)) : {e}",
                bytes.len()
            ))),
        }
    }

    /// Commandes en attente du prochain `step`.
    pub fn pending_len(&self) -> usize {
        self.pending.len()
    }

    // --- Lecture ---

    pub fn tick(&self) -> f64 {
        self.inner.tick() as f64
    }

    pub fn ticks_per_day(&self) -> u32 {
        sim::TICKS_PER_DAY
    }

    pub fn time_of_day(&self) -> u32 {
        self.inner.time_of_day()
    }

    /// Météo courante, suivant `sim::Weather`.
    pub fn weather(&self) -> u8 {
        self.inner.weather() as u8
    }

    /// Hash d'état en hexadécimal, pour l'affichage et la détection de désync.
    pub fn hash(&self) -> String {
        format!("{:016x}", self.inner.state_hash())
    }

    pub fn snapshot(&self) -> Vec<u8> {
        self.inner.snapshot()
    }

    pub fn restore(bytes: &[u8]) -> Result<WasmSim, JsError> {
        sim::Sim::restore(bytes)
            .map(WasmSim::wrap)
            .map_err(|e| JsError::new(&e.to_string()))
    }

    pub fn width(&self) -> u32 {
        self.inner.map().width()
    }

    pub fn height(&self) -> u32 {
        self.inner.map().height()
    }

    /// Change à chaque modification du sol ou des éléments.
    pub fn map_version(&self) -> u32 {
        self.inner.map().version()
    }

    /// Change à chaque modification des zones ou des désignations.
    pub fn overlay_version(&self) -> u32 {
        self.inner.map().overlay_version()
    }

    /// Total rangé en stockage, indexé par `ItemKind`.
    pub fn stored_totals(&self) -> Vec<u32> {
        self.inner.stored_totals().to_vec()
    }

    // --- Vues mémoire (zéro copie ; à recréer après tout appel au sim) ---

    pub fn tiles_ptr(&self) -> *const u8 {
        self.inner.map().tiles().as_ptr()
    }

    pub fn tiles_len(&self) -> usize {
        self.inner.map().tiles().len()
    }

    pub fn features_ptr(&self) -> *const u8 {
        self.inner.map().features().as_ptr()
    }

    pub fn zones_ptr(&self) -> *const u8 {
        self.inner.map().zones().as_ptr()
    }

    pub fn designations_ptr(&self) -> *const u8 {
        self.inner.map().designations().as_ptr()
    }

    pub fn pawn_stride(&self) -> usize {
        PAWN_STRIDE
    }

    pub fn pawns_ptr(&self) -> *const i32 {
        self.pawn_buffer.as_ptr()
    }

    pub fn pawns_len(&self) -> usize {
        self.pawn_buffer.len()
    }

    pub fn item_stride(&self) -> usize {
        ITEM_STRIDE
    }

    pub fn items_ptr(&self) -> *const i32 {
        self.item_buffer.as_ptr()
    }

    pub fn items_len(&self) -> usize {
        self.item_buffer.len()
    }

    pub fn blueprint_stride(&self) -> usize {
        BLUEPRINT_STRIDE
    }

    pub fn blueprints_ptr(&self) -> *const i32 {
        self.blueprint_buffer.as_ptr()
    }

    pub fn blueprints_len(&self) -> usize {
        self.blueprint_buffer.len()
    }

    pub fn event_stride(&self) -> usize {
        EVENT_STRIDE
    }

    pub fn events_ptr(&self) -> *const i32 {
        self.event_buffer.as_ptr()
    }

    pub fn events_len(&self) -> usize {
        self.event_buffer.len()
    }

    pub fn priority_stride(&self) -> usize {
        PRIORITY_STRIDE
    }

    pub fn priorities_ptr(&self) -> *const i32 {
        self.priority_buffer.as_ptr()
    }

    pub fn priorities_len(&self) -> usize {
        self.priority_buffer.len()
    }

    pub fn skill_stride(&self) -> usize {
        SKILL_STRIDE
    }

    pub fn skills_ptr(&self) -> *const i32 {
        self.skill_buffer.as_ptr()
    }

    pub fn skills_len(&self) -> usize {
        self.skill_buffer.len()
    }

    pub fn health_stride(&self) -> usize {
        HEALTH_STRIDE
    }

    pub fn health_ptr(&self) -> *const i32 {
        self.health_buffer.as_ptr()
    }

    pub fn health_len(&self) -> usize {
        self.health_buffer.len()
    }

    /// Blessures d'un pawn, à plat : `[partie, sévérité, saignement, pansée]`
    /// par blessure. Copie ponctuelle, pour le panneau du colon.
    pub fn pawn_injuries(&self, id: u32) -> Vec<i32> {
        let mut out = Vec::new();
        if let Some(p) = self.inner.pawns().iter().find(|p| p.id == id) {
            for inj in &p.injuries {
                out.extend_from_slice(&[
                    inj.part as i32,
                    inj.severity as i32,
                    inj.bleeding as i32,
                    i32::from(inj.tended),
                ]);
            }
        }
        out
    }

    /// Nom du colon ou du pillard, chaîne vide si l'id est inconnu.
    pub fn pawn_name(&self, id: u32) -> String {
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .map(|p| p.name.clone())
            .unwrap_or_default()
    }
}

impl WasmSim {
    fn wrap(inner: sim::Sim) -> WasmSim {
        let mut s = WasmSim {
            inner,
            pending: Vec::new(),
            pawn_buffer: Vec::new(),
            item_buffer: Vec::new(),
            blueprint_buffer: Vec::new(),
            event_buffer: Vec::new(),
            priority_buffer: Vec::new(),
            skill_buffer: Vec::new(),
            health_buffer: Vec::new(),
        };
        s.refresh_buffers();
        s
    }

    fn refresh_buffers(&mut self) {
        self.pawn_buffer.clear();
        for p in self.inner.pawns() {
            let mut flags = 0;
            if p.is_moving() {
                flags |= FLAG_MOVING;
            }
            if matches!(p.job, Job::Sleep { .. }) && !p.is_moving() {
                flags |= FLAG_SLEEPING;
            }
            if matches!(p.job, Job::Work { .. } | Job::Build { .. }) && !p.is_moving() {
                flags |= FLAG_WORKING;
            }
            if p.is_starving() {
                flags |= FLAG_STARVING;
            }
            if p.carrying.is_some() {
                flags |= FLAG_CARRYING;
            }
            if p.is_downed() {
                flags |= FLAG_DOWNED;
            }
            let (ckind, ccount) = match p.carrying {
                Some((k, n)) => (k as i32, n as i32),
                None => (-1, 0),
            };
            self.pawn_buffer.extend_from_slice(&[
                p.id as i32,
                p.x,
                p.y,
                flags,
                (p.hunger / 1000) as i32,
                (p.rest / 1000) as i32,
                (p.mood() / 1000) as i32,
                p.job.code(),
                ckind,
                ccount,
                p.faction as i32,
                p.hp as i32,
            ]);
        }
        self.item_buffer.clear();
        for s in self.inner.items() {
            self.item_buffer.extend_from_slice(&[
                s.id as i32,
                s.kind as i32,
                s.count as i32,
                s.x as i32,
                s.y as i32,
            ]);
        }
        self.blueprint_buffer.clear();
        for b in self.inner.blueprints() {
            self.blueprint_buffer.extend_from_slice(&[
                b.id as i32,
                b.kind as i32,
                b.material as i32,
                b.x as i32,
                b.y as i32,
                b.delivered as i32,
                b.needed as i32,
                // Le sim compte les avancements en centièmes de tick.
                (b.progress / 100) as i32,
            ]);
        }
        self.priority_buffer.clear();
        for p in self.inner.pawns() {
            if p.faction != Faction::Colony {
                continue;
            }
            self.priority_buffer.push(p.id as i32);
            for &prio in &p.priorities {
                self.priority_buffer.push(i32::from(prio));
            }
        }
        self.event_buffer.clear();
        for e in self.inner.events() {
            self.event_buffer.extend_from_slice(&[
                e.seq as i32,
                e.tick as i32,
                e.kind as i32,
                e.arg as i32,
            ]);
        }
        self.skill_buffer.clear();
        for p in self.inner.pawns() {
            if p.faction != Faction::Colony {
                continue;
            }
            self.skill_buffer.push(p.id as i32);
            for skill in &p.skills {
                self.skill_buffer.push(i32::from(skill.level));
                self.skill_buffer.push(skill.xp as i32);
            }
        }
        self.health_buffer.clear();
        for p in self.inner.pawns() {
            self.health_buffer.extend_from_slice(&[
                p.id as i32,
                p.blood as i32,
                p.consciousness_percent() as i32,
                p.injuries.len() as i32,
            ]);
        }
        let _ = ItemKind::COUNT;
    }
}

/// Tests natifs de la frontière du lockstep : encodage, décodage, mise en
/// attente. Ils tournent avec `cargo test --workspace`, sans navigateur.
#[cfg(test)]
mod tests {
    use super::*;
    use sim::Command;
    use sim::testmap::map_from;

    /// Petite clairière plate : tout est praticable, donc les zones passent.
    fn fresh() -> WasmSim {
        WasmSim::wrap(sim::Sim::from_map(
            1,
            map_from(&[
                "........", "........", "........", "........", "........", "........", "........",
                "........",
            ]),
        ))
    }

    #[test]
    fn les_encodeurs_font_l_aller_retour() {
        let cases: Vec<(Vec<u8>, Command)> = vec![
            (WasmSim::encode_nop(), Command::Nop),
            (
                WasmSim::encode_move_to(3, 12, 34),
                Command::MoveTo {
                    pawn: 3,
                    x: 12,
                    y: 34,
                },
            ),
            (
                WasmSim::encode_designate(1, -2, 0, 5, 7),
                Command::Designate {
                    kind: Designation::Chop,
                    x0: -2,
                    y0: 0,
                    x1: 5,
                    y1: 7,
                },
            ),
            (
                WasmSim::encode_set_zone(2, 1, 2, 3, 4),
                Command::SetZone {
                    zone: Zone::Growing,
                    x0: 1,
                    y0: 2,
                    x1: 3,
                    y1: 4,
                },
            ),
            (
                WasmSim::encode_build(1, 1, 0, 0, 2, 2),
                Command::Build {
                    kind: BuildKind::Door,
                    material: Material::Stone,
                    x0: 0,
                    y0: 0,
                    x1: 2,
                    y1: 2,
                },
            ),
            (
                WasmSim::encode_cancel_build(4, 5, 6, 7),
                Command::CancelBuild {
                    x0: 4,
                    y0: 5,
                    x1: 6,
                    y1: 7,
                },
            ),
            (
                WasmSim::encode_attack(2, 9),
                Command::Attack { pawn: 2, target: 9 },
            ),
            (WasmSim::encode_trigger_raid(), Command::TriggerRaid),
            (
                WasmSim::encode_set_priority(1, 4, 3),
                Command::SetPriority {
                    pawn: 1,
                    work: WorkType::Farm,
                    priority: 3,
                },
            ),
        ];
        for (bytes, expected) in cases {
            assert!(!bytes.is_empty(), "une commande encodée n'est jamais vide");
            assert_eq!(decode_command(&bytes).expect("décodage"), expected);
        }
    }

    #[test]
    fn apply_encoded_met_en_attente_et_step_applique() {
        let mut s = fresh();
        assert_eq!(s.pending_len(), 0);
        assert!(
            s.apply_encoded(&WasmSim::encode_set_zone(1, 4, 4, 6, 6))
                .is_ok()
        );
        assert_eq!(s.pending_len(), 1);
        // Rien n'est appliqué avant le tick.
        assert_eq!(s.inner.map().zone(5, 5), Zone::None);

        s.step(1);
        assert_eq!(s.pending_len(), 0, "`step` vide la file");
        assert_eq!(s.inner.map().zone(5, 5), Zone::Stockpile);
    }

    #[test]
    fn apply_encoded_suit_le_meme_chemin_que_les_methodes_typees() {
        let mut encoded = fresh();
        assert!(
            encoded
                .apply_encoded(&WasmSim::encode_designate(1, 0, 0, 3, 3))
                .is_ok()
        );
        encoded.step(4);

        let mut typed = fresh();
        typed.designate(1, 0, 0, 3, 3);
        typed.step(4);

        assert_eq!(encoded.hash(), typed.hash());
    }

    /// Contrat de santé avec le client : tampon `[id, sang, conscience,
    /// blessures]`, drapeau « à terre », code de job 15, et `hp` dérivé.
    #[test]
    fn le_tampon_de_sante_suit_les_blessures() {
        let mut s = fresh();
        let id = s.inner.pawns()[0].id;
        assert!(s.pawn_injuries(id).is_empty(), "on démarre entier");
        s.inner.inflict_injury(id, sim::BodyPart::LeftLeg, 200);
        s.inner.pawn_mut(id).expect("le colon existe").blood = 250;
        s.step(1);

        // Le tick 0 est un tick de cicatrisation : la sévérité a déjà perdu 1.
        let injuries = s.pawn_injuries(id);
        assert_eq!(injuries.len(), 4, "quatre entiers par blessure");
        assert_eq!(injuries[0], sim::BodyPart::LeftLeg as i32);
        assert_eq!(injuries[1], 199, "sévérité");
        assert_eq!(injuries[2], 50, "saignement = sévérité / 4");
        assert_eq!(injuries[3], 0, "pas encore pansée");

        let k = s
            .inner
            .pawns()
            .iter()
            .position(|p| p.id == id)
            .expect("le colon est dans la liste");
        assert_eq!(s.health_stride(), HEALTH_STRIDE);
        assert_eq!(s.health_len(), s.inner.pawns().len() * HEALTH_STRIDE);
        let h = k * HEALTH_STRIDE;
        assert_eq!(s.health_buffer[h], id as i32);
        assert!(s.health_buffer[h + 1] < 250, "le sang a coulé");
        assert_eq!(s.health_buffer[h + 3], 1, "une blessure");

        let p = k * PAWN_STRIDE;
        assert_ne!(
            s.pawn_buffer[p + 3] & FLAG_DOWNED,
            0,
            "drapeau « à terre » absent"
        );
        assert_eq!(s.pawn_buffer[p + 7], 15, "code du job à terre");
        assert_eq!(
            s.pawn_buffer[p + 11],
            1000 - 199,
            "PV dérivés de la sévérité"
        );
    }

    #[test]
    fn des_octets_invalides_sont_refuses() {
        // Variante inexistante, varint tronqué, tampon vide, octets en trop.
        for bytes in [vec![200], vec![0xff], Vec::new(), vec![0, 0]] {
            assert!(
                decode_command(&bytes).is_err(),
                "octets acceptés à tort : {bytes:?}"
            );
        }
    }
}
