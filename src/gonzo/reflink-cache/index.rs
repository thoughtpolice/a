// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What the cache holds, in memory.

use std::collections::{BTreeMap, HashMap};

use reapi_cas::{Digest, DigestFn};
use tokio::sync::watch;

use crate::Held;

/// A cached file, as the index knows it.
pub(crate) type Name = (DigestFn, Digest);

/// Every cached file: clean ones in order of use, and dirty ones in the
/// order they were made dirty.
#[derive(Debug)]
pub(crate) struct Index {
    entries: HashMap<Name, Entry>,
    /// Clean files by when they were last used, oldest first: the order
    /// of eviction. Dirty files are never evicted, so are not here.
    by_use: BTreeMap<u64, Name>,
    /// Dirty files by their sequence numbers, oldest first.
    dirty: BTreeMap<u64, Name>,
    clean_bytes: u64,
    dirty_bytes: u64,
    /// `dirty_bytes`, for those waiting for it to drop.
    dirty_watch: watch::Sender<u64>,
    clock: u64,
    next_seq: u64,
}

#[derive(Debug)]
struct Entry {
    size: u64,
    used: u64,
    /// Actions being given the file, which keep it from eviction.
    pins: usize,
    state: State,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum State {
    Clean,
    Dirty {
        /// Orders dirty files, and names the file in the dirty area.
        seq: u64,
        /// The group commit that makes its name durable (see `commit`).
        ticket: u64,
        /// Whether it is being moved to the clean files.
        cleaning: bool,
    },
}

impl State {
    pub(crate) fn held(self) -> Held {
        match self {
            State::Clean => Held::Clean,
            State::Dirty { .. } => Held::Dirty,
        }
    }
}

impl Index {
    pub(crate) fn new() -> Self {
        Index {
            entries: HashMap::new(),
            by_use: BTreeMap::new(),
            dirty: BTreeMap::new(),
            clean_bytes: 0,
            dirty_bytes: 0,
            dirty_watch: watch::Sender::new(0),
            clock: 0,
            next_seq: 0,
        }
    }

    pub(crate) fn state(&self, name: &Name) -> Option<State> {
        self.entries.get(name).map(|entry| entry.state)
    }

    /// Record a use of `name`, pinning it, if the cache has it.
    pub(crate) fn pin(&mut self, name: &Name) -> bool {
        let Some(entry) = self.entries.get_mut(name) else {
            return false;
        };
        self.clock += 1;
        if entry.state == State::Clean {
            self.by_use.remove(&entry.used);
            self.by_use.insert(self.clock, *name);
        }
        entry.used = self.clock;
        entry.pins += 1;
        true
    }

    pub(crate) fn unpin(&mut self, name: &Name) {
        if let Some(entry) = self.entries.get_mut(name) {
            entry.pins -= 1;
        }
    }

    /// Add a clean file the cache now holds, unless it already had it, and
    /// pin it if `pinned`.
    pub(crate) fn insert_clean(&mut self, name: Name, size: u64, pinned: bool) {
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
                state: State::Clean,
            },
        );
        self.clean_bytes += size;
    }

    /// A sequence number for a new dirty file.
    pub(crate) fn next_seq(&mut self) -> u64 {
        self.next_seq += 1;
        self.next_seq
    }

    /// Add a dirty file numbered `seq`, durable once `ticket` is, which
    /// takes the place of a clean one of the same name, keeping its pins.
    pub(crate) fn insert_dirty(&mut self, name: Name, size: u64, seq: u64, ticket: u64) {
        self.next_seq = self.next_seq.max(seq);
        let pins = match self.entries.remove(&name) {
            Some(Entry {
                state: State::Clean,
                used,
                size,
                pins,
            }) => {
                self.by_use.remove(&used);
                self.clean_bytes -= size;
                pins
            }
            Some(Entry {
                state: State::Dirty { .. },
                ..
            }) => unreachable!("{name:?} is dirty already"),
            None => 0,
        };
        self.clock += 1;
        self.dirty.insert(seq, name);
        self.entries.insert(
            name,
            Entry {
                size,
                used: self.clock,
                pins,
                state: State::Dirty {
                    seq,
                    ticket,
                    cleaning: false,
                },
            },
        );
        self.dirty_bytes += size;
        self.dirty_watch.send_replace(self.dirty_bytes);
    }

    /// Start moving the dirty file `name` to the clean files, returning
    /// its sequence number, unless it is not dirty or is being moved.
    pub(crate) fn begin_clean(&mut self, name: &Name) -> Option<u64> {
        let entry = self.entries.get_mut(name)?;
        match &mut entry.state {
            State::Dirty {
                seq,
                cleaning: cleaning @ false,
                ..
            } => {
                *cleaning = true;
                Some(*seq)
            }
            _ => None,
        }
    }

    /// Finish what [`begin_clean`](Self::begin_clean) started: the file is
    /// clean if it `moved`, and still dirty if not.
    pub(crate) fn end_clean(&mut self, name: &Name, moved: bool) {
        let entry = self.entries.get_mut(name).expect("files being moved stay");
        let State::Dirty { seq, cleaning, .. } = &mut entry.state else {
            unreachable!("{name:?} is being moved");
        };
        if !moved {
            *cleaning = false;
            return;
        }
        self.dirty.remove(seq);
        self.dirty_bytes -= entry.size;
        self.dirty_watch.send_replace(self.dirty_bytes);
        self.clean_bytes += entry.size;
        self.clock += 1;
        entry.used = self.clock;
        entry.state = State::Clean;
        self.by_use.insert(self.clock, *name);
    }

    /// Forget the clean files used longest ago, and unpinned, until no
    /// more than `max_bytes` are left, counting dirty files, and return
    /// them for removal.
    pub(crate) fn evict(&mut self, max_bytes: u64) -> Vec<Name> {
        let mut evicted = Vec::new();
        let mut skipped = Vec::new();
        while self.clean_bytes + self.dirty_bytes > max_bytes {
            let Some((used, name)) = self.by_use.pop_first() else {
                break;
            };
            let entry = &self.entries[&name];
            if entry.pins > 0 {
                skipped.push((used, name));
                continue;
            }
            self.clean_bytes -= entry.size;
            self.entries.remove(&name);
            evicted.push(name);
        }
        self.by_use.extend(skipped);
        evicted
    }

    /// Dirty files and their sequence numbers, oldest first.
    pub(crate) fn dirty(&self) -> impl Iterator<Item = (u64, Name)> + '_ {
        self.dirty.iter().map(|(seq, name)| (*seq, *name))
    }

    pub(crate) fn clean_bytes(&self) -> u64 {
        self.clean_bytes
    }

    pub(crate) fn dirty_bytes(&self) -> u64 {
        self.dirty_bytes
    }

    /// Dirty bytes, as they change.
    pub(crate) fn watch_dirty_bytes(&self) -> watch::Receiver<u64> {
        self.dirty_watch.subscribe()
    }

    /// How many files are clean and dirty.
    pub(crate) fn files(&self) -> (usize, usize) {
        (self.entries.len() - self.dirty.len(), self.dirty.len())
    }
}
