// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

// =================================================================================================================
// Streaming read API tests
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_stream_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(4 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();

    let stream = store
        .cas_get_blob_stream(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let mut stream = std::pin::pin!(stream);
    let mut reassembled = BytesMut::new();
    let mut chunk_count = 0;
    while let Some(chunk) = stream.next().await {
        let chunk = chunk.unwrap();
        reassembled.put(chunk);
        chunk_count += 1;
    }

    assert!(chunk_count > 0);
    assert_eq!(reassembled.freeze(), data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_blob_stream_nonexistent() {
    let store = open_memory_store().await;
    let hash = [0x00; 32];

    let result = store
        .cas_get_blob_stream(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap();
    assert!(result.is_none());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_blob_stream_small_blob() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"small streaming blob");
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

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
    assert_eq!(reassembled.freeze(), data);

    store.close().await.unwrap();
}

// =================================================================================================================
// Stream corruption detection
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_stream_detects_corruption() {
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

    // Tamper with the first chunk
    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let first_chunk_key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &manifest.chunks[0].hash);
    let mut corrupted = vec![Compression::Identity as u8];
    corrupted.extend_from_slice(b"corrupted data that is wrong");
    store.db.put(&first_chunk_key, &corrupted).await.unwrap();

    // Stream should yield an error
    let stream = store
        .cas_get_blob_stream(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let mut stream = std::pin::pin!(stream);
    let mut found_error = false;
    while let Some(result) = stream.next().await {
        if result.is_err() {
            found_error = true;
            break;
        }
    }
    assert!(found_error, "expected corruption error from stream");

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_blob_stream_drop_early() {
    let store = open_memory_store().await;
    let data = Bytes::from(make_data(4 * 1024 * 1024));
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data,
            Compression::Identity,
        )
        .await
        .unwrap();

    let stream = store
        .cas_get_blob_stream(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let mut stream = std::pin::pin!(stream);

    // Consume just one chunk, then drop
    let first = stream.next().await.unwrap().unwrap();
    assert!(!first.is_empty());
    drop(stream);

    // No panic — store is still usable
    assert!(
        store
            .cas_blob_exists(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
    );

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_blob_stream_empty_blob() {
    let store = open_memory_store().await;

    let empty = Bytes::new();
    let hash = sha256(&empty);
    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            empty,
            Compression::Identity,
        )
        .await
        .unwrap();

    let stream = store
        .cas_get_blob_stream(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let mut stream = std::pin::pin!(stream);

    // Empty blob is stored as a single zero-length chunk in the manifest,
    // so streaming reassembly should produce empty data.
    let mut reassembled = BytesMut::new();
    while let Some(chunk) = stream.next().await {
        reassembled.put(chunk.unwrap());
    }
    assert!(reassembled.is_empty());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_blob_stream_middle_chunk_corruption() {
    let store = open_memory_store().await;
    // Use data with high entropy so CDC produces chunks with distinct hashes.
    // make_data's deterministic pattern can produce identical chunks, so we
    // concatenate multiple differently-seeded segments.
    let mut raw = Vec::with_capacity(8 * 1024 * 1024);
    for seg in 0u32..8 {
        let offset = seg as usize * 1024 * 1024;
        for i in 0..(1024 * 1024) {
            let v = (i ^ (seg as usize * 7919))
                .wrapping_mul(251)
                .wrapping_add(offset + i);
            raw.push((v & 0xFF) as u8);
        }
    }
    let data = Bytes::from(raw);
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data,
            Compression::Identity,
        )
        .await
        .unwrap();

    // Find a non-first chunk with a unique hash (not shared with chunk 0)
    let (manifest, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let chunk_count = manifest.chunks.len();
    assert!(chunk_count >= 2, "need multiple chunks for this test");

    // Find a chunk whose hash differs from chunk[0]'s hash to avoid
    // corrupting chunk[0] via a shared content-addressed key.
    let target_idx = (1..chunk_count)
        .find(|&i| manifest.chunks[i].hash != manifest.chunks[0].hash)
        .expect("all chunks have identical hash — cannot test middle corruption");
    let target_key = prefixed_key(
        PREFIX_CHUNK,
        DigestFn::Sha256,
        &manifest.chunks[target_idx].hash,
    );
    let mut corrupted = vec![Compression::Identity as u8];
    corrupted.extend_from_slice(b"corrupted chunk data");
    store.db.put(&target_key, &corrupted).await.unwrap();

    // Stream should yield some successes then hit error at the corrupted chunk
    let stream = store
        .cas_get_blob_stream(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    let mut stream = std::pin::pin!(stream);
    let mut ok_count = 0;
    let mut found_error = false;
    while let Some(result) = stream.next().await {
        match result {
            Ok(_) => ok_count += 1,
            Err(_) => {
                found_error = true;
                break;
            }
        }
    }
    assert!(found_error, "expected corruption error from stream");
    assert!(
        ok_count > 0,
        "should have yielded chunk(s) before the corrupted one at index {target_idx}"
    );

    store.close().await.unwrap();
}

// =================================================================================================================
// CasBlobWriter tests
// =================================================================================================================

#[tokio::test]
async fn blob_writer_roundtrip() {
    let store = open_memory_store().await;
    let data = make_data(256 * 1024);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
    // Write in small pieces
    for chunk in data.chunks(4096) {
        writer.write(chunk).await.unwrap();
    }
    let (digest, total) = writer.finalize().await.unwrap();
    assert_eq!(total, data.len());

    let retrieved = store.cas_get_blob(&digest).await.unwrap().unwrap();
    assert_eq!(&retrieved[..], &data[..]);

    store.close().await.unwrap();
}

#[tokio::test]
async fn blob_writer_empty() {
    let store = open_memory_store().await;

    let writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
    let (digest, total) = writer.finalize().await.unwrap();
    assert_eq!(total, 0);

    // The hash should match the sha256 of empty data
    let expected_hash = sha256(b"");
    assert_eq!(digest.hash, expected_hash);

    store.close().await.unwrap();
}

#[tokio::test]
async fn blob_writer_hash_matches_digest_fn() {
    let store = open_memory_store().await;
    let data = make_data(100_000);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Zstd);
    writer.write(&data).await.unwrap();
    let (digest, _) = writer.finalize().await.unwrap();

    let expected = DigestFn::Sha256.hash_data(&data);
    assert_eq!(digest.hash, expected);

    // Verify it's readable
    let retrieved = store.cas_get_blob(&digest).await.unwrap().unwrap();
    assert_eq!(&retrieved[..], &data[..]);

    store.close().await.unwrap();
}

#[tokio::test]
async fn blob_writer_large_blob() {
    let store = open_memory_store().await;
    let data = make_data(4 * 1024 * 1024);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Zstd);
    // Write in 64 KiB pieces
    for chunk in data.chunks(65536) {
        writer.write(chunk).await.unwrap();
    }
    let (digest, total) = writer.finalize().await.unwrap();
    assert_eq!(total, data.len());

    let expected = DigestFn::Sha256.hash_data(&data);
    assert_eq!(digest.hash, expected);

    let retrieved = store.cas_get_blob(&digest).await.unwrap().unwrap();
    assert_eq!(&retrieved[..], &data[..]);

    store.close().await.unwrap();
}

#[tokio::test]
async fn blob_writer_blake3() {
    let store = open_memory_store().await;
    let data = make_data(200_000);

    let mut writer = store.cas_blob_writer(DigestFn::Blake3, Compression::Identity);
    writer.write(&data).await.unwrap();
    let (digest, _) = writer.finalize().await.unwrap();

    let expected = DigestFn::Blake3.hash_data(&data);
    assert_eq!(digest.hash, expected);

    let retrieved = store.cas_get_blob(&digest).await.unwrap().unwrap();
    assert_eq!(&retrieved[..], &data[..]);

    store.close().await.unwrap();
}

// =================================================================================================================
// CasBlobWriter: SHA256TREE digest
// =================================================================================================================

#[tokio::test]
async fn blob_writer_sha256tree() {
    let store = open_memory_store().await;
    let data = make_data(128 * 1024);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256Tree, Compression::Zstd);
    for chunk in data.chunks(8192) {
        writer.write(chunk).await.unwrap();
    }
    let (digest, total) = writer.finalize().await.unwrap();
    assert_eq!(total, data.len());

    let expected = DigestFn::Sha256Tree.hash_data(&data);
    assert_eq!(digest.hash, expected);

    let retrieved = store.cas_get_blob(&digest).await.unwrap().unwrap();
    assert_eq!(&retrieved[..], &data[..]);

    store.close().await.unwrap();
}

// =================================================================================================================
// CasBlobWriter: exactly at SMALL_BLOB_THRESHOLD (CDC path in finalize)
// =================================================================================================================

#[tokio::test]
async fn blob_writer_exactly_at_threshold() {
    let store = open_memory_store().await;
    let data = make_data(SMALL_BLOB_THRESHOLD);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
    for chunk in data.chunks(65536) {
        writer.write(chunk).await.unwrap();
    }
    let (digest, total) = writer.finalize().await.unwrap();
    assert_eq!(total, data.len());

    let expected = DigestFn::Sha256.hash_data(&data);
    assert_eq!(digest.hash, expected);

    // At exactly SMALL_BLOB_THRESHOLD, the finalize CDC path runs (not the small
    // blob path). CDC may still produce a single chunk if data fits within CDC_MAX_SIZE.
    let (manifest, _) = store.cas_get_manifest(&digest).await.unwrap().unwrap();
    assert!(manifest.chunks.len() >= 1);
    let total: u64 = manifest.chunks.iter().map(|c| c.size).sum();
    assert_eq!(total, data.len() as u64);

    let retrieved = store.cas_get_blob(&digest).await.unwrap().unwrap();
    assert_eq!(&retrieved[..], &data[..]);

    store.close().await.unwrap();
}

// =================================================================================================================
// CasBlobWriter: empty blob is readable
// =================================================================================================================

#[tokio::test]
async fn blob_writer_empty_readable() {
    let store = open_memory_store().await;

    let writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
    let (digest, total) = writer.finalize().await.unwrap();
    assert_eq!(total, 0);

    let retrieved = store.cas_get_blob(&digest).await.unwrap().unwrap();
    assert!(retrieved.is_empty());

    store.close().await.unwrap();
}

// =================================================================================================================
// finalize_verified tests
// =================================================================================================================

#[tokio::test]
async fn finalize_verified_correct_digest_succeeds() {
    let store = open_memory_store().await;
    let data = b"finalize verified test data";
    let hash = sha256(data);
    let cd = ContentDigest::new(DigestFn::Sha256, hash);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
    writer.write(data).await.unwrap();
    let (digest, total) = writer.finalize_verified(&cd).await.unwrap();
    assert_eq!(total, data.len());
    assert_eq!(digest.hash, hash);

    let retrieved = store.cas_get_blob(&cd).await.unwrap().unwrap();
    assert_eq!(&*retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn finalize_verified_wrong_digest_rejects_without_commit() {
    let store = open_memory_store().await;
    let data = b"finalize verified wrong hash test";
    let wrong_hash = sha256(b"totally different data");
    let wrong_cd = ContentDigest::new(DigestFn::Sha256, wrong_hash);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
    writer.write(data).await.unwrap();
    let result = writer.finalize_verified(&wrong_cd).await;
    assert!(
        matches!(result, Err(StoreError::DigestMismatch { .. })),
        "expected DigestMismatch, got {:?}",
        result,
    );

    // Blob should NOT exist under the wrong hash
    assert!(!store.cas_blob_exists(&wrong_cd).await.unwrap());
    // Blob should also NOT exist under the correct hash (never committed)
    let correct_hash = sha256(data);
    let correct_cd = ContentDigest::new(DigestFn::Sha256, correct_hash);
    assert!(!store.cas_blob_exists(&correct_cd).await.unwrap());

    store.close().await.unwrap();
}

#[tokio::test]
async fn finalize_verified_wrong_digest_large_blob() {
    let store = open_memory_store().await;
    // Data larger than SMALL_BLOB_THRESHOLD (2 MiB) to exercise CDC path
    let data = make_data(3 * 1024 * 1024);
    let wrong_hash = sha256(b"wrong hash for large blob");
    let wrong_cd = ContentDigest::new(DigestFn::Sha256, wrong_hash);

    let mut writer = store.cas_blob_writer(DigestFn::Sha256, Compression::Identity);
    writer.write(&data).await.unwrap();
    let result = writer.finalize_verified(&wrong_cd).await;
    assert!(
        matches!(result, Err(StoreError::DigestMismatch { .. })),
        "expected DigestMismatch, got {:?}",
        result,
    );

    assert!(!store.cas_blob_exists(&wrong_cd).await.unwrap());

    store.close().await.unwrap();
}
