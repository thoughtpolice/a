// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

use super::test_helpers::*;
use super::*;

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

// =================================================================================================================
// IncrementalHasher tests
// =================================================================================================================

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
