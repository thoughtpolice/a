// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

use std::sync::Arc;

// =================================================================================================================
// Concurrent stream readers
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_stream_concurrent_readers() {
    let store = Arc::new(open_memory_store().await);
    let data = Bytes::from(make_data(4 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let mut handles = Vec::new();
    for _ in 0..8 {
        let store = Arc::clone(&store);
        let expected = data.clone();
        handles.push(tokio::spawn(async move {
            let stream = store
                .cas_get_blob_stream(&ContentDigest::new(DigestFn::Sha256, hash))
                .await
                .unwrap()
                .unwrap();
            let mut stream = std::pin::pin!(stream);
            let mut reassembled = BytesMut::new();
            while let Some(chunk) = stream.next().await {
                reassembled.put(chunk.unwrap());
            }
            assert_eq!(reassembled.freeze(), expected);
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    store.close().await.unwrap();
}

// =================================================================================================================
// Concurrent writes of same blob
// =================================================================================================================

#[tokio::test]
async fn cas_put_blob_concurrent_same_hash() {
    let store = Arc::new(open_memory_store().await);
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);

    let mut handles = Vec::new();
    for _ in 0..4 {
        let store = Arc::clone(&store);
        let data = data.clone();
        handles.push(tokio::spawn(async move {
            store
                .cas_put_blob(
                    &ContentDigest::new(DigestFn::Sha256, hash),
                    data,
                    Compression::Zstd,
                )
                .await
        }));
    }

    for handle in handles {
        handle.await.unwrap().unwrap();
    }

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Concurrent blob readers
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_concurrent_readers() {
    let store = Arc::new(open_memory_store().await);
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);
    let cd = ContentDigest::new(DigestFn::Sha256, hash);
    store
        .cas_put_blob(&cd, data.clone(), Compression::Zstd)
        .await
        .unwrap();

    let mut handles = Vec::new();
    for _ in 0..32 {
        let store = Arc::clone(&store);
        let expected = data.clone();
        handles.push(tokio::spawn(async move {
            let result = store
                .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result, expected);
        }));
    }
    for handle in handles {
        handle.await.unwrap();
    }

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_blob_concurrent_different_blobs() {
    let store = Arc::new(open_memory_store().await);

    let mut handles = Vec::new();
    for i in 0u32..32 {
        let store = Arc::clone(&store);
        handles.push(tokio::spawn(async move {
            let data = Bytes::from(vec![i as u8; 64 * 1024]);
            let hash = DigestFn::Sha256.hash_data(&data);
            store
                .cas_put_blob(
                    &ContentDigest::new(DigestFn::Sha256, hash),
                    data,
                    Compression::Identity,
                )
                .await
                .unwrap();
            hash
        }));
    }

    let hashes: Vec<[u8; 32]> = futures::future::join_all(handles)
        .await
        .into_iter()
        .map(|r| r.unwrap())
        .collect();

    // Verify all 32 blobs are retrievable
    for (i, hash) in hashes.iter().enumerate() {
        let retrieved = store
            .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, *hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retrieved, Bytes::from(vec![i as u8; 64 * 1024]));
    }

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_concurrent_read_write() {
    let store = Arc::new(open_memory_store().await);
    let data = Bytes::from(make_data(1024 * 1024));
    let hash = sha256(&data);
    let cd = ContentDigest::new(DigestFn::Sha256, hash);

    // Pre-store the blob so readers always find it
    store
        .cas_put_blob(&cd, data.clone(), Compression::Identity)
        .await
        .unwrap();

    let mut handles = Vec::new();

    // 16 readers
    for _ in 0..16 {
        let store = Arc::clone(&store);
        let expected = data.clone();
        handles.push(tokio::spawn(async move {
            let result = store
                .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
                .await
                .unwrap()
                .unwrap();
            assert_eq!(result, expected);
        }));
    }

    // 16 writers (writing the same blob — idempotent)
    for _ in 0..16 {
        let store = Arc::clone(&store);
        let data = data.clone();
        handles.push(tokio::spawn(async move {
            store
                .cas_put_blob(
                    &ContentDigest::new(DigestFn::Sha256, hash),
                    data,
                    Compression::Identity,
                )
                .await
                .unwrap();
        }));
    }

    for handle in handles {
        handle.await.unwrap();
    }

    // Final consistency check
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Streaming writers racing readers
// =================================================================================================================

/// Writers stream the same large blob into the store, chunks ahead of the
/// manifest, while readers poll for it. A reader may find nothing, or the
/// whole blob, and nothing in between: never a manifest naming a chunk not
/// yet there, never other bytes.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn readers_never_see_a_streamed_blob_half_written() {
    let store = Arc::new(open_memory_store().await);
    let data = Bytes::from(make_data(40 * 1024 * 1024));
    let digest = ContentDigest::new(DigestFn::Sha256, sha256(&data));
    let done = Arc::new(std::sync::atomic::AtomicBool::new(false));

    let readers: Vec<_> = (0..4)
        .map(|_| {
            let (store, data, done) = (store.clone(), data.clone(), done.clone());
            tokio::spawn(async move {
                let check = |got: Bytes| {
                    assert_eq!(got.len(), data.len());
                    assert!(got == data, "a reader saw other bytes");
                };
                while !done.load(std::sync::atomic::Ordering::Relaxed) {
                    match store.cas_get_blob(&digest).await {
                        Ok(None) => {}
                        Ok(Some(got)) => check(got),
                        Err(e) => panic!("a reader saw a half-written blob: {e}"),
                    }
                    tokio::task::yield_now().await;
                }
                // Once the writers are done, the blob is there, whole.
                check(store.cas_get_blob(&digest).await.unwrap().expect("stored"));
            })
        })
        .collect();

    let writers: Vec<_> = (0..3)
        .map(|w| {
            let (store, data) = (store.clone(), data.clone());
            tokio::spawn(async move {
                let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
                // Different message sizes, so the writers cut and write
                // ahead at different moments.
                for piece in data.chunks((1 << 20) + w * 4093) {
                    writer.write(piece).await.unwrap();
                }
                writer.finalize_verified(&digest).await.unwrap();
            })
        })
        .collect();
    for w in writers {
        w.await.unwrap();
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    for r in readers {
        r.await.unwrap();
    }
}

/// Batches with overlapping blobs, written at once from many tasks, all
/// land, and FindMissingBlobs' view (the presence cache included) agrees
/// with the store's.
#[tokio::test(flavor = "multi_thread", worker_threads = 4)]
async fn overlapping_batches_all_land() {
    let store = Arc::new(open_memory_store().await);
    let blobs: Vec<(ContentDigest, Bytes)> = (0..400)
        .map(|i| {
            let data = Bytes::from(format!("overlapping blob {i}").repeat(i % 7 + 1));
            (ContentDigest::compute(DigestFn::Sha256, &data), data)
        })
        .collect();
    let tasks: Vec<_> = (0..16)
        .map(|t| {
            let store = store.clone();
            // Each task writes a window of the blobs; windows overlap.
            let batch: Vec<_> = blobs.iter().skip(t * 20).take(100).cloned().collect();
            tokio::spawn(async move { store.cas_put_verified_blobs(batch).await.unwrap() })
        })
        .collect();
    for t in tasks {
        t.await.unwrap();
    }
    let stored = blobs.iter().skip(0).take(15 * 20 + 100).count();
    for (i, (digest, data)) in blobs.iter().enumerate() {
        let expect = i < stored;
        assert_eq!(
            store.cas_blob_fresh(digest).await.unwrap(),
            expect,
            "blob {i}"
        );
        let got = store.cas_get_blob(digest).await.unwrap();
        assert_eq!(got.as_ref(), expect.then_some(data), "blob {i}");
    }
}
