// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Failing filesystem calls on purpose, for tests.
//!
//! [`Faulty`] wraps any [`Fs`] and puts a failpoint before each call,
//! named in [`FAULT_POINTS`], whose payload is the `errno` to fail with:
//! `ENOSPC` from a write or a sync, say, or `EIO` from a directory sync.
//! A failed call has no effect. The cache knows nothing of it; a test
//! opens the cache on a `Faulty` filesystem to inject faults.
//!
//! The library is built with failpoints compiled out, so this is a plain
//! wrapper there; `reflink-cache-faults` is the same crate with them on.

use std::io;
use std::ops::ControlFlow;
use std::path::Path;
use std::sync::Arc;

use faultline::{Injector, Point};

use crate::fs::{DirEntry, File, Fs, Metadata};

/// The failpoints of a [`Faulty`] filesystem.
pub const FAULT_POINTS: &[&str] = &[
    "fs.open",
    "fs.create_new",
    "fs.rename",
    "fs.remove_file",
    "fs.create_dir",
    "fs.sync_dir",
    "fs.sync_fs",
    "fs.read_dir",
    "fs.metadata",
    "fs.read",
    "fs.write",
    "fs.sync_data",
    "fs.set_mode",
];

/// See the module documentation.
#[derive(Clone, Debug)]
pub struct Faulty<F> {
    fs: F,
    points: Arc<Points>,
}

#[derive(Debug)]
struct Points {
    open: Point<i32>,
    create_new: Point<i32>,
    rename: Point<i32>,
    remove_file: Point<i32>,
    create_dir: Point<i32>,
    sync_dir: Point<i32>,
    sync_fs: Point<i32>,
    read_dir: Point<i32>,
    metadata: Point<i32>,
    read: Point<i32>,
    write: Point<i32>,
    sync_data: Point<i32>,
    set_mode: Point<i32>,
}

impl<F> Faulty<F> {
    /// `fs`, failing calls as `faults` says.
    pub fn new(fs: F, faults: &Injector<i32>) -> Self {
        let p = |name: &str| {
            debug_assert!(FAULT_POINTS.contains(&name), "{name} is not listed");
            faults.point(name)
        };
        Faulty {
            fs,
            points: Arc::new(Points {
                open: p("fs.open"),
                create_new: p("fs.create_new"),
                rename: p("fs.rename"),
                remove_file: p("fs.remove_file"),
                create_dir: p("fs.create_dir"),
                sync_dir: p("fs.sync_dir"),
                sync_fs: p("fs.sync_fs"),
                read_dir: p("fs.read_dir"),
                metadata: p("fs.metadata"),
                read: p("fs.read"),
                write: p("fs.write"),
                sync_data: p("fs.sync_data"),
                set_mode: p("fs.set_mode"),
            }),
        }
    }

    /// The filesystem underneath.
    pub fn inner(&self) -> &F {
        &self.fs
    }
}

/// An open file on a [`Faulty`] filesystem.
#[derive(Debug)]
pub struct FaultyFile<T> {
    file: T,
    points: Arc<Points>,
}

impl<T> FaultyFile<T> {
    /// The file underneath.
    pub fn into_inner(self) -> T {
        self.file
    }
}

/// Fail with the `errno` `point` returns, if it does.
fn hit(point: &Point<i32>) -> io::Result<()> {
    match point.hit() {
        ControlFlow::Break(errno) => Err(io::Error::from_raw_os_error(errno)),
        ControlFlow::Continue(()) => Ok(()),
    }
}

impl<F: Fs> Fs for Faulty<F> {
    type File = FaultyFile<F::File>;

    fn open(&self, path: &Path) -> io::Result<Self::File> {
        hit(&self.points.open)?;
        Ok(FaultyFile {
            file: self.fs.open(path)?,
            points: self.points.clone(),
        })
    }

    fn create_new(&self, path: &Path) -> io::Result<Self::File> {
        hit(&self.points.create_new)?;
        Ok(FaultyFile {
            file: self.fs.create_new(path)?,
            points: self.points.clone(),
        })
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        hit(&self.points.rename)?;
        self.fs.rename(from, to)
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        hit(&self.points.remove_file)?;
        self.fs.remove_file(path)
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        hit(&self.points.create_dir)?;
        self.fs.create_dir(path)
    }

    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        hit(&self.points.sync_dir)?;
        self.fs.sync_dir(path)
    }

    fn sync_fs(&self, path: &Path) -> io::Result<()> {
        hit(&self.points.sync_fs)?;
        self.fs.sync_fs(path)
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>> {
        hit(&self.points.read_dir)?;
        self.fs.read_dir(path)
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        hit(&self.points.metadata)?;
        self.fs.metadata(path)
    }

    fn reflink(&self, from: &Self::File, to: &Self::File) -> bool {
        self.fs.reflink(&from.file, &to.file)
    }

    fn blocking<T: Send + 'static>(
        &self,
        work: impl FnOnce() -> T + Send + 'static,
    ) -> impl Future<Output = T> + Send {
        self.fs.blocking(work)
    }
}

impl<T: File> io::Read for FaultyFile<T> {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        hit(&self.points.read)?;
        self.file.read(buf)
    }
}

impl<T: File> io::Write for FaultyFile<T> {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        hit(&self.points.write)?;
        self.file.write(buf)
    }

    fn flush(&mut self) -> io::Result<()> {
        self.file.flush()
    }
}

impl<T: File> File for FaultyFile<T> {
    fn sync_data(&self) -> io::Result<()> {
        hit(&self.points.sync_data)?;
        self.file.sync_data()
    }

    fn size(&self) -> io::Result<u64> {
        self.file.size()
    }

    fn set_mode(&self, mode: u32) -> io::Result<()> {
        hit(&self.points.set_mode)?;
        self.file.set_mode(mode)
    }
}
