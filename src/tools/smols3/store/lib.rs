// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Storage layer for smols3 S3-compatible server.
//!
//! This module provides an abstract storage interface ([`Store`]) and concrete
//! implementations for different backends:
//!
//! - [`MemoryStore`]: In-memory storage for testing and development
//! - [`FjallStore`]: Persistent storage using Fjall LSM-tree database
//! - [`SlateStore`]: Persistent storage using SlateDB backed by object storage
//! - [`ChunkingStore`]: Wrapper that adds content-defined chunking for deduplication
//!
//! The S3 protocol layer ([`SmolS3`]) uses the abstract [`Store`] trait,
//! allowing the same protocol implementation to work with any backend.
//!
//! # Architecture
//!
//! ```text
//! ┌─────────────────┐
//! │  S3 Protocol    │  <- SmolS3 implements s3s::S3
//! │  (s3s::S3)      │
//! └────────┬────────┘
//!          │ uses
//!          ▼
//! ┌─────────────────┐
//! │  ChunkingStore  │  <- Optional: content-defined chunking (FastCDC + BLAKE3)
//! │  (impl Store)   │
//! └────────┬────────┘
//!          │ wraps
//!          ▼
//! ┌─────────────────┐
//! │  Store trait    │  <- Abstract storage interface
//! └────────┬────────┘
//!          │ implemented by
//!    ┌─────┼─────────┐
//!    ▼     ▼         ▼
//! ┌──────┐ ┌──────┐ ┌───────┐
//! │Memory│ │Fjall │ │Slate  │
//! │Store │ │Store │ │Store  │
//! └──────┘ └──────┘ └───────┘
//! ```

mod authz;
mod chunking;
mod error;
mod fjall;
mod memory;
mod s3;
mod slatedb;
mod traits;

pub use authz::CedarAuthorizer;
pub use chunking::{ChunkingConfig, ChunkingStore};
pub use error::{StoreError, StoreResult};
pub use fjall::{FjallStore, FjallStoreConfig};
pub use memory::MemoryStore;
pub use s3::{SmolS3, SmolS3Config};
pub use slatedb::{SlateBackend, SlateStore, SlateStoreConfig};
pub use traits::{
    BodyStream, BucketInfo, CommonPrefix, CompletedPart, CompleteMultipartResult, CopyObjectResult,
    ListObjectsOptions, ListObjectsResult, MultipartUploadInfo, ObjectData, ObjectEntry,
    ObjectMeta, PartInfo, PutObjectOptions, PutObjectResult, Store,
};
