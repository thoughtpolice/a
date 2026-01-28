// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! SlateDB-based persistent storage backend.
//!
//! This module provides a persistent implementation of the [`Store`] trait
//! using SlateDB as the underlying LSM-tree database backed by object storage.
//!
//! # Architecture
//!
//! SlateDB stores data in an object store (local filesystem, S3, etc.).
//! We use key prefixes to separate different data types:
//! - `b:` - bucket metadata (bucket name -> creation timestamp)
//! - `o:` - object data (bucket\0key -> data)
//! - `m:` - object metadata (bucket\0key -> JSON metadata)
//! - `u:` - multipart upload state (upload_id -> JSON state)
//! - `p:` - multipart parts data (upload_id\0part_number -> data)
//! - `q:` - multipart parts metadata (upload_id\0part_number -> JSON)

use std::collections::BTreeSet;
use std::ops::Range;
use std::path::PathBuf;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use slatedb::object_store::local::LocalFileSystem;
use slatedb::object_store::memory::InMemory;
use slatedb::{Db, ErrorKind, IsolationLevel};
use tracing::debug;

use super::error::{StoreError, StoreResult};
use super::traits::*;

// =============================================================================
// Constants
// =============================================================================

/// Maximum number of transaction retries on conflict
const MAX_TRANSACTION_RETRIES: usize = 10;

// =============================================================================
// Key prefix constants
// =============================================================================

const PREFIX_BUCKET: &[u8] = b"b:";
const PREFIX_OBJECT: &[u8] = b"o:";
const PREFIX_META: &[u8] = b"m:";
const PREFIX_MULTIPART: &[u8] = b"u:";
const PREFIX_PART: &[u8] = b"p:";
const PREFIX_PART_META: &[u8] = b"q:";

// =============================================================================
// Serializable types for SlateDB storage
// =============================================================================

/// Serializable object metadata for storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredObjectMeta {
    content_type: Option<String>,
    content_encoding: Option<String>,
    content_disposition: Option<String>,
    content_language: Option<String>,
    cache_control: Option<String>,
    user_metadata: Option<std::collections::HashMap<String, String>>,
    last_modified_millis: u64,
    size: u64,
    etag: String,
}

impl StoredObjectMeta {
    fn from_object_meta(meta: &ObjectMeta) -> Self {
        let last_modified_millis = meta
            .last_modified
            .duration_since(UNIX_EPOCH)
            .unwrap_or_default()
            .as_millis() as u64;

        Self {
            content_type: meta.content_type.clone(),
            content_encoding: meta.content_encoding.clone(),
            content_disposition: meta.content_disposition.clone(),
            content_language: meta.content_language.clone(),
            cache_control: meta.cache_control.clone(),
            user_metadata: meta.user_metadata.clone(),
            last_modified_millis,
            size: meta.size,
            etag: meta.etag.clone(),
        }
    }

    fn to_object_meta(&self) -> ObjectMeta {
        ObjectMeta {
            content_type: self.content_type.clone(),
            content_encoding: self.content_encoding.clone(),
            content_disposition: self.content_disposition.clone(),
            content_language: self.content_language.clone(),
            cache_control: self.cache_control.clone(),
            user_metadata: self.user_metadata.clone(),
            last_modified: UNIX_EPOCH + Duration::from_millis(self.last_modified_millis),
            size: self.size,
            etag: self.etag.clone(),
        }
    }
}

/// Serializable multipart upload state.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredMultipartUpload {
    bucket: String,
    key: String,
    meta: StoredObjectMeta,
    initiated_millis: u64,
}

/// Serializable part metadata.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredPartMeta {
    part_number: i32,
    etag: String,
    size: u64,
    last_modified_millis: u64,
}

// =============================================================================
// Key encoding helpers
// =============================================================================

/// Create a bucket key.
fn make_bucket_key(bucket: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(PREFIX_BUCKET.len() + bucket.len());
    k.extend_from_slice(PREFIX_BUCKET);
    k.extend_from_slice(bucket.as_bytes());
    k
}

/// Create an object key from bucket and key.
fn make_object_key(bucket: &str, key: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(PREFIX_OBJECT.len() + bucket.len() + 1 + key.len());
    k.extend_from_slice(PREFIX_OBJECT);
    k.extend_from_slice(bucket.as_bytes());
    k.push(0); // null separator
    k.extend_from_slice(key.as_bytes());
    k
}

/// Create a metadata key from bucket and key.
fn make_meta_key(bucket: &str, key: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(PREFIX_META.len() + bucket.len() + 1 + key.len());
    k.extend_from_slice(PREFIX_META);
    k.extend_from_slice(bucket.as_bytes());
    k.push(0);
    k.extend_from_slice(key.as_bytes());
    k
}

/// Parse an object/meta key into bucket and key (strips prefix).
fn parse_prefixed_object_key(key: &[u8], prefix: &[u8]) -> Option<(String, String)> {
    if !key.starts_with(prefix) {
        return None;
    }
    let key = &key[prefix.len()..];
    let sep_pos = key.iter().position(|&b| b == 0)?;
    let bucket = std::str::from_utf8(&key[..sep_pos]).ok()?;
    let obj_key = std::str::from_utf8(&key[sep_pos + 1..]).ok()?;
    Some((bucket.to_string(), obj_key.to_string()))
}

/// Create a multipart key.
fn make_multipart_key(upload_id: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(PREFIX_MULTIPART.len() + upload_id.len());
    k.extend_from_slice(PREFIX_MULTIPART);
    k.extend_from_slice(upload_id.as_bytes());
    k
}

/// Create a part key from upload_id and part_number.
fn make_part_key(upload_id: &str, part_number: i32) -> Vec<u8> {
    let mut k = Vec::with_capacity(PREFIX_PART.len() + upload_id.len() + 1 + 4);
    k.extend_from_slice(PREFIX_PART);
    k.extend_from_slice(upload_id.as_bytes());
    k.push(0);
    k.extend_from_slice(&part_number.to_be_bytes());
    k
}

/// Create a part metadata key.
fn make_part_meta_key(upload_id: &str, part_number: i32) -> Vec<u8> {
    let mut k = Vec::with_capacity(PREFIX_PART_META.len() + upload_id.len() + 1 + 4);
    k.extend_from_slice(PREFIX_PART_META);
    k.extend_from_slice(upload_id.as_bytes());
    k.push(0);
    k.extend_from_slice(&part_number.to_be_bytes());
    k
}

/// Encode a timestamp as big-endian u64.
fn encode_timestamp(time: SystemTime) -> [u8; 8] {
    let millis = time
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis() as u64;
    millis.to_be_bytes()
}

/// Decode a timestamp from big-endian u64.
fn decode_timestamp(bytes: &[u8]) -> SystemTime {
    if bytes.len() < 8 {
        return UNIX_EPOCH;
    }
    let millis = u64::from_be_bytes(bytes[..8].try_into().unwrap_or([0; 8]));
    UNIX_EPOCH + Duration::from_millis(millis)
}

/// Compute MD5 hash as hex string (used for ETag).
fn compute_etag(data: &[u8]) -> String {
    format!("{:x}", md5::compute(data))
}

// =============================================================================
// SlateStore configuration and implementation
// =============================================================================

/// Backend type for SlateDB storage.
#[derive(Clone, Debug)]
pub enum SlateBackend {
    /// In-memory storage (no persistence, good for testing).
    InMemory,
    /// Local filesystem storage.
    LocalFileSystem { path: PathBuf },
}

impl Default for SlateBackend {
    fn default() -> Self {
        Self::InMemory
    }
}

/// Configuration for the SlateDB-based store.
#[derive(Clone, Debug, Default)]
pub struct SlateStoreConfig {
    /// The backend storage type.
    pub backend: SlateBackend,
}

impl SlateStoreConfig {
    /// Create a new configuration with the default in-memory backend.
    pub fn in_memory() -> Self {
        Self {
            backend: SlateBackend::InMemory,
        }
    }

    /// Create a new configuration with a local filesystem backend.
    pub fn local_filesystem(path: impl Into<PathBuf>) -> Self {
        Self {
            backend: SlateBackend::LocalFileSystem { path: path.into() },
        }
    }

    /// Create a new configuration with the given path (legacy, uses local filesystem).
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self::local_filesystem(path)
    }
}

/// SlateDB-based persistent storage backend.
///
/// Uses SlateDB LSM-tree database backed by object storage for durable storage.
/// By default, uses an in-memory object store (no persistence).
pub struct SlateStore {
    /// The SlateDB database handle.
    db: Db,
    /// Configuration.
    #[allow(dead_code)]
    config: SlateStoreConfig,
}

impl SlateStore {
    /// Open a SlateDB-based store with the given configuration.
    pub async fn open(config: SlateStoreConfig) -> StoreResult<Self> {
        match &config.backend {
            SlateBackend::InMemory => {
                debug!("opening slatedb store with in-memory backend");
                let object_store = Arc::new(InMemory::new());
                let db = Db::open("/", object_store).await?;
                debug!("slatedb store opened successfully (in-memory)");
                Ok(Self { db, config })
            }
            SlateBackend::LocalFileSystem { path } => {
                debug!(path = %path.display(), "opening slatedb store with local filesystem backend");

                // Create the directory if it doesn't exist
                std::fs::create_dir_all(path).map_err(|e| {
                    StoreError::Internal(format!("failed to create directory: {e}"))
                })?;

                // Use local filesystem as the object store
                let object_store = Arc::new(LocalFileSystem::new());
                let db_path = path.to_string_lossy();

                let db = Db::open(db_path.as_ref(), object_store).await?;

                debug!(path = %path.display(), "slatedb store opened successfully");

                Ok(Self { db, config })
            }
        }
    }

    /// Open a SlateDB-based store with the default in-memory backend.
    pub async fn open_in_memory() -> StoreResult<Self> {
        Self::open(SlateStoreConfig::in_memory()).await
    }

    /// Check if a bucket exists.
    async fn bucket_exists_internal(&self, bucket: &str) -> StoreResult<bool> {
        let key = make_bucket_key(bucket);
        Ok(self.db.get(&key).await?.is_some())
    }

    /// Get multipart upload state.
    async fn get_multipart(&self, upload_id: &str) -> StoreResult<Option<StoredMultipartUpload>> {
        let key = make_multipart_key(upload_id);
        match self.db.get(&key).await? {
            Some(data) => {
                let upload: StoredMultipartUpload = serde_json::from_slice(&data)
                    .map_err(|e| StoreError::Internal(format!("failed to parse multipart: {e}")))?;
                Ok(Some(upload))
            }
            None => Ok(None),
        }
    }

    /// Close the database gracefully.
    pub async fn close(self) -> StoreResult<()> {
        self.db.close().await?;
        Ok(())
    }
}

#[async_trait::async_trait]
impl Store for SlateStore {
    // =========================================================================
    // Bucket operations
    // =========================================================================

    async fn create_bucket(&self, bucket: &str) -> StoreResult<()> {
        if self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketAlreadyExists(bucket.to_string()));
        }

        let key = make_bucket_key(bucket);
        let timestamp = encode_timestamp(SystemTime::now());
        self.db.put(&key, &timestamp).await?;

        debug!(bucket, "bucket created");
        Ok(())
    }

    async fn delete_bucket(&self, bucket: &str) -> StoreResult<()> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Check if bucket is empty by scanning for any objects with this bucket prefix
        let prefix = make_object_key(bucket, "");
        let mut iter = self.db.scan(prefix.clone()..).await?;
        if let Ok(Some(kv)) = iter.next().await {
            // Check if this key actually belongs to this bucket
            if kv.key.starts_with(&prefix) {
                return Err(StoreError::BucketNotEmpty(bucket.to_string()));
            }
        }

        let key = make_bucket_key(bucket);
        self.db.delete(&key).await?;
        debug!(bucket, "bucket deleted");
        Ok(())
    }

    async fn bucket_exists(&self, bucket: &str) -> StoreResult<bool> {
        self.bucket_exists_internal(bucket).await
    }

    async fn list_buckets(&self) -> StoreResult<Vec<BucketInfo>> {
        let mut buckets = Vec::new();

        let mut iter = self.db.scan(PREFIX_BUCKET.to_vec()..).await?;
        while let Ok(Some(kv)) = iter.next().await {
            // Stop if we've moved past bucket prefix
            if !kv.key.starts_with(PREFIX_BUCKET) {
                break;
            }

            let name = String::from_utf8_lossy(&kv.key[PREFIX_BUCKET.len()..]).to_string();
            let created_at = decode_timestamp(&kv.value);
            buckets.push(BucketInfo { name, created_at });
        }

        Ok(buckets)
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    async fn put_object(
        &self,
        bucket: &str,
        key: &str,
        data: Bytes,
        mut meta: ObjectMeta,
        options: PutObjectOptions,
    ) -> StoreResult<PutObjectResult> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let has_conditions = options.if_none_match || options.if_match.is_some();

        // Fast path: no conditions, use direct writes
        if !has_conditions {
            let obj_key = make_object_key(bucket, key);
            let meta_key = make_meta_key(bucket, key);

            let etag = compute_etag(&data);
            meta.size = data.len() as u64;
            meta.last_modified = SystemTime::now();
            meta.etag = etag.clone();

            let stored_meta = StoredObjectMeta::from_object_meta(&meta);
            let meta_json = serde_json::to_vec(&stored_meta)
                .map_err(|e| StoreError::Internal(format!("failed to serialize meta: {e}")))?;

            self.db.put(&obj_key, &data).await?;
            self.db.put(&meta_key, &meta_json).await?;

            debug!(bucket, key, "object stored");
            return Ok(PutObjectResult { etag });
        }

        // Slow path: use transaction for atomic conditional writes
        let obj_key = make_object_key(bucket, key);
        let meta_key = make_meta_key(bucket, key);

        for attempt in 0..MAX_TRANSACTION_RETRIES {
            let txn = self.db.begin(IsolationLevel::Snapshot).await?;

            // Check if_none_match condition within transaction
            if options.if_none_match {
                if txn.get(&obj_key).await?.is_some() {
                    return Err(StoreError::PreconditionFailed(format!(
                        "object already exists: {}/{}",
                        bucket, key
                    )));
                }
            }

            // Check if_match condition within transaction
            if let Some(ref expected_etag) = options.if_match {
                match txn.get(&meta_key).await? {
                    Some(meta_bytes) => {
                        let stored_meta: StoredObjectMeta = serde_json::from_slice(&meta_bytes)
                            .map_err(|e| {
                                StoreError::Internal(format!("failed to parse meta: {e}"))
                            })?;
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

            // Prepare write data
            let etag = compute_etag(&data);
            let mut write_meta = meta.clone();
            write_meta.size = data.len() as u64;
            write_meta.last_modified = SystemTime::now();
            write_meta.etag = etag.clone();

            let stored_meta = StoredObjectMeta::from_object_meta(&write_meta);
            let meta_json = serde_json::to_vec(&stored_meta)
                .map_err(|e| StoreError::Internal(format!("failed to serialize meta: {e}")))?;

            // Write within transaction
            txn.put(&obj_key, &data)?;
            txn.put(&meta_key, &meta_json)?;

            // Commit - retry on conflict
            match txn.commit().await {
                Ok(()) => {
                    debug!(bucket, key, attempt, "object stored (transactional)");
                    return Ok(PutObjectResult { etag });
                }
                Err(e) if e.kind() == ErrorKind::Transaction => {
                    debug!(bucket, key, attempt, "transaction conflict, retrying");
                    continue;
                }
                Err(e) => return Err(StoreError::from(e)),
            }
        }

        // Exhausted retries
        Err(StoreError::ConditionalRequestConflict(format!(
            "failed to complete conditional write after {} retries: {}/{}",
            MAX_TRANSACTION_RETRIES, bucket, key
        )))
    }

    async fn get_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectData> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let obj_key = make_object_key(bucket, key);
        let meta_key = make_meta_key(bucket, key);

        let data = self
            .db
            .get(&obj_key)
            .await?
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        let meta_bytes = self
            .db
            .get(&meta_key)
            .await?
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        let stored_meta: StoredObjectMeta = serde_json::from_slice(&meta_bytes)
            .map_err(|e| StoreError::Internal(format!("failed to parse meta: {e}")))?;

        Ok(ObjectData {
            data,
            meta: stored_meta.to_object_meta(),
        })
    }

    async fn get_object_range(
        &self,
        bucket: &str,
        key: &str,
        range: Range<u64>,
    ) -> StoreResult<Bytes> {
        let obj = self.get_object(bucket, key).await?;

        let start = range.start as usize;
        let end = std::cmp::min(range.end as usize, obj.data.len());

        if start >= obj.data.len() {
            return Err(StoreError::InvalidRange(format!(
                "start {} >= size {}",
                start,
                obj.data.len()
            )));
        }

        Ok(obj.data.slice(start..end))
    }

    async fn head_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectMeta> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let meta_key = make_meta_key(bucket, key);

        let meta_bytes = self
            .db
            .get(&meta_key)
            .await?
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        let stored_meta: StoredObjectMeta = serde_json::from_slice(&meta_bytes)
            .map_err(|e| StoreError::Internal(format!("failed to parse meta: {e}")))?;

        Ok(stored_meta.to_object_meta())
    }

    async fn delete_object(&self, bucket: &str, key: &str) -> StoreResult<()> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let obj_key = make_object_key(bucket, key);
        let meta_key = make_meta_key(bucket, key);

        self.db.delete(&obj_key).await?;
        self.db.delete(&meta_key).await?;

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
        let src_obj = self.get_object(src_bucket, src_key).await?;

        if !self.bucket_exists_internal(dst_bucket).await? {
            return Err(StoreError::BucketNotFound(dst_bucket.to_string()));
        }

        let mut meta = src_obj.meta.clone();
        meta.last_modified = SystemTime::now();

        let result = CopyObjectResult {
            etag: meta.etag.clone(),
            last_modified: meta.last_modified,
        };

        let dst_obj_key = make_object_key(dst_bucket, dst_key);
        let dst_meta_key = make_meta_key(dst_bucket, dst_key);

        let stored_meta = StoredObjectMeta::from_object_meta(&meta);
        let meta_json = serde_json::to_vec(&stored_meta)
            .map_err(|e| StoreError::Internal(format!("failed to serialize meta: {e}")))?;

        self.db.put(&dst_obj_key, &src_obj.data).await?;
        self.db.put(&dst_meta_key, &meta_json).await?;

        debug!(src_bucket, src_key, dst_bucket, dst_key, "object copied");
        Ok(result)
    }

    async fn list_objects(
        &self,
        bucket: &str,
        options: ListObjectsOptions,
    ) -> StoreResult<ListObjectsResult> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let prefix = options.prefix.as_deref().unwrap_or("");
        let delimiter = options.delimiter.as_deref();
        let max_keys = options.max_keys as usize;
        let start_after = options.start_after.as_deref().unwrap_or("");

        let mut entries: Vec<ObjectEntry> = Vec::new();
        let mut common_prefixes_set: BTreeSet<String> = BTreeSet::new();

        // Scan objects with this bucket prefix
        let scan_prefix = make_object_key(bucket, "");
        let mut iter = self.db.scan(scan_prefix.clone()..).await?;

        while let Ok(Some(kv)) = iter.next().await {
            // Stop if we've moved past this bucket's objects
            if !kv.key.starts_with(&scan_prefix) {
                break;
            }

            let (entry_bucket, key) = match parse_prefixed_object_key(&kv.key, PREFIX_OBJECT) {
                Some((b, k)) => (b, k),
                None => continue,
            };

            if entry_bucket != bucket {
                continue;
            }

            if !key.starts_with(prefix) {
                continue;
            }

            if !start_after.is_empty() && key.as_str() <= start_after {
                continue;
            }

            // Handle delimiter
            if let Some(delim) = delimiter {
                let suffix = &key[prefix.len()..];
                if let Some(pos) = suffix.find(delim) {
                    let common_prefix = format!("{}{}", prefix, &suffix[..=pos]);
                    common_prefixes_set.insert(common_prefix);
                    continue;
                }
            }

            // Get metadata for this object
            let meta_key = make_meta_key(bucket, &key);
            if let Some(meta_bytes) = self.db.get(&meta_key).await? {
                if let Ok(stored_meta) = serde_json::from_slice::<StoredObjectMeta>(&meta_bytes) {
                    entries.push(ObjectEntry {
                        key,
                        last_modified: UNIX_EPOCH
                            + Duration::from_millis(stored_meta.last_modified_millis),
                        size: stored_meta.size,
                        etag: stored_meta.etag,
                    });
                }
            }
        }

        // Sort by key
        entries.sort_by(|a, b| a.key.cmp(&b.key));

        // Apply pagination
        let total_count = entries.len() + common_prefixes_set.len();
        let is_truncated = total_count > max_keys;

        let mut result_entries = Vec::new();
        let mut result_prefixes = Vec::new();
        let mut entries_iter = entries.into_iter().peekable();
        let mut prefixes_iter = common_prefixes_set.into_iter().peekable();
        let mut count = 0;

        while count < max_keys {
            match (entries_iter.peek(), prefixes_iter.peek()) {
                (Some(e), Some(p)) => {
                    if e.key.as_str() < p.as_str() {
                        result_entries.push(entries_iter.next().unwrap());
                    } else {
                        result_prefixes.push(CommonPrefix {
                            prefix: prefixes_iter.next().unwrap(),
                        });
                    }
                }
                (Some(_), None) => {
                    result_entries.push(entries_iter.next().unwrap());
                }
                (None, Some(_)) => {
                    result_prefixes.push(CommonPrefix {
                        prefix: prefixes_iter.next().unwrap(),
                    });
                }
                (None, None) => break,
            }
            count += 1;
        }

        let key_count = result_entries.len() + result_prefixes.len();

        Ok(ListObjectsResult {
            objects: result_entries,
            common_prefixes: result_prefixes,
            is_truncated,
            next_continuation_token: if is_truncated {
                Some(format!("token-{}", total_count))
            } else {
                None
            },
            key_count: key_count as u32,
        })
    }

    // =========================================================================
    // Multipart upload operations
    // =========================================================================

    async fn create_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        meta: ObjectMeta,
    ) -> StoreResult<String> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let upload_id = uuid::Uuid::new_v4().to_string();
        let now = SystemTime::now();
        let initiated_millis = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

        let upload = StoredMultipartUpload {
            bucket: bucket.to_string(),
            key: key.to_string(),
            meta: StoredObjectMeta::from_object_meta(&meta),
            initiated_millis,
        };

        let upload_json = serde_json::to_vec(&upload)
            .map_err(|e| StoreError::Internal(format!("failed to serialize multipart: {e}")))?;

        let db_key = make_multipart_key(&upload_id);
        self.db.put(&db_key, &upload_json).await?;

        debug!(bucket, key, upload_id = %upload_id, "multipart upload created");
        Ok(upload_id)
    }

    async fn upload_part(
        &self,
        bucket: &str,
        upload_id: &str,
        part_number: i32,
        data: Bytes,
    ) -> StoreResult<PartInfo> {
        if !(1..=10000).contains(&part_number) {
            return Err(StoreError::InvalidPartNumber(part_number));
        }

        let upload = self
            .get_multipart(upload_id)
            .await?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        let etag = compute_etag(&data);
        let size = data.len() as u64;
        let now = SystemTime::now();
        let last_modified_millis = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

        let part_key = make_part_key(upload_id, part_number);
        let part_meta_key = make_part_meta_key(upload_id, part_number);

        let part_meta = StoredPartMeta {
            part_number,
            etag: etag.clone(),
            size,
            last_modified_millis,
        };

        let meta_json = serde_json::to_vec(&part_meta)
            .map_err(|e| StoreError::Internal(format!("failed to serialize part meta: {e}")))?;

        self.db.put(&part_key, &data).await?;
        self.db.put(&part_meta_key, &meta_json).await?;

        debug!(upload_id, part_number, size, "part uploaded");
        Ok(PartInfo {
            part_number,
            etag,
            size,
            last_modified: now,
        })
    }

    async fn complete_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> StoreResult<CompleteMultipartResult> {
        let upload = self
            .get_multipart(upload_id)
            .await?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        // Assemble parts in the order specified
        let mut combined_data = Vec::new();
        for completed in parts {
            let part_key = make_part_key(upload_id, completed.part_number);
            let part_data = self.db.get(&part_key).await?.ok_or_else(|| StoreError::PartNotFound {
                upload_id: upload_id.to_string(),
                part_number: completed.part_number,
            })?;
            combined_data.extend_from_slice(&part_data);
        }

        let data = Bytes::from(combined_data);
        let etag = compute_etag(&data);

        let mut meta = upload.meta.to_object_meta();
        meta.size = data.len() as u64;
        meta.last_modified = SystemTime::now();
        meta.etag = etag.clone();

        // Store the final object
        let obj_key = make_object_key(bucket, key);
        let meta_key = make_meta_key(bucket, key);
        let stored_meta = StoredObjectMeta::from_object_meta(&meta);
        let meta_json = serde_json::to_vec(&stored_meta)
            .map_err(|e| StoreError::Internal(format!("failed to serialize meta: {e}")))?;

        self.db.put(&obj_key, &data).await?;
        self.db.put(&meta_key, &meta_json).await?;

        // Clean up multipart state
        let multipart_key = make_multipart_key(upload_id);
        self.db.delete(&multipart_key).await?;

        // Clean up parts (we need to delete each part individually)
        for completed in parts {
            let part_key = make_part_key(upload_id, completed.part_number);
            let part_meta_key = make_part_meta_key(upload_id, completed.part_number);
            self.db.delete(&part_key).await?;
            self.db.delete(&part_meta_key).await?;
        }

        debug!(bucket, key, upload_id, "multipart upload completed");
        Ok(CompleteMultipartResult { etag })
    }

    async fn abort_multipart_upload(&self, bucket: &str, upload_id: &str) -> StoreResult<()> {
        let upload = self
            .get_multipart(upload_id)
            .await?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        // Remove multipart state
        let multipart_key = make_multipart_key(upload_id);
        self.db.delete(&multipart_key).await?;

        // Clean up parts by scanning for them
        let part_prefix = {
            let mut k = Vec::with_capacity(PREFIX_PART.len() + upload_id.len() + 1);
            k.extend_from_slice(PREFIX_PART);
            k.extend_from_slice(upload_id.as_bytes());
            k.push(0);
            k
        };

        let mut parts_to_delete = Vec::new();
        let mut iter = self.db.scan(part_prefix.clone()..).await?;
        while let Ok(Some(kv)) = iter.next().await {
            if !kv.key.starts_with(&part_prefix) {
                break;
            }
            parts_to_delete.push(kv.key.to_vec());
        }

        for part_key in parts_to_delete {
            self.db.delete(&part_key).await?;
            // Also delete the corresponding metadata
            let mut meta_key = PREFIX_PART_META.to_vec();
            meta_key.extend_from_slice(&part_key[PREFIX_PART.len()..]);
            self.db.delete(&meta_key).await?;
        }

        debug!(bucket, upload_id, "multipart upload aborted");
        Ok(())
    }

    async fn list_parts(&self, bucket: &str, upload_id: &str) -> StoreResult<Vec<PartInfo>> {
        let upload = self
            .get_multipart(upload_id)
            .await?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        let part_meta_prefix = {
            let mut k = Vec::with_capacity(PREFIX_PART_META.len() + upload_id.len() + 1);
            k.extend_from_slice(PREFIX_PART_META);
            k.extend_from_slice(upload_id.as_bytes());
            k.push(0);
            k
        };

        let mut parts = Vec::new();
        let mut iter = self.db.scan(part_meta_prefix.clone()..).await?;

        while let Ok(Some(kv)) = iter.next().await {
            if !kv.key.starts_with(&part_meta_prefix) {
                break;
            }

            let stored: StoredPartMeta = serde_json::from_slice(&kv.value)
                .map_err(|e| StoreError::Internal(format!("failed to parse part meta: {e}")))?;

            parts.push(PartInfo {
                part_number: stored.part_number,
                etag: stored.etag,
                size: stored.size,
                last_modified: UNIX_EPOCH + Duration::from_millis(stored.last_modified_millis),
            });
        }

        parts.sort_by_key(|p| p.part_number);
        Ok(parts)
    }

    async fn list_multipart_uploads(&self, bucket: &str) -> StoreResult<Vec<MultipartUploadInfo>> {
        if !self.bucket_exists_internal(bucket).await? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let mut uploads = Vec::new();
        let mut iter = self.db.scan(PREFIX_MULTIPART.to_vec()..).await?;

        while let Ok(Some(kv)) = iter.next().await {
            if !kv.key.starts_with(PREFIX_MULTIPART) {
                break;
            }

            let upload_id = String::from_utf8_lossy(&kv.key[PREFIX_MULTIPART.len()..]).to_string();
            let stored: StoredMultipartUpload = serde_json::from_slice(&kv.value)
                .map_err(|e| StoreError::Internal(format!("failed to parse multipart: {e}")))?;

            if stored.bucket == bucket {
                uploads.push(MultipartUploadInfo {
                    upload_id,
                    bucket: stored.bucket,
                    key: stored.key,
                    initiated: UNIX_EPOCH + Duration::from_millis(stored.initiated_millis),
                });
            }
        }

        Ok(uploads)
    }
}
