// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use crate::chunking::FastCdc2020;
use crate::test_helpers::*;

#[test]
fn recommended_parameters_derive_from_the_average() {
    let params = FastCdc2020::RECOMMENDED;
    assert_eq!(params.avg_size, 512 * 1024);
    assert_eq!(params.min_size, 128 * 1024);
    assert_eq!(params.max_size, 2 * 1024 * 1024);
    assert_eq!(params.seed, 0);
    assert_eq!(FastCdc2020::default(), params);
}

#[test]
fn ranges_cover_the_data_in_order() {
    let data = make_data(9 * 1024 * 1024 + 17);
    let params = FastCdc2020::RECOMMENDED;
    let mut next = 0;
    for (offset, length) in params.ranges(&data) {
        assert_eq!(offset, next);
        assert!(length <= params.max_size);
        next += length;
    }
    assert_eq!(next, data.len());
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
    let image_path = buck_resources::get("src/crates/reapi-cas/SekienAkashita.jpg")
        .expect("failed to locate SekienAkashita.jpg resource");
    let vectors_path = buck_resources::get("src/crates/reapi-cas/fastcdc2020_test_vectors")
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
        let params = FastCdc2020 {
            min_size: 4096,
            avg_size: 16384,
            max_size: 65535,
            seed,
        };
        let chunks: Vec<(usize, usize)> = params.ranges(&image_data).collect();
        // The fingerprints come from the crate's own chunker: `ranges`
        // reports only where it cuts, which the offsets check.
        let fingerprints: Vec<u64> = fastcdc::v2020::FastCDC::with_level_and_seed(
            &image_data,
            params.min_size,
            params.avg_size,
            params.max_size,
            fastcdc::v2020::Normalization::Level2,
            seed,
        )
        .map(|chunk| chunk.hash)
        .collect();
        assert_eq!(
            chunks.len(),
            group.len(),
            "seed {}: chunk count mismatch: got {}, expected {}",
            seed,
            chunks.len(),
            group.len(),
        );

        assert_eq!(fingerprints.len(), chunks.len());
        for (j, ((&(offset, length), expected), fingerprint)) in
            chunks.iter().zip(group).zip(&fingerprints).enumerate()
        {
            assert_eq!(
                offset, expected.offset,
                "seed {seed} chunk {j}: offset mismatch"
            );
            assert_eq!(
                length, expected.length,
                "seed {seed} chunk {j}: length mismatch"
            );
            let chunk_sha256 = hex::encode(Sha256::digest(&image_data[offset..offset + length]));
            assert_eq!(
                chunk_sha256, expected.sha256_hex,
                "seed {seed} chunk {j}: SHA256 mismatch"
            );
            assert_eq!(
                *fingerprint, expected.fingerprint,
                "seed {seed} chunk {j}: fingerprint mismatch"
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
