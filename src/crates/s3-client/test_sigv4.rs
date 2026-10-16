// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! SigV4 signing tests against externally-generated vectors.
//!
//! The expected signatures below were produced with AWS's own tooling (see
//! <https://docs.aws.amazon.com/general/latest/gr/sigv4-signed-request-examples.html>)
//! and match the vectors the upstream `object_store` AWS implementation
//! verifies itself against, so this implementation is checked against the
//! same ground truth.

use chrono::{DateTime, Utc};
use reqwest::Method;
use reqwest::header::AUTHORIZATION;

use crate::sigv4::{Credentials, EMPTY_SHA256, UNSIGNED_PAYLOAD, sha256_hex, sign_request_at};

fn test_credentials() -> Credentials {
    // well-known example credentials from the AWS documentation
    Credentials {
        access_key_id: "AKIAIOSFODNN7EXAMPLE".to_string(),
        secret_access_key: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY".to_string(),
        session_token: None,
    }
}

fn date(rfc3339: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(rfc3339)
        .expect("valid test date")
        .with_timezone(&Utc)
}

fn request(method: Method, url: &str) -> reqwest::Request {
    reqwest::Request::new(method, url.parse().expect("valid test URL"))
}

fn authorization(request: &reqwest::Request) -> &str {
    request
        .headers()
        .get(AUTHORIZATION)
        .expect("request was signed")
        .to_str()
        .expect("authorization header is ASCII")
}

#[test]
fn signed_empty_payload() {
    let credentials = test_credentials();
    let mut request = request(Method::GET, "https://ec2.amazon.com/");
    sign_request_at(
        &mut request,
        &credentials,
        "ec2",
        "us-east-1",
        EMPTY_SHA256,
        date("2022-08-06T18:01:34Z"),
    );

    assert_eq!(
        authorization(&request),
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20220806/us-east-1/ec2/aws4_request, \
         SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
         Signature=a3c787a7ed37f7fdfbfd2d7056a3d7c9d85e6d52a2bfbec73793c0be6e7862d4",
    );
}

#[test]
fn unsigned_payload() {
    let credentials = test_credentials();
    let mut request = request(Method::GET, "https://ec2.amazon.com/");
    sign_request_at(
        &mut request,
        &credentials,
        "ec2",
        "us-east-1",
        UNSIGNED_PAYLOAD,
        date("2022-08-06T18:01:34Z"),
    );

    assert_eq!(
        authorization(&request),
        "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20220806/us-east-1/ec2/aws4_request, \
         SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
         Signature=653c3d8ea261fd826207df58bc2bb69fbb5003e9eb3c0ef06e4a51f2a81d8699",
    );
}

#[test]
fn s3_with_port_and_query() {
    // S3-service signing: non-default port in the host header, sorted query
    // canonicalization, and single (not double) URI encoding of the path
    let credentials = Credentials {
        access_key_id: "H20ABqCkLZID4rLe".to_string(),
        secret_access_key: "jMqRDgxSsBqqznfmddGdu1TmmZOJQxdM".to_string(),
        session_token: None,
    };
    let mut request = request(
        Method::GET,
        "http://localhost:9000/tsm-schemas?delimiter=%2F&encoding-type=url&list-type=2&prefix=",
    );
    sign_request_at(
        &mut request,
        &credentials,
        "s3",
        "us-east-1",
        EMPTY_SHA256,
        date("2022-08-09T13:05:25Z"),
    );

    assert_eq!(
        authorization(&request),
        "AWS4-HMAC-SHA256 Credential=H20ABqCkLZID4rLe/20220809/us-east-1/s3/aws4_request, \
         SignedHeaders=host;x-amz-content-sha256;x-amz-date, \
         Signature=9ebf2f92872066c99ac94e573b4e1b80f4dbb8a32b1e8e23178318746e7d1b4d",
    );
}

#[test]
fn session_token_is_signed() {
    let credentials = Credentials {
        session_token: Some("token-value".to_string()),
        ..test_credentials()
    };
    let mut request = request(Method::GET, "https://example.com/key");
    sign_request_at(
        &mut request,
        &credentials,
        "s3",
        "us-east-1",
        EMPTY_SHA256,
        date("2022-08-06T18:01:34Z"),
    );

    assert_eq!(
        request.headers().get("x-amz-security-token").unwrap(),
        "token-value",
    );
    assert!(
        authorization(&request)
            .contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-security-token"),
        "session token header must participate in signing: {}",
        authorization(&request),
    );
}

#[test]
fn header_canonicalization() {
    // whitespace in header values collapses, and hop-by-hop/varying headers
    // (authorization, content-length, user-agent) stay out of the signature
    let credentials = test_credentials();
    let mut request = request(Method::GET, "https://example.com/");
    request
        .headers_mut()
        .insert("x-amz-meta-example", "  foo   bar  ".parse().unwrap());
    request
        .headers_mut()
        .insert("content-length", "1337".parse().unwrap());
    request
        .headers_mut()
        .insert("user-agent", "ignored/1.0".parse().unwrap());
    sign_request_at(
        &mut request,
        &credentials,
        "s3",
        "us-east-1",
        EMPTY_SHA256,
        date("2022-08-06T18:01:34Z"),
    );

    let authorization = authorization(&request);
    assert!(
        authorization
            .contains("SignedHeaders=host;x-amz-content-sha256;x-amz-date;x-amz-meta-example,"),
        "unexpected signed headers: {authorization}",
    );
}

#[test]
fn payload_hashing() {
    // pin the hex-SHA256 helper to an independently computed digest
    assert_eq!(sha256_hex(b""), EMPTY_SHA256);
    assert_eq!(
        sha256_hex(b"hello world"),
        "b94d27b9934d3e08a52e52d7da7dabfac484efe37a5380ee9088f7ace2efcde9",
    );
}
