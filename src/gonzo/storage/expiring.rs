// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What the caches of things read from the store share.
//!
//! Each keeps what a read found, keyed by digest, and serves it until the
//! expiry that read saw (less a margin, for a cache whose entries name data
//! that can expire a little earlier) and, as a guard against the store
//! losing data underneath the server, for [`REVALIDATE_MS`] at most.

use crate::hashing::ContentDigest;
use crate::presence::{DigestHashBuilder, REVALIDATE_MS};

/// How long something read may be served without reading it again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct Freshness {
    /// When it expires (ms since the epoch; `None` never), as its read saw.
    pub(crate) expires_at: Option<i64>,
    /// When to read it again (ms since the epoch).
    revalidate_at: i64,
}

impl Freshness {
    /// Something read at `now_ms`, expiring at `expires_at`.
    pub(crate) fn new(expires_at: Option<i64>, now_ms: i64) -> Self {
        Self {
            expires_at,
            revalidate_at: now_ms.saturating_add(REVALIDATE_MS),
        }
    }

    /// Whether it may still be served at `now_ms`, if it stops being served
    /// `margin_ms` before its expiry.
    pub(crate) fn serves(&self, now_ms: i64, margin_ms: i64) -> bool {
        let live = self
            .expires_at
            .is_none_or(|at| at.saturating_sub(margin_ms) > now_ms);
        live && self.revalidate_at > now_ms
    }
}

/// A value's size in bytes, toward a cache's budget.
pub(crate) trait Weigh {
    fn weight(&self) -> u64;
}

impl Weigh for bytes::Bytes {
    fn weight(&self) -> u64 {
        self.len() as u64
    }
}

/// What an entry costs beyond its value: the key, the entry, and the
/// cache's own bookkeeping.
const ENTRY_OVERHEAD: u64 = 128;

#[derive(Clone)]
struct Entry<V> {
    value: V,
    freshness: Freshness,
}

#[derive(Clone)]
struct EntryWeight;

impl<V: Weigh> quick_cache::Weighter<ContentDigest, Entry<V>> for EntryWeight {
    fn weight(&self, _digest: &ContentDigest, entry: &Entry<V>) -> u64 {
        entry.value.weight() + ENTRY_OVERHEAD
    }
}

/// Values read from the store, under a byte budget.
pub(crate) struct ExpiringCache<V> {
    entries: quick_cache::sync::Cache<ContentDigest, Entry<V>, EntryWeight, DigestHashBuilder>,
    margin_ms: i64,
}

impl<V: Weigh + Clone> ExpiringCache<V> {
    /// A cache holding up to `capacity_bytes` of values in shards of at
    /// least `min_shard_bytes` (room for the largest value kept), serving
    /// each until `margin_ms` before its expiry; or none for 0.
    pub(crate) fn new(capacity_bytes: u64, min_shard_bytes: u64, margin_ms: i64) -> Option<Self> {
        if capacity_bytes == 0 {
            return None;
        }
        Some(Self {
            entries: quick_cache::sync::Cache::with_options(
                crate::db_cache::sharded_options(capacity_bytes, min_shard_bytes),
                EntryWeight,
                DigestHashBuilder,
                Default::default(),
            ),
            margin_ms,
        })
    }

    /// `digest`'s value and the expiry its read saw, if it is here and may
    /// still be served at `now_ms`.
    pub(crate) fn get(&self, digest: &ContentDigest, now_ms: i64) -> Option<(V, Option<i64>)> {
        let entry = self.entries.get(digest)?;
        entry
            .freshness
            .serves(now_ms, self.margin_ms)
            .then_some((entry.value, entry.freshness.expires_at))
    }

    /// Keep `value`, read as `digest`'s at `now_ms`, expiring at `expires_at`.
    pub(crate) fn insert(
        &self,
        digest: ContentDigest,
        value: V,
        expires_at: Option<i64>,
        now_ms: i64,
    ) {
        let freshness = Freshness::new(expires_at, now_ms);
        self.entries.insert(digest, Entry { value, freshness });
    }

    pub(crate) fn remove(&self, digest: &ContentDigest) {
        self.entries.remove(digest);
    }

    #[cfg(test)]
    pub(crate) fn weight(&self) -> u64 {
        self.entries.weight()
    }

    #[cfg(test)]
    pub(crate) fn len(&self) -> usize {
        self.entries.len()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashing::DigestFn;
    use bytes::Bytes;

    fn digest(n: u8) -> ContentDigest {
        ContentDigest::new(DigestFn::Sha256, [n; 32])
    }

    #[test]
    fn serves_until_short_of_expiry_or_revalidation() {
        let cache = ExpiringCache::<Bytes>::new(1 << 20, 1 << 20, 1_000).unwrap();
        let now = 1_000_000;
        assert!(cache.get(&digest(1), now).is_none());

        cache.insert(
            digest(1),
            Bytes::from_static(b"one"),
            Some(now + 5_000),
            now,
        );
        let (value, expires_at) = cache.get(&digest(1), now + 3_999).unwrap();
        assert_eq!(value, Bytes::from_static(b"one"));
        assert_eq!(expires_at, Some(now + 5_000));
        assert!(
            cache.get(&digest(1), now + 4_000).is_none(),
            "within the margin of its expiry"
        );

        cache.insert(digest(2), Bytes::from_static(b"two"), None, now);
        assert!(cache.get(&digest(2), now + REVALIDATE_MS - 1).is_some());
        assert!(
            cache.get(&digest(2), now + REVALIDATE_MS).is_none(),
            "due a read"
        );

        // The same hash under another function is another key.
        let other = ContentDigest::new(DigestFn::Blake3, [2; 32]);
        assert!(cache.get(&other, now).is_none());

        cache.remove(&digest(2));
        assert!(cache.get(&digest(2), now).is_none(), "dropped");
    }

    #[test]
    fn holds_no_more_than_its_budget() {
        let budget = 64 * 1024;
        let cache = ExpiringCache::<Bytes>::new(budget, budget, 0).unwrap();
        for n in 0..=255u8 {
            cache.insert(digest(n), Bytes::from(vec![0u8; 4096]), None, 0);
        }
        assert!(cache.weight() <= budget);
        assert!(cache.len() < 256);
    }

    #[test]
    fn a_zero_budget_is_no_cache() {
        assert!(ExpiringCache::<Bytes>::new(0, 1, 0).is_none());
    }
}
