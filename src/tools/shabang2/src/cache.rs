// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Content-addressed on-disk cache for downloaded artifacts.
//!
//! Cache layout:
//! ```text
//! ~/.cache/shabang2/v1/<hex-key>/<artifact-path>
//! ```
//!
//! The cache key is the SHA-256 hash of the canonical representation of
//! the platform entry (hash algorithm + digest + size + format + path),
//! ensuring any change to the entry invalidates the cache.

use std::path::{Path, PathBuf};

use anyhow::{Result, bail};
use sha2::{Digest, Sha256};

use crate::manifest::PlatformEntry;

/// Manages the on-disk artifact cache.
pub struct Cache {
    base_dir: PathBuf,
}

impl Cache {
    /// Create a new cache rooted at the default location.
    ///
    /// Uses `$SHABANG2_CACHE` if set, otherwise `$HOME/.cache/shabang2/v1`.
    pub fn new() -> Result<Self> {
        let base_dir = if let Ok(dir) = std::env::var("SHABANG2_CACHE") {
            PathBuf::from(dir)
        } else {
            let home = std::env::var("HOME")
                .or_else(|_| std::env::var("USERPROFILE"))
                .map_err(|_| anyhow::anyhow!("cannot determine home directory"))?;
            PathBuf::from(home)
                .join(".cache")
                .join("shabang2")
                .join("v1")
        };
        Ok(Self { base_dir })
    }

    /// Return the base cache directory path.
    pub fn base_dir(&self) -> &Path {
        &self.base_dir
    }

    /// Compute a deterministic cache key for a platform entry.
    ///
    /// The key is the hex-encoded SHA-256 hash of the entry's identifying
    /// fields, ensuring that any change to the artifact description
    /// produces a different cache slot.
    pub fn cache_key(entry: &PlatformEntry) -> String {
        let mut hasher = Sha256::new();
        hasher.update(format!("{:?}", entry.hash).as_bytes());
        hasher.update(b"\0");
        hasher.update(entry.digest.as_bytes());
        hasher.update(b"\0");
        hasher.update(entry.size.to_le_bytes());
        hasher.update(b"\0");
        hasher.update(format!("{:?}", entry.format).as_bytes());
        hasher.update(b"\0");
        hasher.update(entry.path.as_bytes());
        hex::encode(hasher.finalize())
    }

    /// Check whether the artifact for `entry` is already cached.
    /// Returns the path to the executable if found.
    ///
    /// # Stub
    ///
    /// Disk I/O is stubbed for Phase 1. Real implementation in Phase 4.
    pub fn lookup(&self, _entry: &PlatformEntry) -> Result<Option<PathBuf>> {
        bail!("cache::lookup not yet implemented (Phase 4)")
    }

    /// Store an extracted artifact in the cache. `source` is the path to
    /// the extracted directory or file. Returns the final cached path.
    ///
    /// # Stub
    ///
    /// Disk I/O is stubbed for Phase 1. Real implementation in Phase 4.
    pub fn store(&self, _entry: &PlatformEntry, _source: &Path) -> Result<PathBuf> {
        bail!("cache::store not yet implemented (Phase 4)")
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::manifest::{ArchiveFormat, HashAlgorithm, Provider};

    fn sample_entry() -> PlatformEntry {
        PlatformEntry {
            size: 12345,
            hash: HashAlgorithm::Sha256,
            digest: "07380145d2d5de8836bc001d65b82c0ae0a1fa7ff649c7057a0327e98fad9269".to_string(),
            format: ArchiveFormat::Zst,
            path: "test-tool".to_string(),
            providers: vec![Provider {
                url: "https://example.com/test.zst".to_string(),
            }],
        }
    }

    #[test]
    fn test_cache_key_deterministic() {
        let entry = sample_entry();
        let k1 = Cache::cache_key(&entry);
        let k2 = Cache::cache_key(&entry);
        assert_eq!(k1, k2);
        assert_eq!(k1.len(), 64);
    }

    #[test]
    fn test_cache_key_changes_with_size() {
        let mut e1 = sample_entry();
        let mut e2 = sample_entry();
        e2.size = 99999;
        assert_ne!(Cache::cache_key(&e1), Cache::cache_key(&e2));
    }

    #[test]
    fn test_cache_key_changes_with_digest() {
        let e1 = sample_entry();
        let mut e2 = sample_entry();
        e2.digest = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb".to_string();
        assert_ne!(Cache::cache_key(&e1), Cache::cache_key(&e2));
    }
}
