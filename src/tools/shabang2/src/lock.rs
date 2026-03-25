// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Advisory file locking for concurrent download protection.
//!
//! Prevents multiple shabang2 invocations from racing to download the
//! same artifact. Uses `flock(2)` on Unix for blocking exclusive locks.

use std::path::Path;

use anyhow::{Context, Result};

/// An advisory file lock. Released when dropped (closing the fd releases
/// the flock automatically).
pub struct FileLock {
    _file: std::fs::File,
}

impl FileLock {
    /// Acquire a blocking exclusive lock on the given path.
    /// Creates the lock file (and parent directories) if needed.
    pub fn acquire(path: &Path) -> Result<Self> {
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .with_context(|| format!("creating lock dir: {}", parent.display()))?;
        }

        let file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .truncate(false)
            .open(path)
            .with_context(|| format!("opening lock file: {}", path.display()))?;

        flock_exclusive(&file).with_context(|| format!("locking: {}", path.display()))?;

        Ok(Self { _file: file })
    }
}

#[cfg(unix)]
fn flock_exclusive(file: &std::fs::File) -> Result<()> {
    use std::os::unix::io::AsRawFd;

    unsafe extern "C" {
        fn flock(fd: std::os::raw::c_int, operation: std::os::raw::c_int) -> std::os::raw::c_int;
    }

    const LOCK_EX: std::os::raw::c_int = 2;

    let ret = unsafe { flock(file.as_raw_fd(), LOCK_EX) };
    if ret != 0 {
        anyhow::bail!("flock: {}", std::io::Error::last_os_error());
    }
    Ok(())
}

#[cfg(not(unix))]
fn flock_exclusive(_file: &std::fs::File) -> Result<()> {
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_acquire_creates_file() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("subdir").join("test.lock");
        let _lock = FileLock::acquire(&lock_path).unwrap();
        assert!(lock_path.exists());
    }

    #[test]
    fn test_acquire_release_reacquire() {
        let dir = tempfile::tempdir().unwrap();
        let lock_path = dir.path().join("test.lock");
        {
            let _lock = FileLock::acquire(&lock_path).unwrap();
        }
        // After drop, we should be able to acquire again immediately
        let _lock2 = FileLock::acquire(&lock_path).unwrap();
    }
}
