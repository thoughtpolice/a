// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Opening a cache, checking what an earlier run left if it did not stop
//! cleanly, and closing one cleanly.
//!
//! # Which files can be torn
//!
//! With durability on, a file's data is durable before the file is named
//! in the cache, in either area: a download is synced before its rename
//! into the clean files, an ingest or upload before its rename into the
//! dirty area, and a file marked clean was dirty, so synced, already. A
//! power loss can lose a name, but never keep one for data that did not
//! reach the disk. So no file is torn, and checking dirty files again is
//! a defence in depth: against a filesystem that loses synced data, or a
//! caller whose digest was wrong.
//!
//! With durability off, any file named since the last sync may be torn,
//! clean or dirty. So after such a run stops uncleanly, every file is
//! checked.
//!
//! A run says which it is in the `state` file before it changes anything,
//! and a clean close says `clean` there once everything is synced. A
//! missing or unknown state, as a cache from before this file left, is
//! treated as a run without durability.
//!
//! Opening syncs the whole filesystem first. After a process is killed,
//! the kernel still has what it wrote, synced or not, and this makes it
//! durable, so that what is checked and found is what a later power loss
//! would keep. Files found torn are removed, and the removals synced,
//! before the new run's state is written.

use std::io::{self, Read as _};
use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::{Arc, Mutex};

use reapi_cas::{Digest, DigestFn};
use tokio::sync::{OwnedRwLockReadGuard, RwLock};

use crate::commit::Commits;
use crate::fs::Fs;
use crate::index::{Index, Name};
use crate::layout::{Layout, read_small, replace_small};
use crate::stamp::{Stamp, read_stamp};
use crate::{FileCache, Held, Inner, Options, create_dir_all};

/// What opening a cache found an earlier run had left.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct Recovery {
    /// Whether the last run stopped without closing the cache.
    pub unclean: bool,
    /// How many files were hashed again to check them.
    pub rehashed: usize,
    /// Files that were not their blobs, which were removed. A dirty one
    /// was the only copy of its blob, which is lost.
    pub dropped: Vec<(DigestFn, Digest, Held)>,
}

/// What the `state` file says of the last run.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Mode {
    /// It closed the cache, with everything synced.
    Clean,
    /// It ran with durability on, and may have stopped anywhere.
    Durable,
    /// It ran with durability off, and may have stopped anywhere.
    Volatile,
}

impl Mode {
    fn as_str(self) -> &'static str {
        match self {
            Mode::Clean => "clean",
            Mode::Durable => "durable",
            Mode::Volatile => "volatile",
        }
    }
}

impl<F: Fs> FileCache<F> {
    /// The cache in `dir` on `fs`, as [`open`](FileCache::open) but with
    /// all of the [`Options`]. If the last run did not [`close`] it, what
    /// it left is checked first; see [`recovery`](Self::recovery).
    ///
    /// [`close`]: FileCache::close
    pub fn open_with(fs: F, dir: &Path, options: Options) -> io::Result<Self> {
        let layout = Layout::new(dir);
        create_dir_all(&fs, &layout.root)?;
        for sub in [&layout.partial, &layout.dirty] {
            match fs.create_dir(sub) {
                Err(e) if e.kind() != io::ErrorKind::AlreadyExists => return Err(e),
                _ => {}
            }
        }
        // See the module documentation; this also makes the directories
        // just made durable.
        fs.sync_fs(&layout.root)?;
        let last = read_state(&fs, &layout)?;
        let store = read_stamp(&fs, &layout)?;
        // Clean files are vouched for in the store stamped, if any (see
        // `stamp`).
        let vouched = store.is_some();
        for entry in fs.read_dir(&layout.partial)? {
            fs.remove_file(&layout.partial.join(entry.name))?;
        }
        let mut found = layout.scan(&fs)?;
        let mut recovery = Recovery {
            unclean: last != Some(Mode::Clean),
            ..Recovery::default()
        };
        recovery.dropped = found
            .torn
            .iter()
            .map(|((function, digest), held)| (*function, *digest, *held))
            .collect();
        if recovery.unclean {
            let check_clean = last != Some(Mode::Durable);
            let mut buffer = vec![0; 256 * 1024];
            let mut check = |name: &Name, path: &Path, held: Held| -> io::Result<bool> {
                recovery.rehashed += 1;
                if hash_file(&fs, path, name.0, &mut buffer)? == name.1 {
                    return Ok(true);
                }
                fs.remove_file(path)?;
                recovery.dropped.push((name.0, name.1, held));
                Ok(false)
            };
            let mut dirty = Vec::with_capacity(found.dirty.len());
            for file in found.dirty {
                if check(&file.name, &layout.dirty(&file.name, file.seq), Held::Dirty)? {
                    dirty.push(file);
                }
            }
            found.dirty = dirty;
            if check_clean {
                let mut clean = Vec::with_capacity(found.clean.len());
                for file in found.clean {
                    if check(&file.name, &layout.clean(&file.name), Held::Clean)? {
                        clean.push(file);
                    }
                }
                found.clean = clean;
            }
        }
        if !recovery.dropped.is_empty() {
            fs.sync_fs(&layout.root)?;
        }
        write_state(
            &fs,
            &layout,
            if options.durable {
                Mode::Durable
            } else {
                Mode::Volatile
            },
        )?;

        let inner = Inner {
            dirs: Mutex::new([layout.root.clone(), layout.dirty.clone()].into()),
            fs,
            layout,
            next_partial: AtomicU64::new(0),
            options,
            index: Mutex::new(Index::new()),
            commits: Commits::new(),
            writes: Arc::new(RwLock::new(true)),
            recovery,
            stamp: Mutex::new(Stamp {
                vouched_for: store.clone(),
                on_disk: store,
            }),
        };
        found.dirty.sort_by_key(|found| found.seq);
        found.clean.sort_by_key(|found| found.modified);
        let evicted = {
            let mut index = inner.lock();
            let mut extra = Vec::new();
            for dirty in found.dirty {
                // A blob is dirty once; were it twice, the oldest is kept.
                if index.state(&dirty.name).is_some() {
                    extra.push(inner.layout.dirty(&dirty.name, dirty.seq));
                } else {
                    // Synced above, so durable already: no ticket to wait
                    // for.
                    index.insert_dirty(dirty.name, dirty.name.1.size, dirty.seq, 0);
                }
            }
            for clean in found.clean {
                // A blob both dirty and clean was being marked clean, or
                // was taken in again as dirty: keeping it dirty is safe
                // either way.
                if index.state(&clean.name).is_some() {
                    extra.push(inner.layout.clean(&clean.name));
                } else {
                    index.insert_clean(clean.name, clean.name.1.size, false, vouched);
                }
            }
            for path in extra {
                inner.fs.remove_file(&path)?;
            }
            index.evict(inner.options.max_bytes)
        };
        inner.remove(evicted);
        Ok(FileCache {
            inner: Arc::new(inner),
        })
    }

    /// What opening the cache found the last run had left.
    pub fn recovery(&self) -> &Recovery {
        &self.inner.recovery
    }

    /// Close the cache: wait for what is being written, refuse anything
    /// more, sync everything, and record a clean stop, so that the next
    /// run need check nothing. Closing while holding an unfinished
    /// [`Upload`](crate::Upload) waits forever.
    pub async fn close(&self) -> io::Result<()> {
        let mut open = self.inner.writes.write().await;
        if !*open {
            return Ok(());
        }
        *open = false;
        if let Some(failed) = self.inner.commits.failed() {
            return Err(failed);
        }
        self.inner.stamp_if_vouched().await?;
        let inner = self.inner.clone();
        self.inner
            .fs
            .blocking(move || {
                inner.fs.sync_fs(&inner.layout.root)?;
                write_state(&inner.fs, &inner.layout, Mode::Clean)
            })
            .await
    }
}

impl<F: Fs> Inner<F> {
    /// Leave to write to the cache, until the guard is dropped: refused
    /// once it is closed.
    pub(crate) async fn writing(&self) -> io::Result<OwnedRwLockReadGuard<bool>> {
        let open = self.writes.clone().read_owned().await;
        if *open {
            Ok(open)
        } else {
            Err(io::Error::other("the cache is closed"))
        }
    }
}

fn state_path(layout: &Layout) -> PathBuf {
    layout.root.join("state")
}

fn read_state(fs: &impl Fs, layout: &Layout) -> io::Result<Option<Mode>> {
    let contents = read_small(fs, &state_path(layout))?.unwrap_or_default();
    Ok([Mode::Clean, Mode::Durable, Mode::Volatile]
        .into_iter()
        .find(|mode| contents.trim_end() == mode.as_str()))
}

fn write_state(fs: &impl Fs, layout: &Layout, mode: Mode) -> io::Result<()> {
    replace_small(
        fs,
        layout,
        &state_path(layout),
        &format!("{}\n", mode.as_str()),
    )
}

fn hash_file(
    fs: &impl Fs,
    path: &Path,
    function: DigestFn,
    buffer: &mut [u8],
) -> io::Result<Digest> {
    let mut file = fs.open(path)?;
    let mut hasher = function.hasher();
    loop {
        match file.read(buffer)? {
            0 => return Ok(hasher.finish()),
            n => hasher.update(&buffer[..n]),
        }
    }
}
