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
        data: Bytes,
        mut meta: ObjectMeta,
    ) -> StoreResult<PutObjectResult> {
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
        objects.insert((bucket.to_string(), key.to_string()), obj);

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
        data: Bytes,
    ) -> StoreResult<PartInfo> {
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
