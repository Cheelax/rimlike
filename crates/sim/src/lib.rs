//! Simulation déterministe.
//!
//! Règles non négociables (docs/PLAN.md §2.1) :
//! - aucun flottant : `clippy::float_arithmetic` est en `deny` ;
//! - aucune structure à ordre aléatoire (`HashMap`, `HashSet`) : voir `clippy.toml` ;
//! - aucune horloge, aucune entropie : tout vient du seed et des commandes ;
//! - le crate ne connaît ni le rendu ni le réseau.
//!
//! Le même code compile en natif (tests, serveur) et en WASM (navigateur).

#![forbid(unsafe_code)]
#![deny(clippy::float_arithmetic)]
#![deny(clippy::disallowed_types)]
#![deny(clippy::disallowed_methods)]

pub mod animals;
pub mod build;
pub mod caravan;
pub mod climate;
pub mod combat;
pub mod craft;
pub mod factions;
pub mod farm;
pub mod fastforward;
pub mod fire;
pub mod fixed;
pub mod hash;
pub mod health;
pub mod items;
pub mod jobs;
pub mod livestock;
pub mod map;
pub mod names;
pub mod noise;
pub mod path;
pub mod pawn;
pub mod research;
pub mod rng;
pub mod social;
pub mod storyteller;
pub mod testmap;
pub mod trade;
pub mod traits;
pub mod weather;
pub mod work;

use serde::{Deserialize, Serialize};

pub use animals::{MAX_ANIMALS, Species};
pub use build::{Blueprint, BuildKind, Material};
pub use caravan::{CaravanManifest, MANIFEST_VERSION};
pub use climate::{Climate, Season, YEAR_DAYS};
pub use craft::{CraftStage, RECIPES, Recipe};
pub use factions::{FACTION_COUNT, FactionKind, NpcFaction, Relation};
pub use farm::Crop;
pub use fastforward::MAX_FAST_FORWARD;
pub use fire::Fire;
pub use health::{BodyPart, Injury};
pub use items::{ItemKind, ItemStack};
pub use jobs::{Regrow, Reservation};
pub use livestock::{MAX_LIVESTOCK, TAME_TICKS};
pub use map::{Designation, Feature, Map, ROOM_MAX_TILES, Rect, Terrain, Zone};
pub use pawn::{Faction, Job, Pawn};
pub use research::{ResearchState, Tech};
pub use rng::Rng;
pub use social::Opinion;
pub use storyteller::{Difficulty, RaidKind};
pub use trade::{TRADER_STAY, item_value, value_buy, value_sell};
pub use traits::Trait;
pub use weather::Weather;
pub use work::{WORK_TYPES, WorkType};

/// Ticks de simulation par seconde de jeu.
pub const TICKS_PER_SECOND: u32 = 60;
/// Durée d'une journée de jeu. 4 minutes réelles pour l'instant.
pub const TICKS_PER_DAY: u32 = TICKS_PER_SECOND * 60 * 4;
/// La partie commence le matin, pas à minuit.
const DAY_START_OFFSET: u32 = TICKS_PER_DAY * 3 / 10;
/// Événements gardés pour le client. Au-delà, le plus ancien est oublié.
const MAX_EVENTS: usize = 32;

/// Fait notable de la partie, poussé au client pour affichage.
/// Les valeurs sont un contrat avec `apps/client/src/render/terrain.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum EventKind {
    Raid = 1,
    ColonistDied = 2,
    RaiderDied = 3,
    RaiderLeft = 4,
    WandererJoined = 5,
    ColonistBreak = 6,
    /// Un colon a gagné un niveau dans une compétence. `arg` : son id ; le
    /// client choisira plus tard comment nommer la compétence concernée.
    LevelUp = 7,
    /// Un colon s'est écroulé (`arg` : son id). Il ne fait plus rien et les
    /// pillards l'ignorent : c'est le moment de venir le chercher.
    ColonistDowned = 8,
    /// Un colon à terre vient d'être déposé dans un lit. `arg` : l'id du blessé.
    ColonistRescued = 9,
    /// Les blessures d'un colon viennent d'être pansées. `arg` : l'id du soigné.
    ColonistTended = 10,
    /// Une caravane a quitté la carte. `arg` : le nombre de colons partis.
    /// Son manifeste attend dans `Sim::departures`.
    CaravanDeparted = 11,
    /// Une caravane vient d'arriver. `arg` : le nombre de colons débarqués
    /// (0 pour un simple envoi de marchandises).
    CaravanArrived = 12,
    /// La carte gelée a rattrapé le temps passé sans joueur
    /// (`Command::FastForward`). `arg` : le nombre de jours entiers écoulés.
    FastForwarded = 13,
    /// Une arme vient de sortir d'un poste de fabrication. `arg` : le genre
    /// fabriqué (`ItemKind`).
    WeaponCrafted = 14,
    /// La saison a changé. `arg` : la nouvelle saison (`climate::Season`).
    SeasonChanged = 15,
    /// Première gelée de l'automne : la première fois de la saison que la
    /// température extérieure passe sous 0 °C. `arg` : le jour de l'année.
    FirstFrost = 16,
    /// Un troupeau vient d'entrer sur la carte. `arg` : le nombre de bêtes.
    AnimalsArrived = 17,
    /// Une bête vient de mourir. `arg` : son espèce (`animals::Species`).
    AnimalHunted = 18,
    /// Un sanglier charge celui qui l'a blessé. `arg` : l'id du sanglier.
    BoarAttacks = 19,
    /// Un objet **qui n'est pas une arme** vient de sortir d'un poste de
    /// fabrication : un vêtement, pour l'instant. `arg` : le genre fabriqué
    /// (`ItemKind`). Les armes gardent `WeaponCrafted = 14`, que le client sait
    /// déjà afficher : un genre d'événement de plus coûte moins cher qu'un
    /// contrat cassé.
    ItemCrafted = 20,
    /// Une bande vient d'entrer sur la carte. `arg` : sa manière d'aborder la
    /// colonie (`storyteller::RaidKind` : 0 charge, 1 archers, 2 siège). Émis
    /// juste avant `Raid`, qui garde le compte des pillards : le client peut
    /// afficher l'un, l'autre, ou les deux.
    RaidIncoming = 21,
    /// Des vivres tombent près de la colonie. `arg` : le nombre de piles.
    SupplyDrop = 22,
    /// Un colon est tombé malade. `arg` : son id.
    Illness = 23,
    /// Vague de froid : une journée plus froide de `arg` dixièmes de degré.
    ColdSnap = 24,
    /// Canicule : une journée plus chaude de `arg` dixièmes de degré.
    Heatwave = 25,
    /// Un marchand itinérant vient d'arriver (voir `trade`). `arg` : son id,
    /// que le client suit pour afficher son étal et son nom.
    TraderVisit = 26,
    /// Un colon a attaqué le marchand : la visite est annulée et il se défend.
    /// `arg` : l'id du marchand.
    TraderAngered = 27,
    /// Un troc vient d'aboutir. `arg` : le genre acheté (`ItemKind`) — c'est
    /// ce qui vient d'arriver au sol, donc ce que le client a à annoncer.
    TradeDone = 28,
    /// Le marchand est mort sur la carte. `arg` : son id. Ses marchandises
    /// tombent au sol, et les visites suivantes se font attendre.
    TraderDied = 29,
    /// Un cadavre humain vient d'être enterré dans une tombe vide (voir
    /// `pawn::Job::Bury`). `arg` : toujours 0 — `ItemKind::Corpse` ne garde
    /// aucune trace de qui c'était.
    Buried = 30,
    /// Une technologie vient d'être acquise (voir `research`). `arg` : la
    /// technologie (`research::Tech`). La colonie ne cherche plus rien tant
    /// que le joueur n'a pas choisi la suivante.
    ResearchDone = 31,
    /// Une conversation a mal tourné (voir `social`) : les deux colons se sont
    /// accrochés. `arg` : l'id du premier des deux, c'est-à-dire le plus petit
    /// — le client va chercher l'autre dans les avis (`pawn_opinions`).
    Quarrel = 32,
    /// La dispute a dégénéré en rixe entre deux colons qui se détestaient déjà :
    /// chacun a pris un coup, jamais mortel, et la vie reprend (personne ne
    /// poursuit l'autre). `arg` : l'id du premier des deux, comme `Quarrel`.
    /// Émis **après** le `Quarrel` de la même dispute.
    Brawl = 33,
    /// Un colon a perdu un ami (voir `social::FRIEND_OPINION`) : son deuil dure
    /// deux fois plus longtemps. `arg` : l'id du **survivant**, pas du mort —
    /// celui-là vient d'être annoncé par `ColonistDied`.
    FriendLost = 34,
    /// Un piège à pointes vient de se refermer sur quelqu'un (voir
    /// `combat::TRAP_SEVERITY`). `arg` : l'id de la **victime** — un pillard,
    /// un marchand devenu hostile ou une bête, jamais un colon. Le piège est
    /// désormais déclenché (`Feature::SpikeTrapSprung`) et attend d'être
    /// réarmé.
    TrapSprung = 35,
    /// Un incendie vient de se déclarer (voir `fire`). `arg` : ce qui l'a
    /// allumé — 0 la foudre, 1 une escarbille de feu de camp, 2 un ordre du
    /// joueur (`Command::Ignite`). La **propagation** n'annonce rien : un
    /// incendie, c'est un `FireStarted` puis un `FireOut`, quelle que soit la
    /// surface parcourue entre les deux.
    FireStarted = 36,
    /// Plus rien ne brûle sur la carte. `arg` : le nombre de cases qui ont
    /// pris feu depuis le `FireStarted` — pas celles qui ont été détruites,
    /// puisqu'un foyer battu par les colons ou noyé par la pluie laisse son
    /// combustible intact.
    FireOut = 37,
    /// Une bête vient d'entrer dans la colonie (voir `livestock`). `arg` : son
    /// espèce (`animals::Species`), comme `AnimalHunted` — le client sait déjà
    /// nommer une espèce. Les tentatives ratées, elles, n'annoncent rien : un
    /// apprivoisement, c'est du travail, pas un fait notable à chaque essai.
    Tamed = 38,
    /// Une bête est née dans la colonie. `arg` : son espèce.
    Born = 39,
    /// Une bête de la colonie vient d'être abattue (`Command::Slaughter`).
    /// `arg` : son espèce. Elle laisse la même dépouille qu'une bête chassée,
    /// mais n'annonce **pas** `AnimalHunted` : ce n'était pas une chasse.
    Slaughtered = 40,
    /// La dernière bande entrée a été repoussée : tous ses pillards sont morts
    /// ou repartis (voir `factions`). `arg` : la tribu qui l'avait menée. La
    /// Guilde et la tribu rivale y gagnent en réputation ; la colonie, une
    /// réputation de place forte.
    RaidRepelled = 41,
    /// Un tribut vient d'être offert (`Command::Gift`). `arg` : la faction qui
    /// l'a reçu. Ce qu'il a rapporté se lit dans `Sim::goodwill`.
    Gift = 42,
    /// La relation avec une faction a changé de nature : elle a franchi
    /// `factions::HOSTILE_GOODWILL` ou `factions::ALLY_GOODWILL`, dans un sens
    /// ou dans l'autre. `arg` : la faction. Le nouveau palier se lit dans
    /// `Sim::goodwill` (voir `factions::Relation`).
    RelationChanged = 43,
}

/// `arg` dépend du genre : nombre de pillards pour un raid, id du pawn sinon.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct GameEvent {
    pub seq: u32,
    pub tick: u64,
    pub kind: EventKind,
    pub arg: u32,
}

/// Ordre émis par un joueur. Appliqué au début du tick où il est planifié.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub enum Command {
    /// Ne fait rien. Utile pour tester le lockstep sans gameplay.
    Nop,
    /// Envoie un pawn vers une case. Ignoré si la case est inaccessible.
    MoveTo { pawn: u32, x: u32, y: u32 },
    /// Pose (ou retire avec `Designation::None`) une désignation sur un rectangle.
    Designate {
        kind: Designation,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Pose (ou retire avec `Zone::None`) une zone sur un rectangle.
    SetZone {
        zone: Zone,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Pose des plans de construction sur chaque case valide du rectangle.
    Build {
        kind: BuildKind,
        material: Material,
        x0: i32,
        y0: i32,
        x1: i32,
        y1: i32,
    },
    /// Annule les plans du rectangle et rend les matériaux déjà livrés.
    CancelBuild { x0: i32, y0: i32, x1: i32, y1: i32 },
    /// Envoie un pawn en attaquer un autre, d'un camp différent.
    Attack { pawn: u32, target: u32 },
    /// Règle la priorité d'un type de travail pour un colon.
    /// `priority` : 1 la plus haute, 4 la plus basse, 0 désactivé.
    SetPriority {
        pawn: u32,
        work: WorkType,
        priority: u8,
    },
    /// Fait entrer un raid tout de suite (débogage, tests).
    TriggerRaid,
    /// Fait partir une caravane : les colons quittent la carte avec les
    /// marchandises prélevées en stockage, et le manifeste encodé rejoint
    /// `Sim::departures`. Ignorée si la liste est vide, si un id est inconnu,
    /// répété, désigne un pillard ou un colon à terre. Les quantités
    /// manquantes ne sont pas un refus : on part avec ce qui existe.
    FormCaravan {
        pawns: Vec<u32>,
        items: Vec<(ItemKind, u32)>,
    },
    /// Retire les `count` premiers manifestes de `Sim::departures`. C'est la
    /// seule façon de vider la file en lockstep : l'hôte lit `departures()`,
    /// expédie les octets au serveur monde, puis émet cette commande que tous
    /// les clients appliquent au même tick.
    ClearDepartures { count: u32 },
    /// Fait entrer un manifeste (octets de `CaravanManifest::encode`) sur
    /// cette carte. Le manifeste voyage **dans** la commande : tous les
    /// clients de la salle l'appliquent au même tick. Illisible : ignoré.
    ArriveCaravan { manifest: Vec<u8> },
    /// Rattrape d'un coup le temps passé carte gelée, par des formules et non
    /// par des ticks (voir `fastforward`). Émise par l'hôte à la réouverture
    /// d'une colonie, en première commande, avec le `frozenTicks` que le
    /// serveur monde a calculé (`docs/protocol.md` §11.6). Bornée à
    /// `MAX_FAST_FORWARD` (60 jours) ; 0 ne fait rien.
    FastForward { ticks: u32 },
    /// Règle le nombre d'exemplaires de `kind` que la colonie doit maintenir :
    /// les colons fabriquent tant que le total en jeu (au sol, en main,
    /// équipé ou porté par un colon) est inférieur à `target`. Un genre sans
    /// recette (`craft::recipe_for`) est ignoré. Tout est à 0 au départ : sans
    /// ordre, ni arme ni vêtement n'est fabriqué.
    SetCraftTarget { kind: ItemKind, target: u32 },
    /// Impose le climat de la carte : moyenne annuelle et écart saisonnier, en
    /// dixièmes de degré. C'est ainsi qu'une salle du globe reçoit le climat de
    /// sa case (`docs/PLAN.md` §3) sans changer la construction de la carte :
    /// l'hôte l'émet en lockstep, tout le monde l'applique au même tick. Les
    /// valeurs sont bornées par `Climate::sanitized`.
    SetClimate {
        base_temperature: i32,
        amplitude: i32,
    },
    /// Marque (`on`) ou démarque un animal comme gibier. La chasse est un
    /// ordre **par bête**, pas par case : `Command::Designate` travaille au
    /// rectangle et ne saurait viser un cerf qui court. Un colon armé et libre
    /// prend le gibier marqué le plus proche (`Job::Hunt`) ; démarquer arrête
    /// les chasseurs en route. Un id qui n'est pas celui d'un animal vivant
    /// est ignoré.
    Hunt { animal: u32, on: bool },
    /// Règle la dose de menace du storyteller (voir `storyteller::Difficulty`) :
    /// elle multiplie les points de menace d'un raid et espace ou resserre leur
    /// cadence. En `Peaceful`, le storyteller n'envoie plus aucun raid — le
    /// `TriggerRaid` du joueur, lui, reste un outil de débogage et fonctionne
    /// toujours. **Ajoutée en fin d'énumération** : postcard encode l'indice.
    SetDifficulty { level: Difficulty },
    /// Décale le calendrier pour que `day_of_year()` vaille `day_of_year`
    /// (modulo `climate::YEAR_DAYS`), **sans toucher au tick ni à
    /// `time_of_day`** : seul `Sim::calendar_offset_days` change, météo et
    /// températures suivant d'elles-mêmes puisqu'elles lisent `day_of_year()`.
    /// C'est ainsi que le serveur monde impose le jour de l'année d'une
    /// colonie neuve, comme il impose son climat (`Command::SetClimate`) :
    /// l'hôte l'émet en lockstep, tout le monde l'applique au même tick.
    /// Émet `EventKind::SeasonChanged` si la saison change de ce fait.
    /// **Ajoutée en fin d'énumération** : postcard encode l'indice.
    SetCalendar { day_of_year: u32 },
    /// Troque `give_count` unités de `give`, prélevées en **stockage**, contre
    /// `take_count` unités de `take` prises à un marchand présent (voir
    /// `trade`). Acceptée si un marchand est là (ni hostile, ni en partance),
    /// si la colonie a la marchandise en stock, si le marchand a la sienne, et
    /// si ce qu'on donne vaut au moins ce qu'on prend (`value_buy` contre
    /// `value_sell`) : la colonie peut payer plus, jamais moins. Sinon
    /// ignorée, sans plus de manières que `Command::Hunt` sur un id inconnu.
    /// **Ajoutée en fin d'énumération** : postcard encode l'indice.
    Trade {
        give: ItemKind,
        give_count: u32,
        take: ItemKind,
        take_count: u32,
    },
    /// Fait entrer un marchand tout de suite, comme `TriggerRaid` fait entrer un
    /// raid : outil de débogage, passe par le lockstep pour rester partagé. Sans
    /// effet si un marchand est déjà là, si la colonie est éteinte ou si aucun
    /// bord n'est atteignable. **Ajoutée en fin d'énumération.**
    TriggerTraderVisit,
    /// Choisit la technologie que la colonie cherche (`research::Tech`), ou
    /// arrête tout avec `research::NO_TECH` (255). Ignorée si `tech` ne désigne
    /// aucune technologie ou si celle-ci est déjà acquise — sans plus de
    /// manières que `Hunt` sur un id inconnu. Les colons dont la priorité
    /// Recherche est active s'installent alors à un établi
    /// (`BuildKind::ResearchBench`), s'il y en a un.
    /// **Ajoutée en fin d'énumération** : postcard encode l'indice.
    SetResearch { tech: u8 },
    /// Met le feu à une case (voir `fire`). Outil de débogage aujourd'hui,
    /// futur outil du joueur (torche, brûlis) : la commande passe par le
    /// lockstep comme `TriggerRaid`, donc tous les clients d'une salle
    /// allument le même foyer au même tick. Sans effet si la case est hors
    /// carte, si elle brûle déjà ou si elle ne porte aucun combustible
    /// (`fire::feature_burns`, `fire::terrain_burns`, `fire::item_burns`) —
    /// sans plus de manières que `Hunt` sur un id inconnu.
    /// **Ajoutée en fin d'énumération** : postcard encode l'indice.
    Ignite { x: u32, y: u32 },
    /// Marque (`on`) ou démarque une bête **sauvage** pour l'apprivoisement
    /// (voir `livestock`). Symétrique de `Hunt`, et **exclusive** d'elle :
    /// marquer pour apprivoiser retire le marquage de chasse et inversement.
    /// Un colon libre dont la priorité Agriculture est active apporte
    /// `livestock::TAME_FOOD` baies ou légumes et tente sa chance
    /// (`Job::Tame`) ; démarquer arrête les apprivoiseurs en route. Un id qui
    /// n'est pas celui d'un animal sauvage vivant est ignoré.
    /// **Ajoutée en fin d'énumération** : postcard encode l'indice.
    Tame { animal: u32, on: bool },
    /// Marque une bête **de la colonie** pour l'abattoir : un colon la rejoint
    /// et l'abat (`Job::Slaughter`), elle laisse sa dépouille et le dépeçage
    /// existant fait le reste. Une bête sauvage est refusée — celle-là se
    /// chasse. Le marquage ne se retire pas : c'est un ordre, pas une zone.
    /// **Ajoutée en fin d'énumération** : postcard encode l'indice.
    Slaughter { animal: u32 },
    /// Offre un tribut à une faction PNJ (voir `factions`) : `count` unités de
    /// `kind` sont prélevées en **stockage** et quittent la carte, et la
    /// réputation monte de leur valeur divisée par
    /// `factions::GIFT_VALUE_PER_POINT` (au moins un point si la marchandise
    /// vaut quelque chose). C'est la boucle « payer sa paix » : une tribu à
    /// laquelle on offre régulièrement finit alliée, et n'attaque plus.
    /// Refusée — sans un mot, comme `Trade` — si la faction est inconnue, si
    /// la quantité est nulle, si la colonie est éteinte ou si le stock ne
    /// couvre pas la demande.
    /// **Ajoutée en fin d'énumération** : postcard encode l'indice.
    Gift {
        faction: u8,
        kind: ItemKind,
        count: u32,
    },
}

#[derive(Debug)]
pub enum SnapshotError {
    Corrupt,
}

impl core::fmt::Display for SnapshotError {
    fn fmt(&self, f: &mut core::fmt::Formatter<'_>) -> core::fmt::Result {
        match self {
            SnapshotError::Corrupt => f.write_str("snapshot corrompu"),
        }
    }
}

/// État complet d'une carte simulée. Tout ce qui influence le futur est ici,
/// et uniquement ici : c'est ce qui est sérialisé et hashé.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Sim {
    tick: u64,
    rng: Rng,
    map: Map,
    /// Triés par id croissant (ordre d'insertion, jamais réordonnés).
    pawns: Vec<Pawn>,
    items: Vec<ItemStack>,
    reservations: Vec<Reservation>,
    regrow: Vec<Regrow>,
    blueprints: Vec<Blueprint>,
    crops: Vec<Crop>,
    /// Faits notables récents, du plus ancien au plus récent.
    events: Vec<GameEvent>,
    next_event_seq: u32,
    /// Tick du prochain raid.
    next_raid_at: u64,
    /// Tick d'arrivée du prochain voyageur.
    next_wanderer_at: u64,
    weather: Weather,
    /// Tick où la météo courante s'arrête.
    weather_until: u64,
    /// Compteur d'ids partagé par tout ce qui a un id.
    next_id: u32,
    /// Manifestes de caravanes parties d'ici, encodés, en attente d'être
    /// expédiés au serveur monde. Ils font partie de l'état (donc du hash)
    /// tant que `Command::ClearDepartures` ne les a pas retirés : sans ça,
    /// deux clients de la même salle divergeraient dès le premier départ.
    departures: Vec<Vec<u8>>,
    /// Objectif de fabrication par genre (`Command::SetCraftTarget`), indexé
    /// par `ItemKind`. Ajouté **en fin de structure** : un vieux snapshot est
    /// alors refusé net (fin de tampon) au lieu d'être relu de travers.
    craft_targets: [u32; ItemKind::COUNT],
    /// Climat de la carte (`Command::SetClimate`), tempéré par défaut.
    climate: Climate,
    /// Bruit de température de la période météo courante, en dixièmes : tiré
    /// à chaque changement de temps pour que deux années ne se superposent pas.
    pub(crate) weather_noise: i32,
    /// Rien à annoncer côté gelée : soit la première de l'automne en cours est
    /// déjà passée, soit ce n'est pas l'automne. Reposé à chaque changement de
    /// saison (voir `Sim::tick_climate`).
    frost_announced: bool,
    /// Tick d'entrée du prochain troupeau (voir `animals`).
    next_herd_at: u64,
    /// Dose de menace (`Command::SetDifficulty`). **Champs ajoutés en fin de
    /// structure** : un vieux snapshot est refusé net (fin de tampon) plutôt
    /// que relu de travers.
    difficulty: Difficulty,
    /// Dernière richesse calculée et tick de ce calcul : le storyteller la
    /// rafraîchit au plus une fois par `storyteller::WEALTH_CACHE_TICKS`.
    /// C'est un cache qui **influence le futur** (les points de menace en
    /// dépendent), donc il fait partie de l'état et du hash.
    wealth_cache: u32,
    wealth_cache_tick: u64,
    /// Tick du prochain largage de vivres.
    next_supply_at: u64,
    /// Tick de la prochaine maladie.
    next_illness_at: u64,
    /// Tick du prochain coup de temps (vague de froid ou canicule).
    next_extreme_at: u64,
    /// Écart de température du coup de temps en cours, en dixièmes de degré,
    /// et tick où il s'arrête.
    temperature_offset: i32,
    offset_until: u64,
    /// Décalage imposé par `Command::SetCalendar`, en jours : `day_of_year()`
    /// et `season()` l'ajoutent au jour brut déduit du tick
    /// (`climate::day_of_tick`). Toujours dans `0..YEAR_DAYS`. **Champ ajouté
    /// en fin de structure** : un vieux snapshot est refusé net plutôt que relu
    /// de travers.
    calendar_offset_days: u32,
    /// Tick d'arrivée du prochain marchand itinérant (voir `trade`).
    /// **Champs ajoutés en fin de structure**, même raison que ci-dessus.
    next_trader_at: u64,
    /// Tick jusqu'auquel la colonie traîne la réputation d'avoir laissé mourir
    /// un marchand : les visites programmées d'ici là attendent
    /// `trade::TRADER_GRUDGE_EXTRA` de plus. 0 quand rien n'est reproché.
    trader_grudge_until: u64,
    /// Ce que la colonie cherche et ce qu'elle a trouvé (voir `research`).
    /// **Champ ajouté en fin de structure** : un vieux snapshot est refusé net
    /// (fin de tampon) plutôt que relu de travers.
    research: ResearchState,
    /// Cases en feu, dans l'ordre où elles se sont enflammées (voir `fire`).
    /// C'est la **seule** chose que l'évaluation du feu parcourt : la couche
    /// `Map::fire` sert au rendu et aux tests d'appartenance, jamais aux
    /// balayages. **Champs ajoutés en fin de structure** : un vieux snapshot
    /// est refusé net (fin de tampon) plutôt que relu de travers.
    burning: Vec<Fire>,
    /// Cases enflammées depuis le début de l'incendie en cours, remis à zéro
    /// par `EventKind::FireOut` qui l'annonce.
    fires_lit: u32,
    /// Tick de la prochaine naissance possible, **par espèce** dans l'ordre de
    /// `Species::ALL` (voir `livestock::tick_breeding`). 0 : la colonie n'a pas
    /// deux bêtes de cette espèce, l'échéance sera posée quand un couple
    /// existera. **Champ ajouté en fin de structure** : un vieux snapshot est
    /// refusé net (fin de tampon) plutôt que relu de travers.
    breed_at: livestock::BreedClock,
    /// Réputation de la colonie auprès des trois factions PNJ, dans l'ordre de
    /// `factions::FACTIONS` (voir `factions`). **Champs ajoutés en fin de
    /// structure** : un vieux snapshot est refusé net (fin de tampon) plutôt
    /// que relu de travers.
    goodwill: [i32; factions::FACTION_COUNT],
    /// Tribu qui a mené la dernière bande entrée, ou un id hors bornes tant
    /// qu'aucune n'est venue (voir `Sim::last_raid_faction`).
    last_raid_faction: u8,
    /// Une bande est entrée et son sort n'est pas encore tranché : dès qu'il
    /// ne reste plus un pillard vivant sur la carte, le storyteller annonce
    /// `EventKind::RaidRepelled` et remet ce drapeau à faux. Un raid qui en
    /// recouvre un autre ne donne qu'une annonce, pour le dernier arrivé.
    raid_unresolved: bool,
    /// Cases d'entrepôt examinées par la recherche de rangement depuis le
    /// début de la partie. **Hors état** (voir `WorkCounter`) : ni snapshot,
    /// ni hash, ni égalité. C'est une mesure, pas une donnée de jeu.
    #[serde(skip)]
    haul_scans: WorkCounter,
    /// Tombes examinées par la recherche d'inhumation depuis le début de la
    /// partie. Même facture que `haul_scans` : **hors état**, ni snapshot, ni
    /// hash, ni égalité.
    #[serde(skip)]
    bury_scans: WorkCounter,
}

/// Compteur d'observation. Il compte du **travail**, jamais de l'état : il
/// n'entre ni dans le snapshot (`#[serde(skip)]`), ni dans l'égalité de deux
/// sims, donc ni dans le hash, et rien dans le sim ne le relit. Il existe
/// parce qu'un test de performance doit mesurer un nombre d'opérations, pas
/// un temps — le temps, en intégration continue, ne veut rien dire.
#[derive(Clone, Copy, Debug, Default, Eq)]
pub struct WorkCounter(u64);

impl WorkCounter {
    pub fn get(self) -> u64 {
        self.0
    }

    fn add(&mut self, n: u64) {
        self.0 = self.0.saturating_add(n);
    }
}

/// Deux sims dans le même état sont égales, quel que soit le chemin parcouru
/// pour y arriver : le compteur n'est pas de l'état.
impl PartialEq for WorkCounter {
    fn eq(&self, _: &WorkCounter) -> bool {
        true
    }
}

impl Sim {
    pub fn new(seed: u64, width: u32, height: u32) -> Sim {
        Sim::new_with_climate(seed, width, height, Climate::default())
    }

    /// Même chose, sur un climat imposé : c'est ce que fera le serveur monde
    /// pour une case de globe qui n'est pas tempérée.
    pub fn new_with_climate(seed: u64, width: u32, height: u32, climate: Climate) -> Sim {
        let mut rng = Rng::new(seed);
        // Le seed de la carte est dérivé : changer la gen de terrain ne doit pas
        // décaler le flux RNG du gameplay, et inversement.
        let map_seed = rng.next_u64();
        Sim::with_map(rng, Map::generate(map_seed, width, height), climate)
    }

    /// Sim sur une carte fournie (tests, scénarios).
    pub fn from_map(seed: u64, map: Map) -> Sim {
        Sim::from_map_with_climate(seed, map, Climate::default())
    }

    /// Sim sur une carte et un climat fournis (tests, scénarios).
    pub fn from_map_with_climate(seed: u64, map: Map, climate: Climate) -> Sim {
        Sim::with_map(Rng::new(seed), map, climate)
    }

    fn with_map(rng: Rng, map: Map, climate: Climate) -> Sim {
        let mut sim = Sim {
            tick: 0,
            rng,
            map,
            pawns: Vec::new(),
            items: Vec::new(),
            reservations: Vec::new(),
            regrow: Vec::new(),
            blueprints: Vec::new(),
            crops: Vec::new(),
            events: Vec::new(),
            next_event_seq: 0,
            next_raid_at: 0,
            next_wanderer_at: 0,
            weather: Weather::Clear,
            weather_until: 0,
            next_id: 1,
            departures: Vec::new(),
            craft_targets: [0; ItemKind::COUNT],
            climate: climate.sanitized(),
            weather_noise: 0,
            // La partie commence au printemps : rien à guetter avant l'automne.
            frost_announced: true,
            next_herd_at: 0,
            difficulty: Difficulty::default(),
            wealth_cache: 0,
            wealth_cache_tick: 0,
            next_supply_at: 0,
            next_illness_at: 0,
            next_extreme_at: 0,
            temperature_offset: 0,
            offset_until: 0,
            calendar_offset_days: 0,
            next_trader_at: 0,
            trader_grudge_until: 0,
            research: ResearchState::default(),
            burning: Vec::new(),
            fires_lit: 0,
            breed_at: [0; animals::SPECIES_COUNT],
            goodwill: factions::START_GOODWILL,
            // Aucune bande n'est encore venue : l'id ne désigne aucune
            // faction, et `last_raid_faction()` renvoie `None`.
            last_raid_faction: u8::MAX,
            raid_unresolved: false,
            haul_scans: WorkCounter::default(),
            bury_scans: WorkCounter::default(),
        };
        // La couche « intérieur » est prête avant le premier tick : lire une
        // température juste après la construction doit donner le bon chiffre.
        sim.map.refresh_indoor();
        sim.spawn_starting_pawns(3);
        sim.spawn_starting_animals();
        sim.schedule_first_raid();
        sim.schedule_first_herd();
        // La première journée reste claire un moment, le temps de s'installer.
        sim.weather_until = u64::from(TICKS_PER_DAY / 2 + sim.rng.below(TICKS_PER_DAY / 2));
        sim.next_wanderer_at = u64::from(4 * TICKS_PER_DAY + sim.rng.below(TICKS_PER_DAY));
        // En dernier : les échéances des événements ajoutés après coup tirent
        // à la suite, sans décaler ce que les tirages précédents donnaient.
        sim.schedule_first_events();
        sim.schedule_first_trader();
        // Ne consomme aucun hasard : c'est un simple comptage de ce qui existe.
        sim.init_wealth();
        sim
    }

    fn spawn_starting_pawns(&mut self, count: u32) {
        let (cx, cy) = (self.map.width() / 2, self.map.height() / 2);
        let Some(center) = self.map.nearest_passable(cx, cy) else {
            return;
        };
        let mut spawned = 0;
        let mut r: i32 = 0;
        while spawned < count && r < 16 {
            for dy in -r..=r {
                for dx in -r..=r {
                    if spawned >= count || (dx.abs() != r && dy.abs() != r) {
                        continue;
                    }
                    let x = center.0 as i32 + dx;
                    let y = center.1 as i32 + dy;
                    if self.map.in_bounds(x, y) && self.map.passable(x as u32, y as u32) {
                        self.spawn_pawn(x as u32, y as u32, Faction::Colony);
                        spawned += 1;
                    }
                }
            }
            r += 1;
        }
    }

    /// Crée un pawn du camp donné, avec un nom tiré au sort. Les colons
    /// (et voyageurs) reçoivent aussi des niveaux de compétence de départ ;
    /// les pillards restent à 0 partout (valeur par défaut de `Pawn::at_tile`).
    pub fn spawn_pawn(&mut self, x: u32, y: u32, faction: Faction) -> u32 {
        let id = self.next_id;
        self.next_id += 1;
        let name = names::pick(&mut self.rng, faction);
        let mut pawn = Pawn::at_tile(id, x, y, name);
        pawn.faction = faction;
        if faction == Faction::Colony {
            for work in WorkType::ALL {
                pawn.skills[work as usize].level = self.rng.below(9) as u8;
            }
            // Le combat n'est pas un type de travail, mais ses deux
            // compétences se tirent comme les autres.
            pawn.melee.level = self.rng.below(9) as u8;
            pawn.ranged.level = self.rng.below(9) as u8;
            // Deux traits de caractère, jamais contradictoires (voir
            // `traits::roll`). Ni les pillards ni les bêtes n'en ont.
            pawn.traits = traits::roll(&mut self.rng);
        }
        self.pawns.push(pawn);
        id
    }

    /// Avance d'un tick. Les commandes sont appliquées dans l'ordre reçu,
    /// avant la mise à jour du monde. Le lockstep garantit que tous les
    /// clients reçoivent la même liste dans le même ordre pour ce tick.
    pub fn step(&mut self, commands: &[Command]) {
        for command in commands {
            self.apply(command);
        }
        self.update();
        self.tick += 1;
    }

    fn apply(&mut self, command: &Command) {
        match *command {
            Command::Nop => {}
            Command::MoveTo { pawn, x, y } => {
                if !self.map.in_bounds(x as i32, y as i32) {
                    return;
                }
                let Some(i) = self.pawns.iter().position(|p| p.id == pawn) else {
                    return;
                };
                let from = self.pawns[i].tile();
                // Même un ordre du joueur ne fait pas marcher un colon sur un
                // piège armé : il contourne, ou il n'y va pas.
                let walker = self.walker(i);
                if let Some(path) = path::find_path_for(&self.map, from, (x, y), walker) {
                    self.abandon_job(i);
                    self.pawns[i].set_path(path);
                    self.pawns[i].job = Job::Move { manual: true };
                }
            }
            Command::Designate {
                kind,
                x0,
                y0,
                x1,
                y1,
            } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                for (x, y) in rect.tiles() {
                    if kind == Designation::None || kind.applies_to(self.map.feature(x, y)) {
                        self.map.set_designation(x, y, kind);
                    }
                }
            }
            Command::SetZone {
                zone,
                x0,
                y0,
                x1,
                y1,
            } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                for (x, y) in rect.tiles() {
                    if zone == Zone::None || self.map.passable(x, y) {
                        self.map.set_zone(x, y, zone);
                    }
                }
            }
            Command::Build {
                kind,
                material,
                x0,
                y0,
                x1,
                y1,
            } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                let material = kind.forced_material().unwrap_or(material);
                for (x, y) in rect.tiles() {
                    if !build::can_place(&self.map, kind, x, y)
                        || self.blueprints.iter().any(|b| (b.x, b.y) == (x, y))
                        || (kind != BuildKind::Floor
                            && self.items.iter().any(|s| (s.x, s.y) == (x, y)))
                    {
                        continue;
                    }
                    let id = self.next_id;
                    self.next_id += 1;
                    self.blueprints.push(Blueprint {
                        id,
                        x,
                        y,
                        kind,
                        material,
                        delivered: 0,
                        needed: kind.cost(),
                        progress: 0,
                        reserved_by: None,
                    });
                }
            }
            Command::CancelBuild { x0, y0, x1, y1 } => {
                let Some(rect) = self.map.clamp_rect(x0, y0, x1, y1) else {
                    return;
                };
                let mut k = 0;
                while k < self.blueprints.len() {
                    let b = &self.blueprints[k];
                    if b.x >= rect.x0 && b.x <= rect.x1 && b.y >= rect.y0 && b.y <= rect.y1 {
                        let b = self.blueprints.remove(k);
                        self.spawn_item(b.material.item_kind(), b.delivered, b.x, b.y);
                    } else {
                        k += 1;
                    }
                }
            }
            Command::Attack { pawn, target } => {
                let Some(i) = self.pawns.iter().position(|p| p.id == pawn && p.is_alive()) else {
                    return;
                };
                let Some(k) = self
                    .pawns
                    .iter()
                    .position(|p| p.id == target && p.is_alive())
                else {
                    return;
                };
                // On ne commande pas la faune : un sanglier décide seul de
                // charger (voir `animals`), et un lapin ne charge jamais.
                if self.pawns[i].faction == self.pawns[k].faction || self.pawns[i].species.is_some()
                {
                    return;
                }
                // Lever la main sur un marchand annule la visite : il se
                // défend, et la colonie s'en souviendra (voir `trade`).
                if self.pawns[i].faction == Faction::Colony {
                    self.anger_trader(k);
                }
                self.abandon_job(i);
                self.pawns[i].job = Job::Attack { target };
            }
            Command::SetPriority {
                pawn,
                work,
                priority,
            } => {
                let Some(p) = self.pawns.iter_mut().find(|p| p.id == pawn) else {
                    return;
                };
                // Ni les pillards ni les bêtes n'ont de tableau de travail —
                // apprivoisées comprises (voir `livestock`).
                if !p.is_colonist() {
                    return;
                }
                p.priorities[work as usize] = priority.min(4);
            }
            Command::TriggerRaid => {
                // Outil de débogage : il ignore les alliances (voir
                // `Sim::trigger_raid`), sinon il cesserait d'être un outil dès
                // qu'une tribu devient amie.
                self.trigger_raid();
            }
            Command::FormCaravan {
                ref pawns,
                ref items,
            } => self.form_caravan(pawns, items),
            Command::ClearDepartures { count } => self.clear_departures(count),
            Command::ArriveCaravan { ref manifest } => self.arrive_caravan(manifest),
            Command::FastForward { ticks } => self.fast_forward(ticks),
            Command::SetCraftTarget { kind, target } => {
                if craft::recipe_for(kind).is_some() {
                    self.craft_targets[kind as usize] = target;
                }
            }
            Command::SetClimate {
                base_temperature,
                amplitude,
            } => {
                self.climate = Climate {
                    base_temperature,
                    amplitude,
                }
                .sanitized();
            }
            Command::Hunt { animal, on } => self.set_hunted(animal, on),
            Command::SetDifficulty { level } => self.difficulty = level,
            Command::SetCalendar { day_of_year } => self.set_calendar(day_of_year),
            Command::Trade {
                give,
                give_count,
                take,
                take_count,
            } => self.trade(give, give_count, take, take_count),
            Command::TriggerTraderVisit => {
                self.spawn_trader();
            }
            Command::SetResearch { tech } => self.set_research(tech),
            Command::Ignite { x, y } => self.ignite_command(x, y),
            Command::Tame { animal, on } => self.set_tame_marked(animal, on),
            Command::Slaughter { animal } => self.set_slaughter_marked(animal),
            Command::Gift {
                faction,
                kind,
                count,
            } => self.gift(faction, kind, count),
        }
    }

    fn update(&mut self) {
        // La couche « intérieur » d'abord : tout ce qui suit lit des
        // températures. Elle ne coûte que si un mur, une porte ou un feu a
        // bougé depuis le dernier tick.
        self.map.refresh_indoor();
        self.tick_weather();
        // La température extérieure est la même pour toute la carte : une
        // seule lecture par tick, partagée par le calendrier, les plants, les
        // buissons et les pawns.
        let outdoor = self.outdoor_temperature();
        self.tick_climate(outdoor);
        self.tick_regrowth(outdoor);
        self.tick_crops(outdoor);
        self.tick_spoilage();
        self.tick_storyteller();
        // L'élevage : un tick sur `livestock::BREED_INTERVAL`, et rien du tout
        // sans deux bêtes d'une même espèce dans la colonie.
        self.tick_breeding();
        // Le feu, avant que les colons ne jouent : ils voient donc la carte
        // telle que l'incendie vient de la laisser, et les brûlures de ce tour
        // comptent dans leur santé. Un tick sur `fire::FIRE_INTERVAL`, et rien
        // du tout sans case en feu, sans orage et sans feu de camp au sec.
        self.tick_fire(outdoor);
        // Un seul comptage par tick, partagé par tous les colons (comme
        // `outdoor`) : voir `Pawn::corpses_on_map`.
        let corpses = self.corpse_count();
        // Aucun pawn n'apparaît ni ne disparaît pendant cette boucle (le
        // ménage se fait après), les indices restent donc valides.
        let trapped = self.map.trap_count() > 0;
        for i in 0..self.pawns.len() {
            // Case occupée avant son tour : le piège se déclenche à l'entrée,
            // pas au séjour (voir `Sim::spring_trap`). Sans piège sur la
            // carte, on ne relit même pas la case.
            let before = if trapped {
                Some(self.pawns[i].tile())
            } else {
                None
            };
            self.tick_pawn(i, outdoor, corpses);
            if let Some(before) = before {
                self.spring_trap(i, before);
            }
        }
        self.remove_dead();
    }

    /// Cadavres humains au sol, toutes piles confondues (voir
    /// `Pawn::corpses_on_map`).
    fn corpse_count(&self) -> u32 {
        self.items
            .iter()
            .filter(|s| s.kind == ItemKind::Corpse)
            .map(|s| s.count)
            .sum()
    }

    /// Enregistre un fait notable pour le client. La file est bornée : le
    /// client suit les `seq` qu'il a déjà vus.
    fn push_event(&mut self, kind: EventKind, arg: u32) {
        let seq = self.next_event_seq;
        self.next_event_seq += 1;
        self.events.push(GameEvent {
            seq,
            tick: self.tick,
            kind,
            arg,
        });
        if self.events.len() > MAX_EVENTS {
            self.events.remove(0);
        }
    }

    pub fn tick(&self) -> u64 {
        self.tick
    }

    /// Instant dans la journée, dans `0..TICKS_PER_DAY`. 0 = minuit.
    pub fn time_of_day(&self) -> u32 {
        ((self.tick + u64::from(DAY_START_OFFSET)) % u64::from(TICKS_PER_DAY)) as u32
    }

    pub fn map(&self) -> &Map {
        &self.map
    }

    /// Accès direct à la carte, pour les tests et scénarios. Le jeu passe par
    /// des `Command`.
    pub fn map_mut(&mut self) -> &mut Map {
        &mut self.map
    }

    pub fn blueprints(&self) -> &[Blueprint] {
        &self.blueprints
    }

    pub fn crops(&self) -> &[Crop] {
        &self.crops
    }

    pub fn pawns(&self) -> &[Pawn] {
        &self.pawns
    }

    pub fn pawn_mut(&mut self, id: u32) -> Option<&mut Pawn> {
        self.pawns.iter_mut().find(|p| p.id == id)
    }

    /// Blesse un pawn à l'endroit voulu, comme le ferait un coup : le
    /// saignement vaut `severity / health::BLEED_FRACTION`. Sert aux tests et
    /// au futur mode debug ; le jeu blesse par le combat et la famine. Une
    /// bête réagit comme à un vrai coup, mais sans agresseur à charger : elle
    /// détale, sanglier compris.
    pub fn inflict_injury(&mut self, pawn: u32, part: BodyPart, severity: u32) {
        let Some(k) = self.pawns.iter().position(|p| p.id == pawn) else {
            return;
        };
        self.pawns[k].add_injury(part, severity, severity / health::BLEED_FRACTION);
        self.animal_hit(k, None);
    }

    pub fn items(&self) -> &[ItemStack] {
        &self.items
    }

    /// Faits notables récents, du plus ancien au plus récent.
    pub fn events(&self) -> &[GameEvent] {
        &self.events
    }

    /// Objectifs de fabrication courants, indexés par `ItemKind`.
    pub fn craft_targets(&self) -> &[u32; ItemKind::COUNT] {
        &self.craft_targets
    }

    /// Ce que la colonie cherche et ce qu'elle a trouvé.
    pub fn research(&self) -> &ResearchState {
        &self.research
    }

    /// Accès direct à l'état de la recherche, **pour les tests et les
    /// scénarios** (comme `map_mut`) : c'est ainsi qu'on part d'une colonie
    /// qui sait déjà quelque chose. Le jeu, lui, passe par
    /// `Command::SetResearch` et par le travail des colons.
    pub fn research_mut(&mut self) -> &mut ResearchState {
        &mut self.research
    }

    /// Choisit la technologie cherchée. Un octet qui n'en désigne aucune est
    /// ignoré, une technologie déjà acquise aussi ; `research::NO_TECH` (255)
    /// arrête la recherche en cours.
    fn set_research(&mut self, tech: u8) {
        if tech == research::NO_TECH {
            self.research.current = research::NO_TECH;
            return;
        }
        let Some(t) = Tech::from_u8(tech) else {
            return;
        };
        if self.research.is_done(t) {
            return;
        }
        self.research.current = tech;
    }

    /// Total d'objets rangés en zone de stockage, par genre.
    pub fn stored_totals(&self) -> [u32; ItemKind::COUNT] {
        let mut out = [0; ItemKind::COUNT];
        for s in &self.items {
            if self.map.zone(s.x, s.y) == Zone::Stockpile {
                out[s.kind as usize] += s.count;
            }
        }
        out
    }

    /// Sérialisation binaire compacte de l'état complet.
    pub fn snapshot(&self) -> Vec<u8> {
        postcard::to_allocvec(self).expect("sérialisation en mémoire infaillible")
    }

    pub fn restore(bytes: &[u8]) -> Result<Sim, SnapshotError> {
        postcard::from_bytes(bytes).map_err(|_| SnapshotError::Corrupt)
    }

    /// Hash de l'état, comparé entre clients pour détecter une désynchronisation.
    /// Phase 0 : hash du snapshot complet. À rendre incrémental quand l'état grossit.
    pub fn state_hash(&self) -> u64 {
        hash::fnv1a64(&self.snapshot())
    }

    /// Cases d'entrepôt examinées depuis le début de la partie par la
    /// recherche d'une destination de rangement. Sert à mesurer le coût du
    /// rangement sans passer par le chronomètre (`tests/hauling_perf.rs`) :
    /// il doit rester borné par tick, quelle que soit la taille de la carte
    /// et le nombre de piles au sol.
    pub fn haul_scans(&self) -> u64 {
        self.haul_scans.get()
    }

    pub(crate) fn count_haul_scan(&mut self, n: u64) {
        self.haul_scans.add(n);
    }

    /// Tombes examinées depuis le début de la partie par la recherche d'une
    /// sépulture. Même usage que `haul_scans` (`tests/burial_perf.rs`) : le
    /// coût de l'inhumation par tick doit rester borné par le nombre de
    /// tombes, jamais par la surface de la carte ni par le nombre de cadavres.
    pub fn bury_scans(&self) -> u64 {
        self.bury_scans.get()
    }

    pub(crate) fn count_bury_scan(&mut self, n: u64) {
        self.bury_scans.add(n);
    }
}
