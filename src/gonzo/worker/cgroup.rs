// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A cgroup for each action, where the worker may make them.
//!
//! A process group holds only processes that stay in it, and a command can
//! leave its group (`setsid`, as daemons do) and outlive its action. A
//! cgroup holds every process started in it, so killing an action's cgroup
//! (`cgroup.kill`) stops all of it.
//!
//! The worker makes its cgroups under its own, in cgroup v2, when that is
//! writable, as it is for a user's own processes under systemd. Elsewhere
//! actions get process groups alone. No controllers are enabled: the
//! cgroups only gather processes, and limits and pressure on the worker's
//! own cgroup still cover its actions.

use std::fs::File;
use std::io::{self, Write as _};
use std::os::fd::{AsRawFd as _, RawFd};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where this worker's action cgroups go.
#[derive(Debug)]
pub struct Cgroups {
    dir: PathBuf,
}

impl Cgroups {
    /// A parent for action cgroups beneath the process's own cgroup, if the
    /// process may make one.
    pub fn new() -> Option<Self> {
        let own = own_cgroup()?;
        // Moving a process between cgroups takes write access to their
        // common ancestor's cgroup.procs, here the worker's own.
        File::options()
            .write(true)
            .open(own.join("cgroup.procs"))
            .ok()?;
        let dir = own.join(format!("gonzo-actions-{}", std::process::id()));
        match std::fs::create_dir(&dir) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::AlreadyExists => {}
            Err(_) => return None,
        }
        // cgroup.kill came with Linux 5.14; without it there is no point.
        if !dir.join("cgroup.kill").exists() {
            let _ = std::fs::remove_dir(&dir);
            return None;
        }
        Some(Self { dir })
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// A new, empty cgroup for an action.
    pub fn create(&self, name: &str) -> io::Result<ActionCgroup> {
        let dir = self.dir.join(name);
        std::fs::create_dir(&dir)?;
        match File::options().write(true).open(dir.join("cgroup.procs")) {
            Ok(procs) => Ok(ActionCgroup { dir, procs }),
            Err(e) => {
                let _ = std::fs::remove_dir(&dir);
                Err(e)
            }
        }
    }
}

impl Drop for Cgroups {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.dir);
    }
}

/// One action's cgroup, removed (once empty) when dropped.
#[derive(Debug)]
pub struct ActionCgroup {
    dir: PathBuf,
    /// Its `cgroup.procs`, open before the command forks, so the child
    /// joins by writing to it.
    procs: File,
}

impl ActionCgroup {
    /// The descriptor a child writes `0` to, to join.
    pub fn procs_fd(&self) -> RawFd {
        self.procs.as_raw_fd()
    }

    /// Kill every process in the cgroup, and wait (briefly) for them to go.
    pub async fn kill(&self) {
        if let Ok(mut kill) = File::options()
            .write(true)
            .open(self.dir.join("cgroup.kill"))
        {
            let _ = kill.write_all(b"1");
        }
        for _ in 0..200 {
            if !self.populated() {
                return;
            }
            tokio::time::sleep(Duration::from_millis(5)).await;
        }
        tracing::warn!(cgroup = %self.dir.display(), "processes linger after cgroup.kill");
    }

    /// Whether any process is still in the cgroup.
    fn populated(&self) -> bool {
        std::fs::read_to_string(self.dir.join("cgroup.events"))
            .map(|events| events.lines().any(|line| line == "populated 1"))
            .unwrap_or(false)
    }
}

impl Drop for ActionCgroup {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir(&self.dir);
    }
}

/// Join the cgroup whose `cgroup.procs` is open as `fd`. Runs in the child
/// between fork and exec, so it may only make async-signal-safe calls.
pub fn join(fd: RawFd) -> io::Result<()> {
    // SAFETY: write(2) on a descriptor the parent opened and keeps open;
    // the buffer is a static string.
    let written = unsafe { libc::write(fd, b"0".as_ptr().cast(), 1) };
    if written == 1 {
        Ok(())
    } else {
        Err(io::Error::last_os_error())
    }
}

/// The process's own cgroup directory, under cgroup v2.
fn own_cgroup() -> Option<PathBuf> {
    let cgroups = std::fs::read_to_string("/proc/self/cgroup").ok()?;
    // In cgroup v2 alone, the one line reads `0::/path`.
    let path = cgroups.lines().find_map(|line| line.strip_prefix("0::"))?;
    let dir = Path::new("/sys/fs/cgroup").join(path.trim_start_matches('/'));
    dir.join("cgroup.procs").exists().then_some(dir)
}
