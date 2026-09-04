//! Bruit de valeur en arithmétique entière. Toutes les fonctions sont pures :
//! même seed, mêmes coordonnées, même résultat, quelle que soit la cible.

fn hash2(seed: u64, x: i32, y: i32) -> u32 {
    let mut h = seed
        ^ (x as u32 as u64).wrapping_mul(0x9E37_79B9_7F4A_7C15)
        ^ ((y as u32 as u64) << 32).wrapping_mul(0xC2B2_AE3D_27D4_EB4F);
    h ^= h >> 30;
    h = h.wrapping_mul(0xBF58_476D_1CE4_E5B9);
    h ^= h >> 27;
    h = h.wrapping_mul(0x94D0_49BB_1331_11EB);
    h ^= h >> 31;
    (h >> 32) as u32
}

/// Valeur de coin dans `0..=255`.
fn corner(seed: u64, cx: i32, cy: i32) -> i32 {
    (hash2(seed, cx, cy) >> 24) as i32
}

/// Interpolation linéaire avec `t` dans `0..=256`.
fn lerp(a: i32, b: i32, t: i32) -> i32 {
    a + (((b - a) * t) >> 8)
}

fn smooth(t: i32) -> i32 {
    // 3t² - 2t³ avec t dans 0..=256, résultat dans 0..=256.
    let t2 = (t * t) >> 8;
    let t3 = (t2 * t) >> 8;
    3 * t2 - 2 * t3
}

/// Bruit de valeur lissé, résultat dans `0..=255`. `cell` est la taille d'une
/// cellule en cases (puissance de deux).
pub fn value_noise(seed: u64, x: i32, y: i32, cell: i32) -> i32 {
    debug_assert!(cell > 0 && (cell & (cell - 1)) == 0);
    let cx = x.div_euclid(cell);
    let cy = y.div_euclid(cell);
    let fx = (x.rem_euclid(cell) * 256) / cell;
    let fy = (y.rem_euclid(cell) * 256) / cell;
    let sx = smooth(fx);
    let sy = smooth(fy);
    let top = lerp(corner(seed, cx, cy), corner(seed, cx + 1, cy), sx);
    let bottom = lerp(corner(seed, cx, cy + 1), corner(seed, cx + 1, cy + 1), sx);
    lerp(top, bottom, sy)
}

/// Deux octaves, résultat dans `0..=255`.
pub fn fbm2(seed: u64, x: i32, y: i32, cell: i32) -> i32 {
    let a = value_noise(seed, x, y, cell);
    let b = value_noise(seed ^ 0xA5A5_5A5A, x, y, cell / 2);
    (a * 2 + b) / 3
}

/// Trois octaves, résultat dans `0..=255`. `cell` doit être >= 4.
pub fn fbm3(seed: u64, x: i32, y: i32, cell: i32) -> i32 {
    let a = value_noise(seed, x, y, cell);
    let b = value_noise(seed ^ 0xA5A5_5A5A, x, y, cell / 2);
    let c = value_noise(seed ^ 0x3C3C_C3C3, x, y, cell / 4);
    (a * 4 + b * 2 + c) / 7
}

/// Dé non lissé par case, pour la dispersion d'objets.
pub fn scatter(seed: u64, x: i32, y: i32) -> u32 {
    hash2(seed ^ 0x5CA7_7E12, x, y)
}
