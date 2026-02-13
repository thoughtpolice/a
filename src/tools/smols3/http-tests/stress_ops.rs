// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Stress tests for conditional write atomicity.
//!
//! These tests verify that the transactional implementation of conditional
//! writes (if_none_match, if_match) is correct under concurrent access.

use bytes::Bytes;
use std::sync::atomic::{AtomicUsize, Ordering};
use std::sync::Arc;
use store::{ObjectMeta, PutObjectOptions, Store, StoreError};

/// Macro to generate stress tests for multiple store backends.
///
/// This is similar to test_with_stores! but tests at the Store trait level
/// rather than through HTTP, and uses Arc for concurrent access.
macro_rules! stress_test_with_stores {
    ($name:ident, $test:expr) => {
        mod $name {
            use super::*;

            #[cfg(feature = "memory")]
            #[tokio::test]
            async fn memory() {
                let store = Arc::new(store::MemoryStore::new());
                let test_fn = $test;
                test_fn(store).await;
            }

            #[cfg(feature = "fjall")]
            #[tokio::test]
            async fn fjall() {
                let tmp = tempfile::tempdir().unwrap();
                let config = store::FjallStoreConfig::new(tmp.path());
                let store = Arc::new(store::FjallStore::open(config).unwrap());
                let test_fn = $test;
                test_fn(store).await;
            }

            #[cfg(feature = "slatedb")]
            #[tokio::test]
            async fn slatedb() {
                let store = Arc::new(store::SlateStore::open_in_memory().await.unwrap());
                let test_fn = $test;
                test_fn(store).await;
            }
        }
    };
}

// =============================================================================
// Stress test: if_none_match race
// =============================================================================

stress_test_with_stores!(
    stress_if_none_match_race,
    |store: Arc<dyn Store + Send + Sync>| async move {
        store.create_bucket("stress").await.unwrap();

        let success_count = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::new(AtomicUsize::new(0));
        let num_tasks = 100;

        let mut handles = Vec::with_capacity(num_tasks);

        for i in 0..num_tasks {
            let store = Arc::clone(&store);
            let success_count = Arc::clone(&success_count);
            let failure_count = Arc::clone(&failure_count);

            let handle = tokio::spawn(async move {
                let options = PutObjectOptions {
                    if_none_match: true,
                    if_match: None,
                };

                let result = store
                    .put_object(
                        "stress",
                        "contested-key",
                        Bytes::from(format!("data-{}", i)).into(),
                        ObjectMeta::default(),
                        options,
                    )
                    .await;

                match result {
                    Ok(_) => {
                        success_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(StoreError::PreconditionFailed(_)) => {
                        failure_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => panic!("unexpected error: {:?}", e),
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap();
        }

        let successes = success_count.load(Ordering::Relaxed);
        let failures = failure_count.load(Ordering::Relaxed);

        assert_eq!(
            successes, 1,
            "exactly one task should succeed with if_none_match, got {}",
            successes
        );
        assert_eq!(
            failures,
            num_tasks - 1,
            "all other tasks should fail, got {} failures",
            failures
        );
    }
);

// =============================================================================
// Stress test: if_match CAS race
// =============================================================================

stress_test_with_stores!(
    stress_if_match_cas_race,
    |store: Arc<dyn Store + Send + Sync>| async move {
        store.create_bucket("stress").await.unwrap();

        // Create initial object
        let initial_result = store
            .put_object(
                "stress",
                "cas-key",
                Bytes::from("initial").into(),
                ObjectMeta::default(),
                Default::default(),
            )
            .await
            .unwrap();

        let initial_etag = initial_result.etag;
        let success_count = Arc::new(AtomicUsize::new(0));
        let failure_count = Arc::new(AtomicUsize::new(0));
        let num_tasks = 100;

        let mut handles = Vec::with_capacity(num_tasks);

        for i in 0..num_tasks {
            let store = Arc::clone(&store);
            let success_count = Arc::clone(&success_count);
            let failure_count = Arc::clone(&failure_count);
            let etag = initial_etag.clone();

            let handle = tokio::spawn(async move {
                let options = PutObjectOptions {
                    if_none_match: false,
                    if_match: Some(etag),
                };

                let result = store
                    .put_object(
                        "stress",
                        "cas-key",
                        Bytes::from(format!("updated-{}", i)).into(),
                        ObjectMeta::default(),
                        options,
                    )
                    .await;

                match result {
                    Ok(_) => {
                        success_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(StoreError::PreconditionFailed(_)) => {
                        failure_count.fetch_add(1, Ordering::Relaxed);
                    }
                    Err(e) => panic!("unexpected error: {:?}", e),
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap();
        }

        let successes = success_count.load(Ordering::Relaxed);
        let failures = failure_count.load(Ordering::Relaxed);

        assert_eq!(
            successes, 1,
            "exactly one CAS should succeed, got {}",
            successes
        );
        assert_eq!(
            failures,
            num_tasks - 1,
            "all other CAS should fail, got {} failures",
            failures
        );
    }
);

// =============================================================================
// Stress test: Counter increment pattern
// =============================================================================

stress_test_with_stores!(
    stress_counter_increment_pattern,
    |store: Arc<dyn Store + Send + Sync>| async move {
        store.create_bucket("stress").await.unwrap();

        // Create initial counter value
        store
            .put_object(
                "stress",
                "counter",
                Bytes::from("0").into(),
                ObjectMeta::default(),
                Default::default(),
            )
            .await
            .unwrap();

        let total_successes = Arc::new(AtomicUsize::new(0));
        let total_retries = Arc::new(AtomicUsize::new(0));
        let num_tasks = 50;
        let increments_per_task = 10;

        let mut handles = Vec::with_capacity(num_tasks);

        for _task_id in 0..num_tasks {
            let store = Arc::clone(&store);
            let total_successes = Arc::clone(&total_successes);
            let total_retries = Arc::clone(&total_retries);

            let handle = tokio::spawn(async move {
                for _ in 0..increments_per_task {
                    loop {
                        // Read current value
                        let obj = store.get_object("stress", "counter").await.unwrap();
                        let current: i32 =
                            String::from_utf8_lossy(&obj.data).parse().unwrap_or(0);
                        let new_value = current + 1;

                        // Try to CAS
                        let options = PutObjectOptions {
                            if_none_match: false,
                            if_match: Some(obj.meta.etag.clone()),
                        };

                        let result = store
                            .put_object(
                                "stress",
                                "counter",
                                Bytes::from(new_value.to_string()).into(),
                                ObjectMeta::default(),
                                options,
                            )
                            .await;

                        match result {
                            Ok(_) => {
                                total_successes.fetch_add(1, Ordering::Relaxed);
                                break;
                            }
                            Err(StoreError::PreconditionFailed(_)) => {
                                total_retries.fetch_add(1, Ordering::Relaxed);
                                // Retry
                            }
                            Err(e) => panic!("unexpected error: {:?}", e),
                        }
                    }
                }
            });
            handles.push(handle);
        }

        for handle in handles {
            handle.await.unwrap();
        }

        // Read final counter value
        let final_obj = store.get_object("stress", "counter").await.unwrap();
        let final_value: i32 = String::from_utf8_lossy(&final_obj.data)
            .parse()
            .unwrap_or(0);

        let expected_total = num_tasks * increments_per_task;
        let successes = total_successes.load(Ordering::Relaxed);
        let retries = total_retries.load(Ordering::Relaxed);

        assert_eq!(
            final_value, expected_total as i32,
            "counter should equal total increments ({}) but was {} (successes={}, retries={})",
            expected_total, final_value, successes, retries
        );

        assert_eq!(
            successes, expected_total,
            "total successes should match expected increments"
        );
    }
);
