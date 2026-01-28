// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! HTTP integration tests for smols3.
//!
//! This module contains tests that exercise the S3 API through HTTP
//! request/response flows, parameterized over different store backends.

mod bucket_ops;
mod multipart_ops;
mod object_ops;

/// Macro to generate tests for multiple store backends.
///
/// This macro creates a module with a test function for each store type,
/// allowing the same test logic to be run against different backends.
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

            #[tokio::test]
            async fn memory() {
                let harness = testing::TestHarness::new(store::MemoryStore::new());
                let test_fn = $test;
                test_fn(harness).await;
            }

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
        }
    };
}
