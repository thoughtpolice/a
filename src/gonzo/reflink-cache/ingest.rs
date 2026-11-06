// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Taking files in as dirty, and marking them clean.

use std::io;
use std::path::{Path, PathBuf};
use std::sync::Arc;

use reapi_cas::{Digest, DigestFn};

use crate::fs::{File as _, Fs};
use crate::index::{Name, State};
use crate::{FileCache, Held, Ingested, Inner};

impl<F: Fs> FileCache<F> {
    /// Take the file at `path`, whose digest the caller has computed, in
    /// as a dirty file, moving it into the cache: by renaming it if it is
    /// on the cache's filesystem, else by copying it and removing it.
    ///
    /// Returns once the file is durable, unless durability is off. If the
    /// cache holds the blob already, what it has is kept, and durable,
    /// and the file is removed. On failure the file may be gone, taken in
    /// though not known to be durable: the caller cannot count on it.
    pub async fn ingest(
        &self,
        function: DigestFn,
        digest: &Digest,
        path: &Path,
    ) -> io::Result<Ingested> {
        let inner = &self.inner;
        let _writing = inner.writing().await?;
        let name = (function, *digest);
        if let Some(failed) = inner.commits.failed() {
            return Err(failed);
        }
        if let Some((held, ticket)) = inner.held(&name) {
            let _ = inner.fs.remove_file(path);
            // It may have been taken in just now, its name not yet durable.
            inner.wait_durable(ticket).await?;
            return Ok(Ingested::Already(held));
        }
        inner.seal_source(name, path).await?;
        let (entered, ticket) = match inner.enter_dirty(name, path) {
            Err(e) if e.raw_os_error() == Some(libc::EXDEV) => {
                let copy = inner.copy_in(path).await?;
                let entered = inner.enter_dirty(name, &copy);
                if !matches!(entered, Ok((Ingested::Added, _))) {
                    let _ = inner.fs.remove_file(&copy);
                }
                entered?
            }
            Ok((Ingested::Added, ticket)) => {
                inner.wait_durable(ticket).await?;
                return Ok(Ingested::Added);
            }
            entered => entered?,
        };
        // The file was copied in, or the blob was taken in meanwhile.
        let _ = inner.fs.remove_file(path);
        inner.wait_durable(ticket).await?;
        Ok(entered)
    }

    /// Move the dirty files with `digests` to the clean files: once they
    /// are kept elsewhere, durably, so that they may be evicted. Files
    /// the cache does not hold dirty are left as they are.
    ///
    /// Neither move needs to be durable. A file whose move is lost to a
    /// crash is dirty again, and copied elsewhere again; it is never lost,
    /// since a rename is atomic.
    pub async fn mark_clean(&self, function: DigestFn, digests: &[Digest]) -> io::Result<()> {
        let inner = self.inner.clone();
        let writing = inner.writing().await?;
        let names: Vec<Name> = digests.iter().map(|digest| (function, *digest)).collect();
        // All in one piece of blocking work, so that the moves the index
        // records as begun are always ended, even if this is cancelled.
        self.inner
            .fs
            .blocking(move || {
                let _writing = writing;
                inner.mark_clean(&names)
            })
            .await
    }
}

impl<F: Fs> Inner<F> {
    /// How the cache holds `name`, and the ticket to wait for until that
    /// is durable.
    pub(crate) fn held(&self, name: &Name) -> Option<(Held, u64)> {
        match self.lock().state(name)? {
            State::Clean => Some((Held::Clean, 0)),
            State::Dirty { ticket, .. } => Some((Held::Dirty, ticket)),
        }
    }

    /// Check the size of the file at `path`, which is to be `name`, and
    /// make it read-only and its data durable.
    async fn seal_source(self: &Arc<Self>, name: Name, path: &Path) -> io::Result<()> {
        let (inner, path) = (self.clone(), path.to_path_buf());
        self.fs
            .blocking(move || {
                let file = inner.fs.open(&path)?;
                let size = file.size()?;
                if size != name.1.size {
                    return Err(io::Error::new(
                        io::ErrorKind::InvalidInput,
                        format!("{} has {size} bytes, not {}'s", path.display(), name.1),
                    ));
                }
                file.set_mode(0o444)?;
                if inner.options.durable {
                    file.sync_data()?;
                }
                Ok(())
            })
            .await
    }

    /// Copy the file at `path`, on another filesystem, to a new partial
    /// file, sealed.
    async fn copy_in(self: &Arc<Self>, path: &Path) -> io::Result<PathBuf> {
        let (inner, path) = (self.clone(), path.to_path_buf());
        let copy = self.partial();
        let to = copy.clone();
        let copied = self
            .fs
            .blocking(move || {
                let mut from = inner.fs.open(&path)?;
                let mut file = inner.fs.create_new(&to)?;
                if !inner.fs.reflink(&from, &file) {
                    io::copy(&mut from, &mut file)?;
                }
                file.set_mode(0o444)?;
                if inner.options.durable {
                    file.sync_data()?;
                }
                Ok(())
            })
            .await;
        match copied {
            Ok(()) => Ok(copy),
            Err(e) => {
                let _ = self.fs.remove_file(&copy);
                Err(e)
            }
        }
    }

    /// Rename the sealed file at `from` into the dirty area as `name`,
    /// unless the cache holds it already, returning what happened and the
    /// ticket to wait for until it is durable. The rename and the index's
    /// record of it happen under the lock together, with nothing to wait
    /// on between, so that neither eviction nor a cancelled caller can
    /// come between them.
    pub(crate) fn enter_dirty(&self, name: Name, from: &Path) -> io::Result<(Ingested, u64)> {
        let mut index = self.lock();
        if let Some(state) = index.state(&name) {
            let ticket = match state {
                State::Dirty { ticket, .. } => ticket,
                State::Clean => 0,
            };
            return Ok((Ingested::Already(state.held()), ticket));
        }
        let seq = index.next_seq();
        self.fs.rename(from, &self.layout.dirty(&name, seq))?;
        let ticket = if self.options.durable {
            self.commits.issue()
        } else {
            0
        };
        index.insert_dirty(name, name.1.size, seq, ticket);
        let evicted = index.evict(self.options.max_bytes);
        self.remove(evicted);
        Ok((Ingested::Added, ticket))
    }

    fn mark_clean(&self, names: &[Name]) -> io::Result<()> {
        let begun: Vec<(Name, u64)> = {
            let mut index = self.lock();
            names
                .iter()
                .filter_map(|name| Some((*name, index.begin_clean(name)?)))
                .collect()
        };
        let mut result = Ok(());
        let mut moved = Vec::with_capacity(begun.len());
        for (name, seq) in &begun {
            let to = self.layout.clean(name);
            let moving = self
                .make_dir(to.parent().expect("cache paths have parents"))
                .and_then(|()| self.fs.rename(&self.layout.dirty(name, *seq), &to));
            moved.push(moving.is_ok());
            if let Err(e) = moving
                && result.is_ok()
            {
                result = Err(e);
            }
        }
        let mut index = self.lock();
        for ((name, _), moved) in begun.iter().zip(moved) {
            index.end_clean(name, moved);
        }
        let evicted = index.evict(self.options.max_bytes);
        self.remove(evicted);
        result
    }
}
