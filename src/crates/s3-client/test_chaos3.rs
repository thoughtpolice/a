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
    PutObject, WriteCondition,
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
    let upload = client
        .create_multipart_upload(&key, &PutObject::default())
        .await
        .unwrap();
    let (first, second) = body.split_at(5 * 1024 * 1024);
    let e1 = client
        .upload_part(&key, &upload, 1, Bytes::copy_from_slice(first))
        .await
        .unwrap();
    let e2 = client
        .upload_part(&key, &upload, 2, Bytes::copy_from_slice(second))
        .await
        .unwrap();
    client
        .complete_multipart_upload(
            &key,
            &upload,
            vec![e1, e2],
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
