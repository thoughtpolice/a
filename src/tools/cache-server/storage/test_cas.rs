// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

// =================================================================================================================
// CacheStore lifecycle tests
// =================================================================================================================

#[tokio::test]
async fn store_open_memory() {
    let store = open_memory_store().await;
    store.close().await.unwrap();
}

// =================================================================================================================
// CAS small blob tests (below SMALL_BLOB_THRESHOLD = 2 MiB)
// =================================================================================================================

#[tokio::test]
async fn cas_put_get_small_blob() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"hello, world!");
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_get_empty_blob() {
    let store = open_memory_store().await;
    let data = Bytes::new();
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);
    assert!(retrieved.is_empty());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_get_1_byte_blob() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(&[0x42]);
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_small_blob_creates_single_chunk_manifest() {
    let store = open_memory_store().await;
    let data = Bytes::from(vec![0xAA; 1024]); // 1 KiB
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let (manifest, comp) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(comp, Compression::Identity);
    assert_eq!(manifest.chunks.len(), 1);
    assert_eq!(manifest.chunks[0].hash, hash);
    assert_eq!(manifest.chunks[0].size, 1024);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_nonexistent_blob_returns_none() {
    let store = open_memory_store().await;
    let hash = [0x00; 32];
    let result = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap();
    assert!(result.is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_blob_exists_true() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"exists!");
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data,
            Compression::Identity,
        )
        .await
        .unwrap();
    assert!(
        store
            .cas_blob_exists(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
    );

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_blob_exists_false() {
    let store = open_memory_store().await;
    let hash = [0xFF; 32];
    assert!(
        !store
            .cas_blob_exists(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_idempotent_small_blob() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"idempotent content");
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_blob_wrong_hash_rejected() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"real data");
    let wrong_hash = sha256(b"not the real data");

    let result = store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, wrong_hash),
            data,
            Compression::Identity,
        )
        .await;
    assert!(matches!(result, Err(StoreError::DigestMismatch { .. })));

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_blob_prehashed_stores_correctly() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"prehashed blob data");
    let hash = sha256(&data);

    store
        .cas_put_blob_prehashed(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_blob_prehashed_skips_existing() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"deduplicated prehashed blob");
    let hash = sha256(&data);
    let cd = ContentDigest::new(DigestFn::Sha256, hash);

    store
        .cas_put_blob_prehashed(&cd, data.clone(), Compression::Identity)
        .await
        .unwrap();

    // Second write of the same blob should succeed (idempotent)
    store
        .cas_put_blob_prehashed(&cd, data.clone(), Compression::Identity)
        .await
        .unwrap();

    let retrieved = store.cas_get_blob(&cd).await.unwrap().unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_put_chunk_wrong_hash_rejected() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"chunk data");
    let wrong_hash = sha256(b"wrong");

    let result = store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, wrong_hash),
            data,
            Compression::Identity,
        )
        .await;
    assert!(matches!(result, Err(StoreError::DigestMismatch { .. })));

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_multiple_small_blobs_independent() {
    let store = open_memory_store().await;

    let blobs: Vec<Bytes> = (0u8..20)
        .map(|i| Bytes::from(vec![i; (i as usize + 1) * 100]))
        .collect();

    let hashes: Vec<[u8; 32]> = blobs.iter().map(|b| sha256(b)).collect();

    for (hash, data) in hashes.iter().zip(blobs.iter()) {
        store
            .cas_put_blob(
                &ContentDigest::new(DigestFn::Sha256, *hash),
                data.clone(),
                Compression::Identity,
            )
            .await
            .unwrap();
    }

    for (hash, data) in hashes.iter().zip(blobs.iter()) {
        let retrieved = store
            .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, *hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(&retrieved, data);
    }

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_blob_just_below_threshold() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(SMALL_BLOB_THRESHOLD - 1));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(manifest.chunks.len(), 1, "should be a single-chunk blob");

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Inline blob tests (at most INLINE_BLOB_MAX, stored in their manifest)
// =================================================================================================================

async fn put(store: &CacheStore, data: &Bytes, compression: Compression) -> ContentDigest {
    let digest = ContentDigest::compute(DigestFn::Sha256, data);
    store
        .cas_put_blob(&digest, data.clone(), compression)
        .await
        .unwrap();
    digest
}

async fn chunk_key_exists(store: &CacheStore, digest: &ContentDigest) -> bool {
    let key = prefixed_key(PREFIX_CHUNK, digest.function, &digest.hash);
    store.db.get(&key).await.unwrap().is_some()
}

#[tokio::test]
async fn blobs_up_to_the_inline_limit_are_stored_in_their_manifest() {
    let store = open_memory_store().await;
    for size in [1, 100, INLINE_BLOB_MAX] {
        let data = Bytes::from(make_data(size));
        let digest = put(&store, &data, Compression::Identity).await;
        assert!(!chunk_key_exists(&store, &digest).await, "{size} bytes");
        let (manifest, _) = store.cas_get_manifest(&digest).await.unwrap().unwrap();
        assert_eq!(manifest.inline.as_ref(), Some(&data));
        // Its one chunk is the blob itself, as SplitBlob reports it.
        let chunks: Vec<_> = manifest.chunks.iter().map(|c| (c.hash, c.size)).collect();
        assert_eq!(chunks, [(digest.hash, size as u64)]);
        assert_eq!(store.cas_get_blob(&digest).await.unwrap(), Some(data));
    }

    let data = Bytes::from(make_data(INLINE_BLOB_MAX + 1));
    let digest = put(&store, &data, Compression::Identity).await;
    assert!(chunk_key_exists(&store, &digest).await);
    let (manifest, _) = store.cas_get_manifest(&digest).await.unwrap().unwrap();
    assert!(manifest.inline.is_none());
    assert_eq!(store.cas_get_blob(&digest).await.unwrap(), Some(data));

    store.close().await.unwrap();
}

#[tokio::test]
async fn the_streaming_writer_stores_small_blobs_inline() {
    let store = open_memory_store().await;
    for size in [1, INLINE_BLOB_MAX, INLINE_BLOB_MAX + 1] {
        let data = Bytes::from(make_data(size));
        let digest = ContentDigest::compute(DigestFn::Sha256, &data);
        let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Zstd);
        for piece in data.chunks(1000) {
            writer.write(piece).await.unwrap();
        }
        assert_eq!(
            writer.finalize_verified(&digest).await.unwrap(),
            (digest, size)
        );
        let (manifest, _) = store.cas_get_manifest(&digest).await.unwrap().unwrap();
        assert_eq!(manifest.inline.is_some(), size <= INLINE_BLOB_MAX, "{size}");
        assert_eq!(
            chunk_key_exists(&store, &digest).await,
            size > INLINE_BLOB_MAX
        );
        assert_eq!(store.cas_get_blob(&digest).await.unwrap(), Some(data));
    }
    store.close().await.unwrap();
}

/// An inline payload is compressed only when that makes it smaller.
#[tokio::test]
async fn inline_blobs_are_compressed_when_it_pays() {
    let store = open_memory_store().await;
    let stored = |digest: ContentDigest| {
        let store = &store;
        async move {
            let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
            store.db.get(&key).await.unwrap().unwrap()
        }
    };

    let zeros = Bytes::from(vec![0u8; INLINE_BLOB_MAX]);
    let digest = put(&store, &zeros, Compression::Zstd).await;
    assert!(stored(digest).await.len() < 100);
    let (_, compression) = store.cas_get_manifest(&digest).await.unwrap().unwrap();
    assert_eq!(compression, Compression::Zstd);
    assert_eq!(store.cas_get_blob(&digest).await.unwrap(), Some(zeros));

    let noise = Bytes::from(noise(INLINE_BLOB_MAX));
    let digest = put(&store, &noise, Compression::Zstd).await;
    assert_eq!(stored(digest).await.len(), 10 + INLINE_BLOB_MAX);
    let (_, compression) = store.cas_get_manifest(&digest).await.unwrap().unwrap();
    assert_eq!(compression, Compression::Identity);
    assert_eq!(store.cas_get_blob(&digest).await.unwrap(), Some(noise));

    store.close().await.unwrap();
}

#[tokio::test]
async fn inline_blob_corruption_is_detected() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"original data");
    let digest = put(&store, &data, Compression::Identity).await;

    let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
    let tampered = BlobManifest::inline(digest.hash, Bytes::from_static(b"tampered data"));
    store
        .db
        .put(&key, tampered.to_bytes(Compression::Identity).unwrap())
        .await
        .unwrap();

    for result in [
        store.cas_get_blob(&digest).await.map(|_| ()),
        store.cas_get_manifest(&digest).await.map(|_| ()),
        store.cas_get_chunk(&digest).await.map(|_| ()),
    ] {
        assert!(
            matches!(result, Err(StoreError::DigestMismatch { .. })),
            "{result:?}"
        );
    }
    store.close().await.unwrap();
}

#[tokio::test]
async fn inline_blobs_stream_whole() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(3000));
    let digest = put(&store, &data, Compression::Identity).await;
    let pieces: Vec<Bytes> = store
        .cas_get_blob_stream(&digest)
        .await
        .unwrap()
        .unwrap()
        .try_collect()
        .await
        .unwrap();
    assert_eq!(pieces, [data]);
    store.close().await.unwrap();
}

/// The chunks a client splices are CAS blobs however they are stored:
/// inline, as one chunk, or split into many.
#[tokio::test]
async fn blobs_of_every_layout_read_as_chunks() {
    let store = open_memory_store().await;
    for size in [100, INLINE_BLOB_MAX + 1, SMALL_BLOB_THRESHOLD + 1] {
        let data = Bytes::from(make_data(size));
        let digest = put(&store, &data, Compression::Identity).await;
        assert!(store.cas_chunk_exists(&digest).await.unwrap(), "{size}");
        assert_eq!(store.cas_get_chunk(&digest).await.unwrap(), Some(data));
    }
    let missing = ContentDigest::compute(DigestFn::Sha256, b"never stored");
    assert!(!store.cas_chunk_exists(&missing).await.unwrap());
    assert_eq!(store.cas_get_chunk(&missing).await.unwrap(), None);
    store.close().await.unwrap();
}

/// Small blobs stored before inlining, as a chunk and a manifest naming
/// it, still read.
#[tokio::test]
async fn small_blobs_stored_as_chunks_still_read() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"stored by an older server");
    let digest = ContentDigest::compute(DigestFn::Sha256, &data);
    store
        .cas_put_chunk(&digest, data.clone(), Compression::Identity)
        .await
        .unwrap();
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: digest.hash,
            size: data.len() as u64,
        }],
        created_at: unix_now_secs(),
        inline: None,
    };
    store
        .cas_put_manifest(&digest, &manifest, Compression::Identity)
        .await
        .unwrap();

    let (manifest, _) = store.cas_get_manifest(&digest).await.unwrap().unwrap();
    assert!(manifest.inline.is_none());
    assert_eq!(store.cas_get_blob(&digest).await.unwrap(), Some(data));
    store.close().await.unwrap();
}

// =================================================================================================================
// CAS large blob tests (at or above SMALL_BLOB_THRESHOLD = 2 MiB, CDC chunking)
// =================================================================================================================

#[tokio::test]
async fn cas_put_get_large_blob_exact_threshold() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(SMALL_BLOB_THRESHOLD));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_produces_multiple_chunks() {
    let store = open_memory_store().await;
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

    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert!(
        manifest.chunks.len() > 1,
        "4 MiB blob should produce multiple chunks, got {}",
        manifest.chunks.len()
    );

    let total: u64 = manifest.chunks.iter().map(|c| c.size).sum();
    assert_eq!(total, data.len() as u64);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_roundtrip_preserves_content() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(5 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved.len(), data.len());
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_chunks_individually_retrievable() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    for chunk_info in &manifest.chunks {
        assert!(
            store
                .cas_chunk_exists(&ContentDigest::new(DigestFn::Sha256, chunk_info.hash))
                .await
                .unwrap(),
            "chunk should exist in store"
        );
        let chunk_data = store
            .cas_get_chunk(&ContentDigest::new(DigestFn::Sha256, chunk_info.hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(chunk_data.len(), chunk_info.size as usize);
        let actual_hash = sha256(&chunk_data);
        assert_eq!(actual_hash, chunk_info.hash, "chunk hash mismatch");
    }

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_chunk_sizes_within_bounds() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(8 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let num_chunks = manifest.chunks.len();
    for (i, chunk) in manifest.chunks.iter().enumerate() {
        if i < num_chunks - 1 {
            assert!(
                chunk.size >= CDC_MIN_SIZE as u64,
                "non-final chunk {} too small: {} < {}",
                i,
                chunk.size,
                CDC_MIN_SIZE
            );
        }
        assert!(
            chunk.size <= CDC_MAX_SIZE as u64,
            "chunk {} too large: {} > {}",
            i,
            chunk.size,
            CDC_MAX_SIZE
        );
    }

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_manifest_chunks_reassemble_in_order() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// prefixed_key tests
// =================================================================================================================

#[test]
fn prefixed_key_manifest() {
    let hash = [0x42; 32];
    let key = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &hash);
    assert_eq!(key.len(), 34);
    assert_eq!(key[0], b'm');
    assert_eq!(key[1], DigestFn::Sha256 as u8);
    assert_eq!(&key[2..], &[0x42; 32]);
}

#[test]
fn prefixed_key_chunk() {
    let hash = [0x00; 32];
    let key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &hash);
    assert_eq!(key[0], b'c');
    assert_eq!(key[1], DigestFn::Sha256 as u8);
    assert_eq!(&key[2..], &[0x00; 32]);
}

#[test]
fn prefixed_key_action() {
    let hash = [0xFF; 32];
    let key = prefixed_key(PREFIX_ACTION, DigestFn::Sha256, &hash);
    assert_eq!(key[0], b'a');
    assert_eq!(key[1], DigestFn::Sha256 as u8);
    assert_eq!(&key[2..], &[0xFF; 32]);
}

#[test]
fn prefixed_keys_with_different_prefixes_differ() {
    let hash = [0x11; 32];
    let k1 = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &hash);
    let k2 = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &hash);
    let k3 = prefixed_key(PREFIX_ACTION, DigestFn::Sha256, &hash);
    assert_ne!(k1, k2);
    assert_ne!(k2, k3);
    assert_ne!(k1, k3);
}

#[test]
fn prefixed_keys_with_different_digest_fns_differ() {
    let hash = [0x11; 32];
    let k1 = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &hash);
    let k2 = prefixed_key(PREFIX_CHUNK, DigestFn::Blake3, &hash);
    let k3 = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256Tree, &hash);
    assert_ne!(k1, k2);
    assert_ne!(k2, k3);
    assert_ne!(k1, k3);
}

// =================================================================================================================
// Keyspace isolation tests
// =================================================================================================================

#[tokio::test]
async fn keyspaces_are_isolated() {
    let store = open_memory_store().await;

    let blob_data = Bytes::from_static(b"blob content");
    let blob_hash = sha256(&blob_data);
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            blob_data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let chunk_data = Bytes::from_static(b"raw chunk");
    let chunk_hash = sha256(&chunk_data);
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, chunk_hash),
            chunk_data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let ac_data = Bytes::from_static(b"action result");
    let ac_hash = [0x77; 32];
    store
        .ac_put(
            &ContentDigest::new(DigestFn::Sha256, ac_hash),
            ac_data.clone(),
        )
        .await
        .unwrap();

    let got_blob = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got_blob, blob_data);

    let got_chunk = store
        .cas_get_chunk(&ContentDigest::new(DigestFn::Sha256, chunk_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got_chunk, chunk_data);

    let got_ac = store
        .ac_get(&ContentDigest::new(DigestFn::Sha256, ac_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got_ac, ac_data);

    assert!(
        store
            .cas_blob_exists(&ContentDigest::new(DigestFn::Sha256, blob_hash))
            .await
            .unwrap()
    );

    store.close().await.unwrap();
}

#[tokio::test]
async fn blob_and_action_same_hash_independent() {
    let store = open_memory_store().await;
    let hash = [0x55; 32];

    store
        .ac_put(
            &ContentDigest::new(DigestFn::Sha256, hash),
            Bytes::from_static(b"action"),
        )
        .await
        .unwrap();
    assert!(
        !store
            .cas_blob_exists(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
    );
    assert!(
        store
            .ac_get(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .is_some()
    );

    store.close().await.unwrap();
}

// =================================================================================================================
// Digest verification on read tests
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_detects_corruption() {
    let store = open_memory_store().await;
    // Large enough to be stored as a chunk.
    let data = Bytes::from(make_data(INLINE_BLOB_MAX + 1));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Tamper with the chunk directly in the DB (valid tag byte + corrupted
    // data of the same length)
    let chunk_key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &hash);
    let mut corrupted = vec![Compression::Identity as u8];
    corrupted.extend_from_slice(&data);
    corrupted[1] ^= 1;
    store.db.put(&chunk_key, &corrupted).await.unwrap();

    let result = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await;
    assert!(matches!(result, Err(StoreError::DigestMismatch { .. })));

    store.close().await.unwrap();
}

// =================================================================================================================
// Deduplication tests
// =================================================================================================================

#[tokio::test]
async fn cas_put_blob_deduplicates_chunks() {
    let store = open_memory_store().await;

    // Create two large blobs that share a common prefix (and thus common
    // CDC chunks). We store blob1 first, then blob2 which reuses shared chunks.
    let shared_prefix = make_data(3 * 1024 * 1024);
    let mut data1 = shared_prefix.clone();
    data1.extend_from_slice(&[0xAA; 512 * 1024]);
    let mut data2 = shared_prefix;
    data2.extend_from_slice(&[0xBB; 512 * 1024]);

    let hash1 = sha256(&data1);
    let hash2 = sha256(&data2);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash1),
            Bytes::from(data1.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash2),
            Bytes::from(data2.clone()),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Both blobs should round-trip correctly
    let r1 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash1))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&r1[..], &data1[..]);
    let r2 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash2))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(&r2[..], &data2[..]);

    store.close().await.unwrap();
}

#[tokio::test]
async fn large_blob_dedup_identical_content() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Edge cases
// =================================================================================================================

#[tokio::test]
async fn cas_blob_at_various_sizes() {
    let store = open_memory_store().await;

    let sizes = [
        0,
        1,
        100,
        4096,
        65536,
        CDC_MIN_SIZE,
        CDC_AVG_SIZE,
        CDC_MAX_SIZE - 1,
    ];

    for &size in &sizes {
        let data = Bytes::from(make_data(size));
        let hash = sha256(&data);
        store
            .cas_put_blob(
                &ContentDigest::new(DigestFn::Sha256, hash),
                data.clone(),
                Compression::Identity,
            )
            .await
            .unwrap();
        let retrieved = store
            .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            retrieved, data,
            "roundtrip failed for blob of size {}",
            size
        );
    }

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_sizes() {
    let store = open_memory_store().await;

    let sizes = [
        SMALL_BLOB_THRESHOLD,
        SMALL_BLOB_THRESHOLD + 1,
        3 * 1024 * 1024,
    ];

    for &size in &sizes {
        let data = Bytes::from(make_data(size));
        let hash = sha256(&data);
        store
            .cas_put_blob(
                &ContentDigest::new(DigestFn::Sha256, hash),
                data.clone(),
                Compression::Identity,
            )
            .await
            .unwrap();
        let retrieved = store
            .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(
            retrieved.len(),
            data.len(),
            "size mismatch for blob of size {}",
            size
        );
        assert_eq!(
            retrieved, data,
            "content mismatch for blob of size {}",
            size
        );
    }

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_manifest_nonexistent() {
    let store = open_memory_store().await;
    assert!(
        store
            .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, [0x00; 32]))
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_chunk_exists_nonexistent() {
    let store = open_memory_store().await;
    assert!(
        !store
            .cas_chunk_exists(&ContentDigest::new(DigestFn::Sha256, [0x00; 32]))
            .await
            .unwrap()
    );
    store.close().await.unwrap();
}

// =================================================================================================================
// Debug trait test
// =================================================================================================================

#[tokio::test]
async fn cache_store_debug_impl() {
    let store = open_memory_store().await;
    let debug_str = format!("{:?}", store);
    assert!(debug_str.contains("CacheStore"));
    store.close().await.unwrap();
}

// =================================================================================================================
// Multi-hash: BLAKE3 and SHA256TREE blob tests
// =================================================================================================================

#[tokio::test]
async fn blake3_blob_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"blake3 test data");
    let hash = DigestFn::Blake3.hash_data(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Blake3, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Blake3, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn sha256tree_blob_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"sha256tree test data");
    let hash = DigestFn::Sha256Tree.hash_data(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256Tree, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256Tree, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Multi-hash: cross-function isolation
// =================================================================================================================

#[tokio::test]
async fn cross_function_isolation() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"same data, different functions");

    let sha256_hash = DigestFn::Sha256.hash_data(&data);
    let blake3_hash = DigestFn::Blake3.hash_data(&data);
    let sha256tree_hash = DigestFn::Sha256Tree.hash_data(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, sha256_hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Blake3, blake3_hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256Tree, sha256tree_hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let r1 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, sha256_hash))
        .await
        .unwrap()
        .unwrap();
    let r2 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Blake3, blake3_hash))
        .await
        .unwrap()
        .unwrap();
    let r3 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256Tree, sha256tree_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r1, data);
    assert_eq!(r2, data);
    assert_eq!(r3, data);

    assert!(
        store
            .cas_get_blob(&ContentDigest::new(DigestFn::Blake3, sha256_hash))
            .await
            .unwrap()
            .is_none()
    );
    assert!(
        store
            .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blake3_hash))
            .await
            .unwrap()
            .is_none()
    );

    store.close().await.unwrap();
}

// =================================================================================================================
// Compression: blob storage roundtrips
// =================================================================================================================

#[tokio::test]
async fn cas_small_blob_zstd_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from(vec![0xAA; 4096]);
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();

    let (_, comp) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(comp, Compression::Zstd);

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_small_blob_deflate_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from(vec![0xBB; 4096]);
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Deflate,
        )
        .await
        .unwrap();

    let (_, comp) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(comp, Compression::Deflate);

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_small_blob_brotli_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from(vec![0xCC; 4096]);
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Brotli,
        )
        .await
        .unwrap();

    let (_, comp) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(comp, Compression::Brotli);

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_zstd_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();

    let (_, comp) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(comp, Compression::Zstd);

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_empty_blob_with_compression() {
    let store = open_memory_store().await;
    let data = Bytes::new();
    let hash = sha256(&data);

    for c in [Compression::Zstd, Compression::Deflate, Compression::Brotli] {
        store
            .cas_put_blob(&ContentDigest::new(DigestFn::Sha256, hash), data.clone(), c)
            .await
            .unwrap();
        let retrieved = store
            .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(retrieved, data, "empty blob roundtrip failed for {:?}", c);
    }

    store.close().await.unwrap();
}

// =================================================================================================================
// Compression + multi-hash combinations
// =================================================================================================================

#[tokio::test]
async fn sha256tree_with_zstd() {
    let store = open_memory_store().await;
    let data = Bytes::from(vec![0x42; 8192]);
    let hash = DigestFn::Sha256Tree.hash_data(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256Tree, hash),
            data.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256Tree, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn blake3_with_brotli() {
    let store = open_memory_store().await;
    let data = Bytes::from(vec![0x99; 8192]);
    let hash = DigestFn::Blake3.hash_data(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Blake3, hash),
            data.clone(),
            Compression::Brotli,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Blake3, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn compressed_chunks_are_smaller_than_uncompressed() {
    let store = open_memory_store().await;
    // Highly compressible data, large enough to be stored as a chunk
    let data = Bytes::from(vec![0u8; 2 * INLINE_BLOB_MAX]);
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();

    // Read raw bytes directly from storage to inspect compressed size
    let chunk_key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &hash);
    let raw_chunk = store.db.get(&chunk_key).await.unwrap().unwrap();
    assert!(
        raw_chunk.len() < data.len(),
        "compressed chunk ({}) should be smaller than original ({})",
        raw_chunk.len(),
        data.len()
    );

    // But cas_get_blob should still return the original data
    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Compression mismatch on re-write tests
// =================================================================================================================

#[tokio::test]
async fn cas_large_blob_rewrite_different_compression() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);

    // Store with Identity first
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let r1 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r1, data);

    // Re-store with Zstd — existence check makes this a no-op
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();

    // Manifest still records Identity (the original compression)
    let (_, comp) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(comp, Compression::Identity);

    let r2 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r2, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_small_blob_rewrite_different_compression() {
    let store = open_memory_store().await;
    let data = Bytes::from(vec![0xAA; 4096]);
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let r1 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r1, data);

    // Re-store with Zstd — small blobs skip if already exists, so this is a no-op,
    // but subsequent reads should still succeed
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();
    // Read uses the manifest's recorded compression, which is still Identity
    let r2 = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(r2, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_large_blob_overwrite_restores_corrupted_chunk() {
    // CAS immutability: once a blob exists, re-upload is skipped even if a chunk
    // is corrupted underneath. Corruption requires explicit repair, not re-upload.
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(3 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Tamper with the first chunk (valid tag byte + corrupted data)
    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let first_chunk_key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &manifest.chunks[0].hash);
    let mut corrupted = vec![Compression::Identity as u8];
    corrupted.extend_from_slice(b"corrupted");
    store
        .db_put(&first_chunk_key, Bytes::from(corrupted))
        .await
        .unwrap();

    // Re-store is a no-op because the blob manifest already exists
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    // The corruption is still present — reads will detect it
    let result = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await;
    assert!(
        result.is_err(),
        "expected error reading blob with corrupted chunk"
    );

    store.close().await.unwrap();
}

// =================================================================================================================
// Single-chunk verification
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_single_chunk_verified() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"single chunk blob for verification");
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Single-chunk blob: per-chunk hash verification is sufficient
    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(manifest.chunks.len(), 1);

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Numeric overflow tests
// =================================================================================================================

#[tokio::test]
async fn total_size_overflow_detected() {
    let store = open_memory_store().await;

    // Craft a manifest with two chunks each claiming u64::MAX / 2 + 1 bytes,
    // which would overflow when summed
    let chunk_size = u64::MAX / 2 + 1;
    let manifest = BlobManifest {
        chunks: vec![
            ChunkInfo {
                hash: [0xAA; 32],
                size: chunk_size,
            },
            ChunkInfo {
                hash: [0xBB; 32],
                size: chunk_size,
            },
        ],
        created_at: 0,
        inline: None,
    };
    let blob_hash = [0x11; 32];
    let manifest_key = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &blob_hash);
    store
        .db_put(
            &manifest_key,
            manifest.to_bytes(Compression::Identity).unwrap(),
        )
        .await
        .unwrap();

    let result = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await;
    assert!(matches!(result, Err(StoreError::ManifestCorrupted(_))));

    store.close().await.unwrap();
}

// =================================================================================================================
// StoreError::is_retryable tests
// =================================================================================================================

#[test]
fn is_retryable_unavailable() {
    let err = StoreError::Database(slatedb::Error::unavailable("network blip".into()));
    assert!(err.is_retryable());
}

#[test]
fn is_retryable_transaction() {
    let err = StoreError::Database(slatedb::Error::transaction("conflict".into()));
    assert!(err.is_retryable());
}

#[test]
fn is_retryable_closed_is_permanent() {
    let err = StoreError::Database(slatedb::Error::closed(
        "shutting down".into(),
        slatedb::CloseReason::Clean,
    ));
    assert!(!err.is_retryable());
}

#[test]
fn is_retryable_invalid_is_permanent() {
    let err = StoreError::Database(slatedb::Error::invalid("bad argument".into()));
    assert!(!err.is_retryable());
}

#[test]
fn is_retryable_data_is_permanent() {
    let err = StoreError::Database(slatedb::Error::data("corrupt".into()));
    assert!(!err.is_retryable());
}

#[test]
fn is_retryable_internal_is_permanent() {
    let err = StoreError::Database(slatedb::Error::internal("bug".into()));
    assert!(!err.is_retryable());
}

#[test]
fn is_retryable_non_database_variants_are_permanent() {
    let cases: Vec<StoreError> = vec![
        StoreError::ManifestCorrupted("bad".into()),
        StoreError::ChunkMissing { hash: "abc".into() },
        StoreError::ChunkSizeMismatch {
            expected: 10,
            actual: 20,
        },
        StoreError::CompressionFailed("oops".into()),
        StoreError::DigestMismatch {
            expected: "aa".into(),
            actual: "bb".into(),
        },
        StoreError::BlobTooLarge {
            size: 100,
            limit: 50,
        },
    ];
    for err in &cases {
        assert!(!err.is_retryable(), "expected permanent for {:?}", err);
    }
}

// =================================================================================================================
// Manifest V3 timestamp in CAS
// =================================================================================================================

#[tokio::test]
async fn cas_put_blob_sets_created_at() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"timestamp test");
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data,
            Compression::Identity,
        )
        .await
        .unwrap();

    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert!(
        manifest.created_at > 0,
        "expected non-zero created_at timestamp"
    );

    store.close().await.unwrap();
}

// =================================================================================================================
// Zero-chunk manifest hash verification
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_zero_chunk_manifest_wrong_hash_rejected() {
    let store = open_memory_store().await;

    // Write a zero-chunk manifest under a hash that does NOT correspond to empty data.
    let wrong_hash = sha256(b"not empty");
    let manifest = BlobManifest {
        chunks: vec![],
        created_at: 0,
        inline: None,
    };
    let manifest_key = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &wrong_hash);
    store
        .db_put(
            &manifest_key,
            manifest.to_bytes(Compression::Identity).unwrap(),
        )
        .await
        .unwrap();

    // cas_get_blob should detect that the hash of empty data != wrong_hash
    let result = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, wrong_hash))
        .await;
    assert!(
        matches!(result, Err(StoreError::DigestMismatch { .. })),
        "expected DigestMismatch for zero-chunk manifest under wrong hash, got {:?}",
        result,
    );

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_blob_zero_chunk_manifest_correct_hash_accepted() {
    let store = open_memory_store().await;

    // The correct hash for empty data
    let empty_hash = sha256(b"");
    let manifest = BlobManifest {
        chunks: vec![],
        created_at: 0,
        inline: None,
    };
    let manifest_key = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &empty_hash);
    store
        .db_put(
            &manifest_key,
            manifest.to_bytes(Compression::Identity).unwrap(),
        )
        .await
        .unwrap();

    let result = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, empty_hash))
        .await
        .unwrap();
    assert!(result.is_some());
    assert!(result.unwrap().is_empty());

    store.close().await.unwrap();
}

// ---------------------------------------------------------------------------------------------------------------------
// Small blobs kept in memory once read
// ---------------------------------------------------------------------------------------------------------------------

/// Delete `digest`'s manifest from the database underneath the store, as
/// only data loss could.
async fn lose_manifest(store: &CacheStore, digest: &ContentDigest) {
    let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
    store
        .db
        .delete(key)
        .await
        .unwrap()
        .await_durable()
        .await
        .unwrap();
}

/// A small blob, once read, is served from memory (here, even after its
/// manifest is gone from the database); one over 64 KiB is not kept, and
/// nothing is when the cache is off.
#[tokio::test]
async fn small_blobs_are_served_from_memory_once_read() {
    for budget in [None, Some(0)] {
        let store = CacheStore::open(
            StoreBackend::Memory,
            CacheStoreSettings {
                small_blob_cache_bytes: budget,
                // Kept manifests would serve the larger blob from its chunk.
                manifest_cache_bytes: Some(0),
                ..Default::default()
            },
        )
        .await
        .unwrap();
        let small = Bytes::from_static(b"a header everyone includes");
        let large = Bytes::from(noise(128 * 1024));
        let small_cd = ContentDigest::compute(DigestFn::Sha256, &small);
        let large_cd = ContentDigest::compute(DigestFn::Sha256, &large);
        for (cd, data) in [(&small_cd, &small), (&large_cd, &large)] {
            store
                .cas_put_blob(cd, data.clone(), Compression::Identity)
                .await
                .unwrap();
            assert_eq!(store.cas_get_blob(cd).await.unwrap().as_ref(), Some(data));
            lose_manifest(&store, cd).await;
        }

        let small_again = store.cas_get_blob(&small_cd).await.unwrap();
        if budget == Some(0) {
            assert_eq!(small_again, None, "no cache, nothing kept");
        } else {
            assert_eq!(small_again, Some(small), "served from memory");
        }
        assert_eq!(store.cas_get_blob(&large_cd).await.unwrap(), None);
    }
}

/// A blob of one chunk, up to 64 KiB, is kept too once read whole or
/// streamed, and served after its manifest and chunk are gone; one byte
/// larger, it is not kept.
#[tokio::test]
async fn single_chunk_blobs_are_served_from_memory_once_read() {
    let store = open_memory_store().await;
    let chunk_key = |cd: &ContentDigest| prefixed_key(PREFIX_CHUNK, cd.function, &cd.hash);
    let mut blobs = Vec::new();
    for (size, streamed) in [(8 * 1024, false), (64 * 1024, true), (64 * 1024 + 1, false)] {
        let data = Bytes::from(noise(size));
        let cd = ContentDigest::compute(DigestFn::Sha256, &data);
        store
            .cas_put_blob(&cd, data.clone(), Compression::Identity)
            .await
            .unwrap();
        if streamed {
            let pieces: Vec<Bytes> = store
                .cas_get_blob_stream(&cd)
                .await
                .unwrap()
                .unwrap()
                .map(|piece| piece.unwrap())
                .collect()
                .await;
            assert_eq!(pieces.concat(), data.to_vec());
        } else {
            assert_eq!(store.cas_get_blob(&cd).await.unwrap(), Some(data.clone()));
        }
        lose_manifest(&store, &cd).await;
        store
            .db
            .delete(chunk_key(&cd))
            .await
            .unwrap()
            .await_durable()
            .await
            .unwrap();
        blobs.push((size, cd, data));
    }
    for (size, cd, data) in blobs {
        let again = store.cas_get_blob(&cd).await.unwrap();
        if size <= 64 * 1024 {
            assert_eq!(again, Some(data), "{size} bytes, served from memory");
        } else {
            assert_eq!(again, None, "{size} bytes, not kept");
        }
    }
}

/// A kept blob past its expiry is not served: the read goes to the store.
#[tokio::test]
async fn expired_small_blobs_are_not_served_from_memory() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"short-lived");
    let cd = ContentDigest::compute(DigestFn::Sha256, &data);
    let cache = store.small_blobs.as_ref().unwrap();
    let now = now_millis();

    cache.insert(cd, &data, Compression::Identity, 0, Some(now + 60_000), now);
    assert_eq!(store.cas_get_blob(&cd).await.unwrap(), Some(data.clone()));

    cache.insert(cd, &data, Compression::Identity, 0, Some(now - 1), now);
    assert_eq!(store.cas_get_blob(&cd).await.unwrap(), None, "never stored");
}

// ---------------------------------------------------------------------------------------------------------------------
// Blob manifests kept in memory once read
// ---------------------------------------------------------------------------------------------------------------------

/// The manifest of a blob too large to keep whole, one chunk or many, is
/// kept once read: reading the blob again needs only its chunks, here even
/// after the stored manifest is gone. With the cache off, nothing is kept.
#[tokio::test]
async fn manifests_are_served_from_memory_once_read() {
    for budget in [None, Some(0)] {
        let store = CacheStore::open(
            StoreBackend::Memory,
            CacheStoreSettings {
                manifest_cache_bytes: budget,
                ..Default::default()
            },
        )
        .await
        .unwrap();
        for size in [128 * 1024, 5 * 1024 * 1024] {
            let data = Bytes::from(noise(size));
            let cd = ContentDigest::compute(DigestFn::Sha256, &data);
            store
                .cas_put_blob(&cd, data.clone(), Compression::Identity)
                .await
                .unwrap();
            assert_eq!(store.cas_get_blob(&cd).await.unwrap(), Some(data.clone()));
            lose_manifest(&store, &cd).await;
            let again = store.cas_get_blob(&cd).await.unwrap();
            if budget == Some(0) {
                assert_eq!(again, None, "{size} bytes: no cache, nothing kept");
            } else {
                assert_eq!(again, Some(data), "{size} bytes: manifest from memory");
            }
        }
    }
}

/// A kept manifest that names a chunk the store lacks (as one kept across a
/// rewrite that chunked the blob anew might) is read again from the store:
/// a whole read retries at once, a streamed one leaves the next read to.
#[tokio::test]
async fn a_kept_manifest_naming_missing_chunks_is_read_again() {
    let store = open_memory_store().await;
    let data = Bytes::from(noise(128 * 1024));
    let cd = ContentDigest::compute(DigestFn::Sha256, &data);
    store
        .cas_put_blob(&cd, data.clone(), Compression::Identity)
        .await
        .unwrap();
    let stale = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xee; 32],
            size: data.len() as u64,
        }],
        created_at: 0,
        inline: None,
    };
    let keep_stale = || {
        let now = now_millis();
        store.manifests.as_ref().unwrap().insert(
            cd,
            &stale,
            Compression::Identity,
            Some(now + 24 * 60 * 60 * 1000),
            now,
        );
    };

    keep_stale();
    assert_eq!(store.cas_get_blob(&cd).await.unwrap(), Some(data.clone()));

    keep_stale();
    let streamed: Vec<_> = store
        .cas_get_blob_stream(&cd)
        .await
        .unwrap()
        .unwrap()
        .collect()
        .await;
    assert!(
        matches!(streamed[..], [Err(StoreError::ChunkMissing { .. })]),
        "{streamed:?}"
    );
    let pieces: Vec<Bytes> = store
        .cas_get_blob_stream(&cd)
        .await
        .unwrap()
        .unwrap()
        .map(|piece| piece.unwrap())
        .collect()
        .await;
    assert_eq!(pieces.concat(), data.to_vec());
}

/// SplitBlob reads the stored manifest, not a kept one: the chunk manifests
/// it writes must name the chunks the store's does.
#[tokio::test]
async fn split_blob_reads_the_stored_manifest() {
    let store = open_memory_store().await;
    let data = Bytes::from(noise(128 * 1024));
    let cd = ContentDigest::compute(DigestFn::Sha256, &data);
    store
        .cas_put_blob(&cd, data.clone(), Compression::Identity)
        .await
        .unwrap();
    let stale = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xee; 32],
            size: data.len() as u64,
        }],
        created_at: 0,
        inline: None,
    };
    let now = now_millis();
    store.manifests.as_ref().unwrap().insert(
        cd,
        &stale,
        Compression::Identity,
        Some(now + 24 * 60 * 60 * 1000),
        now,
    );

    let split = store.cas_split_blob(&cd).await.unwrap().unwrap();
    let chunks: Vec<[u8; 32]> = split.chunks.iter().map(|c| c.hash).collect();
    assert_eq!(chunks, [cd.hash], "the stored manifest's one chunk");
}
