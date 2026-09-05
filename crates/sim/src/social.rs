//! Relations entre colons : opinions, bavardage, disputes et rixes.
//!
//! Chaque colon garde l'avis qu'il a de ses camarades (`Pawn::opinions`), au
//! plus `MAX_OPINIONS` entrées bornées à `OPINION_MIN..=OPINION_MAX`. Cet avis
//! ne bouge que par la conversation : deux colons **inactifs** et voisins
//! s'arrêtent pour bavarder (`Job::Chat`), et la conversation se termine soit
//! bien (chacun monte de `CHAT_OPINION` et garde un souvenir d'humeur), soit
//! mal (dispute : `QUARREL_OPINION`, humeur en baisse, `EventKind::Quarrel`).
//! Entre deux colons qui se détestent déjà, la dispute dégénère en rixe :
//! chacun prend une bourrade — jamais fatale, voir `Sim::brawl_hit` — et
//! `EventKind::Brawl` part au journal.
//!
//! Rien de tout cela n'est un **travail** : le bavardage n'a pas de `WorkType`,
//! il ne figure pas dans le tableau des priorités et n'est essayé qu'après
//! l'échec de toute recherche de travail, juste avant de flâner
//! (`Sim::find_job`). Un besoin social, comme manger ou dormir sont des
//! besoins du corps.
//!
//! Déterminisme : les partenaires sont triés par `(distance, id)`, le sort de
//! la conversation tient à **un seul tirage** de `Sim::rng` par fin de
//! bavardage, et les opinions vivent dans un `Vec` parcouru par indice.
//!
//! Toutes les constantes d'effet vivent ici, nommées : c'est le seul endroit à
//! modifier pour rééquilibrer la vie sociale d'une colonie.

use serde::{Deserialize, Serialize};

use crate::combat::GRIEF_TICKS;
use crate::health;
use crate::map::chebyshev;
use crate::pawn::{Faction, Job, Pawn};
use crate::traits::Trait;
use crate::{EventKind, Sim, TICKS_PER_DAY};

/// Ce qu'un colon pense d'un autre, et depuis quand ils ne se sont pas parlé.
/// Sérialisé avec le reste du pawn : c'est de l'état de jeu à part entière.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Opinion {
    /// Id du colon jugé.
    pub id: u32,
    /// Avis, dans `OPINION_MIN..=OPINION_MAX`. 0 : indifférence.
    pub value: i32,
    /// Tick de la dernière conversation avec lui ; 0 : jamais. Sert au délai
    /// entre deux bavardages (`CHAT_COOLDOWN`).
    pub last_chat: u64,
}

/// Avis suivis par colon. Au-delà, le plus faible (|avis| puis id) est oublié :
/// l'état d'un vieux colon reste borné, snapshot compris.
pub const MAX_OPINIONS: usize = 16;

/// Bornes d'un avis.
pub const OPINION_MIN: i32 = -100;
pub const OPINION_MAX: i32 = 100;

/// Distance (Chebyshev) à laquelle deux colons peuvent s'adresser la parole.
pub const CHAT_RADIUS: u32 = 2;

/// Durée d'un bavardage. Une seconde et demie de jeu : assez pour se voir
/// s'arrêter, assez peu pour ne pas grever une journée de travail.
pub const CHAT_TICKS: u32 = 90;

/// Délai avant de reparler à la **même** personne. Un `Trait::Sociable` le
/// divise par deux (voir `Sim::try_start_chat`).
pub const CHAT_COOLDOWN: u32 = 1_200;

/// Ce qu'une conversation qui se passe bien fait gagner à chacun.
pub const CHAT_OPINION: i32 = 4;
/// Ce qu'une dispute coûte à chacun.
pub const QUARREL_OPINION: i32 = -10;

/// Chance qu'une conversation tourne à la dispute : un tirage `1 / DEN` par
/// fin de bavardage. Avec `CHAT_COOLDOWN`, une paire de colons oisifs bavarde
/// une douzaine de fois par jour : à 1/8, une dispute éclate presque à coup sûr
/// dans la journée sans que la colonie se déchire (mesuré : voir
/// `tests/social.rs`, `quarrels_happen_and_hurt_opinion`).
pub const QUARREL_CHANCE_DEN: u32 = 8;
/// Même chose quand l'un des deux est un bagarreur : deux fois plus souvent.
pub const BRAWLER_QUARREL_CHANCE_DEN: u32 = 4;

/// En dessous de cet avis **réciproque**, une dispute dégénère en rixe.
pub const BRAWL_OPINION: i32 = -60;
/// Sévérité d'une bourrade de rixe.
pub const BRAWL_SEVERITY: u32 = 25;
/// Points de vie que la rixe laisse toujours à ses participants : sous ce
/// plancher, on se pousse sans faire mal. C'est ce qui rend une rixe **jamais
/// mortelle**, quel que soit l'état des deux protagonistes.
pub const BRAWL_MIN_HP: u32 = 200;

/// Durée du souvenir laissé par une conversation, et par une dispute.
pub const SOCIAL_TICKS: u32 = TICKS_PER_DAY;
pub const QUARREL_TICKS: u32 = TICKS_PER_DAY;

/// Humeur gagnée tant que le souvenir d'une conversation est frais.
pub const CHAT_MOOD_BONUS: i64 = 8_000;
/// Humeur perdue tant que celui d'une dispute l'est.
pub const QUARREL_MOOD_MALUS: i64 = 10_000;

/// À partir de cet avis, l'autre est un ami ; en dessous de `RIVAL_OPINION`,
/// c'est un rival.
pub const FRIEND_OPINION: i32 = 50;
pub const RIVAL_OPINION: i32 = -50;
/// Amis (ou rivaux) comptés dans l'humeur : au-delà, ça n'y change plus rien.
pub const MOOD_SOCIAL_CAP: u32 = 2;
/// Humeur apportée par chaque ami, et retirée par chaque rival.
pub const FRIEND_MOOD_BONUS: i64 = 10_000;
pub const RIVAL_MOOD_MALUS: i64 = 10_000;

/// Deuil maximal : perdre un ami double le deuil ordinaire, jamais plus.
pub const MAX_GRIEF_TICKS: u32 = GRIEF_TICKS * 2;

impl Pawn {
    /// Ce que ce colon pense d'un autre ; 0 s'il ne le connaît pas (ou plus).
    pub fn opinion_of(&self, other: u32) -> i32 {
        self.opinions
            .iter()
            .find(|o| o.id == other)
            .map_or(0, |o| o.value)
    }

    /// Tick de la dernière conversation avec `other` ; 0 s'ils ne se sont
    /// jamais parlé.
    pub fn last_chat_with(&self, other: u32) -> u64 {
        self.opinions
            .iter()
            .find(|o| o.id == other)
            .map_or(0, |o| o.last_chat)
    }

    /// Fait bouger l'avis sur `other` de `delta` (borné) et note le tick de la
    /// conversation. Crée l'entrée si besoin ; au-delà de `MAX_OPINIONS`, la
    /// plus faible s'efface — `(|avis|, id)` départage, donc jamais l'ordre
    /// d'insertion.
    pub(crate) fn remember(&mut self, other: u32, delta: i32, tick: u64) {
        match self.opinions.iter_mut().find(|o| o.id == other) {
            Some(o) => {
                o.value = (o.value + delta).clamp(OPINION_MIN, OPINION_MAX);
                o.last_chat = tick;
            }
            None => self.opinions.push(Opinion {
                id: other,
                value: delta.clamp(OPINION_MIN, OPINION_MAX),
                last_chat: tick,
            }),
        }
        self.trim_opinions();
    }

    /// Oublie la connaissance la plus faible tant qu'il y en a plus de
    /// `MAX_OPINIONS` : `(|avis|, id)` départage, donc jamais l'ordre
    /// d'insertion ni celui d'une rencontre.
    fn trim_opinions(&mut self) {
        while self.opinions.len() > MAX_OPINIONS {
            let mut weakest = 0;
            for k in 1..self.opinions.len() {
                let (a, b) = (&self.opinions[k], &self.opinions[weakest]);
                if (a.value.unsigned_abs(), a.id) < (b.value.unsigned_abs(), b.id) {
                    weakest = k;
                }
            }
            self.opinions.remove(weakest);
        }
    }

    /// Ce que la vie sociale ajoute à l'humeur : le souvenir frais d'une
    /// conversation ou d'une dispute, puis les amis et les rivaux, plafonnés
    /// des deux côtés (`MOOD_SOCIAL_CAP`). Appelée par `Pawn::mood`, qui ne
    /// voit que le pawn : tout est ici, dans le pawn.
    pub fn social_mood(&self) -> i64 {
        let mut m = 0;
        if self.social_ticks > 0 {
            m += CHAT_MOOD_BONUS;
        }
        if self.quarrel_ticks > 0 {
            m -= QUARREL_MOOD_MALUS;
        }
        // Cas courant : personne à aimer ni à détester, on s'arrête là.
        if self.opinions.is_empty() {
            return m;
        }
        let (mut friends, mut rivals) = (0u32, 0u32);
        for o in &self.opinions {
            if o.value >= FRIEND_OPINION {
                friends += 1;
            } else if o.value <= RIVAL_OPINION {
                rivals += 1;
            }
        }
        m + i64::from(friends.min(MOOD_SOCIAL_CAP)) * FRIEND_MOOD_BONUS
            - i64::from(rivals.min(MOOD_SOCIAL_CAP)) * RIVAL_MOOD_MALUS
    }
}

impl Sim {
    /// Engage un bavardage si un camarade est à portée de voix. Appelée par
    /// `Sim::find_job` **après** toutes les recherches de travail : seul un
    /// colon qui n'a rien à faire discute.
    ///
    /// Le partenaire doit être un colon vivant, à `CHAT_RADIUS` cases au plus,
    /// lui-même inactif (ou déjà en train de nous parler), et ne pas nous avoir
    /// parlé depuis `CHAT_COOLDOWN` ticks. À égalité de distance, le plus petit
    /// id l'emporte : aucun ordre de rencontre ne décide à notre place. La
    /// recherche ne parcourt que les pawns, jamais la carte.
    ///
    /// Le délai est celui **de celui qui engage** : c'est son trait qui joue, et
    /// c'est sa mémoire qui compte. Un avis évincé (voir `MAX_OPINIONS`) fait
    /// donc repartir le délai à zéro — on a oublié qu'on s'était parlé.
    pub(crate) fn try_start_chat(&mut self, i: usize) -> bool {
        let me = self.pawns[i].id;
        let from = self.pawns[i].tile();
        // Un sociable renoue plus vite : c'est le seul trait qui joue ici.
        let cooldown = u64::from(if self.pawns[i].has_trait(Trait::Sociable) {
            CHAT_COOLDOWN / 2
        } else {
            CHAT_COOLDOWN
        });
        let mut best: Option<(u32, u32, usize)> = None;
        for k in 0..self.pawns.len() {
            let p = &self.pawns[k];
            if k == i || p.faction != Faction::Colony || !p.is_alive() {
                continue;
            }
            let free = match p.job {
                Job::Idle => true,
                Job::Chat { with, .. } => with == me,
                _ => false,
            };
            if !free {
                continue;
            }
            let distance = chebyshev(from, p.tile());
            if distance > CHAT_RADIUS {
                continue;
            }
            let last = self.pawns[i].last_chat_with(p.id);
            if last != 0 && self.tick < last + cooldown {
                continue;
            }
            let candidate = (distance, p.id, k);
            if best.is_none_or(|b| candidate < b) {
                best = Some(candidate);
            }
        }
        let Some((_, partner, k)) = best else {
            return false;
        };
        // Les deux s'arrêtent et se font face : plus un pas jusqu'au bout de
        // la conversation.
        self.pawns[i].path.clear();
        self.pawns[i].job = Job::Chat {
            with: partner,
            ticks: CHAT_TICKS,
        };
        self.pawns[k].path.clear();
        self.pawns[k].job = Job::Chat {
            with: me,
            ticks: CHAT_TICKS,
        };
        true
    }

    /// Un tick de conversation. Les deux comptent à rebours chacun de leur
    /// côté ; celui qui atteint zéro le premier (toujours le plus petit indice,
    /// donc le plus petit id) clôt la conversation pour les deux — d'où un seul
    /// tirage de dispute par bavardage.
    ///
    /// Si le partenaire a été emporté entre-temps (faim, alerte, sauvetage,
    /// mort), la conversation tombe à plat : personne ne gagne ni ne perd rien.
    pub(crate) fn do_chat(&mut self, i: usize, with: u32, ticks: u32) {
        let me = self.pawns[i].id;
        let Some(k) = self.pawns.iter().position(|p| p.id == with && p.is_alive()) else {
            self.pawns[i].job = Job::Idle;
            return;
        };
        let still_talking = matches!(self.pawns[k].job, Job::Chat { with: w, .. } if w == me);
        if !still_talking || chebyshev(self.pawns[i].tile(), self.pawns[k].tile()) > CHAT_RADIUS {
            self.pawns[i].job = Job::Idle;
            return;
        }
        if ticks > 0 {
            self.pawns[i].job = Job::Chat {
                with,
                ticks: ticks - 1,
            };
            return;
        }
        self.end_chat(i, k);
    }

    /// Solde une conversation : un tirage — toujours, quel que soit le
    /// résultat, pour que le flux d'aléa ne dépende pas de l'issue — puis les
    /// avis, les souvenirs d'humeur et, le cas échéant, la dispute et la rixe.
    fn end_chat(&mut self, i: usize, k: usize) {
        let (a, b) = (self.pawns[i].id, self.pawns[k].id);
        let tick = self.tick;
        let brawler =
            self.pawns[i].has_trait(Trait::Brawler) || self.pawns[k].has_trait(Trait::Brawler);
        let den = if brawler {
            BRAWLER_QUARREL_CHANCE_DEN
        } else {
            QUARREL_CHANCE_DEN
        };
        let quarrel = self.rng.chance(1, den);
        self.pawns[i].job = Job::Idle;
        self.pawns[k].job = Job::Idle;
        if !quarrel {
            self.pawns[i].remember(b, CHAT_OPINION, tick);
            self.pawns[k].remember(a, CHAT_OPINION, tick);
            self.pawns[i].social_ticks = SOCIAL_TICKS;
            self.pawns[k].social_ticks = SOCIAL_TICKS;
            return;
        }
        // « Déjà » : l'inimitié qui déclenche la rixe est celle d'avant la
        // dispute, pas celle que la dispute vient de créer.
        let rivals = self.pawns[i].opinion_of(b) <= BRAWL_OPINION
            && self.pawns[k].opinion_of(a) <= BRAWL_OPINION;
        self.pawns[i].remember(b, QUARREL_OPINION, tick);
        self.pawns[k].remember(a, QUARREL_OPINION, tick);
        self.pawns[i].quarrel_ticks = QUARREL_TICKS;
        self.pawns[k].quarrel_ticks = QUARREL_TICKS;
        self.push_event(EventKind::Quarrel, a.min(b));
        if !rivals {
            return;
        }
        // Les coups partent des deux côtés, dans l'ordre des indices. Personne
        // ne se met à poursuivre l'autre : pas de `Job::Attack`, la vie reprend.
        self.brawl_hit(i);
        self.brawl_hit(k);
        self.push_event(EventKind::Brawl, a.min(b));
    }

    /// Une bourrade de rixe : la partie touchée se tire comme au combat, mais
    /// la sévérité est rabotée pour laisser `BRAWL_MIN_HP` points de vie. Une
    /// rixe ne tue donc jamais, même entre deux blessés — et sous le plancher,
    /// le coup ne fait plus rien du tout (`Pawn::add_injury` ignore 0).
    fn brawl_hit(&mut self, k: usize) {
        let severity = BRAWL_SEVERITY.min(self.pawns[k].hp.saturating_sub(BRAWL_MIN_HP));
        let part = health::part_for_roll(self.rng.below(health::HIT_WEIGHT_TOTAL));
        self.pawns[k].add_injury(part, severity, severity / health::BLEED_FRACTION);
    }

    /// Efface l'avis que les colons avaient de ce pawn. Appelée quand il quitte
    /// la carte pour de bon (mort, caravane) : un absent ne doit plus porter ni
    /// peser sur l'humeur de personne, et son entrée ne doit plus occuper une
    /// des seize places.
    pub(crate) fn forget_opinions_of(&mut self, id: u32) {
        for p in &mut self.pawns {
            if !p.opinions.is_empty() {
                p.opinions.retain(|o| o.id != id);
            }
        }
    }

    /// Impose l'avis d'un colon sur un autre, **pour les tests et les
    /// scénarios** (comme `Sim::map_mut`) : c'est ainsi qu'on part d'une amitié
    /// ancienne ou d'une rancune tenace sans jouer les mille ticks qui les
    /// auraient bâties. Le jeu, lui, ne fait bouger un avis que par la
    /// conversation. La valeur est bornée comme partout ; un id inconnu est
    /// ignoré.
    pub fn set_opinion_for_tests(&mut self, pawn: u32, other: u32, value: i32) {
        let Some(p) = self.pawns.iter_mut().find(|p| p.id == pawn) else {
            return;
        };
        let value = value.clamp(OPINION_MIN, OPINION_MAX);
        match p.opinions.iter_mut().find(|o| o.id == other) {
            Some(o) => o.value = value,
            None => p.opinions.push(Opinion {
                id: other,
                value,
                // Jamais parlé : le premier bavardage peut partir tout de suite.
                last_chat: 0,
            }),
        }
        // Même plafond que dans le jeu : un test ne fabrique pas un colon qui
        // se souviendrait de plus de monde que les règles ne le permettent.
        p.trim_opinions();
    }
}
