// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Shared test helpers — no `#[test]` functions live here.

pub use sha2::{Digest as _, Sha256};

/// SHA-256 hash of data.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Deterministic data of a given size, mixing periods so CDC finds cut
/// points in it.
pub fn make_data(size: usize) -> Vec<u8> {
    (0..size)
        .map(|i| ((i.wrapping_mul(251).wrapping_add(i >> 8)) & 0xFF) as u8)
        .collect()
}
