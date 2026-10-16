// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Small blobs recently read, kept whole.
//!
//! A blob of at most [`INLINE_BLOB_MAX`] bytes is stored in its manifest, so
//! reading it is one point lookup; one of up to [`SMALL_BLOB_MAX`] is one
//! chunk, two lookups, a decompression, and a hash. A SlateDB point lookup
//! sets up an iterator over every SST the key could be in, cloning and
//! dropping shared, reference-counted state for each: on a busy server that
//! is most of what a small read costs, contended between every core. Builds
//! read the same small blobs (headers, outputs, the Directories of the same
//! input roots) over and over, so blobs read are kept here, verified and
//! decompressed, under a byte budget, and served without the LSM.
//!
//! A blob only disappears by expiring, and a rewrite only moves its expiry
//! later, so an entry is good until the expiry its read saw (see
//! [`expiring`](crate::expiring)).

use bytes::Bytes;

use crate::compression::Compression;
use crate::expiring::{ExpiringCache, Weigh};
use crate::hashing::ContentDigest;
#[cfg(doc)]
use crate::manifest::INLINE_BLOB_MAX;
use crate::manifest::{BlobManifest, ChunkInfo};

/// The budget when none is given: thousands to tens of thousands of small
/// blobs.
pub const DEFAULT_SMALL_BLOB_CACHE_BYTES: u64 = 64 * 1024 * 1024;

/// The largest blob kept: the largest chunk the block cache holds, too.
pub(crate) const SMALL_BLOB_MAX: usize = crate::CACHED_CHUNK_BYTES as usize;

/// The least a shard of the cache holds: room for many of the largest
/// blobs, which a smaller share of the budget would turn away.
const MIN_SHARD_BYTES: u64 = 16 * SMALL_BLOB_MAX as u64;

/// A blob read.
#[derive(Clone)]
struct Blob {
    data: Bytes,
    compression: Compression,
    created_at: u64,
}

impl Weigh for Blob {
    fn weight(&self) -> u64 {
        self.data.len() as u64
    }
}

pub(crate) struct SmallBlobCache {
    blobs: ExpiringCache<Blob>,
}

impl SmallBlobCache {
    /// A cache holding up to `capacity_bytes` of blobs, or none for 0.
    pub(crate) fn new(capacity_bytes: u64) -> Option<Self> {
        let blobs = ExpiringCache::new(capacity_bytes, MIN_SHARD_BYTES, 0)?;
        Some(Self { blobs })
    }

    /// `digest`'s manifest and compression, as [`CacheStore::cas_get_manifest`]
    /// would give them for a blob stored in its manifest, if the blob is
    /// here and not past its expiry or its revalidation time at `now_ms`:
    /// its data comes with it, as `inline`, whether or not it was stored so.
    ///
    /// [`CacheStore::cas_get_manifest`]: crate::CacheStore::cas_get_manifest
    pub(crate) fn get(
        &self,
        digest: &ContentDigest,
        now_ms: i64,
    ) -> Option<(BlobManifest, Compression)> {
        let (blob, _) = self.blobs.get(digest, now_ms)?;
        let manifest = BlobManifest {
            chunks: vec![ChunkInfo {
                hash: digest.hash,
                size: blob.data.len() as u64,
            }],
            created_at: blob.created_at,
            inline: Some(blob.data),
        };
        Some((manifest, blob.compression))
    }

    /// Keep `data`, `digest`'s blob as read (and verified) at `now_ms` from
    /// a manifest made at `created_at` with `compression`, expiring at
    /// `expires_at`, unless it is larger than [`SMALL_BLOB_MAX`].
    pub(crate) fn insert(
        &self,
        digest: ContentDigest,
        data: &Bytes,
        compression: Compression,
        created_at: u64,
        expires_at: Option<i64>,
        now_ms: i64,
    ) {
        if data.len() > SMALL_BLOB_MAX {
            return;
        }
        let blob = Blob {
            // A copy: the store hands out slices of the blocks it reads, and
            // an entry holding one would keep the whole block.
            data: Bytes::copy_from_slice(data),
            compression,
            created_at,
        };
        self.blobs.insert(digest, blob, expires_at, now_ms);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashing::DigestFn;

    fn digest(n: u8) -> ContentDigest {
        ContentDigest::new(DigestFn::Sha256, [n; 32])
    }

    fn keep(cache: &SmallBlobCache, n: u8, data: Bytes, expires_at: Option<i64>, now: i64) {
        cache.insert(digest(n), &data, Compression::Identity, 42, expires_at, now);
    }

    #[test]
    fn serves_blobs_as_manifests_holding_them() {
        let cache = SmallBlobCache::new(1 << 20).unwrap();
        let now = 1_000_000;
        assert!(cache.get(&digest(1), now).is_none());

        keep(
            &cache,
            1,
            Bytes::from_static(b"one"),
            Some(now + 5_000),
            now,
        );
        let (manifest, compression) = cache.get(&digest(1), now + 4_999).unwrap();
        assert_eq!(manifest.inline.as_deref(), Some(&b"one"[..]));
        assert_eq!(manifest.created_at, 42);
        assert_eq!(manifest.chunks.len(), 1);
        assert_eq!(manifest.chunks[0].hash, digest(1).hash);
        assert_eq!(manifest.chunks[0].size, 3);
        assert_eq!(compression, Compression::Identity);
        assert!(cache.get(&digest(1), now + 5_000).is_none(), "expired");
    }

    #[test]
    fn keeps_blobs_up_to_the_size_limit() {
        let cache = SmallBlobCache::new(1 << 20).unwrap();
        keep(&cache, 1, Bytes::from(vec![1u8; SMALL_BLOB_MAX]), None, 0);
        keep(
            &cache,
            2,
            Bytes::from(vec![2u8; SMALL_BLOB_MAX + 1]),
            None,
            0,
        );
        assert!(cache.get(&digest(1), 0).is_some());
        assert!(cache.get(&digest(2), 0).is_none());
    }
}
