use serde::{Deserialize, Serialize};

use crate::TICKS_PER_DAY;
use crate::fixed::{self, FX_HALF, Fx};
use crate::items::ItemKind;
use crate::map::{Designation, Map};
use crate::path::Tile;
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

/// Points de vie d'un pawn en pleine forme.
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
    pub hp: u32,
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
            faction: Faction::Colony,
            attack_cooldown: 0,
            grief_ticks: 0,
            gone: false,
            priorities: [3; WORK_TYPES],
            skills: [Skill::default(); WORK_TYPES],
            relief_ticks: 0,
            outdoor_storm: false,
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
        } else {
            m -= 80_000;
        }
        m += match self.last_meal_quality {
            1 => 40_000,
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
        m.clamp(0, i64::from(NEED_MAX)) as u32
    }

    /// Vitesse de travail en centièmes pour le type de travail donné :
    /// l'humeur décide de l'ardeur, le niveau de compétence de l'efficacité.
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
        mood_percent * work::skill_percent(level) / 100
    }

    /// Vitesse en pourcentage de la nominale. Les malus de blessure ne se
    /// cumulent pas entre eux : on garde le plus sévère.
    pub fn speed_percent(&self) -> u32 {
        let base = if self.is_starving() { 60 } else { 100 };
        if self.hp < HP_BADLY_WOUNDED {
            base * 50 / 100
        } else if self.hp < HP_WOUNDED {
            base * 70 / 100
        } else {
            base
        }
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
