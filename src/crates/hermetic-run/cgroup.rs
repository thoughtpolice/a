// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A cgroup for each command, where this process may make them.
//!
//! A process group holds only processes that stay in it, and a process a
//! command starts can leave its group (`setsid`, as daemons do) and outlive
//! the command. A
//! cgroup holds every process started in it, so killing a command's cgroup
//! (`cgroup.kill`) stops all of it.
//!
//! This process makes its cgroups under its own, in cgroup v2, when that is
//! writable, as it is for a user's own processes under systemd. Elsewhere
//! commands get process groups alone. No controllers are enabled: the
//! cgroups only gather processes, and limits and pressure on this process's
//! own cgroup still cover its commands.

use std::fs::File;
use std::io::{self, Write as _};
use std::os::fd::{AsRawFd as _, RawFd};
use std::path::{Path, PathBuf};
use std::time::Duration;

/// Where this process's command cgroups go.
#[derive(Debug)]
pub struct Cgroups {
    dir: PathBuf,
}

impl Cgroups {
    /// A parent for commands' cgroups beneath the process's own cgroup,
    /// named `{prefix}-{pid}`, if the process may make one.
    pub fn new(prefix: &str) -> Option<Self> {
        let own = runtime_env::self_cgroup_v2_dir()?;
        // Moving a process between cgroups takes write access to their
        // common ancestor's cgroup.procs, here this process's own.
        File::options()
            .write(true)
            .open(own.join("cgroup.procs"))
            .ok()?;
        let dir = own.join(format!("{prefix}-{}", std::process::id()));
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

    /// A new, empty cgroup for a command.
    pub fn create(&self, name: &str) -> io::Result<Cgroup> {
        let dir = self.dir.join(name);
        std::fs::create_dir(&dir)?;
        match File::options().write(true).open(dir.join("cgroup.procs")) {
            Ok(procs) => Ok(Cgroup { dir, procs }),
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

/// One command's cgroup, removed (once empty) when dropped.
#[derive(Debug)]
pub struct Cgroup {
    dir: PathBuf,
    /// Its `cgroup.procs`, open before the command forks, so the child
    /// joins by writing to it.
    procs: File,
}

impl Cgroup {
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

impl Drop for Cgroup {
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
