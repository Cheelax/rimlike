//! Menaces : santé, raids, combat de mêlée, mort.
//!
//! Comme le reste du sim, toutes les recherches trient leurs candidats par
//! `(distance, x, y, id)` avant de tenter un chemin : l'ordre est total, donc
//! identique sur tous les clients.

use crate::animals::BOAR_DAMAGE;
use crate::health::{
    self, BLEED_INTERVAL, BLOOD_MAX, BLOOD_REGEN_INTERVAL, DOWNED_BLOOD, DOWNED_CONSCIOUSNESS,
    UP_BLOOD, UP_CONSCIOUSNESS,
};
use crate::items::ItemKind;
use crate::map::{Feature, Map, chebyshev};
use crate::path;
use crate::pawn::{Faction, Job, Pawn};
use crate::research;
use crate::social;
use crate::traits::{self, Trait};
use crate::work;
use crate::{EventKind, Sim, TICKS_PER_DAY, Tech};

/// Ticks entre deux coups d'un même pawn.
pub const ATTACK_COOLDOWN: u32 = 60;
/// Dégâts d'un colon à mains nues, bornes de `range_i32`. L'arme et la
/// compétence viennent ensuite en pourcentage (`strike_percent`).
pub const COLONIST_DAMAGE: (i32, i32) = (80, 121);
/// Dégâts d'un pillard à mains nues, bornes de `range_i32`.
pub const RAIDER_DAMAGE: (i32, i32) = (70, 111);
/// Portée d'un arc, en cases (distance de Tchebychev).
pub const BOW_RANGE: u32 = 8;
/// Ticks entre deux flèches. Un arc frappe moins souvent qu'un gourdin.
pub const RANGED_COOLDOWN: u32 = 90;
/// Dégâts d'une flèche, bornes de `range_i32`.
pub const RANGED_DAMAGE: (i32, i32) = (50, 81);
/// Précision d'un tireur débutant, en pourcentage, plus 3 par niveau.
pub const RANGED_BASE_ACCURACY: u32 = 40;
/// Jusqu'à cette distance, on tire sans malus.
pub const RANGED_SWEET_SPOT: u32 = 3;
/// Précision perdue par case au-delà de `RANGED_SWEET_SPOT`, en points.
pub const RANGED_FALLOFF: u32 = 4;
/// Un tir garde toujours cette chance de toucher.
pub const RANGED_MIN_ACCURACY: u32 = 10;

/// Efficacité au corps à corps apportée par le niveau, en pourcentage :
/// 70 % au niveau 0, 100 % au niveau 10, 130 % au niveau 20.
pub fn melee_skill_percent(level: u8) -> u32 {
    70 + 3 * u32::from(level)
}

/// Chance de toucher d'une flèche, en pourcentage : le niveau ouvre la mire,
/// la distance la referme au-delà de `RANGED_SWEET_SPOT`.
pub fn ranged_accuracy_percent(level: u8, distance: u32) -> u32 {
    let base = RANGED_BASE_ACCURACY + 3 * u32::from(level);
    let malus = RANGED_FALLOFF * distance.saturating_sub(RANGED_SWEET_SPOT);
    base.saturating_sub(malus).max(RANGED_MIN_ACCURACY)
}

/// Ligne de vue entre deux cases, tracée en Bresenham entier. Toute case
/// infranchissable coupe la vue (mur, rocher, arbre, feu, eau profonde), et
/// toute porte aussi : la v1 ne sait pas si elle est ouverte. Ni la case de
/// départ ni celle de la cible ne bloquent — on se voit de mur à mur.
pub fn line_of_sight(map: &Map, from: (u32, u32), to: (u32, u32)) -> bool {
    let (mut x, mut y) = (from.0 as i32, from.1 as i32);
    let (tx, ty) = (to.0 as i32, to.1 as i32);
    let dx = (tx - x).abs();
    let dy = -(ty - y).abs();
    let sx = if x < tx { 1 } else { -1 };
    let sy = if y < ty { 1 } else { -1 };
    let mut err = dx + dy;
    while (x, y) != (tx, ty) {
        let e2 = 2 * err;
        if e2 >= dy {
            err += dy;
            x += sx;
        }
        if e2 <= dx {
            err += dx;
            y += sy;
        }
        if (x, y) == (tx, ty) {
            return true;
        }
        if !map.in_bounds(x, y) {
            return false;
        }
        let (ux, uy) = (x as u32, y as u32);
        if !map.passable(ux, uy) || map.feature(ux, uy).is_door() {
            return false;
        }
    }
    true
}
/// Un colon attaque de lui-même un ennemi jusqu'à cette distance.
pub const DEFEND_RADIUS: u32 = 8;
/// En dessous de ces PV, un pillard décroche et quitte la carte. Assez haut
/// pour qu'un pillard lâche prise après une bonne raclée (environ 40 % de
/// sévérité cumulée) plutôt que de s'acharner jusqu'à l'agonie : un colon
/// pris à part (occupé loin des autres au moment du raid, cas courant en
/// vraie partie) a le temps de se faire mal sans que ça tourne
/// systématiquement au drame. `first_raid_is_dangerous_but_survivable`
/// (colons groupés à l'arrivée du raid) passe déjà à 300 : c'est un scénario
/// mesuré à part (trois colons envoyés aux coins de la carte avant le raid,
/// hors suite de tests) qui a servi de vraie jauge — à 300, ce scénario
/// dispersé perdait souvent deux colons sur 200 graines ; à 600, plus aucun
/// double mort, pour une baisse de moitié seulement du total des morts.
///
/// Remonté de 600 à 650 le 2026-09-05, quand les pillards sont arrivés armés
/// (gourdin puis épieu) et les colons pénalisés par le facteur de compétence
/// de mêlée. Mesuré sur 60 graines, premier raid joué jusqu'au bout :
///
/// | scénario  | avant les armes | armé, 600 | armé, **650** | armé, 700 |
/// |---|---|---|---|---|
/// | groupés : morts    |  5 | 15 | 10 |  6 |
/// | dispersés : morts  | 29 | 57 | 41 | 21 |
/// | dispersés : doubles morts | 0 | 4 | **0** | 0 |
///
/// 650 est le premier palier qui rend au scénario dispersé sa propriété
/// « jamais deux morts d'un coup » sans annuler l'effet des armes : à 700 un
/// raid armé tuerait moins qu'un raid à mains nues, ce qui n'aurait aucun sens.
pub const FLEE_HP: u32 = 650;
/// Un pawn à jeun perd 1 PV tous ces ticks.
pub const STARVE_DAMAGE_INTERVAL: u64 = 28;
/// Un pawn nourri regagne 1 PV tous ces ticks.
pub const HEAL_INTERVAL: u64 = 60;
/// Deux fois plus vite au lit.
pub const HEAL_INTERVAL_BED: u64 = 30;
// `tick_injuries` s'appuie dessus pour ne consulter la carte qu'un tick sur
// `HEAL_INTERVAL_BED` : le plus long des deux intervalles doit être un
// multiple du plus court.
const _: () = assert!(HEAL_INTERVAL % HEAL_INTERVAL_BED == 0);
/// Jours de tranquillité avant le premier raid.
pub const GRACE_DAYS: u32 = 3;
/// Durée du deuil après la mort d'un colon.
pub const GRIEF_TICKS: u32 = TICKS_PER_DAY * 2;
/// Taille maximale d'un raid. Relevée de 6 à 12 le 2026-09-05 : la taille
/// d'une bande n'est plus « 1 + colons / 2 » mais ce que les points de menace
/// achètent (`storyteller::POINTS_PER_RAIDER`), et une colonie riche en
/// difficile dépasse largement l'ancien plafond.
pub const MAX_RAIDERS: u32 = 12;

/// Sévérité de la blessure d'un piège à pointes, posée sur une jambe et
/// saignante comme un coup d'épieu (`health::BLEED_FRACTION`).
///
/// **Mesurée, pas devinée.** Scénario : colonie murée de trois colons, une
/// seule entrée de trois cases toutes piégées, trois pillards à mains nues
/// lâchés devant ; 120 graines, la même jouée avec et sans pièges, jusqu'à ce
/// qu'aucun pillard ne reste debout (au plus trois jours). « À terre ou tué »
/// se compte parmi les **pillards piégés** (357 sur les 360 possibles : le
/// couloir en épargne à peine un).
///
/// | sévérité | à terre ou tué | repartis vivants | PV perdus par la colonie (avec / sans pièges) |
/// |---|---|---|---|
/// |   0 (piège inoffensif) | 25 % | 74 % | 1271 / 1169 |
/// | 180 | 42 % | 57 % |  884 / 1210 |
/// | 200 | 38 % | 61 % |  800 / 1210 |
/// | **250** | **50 %** | 50 % |  **741 / 1210** |
/// | 300 | 40 % | 59 % |  627 / 1210 |
///
/// 250 est le palier qui met à terre ou tue exactement un pillard piégé sur
/// deux. Ce n'est pas monotone, et c'est le seuil de décrochage qui l'explique :
/// à 300, le pillard tombe à 700 PV et passe sous `FLEE_HP` au premier coup
/// reçu — il repart par le bord avant d'avoir saigné, la blessure plus grave
/// tue donc **moins**. À 250 il lui reste 750 PV, assez pour rester au contact
/// le temps que le saignement (250 / 4 = 62 points de sang par
/// `health::BLEED_INTERVAL`, sur `health::BLEED_TICKS`, soit bien plus que les
/// 1000 points d'un corps) fasse son œuvre. Au-delà de `HP_MAX - FLEE_HP`
/// (350), le piège ferait décrocher le pillard sur le coup : il repartirait
/// vivant, exactement le contraire du but.
///
/// La ligne à 0 est le témoin : un piège qui ne fait que barrer le passage
/// **coûte** des PV à la colonie (1271 contre 1169), parce qu'il empêche les
/// colons de sortir prendre les pillards à revers. C'est la blessure, et elle
/// seule, qui fait d'un piège une défense.
pub const TRAP_SEVERITY: u32 = 250;

/// Durée du réarmement d'un piège déclenché (`pawn::Job::RearmTrap`). Sans
/// matériau : on remet les pointes en place, on ne les retaille pas. Court
/// exprès — le coût d'un piège est le bois qu'il a fallu pour le poser, pas
/// l'entretien.
pub const REARM_TICKS: u32 = 100;

/// Ce qu'a donné un tour d'approche-et-frappe (`Sim::engage`). L'appelant
/// décide quoi faire d'un échec : un pillard repart, un chasseur abandonne son
/// gibier, un sanglier détale.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum EngageOutcome {
    /// La cible n'existe plus : morte, partie, ou id inconnu.
    Gone,
    /// Aucun chemin jusqu'à elle (les murs comptent).
    Unreachable,
    /// En cours : on avance, on frappe, ou on attend la fin du cooldown.
    Engaged,
}

/// Nombre de cibles pour lesquelles on tente un chemin par recherche.
const MELEE_TARGETS: usize = 3;
/// Nombre de cases de bord testées par un fuyard.
const FLEE_ATTEMPTS: usize = 6;
/// Tirages de case d'entrée avant d'abandonner un raid.
const ENTRY_DRAWS: u32 = 12;

impl Sim {
    // ------------------------------------------------------------------
    // Santé
    // ------------------------------------------------------------------

    /// Faim qui ronge, plaies qui se referment et cicatrisent, sang qui se
    /// perd ou se refait, écroulement et relevé, minuteries de combat et de
    /// deuil. Le chemin d'un pawn en pleine forme reste court : deux tests.
    pub(crate) fn tick_health(&mut self, i: usize) {
        // La maladie : `sick` est la recopie de `sick_until`, comme
        // `outdoor_storm` est celle de la météo. Guéri, on oublie aussi le
        // pansement : la prochaine maladie repartira de zéro.
        let sick = self.pawns[i].sick_until > self.tick;
        self.pawns[i].sick = sick;
        if !sick {
            self.pawns[i].illness_tended = false;
        }
        if self.pawns[i].hunger == 0 && self.tick % STARVE_DAMAGE_INTERVAL == 0 {
            // La famine n'entame plus les PV directement : elle affaiblit le torse.
            self.pawns[i].starve_torso();
        }
        if !self.pawns[i].injuries.is_empty() {
            self.tick_injuries(i);
        }
        self.tick_blood(i);
        self.update_downed(i);
        self.pawns[i].attack_cooldown = self.pawns[i].attack_cooldown.saturating_sub(1);
        self.pawns[i].grief_ticks = self.pawns[i].grief_ticks.saturating_sub(1);
        self.pawns[i].relief_ticks = self.pawns[i].relief_ticks.saturating_sub(1);
        // Le souvenir d'une conversation, ou d'une dispute, s'estompe au même
        // rythme (voir `social`).
        self.pawns[i].social_ticks = self.pawns[i].social_ticks.saturating_sub(1);
        self.pawns[i].quarrel_ticks = self.pawns[i].quarrel_ticks.saturating_sub(1);
    }

    /// Referme les plaies au bout de `BLEED_TICKS`, fait cicatriser d'un point
    /// par intervalle (deux fois plus vite si la blessure est pansée) et
    /// oublie les blessures guéries.
    fn tick_injuries(&mut self, i: usize) {
        // `HEAL_INTERVAL` est un multiple de `HEAL_INTERVAL_BED` : hors de ces
        // ticks-là, aucune cicatrisation n'est possible et on s'épargne le
        // coup d'œil à la carte (le saignement, lui, s'écoule à chaque tick).
        // Sous `HYPOTHERMIA_TEMP`, plus rien ne cicatrise : le froid entretient
        // les plaies, et c'est ce qui rend l'hypothermie dangereuse — sans
        // cela, une atteinte de `COLD_SEVERITY` toutes les
        // `HYPOTHERMIA_INTERVAL` guérirait plus vite qu'elle ne s'aggrave.
        let heals = self.tick % HEAL_INTERVAL_BED == 0
            && !self.pawns[i].is_starving()
            && self.pawns[i].comfort >= crate::climate::HYPOTHERMIA_TEMP
            && self.tick % self.heal_interval(i) == 0;
        // La médecine fait cicatriser les plaies **pansées** moitié plus vite ;
        // une plaie laissée à l'air libre ne profite de rien.
        let tended_points = research::tended_heal_points(self.research.is_done(Tech::Medicine));
        let p = &mut self.pawns[i];
        for inj in &mut p.injuries {
            if inj.bleeding > 0 {
                inj.bleed_ticks = inj.bleed_ticks.saturating_sub(1);
                if inj.bleed_ticks == 0 {
                    inj.close();
                }
            }
            if heals {
                inj.severity =
                    inj.severity
                        .saturating_sub(if inj.tended { tended_points } else { 1 });
            }
        }
        if heals {
            p.injuries.retain(|inj| inj.severity > 0);
            p.recompute_hp();
        }
    }

    /// Un blessé allongé — endormi ou à terre — cicatrise deux fois plus vite.
    fn heal_interval(&self, i: usize) -> u64 {
        let (x, y) = self.pawns[i].tile();
        let in_bed = matches!(self.pawns[i].job, Job::Sleep { in_bed: true } | Job::Downed)
            && !self.pawns[i].is_moving()
            && self.map.feature(x, y) == Feature::Bed;
        if in_bed {
            HEAL_INTERVAL_BED
        } else {
            HEAL_INTERVAL
        }
    }

    /// Le sang se perd par tranches de `BLEED_INTERVAL` ticks et se refait
    /// lentement dès qu'aucune plaie ne coule.
    fn tick_blood(&mut self, i: usize) {
        let tick = self.tick;
        let p = &mut self.pawns[i];
        if p.injuries.is_empty() {
            // Cas courant : rien ne coule, le corps se refait doucement.
            if p.blood < BLOOD_MAX && tick % BLOOD_REGEN_INTERVAL == 0 {
                p.blood += 1;
            }
            return;
        }
        let rate = p.bleed_rate();
        if rate > 0 {
            if tick % BLEED_INTERVAL == 0 {
                p.blood = p.blood.saturating_sub(rate);
                // Le sang à zéro tue : `recompute_hp` s'en charge.
                p.recompute_hp();
            }
        } else if p.blood < BLOOD_MAX && tick % BLOOD_REGEN_INTERVAL == 0 {
            p.blood += 1;
        }
    }

    /// Fait tomber ou relever le pawn. L'hystérésis (30/40 %) évite qu'un
    /// blessé clignote entre les deux états.
    fn update_downed(&mut self, i: usize) {
        let p = &self.pawns[i];
        if p.is_downed() {
            if p.consciousness_percent() >= UP_CONSCIOUSNESS && p.blood >= UP_BLOOD {
                self.pawns[i].job = Job::Idle;
                self.pawns[i].idle_ticks = 0;
            }
            return;
        }
        // Sortie rapide : sans blessure et avec du sang, personne ne s'écroule.
        if p.injuries.is_empty() && p.blood >= UP_BLOOD {
            return;
        }
        if p.consciousness_percent() >= DOWNED_CONSCIOUSNESS && p.blood >= DOWNED_BLOOD {
            return;
        }
        // Il lâche tout : réservations, chargement, et le blessé qu'il portait.
        self.abandon_job(i);
        self.pawns[i].job = Job::Downed;
        // Une bête de la colonie qui s'écroule n'appelle pas les secours : le
        // sauvetage et les soins sont affaire de colons (voir `livestock`).
        if self.pawns[i].is_colonist() {
            let id = self.pawns[i].id;
            self.push_event(EventKind::ColonistDowned, id);
        }
    }

    // ------------------------------------------------------------------
    // Arrivées
    // ------------------------------------------------------------------
    //
    // Ce qui **décide** de faire entrer quelqu'un vit dans `storyteller` ;
    // ici, on ne fait que trouver par où et le poser sur la carte.

    /// Case de bord d'où la colonie est vraiment atteignable : sinon un
    /// arrivant resterait planté derrière un mur ou de l'eau.
    pub(crate) fn find_entry_tile(&mut self) -> Option<(u32, u32)> {
        let colonists = self.living_colonist_tiles();
        if colonists.is_empty() {
            return None;
        }
        let edges = self.edge_tiles();
        if edges.is_empty() {
            return None;
        }
        for _ in 0..ENTRY_DRAWS {
            let e = edges[self.rng.below(edges.len() as u32) as usize];
            if self.can_reach_any(e, &colonists) {
                return Some(e);
            }
        }
        None
    }

    /// Un colon de passage s'installe. Renvoie vrai s'il a trouvé sa place.
    pub fn spawn_wanderer(&mut self) -> bool {
        if self.pawns.iter().all(|p| !p.is_alive() || !p.is_colonist()) {
            return false;
        }
        let Some(entry) = self.find_entry_tile() else {
            return false;
        };
        let mut r: i32 = 0;
        while r < 8 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let x = entry.0 as i32 + dx;
                    let y = entry.1 as i32 + dy;
                    if !self.map.in_bounds(x, y) {
                        continue;
                    }
                    let tile = (x as u32, y as u32);
                    if !self.map.passable(tile.0, tile.1)
                        || self.pawns.iter().any(|p| p.tile() == tile)
                    {
                        continue;
                    }
                    // `Pawn::at_tile` donne déjà la colonie et les priorités par défaut ;
                    // `spawn_pawn` tire son nom et ses compétences de départ.
                    let id = self.spawn_pawn(tile.0, tile.1, Faction::Colony);
                    let k = self.pawns.len() - 1;
                    self.pawns[k].hunger = 600_000;
                    self.pawns[k].rest = 700_000;
                    self.push_event(EventKind::WandererJoined, id);
                    return true;
                }
            }
            r += 1;
        }
        false
    }

    /// Un pillard vivant traîne-t-il encore sur la carte ? Sert à
    /// `Trait::Coward` (`Pawn::mood`), recopié par pawn à chaque tick comme
    /// `outdoor_storm` (voir `Sim::tick_pawn`).
    pub(crate) fn raider_alive(&self) -> bool {
        self.pawns
            .iter()
            .any(|p| p.is_alive() && p.is_raider_like())
    }

    /// Cases des **colons** vivants, dans l'ordre des indices. Les bêtes
    /// apprivoisées n'en sont pas : une colonie réduite à son troupeau est
    /// éteinte, et rien n'a plus de raison d'entrer sur la carte.
    fn living_colonist_tiles(&self) -> Vec<(u32, u32, u32)> {
        self.pawns
            .iter()
            .filter(|p| p.is_alive() && p.is_colonist())
            .map(|p| {
                let (x, y) = p.tile();
                (x, y, p.id)
            })
            .collect()
    }

    /// Cases franchissables du bord, dans un ordre fixe : rangée du haut,
    /// rangée du bas, puis les colonnes de gauche et de droite.
    fn edge_tiles(&self) -> Vec<(u32, u32)> {
        let (w, h) = (self.map.width(), self.map.height());
        let mut out = Vec::new();
        if w == 0 || h == 0 {
            return out;
        }
        for x in 0..w {
            if self.map.passable(x, 0) {
                out.push((x, 0));
            }
        }
        if h > 1 {
            for x in 0..w {
                if self.map.passable(x, h - 1) {
                    out.push((x, h - 1));
                }
            }
        }
        for y in 1..h.saturating_sub(1) {
            if self.map.passable(0, y) {
                out.push((0, y));
            }
            if w > 1 && self.map.passable(w - 1, y) {
                out.push((w - 1, y));
            }
        }
        out
    }

    pub(crate) fn is_edge_tile(&self, t: (u32, u32)) -> bool {
        t.0 == 0 || t.1 == 0 || t.0 + 1 >= self.map.width() || t.1 + 1 >= self.map.height()
    }

    /// Y a-t-il un chemin de `from` jusqu'au voisinage d'une des cibles ?
    fn can_reach_any(&self, from: (u32, u32), targets: &[(u32, u32, u32)]) -> bool {
        let mut sorted: Vec<(u32, u32, u32, u32)> = targets
            .iter()
            .map(|&(x, y, id)| (chebyshev(from, (x, y)), x, y, id))
            .collect();
        sorted.sort_unstable();
        sorted
            .iter()
            .take(MELEE_TARGETS)
            .any(|&(d, x, y, _)| d <= 1 || self.path_adjacent(from, (x, y)).is_some())
    }

    // ------------------------------------------------------------------
    // Décision
    // ------------------------------------------------------------------

    /// Un colon qui voit un ennemi à portée lâche ce qu'il fait et l'attaque.
    /// Renvoie vrai s'il vient de s'y mettre. Un couard (`Trait::Coward`) ne
    /// se défend jamais de lui-même : il subit le combat, il ne le cherche
    /// pas. Un ordre du joueur (`Command::Attack`) pose `Job::Attack`
    /// ailleurs et reste possible.
    pub(crate) fn defend_if_threatened(&mut self, i: usize) -> bool {
        if self.pawns[i].has_trait(Trait::Coward) {
            return false;
        }
        if matches!(
            self.pawns[i].job,
            Job::Attack { .. } | Job::Move { manual: true }
        ) {
            return false;
        }
        let Some(id) = self.nearest_reachable_enemy(i, DEFEND_RADIUS) else {
            return false;
        };
        self.abandon_job(i);
        self.pawns[i].job = Job::Attack { target: id };
        true
    }

    /// Un pillard fonce sur le colon accessible le plus proche, ou décroche.
    /// Partagée avec le marchand devenu hostile (voir `trade`) : mêmes coups,
    /// même seuil de décrochage, même sortie de carte.
    pub(crate) fn raider_ai(&mut self, i: usize) {
        if self.pawns[i].hp < FLEE_HP {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Flee;
            return;
        }
        match self.nearest_reachable_enemy(i, u32::MAX) {
            // Personne d'atteignable (les murs comptent) : on repart.
            None => {
                self.pawns[i].path.clear();
                self.pawns[i].job = Job::Flee;
            }
            Some(id) => self.pawns[i].job = Job::Attack { target: id },
        }
    }

    /// Un assiégeant campe à son point d'entrée jusqu'à l'heure dite
    /// (`storyteller::SIEGE_TICKS`). Il ne bouge pas, ne frappe pas, ne fuit
    /// pas — mais le premier coup reçu le décide : blessé, il reprend l'IA
    /// normale et charge (ou décroche s'il est déjà mal en point).
    pub(crate) fn do_wait(&mut self, i: usize, until: u64) {
        let hurt = self.pawns[i].hp < self.pawns[i].max_hp();
        if self.tick < until && !hurt {
            return;
        }
        self.pawns[i].job = Job::Idle;
        self.raider_ai(i);
    }

    /// Une bête compte-t-elle comme ennemi qu'on prend de soi-même ? Non :
    /// un raid ne se détourne pas sur un lapin, et un colon ne lâche pas son
    /// chantier pour un cerf qui passe (c'est la chasse, pas la défense). La
    /// seule exception est le sanglier lancé à la charge : celui-là est une
    /// menace, et les colons se défendent.
    ///
    /// Une bête **apprivoisée** est de `Faction::Colony` : elle ne passe donc
    /// pas par ce test côté colons (même camp), mais les pillards la visent
    /// comme n'importe qui de la colonie — et comme `nearest_reachable_enemy`
    /// trie par distance, ils s'en prennent à elle quand elle est plus près
    /// qu'un colon. C'est voulu : un troupeau se garde (voir `livestock`).
    fn is_auto_target(&self, p: &Pawn, seeker: Faction) -> bool {
        // Un marchand furieux ne s'en prend qu'à la colonie : il est venu
        // commercer, pas prendre parti dans un raid (voir `trade`).
        if seeker == Faction::Trader {
            return p.faction == Faction::Colony;
        }
        // Un marchand pacifique n'est la cible de personne : ni des colons
        // (c'est un invité), ni des pillards (ils ont mieux à faire).
        if p.faction == Faction::Trader {
            return p.hostile;
        }
        if p.faction != Faction::Animal {
            return true;
        }
        seeker == Faction::Colony
            && matches!(p.job, Job::Attack { .. })
            && p.species.is_some_and(|s| s.aggressive())
    }

    /// Id de l'ennemi vivant le plus proche dans `radius`, parmi les
    /// `MELEE_TARGETS` premiers pour lesquels un chemin existe. Les pawns à
    /// terre ne sont jamais visés d'eux-mêmes : les pillards passent devant un
    /// colon écroulé sans s'y arrêter, ce qui laisse une chance au sauvetage.
    /// Un ordre explicite du joueur (`Command::Attack`) reste possible.
    ///
    /// Le chemin est celui du **chercheur** (`Sim::walker`) : un colon qui ne
    /// peut atteindre un pillard qu'en traversant ses propres pièges ne le
    /// prend pas pour cible — sans quoi il basculerait d'`Attack` à `Idle` à
    /// chaque tick sans jamais travailler ni se battre.
    fn nearest_reachable_enemy(&self, i: usize, radius: u32) -> Option<u32> {
        let me = self.pawns[i].tile();
        let faction = self.pawns[i].faction;
        let walker = self.walker(i);
        let mut enemies: Vec<(u32, u32, u32, u32)> = self
            .pawns
            .iter()
            .filter(|p| {
                p.is_alive()
                    && p.faction != faction
                    && !p.is_downed()
                    && self.is_auto_target(p, faction)
            })
            .map(|p| {
                let (x, y) = p.tile();
                (chebyshev(me, (x, y)), x, y, p.id)
            })
            .filter(|&(d, ..)| d <= radius)
            .collect();
        enemies.sort_unstable();
        enemies
            .iter()
            .take(MELEE_TARGETS)
            .find(|&&(d, x, y, _)| d <= 1 || self.path_adjacent_for(me, (x, y), walker).is_some())
            .map(|&(.., id)| id)
    }

    // ------------------------------------------------------------------
    // Exécution
    // ------------------------------------------------------------------

    /// Approcher et frapper (ou tirer). Le cœur du combat, partagé par
    /// l'attaque (`Job::Attack`), la chasse (`Job::Hunt`) et la charge d'un
    /// sanglier : mêmes portées, mêmes cooldowns, même XP. Ce qui diffère —
    /// qui décroche, qui achève un corps à terre, ce qu'on fait après un
    /// échec — reste chez l'appelant.
    pub(crate) fn engage(&mut self, i: usize, target: u32) -> EngageOutcome {
        let Some(k) = self
            .pawns
            .iter()
            .position(|p| p.id == target && p.is_alive())
        else {
            return EngageOutcome::Gone;
        };
        let me = self.pawns[i].tile();
        let them = self.pawns[k].tile();
        let distance = chebyshev(me, them);
        if distance <= 1 {
            self.pawns[i].path.clear();
            if self.pawns[i].attack_cooldown == 0 {
                self.melee_strike(i, k);
            }
            return EngageOutcome::Engaged;
        }
        // Un tireur garde ses distances : cible en vue et à portée, il s'arrête
        // là où il est et décoche.
        if self.pawns[i].weapon == Some(ItemKind::Bow)
            && distance <= research::bow_range(BOW_RANGE, self.research.is_done(Tech::Archery))
            && line_of_sight(&self.map, me, them)
        {
            self.pawns[i].path.clear();
            if self.pawns[i].attack_cooldown == 0 {
                self.shoot(i, k, distance);
            }
            return EngageOutcome::Engaged;
        }
        // Le chemin est stocké inversé : `first()` est la destination.
        let stale = self.pawns[i]
            .path
            .first()
            .is_none_or(|&(dx, dy)| chebyshev((u32::from(dx), u32::from(dy)), them) > 1);
        if stale {
            // Un colon qui charge ne traverse pas ses propres pièges ; un
            // pillard, lui, ne les voit pas venir.
            let walker = self.walker(i);
            match self.path_adjacent_for(me, them, walker) {
                Some(p) => self.pawns[i].set_path(p),
                None => return EngageOutcome::Unreachable,
            }
        }
        self.pawns[i].advance(&self.map);
        EngageOutcome::Engaged
    }

    pub(crate) fn do_attack(&mut self, i: usize, target: u32) {
        if self.pawns[i].is_raider_like() && self.pawns[i].hp < FLEE_HP {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Flee;
            return;
        }
        // Un pillard ne s'acharne pas sur un corps à terre : il cherche une
        // autre cible debout, ou repart.
        if self.pawns[i].is_raider_like()
            && self
                .pawns
                .iter()
                .any(|p| p.id == target && p.is_alive() && p.is_downed())
        {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
            return;
        }
        if self.engage(i, target) != EngageOutcome::Engaged {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Idle;
        }
    }

    /// Un coup au corps à corps : deux tirages dans un ordre fixe, les dégâts
    /// puis la partie du corps touchée. Le coup laisse une plaie qui saigne.
    fn melee_strike(&mut self, i: usize, k: usize) {
        let faction = self.pawns[i].faction;
        // L'**espèce** décide avant la faction : un sanglier apprivoisé est de
        // `Faction::Colony` et frappe pourtant du boutoir (voir `livestock`).
        let beast = self.pawns[i].species.is_some();
        let (lo, hi) = if beast {
            BOAR_DAMAGE
        } else {
            match faction {
                Faction::Colony => COLONIST_DAMAGE,
                // Un marchand qu'on a poussé à bout se bat comme un pillard.
                Faction::Raider | Faction::Trader => RAIDER_DAMAGE,
                Faction::Animal => BOAR_DAMAGE,
            }
        };
        let roll = self.rng.range_i32(lo, hi) as u32;
        // Une bête ne tient pas d'arme et n'apprend rien du combat : ses
        // dégâts sont ceux de son espèce, sans facteur.
        let percent = if beast {
            100
        } else {
            let base = self.pawns[i].weapon.map_or(100, |w| w.melee_percent())
                * melee_skill_percent(self.pawns[i].melee.level)
                / 100;
            // Un bagarreur frappe plus fort au corps à corps.
            if self.pawns[i].has_trait(Trait::Brawler) {
                base * traits::BRAWLER_MELEE_PERCENT / 100
            } else {
                base
            }
        };
        let damage = (roll * percent / 100).max(1);
        // `Tough`/`Frail` modulent les dégâts *reçus* : c'est la cible, pas
        // l'attaquant, qui décide (voir `Pawn::damage_from`).
        let damage = self.pawns[k].damage_from(damage);
        let part = health::part_for_roll(self.rng.below(health::HIT_WEIGHT_TOTAL));
        self.pawns[k].add_injury(part, damage, damage / health::BLEED_FRACTION);
        self.pawns[i].attack_cooldown = ATTACK_COOLDOWN;
        let attacker = self.pawns[i].id;
        self.animal_hit(k, Some(attacker));
        self.gain_combat_xp(i, false);
    }

    /// Une flèche : la précision est tirée d'abord (elle ne dépend que de
    /// l'état, donc l'ordre du RNG reste identique partout), puis les dégâts et
    /// la partie touchée si le tir porte. Un tir manqué forme quand même.
    fn shoot(&mut self, i: usize, k: usize, distance: u32) {
        let accuracy = ranged_accuracy_percent(self.pawns[i].ranged.level, distance);
        // Un bagarreur préfère le corps à corps : il vise moins bien à l'arc.
        let accuracy = if self.pawns[i].has_trait(Trait::Brawler) {
            accuracy.saturating_sub(traits::BRAWLER_RANGED_MALUS)
        } else {
            accuracy
        };
        if self.rng.below(100) < accuracy {
            let damage = self.rng.range_i32(RANGED_DAMAGE.0, RANGED_DAMAGE.1) as u32;
            // La recherche affûte la flèche avant que la cible n'encaisse :
            // `Tough`/`Frail` s'appliquent en dernier, sur le coup réel.
            let damage = research::ranged_damage(damage, self.research.is_done(Tech::Archery));
            let damage = self.pawns[k].damage_from(damage);
            let part = health::part_for_roll(self.rng.below(health::HIT_WEIGHT_TOTAL));
            self.pawns[k].add_injury(part, damage, damage / health::BLEED_FRACTION);
            // Une flèche qui porte déclenche la fuite (ou la charge) de la
            // bête ; une flèche perdue ne l'inquiète pas.
            let attacker = self.pawns[i].id;
            self.animal_hit(k, Some(attacker));
        }
        self.pawns[i].attack_cooldown = RANGED_COOLDOWN;
        self.gain_combat_xp(i, true);
    }

    /// Fait progresser une compétence de combat : +1 par coup porté, +1 par
    /// flèche tirée. Mêmes seuils que les compétences de travail, mais hors du
    /// tableau `skills` — et seuls les colons montent en grade au journal.
    fn gain_combat_xp(&mut self, i: usize, ranged: bool) {
        // Une bête ne progresse pas : ses coups ne dépendent pas d'un niveau.
        // Apprivoisée non plus, malgré sa faction (voir `livestock`).
        if self.pawns[i].species.is_some() {
            return;
        }
        let colonist = self.pawns[i].is_colonist();
        let id = self.pawns[i].id;
        let skill = if ranged {
            &mut self.pawns[i].ranged
        } else {
            &mut self.pawns[i].melee
        };
        skill.xp += 1;
        if skill.xp >= work::xp_to_next(skill.level) && skill.level < work::SKILL_MAX {
            skill.level += 1;
            skill.xp = 0;
            if colonist {
                self.push_event(EventKind::LevelUp, id);
            }
        }
    }

    pub(crate) fn do_flee(&mut self, i: usize) {
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        let me = self.pawns[i].tile();
        if self.is_edge_tile(me) {
            self.pawns[i].gone = true;
            return;
        }
        let mut edges: Vec<(u32, u32, u32)> = self
            .edge_tiles()
            .into_iter()
            .map(|(x, y)| (chebyshev(me, (x, y)), x, y))
            .collect();
        edges.sort_unstable();
        let walker = self.walker(i);
        for &(_, x, y) in edges.iter().take(FLEE_ATTEMPTS) {
            let Some(p) = path::find_path_for(&self.map, me, (x, y), walker) else {
                continue;
            };
            if p.is_empty() {
                self.pawns[i].gone = true;
            } else {
                self.pawns[i].set_path(p);
            }
            return;
        }
        // Aucun bord atteignable : le pillard disparaît plutôt que de rester
        // coincé pour l'éternité.
        self.pawns[i].gone = true;
    }

    // ------------------------------------------------------------------
    // Pièges à pointes
    // ------------------------------------------------------------------

    /// Le piège se referme sur qui vient d'**entrer** sur sa case. Appelée
    /// après le tour de chaque pawn (voir `Sim::update`), avec la case qu'il
    /// occupait avant : c'est le changement de case qui déclenche, jamais le
    /// simple fait d'être là. Sans quoi un pillard planté sur un piège se
    /// ferait charcuter à chaque tick.
    ///
    /// Qui tombe dedans : les hostiles (pillards, marchand poussé à bout) et
    /// les bêtes **sauvages**. Jamais un colon — il sait où sont les pointes,
    /// et son chemin les contourne déjà (`path::Walker`) — jamais un marchand
    /// neutre, qui connaît la maison, et jamais une bête apprivoisée, qui la
    /// connaît aussi (voir `livestock`).
    pub(crate) fn spring_trap(&mut self, i: usize, before: (u32, u32)) {
        // Court-circuit du cas courant : aucune colonie n'est piégée.
        if self.map.trap_count() == 0 {
            return;
        }
        let p = &self.pawns[i];
        if !p.is_alive() || !(p.is_raider_like() || p.faction == Faction::Animal) {
            return;
        }
        let here = p.tile();
        if here == before || self.map.feature(here.0, here.1) != Feature::SpikeTrap {
            return;
        }
        // Une jambe ou l'autre. Aucun modificateur de dégâts : ni pillard ni
        // bête ne porte de trait, et un piège ne choisit pas qui passe.
        let part = if self.rng.chance(1, 2) {
            health::BodyPart::LeftLeg
        } else {
            health::BodyPart::RightLeg
        };
        self.pawns[i].add_injury(part, TRAP_SEVERITY, TRAP_SEVERITY / health::BLEED_FRACTION);
        self.map
            .set_feature(here.0, here.1, Feature::SpikeTrapSprung);
        let victim = self.pawns[i].id;
        self.push_event(EventKind::TrapSprung, victim);
        // Une bête prise au piège détale, sanglier compris : il n'y a personne
        // à charger (même règle que `Sim::inflict_injury`).
        self.animal_hit(i, None);
    }

    // ------------------------------------------------------------------
    // Nettoyage
    // ------------------------------------------------------------------

    /// Retire les pawns morts ou partis, libère leurs réservations, pose ce
    /// qu'ils portaient et laisse un cadavre derrière les morts.
    pub(crate) fn remove_dead(&mut self) {
        let mut i = 0;
        while i < self.pawns.len() {
            if self.pawns[i].is_alive() {
                i += 1;
                continue;
            }
            let p = self.pawns.remove(i);
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
            let (x, y) = p.tile();
            if let Some((kind, count)) = p.carrying {
                self.spawn_item(kind, count, x, y);
            }
            if p.hp == 0 {
                // L'**espèce** décide, pas la faction : une bête apprivoisée
                // est de `Faction::Colony` et laisse pourtant une dépouille,
                // pas un cadavre humain (voir `livestock`).
                match (p.species, p.faction) {
                    // Une bête laisse sa dépouille, pas un cadavre humain :
                    // celle-là se transporte et se dépèce.
                    (Some(species), _) => {
                        self.spawn_item(species.corpse_kind(), 1, x, y);
                        // Abattue par un éleveur, elle n'a pas été chassée :
                        // le marquage tranche. Une bête de l'abattoir tuée
                        // entre-temps par un pillard sera donc annoncée comme
                        // abattue — l'écart ne vaut pas un champ de plus.
                        let kind = if p.slaughter_marked {
                            EventKind::Slaughtered
                        } else {
                            EventKind::AnimalHunted
                        };
                        self.push_event(kind, species as u32);
                    }
                    (None, Faction::Animal) => {}
                    (None, faction) => {
                        // L'arme du mort tombe là : butin pour la colonie quand
                        // c'est un pillard, arme à ramasser quand c'est un des
                        // siens. Un fuyard, lui, repart avec la sienne.
                        if let Some(weapon) = p.weapon {
                            self.spawn_item(weapon, 1, x, y);
                        }
                        // Son habit tombe avec : la tunique d'un pillard
                        // d'hiver habille le colon qui l'a abattu.
                        if let Some(apparel) = p.apparel {
                            self.spawn_item(apparel, 1, x, y);
                        }
                        self.spawn_item(ItemKind::Corpse, 1, x, y);
                        if faction == Faction::Colony {
                            // Ceux qui l'aimaient (voir `social`) le pleurent
                            // deux fois plus longtemps.
                            let mut friends: Vec<u32> = Vec::new();
                            for q in &mut self.pawns {
                                if !q.is_colonist() {
                                    continue;
                                }
                                q.grief_ticks = GRIEF_TICKS;
                                if q.opinion_of(p.id) >= social::FRIEND_OPINION {
                                    q.grief_ticks = q
                                        .grief_ticks
                                        .saturating_mul(2)
                                        .min(social::MAX_GRIEF_TICKS);
                                    friends.push(q.id);
                                }
                            }
                            // Une mort sous les coups d'un raid vaut un répit :
                            // le storyteller laisse passer un jour de plus.
                            self.grant_raid_respite();
                            self.push_event(EventKind::ColonistDied, p.id);
                            for friend in friends {
                                self.push_event(EventKind::FriendLost, friend);
                            }
                        } else if faction == Faction::Trader {
                            // Sa réserve tombe là : butin, et réputation (voir
                            // `trade::trader_died`).
                            self.trader_died(&p, (x, y));
                        } else {
                            self.push_event(EventKind::RaiderDied, p.id);
                        }
                    }
                }
            } else if p.faction == Faction::Raider {
                self.push_event(EventKind::RaiderLeft, p.id);
            }
            // Un absent ne pèse plus sur l'humeur de personne : les avis qu'on
            // avait de lui s'effacent, et rendent leur place aux vivants.
            self.forget_opinions_of(p.id);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Terrain;
    use crate::testmap::map_from;

    #[test]
    fn la_vue_porte_a_travers_le_vide_et_bute_sur_les_obstacles() {
        let m = map_from(&["......", "..#...", "......"]);
        assert!(line_of_sight(&m, (0, 0), (0, 0)), "on se voit soi-même");
        assert!(line_of_sight(&m, (0, 0), (5, 0)), "ligne droite dégagée");
        assert!(line_of_sight(&m, (0, 2), (5, 2)), "sous l'obstacle");
        assert!(!line_of_sight(&m, (0, 1), (5, 1)), "rocher en (2, 1)");
        // La case de la cible ne bloque jamais : on vise ce qui est dessus.
        assert!(
            line_of_sight(&m, (0, 1), (2, 1)),
            "tir sur la case du rocher"
        );
        assert!(line_of_sight(&m, (2, 0), (2, 1)), "cible juste à côté");
    }

    #[test]
    fn une_porte_coupe_la_vue_mais_pas_l_eau_peu_profonde() {
        let mut m = map_from(&["....."]);
        assert!(line_of_sight(&m, (0, 0), (4, 0)));
        m.set_terrain(2, 0, Terrain::ShallowWater);
        assert!(
            line_of_sight(&m, (0, 0), (4, 0)),
            "un gué se traverse du regard"
        );
        m.set_terrain(2, 0, Terrain::DeepWater);
        assert!(
            !line_of_sight(&m, (0, 0), (4, 0)),
            "l'eau profonde est un trou"
        );
        m.set_terrain(2, 0, Terrain::Grass);
        m.set_feature(2, 0, Feature::DoorWood);
        assert!(
            !line_of_sight(&m, (0, 0), (4, 0)),
            "une porte est franchissable mais opaque en v1"
        );
    }

    #[test]
    fn la_precision_baisse_avec_la_distance_et_monte_avec_le_niveau() {
        // Sous `RANGED_SWEET_SPOT`, seul le niveau compte.
        assert_eq!(ranged_accuracy_percent(0, 1), RANGED_BASE_ACCURACY);
        assert_eq!(ranged_accuracy_percent(0, 3), RANGED_BASE_ACCURACY);
        assert_eq!(ranged_accuracy_percent(10, 3), RANGED_BASE_ACCURACY + 30);
        // Au-delà, chaque case coûte `RANGED_FALLOFF` points.
        assert_eq!(
            ranged_accuracy_percent(0, 8),
            RANGED_BASE_ACCURACY - 5 * RANGED_FALLOFF
        );
        // Un débutant qui tire au bout de sa portée garde sa chance minimale.
        assert_eq!(ranged_accuracy_percent(0, 100), RANGED_MIN_ACCURACY);
        assert!(ranged_accuracy_percent(20, BOW_RANGE) <= 100);
        // La compétence de mêlée va de 70 % à 130 %.
        assert_eq!(melee_skill_percent(0), 70);
        assert_eq!(melee_skill_percent(crate::work::SKILL_MAX), 130);
    }
}
