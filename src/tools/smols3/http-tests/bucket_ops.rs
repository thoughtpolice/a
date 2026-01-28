// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Bucket operation tests.

use http::StatusCode;
use testing::{collect_body, S3Request, TestHarness};

use crate::test_with_stores;

// =============================================================================
// Create bucket tests
// =============================================================================

test_with_stores!(create_bucket, |harness: TestHarness| async move {
    let resp = harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
});

test_with_stores!(create_bucket_duplicate, |harness: TestHarness| async move {
    // Create bucket first time
    let resp = harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Try to create again - should fail
    let resp = harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);
});

// =============================================================================
// Delete bucket tests
// =============================================================================

test_with_stores!(delete_bucket, |harness: TestHarness| async move {
    // Create bucket
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Delete bucket
    let resp = harness
        .call(S3Request::delete_bucket("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // Verify bucket is gone
    let resp = harness
        .call(S3Request::head_bucket("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

test_with_stores!(delete_bucket_not_found, |harness: TestHarness| async move {
    let resp = harness
        .call(S3Request::delete_bucket("nonexistent").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

test_with_stores!(delete_bucket_not_empty, |harness: TestHarness| async move {
    // Create bucket and put an object
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;
    harness
        .call(
            S3Request::put_object("test-bucket", "key")
                .with_body(b"data")
                .build(),
        )
        .await;

    // Try to delete non-empty bucket
    let resp = harness
        .call(S3Request::delete_bucket("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::CONFLICT);
});

// =============================================================================
// Head bucket tests
// =============================================================================

test_with_stores!(head_bucket, |harness: TestHarness| async move {
    // Create bucket
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Head bucket
    let resp = harness
        .call(S3Request::head_bucket("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
});

test_with_stores!(head_bucket_not_found, |harness: TestHarness| async move {
    let resp = harness
        .call(S3Request::head_bucket("nonexistent").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

// =============================================================================
// List buckets tests
// =============================================================================

test_with_stores!(list_buckets_empty, |harness: TestHarness| async move {
    let resp = harness.call(S3Request::list_buckets().build()).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    // Response should be valid XML but with no buckets
    assert!(body.len() > 0);
});

test_with_stores!(list_buckets_multiple, |harness: TestHarness| async move {
    // Create several buckets
    harness
        .call(S3Request::create_bucket("bucket-a").build())
        .await;
    harness
        .call(S3Request::create_bucket("bucket-b").build())
        .await;
    harness
        .call(S3Request::create_bucket("bucket-c").build())
        .await;

    let resp = harness.call(S3Request::list_buckets().build()).await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    let body_str = String::from_utf8_lossy(&body);

    // Verify all buckets are listed
    assert!(body_str.contains("bucket-a"));
    assert!(body_str.contains("bucket-b"));
    assert!(body_str.contains("bucket-c"));
});

// =============================================================================
// Get bucket location tests
// =============================================================================

test_with_stores!(get_bucket_location, |harness: TestHarness| async move {
    // Create bucket
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Get location
    let resp = harness
        .call(S3Request::get_bucket_location("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
});

test_with_stores!(
    get_bucket_location_not_found,
    |harness: TestHarness| async move {
        let resp = harness
            .call(S3Request::get_bucket_location("nonexistent").build())
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
);
