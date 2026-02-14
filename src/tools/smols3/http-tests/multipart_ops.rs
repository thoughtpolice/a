// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Multipart upload operation tests.

use bytes::Bytes;
use http::StatusCode;
use testing::{collect_body, S3Request, TestHarness};

use crate::test_with_stores;

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

// =============================================================================
// Create multipart upload tests
// =============================================================================

test_with_stores!(
    create_multipart_upload,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let resp = harness
            .call(S3Request::create_multipart_upload("test-bucket", "large-file.bin").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        let upload_id = extract_upload_id(&body);
        assert!(!upload_id.is_empty());
    }
);

test_with_stores!(
    create_multipart_upload_no_bucket,
    |harness: TestHarness| async move {
        let resp = harness
            .call(S3Request::create_multipart_upload("nonexistent", "key").build())
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
);

// =============================================================================
// Upload part tests
// =============================================================================

test_with_stores!(upload_part, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Create multipart upload
    let resp = harness
        .call(S3Request::create_multipart_upload("test-bucket", "key").build())
        .await;
    let body = collect_body(resp).await;
    let upload_id = extract_upload_id(&body);

    // Upload a part
    let resp = harness
        .call(
            S3Request::upload_part("test-bucket", "key", &upload_id, 1)
                .with_body(b"part 1 data")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);
    assert!(resp.headers().contains_key("etag"));
});

test_with_stores!(upload_part_no_upload, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    let resp = harness
        .call(
            S3Request::upload_part("test-bucket", "key", "nonexistent-upload-id", 1)
                .with_body(b"data")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

// =============================================================================
// Complete multipart upload tests
// =============================================================================

test_with_stores!(
    complete_multipart_upload,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create multipart upload
        let resp = harness
            .call(S3Request::create_multipart_upload("test-bucket", "assembled.bin").build())
            .await;
        let body = collect_body(resp).await;
        let upload_id = extract_upload_id(&body);

        // Upload parts
        let resp = harness
            .call(
                S3Request::upload_part("test-bucket", "assembled.bin", &upload_id, 1)
                    .with_body(b"Hello ")
                    .build(),
            )
            .await;
        let etag1 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        let resp = harness
            .call(
                S3Request::upload_part("test-bucket", "assembled.bin", &upload_id, 2)
                    .with_body(b"World!")
                    .build(),
            )
            .await;
        let etag2 = resp
            .headers()
            .get("etag")
            .unwrap()
            .to_str()
            .unwrap()
            .to_string();

        // Complete the upload
        let complete_xml = format!(
            r#"<CompleteMultipartUpload>
            <Part><PartNumber>1</PartNumber><ETag>{etag1}</ETag></Part>
            <Part><PartNumber>2</PartNumber><ETag>{etag2}</ETag></Part>
        </CompleteMultipartUpload>"#
        );

        let resp = harness
            .call(
                S3Request::complete_multipart_upload("test-bucket", "assembled.bin", &upload_id)
                    .with_body(complete_xml.as_bytes())
                    .with_content_type("application/xml")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // Verify the assembled object
        let resp = harness
            .call(S3Request::get_object("test-bucket", "assembled.bin").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("Hello World!"));
    }
);

// =============================================================================
// Abort multipart upload tests
// =============================================================================

test_with_stores!(abort_multipart_upload, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Create multipart upload
    let resp = harness
        .call(S3Request::create_multipart_upload("test-bucket", "key").build())
        .await;
    let body = collect_body(resp).await;
    let upload_id = extract_upload_id(&body);

    // Upload a part
    harness
        .call(
            S3Request::upload_part("test-bucket", "key", &upload_id, 1)
                .with_body(b"data")
                .build(),
        )
        .await;

    // Abort the upload
    let resp = harness
        .call(S3Request::abort_multipart_upload("test-bucket", "key", &upload_id).build())
        .await;
    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // Verify upload is gone by trying to list parts
    let resp = harness
        .call(S3Request::list_parts("test-bucket", "key", &upload_id).build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
});

test_with_stores!(
    abort_multipart_upload_no_upload,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let resp = harness
            .call(
                S3Request::abort_multipart_upload("test-bucket", "key", "nonexistent-upload-id")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::NOT_FOUND);
    }
);

// =============================================================================
// List parts tests
// =============================================================================

test_with_stores!(list_parts, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Create multipart upload
    let resp = harness
        .call(S3Request::create_multipart_upload("test-bucket", "key").build())
        .await;
    let body = collect_body(resp).await;
    let upload_id = extract_upload_id(&body);

    // Upload parts (out of order)
    harness
        .call(
            S3Request::upload_part("test-bucket", "key", &upload_id, 3)
                .with_body(b"third")
                .build(),
        )
        .await;
    harness
        .call(
            S3Request::upload_part("test-bucket", "key", &upload_id, 1)
                .with_body(b"first")
                .build(),
        )
        .await;
    harness
        .call(
            S3Request::upload_part("test-bucket", "key", &upload_id, 2)
                .with_body(b"second")
                .build(),
        )
        .await;

    // List parts
    let resp = harness
        .call(S3Request::list_parts("test-bucket", "key", &upload_id).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    let body_str = String::from_utf8_lossy(&body);

    // Verify all parts are listed
    assert!(body_str.contains("<PartNumber>1</PartNumber>"));
    assert!(body_str.contains("<PartNumber>2</PartNumber>"));
    assert!(body_str.contains("<PartNumber>3</PartNumber>"));
});

// =============================================================================
// List multipart uploads tests
// =============================================================================

test_with_stores!(list_multipart_uploads, |harness: TestHarness| async move {
    harness
        .call(S3Request::create_bucket("test-bucket").build())
        .await;

    // Create multiple multipart uploads
    harness
        .call(S3Request::create_multipart_upload("test-bucket", "file1.bin").build())
        .await;
    harness
        .call(S3Request::create_multipart_upload("test-bucket", "file2.bin").build())
        .await;

    // List uploads
    let resp = harness
        .call(S3Request::list_multipart_uploads("test-bucket").build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    let body_str = String::from_utf8_lossy(&body);

    // Verify both uploads are listed
    assert!(body_str.contains("file1.bin"));
    assert!(body_str.contains("file2.bin"));
});

test_with_stores!(
    list_multipart_uploads_empty,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let resp = harness
            .call(S3Request::list_multipart_uploads("test-bucket").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);
    }
);

// =============================================================================
// Part ordering tests
// =============================================================================

test_with_stores!(
    complete_multipart_parts_assembled_by_number,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        // Create multipart upload
        let resp = harness
            .call(S3Request::create_multipart_upload("test-bucket", "ordered.bin").build())
            .await;
        let body = collect_body(resp).await;
        let upload_id = extract_upload_id(&body);

        // Upload parts out of order: 3, 1, 2
        let resp = harness
            .call(
                S3Request::upload_part("test-bucket", "ordered.bin", &upload_id, 3)
                    .with_body(b"C")
                    .build(),
            )
            .await;
        let etag3 = resp.headers().get("etag").unwrap().to_str().unwrap().to_string();

        let resp = harness
            .call(
                S3Request::upload_part("test-bucket", "ordered.bin", &upload_id, 1)
                    .with_body(b"A")
                    .build(),
            )
            .await;
        let etag1 = resp.headers().get("etag").unwrap().to_str().unwrap().to_string();

        let resp = harness
            .call(
                S3Request::upload_part("test-bucket", "ordered.bin", &upload_id, 2)
                    .with_body(b"B")
                    .build(),
            )
            .await;
        let etag2 = resp.headers().get("etag").unwrap().to_str().unwrap().to_string();

        // Complete with parts listed out of order: 3, 1, 2
        let complete_xml = format!(
            r#"<CompleteMultipartUpload>
            <Part><PartNumber>3</PartNumber><ETag>{etag3}</ETag></Part>
            <Part><PartNumber>1</PartNumber><ETag>{etag1}</ETag></Part>
            <Part><PartNumber>2</PartNumber><ETag>{etag2}</ETag></Part>
        </CompleteMultipartUpload>"#
        );

        let resp = harness
            .call(
                S3Request::complete_multipart_upload("test-bucket", "ordered.bin", &upload_id)
                    .with_body(complete_xml.as_bytes())
                    .with_content_type("application/xml")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // GET assembled object - must be "ABC" (sorted by part number), not "CAB"
        let resp = harness
            .call(S3Request::get_object("test-bucket", "ordered.bin").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("ABC"));
    }
);

test_with_stores!(
    complete_multipart_many_parts_reverse,
    |harness: TestHarness| async move {
        harness
            .call(S3Request::create_bucket("test-bucket").build())
            .await;

        let resp = harness
            .call(S3Request::create_multipart_upload("test-bucket", "reverse.bin").build())
            .await;
        let body = collect_body(resp).await;
        let upload_id = extract_upload_id(&body);

        // Upload 5 parts in reverse order: 5, 4, 3, 2, 1
        let parts_data = [
            (5, "E"),
            (4, "D"),
            (3, "C"),
            (2, "B"),
            (1, "A"),
        ];
        let mut etags = std::collections::HashMap::new();

        for (num, data) in &parts_data {
            let resp = harness
                .call(
                    S3Request::upload_part("test-bucket", "reverse.bin", &upload_id, *num)
                        .with_body(data.as_bytes())
                        .build(),
                )
                .await;
            let etag = resp.headers().get("etag").unwrap().to_str().unwrap().to_string();
            etags.insert(*num, etag);
        }

        // Complete listing parts in reverse order
        let complete_xml = format!(
            r#"<CompleteMultipartUpload>
            <Part><PartNumber>5</PartNumber><ETag>{}</ETag></Part>
            <Part><PartNumber>4</PartNumber><ETag>{}</ETag></Part>
            <Part><PartNumber>3</PartNumber><ETag>{}</ETag></Part>
            <Part><PartNumber>2</PartNumber><ETag>{}</ETag></Part>
            <Part><PartNumber>1</PartNumber><ETag>{}</ETag></Part>
        </CompleteMultipartUpload>"#,
            etags[&5], etags[&4], etags[&3], etags[&2], etags[&1]
        );

        let resp = harness
            .call(
                S3Request::complete_multipart_upload("test-bucket", "reverse.bin", &upload_id)
                    .with_body(complete_xml.as_bytes())
                    .with_content_type("application/xml")
                    .build(),
            )
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        // GET → "ABCDE" (assembled by ascending part number)
        let resp = harness
            .call(S3Request::get_object("test-bucket", "reverse.bin").build())
            .await;
        assert_eq!(resp.status(), StatusCode::OK);

        let body = collect_body(resp).await;
        assert_eq!(body, Bytes::from("ABCDE"));
    }
);
