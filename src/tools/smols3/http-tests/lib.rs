// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HTTP integration tests for smols3.
//!
//! This module contains tests that exercise the S3 API through HTTP
//! request/response flows, parameterized over different store backends.
//!
//! Tests are split into separate binaries by backend for parallel execution:
//! - `http-tests-memory`: MemoryStore tests
//! - `http-tests-fjall`: FjallStore tests
//! - `http-tests-slatedb`: SlateStore tests
//!
//! Each binary tests both raw and chunking-wrapped variants of its backend.

// Only compile test modules when at least one backend feature is enabled
#[cfg(any(feature = "memory", feature = "fjall", feature = "slatedb"))]
mod authz_ops;
#[cfg(any(feature = "memory", feature = "fjall", feature = "slatedb"))]
mod bucket_ops;
#[cfg(any(feature = "memory", feature = "fjall", feature = "slatedb"))]
mod chunking_ops;
#[cfg(any(feature = "memory", feature = "fjall", feature = "slatedb"))]
mod multipart_ops;
#[cfg(any(feature = "memory", feature = "fjall", feature = "slatedb"))]
mod object_ops;
#[cfg(any(feature = "memory", feature = "fjall", feature = "slatedb"))]
mod stress_ops;
#[cfg(any(feature = "memory", feature = "fjall", feature = "slatedb"))]
mod presigned_ops;

/// Macro to generate tests for multiple store backends.
///
/// This macro creates a module with a test function for each store type,
/// allowing the same test logic to be run against different backends.
/// Tests are run against both raw stores and chunking-wrapped stores.
///
/// Which backends are included depends on enabled features:
/// - `memory`: MemoryStore and ChunkingStore<MemoryStore>
/// - `fjall`: FjallStore and ChunkingStore<FjallStore>
/// - `slatedb`: SlateStore and ChunkingStore<SlateStore>
///
/// # Example
///
/// ```ignore
/// test_with_stores!(my_test, |harness| async move {
///     // Test implementation using harness...
/// });
/// ```
#[macro_export]
macro_rules! test_with_stores {
    ($name:ident, $test:expr) => {
        mod $name {
            use super::*;

            // Memory backend (raw)
            #[cfg(feature = "memory")]
            #[tokio::test]
            async fn memory() {
                let harness = testing::TestHarness::new(store::MemoryStore::new());
                let test_fn = $test;
                test_fn(harness).await;
            }

            // Memory backend (chunking)
            #[cfg(feature = "memory")]
            #[tokio::test]
            async fn chunking_memory() {
                let inner = store::MemoryStore::new();
                let chunking_store = store::ChunkingStore::new(inner);
                let harness = testing::TestHarness::new(chunking_store);
                let test_fn = $test;
                test_fn(harness).await;
            }

            // Fjall backend (raw)
            #[cfg(feature = "fjall")]
            #[tokio::test]
            async fn fjall() {
                let tmp = tempfile::tempdir().unwrap();
                let config = store::FjallStoreConfig::new(tmp.path());
                let fjall_store = store::FjallStore::open(config).unwrap();
                let harness = testing::TestHarness::new(fjall_store);
                let test_fn = $test;
                test_fn(harness).await;
                // tmp is dropped here, cleaning up the temp directory
            }

            // Fjall backend (chunking)
            #[cfg(feature = "fjall")]
            #[tokio::test]
            async fn chunking_fjall() {
                let tmp = tempfile::tempdir().unwrap();
                let config = store::FjallStoreConfig::new(tmp.path());
                let fjall_store = store::FjallStore::open(config).unwrap();
                let chunking_store = store::ChunkingStore::new(fjall_store);
                let harness = testing::TestHarness::new(chunking_store);
                let test_fn = $test;
                test_fn(harness).await;
                // tmp is dropped here, cleaning up the temp directory
            }

            // SlateDB backend (raw)
            #[cfg(feature = "slatedb")]
            #[tokio::test]
            async fn slatedb() {
                let slate_store = store::SlateStore::open_in_memory().await.unwrap();
                let harness = testing::TestHarness::new(slate_store);
                let test_fn = $test;
                test_fn(harness).await;
            }

            // SlateDB backend (chunking)
            #[cfg(feature = "slatedb")]
            #[tokio::test]
            async fn chunking_slatedb() {
                let slate_store = store::SlateStore::open_in_memory().await.unwrap();
                let chunking_store = store::ChunkingStore::new(slate_store);
                let harness = testing::TestHarness::new(chunking_store);
                let test_fn = $test;
                test_fn(harness).await;
            }
        }
    };
}
