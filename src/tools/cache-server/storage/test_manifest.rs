// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

// =================================================================================================================
// BlobManifest serialization tests (V3 with compression)
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
