// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;

#[test]
fn parse_read_resource_name_simple() {
    let parsed = super::helpers::parse_read_resource_name(
        "blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(
        parsed.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_read_resource_name_with_digest_function() {
    let parsed = super::helpers::parse_read_resource_name(
        "blobs/sha256/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(
        parsed.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_read_resource_name_with_instance() {
    let parsed = super::helpers::parse_read_resource_name(
        "my-instance/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/42",
    )
    .unwrap();
    assert_eq!(parsed.size, 42);
}

#[test]
fn parse_write_resource_name_simple() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_write_resource_name_with_digest_function() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/blobs/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/100",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 100);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_write_resource_name_invalid() {
    assert!(super::helpers::parse_write_resource_name("invalid/resource").is_err());
}

#[test]
fn parse_read_resource_name_compressed_blobs() {
    let parsed = super::helpers::parse_read_resource_name(
        "compressed-blobs/zstd/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/100",
    )
    .unwrap();
    assert_eq!(
        parsed.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(parsed.size, 100);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Sha256);
}

#[test]
fn parse_read_resource_name_compressed_blobs_with_digest_fn() {
    let parsed = super::helpers::parse_read_resource_name(
        "compressed-blobs/zstd/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/42",
    )
    .unwrap();
    assert_eq!(parsed.size, 42);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_read_resource_name_compressed_blobs_with_instance() {
    let parsed = super::helpers::parse_read_resource_name(
        "my-instance/compressed-blobs/zstd/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/10",
    )
    .unwrap();
    assert_eq!(parsed.size, 10);
    assert_eq!(parsed.compressor, Compression::Zstd);
}

#[test]
fn parse_write_resource_name_compressed_blobs() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/compressed-blobs/zstd/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/200",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 200);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Sha256);
}

#[test]
fn parse_write_resource_name_compressed_blobs_with_digest_fn() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/compressed-blobs/zstd/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/300",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 300);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_read_resource_name_uncompressed_has_identity() {
    let parsed = super::helpers::parse_read_resource_name(
        "blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.compressor, Compression::Identity);
}

#[test]
fn parse_write_resource_name_uncompressed_has_identity() {
    let parsed = super::helpers::parse_write_resource_name(
        "uploads/abc-123/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.compressor, Compression::Identity);
}

#[test]
fn resolve_digest_function_defaults() {
    let df = super::helpers::resolve_digest_function(0).unwrap();
    assert_eq!(df, DigestFn::Sha256);
}

#[test]
fn resolve_digest_function_sha256() {
    let df = super::helpers::resolve_digest_function(1).unwrap();
    assert_eq!(df, DigestFn::Sha256);
}

#[test]
fn resolve_digest_function_invalid() {
    assert!(super::helpers::resolve_digest_function(99).is_err());
}
