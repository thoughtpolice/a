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

use anyhow::{Context, Result};
use sha2::{Digest, Sha256};

use dotslash_manifest::PlatformEntry;

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

    /// Create a cache rooted at a specific directory (for testing).
    #[cfg(test)]
    fn with_base_dir(base_dir: PathBuf) -> Self {
        Self { base_dir }
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
    pub fn lookup(&self, entry: &PlatformEntry) -> Result<Option<PathBuf>> {
        let key = Self::cache_key(entry);
        let cached_path = self.base_dir.join(&key).join(&entry.path);

        if !cached_path.exists() {
            return Ok(None);
        }

        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            let metadata = std::fs::metadata(&cached_path)
                .with_context(|| format!("stat: {}", cached_path.display()))?;
            if metadata.permissions().mode() & 0o111 == 0 {
                tracing::warn!(path = %cached_path.display(), "cached file not executable");
                return Ok(None);
            }
        }

        Ok(Some(cached_path))
    }

    /// Store an extracted artifact in the cache. `source` is the path to
    /// the extraction directory (containing `entry.path`). Returns the
    /// final cached path.
    pub fn store(&self, entry: &PlatformEntry, source: &Path) -> Result<PathBuf> {
        let key = Self::cache_key(entry);
        let slot_dir = self.base_dir.join(&key);
        let final_path = slot_dir.join(&entry.path);

        // Already cached (race with another process)
        if final_path.exists() {
            return Ok(final_path);
        }

        // Create parent directories for the target
        if let Some(parent) = final_path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating cache dir: {}", parent.display()))?;
        }

        let source_file = source.join(&entry.path);
        if !source_file.exists() {
            anyhow::bail!("extracted file not found: {}", source_file.display());
        }

        // Try atomic rename first (same filesystem)
        match std::fs::rename(&source_file, &final_path) {
            Ok(()) => {}
            Err(_) => {
                // Cross-filesystem fallback
                std::fs::copy(&source_file, &final_path).with_context(|| {
                    format!(
                        "copying {} -> {}",
                        source_file.display(),
                        final_path.display()
                    )
                })?;
                let _ = std::fs::remove_file(&source_file);
            }
        }

        Ok(final_path)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use dotslash_manifest::{ArchiveFormat, HashAlgorithm, Provider};

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
        let e1 = sample_entry();
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

    fn cache_in_tempdir() -> (Cache, tempfile::TempDir) {
        let dir = tempfile::tempdir().unwrap();
        let cache = Cache::with_base_dir(dir.path().to_path_buf());
        (cache, dir)
    }

    #[test]
    fn test_lookup_miss() {
        let (cache, _dir) = cache_in_tempdir();
        let entry = sample_entry();
        assert!(cache.lookup(&entry).unwrap().is_none());
    }

    #[test]
    fn test_store_then_lookup() {
        let (cache, _dir) = cache_in_tempdir();
        let entry = sample_entry();

        // Create a fake extracted file in a temp source dir
        let source_dir = tempfile::tempdir().unwrap();
        let source_file = source_dir.path().join(&entry.path);
        std::fs::write(&source_file, b"fake binary").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&source_file, std::fs::Permissions::from_mode(0o755)).unwrap();
        }

        let cached = cache.store(&entry, source_dir.path()).unwrap();
        assert!(cached.exists());
        assert_eq!(std::fs::read(&cached).unwrap(), b"fake binary");

        // Lookup should now find it
        let found = cache.lookup(&entry).unwrap();
        assert_eq!(found, Some(cached));
    }

    #[test]
    fn test_store_idempotent() {
        let (cache, _dir) = cache_in_tempdir();
        let entry = sample_entry();

        // First store
        let source1 = tempfile::tempdir().unwrap();
        let f1 = source1.path().join(&entry.path);
        std::fs::write(&f1, b"binary v1").unwrap();
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            std::fs::set_permissions(&f1, std::fs::Permissions::from_mode(0o755)).unwrap();
        }
        let path1 = cache.store(&entry, source1.path()).unwrap();

        // Second store (already cached)
        let source2 = tempfile::tempdir().unwrap();
        let f2 = source2.path().join(&entry.path);
        std::fs::write(&f2, b"binary v2").unwrap();
        let path2 = cache.store(&entry, source2.path()).unwrap();

        assert_eq!(path1, path2);
        // Original content preserved
        assert_eq!(std::fs::read(&path1).unwrap(), b"binary v1");
    }
}
