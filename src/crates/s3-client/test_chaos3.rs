// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The client against chaos3, a separate S3-compatible server process.
//!
//! Buck starts one chaos3 server per scenario and hands its endpoint and
//! credentials to the test through the environment. Fault budgets belong
//! to a server, so a scenario with faults holds exactly one test.
//! `s3-store` runs the broader object suite through this client; these
//! tests cover the client's own API.

// Each scenario compiles only its own tests, leaving some helpers unused;
// the healthy scenario uses them all, so it keeps the lints.
#![cfg_attr(not(chaos3_scenario = "healthy"), allow(dead_code, unused_imports))]

use bytes::Bytes;
use futures::TryStreamExt as _;

use crate::{
    ByteRange, Client, ClientBuilder, ErrorKind, GetObject, ListObjects, ObjectAttributes,
    PresignedClient, PresignedRequest, PutObject, WriteCondition,
};

fn chaos3_client() -> Client {
    let var = |name: &str| {
        std::env::var(name).unwrap_or_else(|_| {
            panic!("{name} is unset: run this through `buck2 test`, which starts chaos3")
        })
    };
    ClientBuilder::from_env()
        .with_endpoint(var("CHAOS3_ENDPOINT"))
        .with_bucket(var("CHAOS3_BUCKET"))
        .with_allow_http(true)
        .build()
        .expect("chaos3 client configuration is valid")
}

/// A client with no credentials, for requests `chaos3_client` presigned.
fn holder() -> PresignedClient {
    ClientBuilder::new()
        .build_presigned()
        .expect("presigned client configuration is valid")
}

/// How long the presigned requests in these tests stay valid.
const HOUR: std::time::Duration = std::time::Duration::from_secs(3600);

/// A key prefix no other test, or earlier attempt of this one, has used.
fn prefix(test: &str) -> String {
    format!("{test}-{}", std::process::id())
}

fn conditional(condition: WriteCondition) -> PutObject {
    PutObject {
        condition,
        ..Default::default()
    }
}

fn pattern(len: usize) -> Bytes {
    (0..len).map(|i| (i % 251) as u8).collect::<Vec<_>>().into()
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn compare_and_set_lets_exactly_one_writer_win() {
    let client = chaos3_client();
    let key = format!("{}/state.json", prefix("cas"));

    let created = client
        .put_object(&key, "v1".into(), &conditional(WriteCondition::Absent))
        .await
        .unwrap();
    let again = client
        .put_object(
            &key,
            "v1-again".into(),
            &conditional(WriteCondition::Absent),
        )
        .await
        .unwrap_err();
    assert_eq!(again.kind(), ErrorKind::PreconditionFailed, "{again}");

    let e_tag = created.e_tag.expect("PutObject reports an ETag");
    let first = conditional(WriteCondition::Matches(e_tag.clone()));
    client.put_object(&key, "v2".into(), &first).await.unwrap();
    let stale = client
        .put_object(&key, "v3".into(), &first)
        .await
        .unwrap_err();
    assert_eq!(stale.kind(), ErrorKind::PreconditionFailed, "{stale}");

    let current = client
        .get_object(&key, &GetObject::default())
        .await
        .unwrap();
    assert_ne!(current.info.e_tag.as_deref(), Some(e_tag.as_str()));
    assert_eq!(current.bytes().await.unwrap(), "v2");

    let unchanged = GetObject {
        if_none_match: client
            .head_object(&key, &GetObject::default())
            .await
            .unwrap()
            .info
            .e_tag,
        ..Default::default()
    };
    let not_modified = client.get_object(&key, &unchanged).await.unwrap_err();
    assert_eq!(
        not_modified.kind(),
        ErrorKind::NotModified,
        "{not_modified}"
    );
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn if_match_on_a_deleted_object_is_a_precondition_failure() {
    let client = chaos3_client();
    let key = format!("{}/gone", prefix("deleted"));
    let put = client
        .put_object(&key, "x".into(), &PutObject::default())
        .await
        .unwrap();
    client.delete_object(&key).await.unwrap();
    let options = conditional(WriteCondition::Matches(put.e_tag.unwrap()));
    let error = client
        .put_object(&key, "y".into(), &options)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::PreconditionFailed, "{error}");
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn ranges_attributes_and_metadata_round_trip() {
    let client = chaos3_client();
    let key = format!("{}/object", prefix("attrs"));
    let body = pattern(10_000);
    let options = PutObject {
        attributes: ObjectAttributes {
            content_type: Some("application/x-test".into()),
            metadata: [("Owner".to_string(), "queue".to_string())].into(),
            ..Default::default()
        },
        ..Default::default()
    };
    client
        .put_object(&key, body.clone(), &options)
        .await
        .unwrap();

    let read = GetObject {
        range: Some(ByteRange::Suffix(100)),
        ..Default::default()
    };
    let tail = client.get_object(&key, &read).await.unwrap();
    assert_eq!(tail.info.size, 10_000);
    assert_eq!(tail.range, 9_900..10_000);
    assert_eq!(
        tail.attributes.content_type.as_deref(),
        Some("application/x-test")
    );
    assert_eq!(
        tail.attributes.metadata.get("owner").map(String::as_str),
        Some("queue"),
    );
    assert_eq!(tail.bytes().await.unwrap(), body.slice(9_900..));
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn listings_page_through_every_key() {
    let client = chaos3_client();
    let prefix = prefix("list");
    // chaos3 caps pages at 1000 keys, like S3.
    let keys: Vec<String> = (0..1_005).map(|i| format!("{prefix}/k{i:05}")).collect();
    futures::stream::iter(keys.iter().map(Ok))
        .try_for_each_concurrent(32, |key| {
            let client = client.clone();
            async move {
                client
                    .put_object(key, Bytes::new(), &PutObject::default())
                    .await
                    .map(|_| ())
            }
        })
        .await
        .unwrap();
    client
        .put_object(
            &format!("{prefix}/dir/nested"),
            Bytes::new(),
            &PutObject::default(),
        )
        .await
        .unwrap();

    let pages: Vec<_> = client
        .list_pages(ListObjects {
            prefix: Some(format!("{prefix}/")),
            delimiter: true,
            ..Default::default()
        })
        .try_collect()
        .await
        .unwrap();
    assert!(pages.len() >= 2, "{} pages", pages.len());
    let listed: Vec<String> = pages
        .iter()
        .flat_map(|page| page.objects.iter().map(|o| o.key.clone()))
        .collect();
    assert_eq!(listed, keys);
    let prefixes: Vec<&String> = pages.iter().flat_map(|p| &p.common_prefixes).collect();
    assert_eq!(prefixes, [&format!("{prefix}/dir/")]);
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn multipart_uploads_complete_in_part_order() {
    let client = chaos3_client();
    let key = format!("{}/multi", prefix("multipart"));
    let body = pattern(5 * 1024 * 1024 + 17);
    let (upload, e_tags) = upload_two_parts(&client, &key, &body, &Default::default()).await;
    client
        .complete_multipart_upload(
            &key,
            &upload,
            e_tags,
            body.len() as u64,
            &Default::default(),
        )
        .await
        .unwrap();
    let read = client
        .get_object(&key, &GetObject::default())
        .await
        .unwrap();
    assert_eq!(read.bytes().await.unwrap(), body);
}

/// Upload `body` as a two-part multipart upload of `key` created with
/// `attributes`, returning the upload ID and the part ETags, ready to
/// complete.
async fn upload_two_parts(
    client: &Client,
    key: &str,
    body: &Bytes,
    attributes: &ObjectAttributes,
) -> (String, Vec<String>) {
    let options = PutObject {
        attributes: attributes.clone(),
        ..Default::default()
    };
    let upload = client.create_multipart_upload(key, &options).await.unwrap();
    let (first, second) = body.split_at(5 * 1024 * 1024);
    let mut e_tags = Vec::new();
    for (number, part) in [first, second].into_iter().enumerate() {
        e_tags.push(
            client
                .upload_part(key, &upload, number + 1, Bytes::copy_from_slice(part))
                .await
                .unwrap(),
        );
    }
    (upload, e_tags)
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn a_conditional_completion_creates_but_never_replaces() {
    let client = chaos3_client();
    let key = format!("{}/multi", prefix("multipart-absent"));
    let body = pattern(5 * 1024 * 1024 + 17);
    let absent = WriteCondition::Absent;
    let none = ObjectAttributes::default();

    let (upload, e_tags) = upload_two_parts(&client, &key, &body, &none).await;
    let size = body.len() as u64;
    client
        .complete_multipart_upload_if(&key, &upload, e_tags, size, &none, &absent)
        .await
        .expect("nothing is in the way of the first completion");

    // A second upload of the same key fails its condition, leaving the
    // object as it was and the upload in place to abort.
    let other = pattern(5 * 1024 * 1024 + 99).slice(3..);
    let (upload, e_tags) = upload_two_parts(&client, &key, &other, &none).await;
    let size = other.len() as u64;
    let error = client
        .complete_multipart_upload_if(&key, &upload, e_tags, size, &none, &absent)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::PreconditionFailed, "{error}");
    client.abort_multipart_upload(&key, &upload).await.unwrap();
    let read = client
        .get_object(&key, &GetObject::default())
        .await
        .unwrap();
    assert_eq!(read.bytes().await.unwrap(), body);
}

// The server answers 500 after committing the first multipart completion.
// The retry finds its upload consumed and recognizes the object by its
// size and the upload's metadata, even though the completion was
// conditional.
#[cfg(chaos3_scenario = "complete_after_commit")]
#[tokio::test]
async fn a_conditional_completion_recognizes_its_own_committed_attempt() {
    let client = chaos3_client();
    let key = format!("{}/multi", prefix("multipart-ambiguous"));
    let body = pattern(5 * 1024 * 1024 + 17);
    let size = body.len() as u64;
    let absent = WriteCondition::Absent;
    let tagged = |token: &str| ObjectAttributes {
        metadata: [("upload".to_string(), token.to_string())].into(),
        ..Default::default()
    };

    let first = tagged("token-1");
    let (upload, e_tags) = upload_two_parts(&client, &key, &body, &first).await;
    client
        .complete_multipart_upload_if(&key, &upload, e_tags, size, &first, &absent)
        .await
        .expect("the retry finds the committed completion");
    let read = client
        .get_object(&key, &GetObject::default())
        .await
        .unwrap();
    assert_eq!(read.bytes().await.unwrap(), body);

    // Without a replay, an object in the way is another's: a second upload
    // of the same bytes and size is refused.
    let second = tagged("token-2");
    let (upload, e_tags) = upload_two_parts(&client, &key, &body, &second).await;
    let error = client
        .complete_multipart_upload_if(&key, &upload, e_tags, size, &second, &absent)
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::PreconditionFailed, "{error}");
}

// The server answers 500 after committing the first two PutObjects. The
// client's retry of a conditional create then finds its own write.
#[cfg(chaos3_scenario = "put_after_commit")]
#[tokio::test]
async fn a_conditional_write_recognizes_its_own_committed_attempt() {
    let client = chaos3_client();
    let key = format!("{}/state.json", prefix("ambiguous"));
    let created = client
        .put_object(&key, "v1".into(), &conditional(WriteCondition::Absent))
        .await
        .expect("the retry finds the committed create");
    let options = conditional(WriteCondition::Matches(created.e_tag.unwrap()));
    client
        .put_object(&key, "v2".into(), &options)
        .await
        .expect("the retry finds the committed update");
    let read = client
        .get_object(&key, &GetObject::default())
        .await
        .unwrap();
    assert_eq!(read.bytes().await.unwrap(), "v2");
}

// The first GetObject body ends after one 4 KiB chunk.
#[cfg(chaos3_scenario = "body_truncated")]
#[tokio::test]
async fn a_truncated_body_resumes_from_where_it_stopped() {
    let client = chaos3_client();
    let key = format!("{}/big", prefix("resume"));
    let body = pattern(64 * 1024);
    client
        .put_object(&key, body.clone(), &PutObject::default())
        .await
        .unwrap();
    let read = client
        .get_object(&key, &GetObject::default())
        .await
        .unwrap();
    assert_eq!(read.bytes().await.unwrap(), body);
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn a_holder_without_credentials_puts_and_reads_ranges_through_presigned_requests() {
    let client = chaos3_client();
    let holder = holder();
    let key = format!("{}/packs/0a/pack", prefix("presigned"));
    let body = pattern(100_000);

    let create = PutObject {
        condition: WriteCondition::Absent,
        attributes: ObjectAttributes {
            content_type: Some("application/x-pack".into()),
            ..Default::default()
        },
        ..Default::default()
    };
    let put = client.presign_put_object(&key, &create, HOUR).unwrap();
    let written = holder.put_object(&put, body.clone()).await.unwrap();
    assert!(written.e_tag.is_some());

    // The signed `If-None-Match: *` makes the URL good only for creating.
    let again = holder.put_object(&put, pattern(10)).await.unwrap_err();
    assert_eq!(again.kind(), ErrorKind::PreconditionFailed, "{again}");

    let get = client.presign_get_object(&key, HOUR).unwrap();
    for range in [
        ByteRange::Bounded(4_096..8_192),
        ByteRange::Offset(99_000),
        ByteRange::Suffix(10),
    ] {
        let read = GetObject {
            range: Some(range.clone()),
            ..Default::default()
        };
        let output = holder.get_object(&get, &read).await.unwrap();
        let expected = range.resolve(body.len() as u64).unwrap();
        assert_eq!(output.range, expected);
        assert_eq!(output.info.size, body.len() as u64);
        assert_eq!(
            output.attributes.content_type.as_deref(),
            Some("application/x-pack")
        );
        let start = expected.start as usize;
        let end = expected.end as usize;
        assert_eq!(output.bytes().await.unwrap(), body.slice(start..end));
    }
    let whole = holder
        .get_object(&get, &GetObject::default())
        .await
        .unwrap();
    assert_eq!(whole.bytes().await.unwrap(), body);

    // Conditions the holder adds are its own to choose.
    let unchanged = GetObject {
        if_none_match: written.e_tag.clone(),
        ..Default::default()
    };
    let error = holder.get_object(&get, &unchanged).await.unwrap_err();
    assert_eq!(error.kind(), ErrorKind::NotModified, "{error}");
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn the_server_refuses_presigned_requests_that_were_altered_or_expired() {
    let client = chaos3_client();
    let holder = holder();
    let key = format!("{}/object", prefix("refused"));
    client
        .put_object(&key, pattern(64), &PutObject::default())
        .await
        .unwrap();
    let get = client.presign_get_object(&key, HOUR).unwrap();

    let other_key = PresignedRequest {
        url: get.url.replace("/object?", "/other?"),
        ..get.clone()
    };
    let error = holder
        .get_object(&other_key, &GetObject::default())
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::PermissionDenied, "{error}");
    assert!(!error.to_string().contains("X-Amz-Signature"), "{error}");

    // A GET's signature does not cover a PUT, even if the holder relabels it.
    let relabeled = PresignedRequest {
        method: "PUT".into(),
        ..get.clone()
    };
    let error = holder.put_object(&relabeled, pattern(8)).await.unwrap_err();
    assert_eq!(error.kind(), ErrorKind::PermissionDenied, "{error}");

    // A signed header must be sent as signed.
    let create = PutObject {
        condition: WriteCondition::Absent,
        ..Default::default()
    };
    let put = client
        .presign_put_object(&format!("{key}-new"), &create, HOUR)
        .unwrap();
    let unconditional = PresignedRequest {
        headers: Vec::new(),
        ..put
    };
    let error = holder
        .put_object(&unconditional, pattern(8))
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::PermissionDenied, "{error}");

    let short = client
        .presign_get_object(&key, std::time::Duration::from_secs(1))
        .unwrap();
    tokio::time::sleep(std::time::Duration::from_millis(2_100)).await;
    let error = holder
        .get_object(&short, &GetObject::default())
        .await
        .unwrap_err();
    assert_eq!(error.kind(), ErrorKind::PermissionDenied, "{error}");
}

#[cfg(chaos3_scenario = "healthy")]
#[tokio::test]
async fn a_holder_uploads_the_parts_of_a_multipart_upload_the_signer_runs() {
    let client = chaos3_client();
    let holder = holder();
    let key = format!("{}/multi", prefix("presigned-multipart"));
    let body = pattern(5 * 1024 * 1024 + 17);
    let upload = client
        .create_multipart_upload(&key, &PutObject::default())
        .await
        .unwrap();
    let mut e_tags = Vec::new();
    for (index, part) in body.chunks(5 * 1024 * 1024).enumerate() {
        let request = client
            .presign_upload_part(&key, &upload, index + 1, HOUR)
            .unwrap();
        let e_tag = holder
            .upload_part(&request, Bytes::copy_from_slice(part))
            .await
            .unwrap();
        e_tags.push(e_tag);
    }
    assert_eq!(e_tags.len(), 2);
    client
        .complete_multipart_upload(
            &key,
            &upload,
            e_tags,
            body.len() as u64,
            &Default::default(),
        )
        .await
        .unwrap();
    let read = client
        .get_object(&key, &GetObject::default())
        .await
        .unwrap();
    assert_eq!(read.bytes().await.unwrap(), body);
}

// The first GetObject body ends after one 4 KiB chunk.
#[cfg(chaos3_scenario = "presigned_body_truncated")]
#[tokio::test]
async fn a_truncated_presigned_body_resumes_from_where_it_stopped() {
    let client = chaos3_client();
    let key = format!("{}/big", prefix("presigned-resume"));
    let body = pattern(64 * 1024);
    client
        .put_object(&key, body.clone(), &PutObject::default())
        .await
        .unwrap();
    let get = client.presign_get_object(&key, HOUR).unwrap();
    let read = GetObject {
        range: Some(ByteRange::Offset(1_000)),
        ..Default::default()
    };
    let output = holder().get_object(&get, &read).await.unwrap();
    assert_eq!(output.bytes().await.unwrap(), body.slice(1_000..));
}
