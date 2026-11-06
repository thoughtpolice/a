// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What the cache holds, in memory.

use std::collections::{BTreeMap, HashMap};

use reapi_cas::{Digest, DigestFn};

/// A cached file, as the index knows it.
pub(crate) type Name = (DigestFn, Digest);

/// Every cached file, in order of use.
#[derive(Debug, Default)]
pub(crate) struct Index {
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
    pub(crate) fn pin(&mut self, name: &Name) -> bool {
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

    pub(crate) fn unpin(&mut self, name: &Name) {
        if let Some(entry) = self.entries.get_mut(name) {
            entry.pins -= 1;
        }
    }

    /// Add a file the cache now holds, unless it already had it, and pin it
    /// if `pinned`.
    pub(crate) fn insert(&mut self, name: Name, size: u64, pinned: bool) {
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
    pub(crate) fn evict(&mut self, max_bytes: u64) -> Vec<Name> {
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
