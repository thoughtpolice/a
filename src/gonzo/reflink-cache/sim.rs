// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A simulated filesystem in memory, for testing what a cache keeps when
//! the machine loses power.
//!
//! [`SimFs`] keeps two states. The live one is what processes see, and
//! every call reads and changes it. The disk one is what a power loss is
//! certain to keep, and it changes only as ext4 and XFS make things
//! durable:
//!
//! - a file's data reaches the disk when the file is synced
//!   ([`File::sync_data`]), not before;
//! - a directory's changes (a name created, removed, or renamed in or out)
//!   reach the disk when the directory is synced ([`Fs::sync_dir`]),
//!   with the earlier changes they depend on (to the same inodes or
//!   names). A rename is one
//!   change to both of its directories, so syncing either makes all of it
//!   durable, as the journals of both filesystems do;
//! - [`Fs::sync_fs`] makes everything durable.
//!
//! [`SimFs::crash`] is the power loss. What was not durable may survive
//! or not, as a chooser the test supplies decides: each pending directory
//! change, in order, is kept or dropped, and each file whose data was
//! not synced comes back as it was last synced, as it is now, cut short,
//! or with its end zeroed (its size reached the disk but not its blocks).
//! Changes to different inodes and names are dropped independently,
//! which is harsher than a journal, which keeps them all in order: so
//! code correct here does not depend on the order in which a filesystem
//! happens to commit. Changes that depend on each other stay in order.
//!
//! A crash can also land in the middle of the code under test:
//! [`SimFs::crash_after`] lets a number of calls succeed and fails every
//! one after, as if the machine stopped there.
//!
//! What it does not model: hard links, symlinks, permissions (modes are
//! kept but never checked), timestamps other than a modification clock,
//! disk space, and the inode metadata `fsync` adds over `fdatasync`.
//! Reads and writes are whole calls, never torn in the live state.

use std::collections::{BTreeMap, BTreeSet};
use std::ffi::{OsStr, OsString};
use std::io;
use std::path::{Component, Path};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime};

use crate::fs::{DirEntry, File, Fs, Metadata};

type Ino = u64;

const ROOT: Ino = 1;

/// See the module documentation.
#[derive(Clone, Debug)]
pub struct SimFs {
    state: Arc<Mutex<State>>,
}

/// The error of every call made after a simulated crash.
#[derive(Debug)]
struct Crashed;

impl std::fmt::Display for Crashed {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("the simulated machine crashed")
    }
}

impl std::error::Error for Crashed {}

/// How many calls of each kind that make things durable were made.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Stats {
    pub sync_data: u64,
    pub sync_dir: u64,
    pub sync_fs: u64,
}

#[derive(Debug)]
struct State {
    live: Tree,
    disk: Tree,
    /// Directory changes not yet durable, oldest first.
    pending: Vec<Change>,
    /// Directories that are the roots of filesystems of their own:
    /// renames between filesystems fail, and reflinks are not made.
    devices: BTreeSet<Ino>,
    reflinks: bool,
    next_ino: Ino,
    clock: u64,
    /// Which run of the machine this is; handles opened before a crash
    /// fail after it.
    generation: u64,
    /// Calls left before a crash, if one is set.
    countdown: Option<u64>,
    crashed: bool,
    calls: u64,
    stats: Stats,
}

#[derive(Clone, Debug, Default)]
struct Tree {
    inodes: BTreeMap<Ino, Inode>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
enum Inode {
    Dir(BTreeMap<OsString, Ino>),
    File {
        data: Vec<u8>,
        mode: u32,
        modified: u64,
    },
}

/// A change to directories, as the disk sees it.
#[derive(Clone, Debug)]
enum Change {
    Link {
        dir: Ino,
        name: OsString,
        ino: Ino,
    },
    /// Remove `name` from `dir`, if it still names `ino`.
    Unlink {
        dir: Ino,
        name: OsString,
        ino: Ino,
    },
    Rename {
        from: Ino,
        from_name: OsString,
        to: Ino,
        to_name: OsString,
        ino: Ino,
    },
}

impl Change {
    fn touches(&self, dir: Ino) -> bool {
        match self {
            Change::Link { dir: d, .. } | Change::Unlink { dir: d, .. } => *d == dir,
            Change::Rename { from, to, .. } => *from == dir || *to == dir,
        }
    }

    /// What the change depends on: the inode it names and the names it
    /// sets or clears. Changes sharing any of these stay in order.
    fn keys(&self) -> Vec<Key> {
        match self {
            Change::Link { dir, name, ino } | Change::Unlink { dir, name, ino } => {
                vec![Key::Ino(*ino), Key::Name(*dir, name.clone())]
            }
            Change::Rename {
                from,
                from_name,
                to,
                to_name,
                ino,
            } => vec![
                Key::Ino(*ino),
                Key::Name(*from, from_name.clone()),
                Key::Name(*to, to_name.clone()),
            ],
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq, PartialOrd, Ord)]
enum Key {
    Ino(Ino),
    Name(Ino, OsString),
}

impl Tree {
    fn dir_mut(&mut self, ino: Ino) -> &mut BTreeMap<OsString, Ino> {
        match self
            .inodes
            .entry(ino)
            .or_insert(Inode::Dir(BTreeMap::new()))
        {
            Inode::Dir(entries) => entries,
            Inode::File { .. } => unreachable!("inode {ino} is a directory"),
        }
    }

    /// Apply `change` to the disk, whose inodes may lack the ones it names
    /// if they were never made durable.
    fn apply(&mut self, change: &Change, live: &Tree) {
        let ensure = |tree: &mut Tree, ino: Ino| {
            tree.inodes
                .entry(ino)
                .or_insert_with(|| match live.inodes.get(&ino) {
                    Some(Inode::Dir(_)) => Inode::Dir(BTreeMap::new()),
                    _ => Inode::File {
                        data: Vec::new(),
                        mode: 0o644,
                        modified: 0,
                    },
                });
        };
        match change {
            Change::Link { dir, name, ino } => {
                ensure(self, *ino);
                self.dir_mut(*dir).insert(name.clone(), *ino);
            }
            Change::Unlink { dir, name, ino } => {
                let entries = self.dir_mut(*dir);
                if entries.get(name) == Some(ino) {
                    entries.remove(name);
                }
            }
            Change::Rename {
                from,
                from_name,
                to,
                to_name,
                ino,
            } => {
                ensure(self, *ino);
                let entries = self.dir_mut(*from);
                if entries.get(from_name) == Some(ino) {
                    entries.remove(from_name);
                }
                self.dir_mut(*to).insert(to_name.clone(), *ino);
            }
        }
    }

    /// Forget inodes no name reaches.
    fn collect(&mut self) {
        let mut reachable = BTreeSet::new();
        let mut stack = vec![ROOT];
        while let Some(ino) = stack.pop() {
            if !reachable.insert(ino) {
                continue;
            }
            if let Some(Inode::Dir(entries)) = self.inodes.get(&ino) {
                stack.extend(entries.values());
            }
        }
        self.inodes.retain(|ino, _| reachable.contains(ino));
    }
}

fn not_found(path: &Path) -> io::Error {
    io::Error::new(
        io::ErrorKind::NotFound,
        format!("{}: no such file or directory", path.display()),
    )
}

fn error(kind: io::ErrorKind, path: &Path) -> io::Error {
    io::Error::new(kind, format!("{}: {kind}", path.display()))
}

impl State {
    /// Count a call, and fail it if the machine has crashed or crashes now.
    fn call(&mut self) -> io::Result<()> {
        if !self.crashed {
            self.calls += 1;
            match &mut self.countdown {
                Some(0) => self.crashed = true,
                Some(n) => *n -= 1,
                None => {}
            }
        }
        if self.crashed {
            Err(io::Error::other(Crashed))
        } else {
            Ok(())
        }
    }

    fn tick(&mut self) -> u64 {
        self.clock += 1;
        self.clock
    }

    fn lookup(&self, path: &Path) -> io::Result<Ino> {
        let mut ino = ROOT;
        for component in path.components() {
            match component {
                Component::RootDir | Component::CurDir => {}
                Component::Normal(name) => match &self.live.inodes[&ino] {
                    Inode::Dir(entries) => {
                        ino = *entries.get(name).ok_or_else(|| not_found(path))?;
                    }
                    Inode::File { .. } => return Err(error(io::ErrorKind::NotADirectory, path)),
                },
                Component::ParentDir | Component::Prefix(_) => {
                    return Err(error(io::ErrorKind::InvalidInput, path));
                }
            }
        }
        Ok(ino)
    }

    /// The directory holding `path`, and `path`'s name in it.
    fn parent<'p>(&self, path: &'p Path) -> io::Result<(Ino, &'p OsStr)> {
        let name = path
            .file_name()
            .ok_or_else(|| error(io::ErrorKind::InvalidInput, path))?;
        let dir = self.lookup(path.parent().unwrap_or(Path::new("/")))?;
        match self.live.inodes[&dir] {
            Inode::Dir(_) => Ok((dir, name)),
            Inode::File { .. } => Err(error(io::ErrorKind::NotADirectory, path)),
        }
    }

    fn entries_mut(&mut self, dir: Ino) -> &mut BTreeMap<OsString, Ino> {
        self.live.dir_mut(dir)
    }

    /// The root of the filesystem `ino`, a directory, is on.
    fn device(&self, mut ino: Ino) -> Ino {
        loop {
            if ino == ROOT || self.devices.contains(&ino) {
                return ino;
            }
            ino = self
                .live
                .inodes
                .iter()
                .find_map(|(parent, inode)| match inode {
                    Inode::Dir(entries) if entries.values().any(|&i| i == ino) => Some(*parent),
                    _ => None,
                })
                .unwrap_or(ROOT);
        }
    }

    fn file_mut(&mut self, ino: Ino) -> &mut Inode {
        self.live.inodes.get_mut(&ino).expect("open files exist")
    }

    /// Make durable the changes to `dir`, and the changes before them that
    /// they depend on: a filesystem never commits an inode's rename before
    /// its creation, or a name's replacement before what it replaced.
    fn sync_dir(&mut self, dir: Ino) {
        let mut keys = BTreeSet::new();
        let mut durable = vec![false; self.pending.len()];
        for (i, change) in self.pending.iter().enumerate().rev() {
            let changed = change.keys();
            if change.touches(dir) || changed.iter().any(|key| keys.contains(key)) {
                durable[i] = true;
                keys.extend(changed);
            }
        }
        let mut durable = durable.into_iter();
        let (durable, pending): (Vec<_>, Vec<_>) = std::mem::take(&mut self.pending)
            .into_iter()
            .partition(|_| durable.next().unwrap());
        for change in &durable {
            self.disk.apply(change, &self.live);
        }
        self.pending = pending;
    }

    fn sync_data(&mut self, ino: Ino) {
        let live = self.live.inodes[&ino].clone();
        self.disk.inodes.insert(ino, live);
    }
}

impl Default for SimFs {
    fn default() -> Self {
        Self::new()
    }
}

impl SimFs {
    /// An empty filesystem: just a root directory, durable.
    pub fn new() -> Self {
        let mut tree = Tree::default();
        tree.inodes.insert(ROOT, Inode::Dir(BTreeMap::new()));
        SimFs {
            state: Arc::new(Mutex::new(State {
                live: tree.clone(),
                disk: tree,
                pending: Vec::new(),
                devices: BTreeSet::new(),
                reflinks: true,
                next_ino: ROOT + 1,
                clock: 0,
                generation: 0,
                countdown: None,
                crashed: false,
                calls: 0,
                stats: Stats::default(),
            })),
        }
    }

    fn lock(&self) -> MutexGuard<'_, State> {
        self.state.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Let `calls` more calls succeed, then crash: fail every call after,
    /// until [`crash`](Self::crash) restarts the machine.
    pub fn crash_after(&self, calls: u64) {
        self.lock().countdown = Some(calls);
    }

    /// Never crash of itself, undoing [`crash_after`](Self::crash_after).
    pub fn no_crash(&self) {
        self.lock().countdown = None;
    }

    /// Whether the machine has crashed and not been restarted.
    pub fn crashed(&self) -> bool {
        self.lock().crashed
    }

    /// Whether `error` is the failure of a call made after a crash.
    pub fn is_crash(error: &io::Error) -> bool {
        error.get_ref().is_some_and(|e| e.is::<Crashed>())
    }

    /// The calls made so far.
    pub fn calls(&self) -> u64 {
        self.lock().calls
    }

    pub fn stats(&self) -> Stats {
        self.lock().stats
    }

    /// Whether anything is not yet durable, which a crash could lose.
    pub fn unsynced(&self) -> bool {
        let state = self.lock();
        !state.pending.is_empty()
            || state.live.inodes.iter().any(|(ino, inode)| {
                matches!(inode, Inode::File { .. }) && state.disk.inodes.get(ino) != Some(inode)
            })
    }

    /// Whether files are reflinked; they are unless this is turned off.
    pub fn set_reflinks(&self, reflinks: bool) {
        self.lock().reflinks = reflinks;
    }

    /// Make the directory at `path`, durably, as the root of a filesystem
    /// of its own.
    pub fn add_device(&self, path: &Path) -> io::Result<()> {
        self.create_dir(path)?;
        let mut state = self.lock();
        let ino = state.lookup(path)?;
        state.devices.insert(ino);
        drop(state);
        self.sync_fs(path)
    }

    /// Lose power and start again: keep what is durable, and of the rest,
    /// what `choose` says. `choose(n)` returns a number below `n`, and is
    /// asked for each pending directory change (`n` = 2, 1 to keep it)
    /// and each file with unsynced data (`n` = 4 for the version, then
    /// for a length if it is cut short or zeroed).
    pub fn crash(&self, choose: &mut dyn FnMut(u64) -> u64) {
        let mut pick = |n: u64| choose(n) % n;
        let mut state = self.lock();
        let state = &mut *state;
        // Changes that depend on each other are kept in order: once one is
        // dropped, so are the later ones depending on it.
        let mut dropped = BTreeSet::new();
        for change in std::mem::take(&mut state.pending) {
            let keys = change.keys();
            if !keys.iter().any(|key| dropped.contains(key)) && pick(2) == 1 {
                state.disk.apply(&change, &state.live);
            } else {
                dropped.extend(keys);
            }
        }
        for (ino, inode) in &state.live.inodes {
            let Inode::File {
                data,
                mode,
                modified,
            } = inode
            else {
                continue;
            };
            let synced = match state.disk.inodes.get(ino) {
                Some(Inode::File { data, .. }) => data.clone(),
                Some(Inode::Dir(_)) => unreachable!("inode {ino} is a file"),
                // The file's name never reached the disk; it is gone.
                None => continue,
            };
            if synced == *data {
                continue;
            }
            let len = data.len() as u64;
            let survived = match pick(4) {
                0 => synced,
                1 => data.clone(),
                2 => data[..pick(len + 1) as usize].to_vec(),
                _ => {
                    let mut zeroed = data.clone();
                    let from = pick(len + 1) as usize;
                    zeroed[from..].fill(0);
                    zeroed
                }
            };
            state.disk.inodes.insert(
                *ino,
                Inode::File {
                    data: survived,
                    mode: *mode,
                    modified: *modified,
                },
            );
        }
        state.disk.collect();
        state.live = state.disk.clone();
        state
            .devices
            .retain(|ino| state.live.inodes.contains_key(ino));
        state.generation += 1;
        state.countdown = None;
        state.crashed = false;
    }

    /// The live contents of the file at `path`, read without counting as
    /// a call: for checking what the code under test did.
    pub fn read(&self, path: &Path) -> io::Result<Vec<u8>> {
        let state = self.lock();
        match &state.live.inodes[&state.lookup(path)?] {
            Inode::File { data, .. } => Ok(data.clone()),
            Inode::Dir(_) => Err(error(io::ErrorKind::IsADirectory, path)),
        }
    }

    /// Create or replace the file at `path` with `data`, durably, without
    /// counting as a call: for setting up what the code under test finds.
    pub fn write(&self, path: &Path, data: &[u8]) -> io::Result<()> {
        let mut state = self.lock();
        let (dir, name) = state.parent(path)?;
        let ino = state.next_ino;
        state.next_ino += 1;
        let modified = state.tick();
        let inode = Inode::File {
            data: data.to_vec(),
            mode: 0o644,
            modified,
        };
        state.live.inodes.insert(ino, inode.clone());
        state.entries_mut(dir).insert(name.to_owned(), ino);
        state.disk.inodes.insert(ino, inode);
        state.disk.dir_mut(dir).insert(name.to_owned(), ino);
        Ok(())
    }

    fn handle(&self, ino: Ino, generation: u64) -> SimFile {
        SimFile {
            fs: self.clone(),
            ino,
            generation,
            position: 0,
        }
    }
}

impl Fs for SimFs {
    type File = SimFile;

    fn open(&self, path: &Path) -> io::Result<SimFile> {
        let mut state = self.lock();
        state.call()?;
        let ino = state.lookup(path)?;
        if let Inode::Dir(_) = state.live.inodes[&ino] {
            return Err(error(io::ErrorKind::IsADirectory, path));
        }
        Ok(self.handle(ino, state.generation))
    }

    fn create_new(&self, path: &Path) -> io::Result<SimFile> {
        let mut state = self.lock();
        state.call()?;
        let (dir, name) = state.parent(path)?;
        if state.entries_mut(dir).contains_key(name) {
            return Err(error(io::ErrorKind::AlreadyExists, path));
        }
        let ino = state.next_ino;
        state.next_ino += 1;
        let modified = state.tick();
        state.live.inodes.insert(
            ino,
            Inode::File {
                data: Vec::new(),
                mode: 0o644,
                modified,
            },
        );
        state.entries_mut(dir).insert(name.to_owned(), ino);
        state.pending.push(Change::Link {
            dir,
            name: name.to_owned(),
            ino,
        });
        Ok(self.handle(ino, state.generation))
    }

    fn rename(&self, from: &Path, to: &Path) -> io::Result<()> {
        let mut state = self.lock();
        state.call()?;
        let (from_dir, from_name) = state.parent(from)?;
        let (to_dir, to_name) = state.parent(to)?;
        let ino = *state
            .entries_mut(from_dir)
            .get(from_name)
            .ok_or_else(|| not_found(from))?;
        if state.device(from_dir) != state.device(to_dir) {
            return Err(io::Error::from_raw_os_error(libc::EXDEV));
        }
        if let Some(&replaced) = state.entries_mut(to_dir).get(to_name) {
            if replaced == ino {
                return Ok(());
            }
            if let Inode::Dir(_) = state.live.inodes[&replaced] {
                return Err(error(io::ErrorKind::IsADirectory, to));
            }
        }
        state.entries_mut(from_dir).remove(from_name);
        state.entries_mut(to_dir).insert(to_name.to_owned(), ino);
        state.pending.push(Change::Rename {
            from: from_dir,
            from_name: from_name.to_owned(),
            to: to_dir,
            to_name: to_name.to_owned(),
            ino,
        });
        Ok(())
    }

    fn remove_file(&self, path: &Path) -> io::Result<()> {
        let mut state = self.lock();
        state.call()?;
        let (dir, name) = state.parent(path)?;
        let ino = *state
            .entries_mut(dir)
            .get(name)
            .ok_or_else(|| not_found(path))?;
        if let Inode::Dir(_) = state.live.inodes[&ino] {
            return Err(error(io::ErrorKind::IsADirectory, path));
        }
        state.entries_mut(dir).remove(name);
        state.pending.push(Change::Unlink {
            dir,
            name: name.to_owned(),
            ino,
        });
        Ok(())
    }

    fn create_dir(&self, path: &Path) -> io::Result<()> {
        let mut state = self.lock();
        state.call()?;
        let (dir, name) = state.parent(path)?;
        if state.entries_mut(dir).contains_key(name) {
            return Err(error(io::ErrorKind::AlreadyExists, path));
        }
        let ino = state.next_ino;
        state.next_ino += 1;
        state.live.inodes.insert(ino, Inode::Dir(BTreeMap::new()));
        state.entries_mut(dir).insert(name.to_owned(), ino);
        state.pending.push(Change::Link {
            dir,
            name: name.to_owned(),
            ino,
        });
        Ok(())
    }

    fn sync_dir(&self, path: &Path) -> io::Result<()> {
        let mut state = self.lock();
        state.call()?;
        let ino = state.lookup(path)?;
        if let Inode::File { .. } = state.live.inodes[&ino] {
            return Err(error(io::ErrorKind::NotADirectory, path));
        }
        state.stats.sync_dir += 1;
        state.sync_dir(ino);
        Ok(())
    }

    fn sync_fs(&self, path: &Path) -> io::Result<()> {
        let mut state = self.lock();
        state.call()?;
        state.lookup(path)?;
        state.stats.sync_fs += 1;
        let state = &mut *state;
        for change in std::mem::take(&mut state.pending) {
            state.disk.apply(&change, &state.live);
        }
        let files: Vec<Ino> = state.live.inodes.keys().copied().collect();
        for ino in files {
            if let Inode::File { .. } = state.live.inodes[&ino] {
                state.sync_data(ino);
            }
        }
        Ok(())
    }

    fn read_dir(&self, path: &Path) -> io::Result<Vec<DirEntry>> {
        let mut state = self.lock();
        state.call()?;
        let ino = state.lookup(path)?;
        let Inode::Dir(entries) = &state.live.inodes[&ino] else {
            return Err(error(io::ErrorKind::NotADirectory, path));
        };
        Ok(entries
            .iter()
            .map(|(name, ino)| DirEntry {
                name: name.clone(),
                is_dir: matches!(state.live.inodes[ino], Inode::Dir(_)),
            })
            .collect())
    }

    fn metadata(&self, path: &Path) -> io::Result<Metadata> {
        let mut state = self.lock();
        state.call()?;
        let ino = state.lookup(path)?;
        Ok(match &state.live.inodes[&ino] {
            Inode::Dir(_) => Metadata {
                len: 0,
                is_dir: true,
                modified: SystemTime::UNIX_EPOCH,
            },
            Inode::File { data, modified, .. } => Metadata {
                len: data.len() as u64,
                is_dir: false,
                modified: SystemTime::UNIX_EPOCH + Duration::from_nanos(*modified),
            },
        })
    }

    fn reflink(&self, from: &SimFile, to: &SimFile) -> bool {
        let mut state = self.lock();
        if state.call().is_err() || !state.reflinks {
            return false;
        }
        if from.generation != state.generation || to.generation != state.generation {
            return false;
        }
        // The two must be on one filesystem; the inodes' directories are
        // not known here, so compare the devices of any directories
        // naming them.
        let device_of = |state: &State, ino: Ino| {
            state
                .live
                .inodes
                .iter()
                .find_map(|(dir, inode)| match inode {
                    Inode::Dir(entries) if entries.values().any(|&i| i == ino) => {
                        Some(state.device(*dir))
                    }
                    _ => None,
                })
        };
        if device_of(&state, from.ino) != device_of(&state, to.ino) {
            return false;
        }
        let Inode::File { data, .. } = state.live.inodes[&from.ino].clone() else {
            return false;
        };
        let modified = state.tick();
        if let Inode::File {
            data: to_data,
            modified: to_modified,
            ..
        } = state.file_mut(to.ino)
        {
            *to_data = data;
            *to_modified = modified;
        }
        true
    }

    /// Run `work` once other tasks have had a turn, on the calling thread,
    /// so a test on a single-threaded runtime is deterministic, yet tasks
    /// still interleave where they would wait on blocking threads.
    async fn blocking<T: Send + 'static>(&self, work: impl FnOnce() -> T + Send + 'static) -> T {
        tokio::task::yield_now().await;
        work()
    }
}

/// An open file on a [`SimFs`].
#[derive(Debug)]
pub struct SimFile {
    fs: SimFs,
    ino: Ino,
    generation: u64,
    position: u64,
}

impl SimFile {
    /// The machine's state, if it is still the run this file was opened in.
    fn state(&self) -> io::Result<MutexGuard<'_, State>> {
        let mut state = self.fs.lock();
        state.call()?;
        if state.generation != self.generation {
            return Err(io::Error::other("the file was opened before a crash"));
        }
        Ok(state)
    }
}

impl io::Read for SimFile {
    fn read(&mut self, buf: &mut [u8]) -> io::Result<usize> {
        let state = self.state()?;
        let Inode::File { data, .. } = &state.live.inodes[&self.ino] else {
            unreachable!("open files are files");
        };
        let at = (self.position as usize).min(data.len());
        let n = buf.len().min(data.len() - at);
        buf[..n].copy_from_slice(&data[at..at + n]);
        drop(state);
        self.position += n as u64;
        Ok(n)
    }
}

impl io::Write for SimFile {
    fn write(&mut self, buf: &[u8]) -> io::Result<usize> {
        let mut state = self.state()?;
        let modified = state.tick();
        let Inode::File {
            data,
            modified: when,
            ..
        } = state.file_mut(self.ino)
        else {
            unreachable!("open files are files");
        };
        let at = self.position as usize;
        if data.len() < at {
            data.resize(at, 0);
        }
        let overlap = buf.len().min(data.len() - at);
        data[at..at + overlap].copy_from_slice(&buf[..overlap]);
        data.extend_from_slice(&buf[overlap..]);
        *when = modified;
        drop(state);
        self.position += buf.len() as u64;
        Ok(buf.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

impl File for SimFile {
    fn sync_data(&self) -> io::Result<()> {
        let mut state = self.state()?;
        state.stats.sync_data += 1;
        state.sync_data(self.ino);
        Ok(())
    }

    fn size(&self) -> io::Result<u64> {
        let state = self.state()?;
        match &state.live.inodes[&self.ino] {
            Inode::File { data, .. } => Ok(data.len() as u64),
            Inode::Dir(_) => unreachable!("open files are files"),
        }
    }

    fn set_mode(&self, mode: u32) -> io::Result<()> {
        let mut state = self.state()?;
        if let Inode::File { mode: m, .. } = state.file_mut(self.ino) {
            *m = mode;
        }
        Ok(())
    }
}
