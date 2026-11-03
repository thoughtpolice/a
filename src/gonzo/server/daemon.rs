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
//! The claim itself is a [`dir_claim::Claim`].
//!
//! The standalone compactor takes no lock: it runs beside a server started
//! with `--disable-compactor`, and SlateDB coordinates the two.

use std::path::Path;

use anyhow::Result;
use dir_claim::{Claim, Files, TakeError};
use serde::{Deserialize, Serialize};

/// The lock a daemon holds on its store's directory.
pub const LOCK_FILE: &str = "gonzo.lock";

/// What the daemon holding the lock says about itself.
pub const STATE_FILE: &str = "daemon.json";

const FILES: Files = Files {
    lock: LOCK_FILE,
    state: STATE_FILE,
};

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
pub struct StoreClaim(Claim<DaemonInfo>);

impl StoreClaim {
    /// Claim the store in `dir`, creating the directory if need be, or fail
    /// saying which daemon has it.
    pub fn take(dir: &Path) -> Result<Self> {
        match Claim::take(dir, FILES) {
            Ok(claim) => Ok(Self(claim)),
            Err(TakeError::Held { holder, .. }) => Err(anyhow::anyhow!(held(dir, holder))),
            Err(TakeError::Failed(e)) => Err(e.into()),
        }
    }

    /// Record `info` as this daemon's [`STATE_FILE`].
    pub fn announce(&self, info: &DaemonInfo) -> Result<()> {
        Ok(self.0.announce(info)?)
    }
}

/// The daemon that has the store in `dir` open, if it has said.
pub fn running(dir: &Path) -> Option<DaemonInfo> {
    dir_claim::holder(dir, FILES)
}

/// Why `dir` cannot be claimed.
fn held(dir: &Path, running: Option<DaemonInfo>) -> String {
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
