// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! One LSM tree per kind of key.
//!
//! A store that keeps several kinds of data in one keyspace, told apart by
//! the first byte of each key, can split them into SlateDB segments
//! (RFC-0024): one LSM tree per first byte. Small, hot metadata then never
//! shares an SST or a compaction with megabytes of bulk data, a lookup of
//! one kind probes only that kind's SSTs, and compacting metadata rewrites
//! none of the bulk.

use std::borrow::Cow;

use slatedb::db_cache::CacheTarget;
use slatedb::{BlockCachePolicy, PrefixExtractor, PrefixTarget};

/// Splits a database into one segment per first byte of key.
///
/// SlateDB stamps the extractor's name into the manifest of a new database
/// and refuses to open a database with a different one (or none), so a
/// database must keep its name, and its one-byte split, for good.
#[derive(Clone, Debug)]
pub struct FirstByteSegments {
    name: Cow<'static, str>,
}

impl FirstByteSegments {
    /// An extractor named `name` (see the type's documentation).
    pub fn new(name: impl Into<Cow<'static, str>>) -> Self {
        Self { name: name.into() }
    }
}

impl PrefixExtractor for FirstByteSegments {
    fn name(&self) -> &str {
        &self.name
    }

    fn prefix_len(&self, target: &PrefixTarget) -> Option<usize> {
        let (PrefixTarget::Point(bytes) | PrefixTarget::Prefix(bytes)) = target;
        (!bytes.is_empty()).then_some(1)
    }
}

/// What a memtable flush puts in the block cache: every index and filter,
/// and the data blocks of keys starting with one of `first_bytes`, alone.
///
/// The stock policy caches every block of every flushed SST, so a flush of
/// bulk data evicts the small, hot blocks of everything else. Keep bulk
/// data out (and read it with `ReadOptions::cache_blocks` off); its
/// repeated reads are the OS page cache's, or the object store cache's.
pub fn flush_cache_policy(first_bytes: &[u8]) -> BlockCachePolicy {
    let mut targets = vec![CacheTarget::Index, CacheTarget::Filters];
    targets.extend(first_bytes.iter().map(|&byte| match byte.checked_add(1) {
        Some(next) => CacheTarget::data([byte]..[next]),
        None => CacheTarget::data([byte]..),
    }));
    BlockCachePolicy::default().with_flush_targets(&targets)
}
