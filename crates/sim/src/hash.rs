//! FNV-1a 64 bits. Volontairement trivial : la stabilité entre versions et
//! cibles compte plus que la vitesse ici. À remplacer par un hash incrémental
//! si le coût devient visible.

pub fn fnv1a64(bytes: &[u8]) -> u64 {
    let mut h: u64 = 0xCBF2_9CE4_8422_2325;
    for &b in bytes {
        h ^= u64::from(b);
        h = h.wrapping_mul(0x0100_0000_01B3);
    }
    h
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn known_vector() {
        // Vecteur de test FNV-1a 64 pour "a".
        assert_eq!(fnv1a64(b"a"), 0xAF63_DC4C_8601_EC8C);
    }
}
