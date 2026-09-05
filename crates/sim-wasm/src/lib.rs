//! API minimale exposée au navigateur. Tout ce qui est ici doit rester
//! trivial : la logique vit dans `sim`, testée en natif.

use sim::{BuildKind, Designation, Difficulty, Faction, ItemKind, Job, Material, WorkType, Zone};
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
/// type de travail (`sim::WORK_TYPES`, 7 depuis la recherche : 8 entiers).
pub const PRIORITY_STRIDE: usize = 1 + sim::WORK_TYPES;
/// Entiers par colon dans le tampon des compétences : id, puis (niveau, xp)
/// par type de travail (`sim::WORK_TYPES`, 7 depuis la recherche : 15 entiers).
pub const SKILL_STRIDE: usize = 1 + 2 * sim::WORK_TYPES;
/// Entiers par pawn dans le tampon de santé : id, sang, conscience %,
/// nombre de blessures. Toutes factions confondues, comme `pawns()`.
pub const HEALTH_STRIDE: usize = 4;
/// Entiers par bête dans le tampon de la faune : id, espèce (`sim::Species`),
/// chassée (0/1). Le tampon des pawns ne bouge pas (`PAWN_STRIDE` = 12) : la
/// faction 2 y suffit à distinguer un animal, celui-ci dit lequel.
pub const ANIMAL_STRIDE: usize = 3;

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

/// Assemble une commande de départ de caravane. Les genres et les quantités
/// arrivent en deux tampons parallèles (JS n'a pas de tuple) : ils sont
/// appariés dans l'ordre et tronqués à la plus courte des deux longueurs.
fn form_caravan_command(pawn_ids: &[u32], item_kinds: &[u8], item_counts: &[u32]) -> sim::Command {
    let items = item_kinds
        .iter()
        .zip(item_counts.iter())
        .map(|(&kind, &count)| (ItemKind::from_u8(kind), count))
        .collect();
    sim::Command::FormCaravan {
        pawns: pawn_ids.to_vec(),
        items,
    }
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
    animal_buffer: Vec<i32>,
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

    /// `kind` : 0 mur, 1 porte, 2 sol, 3 lit, 4 feu, 5 poste de fabrication,
    /// 6 tombe, 7 établi de recherche, 8 piège à pointes (5 bois, franchissable,
    /// blesse le premier hostile qui marche dessus).
    /// `material` : 0 bois, 1 pierre. Certains genres imposent le leur (pierre
    /// pour la tombe, bois pour le reste) : le matériau donné est alors ignoré.
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

    /// Fait partir une caravane. `item_kinds` suit `sim::ItemKind`, apparié
    /// avec `item_counts`.
    pub fn form_caravan(&mut self, pawn_ids: &[u32], item_kinds: &[u8], item_counts: &[u32]) {
        self.pending
            .push(form_caravan_command(pawn_ids, item_kinds, item_counts));
    }

    /// Retire les `count` premiers manifestes de la file des départs, une fois
    /// qu'ils sont partis chez le serveur monde.
    pub fn clear_departures(&mut self, count: u32) {
        self.pending.push(sim::Command::ClearDepartures { count });
    }

    /// Fait entrer un manifeste sur cette carte.
    pub fn arrive_caravan(&mut self, manifest: &[u8]) {
        self.pending.push(sim::Command::ArriveCaravan {
            manifest: manifest.to_vec(),
        });
    }

    /// Règle l'objectif de fabrication d'un genre. `kind` suit `sim::ItemKind`
    /// (6 gourdin, 7 épieu, 8 arc) ; un genre sans recette est ignoré par le
    /// sim. Les colons fabriquent tant que la colonie en a moins que `target`.
    pub fn set_craft_target(&mut self, kind: u8, target: u32) {
        self.pending.push(sim::Command::SetCraftTarget {
            kind: ItemKind::from_u8(kind),
            target,
        });
    }

    /// Rattrape le temps passé carte gelée (voir `sim::fastforward`).
    /// Émise une seule fois par l'hôte à la réouverture d'une colonie, avec le
    /// `frozenTicks` du `snapshot` reçu du serveur.
    pub fn fast_forward(&mut self, ticks: u32) {
        self.pending.push(sim::Command::FastForward { ticks });
    }

    /// Impose le climat de la carte : moyenne annuelle et écart saisonnier, en
    /// **dixièmes de degré** (120 et 150 = 12 °C ± 15 °C, le tempéré par
    /// défaut). C'est ainsi qu'une salle du globe reçoit le climat de sa case,
    /// sans changer la construction de la carte.
    pub fn set_climate(&mut self, base_temperature: i32, amplitude: i32) {
        self.pending.push(sim::Command::SetClimate {
            base_temperature,
            amplitude,
        });
    }

    /// Marque (`on`) ou démarque un animal comme gibier. La chasse se désigne
    /// **par bête**, pas par rectangle : le client passe l'id lu dans le
    /// tampon `animals`. Un id qui n'est pas celui d'un animal vivant est
    /// ignoré par le sim.
    pub fn hunt(&mut self, animal: u32, on: bool) {
        self.pending.push(sim::Command::Hunt { animal, on });
    }

    /// Règle la dose de menace du storyteller, suivant `sim::Difficulty`
    /// (0 paisible, 1 facile, 2 normal, 3 difficile). Une valeur inconnue
    /// vaut « normal ». En paisible, le storyteller n'envoie plus de raid.
    pub fn set_difficulty(&mut self, level: u8) {
        self.pending.push(sim::Command::SetDifficulty {
            level: Difficulty::from_u8(level),
        });
    }

    /// Impose le jour de l'année (`sim::climate::YEAR_DAYS` = 60), sans
    /// toucher au tick ni à l'heure du jour : `day_of_year()` vaudra la valeur
    /// donnée, modulo. C'est ainsi que le serveur monde impose le calendrier
    /// d'une colonie neuve, comme il impose son climat (`set_climate`).
    pub fn set_calendar(&mut self, day_of_year: u32) {
        self.pending.push(sim::Command::SetCalendar { day_of_year });
    }

    /// Troque avec le marchand présent : `give_count` unités de `give`,
    /// prélevées en stockage, contre `take_count` unités de `take`, posées au
    /// sol près de lui. Les genres suivent `sim::ItemKind`. Le sim ignore la
    /// commande si le marchand est parti, si le compte n'y est pas d'un côté
    /// ou de l'autre, ou si ce qu'on donne vaut moins que ce qu'on prend
    /// (`trader_offers`, `buy_prices`).
    pub fn trade(&mut self, give: u8, give_count: u32, take: u8, take_count: u32) {
        self.pending.push(sim::Command::Trade {
            give: ItemKind::from_u8(give),
            give_count,
            take: ItemKind::from_u8(take),
            take_count,
        });
    }

    /// Fait venir un marchand tout de suite (débogage, comme `trigger_raid`).
    pub fn trigger_trader_visit(&mut self) {
        self.pending.push(sim::Command::TriggerTraderVisit);
    }

    /// Choisit la technologie cherchée, suivant `sim::Tech` (0 agriculture,
    /// 1 médecine, 2 conservation, 3 archerie, 4 maçonnerie), ou 255 pour ne
    /// plus rien chercher. Le sim ignore un numéro inconnu ou une technologie
    /// déjà acquise. Les colons ne cherchent que s'il existe un établi
    /// (`BuildKind::ResearchBench` = 7).
    pub fn set_research(&mut self, tech: u8) {
        self.pending.push(sim::Command::SetResearch { tech });
    }

    /// Met le feu à une case (débogage, futur outil du joueur). Sans effet si
    /// la case est hors carte, si elle brûle déjà ou si elle ne porte aucun
    /// combustible : arbre, buisson, plant, bois bâti, plancher, herbe sèche
    /// par temps chaud, ou pile inflammable (tout sauf la pierre).
    pub fn ignite(&mut self, x: u32, y: u32) {
        self.pending.push(sim::Command::Ignite { x, y });
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

    /// `kind` : 0 mur, 1 porte, 2 sol, 3 lit, 4 feu, 5 poste de fabrication,
    /// 6 tombe, 7 établi de recherche, 8 piège à pointes (5 bois, franchissable,
    /// blesse le premier hostile qui marche dessus).
    /// `material` : 0 bois, 1 pierre. Certains genres imposent le leur (pierre
    /// pour la tombe, bois pour le reste) : le matériau donné est alors ignoré.
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

    /// Départ d'une caravane. `item_kinds` suit `sim::ItemKind`, apparié avec
    /// `item_counts` dans l'ordre.
    pub fn encode_form_caravan(
        pawn_ids: &[u32],
        item_kinds: &[u8],
        item_counts: &[u32],
    ) -> Vec<u8> {
        encode(&form_caravan_command(pawn_ids, item_kinds, item_counts))
    }

    /// Vidange de la file des départs, à émettre après avoir expédié les
    /// manifestes : tous les clients de la salle l'appliquent au même tick.
    pub fn encode_clear_departures(count: u32) -> Vec<u8> {
        encode(&sim::Command::ClearDepartures { count })
    }

    /// Arrivée d'une caravane. Le manifeste voyage **dans** la commande.
    pub fn encode_arrive_caravan(manifest: &[u8]) -> Vec<u8> {
        encode(&sim::Command::ArriveCaravan {
            manifest: manifest.to_vec(),
        })
    }

    /// Avance rapide abstraite d'une carte gelée, en ticks. Bornée à
    /// 60 jours côté sim ; le client émet le `frozenTicks` du `snapshot`.
    pub fn encode_fast_forward(ticks: u32) -> Vec<u8> {
        encode(&sim::Command::FastForward { ticks })
    }

    /// Objectif de fabrication. `kind` suit `sim::ItemKind` (6 gourdin,
    /// 7 épieu, 8 arc).
    pub fn encode_set_craft_target(kind: u8, target: u32) -> Vec<u8> {
        encode(&sim::Command::SetCraftTarget {
            kind: ItemKind::from_u8(kind),
            target,
        })
    }

    /// Climat de la carte, en dixièmes de degré. Voir `set_climate`.
    pub fn encode_set_climate(base_temperature: i32, amplitude: i32) -> Vec<u8> {
        encode(&sim::Command::SetClimate {
            base_temperature,
            amplitude,
        })
    }

    /// Ordre de chasse sur une bête. Voir `hunt`.
    pub fn encode_hunt(animal: u32, on: bool) -> Vec<u8> {
        encode(&sim::Command::Hunt { animal, on })
    }

    /// Dose de menace du storyteller. Voir `set_difficulty`.
    pub fn encode_set_difficulty(level: u8) -> Vec<u8> {
        encode(&sim::Command::SetDifficulty {
            level: Difficulty::from_u8(level),
        })
    }

    /// Jour de l'année imposé. Voir `set_calendar`.
    pub fn encode_set_calendar(day_of_year: u32) -> Vec<u8> {
        encode(&sim::Command::SetCalendar { day_of_year })
    }

    /// Troc avec le marchand de passage. Voir `trade`.
    pub fn encode_trade(give: u8, give_count: u32, take: u8, take_count: u32) -> Vec<u8> {
        encode(&sim::Command::Trade {
            give: ItemKind::from_u8(give),
            give_count,
            take: ItemKind::from_u8(take),
            take_count,
        })
    }

    /// Visite immédiate d'un marchand. Voir `trigger_trader_visit`.
    pub fn encode_trigger_trader_visit() -> Vec<u8> {
        encode(&sim::Command::TriggerTraderVisit)
    }

    /// Technologie cherchée (255 = aucune). Voir `set_research`.
    pub fn encode_set_research(tech: u8) -> Vec<u8> {
        encode(&sim::Command::SetResearch { tech })
    }

    /// Met le feu à une case. Voir `ignite`.
    pub fn encode_ignite(x: u32, y: u32) -> Vec<u8> {
        encode(&sim::Command::Ignite { x, y })
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

    /// Météo courante, suivant `sim::Weather` (0 clair, 1 pluie, 2 orage,
    /// 3 neige).
    pub fn weather(&self) -> u8 {
        self.inner.weather() as u8
    }

    /// Jours d'une année de jeu (quatre saisons).
    pub fn year_days(&self) -> u32 {
        sim::YEAR_DAYS
    }

    /// Jour de l'année courant, dans `0..year_days()`.
    pub fn day_of_year(&self) -> u32 {
        self.inner.day_of_year()
    }

    /// Saison courante, suivant `sim::Season` (0 printemps, 1 été, 2 automne,
    /// 3 hiver).
    pub fn season(&self) -> u8 {
        self.inner.season() as u8
    }

    /// Température extérieure, en **dixièmes de degré** : 120 = 12 °C.
    pub fn outdoor_temperature(&self) -> i32 {
        self.inner.outdoor_temperature()
    }

    /// Température d'une case, en dixièmes de degré : la température
    /// extérieure dehors, plus l'isolation et les feux de la pièce dedans.
    /// Hors carte : la température extérieure.
    pub fn tile_temperature(&self, x: u32, y: u32) -> i32 {
        self.inner.tile_temperature(x, y)
    }

    /// Température ressentie par un pawn, en dixièmes de degré. 0 si l'id est
    /// inconnu.
    pub fn pawn_comfort(&self, id: u32) -> i32 {
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .map_or(0, |p| p.comfort)
    }

    /// Change à chaque recalcul effectif de la couche « intérieur » : le
    /// client rebâtit son rendu des pièces seulement quand ce nombre bouge.
    pub fn indoor_version(&self) -> u32 {
        self.inner.indoor_version()
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

    /// Change à chaque changement d'intensité du feu : le client rebâtit son
    /// rendu des flammes seulement quand ce nombre bouge.
    pub fn fire_version(&self) -> u32 {
        self.inner.map().fire_version()
    }

    /// Cases en feu. À zéro, la couche `fire` est entièrement nulle : le
    /// client n'a rien à dessiner.
    pub fn fire_count(&self) -> u32 {
        self.inner.map().fire_count()
    }

    /// Total rangé en stockage, indexé par `ItemKind`.
    pub fn stored_totals(&self) -> Vec<u32> {
        self.inner.stored_totals().to_vec()
    }

    /// Objectifs de fabrication courants, indexés par `ItemKind`.
    pub fn craft_targets(&self) -> Vec<u32> {
        self.inner.craft_targets().to_vec()
    }

    /// Où en est la recherche : `[current, (avancement, coût, acquise) × n]`,
    /// soit `1 + 3 × sim::Tech::COUNT` entiers, les technologies dans l'ordre
    /// de `sim::Tech`. `current` vaut 255 quand la colonie ne cherche rien ;
    /// `acquise` vaut 0 ou 1.
    pub fn research_state(&self) -> Vec<u32> {
        let state = self.inner.research();
        let mut out = Vec::with_capacity(1 + 3 * sim::Tech::COUNT);
        out.push(u32::from(state.current));
        for tech in sim::Tech::ALL {
            out.push(state.progress_of(tech));
            out.push(tech.cost());
            out.push(u32::from(state.is_done(tech)));
        }
        out
    }

    /// Coût en points d'une technologie ; 0 si le numéro n'en désigne aucune.
    pub fn tech_cost(tech: u8) -> u32 {
        sim::Tech::from_u8(tech).map_or(0, |t| t.cost())
    }

    /// Dose de menace courante, suivant `sim::Difficulty` (0 paisible,
    /// 1 facile, 2 normal, 3 difficile).
    pub fn difficulty(&self) -> u8 {
        self.inner.difficulty() as u8
    }

    /// Richesse de la colonie : ce qui décide de la taille des raids. Valeur
    /// **en cache**, rafraîchie par le sim au plus une fois par 600 ticks : la
    /// lire ne coûte rien et ne change rien à l'état.
    pub fn wealth(&self) -> u32 {
        self.inner.wealth()
    }

    /// Ticks de maladie restants pour un pawn ; 0 s'il va bien ou si l'id est
    /// inconnu. Hors du tampon des pawns comme `pawn_weapon` : `PAWN_STRIDE`
    /// ne bouge pas.
    pub fn pawn_sick(&self, id: u32) -> i32 {
        let tick = self.inner.tick();
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .map_or(0, |p| {
                i32::try_from(p.sick_until.saturating_sub(tick)).unwrap_or(i32::MAX)
            })
    }

    /// Fraîcheur d'une pile, en ‰ restant (1000 à sa création, 0 juste avant
    /// de disparaître) ; −1 si son genre ne périme pas ou si l'id est
    /// inconnu. Hors du tampon des piles : `ITEM_STRIDE` ne bouge pas.
    pub fn item_freshness(&self, id: u32) -> i32 {
        self.inner
            .items()
            .iter()
            .find(|s| s.id == id)
            .map_or(-1, |s| {
                if s.freshness == u32::MAX {
                    -1
                } else {
                    (s.freshness / 1000) as i32
                }
            })
    }

    /// Arme équipée d'un pawn, suivant `sim::ItemKind`. -1 : à mains nues, ou
    /// id inconnu. Hors du tampon des pawns : `PAWN_STRIDE` ne bouge pas.
    pub fn pawn_weapon(&self, id: u32) -> i32 {
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .and_then(|p| p.weapon)
            .map_or(-1, |w| w as i32)
    }

    /// Habit porté par un pawn, suivant `sim::ItemKind` (14 tunique, 15
    /// manteau). -1 : le dos nu, ou id inconnu. Hors du tampon des pawns comme
    /// `pawn_weapon` : `PAWN_STRIDE` ne bouge pas.
    pub fn pawn_apparel(&self, id: u32) -> i32 {
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .and_then(|p| p.apparel)
            .map_or(-1, |a| a as i32)
    }

    /// Compétences de combat d'un pawn : `[niveau mêlée, xp mêlée, niveau tir,
    /// xp tir]`. Vide si l'id est inconnu. Elles ne sont pas dans le tampon des
    /// compétences, qui suit `WorkType` et garde son `SKILL_STRIDE`.
    pub fn pawn_combat_skills(&self, id: u32) -> Vec<i32> {
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .map(|p| {
                vec![
                    i32::from(p.melee.level),
                    p.melee.xp as i32,
                    i32::from(p.ranged.level),
                    p.ranged.xp as i32,
                ]
            })
            .unwrap_or_default()
    }

    /// Traits de caractère d'un pawn, suivant `sim::Trait` (0 à 11). 0, 1 ou
    /// 2 valeurs ; vide si l'id est inconnu ou le pawn n'en a pas (pillards,
    /// bêtes).
    pub fn pawn_traits(&self, id: u32) -> Vec<i32> {
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .map(|p| {
                p.traits
                    .iter()
                    .filter_map(|t| t.map(|t| t as i32))
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Ce qu'un colon pense des autres (voir `sim::social`) :
    /// `[id de l'autre, avis] × n`, **trié par id**, avec un avis dans
    /// -100..=100. Vide si l'id est inconnu, si le pawn n'a d'avis sur
    /// personne, ou s'il n'est pas de la colonie (pillards, bêtes et marchands
    /// n'en ont jamais). Hors du tampon des pawns comme `pawn_traits` :
    /// `PAWN_STRIDE` ne bouge pas.
    pub fn pawn_opinions(&self, id: u32) -> Vec<i32> {
        let Some(p) = self.inner.pawns().iter().find(|p| p.id == id) else {
            return Vec::new();
        };
        let mut sorted: Vec<(u32, i32)> = p.opinions.iter().map(|o| (o.id, o.value)).collect();
        sorted.sort_unstable();
        sorted
            .into_iter()
            .flat_map(|(other, value)| [other as i32, value])
            .collect()
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

    /// Couche « intérieur », un octet par case comme `zones` : 0 dehors,
    /// sinon le numéro de la pièce. Le rendu n'a qu'à tester le zéro.
    pub fn indoor_ptr(&self) -> *const u8 {
        self.inner.map().indoor().as_ptr()
    }

    pub fn indoor_len(&self) -> usize {
        self.inner.map().indoor().len()
    }

    /// Couche « feu », un octet par case comme `zones` : 0 éteint, sinon
    /// l'intensité de 1 à 3 (voir `sim::fire`). Le rendu n'a qu'à tester le
    /// zéro, et ne se rebâtit que quand `fire_version` bouge.
    pub fn fire_ptr(&self) -> *const u8 {
        self.inner.map().fire().as_ptr()
    }

    pub fn fire_len(&self) -> usize {
        self.inner.map().fire().len()
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

    pub fn animal_stride(&self) -> usize {
        ANIMAL_STRIDE
    }

    /// Tampon de la faune : `[id, espèce, chassée]` par bête vivante, dans
    /// l'ordre des pawns. Le rendu y lit quoi dessiner et quoi marquer ; la
    /// position, elle, reste dans le tampon des pawns.
    pub fn animals_ptr(&self) -> *const i32 {
        self.animal_buffer.as_ptr()
    }

    pub fn animals_len(&self) -> usize {
        self.animal_buffer.len()
    }

    /// Espèce d'un pawn, suivant `sim::Species` (0 cerf, 1 lapin, 2 sanglier).
    /// −1 : ce n'est pas un animal, ou l'id est inconnu.
    pub fn pawn_species(&self, id: u32) -> i32 {
        self.inner
            .pawns()
            .iter()
            .find(|p| p.id == id)
            .and_then(|p| p.species)
            .map_or(-1, |s| s as i32)
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

    // --- Caravanes ---

    /// Manifestes en attente d'expédition vers le serveur monde.
    pub fn departures_count(&self) -> u32 {
        self.inner.departures().len() as u32
    }

    /// Copie du manifeste encodé à cet indice, vide si l'indice est hors file.
    /// L'hôte les lit tous, les envoie, puis émet `clear_departures`.
    pub fn departure(&self, index: u32) -> Vec<u8> {
        self.inner
            .departures()
            .get(index as usize)
            .cloned()
            .unwrap_or_default()
    }

    /// Résumé d'un manifeste sans décoder le postcard côté client :
    /// `[nb colons, nb genres, genre0, quantité0, …]`. Vide si les octets ne
    /// sont pas un manifeste lisible.
    pub fn describe_manifest(bytes: &[u8]) -> Vec<i32> {
        let Ok(manifest) = sim::CaravanManifest::decode(bytes) else {
            return Vec::new();
        };
        let mut out = vec![manifest.pawns.len() as i32, manifest.items.len() as i32];
        for &(kind, count) in &manifest.items {
            out.push(kind as i32);
            out.push(count as i32);
        }
        out
    }

    // --- Commerce ---

    /// Id du marchand avec qui on peut traiter, −1 s'il n'y en a pas (parti,
    /// devenu hostile, ou jamais venu). Sa position, son nom et sa santé se
    /// lisent dans les tampons habituels : c'est un pawn de faction 3.
    pub fn trader_present(&self) -> i32 {
        self.inner.trader().map_or(-1, |p| p.id as i32)
    }

    /// Ticks avant que le marchand ne reprenne la route ; 0 s'il n'y en a pas.
    pub fn trader_leaves_in(&self) -> i32 {
        let tick = self.inner.tick();
        self.inner.trader().map_or(0, |p| {
            i32::try_from(p.leaves_at.saturating_sub(tick)).unwrap_or(i32::MAX)
        })
    }

    /// Étal du marchand, à plat : `[genre, quantité, prix unitaire de vente]`
    /// par lot. Vide s'il n'y a personne à qui parler.
    pub fn trader_offers(&self) -> Vec<i32> {
        let mut out = Vec::new();
        for (kind, count, price) in self.inner.trader_offers() {
            out.extend_from_slice(&[kind as i32, count as i32, price as i32]);
        }
        out
    }

    /// Prix unitaire d'achat par genre, indexé par `ItemKind` : ce que la
    /// colonie touche en cédant une unité.
    pub fn buy_prices(&self) -> Vec<u32> {
        self.inner.buy_prices().to_vec()
    }

    /// Nom du colon, du pillard ou du marchand, chaîne vide si l'id est inconnu.
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
            animal_buffer: Vec::new(),
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
        self.animal_buffer.clear();
        for p in self.inner.pawns() {
            let Some(species) = p.species else {
                continue;
            };
            self.animal_buffer.extend_from_slice(&[
                p.id as i32,
                species as i32,
                i32::from(p.hunted),
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
            (
                WasmSim::encode_form_caravan(&[1, 2], &[0, 2], &[40, 20]),
                Command::FormCaravan {
                    pawns: vec![1, 2],
                    items: vec![(ItemKind::Wood, 40), (ItemKind::Berries, 20)],
                },
            ),
            (
                WasmSim::encode_clear_departures(3),
                Command::ClearDepartures { count: 3 },
            ),
            (
                WasmSim::encode_arrive_caravan(&[7, 8, 9]),
                Command::ArriveCaravan {
                    manifest: vec![7, 8, 9],
                },
            ),
            (
                WasmSim::encode_fast_forward(3_000),
                Command::FastForward { ticks: 3_000 },
            ),
            (
                WasmSim::encode_set_craft_target(ItemKind::Bow as u8, 2),
                Command::SetCraftTarget {
                    kind: ItemKind::Bow,
                    target: 2,
                },
            ),
            (
                WasmSim::encode_set_climate(-80, 220),
                Command::SetClimate {
                    base_temperature: -80,
                    amplitude: 220,
                },
            ),
            (
                WasmSim::encode_hunt(12, true),
                Command::Hunt {
                    animal: 12,
                    on: true,
                },
            ),
            (
                WasmSim::encode_set_difficulty(sim::Difficulty::Hard as u8),
                Command::SetDifficulty {
                    level: sim::Difficulty::Hard,
                },
            ),
            (
                // Un octet qui ne désigne aucune difficulté retombe sur
                // « normal » avant même de partir sur le réseau.
                WasmSim::encode_set_difficulty(200),
                Command::SetDifficulty {
                    level: sim::Difficulty::Normal,
                },
            ),
            (
                WasmSim::encode_set_calendar(45),
                Command::SetCalendar { day_of_year: 45 },
            ),
            (
                WasmSim::encode_trade(ItemKind::Wood as u8, 30, ItemKind::Berries as u8, 10),
                Command::Trade {
                    give: ItemKind::Wood,
                    give_count: 30,
                    take: ItemKind::Berries,
                    take_count: 10,
                },
            ),
            (
                WasmSim::encode_trigger_trader_visit(),
                Command::TriggerTraderVisit,
            ),
            (
                WasmSim::encode_set_research(sim::Tech::Masonry as u8),
                Command::SetResearch {
                    tech: sim::Tech::Masonry as u8,
                },
            ),
            (
                // 255 : « ne cherche plus rien ». L'octet part tel quel, c'est
                // le sim qui décide ce qu'il en fait.
                WasmSim::encode_set_research(255),
                Command::SetResearch { tech: 255 },
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

    /// Contrat de caravane avec le client : la file des départs se lit et se
    /// vide par commande, et `describe_manifest` résume sans décoder postcard.
    #[test]
    fn une_caravane_part_se_resume_et_quitte_la_file() {
        let mut s = fresh();
        s.inner.map_mut().set_zone(2, 2, Zone::Stockpile);
        s.inner.spawn_item(ItemKind::Wood, 30, 2, 2);
        let ids: Vec<u32> = s.inner.pawns().iter().take(1).map(|p| p.id).collect();

        s.form_caravan(&ids, &[ItemKind::Wood as u8], &[20]);
        s.step(1);
        assert_eq!(s.departures_count(), 1);

        let bytes = s.departure(0);
        assert_eq!(
            WasmSim::describe_manifest(&bytes),
            vec![1, 1, ItemKind::Wood as i32, 20],
            "[nb colons, nb genres, genre, quantité]"
        );
        assert!(s.departure(7).is_empty(), "indice hors file");
        assert!(
            WasmSim::describe_manifest(&[0xff, 0xff]).is_empty(),
            "un manifeste illisible ne décrit rien"
        );

        s.clear_departures(1);
        s.step(1);
        assert_eq!(s.departures_count(), 0);
    }

    /// Contrat de recherche avec le client : état lisible, coûts, et les deux
    /// tampons dont la foulée a grandi avec `WorkType::Research`.
    #[test]
    fn les_accesseurs_de_recherche_repondent() {
        let mut s = fresh();
        assert_eq!(PRIORITY_STRIDE, 8, "id + 7 priorités");
        assert_eq!(SKILL_STRIDE, 15, "id + (niveau, xp) × 7");
        assert_eq!(s.priority_stride(), PRIORITY_STRIDE);
        assert_eq!(s.skill_stride(), SKILL_STRIDE);
        let colonists = s
            .inner
            .pawns()
            .iter()
            .filter(|p| p.faction == Faction::Colony)
            .count();
        assert_eq!(s.priorities_len(), colonists * PRIORITY_STRIDE);
        assert_eq!(s.skills_len(), colonists * SKILL_STRIDE);

        let state = s.research_state();
        assert_eq!(state.len(), 1 + 3 * sim::Tech::COUNT);
        assert_eq!(state[0], 255, "on ne cherche rien au départ");
        for (k, tech) in sim::Tech::ALL.iter().enumerate() {
            assert_eq!(state[1 + 3 * k], 0, "avancement de départ");
            assert_eq!(state[2 + 3 * k], tech.cost());
            assert_eq!(state[3 + 3 * k], 0, "rien d'acquis au départ");
            assert_eq!(WasmSim::tech_cost(*tech as u8), tech.cost());
        }
        assert_eq!(WasmSim::tech_cost(200), 0, "numéro inconnu");

        s.set_research(sim::Tech::Medicine as u8);
        s.step(1);
        assert_eq!(s.research_state()[0], sim::Tech::Medicine as u32);
        // Un numéro qui ne désigne rien laisse la recherche en cours.
        s.set_research(42);
        s.step(1);
        assert_eq!(s.research_state()[0], sim::Tech::Medicine as u32);
        s.set_research(255);
        s.step(1);
        assert_eq!(s.research_state()[0], 255, "recherche arrêtée");
    }

    /// Contrat d'armement avec le client : objectifs de fabrication lisibles,
    /// arme équipée et compétences de combat hors des tampons existants.
    #[test]
    fn les_accesseurs_d_armement_repondent() {
        let mut s = fresh();
        assert_eq!(
            s.craft_targets().len(),
            ItemKind::COUNT,
            "un objectif par genre"
        );
        assert!(s.craft_targets().iter().all(|&t| t == 0), "0 au départ");

        s.set_craft_target(ItemKind::Club as u8, 3);
        // Un vêtement a une recette lui aussi : même commande, même tampon.
        s.set_craft_target(ItemKind::Coat as u8, 2);
        // Un genre sans recette est ignoré par le sim.
        s.set_craft_target(ItemKind::Stone as u8, 9);
        s.step(1);
        assert_eq!(s.craft_targets()[ItemKind::Club as usize], 3);
        assert_eq!(s.craft_targets()[ItemKind::Coat as usize], 2);
        assert_eq!(s.craft_targets()[ItemKind::Stone as usize], 0);

        let id = s.inner.pawns()[0].id;
        assert_eq!(s.pawn_weapon(id), -1, "un colon démarre à mains nues");
        s.inner.pawn_mut(id).expect("le colon existe").weapon = Some(ItemKind::Spear);
        assert_eq!(s.pawn_weapon(id), ItemKind::Spear as i32);
        assert_eq!(s.pawn_weapon(9999), -1, "id inconnu");

        assert_eq!(s.pawn_apparel(id), -1, "un colon démarre le dos nu");
        s.inner.pawn_mut(id).expect("le colon existe").apparel = Some(ItemKind::Coat);
        assert_eq!(s.pawn_apparel(id), ItemKind::Coat as i32);
        assert_eq!(s.pawn_apparel(9999), -1, "id inconnu");

        let skills = s.pawn_combat_skills(id);
        assert_eq!(skills.len(), 4, "[niveau mêlée, xp, niveau tir, xp]");
        assert!(
            skills[0] <= 8 && skills[2] <= 8,
            "niveaux de départ : {skills:?}"
        );
        assert!(s.pawn_combat_skills(9999).is_empty());

        // Deux traits au plus, jamais plus : `Sim::spawn_pawn` en tire deux au
        // maximum pour un colon.
        assert!(
            s.pawn_traits(id).len() <= 2,
            "traits : {:?}",
            s.pawn_traits(id)
        );
        s.inner.pawn_mut(id).expect("le colon existe").traits =
            [Some(sim::Trait::Tough), Some(sim::Trait::Sociable)];
        assert_eq!(
            s.pawn_traits(id),
            vec![sim::Trait::Tough as i32, sim::Trait::Sociable as i32]
        );
        assert!(s.pawn_traits(9999).is_empty(), "id inconnu");
    }

    #[test]
    fn les_avis_sortent_tries_par_id() {
        let mut s = fresh();
        let id = s.inner.pawns()[0].id;
        assert!(
            s.pawn_opinions(id).is_empty(),
            "un colon démarre sans avis sur personne"
        );
        // Posés dans le désordre : le tampon doit sortir trié par id.
        s.inner.set_opinion_for_tests(id, 42, -30);
        s.inner.set_opinion_for_tests(id, 7, 60);
        assert_eq!(s.pawn_opinions(id), vec![7, 60, 42, -30]);
        assert!(s.pawn_opinions(9999).is_empty(), "id inconnu");
    }

    #[test]
    fn les_accesseurs_de_climat_repondent() {
        let mut s = fresh();
        assert_eq!(s.year_days(), sim::YEAR_DAYS);
        assert_eq!(s.day_of_year(), 0, "la partie commence au printemps");
        assert_eq!(s.season(), 0);
        assert_eq!(s.indoor_len(), 8 * 8, "un octet par case, comme les zones");
        let version = s.indoor_version();

        // Une clairière plate n'a aucune pièce : tout touche le bord.
        assert!(s.tile_temperature(4, 4) == s.outdoor_temperature());
        assert_eq!(
            s.tile_temperature(9_999, 9_999),
            s.outdoor_temperature(),
            "hors carte : la température extérieure"
        );

        s.set_climate(-300, 0);
        s.step(1);
        assert!(
            s.outdoor_temperature() < -250,
            "climat glacial : {}",
            s.outdoor_temperature()
        );
        let id = s.inner.pawns()[0].id;
        assert_eq!(s.pawn_comfort(id), s.tile_temperature(4, 4));
        assert_eq!(s.pawn_comfort(9_999), 0, "id inconnu");

        // Poser un mur ferme une pièce : la couche change de version.
        for (x, y) in [
            (2, 2),
            (3, 2),
            (4, 2),
            (2, 3),
            (4, 3),
            (2, 4),
            (3, 4),
            (4, 4),
        ] {
            s.inner.map_mut().set_feature(x, y, sim::Feature::WallWood);
        }
        s.step(1);
        assert!(
            s.indoor_version() > version,
            "la couche n'a pas été refaite"
        );
        assert!(s.tile_temperature(3, 3) > s.outdoor_temperature());
    }

    /// `set_calendar` est la frontière JS de `Command::SetCalendar` : le jour
    /// de l'année imposé se retrouve bien dans `day_of_year`/`season`, sans
    /// faire bouger le tick.
    #[test]
    fn set_calendar_impose_le_jour_de_lannee() {
        let mut s = fresh();
        let tick_before = s.tick();
        s.set_calendar(45);
        s.step(1);
        assert_eq!(s.day_of_year(), 45);
        assert_eq!(s.season(), sim::Season::Winter as u8);
        assert_eq!(
            s.tick(),
            tick_before + 1.0,
            "un seul tick, comme sans commande"
        );

        // Une valeur au-delà de `year_days()` retombe dessus par modulo.
        let mut wrapped = fresh();
        wrapped.set_calendar(45 + sim::YEAR_DAYS * 3);
        wrapped.step(1);
        assert_eq!(wrapped.day_of_year(), 45);
    }

    /// Contrat de la faune avec le client : tampon `animals` (stride 3),
    /// espèce par accesseur, et ordre de chasse qui pose le marqueur.
    #[test]
    fn le_tampon_de_la_faune_suit_les_betes() {
        let mut s = fresh();
        assert_eq!(s.animal_stride(), ANIMAL_STRIDE);
        // Une bête posée à la main s'ajoute à celles du départ : on la
        // retrouve par son id, pas par sa place.
        let deer = s.inner.spawn_animal(6, 6, sim::Species::Deer);
        s.step(1);
        assert_eq!(
            s.animals_len(),
            s.inner.animal_count() as usize * ANIMAL_STRIDE,
            "une entrée par bête vivante"
        );
        let row = s
            .animal_buffer
            .chunks(ANIMAL_STRIDE)
            .find(|r| r[0] == deer as i32)
            .expect("le cerf est dans le tampon")
            .to_vec();
        assert_eq!(row[1], sim::Species::Deer as i32);
        assert_eq!(row[2], 0, "pas encore chassée");
        assert_eq!(s.pawn_species(deer), sim::Species::Deer as i32);
        assert_eq!(s.pawn_species(9_999), -1, "id inconnu");
        let colonist = s.inner.pawns()[0].id;
        assert_eq!(s.pawn_species(colonist), -1, "un colon n'a pas d'espèce");
        // Le camp suffit au rendu pour distinguer une bête : faction 2.
        let k = s
            .inner
            .pawns()
            .iter()
            .position(|p| p.id == deer)
            .expect("la bête est dans la liste");
        assert_eq!(s.pawn_buffer[k * PAWN_STRIDE + 10], Faction::Animal as i32);

        s.hunt(deer, true);
        s.step(1);
        let hunted = s
            .animal_buffer
            .chunks(ANIMAL_STRIDE)
            .find(|r| r[0] == deer as i32)
            .map(|r| r[2]);
        assert_eq!(hunted, Some(1), "le marqueur de chasse n'est pas posé");
    }

    /// Contrat de commerce avec le client : marchand repérable, étal et prix
    /// lisibles, troc qui passe par la même file que les autres commandes.
    #[test]
    fn les_accesseurs_de_commerce_repondent() {
        let mut s = fresh();
        assert_eq!(s.trader_present(), -1, "aucun marchand au départ");
        assert_eq!(s.trader_leaves_in(), 0);
        assert!(s.trader_offers().is_empty());
        assert_eq!(
            s.buy_prices().len(),
            ItemKind::COUNT,
            "un prix d'achat par genre"
        );
        assert!(s.buy_prices().iter().all(|&p| p >= 1), "prix nul");

        let id = s
            .inner
            .trigger_trader_visit()
            .expect("un marchand doit pouvoir entrer");
        assert_eq!(s.trader_present(), id as i32);
        assert!(s.trader_leaves_in() > 0);
        let offers = s.trader_offers();
        assert!(!offers.is_empty() && offers.len() % 3 == 0, "{offers:?}");
        // `[genre, quantité, prix]` : le prix de vente suit le barème du sim.
        for lot in offers.chunks(3) {
            let kind = ItemKind::from_u8(lot[0] as u8);
            assert!(lot[1] > 0, "lot vide : {lot:?}");
            assert_eq!(lot[2], sim::value_sell(kind) as i32);
        }
        assert!(!s.pawn_name(id).is_empty(), "le marchand a un nom");

        // Le troc passe par la file d'attente comme le reste : rien avant le tick.
        s.inner.map_mut().set_zone(2, 2, Zone::Stockpile);
        s.inner.spawn_item(ItemKind::Wood, 60, 2, 2);
        let take = ItemKind::from_u8(s.trader_offers()[0] as u8);
        s.trade(ItemKind::Wood as u8, 60, take as u8, 1);
        assert_eq!(s.pending_len(), 1);
        s.step(1);
        assert_eq!(s.pending_len(), 0);
        assert!(
            s.inner.stored_totals()[ItemKind::Wood as usize] < 60,
            "le bois n'est pas parti"
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
