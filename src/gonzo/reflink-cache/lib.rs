// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Files kept on disk by REAPI digest, so each is downloaded once, and
//! handed out as copies.
//!
//! Each user gets its own copy of a file. On btrfs and XFS that copy is a
//! reflink, which shares the cached file's blocks until one side writes,
//! so it costs about what a hard link would; a user that writes to its
//! copy cannot corrupt the cache, as it could with a hard link. Elsewhere
//! the copy is a real one.
//!
//! The cache keeps under a size, evicting the files used longest ago
//! (across restarts, those downloaded longest ago), but never a file
//! someone holds [`Pinned`]. Where the files come from is the caller's:
//! anything that can write blobs to files, checked, is a [`Fetch`].
//!
//! The cache does not run commands, but its users often do: a command
//! forked while a copy is open for writing inherits the descriptor, and
//! executing the copy then fails with `ETXTBSY` until the command execs.
//! [`FileCache::copy_to`] takes a `guard` to hold over the write for that
//! (see `hermetic_run::writing_input`).
//!
//! A download's data is made durable before the download is named in the
//! cache, so that a power loss cannot leave the name of a torn file
//! behind; [`Options::durable`] turns that off.
//!
//! Every filesystem call goes through [`Fs`], which is the operating
//! system's ([`RealFs`]) but for tests, which can use a simulated one
//! that loses what was not made durable ([`sim::SimFs`]).

pub mod fs;
mod index;
pub mod sim;

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, Result};

use reapi_cas::{Digest, DigestFn};

use fs::File as _;
pub use fs::{Fs, RealFs};
use index::{Index, Name};

/// See the module documentation.
pub struct FileCache<F: Fs = RealFs> {
    inner: Arc<Inner<F>>,
}

/// How to open a [`FileCache`].
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct Options {
    /// Most bytes of files to keep.
    pub max_bytes: u64,
    /// Whether files are made durable before they are used: on unless a
    /// lost file costs too little to wait for the disk.
    pub durable: bool,
}

impl Options {
    pub fn new(max_bytes: u64) -> Self {
        Options {
            max_bytes,
            durable: true,
        }
    }
}

struct Inner<F> {
    fs: F,
    dir: PathBuf,
    /// Where downloads land before they are complete and checked.
    partial: PathBuf,
    next_partial: AtomicU64,
    options: Options,
    index: Mutex<Index>,
}

impl<F: Fs> std::fmt::Debug for FileCache<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileCache")
            .field("dir", &self.inner.dir)
            .field("options", &self.inner.options)
            .finish_non_exhaustive()
    }
}

/// Where a [`FileCache`] gets files it does not have.
pub trait Fetch: Sync {
    /// Write each blob into a new file at its path, checked against its
    /// digest. On failure, files already written are the caller's to
    /// remove; the error is passed to the caller of [`FileCache::fetch`]
    /// as it is, so that it can say which blobs were missing.
    fn fetch_to_files(
        &self,
        function: DigestFn,
        blobs: Vec<(Digest, PathBuf)>,
    ) -> impl Future<Output = Result<()>> + Send;
}

/// Files being handed out, kept from eviction until this is dropped.
#[must_use]
pub struct Pinned<F: Fs = RealFs> {
    inner: Arc<Inner<F>>,
    names: Vec<Name>,
}

impl<F: Fs> Drop for Pinned<F> {
    fn drop(&mut self) {
        let mut index = self.inner.lock();
        for name in &self.names {
            index.unpin(name);
        }
    }
}

impl FileCache {
    /// The cache in `dir`, created if need be, holding no more than
    /// `max_bytes`. Partial downloads left by an earlier run are removed,
    /// and what it left complete is kept.
    pub fn open(dir: &Path, max_bytes: u64) -> io::Result<Self> {
        Self::open_with(RealFs, dir, Options::new(max_bytes))
    }
}

impl<F: Fs> FileCache<F> {
    /// The cache in `dir` on `fs`, as [`open`](FileCache::open) but with
    /// all of the [`Options`].
    pub fn open_with(fs: F, dir: &Path, options: Options) -> io::Result<Self> {
        let partial = dir.join("partial");
        create_dir_all(&fs, &partial)?;
        for entry in fs.read_dir(&partial)? {
            fs.remove_file(&partial.join(entry.name))?;
        }
        let inner = Inner {
            fs,
            dir: dir.to_path_buf(),
            partial,
            next_partial: AtomicU64::new(0),
            options,
            index: Mutex::default(),
        };
        let mut found = inner.scan()?;
        found.sort_by_key(|(_, _, modified)| *modified);
        let evicted = {
            let mut index = inner.lock();
            for (name, size, _) in found {
                index.insert(name, size, false);
            }
            index.evict(inner.options.max_bytes)
        };
        inner.remove(evicted);
        Ok(FileCache {
            inner: Arc::new(inner),
        })
    }

    /// Where the file with `digest` is kept.
    pub fn path(&self, function: DigestFn, digest: &Digest) -> PathBuf {
        self.inner.path(function, digest)
    }

    /// Fetch whichever of `digests` the cache does not have yet from
    /// `source`, and keep all of them until the result is dropped.
    pub async fn fetch(
        &self,
        source: &impl Fetch,
        function: DigestFn,
        digests: &[Digest],
    ) -> Result<Pinned<F>> {
        let inner = &self.inner;
        let mut pinned = Pinned {
            inner: inner.clone(),
            names: Vec::new(),
        };
        let mut seen = HashSet::new();
        let mut absent = Vec::new();
        {
            let mut index = inner.lock();
            for digest in digests {
                let name = (function, *digest);
                if !seen.insert(name) {
                    continue;
                }
                if index.pin(&name) {
                    pinned.names.push(name);
                } else {
                    absent.push(*digest);
                }
            }
        }
        let downloads: Vec<(Digest, PathBuf)> = absent
            .into_iter()
            .map(|digest| (digest, inner.partial()))
            .collect();
        let fetched = match source.fetch_to_files(function, downloads.clone()).await {
            Ok(()) => inner.seal(&downloads).await,
            Err(e) => Err(e),
        };
        if let Err(e) = fetched {
            for (_, partial) in &downloads {
                let _ = inner.fs.remove_file(partial);
            }
            return Err(e);
        }

        // Moving downloads into place and evicting happen under the lock
        // together, so that an eviction never removes a file just fetched
        // again.
        let mut index = inner.lock();
        for (digest, partial) in downloads {
            inner.keep(&partial, &inner.path(function, &digest))?;
            let name = (function, digest);
            index.insert(name, digest.size, true);
            pinned.names.push(name);
        }
        let evicted = index.evict(inner.options.max_bytes);
        inner.remove(evicted);
        drop(index);
        Ok(pinned)
    }

    /// Make a read-only copy of the file with `digest` at `dest`, which must
    /// not exist, holding what `guard` returns until the copy is closed.
    pub fn copy_to<G>(
        &self,
        function: DigestFn,
        digest: &Digest,
        executable: bool,
        dest: &Path,
        guard: impl FnOnce() -> G,
    ) -> io::Result<()> {
        let fs = &self.inner.fs;
        let mut from = fs.open(&self.path(function, digest))?;
        let _writing = guard();
        let mut to = fs.create_new(dest)?;
        if !fs.reflink(&from, &to) {
            io::copy(&mut from, &mut to)?;
        }
        to.set_mode(if executable { 0o555 } else { 0o444 })
    }
}

impl<F: Fs> Inner<F> {
    /// The files an earlier run left, with their sizes and when they were
    /// written.
    fn scan(&self) -> io::Result<Vec<(Name, u64, std::time::SystemTime)>> {
        let fs = &self.fs;
        let mut found = Vec::new();
        for function in [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree] {
            let functions = self.dir.join(function.to_string());
            let Ok(fans) = fs.read_dir(&functions) else {
                continue;
            };
            for fan in fans {
                let fan = functions.join(fan.name);
                for file in fs.read_dir(&fan)? {
                    let path = fan.join(&file.name);
                    let metadata = fs.metadata(&path)?;
                    let parsed = file.name.to_str().and_then(|name| {
                        let (hash, size) = name.rsplit_once('-')?;
                        Digest::parse(hash, size.parse().ok()?).ok()
                    });
                    match parsed {
                        Some(digest) => {
                            found.push(((function, digest), metadata.len, metadata.modified))
                        }
                        None => fs.remove_file(&path)?,
                    }
                }
            }
        }
        Ok(found)
    }

    fn lock(&self) -> std::sync::MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Remove the files of `names`, which the index has forgotten; the
    /// caller holds the index's lock, or nothing else can use the cache.
    fn remove(&self, names: Vec<Name>) {
        for (function, digest) in names {
            let _ = self.fs.remove_file(&self.path(function, &digest));
        }
    }

    fn path(&self, function: DigestFn, digest: &Digest) -> PathBuf {
        let hash = digest.hex();
        self.dir
            .join(function.to_string())
            .join(&hash[..2])
            .join(format!("{hash}-{}", digest.size))
    }

    fn partial(&self) -> PathBuf {
        let n = self.next_partial.fetch_add(1, Ordering::Relaxed);
        self.partial.join(n.to_string())
    }

    /// Make complete, checked downloads read-only, and their data
    /// durable, in parallel. A download is named in the cache only after
    /// this: were it named first, a power loss could keep the name but
    /// not all of the data, and the cache would hand out a torn file.
    async fn seal(self: &Arc<Self>, downloads: &[(Digest, PathBuf)]) -> Result<()> {
        let sealing = downloads.iter().map(|(_, partial)| {
            let (inner, partial) = (self.clone(), partial.clone());
            self.fs.blocking(move || {
                let file = inner.fs.open(&partial)?;
                file.set_mode(0o444)?;
                if inner.options.durable {
                    file.sync_data()?;
                }
                io::Result::Ok(())
            })
        });
        futures::future::try_join_all(sealing)
            .await
            .context("sealing downloads")?;
        Ok(())
    }

    /// Move a sealed download into place at `path`.
    fn keep(&self, partial: &Path, path: &Path) -> Result<()> {
        create_dir_all(&self.fs, path.parent().expect("cache paths have parents"))?;
        // Another action may have fetched the same file meanwhile; the
        // contents are the same either way.
        self.fs
            .rename(partial, path)
            .with_context(|| format!("moving a download to {}", path.display()))
    }
}

/// Create the directory `path` and any missing parents.
fn create_dir_all(fs: &impl Fs, path: &Path) -> io::Result<()> {
    match fs.create_dir(path) {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::AlreadyExists && fs.metadata(path)?.is_dir => Ok(()),
        Err(e) if e.kind() == io::ErrorKind::NotFound => {
            let parent = path
                .parent()
                .filter(|parent| !parent.as_os_str().is_empty())
                .ok_or(e)?;
            create_dir_all(fs, parent)?;
            create_dir_all(fs, path)
        }
        Err(e) => Err(e),
    }
}

#[cfg(test)]
mod test_fetch;
#[cfg(test)]
mod test_sim;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod tests;
