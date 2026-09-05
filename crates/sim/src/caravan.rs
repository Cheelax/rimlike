//! Caravanes : faire sortir un groupe de colons avec des marchandises, et
//! faire entrer ailleurs ce qu'ils emportent.
//!
//! Le voyage lui-même (itinéraire sur le globe, durée en heures, horloge
//! monde) appartient au serveur monde : le sim ne connaît que les deux bouts.
//! Ce qui relie les deux est le **manifeste**, des octets postcard opaques
//! pour le serveur, relayés tels quels comme le sont les commandes.
//!
//! Départ : `Command::FormCaravan` retire les colons de la carte et empile le
//! manifeste encodé dans `Sim::departures`. Cette file fait partie de l'état
//! (sérialisée, hashée) tant qu'elle n'est pas vidée, et elle ne se vide que
//! par `Command::ClearDepartures`, donc en lockstep chez tout le monde.
//!
//! Arrivée : `Command::ArriveCaravan` décode le manifeste, replace les colons
//! avec de **nouveaux ids** (ceux du départ ne survivent pas au voyage) et
//! pose les marchandises au sol. Le voyage étant abstrait dans cette tranche,
//! les dates de péremption des vivres repartent du tick d'arrivée.

use serde::{Deserialize, Serialize};

use crate::fixed::{self, FX_HALF};
use crate::health::{self, BLOOD_MAX, SEVERITY_MAX};
use crate::items::{ItemKind, STACK_MAX};
use crate::map::{Zone, chebyshev};
use crate::pawn::{self, Faction, Job, NEED_MAX, Pawn};
use crate::work;
use crate::{EventKind, Sim, SnapshotError, combat};

/// Version du format de manifeste. Un manifeste d'une autre version est refusé
/// au décodage : mieux vaut ignorer une caravane que faire entrer des colons
/// relus de travers.
pub const MANIFEST_VERSION: u16 = 1;

/// Anneaux explorés autour de la case d'entrée pour poser colons et piles.
const PLACE_RINGS: i32 = 16;
/// Longueur maximale d'un nom qui arrive du réseau.
const MAX_NAME_CHARS: usize = 24;
/// Colons débarqués au plus par manifeste. Une caravane est un groupe, pas une
/// armée : au-delà, le surplus est laissé de côté plutôt que de noyer la carte
/// sous des pawns venus d'une trame bricolée.
pub const MAX_CARAVAN_PAWNS: usize = 24;
/// Cases occupées au plus par les marchandises d'un manifeste, soit
/// `MAX_CARAVAN_TILES * STACK_MAX` unités débarquées. Le surplus est perdu :
/// sans cette borne, une quantité aberrante couvrirait la carte de piles.
pub const MAX_CARAVAN_TILES: usize = 64;

/// Ce qu'une caravane emporte d'une carte à l'autre : des colons entiers (nom,
/// compétences, besoins, santé, blessures, priorités) et des marchandises.
/// Les positions et les ids ne voyagent pas : la carte d'accueil les redonne.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CaravanManifest {
    pub version: u16,
    /// Tick de la carte de départ au moment de la formation. Informatif : le
    /// serveur monde datera le voyage sur son horloge à lui.
    pub origin_tick: u64,
    pub pawns: Vec<Pawn>,
    /// Quantités par genre, un genre au plus une fois.
    pub items: Vec<(ItemKind, u32)>,
}

impl CaravanManifest {
    /// Sérialisation binaire compacte, comme `Sim::snapshot`.
    pub fn encode(&self) -> Vec<u8> {
        postcard::to_allocvec(self).expect("sérialisation en mémoire infaillible")
    }

    /// Relit un manifeste. Décodage **strict** : des octets en trop font
    /// échouer la relecture, comme pour les commandes du lockstep.
    pub fn decode(bytes: &[u8]) -> Result<CaravanManifest, SnapshotError> {
        let (manifest, rest) = postcard::take_from_bytes::<CaravanManifest>(bytes)
            .map_err(|_| SnapshotError::Corrupt)?;
        if !rest.is_empty() || manifest.version != MANIFEST_VERSION {
            return Err(SnapshotError::Corrupt);
        }
        Ok(manifest)
    }
}

/// Un manifeste arrive du réseau : rien ne garantit que ses colons respectent
/// les invariants du sim. Tout ce qui pourrait déraper est borné avant qu'ils
/// entrent en jeu.
fn sanitize(p: &mut Pawn) {
    if p.name.chars().count() > MAX_NAME_CHARS {
        p.name = p.name.chars().take(MAX_NAME_CHARS).collect();
    }
    p.hunger = p.hunger.min(NEED_MAX);
    p.rest = p.rest.min(NEED_MAX);
    // Zéro voudrait dire mort avant même d'avoir posé le pied à terre.
    p.blood = p.blood.clamp(1, BLOOD_MAX);
    p.injuries.truncate(health::MAX_INJURIES);
    for inj in &mut p.injuries {
        inj.severity = inj.severity.min(SEVERITY_MAX);
        inj.bleeding = inj.bleeding.min(SEVERITY_MAX);
        inj.bleed_ticks = if inj.bleeding == 0 {
            0
        } else {
            inj.bleed_ticks.min(health::BLEED_TICKS)
        };
    }
    for skill in &mut p.skills {
        skill.level = skill.level.min(work::SKILL_MAX);
        skill.xp = skill.xp.min(work::xp_to_next(skill.level));
    }
    for skill in [&mut p.melee, &mut p.ranged] {
        skill.level = skill.level.min(work::SKILL_MAX);
        skill.xp = skill.xp.min(work::xp_to_next(skill.level));
    }
    // Le voyageur garde son arme, à condition que ce soit une arme.
    if p.weapon.is_some_and(|w| !w.is_weapon()) {
        p.weapon = None;
    }
    // Et son habit sur le dos, à condition que ce soit un habit : un manteau
    // fait le voyage, un « manteau » qui serait un cadavre, non.
    if p.apparel.is_some_and(|a| !a.is_apparel()) {
        p.apparel = None;
    }
    for prio in &mut p.priorities {
        *prio = (*prio).min(4);
    }
    p.attack_cooldown = p.attack_cooldown.min(combat::ATTACK_COOLDOWN);
    p.grief_ticks = p.grief_ticks.min(combat::GRIEF_TICKS);
    p.relief_ticks = p.relief_ticks.min(pawn::RELIEF_TICKS);
    p.idle_ticks = 0;
    p.gone = false;
    p.outdoor_storm = false;
    // Une caravane débarque des colons, pas du bétail : rien de la faune ne
    // survit au voyage (une espèce ferait un colon au plafond de PV d'un lapin).
    p.species = None;
    p.flee_until = 0;
    p.hunted = false;
    p.graze_at = 0;
    p.leaving = false;
    // Ni le commerce : une caravane débarque des colons, pas un marchand
    // itinérant avec sa réserve et sa rancune (voir `trade`).
    p.wares.clear();
    p.leaves_at = 0;
    p.hostile = false;
    // `hp` est dérivé : on le recalcule plutôt que de croire le manifeste.
    p.recompute_hp();
}

impl Sim {
    /// Manifestes encodés en attente d'expédition, du plus ancien au plus
    /// récent. Le client hôte les lit, les envoie au serveur monde, puis émet
    /// `Command::ClearDepartures` pour que tout le monde vide la file au même
    /// tick.
    pub fn departures(&self) -> &[Vec<u8>] {
        &self.departures
    }

    /// Vide la file et rend son contenu. **Mute l'état hors d'une commande** :
    /// réservé au client hôte au moment où il expédie, en solo. En multi, la
    /// file se vide par `Command::ClearDepartures`, sinon les clients
    /// divergent.
    pub fn take_departures(&mut self) -> Vec<Vec<u8>> {
        core::mem::take(&mut self.departures)
    }

    /// Retire les `count` premiers manifestes de la file (au plus ce qu'elle
    /// contient).
    pub(crate) fn clear_departures(&mut self, count: u32) {
        let n = (count as usize).min(self.departures.len());
        self.departures.drain(..n);
    }

    /// Forme une caravane : valide les colons, prélève les marchandises en
    /// stockage, retire les colons de la carte et met le manifeste en file.
    /// Une demande invalide (liste vide, id inconnu, pillard, colon à terre,
    /// doublon) est ignorée en bloc.
    pub(crate) fn form_caravan(&mut self, pawn_ids: &[u32], wanted: &[(ItemKind, u32)]) {
        if pawn_ids.is_empty() {
            return;
        }
        let mut chosen: Vec<usize> = Vec::with_capacity(pawn_ids.len());
        for &id in pawn_ids {
            let found = self.pawns.iter().position(|p| {
                p.id == id && p.faction == Faction::Colony && p.is_alive() && !p.is_downed()
            });
            match found {
                Some(i) if !chosen.contains(&i) => chosen.push(i),
                _ => return,
            }
        }
        chosen.sort_unstable();

        // Les piles se prennent autour du premier colon de la liste, avant que
        // qui que ce soit ne quitte la carte.
        let from = self.pawns[chosen[0]].tile();
        let mut items: Vec<(ItemKind, u32)> = Vec::new();
        for &(kind, count) in wanted {
            let taken = self.take_from_stock(kind, count, from);
            if taken == 0 {
                continue;
            }
            match items.iter_mut().find(|(k, _)| *k == kind) {
                Some((_, total)) => *total += taken,
                None => items.push((kind, taken)),
            }
        }

        // Retrait par indices décroissants : ceux qui restent gardent le leur.
        let mut pawns: Vec<Pawn> = Vec::with_capacity(chosen.len());
        for &i in chosen.iter().rev() {
            pawns.push(self.remove_for_caravan(i));
        }
        pawns.reverse();

        let count = pawns.len() as u32;
        let manifest = CaravanManifest {
            version: MANIFEST_VERSION,
            origin_tick: self.tick,
            pawns,
            items,
        };
        self.departures.push(manifest.encode());
        self.push_event(EventKind::CaravanDeparted, count);
    }

    /// Prélève au plus `wanted` unités de `kind` dans les piles rangées en
    /// stockage, les plus proches de `from` d'abord. Rend la quantité obtenue.
    /// Partagé avec le troc (`trade`) : vendre au marchand, c'est charger une
    /// caravane qui n'irait pas plus loin que l'étal.
    pub(crate) fn take_from_stock(&mut self, kind: ItemKind, wanted: u32, from: (u32, u32)) -> u32 {
        if wanted == 0 {
            return 0;
        }
        // Trié par (distance, x, y, id) : ordre total, donc déterministe.
        let mut candidates: Vec<(u32, u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind == kind && self.map.zone(s.x, s.y) == Zone::Stockpile)
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, s.id, k))
            .collect();
        candidates.sort_unstable();

        let mut taken = 0;
        let mut emptied: Vec<usize> = Vec::new();
        for &(.., k) in &candidates {
            if taken >= wanted {
                break;
            }
            let n = self.items[k].count.min(wanted - taken);
            self.items[k].count -= n;
            taken += n;
            if self.items[k].count == 0 {
                emptied.push(k);
            }
        }
        // Une pile réservée par un colon peut être entamée : son job ne la
        // retrouvera pas et s'abandonnera de lui-même, comme à la péremption.
        emptied.sort_unstable();
        for &k in emptied.iter().rev() {
            self.items.remove(k);
        }
        taken
    }

    /// Sort un colon de la carte : mêmes libérations que `remove_dead`, mais
    /// sans cadavre, sans deuil et sans événement de mort. Rend le pawn prêt à
    /// voyager (sans job, sans chemin, sans charge, sans position).
    fn remove_for_caravan(&mut self, i: usize) -> Pawn {
        let mut p = self.pawns.remove(i);
        self.reservations.retain(|r| r.pawn != p.id);
        for q in &mut self.pawns {
            if q.carrying_pawn == Some(p.id) {
                q.carrying_pawn = None;
            }
        }
        for s in &mut self.items {
            if s.reserved_by == Some(p.id) {
                s.reserved_by = None;
            }
        }
        for b in &mut self.blueprints {
            if b.reserved_by == Some(p.id) {
                b.reserved_by = None;
            }
        }
        // Ce qu'il avait en main reste à la colonie.
        if let Some((kind, count)) = p.carrying.take() {
            let (x, y) = p.tile();
            self.spawn_item(kind, count, x, y);
        }
        // Les jobs qui le visaient (Attack, Rescue, Tend) ne trouveront plus
        // leur cible et s'abandonneront au tick suivant.
        p.carrying_pawn = None;
        p.job = Job::Idle;
        p.path.clear();
        p.idle_ticks = 0;
        p.x = 0;
        p.y = 0;
        p
    }

    /// Fait entrer un manifeste sur cette carte. Un manifeste illisible est
    /// ignoré, jamais fatal : ces octets viennent du réseau.
    pub(crate) fn arrive_caravan(&mut self, bytes: &[u8]) {
        let Ok(manifest) = CaravanManifest::decode(bytes) else {
            return;
        };
        // Comme les arrivants d'un raid : un bord d'où la colonie est
        // atteignable. Sans colonie sur place (case vierge), le centre fait
        // l'affaire.
        let entry = match self.find_entry_tile() {
            Some(e) => e,
            None => {
                let (cx, cy) = (self.map.width() / 2, self.map.height() / 2);
                match self.map.nearest_passable(cx, cy) {
                    Some(t) => t,
                    // Carte entièrement infranchissable : personne ne débarque.
                    None => return,
                }
            }
        };

        let wanted = manifest.pawns.len().min(MAX_CARAVAN_PAWNS);
        let spots = self.ring_tiles(entry, wanted, true);
        let mut arrived = 0;
        for (p, &(x, y)) in manifest.pawns.iter().zip(spots.iter()) {
            let mut p = p.clone();
            p.id = self.next_id;
            self.next_id += 1;
            p.faction = Faction::Colony;
            p.x = fixed::from_int(x as i32) + FX_HALF;
            p.y = fixed::from_int(y as i32) + FX_HALF;
            p.job = Job::Idle;
            p.path.clear();
            p.carrying = None;
            p.carrying_pawn = None;
            sanitize(&mut p);
            self.pawns.push(p);
            arrived += 1;
        }

        self.drop_caravan_goods(entry, &manifest.items);
        self.push_event(EventKind::CaravanArrived, arrived);
    }

    /// Pose les marchandises au sol autour de la case d'entrée, une pile de
    /// `STACK_MAX` au plus par case, dans la limite de `MAX_CARAVAN_TILES`
    /// cases. `spawn_item` redate la péremption des vivres au tick d'arrivée :
    /// le voyage est abstrait ici.
    fn drop_caravan_goods(&mut self, entry: (u32, u32), goods: &[(ItemKind, u32)]) {
        // Somme saturante : un manifeste bricolé peut annoncer n'importe quoi.
        let needed = goods
            .iter()
            .fold(0usize, |acc, &(_, count)| {
                acc.saturating_add(count.div_ceil(STACK_MAX) as usize)
            })
            .min(MAX_CARAVAN_TILES);
        if needed == 0 {
            return;
        }
        let tiles = self.ring_tiles(entry, needed, false);
        let mut t = 0;
        for &(kind, count) in goods {
            let mut left = count;
            while left > 0 {
                let Some(&(x, y)) = tiles.get(t) else {
                    // Plus de place autour de l'entrée : le reste se perd.
                    return;
                };
                let n = left.min(STACK_MAX);
                self.spawn_item(kind, n, x, y);
                left -= n;
                t += 1;
            }
        }
    }

    /// Jusqu'à `count` cases franchissables autour de `entry`, par anneaux
    /// croissants et dans l'ordre fixe de `spawn_raid`. `free_of_pawns` écarte
    /// en plus les cases déjà occupées.
    pub(crate) fn ring_tiles(
        &self,
        entry: (u32, u32),
        count: usize,
        free_of_pawns: bool,
    ) -> Vec<(u32, u32)> {
        let mut out: Vec<(u32, u32)> = Vec::new();
        let mut r: i32 = 0;
        while out.len() < count && r < PLACE_RINGS {
            for dy in -r..=r {
                for dx in -r..=r {
                    if out.len() >= count || (dx.abs() != r && dy.abs() != r) {
                        continue;
                    }
                    let x = entry.0 as i32 + dx;
                    let y = entry.1 as i32 + dy;
                    if !self.map.in_bounds(x, y) {
                        continue;
                    }
                    let tile = (x as u32, y as u32);
                    if !self.map.passable(tile.0, tile.1) {
                        continue;
                    }
                    if free_of_pawns && self.pawns.iter().any(|p| p.tile() == tile) {
                        continue;
                    }
                    out.push(tile);
                }
            }
            r += 1;
        }
        out
    }
}
