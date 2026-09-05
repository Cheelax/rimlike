use serde::{Deserialize, Serialize};

use crate::noise;

/// Sol d'une case. Stocké en `u8`, lu en zéro-copie par le client. Les valeurs
/// sont un contrat avec `apps/client/src/render/terrain.ts`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Terrain {
    DeepWater = 0,
    ShallowWater = 1,
    Sand = 2,
    Grass = 3,
    Dirt = 4,
    Gravel = 5,
    WoodFloor = 6,
    StoneFloor = 7,
}

impl Terrain {
    pub fn from_u8(v: u8) -> Terrain {
        match v {
            0 => Terrain::DeepWater,
            1 => Terrain::ShallowWater,
            2 => Terrain::Sand,
            3 => Terrain::Grass,
            4 => Terrain::Dirt,
            6 => Terrain::WoodFloor,
            7 => Terrain::StoneFloor,
            _ => Terrain::Gravel,
        }
    }

    /// Coût de traversée en centièmes : 100 = vitesse nominale. `None` = infranchissable.
    pub fn move_cost(self) -> Option<u32> {
        match self {
            Terrain::DeepWater => None,
            Terrain::ShallowWater => Some(300),
            Terrain::Sand => Some(130),
            Terrain::Grass => Some(100),
            Terrain::Dirt => Some(105),
            Terrain::Gravel => Some(115),
            Terrain::WoodFloor | Terrain::StoneFloor => Some(90),
        }
    }

    pub fn walkable(self) -> bool {
        self.move_cost().is_some()
    }
}

/// Ce qui est posé sur une case. Même contrat client que `Terrain`.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Feature {
    None = 0,
    Tree = 1,
    Rock = 2,
    /// Buisson à baies mûr, récoltable.
    Bush = 3,
    /// Buisson récolté, repousse au bout d'un jour.
    BushUnripe = 4,
    WallWood = 5,
    WallStone = 6,
    DoorWood = 7,
    DoorStone = 8,
    Bed = 9,
    /// Plant en croissance (voir `Sim::crops`).
    Crop = 10,
    /// Plant mûr, à récolter.
    CropRipe = 11,
    Campfire = 12,
    /// Poste de fabrication : on y taille les armes (voir `craft`).
    /// Infranchissable comme le feu de camp : on travaille à côté.
    CraftingSpot = 13,
    /// Tombe vide : un colon peut y porter un cadavre humain (voir
    /// `pawn::Job::Bury`). Franchissable, contrairement au feu et au poste de
    /// fabrication : on marche dessus pour y déposer le mort.
    Grave = 14,
    /// Tombe occupée : plus rien à y faire, on ne la recreuse pas.
    GraveFilled = 15,
    /// Établi de recherche : on y accumule les points de `research`.
    /// Infranchissable comme le poste de fabrication : on travaille à côté.
    ResearchBench = 16,
    /// Piège à pointes armé, caché dans le sol (voir `build::BuildKind::SpikeTrap`).
    /// **Franchissable** : c'est tout l'intérêt, un ennemi marche dessus sans
    /// le voir. Les colons, eux, savent où il est et ne le traversent jamais —
    /// c'est le chemin qui l'interdit (`path::Walker`), pas la carte.
    SpikeTrap = 17,
    /// Piège déclenché : inoffensif jusqu'à ce qu'un colon le réarme
    /// (`pawn::Job::RearmTrap`). Franchissable par tout le monde, colons
    /// compris.
    SpikeTrapSprung = 18,
}

impl Feature {
    pub fn from_u8(v: u8) -> Feature {
        match v {
            1 => Feature::Tree,
            2 => Feature::Rock,
            3 => Feature::Bush,
            4 => Feature::BushUnripe,
            5 => Feature::WallWood,
            6 => Feature::WallStone,
            7 => Feature::DoorWood,
            8 => Feature::DoorStone,
            9 => Feature::Bed,
            10 => Feature::Crop,
            11 => Feature::CropRipe,
            12 => Feature::Campfire,
            13 => Feature::CraftingSpot,
            14 => Feature::Grave,
            15 => Feature::GraveFilled,
            16 => Feature::ResearchBench,
            17 => Feature::SpikeTrap,
            18 => Feature::SpikeTrapSprung,
            _ => Feature::None,
        }
    }

    /// Franchissable par n'importe qui. Les pièges à pointes le sont : ce
    /// qu'un colon en sait relève du chemin (`path::Walker`), pas de la case.
    pub fn passable(self) -> bool {
        !matches!(
            self,
            Feature::Tree
                | Feature::Rock
                | Feature::WallWood
                | Feature::WallStone
                | Feature::Campfire
                | Feature::CraftingSpot
                | Feature::ResearchBench
        )
    }

    pub fn is_wall(self) -> bool {
        matches!(self, Feature::WallWood | Feature::WallStone)
    }

    /// L'élément ferme-t-il une pièce ? Les murs, les portes (qu'on traverse,
    /// mais qui ferment) et la roche, pas les arbres ni les buissons : une
    /// futaie n'est pas un abri, et surtout couper un arbre ne doit pas faire
    /// recalculer la couche « intérieur » toutes les quatre secondes.
    pub fn blocks_room(self) -> bool {
        self.is_wall() || self.is_door() || self == Feature::Rock
    }

    /// Ce que l'élément change pour la couche « intérieur » : le fait de
    /// fermer une pièce, et celui d'être un feu (il chauffe la sienne). Deux
    /// éléments de même clé sont interchangeables pour `refresh_indoor` :
    /// c'est ce qui évite de tout recalculer quand un buisson est cueilli.
    fn room_key(self) -> u8 {
        u8::from(self.blocks_room()) | (u8::from(self == Feature::Campfire) << 1)
    }

    pub fn is_door(self) -> bool {
        matches!(self, Feature::DoorWood | Feature::DoorStone)
    }

    /// Multiplicateur de coût en centièmes.
    pub fn cost_mult(self) -> u32 {
        match self {
            Feature::Bush | Feature::BushUnripe => 150,
            Feature::DoorWood | Feature::DoorStone => 150,
            Feature::Bed => 200,
            Feature::Crop | Feature::CropRipe => 120,
            _ => 100,
        }
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Zone {
    None = 0,
    Stockpile = 1,
    Growing = 2,
}

impl Zone {
    pub fn from_u8(v: u8) -> Zone {
        match v {
            1 => Zone::Stockpile,
            2 => Zone::Growing,
            _ => Zone::None,
        }
    }
}

/// Ordre de travail posé par le joueur sur une case.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[repr(u8)]
pub enum Designation {
    None = 0,
    Chop = 1,
    Mine = 2,
    Harvest = 3,
}

impl Designation {
    pub fn from_u8(v: u8) -> Designation {
        match v {
            1 => Designation::Chop,
            2 => Designation::Mine,
            3 => Designation::Harvest,
            _ => Designation::None,
        }
    }

    /// La désignation a-t-elle un sens sur cet élément ?
    pub fn applies_to(self, f: Feature) -> bool {
        match self {
            Designation::Chop => f == Feature::Tree,
            Designation::Mine => f == Feature::Rock,
            Designation::Harvest => f == Feature::Bush,
            Designation::None => false,
        }
    }

    /// Durée du travail en ticks.
    pub fn work_ticks(self) -> u32 {
        match self {
            Designation::Chop => 240,
            Designation::Mine => 360,
            Designation::Harvest => 120,
            Designation::None => 0,
        }
    }
}

/// Rectangle inclusif, normalisé et borné à la carte.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Rect {
    pub x0: u32,
    pub y0: u32,
    pub x1: u32,
    pub y1: u32,
}

impl Rect {
    pub fn tiles(self) -> impl Iterator<Item = (u32, u32)> {
        (self.y0..=self.y1).flat_map(move |y| (self.x0..=self.x1).map(move |x| (x, y)))
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Map {
    width: u32,
    height: u32,
    tiles: Vec<u8>,
    features: Vec<u8>,
    zones: Vec<u8>,
    designations: Vec<u8>,
    /// Incrémenté à chaque changement de sol ou d'élément : le client rebâtit ses meshes.
    version: u32,
    /// Incrémenté à chaque changement de zone ou de désignation.
    overlay_version: u32,
    designation_count: u32,
    stockpile_count: u32,
    growing_count: u32,
    /// Compteurs d'éléments recherchés par les colons, pour court-circuiter les
    /// balayages de carte quand il n'y a rien à trouver.
    bed_count: u32,
    campfire_count: u32,
    crafting_spot_count: u32,
    /// Couche « intérieur », une valeur par case : 0 dehors, sinon le numéro
    /// de la pièce (1..=`ROOM_ID_MAX`). Lue en zéro-copie par le client, qui
    /// n'a qu'à tester le zéro. Recalculée paresseusement (`refresh_indoor`).
    /// **Champs ajoutés en fin de structure** : un vieux snapshot est refusé
    /// net plutôt que relu de travers.
    indoor: Vec<u8>,
    /// La couche est périmée : un mur, une porte, une roche ou un feu a changé
    /// depuis le dernier calcul.
    indoor_dirty: bool,
    /// Nombre de cases intérieures, pour court-circuiter les lectures.
    indoor_count: u32,
    /// Incrémenté à chaque recalcul effectif de la couche.
    indoor_version: u32,
    /// Feux de camp par pièce, indexé par le numéro de pièce (l'entrée 0,
    /// « dehors », reste à zéro).
    room_campfires: Vec<u32>,
    /// Tombes **vides** (`Feature::Grave`) : une tombe occupée
    /// (`Feature::GraveFilled`) ne compte plus, un colon n'a plus rien à y
    /// porter. **Champ ajouté en fin de structure** : un vieux snapshot est
    /// refusé net plutôt que relu de travers.
    grave_count: u32,
    /// Établis de recherche (`Feature::ResearchBench`), pour court-circuiter
    /// la recherche d'un poste libre. **Champ ajouté en fin de structure** :
    /// un vieux snapshot est refusé net plutôt que relu de travers.
    research_bench_count: u32,
    /// Pièges à pointes **armés** (`Feature::SpikeTrap`). Lu à chaque tick par
    /// le déclenchement et par la recherche de chemin des colons : sans piège
    /// sur la carte, ni l'un ni l'autre ne coûte quoi que ce soit. **Champs
    /// ajoutés en fin de structure** : un vieux snapshot est refusé net plutôt
    /// que relu de travers.
    trap_count: u32,
    /// Pièges déclenchés (`Feature::SpikeTrapSprung`), à réarmer : court-circuit
    /// de `Job::RearmTrap`, sur le modèle de `grave_count`.
    sprung_trap_count: u32,
    /// Couche « feu », une valeur par case : 0 éteint, sinon l'intensité
    /// (1 à `fire::FIRE_MAX`). Lue en zéro-copie par le client, comme `zones`
    /// et `indoor`. La **liste** des cases en feu vit dans `Sim::burning` :
    /// cette couche est là pour le rendu et pour les tests d'appartenance en
    /// temps constant, jamais pour être balayée. **Champs ajoutés en fin de
    /// structure** : un vieux snapshot est refusé net plutôt que relu de
    /// travers.
    fire: Vec<u8>,
    /// Cases en feu. Court-circuit de tout ce qui touche au feu : sans
    /// incendie, ni l'évaluation, ni la lutte, ni la recherche de chemin ne
    /// coûtent quoi que ce soit.
    fire_count: u32,
    /// Incrémenté à chaque changement d'intensité, comme `overlay_version` :
    /// le client rebâtit son rendu du feu quand il bouge.
    fire_version: u32,
    /// **Liste** des cases d'entrepôt, triée par `(x, y)`, tenue à jour par
    /// `set_zone`. `stockpile_count` dit s'il y a un entrepôt ; cette liste dit
    /// **où**, pour que la recherche d'une case de rangement ne balaie plus la
    /// carte (voir `Sim::find_stockpile_dest`). Une zone ne change qu'à la
    /// commande du joueur : l'insertion triée coûte un `memmove` sur une liste
    /// courte, une fois par case peinte, jamais par tick.
    ///
    /// **Sérialisée comme le reste.** Elle décide de l'avenir (c'est elle qui
    /// dit où un colon porte sa charge) : la laisser hors du snapshot en la
    /// reconstruisant à la relecture en ferait un cache non sérialisé qui
    /// influence le futur, ce que l'invariant interdit. Le prix est de deux
    /// octets par case d'entrepôt dans le snapshot, et un vieux snapshot qui
    /// n'est plus relisible. Elle reste une fonction **canonique** de la
    /// couche `zones` — même carte, même liste, toujours triée — donc elle ne
    /// peut pas désynchroniser deux clients arrivés au même état.
    /// **Champ ajouté en fin de structure** : un vieux snapshot est refusé net
    /// plutôt que relu de travers.
    stockpile_tiles: Vec<(u32, u32)>,
    /// **Liste** des tombes **vides** (`Feature::Grave`), triée par `(x, y)`,
    /// tenue à jour par `set_feature`. Même patron que `stockpile_tiles`, et
    /// pour la même raison : `grave_count` dit s'il reste une tombe, cette
    /// liste dit **où**, pour que la recherche d'une sépulture ne balaie plus
    /// la carte (voir `Sim::try_start_bury`). Une tombe se creuse ou se remplit
    /// à la commande du joueur ou à la fin d'un job, jamais par tick :
    /// l'insertion triée coûte un `memmove` sur une liste courte.
    ///
    /// **Sérialisée comme le reste** : elle décide de l'avenir (c'est elle qui
    /// dit où un colon porte un cadavre), donc elle ne peut pas être un cache
    /// reconstruit à la relecture. Elle reste une fonction **canonique** de la
    /// couche `features` — même carte, même liste, toujours triée.
    /// **Champ ajouté en fin de structure** : un vieux snapshot est refusé net
    /// plutôt que relu de travers.
    grave_tiles: Vec<(u32, u32)>,
}

/// Au-delà, la zone est trop vaste pour être une pièce : c'est le dehors.
pub const ROOM_MAX_TILES: usize = 200;
/// Numéro de pièce maximal. Les pièces surnuméraires partagent ce numéro :
/// une carte n'en a jamais autant, et la couche reste un octet par case.
pub const ROOM_ID_MAX: u8 = 255;

impl Map {
    pub fn generate(seed: u64, width: u32, height: u32) -> Map {
        let moisture_seed = seed ^ 0x77AA_1234_5678_9ABC;
        let n = (width * height) as usize;
        let mut tiles = Vec::with_capacity(n);
        let mut features = Vec::with_capacity(n);
        for y in 0..height as i32 {
            for x in 0..width as i32 {
                let elevation = noise::fbm3(seed, x, y, 32);
                let moisture = noise::fbm3(moisture_seed, x, y, 32);
                let dice = noise::scatter(seed, x, y) % 100;
                let (t, f) = if elevation < 92 {
                    (Terrain::DeepWater, Feature::None)
                } else if elevation < 104 {
                    (Terrain::ShallowWater, Feature::None)
                } else if elevation < 114 {
                    (Terrain::Sand, Feature::None)
                } else if elevation < 184 {
                    if moisture > 150 {
                        let f = if dice < 18 {
                            Feature::Tree
                        } else if dice < 21 {
                            Feature::Bush
                        } else {
                            Feature::None
                        };
                        (Terrain::Grass, f)
                    } else if moisture > 96 {
                        let f = if dice < 5 {
                            Feature::Tree
                        } else if dice < 7 {
                            Feature::Bush
                        } else {
                            Feature::None
                        };
                        (Terrain::Grass, f)
                    } else {
                        (
                            Terrain::Dirt,
                            if dice < 1 {
                                Feature::Tree
                            } else {
                                Feature::None
                            },
                        )
                    }
                } else if elevation < 204 {
                    (Terrain::Gravel, Feature::None)
                } else {
                    (Terrain::Gravel, Feature::Rock)
                };
                tiles.push(t as u8);
                features.push(f as u8);
            }
        }
        Map::from_layers(width, height, tiles, features)
    }

    /// Carte explicite (sol seul), pour les tests.
    pub fn from_tiles(width: u32, height: u32, tiles: Vec<u8>) -> Map {
        let n = tiles.len();
        Map::from_layers(width, height, tiles, vec![Feature::None as u8; n])
    }

    /// Carte explicite (sol + éléments), pour les tests.
    pub fn from_layers(width: u32, height: u32, tiles: Vec<u8>, features: Vec<u8>) -> Map {
        let n = (width * height) as usize;
        assert_eq!(tiles.len(), n);
        assert_eq!(features.len(), n);
        let bed_count = features
            .iter()
            .filter(|&&f| f == Feature::Bed as u8)
            .count() as u32;
        let campfire_count = features
            .iter()
            .filter(|&&f| f == Feature::Campfire as u8)
            .count() as u32;
        let crafting_spot_count = features
            .iter()
            .filter(|&&f| f == Feature::CraftingSpot as u8)
            .count() as u32;
        let grave_count = features
            .iter()
            .filter(|&&f| f == Feature::Grave as u8)
            .count() as u32;
        // Un seul passage sur les éléments, à la construction : ensuite la
        // liste ne bouge plus qu'à `set_feature`. Le tri est explicite : la
        // couche est parcourue par rangée, donc en ordre `(y, x)`, quand
        // `binary_search` attend l'ordre `(x, y)` du tuple.
        let mut grave_tiles: Vec<(u32, u32)> = features
            .iter()
            .enumerate()
            .filter(|&(_, &f)| f == Feature::Grave as u8)
            .map(|(i, _)| (i as u32 % width, i as u32 / width))
            .collect();
        grave_tiles.sort_unstable();
        let research_bench_count = features
            .iter()
            .filter(|&&f| f == Feature::ResearchBench as u8)
            .count() as u32;
        let trap_count = features
            .iter()
            .filter(|&&f| f == Feature::SpikeTrap as u8)
            .count() as u32;
        let sprung_trap_count = features
            .iter()
            .filter(|&&f| f == Feature::SpikeTrapSprung as u8)
            .count() as u32;
        Map {
            width,
            height,
            tiles,
            features,
            zones: vec![0; n],
            designations: vec![0; n],
            version: 0,
            overlay_version: 0,
            designation_count: 0,
            stockpile_count: 0,
            growing_count: 0,
            bed_count,
            campfire_count,
            crafting_spot_count,
            indoor: vec![0; n],
            indoor_dirty: true,
            indoor_count: 0,
            indoor_version: 0,
            room_campfires: Vec::new(),
            grave_count,
            research_bench_count,
            trap_count,
            sprung_trap_count,
            fire: vec![0; n],
            fire_count: 0,
            fire_version: 0,
            stockpile_tiles: Vec::new(),
            grave_tiles,
        }
    }

    pub fn width(&self) -> u32 {
        self.width
    }

    pub fn height(&self) -> u32 {
        self.height
    }

    pub fn in_bounds(&self, x: i32, y: i32) -> bool {
        x >= 0 && y >= 0 && (x as u32) < self.width && (y as u32) < self.height
    }

    pub fn index(&self, x: u32, y: u32) -> usize {
        debug_assert!(x < self.width && y < self.height);
        (y * self.width + x) as usize
    }

    pub fn get(&self, x: u32, y: u32) -> Terrain {
        Terrain::from_u8(self.tiles[self.index(x, y)])
    }

    pub fn feature(&self, x: u32, y: u32) -> Feature {
        Feature::from_u8(self.features[self.index(x, y)])
    }

    pub fn zone(&self, x: u32, y: u32) -> Zone {
        Zone::from_u8(self.zones[self.index(x, y)])
    }

    pub fn designation(&self, x: u32, y: u32) -> Designation {
        Designation::from_u8(self.designations[self.index(x, y)])
    }

    pub fn set_terrain(&mut self, x: u32, y: u32, t: Terrain) {
        let i = self.index(x, y);
        if self.tiles[i] != t as u8 {
            self.tiles[i] = t as u8;
            self.version += 1;
        }
    }

    pub fn set_feature(&mut self, x: u32, y: u32, f: Feature) {
        let i = self.index(x, y);
        let old = Feature::from_u8(self.features[i]);
        if old != f {
            match old {
                Feature::Bed => self.bed_count -= 1,
                Feature::Campfire => self.campfire_count -= 1,
                Feature::CraftingSpot => self.crafting_spot_count -= 1,
                Feature::Grave => {
                    self.grave_count -= 1;
                    if let Ok(k) = self.grave_tiles.binary_search(&(x, y)) {
                        self.grave_tiles.remove(k);
                    }
                }
                Feature::ResearchBench => self.research_bench_count -= 1,
                Feature::SpikeTrap => self.trap_count -= 1,
                Feature::SpikeTrapSprung => self.sprung_trap_count -= 1,
                _ => {}
            }
            match f {
                Feature::Bed => self.bed_count += 1,
                Feature::Campfire => self.campfire_count += 1,
                Feature::CraftingSpot => self.crafting_spot_count += 1,
                Feature::Grave => {
                    self.grave_count += 1;
                    if let Err(k) = self.grave_tiles.binary_search(&(x, y)) {
                        self.grave_tiles.insert(k, (x, y));
                    }
                }
                Feature::ResearchBench => self.research_bench_count += 1,
                Feature::SpikeTrap => self.trap_count += 1,
                Feature::SpikeTrapSprung => self.sprung_trap_count += 1,
                _ => {}
            }
            if old.room_key() != f.room_key() {
                self.indoor_dirty = true;
            }
            self.features[i] = f as u8;
            self.version += 1;
        }
    }

    pub fn set_zone(&mut self, x: u32, y: u32, z: Zone) {
        let i = self.index(x, y);
        let old = Zone::from_u8(self.zones[i]);
        if old != z {
            match old {
                Zone::Stockpile => {
                    self.stockpile_count -= 1;
                    if let Ok(k) = self.stockpile_tiles.binary_search(&(x, y)) {
                        self.stockpile_tiles.remove(k);
                    }
                }
                Zone::Growing => self.growing_count -= 1,
                Zone::None => {}
            }
            match z {
                Zone::Stockpile => {
                    self.stockpile_count += 1;
                    if let Err(k) = self.stockpile_tiles.binary_search(&(x, y)) {
                        self.stockpile_tiles.insert(k, (x, y));
                    }
                }
                Zone::Growing => self.growing_count += 1,
                Zone::None => {}
            }
            self.zones[i] = z as u8;
            self.overlay_version += 1;
        }
    }

    pub fn set_designation(&mut self, x: u32, y: u32, d: Designation) {
        let i = self.index(x, y);
        let old = Designation::from_u8(self.designations[i]);
        if old != d {
            if old != Designation::None {
                self.designation_count -= 1;
            }
            if d != Designation::None {
                self.designation_count += 1;
            }
            self.designations[i] = d as u8;
            self.overlay_version += 1;
        }
    }

    /// Coût de traversée combiné sol + élément. `None` = infranchissable.
    pub fn move_cost(&self, x: u32, y: u32) -> Option<u32> {
        let f = self.feature(x, y);
        if !f.passable() {
            return None;
        }
        self.get(x, y).move_cost().map(|c| c * f.cost_mult() / 100)
    }

    pub fn passable(&self, x: u32, y: u32) -> bool {
        self.move_cost(x, y).is_some()
    }

    /// Même chose, mais pour un marcheur donné : un colon connaît les pièges à
    /// pointes de la colonie et ne pose jamais le pied sur un piège **armé**
    /// (voir `path::Walker`). Un pillard, une bête ou un marchand ne savent
    /// rien : pour eux, le coût est celui de la case nue.
    ///
    /// Le feu, lui, se voit : **tout le monde** l'évite (voir
    /// `path::Walker::avoids_fire`), et il coûte cher sans être un mur — un
    /// colon cerné par les flammes traverse plutôt que de rester planté.
    pub fn move_cost_for(&self, x: u32, y: u32, walker: crate::path::Walker) -> Option<u32> {
        if walker.avoids_traps && self.feature(x, y) == Feature::SpikeTrap {
            return None;
        }
        let cost = self.move_cost(x, y)?;
        if walker.avoids_fire && self.fire[self.index(x, y)] != 0 {
            return Some(cost.saturating_mul(crate::fire::FIRE_PATH_COST_MULT));
        }
        Some(cost)
    }

    pub fn passable_for(&self, x: u32, y: u32, walker: crate::path::Walker) -> bool {
        self.move_cost_for(x, y, walker).is_some()
    }

    pub fn tiles(&self) -> &[u8] {
        &self.tiles
    }

    pub fn features(&self) -> &[u8] {
        &self.features
    }

    pub fn zones(&self) -> &[u8] {
        &self.zones
    }

    pub fn designations(&self) -> &[u8] {
        &self.designations
    }

    pub fn version(&self) -> u32 {
        self.version
    }

    pub fn overlay_version(&self) -> u32 {
        self.overlay_version
    }

    pub fn designation_count(&self) -> u32 {
        self.designation_count
    }

    pub fn stockpile_count(&self) -> u32 {
        self.stockpile_count
    }

    /// Les cases d'entrepôt, triées par `(x, y)`. C'est le domaine de toute
    /// recherche de rangement : jamais la carte entière.
    pub fn stockpile_tiles(&self) -> &[(u32, u32)] {
        &self.stockpile_tiles
    }

    pub fn growing_count(&self) -> u32 {
        self.growing_count
    }

    pub fn bed_count(&self) -> u32 {
        self.bed_count
    }

    pub fn campfire_count(&self) -> u32 {
        self.campfire_count
    }

    pub fn crafting_spot_count(&self) -> u32 {
        self.crafting_spot_count
    }

    /// Établis de recherche posés sur la carte (voir `research`).
    pub fn research_bench_count(&self) -> u32 {
        self.research_bench_count
    }

    /// Tombes vides, prêtes à recevoir un cadavre (voir `pawn::Job::Bury`).
    pub fn grave_count(&self) -> u32 {
        self.grave_count
    }

    /// Les tombes vides, triées par `(x, y)`. C'est le domaine de toute
    /// recherche de sépulture : jamais la carte entière.
    pub fn grave_tiles(&self) -> &[(u32, u32)] {
        &self.grave_tiles
    }

    /// Pièges à pointes armés (`Feature::SpikeTrap`).
    pub fn trap_count(&self) -> u32 {
        self.trap_count
    }

    /// Pièges déclenchés en attente de réarmement (`Feature::SpikeTrapSprung`).
    pub fn sprung_trap_count(&self) -> u32 {
        self.sprung_trap_count
    }

    /// Couche « feu », une valeur par case : 0 éteint, sinon l'intensité
    /// (1 à `fire::FIRE_MAX`). Vue plate, comme `zones`.
    pub fn fire(&self) -> &[u8] {
        &self.fire
    }

    /// Intensité du feu sur une case, 0 si elle ne brûle pas.
    pub fn fire_at(&self, x: u32, y: u32) -> u8 {
        self.fire[self.index(x, y)]
    }

    /// Cases en feu. Court-circuit de tout ce qui touche au feu.
    pub fn fire_count(&self) -> u32 {
        self.fire_count
    }

    /// Change à chaque changement d'intensité : le client rebâtit son rendu.
    pub fn fire_version(&self) -> u32 {
        self.fire_version
    }

    /// Pose (ou retire, avec 0) le feu sur une case. La liste des foyers vit
    /// dans `Sim::burning` : c'est elle qui décide, celle-ci ne fait
    /// qu'enregistrer. Une intensité au-delà de `fire::FIRE_MAX` est bornée.
    pub fn set_fire(&mut self, x: u32, y: u32, level: u8) {
        let level = level.min(crate::fire::FIRE_MAX);
        let i = self.index(x, y);
        let old = self.fire[i];
        if old == level {
            return;
        }
        if old == 0 {
            self.fire_count += 1;
        } else if level == 0 {
            self.fire_count -= 1;
        }
        self.fire[i] = level;
        self.fire_version += 1;
    }

    /// Couche « intérieur », une valeur par case : 0 dehors, sinon le numéro
    /// de la pièce. Vue plate, comme `zones`.
    pub fn indoor(&self) -> &[u8] {
        &self.indoor
    }

    /// Numéro de la pièce d'une case, 0 si elle est dehors.
    pub fn room(&self, x: u32, y: u32) -> u8 {
        self.indoor[self.index(x, y)]
    }

    pub fn is_indoor(&self, x: u32, y: u32) -> bool {
        self.room(x, y) != 0
    }

    pub fn indoor_count(&self) -> u32 {
        self.indoor_count
    }

    /// Change à chaque recalcul effectif de la couche « intérieur ».
    pub fn indoor_version(&self) -> u32 {
        self.indoor_version
    }

    /// Feux de camp de la pièce `room` (0 pour le dehors, qui n'en a jamais).
    pub fn room_campfires(&self, room: u8) -> u32 {
        self.room_campfires
            .get(room as usize)
            .copied()
            .unwrap_or_default()
    }

    /// La couche « intérieur » attend un recalcul.
    pub fn indoor_dirty(&self) -> bool {
        self.indoor_dirty
    }

    /// Une case ouverte au sens des pièces : ni mur, ni porte, ni roche. Le
    /// sol ne compte pas — un arbre, un feu de camp ou un étang n'arrêtent pas
    /// le remplissage, faute de quoi une île serait « à l'intérieur ».
    fn room_open(&self, i: usize) -> bool {
        !Feature::from_u8(self.features[i]).blocks_room()
    }

    /// Recalcule la couche « intérieur » si elle est périmée, sinon ne fait
    /// rien. Un remplissage par pile explicite (jamais de récursion) : chaque
    /// composante connexe de cases ouvertes est une pièce si elle ne touche
    /// pas le bord de la carte (le bord compte comme ouvert : une zone qui
    /// l'atteint est dehors) et si elle tient en `ROOM_MAX_TILES` cases.
    ///
    /// Coût : O(cases), payé au plus une fois par tick et seulement après un
    /// changement qui compte (mur, porte, roche, feu) — couper un arbre,
    /// cueillir un buisson, semer un plant ou poser un sol ne salit rien.
    pub fn refresh_indoor(&mut self) {
        if !self.indoor_dirty {
            return;
        }
        self.indoor_dirty = false;
        self.indoor_version += 1;
        self.indoor_count = 0;
        let n = (self.width * self.height) as usize;
        self.indoor.clear();
        self.indoor.resize(n, 0);
        let mut visited = vec![false; n];
        let mut stack: Vec<u32> = Vec::new();
        let mut members: Vec<u32> = Vec::new();
        let mut next_room: u32 = 1;
        for start in 0..n {
            if visited[start] || !self.room_open(start) {
                continue;
            }
            members.clear();
            stack.clear();
            stack.push(start as u32);
            visited[start] = true;
            let mut open = false;
            while let Some(t) = stack.pop() {
                members.push(t);
                let (x, y) = (t % self.width, t / self.width);
                if x == 0 || y == 0 || x + 1 == self.width || y + 1 == self.height {
                    open = true;
                }
                for (dx, dy) in [(0i32, -1i32), (0, 1), (-1, 0), (1, 0)] {
                    let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                    if !self.in_bounds(nx, ny) {
                        continue;
                    }
                    let j = (ny as u32 * self.width + nx as u32) as usize;
                    if visited[j] || !self.room_open(j) {
                        continue;
                    }
                    visited[j] = true;
                    stack.push(j as u32);
                }
            }
            if open || members.len() > ROOM_MAX_TILES {
                continue;
            }
            let id = if next_room < u32::from(ROOM_ID_MAX) {
                let id = next_room as u8;
                next_room += 1;
                id
            } else {
                ROOM_ID_MAX
            };
            for &t in &members {
                self.indoor[t as usize] = id;
            }
            self.indoor_count += members.len() as u32;
        }
        self.refresh_room_campfires(next_room);
    }

    /// Compte les feux de camp de chaque pièce. Un feu ne délimite rien : sa
    /// case porte donc elle-même le numéro de sa pièce.
    fn refresh_room_campfires(&mut self, next_room: u32) {
        let rooms = next_room.min(u32::from(ROOM_ID_MAX)) as usize + 1;
        self.room_campfires.clear();
        self.room_campfires.resize(rooms, 0);
        if self.campfire_count == 0 || self.indoor_count == 0 {
            return;
        }
        for i in 0..self.indoor.len() {
            let room = self.indoor[i];
            if room != 0 && self.features[i] == Feature::Campfire as u8 {
                self.room_campfires[room as usize] += 1;
            }
        }
    }

    /// Sol cultivable.
    pub fn is_soil(&self, x: u32, y: u32) -> bool {
        matches!(self.get(x, y), Terrain::Grass | Terrain::Dirt)
    }

    /// Rectangle normalisé et borné à la carte, `None` s'il est entièrement dehors.
    pub fn clamp_rect(&self, x0: i32, y0: i32, x1: i32, y1: i32) -> Option<Rect> {
        let (x0, x1) = (x0.min(x1), x0.max(x1));
        let (y0, y1) = (y0.min(y1), y0.max(y1));
        if x1 < 0 || y1 < 0 || x0 >= self.width as i32 || y0 >= self.height as i32 {
            return None;
        }
        Some(Rect {
            x0: x0.max(0) as u32,
            y0: y0.max(0) as u32,
            x1: x1.min(self.width as i32 - 1) as u32,
            y1: y1.min(self.height as i32 - 1) as u32,
        })
    }

    /// Case franchissable la plus proche de `(cx, cy)`, par anneaux croissants.
    /// L'ordre de parcours est fixe, donc le résultat est déterministe.
    pub fn nearest_passable(&self, cx: u32, cy: u32) -> Option<(u32, u32)> {
        let max_r = self.width.max(self.height) as i32;
        for r in 0..max_r {
            for dy in -r..=r {
                for dx in -r..=r {
                    if dx.abs() != r && dy.abs() != r {
                        continue;
                    }
                    let x = cx as i32 + dx;
                    let y = cy as i32 + dy;
                    if self.in_bounds(x, y) && self.passable(x as u32, y as u32) {
                        return Some((x as u32, y as u32));
                    }
                }
            }
        }
        None
    }
}

/// Distance de Tchebychev entre deux cases.
pub fn chebyshev(a: (u32, u32), b: (u32, u32)) -> u32 {
    a.0.abs_diff(b.0).max(a.1.abs_diff(b.1))
}
