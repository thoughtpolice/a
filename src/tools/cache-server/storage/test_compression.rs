// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

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

// =================================================================================================================
// Display / FromStr tests
// =================================================================================================================

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
