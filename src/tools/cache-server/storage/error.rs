// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Typed error types for storage operations.

use slatedb::ErrorKind;

/// Typed error enum for storage operations.
#[derive(Debug, thiserror::Error)]
pub enum StoreError {
    /// Wraps SlateDB database errors.
    #[error("database error: {0}")]
    Database(slatedb::Error),

    /// Malformed manifest data (bad version, truncated, invalid compression byte).
    #[error("corrupted manifest: {0}")]
    ManifestCorrupted(String),

    /// Manifest references a chunk that does not exist in the store.
    #[error("chunk missing: hash {hash}")]
    ChunkMissing { hash: String },

    /// Decompressed chunk size does not match the size recorded in the manifest.
    #[error("chunk size mismatch: expected {expected} bytes, got {actual}")]
    ChunkSizeMismatch { expected: u64, actual: usize },

    /// Compression or decompression failure.
    #[error("compression error: {0}")]
    CompressionFailed(String),

    /// Hash verification failure (content does not match its claimed digest).
    #[error("digest mismatch: expected {expected}, actual {actual}")]
    DigestMismatch { expected: String, actual: String },

    /// Blob exceeds the maximum allowed reassembly size.
    #[error("blob too large: {size} bytes exceeds limit of {limit} bytes")]
    BlobTooLarge { size: usize, limit: usize },
}

impl StoreError {
    /// Whether this error is transient and the operation may succeed if retried.
    ///
    /// Uses SlateDB's `ErrorKind` for the `Database` variant:
    /// - `Unavailable` and `Transaction` are retryable (storage hiccup or txn conflict).
    /// - `Closed`, `Invalid`, `Data`, and `Internal` are permanent.
    /// - All other `StoreError` variants are permanent.
    pub fn is_retryable(&self) -> bool {
        match self {
            StoreError::Database(e) => {
                matches!(e.kind(), ErrorKind::Unavailable | ErrorKind::Transaction,)
            }
            _ => false,
        }
    }
}

impl From<slatedb::Error> for StoreError {
    fn from(e: slatedb::Error) -> Self {
        StoreError::Database(e)
    }
}

/// Result type alias for storage operations.
pub type Result<T> = std::result::Result<T, StoreError>;
