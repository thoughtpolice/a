// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Blob manifests recently read.
//!
//! Reading a blob not stored in its manifest is a lookup of its manifest,
//! then one per chunk. The small-blob cache keeps blobs of up to 64 KiB
//! whole, but a build's outputs can run to gigabytes; their manifests are a
//! few dozen bytes per chunk, so keeping those spares one of the two
//! lookups a single-chunk blob costs, across far more blobs.
//!
//! A manifest names chunks the store keeps separately, and expires with
//! them, nearly: an upload writes its chunks before its manifest, so they
//! expire as much earlier as the upload took. An entry is therefore served
//! until [`EXPIRY_MARGIN_MS`] before the expiry its read saw (see
//! [`expiring`](crate::expiring)). A rewrite can give a blob
//! another chunk list (a splice, say); the chunks of the list kept here live
//! as long as the entry is served all the same. A read that finds a chunk
//! missing anyway drops the entry, so the next read goes to the store.

use std::sync::Arc;

use crate::compression::Compression;
use crate::expiring::{ExpiringCache, Weigh};
use crate::hashing::ContentDigest;
use crate::manifest::{BlobManifest, ChunkInfo};

/// The budget when none is given: some two hundred thousand manifests of
/// one chunk.
pub const DEFAULT_MANIFEST_CACHE_BYTES: u64 = 32 * 1024 * 1024;

/// How long before the expiry a read saw an entry stops being served:
/// far longer than any upload takes to write its chunks.
pub(crate) const EXPIRY_MARGIN_MS: i64 = 60 * 60 * 1000;

/// The least a shard of the cache holds: room for the manifests of
/// gigabyte blobs (thousands of chunks), which a smaller share of the
/// budget would turn away.
const MIN_SHARD_BYTES: u64 = 1024 * 1024;

/// The chunk list of a manifest read.
#[derive(Clone)]
struct Chunked {
    chunks: Arc<[ChunkInfo]>,
    compression: Compression,
    created_at: u64,
}

impl Weigh for Chunked {
    fn weight(&self) -> u64 {
        (self.chunks.len() * std::mem::size_of::<ChunkInfo>()) as u64
    }
}

pub(crate) struct ManifestCache {
    manifests: ExpiringCache<Chunked>,
}

impl ManifestCache {
    /// A cache holding up to `capacity_bytes` of manifests, or none for 0.
    pub(crate) fn new(capacity_bytes: u64) -> Option<Self> {
        let manifests = ExpiringCache::new(capacity_bytes, MIN_SHARD_BYTES, EXPIRY_MARGIN_MS)?;
        Some(Self { manifests })
    }

    /// `digest`'s manifest, its compression, and the expiry its read saw,
    /// if it is here and `now_ms` is short of both [`EXPIRY_MARGIN_MS`]
    /// before that expiry and its revalidation time.
    pub(crate) fn get(
        &self,
        digest: &ContentDigest,
        now_ms: i64,
    ) -> Option<(BlobManifest, Compression, Option<i64>)> {
        let (cached, expires_at) = self.manifests.get(digest, now_ms)?;
        let manifest = BlobManifest {
            chunks: cached.chunks.to_vec(),
            created_at: cached.created_at,
            inline: None,
        };
        Some((manifest, cached.compression, expires_at))
    }

    /// Keep `manifest`, `digest`'s as read at `now_ms`, expiring at
    /// `expires_at`. Manifests holding their blob are not kept here.
    pub(crate) fn insert(
        &self,
        digest: ContentDigest,
        manifest: &BlobManifest,
        compression: Compression,
        expires_at: Option<i64>,
        now_ms: i64,
    ) {
        if manifest.inline.is_some() || manifest.chunks.is_empty() {
            return;
        }
        let chunked = Chunked {
            chunks: manifest.chunks.iter().copied().collect(),
            compression,
            created_at: manifest.created_at,
        };
        self.manifests.insert(digest, chunked, expires_at, now_ms);
    }

    /// Drop `digest`'s manifest: a read through it found a chunk missing.
    pub(crate) fn remove(&self, digest: &ContentDigest) {
        self.manifests.remove(digest);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::hashing::DigestFn;

    fn digest(n: u8) -> ContentDigest {
        ContentDigest::new(DigestFn::Sha256, [n; 32])
    }

    fn chunked(chunks: usize) -> BlobManifest {
        BlobManifest {
            chunks: (0..chunks)
                .map(|n| ChunkInfo {
                    hash: [n as u8; 32],
                    size: 1 << 20,
                })
                .collect(),
            created_at: 42,
            inline: None,
        }
    }

    #[test]
    fn serves_until_short_of_expiry() {
        let cache = ManifestCache::new(1 << 20).unwrap();
        let now = 1_000_000_000;
        assert!(cache.get(&digest(1), now).is_none());

        let expires = now + EXPIRY_MARGIN_MS + 5_000;
        cache.insert(
            digest(1),
            &chunked(3),
            Compression::Zstd,
            Some(expires),
            now,
        );
        let (manifest, compression, expires_at) = cache.get(&digest(1), now + 4_999).unwrap();
        assert_eq!(manifest.chunks.len(), 3);
        assert_eq!(manifest.chunks[2].hash, [2; 32]);
        assert_eq!(manifest.created_at, 42);
        assert!(manifest.inline.is_none());
        assert_eq!(compression, Compression::Zstd);
        assert_eq!(expires_at, Some(expires));
        assert!(
            cache.get(&digest(1), now + 5_000).is_none(),
            "within the margin of its expiry"
        );

        cache.insert(digest(2), &chunked(1), Compression::Identity, None, now);
        assert!(cache.get(&digest(2), now).is_some());
        cache.remove(&digest(2));
        assert!(cache.get(&digest(2), now).is_none(), "dropped");
    }

    #[test]
    fn keeps_only_manifests_naming_chunks() {
        let cache = ManifestCache::new(1 << 20).unwrap();
        let inline = BlobManifest {
            chunks: Vec::new(),
            created_at: 0,
            inline: Some(bytes::Bytes::from_static(b"held in the manifest")),
        };
        cache.insert(digest(1), &inline, Compression::Identity, None, 0);
        cache.insert(digest(2), &chunked(0), Compression::Identity, None, 0);
        assert!(cache.get(&digest(1), 0).is_none());
        assert!(cache.get(&digest(2), 0).is_none());
    }
}
