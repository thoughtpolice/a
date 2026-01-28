// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Object operation tests.

use bytes::Bytes;
use http::StatusCode;
use testing::{collect_body, S3Request, TestHarness};

use crate::test_with_stores;

// =============================================================================
// Put object tests
// =============================================================================

test_with_stores!(put_object, |harness: TestHarness| async move {
    // Create bucket
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Put object
    let resp = harness
        .call(
            S3Request::put_object("test-bucket", "hello.txt")
                .with_body(b"Hello, World!")
                .with_content_type("text/plain")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify ETag header is present
    assert!(resp.headers().contains_key("etag"));
});

test_with_stores!(put_object_no_bucket, |harness: TestHarness| async move {
    let resp = harness
        .call(
            S3Request::put_object("nonexistent", "key")
                .with_body(b"data")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

test_with_stores!(put_object_empty, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let resp = harness
        .call(
            S3Request::put_object("test-bucket", "empty")
                .with_body(b"")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
});

test_with_stores!(put_object_overwrite, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Put first version
    harness
        .call(
            S3Request::put_object("test-bucket", "key")
                .with_body(b"first")
                .build(),
        )
        .await;

    // Overwrite with second version
    harness
        .call(
            S3Request::put_object("test-bucket", "key")
                .with_body(b"second")
                .build(),
        )
        .await;

    // Verify we get the second version
    let resp = harness
        .call(S3Request::get_object("test-bucket", "key").build())
        .await;
    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("second"));
});

// =============================================================================
// Get object tests
// =============================================================================

test_with_stores!(get_object, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Put object
    harness
        .call(
            S3Request::put_object("test-bucket", "hello.txt")
                .with_body(b"Hello, World!")
                .with_content_type("text/plain")
                .build(),
        )
        .await;

    // Get object
    let resp = harness
        .call(S3Request::get_object("test-bucket", "hello.txt").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("Hello, World!"));
});

test_with_stores!(get_object_not_found, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let resp = harness
        .call(S3Request::get_object("test-bucket", "nonexistent").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

test_with_stores!(get_object_no_bucket, |harness: TestHarness| async move {
    let resp = harness
        .call(S3Request::get_object("nonexistent", "key").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

test_with_stores!(get_object_range, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    harness
        .call(
            S3Request::put_object("test-bucket", "data.txt")
                .with_body(b"Hello, World!")
                .build(),
        )
        .await;

    // Get range bytes 0-4 ("Hello")
    let resp = harness
        .call(
            S3Request::get_object("test-bucket", "data.txt")
                .with_range(0, 4)
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);

    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("Hello"));
});

// =============================================================================
// Head object tests
// =============================================================================

test_with_stores!(head_object, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    harness
        .call(
            S3Request::put_object("test-bucket", "key")
                .with_body(b"test data")
                .with_content_type("application/octet-stream")
                .build(),
        )
        .await;

    let resp = harness
        .call(S3Request::head_object("test-bucket", "key").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify headers
    assert!(resp.headers().contains_key("content-length"));
    assert!(resp.headers().contains_key("etag"));
});

test_with_stores!(head_object_not_found, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let resp = harness
        .call(S3Request::head_object("test-bucket", "nonexistent").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

// =============================================================================
// Delete object tests
// =============================================================================

test_with_stores!(delete_object, |harness: TestHarness| async move {
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

    // Delete object
    let resp = harness
        .call(S3Request::delete_object("test-bucket", "key").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // Verify object is gone
    let resp = harness
        .call(S3Request::get_object("test-bucket", "key").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

test_with_stores!(delete_object_idempotent, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Delete non-existent object should succeed (S3 semantics)
    let resp = harness
        .call(S3Request::delete_object("test-bucket", "nonexistent").build())
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);
});

// =============================================================================
// Copy object tests
// =============================================================================

test_with_stores!(copy_object_same_bucket, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    harness
        .call(
            S3Request::put_object("test-bucket", "source")
                .with_body(b"source data")
                .build(),
        )
        .await;

    // Copy object
    let resp = harness
        .call(
            S3Request::copy_object("test-bucket", "dest", "test-bucket", "source").build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify copy
    let resp = harness
        .call(S3Request::get_object("test-bucket", "dest").build())
        .await;
    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("source data"));
});

test_with_stores!(copy_object_cross_bucket, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("src-bucket").build())
        .await;
    harness
        .call(S3Request::create_bucket("dst-bucket").build())
        .await;

    harness
        .call(
            S3Request::put_object("src-bucket", "key")
                .with_body(b"cross bucket data")
                .build(),
        )
        .await;

    // Copy across buckets
    let resp = harness
        .call(S3Request::copy_object("dst-bucket", "key", "src-bucket", "key").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify copy
    let resp = harness
        .call(S3Request::get_object("dst-bucket", "key").build())
        .await;
    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("cross bucket data"));
});

test_with_stores!(
    copy_object_source_not_found,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let resp = harness
            .call(
                S3Request::copy_object("test-bucket", "dest", "test-bucket", "nonexistent")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
);

// =============================================================================
// List objects tests
// =============================================================================

test_with_stores!(list_objects_empty, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let resp = harness
        .call(S3Request::list_objects_v2("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
});

test_with_stores!(list_objects_basic, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Put some objects
    for key in ["a", "b", "c"] {
        harness
            .call(
                S3Request::put_object("test-bucket", key)
                    .with_body(format!("data-{key}").as_bytes())
                    .build(),
            )
            .await;
    }

    let resp = harness
        .call(S3Request::list_objects_v2("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    let body_str = String::from_utf8_lossy(&body);

    // Verify all keys are listed
    assert!(body_str.contains("<Key>a</Key>"));
    assert!(body_str.contains("<Key>b</Key>"));
    assert!(body_str.contains("<Key>c</Key>"));
});

test_with_stores!(list_objects_with_prefix, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Put objects in different "directories"
    harness
        .call(
            S3Request::put_object("test-bucket", "photos/cat.jpg")
                .with_body(b"cat")
                .build(),
        )
        .await;
    harness
        .call(
            S3Request::put_object("test-bucket", "photos/dog.jpg")
                .with_body(b"dog")
                .build(),
        )
        .await;
    harness
        .call(
            S3Request::put_object("test-bucket", "docs/readme.txt")
                .with_body(b"readme")
                .build(),
        )
        .await;

    // List only photos
    let resp = harness
        .call(
            S3Request::list_objects_v2("test-bucket")
                .with_prefix("photos/")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    let body_str = String::from_utf8_lossy(&body);

    // Should only contain photos
    assert!(body_str.contains("photos/cat.jpg"));
    assert!(body_str.contains("photos/dog.jpg"));
    assert!(!body_str.contains("docs/readme.txt"));
});

test_with_stores!(
    list_objects_with_delimiter,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        harness
            .call(
                S3Request::put_object("test-bucket", "photos/2023/cat.jpg")
                    .with_body(b"cat")
                    .build(),
            )
            .await;
        harness
            .call(
                S3Request::put_object("test-bucket", "root.txt")
                    .with_body(b"root")
                    .build(),
            )
            .await;

        // List with delimiter
        let resp = harness
            .call(
                S3Request::list_objects_v2("test-bucket")
                    .with_delimiter("/")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        let body_str = String::from_utf8_lossy(&body);

        // Should have root.txt as object and photos/ as common prefix
        assert!(body_str.contains("<Key>root.txt</Key>"));
        assert!(body_str.contains("<Prefix>photos/</Prefix>"));
    }
);

test_with_stores!(list_objects_max_keys, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Put 10 objects
    for i in 0..10 {
        harness
            .call(
                S3Request::put_object("test-bucket", &format!("key-{i:02}"))
                    .with_body(b"data")
                    .build(),
            )
            .await;
    }

    // List with max-keys=3
    let resp = harness
        .call(
            S3Request::list_objects_v2("test-bucket")
                .with_max_keys(3)
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    let body_str = String::from_utf8_lossy(&body);

    // Should indicate truncation
    assert!(body_str.contains("<IsTruncated>true</IsTruncated>"));
});
