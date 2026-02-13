// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! In-memory storage backend.
//!
//! This module provides an in-memory implementation of the [`Store`] trait
//! for testing and development purposes. Data is not persisted across restarts.

use std::collections::HashMap;
use std::ops::Range;
use std::sync::RwLock;
use std::time::SystemTime;

use bytes::Bytes;
use tracing::debug;

use super::error::{StoreError, StoreResult};
use super::traits::*;

/// Internal representation of a stored object.
struct StoredObject {
    data: Bytes,
    meta: ObjectMeta,
}

/// Internal representation of a multipart upload.
struct MultipartUpload {
    bucket: String,
    key: String,
    meta: ObjectMeta,
    parts: HashMap<i32, StoredPart>,
    initiated: SystemTime,
}

/// Internal representation of an uploaded part.
struct StoredPart {
    data: Bytes,
    etag: String,
    last_modified: SystemTime,
}

/// In-memory implementation of the [`Store`] trait.
///
/// Uses `RwLock<HashMap>` for thread-safe concurrent access.
/// All data is lost when the store is dropped.
pub struct MemoryStore {
    /// Bucket metadata: name -> creation time
    buckets: RwLock<HashMap<String, SystemTime>>,
    /// Objects: (bucket, key) -> object
    objects: RwLock<HashMap<(String, String), StoredObject>>,
    /// Multipart uploads: upload_id -> upload state
    multiparts: RwLock<HashMap<String, MultipartUpload>>,
}

impl MemoryStore {
    /// Create a new in-memory store.
    pub fn new() -> Self {
        debug!("creating new in-memory store");
        Self {
            buckets: RwLock::new(HashMap::new()),
            objects: RwLock::new(HashMap::new()),
            multiparts: RwLock::new(HashMap::new()),
        }
    }

    /// Generate a unique upload ID.
    fn generate_upload_id() -> String {
        uuid::Uuid::new_v4().to_string()
    }

    /// Compute MD5 hash as hex string (used for ETag).
    fn compute_etag(data: &[u8]) -> String {
        format!("{:x}", md5::compute(data))
    }
}

impl Default for MemoryStore {
    fn default() -> Self {
        Self::new()
    }
}

#[async_trait::async_trait]
impl Store for MemoryStore {
    // =========================================================================
    // Bucket operations
    // =========================================================================

    async fn create_bucket(&self, bucket: &str) -> StoreResult<()> {
        let mut buckets = self.buckets.write().unwrap();
        if buckets.contains_key(bucket) {
            return Err(StoreError::BucketAlreadyExists(bucket.to_string()));
        }
        buckets.insert(bucket.to_string(), SystemTime::now());
        debug!(bucket, "bucket created");
        Ok(())
    }

    async fn delete_bucket(&self, bucket: &str) -> StoreResult<()> {
        // Check if bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        // Check if bucket is empty
        {
            let objects = self.objects.read().unwrap();
            let has_objects = objects.keys().any(|(b, _)| b == bucket);
            if has_objects {
                return Err(StoreError::BucketNotEmpty(bucket.to_string()));
            }
        }

        // Delete the bucket
        let mut buckets = self.buckets.write().unwrap();
        buckets.remove(bucket);
        debug!(bucket, "bucket deleted");
        Ok(())
    }

    async fn bucket_exists(&self, bucket: &str) -> StoreResult<bool> {
        let buckets = self.buckets.read().unwrap();
        Ok(buckets.contains_key(bucket))
    }

    async fn list_buckets(&self) -> StoreResult<Vec<BucketInfo>> {
        let buckets = self.buckets.read().unwrap();
        let result = buckets
            .iter()
            .map(|(name, &created_at)| BucketInfo {
                name: name.clone(),
                created_at,
            })
            .collect();
        Ok(result)
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    async fn put_object(
        &self,
        bucket: &str,
        key: &str,
        data: BodyStream,
        mut meta: ObjectMeta,
        options: PutObjectOptions,
    ) -> StoreResult<PutObjectResult> {
        let data = data.collect_bytes().await?;

        // Check bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        let etag = Self::compute_etag(&data);
        meta.size = data.len() as u64;
        meta.last_modified = SystemTime::now();
        meta.etag = etag.clone();

        let obj = StoredObject { data, meta };
        let mut objects = self.objects.write().unwrap();
        let obj_key = (bucket.to_string(), key.to_string());

        // Handle conditional writes
        if options.if_none_match {
            // If-None-Match: * - only succeed if object doesn't exist
            if objects.contains_key(&obj_key) {
                return Err(StoreError::PreconditionFailed(format!(
                    "object already exists: {}/{}",
                    bucket, key
                )));
            }
        }

        if let Some(ref expected_etag) = options.if_match {
            // If-Match: <etag> - only succeed if existing object's ETag matches
            match objects.get(&obj_key) {
                Some(existing) => {
                    if existing.meta.etag != *expected_etag {
                        return Err(StoreError::PreconditionFailed(format!(
                            "ETag mismatch: expected {}, found {}",
                            expected_etag, existing.meta.etag
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

        objects.insert(obj_key, obj);

        debug!(bucket, key, "object stored");
        Ok(PutObjectResult { etag })
    }

    async fn get_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectData> {
        // Check bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        let objects = self.objects.read().unwrap();
        let obj = objects
            .get(&(bucket.to_string(), key.to_string()))
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        Ok(ObjectData {
            data: obj.data.clone(),
            meta: obj.meta.clone(),
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
        // Check bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        let objects = self.objects.read().unwrap();
        let obj = objects
            .get(&(bucket.to_string(), key.to_string()))
            .ok_or_else(|| StoreError::ObjectNotFound {
                bucket: bucket.to_string(),
                key: key.to_string(),
            })?;

        Ok(obj.meta.clone())
    }

    async fn delete_object(&self, bucket: &str, key: &str) -> StoreResult<()> {
        // Check bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        let mut objects = self.objects.write().unwrap();
        objects.remove(&(bucket.to_string(), key.to_string()));
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
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(dst_bucket) {
                return Err(StoreError::BucketNotFound(dst_bucket.to_string()));
            }
        }

        // Create new metadata for the copy
        let mut meta = src_obj.meta.clone();
        meta.last_modified = SystemTime::now();

        let result = CopyObjectResult {
            etag: meta.etag.clone(),
            last_modified: meta.last_modified,
        };

        // Store the copy
        let obj = StoredObject {
            data: src_obj.data,
            meta,
        };
        let mut objects = self.objects.write().unwrap();
        objects.insert((dst_bucket.to_string(), dst_key.to_string()), obj);

        debug!(
            src_bucket,
            src_key, dst_bucket, dst_key, "object copied"
        );
        Ok(result)
    }

    async fn list_objects(
        &self,
        bucket: &str,
        options: ListObjectsOptions,
    ) -> StoreResult<ListObjectsResult> {
        // Check bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        let objects = self.objects.read().unwrap();
        let prefix = options.prefix.as_deref().unwrap_or("");
        let delimiter = options.delimiter.as_deref();
        let max_keys = options.max_keys as usize;
        let start_after = options.start_after.as_deref().unwrap_or("");

        let mut entries: Vec<ObjectEntry> = Vec::new();
        let mut common_prefixes_set: std::collections::BTreeSet<String> =
            std::collections::BTreeSet::new();

        // Collect matching objects
        for ((b, key), obj) in objects.iter() {
            if b != bucket {
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
                    // This is a common prefix
                    let common_prefix = format!("{}{}", prefix, &suffix[..=pos]);
                    common_prefixes_set.insert(common_prefix);
                    continue;
                }
            }

            entries.push(ObjectEntry {
                key: key.clone(),
                last_modified: obj.meta.last_modified,
                size: obj.meta.size,
                etag: obj.meta.etag.clone(),
            });
        }

        // Sort by key
        entries.sort_by(|a, b| a.key.cmp(&b.key));

        // Apply pagination
        let is_truncated = entries.len() + common_prefixes_set.len() > max_keys;
        let total_count = entries.len() + common_prefixes_set.len();

        // Interleave entries and prefixes, truncate to max_keys
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
        // Check bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        let upload_id = Self::generate_upload_id();
        let upload = MultipartUpload {
            bucket: bucket.to_string(),
            key: key.to_string(),
            meta,
            parts: HashMap::new(),
            initiated: SystemTime::now(),
        };

        let mut multiparts = self.multiparts.write().unwrap();
        multiparts.insert(upload_id.clone(), upload);

        debug!(bucket, key, upload_id = %upload_id, "multipart upload created");
        Ok(upload_id)
    }

    async fn upload_part(
        &self,
        bucket: &str,
        upload_id: &str,
        part_number: i32,
        data: BodyStream,
    ) -> StoreResult<PartInfo> {
        let data = data.collect_bytes().await?;

        if !(1..=10000).contains(&part_number) {
            return Err(StoreError::InvalidPartNumber(part_number));
        }

        let mut multiparts = self.multiparts.write().unwrap();
        let upload = multiparts
            .get_mut(upload_id)
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        let etag = Self::compute_etag(&data);
        let size = data.len() as u64;
        let last_modified = SystemTime::now();

        let part = StoredPart {
            data,
            etag: etag.clone(),
            last_modified,
        };
        upload.parts.insert(part_number, part);

        debug!(upload_id, part_number, size, "part uploaded");
        Ok(PartInfo {
            part_number,
            etag,
            size,
            last_modified,
        })
    }

    async fn complete_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> StoreResult<CompleteMultipartResult> {
        let upload = {
            let mut multiparts = self.multiparts.write().unwrap();
            multiparts
                .remove(upload_id)
                .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?
        };

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        // Assemble parts in order
        let mut combined_data = Vec::new();
        for completed in parts {
            let stored = upload.parts.get(&completed.part_number).ok_or_else(|| {
                StoreError::PartNotFound {
                    upload_id: upload_id.to_string(),
                    part_number: completed.part_number,
                }
            })?;
            combined_data.extend_from_slice(&stored.data);
        }

        let data = Bytes::from(combined_data);
        let etag = Self::compute_etag(&data);

        let mut meta = upload.meta;
        meta.size = data.len() as u64;
        meta.last_modified = SystemTime::now();
        meta.etag = etag.clone();

        let obj = StoredObject { data, meta };
        let mut objects = self.objects.write().unwrap();
        objects.insert((bucket.to_string(), key.to_string()), obj);

        debug!(bucket, key, upload_id, "multipart upload completed");
        Ok(CompleteMultipartResult { etag })
    }

    async fn abort_multipart_upload(&self, bucket: &str, upload_id: &str) -> StoreResult<()> {
        let mut multiparts = self.multiparts.write().unwrap();
        let upload = multiparts
            .remove(upload_id)
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            // Put it back and return error
            multiparts.insert(upload_id.to_string(), upload);
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        debug!(bucket, upload_id, "multipart upload aborted");
        Ok(())
    }

    async fn list_parts(&self, bucket: &str, upload_id: &str) -> StoreResult<Vec<PartInfo>> {
        let multiparts = self.multiparts.read().unwrap();
        let upload = multiparts
            .get(upload_id)
            .ok_or_else(|| StoreError::MultipartNotFound(upload_id.to_string()))?;

        if upload.bucket != bucket {
            return Err(StoreError::MultipartNotFound(upload_id.to_string()));
        }

        let mut parts: Vec<PartInfo> = upload
            .parts
            .iter()
            .map(|(&part_number, part)| PartInfo {
                part_number,
                etag: part.etag.clone(),
                size: part.data.len() as u64,
                last_modified: part.last_modified,
            })
            .collect();

        parts.sort_by_key(|p| p.part_number);
        Ok(parts)
    }

    async fn list_multipart_uploads(&self, bucket: &str) -> StoreResult<Vec<MultipartUploadInfo>> {
        // Check bucket exists
        {
            let buckets = self.buckets.read().unwrap();
            if !buckets.contains_key(bucket) {
                return Err(StoreError::BucketNotFound(bucket.to_string()));
            }
        }

        let multiparts = self.multiparts.read().unwrap();
        let uploads: Vec<MultipartUploadInfo> = multiparts
            .iter()
            .filter(|(_, upload)| upload.bucket == bucket)
            .map(|(upload_id, upload)| MultipartUploadInfo {
                upload_id: upload_id.clone(),
                bucket: upload.bucket.clone(),
                key: upload.key.clone(),
                initiated: upload.initiated,
            })
            .collect();

        Ok(uploads)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::collections::HashMap;

    // =========================================================================
    // Helper functions
    // =========================================================================

    /// Create a store with a test bucket already created.
    async fn setup_store_with_bucket() -> (MemoryStore, &'static str) {
        let store = MemoryStore::new();
        let bucket = "test-bucket";
        store.create_bucket(bucket).await.unwrap();
        (store, bucket)
    }

    /// Create test ObjectMeta with optional content_type.
    fn test_meta(content_type: Option<&str>) -> ObjectMeta {
        ObjectMeta {
            content_type: content_type.map(String::from),
            ..Default::default()
        }
    }

    // =========================================================================
    // 1. Bucket Operations (8 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_create_bucket() {
        let store = MemoryStore::new();

        store.create_bucket("my-bucket").await.unwrap();

        assert!(store.bucket_exists("my-bucket").await.unwrap());
    }

    #[tokio::test]
    async fn test_create_bucket_duplicate() {
        let store = MemoryStore::new();

        store.create_bucket("my-bucket").await.unwrap();
        let result = store.create_bucket("my-bucket").await;

        assert!(matches!(result, Err(StoreError::BucketAlreadyExists(_))));
    }

    #[tokio::test]
    async fn test_delete_bucket() {
        let store = MemoryStore::new();

        store.create_bucket("my-bucket").await.unwrap();
        assert!(store.bucket_exists("my-bucket").await.unwrap());

        store.delete_bucket("my-bucket").await.unwrap();
        assert!(!store.bucket_exists("my-bucket").await.unwrap());
    }

    #[tokio::test]
    async fn test_delete_bucket_not_found() {
        let store = MemoryStore::new();

        let result = store.delete_bucket("nonexistent").await;

        assert!(matches!(result, Err(StoreError::BucketNotFound(_))));
    }

    #[tokio::test]
    async fn test_delete_bucket_not_empty() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "key", Bytes::from("data").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store.delete_bucket(bucket).await;

        assert!(matches!(result, Err(StoreError::BucketNotEmpty(_))));
    }

    #[tokio::test]
    async fn test_bucket_exists() {
        let store = MemoryStore::new();

        assert!(!store.bucket_exists("my-bucket").await.unwrap());

        store.create_bucket("my-bucket").await.unwrap();

        assert!(store.bucket_exists("my-bucket").await.unwrap());
    }

    #[tokio::test]
    async fn test_list_buckets_empty() {
        let store = MemoryStore::new();

        let buckets = store.list_buckets().await.unwrap();

        assert!(buckets.is_empty());
    }

    #[tokio::test]
    async fn test_list_buckets_multiple() {
        let store = MemoryStore::new();

        store.create_bucket("bucket-a").await.unwrap();
        store.create_bucket("bucket-b").await.unwrap();
        store.create_bucket("bucket-c").await.unwrap();

        let buckets = store.list_buckets().await.unwrap();

        assert_eq!(buckets.len(), 3);
        let names: Vec<&str> = buckets.iter().map(|b| b.name.as_str()).collect();
        assert!(names.contains(&"bucket-a"));
        assert!(names.contains(&"bucket-b"));
        assert!(names.contains(&"bucket-c"));
    }

    // =========================================================================
    // 2. Object Operations (14 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_put_object() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = Bytes::from("hello world");

        let result = store
            .put_object(bucket, "my-key", data.clone().into(), test_meta(None), Default::default())
            .await
            .unwrap();

        assert!(!result.etag.is_empty());
        let expected_etag = MemoryStore::compute_etag(&data);
        assert_eq!(result.etag, expected_etag);
    }

    #[tokio::test]
    async fn test_put_object_no_bucket() {
        let store = MemoryStore::new();

        let result = store
            .put_object("nonexistent", "key", Bytes::from("data").into(), test_meta(None), Default::default())
            .await;

        assert!(matches!(result, Err(StoreError::BucketNotFound(_))));
    }

    #[tokio::test]
    async fn test_put_object_overwrite() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "key", Bytes::from("first").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "key", Bytes::from("second").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let obj = store.get_object(bucket, "key").await.unwrap();
        assert_eq!(obj.data, Bytes::from("second"));
    }

    #[tokio::test]
    async fn test_put_object_empty() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store
            .put_object(bucket, "empty-key", Bytes::new().into(), test_meta(None), Default::default())
            .await
            .unwrap();

        assert!(!result.etag.is_empty());

        let obj = store.get_object(bucket, "empty-key").await.unwrap();
        assert!(obj.data.is_empty());
        assert_eq!(obj.meta.size, 0);
    }

    #[tokio::test]
    async fn test_get_object() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = Bytes::from("hello world");

        store
            .put_object(
                bucket,
                "key",
                data.clone().into(),
                test_meta(Some("text/plain")),
                Default::default(),
            )
            .await
            .unwrap();

        let obj = store.get_object(bucket, "key").await.unwrap();

        assert_eq!(obj.data, data);
        assert_eq!(obj.meta.content_type, Some("text/plain".to_string()));
        assert_eq!(obj.meta.size, data.len() as u64);
        assert!(!obj.meta.etag.is_empty());
    }

    #[tokio::test]
    async fn test_get_object_not_found() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store.get_object(bucket, "nonexistent").await;

        assert!(matches!(result, Err(StoreError::ObjectNotFound { .. })));
    }

    #[tokio::test]
    async fn test_get_object_no_bucket() {
        let store = MemoryStore::new();

        let result = store.get_object("nonexistent", "key").await;

        assert!(matches!(result, Err(StoreError::BucketNotFound(_))));
    }

    #[tokio::test]
    async fn test_get_object_range() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = Bytes::from("hello world");

        store
            .put_object(bucket, "key", data.into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let range_data = store.get_object_range(bucket, "key", 0..5).await.unwrap();

        assert_eq!(range_data, Bytes::from("hello"));
    }

    #[tokio::test]
    async fn test_get_object_range_partial() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = Bytes::from("hello");

        store
            .put_object(bucket, "key", data.into(), test_meta(None), Default::default())
            .await
            .unwrap();

        // Range extends past end - should be clamped
        let range_data = store.get_object_range(bucket, "key", 2..100).await.unwrap();

        assert_eq!(range_data, Bytes::from("llo"));
    }

    #[tokio::test]
    async fn test_get_object_range_invalid() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = Bytes::from("hello");

        store
            .put_object(bucket, "key", data.into(), test_meta(None), Default::default())
            .await
            .unwrap();

        // Start >= size
        let result = store.get_object_range(bucket, "key", 10..20).await;

        assert!(matches!(result, Err(StoreError::InvalidRange(_))));
    }

    #[tokio::test]
    async fn test_head_object() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = Bytes::from("hello world");

        store
            .put_object(
                bucket,
                "key",
                data.clone().into(),
                test_meta(Some("application/json")),
                Default::default(),
            )
            .await
            .unwrap();

        let meta = store.head_object(bucket, "key").await.unwrap();

        assert_eq!(meta.content_type, Some("application/json".to_string()));
        assert_eq!(meta.size, data.len() as u64);
        assert!(!meta.etag.is_empty());
    }

    #[tokio::test]
    async fn test_head_object_not_found() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store.head_object(bucket, "nonexistent").await;

        assert!(matches!(result, Err(StoreError::ObjectNotFound { .. })));
    }

    #[tokio::test]
    async fn test_delete_object() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "key", Bytes::from("data").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        store.delete_object(bucket, "key").await.unwrap();

        let result = store.get_object(bucket, "key").await;
        assert!(matches!(result, Err(StoreError::ObjectNotFound { .. })));
    }

    #[tokio::test]
    async fn test_delete_object_idempotent() {
        let (store, bucket) = setup_store_with_bucket().await;

        // Delete non-existent object should succeed (S3 semantics)
        store.delete_object(bucket, "nonexistent").await.unwrap();

        // Delete same object twice should also succeed
        store
            .put_object(bucket, "key", Bytes::from("data").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store.delete_object(bucket, "key").await.unwrap();
        store.delete_object(bucket, "key").await.unwrap();
    }

    // =========================================================================
    // 3. Copy Object Operations (5 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_copy_object_same_bucket() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = Bytes::from("hello world");

        store
            .put_object(bucket, "source", data.clone().into(), test_meta(Some("text/plain")), Default::default())
            .await
            .unwrap();

        let result = store
            .copy_object(bucket, "source", bucket, "dest")
            .await
            .unwrap();

        assert!(!result.etag.is_empty());

        let dest_obj = store.get_object(bucket, "dest").await.unwrap();
        assert_eq!(dest_obj.data, data);
        assert_eq!(dest_obj.meta.content_type, Some("text/plain".to_string()));
    }

    #[tokio::test]
    async fn test_copy_object_cross_bucket() {
        let store = MemoryStore::new();
        store.create_bucket("src-bucket").await.unwrap();
        store.create_bucket("dst-bucket").await.unwrap();

        let data = Bytes::from("cross bucket data");
        store
            .put_object("src-bucket", "key", data.clone().into(), test_meta(None), Default::default())
            .await
            .unwrap();

        store
            .copy_object("src-bucket", "key", "dst-bucket", "key")
            .await
            .unwrap();

        let dest_obj = store.get_object("dst-bucket", "key").await.unwrap();
        assert_eq!(dest_obj.data, data);
    }

    #[tokio::test]
    async fn test_copy_object_source_not_found() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store
            .copy_object(bucket, "nonexistent", bucket, "dest")
            .await;

        assert!(matches!(result, Err(StoreError::ObjectNotFound { .. })));
    }

    #[tokio::test]
    async fn test_copy_object_dest_bucket_not_found() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "source", Bytes::from("data").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store
            .copy_object(bucket, "source", "nonexistent", "dest")
            .await;

        assert!(matches!(result, Err(StoreError::BucketNotFound(_))));
    }

    #[tokio::test]
    async fn test_copy_object_overwrites_existing() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "source", Bytes::from("source data").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "dest", Bytes::from("original dest").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        store
            .copy_object(bucket, "source", bucket, "dest")
            .await
            .unwrap();

        let dest_obj = store.get_object(bucket, "dest").await.unwrap();
        assert_eq!(dest_obj.data, Bytes::from("source data"));
    }

    // =========================================================================
    // 4. List Objects Operations (10 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_list_objects_empty() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert!(result.objects.is_empty());
        assert!(result.common_prefixes.is_empty());
        assert!(!result.is_truncated);
    }

    #[tokio::test]
    async fn test_list_objects_basic() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "a", Bytes::from("data-a").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "b", Bytes::from("data-b").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "c", Bytes::from("data-c").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result.objects.len(), 3);
        assert_eq!(result.key_count, 3);
    }

    #[tokio::test]
    async fn test_list_objects_no_bucket() {
        let store = MemoryStore::new();

        let result = store
            .list_objects(
                "nonexistent",
                ListObjectsOptions {
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await;

        assert!(matches!(result, Err(StoreError::BucketNotFound(_))));
    }

    #[tokio::test]
    async fn test_list_objects_with_prefix() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "photos/cat.jpg", Bytes::from("cat").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "photos/dog.jpg", Bytes::from("dog").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "docs/readme.txt", Bytes::from("readme").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    prefix: Some("photos/".to_string()),
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result.objects.len(), 2);
        assert!(result.objects.iter().all(|e| e.key.starts_with("photos/")));
    }

    #[tokio::test]
    async fn test_list_objects_with_delimiter() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "photos/2023/cat.jpg", Bytes::from("cat").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "photos/2024/dog.jpg", Bytes::from("dog").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "root.txt", Bytes::from("root").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    delimiter: Some("/".to_string()),
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        // Should have "root.txt" as object and "photos/" as common prefix
        assert_eq!(result.objects.len(), 1);
        assert_eq!(result.objects[0].key, "root.txt");
        assert_eq!(result.common_prefixes.len(), 1);
        assert_eq!(result.common_prefixes[0].prefix, "photos/");
    }

    #[tokio::test]
    async fn test_list_objects_prefix_and_delimiter() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "photos/2023/jan/a.jpg", Bytes::from("a").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "photos/2023/feb/b.jpg", Bytes::from("b").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "photos/2024/mar/c.jpg", Bytes::from("c").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    prefix: Some("photos/".to_string()),
                    delimiter: Some("/".to_string()),
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        // Should have "photos/2023/" and "photos/2024/" as common prefixes
        assert!(result.objects.is_empty());
        assert_eq!(result.common_prefixes.len(), 2);
        let prefixes: Vec<&str> = result.common_prefixes.iter().map(|p| p.prefix.as_str()).collect();
        assert!(prefixes.contains(&"photos/2023/"));
        assert!(prefixes.contains(&"photos/2024/"));
    }

    #[tokio::test]
    async fn test_list_objects_max_keys() {
        let (store, bucket) = setup_store_with_bucket().await;

        for i in 0..10 {
            store
                .put_object(bucket, &format!("key-{:02}", i), Bytes::from("data").into(), test_meta(None), Default::default())
                .await
                .unwrap();
        }

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    max_keys: 3,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result.objects.len(), 3);
        assert!(result.is_truncated);
    }

    #[tokio::test]
    async fn test_list_objects_start_after() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "a", Bytes::from("a").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "b", Bytes::from("b").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "c", Bytes::from("c").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "d", Bytes::from("d").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    start_after: Some("b".to_string()),
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result.objects.len(), 2);
        assert_eq!(result.objects[0].key, "c");
        assert_eq!(result.objects[1].key, "d");
    }

    #[tokio::test]
    async fn test_list_objects_is_truncated() {
        let (store, bucket) = setup_store_with_bucket().await;

        for i in 0..5 {
            store
                .put_object(bucket, &format!("key-{}", i), Bytes::from("data").into(), test_meta(None), Default::default())
                .await
                .unwrap();
        }

        // Request more than available
        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    max_keys: 10,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(!result.is_truncated);
        assert!(result.next_continuation_token.is_none());

        // Request fewer than available
        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    max_keys: 3,
                    ..Default::default()
                },
            )
            .await
            .unwrap();
        assert!(result.is_truncated);
        assert!(result.next_continuation_token.is_some());
    }

    #[tokio::test]
    async fn test_list_objects_sorted() {
        let (store, bucket) = setup_store_with_bucket().await;

        // Insert in non-sorted order
        store
            .put_object(bucket, "zebra", Bytes::from("z").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "apple", Bytes::from("a").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        store
            .put_object(bucket, "mango", Bytes::from("m").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    max_keys: 1000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result.objects[0].key, "apple");
        assert_eq!(result.objects[1].key, "mango");
        assert_eq!(result.objects[2].key, "zebra");
    }

    // =========================================================================
    // 5. Multipart Upload Operations (15 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_create_multipart_upload() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        assert!(!upload_id.is_empty());
    }

    #[tokio::test]
    async fn test_create_multipart_no_bucket() {
        let store = MemoryStore::new();

        let result = store
            .create_multipart_upload("nonexistent", "key", test_meta(None))
            .await;

        assert!(matches!(result, Err(StoreError::BucketNotFound(_))));
    }

    #[tokio::test]
    async fn test_upload_part() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        let part_info = store
            .upload_part(bucket, &upload_id, 1, Bytes::from("part 1 data").into())
            .await
            .unwrap();

        assert_eq!(part_info.part_number, 1);
        assert!(!part_info.etag.is_empty());
        assert_eq!(part_info.size, 11);
    }

    #[tokio::test]
    async fn test_upload_part_invalid_number_zero() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        let result = store
            .upload_part(bucket, &upload_id, 0, Bytes::from("data").into())
            .await;

        assert!(matches!(result, Err(StoreError::InvalidPartNumber(0))));
    }

    #[tokio::test]
    async fn test_upload_part_invalid_number_high() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        let result = store
            .upload_part(bucket, &upload_id, 10001, Bytes::from("data").into())
            .await;

        assert!(matches!(result, Err(StoreError::InvalidPartNumber(10001))));
    }

    #[tokio::test]
    async fn test_upload_part_no_upload() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store
            .upload_part(bucket, "nonexistent-upload-id", 1, Bytes::from("data").into())
            .await;

        assert!(matches!(result, Err(StoreError::MultipartNotFound(_))));
    }

    #[tokio::test]
    async fn test_upload_part_wrong_bucket() {
        let store = MemoryStore::new();
        store.create_bucket("bucket-a").await.unwrap();
        store.create_bucket("bucket-b").await.unwrap();

        let upload_id = store
            .create_multipart_upload("bucket-a", "key", test_meta(None))
            .await
            .unwrap();

        let result = store
            .upload_part("bucket-b", &upload_id, 1, Bytes::from("data").into())
            .await;

        assert!(matches!(result, Err(StoreError::MultipartNotFound(_))));
    }

    #[tokio::test]
    async fn test_upload_part_overwrite() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        store
            .upload_part(bucket, &upload_id, 1, Bytes::from("first").into())
            .await
            .unwrap();
        let part_info = store
            .upload_part(bucket, &upload_id, 1, Bytes::from("second").into())
            .await
            .unwrap();

        assert_eq!(part_info.size, 6); // "second"

        let parts = store.list_parts(bucket, &upload_id).await.unwrap();
        assert_eq!(parts.len(), 1);
        assert_eq!(parts[0].size, 6);
    }

    #[tokio::test]
    async fn test_complete_multipart() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(Some("text/plain")))
            .await
            .unwrap();

        let part1 = store
            .upload_part(bucket, &upload_id, 1, Bytes::from("Hello ").into())
            .await
            .unwrap();
        let part2 = store
            .upload_part(bucket, &upload_id, 2, Bytes::from("World").into())
            .await
            .unwrap();

        let result = store
            .complete_multipart_upload(
                bucket,
                "key",
                &upload_id,
                &[
                    CompletedPart {
                        part_number: 1,
                        etag: part1.etag,
                    },
                    CompletedPart {
                        part_number: 2,
                        etag: part2.etag,
                    },
                ],
            )
            .await
            .unwrap();

        assert!(!result.etag.is_empty());

        let obj = store.get_object(bucket, "key").await.unwrap();
        assert_eq!(obj.data, Bytes::from("Hello World"));
        assert_eq!(obj.meta.content_type, Some("text/plain".to_string()));
    }

    #[tokio::test]
    async fn test_complete_multipart_out_of_order() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        let part1 = store
            .upload_part(bucket, &upload_id, 1, Bytes::from("A").into())
            .await
            .unwrap();
        let part2 = store
            .upload_part(bucket, &upload_id, 2, Bytes::from("B").into())
            .await
            .unwrap();
        let part3 = store
            .upload_part(bucket, &upload_id, 3, Bytes::from("C").into())
            .await
            .unwrap();

        // Complete with parts in different order (3, 1, 2)
        let _ = store
            .complete_multipart_upload(
                bucket,
                "key",
                &upload_id,
                &[
                    CompletedPart {
                        part_number: 3,
                        etag: part3.etag,
                    },
                    CompletedPart {
                        part_number: 1,
                        etag: part1.etag,
                    },
                    CompletedPart {
                        part_number: 2,
                        etag: part2.etag,
                    },
                ],
            )
            .await
            .unwrap();

        let obj = store.get_object(bucket, "key").await.unwrap();
        // Parts are assembled in the order they appear in the request
        assert_eq!(obj.data, Bytes::from("CAB"));
    }

    #[tokio::test]
    async fn test_complete_multipart_missing_part() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        let part1 = store
            .upload_part(bucket, &upload_id, 1, Bytes::from("part1").into())
            .await
            .unwrap();

        let result = store
            .complete_multipart_upload(
                bucket,
                "key",
                &upload_id,
                &[
                    CompletedPart {
                        part_number: 1,
                        etag: part1.etag,
                    },
                    CompletedPart {
                        part_number: 2, // Not uploaded
                        etag: "fake".to_string(),
                    },
                ],
            )
            .await;

        assert!(matches!(result, Err(StoreError::PartNotFound { .. })));
    }

    #[tokio::test]
    async fn test_complete_multipart_no_upload() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store
            .complete_multipart_upload(bucket, "key", "nonexistent", &[])
            .await;

        assert!(matches!(result, Err(StoreError::MultipartNotFound(_))));
    }

    #[tokio::test]
    async fn test_abort_multipart() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        store
            .upload_part(bucket, &upload_id, 1, Bytes::from("data").into())
            .await
            .unwrap();

        store.abort_multipart_upload(bucket, &upload_id).await.unwrap();

        // Upload should no longer exist
        let result = store.list_parts(bucket, &upload_id).await;
        assert!(matches!(result, Err(StoreError::MultipartNotFound(_))));
    }

    #[tokio::test]
    async fn test_abort_multipart_no_upload() {
        let (store, bucket) = setup_store_with_bucket().await;

        let result = store.abort_multipart_upload(bucket, "nonexistent").await;

        assert!(matches!(result, Err(StoreError::MultipartNotFound(_))));
    }

    #[tokio::test]
    async fn test_list_parts() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload_id = store
            .create_multipart_upload(bucket, "key", test_meta(None))
            .await
            .unwrap();

        store
            .upload_part(bucket, &upload_id, 3, Bytes::from("third").into())
            .await
            .unwrap();
        store
            .upload_part(bucket, &upload_id, 1, Bytes::from("first").into())
            .await
            .unwrap();
        store
            .upload_part(bucket, &upload_id, 2, Bytes::from("second").into())
            .await
            .unwrap();

        let parts = store.list_parts(bucket, &upload_id).await.unwrap();

        assert_eq!(parts.len(), 3);
        // Should be sorted by part number
        assert_eq!(parts[0].part_number, 1);
        assert_eq!(parts[1].part_number, 2);
        assert_eq!(parts[2].part_number, 3);
    }

    #[tokio::test]
    async fn test_list_multipart_uploads() {
        let (store, bucket) = setup_store_with_bucket().await;

        let upload1 = store
            .create_multipart_upload(bucket, "key1", test_meta(None))
            .await
            .unwrap();
        let upload2 = store
            .create_multipart_upload(bucket, "key2", test_meta(None))
            .await
            .unwrap();

        let uploads = store.list_multipart_uploads(bucket).await.unwrap();

        assert_eq!(uploads.len(), 2);
        let upload_ids: Vec<&str> = uploads.iter().map(|u| u.upload_id.as_str()).collect();
        assert!(upload_ids.contains(&upload1.as_str()));
        assert!(upload_ids.contains(&upload2.as_str()));
    }

    // =========================================================================
    // 6. Metadata Handling (4 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_metadata_preserved() {
        let (store, bucket) = setup_store_with_bucket().await;

        let meta = ObjectMeta {
            content_type: Some("application/json".to_string()),
            content_encoding: Some("gzip".to_string()),
            content_disposition: Some("attachment".to_string()),
            content_language: Some("en-US".to_string()),
            cache_control: Some("max-age=3600".to_string()),
            ..Default::default()
        };

        store
            .put_object(bucket, "key", Bytes::from("{}").into(), meta, Default::default())
            .await
            .unwrap();

        let retrieved = store.head_object(bucket, "key").await.unwrap();

        assert_eq!(retrieved.content_type, Some("application/json".to_string()));
        assert_eq!(retrieved.content_encoding, Some("gzip".to_string()));
        assert_eq!(retrieved.content_disposition, Some("attachment".to_string()));
        assert_eq!(retrieved.content_language, Some("en-US".to_string()));
        assert_eq!(retrieved.cache_control, Some("max-age=3600".to_string()));
    }

    #[tokio::test]
    async fn test_metadata_user_defined() {
        let (store, bucket) = setup_store_with_bucket().await;

        let mut user_metadata = HashMap::new();
        user_metadata.insert("x-amz-meta-author".to_string(), "Alice".to_string());
        user_metadata.insert("x-amz-meta-version".to_string(), "1.0".to_string());

        let meta = ObjectMeta {
            user_metadata: Some(user_metadata),
            ..Default::default()
        };

        store
            .put_object(bucket, "key", Bytes::from("data").into(), meta, Default::default())
            .await
            .unwrap();

        let retrieved = store.head_object(bucket, "key").await.unwrap();
        let user_meta = retrieved.user_metadata.unwrap();

        assert_eq!(user_meta.get("x-amz-meta-author"), Some(&"Alice".to_string()));
        assert_eq!(user_meta.get("x-amz-meta-version"), Some(&"1.0".to_string()));
    }

    #[tokio::test]
    async fn test_etag_computed() {
        let (store, bucket) = setup_store_with_bucket().await;
        let data = b"hello world";

        store
            .put_object(bucket, "key", Bytes::from_static(data).into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let meta = store.head_object(bucket, "key").await.unwrap();

        // ETag should be MD5 of content
        let expected = format!("{:x}", md5::compute(data));
        assert_eq!(meta.etag, expected);
    }

    #[tokio::test]
    async fn test_last_modified_updated() {
        let (store, bucket) = setup_store_with_bucket().await;

        store
            .put_object(bucket, "key", Bytes::from("v1").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let meta1 = store.head_object(bucket, "key").await.unwrap();

        // Small delay to ensure different timestamp
        tokio::time::sleep(std::time::Duration::from_millis(10)).await;

        store
            .put_object(bucket, "key", Bytes::from("v2").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let meta2 = store.head_object(bucket, "key").await.unwrap();

        assert!(meta2.last_modified >= meta1.last_modified);
    }

    // =========================================================================
    // 7. Conditional Write Operations (6 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_put_object_if_none_match_success() {
        let (store, bucket) = setup_store_with_bucket().await;

        // Put with if_none_match when object doesn't exist - should succeed
        let options = PutObjectOptions {
            if_none_match: true,
            ..Default::default()
        };

        let result = store
            .put_object(bucket, "new-key", Bytes::from("data").into(), test_meta(None), options)
            .await;

        assert!(result.is_ok());
        let obj = store.get_object(bucket, "new-key").await.unwrap();
        assert_eq!(obj.data, Bytes::from("data"));
    }

    #[tokio::test]
    async fn test_put_object_if_none_match_fails_when_exists() {
        let (store, bucket) = setup_store_with_bucket().await;

        // First put an object
        store
            .put_object(bucket, "key", Bytes::from("original").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        // Try to put with if_none_match - should fail
        let options = PutObjectOptions {
            if_none_match: true,
            ..Default::default()
        };

        let result = store
            .put_object(bucket, "key", Bytes::from("new").into(), test_meta(None), options)
            .await;

        assert!(matches!(result, Err(StoreError::PreconditionFailed(_))));

        // Original data should be unchanged
        let obj = store.get_object(bucket, "key").await.unwrap();
        assert_eq!(obj.data, Bytes::from("original"));
    }

    #[tokio::test]
    async fn test_put_object_if_match_success() {
        let (store, bucket) = setup_store_with_bucket().await;

        // First put an object
        let result = store
            .put_object(bucket, "key", Bytes::from("original").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        let original_etag = result.etag;

        // Put with matching etag - should succeed
        let options = PutObjectOptions {
            if_match: Some(original_etag),
            ..Default::default()
        };

        let result = store
            .put_object(bucket, "key", Bytes::from("updated").into(), test_meta(None), options)
            .await;

        assert!(result.is_ok());
        let obj = store.get_object(bucket, "key").await.unwrap();
        assert_eq!(obj.data, Bytes::from("updated"));
    }

    #[tokio::test]
    async fn test_put_object_if_match_fails_when_etag_mismatch() {
        let (store, bucket) = setup_store_with_bucket().await;

        // First put an object
        store
            .put_object(bucket, "key", Bytes::from("original").into(), test_meta(None), Default::default())
            .await
            .unwrap();

        // Put with wrong etag - should fail
        let options = PutObjectOptions {
            if_match: Some("wrong-etag".to_string()),
            ..Default::default()
        };

        let result = store
            .put_object(bucket, "key", Bytes::from("updated").into(), test_meta(None), options)
            .await;

        assert!(matches!(result, Err(StoreError::PreconditionFailed(_))));

        // Original data should be unchanged
        let obj = store.get_object(bucket, "key").await.unwrap();
        assert_eq!(obj.data, Bytes::from("original"));
    }

    #[tokio::test]
    async fn test_put_object_if_match_fails_when_not_exists() {
        let (store, bucket) = setup_store_with_bucket().await;

        // Try to put with if_match when object doesn't exist - should fail
        let options = PutObjectOptions {
            if_match: Some("some-etag".to_string()),
            ..Default::default()
        };

        let result = store
            .put_object(bucket, "nonexistent", Bytes::from("data").into(), test_meta(None), options)
            .await;

        assert!(matches!(result, Err(StoreError::PreconditionFailed(_))));
    }

    #[tokio::test]
    async fn test_conditional_write_compare_and_swap() {
        let (store, bucket) = setup_store_with_bucket().await;

        // Create initial object
        let result = store
            .put_object(bucket, "counter", Bytes::from("0").into(), test_meta(None), Default::default())
            .await
            .unwrap();
        let etag_v0 = result.etag;

        // Update to v1 with CAS
        let options = PutObjectOptions {
            if_match: Some(etag_v0.clone()),
            ..Default::default()
        };
        let result = store
            .put_object(bucket, "counter", Bytes::from("1").into(), test_meta(None), options)
            .await
            .unwrap();
        let etag_v1 = result.etag;

        // Try to update again with stale v0 etag - should fail
        let stale_options = PutObjectOptions {
            if_match: Some(etag_v0),
            ..Default::default()
        };
        let result = store
            .put_object(bucket, "counter", Bytes::from("conflict").into(), test_meta(None), stale_options)
            .await;
        assert!(matches!(result, Err(StoreError::PreconditionFailed(_))));

        // Update with correct v1 etag - should succeed
        let options = PutObjectOptions {
            if_match: Some(etag_v1),
            ..Default::default()
        };
        let result = store
            .put_object(bucket, "counter", Bytes::from("2").into(), test_meta(None), options)
            .await;
        assert!(result.is_ok());

        // Verify final value
        let obj = store.get_object(bucket, "counter").await.unwrap();
        assert_eq!(obj.data, Bytes::from("2"));
    }

    // =========================================================================
    // 8. Edge Cases (4 tests)
    // =========================================================================

    #[tokio::test]
    async fn test_special_characters_in_key() {
        let (store, bucket) = setup_store_with_bucket().await;

        let special_keys = [
            "path/with/slashes/file.txt",
            "file with spaces.txt",
            "unicode-文件-émoji-🎉.txt",
            "special!@#$%^&()chars",
            "file\twith\ttabs",
        ];

        for key in &special_keys {
            store
                .put_object(bucket, key, Bytes::from("data").into(), test_meta(None), Default::default())
                .await
                .unwrap();

            let obj = store.get_object(bucket, key).await.unwrap();
            assert_eq!(obj.data, Bytes::from("data"));
        }
    }

    #[tokio::test]
    async fn test_large_object() {
        let (store, bucket) = setup_store_with_bucket().await;

        // 1MB + 1 byte object
        let size = 1024 * 1024 + 1;
        let data = Bytes::from(vec![0xABu8; size]);

        store
            .put_object(bucket, "large", data.clone().into(), test_meta(None), Default::default())
            .await
            .unwrap();

        let obj = store.get_object(bucket, "large").await.unwrap();
        assert_eq!(obj.data.len(), size);
        assert_eq!(obj.meta.size, size as u64);
    }

    #[tokio::test]
    async fn test_many_objects() {
        let (store, bucket) = setup_store_with_bucket().await;

        // Create 1000 objects
        for i in 0..1000 {
            store
                .put_object(
                    bucket,
                    &format!("obj-{:04}", i),
                    Bytes::from(format!("data-{}", i)).into(),
                    test_meta(None),
                    Default::default(),
                )
                .await
                .unwrap();
        }

        let result = store
            .list_objects(
                bucket,
                ListObjectsOptions {
                    max_keys: 2000,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result.objects.len(), 1000);
    }

    #[tokio::test]
    async fn test_concurrent_operations() {
        use std::sync::Arc;

        let store = Arc::new(MemoryStore::new());
        store.create_bucket("concurrent").await.unwrap();

        let mut handles = vec![];

        // Spawn multiple tasks doing concurrent operations
        for i in 0..10 {
            let store = Arc::clone(&store);
            let handle = tokio::spawn(async move {
                let key = format!("key-{}", i);

                // Put
                store
                    .put_object(
                        "concurrent",
                        &key,
                        Bytes::from(format!("data-{}", i)).into(),
                        ObjectMeta::default(),
                        Default::default(),
                    )
                    .await
                    .unwrap();

                // Get
                let obj = store.get_object("concurrent", &key).await.unwrap();
                assert_eq!(obj.data, Bytes::from(format!("data-{}", i)));

                // Head
                let meta = store.head_object("concurrent", &key).await.unwrap();
                assert!(meta.size > 0);
            });
            handles.push(handle);
        }

        // Wait for all tasks
        for handle in handles {
            handle.await.unwrap();
        }

        // Verify all objects exist
        let result = store
            .list_objects(
                "concurrent",
                ListObjectsOptions {
                    max_keys: 100,
                    ..Default::default()
                },
            )
            .await
            .unwrap();

        assert_eq!(result.objects.len(), 10);
    }
}
