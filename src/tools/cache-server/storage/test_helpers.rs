// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Shared test helpers — no `#[test]` functions live here.

pub use futures::StreamExt;
pub use sha2::{Digest as _, Sha256};

use super::*;

/// Helper: open an in-memory CacheStore for testing.
pub async fn open_memory_store() -> CacheStore {
    CacheStore::open(StoreBackend::Memory, CacheStoreSettings::default())
        .await
        .unwrap()
}

/// Helper: SHA-256 hash of data.
pub fn sha256(data: &[u8]) -> [u8; 32] {
    Sha256::digest(data).into()
}

/// Helper: generate deterministic data of a given size. Uses a simple
/// pattern that's repeatable but not fully uniform (so CDC can find
/// cut points in large blobs).
pub fn make_data(size: usize) -> Vec<u8> {
    let mut data = Vec::with_capacity(size);
    for i in 0..size {
        // Mix multiple periods to avoid degenerate CDC behavior
        data.push(((i.wrapping_mul(251).wrapping_add(i >> 8)) & 0xFF) as u8);
    }
    data
}
