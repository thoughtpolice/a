// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Values read from a store, kept under a byte budget until they expire.

use std::hash::{BuildHasher, Hash};

use crate::DEFAULT_REVALIDATE_MS;

/// How long a cache serves what it keeps.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Policy {
    /// Entries stop being served this long before the expiry their read
    /// saw: for values that name data expiring a little earlier than they
    /// do (a manifest naming chunks written before it, say).
    pub margin_ms: i64,
    /// Entries stop being served this long after they were read, however
    /// long their value lives.
    pub revalidate_ms: i64,
}

impl Policy {
    /// No margin, revalidating after [`DEFAULT_REVALIDATE_MS`].
    pub const DEFAULT: Self = Self {
        margin_ms: 0,
        revalidate_ms: DEFAULT_REVALIDATE_MS,
    };

    /// The default policy, with `margin_ms` of margin.
    pub const fn with_margin(margin_ms: i64) -> Self {
        Self {
            margin_ms,
            ..Self::DEFAULT
        }
    }
}

impl Default for Policy {
    fn default() -> Self {
        Self::DEFAULT
    }
}

/// How long something read may be served without reading it again.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Freshness {
    /// When it expires (ms since the epoch; `None` never), as its read saw.
    pub expires_at: Option<i64>,
    /// When to read it again (ms since the epoch).
    pub revalidate_at: i64,
}

impl Freshness {
    /// Something read at `now_ms`, expiring at `expires_at`, to be read
    /// again `revalidate_ms` later.
    pub fn new(expires_at: Option<i64>, now_ms: i64, revalidate_ms: i64) -> Self {
        Self {
            expires_at,
            revalidate_at: now_ms.saturating_add(revalidate_ms),
        }
    }

    /// Whether it may still be served at `now_ms`, if it stops being served
    /// `margin_ms` before its expiry.
    pub fn serves(&self, now_ms: i64, margin_ms: i64) -> bool {
        let live = self
            .expires_at
            .is_none_or(|at| at.saturating_sub(margin_ms) > now_ms);
        live && self.revalidate_at > now_ms
    }
}

/// A value's size in bytes, toward a cache's budget.
pub trait Weigh {
    fn weight(&self) -> u64;
}

impl Weigh for bytes::Bytes {
    fn weight(&self) -> u64 {
        self.len() as u64
    }
}

impl Weigh for Vec<u8> {
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

impl<K, V: Weigh> quick_cache::Weighter<K, Entry<V>> for EntryWeight {
    fn weight(&self, _key: &K, entry: &Entry<V>) -> u64 {
        entry.value.weight() + ENTRY_OVERHEAD
    }
}

/// Values read from a store, under a byte budget, each served until the
/// expiry its read saw, as its [`Policy`] says.
pub struct ExpiringCache<K, V, S = std::hash::RandomState> {
    entries: quick_cache::sync::Cache<K, Entry<V>, EntryWeight, S>,
    policy: Policy,
    hasher: S,
}

impl<K, V, S> ExpiringCache<K, V, S>
where
    K: Eq + Hash + Clone,
    V: Weigh + Clone,
    S: BuildHasher + Clone + Default,
{
    /// A cache holding up to `capacity_bytes` of values in shards of at
    /// least `min_shard_bytes` (room for the largest value kept; see
    /// [`shard_options`](crate::shard_options)), or none for 0.
    pub fn new(capacity_bytes: u64, min_shard_bytes: u64, policy: Policy) -> Option<Self> {
        Self::with_hasher(capacity_bytes, min_shard_bytes, policy, S::default())
    }
}

impl<K, V, S> ExpiringCache<K, V, S>
where
    K: Eq + Hash + Clone,
    V: Weigh + Clone,
    S: BuildHasher + Clone,
{
    /// [`new`](Self::new), hashing keys with `hasher`.
    pub fn with_hasher(
        capacity_bytes: u64,
        min_shard_bytes: u64,
        policy: Policy,
        hasher: S,
    ) -> Option<Self> {
        if capacity_bytes == 0 {
            return None;
        }
        Some(Self {
            entries: quick_cache::sync::Cache::with_options(
                crate::shard_options(capacity_bytes, min_shard_bytes),
                EntryWeight,
                hasher.clone(),
                Default::default(),
            ),
            policy,
            hasher,
        })
    }

    /// `key`'s value and the expiry its read saw, if it is here and may
    /// still be served at `now_ms`.
    pub fn get(&self, key: &K, now_ms: i64) -> Option<(V, Option<i64>)> {
        let entry = self.entries.get(key)?;
        entry
            .freshness
            .serves(now_ms, self.policy.margin_ms)
            .then_some((entry.value, entry.freshness.expires_at))
    }

    /// Keep `value`, read as `key`'s at `now_ms`, expiring at `expires_at`.
    pub fn insert(&self, key: K, value: V, expires_at: Option<i64>, now_ms: i64) {
        let freshness = Freshness::new(expires_at, now_ms, self.policy.revalidate_ms);
        self.entries.insert(key, Entry { value, freshness });
    }

    pub fn remove(&self, key: &K) {
        self.entries.remove(key);
    }

    /// The policy entries are served by.
    pub fn policy(&self) -> Policy {
        self.policy
    }

    /// The hasher keys are hashed with.
    pub fn hasher(&self) -> &S {
        &self.hasher
    }

    /// Bytes held, by the cache's own weighing.
    pub fn weight(&self) -> u64 {
        self.entries.weight()
    }

    /// Entries held.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use bytes::Bytes;

    type Cache = ExpiringCache<[u8; 32], Bytes>;

    fn key(n: u8) -> [u8; 32] {
        [n; 32]
    }

    #[test]
    fn serves_until_short_of_expiry_or_revalidation() {
        let cache = Cache::new(1 << 20, 1 << 20, Policy::with_margin(1_000)).unwrap();
        let now = 1_000_000;
        assert!(cache.get(&key(1), now).is_none());

        cache.insert(key(1), Bytes::from_static(b"one"), Some(now + 5_000), now);
        let (value, expires_at) = cache.get(&key(1), now + 3_999).unwrap();
        assert_eq!(value, Bytes::from_static(b"one"));
        assert_eq!(expires_at, Some(now + 5_000));
        assert!(
            cache.get(&key(1), now + 4_000).is_none(),
            "within the margin of its expiry"
        );

        cache.insert(key(2), Bytes::from_static(b"two"), None, now);
        assert!(
            cache
                .get(&key(2), now + DEFAULT_REVALIDATE_MS - 1)
                .is_some()
        );
        assert!(
            cache.get(&key(2), now + DEFAULT_REVALIDATE_MS).is_none(),
            "due a read"
        );

        cache.remove(&key(2));
        assert!(cache.get(&key(2), now).is_none(), "dropped");
    }

    #[test]
    fn revalidation_follows_the_policy() {
        let policy = Policy {
            margin_ms: 0,
            revalidate_ms: 50,
        };
        let cache = Cache::new(1 << 20, 1 << 20, policy).unwrap();
        cache.insert(key(1), Bytes::from_static(b"one"), None, 100);
        assert!(cache.get(&key(1), 149).is_some());
        assert!(cache.get(&key(1), 150).is_none());
    }

    #[test]
    fn holds_no_more_than_its_budget() {
        let budget = 64 * 1024;
        let cache = Cache::new(budget, budget, Policy::DEFAULT).unwrap();
        for n in 0..=255u8 {
            cache.insert(key(n), Bytes::from(vec![0u8; 4096]), None, 0);
        }
        assert!(cache.weight() <= budget);
        assert!(cache.len() < 256);
    }

    #[test]
    fn a_zero_budget_is_no_cache() {
        assert!(Cache::new(0, 1, Policy::DEFAULT).is_none());
    }
}
