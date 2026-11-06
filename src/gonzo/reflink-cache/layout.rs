// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Where a cache keeps its files, and finding what an earlier run left.

use std::io;
use std::path::{Path, PathBuf};
use std::time::SystemTime;

use reapi_cas::{Digest, DigestFn};

use crate::fs::Fs;
use crate::index::Name;

const FUNCTIONS: [DigestFn; 3] = [DigestFn::Sha256, DigestFn::Blake3, DigestFn::Sha256Tree];

/// The paths of a cache in `root`; see the crate documentation.
#[derive(Clone, Debug)]
pub(crate) struct Layout {
    pub root: PathBuf,
    pub partial: PathBuf,
    pub dirty: PathBuf,
}

/// A clean file an earlier run left.
pub(crate) struct FoundClean {
    pub name: Name,
    pub modified: SystemTime,
}

/// A dirty file an earlier run left.
pub(crate) struct FoundDirty {
    pub seq: u64,
    pub name: Name,
}

/// What an earlier run left.
#[derive(Default)]
pub(crate) struct Found {
    pub clean: Vec<FoundClean>,
    pub dirty: Vec<FoundDirty>,
    /// Dirty files whose size is not their digest's, which were removed.
    pub torn: Vec<Name>,
}

impl Layout {
    pub fn new(root: &Path) -> Self {
        Layout {
            root: root.to_path_buf(),
            partial: root.join("partial"),
            dirty: root.join("dirty"),
        }
    }

    pub fn clean(&self, (function, digest): &Name) -> PathBuf {
        let hash = digest.hex();
        self.root
            .join(function.to_string())
            .join(&hash[..2])
            .join(format!("{hash}-{}", digest.size))
    }

    pub fn dirty(&self, (function, digest): &Name, seq: u64) -> PathBuf {
        self.dirty
            .join(format!("{seq}-{function}-{}-{}", digest.hex(), digest.size))
    }

    /// The files in the clean and dirty areas, with files whose names are
    /// not the cache's removed, and so are files whose sizes are wrong: a
    /// file cut short is not its blob.
    pub fn scan(&self, fs: &impl Fs) -> io::Result<Found> {
        let mut found = Found::default();
        for function in FUNCTIONS {
            let functions = self.root.join(function.to_string());
            let Ok(fans) = fs.read_dir(&functions) else {
                continue;
            };
            for fan in fans {
                let fan = functions.join(fan.name);
                for file in fs.read_dir(&fan)? {
                    let path = fan.join(&file.name);
                    let metadata = fs.metadata(&path)?;
                    match file.name.to_str().and_then(parse_clean) {
                        Some(digest) if digest.size == metadata.len => {
                            found.clean.push(FoundClean {
                                name: (function, digest),
                                modified: metadata.modified,
                            })
                        }
                        _ => fs.remove_file(&path)?,
                    }
                }
            }
        }
        for file in fs.read_dir(&self.dirty)? {
            let path = self.dirty.join(&file.name);
            let metadata = fs.metadata(&path)?;
            match file.name.to_str().and_then(parse_dirty) {
                Some((seq, name)) if name.1.size == metadata.len => {
                    found.dirty.push(FoundDirty { seq, name })
                }
                Some((_, name)) => {
                    found.torn.push(name);
                    fs.remove_file(&path)?;
                }
                None => fs.remove_file(&path)?,
            }
        }
        Ok(found)
    }
}

fn parse_clean(name: &str) -> Option<Digest> {
    let (hash, size) = name.rsplit_once('-')?;
    Digest::parse(hash, size.parse().ok()?).ok()
}

fn parse_dirty(name: &str) -> Option<(u64, Name)> {
    let (seq, rest) = name.split_once('-')?;
    let (function, rest) = rest.split_once('-')?;
    Some((
        seq.parse().ok()?,
        (function.parse().ok()?, parse_clean(rest)?),
    ))
}
