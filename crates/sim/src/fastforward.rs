//! Avance rapide abstraite d'une carte gelée.
//!
//! Quand plus personne n'est présent sur une case du globe, sa carte n'est
//! plus simulée : le serveur garde le dernier snapshot, mais l'horloge du
//! monde, elle, continue de tourner (`docs/protocol.md` §11.6 et §12.1). À la
//! réouverture, la colonie doit rattraper ce temps gelé.
//!
//! Le rejeu tick par tick est exclu : deux mois d'absence font 864 000 ticks,
//! et surtout personne n'était là pour décider ce que les colons auraient
//! fait. Le parti pris est celui de RimWorld pour ses cartes déchargées :
//! **rien n'est simulé, l'état est recalculé par des formules**. Le coût est
//! en O(entités), jamais en O(ticks).
//!
//! Ce qui avance : la croissance des plants, la repousse des buissons, la
//! péremption des vivres, la cicatrisation, l'horloge du storyteller et la
//! météo. Ce qui est supposé plutôt que simulé : la colonie s'est débrouillée
//! hors écran, donc la faim et le repos remontent à un niveau raisonnable
//! (`FROZEN_HUNGER`, `FROZEN_REST`) au lieu de tomber à zéro. Ce qui
//! n'arrive pas : rien n'est semé ni récolté, aucun chantier n'avance, aucun
//! raid ne se déclenche « en rafale » au retour (les échéances du storyteller
//! sont décalées d'autant).
//!
//! L'avance rapide reste une `Command` comme les autres : c'est l'hôte qui
//! l'émet en lockstep juste après la réouverture, et tous les clients de la
//! salle l'appliquent au même tick.

use crate::combat::HEAL_INTERVAL;
use crate::farm;
use crate::health::{BLOOD_MAX, UP_BLOOD, UP_CONSCIOUSNESS};
use crate::map::Feature;
use crate::pawn::{Faction, Job};
use crate::research;
use crate::{EventKind, Sim, TICKS_PER_DAY, Tech};

/// Avance rapide maximale, en ticks : 60 jours de jeu. Une demande plus
/// grande est **tronquée** plutôt que refusée — une colonie oubliée un an ne
/// doit ni faire boucler le sim, ni faire déborder un compteur.
pub const MAX_FAST_FORWARD: u32 = TICKS_PER_DAY * 60;

/// Faim d'un colon au retour, au minimum : la colonie a mangé sans nous.
/// Même valeur que pour un voyageur qui arrive (`Sim::spawn_wanderer`).
pub const FROZEN_HUNGER: u32 = 600_000;

/// Repos d'un colon au retour, au minimum : elle a dormi aussi.
pub const FROZEN_REST: u32 = 700_000;

impl Sim {
    /// Avance l'état de `ticks` ticks sans simuler, en O(entités).
    /// Au-delà de `MAX_FAST_FORWARD`, l'avance est tronquée ; à 0, rien ne
    /// bouge (pas même un événement).
    pub fn fast_forward(&mut self, ticks: u32) {
        let ticks = ticks.min(MAX_FAST_FORWARD);
        if ticks == 0 {
            return;
        }
        let elapsed = u64::from(ticks);
        // Le nouveau tick d'abord : tout ce qui suit date de là (péremption
        // des piles reposées, événements émis, échéances comparées).
        self.tick += elapsed;
        // La vague de froid d'il y a deux mois est finie depuis longtemps.
        self.temperature_offset = 0;
        self.offset_until = 0;
        self.grow_plants(ticks);
        // Les buissons récoltés avant le gel ont repoussé pendant l'absence.
        let outdoor = self.outdoor_temperature();
        self.tick_regrowth(outdoor);
        // La fraîcheur des vivres déjà posés avale tout l'écart d'un coup, à
        // la température **actuelle** de leur case (on ne connaît pas la
        // météo passée) : avant que les colons ne rentrent et ne lâchent
        // leurs charges, qui doivent, elles, repartir fraîches
        // (`Sim::spawn_item` les pose à `FRESHNESS_MAX`).
        self.spoil_items(ticks);
        self.raiders_leave();
        self.recover_pawns(ticks);
        // Le storyteller a dormi lui aussi : ses échéances glissent d'autant,
        // sinon le retour déclencherait une rafale de raids en attente.
        self.next_raid_at = self.next_raid_at.saturating_add(elapsed);
        self.next_wanderer_at = self.next_wanderer_at.saturating_add(elapsed);
        self.next_herd_at = self.next_herd_at.saturating_add(elapsed);
        self.next_supply_at = self.next_supply_at.saturating_add(elapsed);
        self.next_illness_at = self.next_illness_at.saturating_add(elapsed);
        self.next_extreme_at = self.next_extreme_at.saturating_add(elapsed);
        // Le marchand suivant et la rancune de la colonie glissent avec le
        // reste : deux mois d'absence n'effacent pas une réputation, ils ne la
        // font pas non plus expirer pendant que personne ne regarde.
        self.next_trader_at = self.next_trader_at.saturating_add(elapsed);
        if self.trader_grudge_until > 0 {
            self.trader_grudge_until = self.trader_grudge_until.saturating_add(elapsed);
        }
        // La météo d'il y a deux mois ne veut plus rien dire : on retire.
        self.weather_until = self.tick;
        self.tick_weather();
        // Le calendrier avance tout seul : `day_of_year` et la saison sont des
        // fonctions du tick (et du décalage imposé par `Command::SetCalendar`,
        // inchangé ici), et le tick vient de bondir. Restent à remettre à jour
        // les valeurs recopiées dans les pawns.
        self.refresh_comfort();
        self.push_event(EventKind::FastForwarded, ticks / TICKS_PER_DAY);
    }

    /// Les plants poussent du temps écoulé et mûrissent. Le bonus de pluie
    /// n'est pas rejoué : personne ne sait quel temps il a fait sur une carte
    /// que personne ne simulait. **Le froid non plus** : les hivers traversés
    /// ne ralentissent pas la pousse et surtout ne tuent aucun plant
    /// rétroactivement — il faudrait pour cela rejouer une météo qui n'a jamais
    /// existé. Une colonie oubliée retrouve son champ intact.
    fn grow_plants(&mut self, ticks: u32) {
        // Le quart de pousse de `Tech::Agriculture`, compté d'un coup.
        let ticks = research::crop_growth_ticks(ticks, self.research.is_done(Tech::Agriculture));
        for k in 0..self.crops.len() {
            if self.crops[k].growth >= farm::GROW_TICKS {
                continue;
            }
            self.crops[k].growth = self.crops[k]
                .growth
                .saturating_add(ticks)
                .min(farm::GROW_TICKS);
            if self.crops[k].growth == farm::GROW_TICKS {
                let (x, y) = (self.crops[k].x, self.crops[k].y);
                if self.map.feature(x, y) == Feature::Crop {
                    self.map.set_feature(x, y, Feature::CropRipe);
                }
            }
        }
    }

    /// Les pillards présents quittent la carte : ils n'ont pas attendu deux
    /// mois devant la porte. Ils partent **sans cadavre** (`gone`), donc
    /// `remove_dead` émet un `RaiderLeft` par pillard, comme une fuite.
    ///
    /// Les bêtes s'en vont pour la même raison : un troupeau ne broute pas la
    /// même clairière pendant deux mois. Elles partent en silence — pas de
    /// dépouille, pas d'événement — et de nouveaux troupeaux entreront quand
    /// l'échéance décalée arrivera.
    ///
    /// Le marchand aussi : il n'a pas attendu deux mois derrière son étal. Il
    /// repart avec sa réserve, donc sans rien laisser au sol et sans
    /// `TraderDied` — il n'est pas mort, il est parti.
    fn raiders_leave(&mut self) {
        let mut leaving = false;
        for p in &mut self.pawns {
            if matches!(
                p.faction,
                Faction::Raider | Faction::Animal | Faction::Trader
            ) {
                p.gone = true;
                leaving = true;
            }
        }
        if leaving {
            self.remove_dead();
        }
    }

    /// Remet les colons d'aplomb : jobs abandonnés, plaies refermées et
    /// cicatrisées, sang refait, besoins ramenés à un niveau raisonnable,
    /// minuteries décomptées. Appelée après `raiders_leave` : il ne reste que
    /// des colons.
    fn recover_pawns(&mut self, ticks: u32) {
        // Une blessure gagne un point de cicatrisation par `HEAL_INTERVAL`,
        // deux si elle est pansée : exactement le rythme de `tick_injuries`,
        // en une seule opération.
        let healed = ticks / HEAL_INTERVAL as u32;
        // Même règle que `Sim::tick_injuries` : la médecine accélère la
        // cicatrisation des plaies pansées.
        let tended_points = research::tended_heal_points(self.research.is_done(Tech::Medicine));
        let now = self.tick;
        for i in 0..self.pawns.len() {
            let was_downed = self.pawns[i].is_downed();
            // Personne n'était là pour donner des ordres : réservations,
            // chargements et blessés portés sont rendus.
            self.abandon_job(i);
            let p = &mut self.pawns[i];
            for inj in &mut p.injuries {
                // Deux mois plus tard, plus rien ne coule.
                inj.close();
                let points = if inj.tended {
                    healed.saturating_mul(tended_points)
                } else {
                    healed
                };
                inj.severity = inj.severity.saturating_sub(points);
            }
            p.injuries.retain(|inj| inj.severity > 0);
            if !p.is_bleeding() {
                p.blood = BLOOD_MAX;
            }
            p.hunger = p.hunger.max(FROZEN_HUNGER);
            p.rest = p.rest.max(FROZEN_REST);
            p.grief_ticks = p.grief_ticks.saturating_sub(ticks);
            p.relief_ticks = p.relief_ticks.saturating_sub(ticks);
            p.attack_cooldown = 0;
            p.idle_ticks = 0;
            p.outdoor_storm = false;
            // Les maladies dont l'échéance est passée sont guéries ; celle qui
            // vient d'être déclarée (avance rapide plus courte qu'elle) suit
            // son cours, avec sa recopie remise d'aplomb.
            if p.sick_until <= now {
                p.sick_until = 0;
                p.illness_tended = false;
            }
            p.sick = p.sick_until > now;
            // `hp` est dérivé des blessures et du sang.
            p.recompute_hp();
            // `abandon_job` a remis tout le monde debout : un colon à terre ne
            // se relève que si les seuils le permettent (même hystérésis que
            // `update_downed`).
            if was_downed && (p.consciousness_percent() < UP_CONSCIOUSNESS || p.blood < UP_BLOOD) {
                p.job = Job::Downed;
            }
        }
    }
}
