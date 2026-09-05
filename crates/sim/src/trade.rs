//! Marchands itinérants et troc.
//!
//! Un marchand est un `Pawn` comme un pillard ou une bête (`docs/PLAN.md`,
//! journal du 2026-09-04) : même santé, même pathfinding, mêmes tampons de
//! rendu. Ce qu'il a en plus tient en trois champs de `Pawn` : ses
//! marchandises (`wares`), l'heure à laquelle il plie boutique (`leaves_at`)
//! et le souvenir d'un colon qui aurait levé la main sur lui (`hostile`).
//!
//! La visite : le storyteller le fait entrer par un bord tous les
//! `TRADER_MIN_DAYS` à `TRADER_MIN_DAYS + TRADER_SPAN_DAYS` jours, quelle que
//! soit la difficulté — un marchand n'est pas une menace, il passe même en
//! paisible. Il marche jusqu'à une case à `STALL_MIN_DISTANCE`-`STALL_MAX_DISTANCE`
//! du barycentre des colons, y attend `TRADER_STAY`, puis repart par le bord
//! le plus proche. Il ne mange pas, ne dort pas, ne travaille pas.
//!
//! Il est **neutre** : ni la défense automatique des colons, ni les pillards,
//! ni les bêtes ne le prennent pour cible (voir `Sim::is_auto_target`). Un
//! `Command::Attack` d'un colon, en revanche, annule la visite : il devient
//! hostile et se bat comme un pillard (`Pawn::is_raider_like`).
//!
//! Il appartient à la **Guilde des Colporteurs** (`factions::GUILD`) : ce
//! qu'on lui fait se retient. Un troc conclu la rapproche
//! (`factions::TRADE_DONE`), une main levée sur un de ses marchands
//! (`factions::TRADER_ANGERED`) ou un marchand mort
//! (`factions::TRADER_KILLED`) l'éloigne. Deux conséquences visibles : elle
//! vend moins cher à une colonie **alliée** (`ALLY_SELL_NUM`), et elle
//! n'envoie plus personne tant qu'elle est **hostile** — la rancune de
//! `TRADER_GRUDGE_EXTRA` espaçait les visites, la réputation les suspend.
//!
//! Le troc se fait **en valeur**, pas en monnaie : il n'y a pas d'argent dans
//! ce jeu. La valeur d'un genre est celle qui sert déjà à la richesse de la
//! colonie (`ItemKind::wealth_value`, ré-exportée ici en `item_value`) : le
//! marchand vend au-dessus (`value_sell`) et achète en dessous (`value_buy`),
//! et la différence est sa marge. La colonie peut toujours payer plus que le
//! prix demandé, jamais moins.

use crate::factions::{self, Relation};
use crate::items::{ItemKind, STACK_MAX};
use crate::path;
use crate::pawn::{Faction, Job, NEED_MAX, Pawn};
use crate::{EventKind, Sim, TICKS_PER_DAY};

// ----------------------------------------------------------------------
// Constantes de réglage
// ----------------------------------------------------------------------

/// Le marchand reste une journée entière : de quoi laisser le joueur voir
/// l'annonce, ouvrir son panneau et faire remonter du stock du fond de
/// l'entrepôt.
pub const TRADER_STAY: u32 = TICKS_PER_DAY;

/// Délai entre deux visites : de `TRADER_MIN_DAYS` à
/// `TRADER_MIN_DAYS + TRADER_SPAN_DAYS` jours, soit 4 à 7.
pub const TRADER_MIN_DAYS: u32 = 4;
pub const TRADER_SPAN_DAYS: u32 = 3;

/// Ce que coûte à la colonie d'avoir laissé mourir un marchand : les visites
/// programmées tant que la rancune dure attendent ce délai en plus.
pub const TRADER_GRUDGE_EXTRA: u32 = TICKS_PER_DAY * 3;
/// Durée de la rancune. Assez longue pour couvrir plusieurs visites : « les
/// visites suivantes », pas seulement la prochaine.
pub const TRADER_GRUDGE_TICKS: u32 = TICKS_PER_DAY * 15;

/// Prix de vente = valeur × `SELL_NUM` / `SELL_DEN`, arrondi vers le bas.
pub const SELL_NUM: u32 = 12;
pub const SELL_DEN: u32 = 10;
/// Numérateur de vente pour une colonie **alliée** de la Guilde
/// (`factions::ALLY_GOODWILL`) : 110 % au lieu de 120 %. La marge d'achat, elle,
/// ne bouge pas — un allié est mieux servi, pas subventionné.
pub const ALLY_SELL_NUM: u32 = 11;
/// Prix d'achat = valeur × `BUY_NUM` / `BUY_DEN`, arrondi vers le bas.
pub const BUY_NUM: u32 = 7;
pub const BUY_DEN: u32 = 10;

/// L'étal se pose entre ces deux distances du barycentre des colons : assez
/// près pour qu'un colon fasse l'aller-retour, assez loin pour ne pas planter
/// un inconnu au milieu des lits.
pub const STALL_MIN_DISTANCE: u32 = 4;
pub const STALL_MAX_DISTANCE: u32 = 6;
// `trader_stall` tire un décalage dans `-STALL_MAX_DISTANCE..=STALL_MAX_DISTANCE`
// et ne garde que ce qui tombe dans la fourchette : l'intervalle doit exister.
const _: () = assert!(STALL_MIN_DISTANCE <= STALL_MAX_DISTANCE);
/// Tirages de case avant de renoncer à l'étal (le marchand reste alors au bord).
const STALL_DRAWS: u32 = 24;

/// Quantité d'un lot en vrac : de `BULK_MIN` à `BULK_MIN + BULK_SPAN - 1`.
pub const BULK_MIN: u32 = 10;
pub const BULK_SPAN: u32 = 51;
/// Quantité d'un lot d'armes ou de vêtements : 1 à 3. On ne vend pas trente
/// arcs sur le pas d'une porte.
pub const GEAR_MIN: u32 = 1;
pub const GEAR_SPAN: u32 = 3;

/// Ce que porte un marchand, selon le profil tiré au sort. Un profil est une
/// liste de genres : le tirage ne décide que des quantités, pour que le joueur
/// reconnaisse d'un coup d'œil à qui il a affaire.
const FOOD_WARES: [ItemKind; 4] = [
    ItemKind::Berries,
    ItemKind::Vegetables,
    ItemKind::Meal,
    ItemKind::Meat,
];
const CRAFT_WARES: [ItemKind; 5] = [
    ItemKind::Wood,
    ItemKind::Stone,
    ItemKind::Leather,
    ItemKind::Tunic,
    ItemKind::Coat,
];
const ARMS_WARES: [ItemKind; 3] = [ItemKind::Club, ItemKind::Spear, ItemKind::Bow];

/// Les trois profils, dans un ordre fixe : le tirage porte sur l'indice.
const PROFILES: [&[ItemKind]; 3] = [&FOOD_WARES, &CRAFT_WARES, &ARMS_WARES];

// ----------------------------------------------------------------------
// Prix
// ----------------------------------------------------------------------

/// Valeur d'échange d'une unité. C'est **la même** que celle qui compte dans
/// la richesse de la colonie (`ItemKind::wealth_value`) : deux barèmes qui
/// divergeraient feraient du commerce une machine à fabriquer des raids.
pub fn item_value(kind: ItemKind) -> u32 {
    kind.wealth_value()
}

/// Prix auquel le marchand **vend** une unité : plus cher que sa valeur.
/// Jamais zéro, sinon un genre sans valeur (le cadavre) se donnerait à la
/// pelle. C'est le tarif de base, celui d'une colonie ordinaire : le prix
/// réellement demandé passe par `Sim::sell_price`, qui tient compte de la
/// réputation.
pub fn value_sell(kind: ItemKind) -> u32 {
    sell_price_with(kind, SELL_NUM)
}

/// Prix de vente à un numérateur donné (`SELL_NUM` ou `ALLY_SELL_NUM`).
pub fn sell_price_with(kind: ItemKind, num: u32) -> u32 {
    (item_value(kind) * num / SELL_DEN).max(1)
}

/// Prix auquel le marchand **achète** une unité : moins cher que sa valeur.
pub fn value_buy(kind: ItemKind) -> u32 {
    (item_value(kind) * BUY_NUM / BUY_DEN).max(1)
}

impl Sim {
    // ------------------------------------------------------------------
    // Lecture (client et tests)
    // ------------------------------------------------------------------

    /// Le marchand avec qui on peut traiter maintenant : présent, debout,
    /// pacifique et pas encore en route. `None` le reste du temps — c'est
    /// exactement la condition qu'un `Command::Trade` doit remplir, et c'est
    /// ce que le client affiche.
    pub fn trader(&self) -> Option<&Pawn> {
        self.trader_index().map(|k| &self.pawns[k])
    }

    /// Prix auquel le marchand présent vend une unité : `value_sell`, ou
    /// `ALLY_SELL_NUM` si la colonie est alliée de la Guilde. C'est ce prix-là
    /// que `Command::Trade` exige et que `trader_offers` affiche.
    pub fn sell_price(&self, kind: ItemKind) -> u32 {
        let num = if self.relation(factions::GUILD) == Relation::Ally {
            ALLY_SELL_NUM
        } else {
            SELL_NUM
        };
        sell_price_with(kind, num)
    }

    /// Ce que le marchand propose : genre, quantité, **prix unitaire de
    /// vente**. Vide s'il n'y a personne à qui parler.
    pub fn trader_offers(&self) -> Vec<(ItemKind, u32, u32)> {
        let Some(p) = self.trader() else {
            return Vec::new();
        };
        p.wares
            .iter()
            .filter(|&&(_, count)| count > 0)
            .map(|&(kind, count)| (kind, count, self.sell_price(kind)))
            .collect()
    }

    /// Prix unitaire d'achat par genre, indexé par `ItemKind` : ce que la
    /// colonie touche en cédant une unité. Ne dépend pas du marchand présent —
    /// le client peut l'afficher en permanence.
    pub fn buy_prices(&self) -> [u32; ItemKind::COUNT] {
        let mut out = [0; ItemKind::COUNT];
        for (k, slot) in out.iter_mut().enumerate() {
            *slot = value_buy(ItemKind::from_u8(k as u8));
        }
        out
    }

    /// Indice du marchand avec qui on peut traiter (voir `Sim::trader`).
    fn trader_index(&self) -> Option<usize> {
        self.pawns.iter().position(|p| {
            p.faction == Faction::Trader
                && p.is_alive()
                && !p.hostile
                && !p.is_downed()
                && self.tick < p.leaves_at
        })
    }

    /// Un marchand est-il déjà sur la carte, quel que soit son humeur ? Sert à
    /// ne pas en faire entrer deux.
    fn trader_on_map(&self) -> bool {
        self.pawns
            .iter()
            .any(|p| p.faction == Faction::Trader && p.is_alive())
    }

    // ------------------------------------------------------------------
    // Visites
    // ------------------------------------------------------------------

    /// Programme la première visite. Appelée à la construction du sim, après
    /// les autres échéances : les tirages précédents ne bougent pas.
    pub(crate) fn schedule_first_trader(&mut self) {
        self.next_trader_at = self.roll_delay(TRADER_MIN_DAYS, TRADER_SPAN_DAYS);
    }

    /// Programme la visite suivante, rancune comprise.
    pub(crate) fn schedule_next_trader(&mut self) {
        let extra = if self.tick < self.trader_grudge_until {
            u64::from(TRADER_GRUDGE_EXTRA)
        } else {
            0
        };
        self.next_trader_at = self
            .roll_delay(TRADER_MIN_DAYS, TRADER_SPAN_DAYS)
            .saturating_add(extra);
    }

    /// Fait entrer un marchand tout de suite (tests, débogage). Renvoie son id,
    /// ou `None` si personne ne peut venir : colonie éteinte, aucun bord d'où
    /// l'atteindre, ou marchand déjà sur place.
    pub fn trigger_trader_visit(&mut self) -> Option<u32> {
        self.spawn_trader()
    }

    /// L'arrivée elle-même. Le marchand entre par un bord comme un raid, avec
    /// son épieu et sa tunique — de quoi décourager un colon qui aurait des
    /// idées, pas de quoi prendre une colonie.
    pub(crate) fn spawn_trader(&mut self) -> Option<u32> {
        if self.trader_on_map() {
            return None;
        }
        // La Guilde hostile n'envoie personne se faire égorger : le refus vaut
        // aussi pour `trigger_trader_visit`, comme les autres refus de cette
        // fonction (marchand déjà là, colonie éteinte, aucun bord). C'est
        // l'inverse du choix fait pour `TriggerRaid`, et pour la même raison :
        // ici, ne pas venir *est* le comportement à pouvoir observer.
        if self.relation(factions::GUILD) == Relation::Hostile {
            return None;
        }
        let center = self.colony_center()?;
        let entry = self.find_entry_tile()?;
        // L'étal d'abord : le tirage doit avoir lieu que la case d'apparition
        // existe ou non, sinon le flux RNG dépendrait de l'encombrement du bord.
        let stall = self.trader_stall(center, entry);
        let spot = *self.ring_tiles(entry, 1, true).first()?;
        let wares = self.draw_wares();

        let id = self.spawn_pawn(spot.0, spot.1, Faction::Trader);
        let k = self.pawns.len() - 1;
        // Il ne mange ni ne dort : ses besoins sont comblés une fois pour
        // toutes, comme ceux d'un pillard.
        self.pawns[k].hunger = NEED_MAX;
        self.pawns[k].rest = NEED_MAX;
        self.pawns[k].weapon = Some(ItemKind::Spear);
        self.pawns[k].apparel = Some(ItemKind::Tunic);
        self.pawns[k].wares = wares;
        self.pawns[k].leaves_at = self.tick + u64::from(TRADER_STAY);
        if let Some(target) = stall
            && let Some(p) = path::find_path(&self.map, spot, target)
        {
            self.pawns[k].set_path(p);
            self.pawns[k].job = Job::Move { manual: false };
        } else {
            let until = self.pawns[k].leaves_at;
            self.pawns[k].job = Job::Wait { until };
        }
        self.push_event(EventKind::TraderVisit, id);
        Some(id)
    }

    /// Case où planter l'étal : franchissable, libre, à bonne distance du
    /// barycentre des colons et reliée au bord d'entrée. `None` si rien ne
    /// convient — le marchand tiendra boutique là où il est entré.
    fn trader_stall(&mut self, center: (u32, u32), entry: (u32, u32)) -> Option<(u32, u32)> {
        let span = STALL_MAX_DISTANCE as i32;
        for _ in 0..STALL_DRAWS {
            let dx = self.rng.range_i32(-span, span + 1);
            let dy = self.rng.range_i32(-span, span + 1);
            let d = dx.abs().max(dy.abs()) as u32;
            if !(STALL_MIN_DISTANCE..=STALL_MAX_DISTANCE).contains(&d) {
                continue;
            }
            let x = center.0 as i32 + dx;
            let y = center.1 as i32 + dy;
            if !self.map.in_bounds(x, y) {
                continue;
            }
            let tile = (x as u32, y as u32);
            if !self.map.passable(tile.0, tile.1) || self.pawns.iter().any(|p| p.tile() == tile) {
                continue;
            }
            if path::find_path(&self.map, entry, tile).is_some() {
                return Some(tile);
            }
        }
        None
    }

    /// Les marchandises d'une visite : un profil tiré au sort, puis une
    /// quantité par genre.
    fn draw_wares(&mut self) -> Vec<(ItemKind, u32)> {
        let profile = PROFILES[self.rng.below(PROFILES.len() as u32) as usize];
        let mut out = Vec::with_capacity(profile.len());
        for &kind in profile {
            let count = if kind.is_weapon() || kind.is_apparel() {
                GEAR_MIN + self.rng.below(GEAR_SPAN)
            } else {
                BULK_MIN + self.rng.below(BULK_SPAN)
            };
            out.push((kind, count));
        }
        out
    }

    // ------------------------------------------------------------------
    // Décision
    // ------------------------------------------------------------------

    /// Boucle courte d'un marchand, sur le modèle de `raider_ai` : se battre
    /// s'il a été attaqué, repartir si l'heure est venue, marcher jusqu'à son
    /// étal, sinon attendre le client.
    pub(crate) fn trader_ai(&mut self, i: usize) {
        if self.pawns[i].is_downed() {
            return;
        }
        if self.pawns[i].hostile {
            match self.pawns[i].job.clone() {
                Job::Attack { target } => self.do_attack(i, target),
                Job::Flee => self.do_flee(i),
                _ => self.raider_ai(i),
            }
            return;
        }
        // L'heure de plier boutique : il repart par le bord le plus proche et
        // quitte la carte, comme un pillard qui décroche.
        if self.tick >= self.pawns[i].leaves_at {
            if !matches!(self.pawns[i].job, Job::Flee) {
                self.pawns[i].path.clear();
                self.pawns[i].job = Job::Flee;
            }
            self.do_flee(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let until = self.pawns[i].leaves_at;
        self.pawns[i].job = Job::Wait { until };
    }

    /// Un colon lève la main sur le marchand : la visite est annulée, il se
    /// défend. Sans effet sur qui n'est pas un marchand pacifique — c'est
    /// `Sim::apply` qui appelle, sur n'importe quelle cible d'attaque.
    pub(crate) fn anger_trader(&mut self, k: usize) {
        if self.pawns[k].faction != Faction::Trader || self.pawns[k].hostile {
            return;
        }
        self.pawns[k].hostile = true;
        self.pawns[k].path.clear();
        self.pawns[k].job = Job::Idle;
        let id = self.pawns[k].id;
        self.push_event(EventKind::TraderAngered, id);
        self.add_goodwill(factions::GUILD, factions::TRADER_ANGERED);
    }

    /// Le marchand est mort sur la carte : ses marchandises tombent au sol —
    /// butin, mais butin cher payé — et la colonie garde la réputation
    /// pendant `TRADER_GRUDGE_TICKS`. Appelée par `Sim::remove_dead`.
    pub(crate) fn trader_died(&mut self, p: &Pawn, at: (u32, u32)) {
        let wares = p.wares.clone();
        self.scatter_goods(at, &wares);
        self.push_event(EventKind::TraderDied, p.id);
        self.add_goodwill(factions::GUILD, factions::TRADER_KILLED);
        self.trader_grudge_until = self.tick + u64::from(TRADER_GRUDGE_TICKS);
        self.next_trader_at = self
            .next_trader_at
            .saturating_add(u64::from(TRADER_GRUDGE_EXTRA));
    }

    // ------------------------------------------------------------------
    // Troc
    // ------------------------------------------------------------------

    /// Applique un `Command::Trade`. Tout ce qui cloche — pas de marchand,
    /// stock insuffisant d'un côté ou de l'autre, compte qui ne tombe pas —
    /// fait rentrer la commande sans rien changer : le client aura affiché des
    /// prix un tick trop tôt, ce n'est pas une raison pour désynchroniser.
    pub(crate) fn trade(
        &mut self,
        give: ItemKind,
        give_count: u32,
        take: ItemKind,
        take_count: u32,
    ) {
        if give_count == 0 || take_count == 0 {
            return;
        }
        let Some(k) = self.trader_index() else {
            return;
        };
        // Ce que la colonie possède **en stockage**, comme pour une caravane :
        // ce qui traîne au fond des bois ne se vend pas.
        if self.stored_totals()[give as usize] < give_count {
            return;
        }
        let held = self.ware_count(k, take);
        if held < take_count {
            return;
        }
        // En `u64` : les deux quantités sont déjà bornées par les stocks, mais
        // un produit de `u32` n'a pas à dépendre de cette garantie.
        let paid = u64::from(value_buy(give)) * u64::from(give_count);
        let cost = u64::from(self.sell_price(take)) * u64::from(take_count);
        if paid < cost {
            return;
        }

        let tile = self.pawns[k].tile();
        // Les piles les plus proches du marchand d'abord, comme au chargement
        // d'une caravane.
        let taken = self.take_from_stock(give, give_count, tile);
        self.add_ware(k, give, taken);
        self.remove_ware(k, take, take_count);
        self.scatter_goods(tile, &[(take, take_count)]);
        self.push_event(EventKind::TradeDone, take as u32);
        // Un client est un client : la Guilde s'en souvient.
        self.add_goodwill(factions::GUILD, factions::TRADE_DONE);
    }

    /// Ce que le marchand a de ce genre.
    fn ware_count(&self, k: usize, kind: ItemKind) -> u32 {
        self.pawns[k]
            .wares
            .iter()
            .find(|&&(w, _)| w == kind)
            .map_or(0, |&(_, n)| n)
    }

    /// Range ce que la colonie vient de céder dans la réserve du marchand : il
    /// prend n'importe quel genre, et le revendra plus loin.
    fn add_ware(&mut self, k: usize, kind: ItemKind, count: u32) {
        if count == 0 {
            return;
        }
        match self.pawns[k].wares.iter_mut().find(|(w, _)| *w == kind) {
            Some((_, total)) => *total = total.saturating_add(count),
            None => self.pawns[k].wares.push((kind, count)),
        }
    }

    /// Retire de la réserve ce que la colonie vient d'acheter.
    fn remove_ware(&mut self, k: usize, kind: ItemKind, count: u32) {
        if let Some(slot) = self.pawns[k].wares.iter_mut().find(|(w, _)| *w == kind) {
            slot.1 = slot.1.saturating_sub(count);
        }
        self.pawns[k].wares.retain(|&(_, n)| n > 0);
    }

    /// Pose des marchandises sur une case et ses voisines, une pile de
    /// `STACK_MAX` au plus par case. Sert au troc comme au butin d'un marchand
    /// mort : dans les deux cas, la quantité est petite (une réserve de
    /// marchand, pas une caravane), donc une poignée d'anneaux suffit.
    fn scatter_goods(&mut self, at: (u32, u32), goods: &[(ItemKind, u32)]) {
        let needed = goods.iter().fold(0usize, |acc, &(_, count)| {
            acc.saturating_add(count.div_ceil(STACK_MAX) as usize)
        });
        if needed == 0 {
            return;
        }
        let tiles = self.ring_tiles(at, needed, false);
        let mut t = 0;
        for &(kind, count) in goods {
            let mut left = count;
            while left > 0 {
                let Some(&(x, y)) = tiles.get(t) else {
                    // Plus de place autour : le reste se perd, comme pour une
                    // caravane qui débarque sur une carte encombrée.
                    return;
                };
                let n = left.min(STACK_MAX);
                self.spawn_item(kind, n, x, y);
                left -= n;
                t += 1;
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::health::{BodyPart, SEVERITY_MAX};
    use crate::testmap::map_from;

    /// Tuer le marchand se paie : sa réserve tombe au sol (butin), le journal
    /// le dit, et les visites suivantes se font attendre. Test **interne** au
    /// crate : les échéances du storyteller ne sont pas publiques.
    #[test]
    fn la_mort_d_un_marchand_laisse_son_stock_et_une_rancune() {
        let mut s = Sim::from_map(
            1,
            map_from(&[
                "............",
                "............",
                "............",
                "............",
                "............",
                "............",
                "............",
                "............",
            ]),
        );
        let id = s
            .trigger_trader_visit()
            .expect("un marchand doit pouvoir entrer");
        let wares = s
            .pawns
            .iter()
            .find(|p| p.id == id)
            .expect("le marchand est là")
            .wares
            .clone();
        let (kind, count) = wares[0];
        let before = s.next_trader_at;
        assert_eq!(s.trader_grudge_until, 0, "rancune sans raison");

        // Un coup au torse ne pardonne pas : `remove_dead` fait le reste au
        // tick suivant.
        s.inflict_injury(id, BodyPart::Torso, SEVERITY_MAX);
        s.step(&[]);

        assert!(s.trader().is_none() && !s.trader_on_map(), "il est mort");
        assert!(
            s.events
                .iter()
                .any(|e| e.kind == EventKind::TraderDied && e.arg == id),
            "mort non annoncée : {:?}",
            s.events
        );
        let on_ground: u32 = s
            .items
            .iter()
            .filter(|i| i.kind == kind)
            .map(|i| i.count)
            .sum();
        assert_eq!(on_ground, count, "sa réserve n'est pas tombée au sol");
        assert!(
            s.items.iter().any(|i| i.kind == ItemKind::Spear),
            "son épieu non plus"
        );
        assert!(
            s.next_trader_at >= before + u64::from(TRADER_GRUDGE_EXTRA),
            "la visite suivante n'a pas été repoussée"
        );
        assert!(s.trader_grudge_until > s.tick, "aucune rancune retenue");

        // Et la rancune s'applique aussi aux visites programmées ensuite.
        let sans_rancune = {
            let mut clean = s.clone();
            clean.trader_grudge_until = 0;
            clean.schedule_next_trader();
            clean.next_trader_at
        };
        s.schedule_next_trader();
        assert_eq!(
            s.next_trader_at,
            sans_rancune + u64::from(TRADER_GRUDGE_EXTRA),
            "la rancune n'espace pas les visites"
        );
    }

    #[test]
    fn le_marchand_vend_plus_cher_qu_il_n_achete() {
        for k in 0..ItemKind::COUNT {
            let kind = ItemKind::from_u8(k as u8);
            assert!(value_sell(kind) >= 1, "{kind:?} vendu pour rien");
            assert!(value_buy(kind) >= 1, "{kind:?} acheté pour rien");
            assert!(
                value_sell(kind) >= value_buy(kind),
                "{kind:?} : marge négative"
            );
            assert_eq!(item_value(kind), kind.wealth_value());
        }
        // Un genre qui vaut quelque chose garde bien une marge stricte.
        assert!(value_sell(ItemKind::Bow) > value_buy(ItemKind::Bow));
        assert_eq!(value_sell(ItemKind::Wood), 1);
        assert_eq!(value_buy(ItemKind::Bow), 60 * BUY_NUM / BUY_DEN);
    }

    #[test]
    fn chaque_profil_tient_debout() {
        for profile in PROFILES {
            assert!(!profile.is_empty());
            for &kind in profile {
                assert!(item_value(kind) > 0, "{kind:?} n'a aucune valeur");
                assert!(!kind.is_animal_corpse() && kind != ItemKind::Corpse);
            }
        }
    }
}
