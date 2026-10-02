// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Deterministic blob contents: the same (seed, id, size) always makes the
//! same bytes, so a run can upload a corpus and a later one (or another
//! worker) can name and check it without keeping it.

use bytes::Bytes;
use protos::build::bazel::remote::execution::v2::Digest;
use sha2::{Digest as _, Sha256};

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

    pub fn fill(&mut self, buf: &mut [u8]) {
        let mut chunks = buf.chunks_exact_mut(8);
        for c in &mut chunks {
            c.copy_from_slice(&self.next_u64().to_le_bytes());
        }
        let rest = chunks.into_remainder();
        let last = self.next_u64().to_le_bytes();
        rest.copy_from_slice(&last[..rest.len()]);
    }
}

/// How compressible generated contents are.
#[derive(Clone, Copy, Debug, clap::ValueEnum)]
pub enum Contents {
    /// Uniformly random bytes.
    Random,
    /// Random words from a small vocabulary, about 4:1 under zstd -3,
    /// like source code and object files.
    Text,
}

/// The bytes of blob `id` in the stream `seed`.
pub fn blob(seed: u64, id: u64, size: usize, contents: Contents) -> Bytes {
    let mut rng = Rng::keyed(&[seed, id, size as u64]);
    let mut buf = vec![0u8; size];
    match contents {
        Contents::Random => rng.fill(&mut buf),
        Contents::Text => {
            const WORDS: &[&[u8]] = &[
                b"fn ", b"let ", b"mut ", b"self", b"return ", b"impl ", b"struct ", b"{\n",
                b"}\n", b"(", b")", b";\n", b"    ", b"match ", b"Some", b"None", b"Ok(", b"Err(",
                b"=> ", b"0x", b"if ", b"else ", b"for ", b"in ", b"pub ", b"use ",
            ];
            let mut at = 0;
            while at < size {
                let word = if rng.chance(0.15) {
                    // Some entropy: identifiers.
                    let n = rng.between(3, 9) as usize;
                    let mut id = [0u8; 9];
                    for b in &mut id[..n] {
                        *b = b'a' + rng.below(26) as u8;
                    }
                    let n = n.min(size - at);
                    buf[at..at + n].copy_from_slice(&id[..n]);
                    at += n;
                    continue;
                } else {
                    WORDS[rng.below(WORDS.len() as u64) as usize]
                };
                let n = word.len().min(size - at);
                buf[at..at + n].copy_from_slice(&word[..n]);
                at += n;
            }
        }
    }
    // Stamp the id in, so equal-sized blobs never collide even for tiny sizes.
    let stamp = id.to_le_bytes();
    let n = stamp.len().min(size);
    buf[..n].copy_from_slice(&stamp[..n]);
    Bytes::from(buf)
}

pub fn digest_of(data: &[u8]) -> Digest {
    Digest {
        hash: hex::encode(Sha256::digest(data)),
        size_bytes: data.len() as i64,
    }
}

/// A digest no blob has: a hash of nothing anyone uploads.
pub fn absent_digest(seed: u64, id: u64) -> Digest {
    let mut h = Sha256::new();
    h.update(b"cache-bench absent");
    h.update(seed.to_le_bytes());
    h.update(id.to_le_bytes());
    Digest {
        hash: hex::encode(h.finalize()),
        size_bytes: 1 + (id % 4096) as i64,
    }
}

/// A blob and its digest.
#[derive(Clone)]
pub struct Blob {
    pub digest: Digest,
    pub data: Bytes,
}

impl Blob {
    pub fn new(seed: u64, id: u64, size: usize, contents: Contents) -> Self {
        let data = blob(seed, id, size, contents);
        Self {
            digest: digest_of(&data),
            data,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn blobs_are_deterministic_and_distinct() {
        for contents in [Contents::Random, Contents::Text] {
            let a = blob(7, 1, 1000, contents);
            assert_eq!(a, blob(7, 1, 1000, contents));
            assert_ne!(a, blob(7, 2, 1000, contents));
            assert_ne!(a, blob(8, 1, 1000, contents));
            assert_eq!(blob(7, 3, 5, contents).len(), 5);
        }
    }

    #[test]
    fn text_compresses() {
        let data = blob(1, 1, 1 << 20, Contents::Text);
        let packed = zstd::bulk::compress(&data, 3).unwrap();
        let ratio = data.len() as f64 / packed.len() as f64;
        assert!(ratio > 2.5, "ratio {ratio}");
    }
}
