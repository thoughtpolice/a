// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::*;
use futures::StreamExt;
use sha2::{Digest as _, Sha256};

/// Helper: open an in-memory CacheStore for testing.
async fn open_memory_store() -> CacheStore {
    CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
        .await
        .unwrap()
}

/// Helper: SHA-256 hash of data.
fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Helper: generate deterministic data of a given size. Uses a simple
/// pattern that's repeatable but not fully uniform (so CDC can find
/// cut points in large blobs).
fn make_data(size: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(size);
    for i in 0..size {
        // Mix multiple periods to avoid degenerate CDC behavior
        data.push(((i.wrapping_mul(251).wrapping_add(i >> 8)) & 0xFF) as u8);
    }
    data
}

// =================================================================================================================
// DigestFn tests
// =================================================================================================================

#[test]
fn digest_fn_sha256_matches_sha2_crate() {
    let data = b"hello, world!";
    let expected: [u8; 32] = Sha256::digest(data).into();
    assert_eq!(DigestFn::Sha256.hash_data(data), expected);
}

#[test]
fn digest_fn_blake3_matches_blake3_crate() {
    let data = b"hello, world!";
    let expected = *blake3::hash(data).as_bytes();
    assert_eq!(DigestFn::Blake3.hash_data(data), expected);
}

#[test]
fn digest_fn_proto_roundtrip() {
    for df in [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree] {
        let proto_val = df.to_proto_i32();
        let back = DigestFn::from_proto_i32(proto_val).unwrap();
        assert_eq!(back, df);
    }
}

#[test]
fn digest_fn_from_proto_unsupported() {
    assert!(DigestFn::from_proto_i32(0).is_none()); // UNKNOWN
    assert!(DigestFn::from_proto_i32(2).is_none()); // SHA1
    assert!(DigestFn::from_proto_i32(99).is_none());
}

#[test]
fn digest_fn_str_roundtrip() {
    for df in [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree] {
        let s = df.as_str();
        let back = DigestFn::from_str_name(s).unwrap();
        assert_eq!(back, df);
    }
}

#[test]
fn digest_fn_from_str_case_insensitive() {
    assert_eq!(DigestFn::from_str_name("SHA256"), Some(DigestFn::Sha256));
    assert_eq!(DigestFn::from_str_name("Blake3"), Some(DigestFn::Blake3));
    assert_eq!(
        DigestFn::from_str_name("SHA256TREE"),
        Some(DigestFn::Sha256Tree)
    );
}

#[test]
fn digest_fn_from_str_unknown() {
    assert!(DigestFn::from_str_name("md5").is_none());
    assert!(DigestFn::from_str_name("").is_none());
}

#[test]
fn digest_fn_unique_discriminators() {
    let variants = [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree];
    for (i, a) in variants.iter().enumerate() {
        for (j, b) in variants.iter().enumerate() {
            if i != j {
                assert_ne!(*a as u8, *b as u8, "discriminator collision");
            }
        }
    }
}

// =================================================================================================================
// SHA256TREE tests
// =================================================================================================================

#[test]
fn sha256tree_small_data_matches_sha256() {
    let data = b"small data for tree hashing";
    assert!(data.len() <= SHA256TREE_LEAF_SIZE);
    let sha256_hash: [u8; 32] = Sha256::digest(data).into();
    let tree_hash = sha256tree_hash(data);
    assert_eq!(tree_hash, sha256_hash);
}

#[test]
fn sha256tree_exactly_1024_bytes_matches_sha256() {
    let data = vec![0x42u8; 1024];
    let sha256_hash: [u8; 32] = Sha256::digest(&data).into();
    let tree_hash = sha256tree_hash(&data);
    assert_eq!(tree_hash, sha256_hash);
}

#[test]
fn sha256tree_large_data_differs_from_sha256() {
    let data = vec![0xAB; 2048];
    let sha256_hash: [u8; 32] = Sha256::digest(&data).into();
    let tree_hash = sha256tree_hash(&data);
    assert_ne!(tree_hash, sha256_hash);
}

#[test]
fn sha256tree_deterministic() {
    let data = vec![0xCD; 4096];
    let hash1 = sha256tree_hash(&data);
    let hash2 = sha256tree_hash(&data);
    assert_eq!(hash1, hash2);
}

#[test]
fn sha256tree_different_data_different_hash() {
    let data1 = vec![0x00; 2048];
    let data2 = vec![0xFF; 2048];
    assert_ne!(sha256tree_hash(&data1), sha256tree_hash(&data2));
}

#[test]
fn sha256tree_empty_matches_sha256() {
    let data = b"";
    let sha256_hash: [u8; 32] = Sha256::digest(data).into();
    let tree_hash = sha256tree_hash(data);
    assert_eq!(tree_hash, sha256_hash);
}

#[test]
fn sha256tree_1025_bytes_uses_tree_structure() {
    // 1025 bytes > 1024 threshold, so tree hashing kicks in.
    // Split point: largest power-of-2 < 1025 = 1024.
    // Left = data[..1024] (plain SHA-256), Right = data[1024..] (1 byte, plain SHA-256).
    // Combined via sha256_block_cipher with SHA256TREE_IV.
    let data = vec![0x61; 1025]; // 'a' repeated
    let left_hash: [u8; 32] = Sha256::digest(&data[..1024]).into();
    let right_hash: [u8; 32] = Sha256::digest(&data[1024..]).into();

    let mut block = [0u8; 64];
    block[..32].copy_from_slice(&left_hash);
    block[32..].copy_from_slice(&right_hash);
    let expected_words = sha256_block_cipher(&SHA256TREE_IV, &block);
    let mut expected = [0u8; 32];
    for (i, &word) in expected_words.iter().enumerate() {
        expected[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }

    let actual = sha256tree_hash(&data);
    assert_eq!(
        actual, expected,
        "SHA256TREE hash for 1025 bytes of 0x61 mismatch"
    );
}

#[test]
fn sha256tree_2048_bytes_known_vector() {
    // 2048 bytes: split at 1024.
    // Both halves are exactly 1024 bytes, so each is plain SHA-256.
    let data = vec![0x00; 2048];
    let left_hash: [u8; 32] = Sha256::digest(&data[..1024]).into();
    let right_hash: [u8; 32] = Sha256::digest(&data[1024..]).into();
    // Both halves are identical, so left_hash == right_hash
    assert_eq!(left_hash, right_hash);

    let hash = sha256tree_hash(&data);
    // The tree hash should differ from both plain SHA-256 and from the leaf hash
    let plain_sha256: [u8; 32] = Sha256::digest(&data).into();
    assert_ne!(hash, plain_sha256);
    assert_eq!(hash.len(), 32);
}

#[test]
fn sha256tree_3000_bytes_recursive_split() {
    // 3000 bytes: split at 2048 (largest power-of-2 < 3000).
    // Left = data[..2048] (> 1024, recurse), Right = data[2048..] (952 bytes, leaf).
    let data: Vec<u8> = (0..3000).map(|i| (i % 256) as u8).collect();
    let hash = sha256tree_hash(&data);

    // Manually compute: left subtree splits at 1024
    let left_left: [u8; 32] = Sha256::digest(&data[..1024]).into();
    let left_right: [u8; 32] = Sha256::digest(&data[1024..2048]).into();
    let mut left_block = [0u8; 64];
    left_block[..32].copy_from_slice(&left_left);
    left_block[32..].copy_from_slice(&left_right);
    let left_words = sha256_block_cipher(&SHA256TREE_IV, &left_block);
    let mut left_hash = [0u8; 32];
    for (i, &w) in left_words.iter().enumerate() {
        left_hash[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }

    let right_hash: [u8; 32] = Sha256::digest(&data[2048..]).into();

    let mut root_block = [0u8; 64];
    root_block[..32].copy_from_slice(&left_hash);
    root_block[32..].copy_from_slice(&right_hash);
    let root_words = sha256_block_cipher(&SHA256TREE_IV, &root_block);
    let mut expected = [0u8; 32];
    for (i, &w) in root_words.iter().enumerate() {
        expected[i * 4..i * 4 + 4].copy_from_slice(&w.to_be_bytes());
    }

    assert_eq!(
        hash, expected,
        "SHA256TREE recursive split mismatch for 3000 bytes"
    );
}

#[test]
fn sha256tree_reapi_spec_test_vectors() {
    // Official test vectors from the REAPI spec:
    // https://github.com/bazelbuild/remote-apis/blob/main/build/bazel/remote/execution/v2/sha256tree_test_vectors.txt
    //
    // Each vector: hash of a repeating sequence 0, 1, 2, ..., 250, 0, 1, ... of given length.
    let vectors_path =
        buck_resources::get("src/tools/cache-server/storage/sha256tree_test_vectors")
            .expect("failed to locate sha256tree test vectors resource");
    let vectors_text = std::fs::read_to_string(&vectors_path)
        .unwrap_or_else(|e| panic!("failed to read {}: {}", vectors_path.display(), e));
    let mut tested = 0;
    for line in vectors_text.lines() {
        let line: &str = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let mut parts = line.split_whitespace();
        let length: usize = parts.next().unwrap().parse().unwrap();
        let expected_hex = parts.next().unwrap();
        let expected = parse_digest_hash(expected_hex)
            .unwrap_or_else(|| panic!("invalid hex in test vector: {}", expected_hex));

        // Generate the repeating 0..250 sequence
        let data: Vec<u8> = (0..length).map(|i| (i % 251) as u8).collect();
        let actual = sha256tree_hash(&data);
        assert_eq!(
            actual,
            expected,
            "SHA256TREE mismatch for length {}: got {}, expected {}",
            length,
            hex::encode(actual),
            expected_hex,
        );
        tested += 1;
    }
    assert!(
        tested >= 18,
        "expected at least 18 test vectors, got {}",
        tested
    );
}

#[test]
fn sha256tree_power_of_2_sizes() {
    for &size in &[2048, 4096, 8192] {
        let data = vec![0xAA; size];
        let hash = sha256tree_hash(&data);
        assert_eq!(hash.len(), 32);
    }
}

#[test]
fn incremental_hasher_sha256tree_matches_direct() {
    // Verify IncrementalHasher produces identical results to sha256tree_hash
    // for various sizes including REAPI test vector edge cases.
    let sizes = [
        0, 1, 512, 1023, 1024, 1025, 2048, 2049, 3000, 4096, 8192, 10000, 65536,
    ];
    for &size in &sizes {
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let expected = sha256tree_hash(&data);

        // Feed all at once
        let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
        h.update(&data);
        assert_eq!(
            h.finalize(),
            expected,
            "all-at-once mismatch for size {}",
            size
        );

        // Feed byte by byte
        let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
        for &b in &data {
            h.update(core::slice::from_ref(&b));
        }
        assert_eq!(
            h.finalize(),
            expected,
            "byte-by-byte mismatch for size {}",
            size
        );

        // Feed in 7-byte chunks (non-aligned with leaf size)
        let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
        for chunk in data.chunks(7) {
            h.update(chunk);
        }
        assert_eq!(
            h.finalize(),
            expected,
            "7-byte chunk mismatch for size {}",
            size
        );

        // Feed in 1024-byte chunks (aligned with leaf size)
        let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
        for chunk in data.chunks(1024) {
            h.update(chunk);
        }
        assert_eq!(
            h.finalize(),
            expected,
            "1024-byte chunk mismatch for size {}",
            size
        );
    }
}

#[test]
fn incremental_hasher_sha256tree_empty_blob() {
    let expected = sha256tree_hash(&[]);
    let empty_sha256: [u8; 32] = Sha256::digest(&[]).into();
    assert_eq!(
        expected, empty_sha256,
        "sha256tree of empty data should equal SHA-256 of empty data"
    );

    let h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
    assert_eq!(
        h.finalize(),
        expected,
        "incremental hasher empty blob mismatch"
    );

    // Also verify update with empty slice doesn't break it
    let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
    h.update(&[]);
    assert_eq!(
        h.finalize(),
        expected,
        "incremental hasher after empty update mismatch"
    );
}

// =================================================================================================================
// Compression tests
// =================================================================================================================

#[test]
fn compression_proto_roundtrip() {
    for c in [
        Compression::Identity,
        Compression::Zstd,
        Compression::Deflate,
        Compression::Brotli,
    ] {
        let proto_val = c.to_proto_i32();
        let back = Compression::from_proto_i32(proto_val).unwrap();
        assert_eq!(back, c);
    }
}

#[test]
fn compression_from_proto_unsupported() {
    assert!(Compression::from_proto_i32(4).is_none());
    assert!(Compression::from_proto_i32(99).is_none());
    assert!(Compression::from_proto_i32(-1).is_none());
}

#[test]
fn compression_from_u8_roundtrip() {
    for c in [
        Compression::Identity,
        Compression::Zstd,
        Compression::Deflate,
        Compression::Brotli,
    ] {
        let byte = c as u8;
        let back = Compression::from_u8(byte).unwrap();
        assert_eq!(back, c);
    }
}

#[test]
fn compression_from_u8_unsupported() {
    assert!(Compression::from_u8(4).is_none());
    assert!(Compression::from_u8(255).is_none());
}

#[test]
fn compression_identity_roundtrip() {
    let data = b"identity test data";
    let compressed = Compression::Identity.compress(data).unwrap();
    assert_eq!(&*compressed, &data[..]);
    let decompressed = Compression::Identity.decompress(&compressed).unwrap();
    assert_eq!(&*decompressed, &data[..]);
}

#[test]
fn compression_identity_borrows_without_copy() {
    let data = b"this should be borrowed, not copied";
    let compressed = Compression::Identity.compress(data).unwrap();
    assert!(matches!(compressed, Cow::Borrowed(_)));
    let decompressed = Compression::Identity.decompress(data).unwrap();
    assert!(matches!(decompressed, Cow::Borrowed(_)));
}

#[test]
fn compression_zstd_roundtrip() {
    let data = b"zstd test data that should compress well when repeated zstd test data";
    let compressed = Compression::Zstd.compress(data).unwrap();
    let decompressed = Compression::Zstd.decompress(&compressed).unwrap();
    assert_eq!(&*decompressed, &data[..]);
}

#[test]
fn compression_deflate_roundtrip() {
    let data = b"deflate test data that should compress well when repeated";
    let compressed = Compression::Deflate.compress(data).unwrap();
    let decompressed = Compression::Deflate.decompress(&compressed).unwrap();
    assert_eq!(&*decompressed, &data[..]);
}

#[test]
fn compression_brotli_roundtrip() {
    let data = b"brotli test data that should compress well when repeated";
    let compressed = Compression::Brotli.compress(data).unwrap();
    let decompressed = Compression::Brotli.decompress(&compressed).unwrap();
    assert_eq!(&*decompressed, &data[..]);
}

#[test]
fn compression_empty_data() {
    for c in [
        Compression::Identity,
        Compression::Zstd,
        Compression::Deflate,
        Compression::Brotli,
    ] {
        let compressed = c.compress(b"").unwrap();
        let decompressed = c.decompress(&compressed).unwrap();
        assert_eq!(
            &*decompressed, b"",
            "empty data roundtrip failed for {:?}",
            c
        );
    }
}

#[test]
fn compression_large_data() {
    let data = make_data(1024 * 1024); // 1 MiB
    for c in [Compression::Zstd, Compression::Deflate, Compression::Brotli] {
        let compressed = c.compress(&data).unwrap();
        let decompressed = c.decompress(&compressed).unwrap();
        assert_eq!(
            &*decompressed,
            &data[..],
            "large data roundtrip failed for {:?}",
            c
        );
    }
}

#[test]
fn compression_actually_reduces_size() {
    // Highly compressible data: all zeros
    let data = vec![0u8; 65536];
    for c in [Compression::Zstd, Compression::Deflate, Compression::Brotli] {
        let compressed = c.compress(&data).unwrap();
        assert!(
            compressed.len() < data.len(),
            "{:?} did not reduce size: {} >= {}",
            c,
            compressed.len(),
            data.len()
        );
    }
}

#[test]
fn decompress_bomb_zstd_rejected() {
    // Compress a payload exceeding MAX_CHUNK_DECOMPRESSED_SIZE, then attempt
    // to decompress via `decompress()` (which clamps to the chunk limit).
    let data = vec![0u8; MAX_CHUNK_DECOMPRESSED_SIZE + 1];
    let compressed = Compression::Zstd.compress(&data).unwrap();
    // decompress() clamps to MAX_CHUNK_DECOMPRESSED_SIZE, so zstd will
    // reject it since the actual decompressed size is larger than the cap.
    let result = Compression::Zstd.decompress(&compressed);
    assert!(result.is_err());
    assert!(matches!(result, Err(StoreError::CompressionFailed(_))));

    // decompress_with_size_hint also clamps to MAX_CHUNK_DECOMPRESSED_SIZE,
    // so it rejects data exceeding the cap regardless of the hint.
    let result =
        Compression::Zstd.decompress_with_size_hint(&compressed, MAX_CHUNK_DECOMPRESSED_SIZE + 1);
    assert!(result.is_err());
    assert!(matches!(result, Err(StoreError::CompressionFailed(_))));
}

#[test]
fn manifest_chunk_count_overflow() {
    // Craft a manifest header claiming a chunk count that would overflow
    // the size calculation on 32-bit (count * 40 overflows)
    let mut buf = BytesMut::new();
    buf.put_u8(3); // version
    buf.put_u8(0); // identity compression
    buf.put_u64(0); // created_at
    buf.put_u32(u32::MAX); // absurdly large count
    let result = BlobManifest::from_bytes(buf.freeze());
    assert!(matches!(result, Err(StoreError::ManifestCorrupted(_))));
}

// =================================================================================================================
// Display / FromStr tests
// =================================================================================================================

#[test]
fn digest_fn_display() {
    assert_eq!(format!("{}", DigestFn::Sha256), "sha256");
    assert_eq!(format!("{}", DigestFn::Blake3), "blake3");
    assert_eq!(format!("{}", DigestFn::Sha256Tree), "sha256tree");
}

#[test]
fn digest_fn_from_str() {
    assert_eq!("sha256".parse::<DigestFn>().unwrap(), DigestFn::Sha256);
    assert_eq!("BLAKE3".parse::<DigestFn>().unwrap(), DigestFn::Blake3);
    assert_eq!(
        "Sha256Tree".parse::<DigestFn>().unwrap(),
        DigestFn::Sha256Tree
    );
    assert!("md5".parse::<DigestFn>().is_err());
}

#[test]
fn compression_display() {
    assert_eq!(format!("{}", Compression::Identity), "identity");
    assert_eq!(format!("{}", Compression::Zstd), "zstd");
    assert_eq!(format!("{}", Compression::Deflate), "deflate");
    assert_eq!(format!("{}", Compression::Brotli), "brotli");
}

#[test]
fn compression_from_str() {
    assert_eq!(
        "identity".parse::<Compression>().unwrap(),
        Compression::Identity
    );
    assert_eq!("ZSTD".parse::<Compression>().unwrap(), Compression::Zstd);
    assert_eq!(
        "Deflate".parse::<Compression>().unwrap(),
        Compression::Deflate
    );
    assert_eq!(
        "BROTLI".parse::<Compression>().unwrap(),
        Compression::Brotli
    );
    assert!("lz4".parse::<Compression>().is_err());
}

#[test]
fn compression_str_roundtrip() {
    for c in [
        Compression::Identity,
        Compression::Zstd,
        Compression::Deflate,
        Compression::Brotli,
    ] {
        let s = c.as_str();
        let back = Compression::from_str_name(s).unwrap();
        assert_eq!(back, c);
    }
}

// =================================================================================================================
// BlobManifest serialization tests (V2 with compression)
// =================================================================================================================

#[test]
fn manifest_v3_roundtrip_single_chunk() {
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xAB; 32],
            size: 1024,
        }],
        created_at: 1700000000,
    };
    let bytes = manifest.to_bytes(Compression::Identity).unwrap();
    assert_eq!(bytes.len(), 14 + 40); // V3 header + 1 entry
    let (decoded, comp) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(comp, Compression::Identity);
    assert_eq!(decoded.chunks.len(), 1);
    assert_eq!(decoded.chunks[0].hash, [0xAB; 32]);
    assert_eq!(decoded.chunks[0].size, 1024);
}

#[test]
fn manifest_v3_roundtrip_with_zstd() {
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xCC; 32],
            size: 2048,
        }],
        created_at: 0,
    };
    let bytes = manifest.to_bytes(Compression::Zstd).unwrap();
    let (decoded, comp) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(comp, Compression::Zstd);
    assert_eq!(decoded.chunks.len(), 1);
    assert_eq!(decoded.chunks[0].hash, [0xCC; 32]);
}

#[test]
fn manifest_v3_roundtrip_with_deflate() {
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xDD; 32],
            size: 4096,
        }],
        created_at: 0,
    };
    let bytes = manifest.to_bytes(Compression::Deflate).unwrap();
    let (decoded, comp) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(comp, Compression::Deflate);
    assert_eq!(decoded.chunks.len(), 1);
}

#[test]
fn manifest_v3_roundtrip_with_brotli() {
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xEE; 32],
            size: 8192,
        }],
        created_at: 0,
    };
    let bytes = manifest.to_bytes(Compression::Brotli).unwrap();
    let (decoded, comp) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(comp, Compression::Brotli);
    assert_eq!(decoded.chunks.len(), 1);
}

#[test]
fn manifest_v3_roundtrip_multiple_chunks() {
    let chunks: Vec<ChunkInfo> = (0..100)
        .map(|i| ChunkInfo {
            hash: {
                let mut h = [0u8; 32];
                h[0] = i as u8;
                h[31] = (i * 7) as u8;
                h
            },
            size: (i as u64 + 1) * 512,
        })
        .collect();
    let manifest = BlobManifest {
        chunks,
        created_at: 0,
    };
    let bytes = manifest.to_bytes(Compression::Zstd).unwrap();
    assert_eq!(bytes.len(), 14 + 100 * 40);
    let (decoded, comp) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(comp, Compression::Zstd);
    assert_eq!(decoded.chunks.len(), 100);
    for (i, chunk) in decoded.chunks.iter().enumerate() {
        assert_eq!(chunk.hash[0], i as u8);
        assert_eq!(chunk.hash[31], (i * 7) as u8);
        assert_eq!(chunk.size, (i as u64 + 1) * 512);
    }
}

#[test]
fn manifest_v3_roundtrip_empty() {
    let manifest = BlobManifest {
        chunks: vec![],
        created_at: 0,
    };
    let bytes = manifest.to_bytes(Compression::Identity).unwrap();
    assert_eq!(bytes.len(), 14); // V3 header (version + compression + created_at + count)
    let (decoded, comp) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(comp, Compression::Identity);
    assert_eq!(decoded.chunks.len(), 0);
}

#[test]
fn manifest_unknown_version_rejected() {
    // A V1-style manifest (first byte 0x00) should be rejected
    let mut buf = BytesMut::new();
    buf.put_u32(1); // looks like V1: first byte is 0x00
    buf.put_slice(&[0xDD; 32]);
    buf.put_u64(256);
    let result = BlobManifest::from_bytes(buf.freeze());
    assert!(matches!(result, Err(StoreError::ManifestCorrupted(_))));
}

#[test]
fn manifest_from_bytes_too_short() {
    let result = BlobManifest::from_bytes(Bytes::from_static(&[0, 0]));
    assert!(matches!(result, Err(StoreError::ManifestCorrupted(_))));
}

#[test]
fn manifest_v3_from_bytes_truncated() {
    // V3 header but truncated chunk entries
    let mut buf = BytesMut::new();
    buf.put_u8(3); // version
    buf.put_u8(1); // zstd
    buf.put_u64(1700000000); // created_at
    buf.put_u32(2); // claim 2 chunks
    buf.put_slice(&[0xCC; 32]); // hash
    buf.put_u64(100); // size -- only 1 entry, need 2
    let result = BlobManifest::from_bytes(buf.freeze());
    assert!(matches!(result, Err(StoreError::ManifestCorrupted(_))));
}

#[test]
fn manifest_v2_rejected() {
    // Old V2 manifests are no longer accepted
    let mut buf = BytesMut::new();
    buf.put_u8(2); // version 2
    buf.put_u8(0); // identity compression
    buf.put_u32(0); // zero chunks
    let result = BlobManifest::from_bytes(buf.freeze());
    assert!(matches!(result, Err(StoreError::ManifestCorrupted(_))));
}

#[test]
fn manifest_preserves_chunk_order() {
    let chunks: Vec<ChunkInfo> = (0u8..10)
        .map(|i| ChunkInfo {
            hash: {
                let mut h = [0u8; 32];
                h[0] = i;
                h
            },
            size: i as u64 * 100,
        })
        .collect();
    let manifest = BlobManifest {
        chunks,
        created_at: 0,
    };
    let (decoded, _) =
        BlobManifest::from_bytes(manifest.to_bytes(Compression::Identity).unwrap()).unwrap();
    for (i, chunk) in decoded.chunks.iter().enumerate() {
        assert_eq!(chunk.hash[0], i as u8, "chunk order not preserved at {}", i);
    }
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
// parse_digest_hash tests
// =================================================================================================================

#[test]
fn parse_digest_hash_valid() {
    let hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let result = parse_digest_hash(hex).unwrap();
    assert_eq!(result[0], 0xe3);
    assert_eq!(result[1], 0xb0);
    assert_eq!(result[31], 0x55);
}

#[test]
fn parse_digest_hash_all_zeros() {
    let hex = "0000000000000000000000000000000000000000000000000000000000000000";
    let result = parse_digest_hash(hex).unwrap();
    assert_eq!(result, [0u8; 32]);
}

#[test]
fn parse_digest_hash_all_ff() {
    let hex = "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff";
    let result = parse_digest_hash(hex).unwrap();
    assert_eq!(result, [0xFF; 32]);
}

#[test]
fn parse_digest_hash_too_short() {
    assert!(parse_digest_hash("abcd").is_none());
}

#[test]
fn parse_digest_hash_too_long() {
    let hex = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b85500";
    assert!(parse_digest_hash(hex).is_none());
}

#[test]
fn parse_digest_hash_invalid_hex() {
    let hex = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
    assert!(parse_digest_hash(hex).is_none());
}

#[test]
fn parse_digest_hash_empty() {
    assert!(parse_digest_hash("").is_none());
}

#[test]
fn parse_digest_hash_odd_length() {
    assert!(parse_digest_hash("abc").is_none());
}

#[test]
fn parse_digest_hash_uppercase() {
    let hex = "E3B0C44298FC1C149AFBF4C8996FB92427AE41E4649B934CA495991B7852B855";
    let result = parse_digest_hash(hex).unwrap();
    assert_eq!(result[0], 0xe3);
}

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
// Manifest-level API tests
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
// Digest verification on read tests
// =================================================================================================================

#[tokio::test]
async fn cas_get_blob_detects_corruption() {
    let store = open_memory_store().await;
    let data = Bytes::from_static(b"original data");
    let hash = sha256(&data);

    store
        .cas_put_blob(
            &ContentDigest::new(DigestFn::Sha256, hash),
            data.clone(),
            Compression::Identity,
        )
        .await
        .unwrap();

    // Tamper with the chunk directly in the DB (valid tag byte + corrupted data)
    let chunk_key = prefixed_key(PREFIX_CHUNK, DigestFn::Sha256, &hash);
    let mut corrupted = vec![Compression::Identity as u8];
    corrupted.extend_from_slice(b"tampered_data");
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
        CDC_MIN_SIZE as usize,
        CDC_AVG_SIZE as usize,
        CDC_MAX_SIZE as usize - 1,
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
    // Highly compressible data
    let data = Bytes::from(vec![0u8; 4096]);
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
// Decompression bomb protection tests
// =================================================================================================================

#[test]
fn decompress_bomb_deflate_rejected() {
    // Create data larger than MAX_CHUNK_DECOMPRESSED_SIZE that compresses small
    let data = vec![0u8; MAX_CHUNK_DECOMPRESSED_SIZE + 1];
    let compressed = Compression::Deflate.compress(&data).unwrap();
    // The compressed payload is small, but decompresses to > limit
    let result = Compression::Deflate.decompress(&compressed);
    assert!(result.is_err());
    assert!(matches!(result, Err(StoreError::CompressionFailed(_))));
}

#[test]
fn decompress_bomb_brotli_rejected() {
    let data = vec![0u8; MAX_CHUNK_DECOMPRESSED_SIZE + 1];
    let compressed = Compression::Brotli.compress(&data).unwrap();
    let result = Compression::Brotli.decompress(&compressed);
    assert!(result.is_err());
    assert!(matches!(result, Err(StoreError::CompressionFailed(_))));
}

#[test]
fn streaming_decompressor_zstd_enforces_limit() {
    let data = vec![0u8; 64 * 1024]; // 64 KiB of zeros
    let compressed = Compression::Zstd.compress(&data).unwrap().into_owned();
    let limit = 1024; // 1 KiB limit — much smaller than decompressed size
    let mut decompressor = Compression::Zstd.streaming_decompressor(limit).unwrap();
    let result = decompressor.write(&compressed);
    assert!(
        matches!(result, Err(StoreError::CompressionFailed(_))),
        "expected limit error, got {:?}",
        result,
    );
}

#[test]
fn streaming_decompressor_deflate_enforces_limit() {
    let data = vec![0u8; 64 * 1024];
    let compressed = Compression::Deflate.compress(&data).unwrap().into_owned();
    let limit = 1024;
    let mut decompressor = Compression::Deflate.streaming_decompressor(limit).unwrap();
    let result = decompressor.write(&compressed);
    assert!(
        matches!(result, Err(StoreError::CompressionFailed(_))),
        "expected limit error, got {:?}",
        result,
    );
}

#[test]
fn streaming_decompressor_brotli_enforces_limit() {
    let data = vec![0u8; 64 * 1024];
    let compressed = Compression::Brotli.compress(&data).unwrap().into_owned();
    let limit = 1024;
    let mut decompressor = Compression::Brotli.streaming_decompressor(limit).unwrap();
    let result = decompressor.write(&compressed);
    assert!(
        matches!(result, Err(StoreError::CompressionFailed(_))),
        "expected limit error, got {:?}",
        result,
    );
}

#[test]
fn decompress_with_hint_matches_decompress() {
    let data = b"test data for hint vs no-hint comparison";
    for c in [
        Compression::Identity,
        Compression::Zstd,
        Compression::Deflate,
        Compression::Brotli,
    ] {
        let compressed = c.compress(data).unwrap();
        let without_hint = c.decompress(&compressed).unwrap();
        let with_hint = c
            .decompress_with_size_hint(&compressed, data.len())
            .unwrap();
        assert_eq!(
            without_hint.as_ref(),
            with_hint.as_ref(),
            "decompress and decompress_with_size_hint differ for {:?}",
            c,
        );
    }
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
    store.db_put(&first_chunk_key, &corrupted).await.unwrap();

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
// Resource limit tests
// =================================================================================================================

#[test]
fn manifest_chunk_count_exceeds_limit() {
    let mut buf = BytesMut::new();
    buf.put_u8(3); // version
    buf.put_u8(0); // identity compression
    buf.put_u64(0); // created_at
    buf.put_u32(100_001); // exceeds MAX_MANIFEST_CHUNK_COUNT
    let result = BlobManifest::from_bytes(buf.freeze());
    assert!(matches!(result, Err(StoreError::ManifestCorrupted(_))));
}

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

// =================================================================================================================
// Numeric overflow tests
// =================================================================================================================

#[test]
fn manifest_to_bytes_valid() {
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xAB; 32],
            size: 1024,
        }],
        created_at: 0,
    };
    assert!(manifest.to_bytes(Compression::Identity).is_ok());
}

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
    };
    let blob_hash = [0x11; 32];
    let manifest_key = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &blob_hash);
    store
        .db_put(
            &manifest_key,
            manifest.to_bytes(Compression::Identity).unwrap().as_ref(),
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
// Manifest V3 timestamp tests
// =================================================================================================================

#[test]
fn manifest_v3_roundtrip_with_timestamp() {
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xAB; 32],
            size: 1024,
        }],
        created_at: 1700000000,
    };
    let bytes = manifest.to_bytes(Compression::Identity).unwrap();
    let (decoded, comp) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(comp, Compression::Identity);
    assert_eq!(decoded.chunks.len(), 1);
    assert_eq!(decoded.created_at, 1700000000);
}

#[test]
fn manifest_v3_zero_timestamp() {
    let manifest = BlobManifest {
        chunks: vec![],
        created_at: 0,
    };
    let bytes = manifest.to_bytes(Compression::Identity).unwrap();
    let (decoded, _) = BlobManifest::from_bytes(bytes).unwrap();
    assert_eq!(decoded.created_at, 0);
}

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

// =================================================================================================================
// cas_get_blob_stream: corruption detection
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
// Manifest trailing bytes behavior
// =================================================================================================================

#[test]
fn manifest_trailing_bytes_accepted() {
    // Build a valid V3 manifest with 1 chunk, then append extra trailing bytes.
    // Current behavior: trailing bytes are silently ignored (forward-compatible).
    let manifest = BlobManifest {
        chunks: vec![ChunkInfo {
            hash: [0xAB; 32],
            size: 1024,
        }],
        created_at: 1700000000,
    };
    let mut bytes = BytesMut::from(manifest.to_bytes(Compression::Identity).unwrap().as_ref());
    bytes.put_slice(&[0xFF; 16]); // trailing bytes

    let (decoded, comp) = BlobManifest::from_bytes(bytes.freeze()).unwrap();
    assert_eq!(comp, Compression::Identity);
    assert_eq!(decoded.chunks.len(), 1);
    assert_eq!(decoded.chunks[0].hash, [0xAB; 32]);
    assert_eq!(decoded.chunks[0].size, 1024);
}

// =================================================================================================================
// IncrementalHasher: SHA256TREE with large non-power-of-2 sizes
// =================================================================================================================

#[test]
fn incremental_hasher_sha256tree_large_nonpow2() {
    let sizes = [5000, 7777, 100_000, 131_073, 250_000];
    for &size in &sizes {
        let data: Vec<u8> = (0..size).map(|i| (i % 251) as u8).collect();
        let expected = sha256tree_hash(&data);

        // All at once
        let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
        h.update(&data);
        assert_eq!(
            h.finalize(),
            expected,
            "all-at-once mismatch for size {}",
            size
        );

        // 7-byte chunks (non-aligned)
        let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
        for chunk in data.chunks(7) {
            h.update(chunk);
        }
        assert_eq!(
            h.finalize(),
            expected,
            "7-byte chunk mismatch for size {}",
            size
        );

        // 1024-byte chunks (leaf-aligned)
        let mut h = IncrementalHasher::new(DigestFn::Sha256Tree, 0);
        for chunk in data.chunks(1024) {
            h.update(chunk);
        }
        assert_eq!(
            h.finalize(),
            expected,
            "1024-byte chunk mismatch for size {}",
            size
        );
    }
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
    };
    let manifest_key = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &wrong_hash);
    store
        .db_put(
            &manifest_key,
            manifest.to_bytes(Compression::Identity).unwrap().as_ref(),
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
    };
    let manifest_key = prefixed_key(PREFIX_MANIFEST, DigestFn::Sha256, &empty_hash);
    store
        .db_put(
            &manifest_key,
            manifest.to_bytes(Compression::Identity).unwrap().as_ref(),
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

#[tokio::test]
async fn decompress_with_huge_size_hint_succeeds() {
    let data = b"small payload to compress";
    let compressed = Compression::Zstd.compress(data).unwrap().into_owned();

    // Decompress with an absurdly large size_hint — should still succeed
    // because the initial allocation is capped, even though the hint is huge.
    let result = Compression::Zstd
        .decompress_with_size_hint(&compressed, 500_000_000)
        .unwrap();
    assert_eq!(result.as_ref(), data);
}

// =================================================================================================================
// Concurrency tests

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
// Splice edge cases

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

// =================================================================================================================
// AssetEntry serialization tests
// =================================================================================================================

#[test]
fn asset_entry_roundtrip() {
    let entry = AssetEntry {
        digest_hash: sha256(b"hello"),
        digest_size_bytes: 5,
        created_at: 1000,
        expires_at: 2000,
        is_directory: false,
        qualifiers: vec![
            ("resource_type".into(), "application/octet-stream".into()),
            ("checksum.sri".into(), "sha256-abc123".into()),
        ],
    };
    let bytes = entry.to_bytes();
    let decoded = AssetEntry::from_bytes(bytes).unwrap();
    assert_eq!(decoded.digest_hash, entry.digest_hash);
    assert_eq!(decoded.digest_size_bytes, 5);
    assert_eq!(decoded.created_at, 1000);
    assert_eq!(decoded.expires_at, 2000);
    assert!(!decoded.is_directory);
    assert_eq!(decoded.qualifiers.len(), 2);
    assert_eq!(decoded.qualifiers[0].0, "resource_type");
    assert_eq!(decoded.qualifiers[1].0, "checksum.sri");
}

#[test]
fn asset_entry_roundtrip_directory() {
    let entry = AssetEntry {
        digest_hash: sha256(b"dir"),
        digest_size_bytes: 128,
        created_at: 500,
        expires_at: 0,
        is_directory: true,
        qualifiers: vec![],
    };
    let bytes = entry.to_bytes();
    let decoded = AssetEntry::from_bytes(bytes).unwrap();
    assert!(decoded.is_directory);
    assert_eq!(decoded.expires_at, 0);
    assert!(decoded.qualifiers.is_empty());
}

#[test]
fn asset_entry_from_bytes_too_short() {
    let data = Bytes::from_static(&[0u8; 10]);
    assert!(AssetEntry::from_bytes(data).is_err());
}

// =================================================================================================================
// Asset mapping store tests
// =================================================================================================================

#[tokio::test]
async fn asset_put_get_roundtrip() {
    let store = open_memory_store().await;
    let entry = AssetEntry {
        digest_hash: sha256(b"content"),
        digest_size_bytes: 7,
        created_at: unix_now_secs(),
        expires_at: 0,
        is_directory: false,
        qualifiers: vec![("k".into(), "v".into())],
    };
    let quals = vec![("k".to_string(), "v".to_string())];
    store
        .asset_put(
            DigestFn::Sha256,
            "https://example.com/file.tar",
            &quals,
            &entry,
        )
        .await
        .unwrap();
    let got = store
        .asset_get(DigestFn::Sha256, "https://example.com/file.tar", &quals)
        .await
        .unwrap()
        .unwrap();
    assert_eq!(got.digest_hash, entry.digest_hash);
    assert_eq!(got.digest_size_bytes, 7);
    store.close().await.unwrap();
}

#[tokio::test]
async fn asset_get_not_found() {
    let store = open_memory_store().await;
    let got = store
        .asset_get(DigestFn::Sha256, "https://example.com/missing", &[])
        .await
        .unwrap();
    assert!(got.is_none());
    store.close().await.unwrap();
}

#[tokio::test]
async fn asset_qualifier_ordering_is_canonical() {
    let store = open_memory_store().await;
    let entry = AssetEntry {
        digest_hash: sha256(b"x"),
        digest_size_bytes: 1,
        created_at: 100,
        expires_at: 0,
        is_directory: false,
        qualifiers: vec![],
    };
    let quals_ab = vec![
        ("a".to_string(), "1".to_string()),
        ("b".to_string(), "2".to_string()),
    ];
    store
        .asset_put(DigestFn::Sha256, "urn:test", &quals_ab, &entry)
        .await
        .unwrap();
    // Look up with reversed qualifier order — should still find the entry
    let quals_ba = vec![
        ("b".to_string(), "2".to_string()),
        ("a".to_string(), "1".to_string()),
    ];
    let got = store
        .asset_get(DigestFn::Sha256, "urn:test", &quals_ba)
        .await
        .unwrap();
    assert!(got.is_some());
    store.close().await.unwrap();
}

#[tokio::test]
async fn asset_different_digest_fn_isolates() {
    let store = open_memory_store().await;
    let entry = AssetEntry {
        digest_hash: sha256(b"isolated"),
        digest_size_bytes: 8,
        created_at: 100,
        expires_at: 0,
        is_directory: false,
        qualifiers: vec![],
    };
    store
        .asset_put(DigestFn::Sha256, "urn:iso", &[], &entry)
        .await
        .unwrap();
    // Lookup with Blake3 should not find the SHA256 entry
    let got = store
        .asset_get(DigestFn::Blake3, "urn:iso", &[])
        .await
        .unwrap();
    assert!(got.is_none());
    store.close().await.unwrap();
}
