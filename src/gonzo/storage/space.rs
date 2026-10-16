// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Keeps a local store from filling its disk.
//!
//! When the filesystem under a local store fills, SlateDB's next memtable
//! flush or compaction fails, the database stops, and so does the server:
//! every client loses the cache, reads included, until someone frees space
//! and restarts it. Refusing new writes while free space is below a reserve
//! keeps reads working, leaves compaction and garbage collection the room
//! they need to bring usage back down, and tells clients why their uploads
//! fail (a cache upload failing is a warning to Bazel and Buck, not an error).

use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Weak};
use std::time::Duration;

use crate::error::{Result, StoreError};

/// How often free space is measured.
const REFRESH: Duration = Duration::from_secs(1);

/// The reserve when none is configured: a tenth of the filesystem, at least
/// 1 GiB. Size-tiered compaction writes a merged run before deleting its
/// inputs, so it needs headroom proportional to the store.
pub fn default_reserve(total_bytes: u64) -> u64 {
    (total_bytes / 10).max(1 << 30)
}

/// Free and total bytes of the filesystem holding `path`, as an
/// unprivileged process sees them.
pub fn filesystem_space(path: &Path) -> std::io::Result<(u64, u64)> {
    use std::os::unix::ffi::OsStrExt as _;
    let c_path = std::ffi::CString::new(path.as_os_str().as_bytes())
        .map_err(|e| std::io::Error::new(std::io::ErrorKind::InvalidInput, e))?;
    // SAFETY: statvfs only writes into `stat`, which is plain old data, and
    // reads the NUL-terminated `c_path`, which outlives the call.
    let mut stat: libc::statvfs = unsafe { std::mem::zeroed() };
    if unsafe { libc::statvfs(c_path.as_ptr(), &mut stat) } != 0 {
        return Err(std::io::Error::last_os_error());
    }
    let frsize = stat.f_frsize as u64;
    Ok((
        (stat.f_bavail as u64).saturating_mul(frsize),
        (stat.f_blocks as u64).saturating_mul(frsize),
    ))
}

/// Free space under a local store, measured every [`REFRESH`].
pub(crate) struct DiskReserve {
    path: PathBuf,
    reserve: u64,
    free: AtomicU64,
    low: AtomicBool,
}

impl DiskReserve {
    /// Watch the filesystem holding `path`, refusing writes below `reserve`
    /// bytes free ([`default_reserve`] if `None`). The watch runs on the
    /// current Tokio runtime until the returned value is dropped.
    pub(crate) fn watch(path: PathBuf, reserve: Option<u64>) -> std::io::Result<Arc<Self>> {
        let (free, total) = filesystem_space(&path)?;
        let reserve = reserve.unwrap_or_else(|| default_reserve(total));
        let this = Arc::new(Self {
            path,
            reserve,
            free: AtomicU64::new(free),
            low: AtomicBool::new(false),
        });
        this.note(free);
        let weak: Weak<Self> = Arc::downgrade(&this);
        // Housekeeping, so a plain spawn.
        tokio::spawn(async move {
            let mut tick = tokio::time::interval(REFRESH);
            loop {
                tick.tick().await;
                let Some(this) = weak.upgrade() else { break };
                match filesystem_space(&this.path) {
                    Ok((free, _)) => this.note(free),
                    Err(e) => {
                        tracing::warn!(path = %this.path.display(), "measuring free space: {e}")
                    }
                }
            }
        });
        Ok(this)
    }

    fn note(&self, free: u64) {
        self.free.store(free, Ordering::Relaxed);
        let low = free < self.reserve;
        if self.low.swap(low, Ordering::Relaxed) != low {
            if low {
                tracing::warn!(
                    path = %self.path.display(),
                    free,
                    reserve = self.reserve,
                    "free disk space is below the reserve; refusing writes until it recovers"
                );
            } else {
                tracing::info!(
                    path = %self.path.display(),
                    free,
                    "free disk space recovered; accepting writes again"
                );
            }
        }
    }

    /// Fails while free space is below the reserve.
    pub(crate) fn check(&self) -> Result<()> {
        let free = self.free.load(Ordering::Relaxed);
        if free < self.reserve {
            return Err(StoreError::DiskFull {
                free,
                reserve: self.reserve,
            });
        }
        Ok(())
    }

    pub(crate) fn reserve(&self) -> u64 {
        self.reserve
    }
}
