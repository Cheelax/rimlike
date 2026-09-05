use serde::{Deserialize, Serialize};

use crate::TICKS_PER_DAY;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum ItemKind {
    Wood = 0,
    Stone = 1,
    Berries = 2,
    Vegetables = 3,
    Meal = 4,
    /// Dépouille d'un pawn mort. Ne se transporte pas, se décompose.
    Corpse = 5,
    /// Gourdin : du bois taillé. Arme de mêlée d'entrée de gamme.
    Club = 6,
    /// Épieu : bois et pierre. Frappe plus fort qu'un gourdin.
    Spear = 7,
    /// Arc : tire à distance (voir `combat::BOW_RANGE`), médiocre en mêlée.
    Bow = 8,
    /// Dépouilles de bêtes. **Un genre par espèce** : `ItemStack` ne porte
    /// aucune métadonnée, c'est donc le genre qui dit ce qu'on dépèce (voir
    /// `animals::Species::corpse_kind`). Contrairement au cadavre humain,
    /// elles se transportent : on les range avant de les débiter.
    DeerCorpse = 9,
    RabbitCorpse = 10,
    BoarCorpse = 11,
    /// Viande crue, tirée d'un dépeçage. Se mange telle quelle (mal) ou se
    /// cuisine comme les autres crus.
    Meat = 12,
    /// Cuir : ni comestible ni périssable. Matière première des vêtements.
    Leather = 13,
    /// Tunique de cuir : le premier vêtement, vite taillé et modestement chaud.
    Tunic = 14,
    /// Manteau de cuir : deux fois plus de cuir, deux fois et demie plus chaud.
    Coat = 15,
}

/// Isolation d'une tunique, en dixièmes de degré : +6 °C sur la température
/// ressentie de son porteur.
pub const TUNIC_INSULATION: i32 = 60;
/// Isolation d'un manteau : +15 °C. De quoi tenir dehors un hiver que la
/// tunique seule ne suffit pas à traverser (`climate::HYPOTHERMIA_TEMP`).
pub const COAT_INSULATION: i32 = 150;

impl ItemKind {
    pub const COUNT: usize = 16;

    pub fn from_u8(v: u8) -> ItemKind {
        match v {
            0 => ItemKind::Wood,
            1 => ItemKind::Stone,
            2 => ItemKind::Berries,
            3 => ItemKind::Vegetables,
            4 => ItemKind::Meal,
            6 => ItemKind::Club,
            7 => ItemKind::Spear,
            8 => ItemKind::Bow,
            9 => ItemKind::DeerCorpse,
            10 => ItemKind::RabbitCorpse,
            11 => ItemKind::BoarCorpse,
            12 => ItemKind::Meat,
            13 => ItemKind::Leather,
            14 => ItemKind::Tunic,
            15 => ItemKind::Coat,
            _ => ItemKind::Corpse,
        }
    }

    /// Nutrition d'une unité, en millionièmes de besoin. `None` : pas comestible.
    pub fn nutrition(self) -> Option<u32> {
        match self {
            ItemKind::Berries => Some(200_000),
            ItemKind::Vegetables => Some(150_000),
            ItemKind::Meal => Some(900_000),
            ItemKind::Meat => Some(180_000),
            ItemKind::Wood
            | ItemKind::Stone
            | ItemKind::Corpse
            | ItemKind::Club
            | ItemKind::Spear
            | ItemKind::Bow
            | ItemKind::DeerCorpse
            | ItemKind::RabbitCorpse
            | ItemKind::BoarCorpse
            | ItemKind::Leather
            | ItemKind::Tunic
            | ItemKind::Coat => None,
        }
    }

    pub fn is_food(self) -> bool {
        self.nutrition().is_some()
    }

    /// Un colon peut-il ranger cette pile ? Seul le cadavre **humain** reste
    /// où il tombe ; une dépouille de bête part au stockage, puis au poste.
    pub fn haulable(self) -> bool {
        self != ItemKind::Corpse
    }

    /// Dépouille de bête, matière première du dépeçage.
    pub fn is_animal_corpse(self) -> bool {
        matches!(
            self,
            ItemKind::DeerCorpse | ItemKind::RabbitCorpse | ItemKind::BoarCorpse
        )
    }

    /// Nourriture crue, transformable en repas au feu de camp.
    pub fn is_raw_food(self) -> bool {
        matches!(
            self,
            ItemKind::Berries | ItemKind::Vegetables | ItemKind::Meat
        )
    }

    /// Ordre de préférence quand un colon a faim : plus petit = meilleur. La
    /// viande crue passe après les légumes : c'est le dernier recours.
    pub fn food_rank(self) -> u32 {
        match self {
            ItemKind::Meal => 0,
            ItemKind::Berries => 1,
            ItemKind::Vegetables => 2,
            ItemKind::Meat => 3,
            ItemKind::Wood
            | ItemKind::Stone
            | ItemKind::Corpse
            | ItemKind::Club
            | ItemKind::Spear
            | ItemKind::Bow
            | ItemKind::DeerCorpse
            | ItemKind::RabbitCorpse
            | ItemKind::BoarCorpse
            | ItemKind::Leather
            | ItemKind::Tunic
            | ItemKind::Coat => u32::MAX,
        }
    }

    /// Une arme se fabrique, se range, s'équipe — et se porte à l'unité, même
    /// si une pile posée au sol en empile plusieurs comme n'importe quoi d'autre.
    pub fn is_weapon(self) -> bool {
        matches!(self, ItemKind::Club | ItemKind::Spear | ItemKind::Bow)
    }

    /// Qualité d'une arme : plus grand = meilleur. C'est l'ordre dans lequel un
    /// colon s'équipe (`Bow > Spear > Club`) ; 0 pour ce qui n'est pas une arme.
    pub fn weapon_rank(self) -> u32 {
        match self {
            ItemKind::Club => 1,
            ItemKind::Spear => 2,
            ItemKind::Bow => 3,
            _ => 0,
        }
    }

    /// Un vêtement se fabrique, se range et s'endosse — un seul à la fois
    /// (`Pawn::apparel`), comme une arme. Il tombe au sol à la mort de son
    /// porteur et voyage avec lui en caravane.
    pub fn is_apparel(self) -> bool {
        matches!(self, ItemKind::Tunic | ItemKind::Coat)
    }

    /// Qualité d'un vêtement : plus grand = meilleur. C'est l'ordre dans lequel
    /// un colon s'habille (`Coat > Tunic`) ; 0 pour ce qui n'est pas un
    /// vêtement. Même rôle que `weapon_rank`, et surtout même contrat : un
    /// colon ne redescend jamais en gamme.
    pub fn apparel_rank(self) -> u32 {
        match self {
            ItemKind::Tunic => 1,
            ItemKind::Coat => 2,
            _ => 0,
        }
    }

    /// Isolation apportée au porteur, en dixièmes de degré. 0 pour tout ce qui
    /// ne se porte pas.
    pub fn insulation_tenths(self) -> i32 {
        match self {
            ItemKind::Tunic => TUNIC_INSULATION,
            ItemKind::Coat => COAT_INSULATION,
            _ => 0,
        }
    }

    /// Dégâts de mêlée en pourcentage de ceux des poings nus. L'arc est une
    /// mauvaise massue : on ne se bat pas au corps à corps avec un arc.
    pub fn melee_percent(self) -> u32 {
        match self {
            ItemKind::Club => 130,
            ItemKind::Spear => 160,
            ItemKind::Bow => 80,
            _ => 100,
        }
    }

    /// Effet sur l'humeur du dernier repas : repas cuisiné bon, légumes crus
    /// et viande crue mauvais.
    pub fn meal_quality(self) -> i8 {
        match self {
            ItemKind::Meal => 1,
            ItemKind::Vegetables | ItemKind::Meat => -1,
            _ => 0,
        }
    }

    /// Unités mangées au maximum en un repas.
    pub fn max_per_meal(self) -> u32 {
        match self {
            ItemKind::Meal => 1,
            _ => 5,
        }
    }

    /// Ce qu'une unité vaut dans la richesse de la colonie
    /// (`Sim::wealth`) : c'est cette somme qui décide de la taille des raids.
    /// Un cadavre humain ne vaut rien — la colonie n'en tire ni butin ni
    /// prestige, et il serait absurde qu'un charnier attire les pillards.
    pub fn wealth_value(self) -> u32 {
        match self {
            ItemKind::Wood | ItemKind::Stone => 1,
            ItemKind::Berries | ItemKind::Vegetables => 2,
            ItemKind::Meat => 3,
            ItemKind::Leather => 4,
            ItemKind::DeerCorpse | ItemKind::RabbitCorpse | ItemKind::BoarCorpse => 5,
            ItemKind::Meal => 6,
            ItemKind::Club => 30,
            ItemKind::Spear => 45,
            ItemKind::Bow => 60,
            ItemKind::Tunic => 25,
            ItemKind::Coat => 50,
            ItemKind::Corpse => 0,
        }
    }

    /// Durée de conservation en ticks. `None` : ne se gâte pas.
    pub fn shelf_life(self) -> Option<u32> {
        match self {
            ItemKind::Berries => Some(TICKS_PER_DAY * 3),
            ItemKind::Vegetables => Some(TICKS_PER_DAY * 4),
            ItemKind::Meal => Some(TICKS_PER_DAY * 2),
            ItemKind::Corpse => Some(TICKS_PER_DAY * 3),
            // Une dépouille se dépèce vite ou se perd ; la viande crue suit
            // le repas cuisiné. Le cuir, lui, ne se gâte pas.
            ItemKind::DeerCorpse
            | ItemKind::RabbitCorpse
            | ItemKind::BoarCorpse
            | ItemKind::Meat => Some(TICKS_PER_DAY * 2),
            ItemKind::Wood
            | ItemKind::Stone
            | ItemKind::Club
            | ItemKind::Spear
            | ItemKind::Bow
            | ItemKind::Leather
            // Un vêtement s'use, un jour, à l'usage : pas au fond d'un
            // entrepôt. Rien ne se gâte ici.
            | ItemKind::Tunic
            | ItemKind::Coat => None,
        }
    }
}

/// Taille maximale d'une pile.
pub const STACK_MAX: u32 = 75;

/// Une pile d'objets posée au sol. Une pile portée par un colon n'est plus
/// dans la liste : elle vit dans `Pawn::carrying`.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ItemStack {
    pub id: u32,
    pub kind: ItemKind,
    pub count: u32,
    pub x: u32,
    pub y: u32,
    /// Colon qui a réservé cette pile (transport, repas, cuisine, livraison).
    pub reserved_by: Option<u32>,
    /// Tick à partir duquel la pile est perdue. `u64::MAX` si elle ne se gâte pas.
    pub spoil_at: u64,
}
