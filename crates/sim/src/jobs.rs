//! Comportement des colons : besoins, recherche de travail, exécution des jobs.
//! Toutes les recherches parcourent des `Vec` dans l'ordre des indices et
//! départagent par distance puis coordonnées : déterministe.
//!
//! Ordre de priorité d'un colon libre : dormir > manger > les travaux dans
//! l'ordre réglé par le joueur (`Pawn::priorities`) > flâner.

use core::cmp::Reverse;

use crate::animals::Species;
use crate::build;
use crate::climate;
use crate::combat;
use crate::craft::{self, CraftStage};
use crate::farm::{self, Crop};
use crate::health::{HEMOSTASIS_TICKS, TEND_STEP, TEND_TICKS};
use crate::items::{FRESHNESS_MAX, ItemKind, ItemStack, STACK_MAX};
use crate::map::{Designation, Feature, Zone, chebyshev};
use crate::path::{self, Walker};
use crate::pawn::{
    BREAK_TICKS, Faction, HUNGER_DECAY, Job, MOOD_BREAK, NEED_MAX, RELIEF_TICKS, REST_DECAY,
    REST_RECOVERY, RESTED,
};
use crate::research::{self, RESEARCH_SESSION};
use crate::traits::{self, Trait};
use crate::work::{self, WorkType};
use crate::{EventKind, Sim, TICKS_PER_DAY, Tech, Weather};

/// Nombre maximal de candidats pour lesquels on tente un A* par recherche.
pub(crate) const PATH_ATTEMPTS: usize = 6;

/// Cadence de réessai des recherches de travail qui visent un **poste** ou une
/// **cible** dont rien ne garantit qu'elle soit atteignable : dépeçage,
/// fabrication, fonte, recherche, chasse, réarmement. Une demi-seconde de jeu.
///
/// Ce qui coûte n'est pas l'A\* qui aboutit — il s'arrête sur sa cible — mais
/// celui qui **échoue** : il explore toute la région où se tient le colon
/// avant de rendre `None`. Entre deux essais, ni les murs, ni les postes, ni
/// les régions de la carte ne bougent : un colon inactif qui recherche à
/// chaque tick paie trente fois le même prix pour la même réponse.
///
/// **Sans état ajouté.** Le pas se lit dans `Sim::tick`, l'identité du colon et
/// son `idle_ticks`, tous déjà sérialisés : rien de plus au snapshot, donc rien
/// de plus au hash. Et la cadence ne s'applique qu'au colon qui **tourne à
/// vide** — voir `Sim::job_retry_due`, qui dit pourquoi.
///
/// Contrairement à `fire::FIREFIGHT_RETRY`, la phase est **décalée par colon**
/// (`(tick + id) % RETRY_TICKS`) : aucun de ces travaux n'enchaîne deux
/// questions dans le même tick, on peut donc étaler la charge au lieu de faire
/// chercher tout le monde ensemble. C'est aussi ce qui rend la salve inutile
/// ici — deux colons ne testent presque jamais les mêmes postes au même tick
/// (voir `Sim::reach_station`).
pub const RETRY_TICKS: u64 = 30;
/// Un colon en crise ne change de direction que tous ces ticks.
const BREAK_WANDER_INTERVAL: u64 = 30;
/// Chance par tick qu'un colon au moral à zéro craque : une fois toutes les
/// dix secondes de jeu en moyenne.
const BREAK_CHANCE: u32 = 600;
/// Cadence d'évaluation de la péremption (voir `Sim::tick_spoilage`).
const SPOILAGE_INTERVAL: u64 = 60;

/// Ce qu'une case d'entrepôt accepte encore, dans l'ordre de
/// `Map::stockpile_tiles`. C'est `Sim::dest_accepts` mis à plat : le relevé se
/// fait en un passage sur les piles, au lieu d'un parcours des piles par case
/// examinée.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Slot {
    /// Aucune pile posée dessus : la case prend n'importe quel genre.
    Free,
    /// Une seule pile, non pleine : la case ne prend plus que ce genre.
    Partial(ItemKind),
    /// Plus rien ne s'y pose : pile pleine, mélange de genres, ou case
    /// devenue infranchissable.
    Taken,
}

impl Slot {
    fn accepts(self, kind: ItemKind) -> bool {
        match self {
            Slot::Free => true,
            Slot::Partial(k) => k == kind,
            Slot::Taken => false,
        }
    }

    /// Y a-t-il encore quelque chose à y poser, quel que soit le genre ?
    /// C'est le test de saturation de l'entrepôt.
    fn accepts_anything(self) -> bool {
        self != Slot::Taken
    }
}

/// Ce qu'une recherche de chemin **bornée** a pu conclure. Même distinction
/// que `fire::Beside`, et pour la même raison : seul `Unreachable` est une
/// démonstration — toutes les cases visées ont été essayées — et seule une
/// démonstration autorise à rayer la cible pour le reste de l'appel.
/// `OutOfBudget` ne dit rien : le budget s'est épuisé avant la fin.
enum Reach {
    /// Chemin trouvé.
    Path(Vec<path::Tile>),
    /// Toutes les cases visées ont été essayées, aucune n'est atteignable.
    Unreachable,
    /// Le budget d'A\* s'est épuisé avant la fin : on ne sait pas.
    OutOfBudget,
}

/// Minerai tiré d'un rocher veiné : `ORE_YIELD_MIN` à
/// `ORE_YIELD_MIN + ORE_YIELD_SPAN - 1` unités, soit deux ou trois. Un rocher
/// ordinaire rend quinze pierres : la veine paie en rareté, pas en volume.
pub const ORE_YIELD_MIN: u32 = 2;
pub const ORE_YIELD_SPAN: u32 = 2;

/// Production d'un travail terminé, **sur l'élément qui vient d'être abattu** :
/// un rocher veiné rend du minerai là où un rocher ordinaire rend de la pierre.
/// `None` pour ce qui ne produit rien. Le compte annoncé est le **minimum** :
/// seul le minerai y ajoute un tirage (voir `Sim::do_work`).
fn yield_of(kind: Designation, feature: Feature) -> Option<(ItemKind, u32)> {
    match kind {
        Designation::Chop => Some((ItemKind::Wood, 20)),
        Designation::Mine if feature == Feature::OreRock => Some((ItemKind::Ore, ORE_YIELD_MIN)),
        Designation::Mine => Some((ItemKind::Stone, 15)),
        Designation::Harvest => Some((ItemKind::Berries, 8)),
        Designation::None => None,
    }
}

impl Sim {
    pub(crate) fn tick_pawn(
        &mut self,
        i: usize,
        outdoor: i32,
        corpses: u32,
        salvo: &mut crate::fire::Salvo,
    ) {
        if !self.pawns[i].is_alive() {
            return;
        }
        self.pawns[i].outdoor_storm = self.weather == Weather::Storm;
        // Sert à `Trait::NightOwl` (`Pawn::work_step`) : la vitesse de
        // travail ne voit que le pawn, pas l'horloge du sim.
        self.pawns[i].is_night = self.is_night();
        self.tick_comfort(i, outdoor);
        self.tick_health(i);
        // Une hémorragie peut avoir tué le pawn à l'instant : il sera retiré
        // en fin de tick, il n'agit plus.
        if !self.pawns[i].is_alive() {
            return;
        }
        if self.pawns[i].faction == Faction::Raider {
            // Un pillard à terre reste à terre : il ne combat plus et ne fuit
            // plus, il attend de se relever (ou de mourir).
            if self.pawns[i].is_downed() {
                return;
            }
            // Les pillards ne mangent ni ne dorment : ils viennent, ils frappent.
            match self.pawns[i].job.clone() {
                Job::Attack { target } => self.do_attack(i, target),
                Job::Flee => self.do_flee(i),
                // Un assiégeant patiente à son point d'entrée.
                Job::Wait { until } => self.do_wait(i, until),
                _ => self.raider_ai(i),
            }
            return;
        }
        // Le marchand de passage : il ne mange pas, ne dort pas, ne travaille
        // pas. Il marche jusqu'à son étal, attend, puis repart (voir `trade`).
        if self.pawns[i].faction == Faction::Trader {
            self.trader_ai(i);
            return;
        }
        // La faune : boucle courte elle aussi, sans besoin ni recherche de
        // job. Le test porte sur l'**espèce**, pas sur la faction : une bête
        // apprivoisée est de `Faction::Colony` (voir `livestock`) et n'a pour
        // autant ni tableau de travail, ni humeur, ni repas au réfectoire.
        if self.pawns[i].species.is_some() {
            self.animal_ai(i);
            return;
        }
        // Sert à `Trait::Coward` et `Trait::Sociable` (`Pawn::mood`) : deux
        // recopies de plus dans le même esprit qu'`outdoor_storm`.
        let my_id = self.pawns[i].id;
        self.pawns[i].enemy_present = self.raider_alive();
        self.pawns[i].other_colonists_alive = self
            .pawns
            .iter()
            .filter(|p| p.is_alive() && p.is_colonist() && p.id != my_id)
            .count() as u32;
        self.pawns[i].corpses_on_map = corpses;
        self.decay_needs(i);
        // À terre : plus de défense, plus de crise, plus de recherche de job.
        // Sa position, s'il est porté, est recopiée par le porteur.
        if self.pawns[i].is_downed() {
            return;
        }
        self.defend_if_threatened(i);
        if self.pawns[i].is_starving()
            && !matches!(
                self.pawns[i].job,
                Job::Eat { .. }
                    | Job::Sleep { .. }
                    | Job::Move { manual: true }
                    | Job::Attack { .. }
            )
            && self.food_available()
        {
            self.abandon_job(i);
        }
        // Le feu qui menace la colonie fait tout lâcher, comme la famine
        // ci-dessus : un colon qui range du bois pendant que le toit brûle n'a
        // aucun sens. Court-circuité par `Map::fire_count` (voir `fire`).
        self.drop_work_for_fire(i, salvo);
        self.break_if_desperate(i);
        match self.pawns[i].job.clone() {
            Job::Idle => self.find_job(i, salvo),
            Job::Move { .. } => {
                self.pawns[i].advance(&self.map);
                if !self.pawns[i].is_moving() {
                    self.pawns[i].job = Job::Idle;
                }
            }
            Job::Work {
                kind,
                x,
                y,
                progress,
            } => self.do_work(i, kind, x, y, progress),
            Job::Haul { item, dest, picked } => self.do_haul(i, item, dest, picked),
            Job::Eat { item } => self.do_eat(i, item),
            Job::Sleep { in_bed } => self.do_sleep(i, in_bed),
            Job::Deliver {
                blueprint,
                item,
                picked,
            } => self.do_deliver(i, blueprint, item, picked),
            Job::Build { blueprint } => self.do_build(i, blueprint),
            Job::Farm {
                sow,
                x,
                y,
                progress,
            } => self.do_farm(i, sow, x, y, progress),
            Job::Cook {
                campfire,
                item,
                picked,
                progress,
            } => self.do_cook(i, campfire, item, picked, progress),
            Job::Attack { target } => self.do_attack(i, target),
            Job::Flee => self.do_flee(i),
            Job::Break { until } => self.do_break(i, until),
            Job::Rescue { target, picked } => self.do_rescue(i, target, picked),
            Job::Tend { target, progress } => self.do_tend(i, target, progress),
            Job::Craft {
                spot,
                recipe,
                stage,
            } => self.do_craft(i, spot, recipe, stage),
            Job::Equip { item } => self.do_equip(i, item),
            Job::Hunt { target } => self.do_hunt(i, target),
            Job::Butcher {
                spot,
                item,
                picked,
                progress,
            } => self.do_butcher(i, spot, item, picked, progress),
            Job::Bury {
                corpse,
                grave,
                picked,
            } => self.do_bury(i, corpse, grave, picked),
            Job::Research { bench } => self.do_research(i, bench),
            Job::Chat { with, ticks } => self.do_chat(i, with, ticks),
            Job::RearmTrap { at, progress } => self.do_rearm(i, at, progress),
            Job::Firefight { at, progress } => self.do_firefight(i, at, progress),
            Job::Tame {
                animal,
                item,
                picked,
                progress,
            } => self.do_tame(i, animal, item, picked, progress),
            Job::Slaughter { animal, progress } => self.do_slaughter(i, animal, progress),
            // Traité plus haut : un pawn à terre ne passe jamais par ici.
            Job::Downed => {}
            // Réservé aux assiégeants (traités plus haut) : un colon n'attend
            // jamais. S'il s'en trouvait un, il reprendrait le travail.
            Job::Wait { .. } => self.pawns[i].job = Job::Idle,
        }
    }

    /// Un colon au bout du rouleau finit par tout lâcher. La défense
    /// automatique reste prioritaire : elle abandonne la crise.
    fn break_if_desperate(&mut self, i: usize) {
        if self.pawns[i].mood() >= MOOD_BREAK
            || matches!(
                self.pawns[i].job,
                Job::Break { .. }
                    | Job::Sleep { .. }
                    | Job::Eat { .. }
                    | Job::Attack { .. }
                    | Job::Move { manual: true }
            )
            || !self.rng.chance(1, BREAK_CHANCE)
        {
            return;
        }
        self.abandon_job(i);
        let until = self.tick + u64::from(BREAK_TICKS);
        self.pawns[i].job = Job::Break { until };
        let id = self.pawns[i].id;
        self.push_event(EventKind::ColonistBreak, id);
    }

    /// Pendant une crise, le colon erre au hasard autour de lui.
    fn do_break(&mut self, i: usize, until: u64) {
        if self.tick >= until {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
            self.pawns[i].relief_ticks = RELIEF_TICKS;
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if self.tick % BREAK_WANDER_INTERVAL != 0 || !self.rng.chance(1, 3) {
            return;
        }
        let (px, py) = self.pawns[i].tile();
        let tx = px as i32 + self.rng.range_i32(-6, 7);
        let ty = py as i32 + self.rng.range_i32(-6, 7);
        if !self.map.in_bounds(tx, ty) || !self.map.passable(tx as u32, ty as u32) {
            return;
        }
        // Le chemin est posé, mais le job reste la crise jusqu'à son terme.
        if let Some(path) = self.colonist_path((px, py), (tx as u32, ty as u32))
            && !path.is_empty()
        {
            self.pawns[i].set_path(path);
        }
    }

    fn decay_needs(&mut self, i: usize) {
        let p = &self.pawns[i];
        let sleeping = matches!(p.job, Job::Sleep { .. }) && !p.is_moving();
        let in_bed = matches!(p.job, Job::Sleep { in_bed: true });
        // Un gourmand a plus d'appétit : sa faim décline plus vite, éveillé
        // comme endormi.
        let gourmand = p.has_trait(Trait::Gourmand);
        let p = &mut self.pawns[i];
        let hunger_decay = if sleeping {
            HUNGER_DECAY / 2
        } else {
            HUNGER_DECAY
        };
        let hunger_decay = if gourmand {
            hunger_decay * traits::GOURMAND_HUNGER_PERCENT / 100
        } else {
            hunger_decay
        };
        p.hunger = p.hunger.saturating_sub(hunger_decay);
        if sleeping {
            let recovery = if in_bed {
                REST_RECOVERY * 3 / 2
            } else {
                REST_RECOVERY
            };
            p.rest = (p.rest + recovery).min(NEED_MAX);
        } else {
            p.rest = p.rest.saturating_sub(REST_DECAY);
        }
    }

    /// Hors de la plage `traits::DAY_START_HOUR`-`traits::DAY_END_HOUR` :
    /// sert à `Trait::NightOwl`, recopié par pawn à chaque tick
    /// (`Pawn::is_night`) puisque `Pawn::work_step` ne voit que le pawn.
    fn is_night(&self) -> bool {
        let t = self.time_of_day();
        let day_start = TICKS_PER_DAY * traits::DAY_START_HOUR / 24;
        let day_end = TICKS_PER_DAY * traits::DAY_END_HOUR / 24;
        !(day_start..day_end).contains(&t)
    }

    fn food_available(&self) -> bool {
        self.items
            .iter()
            .any(|s| s.kind.is_food() && s.reserved_by.is_none())
    }

    /// Libère réservations et objets portés, remet le colon à l'arrêt.
    pub(crate) fn abandon_job(&mut self, i: usize) {
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        for s in &mut self.items {
            if s.reserved_by == Some(id) {
                s.reserved_by = None;
            }
        }
        for b in &mut self.blueprints {
            if b.reserved_by == Some(id) {
                b.reserved_by = None;
            }
        }
        self.drop_carried(i);
        // Un porteur qui lâche son job repose le blessé là où il en est.
        self.pawns[i].carrying_pawn = None;
        self.pawns[i].path.clear();
        self.pawns[i].job = Job::Idle;
    }

    fn drop_carried(&mut self, i: usize) {
        if let Some((kind, count)) = self.pawns[i].carrying.take() {
            let (x, y) = self.pawns[i].tile();
            self.spawn_item(kind, count, x, y);
        }
    }

    /// Fait progresser d'un cran la compétence associée à un tick de travail
    /// effectif. Appelée par `do_work`, `do_build`, `do_farm`, `do_cook` et
    /// `do_research` ;
    /// jamais par `do_haul`/`do_deliver`, qui n'ont pas de barre de
    /// progression et ne font donc jamais gagner d'XP au transport.
    pub(crate) fn gain_xp(&mut self, i: usize, work: WorkType) {
        let id = self.pawns[i].id;
        let skill = &mut self.pawns[i].skills[work as usize];
        skill.xp += 1;
        if skill.xp >= work::xp_to_next(skill.level) && skill.level < work::SKILL_MAX {
            skill.level += 1;
            skill.xp = 0;
            self.push_event(EventKind::LevelUp, id);
        }
    }

    // ------------------------------------------------------------------
    // Recherche de travail
    // ------------------------------------------------------------------

    fn find_job(&mut self, i: usize, salvo: &mut crate::fire::Salvo) {
        if self.pawns[i].is_tired() {
            self.start_sleep(i);
            return;
        }
        if self.pawns[i].is_hungry() && self.try_start_eat(i) {
            return;
        }
        // Le feu passe avant tout le reste — secours compris : un blessé ne
        // sera pas mieux au lit dans une colonie qui brûle. Seuls les besoins
        // critiques ci-dessus le devancent : un colon épuisé ou affamé ne bat
        // pas les flammes.
        if self.try_start_firefight(i, salvo) {
            return;
        }
        // Un blessé qui saigne se panse **là où il est tombé**. Le porter au
        // lit d'abord lui coûte exactement le sang qu'on venait lui garder :
        // sur les morts d'après-raid mesurées, une sur quatre survenait
        // pendant le transport (constat n°5). Le lit attend l'hémostase.
        if self.try_start_tend(i, true) {
            return;
        }
        // Le secours passe avant tout travail, mais après ses propres besoins :
        // un colon épuisé ou affamé ne porte personne.
        if self.try_start_rescue(i) {
            return;
        }
        if self.try_start_tend(i, false) {
            return;
        }
        // S'armer passe avant le travail : un colon désarmé qui part couper du
        // bois pendant qu'un arc l'attend en stockage n'a aucun sens.
        if self.try_start_equip(i) {
            return;
        }
        // Priorité 1 d'abord, et à priorité égale l'ordre de `WorkType::ORDER`.
        for prio in 1..=4 {
            for work in WorkType::ORDER {
                if self.pawns[i].priorities[work as usize] == prio && self.try_start(work, i) {
                    return;
                }
            }
        }
        // Plus rien à faire : c'est le moment de bavarder. Le bavardage n'est
        // pas un travail (aucun `WorkType`, aucune priorité) mais un besoin
        // social, essayé juste avant de flâner (voir `social`).
        if self.try_start_chat(i) {
            return;
        }
        self.idle_wander(i);
    }

    /// Tente de démarrer un travail de la famille demandée.
    fn try_start(&mut self, work: WorkType, i: usize) -> bool {
        match work {
            // La fabrication est du travail de constructeur : elle suit la même
            // priorité et la même compétence, après les chantiers en cours.
            // Le réarmement d'un piège se glisse entre les deux : c'est de la
            // défense, elle passe avant la tunique de rechange, mais un
            // chantier déjà lancé passe avant elle.
            WorkType::Build => {
                self.try_start_build(i) || self.try_start_rearm(i) || self.try_start_craft(i)
            }
            WorkType::Deliver => self.try_start_deliver(i),
            // Le dépeçage suit la cuisine : même compétence, même urgence
            // (la viande se gâte), mais après les repas déjà lancés.
            WorkType::Cook => self.try_start_cook(i) || self.try_start_butcher(i),
            // La chasse est du travail désigné : le joueur la demande bête par
            // bête (`Command::Hunt`) plutôt que case par case, mais c'est la
            // même priorité et la même place dans le tableau de travail.
            WorkType::Designated => self.try_start_work(i) || self.try_start_hunt(i),
            // L'élevage est du travail d'agriculteur (voir `livestock`) :
            // aucun type de travail de plus, donc ni `WORK_TYPES` ni les
            // tampons de priorités ne bougent. Le champ passe d'abord — un
            // plant mûr ne se garde pas — puis l'abattoir, puis
            // l'apprivoisement, qui est le plus long et le moins pressé.
            //
            // Les deux dernières visent une **bête**, donc une case qui bouge :
            // elles vérifient l'accès par `colonist_adjacent`, six candidates
            // fois huit voisines, et le refaisaient à chaque tick tant qu'une
            // bête marquée restait de l'autre côté d'un ruisseau. La cadence
            // (`RETRY_TICKS`) se pose ici plutôt que dans `livestock` : c'est
            // le seul endroit où les deux recherches se lisent ensemble, et
            // elles répondent au même ordre du joueur.
            WorkType::Farm => {
                self.try_start_farm(i)
                    || (self.job_retry_due(i)
                        && (self.try_start_slaughter(i) || self.try_start_tame(i)))
            }
            WorkType::Research => self.try_start_research(i),
            // Enterrer un cadavre suit le rangement : même priorité, même
            // urgence relative — la colonie range d'abord ce qui se range,
            // puis s'occupe de ses morts.
            WorkType::Haul => self.try_start_haul(i) || self.try_start_bury(i),
        }
    }

    /// Flâner autour de soi de temps en temps.
    fn idle_wander(&mut self, i: usize) {
        self.pawns[i].idle_ticks += 1;
        if self.pawns[i].idle_ticks < 90 || !self.rng.chance(1, 45) {
            return;
        }
        let (px, py) = self.pawns[i].tile();
        let tx = px as i32 + self.rng.range_i32(-7, 8);
        let ty = py as i32 + self.rng.range_i32(-7, 8);
        if !self.map.in_bounds(tx, ty) || !self.map.passable(tx as u32, ty as u32) {
            return;
        }
        if let Some(path) = self.colonist_path((px, py), (tx as u32, ty as u32))
            && !path.is_empty()
        {
            self.pawns[i].set_path(path);
            self.pawns[i].job = Job::Move { manual: false };
        }
    }

    /// Va dormir dans le lit libre le plus proche, sinon au sol sur place.
    fn start_sleep(&mut self, i: usize) {
        let from = self.pawns[i].tile();
        let mut beds: Vec<(u32, u32, u32)> = Vec::new();
        if self.map.bed_count() == 0 {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Sleep { in_bed: false };
            return;
        }
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                // Un lit réservé attend un blessé qu'on est en train de porter.
                if self.map.feature(x, y) == Feature::Bed
                    && !self.bed_occupied_by_other(i, (x, y))
                    && !self.is_reserved(x, y)
                {
                    beds.push((chebyshev(from, (x, y)), x, y));
                }
            }
        }
        beds.sort_unstable();
        for &(_, x, y) in beds.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.colonist_path(from, (x, y)) {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Sleep { in_bed: true };
                return;
            }
        }
        self.pawns[i].path.clear();
        self.pawns[i].job = Job::Sleep { in_bed: false };
    }

    fn bed_occupied_by_other(&self, i: usize, bed: (u32, u32)) -> bool {
        self.pawns.iter().enumerate().any(|(k, p)| {
            k != i
                && p.tile() == bed
                && (p.is_downed() || matches!(p.job, Job::Sleep { in_bed: true }) && !p.is_moving())
        })
    }

    // ------------------------------------------------------------------
    // Secours : porter les blessés au lit, panser les plaies
    // ------------------------------------------------------------------

    /// Un colon déjà chargé de ce blessé (porteur ou soignant) ?
    fn already_handled(&self, target: u32) -> bool {
        self.pawns.iter().any(|p| match p.job {
            Job::Rescue { target: t, .. } | Job::Tend { target: t, .. } => t == target,
            _ => false,
        })
    }

    /// Lit libre le plus proche de `near`, atteignable depuis là. Réservé pour
    /// un blessé donné : le lit où il gît déjà ne compte pas comme occupé.
    fn find_free_bed(&self, near: (u32, u32), patient: u32) -> Option<(u32, u32)> {
        let mut beds: Vec<(u32, u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) != Feature::Bed || self.is_reserved(x, y) {
                    continue;
                }
                let taken = self.pawns.iter().any(|p| {
                    p.id != patient
                        && p.tile() == (x, y)
                        && (p.is_downed()
                            || matches!(p.job, Job::Sleep { in_bed: true }) && !p.is_moving())
                });
                if !taken {
                    beds.push((chebyshev(near, (x, y)), x, y));
                }
            }
        }
        beds.sort_unstable();
        beds.iter()
            .take(PATH_ATTEMPTS)
            .find(|&&(_, x, y)| self.colonist_path(near, (x, y)).is_some())
            .map(|&(_, x, y)| (x, y))
    }

    /// Va chercher un colon à terre pour le porter dans un lit. Sans lit sur la
    /// carte, on le laisse où il est : il sera soigné au sol.
    fn try_start_rescue(&mut self, i: usize) -> bool {
        // Deux tests qui court-circuitent le cas courant : pas de lit à viser,
        // ou personne au sol. Un colon inactif repasse ici à chaque tick.
        if self.map.bed_count() == 0 || !self.pawns.iter().any(|p| p.is_downed()) {
            return false;
        }
        let me = self.pawns[i].id;
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if p.id == me || !p.is_colonist() || !p.is_alive() || !p.is_downed() {
                continue;
            }
            let (x, y) = p.tile();
            // Déjà au lit : rien à faire de plus pour lui.
            if self.map.feature(x, y) == Feature::Bed || self.already_handled(p.id) {
                continue;
            }
            candidates.push((chebyshev(from, (x, y)), x, y, p.id));
        }
        candidates.sort_unstable();
        for &(_, x, y, target) in candidates.iter().take(PATH_ATTEMPTS) {
            let Some(bed) = self.find_free_bed((x, y), target) else {
                continue;
            };
            let Some(p) = self.path_to_work(from, (x, y)) else {
                continue;
            };
            // Le lit est réservé par `reservations` ; le blessé, lui, l'est par
            // le job du porteur (`already_handled`) : sa case bouge pendant le
            // transport, une réservation de case ne le suivrait pas.
            self.reservations.push(Reservation {
                x: bed.0,
                y: bed.1,
                pawn: me,
            });
            self.pawns[i].set_path(p);
            self.pawns[i].job = Job::Rescue {
                target,
                picked: false,
            };
            return true;
        }
        false
    }

    /// Case réservée par ce colon (le lit visé par un sauvetage).
    fn reserved_tile(&self, pawn: u32) -> Option<(u32, u32)> {
        self.reservations
            .iter()
            .find(|r| r.pawn == pawn)
            .map(|r| (r.x, r.y))
    }

    fn do_rescue(&mut self, i: usize, target: u32, picked: bool) {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == target && p.is_alive() && p.is_downed())
        else {
            // Mort, ou relevé tout seul : on le repose et on passe à autre chose.
            self.abandon_job(i);
            return;
        };
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            if picked {
                self.carry_along(i, k);
            }
            return;
        }
        if !picked {
            let me = self.pawns[i].tile();
            if chebyshev(me, self.pawns[k].tile()) > 1 {
                self.abandon_job(i);
                return;
            }
            let id = self.pawns[i].id;
            let Some(bed) = self.reserved_tile(id) else {
                self.abandon_job(i);
                return;
            };
            let Some(p) = self.colonist_path(me, bed) else {
                self.abandon_job(i);
                return;
            };
            self.pawns[i].carrying_pawn = Some(target);
            self.pawns[i].set_path(p);
            self.pawns[i].job = Job::Rescue {
                target,
                picked: true,
            };
            self.pawns[k].path.clear();
            self.carry_along(i, k);
            return;
        }
        // Arrivé au lit : on dépose.
        self.carry_along(i, k);
        self.pawns[i].carrying_pawn = None;
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
        self.push_event(EventKind::ColonistRescued, target);
    }

    /// Le blessé porté occupe la case de son porteur.
    fn carry_along(&mut self, carrier: usize, carried: usize) {
        let (x, y) = (self.pawns[carrier].x, self.pawns[carrier].y);
        self.pawns[carried].x = x;
        self.pawns[carried].y = y;
    }

    /// Va panser un colon blessé. **Triage** : celui qui se vide le plus vite
    /// d'abord (`Pawn::ticks_to_bleed_out`), à terre avant debout, puis le
    /// plus proche. On ne se soigne pas soi-même.
    ///
    /// `bleeding_only` restreint aux hémorragies : c'est le passage qui
    /// devance le secours dans `find_job`. Une écorchure, elle, attend son
    /// tour derrière le brancard.
    fn try_start_tend(&mut self, i: usize, bleeding_only: bool) -> bool {
        // Court-circuit : personne à panser, on ne compare rien.
        if !self
            .pawns
            .iter()
            .any(|p| p.needs_tending() && (!bleeding_only || p.is_bleeding()))
        {
            return false;
        }
        let me = self.pawns[i].id;
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if p.id == me
                || !p.is_colonist()
                || !p.is_alive()
                || !p.needs_tending()
                || (bleeding_only && !p.is_bleeding())
                || self.already_handled(p.id)
            {
                continue;
            }
            let (x, y) = p.tile();
            candidates.push((
                p.ticks_to_bleed_out(),
                u32::from(!p.is_downed()),
                chebyshev(from, (x, y)),
                x,
                y,
                p.id,
            ));
        }
        candidates.sort_unstable();
        for &(.., x, y, target) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.path_to_work(from, (x, y)) {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Tend {
                    target,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    fn do_tend(&mut self, i: usize, target: u32, progress: u32) {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == target && p.is_alive())
        else {
            self.abandon_job(i);
            return;
        };
        if !self.pawns[k].needs_tending() {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), self.pawns[k].tile()) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress =
            progress + research::tend_step(TEND_STEP, self.research.is_done(Tech::Medicine));
        // Premier quart du geste : on comprime. Le sang s'arrête bien avant
        // que la plaie soit bandée — c'est ce qui sauve. La blessure reste
        // « non pansée » pour autant : la séance continue jusqu'au bandage,
        // qui seul fait cicatriser plus vite.
        if progress >= HEMOSTASIS_TICKS * 100 {
            for inj in &mut self.pawns[k].injuries {
                inj.close();
            }
        }
        if progress < TEND_TICKS * 100 {
            self.pawns[i].job = Job::Tend { target, progress };
            return;
        }
        for inj in &mut self.pawns[k].injuries {
            inj.tended = true;
            inj.close();
        }
        // Le même chevet soigne la maladie : elle passe deux fois plus vite.
        self.tend_illness(k);
        self.pawns[i].job = Job::Idle;
        self.push_event(EventKind::ColonistTended, target);
    }

    /// Va manger la meilleure nourriture accessible : repas, puis baies, puis cru.
    fn try_start_eat(&mut self, i: usize) -> bool {
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.is_food() && s.reserved_by.is_none())
            .map(|(k, s)| (s.kind.food_rank(), chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        candidates.sort_unstable();
        for &(_, _, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.colonist_path(from, (x, y)) {
                let id = self.pawns[i].id;
                self.items[k].reserved_by = Some(id);
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Eat { item };
                return true;
            }
        }
        false
    }

    fn try_start_build(&mut self, i: usize) -> bool {
        if self.blueprints.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, usize)> = self
            .blueprints
            .iter()
            .enumerate()
            .filter(|(_, b)| b.ready() && b.reserved_by.is_none())
            .map(|(k, b)| (chebyshev(from, (b.x, b.y)), b.x, b.y, k))
            .collect();
        candidates.sort_unstable();
        for &(_, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
            let path = if self.blueprints[k].kind.adjacent_only() {
                self.colonist_adjacent(from, (x, y))
            } else {
                self.path_to_work(from, (x, y))
            };
            if let Some(p) = path {
                let id = self.pawns[i].id;
                self.blueprints[k].reserved_by = Some(id);
                let blueprint = self.blueprints[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Build { blueprint };
                return true;
            }
        }
        false
    }

    fn try_start_deliver(&mut self, i: usize) -> bool {
        if self.blueprints.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, usize)> = self
            .blueprints
            .iter()
            .enumerate()
            .filter(|(_, b)| b.missing() > 0 && b.reserved_by.is_none())
            .map(|(k, b)| (chebyshev(from, (b.x, b.y)), b.x, b.y, k))
            .collect();
        candidates.sort_unstable();
        let mut attempts = 0;
        for &(_, _, _, k) in &candidates {
            if attempts >= PATH_ATTEMPTS {
                break;
            }
            let wanted = self.blueprints[k].material.item_kind();
            // La pile la plus proche du colon, qui va d'abord la chercher.
            let mut stacks: Vec<(u32, u32, u32, usize)> = self
                .items
                .iter()
                .enumerate()
                .filter(|(_, s)| s.kind == wanted && s.reserved_by.is_none() && s.count > 0)
                .map(|(j, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, j))
                .collect();
            stacks.sort_unstable();
            let Some(&(_, sx, sy, j)) = stacks.first() else {
                continue;
            };
            attempts += 1;
            if let Some(p) = self.colonist_path(from, (sx, sy)) {
                let id = self.pawns[i].id;
                self.blueprints[k].reserved_by = Some(id);
                self.items[j].reserved_by = Some(id);
                let blueprint = self.blueprints[k].id;
                let item = self.items[j].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Deliver {
                    blueprint,
                    item,
                    picked: false,
                };
                return true;
            }
        }
        false
    }

    fn try_start_work(&mut self, i: usize) -> bool {
        if self.map.designation_count() == 0 {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                let d = self.map.designation(x, y);
                if d != Designation::None
                    && d.applies_to(self.map.feature(x, y))
                    && !self.is_reserved(x, y)
                {
                    candidates.push((chebyshev(from, (x, y)), x, y));
                }
            }
        }
        candidates.sort_unstable();
        for &(_, x, y) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.path_to_work(from, (x, y)) {
                let kind = self.map.designation(x, y);
                let pawn = self.pawns[i].id;
                self.reservations.push(Reservation { x, y, pawn });
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Work {
                    kind,
                    x,
                    y,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    /// Ce que le pawn `i` sait de la carte : la colonie connaît ses pièges à
    /// pointes et les contourne, personne d'autre ne les voit (voir
    /// `path::Walker`). Les **bêtes apprivoisées** en font partie : elles
    /// connaissent la maison et ne se plantent jamais sur les pointes (voir
    /// `livestock`, et `Sim::spring_trap` qui les épargne aussi).
    pub(crate) fn walker(&self, i: usize) -> Walker {
        if self.pawns[i].faction == Faction::Colony {
            Walker::COLONIST
        } else {
            Walker::ANYONE
        }
    }

    /// Chemin d'un colon. Tout ce module travaille pour la colonie —
    /// `tick_pawn` renvoie les pillards, les marchands et les bêtes vers leur
    /// propre boucle avant d'arriver ici — d'où le raccourci.
    pub(crate) fn colonist_path(
        &self,
        from: (u32, u32),
        to: (u32, u32),
    ) -> Option<Vec<path::Tile>> {
        path::find_path_for(&self.map, from, to, Walker::COLONIST)
    }

    /// Chemin d'un colon vers une voisine de la cible.
    pub(crate) fn colonist_adjacent(
        &self,
        from: (u32, u32),
        target: (u32, u32),
    ) -> Option<Vec<path::Tile>> {
        self.path_adjacent_for(from, target, Walker::COLONIST)
    }

    /// Chemin vers la cible si elle est franchissable, sinon vers une voisine.
    /// Toujours pour un colon, comme le reste du module.
    fn path_to_work(&self, from: (u32, u32), target: (u32, u32)) -> Option<Vec<path::Tile>> {
        if self.map.passable_for(target.0, target.1, Walker::COLONIST) {
            return self.colonist_path(from, target);
        }
        self.colonist_adjacent(from, target)
    }

    /// Chemin vers la case voisine franchissable la plus proche, pour
    /// quelqu'un qui ne connaît pas les pièges (pillard, bête, marchand).
    pub(crate) fn path_adjacent(
        &self,
        from: (u32, u32),
        target: (u32, u32),
    ) -> Option<Vec<path::Tile>> {
        self.path_adjacent_for(from, target, Walker::ANYONE)
    }

    /// Même chose pour un marcheur donné : une case voisine occupée par un
    /// piège armé n'est pas un poste de travail pour un colon.
    pub(crate) fn path_adjacent_for(
        &self,
        from: (u32, u32),
        target: (u32, u32),
        walker: Walker,
    ) -> Option<Vec<path::Tile>> {
        // Un poste hors d'atteinte est le pire cas de tout le module : huit
        // voisines franchissables, huit A\* qui explorent chacun toute la
        // région du marcheur avant de rendre `None`. L'index de régions raye
        // d'avance les voisines qui ne communiquent pas avec lui (voir
        // `crate::regions`) : quand elles le sont toutes, le poste est
        // démontré inatteignable sans un seul A\*. La voisine retenue en cas
        // de succès, elle, ne change pas — on ne retire que des candidates
        // dont l'A\* aurait échoué.
        let home = self.map.region_of_for(from.0, from.1, walker);
        let mut neighbours: Vec<(u32, u32, u32)> = Vec::new();
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = target.0 as i32 + dx;
                let ny = target.1 as i32 + dy;
                if self.map.in_bounds(nx, ny) && self.map.passable_for(nx as u32, ny as u32, walker)
                {
                    let n = (nx as u32, ny as u32);
                    if self.other_region(home, n, walker) {
                        continue;
                    }
                    neighbours.push((chebyshev(from, n), n.0, n.1));
                }
            }
        }
        neighbours.sort_unstable();
        neighbours
            .iter()
            .find_map(|&(_, x, y)| path::find_path_for(&self.map, from, (x, y), walker))
    }

    /// La case `to` est-elle **démontrée** hors de la région `home` du
    /// marcheur ? Faux dès qu'on ne sait pas — région de départ inconnue
    /// (case infranchissable : l'A\* n'y teste jamais la case de départ) ou
    /// index périmé —, auquel cas la candidate est gardée et l'A\* tranche.
    fn other_region(&self, home: Option<u16>, to: (u32, u32), walker: Walker) -> bool {
        match (home, self.map.region_of_for(to.0, to.1, walker)) {
            (Some(a), Some(b)) => a != b,
            _ => false,
        }
    }

    // ------------------------------------------------------------------
    // Recherches de chemin bornées (voir `RETRY_TICKS`)
    // ------------------------------------------------------------------

    /// Le colon `i` peut-il relancer une recherche de travail coûteuse ?
    ///
    /// **Oui tant qu'il ne tourne pas à vide.** `Pawn::idle_ticks` retombe à
    /// zéro dès qu'un colon prend un chemin, donc dès qu'il a trouvé à faire :
    /// celui qui enchaîne les besognes cherche à chaque tick comme avant,
    /// mêmes cibles, sans une seconde de retard. La distinction n'est pas
    /// cosmétique — c'est ce qui sépare cette cadence de celle du feu. Freiner
    /// un colon **occupé** ne l'aurait pas fait attendre : il serait tombé sur
    /// le travail suivant de `WorkType::ORDER`, où la recherche à l'établi est
    /// avant-dernière et le rangement dernier. Mesuré sur trente graines de
    /// campagne : la moitié des technologies en moins.
    ///
    /// **Non s'il n'a rien trouvé au tick précédent** : c'est exactement le cas
    /// pathologique — la même recherche, le même échec, soixante fois par
    /// seconde. Il repassera dans `RETRY_TICKS` ticks au plus, la phase décalée
    /// par son identité pour que les colons ne cherchent pas tous ensemble.
    ///
    /// **Sans état ajouté** : `idle_ticks`, le tick et l'identité sont déjà là
    /// et déjà sérialisés. Rien de plus au snapshot, donc rien de plus au hash.
    fn job_retry_due(&self, i: usize) -> bool {
        self.pawns[i].idle_ticks == 0
            || (self.tick + u64::from(self.pawns[i].id)) % RETRY_TICKS == 0
    }

    /// Chemin d'un colon vers une case, pour un essai du budget.
    ///
    /// Le budget compte des **candidats examinés**, pas des A\* : une case
    /// franchissable en vaut un, un poste en vaut un aussi bien qu'il coûte ses
    /// huit voisines (voir `reach_adjacent`). Compter les A\* serait plus fin
    /// mais rendrait un poste muré **indémontrable** — huit voisines pour six
    /// essais — donc jamais inscriptible au tableau des inatteignables, et la
    /// recherche buterait éternellement sur le même. `Sim::job_paths`, lui,
    /// compte bien les A\* : c'est la mesure, pas la borne.
    fn reach_tile(&mut self, from: (u32, u32), to: (u32, u32), budget: &mut usize) -> Reach {
        if *budget == 0 {
            return Reach::OutOfBudget;
        }
        *budget -= 1;
        // L'index de régions tranche en une lecture (voir `crate::regions`) :
        // la démonstration est la même que celle de l'A\*, sans l'A\*. Le
        // **budget** est consommé — le candidat a bien été examiné — mais le
        // compteur ne bouge pas, puisqu'il compte les A\* lancés.
        if self.map.same_region_for(from, to, Walker::COLONIST) == Some(false) {
            return Reach::Unreachable;
        }
        self.count_job_path(1);
        match self.colonist_path(from, to) {
            Some(p) => Reach::Path(p),
            None => Reach::Unreachable,
        }
    }

    /// Chemin d'un colon vers une voisine franchissable de `target`, la plus
    /// proche d'abord : version **bornée et comptée** de `colonist_adjacent`.
    ///
    /// C'est ici que se jouait le point chaud. `path_adjacent_for` essaie
    /// jusqu'à huit voisines et rend `None` quand aucune n'aboutit : sur un
    /// poste muré, c'est **huit** A\* qui explorent chacun toute la région du
    /// colon, et l'appelant recommençait au tick suivant. Le budget borne le
    /// nombre de postes examinés, `RETRY_TICKS` espace les tentatives, et
    /// `Sim::job_paths` compte ce que tout cela coûte vraiment.
    fn reach_adjacent(
        &mut self,
        from: (u32, u32),
        target: (u32, u32),
        budget: &mut usize,
    ) -> Reach {
        if *budget == 0 {
            return Reach::OutOfBudget;
        }
        *budget -= 1;
        // Même court-circuit que `path_adjacent_for` : les voisines qui ne
        // communiquent pas avec le colon ne sont pas essayées, et un poste
        // dont aucune voisine ne communique est démontré hors d'atteinte sans
        // un seul A\* (voir `crate::regions`). Le budget, lui, est déjà
        // consommé : il compte des **candidats examinés**, et l'examen a bien
        // eu lieu — il est simplement devenu gratuit.
        let home = self.map.region_of_for(from.0, from.1, Walker::COLONIST);
        let mut neighbours: Vec<(u32, u32, u32)> = Vec::new();
        for dy in -1i32..=1 {
            for dx in -1i32..=1 {
                if dx == 0 && dy == 0 {
                    continue;
                }
                let nx = target.0 as i32 + dx;
                let ny = target.1 as i32 + dy;
                if self.map.in_bounds(nx, ny)
                    && self
                        .map
                        .passable_for(nx as u32, ny as u32, Walker::COLONIST)
                {
                    let n = (nx as u32, ny as u32);
                    if self.other_region(home, n, Walker::COLONIST) {
                        continue;
                    }
                    neighbours.push((chebyshev(from, n), n.0, n.1));
                }
            }
        }
        neighbours.sort_unstable();
        for (_, x, y) in neighbours {
            self.count_job_path(1);
            if let Some(p) = path::find_path_for(&self.map, from, (x, y), Walker::COLONIST) {
                return Reach::Path(p);
            }
        }
        // Toutes les voisines tenables essayées, aucune n'aboutit : la cible
        // est hors d'atteinte, et c'est une démonstration — l'appelant peut la
        // rayer pour le reste de l'appel.
        Reach::Unreachable
    }

    /// Version bornée et comptée de `path_to_work` : sur la case si elle est
    /// franchissable, sinon sur une voisine.
    fn reach_work(&mut self, from: (u32, u32), target: (u32, u32), budget: &mut usize) -> Reach {
        if self.map.passable_for(target.0, target.1, Walker::COLONIST) {
            return self.reach_tile(from, target, budget);
        }
        self.reach_adjacent(from, target, budget)
    }

    /// Le poste le plus proche de `near` où le colon peut **effectivement** se
    /// poster, et le chemin pour y aller. Les postes sont départagés par
    /// `(distance, x, y)` comme partout ailleurs, et l'on s'arrête au premier
    /// atteignable.
    ///
    /// Sans cette vérification au démarrage, un colon retenait le poste le
    /// plus proche sans se demander s'il y menait un chemin : il partait
    /// chercher sa charge, la ramassait, découvrait le mur dans `do_butcher`
    /// ou `pick_ingredient`, reposait tout — et recommençait au tick suivant.
    ///
    /// `blocked` retient les postes démontrés hors d'atteinte **pendant cet
    /// appel** : la démonstration coûte cher et la réponse ne dépend pas de la
    /// charge à porter, un seul colon la paie une seule fois par salve. Ce
    /// n'est pas de l'état : la liste naît et meurt dans l'appelant.
    ///
    /// `from` est le point de départ du colon, `near` celui dont on mesure la
    /// distance (la dépouille à porter, par exemple). Les deux vivent dans la
    /// même région dès lors que l'appelant a vérifié qu'il pouvait rejoindre
    /// sa charge : tester depuis l'un ou l'autre donne la même réponse.
    fn reach_station(
        &mut self,
        from: (u32, u32),
        stations: &[(u32, u32)],
        near: (u32, u32),
        budget: &mut usize,
        blocked: &mut Vec<(u32, u32)>,
    ) -> Option<((u32, u32), Vec<path::Tile>)> {
        let mut sorted: Vec<(u32, u32, u32)> = stations
            .iter()
            .filter(|s| !blocked.contains(s))
            .map(|&(x, y)| (chebyshev(near, (x, y)), x, y))
            .collect();
        sorted.sort_unstable();
        for (_, x, y) in sorted {
            match self.reach_adjacent(from, (x, y), budget) {
                Reach::Path(p) => return Some(((x, y), p)),
                Reach::Unreachable => blocked.push((x, y)),
                Reach::OutOfBudget => return None,
            }
        }
        None
    }

    /// Cherche une pile au sol à porter à l'entrepôt.
    ///
    /// Trois court-circuits avant tout travail, du moins cher au plus cher :
    /// pas d'entrepôt du tout, entrepôt **saturé** (`Slot::accepts_anything`),
    /// et enfin la borne `PATH_ATTEMPTS` sur les candidats. Le relevé des
    /// cases d'entrepôt (`stockpile_slots`) est fait **une fois** pour tout
    /// l'appel : rien ne bouge entre deux candidats, et il remplace autant de
    /// balayages de carte qu'il y avait de piles au sol.
    fn try_start_haul(&mut self, i: usize) -> bool {
        if self.map.stockpile_count() == 0 {
            return false;
        }
        let slots = self.stockpile_slots();
        self.count_haul_scan(slots.len() as u64);
        // Entrepôt saturé : plus une case libre, plus une pile incomplète.
        // Aucun genre n'a de destination, inutile de trier les piles au sol.
        if !slots.iter().any(|s| s.accepts_anything()) {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.haulable() && s.reserved_by.is_none() && !self.is_stored(s))
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        candidates.sort_unstable();
        // `take` borne les candidats **examinés**, pas les seuls candidats
        // aboutis : une pile sans destination consomme un essai comme les
        // autres. Sans cela la borne ne s'arme jamais quand l'entrepôt ne
        // prend plus le genre à ranger, et la boucle traite **toutes** les
        // piles au sol, à chaque tick, pour chaque colon inactif.
        for &(_, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
            let kind = self.items[k].kind;
            self.count_haul_scan(slots.len() as u64);
            let Some(dest) = self.slot_dest(&slots, kind, (x, y)) else {
                continue;
            };
            if let Some(p) = self.colonist_path(from, (x, y)) {
                let id = self.pawns[i].id;
                self.items[k].reserved_by = Some(id);
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Haul {
                    item,
                    dest: Some(dest),
                    picked: false,
                };
                return true;
            }
        }
        false
    }

    /// Va chercher un cadavre humain non réservé et le porte jusqu'à la tombe
    /// vide la plus proche **de lui** (pas du colon : c'est elle qu'il va
    /// falloir porter). Une dépouille de bête n'est pas concernée
    /// (`ItemKind::is_animal_corpse`) : elle se dépèce, elle ne s'enterre pas.
    ///
    /// Trois court-circuits avant tout travail, du moins cher au plus cher —
    /// le même patron que `try_start_haul` : pas de tombe vide du tout
    /// (`grave_count`), aucun cadavre au sol, et aucune tombe **libre** (elles
    /// sont toutes réservées par un porteur en route). Le relevé des tombes
    /// part de `Map::grave_tiles`, jamais de la carte entière, et il est fait
    /// **une fois** pour tout l'appel : rien ne bouge d'un cadavre à l'autre.
    fn try_start_bury(&mut self, i: usize) -> bool {
        if self.map.grave_count() == 0
            || !self
                .items
                .iter()
                .any(|s| s.kind == ItemKind::Corpse && s.reserved_by.is_none() && s.count > 0)
        {
            return false;
        }
        let graves: Vec<(u32, u32)> = self
            .map
            .grave_tiles()
            .iter()
            .copied()
            .filter(|&(x, y)| !self.is_reserved(x, y))
            .collect();
        self.count_bury_scan(self.map.grave_tiles().len() as u64);
        // Toutes les tombes sont déjà promises : inutile de trier les cadavres.
        if graves.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut corpses: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind == ItemKind::Corpse && s.reserved_by.is_none() && s.count > 0)
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        corpses.sort_unstable();
        // `take` borne les candidats **examinés**, pas les seuls candidats
        // aboutis : un cadavre sans chemin consomme un essai comme les autres.
        for &(_, cx, cy, k) in corpses.iter().take(PATH_ATTEMPTS) {
            self.count_bury_scan(graves.len() as u64);
            let Some((gx, gy)) = graves
                .iter()
                .map(|&(x, y)| (chebyshev((cx, cy), (x, y)), x, y))
                .min()
                .map(|(_, x, y)| (x, y))
            else {
                continue;
            };
            if let Some(p) = self.colonist_path(from, (cx, cy)) {
                let pawn = self.pawns[i].id;
                self.items[k].reserved_by = Some(pawn);
                self.reservations.push(Reservation { x: gx, y: gy, pawn });
                let corpse = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Bury {
                    corpse,
                    grave: (gx, gy),
                    picked: false,
                };
                return true;
            }
        }
        false
    }

    fn do_bury(&mut self, i: usize, corpse: u32, grave: (u32, u32), picked: bool) {
        // La tombe visée doit rester vide et exister : sinon on repose le
        // cadavre où on en est et on retente ailleurs au prochain tick.
        if self.map.feature(grave.0, grave.1) != Feature::Grave {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            let Some(k) = self.items.iter().position(|s| s.id == corpse) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[k].x, self.items[k].y) != here || self.items[k].kind != ItemKind::Corpse
            {
                self.abandon_job(i);
                return;
            }
            // Un cadavre se porte à l'unité, comme une dépouille.
            self.items[k].count -= 1;
            self.items[k].reserved_by = None;
            if self.items[k].count == 0 {
                self.items.remove(k);
            }
            self.pawns[i].carrying = Some((ItemKind::Corpse, 1));
            // La tombe est franchissable : on marche dessus, comme pour un
            // stockage, plutôt que de s'arrêter à côté.
            match self.colonist_path(here, grave) {
                Some(p) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Bury {
                        corpse,
                        grave,
                        picked: true,
                    };
                }
                None => {
                    self.drop_carried(i);
                    self.pawns[i].job = Job::Idle;
                }
            }
            return;
        }
        if here != grave || self.pawns[i].carrying.is_none() {
            self.abandon_job(i);
            return;
        }
        self.pawns[i].carrying = None;
        self.map.set_feature(grave.0, grave.1, Feature::GraveFilled);
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
        // Un mort de moins à voir traîner : le deuil en cours se referme un
        // peu, comme un vrai enterrement.
        for p in &mut self.pawns {
            if p.is_colonist() {
                p.grief_ticks /= 2;
            }
        }
        self.push_event(EventKind::Buried, 0);
    }

    /// Une pile est rangée si elle est seule de son genre sur une case de stockage.
    fn is_stored(&self, s: &ItemStack) -> bool {
        self.map.zone(s.x, s.y) == Zone::Stockpile
            && self
                .items
                .iter()
                .all(|o| o.id == s.id || (o.x, o.y) != (s.x, s.y) || o.kind == s.kind)
    }

    /// Relevé de ce que chaque case d'entrepôt accepte encore, dans l'ordre de
    /// `Map::stockpile_tiles`. Un seul passage sur les piles (le test de zone
    /// est en temps constant, les cases hors entrepôt sortent tout de suite)
    /// et un sur les cases d'entrepôt : c'est ce qui remplace le balayage de
    /// carte, et c'est aussi le court-circuit de la saturation.
    ///
    /// Ce n'est **pas** de l'état : il est rebâti à chaque appel, à partir de
    /// la carte et des piles, et jeté aussitôt.
    fn stockpile_slots(&self) -> Vec<Slot> {
        let tiles = self.map.stockpile_tiles();
        let mut slots: Vec<Slot> = tiles
            .iter()
            .map(|&(x, y)| {
                if self.map.passable(x, y) {
                    Slot::Free
                } else {
                    Slot::Taken
                }
            })
            .collect();
        for s in &self.items {
            if self.map.zone(s.x, s.y) != Zone::Stockpile {
                continue;
            }
            let Ok(k) = tiles.binary_search(&(s.x, s.y)) else {
                continue;
            };
            // La première pile non pleine réserve la case à son genre ; une
            // pile pleine, ou une deuxième pile, la ferme (`dest_accepts`).
            slots[k] = match slots[k] {
                Slot::Free if s.count < STACK_MAX => Slot::Partial(s.kind),
                _ => Slot::Taken,
            };
        }
        slots
    }

    /// Case de stockage la plus proche de `near` pouvant accueillir `kind`,
    /// à partir d'un relevé déjà fait. Départage par `(distance, x, y)`, comme
    /// partout ailleurs.
    fn slot_dest(&self, slots: &[Slot], kind: ItemKind, near: (u32, u32)) -> Option<(u32, u32)> {
        let tiles = self.map.stockpile_tiles();
        let mut best: Option<(u32, u32, u32)> = None;
        for (k, &(x, y)) in tiles.iter().enumerate() {
            if !slots[k].accepts(kind) {
                continue;
            }
            let key = (chebyshev(near, (x, y)), x, y);
            if best.is_none_or(|b| key < b) {
                best = Some(key);
            }
        }
        best.map(|(_, x, y)| (x, y))
    }

    /// Case de stockage la plus proche de `near` pouvant accueillir `kind`.
    /// Pour les appels isolés (`do_haul`) : `try_start_haul`, qui en enchaîne
    /// plusieurs, garde son relevé d'un candidat à l'autre.
    fn find_stockpile_dest(&mut self, kind: ItemKind, near: (u32, u32)) -> Option<(u32, u32)> {
        if self.map.stockpile_count() == 0 {
            return None;
        }
        let slots = self.stockpile_slots();
        self.count_haul_scan(2 * slots.len() as u64);
        self.slot_dest(&slots, kind, near)
    }

    fn dest_accepts(&self, d: (u32, u32), kind: ItemKind) -> bool {
        if self.map.zone(d.0, d.1) != Zone::Stockpile || !self.map.passable(d.0, d.1) {
            return false;
        }
        let mut here = self.items.iter().filter(|s| (s.x, s.y) == d);
        match (here.next(), here.next()) {
            (None, _) => true,
            (Some(s), None) => s.kind == kind && s.count < STACK_MAX,
            _ => false,
        }
    }

    pub(crate) fn is_reserved(&self, x: u32, y: u32) -> bool {
        self.reservations.iter().any(|r| r.x == x && r.y == y)
    }

    // ------------------------------------------------------------------
    // Exécution
    // ------------------------------------------------------------------

    fn do_sleep(&mut self, i: usize, in_bed: bool) {
        // Un cri dans la nuit : une hémorragie que personne ne panse tire le
        // dormeur du lit. Le sommeil n'est interrompu que s'il y a vraiment
        // un geste à faire — `try_start_tend` échoue si le blessé est déjà
        // pris en charge ou hors d'atteinte, et on se rendort sans y penser.
        // Sans cela, le blessé se vidait pendant que la colonie dormait :
        // trois des neuf morts d'après-raid de la mesure ciblée.
        if self.try_start_tend(i, true) {
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        let actually_in_bed = in_bed
            && self.map.feature(here.0, here.1) == Feature::Bed
            && !self.bed_occupied_by_other(i, here);
        if actually_in_bed != in_bed {
            self.pawns[i].job = Job::Sleep {
                in_bed: actually_in_bed,
            };
        }
        if self.pawns[i].rest >= RESTED {
            self.pawns[i].last_sleep_in_bed = actually_in_bed;
            self.pawns[i].job = Job::Idle;
        }
    }

    fn do_work(&mut self, i: usize, kind: Designation, x: u32, y: u32, progress: u32) {
        if self.map.designation(x, y) != kind || !kind.applies_to(self.map.feature(x, y)) {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), (x, y)) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Designated);
        self.gain_xp(i, WorkType::Designated);
        if progress < kind.work_ticks() * 100 {
            self.pawns[i].job = Job::Work {
                kind,
                x,
                y,
                progress,
            };
            return;
        }
        // L'élément est lu **avant** d'être abattu : c'est lui qui dit ce que
        // le travail rend (pierre ou minerai).
        let felled = self.map.feature(x, y);
        match kind {
            Designation::Chop | Designation::Mine => self.map.set_feature(x, y, Feature::None),
            Designation::Harvest => {
                self.map.set_feature(x, y, Feature::BushUnripe);
                self.regrow.push(Regrow {
                    x,
                    y,
                    ready_at: self.tick + u64::from(TICKS_PER_DAY),
                });
            }
            Designation::None => {}
        }
        if let Some((item, count)) = yield_of(kind, felled) {
            // Le minerai est le seul rendement qui ne soit pas fixe : deux ou
            // trois unités par veine.
            let count = if item == ItemKind::Ore {
                count + self.rng.below(ORE_YIELD_SPAN)
            } else {
                count
            };
            self.spawn_item(item, count, x, y);
        }
        self.map.set_designation(x, y, Designation::None);
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    fn do_haul(&mut self, i: usize, item: u32, dest: Option<(u32, u32)>, picked: bool) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            let Some(k) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[k].x, self.items[k].y) != here {
                self.abandon_job(i);
                return;
            }
            let stack = self.items.remove(k);
            self.pawns[i].carrying = Some((stack.kind, stack.count.min(STACK_MAX)));
            let kind = stack.kind;
            let mut dest = dest.filter(|&d| self.dest_accepts(d, kind));
            if dest.is_none() {
                dest = self.find_stockpile_dest(kind, here);
            }
            match dest.and_then(|d| self.colonist_path(here, d).map(|p| (d, p))) {
                Some((d, p)) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Haul {
                        item,
                        dest: Some(d),
                        picked: true,
                    };
                }
                None => {
                    self.drop_carried(i);
                    self.pawns[i].job = Job::Idle;
                }
            }
            return;
        }
        let Some((kind, _)) = self.pawns[i].carrying else {
            self.pawns[i].job = Job::Idle;
            return;
        };
        if dest != Some(here) || !self.dest_accepts(here, kind) {
            // La destination a changé sous nos pieds : en chercher une autre.
            if let Some(d) = self.find_stockpile_dest(kind, here)
                && let Some(p) = self.colonist_path(here, d)
            {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Haul {
                    item,
                    dest: Some(d),
                    picked: true,
                };
                return;
            }
        }
        self.drop_carried(i);
        self.pawns[i].job = Job::Idle;
    }

    fn do_eat(&mut self, i: usize, item: u32) {
        let Some(k) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if self.pawns[i].tile() != (self.items[k].x, self.items[k].y) {
            self.abandon_job(i);
            return;
        }
        let kind = self.items[k].kind;
        let Some(per_unit) = kind.nutrition() else {
            self.abandon_job(i);
            return;
        };
        let hunger = self.pawns[i].hunger;
        let wanted = (NEED_MAX - hunger).div_ceil(per_unit).max(1);
        let n = wanted.min(kind.max_per_meal()).min(self.items[k].count);
        self.pawns[i].hunger = (hunger + n * per_unit).min(NEED_MAX);
        self.pawns[i].last_meal_quality = kind.meal_quality();
        self.items[k].count -= n;
        self.items[k].reserved_by = None;
        if self.items[k].count == 0 {
            self.items.remove(k);
        }
        self.pawns[i].job = Job::Idle;
    }

    fn do_deliver(&mut self, i: usize, blueprint: u32, item: u32, picked: bool) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let Some(k) = self.blueprints.iter().position(|b| b.id == blueprint) else {
            self.abandon_job(i);
            return;
        };
        let here = self.pawns[i].tile();
        if !picked {
            let Some(j) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[j].x, self.items[j].y) != here {
                self.abandon_job(i);
                return;
            }
            let n = self.blueprints[k]
                .missing()
                .min(self.items[j].count)
                .min(STACK_MAX);
            if n == 0 {
                self.abandon_job(i);
                return;
            }
            self.items[j].count -= n;
            self.items[j].reserved_by = None;
            if self.items[j].count == 0 {
                self.items.remove(j);
            }
            let kind = self.blueprints[k].material.item_kind();
            self.pawns[i].carrying = Some((kind, n));
            let target = (self.blueprints[k].x, self.blueprints[k].y);
            match self.path_to_work(here, target) {
                Some(p) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Deliver {
                        blueprint,
                        item,
                        picked: true,
                    };
                }
                None => self.abandon_job(i),
            }
            return;
        }
        let target = (self.blueprints[k].x, self.blueprints[k].y);
        if chebyshev(here, target) > 1 {
            self.abandon_job(i);
            return;
        }
        let Some((kind, n)) = self.pawns[i].carrying.take() else {
            self.blueprints[k].reserved_by = None;
            self.pawns[i].job = Job::Idle;
            return;
        };
        if kind == self.blueprints[k].material.item_kind() {
            let accepted = n.min(self.blueprints[k].missing());
            self.blueprints[k].delivered += accepted;
            if n > accepted {
                self.spawn_item(kind, n - accepted, here.0, here.1);
            }
        } else {
            self.spawn_item(kind, n, here.0, here.1);
        }
        self.blueprints[k].reserved_by = None;
        self.pawns[i].job = Job::Idle;
    }

    fn do_build(&mut self, i: usize, blueprint: u32) {
        let Some(k) = self.blueprints.iter().position(|b| b.id == blueprint) else {
            self.abandon_job(i);
            return;
        };
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let target = (self.blueprints[k].x, self.blueprints[k].y);
        if chebyshev(self.pawns[i].tile(), target) > 1 || !self.blueprints[k].ready() {
            self.abandon_job(i);
            return;
        }
        let kind = self.blueprints[k].kind;
        // Un mur ne se ferme pas sur quelqu'un : on attend que la case se libère.
        if kind.adjacent_only() && self.pawns.iter().any(|p| p.tile() == target) {
            return;
        }
        let material = self.blueprints[k].material;
        let masonry = self.research.is_done(Tech::Masonry);
        self.blueprints[k].progress += self.pawns[i].work_step(WorkType::Build);
        self.gain_xp(i, WorkType::Build);
        if self.blueprints[k].progress < kind.work_ticks_with(material, masonry) * 100 {
            return;
        }
        self.complete_blueprint(k);
        self.pawns[i].job = Job::Idle;
    }

    fn complete_blueprint(&mut self, k: usize) {
        let bp = self.blueprints.remove(k);
        match build::result_feature(bp.kind, bp.material) {
            Some(f) => {
                self.map.set_feature(bp.x, bp.y, f);
                if !f.passable() {
                    self.relocate_items_from(bp.x, bp.y);
                    self.replan_paths_through(bp.x, bp.y);
                } else if f == Feature::SpikeTrap {
                    // Franchissable pour tout le monde, sauf pour ceux qui
                    // viennent de l'enterrer là : les colons qui passaient par
                    // cette case refont leur chemin sur-le-champ.
                    self.replan_paths_through(bp.x, bp.y);
                }
            }
            None => self
                .map
                .set_terrain(bp.x, bp.y, build::result_terrain(bp.material)),
        }
    }

    /// Pousse les piles d'une case devenue infranchissable sur la voisine la plus proche.
    fn relocate_items_from(&mut self, x: u32, y: u32) {
        let Some(dest) = self.map.nearest_passable(x, y) else {
            return;
        };
        for s in &mut self.items {
            if (s.x, s.y) == (x, y) {
                s.x = dest.0;
                s.y = dest.1;
            }
        }
    }

    /// Recalcule le chemin des colons qui passaient par une case devenue
    /// infranchissable ; abandonne le job si la destination n'est plus atteignable.
    pub(crate) fn replan_paths_through(&mut self, x: u32, y: u32) {
        let tile: path::Tile = (x as u16, y as u16);
        for i in 0..self.pawns.len() {
            if !self.pawns[i].path.contains(&tile) {
                continue;
            }
            let dest = self.pawns[i].path[0];
            let from = self.pawns[i].tile();
            let walker = self.walker(i);
            match path::find_path_for(
                &self.map,
                from,
                (u32::from(dest.0), u32::from(dest.1)),
                walker,
            ) {
                Some(p) if !p.is_empty() => self.pawns[i].set_path(p),
                _ => self.abandon_job(i),
            }
        }
    }

    // ------------------------------------------------------------------
    // Pièges à pointes
    // ------------------------------------------------------------------

    /// Va réarmer le piège déclenché le plus proche. Deux court-circuits avant
    /// tout balayage : le compteur de la carte, puis le tour du colon
    /// (`RETRY_TICKS`) — un piège resté du mauvais côté d'une brèche refermée
    /// se redemandait six fois par tick, indéfiniment. La case est réservée
    /// comme celle d'un travail désigné : deux colons ne réarment pas le même
    /// piège.
    fn try_start_rearm(&mut self, i: usize) -> bool {
        if self.map.sprung_trap_count() == 0 || !self.job_retry_due(i) {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut traps: Vec<(u32, u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::SpikeTrapSprung && !self.is_reserved(x, y) {
                    traps.push((chebyshev(from, (x, y)), x, y));
                }
            }
        }
        traps.sort_unstable();
        let mut budget = PATH_ATTEMPTS;
        for &(_, x, y) in traps.iter().take(PATH_ATTEMPTS) {
            // Un piège déclenché est franchissable par tout le monde : le
            // colon va se planter dessus pour le remonter.
            let p = match self.reach_work(from, (x, y), &mut budget) {
                Reach::Path(p) => p,
                Reach::Unreachable => continue,
                Reach::OutOfBudget => break,
            };
            let pawn = self.pawns[i].id;
            self.reservations.push(Reservation { x, y, pawn });
            self.pawns[i].set_path(p);
            self.pawns[i].job = Job::RearmTrap {
                at: (x, y),
                progress: 0,
            };
            return true;
        }
        false
    }

    /// Remonte les pointes. Aucun matériau n'est consommé et rien n'est
    /// annoncé : un piège réarmé est un retour à la normale, pas un fait
    /// notable.
    fn do_rearm(&mut self, i: usize, at: (u32, u32), progress: u32) {
        if self.map.feature(at.0, at.1) != Feature::SpikeTrapSprung {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), at) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Build);
        self.gain_xp(i, WorkType::Build);
        if progress < combat::REARM_TICKS * 100 {
            self.pawns[i].job = Job::RearmTrap { at, progress };
            return;
        }
        self.map.set_feature(at.0, at.1, Feature::SpikeTrap);
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
        // Le colon peut se retrouver debout sur le piège qu'il vient de
        // remonter : il n'en souffre pas (seuls les hostiles et les bêtes le
        // déclenchent) et son prochain chemin repart de là sans encombre — la
        // case de départ n'est jamais testée (`path::find_path_for`).
    }

    // ------------------------------------------------------------------
    // Cuisine et culture
    // ------------------------------------------------------------------

    /// Cuisine s'il y a un feu libre, de la nourriture crue et pas assez de repas.
    fn try_start_cook(&mut self, i: usize) -> bool {
        if self.map.campfire_count() == 0 {
            return false;
        }
        let mut fires: Vec<(u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::Campfire && !self.is_reserved(x, y) {
                    fires.push((x, y));
                }
            }
        }
        if fires.is_empty() {
            return false;
        }
        let meals: u32 = self
            .items
            .iter()
            .filter(|s| s.kind == ItemKind::Meal)
            .map(|s| s.count)
            .sum();
        if meals >= farm::MEALS_TARGET {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut stacks: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| {
                s.kind.is_raw_food() && s.reserved_by.is_none() && s.count >= farm::RAW_PER_MEAL
            })
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        stacks.sort_unstable();
        // La cuisine garde son feu **non vérifié** au démarrage, contrairement
        // au dépeçage : elle est le seul de ces travaux que le scénario `demo`
        // exerce, donc le seul qui ne puisse pas recevoir la cadence de
        // `RETRY_TICKS` sans déplacer le hash de référence. Or vérifier le
        // poste sans pouvoir espacer les essais coûte **plus** que la boucle
        // qu'on voulait supprimer : mesuré sur la graine 3 de la campagne,
        // 71 000 → 581 000 A\*. La vérification et la cadence vont ensemble ou
        // pas du tout (voir `CAMPAIGN-FINDINGS.md`, §3).
        for &(_, sx, sy, k) in stacks.iter().take(PATH_ATTEMPTS) {
            let Some(&(_, fx, fy)) = fires
                .iter()
                .map(|&(x, y)| (chebyshev((sx, sy), (x, y)), x, y))
                .min()
                .as_ref()
            else {
                return false;
            };
            if let Some(p) = self.colonist_path(from, (sx, sy)) {
                let pawn = self.pawns[i].id;
                self.items[k].reserved_by = Some(pawn);
                self.reservations.push(Reservation { x: fx, y: fy, pawn });
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Cook {
                    campfire: (fx, fy),
                    item,
                    picked: false,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    fn do_cook(&mut self, i: usize, campfire: (u32, u32), item: u32, picked: bool, progress: u32) {
        if self.map.feature(campfire.0, campfire.1) != Feature::Campfire {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            let Some(j) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[j].x, self.items[j].y) != here
                || self.items[j].count < farm::RAW_PER_MEAL
            {
                self.abandon_job(i);
                return;
            }
            let kind = self.items[j].kind;
            self.items[j].count -= farm::RAW_PER_MEAL;
            self.items[j].reserved_by = None;
            if self.items[j].count == 0 {
                self.items.remove(j);
            }
            self.pawns[i].carrying = Some((kind, farm::RAW_PER_MEAL));
            match self.colonist_adjacent(here, campfire) {
                Some(p) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Cook {
                        campfire,
                        item,
                        picked: true,
                        progress: 0,
                    };
                }
                None => self.abandon_job(i),
            }
            return;
        }
        if chebyshev(here, campfire) > 1 || self.pawns[i].carrying.is_none() {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Cook);
        self.gain_xp(i, WorkType::Cook);
        if progress < farm::COOK_TICKS * 100 {
            self.pawns[i].job = Job::Cook {
                campfire,
                item,
                picked: true,
                progress,
            };
            return;
        }
        // Les ingrédients sont consommés, le repas est posé au pied du cuisinier.
        self.pawns[i].carrying = None;
        self.spawn_item(ItemKind::Meal, 1, here.0, here.1);
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    // ------------------------------------------------------------------
    // Fabrication d'armes et de vêtements, équipement
    // ------------------------------------------------------------------

    /// Exemplaires d'un genre que possède la colonie : piles au sol ou rangées,
    /// charges en main, armes équipées et vêtements portés. Les pillards ne
    /// comptent pas, leur gourdin (ni leur tunique) n'appartient pas à la
    /// colonie tant qu'ils le portent.
    pub fn colony_total(&self, kind: ItemKind) -> u32 {
        let mut total: u32 = self
            .items
            .iter()
            .filter(|s| s.kind == kind)
            .map(|s| s.count)
            .sum();
        for p in &self.pawns {
            if p.faction != Faction::Colony {
                continue;
            }
            if let Some((k, n)) = p.carrying
                && k == kind
            {
                total += n;
            }
            if p.weapon == Some(kind) {
                total += 1;
            }
            if p.apparel == Some(kind) {
                total += 1;
            }
        }
        total
    }

    /// Une pile par ingrédient de la recette : la plus proche du colon, non
    /// réservée, et assez fournie pour couvrir le besoin d'un seul voyage.
    /// `None` si la colonie n'a pas de quoi.
    ///
    /// **Ne regarde jamais la carte** : c'est ce qui permet à
    /// `try_start_craft` de trancher « faisable ou non » en O(piles), avant
    /// tout balayage.
    fn craft_picks(&self, recipe: &craft::Recipe, from: (u32, u32)) -> Option<Vec<usize>> {
        let mut picks: Vec<usize> = Vec::with_capacity(recipe.inputs.len());
        for &(kind, need) in recipe.inputs {
            let mut stacks: Vec<(u32, u32, u32, usize)> = self
                .items
                .iter()
                .enumerate()
                .filter(|(k, s)| {
                    s.kind == kind
                        && s.reserved_by.is_none()
                        && s.count >= need
                        && !picks.contains(k)
                })
                .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
                .collect();
            stacks.sort_unstable();
            picks.push(stacks.first()?.3);
        }
        Some(picks)
    }

    /// Première recette **faisable** dans l'ordre de `craft::RECIPES` : objectif
    /// non atteint, atelier bâti, et de quoi la tenir en réserve. Renvoie aussi
    /// les piles retenues, pour ne pas les rechercher deux fois.
    ///
    /// Les trois conditions se testent sans toucher à la carte, et c'est le
    /// point : une recette dont l'atelier manque (des lingots sans forge) ou
    /// dont les ingrédients manquent (du minerai qu'on n'a pas) est **sautée**,
    /// pas attendue. Sans cela, un objectif inatteignable bloquait la file — la
    /// colonie ne taillait plus ses arcs — et surtout faisait balayer les
    /// 4 096 cases de la carte à chaque colon désœuvré, à chaque tick (mesuré :
    /// une campagne de 30 jours passait de 0,3 s à 108 s dès l'objectif de
    /// lingots posé).
    fn wanted_craft(&self, from: (u32, u32)) -> Option<(&'static craft::Recipe, Vec<usize>)> {
        craft::RECIPES.iter().find_map(|r| {
            if self.colony_total(r.output) >= self.craft_targets[r.output as usize]
                || self.map.station_count(r.station) == 0
            {
                return None;
            }
            self.craft_picks(r, from).map(|picks| (r, picks))
        })
    }

    /// Fabrique s'il y a un atelier libre **atteignable**, un objectif non
    /// atteint et de quoi tenir la recette. Les piles nécessaires sont
    /// réservées d'un coup : un colon ne part pas chercher du bois pour un
    /// épieu sans pierre.
    ///
    /// Comme le dépeçage : trois court-circuits avant le premier A\* (aucun
    /// atelier, aucun objectif posé, ce n'est pas le tour du colon), puis un
    /// budget partagé par l'atelier et la première pile. L'atelier est vérifié
    /// **ici** — un atelier muré retenu au démarrage se payait autrement dans
    /// `pick_ingredient`, à chaque tick, huit A\* ratés à la fois.
    fn try_start_craft(&mut self, i: usize) -> bool {
        if (self.map.crafting_spot_count() == 0 && self.map.forge_count() == 0)
            || self.craft_targets.iter().all(|&t| t == 0)
            || !self.job_retry_due(i)
        {
            return false;
        }
        let from = self.pawns[i].tile();
        let Some((recipe, picks)) = self.wanted_craft(from) else {
            return false;
        };
        let station = recipe.station;
        let mut spots: Vec<(u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == station && !self.is_reserved(x, y) {
                    spots.push((x, y));
                }
            }
        }
        let mut budget = PATH_ATTEMPTS;
        let mut blocked: Vec<(u32, u32)> = Vec::new();
        // L'atelier le plus proche du colon : c'est lui qui va y retourner
        // autant de fois que la recette a d'ingrédients.
        let Some(((fx, fy), _)) = self.reach_station(from, &spots, from, &mut budget, &mut blocked)
        else {
            return false;
        };
        let first = picks[0];
        let target = (self.items[first].x, self.items[first].y);
        let Reach::Path(p) = self.reach_tile(from, target, &mut budget) else {
            return false;
        };
        let pawn = self.pawns[i].id;
        for &k in &picks {
            self.items[k].reserved_by = Some(pawn);
        }
        self.reservations.push(Reservation { x: fx, y: fy, pawn });
        let item = self.items[first].id;
        self.pawns[i].set_path(p);
        self.pawns[i].job = Job::Craft {
            spot: (fx, fy),
            recipe: recipe.output,
            stage: CraftStage::Fetch {
                index: 0,
                item,
                carried: false,
            },
        };
        true
    }

    fn do_craft(&mut self, i: usize, spot: (u32, u32), recipe: ItemKind, stage: CraftStage) {
        let Some(r) = craft::recipe_for(recipe) else {
            self.abandon_job(i);
            return;
        };
        // L'atelier de la recette, pas « le poste » : la fonte veut une forge.
        if self.map.feature(spot.0, spot.1) != r.station {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        match stage {
            CraftStage::Fetch {
                index,
                item,
                carried,
            } => {
                let Some(&(kind, need)) = r.inputs.get(usize::from(index)) else {
                    self.abandon_job(i);
                    return;
                };
                if !carried {
                    self.pick_ingredient(i, spot, recipe, index, item, kind, need);
                    return;
                }
                // Arrivé au poste, la charge y reste : elle est consommée par
                // la fabrication, qu'on la termine ou non.
                if chebyshev(here, spot) > 1 || self.pawns[i].carrying.is_none() {
                    self.abandon_job(i);
                    return;
                }
                self.pawns[i].carrying = None;
                self.next_ingredient(i, spot, recipe, usize::from(index) + 1);
            }
            CraftStage::Work { progress } => {
                if chebyshev(here, spot) > 1 {
                    self.abandon_job(i);
                    return;
                }
                let progress = progress + self.pawns[i].work_step(WorkType::Build);
                self.gain_xp(i, WorkType::Build);
                if progress < r.work_ticks * 100 {
                    self.pawns[i].job = Job::Craft {
                        spot,
                        recipe,
                        stage: CraftStage::Work { progress },
                    };
                    return;
                }
                // La pièce tombe au pied du poste : un rangeur la mettra en
                // stockage, où un colon viendra la prendre.
                self.spawn_item(recipe, 1, here.0, here.1);
                let id = self.pawns[i].id;
                self.reservations.retain(|r| r.pawn != id);
                self.pawns[i].job = Job::Idle;
                // Les armes gardent `WeaponCrafted`, que le client sait déjà
                // afficher ; le reste passe par `ItemCrafted`.
                let event = if recipe.is_weapon() {
                    EventKind::WeaponCrafted
                } else {
                    EventKind::ItemCrafted
                };
                self.push_event(event, recipe as u32);
            }
        }
    }

    /// Ramasse la part de la pile réservée qu'exige la recette, puis met le cap
    /// sur le poste.
    #[allow(clippy::too_many_arguments)]
    fn pick_ingredient(
        &mut self,
        i: usize,
        spot: (u32, u32),
        recipe: ItemKind,
        index: u8,
        item: u32,
        kind: ItemKind,
        need: u32,
    ) {
        let here = self.pawns[i].tile();
        let Some(j) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        if (self.items[j].x, self.items[j].y) != here || self.items[j].count < need {
            self.abandon_job(i);
            return;
        }
        self.items[j].count -= need;
        self.items[j].reserved_by = None;
        if self.items[j].count == 0 {
            self.items.remove(j);
        }
        self.pawns[i].carrying = Some((kind, need));
        match self.colonist_adjacent(here, spot) {
            Some(p) => {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Craft {
                    spot,
                    recipe,
                    stage: CraftStage::Fetch {
                        index,
                        item,
                        carried: true,
                    },
                };
            }
            None => self.abandon_job(i),
        }
    }

    /// Enchaîne sur l'ingrédient suivant (sa pile est déjà réservée) ou passe
    /// au travail quand la recette est complète.
    fn next_ingredient(&mut self, i: usize, spot: (u32, u32), recipe: ItemKind, index: usize) {
        let Some(r) = craft::recipe_for(recipe) else {
            self.abandon_job(i);
            return;
        };
        let Some(&(kind, need)) = r.inputs.get(index) else {
            self.pawns[i].job = Job::Craft {
                spot,
                recipe,
                stage: CraftStage::Work { progress: 0 },
            };
            return;
        };
        let id = self.pawns[i].id;
        let here = self.pawns[i].tile();
        let found = self
            .items
            .iter()
            .position(|s| s.kind == kind && s.reserved_by == Some(id) && s.count >= need);
        let Some(j) = found else {
            self.abandon_job(i);
            return;
        };
        let target = (self.items[j].x, self.items[j].y);
        let item = self.items[j].id;
        match self.colonist_path(here, target) {
            Some(p) => {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Craft {
                    spot,
                    recipe,
                    stage: CraftStage::Fetch {
                        index: index as u8,
                        item,
                        carried: false,
                    },
                };
            }
            None => self.abandon_job(i),
        }
    }

    /// Va chercher en stockage le meilleur équipement disponible : une arme
    /// (`Bow > Spear > Club`) et un vêtement (`Coat > Tunic`). Les deux tiennent
    /// dans la même fonction parce qu'ils tiennent la même place dans l'ordre
    /// du colon — juste avant le travail — et se jouent pareil (`Job::Equip`,
    /// une pile réservée, un aller simple).
    ///
    /// Quand le colon a froid, l'habit passe devant : celui qui grelotte a plus
    /// besoin d'un manteau que d'un arc.
    fn try_start_equip(&mut self, i: usize) -> bool {
        if self.map.stockpile_count() == 0 {
            return false;
        }
        if self.pawns[i].comfort < climate::COLD_MOOD_TEMP {
            return self.try_start_wear(i) || self.try_start_arm(i);
        }
        self.try_start_arm(i) || self.try_start_wear(i)
    }

    /// L'arme : on ne redescend jamais en gamme.
    fn try_start_arm(&mut self, i: usize) -> bool {
        let current = self.pawns[i].weapon.map_or(0, |w| w.weapon_rank());
        self.try_start_gear(i, current, ItemKind::weapon_rank)
    }

    /// L'habit, seulement s'il sert : au-dessus de `climate::DRESS_TEMP`, un
    /// colon a mieux à faire que traverser la carte pour un manteau.
    ///
    /// La température de sa case se relit **sans rien recalculer** : `comfort`
    /// vient d'être posé par `tick_comfort` au même tick, isolation comprise.
    fn try_start_wear(&mut self, i: usize) -> bool {
        if self.pawns[i].comfort - self.pawns[i].insulation_tenths() >= climate::DRESS_TEMP {
            return false;
        }
        let current = self.pawns[i].apparel.map_or(0, |a| a.apparel_rank());
        self.try_start_gear(i, current, ItemKind::apparel_rank)
    }

    /// Part chercher la meilleure pile rangée dont le rang dépasse `current`.
    /// Partagée par l'arme et l'habit : seul le barème change.
    fn try_start_gear(&mut self, i: usize, current: u32, rank: fn(ItemKind) -> u32) -> bool {
        // Test sans allocation : le cas courant est « rien de rangé ».
        let usable = |s: &ItemStack| {
            rank(s.kind) > current
                && s.reserved_by.is_none()
                && s.count > 0
                && self.map.zone(s.x, s.y) == Zone::Stockpile
        };
        if !self.items.iter().any(usable) {
            return false;
        }
        let from = self.pawns[i].tile();
        // Meilleure pièce d'abord, puis la plus proche : `Reverse` renverse le
        // seul critère décroissant sans casser l'ordre total du tri.
        let mut candidates: Vec<(Reverse<u32>, u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| usable(s))
            .map(|(k, s)| {
                (
                    Reverse(rank(s.kind)),
                    chebyshev(from, (s.x, s.y)),
                    s.x,
                    s.y,
                    k,
                )
            })
            .collect();
        candidates.sort_unstable();
        for &(_, _, x, y, k) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.colonist_path(from, (x, y)) {
                let id = self.pawns[i].id;
                self.items[k].reserved_by = Some(id);
                let item = self.items[k].id;
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Equip { item };
                return true;
            }
        }
        false
    }

    fn do_equip(&mut self, i: usize, item: u32) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let Some(k) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        let here = self.pawns[i].tile();
        let kind = self.items[k].kind;
        // Arme ou habit : la pile dit lequel, et chacun se compare au sien.
        let better = if kind.is_apparel() {
            kind.apparel_rank() > self.pawns[i].apparel.map_or(0, |a| a.apparel_rank())
        } else {
            kind.weapon_rank() > self.pawns[i].weapon.map_or(0, |w| w.weapon_rank())
        };
        if (self.items[k].x, self.items[k].y) != here || !better {
            self.abandon_job(i);
            return;
        }
        // Arme comme habit se portent à l'unité : la pile en perd une, pas plus.
        self.items[k].count -= 1;
        self.items[k].reserved_by = None;
        if self.items[k].count == 0 {
            self.items.remove(k);
        }
        let replaced = if kind.is_apparel() {
            self.pawns[i].apparel.replace(kind)
        } else {
            self.pawns[i].weapon.replace(kind)
        };
        // Ce qu'il quitte tombe à ses pieds : un rangeur le remettra en rayon.
        if let Some(old) = replaced {
            self.spawn_item(old, 1, here.0, here.1);
        }
        self.pawns[i].job = Job::Idle;
    }

    // ------------------------------------------------------------------
    // Chasse et dépeçage
    // ------------------------------------------------------------------

    /// Le gibier est-il déjà pris en charge par un autre chasseur ?
    fn hunted_by_other(&self, i: usize, target: u32) -> bool {
        self.pawns
            .iter()
            .enumerate()
            .any(|(k, p)| k != i && matches!(p.job, Job::Hunt { target: t } if t == target))
    }

    /// Part chasser le gibier marqué le plus proche. **Un colon à mains nues
    /// ne chasse pas** : on ne court pas après un cerf pour l'étrangler.
    fn try_start_hunt(&mut self, i: usize) -> bool {
        // Trois court-circuits : pas d'arme, rien de marqué sur la carte, ou
        // ce n'est pas le tour du colon. Le dernier vaut son pesant : une bête
        // marquée de l'autre rive coûtait six candidats fois huit voisines,
        // soit quarante-huit A\* ratés, à chaque tick et pour chaque chasseur.
        if self.pawns[i].weapon.is_none()
            || !self
                .pawns
                .iter()
                .any(|p| p.hunted && p.faction == Faction::Animal && p.is_alive())
            || !self.job_retry_due(i)
        {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut candidates: Vec<(u32, u32, u32, u32)> = Vec::new();
        for p in &self.pawns {
            if !p.hunted || p.faction != Faction::Animal || !p.is_alive() {
                continue;
            }
            if self.hunted_by_other(i, p.id) {
                continue;
            }
            let (x, y) = p.tile();
            candidates.push((chebyshev(from, (x, y)), x, y, p.id));
        }
        candidates.sort_unstable();
        let mut budget = PATH_ATTEMPTS;
        for &(d, x, y, target) in candidates.iter().take(PATH_ATTEMPTS) {
            // La bête bouge : le chemin sera refait à chaque tick par
            // `engage`. Ici on vérifie seulement qu'elle est atteignable, pour
            // qu'un chasseur ne parte pas après un lapin de l'autre rive.
            let reachable = match d {
                0 | 1 => true,
                _ => match self.reach_adjacent(from, (x, y), &mut budget) {
                    Reach::Path(_) => true,
                    Reach::Unreachable => false,
                    // Budget épuisé : on ne sait pas, et on ne le saura pas ce
                    // tick-ci. Le chasseur repassera à la prochaine salve.
                    Reach::OutOfBudget => break,
                },
            };
            if reachable {
                self.pawns[i].path.clear();
                self.pawns[i].job = Job::Hunt { target };
                return true;
            }
        }
        false
    }

    /// Poursuit et abat le gibier. Contrairement aux pillards face à un colon
    /// écroulé, **le chasseur achève une bête à terre** : la laisser agoniser
    /// n'aurait aucun sens.
    fn do_hunt(&mut self, i: usize, target: u32) {
        let hunted = self
            .pawns
            .iter()
            .any(|p| p.id == target && p.is_alive() && p.hunted);
        if !hunted {
            // Bête morte, partie, ou chasse annulée par le joueur.
            self.abandon_job(i);
            return;
        }
        if self.engage(i, target) != crate::combat::EngageOutcome::Engaged {
            self.abandon_job(i);
        }
    }

    /// Dépèce s'il y a un poste libre **atteignable** et une dépouille au sol.
    /// Aucun objectif à régler : dès qu'une bête est morte, on la débite (voir
    /// `craft::BUTCHER_TICKS`).
    ///
    /// Trois court-circuits avant le premier A\* : pas de poste (un compteur),
    /// pas de dépouille (un test sur les piles), et ce n'est pas le tour du
    /// colon (`RETRY_TICKS`). Le budget borne ensuite les recherches de
    /// chemin, dépouilles et postes confondus.
    ///
    /// **Le poste est vérifié ici**, pas dans `do_butcher` : c'était le point
    /// chaud du profil de campagne (`CAMPAIGN-FINDINGS.md`, §3, « le poste hors
    /// d'atteinte »). Un poste muré était retenu quand même, le
    /// colon allait chercher la dépouille, la ramassait, découvrait qu'aucun
    /// chemin n'y menait, la reposait — et recommençait au tick suivant, huit
    /// A\* ratés à chaque fois.
    fn try_start_butcher(&mut self, i: usize) -> bool {
        if self.map.crafting_spot_count() == 0
            || !self
                .items
                .iter()
                .any(|s| s.kind.is_animal_corpse() && s.reserved_by.is_none() && s.count > 0)
            || !self.job_retry_due(i)
        {
            return false;
        }
        let mut spots: Vec<(u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::CraftingSpot && !self.is_reserved(x, y) {
                    spots.push((x, y));
                }
            }
        }
        if spots.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut stacks: Vec<(u32, u32, u32, usize)> = self
            .items
            .iter()
            .enumerate()
            .filter(|(_, s)| s.kind.is_animal_corpse() && s.reserved_by.is_none() && s.count > 0)
            .map(|(k, s)| (chebyshev(from, (s.x, s.y)), s.x, s.y, k))
            .collect();
        stacks.sort_unstable();
        let mut budget = PATH_ATTEMPTS;
        let mut blocked: Vec<(u32, u32)> = Vec::new();
        for &(_, sx, sy, k) in stacks.iter().take(PATH_ATTEMPTS) {
            // La dépouille **avant** le poste : c'est le test le moins cher
            // (une recherche, contre huit pour un poste dont on essaie les
            // voisines). Une dépouille hors d'atteinte ne fait donc pas payer
            // le poste, et un appel qui n'aboutit à rien coûte un A\* au lieu
            // de neuf.
            let p = match self.reach_tile(from, (sx, sy), &mut budget) {
                Reach::Path(p) => p,
                Reach::Unreachable => continue,
                Reach::OutOfBudget => break,
            };
            // Le poste le plus proche de la dépouille, pas du colon : c'est
            // elle qu'il va falloir porter.
            match self.reach_station(from, &spots, (sx, sy), &mut budget, &mut blocked) {
                Some(((fx, fy), _)) => {
                    let pawn = self.pawns[i].id;
                    self.items[k].reserved_by = Some(pawn);
                    self.reservations.push(Reservation { x: fx, y: fy, pawn });
                    let item = self.items[k].id;
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Butcher {
                        spot: (fx, fy),
                        item,
                        picked: false,
                        progress: 0,
                    };
                    return true;
                }
                // Plus un poste atteignable, ou budget épuisé : les dépouilles
                // suivantes visent les mêmes postes, elles n'iront pas plus loin.
                None => break,
            }
        }
        false
    }

    fn do_butcher(&mut self, i: usize, spot: (u32, u32), item: u32, picked: bool, progress: u32) {
        if self.map.feature(spot.0, spot.1) != Feature::CraftingSpot {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let here = self.pawns[i].tile();
        if !picked {
            let Some(j) = self.items.iter().position(|s| s.id == item) else {
                self.abandon_job(i);
                return;
            };
            if (self.items[j].x, self.items[j].y) != here || !self.items[j].kind.is_animal_corpse()
            {
                self.abandon_job(i);
                return;
            }
            // Une dépouille se porte à l'unité, comme une arme.
            let kind = self.items[j].kind;
            self.items[j].count -= 1;
            self.items[j].reserved_by = None;
            if self.items[j].count == 0 {
                self.items.remove(j);
            }
            self.pawns[i].carrying = Some((kind, 1));
            // `try_start_butcher` a démontré que ce poste était atteignable
            // avant d'envoyer le colon : l'échec ici veut dire qu'un mur s'est
            // élevé entre-temps, pas qu'on a retenu un poste muré. C'est la
            // différence entre un cas rare et une boucle à chaque tick.
            match self.colonist_adjacent(here, spot) {
                Some(p) => {
                    self.pawns[i].set_path(p);
                    self.pawns[i].job = Job::Butcher {
                        spot,
                        item,
                        picked: true,
                        progress: 0,
                    };
                }
                None => self.abandon_job(i),
            }
            return;
        }
        let Some((kind, _)) = self.pawns[i].carrying else {
            self.abandon_job(i);
            return;
        };
        if chebyshev(here, spot) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Cook);
        self.gain_xp(i, WorkType::Cook);
        if progress < craft::BUTCHER_TICKS * 100 {
            self.pawns[i].job = Job::Butcher {
                spot,
                item,
                picked: true,
                progress,
            };
            return;
        }
        // La dépouille est consommée ; viande et cuir tombent au pied du poste.
        self.pawns[i].carrying = None;
        if let Some(species) = Species::from_corpse(kind) {
            self.spawn_item(ItemKind::Meat, species.meat(), here.0, here.1);
            self.spawn_item(ItemKind::Leather, species.leather(), here.0, here.1);
        }
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    // ------------------------------------------------------------------
    // Recherche
    // ------------------------------------------------------------------

    /// Cherche s'il y a une technologie en cours et un établi libre. Trois
    /// court-circuits avant le premier A\* : sans établi ou sans technologie
    /// choisie, un colon inactif ne parcourt pas la carte ; et hors de son
    /// tour (`RETRY_TICKS`), il ne teste pas un établi muré une trente-et-
    /// unième fois. Le budget borne le reste : la boucle valait jusqu'à six
    /// établis fois huit voisines, soit quarante-huit A\* ratés par tick.
    fn try_start_research(&mut self, i: usize) -> bool {
        if self.map.research_bench_count() == 0
            || self.research.current().is_none()
            || !self.job_retry_due(i)
        {
            return false;
        }
        let from = self.pawns[i].tile();
        let mut benches: Vec<(u32, u32)> = Vec::new();
        for y in 0..self.map.height() {
            for x in 0..self.map.width() {
                if self.map.feature(x, y) == Feature::ResearchBench && !self.is_reserved(x, y) {
                    benches.push((x, y));
                }
            }
        }
        let mut budget = PATH_ATTEMPTS;
        let mut blocked: Vec<(u32, u32)> = Vec::new();
        let Some(((bx, by), p)) =
            self.reach_station(from, &benches, from, &mut budget, &mut blocked)
        else {
            return false;
        };
        let pawn = self.pawns[i].id;
        self.reservations.push(Reservation { x: bx, y: by, pawn });
        self.pawns[i].set_path(p);
        self.pawns[i].job = Job::Research { bench: (bx, by) };
        true
    }

    /// Une séance à l'établi. Les points vont dans `Sim::research`, pas dans le
    /// job : ce que la colonie a trouvé ne se perd pas si le chercheur lâche
    /// tout, meurt ou part en caravane.
    fn do_research(&mut self, i: usize, bench: (u32, u32)) {
        // Plus rien à chercher (technologie acquise, ou joueur qui a tout
        // arrêté) : le colon rend l'établi.
        let Some(tech) = self.research.current() else {
            self.abandon_job(i);
            return;
        };
        if self.map.feature(bench.0, bench.1) != Feature::ResearchBench {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), bench) > 1 {
            self.abandon_job(i);
            return;
        }
        let points = research::points_for(self.pawns[i].work_step(WorkType::Research));
        let k = tech as usize;
        self.research.progress[k] = self.research.progress[k].saturating_add(points);
        self.gain_xp(i, WorkType::Research);
        if self.research.reached(tech) {
            self.research.done[k] = true;
            self.research.current = research::NO_TECH;
            self.push_event(EventKind::ResearchDone, tech as u32);
            self.abandon_job(i);
            return;
        }
        // Fin de séance : le colon lâche l'établi (quitte à le reprendre au
        // tick suivant), ses besoins et son tableau de travail sont réévalués,
        // et un camarade peut prendre la place.
        if self.tick % u64::from(RESEARCH_SESSION) == 0 {
            self.abandon_job(i);
        }
    }

    fn can_sow(&self, x: u32, y: u32) -> bool {
        self.map.is_soil(x, y)
            && self.map.feature(x, y) == Feature::None
            && !self.blueprints.iter().any(|b| (b.x, b.y) == (x, y))
            && !self.items.iter().any(|s| (s.x, s.y) == (x, y))
    }

    /// Récolte les plants mûrs, sème les cases de culture libres.
    fn try_start_farm(&mut self, i: usize) -> bool {
        if self.map.growing_count() == 0 && self.crops.is_empty() {
            return false;
        }
        let from = self.pawns[i].tile();
        // (distance, x, y, semer) : à distance égale, la récolte passe avant le semis.
        let mut candidates: Vec<(u32, u32, u32, bool)> = Vec::new();
        for c in &self.crops {
            if self.map.feature(c.x, c.y) == Feature::CropRipe && !self.is_reserved(c.x, c.y) {
                candidates.push((chebyshev(from, (c.x, c.y)), c.x, c.y, false));
            }
        }
        if self.map.growing_count() > 0 {
            for y in 0..self.map.height() {
                for x in 0..self.map.width() {
                    if self.map.zone(x, y) == Zone::Growing
                        && self.can_sow(x, y)
                        && !self.is_reserved(x, y)
                    {
                        candidates.push((chebyshev(from, (x, y)), x, y, true));
                    }
                }
            }
        }
        candidates.sort_unstable();
        for &(_, x, y, sow) in candidates.iter().take(PATH_ATTEMPTS) {
            if let Some(p) = self.path_to_work(from, (x, y)) {
                let pawn = self.pawns[i].id;
                self.reservations.push(Reservation { x, y, pawn });
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Farm {
                    sow,
                    x,
                    y,
                    progress: 0,
                };
                return true;
            }
        }
        false
    }

    fn do_farm(&mut self, i: usize, sow: bool, x: u32, y: u32, progress: u32) {
        let valid = if sow {
            self.map.zone(x, y) == Zone::Growing && self.can_sow(x, y)
        } else {
            self.map.feature(x, y) == Feature::CropRipe
        };
        if !valid {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if chebyshev(self.pawns[i].tile(), (x, y)) > 1 {
            self.abandon_job(i);
            return;
        }
        let progress = progress + self.pawns[i].work_step(WorkType::Farm);
        self.gain_xp(i, WorkType::Farm);
        let needed = if sow {
            farm::SOW_TICKS * 100
        } else {
            farm::HARVEST_TICKS * 100
        };
        if progress < needed {
            self.pawns[i].job = Job::Farm {
                sow,
                x,
                y,
                progress,
            };
            return;
        }
        if sow {
            self.map.set_feature(x, y, Feature::Crop);
            self.crops.push(Crop { x, y, growth: 0 });
        } else {
            self.map.set_feature(x, y, Feature::None);
            self.crops.retain(|c| (c.x, c.y) != (x, y));
            self.spawn_item(ItemKind::Vegetables, farm::CROP_YIELD, x, y);
        }
        let id = self.pawns[i].id;
        self.reservations.retain(|r| r.pawn != id);
        self.pawns[i].job = Job::Idle;
    }

    /// Les plants poussent — ou pas. Sous la pluie deux fois plus vite, sous
    /// 8 °C deux fois moins, sous 0 °C plus du tout, et sous −5 °C ils peuvent
    /// geler pour de bon. La température est celle de leur case : un plant
    /// dans une pièce chauffée passe l'hiver.
    pub(crate) fn tick_crops(&mut self, outdoor: i32) {
        if self.crops.is_empty() {
            return;
        }
        let wet = self.weather.is_wet();
        let tick = self.tick;
        // Lu une fois pour toutes les cases : la recherche ne change pas en
        // cours de tick.
        let agriculture = self.research.is_done(Tech::Agriculture);
        let mut k = 0;
        while k < self.crops.len() {
            let (x, y) = (self.crops[k].x, self.crops[k].y);
            let temperature = outdoor + self.indoor_bonus(x, y);
            if temperature < climate::CROP_KILL_TEMP
                && self.rng.chance(1, climate::CROP_KILL_CHANCE)
            {
                self.kill_crop(x, y);
                self.crops.remove(k);
                continue;
            }
            if self.crops[k].growth < farm::GROW_TICKS {
                let step = climate::growth_step(temperature, wet, tick);
                let step = research::crop_growth_step(step, agriculture, tick);
                self.crops[k].growth = (self.crops[k].growth + step).min(farm::GROW_TICKS);
                if self.crops[k].growth == farm::GROW_TICKS
                    && self.map.feature(x, y) == Feature::Crop
                {
                    self.map.set_feature(x, y, Feature::CropRipe);
                }
            }
            k += 1;
        }
    }

    /// La nourriture périmée disparaît. Les jobs qui la visaient s'arrêtent
    /// d'eux-mêmes en ne la retrouvant pas.
    ///
    /// Lire la température de chaque pile à chaque tick coûterait cher sur
    /// une grande colonie : on n'évalue la péremption que tous les
    /// `SPOILAGE_INTERVAL` ticks, en perdant d'un coup ce que ces ticks-là
    /// auraient coûté à la vitesse mesurée à cet instant (voir
    /// `Sim::spoil_items`).
    pub(crate) fn tick_spoilage(&mut self) {
        if self.tick % SPOILAGE_INTERVAL != 0 {
            return;
        }
        self.spoil_items(SPOILAGE_INTERVAL as u32);
    }

    /// Fait avancer la fraîcheur des piles au sol de `elapsed` ticks, à la
    /// vitesse donnée par la température **actuelle** de chaque case
    /// (`climate::spoilage_divisor`) : rien ne bouge sous le gel, vitesse
    /// nominale au chaud. Une pile qui tombe à 0 disparaît ; sinon
    /// `ItemStack::spoil_at` est ré-estimé à cette même vitesse, pour
    /// l'affichage.
    ///
    /// Partagée par le sweep périodique ci-dessus (`elapsed` =
    /// `SPOILAGE_INTERVAL`) et par l'avance rapide (`Sim::fast_forward`), qui
    /// lui fait avaler tout l'écart gelé d'un coup — on ne connaît pas la
    /// météo passée, seulement la température **actuelle** de chaque case.
    pub(crate) fn spoil_items(&mut self, elapsed: u32) {
        if elapsed == 0 {
            return;
        }
        let now = self.tick;
        let preservation = self.research.is_done(Tech::Preservation);
        let mut k = 0;
        while k < self.items.len() {
            let Some(life) = self.items[k].kind.shelf_life() else {
                k += 1;
                continue;
            };
            let (x, y) = (self.items[k].x, self.items[k].y);
            let temperature = self.tile_temperature(x, y);
            let Some(divisor) = climate::spoilage_divisor(temperature) else {
                // Gelé : aucune perte ce coup-ci.
                k += 1;
                continue;
            };
            // La conservation vient s'ajouter au froid : elle multiplie le
            // diviseur, elle ne le remplace pas.
            let divisor = research::spoilage_divisor(divisor, preservation);
            // Perte du lot, en millionièmes : voir `ItemStack::freshness`.
            // Tout se fait en `u64` et la division vient en dernier — un
            // `1_000_000 / shelf_life` tronqué trop tôt (`shelf_life` ne
            // divise presque jamais pile un million) accumulerait un déficit
            // qui retarderait la disparition de quelques ticks à chaque
            // graine, ici sur toute une durée de vie.
            let denom = u64::from(life) * u64::from(divisor);
            let loss = (u64::from(FRESHNESS_MAX) * u64::from(elapsed) / denom.max(1)) as u32;
            let s = &mut self.items[k];
            s.freshness = s.freshness.saturating_sub(loss.max(1));
            if s.freshness == 0 {
                self.items.remove(k);
                continue;
            }
            // Vitesse effective (en millionièmes par tick) pour l'estimation
            // d'affichage ci-dessous : `.max(1)` pour ne jamais diviser par 0.
            let effective = (FRESHNESS_MAX / (life.saturating_mul(divisor))).max(1);
            s.spoil_at = now + u64::from(s.freshness / effective);
            k += 1;
        }
    }

    // ------------------------------------------------------------------
    // Objets et repousse
    // ------------------------------------------------------------------

    /// Pose `count` objets en `(x, y)`, fusionnés avec une pile existante du
    /// même genre si elle a la place.
    pub fn spawn_item(&mut self, kind: ItemKind, count: u32, x: u32, y: u32) {
        if count == 0 {
            return;
        }
        let spoil_at = kind
            .shelf_life()
            .map_or(u64::MAX, |life| self.tick + u64::from(life));
        // Fraîche à la création ; `u32::MAX` si le genre ne périme pas
        // (voir `ItemStack::freshness`).
        let freshness = if kind.shelf_life().is_some() {
            FRESHNESS_MAX
        } else {
            u32::MAX
        };
        if let Some(s) = self
            .items
            .iter_mut()
            .find(|s| (s.x, s.y) == (x, y) && s.kind == kind && s.count + count <= STACK_MAX)
        {
            s.count += count;
            // La pile fusionnée se gâte à la date la plus proche et prend la
            // fraîcheur la plus basse : mélanger du frais à du vieux ne
            // rajeunit rien.
            s.spoil_at = s.spoil_at.min(spoil_at);
            s.freshness = s.freshness.min(freshness);
            return;
        }
        let id = self.next_id;
        self.next_id += 1;
        self.items.push(ItemStack {
            id,
            kind,
            count,
            x,
            y,
            reserved_by: None,
            spoil_at,
            freshness,
        });
    }

    /// Les buissons récoltés refont leurs baies. Sous le gel, rien ne repousse :
    /// l'échéance est **repoussée**, pas perdue — le buisson repartira au
    /// premier redoux.
    pub(crate) fn tick_regrowth(&mut self, outdoor: i32) {
        if self.regrow.is_empty() {
            return;
        }
        let now = self.tick;
        let mut k = 0;
        while k < self.regrow.len() {
            if self.regrow[k].ready_at <= now {
                let (x, y) = (self.regrow[k].x, self.regrow[k].y);
                if outdoor + self.indoor_bonus(x, y) < climate::FREEZING {
                    self.regrow[k].ready_at = now + u64::from(climate::FROST_REGROW_DELAY);
                    k += 1;
                    continue;
                }
                let r = self.regrow.remove(k);
                if self.map.feature(r.x, r.y) == Feature::BushUnripe {
                    self.map.set_feature(r.x, r.y, Feature::Bush);
                }
            } else {
                k += 1;
            }
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Reservation {
    pub x: u32,
    pub y: u32,
    pub pawn: u32,
}

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Regrow {
    pub x: u32,
    pub y: u32,
    pub ready_at: u64,
}
