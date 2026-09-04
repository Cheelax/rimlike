use serde::{Deserialize, Serialize};

use crate::fixed::{self, FX_HALF, Fx};
use crate::map::Map;
use crate::path::Tile;

/// Vitesse nominale : 1/256 de case par tick. 18 ≈ 4,2 cases/s à 60 ticks/s.
pub const BASE_SPEED: Fx = 18;

/// Un colon. Phase 1 : une position et un chemin. Les besoins, jobs et santé
/// arrivent en phase 2 (et avec eux le passage en ECS si le besoin se confirme).
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Pawn {
    pub id: u32,
    pub x: Fx,
    pub y: Fx,
    /// Chemin restant, inversé : `last()` est la prochaine case.
    pub path: Vec<Tile>,
    pub idle_ticks: u32,
}

impl Pawn {
    pub fn at_tile(id: u32, x: u32, y: u32) -> Pawn {
        Pawn {
            id,
            x: fixed::from_int(x as i32) + FX_HALF,
            y: fixed::from_int(y as i32) + FX_HALF,
            path: Vec::new(),
            idle_ticks: 0,
        }
    }

    pub fn tile(&self) -> (u32, u32) {
        (fixed::to_int(self.x) as u32, fixed::to_int(self.y) as u32)
    }

    pub fn is_moving(&self) -> bool {
        !self.path.is_empty()
    }

    /// Remplace le chemin courant. `path` est dans l'ordre de parcours.
    pub fn set_path(&mut self, mut path: Vec<Tile>) {
        path.reverse();
        self.path = path;
        self.idle_ticks = 0;
    }

    /// Avance d'un tick le long du chemin. La vitesse dépend du terrain de la
    /// case visée.
    pub fn advance(&mut self, map: &Map) {
        let Some(&(wx, wy)) = self.path.last() else {
            return;
        };
        let cost = map
            .get(u32::from(wx), u32::from(wy))
            .move_cost()
            .unwrap_or(100);
        let speed = i64::from(BASE_SPEED * 100 / cost as Fx).max(1);
        let tx = fixed::from_int(i32::from(wx)) + FX_HALF;
        let ty = fixed::from_int(i32::from(wy)) + FX_HALF;
        let dx = i64::from(tx - self.x);
        let dy = i64::from(ty - self.y);
        let dist = fixed::isqrt((dx * dx + dy * dy) as u64) as i64;
        if dist <= speed {
            self.x = tx;
            self.y = ty;
            self.path.pop();
        } else {
            self.x += (dx * speed / dist) as Fx;
            self.y += (dy * speed / dist) as Fx;
        }
    }
}
