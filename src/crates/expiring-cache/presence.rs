// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Keys known to be stored, and until when.
//!
//! An existence check asked over and over (a build system asking about
//! the same inputs for every action) would otherwise be a lookup each
//! time. A value that only disappears by expiring stays stored until its
//! expiry, so "stored, expiring at T" can be answered from here until T.
//! Only positive answers belong here: a key found absent may be written at
//! any moment, so absences are always looked up.

use std::hash::{BuildHasher, Hash};

use crate::DEFAULT_REVALIDATE_MS;
use crate::expiring::Freshness;

/// Keys known stored, under a budget of entries.
pub struct PresenceCache<K, S = std::hash::RandomState> {
    known: quick_cache::sync::Cache<K, Freshness, quick_cache::UnitWeighter, S>,
    revalidate_ms: i64,
}

impl<K, S> PresenceCache<K, S>
where
    K: Eq + Hash + Clone,
    S: BuildHasher + Clone + Default,
{
    /// A cache of up to `entries` keys, each trusted for
    /// [`DEFAULT_REVALIDATE_MS`] before it is looked up again.
    pub fn new(entries: usize) -> Self {
        Self::with_hasher(entries, DEFAULT_REVALIDATE_MS, S::default())
    }
}

impl<K, S> PresenceCache<K, S>
where
    K: Eq + Hash + Clone,
    S: BuildHasher + Clone,
{
    /// A cache of up to `entries` keys (at least one), each trusted for
    /// `revalidate_ms`, hashing keys with `hasher`.
    pub fn with_hasher(entries: usize, revalidate_ms: i64, hasher: S) -> Self {
        let entries = entries.max(1);
        Self {
            known: quick_cache::sync::Cache::with(
                entries,
                entries as u64,
                quick_cache::UnitWeighter,
                hasher,
                Default::default(),
            ),
            revalidate_ms,
        }
    }

    /// The expiry of `key`, if it is known stored and not past either its
    /// expiry or its revalidation time at `now_ms`.
    pub fn get(&self, key: &K, now_ms: i64) -> Option<Option<i64>> {
        let known = self.known.get(key)?;
        known.serves(now_ms, 0).then_some(known.expires_at)
    }

    /// Note that `key` is stored, expiring at `expires_at` (or later), as
    /// of `now_ms`.
    pub fn insert(&self, key: K, expires_at: Option<i64>, now_ms: i64) {
        self.known
            .insert(key, Freshness::new(expires_at, now_ms, self.revalidate_ms));
    }

    /// Forget `key`: it was found missing after all.
    pub fn remove(&self, key: &K) {
        self.known.remove(key);
    }

    /// Keys held.
    pub fn len(&self) -> usize {
        self.known.len()
    }

    pub fn is_empty(&self) -> bool {
        self.known.is_empty()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn answers_until_expiry_or_revalidation() {
        let cache = PresenceCache::<u64>::new(16);
        let now = 1_000_000;
        assert_eq!(cache.get(&1, now), None);

        cache.insert(1, Some(now + 5_000), now);
        assert_eq!(cache.get(&1, now + 4_999), Some(Some(now + 5_000)));
        assert_eq!(cache.get(&1, now + 5_000), None, "expired");

        cache.insert(2, None, now);
        assert_eq!(cache.get(&2, now + DEFAULT_REVALIDATE_MS - 1), Some(None));
        assert_eq!(
            cache.get(&2, now + DEFAULT_REVALIDATE_MS),
            None,
            "due a lookup"
        );

        cache.remove(&2);
        assert_eq!(cache.get(&2, now), None);
    }

    #[test]
    fn holds_no_more_than_its_entries() {
        let cache = PresenceCache::<u64>::new(64);
        for n in 0..1024 {
            cache.insert(n, None, 0);
        }
        assert!(cache.len() <= 64, "{}", cache.len());
    }
}
