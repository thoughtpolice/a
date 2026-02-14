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

// =============================================================================
// Conditional write tests
// =============================================================================

test_with_stores!(
    put_object_if_none_match_success,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Put with If-None-Match: * when object doesn't exist - should succeed
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "new-key")
                    .with_body(b"data")
                    .with_if_none_match("*")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify object was created
        let resp = harness
            .call(S3Request::get_object("test-bucket", "new-key").build())
            .await;
        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("data"));
    }
);

test_with_stores!(
    put_object_if_none_match_fails_when_exists,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Put initial object
        harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"original")
                    .build(),
            )
            .await;

        // Try to put with If-None-Match: * - should fail with 412
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"new")
                    .with_if_none_match("*")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PRECONDITION_FAILED);

        // Verify original data is unchanged
        let resp = harness
            .call(S3Request::get_object("test-bucket", "key").build())
            .await;
        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("original"));
    }
);

test_with_stores!(
    put_object_if_match_success,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Put initial object
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"original")
                    .build(),
            )
            .await;
        let etag = resp
            .headers()
            .get("etag")
            .expect("should have etag")
            .to_str()
            .unwrap()
            .to_string();

        // Put with matching If-Match - should succeed
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"updated")
                    .with_if_match(&etag)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify update succeeded
        let resp = harness
            .call(S3Request::get_object("test-bucket", "key").build())
            .await;
        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("updated"));
    }
);

test_with_stores!(
    put_object_if_match_fails_when_etag_mismatch,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Put initial object
        harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"original")
                    .build(),
            )
            .await;

        // Put with wrong If-Match - should fail with 412
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"updated")
                    .with_if_match("\"wrong-etag\"")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PRECONDITION_FAILED);

        // Verify original data is unchanged
        let resp = harness
            .call(S3Request::get_object("test-bucket", "key").build())
            .await;
        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("original"));
    }
);

test_with_stores!(
    put_object_if_match_fails_when_not_exists,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Put with If-Match when object doesn't exist - should fail with 412
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "nonexistent")
                    .with_body(b"data")
                    .with_if_match("\"some-etag\"")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PRECONDITION_FAILED);
    }
);

// =============================================================================
// Range read tests
// =============================================================================

test_with_stores!(get_object_range_middle, |harness: TestHarness| async move {
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

    // Get range bytes 7-11 ("World")
    let resp = harness
        .call(
            S3Request::get_object("test-bucket", "data.txt")
                .with_range(7, 11)
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);

    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("World"));
});

test_with_stores!(
    get_object_range_content_range_header,
    |harness: TestHarness| async move {
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

        let (resp, body) = harness
            .call_and_collect(
                S3Request::get_object("test-bucket", "data.txt")
                    .with_range(0, 4)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        assert_eq!(body, Bytes::from("Hello"));

        let content_range = resp
            .headers()
            .get("content-range")
            .expect("should have content-range header")
            .to_str()
            .unwrap();
        assert_eq!(content_range, "bytes 0-4/13");
    }
);

test_with_stores!(
    get_object_range_single_byte,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        harness
            .call(
                S3Request::put_object("test-bucket", "data.txt")
                    .with_body(b"ABCDE")
                    .build(),
            )
            .await;

        let resp = harness
            .call(
                S3Request::get_object("test-bucket", "data.txt")
                    .with_range(2, 2)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);

        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("C"));
    }
);

// =============================================================================
// List objects pagination tests
// =============================================================================

test_with_stores!(
    list_objects_pagination_full,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create 10 objects
        for i in 0..10 {
            harness
                .call(
                    S3Request::put_object("test-bucket", &format!("key-{i:02}"))
                        .with_body(b"data")
                        .build(),
                )
                .await;
        }

        let mut all_keys = Vec::new();
        let mut continuation_token: Option<String> = None;
        let mut page_count = 0;

        loop {
            let mut req = S3Request::list_objects_v2("test-bucket").with_max_keys(3);
            if let Some(ref token) = continuation_token {
                req = req.with_query("continuation-token", token);
            }

            let (resp, body) = harness.call_and_collect(req.build()).await;
            assert_eq!(resp.status(), StatusCode::OK);

            let body_str = String::from_utf8_lossy(&body);
            page_count += 1;

            // Extract keys from this page
            let mut offset = 0;
            while let Some(start) = body_str[offset..].find("<Key>") {
                let key_start = offset + start + 5;
                let key_end = key_start
                    + body_str[key_start..]
                        .find("</Key>")
                        .expect("missing </Key>");
                all_keys.push(body_str[key_start..key_end].to_string());
                offset = key_end + 6;
            }

            // Check for next page
            if let Some(start) = body_str.find("<NextContinuationToken>") {
                let token_start = start + 23;
                let token_end = token_start
                    + body_str[token_start..]
                        .find("</NextContinuationToken>")
                        .expect("missing closing tag");
                continuation_token = Some(body_str[token_start..token_end].to_string());
            } else {
                // Last page should not be truncated
                assert!(body_str.contains("<IsTruncated>false</IsTruncated>"));
                break;
            }
        }

        // Verify: 4 pages (3+3+3+1), all 10 unique keys, sorted order
        assert_eq!(page_count, 4);
        assert_eq!(all_keys.len(), 10);

        // Keys should be sorted
        let mut sorted_keys = all_keys.clone();
        sorted_keys.sort();
        assert_eq!(all_keys, sorted_keys);

        // All expected keys present
        for i in 0..10 {
            assert!(all_keys.contains(&format!("key-{i:02}")));
        }
    }
);

test_with_stores!(
    list_objects_continuation_token_resumes,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create 5 objects
        for i in 0..5 {
            harness
                .call(
                    S3Request::put_object("test-bucket", &format!("key-{i:02}"))
                        .with_body(b"data")
                        .build(),
                )
                .await;
        }

        // First page: max_keys=2
        let (_, body1) = harness
            .call_and_collect(
                S3Request::list_objects_v2("test-bucket")
                    .with_max_keys(2)
                    .build(),
            )
            .await;

        let body1_str = String::from_utf8_lossy(&body1);
        assert!(body1_str.contains("<IsTruncated>true</IsTruncated>"));

        // Extract continuation token
        let token_start = body1_str
            .find("<NextContinuationToken>")
            .expect("should have token")
            + 23;
        let token_end = token_start
            + body1_str[token_start..]
                .find("</NextContinuationToken>")
                .expect("missing closing tag");
        let token = &body1_str[token_start..token_end];

        // Extract keys from first page
        let mut page1_keys = Vec::new();
        let mut offset = 0;
        while let Some(start) = body1_str[offset..].find("<Key>") {
            let key_start = offset + start + 5;
            let key_end = key_start
                + body1_str[key_start..]
                    .find("</Key>")
                    .expect("missing </Key>");
            page1_keys.push(body1_str[key_start..key_end].to_string());
            offset = key_end + 6;
        }

        // Second page: continue from token
        let (_, body2) = harness
            .call_and_collect(
                S3Request::list_objects_v2("test-bucket")
                    .with_max_keys(2)
                    .with_query("continuation-token", token)
                    .build(),
            )
            .await;

        let body2_str = String::from_utf8_lossy(&body2);

        // Extract keys from second page
        let mut page2_keys = Vec::new();
        offset = 0;
        while let Some(start) = body2_str[offset..].find("<Key>") {
            let key_start = offset + start + 5;
            let key_end = key_start
                + body2_str[key_start..]
                    .find("</Key>")
                    .expect("missing </Key>");
            page2_keys.push(body2_str[key_start..key_end].to_string());
            offset = key_end + 6;
        }

        // Verify no overlap between pages
        for key in &page1_keys {
            assert!(
                !page2_keys.contains(key),
                "key {} appears on both pages",
                key
            );
        }

        // Second page keys should be lexicographically after first page keys
        if let (Some(last_p1), Some(first_p2)) = (page1_keys.last(), page2_keys.first()) {
            assert!(
                last_p1 < first_p2,
                "page 2 keys should come after page 1 keys: {} vs {}",
                last_p1,
                first_p2
            );
        }
    }
);

// =============================================================================
// Key name validation tests
// =============================================================================

#[cfg(feature = "memory")]
#[tokio::test]
async fn put_object_key_too_long_rejected() {
    let harness = TestHarness::new(store::MemoryStore::new());

    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let long_key = "x".repeat(1025);
    let resp = harness
        .call(
            S3Request::put_object("test-bucket", &long_key)
                .with_body(b"data")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

// =============================================================================
// Max body size tests
// =============================================================================

#[cfg(feature = "memory")]
#[tokio::test]
async fn put_object_body_too_large() {
    let config = store::SmolS3Config {
        max_body_size: Some(100),
    };
    let harness = TestHarness::with_config(store::MemoryStore::new(), config);

    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let body = vec![0u8; 200];
    let resp = harness
        .call(
            S3Request::put_object("test-bucket", "key")
                .with_body(&body)
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::BAD_REQUEST);
}

#[cfg(feature = "memory")]
#[tokio::test]
async fn put_object_body_at_limit() {
    let config = store::SmolS3Config {
        max_body_size: Some(100),
    };
    let harness = TestHarness::with_config(store::MemoryStore::new(), config);

    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let body = vec![0u8; 100];
    let resp = harness
        .call(
            S3Request::put_object("test-bucket", "key")
                .with_body(&body)
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
}

// =============================================================================
// Conditional write tests
// =============================================================================

test_with_stores!(
    conditional_write_compare_and_swap,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create initial value
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "counter")
                    .with_body(b"0")
                    .build(),
            )
            .await;
        let etag_v0 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // CAS: update 0 -> 1 with correct etag
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "counter")
                    .with_body(b"1")
                    .with_if_match(&etag_v0)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let etag_v1 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // CAS: try to update with stale etag - should fail
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "counter")
                    .with_body(b"conflict")
                    .with_if_match(&etag_v0)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PRECONDITION_FAILED);

        // CAS: update 1 -> 2 with correct etag
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "counter")
                    .with_body(b"2")
                    .with_if_match(&etag_v1)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify final value
        let resp = harness
            .call(S3Request::get_object("test-bucket", "counter").build())
            .await;
        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("2"));
    }
);
