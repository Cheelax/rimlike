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

/// Distance à laquelle une bête de la colonie coupe vraiment la route d'un
/// assaillant. Au contact, elle est une cible comme une autre ; au-delà, elle
/// passe **après tous les colons atteignables** dans le choix de cible
/// (`nearest_reachable_enemy`), aussi loin soient-ils : un pillard vient pour
/// la colonie, pas pour son troupeau. « Atteignables » est le mot qui compte :
/// des colons murés ne mettent pas le troupeau à l'abri, ils cèdent la place
/// (voir la seconde passe de `nearest_reachable_enemy`).
///
/// **Mesuré, pas deviné** (`CAMPAIGN-FINDINGS.md` §11.8, campagnes de 60
/// graines × 30 jours en normale, carte 64). La règle d'avant handicapait la
/// bête de trois cases, et le diagnostic a dit pourquoi ça ne pouvait pas
/// suffire : le troupeau paît jusqu'à `livestock::LIVESTOCK_RANGE` du
/// barycentre, la bande entre par un bord de carte, et la bête est
/// régulièrement dix cases plus près qu'un colon. Trois cases de malus
/// n'effacent pas dix cases d'avance — les vingt-sept bêtes perdues de la
/// campagne l'ont toutes été sous les coups d'un pillard, aucune de faim ni
/// de feu.
///
/// | ciblage du bétail | colonies vivantes avec bétail | bêtes tuées par un pillard | morts de colons |
/// |---|---|---|---|
/// | malus de 3 cases | 21 / 35 | 54 | 363 |
/// | malus de 6 cases | 24 / 38 | 33 | 373 |
/// | malus de 12 cases | 23 / 34 | 21 | 374 |
/// | **par rang** | **25 / 33** | **18** | **371** |
/// | témoin sans bétail | — | — | 397 |
///
/// La dernière ligne est celle qui autorise les autres : quel que soit le
/// ciblage, une colonie qui élève perd **moins** de colons qu'une colonie qui
/// n'élève pas. Le troupeau ne devient pas invisible pour autant : une bête au
/// contact reste une cible (c'est ce qui arrive à celle qui bouche une porte),
/// et dès qu'il ne reste aucun colon atteignable — colonie éteinte, ou colons
/// derrière une enceinte fermée — les bêtes se trient entre elles et y
/// passent.
pub const LIVESTOCK_TARGET_REACH: u32 = 1;
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

// ----------------------------------------------------------------------
// La décision tactique : tenir la porte, ou veiller
// ----------------------------------------------------------------------

/// Ce que la colonie fait d'une bande annoncée. Décidé **à la volée**, à
/// chaque fois qu'on le demande : c'est une fonction pure de l'état
/// (`Sim::raid_stance`), pas un champ. Rien n'est ajouté au snapshot ni au
/// hash, et une bande qui perd la moitié des siens fait basculer la colonie
/// dans l'autre posture sans qu'on ait à y penser.
///
/// Valeurs du tampon `raid_status` : libre 0, tenir 1, veille 2.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
#[repr(u8)]
pub enum Stance {
    /// Rien à décider : pas de bande sur la carte, ou pas d'enceinte. Chacun
    /// se bat où il est, comme avant cette fiche.
    #[default]
    Free,
    /// **Tenir la porte** : le rapport de force est favorable. Les colons se
    /// rassemblent côté intérieur de l'entrée et frappent ce qui s'y
    /// présente — y compris sur le seuil. Ils ne courent plus après un
    /// pillard resté dehors.
    Hold,
    /// **La veille** : le rapport de force est défavorable et il y a une
    /// enceinte. Tout le monde rentre, personne ne sort, le travail s'arrête
    /// jusqu'à ce que la bande soit réglée. On ne frappe que ce qui est entré
    /// ou ce qui est au contact.
    Watch,
}

/// Rapport de force, en pourcentage, à partir duquel la colonie **tient la
/// porte** au lieu de veiller : à 100, il lui faut porter autant de coups que
/// la bande.
///
/// **Mesuré, pas deviné** (`crates/sim/tests/balance_threat.rs`,
/// `measure_le_seuil_de_la_decision_tactique`, et `CAMPAIGN-FINDINGS.md`
/// §17). Le seuil retenu est celui qui maximise la survie du joueur **absent**
/// sans rien coûter au joueur **présent**.
pub const HOLD_RATIO_PERCENT: u32 = 150;

/// Rayon du balayage qui cherche l'abri de la colonie autour de son
/// barycentre. Une pièce tient en `map::ROOM_MAX_TILES` (200) cases et
/// l'enceinte du joueur scripté fait treize cases de côté : seize cases
/// autour du barycentre couvrent le cas courant. Si tous les colons sont
/// partis loin, la couche intérieure entière fournit un refuge de secours.
///
/// Le balayage est **court-circuité** par `Map::indoor_count`
/// (aucune pièce, aucun balayage), et il ne tourne qu'une fois par
/// `jobs::RETRY_TICKS` et par colon, et seulement pendant qu'une bande est
/// là : c'est la règle de `AGENTS.md` sur les recherches, appliquée ici.
const SHELTER_RANGE: i32 = 16;

/// À cette distance du poste, un colon est **en place**. Tenir une porte ne
/// veut pas dire se marcher dessus : deux cases suffisent pour que la
/// première bande qui franchit le seuil trouve tout le monde en face.
const POST_REACH: u32 = 2;

/// Ce qu'un pawn porte comme coup, en points de dégât moyen par frappe : la
/// moyenne de ses dégâts nus, corrigée par son arme et sa compétence de
/// mêlée, exactement comme `Sim::melee_strike` la calcule au moment de
/// frapper. C'est la monnaie du rapport de force.
///
/// **Ce que le modèle ne dit pas**, et qu'il assume : un archer y compte pour
/// son arc **au corps à corps** (`ItemKind::melee_percent`, 80 %), c'est-à-dire
/// moins qu'un poing nu. Tirer de loin sans être touché ne se chiffre pas en
/// dégâts par frappe, et la décision porte sur une mêlée de porte. C'est le
/// **seuil** qui absorbe l'écart, et le seuil est mesuré.
pub fn strike_power(p: &Pawn) -> u32 {
    // L'espèce décide avant la faction, comme dans `melee_strike`.
    let beast = p.species.is_some();
    let (lo, hi) = if beast {
        BOAR_DAMAGE
    } else {
        match p.faction {
            Faction::Colony => COLONIST_DAMAGE,
            Faction::Raider | Faction::Trader => RAIDER_DAMAGE,
            Faction::Animal => BOAR_DAMAGE,
        }
    };
    // `Rng::range_i32(lo, hi)` tire dans `lo..hi` : la moyenne entière est
    // `(lo + hi - 1) / 2`.
    let base = ((lo + hi - 1) / 2).max(1) as u32;
    if beast {
        return base;
    }
    let mut percent =
        p.weapon.map_or(100, |w| w.melee_percent()) * melee_skill_percent(p.melee.level) / 100;
    if p.has_trait(Trait::Brawler) {
        percent = percent * traits::BRAWLER_MELEE_PERCENT / 100;
    }
    (base * percent / 100).max(1)
}

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
/// Une seule charge extérieure par pillard ; jamais le contenu d'une pièce.
/// Coût mesuré dans CAMPAIGN-FINDINGS.md §17.
pub const PILLAGE_CARRY_MAX: u32 = 20;
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
        // La famine se compte en jours (deux, à toutes les échelles) : son
        // intervalle suit l'échelle du jour, contrairement au saignement.
        if self.pawns[i].hunger == 0 && self.tick % self.scaled64(STARVE_DAMAGE_INTERVAL) == 0 {
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
        let heals = self.tick % self.scaled64(HEAL_INTERVAL_BED) == 0
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
    /// La convalescence se compte en jours de lit : l'intervalle suit
    /// l'échelle du jour (voir `docs/time.md`).
    fn heal_interval(&self, i: usize) -> u64 {
        let (x, y) = self.pawns[i].tile();
        let in_bed = matches!(self.pawns[i].job, Job::Sleep { in_bed: true } | Job::Downed)
            && !self.pawns[i].is_moving()
            && self.map.feature(x, y) == Feature::Bed;
        if in_bed {
            self.scaled64(HEAL_INTERVAL_BED)
        } else {
            self.scaled64(HEAL_INTERVAL)
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
            Job::Attack { .. } | Job::Defend { .. } | Job::Move { manual: true }
        ) {
            return false;
        }
        let Some(id) = self.nearest_reachable_enemy(i, DEFEND_RADIUS) else {
            return false;
        };
        // Une colonie qui a des murs ne les quitte pas pour aller chercher un
        // pillard dans les bois : voir `Sim::may_engage`.
        if !self.may_engage(i, id) {
            return false;
        }
        self.abandon_job(i);
        self.pawns[i].job = if !self.pawns[i].is_colonist() || self.raid_stance() == Stance::Free {
            Job::Attack { target: id }
        } else {
            Job::Defend { target: id }
        };
        true
    }

    // ------------------------------------------------------------------
    // La décision tactique
    // ------------------------------------------------------------------

    /// Ce que la colonie peut mettre en ligne : la somme des coups de ses
    /// colons **debout et non couards**. Un couard ne se défend jamais
    /// (`Trait::Coward`), il ne compte donc pas dans ce qu'on peut aligner ;
    /// un colon à terre non plus. Les bêtes de la colonie, même agressives,
    /// n'y sont pas : le rapport de force est une affaire de colons, et un
    /// sanglier apprivoisé qui charge est un bonus, pas un plan.
    pub fn colony_line_power(&self) -> u32 {
        self.pawns
            .iter()
            .filter(|p| {
                p.is_colonist() && p.is_alive() && !p.is_downed() && !p.has_trait(Trait::Coward)
            })
            .map(strike_power)
            .sum()
    }

    /// Ce que la bande annoncée porte comme coups. Pendant la prévenance elle
    /// est déjà sur la carte, immobile à son point d'entrée
    /// (`storyteller::RAID_WARNING_DIVISOR`) : sa taille et son armement se
    /// lisent donc directement, sans que le storyteller ait rien à ranger
    /// quelque part.
    pub fn raid_line_power(&self) -> u32 {
        self.pawns
            .iter()
            .filter(|p| p.is_alive() && p.is_raider_like() && !p.is_downed())
            .map(strike_power)
            .sum()
    }

    /// La posture de la colonie, **recalculée à la demande**. Trois cas, dans
    /// cet ordre : pas de bande ou pas d'enceinte → rien ne change ; rapport
    /// favorable → on tient la porte ; sinon → veille.
    ///
    /// « Enceinte » se lit ici sur `Map::indoor_count` — la même mesure que
    /// la colonne `enclosed` de la campagne. Limite assumée : une cabane
    /// isolée compte comme un abri. `Sim::raid_post` tranche ensuite pour de
    /// bon, en cherchant d'abord autour de la colonie puis plus loin si
    /// tous les colons ont quitté les environs de leurs murs.
    pub fn raid_stance(&self) -> Stance {
        if !self.raider_alive() || self.map.indoor_count() == 0 {
            return Stance::Free;
        }
        let theirs = self.raid_line_power();
        if theirs == 0 {
            return Stance::Hold;
        }
        let mine = self.colony_line_power();
        if mine.saturating_mul(100) >= theirs.saturating_mul(HOLD_RATIO_PERCENT) {
            Stance::Hold
        } else {
            Stance::Watch
        }
    }

    /// État de défense lu par le client, sans aucune règle côté interface :
    /// posture, hostiles vivants, préavis restant, puissance alliée, puissance
    /// ennemie, id du premier hostile (u32::MAX si aucun). Le premier ennemi
    /// déjà en marche termine le préavis ; les corps à terre n'en prolongent pas.
    pub fn raid_status(&self) -> [u32; 6] {
        let mut count = 0;
        let mut warning = u64::MAX;
        let mut first = u32::MAX;
        for p in self
            .pawns
            .iter()
            .filter(|p| p.is_alive() && p.is_raider_like())
        {
            count += 1;
            first = first.min(p.id);
            if !p.is_downed() {
                let left = match p.job {
                    Job::Wait { until } => until.saturating_sub(self.tick),
                    _ => 0,
                };
                warning = warning.min(left);
            }
        }
        if count == 0 {
            return [0, 0, 0, 0, 0, u32::MAX];
        }
        [
            self.raid_stance() as u32,
            count,
            if warning == u64::MAX {
                0
            } else {
                warning.min(u64::from(u32::MAX)) as u32
            },
            self.colony_line_power(),
            self.raid_line_power(),
            first,
        ]
    }

    /// Un colon peut-il courir sur cette cible, ou reste-t-il derrière ses
    /// murs ? Hors raid et sans enceinte (`Stance::Free`), rien ne change.
    /// Sinon on ne frappe de soi-même que ce qui est **au contact**, ce qui
    /// est **entré** (une case couverte), et — seulement quand on tient la
    /// porte — ce qui se tient **sur le seuil**. Un ordre du joueur
    /// (`Command::Attack`) ne passe pas par ici : il pose `Job::Attack` et
    /// prime.
    fn may_engage(&self, i: usize, target: u32) -> bool {
        if !self.pawns[i].is_colonist() {
            return true;
        }
        let stance = self.raid_stance();
        if stance == Stance::Free {
            return true;
        }
        let Some(t) = self.pawns.iter().find(|p| p.id == target) else {
            return true;
        };
        let them = t.tile();
        chebyshev(self.pawns[i].tile(), them) <= 1
            || self.map.room(them.0, them.1) != 0
            || (stance == Stance::Hold && self.map.feature(them.0, them.1).is_door())
    }

    /// Le poste de repli de la colonie, et la pièce à laquelle il appartient.
    /// `None` : aucune case intérieure franchissable. La recherche locale
    /// se replie sur la couche intérieure si les colons sont loin des murs.
    ///
    /// - `Stance::Watch` : la case couverte la plus proche du barycentre. On
    ///   rentre, c'est tout ; se coller à la porte n'apporterait qu'un coup
    ///   de plus à encaisser.
    /// - `Stance::Hold` : la case **intérieure** qui touche une porte, la
    ///   plus proche de la bande — le seuil par lequel elle entrera.
    ///
    /// Deux balayages locaux à `SHELTER_RANGE`, puis une passe sur la couche
    /// intérieure seulement si l'abri est éloigné ; court-circuités par
    /// `Map::indoor_count` et appelés au plus une fois par
    /// `jobs::RETRY_TICKS` et par colon (voir `Sim::take_post`).
    pub(crate) fn raid_post(&self, stance: Stance) -> Option<(u8, (u32, u32))> {
        if self.map.indoor_count() == 0 {
            return None;
        }
        let center = self.colony_center()?;
        let local = self.nearest_tile_around(center, |s, x, y| s.map.room(x, y) != 0, center);
        // Des colons dispersés peuvent tirer le barycentre loin de toute
        // enceinte (campagne K=30, graine 17). Le rayon local est un chemin
        // rapide, pas une preuve d'absence d'abri. Le repli complet parcourt
        // la couche intérieure seulement après indoor_count > 0 et au
        // rythme de job_retry_due ; aucun chemin n'est calculé ici.
        let shelter = local.or_else(|| {
            self.map
                .indoor()
                .iter()
                .enumerate()
                .filter(|(_, room)| **room != 0)
                .filter_map(|(index, _)| {
                    let x = index as u32 % self.map.width();
                    let y = index as u32 / self.map.width();
                    self.map
                        .passable_for(x, y, path::Walker::COLONIST)
                        .then_some((chebyshev(center, (x, y)), x, y))
                })
                .min()
                .map(|(_, x, y)| (x, y))
        })?;
        let room = self.map.room(shelter.0, shelter.1);
        if stance != Stance::Hold {
            return Some((room, shelter));
        }
        // Le seuil : parmi les cases de la pièce qui touchent une porte, la
        // plus proche de la bande. Une enceinte sans porte n'en a pas — on se
        // rassemble alors comme en veille.
        let threat = self.nearest_raider_tile(center).unwrap_or(center);
        let gate = self.nearest_tile_around(
            if local.is_some() { center } else { shelter },
            |s, x, y| s.map.room(x, y) == room && s.touches_door(x, y),
            threat,
        );
        Some((room, gate.unwrap_or(shelter)))
    }

    /// La case retenue par `keep` la plus proche de `from`, cherchée dans le
    /// carré de `SHELTER_RANGE` autour de `around`. Départage par
    /// `(distance, x, y)` : l'ordre est total, donc identique partout.
    fn nearest_tile_around(
        &self,
        around: (u32, u32),
        keep: impl Fn(&Sim, u32, u32) -> bool,
        from: (u32, u32),
    ) -> Option<(u32, u32)> {
        let mut best: Option<(u32, u32, u32)> = None;
        for dy in -SHELTER_RANGE..=SHELTER_RANGE {
            for dx in -SHELTER_RANGE..=SHELTER_RANGE {
                let (x, y) = (around.0 as i32 + dx, around.1 as i32 + dy);
                if !self.map.in_bounds(x, y) {
                    continue;
                }
                let (x, y) = (x as u32, y as u32);
                if !keep(self, x, y) || !self.map.passable_for(x, y, path::Walker::COLONIST) {
                    continue;
                }
                let cand = (chebyshev(from, (x, y)), x, y);
                if best.is_none_or(|b| cand < b) {
                    best = Some(cand);
                }
            }
        }
        best.map(|(_, x, y)| (x, y))
    }

    /// La case touche-t-elle une porte par l'un de ses quatre côtés ? Une
    /// porte est franchissable : c'est par là que la bande entre.
    fn touches_door(&self, x: u32, y: u32) -> bool {
        [(0i32, -1i32), (0, 1), (-1, 0), (1, 0)]
            .iter()
            .any(|&(dx, dy)| {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                self.map.in_bounds(nx, ny) && self.map.feature(nx as u32, ny as u32).is_door()
            })
    }

    /// Case du pillard vivant le plus proche de `from`, départagée par
    /// `(distance, x, y)`.
    fn nearest_raider_tile(&self, from: (u32, u32)) -> Option<(u32, u32)> {
        self.pawns
            .iter()
            .filter(|p| p.is_alive() && p.is_raider_like())
            .map(|p| {
                let (x, y) = p.tile();
                (chebyshev(from, (x, y)), x, y)
            })
            .min()
            .map(|(_, x, y)| (x, y))
    }

    /// Une bande annoncée fait **lâcher le travail**, comme le feu
    /// (`Sim::drop_work_for_fire`) : sans cela un bûcheron finirait son arbre
    /// à vingt cases des murs pendant que la bande traverse la carte —
    /// `find_job` ne rappelle personne, il ne parle qu'aux colons déjà
    /// inoccupés.
    ///
    /// Ce qui n'est **pas** lâché : les besoins (manger, dormir), l'urgence
    /// (le feu, le pansement, le secours), le combat déjà engagé, la crise,
    /// et un ordre du joueur. Autrement dit, exactement ce que `find_job`
    /// place avant `Sim::take_post`.
    pub(crate) fn drop_work_for_raid(&mut self, i: usize) {
        // Sortie immédiate du cas courant : pas de bande sur la carte.
        if !self.pawns[i].enemy_present {
            return;
        }
        let droppable = matches!(
            self.pawns[i].job,
            Job::Work { .. }
                | Job::Haul { .. }
                | Job::Deliver { .. }
                | Job::Build { .. }
                | Job::Farm { .. }
                | Job::Cook { .. }
                | Job::Craft { .. }
                | Job::Equip { .. }
                | Job::Hunt { .. }
                | Job::Butcher { .. }
                | Job::Bury { .. }
                | Job::Research { .. }
                | Job::Chat { .. }
                | Job::RearmTrap { .. }
                | Job::Tame { .. }
                | Job::Slaughter { .. }
        );
        if self.raid_stance() == Stance::Free
            || matches!(
                self.pawns[i].job,
                Job::Attack { .. } | Job::Defend { .. } | Job::Move { manual: true }
            )
        {
            return;
        }
        let me = self.pawns[i].tile();
        let room = self.map.room(me.0, me.1);
        let unsafe_path = self.pawns[i]
            .path
            .iter()
            .any(|&(x, y)| room != 0 && self.map.room(u32::from(x), u32::from(y)) != room);
        // Dehors, les besoins attendent le retour ; dedans, on garde les
        // soins, le repas et le sommeil dont le trajet reste dans la pièce.
        let outside_need =
            room == 0 && matches!(self.pawns[i].job, Job::Eat { .. } | Job::Sleep { .. });
        let wandering_outside = matches!(self.pawns[i].job, Job::Move { manual: false })
            && self.pawns[i]
                .path
                .first()
                .is_some_and(|&(x, y)| self.map.room(u32::from(x), u32::from(y)) == 0);
        if droppable || unsafe_path || outside_need || wandering_outside {
            self.abandon_job(i);
        }
    }

    /// Rejoindre son poste, et n'en plus bouger tant que la bande est là.
    /// Renvoie vrai quand la posture a pris le colon en charge : `find_job`
    /// s'arrête alors là, et le travail attend.
    ///
    /// Rien n'est téléporté et personne n'est rendu invulnérable : c'est une
    /// marche, avec le chemin d'un colon (portes franchies, pièges
    /// contournés). Un colon qu'aucun chemin ne ramène reste dehors — c'est un
    /// cas du rapport, pas un cas à masquer.
    pub(crate) fn take_post(&mut self, i: usize) -> bool {
        // Sortie immédiate du cas courant : pas de bande sur la carte. Le
        // drapeau est recopié à chaque tick par `Sim::tick_pawn`.
        if !self.pawns[i].enemy_present {
            return false;
        }
        let stance = self.raid_stance();
        if stance == Stance::Free {
            return false;
        }
        if self.pawns[i].is_moving() {
            return true;
        }
        // Même cadence que les autres recherches sans garantie d'aboutir
        // (`jobs::RETRY_TICKS`, phase décalée par colon) : entre deux essais,
        // ni les murs ni la bande n'ont bougé assez pour changer la réponse.
        if !self.job_retry_due(i) {
            self.pawns[i].idle_ticks += 1;
            return true;
        }
        let Some((room, post)) = self.raid_post(stance) else {
            return false;
        };
        let me = self.pawns[i].tile();
        let inside = self.map.room(me.0, me.1) == room;
        let settled = match stance {
            Stance::Watch => inside,
            _ => inside && chebyshev(me, post) <= POST_REACH,
        };
        if settled {
            self.pawns[i].idle_ticks += 1;
            return true;
        }
        match self.colonist_path(me, post) {
            Some(p) if !p.is_empty() => {
                self.pawns[i].set_path(p);
                self.pawns[i].job = Job::Move { manual: false };
            }
            _ => self.pawns[i].idle_ticks += 1,
        }
        true
    }

    /// Un pillard fonce sur le colon accessible le plus proche, ou décroche.
    /// Partagée avec le marchand devenu hostile (voir `trade`) : mêmes coups,
    /// même seuil de décrochage, même sortie de carte.
    pub(crate) fn raider_ai(&mut self, i: usize) {
        if self.pawns[i].hp < FLEE_HP || self.pawns[i].carrying.is_some() {
            self.pawns[i].path.clear();
            self.pawns[i].job = Job::Flee;
            return;
        }
        match self.nearest_reachable_enemy(i, u32::MAX) {
            // Les colons et le troupeau sont à l'abri : on prend une seule
            // charge dehors, puis on repart. Le marchand furieux ne pille pas.
            None if self.pawns[i].faction == Faction::Raider && self.try_start_pillage(i) => {}
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
    /// comme n'importe qui de la colonie — en dernier, cependant, et seulement
    /// faute de colon atteignable : voir `LIVESTOCK_TARGET_REACH`. Un troupeau
    /// se garde (voir `livestock`), il ne s'offre pas.
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
    ///
    /// **Deux passes bornées, pas un tri commun.** Le rang du bétail
    /// (`LIVESTOCK_TARGET_REACH`) dit « les colons d'abord *quand ils sont
    /// atteignables* », pas « jamais le bétail ». Un tri unique par
    /// `(rang, distance)` disait le second : trois colons derrière une
    /// enceinte fermée remplissaient à eux seuls le budget de `MELEE_TARGETS`
    /// chemins, la recherche ne rendait rien, et `raider_ai` faisait fuir le
    /// pillard sans avoir regardé la bête à trois cases de lui. Chaque rang a
    /// donc sa passe et son propre budget, dans un ordre fixe : les colons,
    /// puis — seulement si aucun n'est atteignable — le troupeau.
    fn nearest_reachable_enemy(&self, i: usize, radius: u32) -> Option<u32> {
        if let Some(id) = self.nearest_reachable_in_rank(i, radius, false) {
            return Some(id);
        }
        // Une bête de la colonie est du même camp qu'un colon : la seconde
        // passe ne peut rien lui donner, autant lui épargner le parcours.
        if self.pawns[i].faction == Faction::Colony {
            return None;
        }
        self.nearest_reachable_in_rank(i, radius, true)
    }

    /// Une passe de `nearest_reachable_enemy` sur un seul rang : les candidats
    /// de ce rang, triés par `(distance, x, y)`, dont on teste le chemin pour
    /// les `MELEE_TARGETS` premiers. `herd` vaut vrai pour le rang différé —
    /// les bêtes de la colonie au-delà de `LIVESTOCK_TARGET_REACH` — et faux
    /// pour tout le reste, une bête au contact comprise.
    fn nearest_reachable_in_rank(&self, i: usize, radius: u32, herd: bool) -> Option<u32> {
        let me = self.pawns[i].tile();
        let faction = self.pawns[i].faction;
        // Le choix de cible doit employer le même confinement que Defend,
        // même si le colon est encore Idle au moment de la recherche.
        let walker = if self.pawns[i].is_colonist() {
            self.work_walker(me)
        } else {
            self.walker(i)
        };
        let mut enemies: Vec<(u32, u32, u32, u32)> = self
            .pawns
            .iter()
            .filter(|p| {
                p.is_alive()
                    && p.faction != faction
                    && !p.is_downed()
                    && self.is_auto_target(p, faction)
            })
            .filter_map(|p| {
                let (x, y) = p.tile();
                let d = chebyshev(me, (x, y));
                if d > radius || (self.pawns[i].is_colonist() && !self.may_engage(i, p.id)) {
                    return None;
                }
                // Le rang, et rien d'autre : la distance vraie reste celle qui
                // décide du rayon et de la mêlée.
                if (p.is_livestock() && d > LIVESTOCK_TARGET_REACH) != herd {
                    return None;
                }
                Some((d, x, y, p.id))
            })
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
        let walker = self.walker(i);
        let blocked = self.pawns[i]
            .path
            .iter()
            .any(|&(x, y)| !self.map.passable_for(u32::from(x), u32::from(y), walker));
        let stale = blocked
            || self.pawns[i]
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

    /// Une défense automatique réévalue sa cible pendant la poursuite.
    /// L'attaque manuelle conserve son comportement et reste prioritaire.
    pub(crate) fn do_defend(&mut self, i: usize, target: u32) {
        if !self.may_engage(i, target) {
            self.abandon_job(i);
            return;
        }
        self.do_attack(i, target);
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

    /// Une charge par pillard : coût extérieur borné, récupérable tant que
    /// le porteur n'a pas rejoint le bord. Le choix reste géométrique,
    /// déterministe et limité à six recherches de chemin.
    fn try_start_pillage(&mut self, i: usize) -> bool {
        let from = self.pawns[i].tile();
        let walker = self.walker(i);
        let mut candidates: Vec<_> = self
            .items
            .iter()
            .filter(|s| {
                s.reserved_by.is_none()
                    && s.kind.haulable()
                    && !s.kind.is_animal_corpse()
                    && self.map.room(s.x, s.y) == 0
                    && self.map.passable_for(s.x, s.y, walker)
            })
            .map(|s| (chebyshev(from, (s.x, s.y)), s.x, s.y, s.id))
            .collect();
        candidates.sort_unstable();
        for (_, x, y, item) in candidates.into_iter().take(FLEE_ATTEMPTS) {
            let Some(path) = path::find_path_for(&self.map, from, (x, y), walker) else {
                continue;
            };
            let Some(stack) = self.items.iter_mut().find(|s| s.id == item) else {
                continue;
            };
            stack.reserved_by = Some(self.pawns[i].id);
            self.pawns[i].set_path(path);
            self.pawns[i].job = Job::Pillage { item };
            return true;
        }
        false
    }

    pub(crate) fn do_pillage(&mut self, i: usize, item: u32) {
        if self.pawns[i].hp < FLEE_HP {
            self.abandon_job(i);
            self.pawns[i].job = Job::Flee;
            return;
        }
        // Si un défenseur vient l'intercepter, il se bat à nouveau. Même
        // cadence physique que les recherches de travail, sans état ajouté.
        if (self.tick + u64::from(self.pawns[i].id)) % crate::jobs::RETRY_TICKS == 0
            && let Some(target) = self.nearest_reachable_enemy(i, DEFEND_RADIUS)
        {
            self.abandon_job(i);
            self.pawns[i].job = Job::Attack { target };
            return;
        }
        let Some(k) = self.items.iter().position(|s| s.id == item) else {
            self.abandon_job(i);
            return;
        };
        let stack = &self.items[k];
        let walker = self.walker(i);
        if stack.reserved_by != Some(self.pawns[i].id)
            || self.map.room(stack.x, stack.y) != 0
            || self.pawns[i]
                .path
                .iter()
                .any(|&(x, y)| !self.map.passable_for(u32::from(x), u32::from(y), walker))
        {
            self.abandon_job(i);
            return;
        }
        if self.pawns[i].is_moving() {
            self.pawns[i].advance(&self.map);
            return;
        }
        if self.pawns[i].tile() != (stack.x, stack.y) {
            self.abandon_job(i);
            return;
        }
        let kind = stack.kind;
        let count = stack.count.min(PILLAGE_CARRY_MAX);
        self.items[k].count -= count;
        self.items[k].reserved_by = None;
        if self.items[k].count == 0 {
            self.items.remove(k);
        }
        self.pawns[i].carrying = Some((kind, count));
        self.pawns[i].job = Job::Flee;
    }

    pub(crate) fn do_flee(&mut self, i: usize) {
        // Une porte peut se fermer depuis le calcul du trajet, notamment
        // quand le rapport de force bascule de tenir à veiller.
        let walker = self.walker(i);
        if self.pawns[i]
            .path
            .iter()
            .any(|&(x, y)| !self.map.passable_for(u32::from(x), u32::from(y), walker))
        {
            self.pawns[i].path.clear();
        }
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
                if p.gone && p.hp > 0 && p.faction == Faction::Raider && self.is_edge_tile((x, y)) {
                    self.push_event(EventKind::LootStolen, (count << 8) | kind as u32);
                } else {
                    self.spawn_item(kind, count, x, y);
                }
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
                            // Le deuil est en jours : lu avant la boucle, qui
                            // emprunte les pawns.
                            let grief = self.scaled(GRIEF_TICKS);
                            let max_grief = self.scaled(social::MAX_GRIEF_TICKS);
                            for q in &mut self.pawns {
                                if !q.is_colonist() {
                                    continue;
                                }
                                q.grief_ticks = grief;
                                if q.opinion_of(p.id) >= social::FRIEND_OPINION {
                                    q.grief_ticks = q.grief_ticks.saturating_mul(2).min(max_grief);
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
