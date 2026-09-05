//! Élevage : apprivoiser une bête, la garder, la faire se reproduire, l'abattre.
//!
//! Une bête apprivoisée **n'est pas un nouveau genre de pawn** : c'est un
//! `Pawn` de `Faction::Animal` dont la faction devient `Faction::Colony` en
//! gardant son `species`. Aucun tampon ne change de largeur : le client la
//! reconnaît à `pawn_species(id) >= 0` **et** faction 0. C'est le même parti
//! pris que pour la faune sauvage (`animals`) et pour les pillards
//! (`docs/PLAN.md`, journal du 2026-09-04) : seule la boucle de décision
//! diffère.
//!
//! Conséquence à retenir dans tout le sim : `faction == Faction::Colony` ne
//! veut plus dire « un colon ». Ce que veut dire « un colon » s'écrit
//! `Pawn::is_colonist()`, et « une bête de la colonie » `Pawn::is_livestock()`.
//! Les bêtes ne comptent donc ni dans les points de menace, ni dans le
//! barycentre de la colonie, ni dans les tableaux de travail, ni dans les
//! maladies, ni dans les caravanes.
//!
//! Ce qu'une bête de la colonie gagne par rapport à une bête sauvage :
//!
//! - elle ne fuit plus les colons et ne quitte plus la carte ;
//! - elle a **faim** (`LIVESTOCK_HUNGER_DECAY`) et se nourrit d'herbe, de
//!   buissons, ou à défaut du stock de la colonie ;
//! - elle tient le rayon `LIVESTOCK_RANGE` autour du barycentre des colons ;
//! - apprivoisée et agressive (le sanglier), elle rejoint la défense
//!   automatique ;
//! - elle ne déclenche plus les pièges (son chemin est celui d'un colon) et
//!   n'est plus du gibier ;
//! - elle compte dans la richesse (`Species::wealth_value`) et se reproduit.
//!
//! Ce que l'élevage ne change pas : les **caravanes** (aucune bête ne voyage,
//! le manifeste ne bouge pas — `caravan::sanitize` efface toute espèce) et
//! l'**avance rapide** (`fastforward`), où les bêtes de la colonie restent sur
//! la carte au lieu de partir comme la faune sauvage, et rentrent nourries par
//! `FROZEN_HUNGER` comme les colons ; seule l'échéance de reproduction glisse
//! avec les autres.

use crate::animals::{SPECIES_COUNT, Species, straight_walk};
use crate::combat::EngageOutcome;
use crate::health::{BodyPart, SEVERITY_MAX};
use crate::items::ItemKind;
use crate::jobs::PATH_ATTEMPTS;
use crate::map::{Zone, chebyshev};
use crate::pawn::{Faction, Job, NEED_MAX};
use crate::work::WorkType;
use crate::{EventKind, Sim, TICKS_PER_DAY};

/// Baies ou légumes qu'un colon apporte pour une tentative d'apprivoisement.
pub const TAME_FOOD: u32 = 5;
/// Durée d'une tentative d'apprivoisement, une fois le colon auprès de la bête.
pub const TAME_TICKS: u32 = 300;
/// Distance à laquelle un apprivoiseur travaille : on ne colle pas au museau
/// d'un cerf, on l'approche.
pub const TAME_REACH: u32 = 2;
/// Après un échec, plus personne ne retente sur cette bête avant ce délai.
pub const TAME_RETRY: u32 = TICKS_PER_DAY / 8;

/// Chance de base d'une tentative, en `TAME_BASE_NUM / TAME_BASE_DEN`.
///
/// **Mesurée avant d'être réglée.** Scénario : prairie 32 × 16, trois colons
/// nourris et reposés, 30 baies en stockage (donc six tentatives au plus,
/// `TAME_FOOD` par essai), une bête marquée au premier tick, trois jours de
/// jeu, 20 graines. Bêtes apprivoisées dans ce délai :
///
/// | base  | lapin | cerf | sanglier |
/// |---|---|---|---|
/// | 100 ‰ | 17 / 20 | 11 / 20 |  7 / 20 |
/// | **250 ‰** | **20 / 20** | **16 / 20** | **9 / 20** |
/// | 400 ‰ | 20 / 20 | 20 / 20 | 13 / 20 |
///
/// 250 est le palier qui donne à chaque espèce le rôle qu'on lui veut : le
/// lapin est la bête du débutant (six baies et trois jours suffisent, toujours
/// — 1,7 tentative en moyenne), le cerf demande de la patience, le sanglier
/// reste un pari qu'on perd une fois sur deux. À 100, le lapin lui-même
/// devient une loterie ; à 400, le cerf passe aussi sûrement que le lapin et
/// la différence d'espèce ne veut plus rien dire.
///
/// Le sanglier paie deux fois : `Species::tame_percent` le met à 150 ‰ par
/// essai, et une tentative ratée sur `BOAR_BACKLASH_CHANCE` le fait charger —
/// ce qui interrompt l'éleveur et explique qu'il aboutisse moins souvent que
/// les 62 % que ses seuls dés promettraient sur six essais.
pub const TAME_BASE_NUM: u32 = 250;
pub const TAME_BASE_DEN: u32 = 1000;
/// Chance gagnée par niveau d'`WorkType::Farm`, en millièmes : +1 % par niveau,
/// soit +20 % pour un éleveur au sommet de son art.
pub const TAME_SKILL_PER_LEVEL: u32 = TAME_BASE_DEN / 100;

/// Un sanglier qui vient d'échapper à l'apprivoisement charge une fois sur
/// quatre : approcher une bête agressive n'est jamais anodin.
pub const BOAR_BACKLASH_CHANCE: u32 = 4;

/// Bêtes apprivoisées **par espèce** au-delà desquelles la colonie n'en voit
/// plus naître. Rien n'empêche d'en apprivoiser plus : c'est la reproduction
/// qui s'arrête, pas l'élevage.
pub const MAX_LIVESTOCK: u32 = 12;

/// Rayon, en cases, que les bêtes de la colonie tiennent autour du barycentre
/// des colons — et dans lequel elles cherchent leur pâture.
pub const LIVESTOCK_RANGE: u32 = 12;

/// Faim d'une bête de la colonie : comblée à vide en deux jours. C'est le
/// « deux jours » du cahier des charges — passé ce délai sans herbe ni stock,
/// la faim tombe à zéro et la machinerie de famine des colons prend le relais
/// (`Sim::tick_health` : une atteinte du torse tous les
/// `combat::STARVE_DAMAGE_INTERVAL` ticks, et plus aucune cicatrisation).
pub const LIVESTOCK_HUNGER_DECAY: u32 = NEED_MAX.div_ceil(2 * TICKS_PER_DAY);
/// En dessous de cette faim, la bête cherche à manger : une fois par jour.
pub const LIVESTOCK_FEED_AT: u32 = NEED_MAX / 2;
/// Unités de baies ou de légumes qu'une bête prélève au stock quand elle ne
/// peut pas paître (gel, neige, pas un brin d'herbe alentour).
pub const LIVESTOCK_FEED: u32 = 5;
/// Cadence d'évaluation de la faim : une bête repue ne cherche rien, une bête
/// affamée ne balaie ses alentours qu'un tick sur `FEED_INTERVAL`.
pub const FEED_INTERVAL: u64 = 300;

/// Cadence d'évaluation de la reproduction. Les échéances, elles, sont en
/// jours (`Species::breed_days`) : cet intervalle n'est qu'un pas de
/// vérification, assez court pour ne rien décaler visiblement.
pub const BREED_INTERVAL: u64 = 600;

/// Durée d'un abattage, une fois le colon auprès de la bête.
pub const SLAUGHTER_TICKS: u32 = 60;

/// Ce qu'une bête mange : des baies ou des légumes, jamais un repas cuisiné
/// (les colons y tiennent) ni de la viande.
pub fn is_fodder(kind: ItemKind) -> bool {
    matches!(kind, ItemKind::Berries | ItemKind::Vegetables)
}

/// Chance d'une tentative d'apprivoisement, en millièmes : la base, modulée
/// par l'espèce, plus la compétence d'élevage. Jamais au-delà de la certitude.
pub fn tame_chance(species: Species, farm_level: u8) -> u32 {
    let base = TAME_BASE_NUM * species.tame_percent() / 100;
    (base + TAME_SKILL_PER_LEVEL * u32::from(farm_level)).min(TAME_BASE_DEN)
}

impl Sim {
    // ------------------------------------------------------------------
    // Marquage
    // ------------------------------------------------------------------

    /// Marque (ou démarque) une bête **sauvage** pour l'apprivoisement. Un id
    /// qui n'est pas celui d'un animal sauvage vivant est ignoré, sans plus de
    /// manières que `Command::Hunt`.
    ///
    /// Exclusif de la chasse : marquer pour l'apprivoisement retire le
    /// marquage de gibier et arrête les chasseurs en route.
    pub(crate) fn set_tame_marked(&mut self, animal: u32, on: bool) {
        let found = self
            .pawns
            .iter_mut()
            .find(|p| p.id == animal && p.faction == Faction::Animal && p.is_alive());
        let Some(p) = found else {
            return;
        };
        p.tame_marked = on;
        if on {
            p.hunted = false;
            self.abandon_jobs_on_animal(animal, true);
            return;
        }
        self.abandon_jobs_on_animal(animal, false);
    }

    /// Marque une bête **de la colonie** pour l'abattoir. Une bête sauvage est
    /// refusée : celle-là se chasse (`Command::Hunt`).
    pub(crate) fn set_slaughter_marked(&mut self, animal: u32) {
        if let Some(p) = self
            .pawns
            .iter_mut()
            .find(|p| p.id == animal && p.is_livestock() && p.is_alive())
        {
            p.slaughter_marked = true;
        }
    }

    // ------------------------------------------------------------------
    // Comptage
    // ------------------------------------------------------------------

    /// Bêtes apprivoisées vivantes, toutes espèces confondues.
    pub fn livestock_count(&self) -> u32 {
        self.pawns
            .iter()
            .filter(|p| p.is_livestock() && p.is_alive())
            .count() as u32
    }

    /// Bêtes apprivoisées vivantes d'une espèce.
    pub fn livestock_of(&self, species: Species) -> u32 {
        self.pawns
            .iter()
            .filter(|p| p.is_livestock() && p.is_alive() && p.species == Some(species))
            .count() as u32
    }

    /// Ce que le troupeau ajoute à la richesse de la colonie.
    pub(crate) fn livestock_wealth(&self) -> u32 {
        let mut total: u32 = 0;
        for p in &self.pawns {
            if let (true, Some(species)) = (p.is_livestock() && p.is_alive(), p.species) {
                total = total.saturating_add(species.wealth_value());
            }
        }
        total
    }

    // ------------------------------------------------------------------
    // Vie d'une bête de la colonie
    // ------------------------------------------------------------------

    /// Boucle d'une bête apprivoisée : la faim, la défense pour les
    /// agressives, la pâture autour de la maison.
    pub(crate) fn livestock_ai(&mut self, i: usize) {
        self.livestock_needs(i);
        // La faim vient peut-être de l'achever : elle sera retirée en fin de tick.
        if !self.pawns[i].is_alive() || self.pawns[i].is_downed() {
            return;
        }
        // Un sanglier de la colonie se bat comme un colon armé de mêlée : même
        // recherche de cible, même rayon (`combat::DEFEND_RADIUS`). Les autres
        // espèces ne défendent rien — un lapin de garde n'existe pas.
        if self.pawns[i].species.is_some_and(|s| s.aggressive()) && self.defend_if_threatened(i) {
            return;
        }
        self.livestock_graze(i);
    }

    /// Un combat de bête apprivoisée. Même cœur que la charge d'un sanglier
    /// sauvage (`Sim::engage`), mais l'échec ne la fait pas détaler : elle
    /// rentre au troupeau.
    pub(crate) fn livestock_fight(&mut self, i: usize, target: u32) {
        let over = self
            .pawns
            .iter()
            .find(|p| p.id == target)
            .is_none_or(|p| !p.is_alive() || p.is_downed());
        if over || self.engage(i, target) != EngageOutcome::Engaged {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
        }
    }

    /// La faim d'une bête de la colonie, et ce qu'elle mange. Le chemin d'une
    /// bête repue est de deux comparaisons : la faim décline, et c'est tout.
    fn livestock_needs(&mut self, i: usize) {
        self.pawns[i].hunger = self.pawns[i].hunger.saturating_sub(LIVESTOCK_HUNGER_DECAY);
        if self.pawns[i].hunger >= LIVESTOCK_FEED_AT || self.tick % FEED_INTERVAL != 0 {
            return;
        }
        // L'herbe et les buissons d'abord — mais rien ne pousse sous le gel :
        // c'est là que l'hiver oblige l'éleveur à puiser dans ses réserves.
        if self.outdoor_temperature() >= crate::climate::FREEZING
            && self.pasture_near(self.pawns[i].tile())
        {
            self.pawns[i].hunger = NEED_MAX;
            return;
        }
        if self.feed_from_stores(i) {
            self.pawns[i].hunger = NEED_MAX;
        }
        // Sinon la bête maigrit : `Sim::tick_health` fera le reste quand la
        // faim touchera le fond.
    }

    /// Y a-t-il de quoi paître à `LIVESTOCK_RANGE` de là ? De l'herbe, ou un
    /// buisson (mûr ou non : une bête ne fait pas la différence). Balayage
    /// borné au carré du rayon, et court-circuité dès la première touffe : en
    /// pratique il s'arrête au premier coup d'œil.
    fn pasture_near(&self, from: (u32, u32)) -> bool {
        let r = LIVESTOCK_RANGE as i32;
        for dy in -r..=r {
            for dx in -r..=r {
                let x = from.0 as i32 + dx;
                let y = from.1 as i32 + dy;
                if !self.map.in_bounds(x, y) {
                    continue;
                }
                let (x, y) = (x as u32, y as u32);
                if self.map.get(x, y) == crate::map::Terrain::Grass
                    || matches!(
                        self.map.feature(x, y),
                        crate::map::Feature::Bush | crate::map::Feature::BushUnripe
                    )
                {
                    return true;
                }
            }
        }
        false
    }

    /// Prélève `LIVESTOCK_FEED` unités de fourrage dans le stock de la
    /// colonie, la pile rangée la plus proche de la bête d'abord. Renvoie faux
    /// si la colonie n'a rien à donner.
    ///
    /// Le trajet n'est pas joué : ce n'est le job de personne (aucun colon ne
    /// porte le seau), et faire marcher la bête jusqu'au silo pour en revenir
    /// coûterait un A* par repas sans rien changer au résultat. Ce que le
    /// joueur voit, c'est le stock qui baisse — et c'est bien ce qui compte.
    fn feed_from_stores(&mut self, i: usize) -> bool {
        let from = self.pawns[i].tile();
        // Test sans allocation d'abord : le cas courant est « pas de fourrage ».
        if !self
            .items
            .iter()
            .any(|s| is_fodder(s.kind) && self.map.zone(s.x, s.y) == Zone::Stockpile)
        {
            return false;
        }
        let mut candidates: Vec<(u32, u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| is_fodder(s.kind) && self.map.zone(s.x, s.y) == Zone::Stockpile)
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, s.id, k))
            .collect();
        candidates.sort_unstable();
        let mut left = LIVESTOCK_FEED;
        let mut emptied: Vec<usize> = Vec::new();
        for &(.., k) in &candidates {
            if left == 0 {
                break;
            }
            let n = self.items[k].count.min(left);
            self.items[k].count -= n;
            left -= n;
            if self.items[k].count == 0 {
                emptied.push(k);
            }
        }
        emptied.sort_unstable();
        for &k in emptied.iter().rev() {
            self.items.remove(k);
        }
        // Une ration entamée nourrit quand même : mieux vaut une bête à moitié
        // repue qu'un stock intact et une bête morte.
        left < LIVESTOCK_FEED
    }

    /// Paître autour de la maison. Même cadence et même « tout droit » que la
    /// pâture sauvage (`Sim::animal_graze`, voir la note de perf de
    /// `animals::straight_walk` : jamais d'A* pour un pas de quatre cases),
    /// avec deux règles en plus : la case visée reste dans `LIVESTOCK_RANGE`
    /// du barycentre des colons, et une bête qui s'est éloignée rentre.
    fn livestock_graze(&mut self, i: usize) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if self.tick < self.pawns[i].graze_at {
            return;
        }
        self.pawns[i].graze_at = self.tick
            + u64::from(crate::animals::GRAZE_MIN + self.rng.below(crate::animals::GRAZE_SPAN));
        let me = self.pawns[i].tile();
        // Sans colon vivant, la bête reste où elle est : il n'y a plus de
        // maison vers laquelle rentrer.
        let Some(home) = self.colony_center() else {
            return;
        };
        if chebyshev(home, me) > LIVESTOCK_RANGE {
            self.livestock_walk_home(i, me, home);
            return;
        }
        let range = crate::animals::GRAZE_RANGE;
        let tx = me.0 as i32 + self.rng.range_i32(-range, range + 1);
        let ty = me.1 as i32 + self.rng.range_i32(-range, range + 1);
        if !self.map.in_bounds(tx, ty) || !self.map.passable(tx as u32, ty as u32) {
            return;
        }
        let target = (tx as u32, ty as u32);
        // Pas question de brouter chez les pillards : la bête reste au rayon.
        if chebyshev(home, target) > LIVESTOCK_RANGE {
            return;
        }
        if let Some(p) = straight_walk(&self.map, me, target) {
            self.pawns[i].set_path(p);
        }
    }

    /// Rentrer : viser tout droit vers le barycentre, en raccourcissant la
    /// course si un obstacle gêne — exactement comme une bête qui détale
    /// (`Sim::animal_flee`), mais dans l'autre sens.
    fn livestock_walk_home(&mut self, i: usize, me: (u32, u32), home: (u32, u32)) {
        let dx = (home.0 as i32 - me.0 as i32).signum();
        let dy = (home.1 as i32 - me.1 as i32).signum();
        for d in (1..=crate::animals::GRAZE_RANGE).rev() {
            let tx = (me.0 as i32 + dx * d).clamp(0, self.map.width() as i32 - 1);
            let ty = (me.1 as i32 + dy * d).clamp(0, self.map.height() as i32 - 1);
            if let Some(p) = straight_walk(&self.map, me, (tx as u32, ty as u32)) {
                self.pawns[i].set_path(p);
                return;
            }
        }
    }

    // ------------------------------------------------------------------
    // Reproduction
    // ------------------------------------------------------------------

    /// Deux bêtes d'une même espèce dans la colonie et le temps fait le reste.
    /// Évaluée un tick sur `BREED_INTERVAL`, espèce par espèce dans l'ordre de
    /// `Species::ALL` : un seul tirage d'aléa par naissance (le parent auprès
    /// duquel le petit vient au monde), et aucun quand rien ne naît.
    pub(crate) fn tick_breeding(&mut self) {
        if self.tick % BREED_INTERVAL != 0 {
            return;
        }
        for species in Species::ALL {
            let k = species as usize;
            let n = self.livestock_of(species);
            if n < 2 {
                // Plus de couple : l'échéance repart de zéro quand il s'en
                // reformera un.
                self.breed_at[k] = 0;
                continue;
            }
            let period = u64::from(species.breed_days()) * u64::from(TICKS_PER_DAY);
            if self.breed_at[k] == 0 {
                self.breed_at[k] = self.tick + period;
                continue;
            }
            if self.tick < self.breed_at[k] {
                continue;
            }
            self.breed_at[k] = self.tick + period;
            // Le plafond arrête les naissances, pas l'horloge : le troupeau
            // repartira dès qu'une bête sera abattue.
            if n >= MAX_LIVESTOCK {
                continue;
            }
            self.give_birth(species);
        }
    }

    /// Fait naître une bête auprès de l'un des parents (tiré au sort : le seul
    /// aléa de la reproduction), sur une case libre de son voisinage.
    fn give_birth(&mut self, species: Species) {
        let parents: Vec<(u32, u32)> = self
            .pawns
            .iter()
            .filter(|p| p.is_livestock() && p.is_alive() && p.species == Some(species))
            .map(|p| p.tile())
            .collect();
        if parents.is_empty() {
            return;
        }
        let parent = parents[self.rng.below(parents.len() as u32) as usize];
        let Some(&(x, y)) = self.ring_tiles(parent, 1, true).first() else {
            return;
        };
        let id = self.spawn_animal(x, y, species);
        self.tame_pawn(id);
        self.push_event(EventKind::Born, species as u32);
    }

    /// Fait passer une bête dans la colonie : plus de fuite, plus de gibier,
    /// le ventre plein et le pas d'un colon (pièges compris).
    fn tame_pawn(&mut self, animal: u32) {
        let Some(p) = self.pawns.iter_mut().find(|p| p.id == animal) else {
            return;
        };
        p.faction = Faction::Colony;
        p.hunted = false;
        p.tame_marked = false;
        p.tame_retry_at = 0;
        p.slaughter_marked = false;
        p.flee_until = 0;
        p.leaving = false;
        p.hunger = NEED_MAX;
        p.job = Job::Idle;
        p.path.clear();
    }

    // ------------------------------------------------------------------
    // Apprivoisement
    // ------------------------------------------------------------------

    /// Un colon est-il déjà sur cette bête (apprivoisement ou abattage) ?
    fn animal_handled_by_other(&self, i: usize, animal: u32) -> bool {
        self.pawns.iter().enumerate().any(|(k, p)| {
            k != i
                && match p.job {
                    Job::Tame { animal: a, .. } | Job::Slaughter { animal: a, .. } => a == animal,
                    _ => false,
                }
        })
    }

    /// Part apprivoiser la bête marquée la plus proche, fourrage en main.
    /// Trois court-circuits avant tout tri : rien de marqué, pas de stockage,
    /// pas de fourrage rangé.
    pub(crate) fn try_start_tame(&mut self, i: usize) -> bool {
        if self.map.stockpile_count() == 0
            || !self
                .pawns
                .iter()
                .any(|p| p.tame_marked && p.is_alive() && self.tick >= p.tame_retry_at)
        {
            return false;
        }
        let fodder = |s: &crate::items::ItemStack| {
            is_fodder(s.kind)
                && s.reserved_by.is_none()
                && s.count >= TAME_FOOD
                && self.map.zone(s.x, s.y) == Zone::Stockpile
        };
        if !self.items.iter().any(fodder) {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if !p.tame_marked || !p.is_alive() || self.tick < p.tame_retry_at {
                continue;
            }
            if self.animal_handled_by_other(i, p.id) {
                continue;
            }
            let (x, y) = p.tile();
            candidates.push((chebyshev(from, (x, y)), x, y, p.id));
        }
        candidates.sort_unstable();
        // Une pile de fourrage par tentative : la plus proche du colon, qui va
        // la chercher avant de rejoindre la bête.
        let mut stacks: Vec<(u32, u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| fodder(s))
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, s.id, k))
            .collect();
        stacks.sort_unstable();
        let Some(&(.., sx, sy, _, k)) = stacks.first() else {
            return false;
        };
        for &(_, x, y, animal) in candidates.iter().take(PATH_ATTEMPTS) {
            // La bête bouge : le chemin sera refait au fil des ticks. Ici on
            // vérifie seulement qu'elle est atteignable, pour qu'un éleveur ne
            // parte pas après un cerf de l'autre rive.
            if chebyshev(from, (x, y)) > 1 && self.colonist_adjacent(from, (x, y)).is_none() {
                continue;
            }
            let Some(p) = self.colonist_path(from, (sx, sy)) else {
                return false;
            };
            let pawn = self.pawns[i].id;
            self.items[k].reserved_by = Some(pawn);
            let item = self.items[k].id;
            self.pawns[i].set_path(p);
            self.pawns[i].job = Job::Tame {
                animal,
                item,
                picked: false,
                progress: 0,
            };
            return true;
        }
        false
    }

    /// Va chercher le fourrage, rejoint la bête, l'amadoue — ou la fait fuir.
    pub(crate) fn do_tame(
        &mut self,
        i: usize,
        animal: u32,
        item: u32,
        picked: bool,
        progress: u32,
    ) {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == animal && p.is_alive() && p.tame_marked)
        else {
            // Bête morte, apprivoisée par un autre, ou ordre annulé.
            self.abandon_job(i);
            return;
        };
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            self.pick_fodder(i, animal, item);
            return;
        }
        if self.pawns[i].carrying.is_none() {
            self.abandon_job(i);
            return;
        }
        let them = self.pawns[k].tile();
        if chebyshev(here, them) > TAME_REACH {
            // La bête s'est éloignée : on la rejoint, comme un chasseur
            // (`Sim::engage`) mais sans lever la main sur elle.
            let stale = self.pawns[i]
                .path
                .first()
                .is_none_or(|&(dx, dy)| chebyshev((u32::from(dx), u32::from(dy)), them) > 1);
            if stale {
                match self.colonist_adjacent(here, them) {
                    Some(p) => self.pawns[i].set_path(p),
                    None => {
                        self.abandon_job(i);
                        return;
                    }
                }
            }
            self.pawns[i].advance(&self.map);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Farm);
        self.gain_xp(i, WorkType::Farm);
        if progress < TAME_TICKS * 100 {
            self.pawns[i].job = Job::Tame {
                animal,
                item,
                picked: true,
                progress,
            };
            return;
        }
        self.resolve_tame(i, k, animal);
    }

    /// Ramasse la ration réservée et met le cap sur la bête.
    fn pick_fodder(&mut self, i: usize, animal: u32, item: u32) {
        let here = self.pawns[i].tile();
        let Some(j) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        if (self.items[j].x, self.items[j].y) != here || self.items[j].count < TAME_FOOD {
            self.abandon_job(i);
            return;
        }
        let kind = self.items[j].kind;
        self.items[j].count -= TAME_FOOD;
        self.items[j].reserved_by = None;
        if self.items[j].count == 0 {
            self.items.remove(j);
        }
        self.pawns[i].carrying = Some((kind, TAME_FOOD));
        let Some(them) = self.pawns.iter().find(|p| p.id == animal).map(|p| p.tile()) else {
            self.abandon_job(i);
            return;
        };
        // Assez près pour travailler tout de suite : pas de chemin à poser.
        if chebyshev(here, them) <= TAME_REACH {
            self.pawns[i].job = Job::Tame {
                animal,
                item,
                picked: true,
                progress: 0,
            };
            return;
        }
        match self.colonist_adjacent(here, them) {
            Some(p) => {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Tame {
                    animal,
                    item,
                    picked: true,
                    progress: 0,
                };
            }
            None => self.abandon_job(i),
        }
    }

    /// Le dé : la ration est mangée quoi qu'il arrive. Réussi, la bête entre
    /// dans la colonie ; raté, elle garde son marquage et personne ne
    /// réessaiera avant `TAME_RETRY` — un sanglier, lui, peut charger.
    fn resolve_tame(&mut self, i: usize, k: usize, animal: u32) {
        // La nourriture est consommée : elle ne retourne pas au stock.
        self.pawns[i].carrying = None;
        self.pawns[i].job = Job::Idle;
        let species = self.pawns[k].species.unwrap_or(Species::Deer);
        let level = self.pawns[i].skills[WorkType::Farm as usize].level;
        let chance = tame_chance(species, level);
        if self.rng.chance(chance, TAME_BASE_DEN) {
            self.tame_pawn(animal);
            self.push_event(EventKind::Tamed, species as u32);
            return;
        }
        self.pawns[k].tame_retry_at = self.tick + u64::from(TAME_RETRY);
        if species.aggressive() && self.rng.chance(1, BOAR_BACKLASH_CHANCE) {
            // La riposte existante : `animal_hit` sur une bête agressive pose
            // `Job::Attack` et annonce la charge.
            let tamer = self.pawns[i].id;
            self.animal_hit(k, Some(tamer));
        }
    }

    // ------------------------------------------------------------------
    // Abattage
    // ------------------------------------------------------------------

    /// Va abattre la bête marquée la plus proche. Court-circuit avant tout
    /// tri : rien de marqué sur la carte.
    pub(crate) fn try_start_slaughter(&mut self, i: usize) -> bool {
        if !self
            .pawns
            .iter()
            .any(|p| p.slaughter_marked && p.is_livestock() && p.is_alive())
        {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if !p.slaughter_marked || !p.is_livestock() || !p.is_alive() {
                continue;
            }
            if self.animal_handled_by_other(i, p.id) {
                continue;
            }
            let (x, y) = p.tile();
            candidates.push((chebyshev(from, (x, y)), x, y, p.id));
        }
        candidates.sort_unstable();
        for &(d, x, y, animal) in candidates.iter().take(PATH_ATTEMPTS) {
            if d <= 1 || self.colonist_adjacent(from, (x, y)).is_some() {
                self.pawns[i].path.clear();
                self.pawns[i].job = Job::Slaughter {
                    animal,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    /// Rejoint la bête et l'abat. Aucun coup n'est porté et aucune compétence
    /// de combat ne monte : ce n'est pas une chasse, c'est du travail
    /// d'éleveur.
    pub(crate) fn do_slaughter(&mut self, i: usize, animal: u32, progress: u32) {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == animal && p.is_alive() && p.slaughter_marked && p.is_livestock())
        else {
            self.abandon_job(i);
            return;
        };
        let here = self.pawns[i].tile();
        let them = self.pawns[k].tile();
        if chebyshev(here, them) > 1 {
            let stale = self.pawns[i]
                .path
                .first()
                .is_none_or(|&(dx, dy)| chebyshev((u32::from(dx), u32::from(dy)), them) > 1);
            if stale {
                match self.colonist_adjacent(here, them) {
                    Some(p) => self.pawns[i].set_path(p),
                    None => {
                        self.abandon_job(i);
                        return;
                    }
                }
            }
            self.pawns[i].advance(&self.map);
            return;
        }
        self.pawns[i].path.clear();
        let progress = progress + self.pawns[i].work_step(WorkType::Farm);
        self.gain_xp(i, WorkType::Farm);
        if progress < SLAUGHTER_TICKS * 100 {
            self.pawns[i].job = Job::Slaughter { animal, progress };
            return;
        }
        // Une atteinte vitale au maximum : `Pawn::recompute_hp` met les PV à
        // zéro pour de bon, et `Sim::remove_dead` laisse la dépouille et
        // annonce `EventKind::Slaughtered` (le marquage le lui dit).
        self.pawns[k].injuries.clear();
        self.pawns[k].add_injury(BodyPart::Head, SEVERITY_MAX, 0);
        self.pawns[i].job = Job::Idle;
    }
}

/// Échéance de naissance par espèce, dans l'ordre de `Species::ALL`.
pub(crate) type BreedClock = [u64; SPECIES_COUNT];

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_chances_d_apprivoisement_sont_ordonnees() {
        // Le lapin est le plus facile, le sanglier le plus dur.
        let rabbit = tame_chance(Species::Rabbit, 0);
        let deer = tame_chance(Species::Deer, 0);
        let boar = tame_chance(Species::Boar, 0);
        assert!(boar < deer && deer < rabbit, "{boar} / {deer} / {rabbit}");
        assert_eq!(deer, TAME_BASE_NUM, "le cerf est la référence");
        // La compétence aide, sans jamais dépasser la certitude.
        for species in Species::ALL {
            assert!(
                tame_chance(species, 20) > tame_chance(species, 0),
                "{species:?} ne profite pas de la compétence"
            );
            assert!(tame_chance(species, 255) <= TAME_BASE_DEN);
        }
        // Chaque espèce se reproduit, et vaut quelque chose.
        for species in Species::ALL {
            assert!(species.breed_days() > 0);
            assert!(species.wealth_value() > 0);
        }
        assert!(is_fodder(ItemKind::Berries) && is_fodder(ItemKind::Vegetables));
        assert!(!is_fodder(ItemKind::Meal) && !is_fodder(ItemKind::Meat));
    }
}
