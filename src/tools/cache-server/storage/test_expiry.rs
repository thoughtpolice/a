// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Expiry and existence: what reads as stored, and when.

use super::*;

use std::time::Duration;

async fn store_with_ttl(ttl: Duration) -> CacheStore {
    CacheStore::open(
        StoreBackend::Memory,
        CacheStoreSettings {
            default_ttl: Some(jiff::SignedDuration::try_from(ttl).expect("ttl")),
            ..Default::default()
        },
    )
    .await
    .expect("open")
}

fn blob(data: &'static [u8]) -> (ContentDigest, Bytes) {
    let data = Bytes::from_static(data);
    (ContentDigest::compute(DigestFn::Sha256, &data), data)
}

/// SlateDB removes an expired value only when compaction reaches it; until
/// then it must already read as gone, everywhere.
#[tokio::test]
async fn expired_entries_read_as_missing() {
    let store = store_with_ttl(Duration::from_millis(300)).await;
    let (digest, data) = blob(b"short-lived");
    store
        .cas_put_blob(&digest, data, Compression::Identity)
        .await
        .expect("put");
    store
        .ac_put(&digest, Bytes::from_static(b"action result"))
        .await
        .expect("ac put");
    let entry = AssetEntry {
        digest_hash: digest.hash,
        digest_size_bytes: 11,
        created_at: unix_now_secs(),
        expires_at: 0,
        is_directory: false,
        qualifiers: vec![],
    };
    store
        .asset_put(DigestFn::Sha256, "https://example.com/x", &[], &entry)
        .await
        .expect("asset put");
    assert!(store.cas_blob_exists(&digest).await.expect("exists"));

    tokio::time::sleep(Duration::from_millis(400)).await;

    assert!(!store.cas_blob_exists(&digest).await.expect("exists"));
    assert!(!store.cas_blob_fresh(&digest).await.expect("fresh"));
    assert_eq!(store.cas_get_blob(&digest).await.expect("get"), None);
    assert!(
        store
            .cas_get_manifest(&digest)
            .await
            .expect("manifest")
            .is_none()
    );
    assert_eq!(store.ac_get(&digest).await.expect("ac get"), None);
    assert!(
        store
            .asset_get(DigestFn::Sha256, "https://example.com/x", &[])
            .await
            .expect("asset get")
            .is_none()
    );
    store.close().await.expect("close");
}

/// An upload of a blob whose stored copy has expired (but not yet been
/// compacted away) must store it again, not be skipped as a duplicate.
#[tokio::test]
async fn uploading_an_expired_blob_stores_it_again() {
    let store = store_with_ttl(Duration::from_millis(300)).await;
    let (digest, data) = blob(b"uploaded twice");
    store
        .cas_put_blob(&digest, data.clone(), Compression::Identity)
        .await
        .expect("put");
    tokio::time::sleep(Duration::from_millis(400)).await;
    store
        .cas_put_blob(&digest, data.clone(), Compression::Identity)
        .await
        .expect("put again");
    assert_eq!(store.cas_get_blob(&digest).await.expect("get"), Some(data));
    store.close().await.expect("close");
}

/// A blob past half its TTL still reads, but no longer counts as stored for
/// skipping an upload, and the upload renews it.
#[tokio::test]
async fn a_blob_past_half_its_ttl_is_due_for_upload() {
    let store = store_with_ttl(Duration::from_millis(1200)).await;
    let (digest, data) = blob(b"aging");
    store
        .cas_put_blob(&digest, data.clone(), Compression::Identity)
        .await
        .expect("put");
    assert!(store.cas_blob_fresh(&digest).await.expect("fresh"));

    tokio::time::sleep(Duration::from_millis(700)).await;
    assert!(store.cas_blob_exists(&digest).await.expect("exists"));
    assert!(!store.cas_blob_fresh(&digest).await.expect("fresh"));

    store
        .cas_put_blob(&digest, data, Compression::Identity)
        .await
        .expect("renew");
    assert!(store.cas_blob_fresh(&digest).await.expect("fresh"));
    store.close().await.expect("close");
}

/// Without a TTL nothing ages.
#[tokio::test]
async fn without_a_ttl_blobs_stay_fresh() {
    let store = CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
        .await
        .expect("open");
    let (digest, data) = blob(b"forever");
    store
        .cas_put_blob(&digest, data, Compression::Identity)
        .await
        .expect("put");
    assert!(store.cas_blob_fresh(&digest).await.expect("fresh"));
    store.close().await.expect("close");
}

/// A write still waiting for durability does not make its blob exist: a
/// second upload relying on it would otherwise be acknowledged before
/// anything made the blob durable.
#[tokio::test]
async fn writes_in_flight_do_not_exist_yet() {
    let mut never_flush = tuned_settings(&StoreBackend::Memory);
    never_flush.flush_interval = Some(Duration::from_secs(3600));
    let store = Arc::new(
        CacheStore::open(
            StoreBackend::Memory,
            CacheStoreSettings {
                slatedb_overrides: Some(never_flush),
                ..Default::default()
            },
        )
        .await
        .expect("open"),
    );
    // The flush ticker's first tick fires as the database opens, and may
    // catch a write racing it; let one write take that chance first.
    let (warm_digest, warm) = blob(b"warm-up");
    let _ = tokio::time::timeout(
        Duration::from_millis(300),
        store.cas_put_blob(&warm_digest, warm, Compression::Identity),
    )
    .await;

    let (digest, data) = blob(b"in flight");
    let writer = {
        let store = Arc::clone(&store);
        tokio::spawn(async move {
            store
                .cas_put_blob(&digest, data, Compression::Identity)
                .await
        })
    };
    tokio::time::sleep(Duration::from_millis(200)).await;
    assert!(
        !writer.is_finished(),
        "the put should still await durability"
    );
    assert!(!store.cas_blob_exists(&digest).await.expect("exists"));
    assert!(!store.cas_blob_fresh(&digest).await.expect("fresh"));
    writer.abort();
}
