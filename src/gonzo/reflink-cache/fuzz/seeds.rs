// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Writes the seed corpus of the machine target: byte strings, which the
//! target reads as a choice at a time, so any bytes are a run.
//!
//! Usage: fuzz-seeds OUT_DIR

use std::path::Path;

/// `len` bytes from `seed`.
fn noise(seed: u64, len: usize) -> Vec<u8> {
    let mut state = seed | 1;
    (0..len)
        .map(|_| {
            state ^= state << 13;
            state ^= state >> 7;
            state ^= state << 17;
            state as u8
        })
        .collect()
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let [_, dir] = &args[..] else {
        panic!("usage: fuzz-seeds OUT_DIR");
    };
    let dir = Path::new(dir);
    std::fs::create_dir_all(dir).unwrap();
    for (i, len) in [16, 64, 256, 1024, 4096].into_iter().enumerate() {
        for seed in 0..3 {
            let name = format!("noise-{len}-{seed}");
            std::fs::write(dir.join(name), noise((i * 3 + seed) as u64 + 1, len)).unwrap();
        }
    }
    // Runs that take files in and lose power over and over: a step's
    // first choice is its operation, 0 to take files in and 13 to lose
    // power.
    let mut cycles = Vec::new();
    for round in 0..40u8 {
        cycles.extend([1, 1, 1, 0, round % 3, round, 0, 0]);
        cycles.extend([13, round % 5, round, round / 2]);
    }
    std::fs::write(dir.join("ingest-and-crash"), cycles).unwrap();
}
