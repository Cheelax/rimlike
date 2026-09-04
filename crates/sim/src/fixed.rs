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

/// Racine carrée entière (plancher) sur `u64`, par Newton.
pub fn isqrt(n: u64) -> u64 {
    if n < 2 {
        return n;
    }
    let mut x = n;
    let mut y = x.div_ceil(2);
    while y < x {
        x = y;
        y = (x + n / x) / 2;
    }
    x
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
    }
}
