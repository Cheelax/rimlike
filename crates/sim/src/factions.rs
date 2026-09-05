//! Factions PNJ et réputation.
//!
//! Jusqu'ici les pillards n'étaient personne : une bande sortait d'un bord,
//! mourait ou repartait, et la suivante n'en savait rien. Les marchands, eux,
//! traînaient une rancune anonyme (`trade::TRADER_GRUDGE_TICKS`). Ici, chaque
//! bande a un **nom**, et ce que la colonie fait se retient.
//!
//! Trois factions fixes, jamais créées ni détruites — elles sont le décor du
//! monde, pas des entités du sim :
//!
//! | id | nom | genre |
//! |---|---|---|
//! | 0 | Clan des Cendres | pillards |
//! | 1 | Fraternité du Fer | pillards |
//! | 2 | Guilde des Colporteurs | marchands |
//!
//! Une seule quantité par faction, la **réputation** (`Sim::goodwill`), bornée
//! à `GOODWILL_MIN..=GOODWILL_MAX` et rangée dans l'ordre des ids. Elle décide
//! de trois choses :
//!
//! 1. **qui attaque** : le storyteller tire la tribu qui mène un raid avec un
//!    poids `100 − réputation` (voir `Sim::draw_raid_faction`), et une tribu
//!    alliée (`Relation::Ally`) n'attaque plus du tout ;
//! 2. **à quel prix** : la Guilde vend moins cher à une colonie alliée
//!    (`trade::ALLY_SELL_NUM`) et n'envoie plus personne tant qu'elle est
//!    hostile (`Relation::Hostile`) ;
//! 3. **ce que ça coûte** : chaque geste a son tarif, rassemblé plus bas en
//!    constantes — un raid mené, un raid repoussé, un troc, un marchand
//!    frappé ou tué, un tribut (`Command::Gift`).
//!
//! Deux forces la font bouger sans le joueur : le temps, qui adoucit d'un
//! point par jour toute rancune (`FADE_PER_DAY`), et les représailles — une
//! tribu qui **franchit** `HOSTILE_GOODWILL` vers le bas avance le prochain
//! raid (`Sim::plan_reprisal`), en passant par le storyteller, donc en
//! respectant la difficulté.
//!
//! Le franchissement de seuil est annoncé (`EventKind::RelationChanged`) dans
//! un sens comme dans l'autre : c'est le seul moment où la relation change de
//! nature, et le seul que le client a besoin de raconter.

use serde::{Deserialize, Serialize};

use crate::items::ItemKind;
use crate::trade::item_value;
use crate::{EventKind, Sim};

// ----------------------------------------------------------------------
// Identité des factions
// ----------------------------------------------------------------------

/// Ce qu'une faction fait de la colonie. Les valeurs sont un contrat avec le
/// client (`WasmSim::faction_kind`).
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum FactionKind {
    /// Elle mène des raids (voir `storyteller`).
    Raiders = 0,
    /// Elle envoie des marchands (voir `trade`).
    Guild = 1,
}

/// Une faction PNJ : un id stable et un genre. Rien d'autre — pas de position,
/// pas d'inventaire, pas de tick. Ce qui vit sur la carte, ce sont les pawns
/// qu'elle envoie.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct NpcFaction {
    pub id: u8,
    pub kind: FactionKind,
}

/// Nombre de factions PNJ. Fixe : `Sim::goodwill` est un tableau de cette
/// taille, et les ids sont ses indices.
pub const FACTION_COUNT: usize = 3;

/// Les trois factions, dans l'ordre de leurs ids.
pub const FACTIONS: [NpcFaction; FACTION_COUNT] = [
    NpcFaction {
        id: 0,
        kind: FactionKind::Raiders,
    },
    NpcFaction {
        id: 1,
        kind: FactionKind::Raiders,
    },
    NpcFaction {
        id: 2,
        kind: FactionKind::Guild,
    },
];

/// Noms affichés, dans l'ordre des ids. Le client les lit par
/// `WasmSim::faction_name` : aucune chaîne n'est dupliquée côté TypeScript.
pub const FACTION_NAMES: [&str; FACTION_COUNT] = [
    "Clan des Cendres",
    "Fraternité du Fer",
    "Guilde des Colporteurs",
];

/// Id de la Guilde des Colporteurs : c'est elle qui envoie les marchands.
pub const GUILD: u8 = 2;

/// Réputation de départ : les deux tribus se méfient, la Guilde a entendu
/// parler de vous en bien.
pub const START_GOODWILL: [i32; FACTION_COUNT] = [-20, -20, 10];

/// Une faction existe-t-elle sous cet id ?
pub fn get(id: u8) -> Option<NpcFaction> {
    FACTIONS.get(id as usize).copied()
}

/// Nom d'une faction, chaîne vide si l'id n'en désigne aucune.
pub fn name(id: u8) -> &'static str {
    FACTION_NAMES.get(id as usize).copied().unwrap_or("")
}

/// Genre d'une faction, `None` si l'id n'en désigne aucune.
pub fn kind(id: u8) -> Option<FactionKind> {
    get(id).map(|f| f.kind)
}

/// Cette faction mène-t-elle des raids ? Faux pour la Guilde et pour un id
/// inconnu.
pub fn is_tribe(id: u8) -> bool {
    kind(id) == Some(FactionKind::Raiders)
}

// ----------------------------------------------------------------------
// Bornes et seuils de réputation
// ----------------------------------------------------------------------

pub const GOODWILL_MIN: i32 = -100;
pub const GOODWILL_MAX: i32 = 100;

/// À partir de là, la faction est alliée : une tribu n'attaque plus, la Guilde
/// baisse ses prix.
pub const ALLY_GOODWILL: i32 = 50;
/// **Sous** ce seuil, la faction est hostile : la Guilde n'envoie plus
/// personne, et une tribu qui vient de basculer prépare des représailles.
pub const HOSTILE_GOODWILL: i32 = -50;

/// Nature de la relation. Trois paliers, tranchés par les deux seuils
/// ci-dessus : c'est ce qui change quand `EventKind::RelationChanged` tombe.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
#[repr(u8)]
pub enum Relation {
    Hostile = 0,
    Wary = 1,
    Ally = 2,
}

impl Relation {
    pub fn of(goodwill: i32) -> Relation {
        if goodwill < HOSTILE_GOODWILL {
            Relation::Hostile
        } else if goodwill >= ALLY_GOODWILL {
            Relation::Ally
        } else {
            Relation::Wary
        }
    }
}

// ----------------------------------------------------------------------
// Ce que chaque geste coûte ou rapporte
// ----------------------------------------------------------------------

/// Une bande vient d'entrer : la tribu qui la mène perd ce qu'il faut pour
/// qu'attaquer se paie en réputation.
pub const RAID_LED: i32 = -10;
/// Raid repoussé : la Guilde vous voit comme une place forte…
pub const RAID_REPELLED_GUILD: i32 = 5;
/// … et l'autre tribu, comme l'ennemie de son ennemie.
pub const RAID_REPELLED_OTHER: i32 = 3;

/// Un troc conclu avec un marchand de la Guilde.
pub const TRADE_DONE: i32 = 2;
/// Un colon a levé la main sur un marchand.
pub const TRADER_ANGERED: i32 = -30;
/// Le marchand est mort sur la carte. S'ajoute à `TRADER_ANGERED` quand c'est
/// un colon qui a commencé, et à la rancune de `trade` qui espace les visites.
pub const TRADER_KILLED: i32 = -40;

/// Ce que le temps rend chaque jour à une faction qui vous en veut (réputation
/// négative seulement : le temps n'a jamais fait d'ami).
pub const FADE_PER_DAY: i32 = 1;

/// Valeur de tribut qu'il faut offrir pour un point de réputation
/// (`Command::Gift`). Un manteau de cuir (50) vaut donc deux points, cinquante
/// bois un seul.
pub const GIFT_VALUE_PER_POINT: u32 = 20;

impl Sim {
    // ------------------------------------------------------------------
    // Lecture (client et tests)
    // ------------------------------------------------------------------

    /// Réputation de la colonie auprès des trois factions, dans l'ordre des
    /// ids.
    pub fn goodwill(&self) -> &[i32; FACTION_COUNT] {
        &self.goodwill
    }

    /// Réputation auprès d'une faction ; 0 pour un id inconnu — un id inventé
    /// n'a pas d'avis.
    pub fn faction_goodwill(&self, faction: u8) -> i32 {
        self.goodwill
            .get(faction as usize)
            .copied()
            .unwrap_or_default()
    }

    /// Nature de la relation avec une faction (voir `Relation`).
    pub fn relation(&self, faction: u8) -> Relation {
        Relation::of(self.faction_goodwill(faction))
    }

    /// Impose une réputation (tests et scénarios, comme `Sim::set_difficulty`) :
    /// le jeu, lui, la fait bouger par des raids, des trocs et des tributs.
    /// N'annonce rien et ne déclenche aucune représaille — c'est un réglage,
    /// pas un événement.
    pub fn set_goodwill(&mut self, faction: u8, value: i32) {
        if let Some(slot) = self.goodwill.get_mut(faction as usize) {
            *slot = value.clamp(GOODWILL_MIN, GOODWILL_MAX);
        }
    }

    /// Applique un `Command::SetGoodwill` : remplace les trois réputations
    /// d'un coup, chacune bornée comme `Sim::set_goodwill`. C'est ainsi que le
    /// serveur monde impose la réputation de départ d'une colonie neuve,
    /// comme il impose déjà son climat (`Command::SetClimate`) et son
    /// calendrier (`Command::SetCalendar`) : n'annonce rien et ne déclenche
    /// aucune représaille, quelle que soit la valeur imposée — un état de
    /// départ ne se joue pas comme un franchissement de seuil.
    pub(crate) fn set_goodwill_all(&mut self, values: [i32; FACTION_COUNT]) {
        for (faction, &value) in values.iter().enumerate() {
            self.set_goodwill(faction as u8, value);
        }
    }

    /// Tribu qui a mené le dernier raid, `None` si aucune bande n'est encore
    /// entrée.
    pub fn last_raid_faction(&self) -> Option<u8> {
        get(self.last_raid_faction).map(|f| f.id)
    }

    // ------------------------------------------------------------------
    // Écriture
    // ------------------------------------------------------------------

    /// Fait bouger une réputation, bornes comprises, et annonce le
    /// franchissement d'un seuil (`EventKind::RelationChanged`) dans un sens
    /// comme dans l'autre. Une **tribu** qui tombe du côté hostile prépare des
    /// représailles ; la Guilde, elle, se contente de ne plus venir.
    ///
    /// Un id inconnu et une variation nulle ne font rien du tout : c'est la
    /// porte par laquelle passent commandes et événements, elle ne panique
    /// jamais.
    pub(crate) fn add_goodwill(&mut self, faction: u8, delta: i32) {
        let Some(&before) = self.goodwill.get(faction as usize) else {
            return;
        };
        let after = before
            .saturating_add(delta)
            .clamp(GOODWILL_MIN, GOODWILL_MAX);
        if after == before {
            return;
        }
        self.goodwill[faction as usize] = after;
        if Relation::of(before) == Relation::of(after) {
            return;
        }
        self.push_event(EventKind::RelationChanged, u32::from(faction));
        if Relation::of(after) == Relation::Hostile && is_tribe(faction) {
            self.plan_reprisal();
        }
    }

    /// Le temps adoucit les rancunes : chaque faction en dessous de zéro
    /// regagne `FADE_PER_DAY` par jour, sans jamais dépasser zéro — une
    /// alliance se gagne, elle ne s'attend pas. Appelée une fois par jour par
    /// le storyteller, et d'un coup par `Sim::fast_forward`.
    pub(crate) fn fade_grudges(&mut self, days: u32) {
        if days == 0 {
            return;
        }
        let gain = i32::try_from(days).unwrap_or(i32::MAX);
        for k in 0..FACTION_COUNT {
            let before = self.goodwill[k];
            if before >= 0 {
                continue;
            }
            // Plafonné à zéro : `add_goodwill` borne par le bas et par le
            // haut, pas à mi-chemin.
            self.add_goodwill(k as u8, gain.min(-before));
        }
    }

    // ------------------------------------------------------------------
    // Tribut
    // ------------------------------------------------------------------

    /// Applique un `Command::Gift` : la colonie cède `count` unités de `kind`,
    /// prélevées en **stockage** comme pour un troc ou une caravane, et gagne
    /// de la réputation à proportion de ce que ça valait
    /// (`GIFT_VALUE_PER_POINT`, au moins un point si la marchandise vaut
    /// quelque chose).
    ///
    /// Refusée sans un mot — comme `Command::Trade` — si la faction est
    /// inconnue, si la quantité est nulle, si la colonie est éteinte (personne
    /// pour porter le tribut) ou si le stock ne couvre pas la demande : on
    /// n'offre pas ce qu'on n'a pas. Une marchandise sans valeur (le cadavre)
    /// part quand même, mais n'achète rien : offrir ses morts n'est pas un
    /// cadeau.
    pub(crate) fn gift(&mut self, faction: u8, kind: ItemKind, count: u32) {
        if count == 0 || get(faction).is_none() {
            return;
        }
        let Some(center) = self.colony_center() else {
            return;
        };
        if self.stored_totals()[kind as usize] < count {
            return;
        }
        let taken = self.take_from_stock(kind, count, center);
        // En `u64` : `taken` est borné par le stock, mais un produit de `u32`
        // n'a pas à dépendre de cette garantie. Le gain est plafonné bien
        // au-delà de l'amplitude de la réputation.
        let value = u64::from(item_value(kind)) * u64::from(taken);
        let gain = if value == 0 {
            0
        } else {
            (value / u64::from(GIFT_VALUE_PER_POINT)).clamp(1, 1_000) as i32
        };
        self.push_event(EventKind::Gift, u32::from(faction));
        self.add_goodwill(faction, gain);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn les_trois_factions_sont_nommees_et_rangees_par_id() {
        for (k, f) in FACTIONS.iter().enumerate() {
            assert_eq!(f.id as usize, k, "ids non alignés sur les indices");
            assert_eq!(get(f.id), Some(*f));
            assert!(!name(f.id).is_empty(), "faction {k} sans nom");
        }
        assert_eq!(kind(0), Some(FactionKind::Raiders));
        assert_eq!(kind(1), Some(FactionKind::Raiders));
        assert_eq!(kind(GUILD), Some(FactionKind::Guild));
        // Un id inventé ne désigne rien, et ne panique pas.
        assert_eq!(get(FACTION_COUNT as u8), None);
        assert_eq!(kind(200), None);
        assert_eq!(name(200), "");
        assert!(is_tribe(0) && is_tribe(1) && !is_tribe(GUILD) && !is_tribe(9));
    }

    #[test]
    fn les_paliers_de_relation_suivent_les_seuils() {
        assert_eq!(Relation::of(GOODWILL_MIN), Relation::Hostile);
        assert_eq!(Relation::of(HOSTILE_GOODWILL - 1), Relation::Hostile);
        // Le seuil lui-même est encore de la méfiance : on franchit **sous**.
        assert_eq!(Relation::of(HOSTILE_GOODWILL), Relation::Wary);
        assert_eq!(Relation::of(0), Relation::Wary);
        assert_eq!(Relation::of(ALLY_GOODWILL - 1), Relation::Wary);
        assert_eq!(Relation::of(ALLY_GOODWILL), Relation::Ally);
        assert_eq!(Relation::of(GOODWILL_MAX), Relation::Ally);
        // La réputation de départ : deux tribus méfiantes, une guilde amicale
        // mais pas encore alliée.
        for (k, &g) in START_GOODWILL.iter().enumerate() {
            assert_eq!(Relation::of(g), Relation::Wary, "faction {k}");
            assert!((GOODWILL_MIN..=GOODWILL_MAX).contains(&g));
        }
    }
}
