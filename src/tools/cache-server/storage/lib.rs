// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Content-addressable chunk storage backed by SlateDB with FastCDC chunking.

mod compression;
mod error;
mod hashing;
mod manifest;
mod writer;

// Re-export public API so the external interface is unchanged.
pub use compression::{Compression, StreamingDecompressor};
pub use error::{Result, StoreError};
pub use hashing::{ContentDigest, DigestFn, parse_digest_hash};
pub use manifest::{BlobManifest, ChunkInfo, MAX_MANIFEST_CHUNK_COUNT};
pub use writer::CasBlobWriter;

// Crate-internal re-exports used by sibling modules and tests.
pub(crate) use compression::MAX_CHUNK_DECOMPRESSED_SIZE;
pub(crate) use hashing::{
    IncrementalHasher, SHA256TREE_IV, SHA256TREE_LEAF_SIZE, sha256_block_cipher, sha256tree_hash,
};
pub use manifest::unix_now_secs;

// Re-export std types used by tests via `super::*`.
#[allow(unused_imports)]
pub(crate) use std::borrow::Cow;

use std::sync::Arc;

use bytes::{Buf, BufMut, Bytes, BytesMut};
use futures::{Stream, StreamExt as _};
use slatedb::{Db, WriteBatch};
use tracing::{debug, instrument, warn};

/// Re-export for callers that need to construct TTL durations.
pub use jiff::SignedDuration;
/// Re-export for standalone compaction.
pub use slatedb::CompactorBuilder;

/// Settings for opening a [`CacheStore`].
#[derive(Clone, Debug, Default)]
pub struct CacheStoreSettings {
    /// If `Some`, all new writes will expire after this duration
    /// (mapped to SlateDB's `Settings::default_ttl`). `None` means no expiry.
    pub default_ttl: Option<jiff::SignedDuration>,
    /// When `true`, the embedded compactor is disabled. Use this when running
    /// a standalone compactor process via [`CompactorBuilder`].
    pub disable_compactor: bool,
}

/// The SlateDB database path used by the cache store.
pub const DB_PATH: &str = "cache";

// Key prefixes for the flat keyspace
const PREFIX_MANIFEST: u8 = b'm';
const PREFIX_CHUNK: u8 = b'c';
const PREFIX_ACTION: u8 = b'a';
const PREFIX_ASSET: u8 = b'r';

// FastCDC parameters: avg 512 KiB, min = avg/4, max = avg*4
const CDC_AVG_SIZE: u32 = 524_288; // 512 KiB
const CDC_MIN_SIZE: u32 = CDC_AVG_SIZE / 4; // 128 KiB
const CDC_MAX_SIZE: u32 = CDC_AVG_SIZE * 4; // 2 MiB

// Blobs below this size are stored as a single chunk (no CDC splitting)
const SMALL_BLOB_THRESHOLD: usize = CDC_MAX_SIZE as usize;

/// Maximum total blob size for reassembly (2 GiB).
pub const MAX_BLOB_REASSEMBLE_SIZE: usize = 2 * 1024 * 1024 * 1024;

// Maximum action cache entry size (16 MiB)
const MAX_ACTION_CACHE_ENTRY_SIZE: usize = 16 * 1024 * 1024;

/// Where to store SlateDB data.
pub enum StoreBackend {
    /// In-memory object store (ephemeral, for testing).
    Memory,
    /// Local filesystem at the given path.
    LocalFs(String),
}

/// Main storage engine wrapping SlateDB with CDC-aware blob storage.
pub struct CacheStore {
    db: Db,
}

impl std::fmt::Debug for CacheStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CacheStore").finish_non_exhaustive()
    }
}

/// Create the [`ObjectStore`](slatedb::object_store::ObjectStore) for a given backend.
///
/// Shared by [`CacheStore::open`] and standalone compaction so both use the
/// same object store construction logic.
pub fn create_object_store(
    backend: &StoreBackend,
) -> Result<Arc<dyn slatedb::object_store::ObjectStore>> {
    let object_store: Arc<dyn slatedb::object_store::ObjectStore> = match backend {
        StoreBackend::Memory => Arc::new(slatedb::object_store::memory::InMemory::new()),
        StoreBackend::LocalFs(path) => Arc::new(
            slatedb::object_store::local::LocalFileSystem::new_with_prefix(path)
                .map_err(|e| StoreError::Database(slatedb::Error::unavailable(e.to_string())))?,
        ),
    };
    Ok(object_store)
}

impl CacheStore {
    /// Open the store with the given backend and settings.
    pub async fn open(backend: StoreBackend, settings: CacheStoreSettings) -> Result<Self> {
        let object_store = create_object_store(&backend)?;

        let default_ttl_ms = settings
            .default_ttl
            .map(|d| u64::try_from(d.as_millis()).expect("default TTL overflows u64 milliseconds"));
        let db_settings = slatedb::config::Settings {
            default_ttl: default_ttl_ms,
            compactor_options: if settings.disable_compactor {
                None
            } else {
                slatedb::config::Settings::default().compactor_options
            },
            ..Default::default()
        };
        let db = Db::builder(DB_PATH, object_store)
            .with_settings(db_settings)
            .build()
            .await?;
        Ok(CacheStore { db })
    }

    /// Graceful shutdown.
    pub async fn close(&self) -> Result<()> {
        self.db.close().await.map_err(StoreError::from)
    }

    /// Wrapper around `Db::put` that discards the `WriteHandle`.
    async fn db_put<K: AsRef<[u8]>, V: AsRef<[u8]>>(&self, key: K, value: V) -> Result<()> {
        self.db.put(key, value).await.map(|_handle| ())?;
        Ok(())
    }

    // -----------------------------------------------------------------------------------------------------------------
    // High-level CAS blob API
    // -----------------------------------------------------------------------------------------------------------------

    /// Store a blob, chunking with FastCDC if large enough.
    ///
    /// All chunks and the manifest are written in a single WriteBatch
    /// so that the blob is either fully visible or not visible at all.
    /// Chunks are compressed with the given algorithm before storage.
    #[instrument(skip(self, data), fields(size = data.len(), %digest, %compression))]
    pub async fn cas_put_blob(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
    ) -> Result<()> {
        self.cas_put_blob_inner(digest, data, compression, true)
            .await
    }

    /// Store a blob whose digest was already computed by the caller.
    ///
    /// Identical to [`cas_put_blob`] but skips re-hashing the data for
    /// verification. The caller **must** guarantee that `digest` was
    /// computed from `data` — passing a mismatched pair is a logic error
    /// that will silently store garbage.
    #[instrument(skip(self, data), fields(size = data.len(), %digest, %compression))]
    pub async fn cas_put_blob_prehashed(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
    ) -> Result<()> {
        self.cas_put_blob_inner(digest, data, compression, false)
            .await
    }

    async fn cas_put_blob_inner(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
        verify_hash: bool,
    ) -> Result<()> {
        let digest_fn = digest.function;
        let hash = &digest.hash;
        if data.len() > MAX_BLOB_REASSEMBLE_SIZE {
            return Err(StoreError::BlobTooLarge {
                size: data.len(),
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            });
        }

        if verify_hash {
            // Verify hash first — never skip validation for untrusted
            // callers, to prevent accepting garbage data under a valid
            // digest.
            let computed = digest_fn.hash_data(&data);
            if computed != *hash {
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(hash),
                    actual: hex::encode(computed),
                });
            }
        }

        // Short-circuit: skip redundant write if blob already exists
        if self.cas_blob_exists(digest).await? {
            debug!("blob already exists, skipping write");
            return Ok(());
        }

        if data.len() < SMALL_BLOB_THRESHOLD {
            // Small blob: WriteBatch for atomic chunk+manifest write.
            // Content-addressed writes are idempotent, so no transaction
            // isolation is needed — concurrent writes of the same hash
            // produce identical data.
            let compressed = compression.compress_async(data.clone()).await?;
            let tagged = tagged_chunk(compression, &compressed);
            let chunk_key = prefixed_key(PREFIX_CHUNK, digest_fn, hash);

            let manifest = BlobManifest {
                chunks: vec![ChunkInfo {
                    hash: *hash,
                    size: data.len() as u64,
                }],
                created_at: unix_now_secs(),
            };
            let manifest_key = prefixed_key(PREFIX_MANIFEST, digest_fn, hash);

            let mut batch = WriteBatch::new();
            batch.put(chunk_key, tagged.as_ref());
            batch.put(manifest_key, manifest.to_bytes(compression)?);
            self.db.write(batch).await?;
        } else {
            // Large blob: use WriteBatch for atomic chunk+manifest write.
            // Collect CDC chunk ranges first, then compress in parallel.
            let chunker = fastcdc::v2020::FastCDC::with_level(
                &data,
                CDC_MIN_SIZE,
                CDC_AVG_SIZE,
                CDC_MAX_SIZE,
                fastcdc::v2020::Normalization::Level2,
            );
            let chunk_ranges: Vec<_> = chunker.map(|c| (c.offset, c.length)).collect();

            let mut batch = WriteBatch::new();
            let chunks =
                compress_and_batch_chunks(&data, &chunk_ranges, digest_fn, compression, &mut batch)
                    .await?;

            debug!(
                chunk_count = chunks.len(),
                "large blob CDC chunking complete"
            );
            let manifest = BlobManifest {
                chunks,
                created_at: unix_now_secs(),
            };
            let manifest_key = prefixed_key(PREFIX_MANIFEST, digest_fn, hash);
            batch.put(manifest_key, manifest.to_bytes(compression)?);
            self.db.write(batch).await?;
        }

        Ok(())
    }

    /// Reassemble a blob from its manifest and chunks.
    /// Decompresses chunks transparently based on compression recorded in manifest.
    #[instrument(skip(self), fields(%digest))]
    pub async fn cas_get_blob(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        let digest_fn = digest.function;
        let hash = &digest.hash;

        let (manifest, _compression) = match self.cas_get_manifest(digest).await? {
            Some(m) => m,
            None => return Ok(None),
        };

        let total_size: u64 = manifest
            .chunks
            .iter()
            .try_fold(0u64, |acc, c| acc.checked_add(c.size))
            .ok_or_else(|| StoreError::ManifestCorrupted("total blob size overflows u64".into()))?;
        if total_size > MAX_BLOB_REASSEMBLE_SIZE as u64 {
            return Err(StoreError::BlobTooLarge {
                size: total_size as usize,
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            });
        }
        // Read chunks sequentially into a pre-allocated buffer so that each
        // chunk's raw + decompressed data can be dropped before the next iteration,
        // keeping peak memory at ~1x blob size instead of 2x.
        let mut buf = BytesMut::with_capacity(total_size as usize);
        let mut hasher = if manifest.chunks.len() != 1 {
            Some(IncrementalHasher::new(digest_fn, total_size as usize))
        } else {
            None
        };
        // Collect owned (hash, size) pairs so the stream closure captures
        // Copy values rather than &ChunkInfo references. This avoids a
        // Higher-Ranked Trait Bound (HRTB) issue that prevents the returned
        // future from being boxed (e.g. when called from #[tonic::async_trait]
        // methods).
        let chunk_specs: Vec<([u8; 32], u64)> = manifest
            .chunks
            .iter()
            .map(|ci| (ci.hash, ci.size))
            .collect();

        // Fetch chunks concurrently (up to 32 in-flight), yielded in order
        let mut stream = futures::stream::iter(chunk_specs)
            .map(|(chunk_hash, chunk_size)| async move {
                (
                    self.cas_get_raw_chunk(digest_fn, &chunk_hash).await,
                    chunk_hash,
                    chunk_size,
                )
            })
            .buffered(32);

        // Decompress, verify, and assemble as each chunk arrives
        while let Some((raw_result, chunk_hash, chunk_size)) = stream.next().await {
            let (chunk_compression, compressed) = match raw_result? {
                Some(c) => c,
                None => {
                    warn!(chunk_hash = %hex::encode(chunk_hash), "chunk missing from store");
                    return Err(StoreError::ChunkMissing {
                        hash: hex::encode(chunk_hash),
                    });
                }
            };
            let decompressed = chunk_compression
                .decompress_with_size_hint_async(compressed, chunk_size as usize)
                .await?;
            if decompressed.len() != chunk_size as usize {
                return Err(StoreError::ChunkSizeMismatch {
                    expected: chunk_size,
                    actual: decompressed.len(),
                });
            }
            let computed = digest_fn.hash_data(&decompressed);
            if computed != chunk_hash {
                warn!(
                    expected = %hex::encode(chunk_hash),
                    actual = %hex::encode(computed),
                    "chunk digest mismatch",
                );
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(chunk_hash),
                    actual: hex::encode(computed),
                });
            }
            if let Some(ref mut h) = hasher {
                h.update(&decompressed);
            }
            buf.put(decompressed.as_ref());
        }

        // For single-chunk blobs, the per-chunk hash check above already
        // verified the same hash, so skip the redundant whole-blob hash.
        if let Some(h) = hasher {
            let computed = h.finalize();
            if computed != *hash {
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(hash),
                    actual: hex::encode(computed),
                });
            }
        }
        Ok(Some(buf.freeze()))
    }

    /// Stream a blob's decompressed chunks one at a time.
    ///
    /// Peak memory is O(max_chunk_size) instead of O(blob_size). Returns
    /// `Ok(None)` if the blob does not exist. Each yielded `Bytes` is a
    /// verified, decompressed chunk.
    ///
    /// Note: unlike `cas_get_blob`, this does **not** verify the whole-blob
    /// hash (since chunks are yielded incrementally). Callers that need
    /// whole-blob integrity should hash the concatenated output themselves.
    #[instrument(skip(self), fields(%digest))]
    pub async fn cas_get_blob_stream(
        &self,
        digest: &ContentDigest,
    ) -> Result<Option<impl Stream<Item = Result<Bytes>> + '_>> {
        let digest_fn = digest.function;

        let (manifest, _compression) = match self.cas_get_manifest(digest).await? {
            Some(m) => m,
            None => return Ok(None),
        };

        let stream = async_stream::try_stream! {
            for chunk_info in &manifest.chunks {
                let (chunk_compression, compressed) = self
                    .cas_get_raw_chunk(digest_fn, &chunk_info.hash)
                    .await?
                    .ok_or_else(|| StoreError::ChunkMissing {
                        hash: hex::encode(chunk_info.hash),
                    })?;
                let decompressed = chunk_compression
                    .decompress_with_size_hint_async(compressed, chunk_info.size as usize).await?;
                if decompressed.len() != chunk_info.size as usize {
                    Err(StoreError::ChunkSizeMismatch {
                        expected: chunk_info.size,
                        actual: decompressed.len(),
                    })?;
                }
                let computed = digest_fn.hash_data(&decompressed);
                if computed != chunk_info.hash {
                    Err(StoreError::DigestMismatch {
                        expected: hex::encode(chunk_info.hash),
                        actual: hex::encode(computed),
                    })?;
                }
                yield decompressed;
            }
        };
        Ok(Some(stream))
    }

    /// Check if a blob exists (by checking its manifest key).
    // TODO(perf): SlateDB lacks contains_key; this fetches the full value
    pub async fn cas_blob_exists(&self, digest: &ContentDigest) -> Result<bool> {
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        let result = self.db.get(&key).await?;
        Ok(result.is_some())
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Chunk-level CAS API (for SplitBlob/SpliceBlob)
    // -----------------------------------------------------------------------------------------------------------------

    /// Get the manifest (chunk list) for a blob, along with its compression.
    pub async fn cas_get_manifest(
        &self,
        digest: &ContentDigest,
    ) -> Result<Option<(BlobManifest, Compression)>> {
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        match self.db.get(&key).await? {
            Some(data) => Ok(Some(BlobManifest::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    /// Store a manifest for a blob (used by SpliceBlob).
    ///
    /// Note: this is a non-atomic write — use `cas_splice_blob` for atomic
    /// chunk+manifest writes.
    pub(crate) async fn cas_put_manifest(
        &self,
        digest: &ContentDigest,
        manifest: &BlobManifest,
        compression: Compression,
    ) -> Result<()> {
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        self.db_put(&key, manifest.to_bytes(compression)?.as_ref())
            .await
    }

    /// Atomically store a blob from pre-existing chunk data.
    ///
    /// All chunks are verified, compressed, and written along with the manifest
    /// in a single WriteBatch. This is the preferred path for SpliceBlob
    /// workflows where all chunk data is available upfront.
    #[instrument(skip(self, chunks), fields(%blob_digest, %compression))]
    pub async fn cas_splice_blob(
        &self,
        blob_digest: &ContentDigest,
        chunks: Vec<(ContentDigest, Bytes)>,
        compression: Compression,
    ) -> Result<()> {
        let digest_fn = blob_digest.function;

        let total_size: usize = chunks
            .iter()
            .try_fold(0usize, |acc, (_, d)| acc.checked_add(d.len()))
            .ok_or_else(|| StoreError::BlobTooLarge {
                size: usize::MAX,
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            })?;
        let mut hasher = IncrementalHasher::new(digest_fn, total_size);

        // Phase 1: verify per-chunk hashes and update incremental hasher
        // (sequential — hasher is order-dependent). Hashing is fast; this
        // fails early on corrupt chunks before expensive compression work.
        for (chunk_digest, chunk_data) in &chunks {
            let computed = digest_fn.hash_data(chunk_data);
            if computed != chunk_digest.hash {
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(chunk_digest.hash),
                    actual: hex::encode(computed),
                });
            }
            hasher.update(chunk_data);
        }

        // Verify whole-blob hash before doing compression work
        let computed_blob_hash = hasher.finalize();
        if computed_blob_hash != blob_digest.hash {
            return Err(StoreError::DigestMismatch {
                expected: hex::encode(blob_digest.hash),
                actual: hex::encode(computed_blob_hash),
            });
        }

        // Phase 2: compress chunks in parallel and batch write
        let mut batch = WriteBatch::new();
        let mut chunk_infos = Vec::with_capacity(chunks.len());
        let mut stream = futures::stream::iter(chunks)
            .map(|(chunk_digest, chunk_data)| async move {
                let chunk_len = chunk_data.len() as u64;
                let compressed = compression.compress_async(chunk_data).await?;
                let tagged = tagged_chunk(compression, &compressed);
                Ok::<_, StoreError>((chunk_digest.hash, chunk_len, tagged))
            })
            .buffered(32);

        while let Some(result) = stream.next().await {
            let (hash, chunk_len, tagged) = result?;
            let chunk_key = prefixed_key(PREFIX_CHUNK, digest_fn, &hash);
            batch.put(chunk_key, tagged.as_ref());
            chunk_infos.push(ChunkInfo {
                hash,
                size: chunk_len,
            });
        }

        let manifest = BlobManifest {
            chunks: chunk_infos,
            created_at: unix_now_secs(),
        };
        let manifest_key = prefixed_key(PREFIX_MANIFEST, digest_fn, &blob_digest.hash);
        batch.put(manifest_key, manifest.to_bytes(compression)?);
        self.db.write(batch).await?;
        Ok(())
    }

    /// Fetch a raw chunk without decompression, returning its compression tag.
    async fn cas_get_raw_chunk(
        &self,
        digest_fn: DigestFn,
        hash: &[u8; 32],
    ) -> Result<Option<(Compression, Bytes)>> {
        let key = prefixed_key(PREFIX_CHUNK, digest_fn, hash);
        match self.db.get(&key).await? {
            Some(raw) => Ok(Some(parse_chunk_tag(raw)?)),
            None => Ok(None),
        }
    }

    /// Store a chunk, compressing it before storage.
    pub async fn cas_put_chunk(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
    ) -> Result<()> {
        let computed = digest.function.hash_data(&data);
        if computed != digest.hash {
            return Err(StoreError::DigestMismatch {
                expected: hex::encode(digest.hash),
                actual: hex::encode(computed),
            });
        }

        let compressed = compression.compress_async(data).await?;
        let tagged = tagged_chunk(compression, &compressed);
        let key = prefixed_key(PREFIX_CHUNK, digest.function, &digest.hash);
        self.db_put(&key, tagged.as_ref()).await
    }

    /// Fetch a chunk, decompressing it after retrieval.
    ///
    /// The compression algorithm is auto-detected from the stored 1-byte header.
    pub async fn cas_get_chunk(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        match self
            .cas_get_raw_chunk(digest.function, &digest.hash)
            .await?
        {
            Some((compression, compressed)) => {
                let decompressed = compression.decompress_async(compressed).await?;
                let computed = digest.function.hash_data(&decompressed);
                if computed != digest.hash {
                    return Err(StoreError::DigestMismatch {
                        expected: hex::encode(digest.hash),
                        actual: hex::encode(computed),
                    });
                }
                Ok(Some(decompressed))
            }
            None => Ok(None),
        }
    }

    /// Check if a chunk exists.
    // TODO(perf): SlateDB lacks contains_key; this fetches the full value
    pub async fn cas_chunk_exists(&self, digest: &ContentDigest) -> Result<bool> {
        let key = prefixed_key(PREFIX_CHUNK, digest.function, &digest.hash);
        let result = self.db.get(&key).await?;
        Ok(result.is_some())
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Action cache API
    // -----------------------------------------------------------------------------------------------------------------

    /// Store an action cache entry (serialized ActionResult protobuf).
    ///
    /// The digest is an *action digest* — the hash of the Action proto (command +
    /// input root), NOT a content hash of `data`. The `data` is a serialized
    /// `ActionResult` proto (build outputs, exit codes, etc.) which is semantically
    /// unrelated to the action hash. Content-hash verification is therefore
    /// impossible and incorrect at this layer.
    ///
    /// # Security
    ///
    /// Because the hash is not verified against the stored data, any caller can
    /// write arbitrary results under any action key. In multi-tenant deployments,
    /// cache poisoning must be prevented at the gRPC service layer via
    /// authentication and authorization policies that gate which clients may
    /// write to which action keys.
    #[instrument(skip(self, data), fields(%digest, size = data.len()))]
    pub async fn ac_put(&self, digest: &ContentDigest, data: Bytes) -> Result<()> {
        if data.len() > MAX_ACTION_CACHE_ENTRY_SIZE {
            return Err(StoreError::BlobTooLarge {
                size: data.len(),
                limit: MAX_ACTION_CACHE_ENTRY_SIZE,
            });
        }
        let key = prefixed_key(PREFIX_ACTION, digest.function, &digest.hash);
        self.db_put(&key, data.as_ref()).await
    }

    /// Fetch an action cache entry.
    #[instrument(skip(self), fields(%digest))]
    pub async fn ac_get(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        let key = prefixed_key(PREFIX_ACTION, digest.function, &digest.hash);
        self.db.get(&key).await.map_err(StoreError::from)
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Asset mapping API (Remote Asset API)
    // -----------------------------------------------------------------------------------------------------------------

    /// Store an asset mapping entry for a (URI, qualifiers, digest_function) tuple.
    #[instrument(skip(self, entry), fields(%uri, %digest_fn))]
    pub async fn asset_put(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        entry: &AssetEntry,
    ) -> Result<()> {
        let key = asset_key(digest_fn, uri, qualifiers);
        self.db_put(&key, entry.to_bytes().as_ref()).await
    }

    /// Look up an asset mapping entry by (URI, qualifiers, digest_function).
    #[instrument(skip(self), fields(%uri, %digest_fn))]
    pub async fn asset_get(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
    ) -> Result<Option<AssetEntry>> {
        let key = asset_key(digest_fn, uri, qualifiers);
        match self.db.get(&key).await? {
            Some(data) => Ok(Some(AssetEntry::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    // -----------------------------------------------------------------------------------------------------------------

    /// Create a streaming writer for building a CAS blob incrementally.
    ///
    /// Data can be fed in arbitrary-sized pieces via [`CasBlobWriter::write`].
    /// Call [`CasBlobWriter::finalize`] to flush remaining data, write the
    /// manifest, and return the whole-blob digest.
    pub fn cas_blob_writer(
        &self,
        digest_fn: DigestFn,
        compression: Compression,
    ) -> CasBlobWriter<'_> {
        CasBlobWriter::new(self, digest_fn, compression)
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// Prepend a 1-byte compression tag to compressed chunk data for self-describing storage.
pub(crate) fn tagged_chunk(compression: Compression, compressed: &[u8]) -> Bytes {
    let mut buf = BytesMut::with_capacity(1 + compressed.len());
    buf.put_u8(compression as u8);
    buf.put(compressed);
    buf.freeze()
}

/// Parse the 1-byte compression tag from stored chunk data.
/// Returns the compression algorithm and the remaining compressed bytes.
fn parse_chunk_tag(raw: Bytes) -> Result<(Compression, Bytes)> {
    if raw.is_empty() {
        return Err(StoreError::ManifestCorrupted(
            "chunk data is empty (missing compression tag)".into(),
        ));
    }
    let tag = raw[0];
    let compression = Compression::from_u8(tag).ok_or_else(|| {
        StoreError::ManifestCorrupted(format!("unknown chunk compression tag: {}", tag))
    })?;
    Ok((compression, raw.slice(1..)))
}

/// Build a 34-byte key: 1-byte prefix + 1-byte digest_fn discriminator + 32-byte hash.
pub(crate) fn prefixed_key(prefix: u8, digest_fn: DigestFn, hash: &[u8; 32]) -> [u8; 34] {
    let mut key = [0u8; 34];
    key[0] = prefix;
    key[1] = digest_fn as u8;
    key[2..34].copy_from_slice(hash);
    key
}

/// Compress chunk ranges in parallel and write them to a WriteBatch.
///
/// Each range `(offset, length)` is sliced from `data`, hashed, compressed,
/// tagged, and added to the batch. Returns the chunk metadata.
pub(crate) async fn compress_and_batch_chunks(
    data: &Bytes,
    ranges: &[(usize, usize)],
    digest_fn: DigestFn,
    compression: Compression,
    batch: &mut WriteBatch,
) -> Result<Vec<ChunkInfo>> {
    let mut stream = futures::stream::iter(ranges.iter().copied())
        .map(|(offset, length)| {
            let chunk_data = data.slice(offset..offset + length);
            async move {
                let chunk_hash = digest_fn.hash_data(&chunk_data);
                let compressed = compression.compress_async(chunk_data).await?;
                let tagged = tagged_chunk(compression, &compressed);
                Ok::<_, StoreError>((chunk_hash, length, tagged))
            }
        })
        .buffered(32);

    let mut chunks = Vec::with_capacity(ranges.len());
    while let Some(result) = stream.next().await {
        let (chunk_hash, length, tagged) = result?;
        let chunk_key = prefixed_key(PREFIX_CHUNK, digest_fn, &chunk_hash);
        batch.put(chunk_key, tagged.as_ref());
        chunks.push(ChunkInfo {
            hash: chunk_hash,
            size: length as u64,
        });
    }
    Ok(chunks)
}

// ---------------------------------------------------------------------------------------------------------------------
// Asset mapping types
// ---------------------------------------------------------------------------------------------------------------------

/// An asset mapping entry stored by the Remote Asset API.
///
/// Associates a (URI, qualifiers, digest_function) tuple with a CAS digest,
/// recording creation time, optional expiry, and content type (blob vs directory).
#[derive(Debug, Clone)]
pub struct AssetEntry {
    pub digest_hash: [u8; 32],
    pub digest_size_bytes: i64,
    pub created_at: u64,
    /// Unix timestamp after which the entry is considered expired. 0 = no expiry.
    pub expires_at: u64,
    pub is_directory: bool,
    pub qualifiers: Vec<(String, String)>,
}

impl AssetEntry {
    /// Serialize to binary format:
    /// `[32B hash][i64 LE size][u64 LE created][u64 LE expires][u8 is_dir][u32 LE num_quals]`
    /// followed by `[u32 LE name_len][name][u32 LE val_len][val]` per qualifier.
    pub fn to_bytes(&self) -> Bytes {
        let qual_size: usize = self
            .qualifiers
            .iter()
            .map(|(n, v)| 4 + n.len() + 4 + v.len())
            .sum();
        let len = 32 + 8 + 8 + 8 + 1 + 4 + qual_size;
        let mut buf = BytesMut::with_capacity(len);
        buf.put_slice(&self.digest_hash);
        buf.put_i64_le(self.digest_size_bytes);
        buf.put_u64_le(self.created_at);
        buf.put_u64_le(self.expires_at);
        buf.put_u8(u8::from(self.is_directory));
        buf.put_u32_le(self.qualifiers.len() as u32);
        for (name, value) in &self.qualifiers {
            buf.put_u32_le(name.len() as u32);
            buf.put_slice(name.as_bytes());
            buf.put_u32_le(value.len() as u32);
            buf.put_slice(value.as_bytes());
        }
        buf.freeze()
    }

    /// Deserialize from binary format.
    pub fn from_bytes(mut data: Bytes) -> Result<Self> {
        const MIN_SIZE: usize = 32 + 8 + 8 + 8 + 1 + 4;
        if data.len() < MIN_SIZE {
            return Err(StoreError::ManifestCorrupted(
                "asset entry too short".into(),
            ));
        }
        let mut digest_hash = [0u8; 32];
        data.copy_to_slice(&mut digest_hash);
        let digest_size_bytes = data.get_i64_le();
        let created_at = data.get_u64_le();
        let expires_at = data.get_u64_le();
        let is_directory = data.get_u8() != 0;
        let num_qualifiers = data.get_u32_le() as usize;
        let mut qualifiers = Vec::with_capacity(num_qualifiers.min(1024));
        for _ in 0..num_qualifiers {
            if data.remaining() < 4 {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier truncated".into(),
                ));
            }
            let name_len = data.get_u32_le() as usize;
            if data.remaining() < name_len {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier name truncated".into(),
                ));
            }
            let name = String::from_utf8(data.split_to(name_len).to_vec()).map_err(|_| {
                StoreError::ManifestCorrupted("invalid UTF-8 in qualifier name".into())
            })?;
            if data.remaining() < 4 {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier value length truncated".into(),
                ));
            }
            let value_len = data.get_u32_le() as usize;
            if data.remaining() < value_len {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier value truncated".into(),
                ));
            }
            let value = String::from_utf8(data.split_to(value_len).to_vec()).map_err(|_| {
                StoreError::ManifestCorrupted("invalid UTF-8 in qualifier value".into())
            })?;
            qualifiers.push((name, value));
        }
        Ok(AssetEntry {
            digest_hash,
            digest_size_bytes,
            created_at,
            expires_at,
            is_directory,
            qualifiers,
        })
    }
}

/// Compute the storage key for an asset mapping.
///
/// Canonical form: `"{uri}\0{q1_name}={q1_value}\0..."` with qualifiers sorted
/// lexicographically by name. SHA-256 hashed into a fixed 32-byte key, then
/// prefixed with `PREFIX_ASSET` and the digest function discriminator.
fn asset_key(digest_fn: DigestFn, uri: &str, qualifiers: &[(String, String)]) -> [u8; 34] {
    let mut canonical = uri.to_string();
    let mut sorted_quals: Vec<(&String, &String)> =
        qualifiers.iter().map(|(n, v)| (n, v)).collect();
    sorted_quals.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, value) in sorted_quals {
        canonical.push('\0');
        canonical.push_str(name);
        canonical.push('=');
        canonical.push_str(value);
    }
    let key_hash = DigestFn::Sha256.hash_data(canonical.as_bytes());
    prefixed_key(PREFIX_ASSET, digest_fn, &key_hash)
}

#[cfg(test)]
mod test_helpers;

#[cfg(test_module_action_cache)]
mod test_action_cache;
#[cfg(test_module_asset)]
mod test_asset;
#[cfg(test_module_cas)]
mod test_cas;
#[cfg(test_module_chunking)]
mod test_chunking;
#[cfg(test_module_compression)]
mod test_compression;
#[cfg(test_module_concurrency)]
mod test_concurrency;
#[cfg(test_module_hashing)]
mod test_hashing;
#[cfg(test_module_manifest)]
mod test_manifest;
#[cfg(test_module_streaming)]
mod test_streaming;
