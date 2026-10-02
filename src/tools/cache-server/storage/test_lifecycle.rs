// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! How a store reports that it has stopped.

use super::*;

use std::time::Duration;

/// A second writer opening the store fences the first: the first's writes
/// fail from then on, and `failed` says why, so the server can stop.
#[tokio::test]
async fn a_second_writer_fences_the_first() {
    let dir = tempfile::tempdir().expect("temp dir");
    let backend = || StoreBackend::LocalFs(dir.path().display().to_string());
    let first = CacheStore::open(backend(), CacheStoreSettings::default())
        .await
        .expect("open first");
    let second = CacheStore::open(backend(), CacheStoreSettings::default())
        .await
        .expect("open second");

    let data = Bytes::from_static(b"written by the fenced writer");
    let digest = ContentDigest::compute(DigestFn::Sha256, &data);
    let write = first
        .cas_put_blob(&digest, data, Compression::Identity)
        .await;
    let reason = tokio::time::timeout(Duration::from_secs(30), first.failed())
        .await
        .expect("the fenced store reports that it stopped");
    assert_eq!(reason, CloseReason::Fenced);

    let err = write.expect_err("a fenced writer cannot write");
    assert!(
        err.is_closed() || matches!(err, StoreError::Database(_)),
        "{err}"
    );
    let data = Bytes::from_static(b"after the fence");
    let digest = ContentDigest::compute(DigestFn::Sha256, &data);
    let err = first
        .cas_put_blob(&digest, data, Compression::Identity)
        .await
        .expect_err("still fenced");
    assert!(err.is_closed(), "{err}");

    second.close().await.expect("close second");
}

/// A clean close is not a failure.
#[tokio::test]
async fn a_clean_close_is_not_a_failure() {
    let store = CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
        .await
        .expect("open");
    store.close().await.expect("close");
    assert!(
        tokio::time::timeout(Duration::from_millis(300), store.failed())
            .await
            .is_err(),
        "failed() resolved after a clean close"
    );
}

/// Each kind of key gets its own LSM tree, and a store made that way reopens.
#[tokio::test]
async fn each_kind_of_key_has_its_own_tree() {
    let dir = tempfile::tempdir().expect("temp dir");
    let backend = || StoreBackend::LocalFs(dir.path().display().to_string());
    let store = CacheStore::open(backend(), CacheStoreSettings::default())
        .await
        .expect("open");
    // Too large to be stored in its manifest: a chunk and a manifest.
    let data = Bytes::from(vec![7u8; INLINE_BLOB_MAX + 1]);
    let digest = ContentDigest::compute(DigestFn::Sha256, &data);
    store
        .cas_put_blob(&digest, data.clone(), Compression::Identity)
        .await
        .expect("put");
    store
        .ac_put(&digest, Bytes::from_static(b"result"))
        .await
        .expect("ac put");
    let mut segments = store.segments();
    segments.sort();
    assert_eq!(segments, [&b"a"[..], b"c", b"m"]);
    store.close().await.expect("close");

    let store = CacheStore::open(backend(), CacheStoreSettings::default())
        .await
        .expect("reopen");
    assert_eq!(store.cas_get_blob(&digest).await.expect("get"), Some(data));
    store.close().await.expect("close");
}

/// The split is fixed when a store is created: a store made without it is
/// refused rather than mixed.
#[tokio::test]
async fn a_store_made_without_the_split_is_refused() {
    let dir = tempfile::tempdir().expect("temp dir");
    let object_store =
        create_object_store(&StoreBackend::LocalFs(dir.path().display().to_string()))
            .expect("object store");
    let db = Db::builder(DB_PATH, object_store)
        .build()
        .await
        .expect("plain db");
    db.put(b"m-key", b"value").await.expect("put");
    db.close().await.expect("close");

    let err = CacheStore::open(
        StoreBackend::LocalFs(dir.path().display().to_string()),
        CacheStoreSettings::default(),
    )
    .await
    .expect_err("mismatched store");
    assert!(err.to_string().contains("segment extractor"), "{err}");
}

/// Writes stop while the disk under a local store is below its reserve;
/// reads of what is stored carry on.
#[tokio::test]
async fn a_full_disk_refuses_writes_but_serves_reads() {
    let dir = tempfile::tempdir().expect("temp dir");
    let open = |reserve| {
        let backend = StoreBackend::LocalFs(dir.path().to_str().expect("utf-8").into());
        CacheStore::open(
            backend,
            CacheStoreSettings {
                disk_reserve_bytes: Some(reserve),
                ..Default::default()
            },
        )
    };
    let data = Bytes::from_static(b"stored before the disk filled");
    let digest = ContentDigest::compute(DigestFn::Sha256, &data);
    let store = open(0).await.expect("open without a reserve");
    store
        .cas_put_blob(&digest, data.clone(), Compression::Identity)
        .await
        .expect("put");
    store.close().await.expect("close");

    // A reserve no disk can meet.
    let store = open(u64::MAX).await.expect("open with a reserve");
    let more = Bytes::from_static(b"one too many");
    let err = store
        .cas_put_blob(
            &ContentDigest::compute(DigestFn::Sha256, &more),
            more,
            Compression::Identity,
        )
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::DiskFull { .. }), "{err:?}");
    let err = store
        .ac_put(&digest, Bytes::from_static(b"result"))
        .await
        .unwrap_err();
    assert!(matches!(err, StoreError::DiskFull { .. }), "{err:?}");
    assert_eq!(store.cas_get_blob(&digest).await.expect("get"), Some(data));
    store.close().await.expect("close");
}

#[test]
fn the_default_disk_reserve_is_a_tenth_and_at_least_a_gib() {
    assert_eq!(default_reserve(4 << 40), (4 << 40) / 10);
    assert_eq!(default_reserve(2 << 30), 1 << 30);
    let (free, total) = filesystem_space(std::path::Path::new("/")).expect("statvfs /");
    assert!(free <= total && total > 0);
}
