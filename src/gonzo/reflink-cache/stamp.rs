// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The store a cache's clean files are vouched for in.
//!
//! A clean file is a copy of a blob kept elsewhere: in the store the
//! node belongs to, whose ID the leader gives it. The cache keeps that ID
//! in its `store` file. A node that joins another store cannot count on
//! that store keeping the blobs of the clean files it has: they are plain
//! cache, handed out still, but not counted as held when a blob is taken
//! in, until the node registers them with the new store and vouches for
//! them ([`FileCache::vouch`]). Clean files made from then on, fetched
//! from the store or marked clean once copied to it, are vouched for.
//!
//! The stamp is written only once no clean file is left unvouched, so it
//! never vouches for a file the store may lack. A cache that stops before
//! then has the old stamp still, and the node registers its clean files
//! again when it joins once more.

use std::io;
use std::path::PathBuf;
use std::sync::Arc;

use reapi_cas::{Digest, DigestFn};

use crate::fs::Fs;
use crate::layout::{Layout, read_small, replace_small};
use crate::{FileCache, Inner};

/// What a cache knows of its store.
#[derive(Debug)]
pub(crate) struct Stamp {
    /// The ID in the `store` file.
    pub on_disk: Option<String>,
    /// The store vouched-for clean files are known to be kept in.
    pub vouched_for: Option<String>,
}

impl<F: Fs> FileCache<F> {
    /// The store the cache's clean files were last all vouched for in, if
    /// any.
    pub fn store_id(&self) -> Option<String> {
        self.inner.stamp().on_disk.clone()
    }

    /// Join the store with the ID `store`. Unless the clean files are
    /// vouched for in it already, every one held now is plain cache from
    /// now on, and returned, to be registered with the store and vouched
    /// for.
    pub async fn join(&self, store: &str) -> io::Result<Vec<(DigestFn, Digest)>> {
        if store.is_empty() || store.contains('\n') {
            return Err(io::Error::new(
                io::ErrorKind::InvalidInput,
                format!("{store:?} is not a store ID"),
            ));
        }
        let unvouched = {
            let mut stamp = self.inner.stamp();
            if stamp.vouched_for.as_deref() == Some(store) {
                return Ok(Vec::new());
            }
            stamp.vouched_for = Some(store.to_owned());
            self.inner.lock().unvouch_all()
        };
        self.inner.stamp_if_vouched().await?;
        Ok(unvouched)
    }

    /// Vouch for the clean files with `digests`, once the store is known
    /// to keep their blobs. Once none is left unvouched, by this or by
    /// eviction, the store's ID is stamped on the cache.
    pub async fn vouch(&self, function: DigestFn, digests: &[Digest]) -> io::Result<()> {
        {
            let mut index = self.inner.lock();
            for digest in digests {
                index.vouch(&(function, *digest));
            }
        }
        self.inner.stamp_if_vouched().await
    }

    /// The clean files not vouched for in the store last joined.
    pub fn unvouched(&self) -> Vec<(DigestFn, Digest)> {
        self.inner.lock().unvouched().collect()
    }

    /// Every clean file.
    pub fn clean_files(&self) -> Vec<(DigestFn, Digest)> {
        self.inner.lock().clean().collect()
    }
}

impl<F: Fs> Inner<F> {
    pub(crate) fn stamp(&self) -> std::sync::MutexGuard<'_, Stamp> {
        self.stamp.lock().unwrap_or_else(|e| e.into_inner())
    }

    /// Write the stamp of the store joined, if it is due: if it is not on
    /// disk, and every clean file is vouched for.
    pub(crate) async fn stamp_if_vouched(self: &Arc<Self>) -> io::Result<()> {
        let due = {
            let stamp = self.stamp();
            match &stamp.vouched_for {
                Some(store) if stamp.on_disk.as_ref() != Some(store) => Some(store.clone()),
                _ => None,
            }
        };
        let Some(store) = due else {
            return Ok(());
        };
        if self.lock().unvouched_count() > 0 {
            return Ok(());
        }
        let inner = self.clone();
        let written = store.clone();
        self.fs
            .blocking(move || write_stamp(&inner.fs, &inner.layout, &written))
            .await?;
        self.stamp().on_disk = Some(store);
        Ok(())
    }
}

fn stamp_path(layout: &Layout) -> PathBuf {
    layout.root.join("store")
}

pub(crate) fn read_stamp(fs: &impl Fs, layout: &Layout) -> io::Result<Option<String>> {
    Ok(read_small(fs, &stamp_path(layout))?.and_then(|contents| {
        contents
            .strip_suffix('\n')
            .filter(|id| !id.is_empty() && !id.contains('\n'))
            .map(str::to_owned)
    }))
}

fn write_stamp(fs: &impl Fs, layout: &Layout, store: &str) -> io::Result<()> {
    replace_small(fs, layout, &stamp_path(layout), &format!("{store}\n"))
}
