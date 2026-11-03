// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Where a database keeps its objects.

use std::path::{Path, PathBuf};
use std::sync::Arc;

use slatedb::object_store::ObjectStore;

/// Where to store SlateDB's objects.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Backend {
    /// In memory, gone when the process exits: for tests.
    Memory,
    /// A directory on local disk.
    LocalFs(PathBuf),
    /// An S3 (or S3-compatible) bucket, optionally under a key prefix.
    ///
    /// Credentials, region, and endpoint come from the standard `AWS_*`
    /// environment variables; see
    /// [`object_store_s3::S3StoreBuilder::from_env`].
    S3 {
        bucket: String,
        prefix: Option<String>,
    },
}

impl Backend {
    /// Whether writes land on local media rather than remote object
    /// storage: the axis SlateDB's stock settings are tuned against (see
    /// [`tuned`](crate::settings::tuned)).
    pub fn writes_land_locally(&self) -> bool {
        match self {
            Backend::Memory | Backend::LocalFs(_) => true,
            Backend::S3 { .. } => false,
        }
    }

    /// The directory of a local store.
    pub fn local_dir(&self) -> Option<&Path> {
        match self {
            Backend::LocalFs(path) => Some(path),
            Backend::Memory | Backend::S3 { .. } => None,
        }
    }

    /// The object store this backend names, creating a local store's
    /// directory if need be.
    ///
    /// Local reads go to a pool of threads of their own, one trip each,
    /// rather than two trips through Tokio's blocking pool (see
    /// [`object_store_local`]).
    pub fn object_store(&self) -> Result<Arc<dyn ObjectStore>, slatedb::Error> {
        let unavailable = |what: String| slatedb::Error::unavailable(what);
        Ok(match self {
            Backend::Memory => Arc::new(slatedb::object_store::memory::InMemory::new()),
            Backend::LocalFs(path) => {
                // The store's root has to exist before LocalFileSystem will
                // use it.
                std::fs::create_dir_all(path).map_err(|e| {
                    unavailable(format!("create store directory {}: {e}", path.display()))
                })?;
                let threads =
                    std::thread::available_parallelism().map_or(8, |n| n.get().clamp(4, 32));
                Arc::new(
                    object_store_local::PooledLocalFileSystem::new_with_prefix(path, threads)
                        .map_err(|e| unavailable(e.to_string()))?,
                )
            }
            Backend::S3 { bucket, prefix } => {
                let store = object_store_s3::S3StoreBuilder::from_env()
                    .with_bucket(bucket)
                    .build()
                    .map_err(|e| unavailable(e.to_string()))?;
                match prefix {
                    Some(prefix) => Arc::new(slatedb::object_store::prefix::PrefixStore::new(
                        store,
                        prefix.as_str(),
                    )),
                    None => Arc::new(store),
                }
            }
        })
    }
}
