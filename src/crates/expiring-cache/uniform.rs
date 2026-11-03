// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A hasher for keys that are already uniformly random.

use std::hash::{BuildHasher, Hasher};

/// Builds [`UniformHasher`]s.
#[derive(Clone, Copy, Debug, Default)]
pub struct UniformHashBuilder;

impl BuildHasher for UniformHashBuilder {
    type Hasher = UniformHasher;

    fn build_hasher(&self) -> UniformHasher {
        UniformHasher(0)
    }
}

/// For keys whose bytes are already uniformly random, such as cryptographic
/// digests: hashing the first eight bytes of each write is as good as
/// hashing them all, and much cheaper than SipHash. Not for keys an
/// adversary can choose freely, which could all be made to collide.
pub struct UniformHasher(u64);

const MULTIPLIER: u64 = 0x517c_c1b7_2722_0a95;

impl Hasher for UniformHasher {
    fn write(&mut self, bytes: &[u8]) {
        if let Some(chunk) = bytes.chunks(8).next() {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word)).wrapping_mul(MULTIPLIER);
        }
    }

    fn write_u8(&mut self, n: u8) {
        self.0 = (self.0.rotate_left(5) ^ u64::from(n)).wrapping_mul(MULTIPLIER);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keys_spread_over_the_hash_space() {
        let build = UniformHashBuilder;
        let a = build.hash_one((0u8, [1u8; 32]));
        let b = build.hash_one((0u8, [2u8; 32]));
        let c = build.hash_one((1u8, [1u8; 32]));
        assert!(a != b && a != c && b != c);
    }
}
