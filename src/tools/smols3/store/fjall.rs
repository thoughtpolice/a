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
//! - `buckets`: bucket name -> creation timestamp
//! - `objects`: bucket:key -> object data
//! - `object_meta`: bucket:key -> object metadata (JSON)
//! - `multipart`: upload_id -> multipart state (JSON)
//! - `parts`: upload_id:part_number -> part data
//!
//! # Future Improvements
//!
//! - Per-bucket databases for better isolation and concurrent writes
//! - Content-defined chunking (FastCDC) for deduplication
//! - Separate blob storage for large objects

use std::ops::Range;
use std::path::PathBuf;

use bytes::Bytes;
use tracing::debug;

use super::error::StoreResult;
use super::traits::*;

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
    #[allow(dead_code)]
    buckets: fjall::Keyspace,
    /// Keyspace for object data.
    #[allow(dead_code)]
    objects: fjall::Keyspace,
    /// Keyspace for object metadata.
    #[allow(dead_code)]
    object_meta: fjall::Keyspace,
    /// Keyspace for multipart upload state.
    #[allow(dead_code)]
    multipart: fjall::Keyspace,
    /// Keyspace for multipart parts.
    #[allow(dead_code)]
    parts: fjall::Keyspace,
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

        debug!(path = %config.path.display(), "fjall store opened successfully");

        Ok(Self {
            db,
            buckets,
            objects,
            object_meta,
            multipart,
            parts,
            config,
        })
    }
}

#[async_trait::async_trait]
impl Store for FjallStore {
    // =========================================================================
    // Bucket operations
    // =========================================================================

    async fn create_bucket(&self, _bucket: &str) -> StoreResult<()> {
        todo!("FjallStore::create_bucket")
    }

    async fn delete_bucket(&self, _bucket: &str) -> StoreResult<()> {
        todo!("FjallStore::delete_bucket")
    }

    async fn bucket_exists(&self, _bucket: &str) -> StoreResult<bool> {
        todo!("FjallStore::bucket_exists")
    }

    async fn list_buckets(&self) -> StoreResult<Vec<BucketInfo>> {
        todo!("FjallStore::list_buckets")
    }

    // =========================================================================
    // Object operations
    // =========================================================================

    async fn put_object(
        &self,
        _bucket: &str,
        _key: &str,
        _data: Bytes,
        _meta: ObjectMeta,
    ) -> StoreResult<PutObjectResult> {
        todo!("FjallStore::put_object")
    }

    async fn get_object(&self, _bucket: &str, _key: &str) -> StoreResult<ObjectData> {
        todo!("FjallStore::get_object")
    }

    async fn get_object_range(
        &self,
        _bucket: &str,
        _key: &str,
        _range: Range<u64>,
    ) -> StoreResult<Bytes> {
        todo!("FjallStore::get_object_range")
    }

    async fn head_object(&self, _bucket: &str, _key: &str) -> StoreResult<ObjectMeta> {
        todo!("FjallStore::head_object")
    }

    async fn delete_object(&self, _bucket: &str, _key: &str) -> StoreResult<()> {
        todo!("FjallStore::delete_object")
    }

    async fn copy_object(
        &self,
        _src_bucket: &str,
        _src_key: &str,
        _dst_bucket: &str,
        _dst_key: &str,
    ) -> StoreResult<CopyObjectResult> {
        todo!("FjallStore::copy_object")
    }

    async fn list_objects(
        &self,
        _bucket: &str,
        _options: ListObjectsOptions,
    ) -> StoreResult<ListObjectsResult> {
        todo!("FjallStore::list_objects")
    }

    // =========================================================================
    // Multipart upload operations
    // =========================================================================

    async fn create_multipart_upload(
        &self,
        _bucket: &str,
        _key: &str,
        _meta: ObjectMeta,
    ) -> StoreResult<String> {
        todo!("FjallStore::create_multipart_upload")
    }

    async fn upload_part(
        &self,
        _bucket: &str,
        _upload_id: &str,
        _part_number: i32,
        _data: Bytes,
    ) -> StoreResult<PartInfo> {
        todo!("FjallStore::upload_part")
    }

    async fn complete_multipart_upload(
        &self,
        _bucket: &str,
        _key: &str,
        _upload_id: &str,
        _parts: &[CompletedPart],
    ) -> StoreResult<CompleteMultipartResult> {
        todo!("FjallStore::complete_multipart_upload")
    }

    async fn abort_multipart_upload(&self, _bucket: &str, _upload_id: &str) -> StoreResult<()> {
        todo!("FjallStore::abort_multipart_upload")
    }

    async fn list_parts(&self, _bucket: &str, _upload_id: &str) -> StoreResult<Vec<PartInfo>> {
        todo!("FjallStore::list_parts")
    }

    async fn list_multipart_uploads(&self, _bucket: &str) -> StoreResult<Vec<MultipartUploadInfo>> {
        todo!("FjallStore::list_multipart_uploads")
    }
}
