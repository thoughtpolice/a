// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Values that can be overwritten, kept until they expire or are written.
//!
//! A cache of values that writes can replace has to drop an entry on every
//! write, which works only while the process holding the cache is the
//! store's only writer. Dropping is not enough on its own: a read that
//! began before a write could put back what it read after the write
//! dropped it. Each write therefore also bumps a counter (one per stripe of
//! the key space), and a read keeps what it read only if its stripe's
//! counter did not move from before the read until after the entry went
//! in.

use std::hash::{BuildHasher, Hash};
use std::sync::atomic::{AtomicU64, Ordering};

use crate::expiring::{ExpiringCache, Policy, Weigh};

/// Write counters: enough that unrelated writes rarely keep a read from
/// being kept.
const STRIPES: usize = 4096;

/// Where a read of an entry began, to tell whether a write came in since.
#[derive(Clone, Copy, Debug)]
pub struct ReadStart(u64);

/// An [`ExpiringCache`] whose entries writes drop, along with whatever reads
/// under way at the time would keep.
pub struct InvalidatingCache<K, V, S = std::hash::RandomState> {
    entries: ExpiringCache<K, V, S>,
    writes: Box<[AtomicU64]>,
}

impl<K, V, S> InvalidatingCache<K, V, S>
where
    K: Eq + Hash + Clone,
    V: Weigh + Clone,
    S: BuildHasher + Clone + Default,
{
    /// A cache holding up to `capacity_bytes` of values in shards of at
    /// least `min_shard_bytes`, or none for 0.
    pub fn new(capacity_bytes: u64, min_shard_bytes: u64, policy: Policy) -> Option<Self> {
        Self::with_hasher(capacity_bytes, min_shard_bytes, policy, S::default())
    }
}

impl<K, V, S> InvalidatingCache<K, V, S>
where
    K: Eq + Hash + Clone,
    V: Weigh + Clone,
    S: BuildHasher + Clone,
{
    /// [`new`](Self::new), hashing keys with `hasher`, which also picks
    /// each key's stripe.
    pub fn with_hasher(
        capacity_bytes: u64,
        min_shard_bytes: u64,
        policy: Policy,
        hasher: S,
    ) -> Option<Self> {
        Some(Self {
            entries: ExpiringCache::with_hasher(capacity_bytes, min_shard_bytes, policy, hasher)?,
            writes: (0..STRIPES).map(|_| AtomicU64::new(0)).collect(),
        })
    }

    fn stripe(&self, key: &K) -> &AtomicU64 {
        let hash = self.entries.hasher().hash_one(key);
        &self.writes[(hash % STRIPES as u64) as usize]
    }

    /// `key`'s value, if it is here and not past its expiry or its
    /// revalidation time at `now_ms`.
    pub fn get(&self, key: &K, now_ms: i64) -> Option<V> {
        self.entries.get(key, now_ms).map(|(value, _)| value)
    }

    /// Note that a read of `key` from the store begins, for
    /// [`insert`](Self::insert) to check against.
    pub fn read_start(&self, key: &K) -> ReadStart {
        ReadStart(self.stripe(key).load(Ordering::SeqCst))
    }

    /// Keep `value`, read at `now_ms` as `key`'s (expiring at `expires_at`)
    /// by a read that began at `start`, unless a write to the same stripe
    /// has come in since.
    pub fn insert(&self, key: K, start: ReadStart, value: V, expires_at: Option<i64>, now_ms: i64) {
        let stripe = self.stripe(&key);
        if stripe.load(Ordering::SeqCst) != start.0 {
            return;
        }
        self.entries.insert(key.clone(), value, expires_at, now_ms);
        // A write that bumped the stripe after the check above may already
        // have dropped the entry, before it went in: take it out again. A
        // write bumping it later drops it itself.
        if stripe.load(Ordering::SeqCst) != start.0 {
            self.entries.remove(&key);
        }
    }

    /// Drop `key`'s entry, just written (or perhaps written: a write that
    /// failed may still have landed): what is kept of it, and what reads
    /// already under way would keep.
    pub fn invalidate(&self, key: &K) {
        self.stripe(key).fetch_add(1, Ordering::SeqCst);
        self.entries.remove(key);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    type Cache = InvalidatingCache<u64, Bytes>;

    fn cache() -> Cache {
        Cache::new(1 << 20, 1 << 20, Policy::DEFAULT).unwrap()
    }

    fn data(s: &'static str) -> Bytes {
        Bytes::from_static(s.as_bytes())
    }

    #[test]
    fn serves_until_expiry() {
        let cache = cache();
        let now = 1_000_000;
        assert_eq!(cache.get(&1, now), None);

        let start = cache.read_start(&1);
        cache.insert(1, start, data("one"), Some(now + 5_000), now);
        assert_eq!(cache.get(&1, now + 4_999), Some(data("one")));
        assert_eq!(cache.get(&1, now + 5_000), None, "expired");
    }

    #[test]
    fn a_write_drops_the_entry() {
        let cache = cache();
        let start = cache.read_start(&1);
        cache.insert(1, start, data("old"), None, 0);
        cache.invalidate(&1);
        assert_eq!(cache.get(&1, 0), None);
    }

    #[test]
    fn a_read_that_raced_a_write_is_not_kept() {
        let cache = cache();
        // The read saw the entry from before the write.
        let start = cache.read_start(&1);
        cache.invalidate(&1);
        cache.insert(1, start, data("old"), None, 0);
        assert_eq!(cache.get(&1, 0), None);

        // A read that began after the write is kept.
        let start = cache.read_start(&1);
        cache.insert(1, start, data("new"), None, 0);
        assert_eq!(cache.get(&1, 0), Some(data("new")));
    }
}
