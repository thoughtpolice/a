// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Input files, kept by digest so each is downloaded once.
//!
//! Actions get their own copy of each file. On btrfs and XFS that copy is
//! a reflink, which shares the cached file's blocks until one side writes,
//! so it costs about what a hard link would; an action that writes to its
//! inputs cannot corrupt the cache, as it could with a hard link.
//! Elsewhere the copy is a real one.
//!
//! The cache keeps under a size, evicting the files used longest ago
//! (across restarts, those downloaded longest ago), but never a file an
//! action is being given.

use std::collections::{BTreeMap, HashMap, HashSet};
use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context as _, Result};
use futures::{StreamExt as _, TryStreamExt as _};

use protos::build::bazel::remote::execution::v2::Digest;

use crate::cas::{BATCH_BLOB_MAX, Cas};
use crate::digest::{DigestFunction, Key, key};

/// Downloads under way at once.
const PARALLEL_DOWNLOADS: usize = 16;

/// A cached file, as the index knows it.
type Name = (DigestFunction, Key);

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
        self.by_use.insert(self.clock, name.clone());
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
        self.by_use.insert(self.clock, name.clone());
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

/// Files an action is being given, kept from eviction until this is
/// dropped.
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
        for function in [DigestFunction::Sha256, DigestFunction::Blake3] {
            let Ok(fans) = std::fs::read_dir(self.dir.join(function.to_string())) else {
                continue;
            };
            for fan in fans {
                for file in std::fs::read_dir(fan?.path())? {
                    let file = file?;
                    let metadata = file.metadata()?;
                    let parsed = file.file_name().to_str().and_then(|name| {
                        let (hash, size) = name.rsplit_once('-')?;
                        Some((hash.to_string(), size.parse::<i64>().ok()?))
                    });
                    match parsed {
                        Some(key) => {
                            found.push(((function, key), metadata.len(), metadata.modified()?))
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
        for (function, (hash, size)) in names {
            let digest = Digest {
                hash,
                size_bytes: size,
            };
            let _ = std::fs::remove_file(self.path(function, &digest));
        }
    }

    /// Where the file with `digest` is kept.
    pub fn path(&self, function: DigestFunction, digest: &Digest) -> PathBuf {
        let hash = &digest.hash;
        let fan = hash.get(..2).unwrap_or("00");
        self.dir
            .join(function.to_string())
            .join(fan)
            .join(format!("{hash}-{}", digest.size_bytes))
    }

    /// Download whichever of `digests` the cache does not have yet, and keep
    /// all of them until the result is dropped.
    pub async fn fetch(
        &self,
        cas: &Cas,
        function: DigestFunction,
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
                let name = (function, key(digest));
                if !seen.insert(name.clone()) {
                    continue;
                }
                if index.pin(&name) {
                    pinned.names.push(name);
                } else {
                    absent.push(digest.clone());
                }
            }
        }
        let (small, large): (Vec<Digest>, Vec<Digest>) = absent
            .into_iter()
            .partition(|d| d.size_bytes <= BATCH_BLOB_MAX);

        // Small blobs come by batches, and large ones stream, at once.
        let batched = async {
            let mut blobs = cas.read_blobs(function, &small).await?;
            let writes: Vec<_> = small
                .into_iter()
                .map(|digest| {
                    let data = blobs
                        .remove(&key(&digest))
                        .expect("read_blobs read them all");
                    (self.partial(), digest, data)
                })
                .collect();
            tokio::task::spawn_blocking(move || {
                writes
                    .into_iter()
                    .map(|(partial, digest, data)| {
                        std::fs::write(&partial, data)
                            .with_context(|| format!("writing {}", partial.display()))?;
                        Ok((partial, digest))
                    })
                    .collect::<Result<Vec<(PathBuf, Digest)>>>()
            })
            .await?
        };
        let streamed = futures::stream::iter(large)
            .map(|digest| async move {
                let partial = self.partial();
                let result = cas.read_to_file(function, &digest, &partial).await;
                if result.is_err() {
                    let _ = std::fs::remove_file(&partial);
                }
                result?;
                anyhow::Ok((partial, digest))
            })
            .buffer_unordered(PARALLEL_DOWNLOADS)
            .try_collect::<Vec<(PathBuf, Digest)>>();
        let (mut downloaded, streamed) = futures::try_join!(batched, streamed)?;
        downloaded.extend(streamed);

        // Moving downloads into place and evicting happen under the lock
        // together, so that an eviction never removes a file just fetched
        // again.
        let mut index = self.lock();
        for (partial, digest) in downloaded {
            keep(&partial, &self.path(function, &digest))?;
            let name = (function, key(&digest));
            index.insert(name.clone(), digest.size_bytes as u64, true);
            pinned.names.push(name);
        }
        let evicted = index.evict(self.max_bytes);
        self.remove(evicted);
        drop(index);
        Ok(pinned)
    }

    /// Give the action a copy of the file with `digest` at `dest`.
    pub fn copy_to(
        &self,
        function: DigestFunction,
        digest: &Digest,
        executable: bool,
        dest: &Path,
    ) -> io::Result<()> {
        let source = self.path(function, digest);
        let from = std::fs::File::open(&source)?;
        // Until the copy is closed, no command forks to hold it open.
        let _writing = crate::runner::writing_input();
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
mod tests {
    use super::*;

    use crate::test_support::Daemon;

    const SHA256: DigestFunction = DigestFunction::Sha256;

    async fn fetched(cache: &FileCache, cas: &Cas, digest: &Digest) {
        drop(
            cache
                .fetch(cas, SHA256, &[digest.clone()])
                .await
                .expect("fetch"),
        );
    }

    #[tokio::test]
    async fn the_files_used_longest_ago_are_evicted() {
        let daemon = Daemon::start().await;
        let (a, b, c) = (
            daemon.put("aaaa").await,
            daemon.put("bbbb").await,
            daemon.put("cccc").await,
        );
        let scratch = tempfile::tempdir().unwrap();
        // Room for two.
        let cache = FileCache::open(scratch.path(), 8).unwrap();
        let cas = daemon.cas();
        fetched(&cache, &cas, &a).await;
        fetched(&cache, &cas, &b).await;
        // Using a again leaves b the oldest.
        fetched(&cache, &cas, &a).await;
        fetched(&cache, &cas, &c).await;
        assert!(cache.path(SHA256, &a).exists());
        assert!(!cache.path(SHA256, &b).exists());
        assert!(cache.path(SHA256, &c).exists());
    }

    #[tokio::test]
    async fn files_being_given_out_are_kept() {
        let daemon = Daemon::start().await;
        let (a, b, c) = (
            daemon.put("aaaa").await,
            daemon.put("bbbb").await,
            daemon.put("cccc").await,
        );
        let scratch = tempfile::tempdir().unwrap();
        // Room for one.
        let cache = FileCache::open(scratch.path(), 4).unwrap();
        let cas = daemon.cas();
        let holding_a = cache.fetch(&cas, SHA256, &[a.clone()]).await.unwrap();
        let holding_b = cache.fetch(&cas, SHA256, &[b.clone()]).await.unwrap();
        assert!(cache.path(SHA256, &a).exists() && cache.path(SHA256, &b).exists());

        drop((holding_a, holding_b));
        fetched(&cache, &cas, &c).await;
        assert!(!cache.path(SHA256, &a).exists());
        assert!(!cache.path(SHA256, &b).exists());
        assert!(cache.path(SHA256, &c).exists());
    }

    #[tokio::test]
    async fn a_reopened_cache_knows_its_files() {
        let daemon = Daemon::start().await;
        let (a, b) = (daemon.put("aaaa").await, daemon.put("bbbb").await);
        let scratch = tempfile::tempdir().unwrap();
        {
            let cache = FileCache::open(scratch.path(), 100).unwrap();
            let cas = daemon.cas();
            fetched(&cache, &cas, &a).await;
            fetched(&cache, &cas, &b).await;
        }
        // A smaller cache keeps what fits.
        let cache = FileCache::open(scratch.path(), 4).unwrap();
        let kept = [&a, &b]
            .iter()
            .filter(|d| cache.path(SHA256, d).exists())
            .count();
        assert_eq!(kept, 1);
    }

    /// A command forked while a copy is open for writing holds it open
    /// until it execs, and an action's exec of the copy meanwhile fails
    /// with ETXTBSY. Here the copy waits on a FIFO and the command waits to
    /// exec, so that, were they not kept apart, they would overlap.
    #[tokio::test(flavor = "multi_thread")]
    async fn no_command_forks_while_a_copy_is_open_for_writing() {
        use std::io::Write as _;
        use std::os::unix::ffi::OsStrExt as _;
        use std::sync::Arc;
        use std::time::Duration;

        let scratch = tempfile::tempdir().unwrap();
        let cache = Arc::new(FileCache::open(&scratch.path().join("files"), u64::MAX).unwrap());
        let digest = SHA256.of(b"a slow tool");
        let source = cache.path(SHA256, &digest);
        std::fs::create_dir_all(source.parent().unwrap()).unwrap();
        let fifo = std::ffi::CString::new(source.as_os_str().as_bytes()).unwrap();
        // SAFETY: mkfifo(3) reads a NUL-terminated path.
        assert_eq!(unsafe { libc::mkfifo(fifo.as_ptr(), 0o600) }, 0);
        // The FIFO's only writer is another process, so the copy ends when
        // it exits, whatever a child of this one holds.
        let mut writer = std::process::Command::new("/bin/sh")
            .args([
                "-c",
                r#"exec 3>"$0"; read go; printf '#!/bin/sh\nexit 0\n' >&3"#,
            ])
            .arg(&source)
            .stdin(std::process::Stdio::piped())
            .spawn()
            .unwrap();

        let tool = scratch.path().join("tool");
        let copying = tokio::task::spawn_blocking({
            let (cache, tool) = (cache.clone(), tool.clone());
            move || cache.copy_to(SHA256, &digest, true, &tool)
        });
        while !tool.exists() {
            tokio::time::sleep(Duration::from_millis(1)).await;
        }

        let mut release = [0; 2];
        // SAFETY: pipe(2) fills the two descriptors.
        assert_eq!(unsafe { libc::pipe(release.as_mut_ptr()) }, 0);
        let [held, unblock] = release;
        let mut command = tokio::process::Command::new("/bin/sh");
        command.args(["-c", ":"]);
        // SAFETY: read(2) is async-signal-safe.
        unsafe {
            command.pre_exec(move || {
                let mut byte = 0u8;
                libc::read(held, (&raw mut byte).cast(), 1);
                Ok(())
            });
        }
        let spawning =
            tokio::task::spawn_blocking(move || crate::runner::spawn(&mut command).unwrap());
        // Time for the command to fork, if it may while the copy is open.
        tokio::time::sleep(Duration::from_millis(200)).await;

        writer.stdin.take().unwrap().write_all(b"\n").unwrap();
        assert!(writer.wait().unwrap().success());
        copying.await.unwrap().unwrap();
        let ran = std::process::Command::new(&tool).status();

        // SAFETY: write(2) reads the one byte given.
        assert_eq!(unsafe { libc::write(unblock, b"\n".as_ptr().cast(), 1) }, 1);
        assert!(spawning.await.unwrap().wait().await.unwrap().success());
        // SAFETY: both descriptors are this test's own.
        unsafe {
            libc::close(held);
            libc::close(unblock);
        }
        assert!(ran.unwrap().success());
    }
}
