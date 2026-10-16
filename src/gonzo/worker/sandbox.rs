// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! `container-image=empty`: an action whose whole filesystem is its input
//! root.
//!
//! The command starts in new user, mount, network, IPC and UTS namespaces,
//! and its input root becomes `/` (by `pivot_root`, the host's root then
//! detached), so nothing outside its declared inputs exists for it: no
//! `/bin`, no `/lib`, no `/dev`, no `/proc`, no `/tmp`, and no network but
//! a loopback device that is down. It runs as the worker's own user, mapped
//! to itself. This is for checking that a build needs nothing of the host,
//! as a full-source bootstrap should not.
//!
//! An unprivileged process may do all of this where the kernel allows
//! unprivileged user namespaces, as most distributions' kernels do; a
//! worker offers `container-image=empty` only where [`supported`] says so.

use std::ffi::CString;
use std::io;
use std::os::unix::ffi::OsStrExt as _;
use std::path::{Component, Path};
use std::sync::OnceLock;

/// The image value that asks for an empty root.
pub const EMPTY: &str = "empty";

/// What a command needs to enter its empty root, prepared before it forks:
/// between fork and exec a child of a multithreaded process may make
/// system calls, but not allocate.
#[derive(Clone, Debug)]
pub struct EmptyRoot {
    /// The input root, as the worker sees it.
    root: CString,
    /// The working directory, as the command will see it.
    cwd: CString,
    uid_map: Vec<u8>,
    gid_map: Vec<u8>,
}

impl EmptyRoot {
    /// Prepare to run in `root`, with `working_directory` (relative to
    /// `root`) as the current directory.
    pub fn new(root: &Path, working_directory: &Path) -> io::Result<Self> {
        if !working_directory
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
        {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{} is not inside the root", working_directory.display()),
            ));
        }
        let cwd = Path::new("/").join(working_directory);
        let cstring = |path: &Path| {
            CString::new(path.as_os_str().as_bytes())
                .map_err(|e| io::Error::new(io::ErrorKind::InvalidInput, e))
        };
        // SAFETY: getuid(2) and getgid(2) cannot fail.
        let (uid, gid) = unsafe { (libc::getuid(), libc::getgid()) };
        Ok(Self {
            root: cstring(root)?,
            cwd: cstring(&cwd)?,
            uid_map: format!("{uid} {uid} 1\n").into_bytes(),
            gid_map: format!("{gid} {gid} 1\n").into_bytes(),
        })
    }

    /// Enter the empty root. Runs in the child between fork and exec, so it
    /// makes system calls and nothing else.
    pub fn enter(&self) -> io::Result<()> {
        // SAFETY: each call takes NUL-terminated strings and buffers this
        // owns, alive for the call; none touches the child's other memory.
        unsafe {
            check(libc::unshare(
                libc::CLONE_NEWUSER
                    | libc::CLONE_NEWNS
                    | libc::CLONE_NEWNET
                    | libc::CLONE_NEWIPC
                    | libc::CLONE_NEWUTS,
            ))?;
            // An unprivileged process may map only its own IDs, and its
            // group only once setgroups(2) is off.
            write(c"/proc/self/setgroups", b"deny")?;
            write(c"/proc/self/uid_map", &self.uid_map)?;
            write(c"/proc/self/gid_map", &self.gid_map)?;
            // Nothing done here may reach the host's mounts.
            check(libc::mount(
                std::ptr::null(),
                c"/".as_ptr(),
                std::ptr::null(),
                libc::MS_REC | libc::MS_PRIVATE,
                std::ptr::null(),
            ))?;
            // pivot_root wants a mount point.
            check(libc::mount(
                self.root.as_ptr(),
                self.root.as_ptr(),
                std::ptr::null(),
                libc::MS_BIND | libc::MS_REC,
                std::ptr::null(),
            ))?;
            check(libc::chdir(self.root.as_ptr()))?;
            // With "." as both arguments, the old root lands on top of the
            // new one, and detaching it leaves the new one alone.
            check(libc::syscall(libc::SYS_pivot_root, c".".as_ptr(), c".".as_ptr()) as i32)?;
            check(libc::umount2(c".".as_ptr(), libc::MNT_DETACH))?;
            check(libc::chdir(self.cwd.as_ptr()))?;
        }
        Ok(())
    }
}

fn check(result: i32) -> io::Result<()> {
    if result < 0 {
        Err(io::Error::last_os_error())
    } else {
        Ok(())
    }
}

/// Write `data` to the file at `path`, whole.
///
/// # Safety
///
/// Makes system calls only, so may run between fork and exec.
unsafe fn write(path: &std::ffi::CStr, data: &[u8]) -> io::Result<()> {
    // SAFETY: the path is NUL-terminated and the buffer is `data`'s.
    unsafe {
        let fd = libc::open(path.as_ptr(), libc::O_WRONLY | libc::O_CLOEXEC);
        if fd < 0 {
            return Err(io::Error::last_os_error());
        }
        let written = libc::write(fd, data.as_ptr().cast(), data.len());
        let error = io::Error::last_os_error();
        libc::close(fd);
        if written != data.len() as isize {
            return Err(error);
        }
    }
    Ok(())
}

/// Whether this process can run commands in an empty root, found out once
/// by trying: a command that enters an empty root and then fails to find
/// its program there shows that everything before the exec worked.
pub fn supported() -> bool {
    static SUPPORTED: OnceLock<bool> = OnceLock::new();
    *SUPPORTED.get_or_init(|| match probe() {
        Ok(()) => true,
        Err(e) => {
            tracing::info!("actions cannot run in an empty root here: {e}");
            false
        }
    })
}

fn probe() -> io::Result<()> {
    use std::os::unix::process::CommandExt as _;
    let scratch = tempfile::tempdir()?;
    let root = EmptyRoot::new(scratch.path(), Path::new(""))?;
    let mut command = std::process::Command::new("/gonzo-probe-of-an-empty-root");
    // SAFETY: entering makes system calls only.
    unsafe {
        command.pre_exec(move || root.enter());
    }
    match command.spawn() {
        Err(e) if e.kind() == io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e),
        Ok(mut child) => {
            let _ = child.kill();
            let _ = child.wait();
            Err(io::Error::other("a program that cannot exist ran"))
        }
    }
}
