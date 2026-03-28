// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

// =================================================================================================================
// Action cache tests
// =================================================================================================================

#[tokio::test]
async fn ac_put_get_roundtrip() {
    let store = open_memory_store().await;
    let hash = [0xAC; 32];
    let data = Bytes::from_static(b"serialized ActionResult proto");

    store
        .ac_put(&ContentDigest::new(DigestFn::Sha256, hash), data.clone())
        .await
        .unwrap();
    let retrieved = store
        .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn ac_get_nonexistent_returns_none() {
    let store = open_memory_store().await;
    let hash = [0xDE; 32];
    assert!(
        store
            .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn ac_put_overwrite() {
    let store = open_memory_store().await;
    let hash = [0xAC; 32];

    store
        .ac_put(
            &ContentDigest::new(DigestFn::Sha256, hash),
            Bytes::from_static(b"v1"),
        )
        .await
        .unwrap();
    store
        .ac_put(
            &ContentDigest::new(DigestFn::Sha256, hash),
            Bytes::from_static(b"v2"),
        )
        .await
        .unwrap();

    let retrieved = store
        .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, Bytes::from_static(b"v2"));

    store.close().await.unwrap();
}

#[tokio::test]
async fn ac_put_empty_value() {
    let store = open_memory_store().await;
    let hash = [0xEE; 32];
    let data = Bytes::new();

    store
        .ac_put(&ContentDigest::new(DigestFn::Sha256, hash), data.clone())
        .await
        .unwrap();
    let retrieved = store
        .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn ac_multiple_entries() {
    let store = open_memory_store().await;

    for i in 0u8..50 {
        let mut hash = [0u8; 32];
        hash[0] = i;
        let data = Bytes::from(vec![i; (i as usize + 1) * 10]);
        store
            .ac_put(&ContentDigest::new(DigestFn::Sha256, hash), data)
            .await
            .unwrap();
    }

    for i in 0u8..50 {
        let mut hash = [0u8; 32];
        hash[0] = i;
        let retrieved = store
            .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retrieved.len(), (i as usize + 1) * 10);
        assert!(retrieved.iter().all(|&b| b == i));
    }

    store.close().await.unwrap();
}

// =================================================================================================================
// Cross-function action cache isolation
// =================================================================================================================

#[tokio::test]
async fn cross_function_action_cache_isolation() {
    let store = open_memory_store().await;
    let hash = [0xAC; 32];

    store
        .ac_put(
            &ContentDigest::new(DigestFn::Sha256, hash),
            Bytes::from_static(b"sha256-result"),
        )
        .await
        .unwrap();
    store
        .ac_put(
            &ContentDigest::new(DigestFn::Blake3, hash),
            Bytes::from_static(b"blake3-result"),
        )
        .await
        .unwrap();

    let r1 = store
        .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let r2 = store
        .ac_get(&ContentDigest::new(DigestFn::Blake3, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r1, Bytes::from_static(b"sha256-result"));
    assert_eq!(r2, Bytes::from_static(b"blake3-result"));

    assert!(
        store
            .ac_get(&ContentDigest::new(DigestFn::Sha256Tree, hash))
            .await
            .unwrap()
            .is_none()
    );

    store.close().await.unwrap();
}

// =================================================================================================================
// Resource limit tests
// =================================================================================================================

#[tokio::test]
async fn ac_put_oversized_rejected() {
    let store = open_memory_store().await;
    let hash = [0xAC; 32];
    let data = Bytes::from(vec![0u8; MAX_ACTION_CACHE_ENTRY_SIZE + 1]);

    let result = store
        .ac_put(&ContentDigest::new(DigestFn::Sha256, hash), data)
        .await;
    assert!(matches!(result, Err(StoreError::BlobTooLarge { .. })));

    store.close().await.unwrap();
}

#[tokio::test]
async fn ac_put_at_limit_accepted() {
    let store = open_memory_store().await;
    let hash = [0xAC; 32];
    let data = Bytes::from(vec![0u8; MAX_ACTION_CACHE_ENTRY_SIZE]);

    store
        .ac_put(&ContentDigest::new(DigestFn::Sha256, hash), data.clone())
        .await
        .unwrap();
    let retrieved = store
        .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved.len(), data.len());

    store.close().await.unwrap();
}
