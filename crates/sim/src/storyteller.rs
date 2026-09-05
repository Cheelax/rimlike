//! Storyteller : ce qui arrive à la colonie, et à quelle dose.
//!
//! Jusqu'ici la tension suivait le calendrier : un raid tous les 2 à 4 jours,
//! `1 + colons / 2` pillards, point final. Une colonie de trois miséreux et une
//! colonie de dix colons armés et pleines réserves recevaient le même comité
//! d'accueil. Ici, la tension **suit la colonie**.
//!
//! Trois quantités, dans cet ordre :
//!
//! 1. la **richesse** (`Sim::wealth`) : ce que la colonie possède, piles,
//!    constructions et colons confondus. C'est un balayage de la carte, donc
//!    elle est mise en cache et recalculée au plus une fois par
//!    `WEALTH_CACHE_TICKS` ;
//! 2. les **points de menace** (`Sim::threat_points`) : colons, richesse et
//!    jours écoulés, plafonnés puis multipliés par la difficulté ;
//! 3. la **composition** du raid : les points achètent des pillards
//!    (`RAIDER_COST`) puis leur équipement.
//!
//! Avec une exception, mesurée puis posée en règle : la **toute première**
//! bande d'une colonie est plafonnée à `FIRST_RAID_POINTS`, deux têtes. Elle
//! vient tâter le terrain, pas régler la partie — sans quoi une colonie riche
//! de son bois coupé, ou une difficulté à 120 %, décidait de l'issue avant que
//! quiconque ait eu le temps de tailler un arc (voir
//! `sim-cli/CAMPAIGN-FINDINGS.md` §4).
//!
//! La **bande**, elle, appartient à quelqu'un : chaque raid est mené par l'une
//! des deux tribus de `factions`, tirée d'autant plus souvent qu'elle vous en
//! veut, et une tribu alliée n'attaque plus (voir `Sim::draw_raid_faction`).
//! Si les deux sont alliées, plus aucune bande n'entre — le reste du récit
//! (maladies, coups de temps, largages, marchands) continue sans elles.
//!
//! Le reste du module tient les autres fils du récit : voyageurs, troupeaux,
//! largages de vivres, maladies et coups de temps. Tout passe par `self.rng`
//! dans un ordre fixe, et toutes les échéances sont des champs de `Sim` : une
//! carte gelée les décale (voir `fastforward`) au lieu de les accumuler.

use serde::{Deserialize, Serialize};

use crate::climate::{COLD_MOOD_TEMP, FREEZING, Season};
use crate::combat::MAX_RAIDERS;
use crate::factions;
use crate::items::ItemKind;
use crate::map::{Feature, Terrain};
use crate::pawn::{Faction, Job, NEED_MAX};
use crate::weather::Weather;
use crate::{EventKind, Sim, TICKS_PER_DAY};

// ----------------------------------------------------------------------
// Difficulté
// ----------------------------------------------------------------------

/// Réglage de la dose de menace. Les valeurs sont un contrat avec le client
/// (`Command::SetDifficulty`, `WasmSim::difficulty`).
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Difficulty {
    /// Aucun raid : le storyteller n'en envoie jamais. Tout le reste (météo,
    /// troupeaux, maladies, largages) continue.
    Peaceful = 0,
    Easy = 1,
    #[default]
    Normal = 2,
    Hard = 3,
}

impl Difficulty {
    /// Dans l'ordre des valeurs.
    pub const ALL: [Difficulty; 4] = [
        Difficulty::Peaceful,
        Difficulty::Easy,
        Difficulty::Normal,
        Difficulty::Hard,
    ];

    /// Une valeur inconnue vaut `Normal` : c'est la frontière WASM qui l'appelle,
    /// et un octet bricolé ne doit pas désarmer le storyteller.
    pub fn from_u8(v: u8) -> Difficulty {
        match v {
            0 => Difficulty::Peaceful,
            1 => Difficulty::Easy,
            3 => Difficulty::Hard,
            _ => Difficulty::Normal,
        }
    }

    /// Multiplicateur des points de menace, en pourcentage.
    ///
    /// **Difficile ramené de 150 à 120 le 2026-09-05.** À 150 %, la colonie de
    /// départ (trois colons, 300 de richesse, 120 points) en valait 180, soit
    /// trois pillards armés là où la normale en donne deux, et la campagne de
    /// 30 graines éteignait **30 colonies sur 30**, 25 avant le jour 10
    /// (`sim-cli/CAMPAIGN-FINDINGS.md` §4). À 120 % elle en vaut 144 : deux
    /// têtes, comme en normal. La difficulté se joue alors sur la **montée** —
    /// une colonie de quatre colons riche de 4 700 reçoit une tête de plus
    /// qu'en normal — et sur la cadence (`raid_delay`).
    pub fn threat_percent(self) -> u32 {
        match self {
            Difficulty::Peaceful => 0,
            Difficulty::Easy => 60,
            Difficulty::Normal => 100,
            Difficulty::Hard => 120,
        }
    }

    /// Délai entre deux raids : minimum et amplitude du tirage, en ticks.
    /// Normal garde les 2 à 4 jours d'avant ; `Peaceful` n'attaque pas mais
    /// garde une échéance qui avance, pour qu'un passage en Normal ne
    /// déclenche pas un raid dans la seconde.
    ///
    /// **Difficile allongé de (1,5 j ; 1,5 j) à (1,75 j ; 2 j) le 2026-09-05.**
    /// L'ancienne cadence donnait 2,25 jours de moyenne contre 3 en normal,
    /// soit un tiers de raids en plus : une fois l'ouverture rendue survivable
    /// (`FIRST_RAID_POINTS`), c'est ce qui usait les colonies entre le jour 10
    /// et le jour 30 — 3 colonies sur 30 y arrivaient encore. À 2,75 jours de
    /// moyenne, la colonie a le temps de rebâtir entre deux bandes, et le
    /// difficile garde une cadence à lui : le minimum reste sous celui de la
    /// normale.
    pub fn raid_delay(self) -> (u32, u32) {
        match self {
            Difficulty::Hard => (TICKS_PER_DAY * 7 / 4, TICKS_PER_DAY * 2),
            Difficulty::Easy => (TICKS_PER_DAY * 3, TICKS_PER_DAY * 2),
            _ => (TICKS_PER_DAY * 2, TICKS_PER_DAY * 2),
        }
    }
}

// ----------------------------------------------------------------------
// Constantes de réglage
// ----------------------------------------------------------------------

/// Points de menace apportés par chaque colon vivant : c'est le terme qui
/// domine en début de partie.
///
/// **Laissé à 40 le 2026-09-05, après l'avoir essayé à 35.** Le socle est
/// pincé entre deux mesures : trois colons et les 300 de richesse de départ
/// doivent faire **deux** têtes au tick 0, donc entre 120 et 179 points
/// (`POINTS_PER_RAIDER`) — c'est ce que calibre
/// `first_raid_is_dangerous_but_survivable`. À 35, il aurait fallu que la
/// richesse rende les 15 points manquants, donc un `WEALTH_PER_THREAT` sous
/// 20 ; et à ce prix-là, la colonie du joueur scripté — **1 711 de richesse
/// dès le jour 3**, l'essentiel en bois coupé qui traîne au sol (campagne de
/// 30 graines, `--days 3`) — recevait trois à quatre têtes par bande au lieu
/// de deux. Essayé, mesuré, rejeté : 30 colonies éteintes sur 30 en normal.
pub const THREAT_PER_COLONIST: u32 = 40;
/// Richesse qu'il faut accumuler pour un point de menace de plus, au tarif
/// ordinaire. **Inchangée : c'est le tarif de la colonie qui survit.**
///
/// Une colonie de campagne est riche tout de suite et le reste : 1 711 de
/// richesse au jour 3, 1 565 au jour 5, 1 448 au jour 10 — l'essentiel en bois
/// coupé qui traîne au sol. Sa richesse ne monte pas, elle *décroît*. Tout
/// tarif linéaire assez raide pour que « tripler sa richesse » se voie
/// (`WEALTH_PER_THREAT` à 80, mesuré) fait donc payer à cette colonie-là, qui
/// n'a rien prospéré du tout, une tête de plus par bande : la campagne normale
/// tombait de 20 colonies vivantes sur 30 à **14**. C'est ce qui a fait
/// scinder le terme en deux (voir `WEALTH_RICH_FROM`).
pub const WEALTH_PER_THREAT: u32 = 400;
/// Au-delà de cette richesse, la colonie a **vraiment** prospéré : ce qui
/// dépasse compte une seconde fois, au tarif fort de `WEALTH_PER_THREAT_RICH`.
///
/// **Mesuré, pas choisi.** 2 000, c'est le dessus de la fourchette d'une
/// colonie de campagne ordinaire (1 400 à 1 700 du jour 3 au jour 30, moyenne
/// finale 2 102 après les correctifs du 2026-09-05, mais la moitié des colonies
/// en dessous) ; la plus riche des trente en finit à 4 768. En dessous du
/// seuil, la menace est **exactement** celle d'avant — c'est ce qui protège la
/// colonie qui n'a fait qu'abattre des arbres. Au-dessus, chaque tranche de 40
/// vaut une tranche de 400 : une colonie à 4 700 gagne 67 points au lieu de 11,
/// soit une bande de trois têtes au jour 30 là où elle en recevait deux au
/// jour 5. C'est le constat n°3 du rapport, rendu vrai sans casser le reste.
pub const WEALTH_RICH_FROM: u32 = 2_000;
/// Tarif fort, au-delà de `WEALTH_RICH_FROM` : dix fois le tarif ordinaire.
/// Autrement dit, il faut 2 400 de richesse de plus pour un pillard de plus —
/// une enceinte de pierre, un cheptel et des réserves pleines.
pub const WEALTH_PER_THREAT_RICH: u32 = 40;
/// Jours de survie pour un point de menace de plus.
///
/// **Ramené de 4 à 2 le 2026-09-05** (proposition §5) : trente jours rendent
/// 15 points au lieu de 7, de quoi empêcher une colonie pauvre mais tenace de
/// garder le même comité d'accueil du premier jour au dernier.
pub const DAYS_PER_THREAT: u32 = 2;
/// Plafond des points de menace **avant** multiplicateur de difficulté.
///
/// Au tarif fort, il faut 20 000 de richesse pour l'atteindre par la seule
/// richesse — quatre fois ce que la plus riche des colonies mesurées possédait
/// au jour 30 (4 768). Il borne donc le très long terme sans écrêter la montée
/// qu'on vient de rendre possible : dix têtes en normal, douze en difficile
/// (`MAX_RAIDERS`).
pub const THREAT_MAX: u32 = 600;

/// Ce que coûte un pillard à mains nues.
pub const RAIDER_COST: u32 = 40;
/// Ce qu'ajoute chaque pièce d'équipement.
pub const CLUB_COST: u32 = 10;
pub const SPEAR_COST: u32 = 20;
pub const BOW_COST: u32 = 30;
pub const TUNIC_COST: u32 = 10;

/// Points qu'il faut dépenser pour **une tête**, équipement moyen compris.
///
/// **Mesuré avant d'être réglé.** Le nombre de pillards ne peut pas se déduire
/// d'une boucle gourmande (« tant qu'il reste de quoi payer un pillard, en
/// ajouter un ») : à 120 points, trois pillards à mains nues passent tout
/// juste, et le premier raid deviendrait une mêlée à trois contre trois là où
/// la difficulté de référence (`first_raid_is_dangerous_but_survivable`) en
/// attend deux. On tranche donc d'abord la **taille** de la bande à ce
/// diviseur — 40 pour le corps, 20 d'équipement en moyenne — puis on dépense
/// le reste en armes et en tuniques. Conséquence voulue : à 120 points
/// (trois colons, tick 0, difficulté normale) la bande fait exactement deux
/// pillards, et il reste 40 points pour les armer.
pub const POINTS_PER_RAIDER: u32 = 60;

/// Ce que vaut, au plus, la **toute première** bande d'une colonie : deux
/// têtes et 40 points pour les armer, soit exactement la bande de référence du
/// tick 0 décrite ci-dessus.
///
/// **Mesuré.** Sans ce plafond, la première bande dépend de ce que la colonie
/// a déjà amassé, et la colonie du joueur scripté vaut 1 711 de richesse dès
/// le jour 3 : en difficile, elle recevait **trois pillards armés** face à
/// trois colons qui n'ont pas encore de poste de fabrication, et la campagne
/// de 30 graines éteignait 30 colonies sur 30, 25 avant le jour 10
/// (`sim-cli/CAMPAIGN-FINDINGS.md` §4). La première bande vient tâter le
/// terrain, pas régler la partie : elle est la même partout, et la difficulté
/// se rattrape dès la deuxième (`Difficulty::threat_percent`,
/// `Difficulty::raid_delay`).
pub const FIRST_RAID_POINTS: u32 = 2 * POINTS_PER_RAIDER;

/// Un assiégeant patiente ce temps-là à son point d'entrée avant de charger.
pub const SIEGE_TICKS: u64 = 1_200;

/// Représailles d'une tribu qui vient de basculer du côté hostile
/// (`factions::HOSTILE_GOODWILL`) : le prochain raid est avancé à un tick tiré
/// dans cette fourchette, soit une demi-journée à deux jours. Il passe par
/// l'échéance ordinaire, donc par la difficulté : en paisible, personne ne
/// vient quand même.
pub const REPRISAL_MIN: u32 = TICKS_PER_DAY / 2;
pub const REPRISAL_SPAN: u32 = TICKS_PER_DAY * 3 / 2;

/// Un raid qui a coûté un colon accorde ce répit en plus.
pub const RAID_DEATH_RESPITE: u32 = TICKS_PER_DAY;

/// La richesse n'est recalculée qu'une fois par tranche de ce nombre de ticks :
/// elle balaie la carte entière.
pub const WEALTH_CACHE_TICKS: u64 = 600;
/// Ce que vaut un colon dans la richesse de la colonie.
pub const COLONIST_WEALTH: u32 = 100;

/// Largage de vivres : délai minimum et amplitude du tirage, en jours.
pub const SUPPLY_MIN_DAYS: u32 = 5;
pub const SUPPLY_SPAN_DAYS: u32 = 3;
/// Piles larguées : de `SUPPLY_MIN_PILES` à `SUPPLY_MIN_PILES + 2`.
pub const SUPPLY_MIN_PILES: u32 = 2;
/// Rayon de dispersion des piles autour du barycentre des colons.
pub const SUPPLY_RADIUS: i32 = 6;
/// Tirages de case avant de renoncer à placer une pile.
const SUPPLY_DRAWS: u32 = 16;
/// Une pile sur `SUPPLY_WEAPON_CHANCE` est une arme, à l'unité.
const SUPPLY_WEAPON_CHANCE: u32 = 8;

/// Maladie : délai minimum et amplitude du tirage, en jours.
pub const ILLNESS_MIN_DAYS: u32 = 6;
pub const ILLNESS_SPAN_DAYS: u32 = 5;
/// Une maladie dure deux jours, un seul si on la soigne.
pub const ILLNESS_TICKS: u32 = TICKS_PER_DAY * 2;
pub const ILLNESS_TENDED_TICKS: u32 = TICKS_PER_DAY;
/// Vitesse de travail d'un malade, en pourcentage.
pub const ILLNESS_WORK_PERCENT: u32 = 60;
/// Mobilité d'un malade, en pourcentage.
pub const ILLNESS_MOBILITY_PERCENT: u32 = 80;
/// Ce que la maladie coûte à l'humeur.
pub const ILLNESS_MOOD_MALUS: i64 = 80_000;

/// Coup de temps (froid ou chaleur) : délai minimum et amplitude, en jours.
pub const EXTREME_MIN_DAYS: u32 = 8;
pub const EXTREME_SPAN_DAYS: u32 = 7;
/// Écart de température d'un coup de temps, en dixièmes de degré.
pub const EXTREME_OFFSET: i32 = 100;
/// Durée d'un coup de temps.
pub const EXTREME_TICKS: u32 = TICKS_PER_DAY;

// ----------------------------------------------------------------------
// Types de raid
// ----------------------------------------------------------------------

/// Manière dont une bande aborde la colonie. Les valeurs sont un contrat avec
/// le client (`arg` de `EventKind::RaidIncoming`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum RaidKind {
    /// La charge d'avant : tout le monde fonce sur le colon le plus proche.
    Rush = 0,
    /// La moitié de la bande arrive à l'arc, quitte à ce que le reste vienne
    /// à mains nues : les points sont les mêmes pour tout le monde.
    Archers = 1,
    /// Les pillards s'installent à leur point d'entrée et attendent
    /// `SIEGE_TICKS` avant de charger. Le temps de fermer une porte.
    Siege = 2,
}

impl RaidKind {
    pub const ALL: [RaidKind; 3] = [RaidKind::Rush, RaidKind::Archers, RaidKind::Siege];

    pub fn from_u8(v: u8) -> RaidKind {
        match v {
            1 => RaidKind::Archers,
            2 => RaidKind::Siege,
            _ => RaidKind::Rush,
        }
    }
}

/// Équipement d'un pillard, décidé avant qu'il n'entre sur la carte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct RaiderKit {
    weapon: Option<ItemKind>,
    apparel: Option<ItemKind>,
}

/// Armes achetables, **par coût croissant** : les options abordables forment
/// alors un préfixe de la table, et un seul comptage suffit à les compter.
const WEAPON_OPTIONS: [(Option<ItemKind>, u32); 4] = [
    (None, 0),
    (Some(ItemKind::Club), CLUB_COST),
    (Some(ItemKind::Spear), SPEAR_COST),
    (Some(ItemKind::Bow), BOW_COST),
];

/// Ce qui tombe d'un largage : genre, quantité minimale, amplitude du tirage.
const SUPPLY_TABLE: [(ItemKind, u32, u32); 5] = [
    (ItemKind::Berries, 20, 11),
    (ItemKind::Vegetables, 15, 11),
    (ItemKind::Wood, 25, 16),
    (ItemKind::Stone, 20, 11),
    (ItemKind::Leather, 6, 5),
];

/// Armes possibles d'un largage, à l'unité.
const SUPPLY_WEAPONS: [ItemKind; 3] = [ItemKind::Club, ItemKind::Spear, ItemKind::Bow];

/// Ce que vaut une construction dans la richesse de la colonie. Les sols sont
/// du terrain, pas un élément : ils comptent à part (`FLOOR_WEALTH`).
fn feature_wealth(f: Feature) -> u32 {
    match f {
        Feature::WallWood | Feature::WallStone => 5,
        Feature::DoorWood | Feature::DoorStone => 12,
        Feature::Bed => 20,
        Feature::Campfire => 10,
        Feature::CraftingSpot => 15,
        Feature::ResearchBench => 20,
        // Une défense passive compte, comme dans RimWorld : elle attire les
        // convoitises. Modeste — un piège vaut deux murs — et seulement tant
        // qu'il est armé : un piège déclenché ne défend plus rien.
        Feature::SpikeTrap => TRAP_WEALTH,
        // La nature n'appartient à personne : ni arbre, ni rocher, ni buisson,
        // ni plant ne compte comme richesse.
        _ => 0,
    }
}

/// Ce que vaut une case de sol bâti.
const FLOOR_WEALTH: u32 = 3;

/// Ce que vaut un piège à pointes **armé** dans la richesse de la colonie.
pub const TRAP_WEALTH: u32 = 10;

impl Sim {
    // ------------------------------------------------------------------
    // Difficulté et richesse
    // ------------------------------------------------------------------

    pub fn difficulty(&self) -> Difficulty {
        self.difficulty
    }

    /// Impose la difficulté (tests et scénarios ; le jeu passe par
    /// `Command::SetDifficulty`).
    pub fn set_difficulty(&mut self, difficulty: Difficulty) {
        self.difficulty = difficulty;
    }

    /// Richesse de la colonie : ses piles, ses constructions et ses colons.
    ///
    /// **Valeur en cache** : le calcul balaie la carte, il n'est refait qu'une
    /// fois par `WEALTH_CACHE_TICKS` (par `tick_storyteller`, donc à des ticks
    /// que tous les clients partagent). Lire cette valeur ne change rien à
    /// l'état — c'est la condition pour que le client puisse l'afficher sans
    /// désynchroniser la partie.
    pub fn wealth(&self) -> u32 {
        if self.tick.saturating_sub(self.wealth_cache_tick) < WEALTH_CACHE_TICKS {
            return self.wealth_cache;
        }
        self.compute_wealth()
    }

    /// Le calcul complet, en O(objets + cases + pawns).
    fn compute_wealth(&self) -> u32 {
        let mut total: u32 = 0;
        for s in &self.items {
            total = total.saturating_add(s.kind.wealth_value().saturating_mul(s.count));
        }
        // Un seul passage sur les deux couches, en `zip` plutôt qu'en indices :
        // c'est le seul endroit du sim qui balaie la carte entière, autant lui
        // épargner un contrôle de bornes par case.
        for (&f, &t) in self.map.features().iter().zip(self.map.tiles()) {
            total = total.saturating_add(feature_wealth(Feature::from_u8(f)));
            if matches!(
                Terrain::from_u8(t),
                Terrain::WoodFloor | Terrain::StoneFloor
            ) {
                total = total.saturating_add(FLOOR_WEALTH);
            }
        }
        // Le troupeau compte, modestement (voir `livestock`).
        let total = total.saturating_add(self.livestock_wealth());
        total.saturating_add(self.living_colonists().saturating_mul(COLONIST_WEALTH))
    }

    /// Première évaluation, à la construction du sim : sans elle, `wealth()`
    /// renverrait 0 pendant les six cents premiers ticks — ce que le client
    /// afficherait tel quel.
    pub(crate) fn init_wealth(&mut self) {
        self.wealth_cache = self.compute_wealth();
        self.wealth_cache_tick = 0;
    }

    /// Recalcule la richesse si le cache a fait son temps. Appelée à chaque
    /// tick par le storyteller : le coût réel est celui d'un balayage tous les
    /// `WEALTH_CACHE_TICKS` ticks.
    fn refresh_wealth(&mut self) {
        if self.tick.saturating_sub(self.wealth_cache_tick) < WEALTH_CACHE_TICKS {
            return;
        }
        self.wealth_cache = self.compute_wealth();
        self.wealth_cache_tick = self.tick;
    }

    /// Colons vivants (les bêtes et les pillards ne comptent pas). Les bêtes
    /// **apprivoisées** non plus, malgré leur faction : un troupeau n'ajoute
    /// pas 40 points de menace par tête (voir `livestock`), il pèse seulement
    /// dans la richesse.
    pub(crate) fn living_colonists(&self) -> u32 {
        self.pawns
            .iter()
            .filter(|p| p.is_colonist() && p.is_alive())
            .count() as u32
    }

    /// Points de menace du prochain raid : les colons pèsent le plus lourd, la
    /// richesse et l'ancienneté de la colonie complètent, la difficulté
    /// multiplie. Le plafond s'applique **avant** le multiplicateur : en
    /// difficile, un raid de fin de partie peut dépasser 600 points.
    pub fn threat_points(&self) -> u32 {
        let colonists = self.living_colonists();
        let days = (self.tick / u64::from(TICKS_PER_DAY)) as u32;
        let base = THREAT_PER_COLONIST
            .saturating_mul(colonists)
            .saturating_add(self.wealth_threat())
            .saturating_add(days / DAYS_PER_THREAT)
            .min(THREAT_MAX);
        base * self.difficulty.threat_percent() / 100
    }

    /// Ce que la richesse apporte aux points de menace, en **deux tranches** :
    /// tout au tarif ordinaire, puis une seconde fois, au tarif fort, ce qui
    /// dépasse `WEALTH_RICH_FROM`.
    ///
    /// Deux tranches et non une pente unique, parce que « riche » ne veut pas
    /// dire la même chose des deux côtés du seuil : sous 2 000, la richesse
    /// d'une colonie, c'est le bois qu'elle vient d'abattre et qui traîne au
    /// sol — la faire payer pour ça éteint la campagne normale (mesuré : 14
    /// colonies vivantes sur 30 au lieu de 20). Au-dessus, c'est une enceinte,
    /// des réserves et un cheptel : de la prospérité, et elle appelle les
    /// ennuis.
    fn wealth_threat(&self) -> u32 {
        let wealth = self.wealth();
        (wealth / WEALTH_PER_THREAT)
            .saturating_add(wealth.saturating_sub(WEALTH_RICH_FROM) / WEALTH_PER_THREAT_RICH)
    }

    // ------------------------------------------------------------------
    // Raids
    // ------------------------------------------------------------------

    /// Programme le premier raid, après quelques jours de répit. Le délai de
    /// grâce est le même à toutes les difficultés (`combat::GRACE_DAYS`) : ce
    /// qui protège l'ouverture, c'est le plafond de la première bande
    /// (`FIRST_RAID_POINTS`), pas un sursis — un sursis laisse la colonie
    /// grossir, donc la bande aussi (mesuré : voir `CAMPAIGN-FINDINGS.md` §4).
    pub(crate) fn schedule_first_raid(&mut self) {
        let grace = u64::from(TICKS_PER_DAY) * u64::from(crate::combat::GRACE_DAYS);
        self.next_raid_at = grace + u64::from(self.rng.below(TICKS_PER_DAY / 2));
    }

    /// Programme les événements qui n'existaient pas avant cette tranche.
    /// Aucun ne tombe dans les cinq premiers jours : la colonie s'installe.
    pub(crate) fn schedule_first_events(&mut self) {
        self.next_supply_at = self.roll_delay(SUPPLY_MIN_DAYS, SUPPLY_SPAN_DAYS);
        self.next_illness_at = self.roll_delay(ILLNESS_MIN_DAYS, ILLNESS_SPAN_DAYS);
        self.next_extreme_at = self.roll_delay(EXTREME_MIN_DAYS, EXTREME_SPAN_DAYS);
    }

    /// Tick d'échéance tiré au sort : `self.tick + min_days` à
    /// `+ min_days + span_days` jours.
    pub(crate) fn roll_delay(&mut self, min_days: u32, span_days: u32) -> u64 {
        let min = u64::from(TICKS_PER_DAY) * u64::from(min_days);
        let span = TICKS_PER_DAY.saturating_mul(span_days).max(1);
        self.tick + min + u64::from(self.rng.below(span))
    }

    /// Déclenche les événements à l'heure dite et programme les suivants.
    /// Un seul point d'entrée : c'est ici que se décide tout ce qui arrive à
    /// la colonie sans que le joueur l'ait demandé.
    pub(crate) fn tick_storyteller(&mut self) {
        self.refresh_wealth();
        // Une fois par jour, les rancunes s'estompent d'un point (voir
        // `factions::FADE_PER_DAY`). Pas de tirage, pas d'échéance : le
        // calendrier suffit, et une carte gelée rattrape son retard d'un coup
        // (`Sim::fast_forward`).
        if self.tick > 0 && self.tick % u64::from(TICKS_PER_DAY) == 0 {
            self.fade_grudges(1);
        }
        // Le sort de la dernière bande, tranché au tick d'après sa dernière
        // mort : `remove_dead` tourne à la fin du tick, la carte est donc bien
        // vide de pillards quand on regarde.
        self.resolve_raid();
        if self.tick >= self.next_wanderer_at {
            self.spawn_wanderer();
            let three_days = u64::from(TICKS_PER_DAY) * 3;
            self.next_wanderer_at =
                self.tick + three_days + u64::from(self.rng.below(TICKS_PER_DAY * 2));
        }
        // Avant la sortie rapide du raid : sinon un troupeau n'entrerait
        // jamais tant qu'un raid est en attente, c'est-à-dire presque toujours.
        if self.tick >= self.next_herd_at {
            self.spawn_herd();
            let two_days = u64::from(TICKS_PER_DAY) * 2;
            self.next_herd_at = self.tick + two_days + u64::from(self.rng.below(TICKS_PER_DAY * 2));
        }
        if self.tick >= self.next_supply_at {
            self.supply_drop();
            self.next_supply_at = self.roll_delay(SUPPLY_MIN_DAYS, SUPPLY_SPAN_DAYS);
        }
        if self.tick >= self.next_illness_at {
            self.strike_illness();
            self.next_illness_at = self.roll_delay(ILLNESS_MIN_DAYS, ILLNESS_SPAN_DAYS);
        }
        if self.tick >= self.next_extreme_at {
            self.strike_extreme_weather();
            self.next_extreme_at = self.roll_delay(EXTREME_MIN_DAYS, EXTREME_SPAN_DAYS);
        }
        // Avant la sortie rapide du raid, comme les troupeaux : un marchand
        // n'est pas une menace, et il passe à toutes les difficultés — même en
        // paisible, où plus aucune bande n'entre.
        if self.tick >= self.next_trader_at {
            self.spawn_trader();
            self.schedule_next_trader();
        }
        if self.tick < self.next_raid_at {
            return;
        }
        // En paisible, l'échéance avance mais personne n'entre : passer en
        // normal ne doit pas déclencher un raid au tick suivant.
        if self.difficulty != Difficulty::Peaceful {
            self.spawn_raid();
        }
        let (min, span) = self.difficulty.raid_delay();
        let next = self.tick + u64::from(min) + u64::from(self.rng.below(span.max(1)));
        // Le raid qui vient d'entrer a pu faire basculer sa tribu du côté
        // hostile (`factions::RAID_LED`) et poser des représailles plus
        // proches : la cadence ordinaire ne les efface pas.
        self.next_raid_at = if self.next_raid_at > self.tick {
            self.next_raid_at.min(next)
        } else {
            next
        };
    }

    /// Avance le prochain raid : une tribu vient de passer sous
    /// `factions::HOSTILE_GOODWILL` et veut le faire savoir. Elle ne choisit
    /// pas la date exacte (`REPRISAL_MIN`, `REPRISAL_SPAN`) et ne court-circuite
    /// pas le storyteller : c'est lui qui décidera de la bande, de sa taille et
    /// même de son existence (en paisible, personne ne vient).
    pub(crate) fn plan_reprisal(&mut self) {
        let delay = u64::from(REPRISAL_MIN) + u64::from(self.rng.below(REPRISAL_SPAN.max(1)));
        self.next_raid_at = self.next_raid_at.min(self.tick + delay);
    }

    /// Annonce le sort de la dernière bande entrée, une fois qu'il ne reste
    /// plus un pillard vivant sur la carte : la Guilde et la tribu rivale y
    /// gagnent (`factions::RAID_REPELLED_GUILD`, `RAID_REPELLED_OTHER`). Une
    /// colonie éteinte, elle, n'a rien repoussé : le drapeau retombe sans
    /// annonce ni récompense.
    fn resolve_raid(&mut self) {
        if !self.raid_unresolved {
            return;
        }
        if self
            .pawns
            .iter()
            .any(|p| p.faction == Faction::Raider && p.is_alive())
        {
            return;
        }
        self.raid_unresolved = false;
        if self.living_colonists() == 0 {
            return;
        }
        let led_by = self.last_raid_faction;
        self.push_event(EventKind::RaidRepelled, u32::from(led_by));
        self.add_goodwill(factions::GUILD, factions::RAID_REPELLED_GUILD);
        // L'ennemi de mon ennemi : l'autre tribu apprécie qu'on ait saigné
        // celle d'en face. Rien pour elle si elle menait le raid.
        for f in factions::FACTIONS {
            if f.id != led_by && factions::is_tribe(f.id) {
                self.add_goodwill(f.id, factions::RAID_REPELLED_OTHER);
            }
        }
    }

    /// Un raid a coûté un colon : la bande suivante se fait attendre un jour
    /// de plus. Appelée à la mort d'un colon, quels que soient ses tourments,
    /// à condition qu'un pillard soit encore sur la carte — une famine en
    /// pleine attaque compte donc aussi, et c'est très bien : ce qui décide du
    /// répit, c'est ce que la colonie vient d'encaisser.
    pub(crate) fn grant_raid_respite(&mut self) {
        if self
            .pawns
            .iter()
            .any(|p| p.faction == Faction::Raider && p.is_alive())
        {
            self.next_raid_at = self
                .next_raid_at
                .saturating_add(u64::from(RAID_DEATH_RESPITE));
        }
    }

    /// Fait entrer une bande de pillards d'un genre tiré au sort : la charge
    /// six fois sur dix, les archers un quart du temps, le siège le reste.
    /// Renvoie le nombre de pillards apparus. C'est le chemin **naturel**,
    /// celui du storyteller : aucune bande n'entre si les deux tribus sont
    /// alliées.
    pub fn spawn_raid(&mut self) -> u32 {
        let kind = self.draw_raid_kind();
        self.spawn_raid_of(kind, false)
    }

    /// Fait entrer une bande tout de suite, genre tiré au sort
    /// (`Command::TriggerRaid`). **Outil de débogage** : il ignore les
    /// alliances, sinon il ne serait plus un outil de test dès qu'une tribu
    /// devient amie. La tribu qui mène est quand même tirée par hostilité,
    /// alliée comprise, et le raid coûte la même réputation qu'un autre.
    pub fn trigger_raid(&mut self) -> u32 {
        let kind = self.draw_raid_kind();
        self.spawn_raid_of(kind, true)
    }

    /// Fait entrer une bande d'un genre imposé (tests, débogage). Ignore les
    /// alliances comme `trigger_raid` ; le storyteller, lui, passe par
    /// `spawn_raid` et tire son genre.
    pub fn trigger_raid_of(&mut self, kind: RaidKind) -> u32 {
        self.spawn_raid_of(kind, true)
    }

    /// Manière d'aborder la colonie, tirée au sort.
    fn draw_raid_kind(&mut self) -> RaidKind {
        match self.rng.below(100) {
            r if r < 60 => RaidKind::Rush,
            r if r < 85 => RaidKind::Archers,
            _ => RaidKind::Siege,
        }
    }

    /// Tribu qui mène le prochain raid : tirage pondéré par l'hostilité, poids
    /// `100 − réputation` (une tribu qui vous déteste attaque jusqu'à quatre
    /// fois plus souvent que celle qui vous tolère). Une tribu **alliée**
    /// (`factions::ALLY_GOODWILL`) est écartée, sauf pour un raid forcé, où
    /// elle garde un poids minimal : un outil de débogage doit marcher même sur
    /// une carte où tout le monde est ami.
    ///
    /// `None` : les deux tribus sont alliées et le raid n'est pas forcé —
    /// personne n'entre. Aucun tirage n'est consommé dans ce cas.
    fn draw_raid_faction(&mut self, forced: bool) -> Option<u8> {
        let mut weights = [0u32; factions::FACTION_COUNT];
        let mut total = 0u32;
        for f in factions::FACTIONS {
            if !factions::is_tribe(f.id) {
                continue;
            }
            let goodwill = self.faction_goodwill(f.id);
            if !forced && goodwill >= factions::ALLY_GOODWILL {
                continue;
            }
            // `goodwill` est borné à ±100 : le poids tient dans 0..=200, et
            // reste au moins à 1 pour un raid forcé.
            let weight = (100 - goodwill).clamp(1, 200) as u32;
            weights[f.id as usize] = weight;
            total += weight;
        }
        if total == 0 {
            return None;
        }
        let mut draw = self.rng.below(total);
        for (id, &weight) in weights.iter().enumerate() {
            if draw < weight {
                return Some(id as u8);
            }
            draw -= weight;
        }
        // Inatteignable : la somme des poids est exactement `total`.
        None
    }

    fn spawn_raid_of(&mut self, kind: RaidKind, forced: bool) -> u32 {
        if self.living_colonists() == 0 {
            return 0;
        }
        let Some(led_by) = self.draw_raid_faction(forced) else {
            return 0;
        };
        // La première bande d'une colonie est plafonnée : deux têtes, quelle
        // que soit la difficulté et quoi que la colonie ait déjà amassé
        // (`FIRST_RAID_POINTS`). `last_raid_faction` vaut `u8::MAX` tant
        // qu'aucune n'est venue. Un raid **forcé** l'ignore, comme il ignore
        // les alliances : `Command::TriggerRaid` est un outil de débogage, il
        // doit montrer ce que la colonie vaut vraiment.
        let mut points = self.threat_points();
        if !forced && self.last_raid_faction == u8::MAX {
            points = points.min(FIRST_RAID_POINTS);
        }
        // En hiver, ou par n'importe quel temps où un colon aurait froid, les
        // pillards arrivent couverts : leur tunique ne change ni leurs coups ni
        // leur résistance, seulement le butin qu'ils laissent en mourant — et
        // les points qu'elle coûte, qui ne financeront pas une arme.
        let dressed =
            self.season() == Season::Winter || self.outdoor_temperature() < COLD_MOOD_TEMP;
        let roster = self.raid_roster(points, kind, dressed);
        let Some(entry) = self.find_entry_tile() else {
            return 0;
        };
        let spots = self.ring_tiles(entry, roster.len(), true);
        let until = self.tick + SIEGE_TICKS;
        let mut spawned = 0;
        for (rank, &(x, y)) in spots.iter().enumerate() {
            let kit = roster[rank];
            self.spawn_pawn(x, y, Faction::Raider);
            let k = self.pawns.len() - 1;
            self.pawns[k].hunger = NEED_MAX;
            self.pawns[k].rest = NEED_MAX;
            self.pawns[k].weapon = kit.weapon;
            self.pawns[k].apparel = kit.apparel;
            if kind == RaidKind::Siege {
                self.pawns[k].job = Job::Wait { until };
            }
            spawned += 1;
        }
        if spawned > 0 {
            self.push_event(EventKind::RaidIncoming, kind as u32);
            self.push_event(EventKind::Raid, spawned);
            self.last_raid_faction = led_by;
            self.raid_unresolved = true;
            // Attaquer se paie : la tribu qui mène la bande perd ce qu'elle
            // vient de prendre par la force. C'est ce qui, raid après raid,
            // finit par la faire basculer du côté hostile — et par appeler des
            // représailles.
            self.add_goodwill(led_by, factions::RAID_LED);
        }
        spawned
    }

    /// Combien de pillards, et avec quoi. La taille est tranchée d'abord
    /// (`POINTS_PER_RAIDER`), le reste des points est dépensé en tuniques puis
    /// en armes : une bande qui vient couverte vient moins bien armée.
    fn raid_roster(&mut self, points: u32, kind: RaidKind, dressed: bool) -> Vec<RaiderKit> {
        let count = (points / POINTS_PER_RAIDER).clamp(1, MAX_RAIDERS);
        let mut budget = points.saturating_sub(RAIDER_COST.saturating_mul(count));
        // Les tuniques d'abord, pour tout le monde : elles ne coûtent pas de
        // tirage, et ce qu'elles laissent est ce qui armera la bande.
        let apparels: Vec<Option<ItemKind>> = (0..count)
            .map(|_| {
                if dressed && budget >= TUNIC_COST {
                    budget -= TUNIC_COST;
                    Some(ItemKind::Tunic)
                } else {
                    None
                }
            })
            .collect();
        let mut roster: Vec<RaiderKit> = Vec::with_capacity(apparels.len());
        for (rank, apparel) in apparels.into_iter().enumerate() {
            // Un raid d'archers arme la première moitié de la bande à l'arc ;
            // le reste se débrouille avec ce qu'il reste de points.
            let archer = kind == RaidKind::Archers && 2 * (rank as u32) < count;
            let weapon = self.draw_weapon(&mut budget, archer);
            roster.push(RaiderKit { weapon, apparel });
        }
        roster
    }

    /// Arme d'un pillard, payée sur le budget commun. Le tirage est le
    /// **meilleur de deux** parmi les options abordables : un pillard qui peut
    /// s'armer s'arme presque toujours, mais une bande fauchée reste à mains
    /// nues.
    fn draw_weapon(&mut self, budget: &mut u32, archer: bool) -> Option<ItemKind> {
        if archer && *budget >= BOW_COST {
            *budget -= BOW_COST;
            return Some(ItemKind::Bow);
        }
        // Les options sont triées par coût : les abordables sont un préfixe.
        let affordable = WEAPON_OPTIONS
            .iter()
            .filter(|&&(_, c)| c <= *budget)
            .count() as u32;
        // Toujours au moins « mains nues », qui ne coûte rien.
        let n = affordable.max(1);
        let k = self.rng.below(n).max(self.rng.below(n)) as usize;
        let (weapon, cost) = WEAPON_OPTIONS[k];
        *budget -= cost;
        weapon
    }

    // ------------------------------------------------------------------
    // Largage de vivres
    // ------------------------------------------------------------------

    /// Fait tomber deux à quatre piles près de la colonie. Renvoie le nombre
    /// de piles effectivement posées (0 si la colonie est morte ou si aucune
    /// case ne convient).
    pub fn trigger_supply_drop(&mut self) -> u32 {
        self.supply_drop()
    }

    fn supply_drop(&mut self) -> u32 {
        let Some(center) = self.colony_center() else {
            return 0;
        };
        let piles = SUPPLY_MIN_PILES + self.rng.below(3);
        let mut dropped = 0;
        for _ in 0..piles {
            // Les deux tirages (contenu puis case) sont faits dans cet ordre
            // quoi qu'il arrive : un échec de placement ne doit pas décaler
            // le flux RNG des piles suivantes.
            let (kind, count) = self.draw_supply();
            let Some((x, y)) = self.supply_tile(center) else {
                continue;
            };
            self.spawn_item(kind, count, x, y);
            dropped += 1;
        }
        if dropped > 0 {
            self.push_event(EventKind::SupplyDrop, dropped);
        }
        dropped
    }

    /// Contenu d'une pile larguée : des vivres et des matériaux le plus
    /// souvent, une arme de temps en temps.
    fn draw_supply(&mut self) -> (ItemKind, u32) {
        if self.rng.chance(1, SUPPLY_WEAPON_CHANCE) {
            let k = self.rng.below(SUPPLY_WEAPONS.len() as u32) as usize;
            return (SUPPLY_WEAPONS[k], 1);
        }
        let k = self.rng.below(SUPPLY_TABLE.len() as u32) as usize;
        let (kind, min, span) = SUPPLY_TABLE[k];
        (kind, min + self.rng.below(span))
    }

    /// Barycentre des colons vivants, `None` si la colonie est éteinte.
    /// Public parce qu'il ne fait que lire : c'est le repère du largage de
    /// vivres, du rayon de lutte contre le feu (`fire::FIREFIGHT_RADIUS`) et
    /// des tests qui veulent savoir où se tient la colonie.
    pub fn colony_center(&self) -> Option<(u32, u32)> {
        let mut sum = (0u64, 0u64);
        let mut n = 0u64;
        for p in &self.pawns {
            // Les bêtes apprivoisées ne tirent pas le barycentre : c'est lui
            // qui les tient au rayon (voir `livestock::LIVESTOCK_RANGE`).
            if !p.is_colonist() || !p.is_alive() {
                continue;
            }
            let (x, y) = p.tile();
            sum.0 += u64::from(x);
            sum.1 += u64::from(y);
            n += 1;
        }
        if n == 0 {
            return None;
        }
        Some(((sum.0 / n) as u32, (sum.1 / n) as u32))
    }

    /// Case franchissable où poser une pile, tirée autour du barycentre. À
    /// défaut, la case franchissable la plus proche du barycentre : mieux vaut
    /// un largage groupé que pas de largage.
    fn supply_tile(&mut self, center: (u32, u32)) -> Option<(u32, u32)> {
        for _ in 0..SUPPLY_DRAWS {
            let dx = self.rng.range_i32(-SUPPLY_RADIUS, SUPPLY_RADIUS + 1);
            let dy = self.rng.range_i32(-SUPPLY_RADIUS, SUPPLY_RADIUS + 1);
            let x = center.0 as i32 + dx;
            let y = center.1 as i32 + dy;
            if self.map.in_bounds(x, y) && self.map.passable(x as u32, y as u32) {
                return Some((x as u32, y as u32));
            }
        }
        self.map.nearest_passable(center.0, center.1)
    }

    // ------------------------------------------------------------------
    // Maladie
    // ------------------------------------------------------------------

    /// Rend malade un colon tiré au sort parmi ceux qui vont bien. Renvoie son
    /// id, ou `None` si tout le monde est déjà malade (ou mort).
    fn strike_illness(&mut self) -> Option<u32> {
        let healthy: Vec<u32> = self
            .pawns
            .iter()
            .filter(|p| p.is_colonist() && p.is_alive() && !p.sick)
            .map(|p| p.id)
            .collect();
        if healthy.is_empty() {
            return None;
        }
        let id = healthy[self.rng.below(healthy.len() as u32) as usize];
        self.trigger_illness(id);
        Some(id)
    }

    /// Rend malade un colon précis (tests, débogage). Renvoie faux si l'id
    /// n'est pas celui d'un colon vivant.
    pub fn trigger_illness(&mut self, pawn: u32) -> bool {
        let tick = self.tick;
        let Some(p) = self
            .pawns
            .iter_mut()
            .find(|p| p.id == pawn && p.is_colonist() && p.hp > 0 && !p.gone)
        else {
            return false;
        };
        p.sick_until = tick + u64::from(ILLNESS_TICKS);
        p.illness_tended = false;
        p.sick = true;
        self.push_event(EventKind::Illness, pawn);
        true
    }

    /// Un soin abrège la maladie comme il abrège une plaie. Appelée à la fin
    /// d'un `Job::Tend`.
    pub(crate) fn tend_illness(&mut self, k: usize) {
        if !self.pawns[k].sick {
            return;
        }
        let soon = self.tick + u64::from(ILLNESS_TENDED_TICKS);
        self.pawns[k].illness_tended = true;
        self.pawns[k].sick_until = self.pawns[k].sick_until.min(soon);
    }

    // ------------------------------------------------------------------
    // Coups de temps
    // ------------------------------------------------------------------

    /// Vague de froid ou de chaleur, selon la saison : la chaleur en été, le
    /// froid le reste de l'année (une gelée tardive de printemps est un
    /// classique du genre).
    fn strike_extreme_weather(&mut self) {
        if self.season() == Season::Summer {
            self.trigger_heatwave();
        } else {
            self.trigger_cold_snap();
        }
    }

    /// Une journée à `EXTREME_OFFSET` dixièmes de moins, sous la neige ou
    /// l'orage.
    pub fn trigger_cold_snap(&mut self) {
        self.set_temperature_swing(-EXTREME_OFFSET);
        // La neige quand il gèle vraiment, l'orage sinon : `freeze_or_thaw` ne
        // convertit que la pluie, ces deux temps-là tiennent leur journée.
        let weather = if self.outdoor_temperature() < FREEZING {
            Weather::Snow
        } else {
            Weather::Storm
        };
        let until = self.offset_until;
        self.force_weather(weather, until);
        self.push_event(EventKind::ColdSnap, EXTREME_OFFSET as u32);
    }

    /// Une journée à `EXTREME_OFFSET` dixièmes de plus. Le ciel reste ce qu'il
    /// est : une canicule n'a pas de météo à elle.
    pub fn trigger_heatwave(&mut self) {
        self.set_temperature_swing(EXTREME_OFFSET);
        self.push_event(EventKind::Heatwave, EXTREME_OFFSET as u32);
    }

    fn set_temperature_swing(&mut self, tenths: i32) {
        self.temperature_offset = tenths;
        self.offset_until = self.tick + u64::from(EXTREME_TICKS);
    }

    /// Écart de température du coup de temps en cours, 0 le reste du temps.
    /// Lu par `Sim::outdoor_temperature`, donc à chaque tick : deux
    /// comparaisons, pas une de plus.
    #[inline]
    pub(crate) fn temperature_swing(&self) -> i32 {
        if self.tick < self.offset_until {
            self.temperature_offset
        } else {
            0
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_multiplicateurs_de_difficulte_sont_ordonnes() {
        let mut last = 0;
        for d in Difficulty::ALL {
            assert!(d.threat_percent() >= last, "{d:?} casse l'ordre");
            last = d.threat_percent();
            assert_eq!(Difficulty::from_u8(d as u8), d);
        }
        assert_eq!(Difficulty::Peaceful.threat_percent(), 0);
        assert_eq!(Difficulty::default(), Difficulty::Normal);
        // Une valeur inconnue retombe sur la difficulté de référence.
        assert_eq!(Difficulty::from_u8(200), Difficulty::Normal);
        // Plus la difficulté monte, moins on souffle entre deux raids.
        assert!(Difficulty::Hard.raid_delay().0 < Difficulty::Normal.raid_delay().0);
        assert!(Difficulty::Normal.raid_delay().0 < Difficulty::Easy.raid_delay().0);
    }

    #[test]
    fn les_genres_de_raid_se_relisent() {
        for k in RaidKind::ALL {
            assert_eq!(RaidKind::from_u8(k as u8), k);
        }
        assert_eq!(RaidKind::from_u8(99), RaidKind::Rush);
    }

    #[test]
    fn les_options_d_arme_sont_triees_par_cout() {
        let mut last = 0;
        for (_, cost) in WEAPON_OPTIONS {
            assert!(cost >= last, "table d'armes non triée");
            last = cost;
        }
        assert_eq!(WEAPON_OPTIONS[0].1, 0, "les mains nues sont gratuites");
    }
}
