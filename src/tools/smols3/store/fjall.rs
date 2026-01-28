// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fjall-based persistent storage backend.
//!
//! This module provides a persistent implementation of the [`Store`] trait
//! using Fjall as the underlying LSM-tree database.
//!
//! # Architecture
//!
//! The current implementation uses a single database with multiple keyspaces:
//! - `buckets`: bucket name -> creation timestamp (u64 millis, big-endian)
//! - `objects`: bucket\0key -> object data
//! - `object_meta`: bucket\0key -> object metadata (JSON)
//! - `multipart`: upload_id -> multipart state (JSON)
//! - `parts`: upload_id\0part_number -> part data
//! - `part_meta`: upload_id\0part_number -> part metadata (JSON)
//!
//! # Future Improvements
//!
//! - Per-bucket databases for better isolation and concurrent writes
//! - Content-defined chunking (FastCDC) for deduplication
//! - Separate blob storage for large objects
//! - Encryption at rest
//! - Compression

use std::collections::{BTreeSet, HashMap};
use std::ops::Range;
use std::path::PathBuf;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use bytes::Bytes;
use serde::{Deserialize, Serialize};
use tracing::debug;

use super::error::{StoreError, StoreResult};
use super::traits::*;

// =============================================================================
// Serializable types for Fjall storage
// =============================================================================

/// Serializable object metadata for storage.
#[derive(Debug, Clone, Serialize, Deserialize)]
struct StoredObjectMeta {
    content_type: Option<String>,
    content_encoding: Option<String>,
    content_disposition: Option<String>,
    content_language: Option<String>,
    cache_control: Option<String>,
    user_metadata: Option<HashMap<String, String>>,
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

/// Create an object key from bucket and key.
fn make_object_key(bucket: &str, key: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(bucket.len() + 1 + key.len());
    k.extend_from_slice(bucket.as_bytes());
    k.push(0); // null separator
    k.extend_from_slice(key.as_bytes());
    k
}

/// Parse an object key into bucket and key.
fn parse_object_key(key: &[u8]) -> Option<(&str, &str)> {
    let sep_pos = key.iter().position(|&b| b == 0)?;
    let bucket = std::str::from_utf8(&key[..sep_pos]).ok()?;
    let obj_key = std::str::from_utf8(&key[sep_pos + 1..]).ok()?;
    Some((bucket, obj_key))
}

/// Create a part key from upload_id and part_number.
fn make_part_key(upload_id: &str, part_number: i32) -> Vec<u8> {
    let mut k = Vec::with_capacity(upload_id.len() + 1 + 4);
    k.extend_from_slice(upload_id.as_bytes());
    k.push(0);
    k.extend_from_slice(&part_number.to_be_bytes());
    k
}

/// Create a prefix for all parts of an upload.
fn make_part_prefix(upload_id: &str) -> Vec<u8> {
    let mut k = Vec::with_capacity(upload_id.len() + 1);
    k.extend_from_slice(upload_id.as_bytes());
    k.push(0);
    k
}

/// Encode a timestamp as big-endian u64 (for lexicographic ordering).
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
// FjallStore configuration and implementation
// =============================================================================

/// Configuration for the Fjall-based store.
#[derive(Clone, Debug)]
pub struct FjallStoreConfig {
    /// Path to the database directory.
    pub path: PathBuf,
}

impl FjallStoreConfig {
    /// Create a new configuration with the given path.
    pub fn new(path: impl Into<PathBuf>) -> Self {
        Self { path: path.into() }
    }
}

/// Fjall-based persistent storage backend.
///
/// Uses Fjall LSM-tree database for durable storage with
/// efficient reads and writes.
pub struct FjallStore {
    /// The fjall database handle.
    #[allow(dead_code)]
    db: fjall::Database,
    /// Keyspace for bucket metadata.
    buckets: fjall::Keyspace,
    /// Keyspace for object data.
    objects: fjall::Keyspace,
    /// Keyspace for object metadata.
    object_meta: fjall::Keyspace,
    /// Keyspace for multipart upload state.
    multipart: fjall::Keyspace,
    /// Keyspace for multipart parts data.
    parts: fjall::Keyspace,
    /// Keyspace for multipart parts metadata.
    part_meta: fjall::Keyspace,
    /// Configuration.
    #[allow(dead_code)]
    config: FjallStoreConfig,
}

impl FjallStore {
    /// Open a Fjall-based store with the given configuration.
    pub fn open(config: FjallStoreConfig) -> StoreResult<Self> {
        debug!(path = %config.path.display(), "opening fjall store");

        let db = fjall::Database::builder(&config.path).open()?;

        let buckets = db.keyspace("buckets", fjall::KeyspaceCreateOptions::default)?;
        let objects = db.keyspace("objects", fjall::KeyspaceCreateOptions::default)?;
        let object_meta = db.keyspace("object_meta", fjall::KeyspaceCreateOptions::default)?;
        let multipart = db.keyspace("multipart", fjall::KeyspaceCreateOptions::default)?;
        let parts = db.keyspace("parts", fjall::KeyspaceCreateOptions::default)?;
        let part_meta = db.keyspace("part_meta", fjall::KeyspaceCreateOptions::default)?;

        debug!(path = %config.path.display(), "fjall store opened successfully");

        Ok(Self {
            db,
            buckets,
            objects,
            object_meta,
            multipart,
            parts,
            part_meta,
            config,
        })
    }

    /// Check if a bucket exists (internal helper).
    fn bucket_exists_sync(&self, bucket: &str) -> StoreResult<bool> {
        Ok(self.buckets.get(bucket.as_bytes())?.is_some())
    }

    /// Get multipart upload state.
    fn get_multipart(&self, upload_id: &str) -> StoreResult<Option<StoredMultipartUpload>> {
        match self.multipart.get(upload_id.as_bytes())? {
            Some(data) => {
                let upload: StoredMultipartUpload = serde_json::from_slice(&data)
                    .map_err(|e| StoreError::Internal(format!("failed to parse multipart: {e}")))?;
                Ok(Some(upload))
            }
            None => Ok(None),
        }
    }
}

#[async_trait::async_trait]
impl Store for FjallStore {
    // =========================================================================
    // Bucket operations
    // =========================================================================

    async fn create_bucket(&self, bucket: &str) -> StoreResult<()> {
        if self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketAlreadyExists(bucket.to_string()));
        }

        let timestamp = encode_timestamp(SystemTime::now());
        self.buckets.insert(bucket.as_bytes(), timestamp)?;

        debug!(bucket, "bucket created");
        Ok(())
    }

    async fn delete_bucket(&self, bucket: &str) -> StoreResult<()> {
        if !self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        // Check if bucket is empty
        let prefix = make_object_key(bucket, "");
        let mut iter = self.objects.prefix(&prefix);
        if iter.next().is_some() {
            return Err(StoreError::BucketNotEmpty(bucket.to_string()));
        }

        self.buckets.remove(bucket.as_bytes())?;
        debug!(bucket, "bucket deleted");
        Ok(())
    }

    async fn bucket_exists(&self, bucket: &str) -> StoreResult<bool> {
        self.bucket_exists_sync(bucket)
    }

    async fn list_buckets(&self) -> StoreResult<Vec<BucketInfo>> {
        let mut buckets = Vec::new();

        for entry in self.buckets.iter() {
            let (key, value) = entry.into_inner()?;
            let name = String::from_utf8_lossy(&key).to_string();
            let created_at = decode_timestamp(&value);
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
    ) -> StoreResult<PutObjectResult> {
        if !self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let etag = compute_etag(&data);
        meta.size = data.len() as u64;
        meta.last_modified = SystemTime::now();
        meta.etag = etag.clone();

        let obj_key = make_object_key(bucket, key);
        let stored_meta = StoredObjectMeta::from_object_meta(&meta);
        let meta_json = serde_json::to_vec(&stored_meta)
            .map_err(|e| StoreError::Internal(format!("failed to serialize meta: {e}")))?;

        self.objects.insert(&obj_key, data.as_ref())?;
        self.object_meta.insert(&obj_key, meta_json)?;

        debug!(bucket, key, "object stored");
        Ok(PutObjectResult { etag })
    }

    async fn get_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectData> {
        if !self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let obj_key = make_object_key(bucket, key);

        let data = self
            .objects
            .get(&obj_key)?
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        let meta_bytes = self
            .object_meta
            .get(&obj_key)?
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        let stored_meta: StoredObjectMeta = serde_json::from_slice(&meta_bytes)
            .map_err(|e| StoreError::Internal(format!("failed to parse meta: {e}")))?;

        Ok(ObjectData {
            data: Bytes::copy_from_slice(&data),
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
        if !self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let obj_key = make_object_key(bucket, key);

        let meta_bytes = self
            .object_meta
            .get(&obj_key)?
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        let stored_meta: StoredObjectMeta = serde_json::from_slice(&meta_bytes)
            .map_err(|e| StoreError::Internal(format!("failed to parse meta: {e}")))?;

        Ok(stored_meta.to_object_meta())
    }

    async fn delete_object(&self, bucket: &str, key: &str) -> StoreResult<()> {
        if !self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let obj_key = make_object_key(bucket, key);
        self.objects.remove(&obj_key)?;
        self.object_meta.remove(&obj_key)?;

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
        // Get source object
        let src_obj = self.get_object(src_bucket, src_key).await?;

        // Check destination bucket exists
        if !self.bucket_exists_sync(dst_bucket)? {
            return Err(StoreError::BucketNotFound(dst_bucket.to_string()));
        }

        // Create new metadata for the copy
        let mut meta = src_obj.meta.clone();
        meta.last_modified = SystemTime::now();

        let result = CopyObjectResult {
            etag: meta.etag.clone(),
            last_modified: meta.last_modified,
        };

        // Store the copy
        let dst_obj_key = make_object_key(dst_bucket, dst_key);
        let stored_meta = StoredObjectMeta::from_object_meta(&meta);
        let meta_json = serde_json::to_vec(&stored_meta)
            .map_err(|e| StoreError::Internal(format!("failed to serialize meta: {e}")))?;

        self.objects.insert(&dst_obj_key, src_obj.data.as_ref())?;
        self.object_meta.insert(&dst_obj_key, meta_json)?;

        debug!(src_bucket, src_key, dst_bucket, dst_key, "object copied");
        Ok(result)
    }

    async fn list_objects(
        &self,
        bucket: &str,
        options: ListObjectsOptions,
    ) -> StoreResult<ListObjectsResult> {
        if !self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let prefix = options.prefix.as_deref().unwrap_or("");
        let delimiter = options.delimiter.as_deref();
        let max_keys = options.max_keys as usize;
        let start_after = options.start_after.as_deref().unwrap_or("");

        let mut entries: Vec<ObjectEntry> = Vec::new();
        let mut common_prefixes_set: BTreeSet<String> = BTreeSet::new();

        // Scan all objects in the bucket
        let bucket_prefix = make_object_key(bucket, "");

        for entry in self.objects.prefix(&bucket_prefix) {
            let key_bytes = match entry.key() {
                Ok(k) => k,
                Err(_) => continue,
            };
            let (entry_bucket, key) = match parse_object_key(&key_bytes) {
                Some((b, k)) => (b, k),
                None => continue,
            };

            if entry_bucket != bucket {
                continue;
            }

            if !key.starts_with(prefix) {
                continue;
            }

            if !start_after.is_empty() && key <= start_after {
                continue;
            }

            // Handle delimiter
            if let Some(delim) = delimiter {
                let suffix = &key[prefix.len()..];
                if let Some(pos) = suffix.find(delim) {
                    // This is a common prefix
                    let common_prefix = format!("{}{}", prefix, &suffix[..=pos]);
                    common_prefixes_set.insert(common_prefix);
                    continue;
                }
            }

            // Get metadata for this object
            let obj_key = make_object_key(bucket, key);
            if let Some(meta_bytes) = self.object_meta.get(&obj_key)? {
                if let Ok(stored_meta) = serde_json::from_slice::<StoredObjectMeta>(&meta_bytes) {
                    entries.push(ObjectEntry {
                        key: key.to_string(),
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

        // Apply pagination - interleave entries and prefixes
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
        if !self.bucket_exists_sync(bucket)? {
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

        self.multipart.insert(upload_id.as_bytes(), upload_json)?;

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
            .get_multipart(upload_id)?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        let etag = compute_etag(&data);
        let size = data.len() as u64;
        let now = SystemTime::now();
        let last_modified_millis = now.duration_since(UNIX_EPOCH).unwrap_or_default().as_millis() as u64;

        let part_key = make_part_key(upload_id, part_number);

        let part_meta = StoredPartMeta {
            part_number,
            etag: etag.clone(),
            size,
            last_modified_millis,
        };

        let meta_json = serde_json::to_vec(&part_meta)
            .map_err(|e| StoreError::Internal(format!("failed to serialize part meta: {e}")))?;

        self.parts.insert(&part_key, data.as_ref())?;
        self.part_meta.insert(&part_key, meta_json)?;

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
            .get_multipart(upload_id)?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        // Assemble parts in the order specified
        let mut combined_data = Vec::new();
        for completed in parts {
            let part_key = make_part_key(upload_id, completed.part_number);
            let part_data = self.parts.get(&part_key)?.ok_or_else(|| StoreError::PartNotFound {
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
        let stored_meta = StoredObjectMeta::from_object_meta(&meta);
        let meta_json = serde_json::to_vec(&stored_meta)
            .map_err(|e| StoreError::Internal(format!("failed to serialize meta: {e}")))?;

        self.objects.insert(&obj_key, data.as_ref())?;
        self.object_meta.insert(&obj_key, meta_json)?;

        // Clean up multipart state
        self.multipart.remove(upload_id.as_bytes())?;

        // Clean up parts
        let part_prefix = make_part_prefix(upload_id);
        let parts_to_delete: Vec<_> = self
            .parts
            .prefix(&part_prefix)
            .filter_map(|e| e.key().ok().map(|k| k.to_vec()))
            .collect();

        for part_key in parts_to_delete {
            self.parts.remove(&part_key)?;
            self.part_meta.remove(&part_key)?;
        }

        debug!(bucket, key, upload_id, "multipart upload completed");
        Ok(CompleteMultipartResult { etag })
    }

    async fn abort_multipart_upload(&self, bucket: &str, upload_id: &str) -> StoreResult<()> {
        let upload = self
            .get_multipart(upload_id)?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        // Remove multipart state
        self.multipart.remove(upload_id.as_bytes())?;

        // Clean up parts
        let part_prefix = make_part_prefix(upload_id);
        let parts_to_delete: Vec<_> = self
            .parts
            .prefix(&part_prefix)
            .filter_map(|e| e.key().ok().map(|k| k.to_vec()))
            .collect();

        for part_key in parts_to_delete {
            self.parts.remove(&part_key)?;
            self.part_meta.remove(&part_key)?;
        }

        debug!(bucket, upload_id, "multipart upload aborted");
        Ok(())
    }

    async fn list_parts(&self, bucket: &str, upload_id: &str) -> StoreResult<Vec<PartInfo>> {
        let upload = self
            .get_multipart(upload_id)?
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        let part_prefix = make_part_prefix(upload_id);
        let mut parts = Vec::new();

        for entry in self.part_meta.prefix(&part_prefix) {
            let value = entry.value()?;
            let stored: StoredPartMeta = serde_json::from_slice(&value)
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
        if !self.bucket_exists_sync(bucket)? {
            return Err(StoreError::BucketNotFound(bucket.to_string()));
        }

        let mut uploads = Vec::new();

        for entry in self.multipart.iter() {
            let (key, value) = entry.into_inner()?;
            let upload_id = String::from_utf8_lossy(&key).to_string();
            let stored: StoredMultipartUpload = serde_json::from_slice(&value)
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
