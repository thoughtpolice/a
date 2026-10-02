// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! SlateDB's in-memory block and metadata caches, on quick_cache.
//!
//! Every lookup goes through these: a FindMissingBlobs digest consults the
//! filter of each SST in its segment. SlateDB's stock cache is foyer with
//! LRU eviction, whose hits take an exclusive lock on the shard (to move the
//! entry to the front) and whose handles take it again when dropped; with
//! every worker hitting the same few hot entries, a dial9 trace of a busy
//! server found its Tokio workers parked on those locks for 41% of their
//! off-CPU time. quick_cache's hits take a shared read lock and set a bit,
//! and its eviction (CLOCK-Pro-like) keeps the hit rate.
//!
//! quick_cache splits its budget evenly between shards (by default four per
//! CPU) and turns away any entry heavier than a shard's share. An SST of
//! small values has an index of several MiB, which a 128 MiB cache over 64
//! shards turned away every time: each lookup in such an SST read its index
//! back from disk and verified it, a quarter of a busy server's CPU. Shards
//! here are never smaller than [`MIN_SHARD_BYTES`].

use std::sync::Arc;

use slatedb::db_cache::{CacheLoader, CachedEntry, CachedKey, DbCache};

type Entries = quick_cache::sync::Cache<CachedKey, CachedEntry, EntryWeight>;

/// The least a cache shard holds. SlateDB's largest entries are SST
/// indexes, about 60 bytes for each block of the SST: 4 MiB for a 256 MiB
/// SST (its largest by default) of 4 KiB blocks.
const MIN_SHARD_BYTES: u64 = 16 * 1024 * 1024;

/// A [`DbCache`] holding at most a byte budget of entries.
pub(crate) struct QuickDbCache {
    entries: Arc<Entries>,
}

/// Entries weigh what SlateDB says they occupy.
#[derive(Clone)]
struct EntryWeight;

impl quick_cache::Weighter<CachedKey, CachedEntry> for EntryWeight {
    fn weight(&self, _key: &CachedKey, entry: &CachedEntry) -> u64 {
        entry.size() as u64
    }
}

impl QuickDbCache {
    pub(crate) fn new(capacity_bytes: u64) -> Self {
        Self {
            entries: Arc::new(quick_cache::sync::Cache::with_options(
                sharded_options(capacity_bytes, MIN_SHARD_BYTES),
                EntryWeight,
                Default::default(),
                Default::default(),
            )),
        }
    }

    /// The entry for `key`, loading it with `loader` on a miss. Concurrent
    /// misses on one key wait for a single load.
    async fn fetch(
        &self,
        key: CachedKey,
        loader: CacheLoader,
    ) -> Result<CachedEntry, slatedb::Error> {
        match self.entries.get_value_or_guard_async(&key).await {
            Ok(entry) => Ok(entry),
            Err(guard) => {
                // A failed load drops the guard, and the next caller loads.
                let entry = loader().await?;
                let _ = guard.insert(entry.clone());
                Ok(entry)
            }
        }
    }
}

/// A quick_cache of `capacity_bytes` in shards of at least `min_shard_bytes`
/// (quick_cache turns away any entry heavier than a shard's share of the
/// budget), and no more of them than quick_cache would use by default.
pub(crate) fn sharded_options(capacity_bytes: u64, min_shard_bytes: u64) -> quick_cache::Options {
    // quick_cache sizes its tables from an item estimate; blocks are a
    // few KiB, filters and indexes larger, so 4 KiB a piece errs high.
    let items = usize::try_from(capacity_bytes / 4096)
        .unwrap_or(usize::MAX)
        .clamp(1024, 1 << 22);
    let default_shards = std::thread::available_parallelism().map_or(4, |n| n.get() * 4);
    let shards = usize::try_from(capacity_bytes / min_shard_bytes)
        .unwrap_or(usize::MAX)
        .clamp(1, default_shards);
    quick_cache::OptionsBuilder::new()
        .estimated_items_capacity(items)
        .weight_capacity(capacity_bytes.max(1))
        .shards(shards)
        .build()
        .expect("valid cache options")
}

#[async_trait::async_trait]
impl DbCache for QuickDbCache {
    async fn get_block(&self, key: &CachedKey) -> Result<Option<CachedEntry>, slatedb::Error> {
        Ok(self.entries.get(key))
    }

    async fn get_index(&self, key: &CachedKey) -> Result<Option<CachedEntry>, slatedb::Error> {
        Ok(self.entries.get(key))
    }

    async fn get_filter(&self, key: &CachedKey) -> Result<Option<CachedEntry>, slatedb::Error> {
        Ok(self.entries.get(key))
    }

    async fn get_stats(&self, key: &CachedKey) -> Result<Option<CachedEntry>, slatedb::Error> {
        Ok(self.entries.get(key))
    }

    async fn insert(&self, key: CachedKey, value: CachedEntry) {
        self.entries.insert(key, value);
    }

    async fn remove(&self, key: &CachedKey) {
        self.entries.remove(key);
    }

    fn entry_count(&self) -> u64 {
        self.entries.len() as u64
    }

    async fn fetch_block(
        &self,
        key: CachedKey,
        loader: CacheLoader,
    ) -> Result<CachedEntry, slatedb::Error> {
        self.fetch(key, loader).await
    }

    async fn fetch_index(
        &self,
        key: CachedKey,
        loader: CacheLoader,
    ) -> Result<CachedEntry, slatedb::Error> {
        self.fetch(key, loader).await
    }

    async fn fetch_filter(
        &self,
        key: CachedKey,
        loader: CacheLoader,
    ) -> Result<CachedEntry, slatedb::Error> {
        self.fetch(key, loader).await
    }

    async fn fetch_stats(
        &self,
        key: CachedKey,
        loader: CacheLoader,
    ) -> Result<CachedEntry, slatedb::Error> {
        self.fetch(key, loader).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[derive(Clone)]
    struct Len;

    impl quick_cache::Weighter<u64, Vec<u8>> for Len {
        fn weight(&self, _key: &u64, value: &Vec<u8>) -> u64 {
            value.len() as u64
        }
    }

    /// The default metadata cache keeps an index as large as SlateDB's
    /// largest, alongside thousands of small entries.
    #[test]
    fn large_indexes_are_kept() {
        let capacity = crate::DEFAULT_META_CACHE_BYTES;
        let cache = quick_cache::sync::Cache::<u64, Vec<u8>, Len>::with_options(
            sharded_options(capacity, MIN_SHARD_BYTES),
            Len,
            Default::default(),
            Default::default(),
        );
        for key in 0..4096 {
            cache.insert(key, vec![0; 4096]);
        }
        cache.insert(u64::MAX, vec![0; 6 << 20]);
        assert!(cache.get(&u64::MAX).is_some());
        assert!(cache.weight() <= capacity);
    }
}
