// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

// =================================================================================================================
// Chunk-level API tests
// =================================================================================================================

#[tokio::test]
async fn chunk_put_get_roundtrip() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"chunk data here");
    let hash = sha256(&data);

    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_chunk(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn chunk_get_nonexistent_returns_none() {
    let store = open_memory_store().await;
    let hash = [0x99; 32];
    assert!(
        store
            .cas_get_chunk(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn chunk_exists_true_and_false() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"test chunk");
    let hash = sha256(&data);

    assert!(
        !store
            .cas_chunk_exists(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
    );
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data,
            Compression::Identity,
        )
        .await
        .unwrap();
    assert!(
        store
            .cas_chunk_exists(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
    );

    store.close().await.unwrap();
}

#[tokio::test]
async fn chunk_put_empty_data() {
    let store = open_memory_store().await;
    let data = Bytes::new();
    let hash = sha256(&data);

    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    let retrieved = store
        .cas_get_chunk(&ContentDigest::new(DigestFn::Sha256, hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, data);

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_get_chunk_detects_corruption() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"chunk data for corruption test");
    let hash = sha256(&data);

    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data,
            Compression::Identity,
        )
        .await
        .unwrap();

    // Tamper with the stored chunk by writing a valid compression tag
    // followed by garbage data directly to the chunk key
    let chunk_key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &hash);
    let mut corrupted = vec![Compression::Identity as u8]; // valid tag
    corrupted.extend_from_slice(b"corrupted data");
    store.db.put(&chunk_key, &corrupted).await.unwrap();

    let result = store
        .cas_get_chunk(&ContentDigest::new(DigestFn::Sha256, hash))
        .await;
    assert!(matches!(result, Err(StoreError::DigestMismatch { .. })));

    store.close().await.unwrap();
}

// =================================================================================================================
// Manifest-level API tests (store operations)
// =================================================================================================================

#[tokio::test]
async fn manifest_put_get_roundtrip() {
    let store = open_memory_store().await;
    let blob_hash = [0x11; 32];
    let manifest = BlobManifest {
        chunks: vec![
            ChunkInfo {
                hash: [0xAA; 32],
                size: 500,
            },
            ChunkInfo {
                hash: [0xBB; 32],
                size: 600,
            },
        ],
        created_at: 0,
    };

    store
        .cas_put_manifest(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            &manifest,
            Compression::Identity,
        )
        .await
        .unwrap();
    let (retrieved, comp) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(comp, Compression::Identity);
    assert_eq!(retrieved.chunks.len(), 2);
    assert_eq!(retrieved.chunks[0].hash, [0xAA; 32]);
    assert_eq!(retrieved.chunks[0].size, 500);
    assert_eq!(retrieved.chunks[1].hash, [0xBB; 32]);
    assert_eq!(retrieved.chunks[1].size, 600);

    store.close().await.unwrap();
}

#[tokio::test]
async fn manifest_get_nonexistent_returns_none() {
    let store = open_memory_store().await;
    let hash = [0x22; 32];
    assert!(
        store
            .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, hash))
            .await
            .unwrap()
            .is_none()
    );
    store.close().await.unwrap();
}

#[tokio::test]
async fn manifest_overwrite() {
    let store = open_memory_store().await;
    let blob_hash = [0x33; 32];

    let m1 = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0x01; 32],
            size: 100,
        }],
        created_at: 0,
    };
    store
        .cas_put_manifest(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            &m1,
            Compression::Identity,
        )
        .await
        .unwrap();

    let m2 = BlobManifest {
        chunks: vec![
            ChunkInfo {
                hash: [0x02; 32],
                size: 200,
            },
            ChunkInfo {
                hash: [0x03; 32],
                size: 300,
            },
        ],
        created_at: 0,
    };
    store
        .cas_put_manifest(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            &m2,
            Compression::Identity,
        )
        .await
        .unwrap();

    let (retrieved, _) = store
        .cas_get_manifest(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved.chunks.len(), 2);
    assert_eq!(retrieved.chunks[0].hash, [0x02; 32]);

    store.close().await.unwrap();
}

// =================================================================================================================
// SpliceBlob simulation
// =================================================================================================================

#[tokio::test]
async fn splice_blob_simulation() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from_static(b"first chunk of data");
    let chunk2 = Bytes::from_static(b"second chunk of data");
    let chunk3 = Bytes::from_static(b"third and final chunk");

    let hash1 = sha256(&chunk1);
    let hash2 = sha256(&chunk2);
    let hash3 = sha256(&chunk3);

    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash1),
            chunk1.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash2),
            chunk2.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash3),
            chunk3.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    let mut full_data = BytesMut::new();
    full_data.put(chunk1.clone());
    full_data.put(chunk2.clone());
    full_data.put(chunk3.clone());
    let blob_hash = sha256(&full_data);

    let manifest = BlobManifest {
        chunks: vec![
            ChunkInfo {
                hash: hash1,
                size: chunk1.len() as u64,
            },
            ChunkInfo {
                hash: hash2,
                size: chunk2.len() as u64,
            },
            ChunkInfo {
                hash: hash3,
                size: chunk3.len() as u64,
            },
        ],
        created_at: 0,
    };
    store
        .cas_put_manifest(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            &manifest,
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full_data.freeze());
    assert!(
        store
            .cas_blob_exists(&ContentDigest::new(DigestFn::Sha256, blob_hash))
            .await
            .unwrap()
    );

    store.close().await.unwrap();
}

#[tokio::test]
async fn splice_blob_with_zstd_compression() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from(vec![0xAA; 1024]);
    let chunk2 = Bytes::from(vec![0xBB; 2048]);
    let chunk3 = Bytes::from(vec![0xCC; 512]);

    let hash1 = sha256(&chunk1);
    let hash2 = sha256(&chunk2);
    let hash3 = sha256(&chunk3);

    // Upload chunks with Zstd compression
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash1),
            chunk1.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash2),
            chunk2.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash3),
            chunk3.clone(),
            Compression::Zstd,
        )
        .await
        .unwrap();

    let mut full_data = BytesMut::new();
    full_data.put(chunk1.clone());
    full_data.put(chunk2.clone());
    full_data.put(chunk3.clone());
    let blob_hash = sha256(&full_data);

    let manifest = BlobManifest {
        chunks: vec![
            ChunkInfo {
                hash: hash1,
                size: chunk1.len() as u64,
            },
            ChunkInfo {
                hash: hash2,
                size: chunk2.len() as u64,
            },
            ChunkInfo {
                hash: hash3,
                size: chunk3.len() as u64,
            },
        ],
        created_at: 0,
    };
    store
        .cas_put_manifest(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            &manifest,
            Compression::Zstd,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full_data.freeze());

    store.close().await.unwrap();
}

#[tokio::test]
async fn splice_blob_with_brotli_compression() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from(vec![0x11; 800]);
    let chunk2 = Bytes::from(vec![0x22; 1600]);

    let hash1 = sha256(&chunk1);
    let hash2 = sha256(&chunk2);

    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash1),
            chunk1.clone(),
            Compression::Brotli,
        )
        .await
        .unwrap();
    store
        .cas_put_chunk(
            &ContentDigest::new(DigestFn::Sha256, hash2),
            chunk2.clone(),
            Compression::Brotli,
        )
        .await
        .unwrap();

    let mut full_data = BytesMut::new();
    full_data.put(chunk1.clone());
    full_data.put(chunk2.clone());
    let blob_hash = sha256(&full_data);

    let manifest = BlobManifest {
        chunks: vec![
            ChunkInfo {
                hash: hash1,
                size: chunk1.len() as u64,
            },
            ChunkInfo {
                hash: hash2,
                size: chunk2.len() as u64,
            },
        ],
        created_at: 0,
    };
    store
        .cas_put_manifest(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            &manifest,
            Compression::Brotli,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full_data.freeze());

    store.close().await.unwrap();
}

// =================================================================================================================
// Atomic splice blob tests
// =================================================================================================================

#[tokio::test]
async fn cas_splice_blob_atomic() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from_static(b"first chunk of atomic splice");
    let chunk2 = Bytes::from_static(b"second chunk of atomic splice");

    let hash1 = sha256(&chunk1);
    let hash2 = sha256(&chunk2);

    let mut full_data = BytesMut::new();
    full_data.put(chunk1.clone());
    full_data.put(chunk2.clone());
    let blob_hash = sha256(&full_data);

    store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            vec![
                (ContentDigest::new(DigestFn::Sha256, hash1), chunk1.clone()),
                (ContentDigest::new(DigestFn::Sha256, hash2), chunk2.clone()),
            ],
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full_data.freeze());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_splice_blob_with_compression() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from(vec![0xAA; 1024]);
    let chunk2 = Bytes::from(vec![0xBB; 2048]);

    let hash1 = sha256(&chunk1);
    let hash2 = sha256(&chunk2);

    let mut full_data = BytesMut::new();
    full_data.put(chunk1.clone());
    full_data.put(chunk2.clone());
    let blob_hash = sha256(&full_data);

    store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            vec![
                (ContentDigest::new(DigestFn::Sha256, hash1), chunk1),
                (ContentDigest::new(DigestFn::Sha256, hash2), chunk2),
            ],
            Compression::Zstd,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full_data.freeze());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_splice_blob_wrong_chunk_hash_rejected() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from_static(b"correct chunk");
    let hash1 = sha256(&chunk1);
    let wrong_hash = sha256(b"wrong");

    let blob_hash = [0x42; 32];
    let result = store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            vec![
                (ContentDigest::new(DigestFn::Sha256, hash1), chunk1),
                (
                    ContentDigest::new(DigestFn::Sha256, wrong_hash),
                    Bytes::from_static(b"different"),
                ),
            ],
            Compression::Identity,
        )
        .await;
    assert!(matches!(result, Err(StoreError::DigestMismatch { .. })));

    store.close().await.unwrap();
}

// =================================================================================================================
// SplitBlob simulation
// =================================================================================================================

#[tokio::test]
async fn split_blob_simulation() {
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
    assert!(manifest.chunks.len() > 1);

    // With identity compression, raw chunks match the original data slices
    let mut offset = 0;
    for chunk_info in &manifest.chunks {
        let chunk_data = store
            .cas_get_chunk(&ContentDigest::new(DigestFn::Sha256, chunk_info.hash))
            .await
            .unwrap()
            .unwrap();
        assert_eq!(chunk_data.len(), chunk_info.size as usize);
        assert_eq!(
            chunk_data.as_ref(),
            &data[offset..offset + chunk_data.len()]
        );
        offset += chunk_data.len();
    }
    assert_eq!(offset, data.len());

    store.close().await.unwrap();
}

// =================================================================================================================
// FastCDC 2020 test vectors
// =================================================================================================================

/// Parsed test vector entry from the fastcdc2020_test_vectors.txt file.
struct FastCdcVector {
    seed: u64,
    offset: usize,
    length: usize,
    sha256_hex: String,
    fingerprint: u64,
}

/// Parse the fastcdc2020 test vectors file into groups by seed.
fn parse_fastcdc_vectors(text: &str) -> Vec<FastCdcVector> {
    let mut vectors = Vec::new();
    let mut current_seed: u64 = 0;
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() {
            continue;
        }
        if line.starts_with("# Seed:") {
            current_seed = line.trim_start_matches("# Seed:").trim().parse().unwrap();
            continue;
        }
        if line.starts_with('#') {
            continue;
        }
        let parts: Vec<&str> = line.split('\t').collect();
        assert_eq!(
            parts.len(),
            4,
            "expected 4 tab-separated fields, got: {:?}",
            parts
        );
        vectors.push(FastCdcVector {
            seed: current_seed,
            offset: parts[0].parse().unwrap(),
            length: parts[1].parse().unwrap(),
            sha256_hex: parts[2].to_string(),
            fingerprint: parts[3].parse().unwrap(),
        });
    }
    vectors
}

#[test]
fn fastcdc2020_test_vectors() {
    // Load the test image (SekienAkashita.jpg) and vectors file via buck resources
    let image_path = buck_resources::get("src/tools/cache-server/storage/SekienAkashita.jpg")
        .expect("failed to locate SekienAkashita.jpg resource");
    let vectors_path =
        buck_resources::get("src/tools/cache-server/storage/fastcdc2020_test_vectors")
            .expect("failed to locate fastcdc2020 test vectors resource");

    let image_data = std::fs::read(&image_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", image_path.display(), e));
    let vectors_text = std::fs::read_to_string(&vectors_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", vectors_path.display(), e));

    // Verify the image hash matches the expected value
    let image_hash = hex::encode(Sha256::digest(&image_data));
    assert_eq!(
        image_hash, "d9e749d9367fc908876749d6502eb212fee88c9a94892fb07da5ef3ba8bc39ed",
        "SekienAkashita.jpg SHA256 mismatch"
    );
    assert_eq!(image_data.len(), 109466, "SekienAkashita.jpg size mismatch");

    let vectors = parse_fastcdc_vectors(&vectors_text);
    assert!(!vectors.is_empty(), "no test vectors parsed");

    // Group vectors by seed and test each group
    let mut seeds_tested = std::collections::HashSet::new();
    let mut i = 0;
    while i < vectors.len() {
        let seed = vectors[i].seed;
        let group_start = i;
        while i < vectors.len() && vectors[i].seed == seed {
            i += 1;
        }
        let group = &vectors[group_start..i];

        // Run FastCDC with these parameters (from the file header)
        let chunker = fastcdc::v2020::FastCDC::with_level_and_seed(
            &image_data,
            4096,  // min
            16384, // avg
            65535, // max
            fastcdc::v2020::Normalization::Level2,
            seed,
        );

        let chunks: Vec<_> = chunker.collect();
        assert_eq!(
            chunks.len(),
            group.len(),
            "seed {}: chunk count mismatch: got {}, expected {}",
            seed,
            chunks.len(),
            group.len(),
        );

        for (j, (chunk, expected)) in chunks.iter().zip(group.iter()).enumerate() {
            assert_eq!(
                chunk.offset, expected.offset,
                "seed {} chunk {}: offset mismatch",
                seed, j,
            );
            assert_eq!(
                chunk.length, expected.length,
                "seed {} chunk {}: length mismatch",
                seed, j,
            );
            // Verify chunk content SHA256
            let chunk_data = &image_data[chunk.offset..chunk.offset + chunk.length];
            let chunk_sha256 = hex::encode(Sha256::digest(chunk_data));
            assert_eq!(
                chunk_sha256, expected.sha256_hex,
                "seed {} chunk {}: SHA256 mismatch",
                seed, j,
            );
            // Verify gear hash fingerprint
            assert_eq!(
                chunk.hash, expected.fingerprint,
                "seed {} chunk {}: fingerprint mismatch",
                seed, j,
            );
        }

        seeds_tested.insert(seed);
    }
    assert!(
        seeds_tested.len() >= 2,
        "expected at least 2 seeds tested, got {}",
        seeds_tested.len()
    );
}

// =================================================================================================================
// Whole-blob hash verification in cas_splice_blob
// =================================================================================================================

#[tokio::test]
async fn cas_splice_blob_wrong_blob_hash_rejected() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from_static(b"first chunk");
    let chunk2 = Bytes::from_static(b"second chunk");
    let hash1 = sha256(&chunk1);
    let hash2 = sha256(&chunk2);

    // Provide valid chunks but a blob_hash that doesn't match their concatenation
    let wrong_blob_hash = sha256(b"not the concatenation");
    let result = store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256, wrong_blob_hash),
            vec![
                (ContentDigest::new(DigestFn::Sha256, hash1), chunk1),
                (ContentDigest::new(DigestFn::Sha256, hash2), chunk2),
            ],
            Compression::Identity,
        )
        .await;
    assert!(matches!(result, Err(StoreError::DigestMismatch { .. })));

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_splice_blob_correct_blob_hash_accepted() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from_static(b"chunk A");
    let chunk2 = Bytes::from_static(b"chunk B");
    let hash1 = sha256(&chunk1);
    let hash2 = sha256(&chunk2);

    let mut full = BytesMut::new();
    full.put(chunk1.clone());
    full.put(chunk2.clone());
    let blob_hash = sha256(&full);

    store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            vec![
                (ContentDigest::new(DigestFn::Sha256, hash1), chunk1),
                (ContentDigest::new(DigestFn::Sha256, hash2), chunk2),
            ],
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full.freeze());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_splice_blob_blake3() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from(vec![0xAA; 1024]);
    let chunk2 = Bytes::from(vec![0xBB; 2048]);

    let hash1 = DigestFn::Blake3.hash_data(&chunk1);
    let hash2 = DigestFn::Blake3.hash_data(&chunk2);

    let mut full = BytesMut::new();
    full.put(chunk1.clone());
    full.put(chunk2.clone());
    let blob_hash = DigestFn::Blake3.hash_data(&full);

    store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Blake3, blob_hash),
            vec![
                (ContentDigest::new(DigestFn::Blake3, hash1), chunk1),
                (ContentDigest::new(DigestFn::Blake3, hash2), chunk2),
            ],
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Blake3, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full.freeze());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_splice_blob_sha256tree() {
    let store = open_memory_store().await;

    let chunk1 = Bytes::from(vec![0x11; 2048]);
    let chunk2 = Bytes::from(vec![0x22; 4096]);

    let hash1 = DigestFn::Sha256Tree.hash_data(&chunk1);
    let hash2 = DigestFn::Sha256Tree.hash_data(&chunk2);

    let mut full = BytesMut::new();
    full.put(chunk1.clone());
    full.put(chunk2.clone());
    let blob_hash = DigestFn::Sha256Tree.hash_data(&full);

    store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256Tree, blob_hash),
            vec![
                (ContentDigest::new(DigestFn::Sha256Tree, hash1), chunk1),
                (ContentDigest::new(DigestFn::Sha256Tree, hash2), chunk2),
            ],
            Compression::Zstd,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256Tree, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full.freeze());

    store.close().await.unwrap();
}

// =================================================================================================================
// Splice edge cases
// =================================================================================================================

#[tokio::test]
async fn cas_splice_blob_empty() {
    let store = open_memory_store().await;

    let empty_hash = sha256(b"");
    store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256, empty_hash),
            vec![],
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, empty_hash))
        .await
        .unwrap()
        .unwrap();
    assert!(retrieved.is_empty());

    store.close().await.unwrap();
}

#[tokio::test]
async fn cas_splice_blob_duplicate_chunk_digests() {
    let store = open_memory_store().await;

    let chunk = Bytes::from_static(b"hello chunk");
    let chunk_hash = sha256(&chunk);

    let mut full = BytesMut::new();
    full.put(chunk.clone());
    full.put(chunk.clone());
    let blob_hash = sha256(&full);

    store
        .cas_splice_blob(
            &ContentDigest::new(DigestFn::Sha256, blob_hash),
            vec![
                (
                    ContentDigest::new(DigestFn::Sha256, chunk_hash),
                    chunk.clone(),
                ),
                (ContentDigest::new(DigestFn::Sha256, chunk_hash), chunk),
            ],
            Compression::Identity,
        )
        .await
        .unwrap();

    let retrieved = store
        .cas_get_blob(&ContentDigest::new(DigestFn::Sha256, blob_hash))
        .await
        .unwrap()
        .unwrap();
    assert_eq!(retrieved, full.freeze());

    store.close().await.unwrap();
}
