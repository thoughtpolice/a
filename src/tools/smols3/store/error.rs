// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Error types for smols3 storage operations.

use thiserror::Error;

/// Errors that can occur during storage operations.
#[derive(Debug, Error)]
pub enum StoreError {
    /// Bucket not found.
    #[error("bucket not found: {0}")]
    BucketNotFound(String),

    /// Bucket already exists.
    #[error("bucket already exists: {0}")]
    BucketAlreadyExists(String),

    /// Bucket is not empty (cannot delete).
    #[error("bucket not empty: {0}")]
    BucketNotEmpty(String),

    /// Object not found.
    #[error("object not found: {bucket}/{key}")]
    ObjectNotFound { bucket: String, key: String },

    /// Multipart upload not found.
    #[error("multipart upload not found: {0}")]
    MultipartNotFound(String),

    /// Invalid part number.
    #[error("invalid part number: {0} (must be 1-10000)")]
    InvalidPartNumber(i32),

    /// Part not found.
    #[error("part not found: upload_id={upload_id}, part={part_number}")]
    PartNotFound { upload_id: String, part_number: i32 },

    /// Invalid range request.
    #[error("invalid range: {0}")]
    InvalidRange(String),

    /// Precondition failed (If-Match or If-None-Match condition not met).
    ///
    /// Returned when:
    /// - If-None-Match: * was specified but the object already exists
    /// - If-Match: <etag> was specified but the ETag doesn't match
    #[error("precondition failed: {0}")]
    PreconditionFailed(String),

    /// Conditional request conflict (concurrent modification).
    ///
    /// Returned when a conflicting operation occurs during a conditional write,
    /// such as a concurrent delete or update.
    #[error("conditional request conflict: {0}")]
    ConditionalRequestConflict(String),

    /// Fjall database error.
    #[error("database error: {0}")]
    Database(#[from] fjall::Error),

    /// SlateDB error.
    #[error("slatedb error: {0}")]
    SlateDb(#[from] slatedb::Error),

    /// Request body exceeds the maximum allowed size.
    #[error("body too large: received {received} bytes, max {max} bytes")]
    BodyTooLarge { received: u64, max: u64 },

    /// Invalid bucket name.
    #[error("invalid bucket name: {0}")]
    InvalidBucketName(String),

    /// Invalid key name.
    #[error("invalid key name: {0}")]
    InvalidKeyName(String),

    /// Internal storage error.
    #[error("internal error: {0}")]
    Internal(String),
}

/// Result type for storage operations.
pub type StoreResult<T> = Result<T, StoreError>;
