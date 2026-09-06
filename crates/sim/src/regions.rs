//! Index de régions : les composantes connexes des cases franchissables.
//!
//! **À quoi ça sert.** Un A\* qui aboutit s'arrête sur sa cible ; un A\* qui
//! **échoue** explore toute la composante où se tient le marcheur avant de
//! rendre `None`. Or il échoue si et seulement si la cible n'est pas dans la
//! même composante que lui : la question mérite mieux qu'un parcours complet.
//! Cet index la rend O(1), et il ne répond qu'à elle.
//!
//! **Deux couches, une par sorte de marcheur** (voir `path::Walker`) :
//!
//! - `anyone` : la franchissabilité **de base**, `Map::passable` — le sol et
//!   l'élément. Murs, rochers, eau profonde, arbres, feux de camp, établis
//!   ferment ; les **portes** ouvrent. C'est ce que voient un pillard, une
//!   bête, un marchand.
//! - `colonist` : la même chose, plus les **pièges à pointes armés**, qu'un
//!   membre de la colonie ne traverse jamais (`Walker::avoids_traps`). Elle
//!   n'est bâtie que s'il y a un piège armé sur la carte ; sinon les deux
//!   couches seraient identiques et la seconde reste vide, les questions
//!   retombant sur la première.
//!
//! La seconde couche n'était pas prévue : les pièges devaient rester une
//! exception que l'A\* traiterait comme avant. La mesure a dit le contraire, et
//! c'est le cœur du défaut (`crates/sim-cli/CAMPAIGN-FINDINGS.md`, §3) : le
//! joueur scripté des campagnes referme son enceinte, pose une porte, puis
//! **trois pièges juste devant**. Les trois seules cases par où l'on sort. La
//! colonie est alors murée pour elle-même — mais pas pour la carte, où portes
//! et pièges sont franchissables : une couche de base voit une seule région et
//! ne peut rien démontrer, quand la couche des colons en voit deux et démontre
//! tout. C'est cette différence qui tenait cinq graines de campagne sous
//! 1 000 ticks/s.
//!
//! **Le feu, lui, reste hors de l'index**, et c'est exact : il n'est pas un
//! mur mais un surcoût (`fire::FIRE_PATH_COST_MULT`). Il ne peut donc jamais
//! rendre une cible inatteignable.
//!
//! **Ce que l'index promet, et rien de plus.** Retirer des cases à un marcheur
//! ne peut que séparer, jamais joindre : « régions différentes » est une
//! **preuve d'échec**, « même région » ne promet rien et laisse l'A\*
//! trancher. L'index ne sert qu'à démontrer un échec — c'est toute sa sûreté.
//!
//! **Quatre voisines suffisent** alors que l'A\* en a huit. Une diagonale n'est
//! prise que si ses deux orthogonales le sont (`path::find_path_for` refuse la
//! coupe de coin) : tout chemin à huit directions se double donc d'un chemin à
//! quatre, et les deux découpages en composantes sont le même.
//!
//! **Pourquoi ce n'est pas de l'état.** Les couches sont une fonction pure de
//! `Map::tiles` et `Map::features`, tous deux sérialisés : elles sont
//! `#[serde(skip)]`, absentes du snapshot, du hash et de l'égalité de deux
//! cartes, et recalculées après chargement. Voir `Regions` pour le détail de
//! l'exception à la règle « pas de cache non sérialisé ».

use crate::map::{Feature, Terrain};

/// Numéro de région maximal. Au-delà, les régions surnuméraires partagent ce
/// numéro : elles paraissent alors **jointes** alors qu'elles ne le sont pas,
/// ce qui fait retomber l'index dans « je ne sais pas » et relance l'A\* comme
/// avant. L'erreur est donc du seul côté sûr, et une carte de jeu (128×128,
/// 16 384 cases) n'en approche jamais.
pub const REGION_ID_MAX: u16 = u16::MAX;

/// Les composantes connexes de la carte, par sorte de marcheur.
///
/// **Exception assumée à « pas de cache non sérialisé ».** L'invariant vise
/// les caches qui **influencent le futur** : `Map::stockpile_tiles` décide où
/// un colon porte sa charge, elle est donc sérialisée. Celui-ci ne décide
/// rien. Il répond à une question dont la réponse est déjà entièrement
/// déterminée par `tiles` et `features` — « ces deux cases communiquent-elles
/// pour ce marcheur ? » — et la seule chose qu'il autorise est de **ne pas
/// lancer un A\* qui aurait rendu `None`**. Deux sims dans le même état
/// sérialisé prennent les mêmes décisions, que leur index soit calculé, périmé
/// ou vide :
///
/// - `dirty` (index périmé ou jamais calculé) ⇒ toute question rend « je ne
///   sais pas » ⇒ l'A\* tourne comme avant. C'est le cas d'un snapshot qu'on
///   vient de relire, et celui d'un tick où la carte a changé sous les pieds
///   des colons ;
/// - index à jour ⇒ la réponse est celle qu'aurait donnée l'A\*.
///
/// D'où `PartialEq` toujours vrai, comme `WorkCounter` : deux cartes dans le
/// même état sont égales, index calculé ou non.
#[derive(Clone, Debug, Eq)]
pub struct Regions {
    /// Une valeur par case, franchissabilité de base : 0 infranchissable (ou
    /// couche périmée), sinon le numéro de la région (1..=`REGION_ID_MAX`).
    anyone: Vec<u16>,
    /// La même chose pour qui contourne les pièges armés. **Vide** tant qu'il
    /// n'y a pas un seul piège armé sur la carte : les questions retombent
    /// alors sur `anyone`, qui est mot pour mot la même réponse.
    colonist: Vec<u16>,
    /// La couche est périmée : un changement de sol, d'élément ou de piège a
    /// touché la franchissabilité depuis le dernier calcul. **Vrai par
    /// défaut**, donc vrai après un `#[serde(skip)]` : un snapshot relu
    /// recalcule.
    dirty: bool,
    /// Incrémentée à chaque recalcul **effectif**. Sert de version de couche
    /// et de compteur d'observation (`Sim::region_rebuilds`) : c'est par elle
    /// qu'un test vérifie que l'index n'est pas rebâti à chaque tick.
    version: u64,
    /// Régions du dernier calcul, couche de base puis couche des colons.
    counts: (u32, u32),
}

/// Une carte neuve, ou relue, n'a pas d'index : la première question le fait
/// calculer.
impl Default for Regions {
    fn default() -> Regions {
        Regions {
            anyone: Vec::new(),
            colonist: Vec::new(),
            dirty: true,
            version: 0,
            counts: (0, 0),
        }
    }
}

/// Deux cartes dans le même état sont égales, index calculé ou non : la couche
/// est dérivée, elle n'est pas de l'état (voir la documentation du type).
impl PartialEq for Regions {
    fn eq(&self, _: &Regions) -> bool {
        true
    }
}

/// Franchissable par n'importe qui, lu à plat dans les deux couches. C'est
/// `Map::move_cost` sans le calcul du coût : sol praticable **et** élément
/// franchissable.
fn passable(tile: u8, feature: u8) -> bool {
    Terrain::from_u8(tile).walkable() && Feature::from_u8(feature).passable()
}

/// Franchissable pour la colonie : la même chose, sauf un piège **armé**, que
/// personne de la maison ne traverse (`path::Walker::avoids_traps`).
fn passable_for_colonist(tile: u8, feature: u8) -> bool {
    feature != Feature::SpikeTrap as u8 && passable(tile, feature)
}

impl Regions {
    /// La couche attend un recalcul.
    pub fn dirty(&self) -> bool {
        self.dirty
    }

    /// Marque la couche périmée. Appelée par `Map::set_feature` et
    /// `Map::set_terrain`, et **seulement** quand la franchissabilité de la
    /// case change : couper un arbre, miner un rocher, armer ou désarmer un
    /// piège comptent ; semer un plant, poser un sol de bois ou cueillir un
    /// buisson ne comptent pas.
    pub fn mark_dirty(&mut self) {
        self.dirty = true;
    }

    /// Version de la couche, incrémentée à chaque recalcul effectif.
    pub fn version(&self) -> u64 {
        self.version
    }

    /// Régions du dernier calcul, couche de base puis couche des colons.
    /// Les deux sont égales tant qu'aucun piège n'est armé.
    pub fn counts(&self) -> (u32, u32) {
        self.counts
    }

    /// Numéro de région d'une case pour un marcheur qui contourne (ou non) les
    /// pièges armés. `None` si la case est infranchissable **pour lui** ou si
    /// la couche est périmée.
    ///
    /// Les deux réponses se confondent volontairement : dans les deux cas
    /// l'appelant ne peut rien démontrer et doit lancer son A\*. Une couche
    /// périmée ne ment donc jamais — elle se tait.
    pub fn id(&self, index: usize, avoids_traps: bool) -> Option<u16> {
        if self.dirty {
            return None;
        }
        let layer = if avoids_traps && !self.colonist.is_empty() {
            &self.colonist
        } else {
            &self.anyone
        };
        match layer.get(index) {
            None | Some(&0) => None,
            Some(&r) => Some(r),
        }
    }

    /// Recalcule les couches si elles sont périmées, sinon ne fait rien.
    ///
    /// Remplissage par pile explicite (jamais de récursion), en 4-connexité,
    /// dans l'ordre des indices : le résultat ne dépend d'aucun parcours
    /// hasardeux. Coût O(cases), payé au plus une fois par tick et seulement
    /// après un changement qui touche la franchissabilité — le patron de
    /// `Map::refresh_indoor`, et pour les mêmes raisons.
    ///
    /// `traps` est `Map::trap_count` : sans piège armé, la couche des colons
    /// serait la copie de l'autre, on ne la bâtit pas.
    pub fn refresh(&mut self, width: u32, height: u32, tiles: &[u8], features: &[u8], traps: u32) {
        if !self.dirty {
            return;
        }
        self.dirty = false;
        self.version += 1;
        let n = (width * height) as usize;
        let base = fill(
            &mut self.anyone,
            width,
            height,
            n,
            tiles,
            features,
            passable,
        );
        let colony = if traps == 0 {
            self.colonist.clear();
            base
        } else {
            fill(
                &mut self.colonist,
                width,
                height,
                n,
                tiles,
                features,
                passable_for_colonist,
            )
        };
        self.counts = (base, colony);
    }
}

/// Remplit une couche et rend le nombre de régions trouvées.
fn fill(
    ids: &mut Vec<u16>,
    width: u32,
    height: u32,
    n: usize,
    tiles: &[u8],
    features: &[u8],
    open: fn(u8, u8) -> bool,
) -> u32 {
    ids.clear();
    ids.resize(n, 0);
    let mut next: u16 = 1;
    let mut regions: u32 = 0;
    let mut stack: Vec<u32> = Vec::new();
    for start in 0..n {
        if ids[start] != 0 || !open(tiles[start], features[start]) {
            continue;
        }
        let id = next;
        regions += 1;
        // Saturation plutôt que débordement : au-delà, les régions paraissent
        // jointes, ce qui ne fait que rendre l'index muet.
        next = next.saturating_add(1);
        ids[start] = id;
        stack.push(start as u32);
        while let Some(t) = stack.pop() {
            let (x, y) = (t % width, t / width);
            for (dx, dy) in [(0i32, -1i32), (0, 1), (-1, 0), (1, 0)] {
                let (nx, ny) = (x as i32 + dx, y as i32 + dy);
                if nx < 0 || ny < 0 || nx >= width as i32 || ny >= height as i32 {
                    continue;
                }
                let j = (ny as u32 * width + nx as u32) as usize;
                if ids[j] != 0 || !open(tiles[j], features[j]) {
                    continue;
                }
                ids[j] = id;
                stack.push(j as u32);
            }
        }
    }
    regions
}
