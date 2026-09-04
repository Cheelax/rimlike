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

/// Chemin de `from` (exclu) à `to` (inclus). `None` si `to` est inaccessible.
/// `Some(vec![])` si `from == to`.
pub fn find_path(map: &Map, from: (u32, u32), to: (u32, u32)) -> Option<Vec<Tile>> {
    if !map.passable(to.0, to.1) {
        return None;
    }
    if from == to {
        return Some(Vec::new());
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
            let Some(cost) = map.move_cost(nx as u32, ny as u32) else {
                continue;
            };
            let diagonal = dx != 0 && dy != 0;
            if diagonal
                && (!map.passable(cx as u32, ny as u32) || !map.passable(nx as u32, cy as u32))
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
