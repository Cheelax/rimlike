use serde::{Deserialize, Serialize};

use crate::TICKS_PER_DAY;
use crate::climate::{
    COLD_MOOD_MALUS, COLD_MOOD_TEMP, Climate, FREEZING_MOOD_MALUS, HOT_MOOD_MALUS, HOT_MOOD_TEMP,
    HYPOTHERMIA_TEMP, SNOW_MOOD_MALUS,
};
use crate::craft::CraftStage;
use crate::fixed::{self, FX_HALF, Fx};
use crate::health::{BLOOD_MAX, Injury};
use crate::items::ItemKind;
use crate::map::{Designation, Map};
use crate::path::Tile;
use crate::storyteller::{ILLNESS_MOBILITY_PERCENT, ILLNESS_MOOD_MALUS, ILLNESS_WORK_PERCENT};
use crate::traits::{self, Trait};
use crate::work::{self, Skill, WORK_TYPES, WorkType};

/// Vitesse nominale : 1/256 de case par tick. 18 ≈ 4,2 cases/s à 60 ticks/s.
pub const BASE_SPEED: Fx = 18;

/// Les besoins vont de 0 (vide) à `NEED_MAX` (comblé).
pub const NEED_MAX: u32 = 1_000_000;
/// La faim passe de comblée à vide en une journée.
pub const HUNGER_DECAY: u32 = NEED_MAX / TICKS_PER_DAY;
/// Le repos s'épuise en un jour et demi d'éveil.
pub const REST_DECAY: u32 = NEED_MAX * 2 / (3 * TICKS_PER_DAY);
/// Une nuit de sommeil (un tiers de jour) recharge complètement.
pub const REST_RECOVERY: u32 = NEED_MAX * 3 / TICKS_PER_DAY;
pub const HUNGRY: u32 = 300_000;
pub const STARVING: u32 = 100_000;
pub const TIRED: u32 = 250_000;
pub const RESTED: u32 = 950_000;

/// En dessous de cette humeur, un colon peut craquer et tout lâcher.
pub const MOOD_BREAK: u32 = 200_000;
/// En dessous : le colon traîne des pieds, il travaille moins vite.
pub const MOOD_SAD: u32 = 400_000;
/// Au-dessus : le colon est heureux, il travaille plus vite.
pub const MOOD_HAPPY: u32 = 700_000;
/// Durée d'une crise : un quart de journée à errer sans rien faire.
pub const BREAK_TICKS: u32 = TICKS_PER_DAY / 4;
/// Après s'être défoulé, le colon garde un bonus d'humeur une journée.
pub const RELIEF_TICKS: u32 = TICKS_PER_DAY;

/// Points de vie d'un pawn en pleine forme. **Valeur dérivée** : voir
/// `Pawn::hp` et `Pawn::recompute_hp` (module `health`).
pub const HP_MAX: u32 = 1000;
/// En dessous : blessé (vitesse et humeur en baisse).
pub const HP_WOUNDED: u32 = HP_MAX / 2;
/// En dessous : grièvement blessé.
pub const HP_BADLY_WOUNDED: u32 = HP_MAX / 4;

/// Camp d'un pawn. Les valeurs sont un contrat avec le client.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Faction {
    Colony = 0,
    Raider = 1,
    /// Faune sauvage (voir `animals`). Ni alliée ni ennemie : les pillards
    /// l'ignorent et la défense automatique aussi, sauf sanglier qui charge.
    Animal = 2,
}

/// Ce que fait un colon. Le chemin courant vit dans `Pawn::path`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Job {
    Idle,
    /// Déplacement simple. `manual` : ordre du joueur, non interruptible par la faim.
    Move {
        manual: bool,
    },
    /// Travail sur une case désignée.
    Work {
        kind: Designation,
        x: u32,
        y: u32,
        progress: u32,
    },
    /// Transport d'une pile vers un stockage. `picked` : la pile est en main.
    Haul {
        item: u32,
        dest: Option<(u32, u32)>,
        picked: bool,
    },
    Eat {
        item: u32,
    },
    /// Dort. `in_bed` : se dirige vers un lit puis y dort ; sinon au sol.
    Sleep {
        in_bed: bool,
    },
    /// Apporte des matériaux à un chantier. `picked` : la pile est en main.
    Deliver {
        blueprint: u32,
        item: u32,
        picked: bool,
    },
    Build {
        blueprint: u32,
    },
    /// Semer (`sow`) ou récolter un plant dans une zone de culture.
    Farm {
        sow: bool,
        x: u32,
        y: u32,
        progress: u32,
    },
    /// Cuisiner au feu de camp : va chercher la nourriture crue, puis cuit.
    Cook {
        campfire: (u32, u32),
        item: u32,
        picked: bool,
        progress: u32,
    },
    /// Se rapproche d'un ennemi puis le frappe au corps à corps.
    Attack {
        target: u32,
    },
    /// Quitte la carte par le bord le plus proche.
    Flee,
    /// Crise de moral : le colon lâche tout et erre jusqu'à `until`.
    Break {
        until: u64,
    },
    /// À terre : trop peu de sang ou de conscience pour faire quoi que ce
    /// soit. Le pawn est hors combat jusqu'à ce qu'il se relève.
    Downed,
    /// Porte un colon à terre jusqu'au lit réservé. `picked` : il l'a en bras
    /// (le blessé suit alors la position du porteur à chaque tick).
    Rescue {
        target: u32,
        picked: bool,
    },
    /// Panse les blessures d'un autre colon.
    Tend {
        target: u32,
        progress: u32,
    },
    /// Fabrique au poste `spot` — une arme ou un vêtement : va chercher les
    /// ingrédients de la recette qui produit `recipe`, les rapporte, puis
    /// travaille (voir `craft`).
    Craft {
        spot: (u32, u32),
        recipe: ItemKind,
        stage: CraftStage,
    },
    /// Va chercher une pièce d'équipement rangée en stockage — une arme ou un
    /// vêtement — et l'endosse. Le genre de la pile réservée dit laquelle.
    Equip {
        item: u32,
    },
    /// Chasse un animal marqué : même approche et mêmes coups qu'une attaque
    /// (`Sim::engage`), mais la cible est du gibier, pas un ennemi — et on
    /// achève une bête à terre au lieu de l'épargner.
    ///
    /// **Ajouté en fin d'énumération** : postcard encode l'indice, et les
    /// snapshots existants en dépendent.
    Hunt {
        target: u32,
    },
    /// Dépèce une dépouille au poste de fabrication : va la chercher, la
    /// rapporte, puis débite (voir `craft::BUTCHER_TICKS`).
    Butcher {
        spot: (u32, u32),
        item: u32,
        picked: bool,
        progress: u32,
    },
    /// Attend sur place jusqu'à `until`, sans rien faire ni frapper. C'est le
    /// job des assiégeants (`storyteller::RaidKind::Siege`) pendant qu'ils
    /// campent à leur point d'entrée. Un pillard blessé pendant l'attente
    /// reprend l'IA normale : il charge ou il décroche.
    ///
    /// **Ajouté en fin d'énumération** : postcard encode l'indice.
    Wait {
        until: u64,
    },
}

impl Job {
    /// Code compact pour le tampon de rendu.
    pub fn code(&self) -> i32 {
        match self {
            Job::Idle => 0,
            Job::Move { .. } => 1,
            Job::Work {
                kind: Designation::Chop,
                ..
            } => 2,
            Job::Work {
                kind: Designation::Mine,
                ..
            } => 3,
            Job::Work { .. } => 4,
            Job::Haul { .. } => 5,
            Job::Eat { .. } => 6,
            Job::Sleep { .. } => 7,
            Job::Deliver { .. } => 8,
            Job::Build { .. } => 9,
            Job::Farm { sow: true, .. } => 10,
            Job::Farm { sow: false, .. } => 4,
            Job::Cook { .. } => 11,
            Job::Attack { .. } => 12,
            Job::Flee => 13,
            Job::Break { .. } => 14,
            Job::Downed => 15,
            Job::Rescue { .. } => 16,
            Job::Tend { .. } => 17,
            Job::Craft { .. } => 18,
            Job::Equip { .. } => 19,
            Job::Hunt { .. } => 20,
            Job::Butcher { .. } => 21,
            Job::Wait { .. } => 22,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pawn {
    pub id: u32,
    /// Tiré au sort à la création (`names::pick`), dans une liste qui dépend du camp.
    pub name: String,
    pub x: Fx,
    pub y: Fx,
    /// Chemin restant, inversé : `last()` est la prochaine case.
    pub path: Vec<Tile>,
    pub idle_ticks: u32,
    pub hunger: u32,
    pub rest: u32,
    pub job: Job,
    pub carrying: Option<(ItemKind, u32)>,
    /// Le dernier sommeil s'est fait dans un lit (bonus d'humeur) ou au sol (malus).
    pub last_sleep_in_bed: bool,
    /// Qualité du dernier repas : 1 cuisiné, 0 neutre, -1 cru désagréable.
    pub last_meal_quality: i8,
    /// **Valeur dérivée**, pas la source de vérité : `hp = HP_MAX - somme des
    /// sévérités`, remis à jour par `Pawn::recompute_hp` après tout changement
    /// de blessure ou de sang, et forcé à 0 quand le pawn meurt. Le champ est
    /// conservé pour ne pas casser les tampons de rendu ; pour blesser
    /// quelqu'un, passer par `Pawn::add_injury` ou `Sim::inflict_injury`.
    pub hp: u32,
    /// Blessures en cours, dans l'ordre où elles ont été reçues (au plus
    /// `health::MAX_INJURIES`).
    pub injuries: Vec<Injury>,
    /// Volume sanguin, 0..=`health::BLOOD_MAX`. À zéro, le pawn meurt.
    pub blood: u32,
    /// Colon à terre porté en ce moment (job `Rescue` avec `picked`).
    pub carrying_pawn: Option<u32>,
    pub faction: Faction,
    /// Ticks restants avant de pouvoir frapper à nouveau.
    pub attack_cooldown: u32,
    /// Ticks de deuil restants après la mort d'un colon.
    pub grief_ticks: u32,
    /// Le pawn a quitté la carte : il est retiré au prochain nettoyage.
    pub gone: bool,
    /// Priorité de chaque type de travail, indexée par `WorkType` :
    /// 1 la plus haute, 4 la plus basse, 0 désactivé.
    pub priorities: [u8; WORK_TYPES],
    /// Compétence de chaque type de travail, indexée par `WorkType`. Tirée au
    /// sort à la création pour les colons (`Sim::spawn_pawn`) ; toujours à 0
    /// pour les pillards.
    pub skills: [Skill; WORK_TYPES],
    /// Ticks restants du bonus d'humeur qui suit une crise.
    pub relief_ticks: u32,
    /// Le colon est dehors sous l'orage (recopié du sim à chaque tick, parce
    /// que `mood()` ne voit que le pawn).
    pub outdoor_storm: bool,
    /// Arme équipée, `None` à mains nues. Une seule à la fois ; elle tombe au
    /// sol à la mort du porteur et voyage avec lui en caravane.
    pub weapon: Option<ItemKind>,
    /// Compétence de corps à corps. **Hors du tableau `skills`** : le combat
    /// n'est pas un type de travail, `WORK_TYPES` et les priorités ne bougent
    /// pas. Tirée au sort à la création pour les colons.
    pub melee: Skill,
    /// Compétence de tir, même statut que `melee`.
    pub ranged: Skill,
    /// Température ressentie, en dixièmes de degré : celle de la case où il se
    /// trouve, recopiée à chaque tick depuis `Sim::tile_temperature` (comme
    /// `outdoor_storm`, parce que `mood()` ne voit que le pawn).
    pub comfort: i32,
    /// Il neige sur la carte. Recopié du sim à chaque tick.
    pub in_snow: bool,
    /// Espèce, pour un pawn de `Faction::Animal` ; `None` pour un humain.
    /// Elle décide de la vitesse, du plafond de PV et de ce que donne le
    /// dépeçage (voir `animals::Species`). **Champs ajoutés en fin de
    /// structure** : un vieux snapshot est refusé net plutôt que relu de travers.
    pub species: Option<crate::animals::Species>,
    /// Tick jusqu'auquel la bête détale ; 0 quand elle est calme.
    pub flee_until: u64,
    /// La bête est marquée comme gibier (`Command::Hunt`).
    pub hunted: bool,
    /// Tick du prochain pas de pâture.
    pub graze_at: u64,
    /// La bête a décidé, en prenant peur, de quitter la carte pour de bon :
    /// elle disparaît en atteignant un bord. Tiré une fois par fuite et lu
    /// seulement pendant celle-ci (voir `animals::ESCAPE_CHANCE`).
    pub leaving: bool,
    /// Vêtement porté, `None` sur le dos nu. Un seul à la fois, comme l'arme :
    /// il isole du froid (`insulation_tenths`), tombe au sol à la mort du
    /// porteur et voyage avec lui en caravane. **Champ ajouté en fin de
    /// structure** : un vieux snapshot est refusé net plutôt que relu de
    /// travers.
    pub apparel: Option<ItemKind>,
    /// Tick jusqu'auquel le colon est malade ; 0 quand il va bien (voir
    /// `storyteller`). C'est la **source de vérité** de la maladie.
    pub sick_until: u64,
    /// Recopie de `sick_until > tick`, refaite à chaque tick par
    /// `Sim::tick_health` — même procédé que `outdoor_storm` et `in_snow` :
    /// `mood()`, `work_step()` et `speed_percent()` ne voient que le pawn, pas
    /// l'horloge du sim.
    pub sick: bool,
    /// La maladie a été soignée : elle ne demande plus de chevet et se termine
    /// deux fois plus vite. Remis à faux dès que le colon est guéri.
    pub illness_tended: bool,
    /// Deux traits de caractère au plus, jamais contradictoires (voir
    /// `traits::roll`). Tirés à la création pour les colons (voyageurs
    /// compris) par `Sim::spawn_pawn` ; toujours `[None, None]` pour les
    /// pillards et les bêtes. **Champs ajoutés en fin de structure** : un
    /// vieux snapshot est refusé net plutôt que relu de travers.
    pub traits: [Option<Trait>; 2],
    /// Hors de la plage `traits::DAY_START_HOUR`-`traits::DAY_END_HOUR`,
    /// recopié à chaque tick par `Sim::tick_pawn` comme `outdoor_storm` : sert
    /// à `Trait::NightOwl` (`work_step`), qui ne voit que le pawn.
    pub is_night: bool,
    /// Un pillard vivant traîne encore sur la carte, recopié à chaque tick
    /// comme `outdoor_storm` : sert à `Trait::Coward` (`mood`).
    pub enemy_present: bool,
    /// Nombre d'autres colons vivants sur la carte, recopié à chaque tick
    /// comme `outdoor_storm` : sert à `Trait::Sociable` (`mood`).
    pub other_colonists_alive: u32,
}

impl Pawn {
    /// `name` vient de `names::pick` : `at_tile` ne connaît pas le RNG, donc
    /// ne tire rien lui-même. Idem pour les niveaux de compétence, posés par
    /// l'appelant (`Sim::spawn_pawn`) après construction.
    pub fn at_tile(id: u32, x: u32, y: u32, name: String) -> Pawn {
        Pawn {
            id,
            name,
            x: fixed::from_int(x as i32) + FX_HALF,
            y: fixed::from_int(y as i32) + FX_HALF,
            path: Vec::new(),
            idle_ticks: 0,
            hunger: NEED_MAX * 4 / 5,
            rest: NEED_MAX * 9 / 10,
            job: Job::Idle,
            carrying: None,
            last_sleep_in_bed: true,
            last_meal_quality: 0,
            hp: HP_MAX,
            injuries: Vec::new(),
            blood: BLOOD_MAX,
            carrying_pawn: None,
            faction: Faction::Colony,
            attack_cooldown: 0,
            grief_ticks: 0,
            gone: false,
            priorities: [3; WORK_TYPES],
            skills: [Skill::default(); WORK_TYPES],
            relief_ticks: 0,
            outdoor_storm: false,
            weapon: None,
            melee: Skill::default(),
            ranged: Skill::default(),
            // Une valeur tempérée en attendant le premier tick : zéro voudrait
            // dire 0 °C, et un pawn tout juste créé grelotterait pour rien.
            comfort: Climate::TEMPERATE_BASE,
            in_snow: false,
            species: None,
            flee_until: 0,
            hunted: false,
            graze_at: 0,
            leaving: false,
            apparel: None,
            sick_until: 0,
            sick: false,
            illness_tended: false,
            traits: [None, None],
            is_night: false,
            enemy_present: false,
            other_colonists_alive: 0,
        }
    }

    /// Vrai si le colon porte ce trait, sur l'un des deux emplacements.
    pub fn has_trait(&self, t: Trait) -> bool {
        self.traits[0] == Some(t) || self.traits[1] == Some(t)
    }

    /// Dégâts effectivement subis pour un coup de force `base` : `Tough`
    /// encaisse `traits::TOUGH_DAMAGE_PERCENT`, `Frail`
    /// `traits::FRAIL_DAMAGE_PERCENT`. La sévérité portant le saignement
    /// (`Injury::bleeding` = sévérité / `health::BLEED_FRACTION`), moduler
    /// l'une revient à moduler l'autre dans les mêmes proportions. Appelée par
    /// le combat (`Sim::melee_strike`, `Sim::shoot`) ; `Sim::inflict_injury`
    /// n'applique volontairement aucun modificateur, pour rester un coup «
    /// brut » utilisable en test et en debug.
    pub fn damage_from(&self, base: u32) -> u32 {
        let percent = if self.has_trait(Trait::Tough) {
            traits::TOUGH_DAMAGE_PERCENT
        } else if self.has_trait(Trait::Frail) {
            traits::FRAIL_DAMAGE_PERCENT
        } else {
            100
        };
        (base * percent / 100).max(1)
    }

    /// Isolation apportée par le vêtement porté, en dixièmes de degré : ce que
    /// le colon gagne sur la température de sa case. 0 sur le dos nu.
    pub fn insulation_tenths(&self) -> i32 {
        self.apparel.map_or(0, |a| a.insulation_tenths())
    }

    /// Points de vie d'un pawn entier. Un humain vaut `HP_MAX` ; une bête vaut
    /// ce que vaut son espèce, du lapin au sanglier. C'est le plafond que
    /// `recompute_hp` entame, donc aussi ce qui décide quand elle meurt.
    pub fn max_hp(&self) -> u32 {
        match self.species {
            Some(s) => s.max_hp(),
            None => HP_MAX,
        }
    }

    pub fn tile(&self) -> (u32, u32) {
        (fixed::to_int(self.x) as u32, fixed::to_int(self.y) as u32)
    }

    /// Un pawn mort ou parti n'est plus simulé et disparaît du tampon de rendu.
    pub fn is_alive(&self) -> bool {
        self.hp > 0 && !self.gone
    }

    pub fn is_moving(&self) -> bool {
        !self.path.is_empty()
    }

    pub fn is_hungry(&self) -> bool {
        self.hunger < HUNGRY
    }

    pub fn is_starving(&self) -> bool {
        self.hunger < STARVING
    }

    pub fn is_tired(&self) -> bool {
        self.rest < TIRED
    }

    /// Humeur dérivée des besoins, dans `0..=NEED_MAX`.
    pub fn mood(&self) -> u32 {
        let mut m: i64 = 600_000;
        if self.is_starving() {
            m -= 350_000;
        } else if self.is_hungry() {
            m -= 150_000;
        } else if self.hunger > 800_000 {
            m += 60_000;
        }
        if self.rest < 100_000 {
            m -= 300_000;
        } else if self.is_tired() {
            m -= 150_000;
        }
        if self.last_sleep_in_bed {
            m += 50_000;
        } else if !self.has_trait(Trait::Ascetic) {
            // Un ascète ne perd rien à dormir au sol.
            m -= 80_000;
        }
        let ascetic = self.has_trait(Trait::Ascetic);
        let gourmand = self.has_trait(Trait::Gourmand);
        m += match self.last_meal_quality {
            1 => {
                if gourmand {
                    40_000 + traits::GOURMAND_EXTRA_MEAL_BONUS
                } else {
                    40_000
                }
            }
            // Un ascète ne perd rien à manger cru.
            -1 if ascetic => 0,
            -1 => -60_000,
            _ => 0,
        };
        if self.grief_ticks > 0 {
            m -= 150_000;
        }
        if self.hp < HP_WOUNDED {
            m -= 100_000;
        }
        // Le colon s'est défoulé : ça va mieux pendant un moment.
        if self.relief_ticks > 0 {
            m += 80_000;
        }
        // Tout le monde est dehors sous l'orage : les toits viendront plus tard.
        if self.outdoor_storm {
            m -= 50_000;
        }
        // Le froid et la chaleur ne se cumulent pas : on garde le pire des
        // trois seuils. `comfort` porte déjà l'isolation du vêtement, donc un
        // manteau remonte ces seuils sans qu'on ait rien à faire ici — y
        // compris, faute de gestion de la chaleur, du mauvais côté de
        // `HOT_MOOD_TEMP`.
        if self.comfort < HYPOTHERMIA_TEMP {
            m -= FREEZING_MOOD_MALUS;
        } else if self.comfort < COLD_MOOD_TEMP {
            m -= COLD_MOOD_MALUS;
        } else if self.comfort > HOT_MOOD_TEMP {
            m -= HOT_MOOD_MALUS;
        }
        if self.in_snow {
            m -= SNOW_MOOD_MALUS;
        }
        // Être malade abat autant qu'une bonne blessure.
        if self.sick {
            m -= ILLNESS_MOOD_MALUS;
        }
        if self.has_trait(Trait::Optimist) {
            m += traits::OPTIMIST_MOOD_BONUS;
        }
        if self.has_trait(Trait::Pessimist) {
            m -= traits::PESSIMIST_MOOD_MALUS;
        }
        // Un couard rumine tant qu'un pillard traîne sur la carte.
        if self.has_trait(Trait::Coward) && self.enemy_present {
            m -= traits::COWARD_ENEMY_MOOD_MALUS;
        }
        if self.has_trait(Trait::Sociable) {
            if self.other_colonists_alive == 0 {
                m -= traits::SOCIABLE_ALONE_MOOD_MALUS;
            } else {
                let bonus = (traits::SOCIABLE_MOOD_PER_COLONIST * self.other_colonists_alive)
                    .min(traits::SOCIABLE_MOOD_CAP);
                m += i64::from(bonus);
            }
        }
        m.clamp(0, i64::from(NEED_MAX)) as u32
    }

    /// Vitesse de travail en centièmes pour le type de travail donné :
    /// l'humeur décide de l'ardeur, le niveau de compétence de l'efficacité,
    /// et les bras font le reste.
    pub fn work_step(&self, work: WorkType) -> u32 {
        let mood = self.mood();
        let mood_percent = if mood >= MOOD_HAPPY {
            120
        } else if mood < MOOD_SAD {
            80
        } else {
            100
        };
        let level = self.skills[work as usize].level;
        // Un malade traîne : dernier facteur, comme la maladresse des bras.
        let sick_percent = if self.sick { ILLNESS_WORK_PERCENT } else { 100 };
        mood_percent * work::skill_percent(level) / 100 * self.manipulation_percent() / 100
            * sick_percent
            / 100
            * self.trait_work_percent()
            / 100
    }

    /// Multiplicateur combiné des traits qui touchent la vitesse de travail :
    /// `Industrious`/`Lazy` (fixe) et `NightOwl` (selon `is_night`, recopié
    /// par tick comme `outdoor_storm`). Les deux familles se cumulent : un
    /// travailleur acharné qui est aussi lève-tard reste plus rapide la nuit
    /// que le jour, sans perdre son bonus permanent.
    fn trait_work_percent(&self) -> u32 {
        let steady = if self.has_trait(Trait::Industrious) {
            traits::INDUSTRIOUS_WORK_PERCENT
        } else if self.has_trait(Trait::Lazy) {
            traits::LAZY_WORK_PERCENT
        } else {
            100
        };
        let clock = if !self.has_trait(Trait::NightOwl) {
            100
        } else if self.is_night {
            traits::NIGHT_OWL_NIGHT_PERCENT
        } else {
            traits::NIGHT_OWL_DAY_PERCENT
        };
        steady * clock / 100
    }

    /// Vitesse en pourcentage de la nominale. Les malus globaux de blessure ne
    /// se cumulent pas entre eux (on garde le plus sévère) ; la mobilité, elle,
    /// vient s'y multiplier : des jambes abîmées ralentissent en plus. Les
    /// seuils sont **relatifs au plafond** : un lapin à 150 PV serait sinon
    /// « grièvement blessé » en pleine forme (`HP_WOUNDED` vaut 500).
    pub fn speed_percent(&self) -> u32 {
        let base = if self.is_starving() { 60 } else { 100 };
        let max = self.max_hp();
        let wounded = if self.hp * (HP_MAX / HP_BADLY_WOUNDED) < max {
            base * 50 / 100
        } else if self.hp * (HP_MAX / HP_WOUNDED) < max {
            base * 70 / 100
        } else {
            base
        };
        // Le lapin détale, le sanglier pèse : c'est le dernier facteur.
        let species = self.species.map_or(100, |s| s.speed_percent());
        // La maladie s'y multiplie comme le reste : elle ne cloue pas au lit,
        // elle ralentit.
        let sick_percent = if self.sick {
            ILLNESS_MOBILITY_PERCENT
        } else {
            100
        };
        wounded * self.mobility_percent() / 100 * species / 100 * sick_percent / 100
    }

    /// Remplace le chemin courant. `path` est dans l'ordre de parcours.
    pub fn set_path(&mut self, mut path: Vec<Tile>) {
        path.reverse();
        self.path = path;
        self.idle_ticks = 0;
    }

    /// Avance d'un tick le long du chemin. La vitesse dépend du terrain de la
    /// case visée et de l'état du colon.
    pub fn advance(&mut self, map: &Map) {
        let Some(&(wx, wy)) = self.path.last() else {
            return;
        };
        let cost = map.move_cost(u32::from(wx), u32::from(wy)).unwrap_or(100);
        let speed = (i64::from(BASE_SPEED) * 100 * i64::from(self.speed_percent())
            / (i64::from(cost) * 100))
            .max(1);
        let tx = fixed::from_int(i32::from(wx)) + FX_HALF;
        let ty = fixed::from_int(i32::from(wy)) + FX_HALF;
        let dx = i64::from(tx - self.x);
        let dy = i64::from(ty - self.y);
        let dist = fixed::isqrt((dx * dx + dy * dy) as u64) as i64;
        if dist <= speed {
            self.x = tx;
            self.y = ty;
            self.path.pop();
        } else {
            self.x += (dx * speed / dist) as Fx;
            self.y += (dy * speed / dist) as Fx;
        }
    }
}
