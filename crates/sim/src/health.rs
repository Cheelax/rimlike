//! Santé détaillée : parties du corps, blessures, saignement et sang.
//!
//! Les points de vie ne sont plus une réserve qu'on entame : `Pawn::hp` est
//! **dérivé** de la somme des sévérités (voir `Pawn::recompute_hp`). Tout ce
//! qui blesse passe par `Pawn::add_injury` ; rien ne touche `hp` directement.
//!
//! Toutes les valeurs sont entières et les parcours suivent l'ordre des `Vec` :
//! aucune source d'indéterminisme.

use serde::{Deserialize, Serialize};

use crate::TICKS_PER_DAY;
use crate::pawn::{HP_MAX, Job, Pawn};

/// Partie du corps touchée par une blessure. Les valeurs sont un contrat avec
/// le client (`pawn_injuries` en expose l'entier).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum BodyPart {
    Head = 0,
    Torso = 1,
    LeftArm = 2,
    RightArm = 3,
    LeftLeg = 4,
    RightLeg = 5,
}

/// Nombre de parties du corps.
pub const BODY_PARTS: usize = 6;

/// Somme des poids de `BodyPart::hit_weight`.
pub const HIT_WEIGHT_TOTAL: u32 = 200;

impl BodyPart {
    /// Dans l'ordre des valeurs : c'est aussi l'ordre du découpage des tirages.
    pub const ALL: [BodyPart; BODY_PARTS] = [
        BodyPart::Head,
        BodyPart::Torso,
        BodyPart::LeftArm,
        BodyPart::RightArm,
        BodyPart::LeftLeg,
        BodyPart::RightLeg,
    ];

    pub fn from_u8(v: u8) -> BodyPart {
        match v {
            0 => BodyPart::Head,
            2 => BodyPart::LeftArm,
            3 => BodyPart::RightArm,
            4 => BodyPart::LeftLeg,
            5 => BodyPart::RightLeg,
            _ => BodyPart::Torso,
        }
    }

    /// Poids de tirage d'un coup, sur `HIT_WEIGHT_TOTAL` : torse 35 %,
    /// tête 10 %, chaque bras 15 %, chaque jambe 12,5 %.
    pub fn hit_weight(self) -> u32 {
        match self {
            BodyPart::Head => 20,
            BodyPart::Torso => 70,
            BodyPart::LeftArm | BodyPart::RightArm => 30,
            BodyPart::LeftLeg | BodyPart::RightLeg => 25,
        }
    }

    pub fn is_arm(self) -> bool {
        matches!(self, BodyPart::LeftArm | BodyPart::RightArm)
    }

    pub fn is_leg(self) -> bool {
        matches!(self, BodyPart::LeftLeg | BodyPart::RightLeg)
    }

    /// Une blessure maximale ici est mortelle.
    pub fn is_vital(self) -> bool {
        matches!(self, BodyPart::Head | BodyPart::Torso)
    }
}

/// Partie touchée par un tirage dans `0..HIT_WEIGHT_TOTAL`.
pub fn part_for_roll(roll: u32) -> BodyPart {
    let mut acc = 0;
    for part in BodyPart::ALL {
        acc += part.hit_weight();
        if roll < acc {
            return part;
        }
    }
    BodyPart::Torso
}

/// Sévérité maximale d'une blessure : au torse ou à la tête, elle tue.
pub const SEVERITY_MAX: u32 = 1000;
/// Blessures suivies par pawn. Au-delà, la nouvelle vient aggraver la plus
/// grave de la même partie.
pub const MAX_INJURIES: usize = 8;
/// Volume sanguin d'un pawn en pleine forme.
pub const BLOOD_MAX: u32 = 1000;
/// Une plaie non pansée saigne ce temps-là, puis se referme d'elle-même.
pub const BLEED_TICKS: u32 = TICKS_PER_DAY / 6;
/// Le sang perdu est décompté par tranches : `bleeding` est en points par
/// `BLEED_INTERVAL` ticks.
pub const BLEED_INTERVAL: u64 = 100;
/// Sans saignement, le corps refait 1 point de sang tous ces ticks.
pub const BLOOD_REGEN_INTERVAL: u64 = 40;
/// Part de la sévérité d'un coup qui se transforme en saignement.
pub const BLEED_FRACTION: u32 = 4;

/// En dessous de cette conscience (ou de ce sang), le pawn s'écroule.
pub const DOWNED_CONSCIOUSNESS: u32 = 30;
pub const DOWNED_BLOOD: u32 = 300;
/// Il faut remonter au-dessus pour se relever : hystérésis, sinon un blessé
/// clignoterait entre debout et à terre.
pub const UP_CONSCIOUSNESS: u32 = 40;
pub const UP_BLOOD: u32 = 400;

/// Durée d'un soin.
pub const TEND_TICKS: u32 = 240;
/// Vitesse de soin, en centièmes de tick. Neutre : le soin n'a pas de
/// `WorkType` (en ajouter un changerait `WORK_TYPES` et les tampons de
/// priorités), donc ni humeur ni compétence ne le modulent pour l'instant.
pub const TEND_STEP: u32 = 100;

/// Une blessure sur une partie du corps. `severity` va de 0 à `SEVERITY_MAX`,
/// `bleeding` est une perte de sang par `BLEED_INTERVAL` ticks.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Injury {
    pub part: BodyPart,
    /// 0..=`SEVERITY_MAX`. La blessure disparaît à 0.
    pub severity: u32,
    /// Points de sang perdus par `BLEED_INTERVAL` ticks. 0 si pansée ou refermée.
    pub bleeding: u32,
    /// Pansée : ne saigne plus et cicatrise deux fois plus vite.
    pub tended: bool,
    /// Ticks de saignement restants avant que la plaie se referme seule.
    /// Champ interne : il ne sort pas dans le tampon du client.
    pub bleed_ticks: u32,
}

impl Injury {
    pub fn new(part: BodyPart, severity: u32, bleeding: u32) -> Injury {
        Injury {
            part,
            severity: severity.min(SEVERITY_MAX),
            bleeding,
            tended: false,
            bleed_ticks: if bleeding > 0 { BLEED_TICKS } else { 0 },
        }
    }

    /// Referme la plaie : c'est ce que fait un soin, et ce que le temps finit
    /// par faire tout seul.
    pub fn close(&mut self) {
        self.bleeding = 0;
        self.bleed_ticks = 0;
    }
}

impl Pawn {
    /// Somme des sévérités, toutes parties confondues.
    pub fn total_severity(&self) -> u32 {
        self.injuries.iter().map(|i| i.severity).sum()
    }

    /// Somme des sévérités des parties retenues par `pick`.
    fn severity_where(&self, pick: fn(BodyPart) -> bool) -> u32 {
        self.injuries
            .iter()
            .filter(|i| pick(i.part))
            .map(|i| i.severity)
            .sum()
    }

    /// Recalcule les points de vie à partir des blessures et du sang. `hp`
    /// n'est plus la source de vérité : il est gardé pour les tampons de rendu
    /// et vaut exactement 0 quand le pawn meurt.
    pub fn recompute_hp(&mut self) {
        let lethal = self.blood == 0
            || self
                .injuries
                .iter()
                .any(|i| i.part.is_vital() && i.severity >= SEVERITY_MAX);
        self.hp = if lethal {
            0
        } else {
            HP_MAX.saturating_sub(self.total_severity().min(HP_MAX))
        };
    }

    /// Ajoute une blessure. Au-delà de `MAX_INJURIES`, elle vient aggraver la
    /// plus grave de la même partie (à défaut, la plus grave tout court) :
    /// l'état d'un pawn reste borné même après un long combat.
    pub fn add_injury(&mut self, part: BodyPart, severity: u32, bleeding: u32) {
        if severity == 0 {
            return;
        }
        if self.injuries.len() < MAX_INJURIES {
            self.injuries.push(Injury::new(part, severity, bleeding));
            self.recompute_hp();
            return;
        }
        let target = self
            .worst_index(|i| i.part == part)
            .or_else(|| self.worst_index(|_| true));
        if let Some(k) = target {
            let inj = &mut self.injuries[k];
            inj.severity = (inj.severity + severity).min(SEVERITY_MAX);
            if bleeding > 0 {
                inj.bleeding += bleeding;
                inj.bleed_ticks = BLEED_TICKS;
                inj.tended = false;
            }
        }
        self.recompute_hp();
    }

    /// Indice de la blessure la plus grave parmi celles retenues. À égalité,
    /// la première rencontrée : l'ordre du `Vec` tranche.
    fn worst_index(&self, keep: impl Fn(&Injury) -> bool) -> Option<usize> {
        let mut best: Option<(usize, u32)> = None;
        for (k, inj) in self.injuries.iter().enumerate() {
            if keep(inj) && best.is_none_or(|(_, s)| inj.severity > s) {
                best = Some((k, inj.severity));
            }
        }
        best.map(|(k, _)| k)
    }

    /// La famine ronge le torse. Une seule blessure « faiblesse » (sans
    /// saignement) qui s'aggrave, plutôt qu'une par tick de famine. Elle naît
    /// « pansée » : il n'y a rien à bander sur un ventre vide, ça se soigne en
    /// mangeant — et personne ne perd son temps à venir l'examiner.
    pub fn starve_torso(&mut self) {
        self.wear_torso(1);
    }

    /// Le grand froid ronge le torse, exactement comme la famine : une seule
    /// atteinte « pansée », sans saignement, qui s'aggrave par paliers et
    /// cicatrise comme les autres dès qu'on est au chaud
    /// (`climate::COLD_SEVERITY`).
    pub fn chill_torso(&mut self) {
        self.wear_torso(crate::climate::COLD_SEVERITY);
    }

    /// Aggrave (ou crée) l'atteinte sourde du torse : celle qui ne saigne pas
    /// et qu'on ne panse pas. Partagée par la famine et le froid.
    fn wear_torso(&mut self, amount: u32) {
        if amount == 0 {
            return;
        }
        let existing = self
            .injuries
            .iter()
            .position(|i| i.part == BodyPart::Torso && i.bleeding == 0);
        match existing {
            Some(k) => {
                let inj = &mut self.injuries[k];
                inj.severity = (inj.severity + amount).min(SEVERITY_MAX);
            }
            None if self.injuries.len() < MAX_INJURIES => {
                let mut weakness = Injury::new(BodyPart::Torso, amount, 0);
                weakness.tended = true;
                self.injuries.push(weakness);
            }
            None => self.add_injury(BodyPart::Torso, amount, 0),
        }
        self.recompute_hp();
    }

    /// Mobilité en pourcentage : les jambes portent le corps.
    pub fn mobility_percent(&self) -> u32 {
        let legs = self.severity_where(BodyPart::is_leg).min(2 * SEVERITY_MAX);
        (100 - 60 * legs / (2 * SEVERITY_MAX)).clamp(20, 100)
    }

    /// Manipulation en pourcentage : les bras font le travail.
    pub fn manipulation_percent(&self) -> u32 {
        let arms = self.severity_where(BodyPart::is_arm).min(2 * SEVERITY_MAX);
        (100 - 60 * arms / (2 * SEVERITY_MAX)).clamp(20, 100)
    }

    /// Conscience en pourcentage : le sang irrigue, la tête encaisse.
    pub fn consciousness_percent(&self) -> u32 {
        let head = self.severity_where(|p| p == BodyPart::Head);
        (self.blood / 10).min(100).saturating_sub(head / 20)
    }

    /// Le pawn est à terre : il ne fait plus rien et sort du combat.
    pub fn is_downed(&self) -> bool {
        matches!(self.job, Job::Downed)
    }

    /// Y a-t-il une plaie ouverte ?
    pub fn is_bleeding(&self) -> bool {
        self.injuries.iter().any(|i| i.bleeding > 0)
    }

    /// Sang perdu par `BLEED_INTERVAL` ticks.
    pub fn bleed_rate(&self) -> u32 {
        self.injuries.iter().map(|i| i.bleeding).sum()
    }

    /// Reste-t-il une blessure à panser ?
    pub fn needs_tending(&self) -> bool {
        self.injuries.iter().any(|i| !i.tended)
    }
}
