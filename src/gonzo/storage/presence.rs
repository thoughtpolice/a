// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Blobs known to be stored, and until when.
//!
//! Builds ask about the same inputs over and over (every action names the
//! same toolchain and headers), and each FindMissingBlobs answer would
//! otherwise be a point lookup through every SST of the manifest segment.
//! A blob only disappears by expiring, so "durably stored, expiring at T"
//! stays true until T: such answers are kept here and served without the
//! LSM. Only durable, positive answers are kept; absent blobs are always
//! looked up, since they may arrive at any moment.
//!
//! As a guard against the store losing data underneath the server (an
//! operator restoring an old bucket, say), an entry is only trusted for
//! [`REVALIDATE_MS`] before it is looked up again.

use std::hash::{BuildHasher, Hasher};

use crate::expiring::Freshness;
use crate::hashing::ContentDigest;

/// How long a cached answer is trusted before it is looked up again (ms).
pub(crate) const REVALIDATE_MS: i64 = 10 * 60 * 1000;

/// Entries kept: about 80 bytes each.
pub(crate) const DEFAULT_ENTRIES: usize = 1 << 20;

pub(crate) struct PresenceCache {
    known: quick_cache::sync::Cache<
        ContentDigest,
        Freshness,
        quick_cache::UnitWeighter,
        DigestHashBuilder,
    >,
}

impl PresenceCache {
    pub(crate) fn new(entries: usize) -> Self {
        Self {
            known: quick_cache::sync::Cache::with(
                entries,
                entries as u64,
                quick_cache::UnitWeighter,
                DigestHashBuilder,
                Default::default(),
            ),
        }
    }

    /// The expiry of `digest`, if it is known stored and not past either its
    /// expiry or its revalidation time at `now_ms`.
    pub(crate) fn get(&self, digest: &ContentDigest, now_ms: i64) -> Option<Option<i64>> {
        let known = self.known.get(digest)?;
        known.serves(now_ms, 0).then_some(known.expires_at)
    }

    /// Note that `digest` is durably stored, expiring at `expires_at` (or
    /// later).
    pub(crate) fn insert(&self, digest: ContentDigest, expires_at: Option<i64>, now_ms: i64) {
        self.known
            .insert(digest, Freshness::new(expires_at, now_ms));
    }
}

/// Digests are already uniformly random: hashing their first eight bytes
/// is as good as hashing them all, and much cheaper than SipHash.
#[derive(Clone, Copy, Default)]
pub(crate) struct DigestHashBuilder;

impl BuildHasher for DigestHashBuilder {
    type Hasher = DigestHasher;

    fn build_hasher(&self) -> DigestHasher {
        DigestHasher(0)
    }
}

pub(crate) struct DigestHasher(u64);

impl Hasher for DigestHasher {
    fn write(&mut self, bytes: &[u8]) {
        for chunk in bytes.chunks(8).take(1) {
            let mut word = [0u8; 8];
            word[..chunk.len()].copy_from_slice(chunk);
            self.0 = (self.0.rotate_left(5) ^ u64::from_le_bytes(word))
                .wrapping_mul(0x517c_c1b7_2722_0a95);
        }
    }

    fn write_u8(&mut self, n: u8) {
        self.0 = (self.0.rotate_left(5) ^ u64::from(n)).wrapping_mul(0x517c_c1b7_2722_0a95);
    }

    fn finish(&self) -> u64 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashing::DigestFn;

    fn digest(n: u8) -> ContentDigest {
        ContentDigest::new(DigestFn::Sha256, [n; 32])
    }

    #[test]
    fn answers_until_expiry_or_revalidation() {
        let cache = PresenceCache::new(16);
        let now = 1_000_000;
        assert_eq!(cache.get(&digest(1), now), None);

        cache.insert(digest(1), Some(now + 5_000), now);
        assert_eq!(cache.get(&digest(1), now + 4_999), Some(Some(now + 5_000)));
        assert_eq!(cache.get(&digest(1), now + 5_000), None, "expired");

        cache.insert(digest(2), None, now);
        assert_eq!(cache.get(&digest(2), now + REVALIDATE_MS - 1), Some(None));
        assert_eq!(
            cache.get(&digest(2), now + REVALIDATE_MS),
            None,
            "due a lookup"
        );

        // The same hash under another function is another blob.
        let other = ContentDigest::new(DigestFn::Blake3, [2; 32]);
        assert_eq!(cache.get(&other, now), None);
    }

    #[test]
    fn digests_spread_over_the_hash_space() {
        let build = DigestHashBuilder;
        let a = build.hash_one(digest(1));
        let b = build.hash_one(digest(2));
        let c = build.hash_one(ContentDigest::new(DigestFn::Blake3, [1; 32]));
        assert!(a != b && a != c && b != c);
    }
}
