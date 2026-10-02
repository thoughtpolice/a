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

// ---------------------------------------------------------------------------------------------------------------------
// Entries kept in memory once read
// ---------------------------------------------------------------------------------------------------------------------

/// An entry, once read, is served from memory (here, even after it is gone
/// from the database underneath); with the cache off, nothing is kept.
#[tokio::test]
async fn entries_are_served_from_memory_once_read() {
    for budget in [None, Some(0)] {
        let store = CacheStore::open(
            StoreBackend::Memory,
            CacheStoreSettings {
                action_result_cache_bytes: budget,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let digest = ContentDigest::new(DigestFn::Sha256, [7; 32]);
        let result = Bytes::from_static(b"an action result");
        store.ac_put(&digest, result.clone()).await.unwrap();
        assert_eq!(store.ac_get(&digest).await.unwrap(), Some(result.clone()));

        let key = prefixed_key(PREFIX_ACTION, digest.function, &digest.hash);
        store
            .db
            .delete(key)
            .await
            .unwrap()
            .await_durable()
            .await
            .unwrap();
        let again = store.ac_get(&digest).await.unwrap();
        if budget == Some(0) {
            assert_eq!(again, None, "no cache, nothing kept");
        } else {
            assert_eq!(again, Some(result), "served from memory");
        }
    }
}

/// A write replaces what is kept of the entry.
#[tokio::test]
async fn a_write_replaces_the_kept_entry() {
    let store = open_memory_store().await;
    let digest = ContentDigest::new(DigestFn::Sha256, [8; 32]);
    store
        .ac_put(&digest, Bytes::from_static(b"first"))
        .await
        .unwrap();
    assert_eq!(
        store.ac_get(&digest).await.unwrap().as_deref(),
        Some(&b"first"[..])
    );
    store
        .ac_put(&digest, Bytes::from_static(b"second"))
        .await
        .unwrap();
    assert_eq!(
        store.ac_get(&digest).await.unwrap().as_deref(),
        Some(&b"second"[..])
    );
}

/// Readers racing a writer never leave a replaced entry behind: once a write
/// returns, every read sees it.
#[tokio::test(flavor = "multi_thread", worker_threads = 8)]
async fn reads_racing_writes_never_keep_a_replaced_entry() {
    let store = std::sync::Arc::new(open_memory_store().await);
    let digest = ContentDigest::new(DigestFn::Sha256, [9; 32]);
    store
        .ac_put(&digest, Bytes::from(0u32.to_be_bytes().to_vec()))
        .await
        .unwrap();
    let done = std::sync::Arc::new(std::sync::atomic::AtomicBool::new(false));
    // Fewer readers than workers, each yielding between reads: a read
    // served from memory never waits, and readers that never yield would
    // starve the writer and the store's own flushes.
    let readers: Vec<_> = (0..4)
        .map(|_| {
            let (store, done) = (store.clone(), done.clone());
            tokio::spawn(async move {
                while !done.load(std::sync::atomic::Ordering::Relaxed) {
                    store.ac_get(&digest).await.unwrap();
                    tokio::task::yield_now().await;
                }
            })
        })
        .collect();

    for version in 1..=200u32 {
        let value = Bytes::from(version.to_be_bytes().to_vec());
        store.ac_put(&digest, value.clone()).await.unwrap();
        assert_eq!(
            store.ac_get(&digest).await.unwrap(),
            Some(value),
            "version {version}"
        );
    }
    done.store(true, std::sync::atomic::Ordering::Relaxed);
    for reader in readers {
        reader.await.unwrap();
    }
}
