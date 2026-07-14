// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! End-to-end [`ObjectStore`] behavior tests against the in-memory s3s
//! server, which independently verifies every request's SigV4 signature.

use bytes::Bytes;
use futures::{StreamExt as _, TryStreamExt as _};
use object_store::path::Path;
use object_store::{
    Attribute, Attributes, GetOptions, GetRange, ObjectStore, ObjectStoreExt as _, PutMode,
    PutOptions, PutPayload,
};

use crate::S3StoreBuilder;
use crate::test_server::{TEST_ACCESS_KEY, TEST_BUCKET, TestServer};

/// Deterministic patterned payload, distinguishable across sizes/offsets.
fn pattern(len: usize) -> Bytes {
    (0..len).map(|i| (i % 251) as u8).collect::<Vec<_>>().into()
}

async fn collect_locations(
    stream: futures::stream::BoxStream<'static, object_store::Result<object_store::ObjectMeta>>,
) -> Vec<String> {
    let metas: Vec<_> = stream.try_collect().await.expect("listing succeeds");
    metas.into_iter().map(|m| m.location.to_string()).collect()
}

#[tokio::test]
async fn put_get_roundtrip() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("dir/data.bin");
    let body = pattern(65_537);

    let put = store.put(&location, body.clone().into()).await.unwrap();
    assert!(put.e_tag.is_some(), "put must report an etag");

    let result = store.get(&location).await.unwrap();
    assert_eq!(result.meta.size, body.len() as u64);
    assert_eq!(result.meta.location, location);
    assert_eq!(result.meta.e_tag, put.e_tag);
    assert_eq!(result.range, 0..body.len() as u64);
    assert!(
        result.meta.last_modified.timestamp() > 0,
        "last_modified should be a real timestamp",
    );
    assert_eq!(result.bytes().await.unwrap(), body);
}

#[tokio::test]
async fn get_streams_in_chunks() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("big.bin");
    let body = pattern(4 * 1024 * 1024);

    store.put(&location, body.clone().into()).await.unwrap();
    let chunks: Vec<Bytes> = store
        .get(&location)
        .await
        .unwrap()
        .into_stream()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(chunks.concat(), body);
}

#[tokio::test]
async fn empty_object() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("empty");

    store.put(&location, PutPayload::new()).await.unwrap();
    let result = store.get(&location).await.unwrap();
    assert_eq!(result.meta.size, 0);
    assert_eq!(result.bytes().await.unwrap(), Bytes::new());
}

#[tokio::test]
async fn get_missing_is_not_found() {
    let server = TestServer::spawn().await;
    let store = server.store();

    let error = store.get(&Path::from("nope")).await.unwrap_err();
    assert!(
        matches!(error, object_store::Error::NotFound { .. }),
        "unexpected error: {error:?}",
    );
    let error = store.head(&Path::from("nope")).await.unwrap_err();
    assert!(
        matches!(error, object_store::Error::NotFound { .. }),
        "unexpected error: {error:?}",
    );
}

#[tokio::test]
async fn head_returns_metadata_without_body() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("meta.bin");
    let body = pattern(1234);

    let put = store.put(&location, body.into()).await.unwrap();
    let meta = store.head(&location).await.unwrap();
    assert_eq!(meta.size, 1234);
    assert_eq!(meta.e_tag, put.e_tag);
    assert_eq!(meta.location, location);
}

#[tokio::test]
async fn get_ranges() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("ranged.bin");
    let body = pattern(10_000);
    store.put(&location, body.clone().into()).await.unwrap();

    // bounded
    let bytes = store.get_range(&location, 100..300).await.unwrap();
    assert_eq!(bytes, body.slice(100..300));

    // bounded range extending past the end is clamped
    let result = store
        .get_opts(
            &location,
            GetOptions::new().with_range(Some(GetRange::Bounded(9_000..20_000))),
        )
        .await
        .unwrap();
    assert_eq!(result.range, 9_000..10_000);
    assert_eq!(
        result.meta.size, 10_000,
        "meta.size must be the full object size"
    );
    assert_eq!(result.bytes().await.unwrap(), body.slice(9_000..10_000));

    // offset
    let result = store
        .get_opts(
            &location,
            GetOptions::new().with_range(Some(GetRange::Offset(9_900))),
        )
        .await
        .unwrap();
    assert_eq!(result.bytes().await.unwrap(), body.slice(9_900..10_000));

    // suffix
    let result = store
        .get_opts(
            &location,
            GetOptions::new().with_range(Some(GetRange::Suffix(64))),
        )
        .await
        .unwrap();
    assert_eq!(
        result.bytes().await.unwrap(),
        body.slice(10_000 - 64..10_000)
    );

    // coalesced multi-range
    let ranges = store
        .get_ranges(&location, &[0..10, 20..30, 5_000..5_010])
        .await
        .unwrap();
    assert_eq!(ranges[0], body.slice(0..10));
    assert_eq!(ranges[1], body.slice(20..30));
    assert_eq!(ranges[2], body.slice(5_000..5_010));

    // invalid and unsatisfiable ranges are errors
    store
        .get_opts(
            &location,
            GetOptions::new().with_range(Some(GetRange::Bounded(300..100))),
        )
        .await
        .unwrap_err();
    store
        .get_opts(
            &location,
            GetOptions::new().with_range(Some(GetRange::Bounded(50_000..50_010))),
        )
        .await
        .unwrap_err();
}

#[tokio::test]
async fn conditional_get() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("cond.bin");
    let put = store.put(&location, pattern(64).into()).await.unwrap();
    let e_tag = put.e_tag.unwrap();

    // if-match with the right etag succeeds
    store
        .get_opts(
            &location,
            GetOptions::new().with_if_match(Some(e_tag.clone())),
        )
        .await
        .unwrap();

    // if-match with the wrong etag fails the precondition
    let error = store
        .get_opts(
            &location,
            GetOptions::new().with_if_match(Some("\"bogus\"")),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::Precondition { .. }),
        "unexpected error: {error:?}",
    );

    // if-none-match with the current etag reports not-modified
    let error = store
        .get_opts(
            &location,
            GetOptions::new().with_if_none_match(Some(e_tag.clone())),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::NotModified { .. }),
        "unexpected error: {error:?}",
    );

    // head requests take the same conditional path
    let meta = store
        .get_opts(
            &location,
            GetOptions::new().with_if_match(Some(e_tag)).with_head(true),
        )
        .await
        .unwrap()
        .meta;
    assert_eq!(meta.size, 64);
}

#[tokio::test]
async fn conditional_get_by_date() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("dated.bin");
    store.put(&location, pattern(8).into()).await.unwrap();

    let long_ago = chrono::DateTime::parse_from_rfc3339("2001-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);
    let far_future = chrono::DateTime::parse_from_rfc3339("2100-01-01T00:00:00Z")
        .unwrap()
        .with_timezone(&chrono::Utc);

    // modified since 2001 -> yes
    store
        .get_opts(
            &location,
            GetOptions::new().with_if_modified_since(Some(long_ago)),
        )
        .await
        .unwrap();
    // modified since 2100 -> not modified
    let error = store
        .get_opts(
            &location,
            GetOptions::new().with_if_modified_since(Some(far_future)),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::NotModified { .. }),
        "unexpected error: {error:?}",
    );
    // unmodified since 2100 -> yes
    store
        .get_opts(
            &location,
            GetOptions::new().with_if_unmodified_since(Some(far_future)),
        )
        .await
        .unwrap();
    // unmodified since 2001 -> precondition failed
    let error = store
        .get_opts(
            &location,
            GetOptions::new().with_if_unmodified_since(Some(long_ago)),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::Precondition { .. }),
        "unexpected error: {error:?}",
    );
}

#[tokio::test]
async fn put_mode_create() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("create-once");

    let opts = PutOptions::from(PutMode::Create);
    store
        .put_opts(&location, pattern(10).into(), opts.clone())
        .await
        .unwrap();

    // a second create must fail
    let error = store
        .put_opts(&location, pattern(20).into(), opts.clone())
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::AlreadyExists { .. }),
        "unexpected error: {error:?}",
    );
    // and must not have clobbered the object
    assert_eq!(store.get(&location).await.unwrap().meta.size, 10);

    // deleting makes create possible again
    store.delete(&location).await.unwrap();
    store
        .put_opts(&location, pattern(30).into(), opts)
        .await
        .unwrap();
    assert_eq!(store.get(&location).await.unwrap().meta.size, 30);
}

#[tokio::test]
async fn put_mode_update() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("cas-object");

    let v1 = store.put(&location, pattern(10).into()).await.unwrap();

    // update conditioned on the current version succeeds
    let v2 = store
        .put_opts(
            &location,
            pattern(20).into(),
            PutOptions::from(PutMode::Update(v1.clone().into())),
        )
        .await
        .unwrap();
    assert_ne!(v1.e_tag, v2.e_tag);

    // update conditioned on the stale version fails
    let error = store
        .put_opts(
            &location,
            pattern(30).into(),
            PutOptions::from(PutMode::Update(v1.into())),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::Precondition { .. }),
        "unexpected error: {error:?}",
    );
    assert_eq!(store.get(&location).await.unwrap().meta.size, 20);

    // update of a missing object is a precondition failure too
    store.delete(&location).await.unwrap();
    let stale = object_store::UpdateVersion {
        e_tag: Some("\"gone\"".to_string()),
        version: None,
    };
    let error = store
        .put_opts(
            &location,
            pattern(1).into(),
            PutOptions::from(PutMode::Update(stale)),
        )
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::Precondition { .. }),
        "unexpected error: {error:?}",
    );
}

#[tokio::test]
async fn attributes_roundtrip() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("attrs.bin");

    let mut attributes = Attributes::new();
    attributes.insert(Attribute::ContentType, "application/octet-stream".into());
    attributes.insert(Attribute::Metadata("purpose".into()), "testing".into());

    let opts = PutOptions {
        attributes,
        ..Default::default()
    };
    store
        .put_opts(&location, pattern(4).into(), opts)
        .await
        .unwrap();

    let result = store.get(&location).await.unwrap();
    assert_eq!(
        result
            .attributes
            .get(&Attribute::ContentType)
            .map(|v| v.as_ref()),
        Some("application/octet-stream"),
    );
    assert_eq!(
        result
            .attributes
            .get(&Attribute::Metadata("purpose".into()))
            .map(|v| v.as_ref()),
        Some("testing"),
    );
}

#[tokio::test]
async fn delete_semantics() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("doomed");

    store.put(&location, pattern(1).into()).await.unwrap();
    store.delete(&location).await.unwrap();
    assert!(matches!(
        store.get(&location).await.unwrap_err(),
        object_store::Error::NotFound { .. },
    ));

    // S3 deletes are idempotent
    store.delete(&location).await.unwrap();
}

#[tokio::test]
async fn delete_stream_bulk() {
    let server = TestServer::spawn().await;
    let store = server.store();

    let paths: Vec<Path> = (0..25)
        .map(|i| Path::from(format!("bulk/{i:02}")))
        .collect();
    for path in &paths {
        store.put(path, pattern(8).into()).await.unwrap();
    }

    let stream = futures::stream::iter(paths.clone().into_iter().map(Ok)).boxed();
    let mut deleted: Vec<String> = store
        .delete_stream(stream)
        .try_collect::<Vec<_>>()
        .await
        .unwrap()
        .into_iter()
        .map(|p| p.to_string())
        .collect();
    deleted.sort();
    let mut expected: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
    expected.sort();
    assert_eq!(deleted, expected);

    let remaining = collect_locations(store.list(Some(&Path::from("bulk")))).await;
    assert!(
        remaining.is_empty(),
        "everything should be deleted: {remaining:?}"
    );
}

#[tokio::test]
async fn list_paginated() {
    // a page limit of 3 forces continuation-token handling with few keys
    let server = TestServer::spawn_with_page_limit(3).await;
    let store = server.store();

    let mut expected = Vec::new();
    for i in 0..10 {
        let path = Path::from(format!("data/{i:02}.bin"));
        store.put(&path, pattern(i).into()).await.unwrap();
        expected.push(path.to_string());
    }
    // a key outside the prefix must not appear
    store
        .put(&Path::from("other/x"), pattern(1).into())
        .await
        .unwrap();

    let listed = collect_locations(store.list(Some(&Path::from("data")))).await;
    assert_eq!(
        listed, expected,
        "expected complete listing in lexicographic order"
    );

    // prefixes match whole path segments, not string prefixes
    store
        .put(&Path::from("data-adjacent"), pattern(1).into())
        .await
        .unwrap();
    let listed = collect_locations(store.list(Some(&Path::from("data")))).await;
    assert_eq!(listed, expected, "data-adjacent must not match prefix data");

    // full listing sees everything
    let all = collect_locations(store.list(None)).await;
    assert_eq!(all.len(), 12);
}

#[tokio::test]
async fn list_with_offset() {
    let server = TestServer::spawn_with_page_limit(2).await;
    let store = server.store();

    for i in 0..6 {
        store
            .put(&Path::from(format!("off/{i}")), pattern(1).into())
            .await
            .unwrap();
    }

    let listed =
        collect_locations(store.list_with_offset(Some(&Path::from("off")), &Path::from("off/2")))
            .await;
    assert_eq!(listed, ["off/3", "off/4", "off/5"], "offset is exclusive");
}

#[tokio::test]
async fn list_with_delimiter() {
    let server = TestServer::spawn_with_page_limit(2).await;
    let store = server.store();

    for key in [
        "root.txt",
        "a/1.txt",
        "a/2.txt",
        "a/sub/3.txt",
        "b/4.txt",
        "c.txt",
    ] {
        store
            .put(&Path::from(key), pattern(3).into())
            .await
            .unwrap();
    }

    // at the root
    let result = store.list_with_delimiter(None).await.unwrap();
    let prefixes: Vec<String> = result
        .common_prefixes
        .iter()
        .map(|p| p.to_string())
        .collect();
    let objects: Vec<String> = result
        .objects
        .iter()
        .map(|o| o.location.to_string())
        .collect();
    assert_eq!(prefixes, ["a", "b"]);
    assert_eq!(objects, ["c.txt", "root.txt"]);

    // under a prefix
    let result = store
        .list_with_delimiter(Some(&Path::from("a")))
        .await
        .unwrap();
    let prefixes: Vec<String> = result
        .common_prefixes
        .iter()
        .map(|p| p.to_string())
        .collect();
    let objects: Vec<String> = result
        .objects
        .iter()
        .map(|o| o.location.to_string())
        .collect();
    assert_eq!(prefixes, ["a/sub"]);
    assert_eq!(objects, ["a/1.txt", "a/2.txt"]);
}

#[tokio::test]
async fn copy_and_rename() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let source = Path::from("copy/src.bin");
    let body = pattern(2048);
    store.put(&source, body.clone().into()).await.unwrap();

    // overwrite copy
    let dest = Path::from("copy/dst.bin");
    store.put(&dest, pattern(1).into()).await.unwrap();
    store.copy(&source, &dest).await.unwrap();
    assert_eq!(store.get(&dest).await.unwrap().bytes().await.unwrap(), body);
    assert_eq!(
        store.get(&source).await.unwrap().meta.size,
        2048,
        "source untouched"
    );

    // copy of a missing source is NotFound
    let error = store
        .copy(&Path::from("copy/missing"), &dest)
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::NotFound { .. }),
        "unexpected error: {error:?}",
    );

    // atomic copy-if-not-exists is not supported on S3
    let error = store
        .copy_if_not_exists(&source, &Path::from("copy/new"))
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::NotSupported { .. }),
        "unexpected error: {error:?}",
    );

    // rename = copy + delete
    let renamed = Path::from("copy/renamed.bin");
    store.rename(&source, &renamed).await.unwrap();
    assert_eq!(
        store.get(&renamed).await.unwrap().bytes().await.unwrap(),
        body
    );
    assert!(matches!(
        store.get(&source).await.unwrap_err(),
        object_store::Error::NotFound { .. },
    ));
}

#[tokio::test]
async fn multipart_upload() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("multi/large.bin");

    let parts = [pattern(100_003), pattern(100_019), pattern(50_011)];
    let mut upload = store.put_multipart(&location).await.unwrap();

    // launch all parts concurrently; completion order must not matter
    let futures: Vec<_> = parts
        .iter()
        .map(|part| upload.put_part(PutPayload::from_bytes(part.clone())))
        .collect();
    futures::future::try_join_all(futures).await.unwrap();

    let result = upload.complete().await.unwrap();
    assert!(result.e_tag.is_some());

    let expected: Bytes = parts.concat().into();
    let got = store.get(&location).await.unwrap().bytes().await.unwrap();
    assert_eq!(got, expected);
}

#[tokio::test]
async fn multipart_empty_and_abort() {
    let server = TestServer::spawn().await;
    let store = server.store();

    // completing with zero parts still produces an (empty) object
    let location = Path::from("multi/empty.bin");
    let mut upload = store.put_multipart(&location).await.unwrap();
    upload.complete().await.unwrap();
    assert_eq!(store.get(&location).await.unwrap().meta.size, 0);

    // aborting leaves no object and invalidates the upload
    let location = Path::from("multi/aborted.bin");
    let mut upload = store.put_multipart(&location).await.unwrap();
    upload.put_part(pattern(1024).into()).await.unwrap();
    upload.abort().await.unwrap();
    assert!(matches!(
        store.get(&location).await.unwrap_err(),
        object_store::Error::NotFound { .. },
    ));
    upload.complete().await.unwrap_err();
}

#[tokio::test]
async fn multipart_incomplete_part_fails_complete() {
    let server = TestServer::spawn().await;
    let store = server.store();
    let location = Path::from("multi/incomplete.bin");

    let mut upload = store.put_multipart(&location).await.unwrap();
    // reserve a part number but never await the upload future
    drop(upload.put_part(pattern(64).into()));
    let error = upload.complete().await.unwrap_err();
    assert!(
        error.to_string().contains("parts uploaded before complete"),
        "expected a missing-part error, got: {error}",
    );
}

#[tokio::test]
async fn special_characters_in_keys() {
    let server = TestServer::spawn().await;
    let store = server.store();

    let keys = [
        "specials/with space.txt",
        "specials/percent%25.txt",
        "specials/plus+plus.txt",
        "specials/☃ snowman.bin",
        "specials/query?&=#.frag",
        "specials/quote's\".txt",
    ];
    for (i, key) in keys.iter().enumerate() {
        let location = Path::parse(key).unwrap();
        store.put(&location, pattern(i + 1).into()).await.unwrap();
        let roundtrip = store.get(&location).await.unwrap().bytes().await.unwrap();
        assert_eq!(roundtrip, pattern(i + 1), "roundtrip failed for {key}");
    }

    let mut listed = collect_locations(store.list(Some(&Path::from("specials")))).await;
    listed.sort();
    let mut expected: Vec<String> = keys.iter().map(|k| k.to_string()).collect();
    expected.sort();
    assert_eq!(listed, expected);
}

#[tokio::test]
async fn wrong_credentials_are_rejected() {
    let server = TestServer::spawn().await;
    let store = S3StoreBuilder::new()
        .with_bucket(TEST_BUCKET)
        .with_endpoint(&server.endpoint)
        .with_credentials(TEST_ACCESS_KEY, "not-the-right-secret")
        .with_allow_http(true)
        .with_max_attempts(1)
        .build()
        .unwrap();

    let error = store
        .put(&Path::from("x"), pattern(1).into())
        .await
        .unwrap_err();
    assert!(
        matches!(error, object_store::Error::PermissionDenied { .. }),
        "a bad signature must be rejected by the server: {error:?}",
    );
}

#[tokio::test]
async fn unsigned_requests_are_rejected() {
    let server = TestServer::spawn().await;
    let store = S3StoreBuilder::new()
        .with_bucket(TEST_BUCKET)
        .with_endpoint(&server.endpoint)
        .with_skip_signature(true)
        .with_allow_http(true)
        .with_max_attempts(1)
        .build()
        .unwrap();

    store
        .put(&Path::from("x"), pattern(1).into())
        .await
        .expect_err("the test server requires signed requests");
}

#[tokio::test]
async fn builder_validation() {
    // no bucket
    S3StoreBuilder::new().build().unwrap_err();
    // no credentials
    S3StoreBuilder::new().with_bucket("b").build().unwrap_err();
    // http endpoint without allow_http
    S3StoreBuilder::new()
        .with_bucket("b")
        .with_credentials("k", "s")
        .with_endpoint("http://127.0.0.1:1")
        .build()
        .unwrap_err();
    // invalid bucket name
    S3StoreBuilder::new()
        .with_bucket("a/b")
        .with_credentials("k", "s")
        .build()
        .unwrap_err();
    // a valid configuration builds without touching the network
    S3StoreBuilder::new()
        .with_bucket("b")
        .with_credentials("k", "s")
        .build()
        .unwrap();
}
