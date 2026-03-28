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
