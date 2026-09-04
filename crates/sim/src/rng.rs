//! Générateur xoshiro128** implémenté à la main : petit, rapide, et surtout
//! identique à l'octet près quel que soit le compilateur ou la cible.

use serde::{Deserialize, Serialize};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Rng {
    s: [u32; 4],
}

fn splitmix64(state: &mut u64) -> u64 {
    *state = state.wrapping_add(0x9E37_79B9_7F4A_7C15);
    let mut z = *state;
    z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
    z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
    z ^ (z >> 31)
}

impl Rng {
    pub fn new(seed: u64) -> Rng {
        let mut st = seed;
        let a = splitmix64(&mut st);
        let b = splitmix64(&mut st);
        let mut s = [a as u32, (a >> 32) as u32, b as u32, (b >> 32) as u32];
        if s == [0; 4] {
            s[0] = 1;
        }
        Rng { s }
    }

    pub fn next_u32(&mut self) -> u32 {
        let result = self.s[1].wrapping_mul(5).rotate_left(7).wrapping_mul(9);
        let t = self.s[1] << 9;
        self.s[2] ^= self.s[0];
        self.s[3] ^= self.s[1];
        self.s[1] ^= self.s[2];
        self.s[0] ^= self.s[3];
        self.s[2] ^= t;
        self.s[3] = self.s[3].rotate_left(11);
        result
    }

    pub fn next_u64(&mut self) -> u64 {
        let hi = u64::from(self.next_u32());
        let lo = u64::from(self.next_u32());
        (hi << 32) | lo
    }

    /// Entier uniforme dans `0..n`. `n` doit être > 0.
    pub fn below(&mut self, n: u32) -> u32 {
        debug_assert!(n > 0);
        ((u64::from(self.next_u32()) * u64::from(n)) >> 32) as u32
    }

    /// Entier uniforme dans `lo..hi`. `hi` doit être > `lo`.
    pub fn range_i32(&mut self, lo: i32, hi: i32) -> i32 {
        debug_assert!(hi > lo);
        let span = (i64::from(hi) - i64::from(lo)) as u32;
        lo.wrapping_add(self.below(span) as i32)
    }

    /// Vrai avec probabilité `num / den`.
    pub fn chance(&mut self, num: u32, den: u32) -> bool {
        self.below(den) < num
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn same_seed_same_sequence() {
        let mut a = Rng::new(12345);
        let mut b = Rng::new(12345);
        for _ in 0..1000 {
            assert_eq!(a.next_u32(), b.next_u32());
        }
    }

    #[test]
    fn different_seeds_differ() {
        let mut a = Rng::new(1);
        let mut b = Rng::new(2);
        assert_ne!(a.next_u64(), b.next_u64());
    }

    #[test]
    fn below_stays_in_range() {
        let mut r = Rng::new(7);
        for _ in 0..10_000 {
            assert!(r.below(13) < 13);
            let v = r.range_i32(-5, 5);
            assert!((-5..5).contains(&v));
        }
    }
}
