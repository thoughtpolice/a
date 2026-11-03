// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A small, fast, seedable generator, so that a run's arrivals, think
//! times and whatever its workload draws are the same each time.

/// xoshiro256++, seeded through splitmix64.
#[derive(Clone)]
pub struct Rng([u64; 4]);

impl Rng {
    pub fn new(seed: u64) -> Self {
        let mut s = seed;
        let mut next = || {
            s = s.wrapping_add(0x9E37_79B9_7F4A_7C15);
            let mut z = s;
            z = (z ^ (z >> 30)).wrapping_mul(0xBF58_476D_1CE4_E5B9);
            z = (z ^ (z >> 27)).wrapping_mul(0x94D0_49BB_1331_11EB);
            z ^ (z >> 31)
        };
        Self([next(), next(), next(), next()])
    }

    /// A generator for the stream named by `parts`.
    pub fn keyed(parts: &[u64]) -> Self {
        let mut h = 0xcbf2_9ce4_8422_2325u64;
        for p in parts {
            h = (h ^ p).wrapping_mul(0x0000_0100_0000_01B3).rotate_left(29);
        }
        Self::new(h)
    }

    pub fn next_u64(&mut self) -> u64 {
        let s = &mut self.0;
        let result = s[0].wrapping_add(s[3]).rotate_left(23).wrapping_add(s[0]);
        let t = s[1] << 17;
        s[2] ^= s[0];
        s[3] ^= s[1];
        s[1] ^= s[2];
        s[0] ^= s[3];
        s[2] ^= t;
        s[3] = s[3].rotate_left(45);
        result
    }

    /// Uniform in `0..n` (n > 0).
    pub fn below(&mut self, n: u64) -> u64 {
        ((u128::from(self.next_u64()) * u128::from(n)) >> 64) as u64
    }

    /// Uniform in `lo..=hi`.
    pub fn between(&mut self, lo: u64, hi: u64) -> u64 {
        lo + self.below(hi - lo + 1)
    }

    pub fn chance(&mut self, p: f64) -> bool {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64 <= p
    }

    /// Uniform in `(0, 1]`.
    pub fn unit(&mut self) -> f64 {
        ((self.next_u64() >> 11) + 1) as f64 / (1u64 << 53) as f64
    }

    /// Exponentially distributed, of mean `mean`.
    pub fn exp(&mut self, mean: f64) -> f64 {
        -mean * self.unit().ln()
    }

    pub fn fill(&mut self, buf: &mut [u8]) {
        let (chunks, rest) = buf.as_chunks_mut::<8>();
        for c in chunks {
            *c = self.next_u64().to_le_bytes();
        }
        let last = self.next_u64().to_le_bytes();
        rest.copy_from_slice(&last[..rest.len()]);
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn exponential_draws_have_their_mean() {
        let mut rng = Rng::new(3);
        let n = 200_000;
        let mean = (0..n).map(|_| rng.exp(2.5)).sum::<f64>() / n as f64;
        assert!((mean - 2.5).abs() < 0.05, "mean {mean}");
    }

    #[test]
    fn keyed_streams_are_deterministic_and_distinct() {
        let draw = |parts: &[u64]| {
            let mut rng = Rng::keyed(parts);
            [rng.next_u64(), rng.next_u64()]
        };
        assert_eq!(draw(&[1, 2]), draw(&[1, 2]));
        assert_ne!(draw(&[1, 2]), draw(&[2, 1]));
        let mut rng = Rng::new(9);
        assert!((0..1000).all(|_| (3..=5).contains(&rng.between(3, 5))));
        let mut buf = [0u8; 13];
        rng.fill(&mut buf);
        assert_ne!(buf, [0; 13]);
    }
}
