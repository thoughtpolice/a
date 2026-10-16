// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Input files, kept by digest so each is downloaded once.
//!
//! Actions get their own copy of each file. On btrfs and XFS that copy is
//! a reflink, which shares the cached file's blocks until one side writes,
//! so it costs about what a hard link would; an action that writes to its
//! inputs cannot corrupt the cache, as it could with a hard link.
//! Elsewhere the copy is a real one.

use std::io;
use std::os::fd::AsRawFd as _;
use std::os::unix::fs::PermissionsExt as _;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};

use anyhow::{Context as _, Result};
use futures::{StreamExt as _, TryStreamExt as _};

use protos::build::bazel::remote::execution::v2::Digest;

use crate::cas::{BATCH_BLOB_MAX, Cas};
use crate::digest::{DigestFunction, key};

/// Downloads under way at once.
const PARALLEL_DOWNLOADS: usize = 16;

/// See the module documentation.
#[derive(Debug)]
pub struct FileCache {
    dir: PathBuf,
    /// Where downloads land before they are complete and checked.
    partial: PathBuf,
    next_partial: AtomicU64,
}

impl FileCache {
    /// The cache in `dir`, created if need be. Partial downloads left by an
    /// earlier run are removed.
    pub fn open(dir: &Path) -> io::Result<Self> {
        let partial = dir.join("partial");
        match std::fs::remove_dir_all(&partial) {
            Ok(()) => {}
            Err(e) if e.kind() == io::ErrorKind::NotFound => {}
            Err(e) => return Err(e),
        }
        std::fs::create_dir_all(&partial)?;
        Ok(Self {
            dir: dir.to_path_buf(),
            partial,
            next_partial: AtomicU64::new(0),
        })
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

    /// Download whichever of `digests` the cache does not have yet.
    pub async fn fetch(
        &self,
        cas: &Cas,
        function: DigestFunction,
        digests: &[Digest],
    ) -> Result<()> {
        let mut seen = std::collections::HashSet::new();
        let absent: Vec<Digest> = digests
            .iter()
            .filter(|d| seen.insert(key(d)))
            .filter(|d| !self.path(function, d).exists())
            .cloned()
            .collect();
        let (small, large): (Vec<Digest>, Vec<Digest>) = absent
            .into_iter()
            .partition(|d| d.size_bytes <= BATCH_BLOB_MAX);

        let mut blobs = cas.read_blobs(function, &small).await?;
        let writes: Vec<_> = small
            .iter()
            .map(|digest| {
                let data = blobs
                    .remove(&key(digest))
                    .expect("read_blobs read them all");
                (self.partial(), self.path(function, digest), data)
            })
            .collect();
        tokio::task::spawn_blocking(move || {
            writes.into_iter().try_for_each(|(partial, path, data)| {
                std::fs::write(&partial, data)
                    .with_context(|| format!("writing {}", partial.display()))?;
                keep(&partial, &path)
            })
        })
        .await??;

        futures::stream::iter(large)
            .map(|digest| async move {
                let partial = self.partial();
                let result = cas.read_to_file(function, &digest, &partial).await;
                if result.is_err() {
                    let _ = std::fs::remove_file(&partial);
                }
                result?;
                keep(&partial, &self.path(function, &digest))
            })
            .buffer_unordered(PARALLEL_DOWNLOADS)
            .try_collect::<()>()
            .await
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
