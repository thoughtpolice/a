// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Files kept on disk by REAPI digest: a cache of files downloaded once
//! and handed out as copies, and a store of files that exist nowhere
//! else yet.
//!
//! Each user gets its own copy of a file. On btrfs and XFS that copy is a
//! reflink, which shares the cached file's blocks until one side writes,
//! so it costs about what a hard link would; a user that writes to its
//! copy cannot corrupt the cache, as it could with a hard link. Elsewhere
//! the copy is a real one.
//!
//! # Clean and dirty files
//!
//! A clean file is a copy of a blob kept elsewhere: one fetched from a
//! [`Fetch`], or one a caller has said is kept elsewhere now
//! ([`FileCache::mark_clean`]). The cache keeps under a size, evicting
//! the clean files used longest ago (across restarts, those downloaded
//! longest ago), but never a file someone holds [`Pinned`].
//!
//! A dirty file is the only copy of its blob: an action's output taken in
//! with [`FileCache::ingest`], or a blob a client sent written in with
//! [`FileCache::upload`], until it is copied elsewhere and marked clean.
//! Dirty files count toward the size but are never evicted, so they alone
//! can push the cache over it. [`FileCache::dirty_files`] lists them
//! oldest first, for whatever copies them elsewhere, and
//! [`FileCache::open_file`] reads them. Past a cap on dirty bytes
//! ([`Options::dirty_cap`]) the cache's user should take no more in:
//! [`FileCache::usage`] says when, and [`FileCache::below_dirty_cap`]
//! waits until it may again.
//!
//! # Durability
//!
//! A file's data is made durable before the file is named in the cache,
//! so that a power loss cannot leave the name of a torn file behind. An
//! ingest returns only once the file's name in the dirty area is durable
//! too. Data is synced in parallel on blocking threads, and ingests that
//! finish together share one sync of the dirty area's directory. Should
//! that sync fail, which names reached the disk is unknown, so every
//! later ingest and upload fails until the cache is opened again.
//! [`Options::durable`] turns syncing off.
//!
//! # Stores
//!
//! A clean file's blob is kept in the store the node belongs to. A node
//! that joins another store ([`FileCache::join`]) treats the clean files
//! it has as plain cache, not counted as held when a blob is taken in,
//! until it has registered them with the new store and vouched for them
//! ([`FileCache::vouch`]).
//!
//! # Recovery
//!
//! A cache that was not [closed](FileCache::close) is checked when it is
//! opened again: its dirty files are hashed again, and, if it ran without
//! durability, its clean ones too, and files that are not their blobs
//! removed ([`FileCache::recovery`] says which). A user that never
//! closes the cache and never takes files in, such as a worker's input
//! cache, has no dirty files to check, and pays only a sync of the
//! filesystem on opening; but a cache from before the `state` file is
//! checked in full, once.
//!
//! # Layout
//!
//! In the cache's directory:
//!
//! - `<function>/<hh>/<hash>-<size>`: clean files, by digest function and
//!   digest, fanned out by the hash's first byte;
//! - `dirty/<seq>-<function>-<hash>-<size>`: dirty files, numbered in the
//!   order they were taken in;
//! - `partial/`: downloads, uploads and copies being written, removed on
//!   opening;
//! - `state`: how the last run stopped, or is running, which says what
//!   opening must check (see [`Recovery`]);
//! - `store`: the ID of the store the clean files are vouched for in (see
//!   [`FileCache::join`]).
//!
//! # Commands
//!
//! The cache does not run commands, but its users often do: a command
//! forked while a copy is open for writing inherits the descriptor, and
//! executing the copy then fails with `ETXTBSY` until the command execs.
//! [`FileCache::copy_to`] takes a `guard` to hold over the write for that
//! (see `hermetic_run::writing_input`).
//!
//! Every filesystem call goes through [`Fs`], which is the operating
//! system's ([`RealFs`]) but for tests, which can use a simulated one
//! that loses what was not made durable ([`sim::SimFs`]), or one that
//! fails calls on purpose ([`faults::Faulty`]).

mod commit;
pub mod faults;
pub mod fs;
mod index;
mod ingest;
mod layout;
mod recover;
pub mod sim;
mod stamp;
mod upload;

use std::collections::HashSet;
use std::io;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

use anyhow::{Context as _, Result};

use reapi_cas::{Digest, DigestFn};

use commit::Commits;
use fs::File as _;
pub use fs::{Fs, RealFs};
use index::{Index, Name, State};
use layout::Layout;
pub use recover::Recovery;
pub use upload::Upload;

/// See the module documentation.
pub struct FileCache<F: Fs = RealFs> {
    inner: Arc<Inner<F>>,
}

/// How to open a [`FileCache`].
#[derive(Clone, Debug)]
#[non_exhaustive]
pub struct Options {
    /// Most bytes of files to keep, clean and dirty: clean files are
    /// evicted to stay under it, but dirty ones are not.
    pub max_bytes: u64,
    /// Most bytes of dirty files to hold before [`Usage::over_dirty_cap`]
    /// says to stop taking more in: a quarter of `max_bytes` unless set.
    /// Nothing here stops more being taken in; the caller decides.
    pub dirty_cap: Option<u64>,
    /// Whether files are made durable before they are used: on unless a
    /// lost file costs too little to wait for the disk.
    pub durable: bool,
}

impl Options {
    pub fn new(max_bytes: u64) -> Self {
        Options {
            max_bytes,
            dirty_cap: None,
            durable: true,
        }
    }

    fn dirty_cap(&self) -> u64 {
        self.dirty_cap.unwrap_or(self.max_bytes / 4)
    }
}

/// How the cache holds a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Held {
    /// A copy of a blob kept elsewhere, which may be evicted.
    Clean,
    /// The only copy of its blob, kept until it is marked clean.
    Dirty,
}

/// What [`FileCache::ingest`] did with a file.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Ingested {
    /// The file is a new dirty file.
    Added,
    /// The cache held the blob already, and kept what it had.
    Already(Held),
}

/// What a cache holds.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Usage {
    pub clean_bytes: u64,
    pub clean_files: usize,
    pub dirty_bytes: u64,
    pub dirty_files: usize,
    /// See [`Options::dirty_cap`].
    pub dirty_cap: u64,
}

impl Usage {
    /// Whether more dirty bytes are held than the cap allows, so that the
    /// caller should take no more in until some are marked clean.
    pub fn over_dirty_cap(&self) -> bool {
        self.dirty_bytes > self.dirty_cap
    }
}

struct Inner<F> {
    fs: F,
    layout: Layout,
    next_partial: AtomicU64,
    options: Options,
    index: Mutex<Index>,
    commits: Commits,
    /// Whether the cache is open for writing, and held by those writing
    /// to it, so that closing it waits for them.
    writes: Arc<tokio::sync::RwLock<bool>>,
    recovery: Recovery,
    stamp: Mutex<stamp::Stamp>,
    /// Directories whose own names are durable, so names made in them
    /// can be: those made or found by this run.
    dirs: Mutex<HashSet<PathBuf>>,
}

impl<F: Fs> std::fmt::Debug for FileCache<F> {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("FileCache")
            .field("dir", &self.inner.layout.root)
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
        // Pins may have held the cache over its size.
        let evicted = index.evict(self.inner.options.max_bytes);
        self.inner.remove(evicted);
    }
}

impl FileCache {
    /// The cache in `dir`, created if need be, holding no more than
    /// `max_bytes`. Partial downloads left by an earlier run are removed,
    /// and what it left complete is kept, checked first if it did not
    /// close the cache.
    pub fn open(dir: &Path, max_bytes: u64) -> io::Result<Self> {
        Self::open_with(RealFs, dir, Options::new(max_bytes))
    }
}

impl<F: Fs> FileCache<F> {
    /// Where the clean file with `digest` is kept.
    pub fn path(&self, function: DigestFn, digest: &Digest) -> PathBuf {
        self.inner.layout.clean(&(function, *digest))
    }

    /// How the cache holds the file with `digest`, if it does. A dirty
    /// file may not be durable yet, if it is being taken in; and a clean
    /// one not vouched for in the store last joined is plain cache.
    pub fn has(&self, function: DigestFn, digest: &Digest) -> Option<Held> {
        let state = self.inner.lock().state(&(function, *digest));
        state.map(State::held)
    }

    /// The dirty files, oldest first.
    pub fn dirty_files(&self) -> Vec<(DigestFn, Digest)> {
        self.inner.lock().dirty().map(|(_, name)| name).collect()
    }

    pub fn usage(&self) -> Usage {
        let index = self.inner.lock();
        let (clean_files, dirty_files) = index.files();
        Usage {
            clean_bytes: index.clean_bytes(),
            clean_files,
            dirty_bytes: index.dirty_bytes(),
            dirty_files,
            dirty_cap: self.inner.options.dirty_cap(),
        }
    }

    /// Wait until the dirty bytes are no more than the cap: at once if
    /// they are not over it now.
    pub async fn below_dirty_cap(&self) {
        let cap = self.inner.options.dirty_cap();
        let mut dirty_bytes = self.inner.lock().watch_dirty_bytes();
        // The index holds the sender as long as the cache lives.
        let _ = dirty_bytes.wait_for(|bytes| *bytes <= cap).await;
    }

    /// Open the file with `digest`, clean or dirty, to read: to copy a
    /// dirty file elsewhere, say. What is open stays readable whatever
    /// becomes of the file in the cache.
    pub fn open_file(&self, function: DigestFn, digest: &Digest) -> io::Result<F::File> {
        self.inner.open_held(&(function, *digest))
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
        let _writing = inner.writing().await?;
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
        let mut unused = Vec::new();
        for (digest, partial) in downloads {
            let name = (function, digest);
            // The blob may have been fetched or taken in meanwhile.
            if index.pin(&name) {
                unused.push(partial);
            } else {
                inner.keep(&partial, &inner.layout.clean(&name))?;
                index.insert_clean(name, digest.size, true, true);
            }
            pinned.names.push(name);
        }
        let evicted = index.evict(inner.options.max_bytes);
        inner.remove(evicted);
        drop(index);
        for partial in unused {
            let _ = inner.fs.remove_file(&partial);
        }
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
        let mut from = self.inner.open_held(&(function, *digest))?;
        let _writing = guard();
        let mut to = fs.create_new(dest)?;
        if !fs.reflink(&from, &to) {
            io::copy(&mut from, &mut to)?;
        }
        to.set_mode(if executable { 0o555 } else { 0o444 })
    }
}

impl<F: Fs> Inner<F> {
    fn lock(&self) -> std::sync::MutexGuard<'_, Index> {
        self.index.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Remove the clean files of `names`, which the index has forgotten;
    /// the caller holds the index's lock, or nothing else can use the
    /// cache.
    fn remove(&self, names: Vec<Name>) {
        for name in names {
            let _ = self.fs.remove_file(&self.layout.clean(&name));
        }
    }

    /// Open the file the cache holds as `name`.
    fn open_held(&self, name: &Name) -> io::Result<F::File> {
        let state = self.lock().state(name);
        match state {
            Some(State::Dirty { seq, .. }) => {
                match self.fs.open(&self.layout.dirty(name, seq)) {
                    // Marking it clean may have moved it since.
                    Err(e) if e.kind() == io::ErrorKind::NotFound => {
                        self.fs.open(&self.layout.clean(name))
                    }
                    opened => opened,
                }
            }
            // A file the index lacks may still be in place: the caller may
            // know better, and only the file can say.
            Some(State::Clean { .. }) | None => self.fs.open(&self.layout.clean(name)),
        }
    }

    /// Make the directory `dir` in the cache, and its parents, with their
    /// names durable if the cache is, so that a durable name made in it
    /// cannot be lost with it.
    fn make_dir(&self, dir: &Path) -> io::Result<()> {
        if self.known_dirs().contains(dir) {
            return Ok(());
        }
        let parent = dir.parent().expect("cache directories have parents");
        self.make_dir(parent)?;
        match self.fs.create_dir(dir) {
            Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
            _ => {}
        }
        // Found here, the directory may be another call's, made but not
        // yet durable: sync its parent either way.
        if self.options.durable {
            self.fs.sync_dir(parent)?;
        }
        self.known_dirs().insert(dir.to_path_buf());
        Ok(())
    }

    fn known_dirs(&self) -> std::sync::MutexGuard<'_, HashSet<PathBuf>> {
        self.dirs.lock().unwrap_or_else(|e| e.into_inner())
    }

    fn partial(&self) -> PathBuf {
        let n = self.next_partial.fetch_add(1, Ordering::Relaxed);
        self.layout.partial.join(n.to_string())
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
        self.make_dir(path.parent().expect("cache paths have parents"))?;
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
mod test_cap;
#[cfg(test)]
mod test_commit;
#[cfg(test)]
mod test_crash;
#[cfg(test)]
mod test_dirty;
#[cfg(test)]
mod test_faults;
#[cfg(test)]
mod test_fetch;
#[cfg(test)]
mod test_kill;
#[cfg(test)]
mod test_machine;
#[cfg(test)]
mod test_recovery;
#[cfg(test)]
mod test_sim;
#[cfg(test)]
mod test_stamp;
#[cfg(test)]
mod test_support;
#[cfg(test)]
mod test_upload;
#[cfg(test)]
mod tests;
