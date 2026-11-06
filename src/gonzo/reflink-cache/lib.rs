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

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context as _, Result};

use reapi_cas::{Digest, DigestFn};

/// A cached file, as the index knows it.
type Name = (DigestFn, Digest);

/// See the module documentation.
#[derive(Debug)]
pub struct FileCache {
    dir: PathBuf,
    /// Where downloads land before they are complete and checked.
    partial: PathBuf,
    next_partial: AtomicU64,
    /// Most bytes of files to keep.
    max_bytes: u64,
    index: Mutex<Index>,
}

/// Every cached file, in order of use.
#[derive(Debug, Default)]
struct Index {
    entries: HashMap<Name, Entry>,
    /// Names by when they were last used, oldest first.
    by_use: BTreeMap<u64, Name>,
    bytes: u64,
    clock: u64,
}

#[derive(Debug)]
struct Entry {
    size: u64,
    used: u64,
    /// Actions being given the file, which keep it from eviction.
    pins: usize,
}

impl Index {
    /// Record a use of `name`, pinning it, if the cache has it.
    fn pin(&mut self, name: &Name) -> bool {
        let Some(entry) = self.entries.get_mut(name) else {
            return false;
        };
        self.by_use.remove(&entry.used);
        self.clock += 1;
        entry.used = self.clock;
        entry.pins += 1;
        self.by_use.insert(self.clock, *name);
        true
    }

    fn unpin(&mut self, name: &Name) {
        if let Some(entry) = self.entries.get_mut(name) {
            entry.pins -= 1;
        }
    }

    /// Add a file the cache now holds, unless it already had it, and pin it
    /// if `pinned`.
    fn insert(&mut self, name: Name, size: u64, pinned: bool) {
        if pinned && self.pin(&name) {
            return;
        }
        if self.entries.contains_key(&name) {
            return;
        }
        self.clock += 1;
        self.by_use.insert(self.clock, name);
        self.entries.insert(
            name,
            Entry {
                size,
                used: self.clock,
                pins: usize::from(pinned),
            },
        );
        self.bytes += size;
    }

    /// Forget the files used longest ago, and unpinned, until no more than
    /// `max_bytes` are left, and return them for removal.
    fn evict(&mut self, max_bytes: u64) -> Vec<Name> {
        let mut evicted = Vec::new();
        let mut skipped = Vec::new();
        while self.bytes > max_bytes {
            let Some((used, name)) = self.by_use.pop_first() else {
                break;
            };
            let entry = &self.entries[&name];
            if entry.pins > 0 {
                skipped.push((used, name));
                continue;
            }
            self.bytes -= entry.size;
            self.entries.remove(&name);
            evicted.push(name);
        }
        self.by_use.extend(skipped);
        evicted
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
pub struct Pinned<'a> {
    cache: &'a FileCache,
    names: Vec<Name>,
}

impl Drop for Pinned<'_> {
    fn drop(&mut self) {
        let mut index = self.cache.lock();
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
        let partial = dir.join("partial");
        match std::fs::remove_dir_all(&partial) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        std::fs::create_dir_all(&partial)?;
        let cache = Self {
            dir: dir.to_path_buf(),
            partial,
            next_partial: AtomicU64::new(0),
            max_bytes,
            index: Mutex::default(),
        };
        let mut found = cache.scan()?;
        found.sort_by_key(|(_, _, modified)| *modified);
        let evicted = {
            let mut index = cache.lock();
            for (name, size, _) in found {
                index.insert(name, size, false);
            }
            index.evict(max_bytes)
        };
        cache.remove(evicted);
        Ok(cache)
    }

    /// The files an earlier run left, with their sizes and when they were
    /// written.
    fn scan(&self) -> io::Result<Vec<(Name, u64, std::time::SystemTime)>> {
        let mut found = Vec::new();
        for function in [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree] {
            let Ok(fans) = std::fs::read_dir(self.dir.join(function.to_string())) else {
                continue;
            };
            for fan in fans {
                for file in std::fs::read_dir(fan?.path())? {
                    let file = file?;
                    let metadata = file.metadata()?;
                    let parsed = file.file_name().to_str().and_then(|name| {
                        let (hash, size) = name.rsplit_once('-')?;
                        Digest::parse(hash, size.parse().ok()?).ok()
                    });
                    match parsed {
                        Some(digest) => {
                            found.push(((function, digest), metadata.len(), metadata.modified()?))
                        }
                        None => std::fs::remove_file(file.path())?,
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
            let _ = std::fs::remove_file(self.path(function, &digest));
        }
    }

    /// Where the file with `digest` is kept.
    pub fn path(&self, function: DigestFn, digest: &Digest) -> PathBuf {
        let hash = digest.hex();
        self.dir
            .join(function.to_string())
            .join(&hash[..2])
            .join(format!("{hash}-{}", digest.size))
    }

    /// Fetch whichever of `digests` the cache does not have yet from
    /// `source`, and keep all of them until the result is dropped.
    pub async fn fetch(
        &self,
        source: &impl Fetch,
        function: DigestFn,
        digests: &[Digest],
    ) -> Result<Pinned<'_>> {
        let mut pinned = Pinned {
            cache: self,
            names: Vec::new(),
        };
        let mut seen = HashSet::new();
        let mut absent = Vec::new();
        {
            let mut index = self.lock();
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
            .map(|digest| (digest, self.partial()))
            .collect();
        if let Err(e) = source.fetch_to_files(function, downloads.clone()).await {
            for (_, partial) in &downloads {
                let _ = std::fs::remove_file(partial);
            }
            return Err(e);
        }

        // Moving downloads into place and evicting happen under the lock
        // together, so that an eviction never removes a file just fetched
        // again.
        let mut index = self.lock();
        for (digest, partial) in downloads {
            keep(&partial, &self.path(function, &digest))?;
            let name = (function, digest);
            index.insert(name, digest.size, true);
            pinned.names.push(name);
        }
        let evicted = index.evict(self.max_bytes);
        self.remove(evicted);
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
        let source = self.path(function, digest);
        let from = std::fs::File::open(&source)?;
        let _writing = guard();
        let to = std::fs::File::create_new(dest)?;
        if !reflink(&from, &to) {
            let mut from = from;
            io::copy(&mut from, &mut &to)?;
        }
        to.set_permissions(std::fs::Permissions::from_mode(if executable {
            0o555
        } else {
            0o444
        }))
    }

    fn partial(&self) -> PathBuf {
        let n = self.next_partial.fetch_add(1, Ordering::Relaxed);
        self.partial.join(n.to_string())
    }
}

/// Move a complete, checked download into place at `path`.
fn keep(partial: &Path, path: &Path) -> Result<()> {
    std::fs::create_dir_all(path.parent().expect("cache paths have parents"))?;
    std::fs::set_permissions(partial, std::fs::Permissions::from_mode(0o444))?;
    // Another action may have fetched the same file meanwhile; the contents
    // are the same either way.
    std::fs::rename(partial, path)
        .with_context(|| format!("moving a download to {}", path.display()))
}

/// Make `to` share `from`'s blocks, if the filesystem can.
fn reflink(from: &std::fs::File, to: &std::fs::File) -> bool {
    // SAFETY: FICLONE takes the source descriptor as its argument; both
    // descriptors stay open for the call.
    unsafe { libc::ioctl(to.as_raw_fd(), libc::FICLONE, from.as_raw_fd()) == 0 }
}

#[cfg(test)]
mod tests;
