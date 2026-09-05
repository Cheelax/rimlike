//! Virgule fixe 24.8 sur `i32` : une case = 256 unités.
//! Positions, vitesses et distances du sim vivent dans ce format.

pub type Fx = i32;

pub const FX_SHIFT: u32 = 8;
pub const FX_ONE: Fx = 1 << FX_SHIFT;
pub const FX_HALF: Fx = FX_ONE / 2;

pub const fn from_int(v: i32) -> Fx {
    v << FX_SHIFT
}

/// Partie entière (arrondi vers moins l'infini).
pub const fn to_int(v: Fx) -> i32 {
    v >> FX_SHIFT
}

pub const fn mul(a: Fx, b: Fx) -> Fx {
    (((a as i64) * (b as i64)) >> FX_SHIFT) as Fx
}

pub const fn div(a: Fx, b: Fx) -> Fx {
    (((a as i64) << FX_SHIFT) / (b as i64)) as Fx
}

/// Racine carrée entière (plancher) sur `u64`.
///
/// `u64::isqrt` est **exact** (plancher, par contrat de la bibliothèque
/// standard) et donc identique à l'octet près sur toutes les cibles : le
/// lockstep n'y perd rien. Elle remplace la boucle de Newton maison, qui
/// partait de `n` et payait une dizaine de divisions 64 bits par appel —
/// c'est-à-dire à chaque pas de chaque pawn (`Pawn::advance`). Mesuré au
/// `bench` du 2026-09-05 : environ un quart du temps du scénario `demo`.
#[inline]
pub fn isqrt(n: u64) -> u64 {
    n.isqrt()
}

/// Racine carrée en virgule fixe.
pub fn sqrt(v: Fx) -> Fx {
    debug_assert!(v >= 0);
    isqrt((v as u64) << FX_SHIFT) as Fx
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn arithmetic() {
        assert_eq!(to_int(from_int(7)), 7);
        assert_eq!(mul(from_int(3), from_int(4)), from_int(12));
        assert_eq!(div(from_int(12), from_int(4)), from_int(3));
        assert_eq!(mul(FX_HALF, FX_HALF), FX_ONE / 4);
    }

    #[test]
    fn sqrt_exact_squares() {
        assert_eq!(sqrt(from_int(16)), from_int(4));
        assert_eq!(sqrt(from_int(2)), 362); // 1.4142 * 256 = 362.0
        for n in 0..10_000u64 {
            let r = isqrt(n);
            assert!(r * r <= n && (r + 1) * (r + 1) > n);
        }
        // Le plancher tient aussi tout en haut de la plage : c'est le contrat
        // sur lequel repose le lockstep depuis le passage à `u64::isqrt`.
        for n in [
            u64::from(u32::MAX),
            1 << 40,
            (1 << 40) - 1,
            u64::MAX - 1,
            u64::MAX,
        ] {
            let r = isqrt(n);
            assert!(r.checked_mul(r).is_some_and(|s| s <= n));
            assert!((r + 1).checked_mul(r + 1).is_none_or(|s| s > n));
        }
    }
}
