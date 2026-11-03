// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Action cache entries recently read, kept whole.
//!
//! GetActionResult is the call a build makes for every action, and a hit is
//! one point lookup, which SlateDB spends mostly on reference counting
//! shared by every core (see `small_blobs`). Entries read are kept here,
//! under a byte budget, until the expiry their read saw (see
//! [`expiring_cache`]).
//!
//! Unlike a blob, an entry can be overwritten. This process is the store's
//! only writer, so every write, once durable, drops the entry from here,
//! along with what reads racing it would keep (see
//! [`expiring_cache::InvalidatingCache`]).

use bytes::Bytes;
use expiring_cache::{InvalidatingCache, Policy, UniformHashBuilder};

use reapi_cas::ContentDigest;

pub(crate) use expiring_cache::ReadStart;

/// The budget when none is given: hundreds of thousands of typical entries.
pub const DEFAULT_ACTION_RESULT_CACHE_BYTES: u64 = 64 * 1024 * 1024;

/// The least a shard of the cache holds: room for large entries (an action
/// with thousands of outputs), which a smaller share of the budget would
/// turn away.
const MIN_SHARD_BYTES: u64 = 1024 * 1024;

pub(crate) struct ActionResultCache {
    entries: InvalidatingCache<ContentDigest, Bytes, UniformHashBuilder>,
}

impl ActionResultCache {
    /// A cache holding up to `capacity_bytes` of entries, or none for 0.
    pub(crate) fn new(capacity_bytes: u64) -> Option<Self> {
        let entries = InvalidatingCache::new(capacity_bytes, MIN_SHARD_BYTES, Policy::DEFAULT)?;
        Some(Self { entries })
    }

    /// `digest`'s entry, if it is here and not past its expiry or its
    /// revalidation time at `now_ms`.
    pub(crate) fn get(&self, digest: &ContentDigest, now_ms: i64) -> Option<Bytes> {
        self.entries.get(digest, now_ms)
    }

    /// Note that a read of `digest`'s entry from the store begins, for
    /// [`insert`](Self::insert) to check against.
    pub(crate) fn read_start(&self, digest: &ContentDigest) -> ReadStart {
        self.entries.read_start(digest)
    }

    /// Keep `data`, read at `now_ms` as `digest`'s entry (expiring at
    /// `expires_at`) by a read that began at `start`, unless a write to
    /// it may have come in since.
    pub(crate) fn insert(
        &self,
        digest: ContentDigest,
        start: ReadStart,
        data: Bytes,
        expires_at: Option<i64>,
        now_ms: i64,
    ) {
        // A copy: the store hands out slices of the blocks it reads, and an
        // entry holding one would keep the whole block.
        let data = Bytes::copy_from_slice(&data);
        self.entries.insert(digest, start, data, expires_at, now_ms);
    }

    /// Drop `digest`'s entry, just written: what is kept of it, and what
    /// reads already under way would keep.
    pub(crate) fn invalidate(&self, digest: &ContentDigest) {
        self.entries.invalidate(digest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use reapi_cas::DigestFn;

    fn digest(n: u8) -> ContentDigest {
        ContentDigest::new(DigestFn::Sha256, [n; 32])
    }

    fn data(s: &'static str) -> Bytes {
        Bytes::from_static(s.as_bytes())
    }

    #[test]
    fn serves_until_expiry() {
        let cache = ActionResultCache::new(1 << 20).unwrap();
        let now = 1_000_000;
        assert_eq!(cache.get(&digest(1), now), None);

        let start = cache.read_start(&digest(1));
        cache.insert(digest(1), start, data("one"), Some(now + 5_000), now);
        assert_eq!(cache.get(&digest(1), now + 4_999), Some(data("one")));
        assert_eq!(cache.get(&digest(1), now + 5_000), None, "expired");
    }

    #[test]
    fn a_write_drops_the_entry() {
        let cache = ActionResultCache::new(1 << 20).unwrap();
        let start = cache.read_start(&digest(1));
        cache.insert(digest(1), start, data("old"), None, 0);
        cache.invalidate(&digest(1));
        assert_eq!(cache.get(&digest(1), 0), None);
    }

    #[test]
    fn a_read_that_raced_a_write_is_not_kept() {
        let cache = ActionResultCache::new(1 << 20).unwrap();
        // The read saw the entry from before the write.
        let start = cache.read_start(&digest(1));
        cache.invalidate(&digest(1));
        cache.insert(digest(1), start, data("old"), None, 0);
        assert_eq!(cache.get(&digest(1), 0), None);

        // A read that began after the write is kept.
        let start = cache.read_start(&digest(1));
        cache.insert(digest(1), start, data("new"), None, 0);
        assert_eq!(cache.get(&digest(1), 0), Some(data("new")));
    }
}
