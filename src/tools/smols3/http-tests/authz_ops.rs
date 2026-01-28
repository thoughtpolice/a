// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Authorization tests for Cedar-based access control.
//!
//! These tests verify that Cedar policies correctly control access to S3
//! operations. They use signed requests to pass authentication and then
//! verify that authorization policies permit or deny as expected.

use http::StatusCode;
use s3s::auth::SimpleAuth;
use store::{CedarAuthorizer, MemoryStore};
use testing::{collect_body, SignedRequest, TestCredentials, TestHarness};

/// Create a test harness with auth and Cedar authorization.
fn harness_with_policy(policy: &str) -> (TestHarness, TestCredentials) {
    let store = MemoryStore::new();
    let auth = SimpleAuth::from_single("AKIAADMIN", "secretkey");
    let access = CedarAuthorizer::from_policy_str(policy).expect("valid policy");
    let harness = TestHarness::with_auth_and_access(store, Some(auth), Some(access));
    let creds = TestCredentials::new("AKIAADMIN", "secretkey");
    (harness, creds)
}

/// Create a harness with multiple users.
fn harness_with_policy_multi_user(policy: &str) -> TestHarness {
    let store = MemoryStore::new();
    let mut auth = SimpleAuth::new();
    auth.register("AKIAADMIN".to_string(), "adminkey".into());
    auth.register("AKIAREADONLY".to_string(), "readonlykey".into());
    auth.register("AKIAUPLOADER".to_string(), "uploadkey".into());
    let access = CedarAuthorizer::from_policy_str(policy).expect("valid policy");
    TestHarness::with_auth_and_access(store, Some(auth), Some(access))
}

// =============================================================================
// Basic permit/deny tests
// =============================================================================

#[tokio::test]
async fn permit_all_policy_allows_operations() {
    let policy = r#"
        permit(principal, action, resource);
    "#;
    let (harness, creds) = harness_with_policy(policy);

    // Create bucket should succeed
    let resp = harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Put object should succeed
    let resp = harness
        .call(
            SignedRequest::put_object("test-bucket", "key", creds.clone())
                .with_body(b"hello")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Get object should succeed
    let resp = harness
        .call(SignedRequest::get_object("test-bucket", "key", creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let body = collect_body(resp).await;
    assert_eq!(&body[..], b"hello");
}

#[tokio::test]
async fn empty_policy_denies_all() {
    // Empty policy means no permits, so everything is denied
    let policy = "";
    let (harness, creds) = harness_with_policy(policy);

    // Create bucket should be denied
    let resp = harness
        .call(SignedRequest::create_bucket("test-bucket", creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// =============================================================================
// User-specific policy tests
// =============================================================================

#[tokio::test]
async fn specific_user_permit() {
    let policy = r#"
        permit(
            principal == SmolS3::User::"AKIAADMIN",
            action,
            resource
        );
    "#;
    let harness = harness_with_policy_multi_user(policy);

    // Admin user should be allowed
    let admin_creds = TestCredentials::new("AKIAADMIN", "adminkey");
    let resp = harness
        .call(SignedRequest::create_bucket("test-bucket", admin_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Read-only user should be denied
    let readonly_creds = TestCredentials::new("AKIAREADONLY", "readonlykey");
    let resp = harness
        .call(SignedRequest::create_bucket("other-bucket", readonly_creds).build())
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// =============================================================================
// Action-specific policy tests
// =============================================================================

#[tokio::test]
async fn readonly_user_can_read_but_not_write() {
    let policy = r#"
        // Admin can do everything
        permit(
            principal == SmolS3::User::"AKIAADMIN",
            action,
            resource
        );

        // Read-only user can only read
        permit(
            principal == SmolS3::User::"AKIAREADONLY",
            action in [
                SmolS3::Action::"s3:GetObject",
                SmolS3::Action::"s3:HeadObject",
                SmolS3::Action::"s3:ListBucket"
            ],
            resource
        );
    "#;
    let harness = harness_with_policy_multi_user(policy);

    let admin_creds = TestCredentials::new("AKIAADMIN", "adminkey");
    let readonly_creds = TestCredentials::new("AKIAREADONLY", "readonlykey");

    // Admin creates bucket and object
    harness
        .call(SignedRequest::create_bucket("test-bucket", admin_creds.clone()).build())
        .await;
    harness
        .call(
            SignedRequest::put_object("test-bucket", "file.txt", admin_creds.clone())
                .with_body(b"content")
                .build(),
        )
        .await;

    // Read-only user can read
    let resp = harness
        .call(SignedRequest::get_object("test-bucket", "file.txt", readonly_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Read-only user can head
    let resp = harness
        .call(SignedRequest::head_object("test-bucket", "file.txt", readonly_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Read-only user can list
    let resp = harness
        .call(SignedRequest::list_objects_v2("test-bucket", readonly_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Read-only user cannot write
    let resp = harness
        .call(
            SignedRequest::put_object("test-bucket", "new.txt", readonly_creds.clone())
                .with_body(b"new content")
                .build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    // Read-only user cannot delete
    let resp = harness
        .call(
            SignedRequest::delete_object("test-bucket", "file.txt", readonly_creds.clone()).build(),
        )
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// =============================================================================
// Resource hierarchy tests
// =============================================================================

#[tokio::test]
async fn bucket_scoped_access() {
    let policy = r#"
        // Admin can do everything
        permit(
            principal == SmolS3::User::"AKIAADMIN",
            action,
            resource
        );

        // Read-only user can only access "public" bucket
        permit(
            principal == SmolS3::User::"AKIAREADONLY",
            action in [
                SmolS3::Action::"s3:GetObject",
                SmolS3::Action::"s3:HeadObject",
                SmolS3::Action::"s3:ListBucket",
                SmolS3::Action::"s3:HeadBucket"
            ],
            resource in SmolS3::Bucket::"public"
        );
    "#;
    let harness = harness_with_policy_multi_user(policy);

    let admin_creds = TestCredentials::new("AKIAADMIN", "adminkey");
    let readonly_creds = TestCredentials::new("AKIAREADONLY", "readonlykey");

    // Admin creates buckets and objects
    harness
        .call(SignedRequest::create_bucket("public", admin_creds.clone()).build())
        .await;
    harness
        .call(SignedRequest::create_bucket("private", admin_creds.clone()).build())
        .await;
    harness
        .call(
            SignedRequest::put_object("public", "readme.txt", admin_creds.clone())
                .with_body(b"public content")
                .build(),
        )
        .await;
    harness
        .call(
            SignedRequest::put_object("private", "secret.txt", admin_creds.clone())
                .with_body(b"secret content")
                .build(),
        )
        .await;

    // Read-only user can access public bucket
    let resp = harness
        .call(SignedRequest::head_bucket("public", readonly_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    let resp = harness
        .call(SignedRequest::get_object("public", "readme.txt", readonly_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::OK);

    // Read-only user cannot access private bucket
    let resp = harness
        .call(SignedRequest::head_bucket("private", readonly_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);

    let resp = harness
        .call(SignedRequest::get_object("private", "secret.txt", readonly_creds.clone()).build())
        .await;
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

// =============================================================================
// Mixed authentication and authorization
// =============================================================================

#[tokio::test]
async fn anonymous_request_with_permit_all_succeeds() {
    // When using permit_all policy, even anonymous (unsigned) requests
    // are allowed because the policy permits SmolS3::User::"anonymous"
    let policy = r#"
        permit(principal, action, resource);
    "#;
    let (harness, _creds) = harness_with_policy(policy);

    // Unsigned request - will be treated as "anonymous" user
    let resp = harness
        .call(testing::S3Request::create_bucket("test-bucket").build())
        .await;
    // permit_all allows anonymous, so this succeeds
    assert_eq!(resp.status(), StatusCode::OK);
}

#[tokio::test]
async fn anonymous_request_denied_by_user_policy() {
    // When policy only permits specific users, anonymous requests are denied
    let policy = r#"
        permit(
            principal == SmolS3::User::"AKIAADMIN",
            action,
            resource
        );
    "#;
    let (harness, _creds) = harness_with_policy(policy);

    // Unsigned request - will be treated as "anonymous" user
    let resp = harness
        .call(testing::S3Request::create_bucket("test-bucket").build())
        .await;
    // Policy doesn't permit anonymous, so this is denied
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}

#[tokio::test]
async fn invalid_credentials_denied() {
    let policy = r#"
        permit(principal, action, resource);
    "#;
    let (harness, _creds) = harness_with_policy(policy);

    // Request with wrong credentials
    let wrong_creds = TestCredentials::new("AKIAADMIN", "wrongkey");
    let resp = harness
        .call(SignedRequest::create_bucket("test-bucket", wrong_creds).build())
        .await;
    // Signature mismatch returns 403
    assert_eq!(resp.status(), StatusCode::FORBIDDEN);
}
