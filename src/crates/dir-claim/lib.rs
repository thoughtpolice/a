// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! One process at a time per directory, and a note saying which.
//!
//! A [`Claim`] is an exclusive lock on a file in the directory, held for
//! the claim's life, beside a state file of the holder's choosing (JSON of
//! any serde type: where it listens, its pid, its version). A second
//! process finds the lock taken and can read the state to say who has the
//! directory. The lock is an `flock`, so it goes when the holder exits, by
//! any means; the state file is written whole and renamed into place, so a
//! reader never sees half of one, and removed while the lock is still held,
//! so the next holder never finds the last one's.

use std::fmt;
use std::fs::File;
use std::io::{self, Write as _};
use std::marker::PhantomData;
use std::os::unix::fs::OpenOptionsExt as _;
use std::path::{Path, PathBuf};

use serde::Serialize;
use serde::de::DeserializeOwned;

/// The names of a claim's files in its directory.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Files {
    /// The file holding the lock.
    pub lock: &'static str,
    /// The holder's state, once it has announced it.
    pub state: &'static str,
}

/// A filesystem operation that failed, or a state that did not encode.
#[derive(Debug, thiserror::Error)]
pub enum Error {
    #[error("failed to {action} {}", path.display())]
    Io {
        action: &'static str,
        path: PathBuf,
        #[source]
        source: io::Error,
    },
    #[error("failed to encode {}", path.display())]
    Encode {
        path: PathBuf,
        #[source]
        source: serde_json::Error,
    },
}

/// Why a directory could not be claimed.
#[derive(Debug)]
pub enum TakeError<T> {
    /// Another process holds the lock. `holder` is its state, if it has
    /// announced one that decodes as a `T`.
    Held {
        lock: PathBuf,
        holder: Option<T>,
    },
    Failed(Error),
}

impl<T> fmt::Display for TakeError<T> {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Held { lock, .. } => write!(f, "another process holds {}", lock.display()),
            Self::Failed(e) => e.fmt(f),
        }
    }
}

impl<T: fmt::Debug> std::error::Error for TakeError<T> {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        match self {
            Self::Held { .. } => None,
            Self::Failed(e) => Some(e),
        }
    }
}

impl<T> From<Error> for TakeError<T> {
    fn from(e: Error) -> Self {
        Self::Failed(e)
    }
}

fn io<'a>(action: &'static str, path: &'a Path) -> impl FnOnce(io::Error) -> Error + 'a {
    move |source| Error::Io {
        action,
        path: path.to_path_buf(),
        source,
    }
}

/// A process's claim on a directory, with state of type `T`, released
/// when dropped.
#[derive(Debug)]
pub struct Claim<T> {
    dir: PathBuf,
    files: Files,
    /// Held for the claim's life; closing it releases the lock.
    _lock: File,
    _state: PhantomData<fn(&T)>,
}

impl<T: Serialize + DeserializeOwned> Claim<T> {
    /// Claim `dir`, creating it if need be, or say who has it.
    pub fn take(dir: &Path, files: Files) -> Result<Self, TakeError<T>> {
        std::fs::create_dir_all(dir).map_err(io("create the directory", dir))?;
        let path = dir.join(files.lock);
        let lock = File::options()
            .create(true)
            .truncate(false)
            .write(true)
            .open(&path)
            .map_err(io("open", &path))?;
        match lock.try_lock() {
            Ok(()) => Ok(Self {
                dir: dir.to_path_buf(),
                files,
                _lock: lock,
                _state: PhantomData,
            }),
            Err(std::fs::TryLockError::WouldBlock) => Err(TakeError::Held {
                lock: path,
                holder: holder(dir, files),
            }),
            Err(std::fs::TryLockError::Error(e)) => Err(io("lock", &path)(e).into()),
        }
    }

    /// Record `state` as the holder's, readable only by its owner: it may
    /// carry credentials.
    pub fn announce(&self, state: &T) -> Result<(), Error> {
        let path = self.dir.join(self.files.state);
        let partial = self.dir.join(format!("{}.partial", self.files.state));
        let mut file = File::options()
            .write(true)
            .create(true)
            .truncate(true)
            .mode(0o600)
            .open(&partial)
            .map_err(io("create", &partial))?;
        serde_json::to_writer_pretty(&mut file, state).map_err(|source| Error::Encode {
            path: path.clone(),
            source,
        })?;
        file.write_all(b"\n")
            .and_then(|()| file.sync_all())
            .map_err(io("write", &partial))?;
        std::fs::rename(&partial, &path).map_err(io("write", &path))
    }

    /// The directory claimed.
    pub fn dir(&self) -> &Path {
        &self.dir
    }
}

impl<T> Drop for Claim<T> {
    /// Remove the state file while the lock is still held (fields drop
    /// after this), so the next holder never reads this one's.
    fn drop(&mut self) {
        let _ = std::fs::remove_file(self.dir.join(self.files.state));
    }
}

/// The state the holder of `dir` announced, if it has, and it decodes.
pub fn holder<T: DeserializeOwned>(dir: &Path, files: Files) -> Option<T> {
    let json = std::fs::read(dir.join(files.state)).ok()?;
    serde_json::from_slice(&json).ok()
}

#[cfg(test)]
mod tests;
