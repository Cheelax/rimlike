//! Biome de la case du globe où la colonie est fondée, et ce qu'il change à sa
//! carte.
//!
//! Le monde partagé (`packages/world`) classe chaque case du globe dans un
//! biome ; jusqu'ici la carte de colonie ne s'en servait pas — seule la
//! température suivait, imposée par `Command::SetClimate`. Ce module porte la
//! **composition** : sols, densité d'arbres et de buissons, rochers et veines,
//! eau.
//!
//! # Ce que le biome n'est pas
//!
//! Il n'est **pas** une commande. La composition d'une carte ne peut pas
//! changer après le premier tick — ce serait une autre carte, et deux clients
//! d'une même salle ne pourraient pas s'accorder sur celle qui a été jouée. Le
//! biome est donc fixé à la construction (`Sim::new_in_biome`), rangé en fin de
//! `Sim` et sérialisé, et jamais modifiable ensuite. Le serveur monde le fournit
//! à la fondation, comme il fournit déjà le climat et le jour de l'année.
//!
//! Il ne porte **pas** la température non plus : c'est `Command::SetClimate`
//! qui l'impose, dérivée de la latitude et de l'altitude de la case
//! (`docs/PLAN.md` §6). Le seul point de contact est la neige au sol (voir
//! `BiomeTable::snow`).
//!
//! # Comment la table agit
//!
//! `Map::generate` tire trois champs de bruit par case — élévation, humidité,
//! et un dé de cent faces pour la dispersion — exactement comme avant cette
//! tranche. La table du biome ne fait que **déplacer les seuils** de ces trois
//! champs : c'est ce qui permet au cas tempéré de rester bit-à-bit identique à
//! la génération d'avant (voir `tests/biomes.rs`).

use serde::{Deserialize, Serialize};

use crate::animals::{SPECIES_COUNT, Species};

/// Amplitude des bruits de `crate::noise` : `fbm3` rend `0..=255`, et les parts
/// pour mille de la table sont converties en niveaux de bruit sur cette base.
pub const NOISE_SPAN: i32 = 256;

/// Épaisseur de la frange d'eau **profonde** sous le niveau d'eau, en pour
/// mille du bruit d'élévation. Constante : tous les biomes ont la même berge,
/// seul le niveau d'eau bouge.
const DEEP_SHARE: u32 = 48;

/// Épaisseur de la frange de gravier nu sous les rochers, en pour mille de la
/// bande de terre. Constante, comme `DEEP_SHARE` : c'est le piémont, il
/// accompagne les rochers où qu'ils soient.
const GRAVEL_SHARE: u32 = 135;

/// Part de la bande herbue qui est **luxuriante** (arbres et buissons à pleine
/// densité), pour mille. Le reste de l'herbe est clairsemé.
const LUSH_IN_GRASS: u32 = 660;

/// Densité d'arbres d'une case d'herbe clairsemée, en pour mille de
/// `BiomeTable::tree_density`.
const SPARSE_TREES: u32 = 250;
/// Densité de buissons d'une case d'herbe clairsemée, en pour mille de
/// `BiomeTable::bush_density`.
const SPARSE_BUSHES: u32 = 700;
/// Densité d'arbres d'une case de terre nue, en pour mille de
/// `BiomeTable::tree_density`. Aucun buisson n'y pousse.
const DIRT_TREES: u32 = 50;

/// Faces du dé des veines (voir `BiomeTable::ore_share`).
pub const ORE_DIE: u32 = 8;

/// Biomes du globe. **Les valeurs numériques sont un contrat** avec
/// `packages/world/src/biomes.ts` (`enum Biome`, lecture seule côté Rust) :
/// elles voyagent sur le fil, du serveur monde à la salle, dans le futur
/// `start.biome`. Recopiées dans l'ordre exact du fichier TypeScript.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Biome {
    Ocean = 0,
    Ice = 1,
    Tundra = 2,
    BorealForest = 3,
    /// Le défaut : c'est la carte d'avant l'arrivée des biomes, celle que
    /// `Sim::new` rend encore et que tous les tests du dépôt décrivent.
    #[default]
    TemperateForest = 4,
    Grassland = 5,
    Desert = 6,
    Savanna = 7,
    Jungle = 8,
    Mountain = 9,
}

impl Biome {
    /// Nombre de biomes : taille de tout tableau indexé par `Biome`.
    pub const COUNT: usize = 10;

    /// Tous les biomes, dans l'ordre de leurs valeurs.
    pub const ALL: [Biome; Biome::COUNT] = [
        Biome::Ocean,
        Biome::Ice,
        Biome::Tundra,
        Biome::BorealForest,
        Biome::TemperateForest,
        Biome::Grassland,
        Biome::Desert,
        Biome::Savanna,
        Biome::Jungle,
        Biome::Mountain,
    ];

    /// Relit un octet venu du réseau ou d'un vieux snapshot. **Une valeur
    /// inconnue retombe sur la forêt tempérée** : c'est la carte d'avant cette
    /// tranche, celle que tous les tests décrivent, donc le défaut le moins
    /// surprenant — et un octet aberrant ne doit pas plus arrêter une partie
    /// qu'un `Command::Hunt` sur un id inconnu.
    pub fn from_u8(v: u8) -> Biome {
        match v {
            0 => Biome::Ocean,
            1 => Biome::Ice,
            2 => Biome::Tundra,
            3 => Biome::BorealForest,
            5 => Biome::Grassland,
            6 => Biome::Desert,
            7 => Biome::Savanna,
            8 => Biome::Jungle,
            9 => Biome::Mountain,
            _ => Biome::TemperateForest,
        }
    }

    /// Le biome dont la carte est **réellement** bâtie. Seul l'océan change :
    /// on ne fonde pas une colonie en pleine mer (le serveur monde ne propose
    /// que des cases de terre, voir `docs/world.md`), et une carte entièrement
    /// noyée n'aurait ni bois, ni pierre, ni sol. Il retombe donc sur la forêt
    /// tempérée, comme une valeur inconnue.
    pub fn for_colony(self) -> Biome {
        match self {
            Biome::Ocean => Biome::TemperateForest,
            other => other,
        }
    }

    /// Nom lisible, pour les journaux et les rapports de `sim-cli`. Mêmes noms
    /// que `BIOME_NAMES` côté TypeScript.
    pub fn name(self) -> &'static str {
        match self {
            Biome::Ocean => "océan",
            Biome::Ice => "banquise",
            Biome::Tundra => "toundra",
            Biome::BorealForest => "forêt boréale",
            Biome::TemperateForest => "forêt tempérée",
            Biome::Grassland => "prairie",
            Biome::Desert => "désert",
            Biome::Savanna => "savane",
            Biome::Jungle => "jungle",
            Biome::Mountain => "montagne",
        }
    }

    /// La table de composition du biome. Fonction **pure** : même biome, même
    /// table, sur toutes les cibles.
    pub fn table(self) -> BiomeTable {
        match self.for_colony() {
            // Recopié pour l'exhaustivité : `for_colony` l'a déjà écarté.
            Biome::Ocean | Biome::TemperateForest => TEMPERATE,
            Biome::Ice => ICE,
            Biome::Tundra => TUNDRA,
            Biome::BorealForest => BOREAL,
            Biome::Grassland => GRASSLAND,
            Biome::Desert => DESERT,
            Biome::Savanna => SAVANNA,
            Biome::Jungle => JUNGLE,
            Biome::Mountain => MOUNTAIN,
        }
    }
}

/// Ce qu'un biome change à la composition d'une carte. **Tout est en entiers**,
/// et toute proportion est en **pour mille** (`0..=1000`).
///
/// Les quatre premiers champs pèsent sur ce qui pousse et ce qui se mine, les
/// trois suivants sur le découpage des sols, le dernier sur la couleur du sol.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct BiomeTable {
    /// Densité d'arbres d'une case d'herbe **luxuriante**, pour mille. Le dé de
    /// la dispersion a cent faces (`noise::scatter % 100`) : une densité qui
    /// n'est pas un multiple de dix se comporte donc comme la dizaine de pour
    /// mille au-dessus (185 vaut 190). L'herbe clairsemée reçoit `SPARSE_TREES`
    /// de cette densité, la terre nue `DIRT_TREES`.
    pub tree_density: u32,
    /// Densité de buissons à baies d'une case d'herbe luxuriante, pour mille,
    /// tirée sur le même dé juste après les arbres (`SPARSE_BUSHES` sur l'herbe
    /// clairsemée, aucun sur la terre nue).
    pub bush_density: u32,
    /// Part de la **bande de terre** (du niveau d'eau au sommet du bruit)
    /// couverte de rochers, pour mille. Une frange de gravier nu de
    /// `GRAVEL_SHARE` la précède : c'est le piémont.
    pub rock_density: u32,
    /// Part des rochers qui sont **veinés** (`Feature::OreRock`), pour mille.
    /// Le dé des veines a `ORE_DIE` faces : la part est arrondie au huitième
    /// inférieur (125 pour mille par face).
    pub ore_share: u32,
    /// Niveau d'eau, en pour mille du bruit d'élévation : sous ce niveau la
    /// case est de l'eau, et `DEEP_SHARE` plus bas elle est profonde.
    pub water_level: u32,
    /// Part de la bande de terre allouée au **sable** juste au-dessus de l'eau,
    /// pour mille : une plage sur une carte tempérée, tout le sol sur un
    /// désert. Bornée au piémont : le sable ne mange jamais les rochers.
    pub sand_share: u32,
    /// Part de la bande de sol qui est **herbue** plutôt que terre nue, pour
    /// mille. C'est un seuil sur le bruit d'**humidité**, pas sur l'élévation :
    /// l'herbe suit la pluie. `LUSH_IN_GRASS` de cette part est luxuriante.
    pub grass_share: u32,
    /// **Abondance du gibier**, en pour mille de la cadence de référence.
    ///
    /// 1000 est la cadence d'avant cette entrée — une harde tous les deux à
    /// quatre jours (`storyteller.rs`, `next_herd_at`), de deux à quatre bêtes
    /// (`animals::spawn_herd`) — et c'est la valeur de **toutes** les tables
    /// sauf `ICE` (`tests::only_the_ice_bends_the_game_rate`). Au-dessus, les
    /// hardes se pressent : le délai tiré est divisé d'autant
    /// (`BiomeTable::herd_delay`).
    ///
    /// **Le flux d'aléa ne bouge pas.** On tire le délai comme avant, dans le
    /// même ordre et pour le même nombre de tirages, puis on met le **résultat**
    /// à l'échelle : c'est ce qui garantit qu'un biome à 1000 joue exactement la
    /// même partie qu'avant (`tests/biomes.rs::the_other_biomes_draw_the_same_herds`).
    ///
    /// Pourquoi cette entrée existe : la banquise n'a ni sol ni buisson, et la
    /// chasse à la cadence de référence rend ~7 unités crues par jour quand
    /// trois colons en mangent 15 — 30 colonies éteintes sur 30, 100 % de
    /// famine (`crates/sim-cli/CAMPAIGN-FINDINGS.md` §14). Une calotte ne
    /// dégèle pas ; elle nourrit par la chasse, ou pas du tout.
    pub game_density: u32,
    /// **Composition des hardes** : un poids par espèce, dans l'ordre de
    /// `Species::ALL` (cerf, lapin, sanglier). `spawn_herd` tire
    /// `rng.below(somme des poids)` et choisit l'espèce par tranche
    /// (`BiomeTable::herd_species`).
    ///
    /// `[1, 1, 1]` est la composition d'avant cette entrée — le `below(3)` puis
    /// `Species::from_u8` d'`animals::spawn_herd` — et c'est la valeur de
    /// **toutes** les tables sauf `ICE`
    /// (`tests::only_the_ice_picks_its_herds`) : même tirage, même nombre de
    /// tirages, même espèce, donc la même partie qu'avant
    /// (`tests/biomes.rs::the_other_biomes_draw_the_same_herds`).
    ///
    /// La somme doit être non nulle : une table sans gibier ferait tirer
    /// `below(0)`, et surtout un biome dont c'est la seule nourriture n'aurait
    /// plus rien à manger.
    pub game_mix: [u32; SPECIES_COUNT],
    /// Le sol de départ est-il enneigé (`Terrain::Snow`) ?
    ///
    /// **Lien avec `climate.rs`** : la neige au sol n'y existe pas — sous
    /// `climate::FREEZING`, `weather::freeze_or_thaw` change la **pluie** en
    /// `Weather::Snow`, et rien ne blanchit les cases. Une toundra dont le
    /// climat imposé par `SetClimate` passe la moitié de l'année sous zéro
    /// devrait pourtant être blanche dès la fondation, sans attendre le premier
    /// gel (`EventKind::FirstFrost`) : c'est la génération qui la porte. Le sol
    /// enneigé ne fond donc pas plus qu'il n'apparaît — c'est une couverture
    /// permanente, pas un état météo.
    pub snow: bool,
}

impl BiomeTable {
    /// Niveau d'eau en unités du bruit d'élévation (`0..=NOISE_SPAN`).
    pub fn water_noise(self) -> i32 {
        share(NOISE_SPAN, self.water_level)
    }

    /// Sous ce niveau, l'eau est profonde (infranchissable).
    pub fn deep_noise(self) -> i32 {
        self.water_noise() - share(NOISE_SPAN, DEEP_SHARE)
    }

    /// Étendue de bruit au-dessus de l'eau : c'est la « bande de terre » dont
    /// `rock_density` et `sand_share` sont des parts.
    fn land_span(self) -> i32 {
        NOISE_SPAN - self.water_noise()
    }

    /// À partir de ce niveau, la case est un rocher.
    pub fn rock_noise(self) -> i32 {
        NOISE_SPAN - share(self.land_span(), self.rock_density)
    }

    /// À partir de ce niveau, le sol est du gravier nu (le piémont).
    pub fn gravel_noise(self) -> i32 {
        self.rock_noise() - share(self.land_span(), GRAVEL_SHARE)
    }

    /// Sous ce niveau (et au-dessus de l'eau), le sol est du sable.
    pub fn sand_noise(self) -> i32 {
        (self.water_noise() + share(self.land_span(), self.sand_share)).min(self.gravel_noise())
    }

    /// Au-dessus de cette humidité, le sol est herbu ; en dessous, terre nue.
    pub fn grass_moisture(self) -> i32 {
        share(NOISE_SPAN, 1000 - self.grass_share)
    }

    /// Cette table peut-elle rendre **une seule case cultivable** (herbe ou
    /// terre nue, voir `Map::is_soil`) ?
    ///
    /// Trois tables en sont incapables, pour deux raisons : le désert, dont le
    /// sable prend toute la bande de sol (`sand_noise` rejoint `gravel_noise`,
    /// quelle que soit l'humidité) ; la banquise et la toundra, dont le sol est
    /// blanchi (`snow`) — et « on ne cultive pas la neige »
    /// (`tests/biomes.rs::snow_is_a_ground_not_a_weather`).
    ///
    /// Cette question ne dépend **que de la table**, pas de la graine : c'est
    /// ce qui permet à `Map::ensure_resources` de garantir un potager
    /// (`map::MIN_SOIL`) là où le biome n'en promet aucun, sans jamais toucher
    /// une carte tempérée — même une carte tempérée que le bruit a laissée
    /// pauvre. Le désert n'est pas une carte malchanceuse, c'est une carte dont
    /// la **règle** interdit de semer : seule celle-là reçoit une oasis.
    pub fn has_no_soil(self) -> bool {
        self.snow || self.sand_noise() >= self.gravel_noise()
    }

    /// Au-dessus de cette humidité, l'herbe est luxuriante.
    pub fn lush_moisture(self) -> i32 {
        let grass = self.grass_moisture();
        grass + share(NOISE_SPAN - grass, 1000 - LUSH_IN_GRASS)
    }

    /// Densités (arbres, arbres + buissons) applicables à une case de sol, en
    /// pour mille, selon son humidité. À comparer au dé de cent faces multiplié
    /// par dix (voir `tree_density`).
    pub fn plant_odds(self, moisture: i32) -> (u32, u32) {
        let (trees, bushes) = if moisture > self.lush_moisture() {
            (self.tree_density, self.bush_density)
        } else if moisture > self.grass_moisture() {
            (
                self.tree_density * SPARSE_TREES / 1000,
                self.bush_density * SPARSE_BUSHES / 1000,
            )
        } else {
            (self.tree_density * DIRT_TREES / 1000, 0)
        };
        (trees, trees + bushes)
    }

    /// Délai avant la prochaine harde, `ticks` étant celui que le tirage a
    /// rendu. À 1000 il ressort inchangé — c'est l'identité, et c'est le cas de
    /// tous les biomes sauf la banquise. Jamais zéro : une harde par tick
    /// n'aurait pas de sens, et `next_herd_at` doit avancer.
    pub fn herd_delay(self, ticks: u64) -> u64 {
        (ticks * 1000 / u64::from(self.game_density)).max(1)
    }

    /// Somme des poids de `game_mix` : les faces du dé de `spawn_herd`.
    pub fn game_total(self) -> u32 {
        self.game_mix.iter().sum()
    }

    /// Espèce de la harde qui entre, `roll` étant tiré dans
    /// `0..self.game_total()`. Les tranches se suivent dans l'ordre de
    /// `Species::ALL` : à `[1, 1, 1]` c'est exactement `Species::from_u8(roll)`.
    ///
    /// Un poids nul retire l'espèce du tirage sans décaler les autres d'un
    /// tirage : c'est le résultat qui change, jamais le flux d'aléa.
    pub fn herd_species(self, roll: u32) -> Species {
        let mut acc = 0;
        for (k, &weight) in self.game_mix.iter().enumerate() {
            acc += weight;
            if roll < acc {
                return Species::ALL[k];
            }
        }
        // Inatteignable tant que `roll < game_total()` ; la dernière espèce
        // pondérée fait office de garde-fou plutôt qu'une panique.
        *Species::ALL
            .iter()
            .rev()
            .find(|s| self.game_mix[**s as usize] > 0)
            .unwrap_or(&Species::Deer)
    }

    /// Le rocher de cette case est-il veiné ? `die` est le dé des veines
    /// (`0..ORE_DIE`), tiré sur un bruit à part.
    pub fn veined(self, die: u32) -> bool {
        die * (1000 / ORE_DIE) < self.ore_share
    }
}

/// Part `per_mille` d'une étendue, en entiers.
fn share(span: i32, per_mille: u32) -> i32 {
    span * per_mille as i32 / 1000
}

/// La carte d'avant cette tranche, chiffre pour chiffre : niveau d'eau à 104,
/// plage jusqu'à 114, sol jusqu'à 184, gravier nu jusqu'à 204, rochers
/// au-dessus, herbe au-dessus de 96 d'humidité et luxuriante au-dessus de 150,
/// 18 % d'arbres et 3 % de buissons sur l'herbe luxuriante, un quart et sept
/// dixièmes de cela sur l'herbe clairsemée, 1 % d'arbres sur la terre nue, un
/// rocher sur huit veiné. **C'est la preuve de la tranche** : ces valeurs sont
/// choisies pour que les seuils calculés retombent exactement sur ceux du code
/// d'avant (voir `tests/biomes.rs`).
pub const TEMPERATE: BiomeTable = BiomeTable {
    tree_density: 180,
    bush_density: 30,
    rock_density: 345,
    ore_share: 125,
    water_level: 408,
    sand_share: 70,
    grass_share: 625,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: false,
};

/// Calotte de glace : tout est blanc, rien ne pousse, la roche affleure. Les
/// rares mares sont les seules cases d'eau (le reste est pris par le gel, que
/// la carte ne modélise pas encore).
///
/// C'est la **seule** table qui s'écarte de la faune de référence, et sur les
/// deux entrées : ni sol (`has_no_soil`) ni buisson, la chasse y est la seule
/// nourriture, et à la cadence de référence elle rend la moitié de ce qu'une
/// colonie de trois mange.
///
/// - `game_density` à 2000 : le gibier y est deux fois plus pressé qu'ailleurs
///   — la banlieue d'un trou de phoque, pas un désert blanc.
/// - `game_mix` à `[2, 1, 0]` : **deux cerfs pour un lièvre, et pas un
///   sanglier**. Le sanglier ne vit pas sur une calotte, et surtout il rend
///   la chasse à mains nues mortelle (il charge au lieu de fuir) ; le lièvre
///   ne rend que deux viandes (`Species::meat`) quand le cerf en rend douze,
///   c'est l'appoint, pas le repas.
///
/// Valeurs mesurées, rejets chiffrés :
/// `crates/sim-cli/CAMPAIGN-FINDINGS.md` §14.3.
pub const ICE: BiomeTable = BiomeTable {
    tree_density: 0,
    bush_density: 0,
    rock_density: 260,
    ore_share: 250,
    water_level: 220,
    sand_share: 0,
    grass_share: 0,
    game_density: 2000,
    game_mix: [2, 1, 0],
    snow: true,
};

/// Toundra : de la neige, quelques arbres rabougris, des rochers.
pub const TUNDRA: BiomeTable = BiomeTable {
    tree_density: 40,
    bush_density: 20,
    rock_density: 200,
    ore_share: 250,
    water_level: 260,
    sand_share: 0,
    grass_share: 600,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: true,
};

/// Taïga : forêt dense et rochers. Le sol n'est pas enneigé — c'est le climat
/// qui fait l'hiver, pas la carte.
pub const BOREAL: BiomeTable = BiomeTable {
    tree_density: 420,
    bush_density: 40,
    rock_density: 400,
    ore_share: 250,
    water_level: 380,
    sand_share: 30,
    grass_share: 800,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: false,
};

/// Prairie : de l'herbe partout, des arbres en bosquets, peu de relief.
pub const GRASSLAND: BiomeTable = BiomeTable {
    tree_density: 90,
    bush_density: 60,
    rock_density: 220,
    ore_share: 125,
    water_level: 400,
    sand_share: 50,
    grass_share: 900,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: false,
};

/// Désert : le sable couvre tout le sol, aucun buisson, quelques rochers, très
/// peu d'eau. Comme `sand_share` prend toute la bande de sol, `tree_density` ne
/// s'applique en pratique à aucune case : **les seuls arbres d'un désert sont
/// ceux du bosquet forcé** près du centre — l'oasis (voir
/// `Map::ensure_resources`). La densité reste écrite pour qu'un désert moins
/// sableux, un jour, en porte quelques-uns.
///
/// Cette table est aussi la seule, avec la banquise et la toundra, à ne pouvoir
/// rendre **aucune case cultivable** (`BiomeTable::has_no_soil`) : le sable
/// ferme la bande de sol, et `Map::is_soil` le refuse. C'est pourquoi
/// `Map::ensure_resources` y garantit un potager (`map::MIN_SOIL`) en plus du
/// bosquet et de la mare — sans lui, la campagne éteignait 30 colonies sur 30
/// par famine (`crates/sim-cli/CAMPAIGN-FINDINGS.md` §13). **Ce n'est pas
/// `bush_density` qui a été relevé**, et le rejet est chiffré là aussi : rouvrir
/// la bande de sol pour qu'un buisson ait de l'herbe fait tomber le sable sous
/// sa borne et ne garantit toujours rien — la survie devient une loterie de
/// graine.
pub const DESERT: BiomeTable = BiomeTable {
    tree_density: 20,
    bush_density: 0,
    rock_density: 240,
    ore_share: 125,
    water_level: 200,
    sand_share: 1000,
    grass_share: 150,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: false,
};

/// Savane : de l'herbe sèche, des arbres épars, des buissons.
pub const SAVANNA: BiomeTable = BiomeTable {
    tree_density: 70,
    bush_density: 50,
    rock_density: 200,
    ore_share: 125,
    water_level: 340,
    sand_share: 120,
    grass_share: 800,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: false,
};

/// Jungle : arbres et buissons très denses, presque pas de roche.
pub const JUNGLE: BiomeTable = BiomeTable {
    tree_density: 850,
    bush_density: 130,
    rock_density: 80,
    ore_share: 125,
    water_level: 360,
    sand_share: 20,
    grass_share: 1000,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: false,
};

/// Montagne : la roche domine, quelques conifères dans les vallées, des veines
/// riches. C'est le biome où l'on mine.
pub const MOUNTAIN: BiomeTable = BiomeTable {
    tree_density: 160,
    bush_density: 20,
    rock_density: 650,
    ore_share: 375,
    water_level: 330,
    sand_share: 20,
    grass_share: 700,
    game_density: 1000,
    game_mix: [1, 1, 1],
    snow: false,
};

#[cfg(test)]
mod tests {
    use super::*;

    /// Les seuils de la table tempérée retombent **exactement** sur les
    /// nombres écrits en dur dans la génération d'avant cette tranche.
    #[test]
    fn temperate_thresholds_match_the_old_generation() {
        let t = TEMPERATE;
        assert_eq!(t.deep_noise(), 92);
        assert_eq!(t.water_noise(), 104);
        assert_eq!(t.sand_noise(), 114);
        assert_eq!(t.gravel_noise(), 184);
        assert_eq!(t.rock_noise(), 204);
        assert_eq!(t.grass_moisture(), 96);
        assert_eq!(t.lush_moisture(), 150);
        // Herbe luxuriante : dé < 18 pour un arbre, < 21 pour un buisson.
        assert_eq!(t.plant_odds(200), (180, 210));
        // Herbe clairsemée : dé < 5 puis < 7.
        assert_eq!(t.plant_odds(120), (45, 66));
        // Terre nue : dé < 1, aucun buisson.
        assert_eq!(t.plant_odds(50), (9, 9));
        // Un rocher sur huit veiné.
        assert!(t.veined(0));
        for die in 1..ORE_DIE {
            assert!(!t.veined(die));
        }
    }

    #[test]
    fn unknown_byte_is_temperate_and_ocean_never_settles() {
        assert_eq!(Biome::from_u8(4), Biome::TemperateForest);
        assert_eq!(Biome::from_u8(10), Biome::TemperateForest);
        assert_eq!(Biome::from_u8(255), Biome::TemperateForest);
        assert_eq!(Biome::Ocean.for_colony(), Biome::TemperateForest);
        assert_eq!(Biome::Ocean.table(), TEMPERATE);
        for (i, b) in Biome::ALL.iter().enumerate() {
            assert_eq!(*b as usize, i);
            assert_eq!(Biome::from_u8(i as u8), *b);
        }
    }

    /// Trois biomes seulement interdisent par règle toute case cultivable, et
    /// ce sont eux — et eux seuls — qui reçoivent le potager garanti de
    /// `Map::ensure_resources`. La liste est figée ici exprès : si une table
    /// retouchée y entre ou en sort, ce test le dit, parce que ça change ce que
    /// la génération complète.
    #[test]
    fn only_the_sand_and_the_snow_forbid_farming() {
        for b in Biome::ALL {
            let t = b.table();
            let expected = matches!(b.for_colony(), Biome::Desert | Biome::Ice | Biome::Tundra);
            assert_eq!(
                t.has_no_soil(),
                expected,
                "{} : has_no_soil() = {}",
                b.name(),
                t.has_no_soil()
            );
        }
        // Le désert, c'est le sable qui ferme la bande de sol ; la toundra et
        // la banquise, c'est la neige.
        assert!(DESERT.sand_noise() >= DESERT.gravel_noise() && !DESERT.snow);
        assert!(TUNDRA.snow && TUNDRA.sand_noise() < TUNDRA.gravel_noise());
    }

    /// **Une seule table plie la cadence du gibier**, et c'est la banquise.
    /// Partout ailleurs `game_density` vaut 1000, c'est-à-dire l'identité : le
    /// délai tiré ressort tel quel, et la partie est celle d'avant l'entrée
    /// (voir `tests/biomes.rs::the_other_biomes_draw_the_same_herds`). Ce test
    /// est la garde : si une table s'écarte de 1000, elle change le jeu de son
    /// biome, et il faut le mesurer avant.
    #[test]
    fn only_the_ice_bends_the_game_rate() {
        for b in Biome::ALL {
            let t = b.table();
            if b.for_colony() == Biome::Ice {
                assert!(
                    t.game_density > 1000,
                    "banquise : {} pour mille de gibier",
                    t.game_density
                );
                continue;
            }
            assert_eq!(
                t.game_density,
                1000,
                "{} : {} pour mille de gibier, ce n'est plus la cadence de référence",
                b.name(),
                t.game_density
            );
            // 1000, c'est l'identité, y compris sur les bornes du tirage.
            for ticks in [1u64, 14_400, 28_800, 57_600] {
                assert_eq!(t.herd_delay(ticks), ticks, "{}", b.name());
            }
        }
        // La banquise presse les hardes, sans jamais annuler le délai.
        let ice = ICE;
        assert!(ice.herd_delay(28_800) < 28_800);
        assert_eq!(ice.herd_delay(0), 1);
    }

    /// **Une seule table compose ses hardes autrement**, et c'est encore la
    /// banquise. Partout ailleurs `game_mix` vaut `[1, 1, 1]`, c'est-à-dire le
    /// `below(3)` puis `Species::from_u8` d'avant l'entrée : même dé, même
    /// nombre de faces, même espèce pour chaque tirage. Ce test est la garde,
    /// comme `only_the_ice_bends_the_game_rate` l'est pour la cadence.
    #[test]
    fn only_the_ice_picks_its_herds() {
        for b in Biome::ALL {
            let t = b.table();
            assert!(
                t.game_total() > 0,
                "{} : une table sans gibier ferait tirer below(0)",
                b.name()
            );
            if b.for_colony() == Biome::Ice {
                assert_eq!(t.game_mix, [2, 1, 0], "banquise");
                // Pas un sanglier sur la calotte, et le cerf porte le repas.
                assert_eq!(t.game_total(), 3);
                assert_eq!(t.herd_species(0), Species::Deer);
                assert_eq!(t.herd_species(1), Species::Deer);
                assert_eq!(t.herd_species(2), Species::Rabbit);
                continue;
            }
            assert_eq!(
                t.game_mix,
                [1, 1, 1],
                "{} : ce n'est plus la composition de référence",
                b.name()
            );
            // `[1, 1, 1]`, c'est l'identité : le dé garde ses trois faces et
            // chacune rend l'espèce de son indice.
            assert_eq!(t.game_total(), SPECIES_COUNT as u32);
            for roll in 0..t.game_total() {
                assert_eq!(
                    t.herd_species(roll),
                    Species::from_u8(roll as u8),
                    "{} : tirage {roll}",
                    b.name()
                );
            }
        }
    }

    /// Aucune table ne peut demander plus de plantes que le dé n'a de faces,
    /// ni un niveau d'eau qui mangerait les rochers.
    #[test]
    fn every_table_is_coherent() {
        for b in Biome::ALL {
            let t = b.table();
            let name = b.name();
            assert!(
                t.tree_density + t.bush_density <= 1000,
                "{name} : {} + {} pour mille de plantes",
                t.tree_density,
                t.bush_density
            );
            assert!(t.deep_noise() > 0, "{name} : pas d'eau profonde possible");
            assert!(
                t.water_noise() < t.gravel_noise(),
                "{name} : l'eau noie le piémont"
            );
            assert!(
                t.gravel_noise() < t.rock_noise(),
                "{name} : pas de piémont sous les rochers"
            );
            assert!(
                t.rock_noise() < NOISE_SPAN,
                "{name} : aucun rocher atteignable"
            );
            assert!(t.sand_noise() >= t.water_noise());
            assert!(t.lush_moisture() >= t.grass_moisture());
        }
    }
}
