// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Presigning, checked against AWS's published example, and the presigned
//! client's handling of requests before anything is sent.
//!
//! The example is from "Authenticating Requests: Using Query Parameters"
//! in the S3 API reference
//! (<https://docs.aws.amazon.com/AmazonS3/latest/API/sigv4-query-string-auth.html>),
//! which s3s's verifier also tests itself against.

use std::time::Duration;

use chrono::Utc;
use reqwest::Method;
use reqwest::header::HeaderMap;

use crate::test_sigv4::{date, test_credentials};
use crate::{
    Client, ClientBuilder, ErrorKind, GetObject, MAX_PRESIGNED_EXPIRY, ObjectAttributes,
    PresignedRequest, PutObject, WriteCondition,
};

/// A client for AWS's example bucket, addressed the way the example is.
fn example_client() -> ClientBuilder {
    let credentials = test_credentials();
    ClientBuilder::new()
        .with_bucket("examplebucket")
        .with_endpoint("https://s3.amazonaws.com")
        .with_virtual_hosted_style_request(true)
        .with_region("us-east-1")
        .with_credentials(credentials.access_key_id, credentials.secret_access_key)
}

fn presign_get(client: &Client, key: &str, expires_in: Duration) -> PresignedRequest {
    let url = client.object_url(key, &[]).unwrap();
    client
        .presign_at(
            Method::GET,
            url,
            HeaderMap::new(),
            expires_in,
            date("2013-05-24T00:00:00Z"),
        )
        .unwrap()
}

/// The value of query parameter `name` in `url`.
fn query_param(url: &str, name: &str) -> Option<String> {
    reqwest::Url::parse(url)
        .unwrap()
        .query_pairs()
        .find(|(key, _)| key == name)
        .map(|(_, value)| value.into_owned())
}

#[test]
fn the_aws_example_signs_to_the_published_url() {
    let client = example_client().build().unwrap();
    let request = presign_get(&client, "test.txt", Duration::from_secs(86_400));
    assert_eq!(request.method, "GET");
    assert_eq!(
        request.url,
        "https://examplebucket.s3.amazonaws.com/test.txt\
         ?X-Amz-Algorithm=AWS4-HMAC-SHA256\
         &X-Amz-Credential=AKIAIOSFODNN7EXAMPLE%2F20130524%2Fus-east-1%2Fs3%2Faws4_request\
         &X-Amz-Date=20130524T000000Z\
         &X-Amz-Expires=86400\
         &X-Amz-SignedHeaders=host\
         &X-Amz-Signature=aeeed9bbccd4d02ee5c0109b86d86835f995330da4c265957d157751f604d404",
    );
    assert!(request.headers.is_empty(), "{:?}", request.headers);
    assert_eq!(request.expires_at, date("2013-05-25T00:00:00Z"));
}

#[test]
fn a_session_token_is_signed_into_the_query() {
    let client = example_client()
        .with_session_token("token/value")
        .build()
        .unwrap();
    let request = presign_get(&client, "test.txt", Duration::from_secs(60));
    assert_eq!(
        query_param(&request.url, "X-Amz-Security-Token").as_deref(),
        Some("token/value"),
    );
    // The token comes before the signature, so the signature covers it.
    let token = request.url.find("X-Amz-Security-Token").unwrap();
    let signature = request.url.find("X-Amz-Signature").unwrap();
    assert!(token < signature, "{}", request.url);
    let plain = presign_get(
        &example_client().build().unwrap(),
        "test.txt",
        Duration::from_secs(60),
    );
    assert_ne!(
        query_param(&request.url, "X-Amz-Signature"),
        query_param(&plain.url, "X-Amz-Signature"),
    );
}

#[test]
fn a_put_signs_its_condition_attributes_and_tags() {
    let client = example_client().build().unwrap();
    let options = PutObject {
        condition: WriteCondition::Absent,
        attributes: ObjectAttributes {
            content_type: Some("application/octet-stream".into()),
            metadata: [("Pack".to_string(), "01J".to_string())].into(),
            ..Default::default()
        },
        tagging: Some("tier=cold".into()),
    };
    let request = client
        .presign_put_object("packs/0a/01J", &options, Duration::from_secs(3600))
        .unwrap();
    assert_eq!(request.method, "PUT");
    assert_eq!(
        query_param(&request.url, "X-Amz-SignedHeaders").as_deref(),
        Some("content-type;host;if-none-match;x-amz-meta-pack;x-amz-tagging"),
    );
    let mut headers = request.headers.clone();
    headers.sort();
    assert_eq!(
        headers,
        [
            ("content-type", "application/octet-stream"),
            ("if-none-match", "*"),
            ("x-amz-meta-pack", "01J"),
            ("x-amz-tagging", "tier=cold"),
        ]
        .map(|(name, value)| (name.to_string(), value.to_string())),
    );
}

#[test]
fn an_upload_part_signs_its_part_and_upload() {
    let client = example_client().build().unwrap();
    let request = client
        .presign_upload_part("big", "upload/id+1", 7, Duration::from_secs(3600))
        .unwrap();
    assert_eq!(request.method, "PUT");
    assert_eq!(
        query_param(&request.url, "partNumber").as_deref(),
        Some("7")
    );
    assert_eq!(
        query_param(&request.url, "uploadId").as_deref(),
        Some("upload/id+1"),
    );
    // Encoded the way the signature canonicalizes it, so a server decodes
    // exactly what was signed.
    assert!(
        request.url.contains("uploadId=upload%2Fid%2B1"),
        "{}",
        request.url
    );
}

#[test]
fn expiry_must_be_between_a_second_and_seven_days() {
    let client = example_client().build().unwrap();
    for expires_in in [Duration::ZERO, Duration::from_millis(999)] {
        let error = client.presign_get_object("k", expires_in).unwrap_err();
        assert_eq!(error.kind(), ErrorKind::Other, "{error}");
    }
    let too_long = MAX_PRESIGNED_EXPIRY + Duration::from_secs(1);
    assert!(client.presign_get_object("k", too_long).is_err());
    let longest = client
        .presign_get_object("k", MAX_PRESIGNED_EXPIRY)
        .unwrap();
    assert_eq!(
        query_param(&longest.url, "X-Amz-Expires").as_deref(),
        Some("604800")
    );
}

#[test]
fn presigning_takes_credentials() {
    let client = ClientBuilder::new()
        .with_bucket("examplebucket")
        .with_skip_signature(true)
        .build()
        .unwrap();
    let error = client
        .presign_get_object("k", Duration::from_secs(60))
        .unwrap_err();
    assert!(error.to_string().contains("credentials"), "{error}");
}

#[test]
fn debug_output_leaves_out_the_signature() {
    let client = example_client().build().unwrap();
    let request = presign_get(&client, "test.txt", Duration::from_secs(86_400));
    let debug = format!("{request:?}");
    assert!(!debug.contains("aeeed9bb"), "{debug}");
    assert!(!debug.contains("X-Amz-Credential"), "{debug}");
    assert!(
        debug.contains("https://examplebucket.s3.amazonaws.com/test.txt?<redacted>"),
        "{debug}"
    );
}

#[tokio::test]
async fn a_request_is_only_sent_as_the_operation_it_was_signed_for() {
    let client = example_client().build().unwrap();
    let get = presign_get(&client, "test.txt", Duration::from_secs(60));
    let holder = ClientBuilder::new().build_presigned().unwrap();
    let error = holder.put_object(&get, "x".into()).await.unwrap_err();
    assert!(error.to_string().contains("is for GET, not PUT"), "{error}");
    let versioned = GetObject {
        version: Some("v1".into()),
        ..Default::default()
    };
    let error = holder.get_object(&get, &versioned).await.unwrap_err();
    assert!(error.to_string().contains("version"), "{error}");
}

#[tokio::test]
async fn errors_leave_out_the_signature() {
    // Nothing listens on port 1, so the connection is refused at once.
    let request = PresignedRequest {
        method: "GET".into(),
        url: "http://127.0.0.1:1/bucket/key?X-Amz-Signature=secret".into(),
        headers: Vec::new(),
        expires_at: Utc::now(),
    };
    let holder = ClientBuilder::new()
        .with_max_attempts(1)
        .build_presigned()
        .unwrap();
    let error = holder
        .get_object(&request, &GetObject::default())
        .await
        .unwrap_err();
    let message = format!("{error} {error:?}");
    assert!(!message.contains("secret"), "{message}");
    assert!(message.contains("127.0.0.1:1/bucket/key"), "{message}");
}
