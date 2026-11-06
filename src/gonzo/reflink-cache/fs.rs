// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The filesystem calls a [`FileCache`](crate::FileCache) makes.
//!
//! They go through [`Fs`] so that tests can run the cache on a simulated
//! filesystem, which can lose what was never synced the way a power loss
//! does. Killing a process cannot test that: the kernel keeps its page
//! cache, so everything the process wrote survives, synced or not.
//! [`RealFs`] is the operating system's filesystem, and what the cache
//! uses outside tests.
//!
//! The calls are the ones durability depends on, kept apart: writing a
//! file's data, making it durable ([`File::sync_data`]), naming it in a
//! directory ([`Fs::create_new`], [`Fs::rename`], [`Fs::remove_file`]),
//! and making a directory's names durable ([`Fs::sync_dir`]).

use std::ffi::OsString;
use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::Path;
use std::time::SystemTime;

/// A filesystem, as the cache uses one. Paths are absolute, or relative to
/// the process's working directory, as for [`std::fs`].
pub trait Fs: Send + Sync + 'static {
    type File: File;

    /// Open the file at `path` for reading.
    fn open(&self, path: &Path) -> io::Result<Self::File>;

    /// Create a file at `path`, which must not exist, for writing.
    fn create_new(&self, path: &Path) -> io::Result<Self::File>;

    /// Rename the file at `from` to `to`, replacing any file there.
    fn rename(&self, from: &Path, to: &Path) -> io::Result<()>;

    fn remove_file(&self, path: &Path) -> io::Result<()>;

    /// Create the directory `path`, whose parent must exist.
    fn create_dir(&self, path: &Path) -> io::Result<()>;

    /// Make the names in the directory `path` durable: those created,
    /// renamed in or out, and removed.
    fn sync_dir(&self, path: &Path) -> io::Result<()>;

    /// Make everything written to the filesystem holding `path` durable.
    fn sync_fs(&self, path: &Path) -> io::Result<()>;

    /// The names in the directory `path`, in no particular order.
    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>>;

    fn metadata(&self, path: &Path) -> io::Result<Metadata>;

    /// Make `to`, which is empty, share `from`'s blocks, if the filesystem
    /// can, returning whether it did.
    fn reflink(&self, from: &Self::File, to: &Self::File) -> bool;

    /// Run `work`, which makes blocking calls, where it will not hold up
    /// asynchronous tasks: on Tokio's blocking threads, by default.
    fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> impl Future<Output = T> + Send {
        async move {
            match tokio::task::spawn_blocking(work).await {
                Ok(value) => value,
                Err(e) => match e.try_into_panic() {
                    Ok(panic) => std::panic::resume_unwind(panic),
                    Err(e) => panic!("blocking filesystem work was cancelled: {e}"),
                },
            }
        }
    }
}

/// An open file. Reads and writes are sequential, from where the last one
/// ended, so a file may be a FIFO.
pub trait File: io::Read + io::Write + Send + Sync + 'static {
    /// Make the file's data durable, and the metadata needed to read it
    /// back (its size), as `fdatasync(2)` does.
    fn sync_data(&self) -> io::Result<()>;

    /// The file's size.
    fn size(&self) -> io::Result<u64>;

    /// Set the file's permission bits.
    fn set_mode(&self, mode: u32) -> io::Result<()>;
}

/// A name in a directory.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct DirEntry {
    pub name: OsString,
    pub is_dir: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Metadata {
    pub len: u64,
    pub is_dir: bool,
    pub modified: SystemTime,
}

/// The operating system's filesystem.
#[derive(Clone, Copy, Debug, Default)]
pub struct RealFs;

impl Fs for RealFs {
    type File = std::fs::File;

    fn open(&self, path: &Path) -> io::Result<Self::File> {
        std::fs::File::open(path)
    }

    fn create_new(&self, path: &Path) -> io::Result<Self::File> {
        std::fs::File::create_new(path)
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        std::fs::rename(from, to)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        std::fs::remove_file(path)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        std::fs::create_dir(path)
    }

    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        std::fs::File::open(path)?.sync_all()
    }

    fn sync_fs(&self, path: &Path) -> io::Result<()> {
        let dir = std::fs::File::open(path)?;
        // SAFETY: syncfs(2) takes any descriptor on the filesystem, and
        // `dir` stays open for the call.
        if unsafe { libc::syncfs(dir.as_raw_fd()) } == 0 {
            Ok(())
        } else {
            Err(io::Error::last_os_error())
        }
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>> {
        std::fs::read_dir(path)?
            .map(|entry| {
                let entry = entry?;
                Ok(DirEntry {
                    name: entry.file_name(),
                    is_dir: entry.file_type()?.is_dir(),
                })
            })
            .collect()
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        let metadata = std::fs::metadata(path)?;
        Ok(Metadata {
            len: metadata.len(),
            is_dir: metadata.is_dir(),
            modified: metadata.modified()?,
        })
    }

    fn reflink(&self, from: &Self::File, to: &Self::File) -> bool {
        // SAFETY: FICLONE takes the source descriptor as its argument; both
        // descriptors stay open for the call.
        unsafe { libc::ioctl(to.as_raw_fd(), libc::FICLONE, from.as_raw_fd()) == 0 }
    }
}

impl File for std::fs::File {
    fn sync_data(&self) -> io::Result<()> {
        std::fs::File::sync_data(self)
    }

    fn size(&self) -> io::Result<u64> {
        Ok(self.metadata()?.len())
    }

    fn set_mode(&self, mode: u32) -> io::Result<()> {
        self.set_permissions(std::fs::Permissions::from_mode(mode))
    }
}
