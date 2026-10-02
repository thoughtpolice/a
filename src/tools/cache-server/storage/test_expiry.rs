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

/// A git blob record round-trips, is per digest function, and expires with
/// its TTL like everything else.
#[tokio::test]
async fn git_blob_records_round_trip_and_expire() {
    let store = store_with_ttl(Duration::from_millis(300)).await;
    let (digest, data) = blob(b"recorded");
    let record = GitBlobRecord {
        git_id: [0x5a; 20],
        digest,
        size: data.len() as u64,
        blob_expires_at_ms: store.new_blob_expiry(),
    };
    store
        .cas_put_batch(vec![(digest, data, Compression::Identity)], vec![record])
        .await
        .expect("put");

    assert_eq!(
        store
            .git_blob(DigestFn::Sha256, &[0x5a; 20])
            .await
            .expect("get"),
        Some(record)
    );
    assert_eq!(
        store
            .git_blob(DigestFn::Blake3, &[0x5a; 20])
            .await
            .expect("get"),
        None
    );
    assert!(store.is_fresh(record.blob_expires_at_ms));

    tokio::time::sleep(Duration::from_millis(400)).await;
    assert_eq!(
        store
            .git_blob(DigestFn::Sha256, &[0x5a; 20])
            .await
            .expect("get"),
        None
    );
    assert!(!store.is_fresh(record.blob_expires_at_ms));
    store.close().await.expect("close");
}

/// `len` bytes that FastCDC cuts into several distinct chunks.
fn large_blob(len: usize) -> (ContentDigest, Bytes) {
    let data = Bytes::from(super::test_helpers::noise(len));
    (ContentDigest::compute(DigestFn::Sha256, &data), data)
}

/// The chunks of a blob, as digests.
fn chunk_digests(manifest: &BlobManifest) -> Vec<ContentDigest> {
    manifest
        .chunks
        .iter()
        .map(|c| ContentDigest::new(DigestFn::Sha256, c.hash))
        .collect()
}

/// When `digest`'s manifest expires, read from the store itself rather than
/// the presence cache.
async fn stored_expiry(store: &CacheStore, digest: &ContentDigest) -> Option<Option<i64>> {
    let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
    store
        .get_live(&key, &durable_read_options())
        .await
        .expect("get")
        .map(|(_, expires_at)| expires_at)
}

/// Splitting a blob makes each of its chunks a blob, stored until the blob
/// itself expires: no sooner, as a client fetching them relies on, and no
/// later, as the chunk data under them goes when the blob's does.
#[tokio::test]
async fn split_chunks_are_blobs_that_expire_with_theirs() {
    let store = store_with_ttl(Duration::from_secs(60)).await;
    let (digest, data) = large_blob(4 << 20);
    store
        .cas_put_blob(&digest, data, Compression::Identity)
        .await
        .expect("put");
    let (manifest, _) = store.cas_get_manifest(&digest).await.expect("get").unwrap();
    let chunks = chunk_digests(&manifest);
    assert!(chunks.len() > 2);
    for chunk in &chunks {
        assert_eq!(stored_expiry(&store, chunk).await, None, "not a blob yet");
    }

    // The presence cache notes expiries by this process's clock and SlateDB
    // stores them by its own, a few milliseconds apart either way. Chunks
    // take the stored one, so they never outlive the chunk data under them.
    let expires_at = stored_expiry(&store, &digest).await.flatten().unwrap();
    store
        .presence
        .insert(digest, Some(expires_at + 5), now_millis());

    let split = store.cas_split_blob(&digest).await.expect("split").unwrap();
    assert_eq!(chunk_digests(&split), chunks);
    for chunk in &chunks {
        assert_eq!(
            stored_expiry(&store, chunk).await.flatten(),
            Some(expires_at)
        );
        assert!(store.cas_blob_fresh(chunk).await.expect("fresh"));
        let data = store
            .cas_get_blob(chunk)
            .await
            .expect("read")
            .expect("a blob");
        assert_eq!(DigestFn::Sha256.hash_data(&data), chunk.hash);
    }
    store.close().await.expect("close");
}

/// Splitting a blob past half its TTL renews it, chunk data included, as
/// an upload of it would.
#[tokio::test]
async fn splitting_a_blob_past_half_its_ttl_renews_it() {
    let store = store_with_ttl(Duration::from_millis(4000)).await;
    let (digest, data) = large_blob(4 << 20);
    store
        .cas_put_blob(&digest, data.clone(), Compression::Identity)
        .await
        .expect("put");
    let first = stored_expiry(&store, &digest).await.flatten().unwrap();

    tokio::time::sleep(Duration::from_millis(2300)).await;
    assert!(!store.cas_blob_fresh(&digest).await.expect("fresh"));
    let manifest = store.cas_split_blob(&digest).await.expect("split").unwrap();

    let renewed = stored_expiry(&store, &digest).await.flatten().unwrap();
    assert!(renewed >= first + 2000, "{first} -> {renewed}");
    assert!(store.cas_blob_fresh(&digest).await.expect("fresh"));
    for chunk in chunk_digests(&manifest) {
        assert!(store.cas_blob_fresh(&chunk).await.expect("fresh"));
        let key = prefixed_key(PREFIX_CHUNK, chunk.function, &chunk.hash);
        let stored = store.db.get_key_value(&key).await.expect("get").unwrap();
        assert!(
            stored.expire_ts.unwrap() >= first + 2000,
            "chunk data renewed"
        );
    }

    // Past the first expiry, everything still reads.
    tokio::time::sleep(Duration::from_millis(2000)).await;
    assert_eq!(store.cas_get_blob(&digest).await.expect("read"), Some(data));
    store.close().await.expect("close");
}

/// A blob that cannot be renewed because a chunk is gone is reported as
/// such, not split into chunks a client cannot fetch.
#[tokio::test]
async fn splitting_a_blob_with_a_chunk_gone_fails() {
    let store = store_with_ttl(Duration::from_millis(2000)).await;
    let (digest, data) = large_blob(4 << 20);
    store
        .cas_put_blob(&digest, data, Compression::Identity)
        .await
        .expect("put");
    let (manifest, _) = store.cas_get_manifest(&digest).await.expect("get").unwrap();
    let gone = &manifest.chunks[1];
    let key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &gone.hash);
    store.db.delete(&key).await.expect("delete");

    tokio::time::sleep(Duration::from_millis(1100)).await;
    let result = store.cas_split_blob(&digest).await;
    assert!(
        matches!(result, Err(StoreError::ChunkMissing { .. })),
        "{result:?}"
    );
    store.close().await.expect("close");
}
