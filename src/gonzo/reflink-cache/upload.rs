// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Blobs written into the cache as they arrive, from a client uploading
//! them, and taken in as dirty once they are whole and checked.

use std::io::{self, Write as _};
use std::path::PathBuf;
use std::sync::Arc;

use reapi_cas::{Digest, DigestFn, Hasher};

use crate::fs::{File as _, Fs};
use crate::index::Name;
use crate::{FileCache, Ingested, Inner, RealFs};

/// A blob being written into a new file in `partial/`, hashed as it is
/// written. [`finish`](Upload::finish) checks it against its digest and
/// takes it in as dirty; dropping it unfinished removes the file.
///
/// Writes go to the page cache, so they are quick, but they are blocking
/// calls all the same; data is synced once, by `finish`, on a blocking
/// thread.
#[must_use]
pub struct Upload<F: Fs = RealFs> {
    inner: Arc<Inner<F>>,
    name: Name,
    path: PathBuf,
    file: Option<F::File>,
    hasher: Option<Hasher>,
    written: u64,
}

impl<F: Fs> FileCache<F> {
    /// Start an upload of the blob with `digest`, or return `None` if the
    /// cache holds it already, durably, and nothing need be uploaded.
    pub async fn upload(
        &self,
        function: DigestFn,
        digest: &Digest,
    ) -> io::Result<Option<Upload<F>>> {
        let inner = &self.inner;
        if let Some(failed) = inner.commits.failed() {
            return Err(failed);
        }
        let name = (function, *digest);
        if let Some((_, ticket)) = inner.held(&name) {
            inner.wait_durable(ticket).await?;
            return Ok(None);
        }
        let path = inner.partial();
        let file = inner.fs.create_new(&path)?;
        Ok(Some(Upload {
            inner: inner.clone(),
            name,
            path,
            file: Some(file),
            hasher: Some(function.hasher()),
            written: 0,
        }))
    }
}

impl<F: Fs> Upload<F> {
    /// Write the next part of the blob. Writing past its size fails.
    pub fn write(&mut self, data: &[u8]) -> io::Result<()> {
        let size = self.name.1.size;
        if self.written + data.len() as u64 > size {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!(
                    "{} has {size} bytes; {} written are too many",
                    self.name.1,
                    self.written + data.len() as u64
                ),
            ));
        }
        let file = self.file.as_mut().expect("unfinished uploads have files");
        file.write_all(data)?;
        self.hasher
            .as_mut()
            .expect("unfinished uploads have hashers")
            .update(data);
        self.written += data.len() as u64;
        Ok(())
    }

    /// The bytes written so far.
    pub fn written(&self) -> u64 {
        self.written
    }

    /// Check the blob against its digest, then take it in as dirty, as
    /// [`FileCache::ingest`] does, returning once it is durable.
    pub async fn finish(mut self) -> io::Result<Ingested> {
        let found = self.hasher.take().expect("finished once").finish();
        if found != self.name.1 {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                format!("the blob uploaded as {} is {found}", self.name.1),
            ));
        }
        let file = self.file.take().expect("finished once");
        let inner = self.inner.clone();
        let durable = inner.options.durable;
        self.inner
            .fs
            .blocking(move || {
                file.set_mode(0o444)?;
                if durable {
                    file.sync_data()?;
                }
                io::Result::Ok(())
            })
            .await?;
        let (ingested, ticket) = inner.enter_dirty(self.name, &self.path)?;
        if ingested == Ingested::Added {
            // The file is the cache's now.
            self.path = PathBuf::new();
        }
        inner.wait_durable(ticket).await?;
        Ok(ingested)
    }
}

impl<F: Fs> Drop for Upload<F> {
    fn drop(&mut self) {
        if !self.path.as_os_str().is_empty() {
            let _ = self.inner.fs.remove_file(&self.path);
        }
    }
}
