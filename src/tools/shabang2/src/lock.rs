// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Advisory file locking for concurrent download protection.
//!
//! Prevents multiple shabang2 invocations from racing to download the
//! same artifact. Uses `flock(2)` on Unix for blocking exclusive locks.

use std::path::Path;

use anyhow::{Result, bail};

/// An advisory file lock. Released on drop.
pub struct FileLock {
    _file: std::fs::File,
}

impl FileLock {
    /// Acquire a blocking exclusive lock on the given path.
    /// Creates the lock file (and parent directories) if needed.
    ///
    /// # Stub
    ///
    /// This is a stub for Phase 1. Real implementation in Phase 4 will
    /// use `libc::flock` on Unix.
    pub fn acquire(_path: &Path) -> Result<Self> {
        bail!("lock::FileLock::acquire not yet implemented (Phase 4)")
    }
}
