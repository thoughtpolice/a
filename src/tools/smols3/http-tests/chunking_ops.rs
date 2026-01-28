// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Chunking-specific integration tests.
//!
//! These tests verify chunking layer behaviors like deduplication, chunk
//! sharing across copies, and proper cleanup on delete.

use bytes::Bytes;
use http::StatusCode;
use testing::{collect_body, S3Request, TestHarness};

/// Extract upload_id from CreateMultipartUploadResult XML response.
fn extract_upload_id(body: &[u8]) -> String {
    let body_str = String::from_utf8_lossy(body);
    // Parse out: <UploadId>...</UploadId>
    let start = body_str.find("<UploadId>").expect("no UploadId in response") + 10;
    let end = body_str[start..]
        .find("</UploadId>")
        .expect("no closing UploadId tag")
        + start;
    body_str[start..end].to_string()
}

/// Macro to generate tests only for chunking store backends.
macro_rules! test_with_chunking_stores {
    ($name:ident, $test:expr) => {
        mod $name {
            use super::*;

            #[tokio::test]
            async fn chunking_memory() {
                let inner = store::MemoryStore::new();
                let chunking_store = store::ChunkingStore::new(inner);
                let harness = TestHarness::new(chunking_store);
                let test_fn = $test;
                test_fn(harness).await;
            }

            #[tokio::test]
            async fn chunking_fjall() {
                let tmp = tempfile::tempdir().unwrap();
                let config = store::FjallStoreConfig::new(tmp.path());
                let fjall_store = store::FjallStore::open(config).unwrap();
                let chunking_store = store::ChunkingStore::new(fjall_store);
                let harness = TestHarness::new(chunking_store);
                let test_fn = $test;
                test_fn(harness).await;
            }

            #[tokio::test]
            async fn chunking_slatedb() {
                let slate_store = store::SlateStore::open_in_memory().await.unwrap();
                let chunking_store = store::ChunkingStore::new(slate_store);
                let harness = TestHarness::new(chunking_store);
                let test_fn = $test;
                test_fn(harness).await;
            }
        }
    };
}

// =============================================================================
// Deduplication tests
// =============================================================================

test_with_chunking_stores!(
    chunking_deduplication,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create a reasonably large object that will produce multiple chunks
        let data: Vec<u8> = (0..100_000).map(|i| (i % 256) as u8).collect();
        let data = Bytes::from(data);

        // Upload same data twice with different keys
        let resp1 = harness
            .call(
                S3Request::put_object("test-bucket", "obj1")
                    .with_body(&data)
                    .build(),
            )
            .await;
        assert_eq!(resp1.status(), StatusCode::OK);

        let resp2 = harness
            .call(
                S3Request::put_object("test-bucket", "obj2")
                    .with_body(&data)
                    .build(),
            )
            .await;
        assert_eq!(resp2.status(), StatusCode::OK);

        // Both objects should be retrievable with identical content
        let resp = harness
            .call(S3Request::get_object("test-bucket", "obj1").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body1 = collect_body(resp).await;

        let resp = harness
            .call(S3Request::get_object("test-bucket", "obj2").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body2 = collect_body(resp).await;

        assert_eq!(body1, data);
        assert_eq!(body2, data);
    }
);

test_with_chunking_stores!(
    chunking_dedup_survives_delete,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create duplicate data
        let data: Vec<u8> = (0..50_000).map(|i| (i % 256) as u8).collect();
        let data = Bytes::from(data);

        harness
            .call(
                S3Request::put_object("test-bucket", "first")
                    .with_body(&data)
                    .build(),
            )
            .await;

        harness
            .call(
                S3Request::put_object("test-bucket", "second")
                    .with_body(&data)
                    .build(),
            )
            .await;

        // Delete first object
        let resp = harness
            .call(S3Request::delete_object("test-bucket", "first").build())
            .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // Second object should still work (shared chunks not deleted)
        let resp = harness
            .call(S3Request::get_object("test-bucket", "second").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = collect_body(resp).await;
        assert_eq!(body, data);
    }
);

// =============================================================================
// Large object tests
// =============================================================================

test_with_chunking_stores!(chunking_large_object, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Create a 1MB object
    let data: Vec<u8> = (0..1_000_000).map(|i| (i % 256) as u8).collect();
    let data = Bytes::from(data);

    let resp = harness
        .call(
            S3Request::put_object("test-bucket", "large-object")
                .with_body(&data)
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Verify retrieval
    let resp = harness
        .call(S3Request::get_object("test-bucket", "large-object").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    assert_eq!(body.len(), 1_000_000);
    assert_eq!(body, data);
});

// =============================================================================
// Range read tests
// =============================================================================

test_with_chunking_stores!(
    chunking_range_across_chunks,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create data that will span multiple chunks
        let data: Vec<u8> = (0..500_000).map(|i| (i % 256) as u8).collect();
        let data = Bytes::from(data);

        harness
            .call(
                S3Request::put_object("test-bucket", "chunked")
                    .with_body(&data)
                    .build(),
            )
            .await;

        // Read a range that likely spans multiple chunks
        let resp = harness
            .call(
                S3Request::get_object("test-bucket", "chunked")
                    .with_range(100_000, 200_000)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);

        let body = collect_body(resp).await;
        assert_eq!(body.len(), 100_001); // inclusive range
        assert_eq!(body.as_ref(), &data[100_000..200_001]);
    }
);

test_with_chunking_stores!(
    chunking_range_at_boundaries,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let data: Vec<u8> = (0..300_000).map(|i| (i % 256) as u8).collect();
        let data = Bytes::from(data);

        harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(&data)
                    .build(),
            )
            .await;

        // Read from start
        let resp = harness
            .call(
                S3Request::get_object("test-bucket", "key")
                    .with_range(0, 99)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        let body = collect_body(resp).await;
        assert_eq!(body.as_ref(), &data[0..100]);

        // Read from end
        let resp = harness
            .call(
                S3Request::get_object("test-bucket", "key")
                    .with_range(299_900, 299_999)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PARTIAL_CONTENT);
        let body = collect_body(resp).await;
        assert_eq!(body.as_ref(), &data[299_900..300_000]);
    }
);

// =============================================================================
// Copy operation tests
// =============================================================================

test_with_chunking_stores!(
    chunking_copy_shares_chunks,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let data: Vec<u8> = (0..200_000).map(|i| (i % 256) as u8).collect();
        let data = Bytes::from(data);

        harness
            .call(
                S3Request::put_object("test-bucket", "source")
                    .with_body(&data)
                    .build(),
            )
            .await;

        // Copy the object
        let resp = harness
            .call(S3Request::copy_object("test-bucket", "dest", "test-bucket", "source").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Both should work
        let resp = harness
            .call(S3Request::get_object("test-bucket", "source").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let src_body = collect_body(resp).await;

        let resp = harness
            .call(S3Request::get_object("test-bucket", "dest").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let dst_body = collect_body(resp).await;

        assert_eq!(src_body, data);
        assert_eq!(dst_body, data);

        // Delete source - dest should still work (chunks are shared)
        let resp = harness
            .call(S3Request::delete_object("test-bucket", "source").build())
            .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        let resp = harness
            .call(S3Request::get_object("test-bucket", "dest").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = collect_body(resp).await;
        assert_eq!(body, data);
    }
);

// =============================================================================
// Delete and cleanup tests
// =============================================================================

test_with_chunking_stores!(
    chunking_delete_cleans_chunks,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create unique data (won't be shared)
        let data = Bytes::from(vec![0xABu8; 100_000]);

        harness
            .call(
                S3Request::put_object("test-bucket", "unique")
                    .with_body(&data)
                    .build(),
            )
            .await;

        // Verify object exists
        let resp = harness
            .call(S3Request::get_object("test-bucket", "unique").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Delete object
        let resp = harness
            .call(S3Request::delete_object("test-bucket", "unique").build())
            .await;
        assert_eq!(resp.status(), StatusCode::NO_CONTENT);

        // Object should be gone
        let resp = harness
            .call(S3Request::get_object("test-bucket", "unique").build())
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
);

// =============================================================================
// Empty and small object tests
// =============================================================================

test_with_chunking_stores!(
    chunking_empty_object,
    |harness: TestHarness| async move {
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

        let resp = harness
            .call(S3Request::get_object("test-bucket", "empty").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        assert!(body.is_empty());
    }
);

test_with_chunking_stores!(
    chunking_small_object,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Object smaller than min chunk size (should still work as single chunk)
        let data = Bytes::from("small data");

        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "small")
                    .with_body(&data)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let resp = harness
            .call(S3Request::get_object("test-bucket", "small").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        assert_eq!(body, data);
    }
);

// =============================================================================
// Multipart upload tests
// =============================================================================

test_with_chunking_stores!(
    chunking_multipart_upload,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Initiate multipart upload
        let resp = harness
            .call(S3Request::create_multipart_upload("test-bucket", "multipart-key").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        let upload_id = extract_upload_id(&body);

        // Upload parts (using smaller sizes to keep tests fast)
        let part1_data = vec![0x11u8; 100_000];
        let part2_data = vec![0x22u8; 100_000];

        let resp = harness
            .call(
                S3Request::upload_part("test-bucket", "multipart-key", &upload_id, 1)
                    .with_body(&part1_data)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let etag1 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let resp = harness
            .call(
                S3Request::upload_part("test-bucket", "multipart-key", &upload_id, 2)
                    .with_body(&part2_data)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let etag2 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // Complete multipart upload with XML body
        let complete_xml = format!(
            r#"<CompleteMultipartUpload>
            <Part><PartNumber>1</PartNumber><ETag>{etag1}</ETag></Part>
            <Part><PartNumber>2</PartNumber><ETag>{etag2}</ETag></Part>
        </CompleteMultipartUpload>"#
        );

        let resp = harness
            .call(
                S3Request::complete_multipart_upload("test-bucket", "multipart-key", &upload_id)
                    .with_body(complete_xml.as_bytes())
                    .with_content_type("application/xml")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify the assembled object
        let resp = harness
            .call(S3Request::get_object("test-bucket", "multipart-key").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        assert_eq!(body.len(), 200_000);
        assert_eq!(&body[..100_000], &part1_data[..]);
        assert_eq!(&body[100_000..], &part2_data[..]);
    }
);

// =============================================================================
// Conditional write tests
// =============================================================================

test_with_chunking_stores!(
    chunking_conditional_write,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create initial object
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"initial")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let etag = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // Try If-None-Match - should fail
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"conflict")
                    .with_if_none_match("*")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::PRECONDITION_FAILED);

        // Try If-Match with correct ETag - should succeed
        let resp = harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(b"updated")
                    .with_if_match(&etag)
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify updated content
        let resp = harness
            .call(S3Request::get_object("test-bucket", "key").build())
            .await;
        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("updated"));
    }
);

// =============================================================================
// Overwrite cleanup tests
// =============================================================================

test_with_chunking_stores!(
    chunking_overwrite_cleanup,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create first version with unique data
        let data1 = vec![0x11u8; 100_000];
        harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(&data1)
                    .build(),
            )
            .await;

        // Overwrite with different data
        let data2 = vec![0x22u8; 100_000];
        harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(&data2)
                    .build(),
            )
            .await;

        // Verify we get the new data
        let resp = harness
            .call(S3Request::get_object("test-bucket", "key").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
        let body = collect_body(resp).await;
        assert_eq!(body.as_ref(), &data2[..]);
    }
);

// =============================================================================
// Reserved bucket tests
// =============================================================================

test_with_chunking_stores!(
    chunking_reserved_bucket_hidden,
    |harness: TestHarness| async move {
        // Create a visible bucket
        harness
            .call(S3Request::create_bucket("visible-bucket").build())
            .await;

        // Put an object to ensure __chunks__ bucket is created internally
        harness
            .call(
                S3Request::put_object("visible-bucket", "key")
                    .with_body(b"data")
                    .build(),
            )
            .await;

        // List buckets - should only see visible-bucket
        let resp = harness.call(S3Request::list_buckets().build()).await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        let body_str = String::from_utf8_lossy(&body);

        assert!(body_str.contains("visible-bucket"));
        assert!(!body_str.contains("__chunks__"));
    }
);

test_with_chunking_stores!(
    chunking_cannot_access_reserved_bucket,
    |harness: TestHarness| async move {
        // Try to create the reserved bucket - should fail
        // (may return 400 Bad Request or 500 Internal Error depending on S3 layer translation)
        let resp = harness
            .call(S3Request::create_bucket("__chunks__").build())
            .await;
        assert!(
            resp.status() == StatusCode::INTERNAL_SERVER_ERROR
                || resp.status() == StatusCode::BAD_REQUEST,
            "expected 400 or 500, got {}",
            resp.status()
        );

        // Try to put to reserved bucket - should fail
        let resp = harness
            .call(
                S3Request::put_object("__chunks__", "key")
                    .with_body(b"data")
                    .build(),
            )
            .await;
        assert!(
            resp.status() == StatusCode::INTERNAL_SERVER_ERROR
                || resp.status() == StatusCode::BAD_REQUEST,
            "expected 400 or 500, got {}",
            resp.status()
        );
    }
);

// =============================================================================
// Head object size verification
// =============================================================================

test_with_chunking_stores!(
    chunking_head_object_size,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let data = vec![0xCDu8; 150_000];
        harness
            .call(
                S3Request::put_object("test-bucket", "key")
                    .with_body(&data)
                    .build(),
            )
            .await;

        let resp = harness
            .call(S3Request::head_object("test-bucket", "key").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Content-Length should report original data size, not manifest size
        let content_length = resp
            .headers()
            .get("content-length")
            .expect("should have content-length")
            .to_str()
            .unwrap();
        assert_eq!(content_length, "150000");
    }
);
