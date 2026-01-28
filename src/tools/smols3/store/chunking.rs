// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Content-defined chunking layer for smols3.
//!
//! This module provides a [`ChunkingStore`] wrapper that sits between the S3
//! protocol layer and the underlying storage backend. It uses FastCDC v2020
//! for content-defined chunking and BLAKE3 for content addressing, enabling
//! deduplication across objects.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────┐
//! │  S3 Protocol    │
//! │  (s3s::S3)      │
//! └────────┬────────┘
//!          │
//! ┌────────▼────────┐
//! │  ChunkingStore  │  <- Chunks/reassembles data
//! │  (impl Store)   │
//! └────────┬────────┘
//!          │
//! ┌────────▼────────┐
//! │  Store trait    │  <- MemoryStore, FjallStore, SlateStore
//! └─────────────────┘
//! ```
//!
//! # Data Model
//!
//! Chunks are stored in a special `__chunks__` bucket with the following key schema:
//!
//! - `c/{blake3_hash}`: Raw chunk data
//! - `r/{blake3_hash}`: Reference count (u64 as string)
//!
//! Object manifests are stored as the object data in the user's bucket/key,
//! describing how to reassemble the original object from chunks.

use std::ops::Range;
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::SystemTime;

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tracing::debug;

use super::error::{StoreError, StoreResult};
use super::traits::*;

/// The internal bucket name used to store chunks.
const CHUNKS_BUCKET: &str = "__chunks__";

/// Prefix for chunk data keys.
const CHUNK_PREFIX: &str = "c/";

/// Prefix for reference count keys.
const REFCOUNT_PREFIX: &str = "r/";

/// Configuration for content-defined chunking.
#[derive(Debug, Clone)]
pub struct ChunkingConfig {
    /// Minimum chunk size in bytes.
    pub min_size: u32,
    /// Average (target) chunk size in bytes.
    pub avg_size: u32,
    /// Maximum chunk size in bytes.
    pub max_size: u32,
}

impl Default for ChunkingConfig {
    fn default() -> Self {
        Self {
            min_size: 8 * 1024,       // 8 KB
            avg_size: 64 * 1024,      // 64 KB
            max_size: 256 * 1024,     // 256 KB
        }
    }
}

/// Reference to a chunk within an object.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChunkRef {
    /// BLAKE3 hash as hex string (64 chars).
    pub hash: String,
    /// Offset of this chunk in the original object.
    pub offset: u64,
    /// Size of the chunk in bytes.
    pub length: u32,
}

/// Manifest describing how an object is composed of chunks.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ObjectManifest {
    /// Format version (currently 1).
    pub version: u8,
    /// Total size of the original object.
    pub total_size: u64,
    /// Ordered list of chunk references.
    pub chunks: Vec<ChunkRef>,
}

impl ObjectManifest {
    /// Create a new manifest for an object.
    fn new(total_size: u64, chunks: Vec<ChunkRef>) -> Self {
        Self {
            version: 1,
            total_size,
            chunks,
        }
    }

    /// Serialize the manifest to JSON bytes.
    fn to_bytes(&self) -> StoreResult<Bytes> {
        serde_json::to_vec(self)
            .map(Bytes::from)
            .map_err(|e| StoreError::Internal(format!("failed to serialize manifest: {}", e)))
    }

    /// Deserialize a manifest from JSON bytes.
    fn from_bytes(data: &[u8]) -> StoreResult<Self> {
        serde_json::from_slice(data)
            .map_err(|e| StoreError::Internal(format!("failed to deserialize manifest: {}", e)))
    }
}

/// A storage wrapper that provides content-defined chunking and deduplication.
///
/// `ChunkingStore` wraps any [`Store`] implementation and transparently chunks
/// all stored objects using FastCDC v2020. Chunks are content-addressed using
/// BLAKE3 hashes, enabling automatic deduplication of identical content.
///
/// # Thread Safety
///
/// `ChunkingStore` is thread-safe if the underlying store is thread-safe.
pub struct ChunkingStore<S: Store> {
    /// The underlying storage backend.
    inner: S,
    /// Chunking configuration.
    config: ChunkingConfig,
    /// Whether the __chunks__ bucket has been initialized.
    chunks_bucket_initialized: AtomicBool,
}

impl<S: Store> ChunkingStore<S> {
    /// Create a new chunking store with default configuration.
    pub fn new(inner: S) -> Self {
        Self::with_config(inner, ChunkingConfig::default())
    }

    /// Create a new chunking store with custom configuration.
    pub fn with_config(inner: S, config: ChunkingConfig) -> Self {
        Self {
            inner,
            config,
            chunks_bucket_initialized: AtomicBool::new(false),
        }
    }

    /// Ensure the chunks bucket exists.
    async fn ensure_chunks_bucket(&self) -> StoreResult<()> {
        if self.chunks_bucket_initialized.load(Ordering::Relaxed) {
            return Ok(());
        }

        if !self.inner.bucket_exists(CHUNKS_BUCKET).await? {
            // Ignore error if bucket already exists (race condition)
            let _ = self.inner.create_bucket(CHUNKS_BUCKET).await;
        }

        self.chunks_bucket_initialized.store(true, Ordering::Relaxed);
        Ok(())
    }

    /// Compute BLAKE3 hash of data and return as hex string.
    fn compute_hash(data: &[u8]) -> String {
        blake3::hash(data).to_hex().to_string()
    }

    /// Get the key for storing chunk data.
    fn chunk_key(hash: &str) -> String {
        format!("{}{}", CHUNK_PREFIX, hash)
    }

    /// Get the key for storing reference count.
    fn refcount_key(hash: &str) -> String {
        format!("{}{}", REFCOUNT_PREFIX, hash)
    }

    /// Get the current reference count for a chunk.
    async fn get_refcount(&self, hash: &str) -> StoreResult<u64> {
        let key = Self::refcount_key(hash);
        match self.inner.get_object(CHUNKS_BUCKET, &key).await {
            Ok(obj) => {
                let count_str = std::str::from_utf8(&obj.data)
                    .map_err(|e| StoreError::Internal(format!("invalid refcount data: {}", e)))?;
                count_str
                    .parse()
                    .map_err(|e| StoreError::Internal(format!("invalid refcount value: {}", e)))
            }
            Err(StoreError::ObjectNotFound { .. }) => Ok(0),
            Err(e) => Err(e),
        }
    }

    /// Set the reference count for a chunk.
    async fn set_refcount(&self, hash: &str, count: u64) -> StoreResult<()> {
        let key = Self::refcount_key(hash);
        if count == 0 {
            // Delete refcount entry when it reaches zero
            self.inner.delete_object(CHUNKS_BUCKET, &key).await
        } else {
            self.inner
                .put_object(
                    CHUNKS_BUCKET,
                    &key,
                    Bytes::from(count.to_string()),
                    ObjectMeta::default(),
                    PutObjectOptions::default(),
                )
                .await?;
            Ok(())
        }
    }

    /// Store a chunk and increment its reference count.
    /// Returns true if this was a new chunk, false if it already existed.
    async fn store_chunk(&self, data: &[u8]) -> StoreResult<(String, bool)> {
        let hash = Self::compute_hash(data);
        let chunk_key = Self::chunk_key(&hash);

        let current_count = self.get_refcount(&hash).await?;
        let is_new = current_count == 0;

        if is_new {
            // Store the chunk data
            self.inner
                .put_object(
                    CHUNKS_BUCKET,
                    &chunk_key,
                    Bytes::copy_from_slice(data),
                    ObjectMeta::default(),
                    PutObjectOptions::default(),
                )
                .await?;
        }

        // Increment reference count
        self.set_refcount(&hash, current_count + 1).await?;

        debug!(hash = %hash, is_new = is_new, refcount = current_count + 1, "chunk stored");
        Ok((hash, is_new))
    }

    /// Decrement reference count for a chunk and delete if orphaned.
    async fn release_chunk(&self, hash: &str) -> StoreResult<()> {
        let current_count = self.get_refcount(hash).await?;
        if current_count == 0 {
            return Ok(()); // Already gone
        }

        let new_count = current_count - 1;
        if new_count == 0 {
            // Delete the chunk data
            let chunk_key = Self::chunk_key(hash);
            self.inner.delete_object(CHUNKS_BUCKET, &chunk_key).await?;
            self.set_refcount(hash, 0).await?;
            debug!(hash = %hash, "chunk deleted (refcount reached 0)");
        } else {
            self.set_refcount(hash, new_count).await?;
            debug!(hash = %hash, refcount = new_count, "chunk reference released");
        }

        Ok(())
    }

    /// Get chunk data by hash.
    async fn get_chunk(&self, hash: &str) -> StoreResult<Bytes> {
        let chunk_key = Self::chunk_key(hash);
        let obj = self.inner.get_object(CHUNKS_BUCKET, &chunk_key).await?;
        Ok(obj.data)
    }

    /// Chunk data using FastCDC and store all chunks.
    async fn chunk_and_store(&self, data: &[u8]) -> StoreResult<ObjectManifest> {
        self.ensure_chunks_bucket().await?;

        if data.is_empty() {
            return Ok(ObjectManifest::new(0, vec![]));
        }

        let chunker = fastcdc::v2020::FastCDC::new(
            data,
            self.config.min_size,
            self.config.avg_size,
            self.config.max_size,
        );

        let mut chunks = Vec::new();
        let mut offset: u64 = 0;

        for chunk in chunker {
            let chunk_data = &data[chunk.offset..chunk.offset + chunk.length];
            let (hash, _is_new) = self.store_chunk(chunk_data).await?;

            chunks.push(ChunkRef {
                hash,
                offset,
                length: chunk.length as u32,
            });

            offset += chunk.length as u64;
        }

        Ok(ObjectManifest::new(data.len() as u64, chunks))
    }

    /// Reassemble object data from a manifest.
    async fn reassemble(&self, manifest: &ObjectManifest) -> StoreResult<Bytes> {
        if manifest.chunks.is_empty() {
            return Ok(Bytes::new());
        }

        let mut data = Vec::with_capacity(manifest.total_size as usize);

        for chunk_ref in &manifest.chunks {
            let chunk_data = self.get_chunk(&chunk_ref.hash).await?;
            data.extend_from_slice(&chunk_data);
        }

        Ok(Bytes::from(data))
    }

    /// Release all chunks referenced by a manifest.
    async fn release_manifest_chunks(&self, manifest: &ObjectManifest) -> StoreResult<()> {
        for chunk_ref in &manifest.chunks {
            self.release_chunk(&chunk_ref.hash).await?;
        }
        Ok(())
    }

    /// Increment reference counts for all chunks in a manifest (for copy).
    async fn increment_manifest_chunks(&self, manifest: &ObjectManifest) -> StoreResult<()> {
        for chunk_ref in &manifest.chunks {
            let current_count = self.get_refcount(&chunk_ref.hash).await?;
            self.set_refcount(&chunk_ref.hash, current_count + 1).await?;
        }
        Ok(())
    }

    /// Get the manifest for an object, if it exists.
    async fn get_manifest(&self, bucket: &str, key: &str) -> StoreResult<ObjectManifest> {
        let obj = self.inner.get_object(bucket, key).await?;
        ObjectManifest::from_bytes(&obj.data)
    }

    /// Compute MD5 hash for ETag (S3 compatibility).
    fn compute_etag(data: &[u8]) -> String {
        format!("{:x}", md5::compute(data))
    }

    /// Check if a bucket name is reserved for internal use.
    fn is_reserved_bucket(bucket: &str) -> bool {
        bucket == CHUNKS_BUCKET
    }
}

#[async_trait::async_trait]
impl<S: Store> Store for ChunkingStore<S> {
    // =========================================================================
    // Bucket operations - delegate to inner store
    // =========================================================================

    async fn create_bucket(&self, bucket: &str) -> StoreResult<()> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::Internal(format!(
                "bucket name '{}' is reserved",
                bucket
            )));
        }
        self.inner.create_bucket(bucket).await
    }

    async fn delete_bucket(&self, bucket: &str) -> StoreResult<()> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::Internal(format!(
                "bucket name '{}' is reserved",
                bucket
            )));
        }
        self.inner.delete_bucket(bucket).await
    }

    async fn bucket_exists(&self, bucket: &str) -> StoreResult<bool> {
        if Self::is_reserved_bucket(bucket) {
            return Ok(false);
        }
        self.inner.bucket_exists(bucket).await
    }

    async fn list_buckets(&self) -> StoreResult<Vec<BucketInfo>> {
        let buckets = self.inner.list_buckets().await?;
        // Filter out the internal chunks bucket
        Ok(buckets
            .into_iter()
            .filter(|b| !Self::is_reserved_bucket(&b.name))
            .collect())
    }

    // =========================================================================
    // Object operations - chunk/reassemble data
    // =========================================================================

    async fn put_object(
        &self,
        bucket: &str,
        key: &str,
        data: Bytes,
        mut meta: ObjectMeta,
        options: PutObjectOptions,
    ) -> StoreResult<PutObjectResult> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::Internal(format!(
                "bucket name '{}' is reserved",
                bucket
            )));
        }

        // Check bucket exists
        if !self.inner.bucket_exists(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Get old manifest to clean up chunks after successful write
        let old_manifest = match self.get_manifest(bucket, key).await {
            Ok(m) => Some(m),
            Err(StoreError::ObjectNotFound { .. }) => None,
            Err(e) => return Err(e),
        };

        // Handle conditional write checks before modifying chunks
        if options.if_none_match && old_manifest.is_some() {
            return Err(StoreError::PreconditionFailed(format!(
                "object already exists: {}/{}",
                bucket, key
            )));
        }

        if let Some(ref expected_etag) = options.if_match {
            match &old_manifest {
                Some(_old) => {
                    // Get the stored manifest's metadata to check ETag
                    let stored_meta = self.inner.head_object(bucket, key).await?;
                    if stored_meta.etag != *expected_etag {
                        return Err(StoreError::PreconditionFailed(format!(
                            "ETag mismatch: expected {}, found {}",
                            expected_etag, stored_meta.etag
                        )));
                    }
                }
                None => {
                    return Err(StoreError::PreconditionFailed(format!(
                        "object does not exist: {}/{}",
                        bucket, key
                    )));
                }
            }
        }

        // Remember original data size
        let original_size = data.len() as u64;

        // Chunk the data and store chunks
        let manifest = self.chunk_and_store(&data).await?;

        // Serialize manifest
        let manifest_bytes = manifest.to_bytes()?;
        let etag = Self::compute_etag(&manifest_bytes);

        // Update metadata
        meta.size = original_size;
        meta.last_modified = SystemTime::now();
        meta.etag = etag.clone();

        // Store the manifest
        self.inner
            .put_object(
                bucket,
                key,
                manifest_bytes,
                meta,
                PutObjectOptions::default(),
            )
            .await?;

        // Release old chunks after successful write
        if let Some(old) = old_manifest {
            self.release_manifest_chunks(&old).await?;
        }

        debug!(bucket, key, chunks = manifest.chunks.len(), size = original_size, "object stored with chunking");
        Ok(PutObjectResult { etag })
    }

    async fn get_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectData> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Get manifest
        let stored = self.inner.get_object(bucket, key).await?;
        let manifest = ObjectManifest::from_bytes(&stored.data)?;

        // Reassemble data
        let data = self.reassemble(&manifest).await?;

        // Update metadata with actual size
        let mut meta = stored.meta;
        meta.size = manifest.total_size;

        Ok(ObjectData { data, meta })
    }

    async fn get_object_range(
        &self,
        bucket: &str,
        key: &str,
        range: Range<u64>,
    ) -> StoreResult<Bytes> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Get manifest
        let stored = self.inner.get_object(bucket, key).await?;
        let manifest = ObjectManifest::from_bytes(&stored.data)?;

        if range.start >= manifest.total_size {
            return Err(StoreError::InvalidRange(format!(
                "start {} >= size {}",
                range.start, manifest.total_size
            )));
        }

        let end = std::cmp::min(range.end, manifest.total_size);

        // Find chunks that overlap with the range
        let mut result = Vec::new();
        let mut current_pos: u64 = 0;

        for chunk_ref in &manifest.chunks {
            let chunk_end = current_pos + chunk_ref.length as u64;

            // Check if this chunk overlaps with requested range
            if chunk_end > range.start && current_pos < end {
                let chunk_data = self.get_chunk(&chunk_ref.hash).await?;

                // Calculate slice within chunk
                let slice_start = if current_pos < range.start {
                    (range.start - current_pos) as usize
                } else {
                    0
                };

                let slice_end = if chunk_end > end {
                    chunk_data.len() - (chunk_end - end) as usize
                } else {
                    chunk_data.len()
                };

                result.extend_from_slice(&chunk_data[slice_start..slice_end]);
            }

            current_pos = chunk_end;
            if current_pos >= end {
                break;
            }
        }

        Ok(Bytes::from(result))
    }

    async fn head_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectMeta> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Get manifest to retrieve total size
        let stored = self.inner.get_object(bucket, key).await?;
        let manifest = ObjectManifest::from_bytes(&stored.data)?;

        let mut meta = stored.meta;
        meta.size = manifest.total_size;
        Ok(meta)
    }

    async fn delete_object(&self, bucket: &str, key: &str) -> StoreResult<()> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Get manifest to release chunks
        match self.get_manifest(bucket, key).await {
            Ok(manifest) => {
                // Delete the manifest first
                self.inner.delete_object(bucket, key).await?;
                // Then release chunks
                self.release_manifest_chunks(&manifest).await?;
            }
            Err(StoreError::ObjectNotFound { .. }) => {
                // Object doesn't exist, just return success (S3 semantics)
            }
            Err(e) => return Err(e),
        }

        debug!(bucket, key, "object deleted");
        Ok(())
    }

    async fn copy_object(
        &self,
        src_bucket: &str,
        src_key: &str,
        dst_bucket: &str,
        dst_key: &str,
    ) -> StoreResult<CopyObjectResult> {
        if Self::is_reserved_bucket(src_bucket) || Self::is_reserved_bucket(dst_bucket) {
            return Err(StoreError::BucketNotFound(
                if Self::is_reserved_bucket(src_bucket) {
                    src_bucket.to_string()
                } else {
                    dst_bucket.to_string()
                },
            ));
        }

        // Get source manifest and metadata
        let src_stored = self.inner.get_object(src_bucket, src_key).await?;
        let manifest = ObjectManifest::from_bytes(&src_stored.data)?;

        // Check destination bucket exists
        if !self.inner.bucket_exists(dst_bucket).await? {
            return Err(StoreError::BucketNotFound(dst_bucket.to_string()));
        }

        // Get old manifest at destination to clean up chunks later
        let old_dst_manifest = match self.get_manifest(dst_bucket, dst_key).await {
            Ok(m) => Some(m),
            Err(StoreError::ObjectNotFound { .. }) => None,
            Err(e) => return Err(e),
        };

        // Increment refcounts for all chunks (this is the dedup magic - no data copied!)
        self.increment_manifest_chunks(&manifest).await?;

        // Create new metadata for destination
        let mut meta = src_stored.meta.clone();
        meta.last_modified = SystemTime::now();

        let result = CopyObjectResult {
            etag: meta.etag.clone(),
            last_modified: meta.last_modified,
        };

        // Store manifest at destination
        self.inner
            .put_object(
                dst_bucket,
                dst_key,
                src_stored.data,
                meta,
                PutObjectOptions::default(),
            )
            .await?;

        // Release old destination chunks if we overwrote something
        if let Some(old) = old_dst_manifest {
            self.release_manifest_chunks(&old).await?;
        }

        debug!(
            src_bucket,
            src_key, dst_bucket, dst_key, chunks = manifest.chunks.len(),
            "object copied (chunks shared)"
        );
        Ok(result)
    }

    async fn list_objects(
        &self,
        bucket: &str,
        options: ListObjectsOptions,
    ) -> StoreResult<ListObjectsResult> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Get list from inner store
        let mut result = self.inner.list_objects(bucket, options).await?;

        // Update sizes by reading manifests
        for entry in &mut result.objects {
            if let Ok(stored) = self.inner.get_object(bucket, &entry.key).await {
                if let Ok(manifest) = ObjectManifest::from_bytes(&stored.data) {
                    entry.size = manifest.total_size;
                }
            }
        }

        Ok(result)
    }

    // =========================================================================
    // Multipart upload operations - delegate most to inner, chunk on complete
    // =========================================================================

    async fn create_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        meta: ObjectMeta,
    ) -> StoreResult<String> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }
        self.inner.create_multipart_upload(bucket, key, meta).await
    }

    async fn upload_part(
        &self,
        bucket: &str,
        upload_id: &str,
        part_number: i32,
        data: Bytes,
    ) -> StoreResult<PartInfo> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }
        // Store parts directly in inner store (no chunking yet)
        self.inner
            .upload_part(bucket, upload_id, part_number, data)
            .await
    }

    async fn complete_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> StoreResult<CompleteMultipartResult> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Complete the multipart upload in inner store first to assemble parts
        let result = self
            .inner
            .complete_multipart_upload(bucket, key, upload_id, parts)
            .await?;

        // Now get the assembled object and re-store it with chunking
        let obj = self.inner.get_object(bucket, key).await?;

        // Chunk the assembled data
        let manifest = self.chunk_and_store(&obj.data).await?;

        // Serialize manifest
        let manifest_bytes = manifest.to_bytes()?;
        let etag = Self::compute_etag(&manifest_bytes);

        // Update metadata
        let mut meta = obj.meta;
        meta.etag = etag.clone();
        // size is already set correctly from assembled parts

        // Store the manifest (overwriting the assembled data)
        self.inner
            .put_object(
                bucket,
                key,
                manifest_bytes,
                meta,
                PutObjectOptions::default(),
            )
            .await?;

        debug!(
            bucket,
            key,
            upload_id,
            chunks = manifest.chunks.len(),
            "multipart upload completed with chunking"
        );

        Ok(CompleteMultipartResult { etag })
    }

    async fn abort_multipart_upload(&self, bucket: &str, upload_id: &str) -> StoreResult<()> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }
        self.inner.abort_multipart_upload(bucket, upload_id).await
    }

    async fn list_parts(&self, bucket: &str, upload_id: &str) -> StoreResult<Vec<PartInfo>> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }
        self.inner.list_parts(bucket, upload_id).await
    }

    async fn list_multipart_uploads(&self, bucket: &str) -> StoreResult<Vec<MultipartUploadInfo>> {
        if Self::is_reserved_bucket(bucket) {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }
        self.inner.list_multipart_uploads(bucket).await
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::MemoryStore;

    /// Create a test ChunkingStore wrapping MemoryStore.
    fn test_store() -> ChunkingStore<MemoryStore> {
        ChunkingStore::new(MemoryStore::new())
    }

    /// Create a test ChunkingStore with small chunk sizes for testing.
    fn test_store_small_chunks() -> ChunkingStore<MemoryStore> {
        ChunkingStore::with_config(
            MemoryStore::new(),
            ChunkingConfig {
                min_size: 64,
                avg_size: 256,
                max_size: 1024,
            },
        )
    }

    // =========================================================================
    // Manifest serialization tests
    // =========================================================================

    #[test]
    fn test_manifest_roundtrip() {
        let manifest = ObjectManifest {
            version: 1,
            total_size: 1000,
            chunks: vec![
                ChunkRef {
                    hash: "abc123".to_string(),
                    offset: 0,
                    length: 500,
                },
                ChunkRef {
                    hash: "def456".to_string(),
                    offset: 500,
                    length: 500,
                },
            ],
        };

        let bytes = manifest.to_bytes().unwrap();
        let restored = ObjectManifest::from_bytes(&bytes).unwrap();

        assert_eq!(restored.version, 1);
        assert_eq!(restored.total_size, 1000);
        assert_eq!(restored.chunks.len(), 2);
        assert_eq!(restored.chunks[0].hash, "abc123");
        assert_eq!(restored.chunks[1].hash, "def456");
    }

    #[test]
    fn test_manifest_empty_chunks() {
        let manifest = ObjectManifest::new(0, vec![]);

        let bytes = manifest.to_bytes().unwrap();
        let restored = ObjectManifest::from_bytes(&bytes).unwrap();

        assert_eq!(restored.total_size, 0);
        assert!(restored.chunks.is_empty());
    }

    // =========================================================================
    // Hash computation tests
    // =========================================================================

    #[test]
    fn test_hash_deterministic() {
        let data = b"hello world";
        let hash1 = ChunkingStore::<MemoryStore>::compute_hash(data);
        let hash2 = ChunkingStore::<MemoryStore>::compute_hash(data);
        assert_eq!(hash1, hash2);
    }

    #[test]
    fn test_hash_different_data() {
        let hash1 = ChunkingStore::<MemoryStore>::compute_hash(b"hello");
        let hash2 = ChunkingStore::<MemoryStore>::compute_hash(b"world");
        assert_ne!(hash1, hash2);
    }

    #[test]
    fn test_hash_is_hex() {
        let hash = ChunkingStore::<MemoryStore>::compute_hash(b"test");
        assert_eq!(hash.len(), 64); // BLAKE3 produces 32 bytes = 64 hex chars
        assert!(hash.chars().all(|c| c.is_ascii_hexdigit()));
    }

    // =========================================================================
    // Chunking behavior tests
    // =========================================================================

    #[tokio::test]
    async fn test_chunk_empty_data() {
        let store = test_store();
        store.create_bucket("test").await.unwrap();

        store
            .put_object(
                "test",
                "empty",
                Bytes::new(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let obj = store.get_object("test", "empty").await.unwrap();
        assert!(obj.data.is_empty());
        assert_eq!(obj.meta.size, 0);
    }

    #[tokio::test]
    async fn test_chunk_small_data() {
        let store = test_store();
        store.create_bucket("test").await.unwrap();

        let data = Bytes::from("small data");
        store
            .put_object(
                "test",
                "small",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let obj = store.get_object("test", "small").await.unwrap();
        assert_eq!(obj.data, data);
        assert_eq!(obj.meta.size, data.len() as u64);
    }

    #[tokio::test]
    async fn test_chunk_large_data() {
        let store = test_store_small_chunks();
        store.create_bucket("test").await.unwrap();

        // Create data larger than max chunk size to force multiple chunks
        let data = Bytes::from(vec![0xABu8; 4096]);
        store
            .put_object(
                "test",
                "large",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let obj = store.get_object("test", "large").await.unwrap();
        assert_eq!(obj.data, data);
        assert_eq!(obj.meta.size, data.len() as u64);
    }

    #[tokio::test]
    async fn test_chunking_deterministic() {
        let store = test_store_small_chunks();
        store.create_bucket("test").await.unwrap();

        let data = Bytes::from(vec![0xCDu8; 2048]);

        // Store same data twice
        store
            .put_object(
                "test",
                "obj1",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        store
            .put_object(
                "test",
                "obj2",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        // Both should retrieve the same data
        let obj1 = store.get_object("test", "obj1").await.unwrap();
        let obj2 = store.get_object("test", "obj2").await.unwrap();

        assert_eq!(obj1.data, data);
        assert_eq!(obj2.data, data);
    }

    // =========================================================================
    // Reference counting tests
    // =========================================================================

    #[tokio::test]
    async fn test_refcount_lifecycle() {
        let store = test_store_small_chunks();
        store.create_bucket("test").await.unwrap();

        let data = Bytes::from(vec![0xEFu8; 2048]);

        // Store object - creates chunks with refcount 1
        store
            .put_object(
                "test",
                "obj1",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        // Store same data again - increments refcounts
        store
            .put_object(
                "test",
                "obj2",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        // Delete first object - decrements refcounts
        store.delete_object("test", "obj1").await.unwrap();

        // Second object should still work (chunks still exist)
        let obj = store.get_object("test", "obj2").await.unwrap();
        assert_eq!(obj.data, data);

        // Delete second object - should clean up all chunks
        store.delete_object("test", "obj2").await.unwrap();
    }

    #[tokio::test]
    async fn test_deduplication() {
        let store = test_store_small_chunks();
        store.create_bucket("test").await.unwrap();

        // Create data that will produce multiple chunks
        let data = Bytes::from(vec![0x42u8; 4096]);

        // Store same data twice
        store
            .put_object(
                "test",
                "first",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        store
            .put_object(
                "test",
                "second",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        // Delete first and verify second still works
        store.delete_object("test", "first").await.unwrap();

        let obj = store.get_object("test", "second").await.unwrap();
        assert_eq!(obj.data, data);
    }

    // =========================================================================
    // Range read tests
    // =========================================================================

    #[tokio::test]
    async fn test_range_read_simple() {
        let store = test_store();
        store.create_bucket("test").await.unwrap();

        let data = Bytes::from("hello world");
        store
            .put_object(
                "test",
                "key",
                data,
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let range_data = store.get_object_range("test", "key", 0..5).await.unwrap();
        assert_eq!(range_data, Bytes::from("hello"));
    }

    #[tokio::test]
    async fn test_range_read_middle() {
        let store = test_store();
        store.create_bucket("test").await.unwrap();

        let data = Bytes::from("hello world");
        store
            .put_object(
                "test",
                "key",
                data,
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let range_data = store.get_object_range("test", "key", 6..11).await.unwrap();
        assert_eq!(range_data, Bytes::from("world"));
    }

    #[tokio::test]
    async fn test_range_read_across_chunks() {
        let store = test_store_small_chunks();
        store.create_bucket("test").await.unwrap();

        // Create data larger than chunk size
        let data: Vec<u8> = (0..2048).map(|i| (i % 256) as u8).collect();
        let data = Bytes::from(data);

        store
            .put_object(
                "test",
                "key",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        // Read range that likely spans chunks
        let range_data = store
            .get_object_range("test", "key", 500..1500)
            .await
            .unwrap();

        assert_eq!(range_data.len(), 1000);
        assert_eq!(range_data.as_ref(), &data[500..1500]);
    }

    // =========================================================================
    // Copy operation tests
    // =========================================================================

    #[tokio::test]
    async fn test_copy_shares_chunks() {
        let store = test_store_small_chunks();
        store.create_bucket("test").await.unwrap();

        let data = Bytes::from(vec![0xAAu8; 2048]);

        store
            .put_object(
                "test",
                "source",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        // Copy object
        store
            .copy_object("test", "source", "test", "dest")
            .await
            .unwrap();

        // Both should work
        let src = store.get_object("test", "source").await.unwrap();
        let dst = store.get_object("test", "dest").await.unwrap();

        assert_eq!(src.data, data);
        assert_eq!(dst.data, data);

        // Delete source - dest should still work (shared chunks)
        store.delete_object("test", "source").await.unwrap();

        let dst = store.get_object("test", "dest").await.unwrap();
        assert_eq!(dst.data, data);
    }

    // =========================================================================
    // Reserved bucket tests
    // =========================================================================

    #[tokio::test]
    async fn test_reserved_bucket_create() {
        let store = test_store();

        let result = store.create_bucket(CHUNKS_BUCKET).await;
        assert!(matches!(result, Err(StoreError::Internal(_))));
    }

    #[tokio::test]
    async fn test_reserved_bucket_hidden() {
        let store = test_store();
        store.create_bucket("visible").await.unwrap();

        // Ensure chunks bucket is created
        store
            .put_object(
                "visible",
                "key",
                Bytes::from("data"),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let buckets = store.list_buckets().await.unwrap();
        assert_eq!(buckets.len(), 1);
        assert_eq!(buckets[0].name, "visible");
    }

    // =========================================================================
    // Head object tests
    // =========================================================================

    #[tokio::test]
    async fn test_head_object_size() {
        let store = test_store();
        store.create_bucket("test").await.unwrap();

        let data = Bytes::from("hello world");
        store
            .put_object(
                "test",
                "key",
                data.clone(),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let meta = store.head_object("test", "key").await.unwrap();
        assert_eq!(meta.size, data.len() as u64);
    }

    // =========================================================================
    // Conditional write tests
    // =========================================================================

    #[tokio::test]
    async fn test_conditional_write_if_none_match() {
        let store = test_store();
        store.create_bucket("test").await.unwrap();

        // First write should succeed
        let options = PutObjectOptions {
            if_none_match: true,
            ..Default::default()
        };
        store
            .put_object(
                "test",
                "key",
                Bytes::from("first"),
                ObjectMeta::default(),
                options.clone(),
            )
            .await
            .unwrap();

        // Second write should fail
        let result = store
            .put_object(
                "test",
                "key",
                Bytes::from("second"),
                ObjectMeta::default(),
                options,
            )
            .await;

        assert!(matches!(result, Err(StoreError::PreconditionFailed(_))));
    }

    #[tokio::test]
    async fn test_conditional_write_if_match() {
        let store = test_store();
        store.create_bucket("test").await.unwrap();

        // Store initial object
        let result = store
            .put_object(
                "test",
                "key",
                Bytes::from("initial"),
                ObjectMeta::default(),
                PutObjectOptions::default(),
            )
            .await
            .unwrap();

        let etag = result.etag;

        // Update with matching ETag should succeed
        let options = PutObjectOptions {
            if_match: Some(etag),
            ..Default::default()
        };
        store
            .put_object(
                "test",
                "key",
                Bytes::from("updated"),
                ObjectMeta::default(),
                options,
            )
            .await
            .unwrap();

        // Update with wrong ETag should fail
        let options = PutObjectOptions {
            if_match: Some("wrong-etag".to_string()),
            ..Default::default()
        };
        let result = store
            .put_object(
                "test",
                "key",
                Bytes::from("conflict"),
                ObjectMeta::default(),
                options,
            )
            .await;

        assert!(matches!(result, Err(StoreError::PreconditionFailed(_))));
    }
}
