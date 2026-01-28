// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Storage trait definitions for smols3.
//!
//! This module defines the abstract storage interface that backends must implement.
//! The trait is designed around S3 semantics while allowing flexibility in the
//! underlying storage implementation.
//!
//! # Design Considerations
//!
//! The `Store` trait is designed to support:
//! - Per-bucket isolation (each bucket could be its own database)
//! - Content-defined chunking for deduplication (e.g., FastCDC)
//! - Efficient range reads for partial object retrieval
//! - Atomic multipart upload operations
//!
//! # S3 Operations Mapping
//!
//! | S3 Operation | Store Method |
//! |--------------|--------------|
//! | CreateBucket | `create_bucket` |
//! | DeleteBucket | `delete_bucket` |
//! | HeadBucket | `bucket_exists` |
//! | ListBuckets | `list_buckets` |
//! | PutObject | `put_object` |
//! | GetObject | `get_object` / `get_object_range` |
//! | HeadObject | `head_object` |
//! | DeleteObject | `delete_object` |
//! | CopyObject | `copy_object` |
//! | ListObjects* | `list_objects` |
//! | CreateMultipartUpload | `create_multipart_upload` |
//! | UploadPart | `upload_part` |
//! | CompleteMultipartUpload | `complete_multipart_upload` |
//! | AbortMultipartUpload | `abort_multipart_upload` |
//! | ListParts | `list_parts` |
//! | ListMultipartUploads | `list_multipart_uploads` |

use std::collections::HashMap;
use std::ops::Range;
use std::time::SystemTime;

use bytes::Bytes;

use super::error::StoreResult;

// =============================================================================
// Bucket types
// =============================================================================

/// Information about a bucket.
#[derive(Debug, Clone)]
pub struct BucketInfo {
    /// Bucket name.
    pub name: String,
    /// Creation timestamp.
    pub created_at: SystemTime,
}

// =============================================================================
// Object types
// =============================================================================

/// Metadata associated with an object.
#[derive(Debug, Clone)]
pub struct ObjectMeta {
    /// Content type (MIME type).
    pub content_type: Option<String>,
    /// Content encoding (e.g., gzip).
    pub content_encoding: Option<String>,
    /// Content disposition.
    pub content_disposition: Option<String>,
    /// Content language.
    pub content_language: Option<String>,
    /// Cache control directives.
    pub cache_control: Option<String>,
    /// User-defined metadata (x-amz-meta-*).
    pub user_metadata: Option<HashMap<String, String>>,
    /// Last modification time.
    pub last_modified: SystemTime,
    /// Size in bytes.
    pub size: u64,
    /// ETag (usually MD5 hash).
    pub etag: String,
}

impl Default for ObjectMeta {
    fn default() -> Self {
        Self {
            content_type: None,
            content_encoding: None,
            content_disposition: None,
            content_language: None,
            cache_control: None,
            user_metadata: None,
            last_modified: SystemTime::UNIX_EPOCH,
            size: 0,
            etag: String::new(),
        }
    }
}

/// Result of a put_object operation.
#[derive(Debug, Clone)]
pub struct PutObjectResult {
    /// ETag of the stored object.
    pub etag: String,
}

/// Options for conditional put_object operations.
///
/// These options implement S3's conditional write semantics:
/// - `if_none_match`: Only write if the object doesn't exist (put-if-absent)
/// - `if_match`: Only write if the object's ETag matches (compare-and-swap)
///
/// See: <https://docs.aws.amazon.com/AmazonS3/latest/userguide/conditional-writes.html>
#[derive(Debug, Clone, Default)]
pub struct PutObjectOptions {
    /// If set to true (representing `If-None-Match: *`), the operation only
    /// succeeds if the object does not already exist.
    ///
    /// Returns `PreconditionFailed` if the object exists.
    pub if_none_match: bool,

    /// If set, the operation only succeeds if the existing object's ETag
    /// matches this value (representing `If-Match: <etag>`).
    ///
    /// Returns `PreconditionFailed` if:
    /// - The object doesn't exist
    /// - The object's ETag doesn't match
    pub if_match: Option<String>,
}

/// Result of a copy_object operation.
#[derive(Debug, Clone)]
pub struct CopyObjectResult {
    /// ETag of the copied object.
    pub etag: String,
    /// Last modification time of the copy.
    pub last_modified: SystemTime,
}

/// Object data with metadata.
#[derive(Debug)]
pub struct ObjectData {
    /// Object content.
    pub data: Bytes,
    /// Object metadata.
    pub meta: ObjectMeta,
}

// =============================================================================
// List types
// =============================================================================

/// Options for listing objects.
#[derive(Debug, Clone, Default)]
pub struct ListObjectsOptions {
    /// Only return keys that begin with this prefix.
    pub prefix: Option<String>,
    /// Character used to group keys (usually "/").
    pub delimiter: Option<String>,
    /// Start listing after this key.
    pub start_after: Option<String>,
    /// Maximum number of keys to return.
    pub max_keys: u32,
    /// Continuation token for pagination.
    pub continuation_token: Option<String>,
}

/// An object entry in a list result.
#[derive(Debug, Clone)]
pub struct ObjectEntry {
    /// Object key.
    pub key: String,
    /// Last modification time.
    pub last_modified: SystemTime,
    /// Size in bytes.
    pub size: u64,
    /// ETag.
    pub etag: String,
}

/// A common prefix in a list result (for delimiter-based grouping).
#[derive(Debug, Clone)]
pub struct CommonPrefix {
    /// The prefix.
    pub prefix: String,
}

/// Result of a list_objects operation.
#[derive(Debug, Clone)]
pub struct ListObjectsResult {
    /// Objects matching the criteria.
    pub objects: Vec<ObjectEntry>,
    /// Common prefixes (when delimiter is used).
    pub common_prefixes: Vec<CommonPrefix>,
    /// Whether there are more results.
    pub is_truncated: bool,
    /// Token to continue listing.
    pub next_continuation_token: Option<String>,
    /// Number of keys returned.
    pub key_count: u32,
}

// =============================================================================
// Multipart types
// =============================================================================

/// Information about a multipart upload.
#[derive(Debug, Clone)]
pub struct MultipartUploadInfo {
    /// Unique upload ID.
    pub upload_id: String,
    /// Bucket name.
    pub bucket: String,
    /// Object key.
    pub key: String,
    /// When the upload was initiated.
    pub initiated: SystemTime,
}

/// Information about an uploaded part.
#[derive(Debug, Clone)]
pub struct PartInfo {
    /// Part number (1-10000).
    pub part_number: i32,
    /// ETag of the part.
    pub etag: String,
    /// Size in bytes.
    pub size: u64,
    /// Last modification time.
    pub last_modified: SystemTime,
}

/// A completed part reference for completing multipart upload.
#[derive(Debug, Clone)]
pub struct CompletedPart {
    /// Part number.
    pub part_number: i32,
    /// ETag of the part (for verification).
    pub etag: String,
}

/// Result of completing a multipart upload.
#[derive(Debug, Clone)]
pub struct CompleteMultipartResult {
    /// ETag of the final object.
    pub etag: String,
}

// =============================================================================
// Store trait
// =============================================================================

/// Abstract storage interface for S3-compatible operations.
///
/// This trait defines the storage primitives needed to implement S3 semantics.
/// Implementations can use different backends (memory, Fjall, etc.) while the
/// S3 protocol layer remains the same.
///
/// # Thread Safety
///
/// All methods take `&self` and implementations must be thread-safe. The trait
/// requires `Send + Sync` bounds.
///
/// # Error Handling
///
/// All methods return `StoreResult<T>` which wraps storage-specific errors.
/// The S3 layer translates these to appropriate S3 error responses.
#[async_trait::async_trait]
pub trait Store: Send + Sync {
    // =========================================================================
    // Bucket operations
    // =========================================================================

    /// Create a new bucket.
    ///
    /// Returns an error if the bucket already exists.
    async fn create_bucket(&self, bucket: &str) -> StoreResult<()>;

    /// Delete a bucket.
    ///
    /// Returns an error if the bucket doesn't exist or is not empty.
    async fn delete_bucket(&self, bucket: &str) -> StoreResult<()>;

    /// Check if a bucket exists.
    async fn bucket_exists(&self, bucket: &str) -> StoreResult<bool>;

    /// List all buckets.
    async fn list_buckets(&self) -> StoreResult<Vec<BucketInfo>>;

    // =========================================================================
    // Object operations
    // =========================================================================

    /// Store an object.
    ///
    /// If the object already exists, it is overwritten unless conditional options
    /// are specified:
    /// - `options.if_none_match = true`: Only succeeds if object doesn't exist (put-if-absent)
    /// - `options.if_match = Some(etag)`: Only succeeds if existing object's ETag matches
    async fn put_object(
        &self,
        bucket: &str,
        key: &str,
        data: Bytes,
        meta: ObjectMeta,
        options: PutObjectOptions,
    ) -> StoreResult<PutObjectResult>;

    /// Retrieve an object and its metadata.
    ///
    /// Returns an error if the bucket or object doesn't exist.
    async fn get_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectData>;

    /// Retrieve a byte range from an object.
    ///
    /// The range is half-open: [start, end).
    /// Returns an error if the bucket or object doesn't exist.
    async fn get_object_range(
        &self,
        bucket: &str,
        key: &str,
        range: Range<u64>,
    ) -> StoreResult<Bytes>;

    /// Retrieve object metadata without the data.
    ///
    /// Returns an error if the bucket or object doesn't exist.
    async fn head_object(&self, bucket: &str, key: &str) -> StoreResult<ObjectMeta>;

    /// Delete an object.
    ///
    /// Returns success even if the object doesn't exist (S3 semantics).
    async fn delete_object(&self, bucket: &str, key: &str) -> StoreResult<()>;

    /// Copy an object.
    ///
    /// The source and destination can be in different buckets.
    async fn copy_object(
        &self,
        src_bucket: &str,
        src_key: &str,
        dst_bucket: &str,
        dst_key: &str,
    ) -> StoreResult<CopyObjectResult>;

    /// List objects in a bucket.
    async fn list_objects(
        &self,
        bucket: &str,
        options: ListObjectsOptions,
    ) -> StoreResult<ListObjectsResult>;

    // =========================================================================
    // Multipart upload operations
    // =========================================================================

    /// Initiate a multipart upload.
    ///
    /// Returns a unique upload ID.
    async fn create_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        meta: ObjectMeta,
    ) -> StoreResult<String>;

    /// Upload a part of a multipart upload.
    ///
    /// Part numbers must be between 1 and 10000.
    async fn upload_part(
        &self,
        bucket: &str,
        upload_id: &str,
        part_number: i32,
        data: Bytes,
    ) -> StoreResult<PartInfo>;

    /// Complete a multipart upload.
    ///
    /// Assembles the parts into the final object.
    async fn complete_multipart_upload(
        &self,
        bucket: &str,
        key: &str,
        upload_id: &str,
        parts: &[CompletedPart],
    ) -> StoreResult<CompleteMultipartResult>;

    /// Abort a multipart upload.
    ///
    /// Cleans up all uploaded parts.
    async fn abort_multipart_upload(&self, bucket: &str, upload_id: &str) -> StoreResult<()>;

    /// List the parts that have been uploaded for a multipart upload.
    async fn list_parts(&self, bucket: &str, upload_id: &str) -> StoreResult<Vec<PartInfo>>;

    /// List in-progress multipart uploads in a bucket.
    async fn list_multipart_uploads(&self, bucket: &str) -> StoreResult<Vec<MultipartUploadInfo>>;
}
