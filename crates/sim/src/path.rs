//! A* sur grille, 8 directions, sans coupe de coin. Coûts en centièmes,
//! diagonale = coût × 1,41. Tas binaire avec numéro de séquence pour que
//! l'ordre d'exploration soit total, donc identique partout.

use core::cmp::Reverse;
use std::collections::BinaryHeap;

use crate::map::Map;

pub type Tile = (u16, u16);

const DIRS: [(i32, i32); 8] = [
    (1, 0),
    (-1, 0),
    (0, 1),
    (0, -1),
    (1, 1),
    (1, -1),
    (-1, 1),
    (-1, -1),
];

fn heuristic(a: (u32, u32), b: (u32, u32)) -> u32 {
    let dx = a.0.abs_diff(b.0);
    let dy = a.1.abs_diff(b.1);
    100 * dx.max(dy) + 41 * dx.min(dy)
}

/// Ce que celui qui marche sait de la carte. Toute la traversabilité ne
/// dépendait jusqu'ici que de la case ; le piège à pointes est le premier
/// obstacle qui dépend de **qui** passe : la colonie sait où elle a enterré ses
/// pointes, un pillard ou une bête l'apprend en marchant dessus.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Walker {
    /// Les pièges armés (`map::Feature::SpikeTrap`) sont infranchissables.
    pub avoids_traps: bool,
    /// Les cases en feu coûtent `fire::FIRE_PATH_COST_MULT` fois leur prix.
    /// Contrairement aux pièges, **tout le monde** voit le feu : ce drapeau
    /// n'est pas une propriété du marcheur mais un court-circuit, posé par
    /// `find_path_for` quand — et seulement quand — la carte brûle.
    pub avoids_fire: bool,
}

impl Walker {
    /// Celui qui ne sait rien : pillard, bête, marchand. C'est le défaut, donc
    /// ce que voient les appels historiques (`find_path`).
    pub const ANYONE: Walker = Walker {
        avoids_traps: false,
        avoids_fire: false,
    };
    /// Un membre de la colonie : il contourne ses propres pièges.
    pub const COLONIST: Walker = Walker {
        avoids_traps: true,
        avoids_fire: false,
    };
}

/// Chemin de `from` (exclu) à `to` (inclus), pour quelqu'un qui ne connaît pas
/// les pièges. `None` si `to` est inaccessible, `Some(vec![])` si `from == to`.
pub fn find_path(map: &Map, from: (u32, u32), to: (u32, u32)) -> Option<Vec<Tile>> {
    find_path_for(map, from, to, Walker::ANYONE)
}

/// Même chose pour un marcheur donné (voir `Walker`). La case de **départ**
/// n'est jamais testée : un colon posé sur un piège armé (snapshot bricolé,
/// piège réarmé sous ses pieds) doit pouvoir en repartir.
pub fn find_path_for(
    map: &Map,
    from: (u32, u32),
    to: (u32, u32),
    walker: Walker,
) -> Option<Vec<Tile>> {
    // Sans piège armé sur la carte, le marcheur averti est un marcheur comme
    // un autre : on s'épargne la lecture d'élément par case. Le feu, lui,
    // n'est l'apanage de personne : dès qu'une case brûle, tout le monde la
    // contourne — et sans feu, le drapeau reste à faux, donc gratuit.
    let walker = Walker {
        avoids_traps: walker.avoids_traps && map.trap_count() > 0,
        avoids_fire: map.fire_count() > 0,
    };
    if !map.passable_for(to.0, to.1, walker) {
        return None;
    }
    if from == to {
        return Some(Vec::new());
    }
    // Le court-circuit qui vaut toute cette page : un A\* qui **échoue**
    // explore toute la composante où se tient le marcheur avant de rendre
    // `None`, et il échoue si et seulement si la cible est ailleurs. L'index
    // de régions répond à cette question en une lecture (voir
    // `crate::regions`), et il ne répond qu'à elle : `Some(false)` est une
    // démonstration d'échec, tandis que `Some(true)` et `None` (case de départ
    // infranchissable, index périmé) laissent l'A\* trancher exactement comme
    // avant.
    //
    // Le marcheur passé ici est déjà **normalisé** (les deux lignes
    // ci-dessus) : `avoids_traps` n'est vrai que s'il y a un piège armé sur la
    // carte, ce qui est exactement la condition sous laquelle l'index tient sa
    // seconde couche. Le feu, lui, n'entre pas dans la question : il renchérit
    // la route, il ne la ferme pas.
    if map.same_region_for(from, to, walker) == Some(false) {
        return None;
    }
    let w = map.width() as usize;
    let h = map.height() as usize;
    let n = w * h;
    let start = to_index(from, w);
    let goal = to_index(to, w);

    let mut g = vec![u32::MAX; n];
    let mut came_from = vec![u32::MAX; n];
    let mut closed = vec![false; n];
    let mut heap: BinaryHeap<Reverse<(u32, u32, u32)>> = BinaryHeap::new();
    let mut seq: u32 = 0;

    g[start] = 0;
    heap.push(Reverse((heuristic(from, to), seq, start as u32)));

    while let Some(Reverse((_, _, cur))) = heap.pop() {
        let cur = cur as usize;
        if closed[cur] {
            continue;
        }
        closed[cur] = true;
        if cur == goal {
            return Some(reconstruct(&came_from, start, goal, w));
        }
        let cx = (cur % w) as i32;
        let cy = (cur / w) as i32;
        for (dx, dy) in DIRS {
            let nx = cx + dx;
            let ny = cy + dy;
            if nx < 0 || ny < 0 || nx >= w as i32 || ny >= h as i32 {
                continue;
            }
            let ni = ny as usize * w + nx as usize;
            if closed[ni] {
                continue;
            }
            let Some(cost) = map.move_cost_for(nx as u32, ny as u32, walker) else {
                continue;
            };
            let diagonal = dx != 0 && dy != 0;
            if diagonal
                && (!map.passable_for(cx as u32, ny as u32, walker)
                    || !map.passable_for(nx as u32, cy as u32, walker))
            {
                continue;
            }
            let step = if diagonal { cost * 141 / 100 } else { cost };
            let ng = g[cur] + step;
            if ng < g[ni] {
                g[ni] = ng;
                came_from[ni] = cur as u32;
                seq += 1;
                heap.push(Reverse((
                    ng + heuristic((nx as u32, ny as u32), to),
                    seq,
                    ni as u32,
                )));
            }
        }
    }
    None
}

fn to_index(t: (u32, u32), w: usize) -> usize {
    t.1 as usize * w + t.0 as usize
}

fn reconstruct(came_from: &[u32], start: usize, goal: usize, w: usize) -> Vec<Tile> {
    let mut path = Vec::new();
    let mut cur = goal;
    while cur != start {
        path.push(((cur % w) as u16, (cur / w) as u16));
        cur = came_from[cur] as usize;
    }
    path.reverse();
    path
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::map::Terrain;
    use crate::testmap::map_from;

    #[test]
    fn straight_line() {
        let m = map_from(&["....."]);
        let p = find_path(&m, (0, 0), (4, 0)).unwrap();
        assert_eq!(p, vec![(1, 0), (2, 0), (3, 0), (4, 0)]);
    }

    #[test]
    fn same_tile_is_empty_path() {
        let m = map_from(&["..."]);
        assert_eq!(find_path(&m, (1, 0), (1, 0)), Some(vec![]));
    }

    #[test]
    fn detours_around_wall() {
        let m = map_from(&[".....", ".###.", "....."]);
        let p = find_path(&m, (0, 1), (4, 1)).unwrap();
        assert_eq!(p.last(), Some(&(4, 1)));
        assert!(p.iter().all(|&(x, y)| m.passable(x as u32, y as u32)));
        assert!(p.len() >= 4);
    }

    #[test]
    fn unreachable_is_none() {
        let m = map_from(&[".#.", ".#.", ".#."]);
        assert_eq!(find_path(&m, (0, 1), (2, 1)), None);
        assert_eq!(find_path(&m, (0, 0), (1, 0)), None, "cible infranchissable");
    }

    #[test]
    fn no_corner_cutting() {
        // Pour aller de (0,0) à (1,1), la diagonale passerait entre deux rochers.
        let m = map_from(&[".#", "#."]);
        assert_eq!(find_path(&m, (0, 0), (1, 1)), None);
    }

    #[test]
    fn prefers_cheap_terrain() {
        // Ligne droite par l'eau (coût 300) contre détour par l'herbe.
        let m = map_from(&[".....", ".~~~.", "....."]);
        let p = find_path(&m, (0, 1), (4, 1)).unwrap();
        assert!(
            p.iter()
                .all(|&(x, y)| m.get(x as u32, y as u32) != Terrain::ShallowWater)
        );
    }

    #[test]
    fn deterministic() {
        let m = Map::generate(99, 96, 96);
        let from = m.nearest_passable(2, 2).unwrap();
        let to = m.nearest_passable(90, 90).unwrap();
        assert_eq!(find_path(&m, from, to), find_path(&m, from, to));
    }
}
