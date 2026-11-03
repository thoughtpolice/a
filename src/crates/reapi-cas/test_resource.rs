// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use crate::compression::Compression;
use crate::digest::{Digest, DigestFn};
use crate::resource::{parse_read, parse_write, read_name, write_name};

#[test]
fn parse_read_resource_name_simple() {
    let parsed =
        parse_read("blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0")
            .unwrap();
    assert_eq!(
        parsed.hash,
        "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
    );
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_read_resource_name_with_digest_function() {
    let parsed = parse_read(
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
    let parsed = parse_read(
        "my-instance/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/42",
    )
    .unwrap();
    assert_eq!(parsed.size, 42);
}

#[test]
fn parse_write_resource_name_simple() {
    let parsed = parse_write(
        "uploads/abc-123/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 0);
}

#[test]
fn parse_write_resource_name_with_digest_function() {
    let parsed = parse_write(
        "uploads/abc-123/blobs/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/100",
    )
    .unwrap();
    assert_eq!(parsed.uuid.as_deref(), Some("abc-123"));
    assert_eq!(parsed.size, 100);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_write_resource_name_invalid() {
    assert!(parse_write("invalid/resource").is_err());
}

#[test]
fn parse_read_resource_name_compressed_blobs() {
    let parsed = parse_read(
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
    let parsed = parse_read(
        "compressed-blobs/zstd/blake3/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/42",
    )
    .unwrap();
    assert_eq!(parsed.size, 42);
    assert_eq!(parsed.compressor, Compression::Zstd);
    assert_eq!(parsed.digest_fn, DigestFn::Blake3);
}

#[test]
fn parse_read_resource_name_compressed_blobs_with_instance() {
    let parsed = parse_read(
        "my-instance/compressed-blobs/zstd/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/10",
    )
    .unwrap();
    assert_eq!(parsed.size, 10);
    assert_eq!(parsed.compressor, Compression::Zstd);
}

#[test]
fn parse_write_resource_name_compressed_blobs() {
    let parsed = parse_write(
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
    let parsed = parse_write(
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
    let parsed =
        parse_read("blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0")
            .unwrap();
    assert_eq!(parsed.compressor, Compression::Identity);
}

#[test]
fn parse_write_resource_name_uncompressed_has_identity() {
    let parsed = parse_write(
        "uploads/abc-123/blobs/e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855/0",
    )
    .unwrap();
    assert_eq!(parsed.compressor, Compression::Identity);
}

#[test]
fn resolve_digest_function_defaults() {
    let df = DigestFn::of_request(0).unwrap();
    assert_eq!(df, DigestFn::Sha256);
}

#[test]
fn resolve_digest_function_sha256() {
    let df = DigestFn::of_request(1).unwrap();
    assert_eq!(df, DigestFn::Sha256);
}

#[test]
fn resolve_digest_function_invalid() {
    assert!(DigestFn::of_request(99).is_none());
}

#[test]
fn built_names_parse_back() {
    let hash = "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";
    let digest = Digest::parse(hash, 42).unwrap();
    for instance in ["", "main", "a/b"] {
        for digest_fn in [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree] {
            for compressor in [Compression::Identity, Compression::Zstd] {
                let name = read_name(instance, digest_fn, compressor, &digest);
                let read = parse_read(&name).unwrap();
                assert_eq!(
                    (
                        read.hash.as_str(),
                        read.size,
                        read.digest_fn,
                        read.compressor
                    ),
                    (hash, 42, digest_fn, compressor),
                    "{name}"
                );

                let name = write_name(instance, "u-1", digest_fn, compressor, &digest);
                let write = parse_write(&name).unwrap();
                assert_eq!(
                    (write.hash.as_str(), write.size, write.uuid.as_deref()),
                    (hash, 42, Some("u-1")),
                    "{name}"
                );
                assert_eq!((write.digest_fn, write.compressor), (digest_fn, compressor));
            }
        }
    }
}

#[test]
fn sha256_names_leave_out_the_digest_function() {
    let hash = "ab".repeat(32);
    let digest = Digest::parse(&hash, 1).unwrap();
    assert_eq!(
        read_name("", DigestFn::Sha256, Compression::Identity, &digest),
        format!("blobs/{hash}/1")
    );
    assert_eq!(
        read_name("i", DigestFn::Blake3, Compression::Zstd, &digest),
        format!("i/compressed-blobs/zstd/blake3/{hash}/1")
    );
    assert_eq!(
        write_name("", "u", DigestFn::Sha256, Compression::Identity, &digest),
        format!("uploads/u/blobs/{hash}/1")
    );
}
