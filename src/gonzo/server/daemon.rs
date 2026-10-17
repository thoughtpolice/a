// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! One daemon per store.
//!
//! SlateDB allows one writer per store, and a second writer opening it
//! *fences* the first: the first's writes fail from then on, and it stops.
//! So a second `gonzo serve` on the same directory (an agent running
//! `buck2 run //src/gonzo` in a workspace, say) would take down the daemon
//! every other client is using. Before it opens a local store, the daemon
//! takes an exclusive lock on [`LOCK_FILE`] in the store's directory, held
//! until it exits, and once it knows where it listens it writes
//! [`STATE_FILE`] beside it. A second daemon finds the lock taken and
//! exits, saying where the first one is.
//!
//! The standalone compactor takes no lock: it runs beside a server started
//! with `--disable-compactor`, and SlateDB coordinates the two.

use std::fs::File;
use std::io::Write as _;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::{Deserialize, Serialize};

/// The lock a daemon holds on its store's directory.
pub const LOCK_FILE: &str = "gonzo.lock";

/// What the daemon holding the lock says about itself.
pub const STATE_FILE: &str = "daemon.json";

/// The contents of [`STATE_FILE`].
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DaemonInfo {
    pub pid: u32,
    /// Where it serves gRPC, as `HOST:PORT`.
    pub address: String,
    pub version: String,
    /// Its iroh endpoint ID, if it accepts workers.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub endpoint: Option<String>,
    /// A ticket for joining it as a worker, if it accepts workers. It is a
    /// credential, which is why the file is the owner's alone.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub ticket: Option<String>,
    /// Its join code, if workers may join by code; a credential too.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub code: Option<String>,
}

/// A daemon's claim on a local store, released when dropped.
#[derive(Debug)]
pub struct StoreClaim {
    dir: PathBuf,
    /// Held for the claim's life; closing it releases the lock.
    _lock: File,
}

impl StoreClaim {
    /// Claim the store in `dir`, creating the directory if need be, or fail
    /// saying which daemon has it.
    pub fn take(dir: &Path) -> Result<Self> {
        std::fs::create_dir_all(dir)
            .with_context(|| format!("failed to create the store directory {}", dir.display()))?;
        let path = dir.join(LOCK_FILE);
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .with_context(|| format!("failed to open {}", path.display()))?;
        match lock.try_lock() {
            Ok(()) => Ok(Self {
                dir: dir.to_path_buf(),
                _lock: lock,
            }),
            Err(std::fs::TryLockError::WouldBlock) => Err(anyhow::anyhow!(held(dir))),
            Err(std::fs::TryLockError::Error(e)) => {
                Err(e).with_context(|| format!("failed to lock {}", path.display()))
            }
        }
    }

    /// Record `info` as this daemon's [`STATE_FILE`].
    pub fn announce(&self, info: &DaemonInfo) -> Result<()> {
        let path = self.dir.join(STATE_FILE);
        // Written whole and renamed into place, so a reader never sees half
        // of it.
        let partial = self.dir.join(format!("{STATE_FILE}.partial"));
        let mut file = File::options()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&partial)
            .with_context(|| format!("failed to create {}", partial.display()))?;
        serde_json::to_writer_pretty(&mut file, info).context("failed to encode daemon.json")?;
        file.write_all(b"\n")
            .and_then(|()| file.sync_all())
            .with_context(|| format!("failed to write {}", partial.display()))?;
        std::fs::rename(&partial, &path)
            .with_context(|| format!("failed to write {}", path.display()))
    }
}

impl Drop for StoreClaim {
    /// Remove [`STATE_FILE`] while the lock is still held (fields drop after
    /// this), so the next daemon never reads this one's.
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.dir.join(STATE_FILE));
    }
}

/// The daemon that has the store in `dir` open, if it has said.
pub fn running(dir: &Path) -> Option<DaemonInfo> {
    let json = std::fs::read(dir.join(STATE_FILE)).ok()?;
    serde_json::from_slice(&json).ok()
}

/// Why `dir` cannot be claimed.
fn held(dir: &Path) -> String {
    let running = running(dir);
    let dir = dir.display();
    match running {
        Some(info) => format!(
            "gonzo {} (pid {}) is already serving the store at {dir} on {}; point clients \
             there, or give this one its own --store",
            info.version, info.pid, info.address
        ),
        // Between its claim and its announcement, or not a daemon at all.
        None => format!(
            "another process holds {dir}/{LOCK_FILE}; give this one its own --store \
             or stop that one"
        ),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn info() -> DaemonInfo {
        DaemonInfo {
            pid: 4321,
            address: "127.0.0.1:8980".into(),
            version: "test".into(),
            endpoint: None,
            ticket: Some("a ticket".into()),
            code: None,
        }
    }

    #[test]
    fn a_second_claim_is_refused_until_the_first_is_dropped() {
        let dir = tempfile::tempdir().expect("temp dir");
        let store = dir.path().join("store");
        let first = StoreClaim::take(&store).expect("first claim");

        let err = StoreClaim::take(&store).expect_err("a second claim");
        assert!(format!("{err:#}").contains(LOCK_FILE), "{err:#}");

        first.announce(&info()).expect("announce");
        assert_eq!(running(&store), Some(info()));
        let err = format!(
            "{:#}",
            StoreClaim::take(&store).expect_err("a second claim")
        );
        assert!(
            err.contains("pid 4321") && err.contains("127.0.0.1:8980"),
            "{err}"
        );

        drop(first);
        assert_eq!(running(&store), None, "the state file goes with the claim");
        StoreClaim::take(&store).expect("claim once released");
    }
}
