// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Content-addressable chunk storage backed by SlateDB with FastCDC chunking.

use anyhow::Result;
use slatedb::Db;

/// Where to store SlateDB data.
pub enum StoreBackend {
    /// In-memory object store (ephemeral, for testing).
    Memory,
    /// Local filesystem at the given path.
    LocalFs(String),
}

/// Main storage engine wrapping SlateDB with CDC-aware blob storage.
pub struct CacheStore {
    db: Db,
}

impl std::fmt::Debug for CacheStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CacheStore").finish_non_exhaustive()
    }
}

impl CacheStore {
    /// Open the store with the given backend.
    pub async fn open(backend: StoreBackend) -> Result<Self> {
        anyhow::bail!("NIH")
    }

    /// Graceful shutdown.
    pub async fn close(&self) -> Result<()> {
        anyhow::bail!("NIH")
    }
}
