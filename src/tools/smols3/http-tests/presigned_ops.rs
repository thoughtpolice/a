// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Presigned URL operation tests.
//!
//! These tests verify that presigned URLs work correctly for S3 operations.
//! Presigned URLs embed authentication in the URL query parameters, allowing
//! unauthenticated clients to access resources for a limited time.

use bytes::Bytes;
use http::{Method, Request, StatusCode, Uri};
use s3s::auth::SimpleAuth;
use store::MemoryStore;
use testing::{collect_body, SignedRequest, TestCredentials, TestHarness};

/// Create a test harness with authentication enabled.
fn harness_with_auth() -> (TestHarness, TestCredentials) {
    let store = MemoryStore::new();
    let auth = SimpleAuth::from_single("AKIATEST", "secretkey");
    let harness = TestHarness::with_auth(store, Some(auth));
    let creds = TestCredentials::new("AKIATEST", "secretkey");
    (harness, creds)
}

/// Build an HTTP request from a presigned URL.
fn request_from_presigned_url(url: &str, method: Method) -> Request<s3s::Body> {
    request_from_presigned_url_with_body(url, method, None)
}

/// Build an HTTP request from a presigned URL with an optional body.
fn request_from_presigned_url_with_body(
    url: &str,
    method: Method,
    body: Option<&[u8]>,
) -> Request<s3s::Body> {
    // Parse the URL to extract the path and query
    let url_parts: Vec<&str> = url.splitn(2, "://").collect();
    let after_scheme = url_parts.get(1).unwrap_or(&"");
    let host_and_path: Vec<&str> = after_scheme.splitn(2, '/').collect();
    let path_and_query = format!("/{}", host_and_path.get(1).unwrap_or(&""));

    let uri: Uri = path_and_query.parse().expect("invalid URI from presigned URL");

    let body = match body {
        Some(bytes) => s3s::Body::from(Bytes::copy_from_slice(bytes)),
        None => s3s::Body::empty(),
    };

    Request::builder()
        .method(method)
        .uri(uri)
        .header("host", "localhost")
        .body(body)
        .expect("failed to build request")
}

// =============================================================================
// Basic presigned GET tests
// =============================================================================

#[tokio::test]
async fn presigned_get_object() {
    let (harness, creds) = harness_with_auth();

    // Create bucket using signed request
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;

    // Put object using signed request
    harness
        .call(
            SignedRequest::put_object("test-bucket", "hello.txt", creds.clone())
                .with_body(b"Hello, Presigned World!")
                .build(),
        )
        .await;

    // Generate presigned URL for GET
    let presigned_url = SignedRequest::get_object("test-bucket", "hello.txt", creds)
        .build_presigned_url("http://localhost", 3600);

    // Fetch using presigned URL (no Authorization header)
    let req = request_from_presigned_url(&presigned_url, Method::GET);
    let resp = harness.call(req).await;

    assert_eq!(resp.status(), StatusCode::OK);
    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("Hello, Presigned World!"));
}

#[tokio::test]
async fn presigned_get_object_not_found() {
    let (harness, creds) = harness_with_auth();

    // Create bucket
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;

    // Generate presigned URL for non-existent object
    let presigned_url = SignedRequest::get_object("test-bucket", "nonexistent", creds)
        .build_presigned_url("http://localhost", 3600);

    let req = request_from_presigned_url(&presigned_url, Method::GET);
    let resp = harness.call(req).await;

    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}

// =============================================================================
// Presigned PUT tests
// =============================================================================

#[tokio::test]
async fn presigned_put_object() {
    let (harness, creds) = harness_with_auth();

    // Create bucket using signed request
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;

    // Generate presigned URL for PUT
    let presigned_url = SignedRequest::put_object("test-bucket", "uploaded.txt", creds.clone())
        .build_presigned_url("http://localhost", 3600);

    // Upload using presigned URL
    let req = request_from_presigned_url_with_body(
        &presigned_url,
        Method::PUT,
        Some(b"Uploaded via presigned URL"),
    );
    let resp = harness.call(req).await;

    assert_eq!(resp.status(), StatusCode::OK);

    // Verify the object was created using signed GET
    let resp = harness
        .call(SignedRequest::get_object("test-bucket", "uploaded.txt", creds).build())
        .await;
    let body = collect_body(resp).await;
    assert_eq!(body, Bytes::from("Uploaded via presigned URL"));
}

// =============================================================================
// Presigned HEAD tests
// =============================================================================

#[tokio::test]
async fn presigned_head_object() {
    let (harness, creds) = harness_with_auth();

    // Create bucket and object
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;
    harness
        .call(
            SignedRequest::put_object("test-bucket", "test.txt", creds.clone())
                .with_body(b"test content")
                .build(),
        )
        .await;

    // Generate presigned URL for HEAD
    let presigned_url = SignedRequest::head_object("test-bucket", "test.txt", creds)
        .build_presigned_url("http://localhost", 3600);

    let req = request_from_presigned_url(&presigned_url, Method::HEAD);
    let resp = harness.call(req).await;

    assert_eq!(resp.status(), StatusCode::OK);
    assert!(resp.headers().contains_key("content-length"));
    assert!(resp.headers().contains_key("etag"));
}

// =============================================================================
// Invalid signature tests
// =============================================================================

#[tokio::test]
async fn presigned_invalid_signature_denied() {
    let (harness, creds) = harness_with_auth();

    // Create bucket and object
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;
    harness
        .call(
            SignedRequest::put_object("test-bucket", "secret.txt", creds.clone())
                .with_body(b"secret data")
                .build(),
        )
        .await;

    // Generate presigned URL
    let presigned_url = SignedRequest::get_object("test-bucket", "secret.txt", creds)
        .build_presigned_url("http://localhost", 3600);

    // Tamper with the signature (replace last character)
    let tampered_url = if presigned_url.ends_with('0') {
        format!("{}1", &presigned_url[..presigned_url.len() - 1])
    } else {
        format!("{}0", &presigned_url[..presigned_url.len() - 1])
    };

    let req = request_from_presigned_url(&tampered_url, Method::GET);
    let resp = harness.call(req).await;

    // Should be rejected with 403
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn presigned_wrong_credentials_denied() {
    let (harness, creds) = harness_with_auth();

    // Create bucket and object
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;
    harness
        .call(
            SignedRequest::put_object("test-bucket", "file.txt", creds)
                .with_body(b"data")
                .build(),
        )
        .await;

    // Generate presigned URL with wrong credentials
    let wrong_creds = TestCredentials::new("AKIATEST", "wrongkey");
    let presigned_url = SignedRequest::get_object("test-bucket", "file.txt", wrong_creds)
        .build_presigned_url("http://localhost", 3600);

    let req = request_from_presigned_url(&presigned_url, Method::GET);
    let resp = harness.call(req).await;

    // Should be rejected with 403 (signature mismatch)
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// =============================================================================
// Method mismatch tests
// =============================================================================

#[tokio::test]
async fn presigned_url_wrong_method_denied() {
    let (harness, creds) = harness_with_auth();

    // Create bucket
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;

    // Generate presigned URL for GET
    let get_url = SignedRequest::get_object("test-bucket", "test.txt", creds)
        .build_presigned_url("http://localhost", 3600);

    // Try to use it for PUT (should fail because method is part of signature)
    let req = request_from_presigned_url_with_body(&get_url, Method::PUT, Some(b"data"));
    let resp = harness.call(req).await;

    // The signature won't match because the method is part of the canonical request
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// =============================================================================
// Edge cases
// =============================================================================

#[tokio::test]
async fn presigned_list_objects() {
    let (harness, creds) = harness_with_auth();

    // Create bucket and objects
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;
    for key in ["a.txt", "b.txt", "c.txt"] {
        harness
            .call(
                SignedRequest::put_object("test-bucket", key, creds.clone())
                    .with_body(format!("content-{key}").as_bytes())
                    .build(),
            )
            .await;
    }

    // Generate presigned URL for list objects v2
    let presigned_url =
        SignedRequest::list_objects_v2("test-bucket", creds).build_presigned_url("http://localhost", 3600);

    let req = request_from_presigned_url(&presigned_url, Method::GET);
    let resp = harness.call(req).await;

    assert_eq!(resp.status(), StatusCode::OK);
    let body = collect_body(resp).await;
    let body_str = String::from_utf8_lossy(&body);

    // Verify all keys are listed
    assert!(body_str.contains("<Key>a.txt</Key>"));
    assert!(body_str.contains("<Key>b.txt</Key>"));
    assert!(body_str.contains("<Key>c.txt</Key>"));
}

#[tokio::test]
async fn presigned_delete_object() {
    let (harness, creds) = harness_with_auth();

    // Create bucket and object
    harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;
    harness
        .call(
            SignedRequest::put_object("test-bucket", "to-delete.txt", creds.clone())
                .with_body(b"delete me")
                .build(),
        )
        .await;

    // Generate presigned URL for DELETE
    let presigned_url = SignedRequest::delete_object("test-bucket", "to-delete.txt", creds.clone())
        .build_presigned_url("http://localhost", 3600);

    let req = request_from_presigned_url(&presigned_url, Method::DELETE);
    let resp = harness.call(req).await;

    assert_eq!(resp.status(), StatusCode::NO_CONTENT);

    // Verify object is gone
    let resp = harness
        .call(SignedRequest::get_object("test-bucket", "to-delete.txt", creds).build())
        .await;
    assert_eq!(resp.status(), StatusCode::NOT_FOUND);
}
