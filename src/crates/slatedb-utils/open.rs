// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Opening a database with tuned settings, quick_cache block and metadata
//! caches, segments, and write admission.

use std::sync::Arc;
use std::time::Duration;

use slatedb::db_cache::SplitCache;
use slatedb::{BlockCachePolicy, Db, PrefixExtractor};
use slatedb_common::metrics::MetricsRecorder;
use tracing::{info, warn};
use write_admission::{Admission, DEFAULT_MAX_WRITE_WAIT, DiskReserve};

use crate::{Backend, DurableDb, QuickDbCache};

/// Default size of the in-memory SST data block cache (512 MiB).
pub const DEFAULT_BLOCK_CACHE_BYTES: u64 = 512 * 1024 * 1024;

/// Default size of the in-memory SST index and filter cache (128 MiB).
pub const DEFAULT_META_CACHE_BYTES: u64 = 128 * 1024 * 1024;

/// A local disk cache in front of a remote object store.
#[derive(Clone, Debug)]
pub struct ObjectStoreCache {
    /// Directory the cache lives in.
    pub dir: std::path::PathBuf,
    /// Most bytes it holds; `None` keeps SlateDB's default (16 GiB).
    pub max_bytes: Option<usize>,
}

/// How to open a database. `Default` gives [`tuned`](crate::settings::tuned)
/// settings, the default caches, no segments, a disk reserve for local
/// stores, and a backlog of [`DEFAULT_MAX_WRITE_WAIT`].
#[derive(Clone, Default)]
pub struct OpenOptions {
    /// The SlateDB settings to start from; `None` derives them from the
    /// backend ([`tuned`](crate::settings::tuned)), overridden from the
    /// environment if [`env_prefix`](Self::env_prefix) is set.
    pub settings: Option<slatedb::config::Settings>,
    /// The prefix of environment variables overriding the derived settings
    /// (see [`from_env`](crate::settings::from_env)). Ignored when
    /// [`settings`](Self::settings) is given.
    pub env_prefix: Option<String>,
    /// If set, every value written expires this long after it is written.
    pub default_ttl: Option<Duration>,
    /// Run no compactor in this process: one runs elsewhere (see
    /// [`slatedb::CompactorBuilder`]).
    pub disable_compactor: bool,
    /// In-memory cache of SST data blocks; `None` keeps
    /// [`DEFAULT_BLOCK_CACHE_BYTES`].
    pub block_cache_bytes: Option<u64>,
    /// In-memory cache of SST indexes and bloom filters, which every point
    /// lookup consults; `None` keeps [`DEFAULT_META_CACHE_BYTES`].
    pub meta_cache_bytes: Option<u64>,
    /// Most bytes of writes held in memory before they are flushed to L0
    /// SSTs (SlateDB's `max_unflushed_bytes`); past it, writes wait for a
    /// flush. It must exceed the L0 SST size. `None` keeps the setting's.
    pub write_buffer_bytes: Option<u64>,
    /// A local disk cache of SSTs read from S3. Ignored, with a warning,
    /// for backends whose data is already local.
    pub object_store_cache: Option<ObjectStoreCache>,
    /// Where SlateDB reports its metrics (and those of the embedded
    /// compactor and garbage collector); `None` discards them.
    pub metrics_recorder: Option<Arc<dyn MetricsRecorder>>,
    /// Local stores only: refuse writes while the disk under the store has
    /// less than this many bytes free. `None` keeps
    /// [`default_reserve`](write_admission::default_reserve); `Some(0)`
    /// turns the check off.
    pub disk_reserve_bytes: Option<u64>,
    /// Refuse new writes while the oldest under way has waited longer than
    /// this (see [`write_admission::Backlog`]). `None` keeps
    /// [`DEFAULT_MAX_WRITE_WAIT`]; `Some(ZERO)` lets writes wait as long as
    /// the store takes.
    pub max_write_wait: Option<Duration>,
    /// Splits the database into segments (see
    /// [`FirstByteSegments`](crate::segments::FirstByteSegments)). A
    /// database must be opened with the extractor it was made with.
    pub segment_extractor: Option<Arc<dyn PrefixExtractor>>,
    /// What memtable flushes put in the block cache (see
    /// [`flush_cache_policy`](crate::segments::flush_cache_policy)).
    pub block_cache_policy: Option<BlockCachePolicy>,
}

impl std::fmt::Debug for OpenOptions {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("OpenOptions")
            .field("settings", &self.settings)
            .field("env_prefix", &self.env_prefix)
            .field("default_ttl", &self.default_ttl)
            .field("disable_compactor", &self.disable_compactor)
            .field("block_cache_bytes", &self.block_cache_bytes)
            .field("meta_cache_bytes", &self.meta_cache_bytes)
            .field("write_buffer_bytes", &self.write_buffer_bytes)
            .field("object_store_cache", &self.object_store_cache)
            .field("metrics_recorder", &self.metrics_recorder.is_some())
            .field("disk_reserve_bytes", &self.disk_reserve_bytes)
            .field("max_write_wait", &self.max_write_wait)
            .field(
                "segment_extractor",
                &self
                    .segment_extractor
                    .as_ref()
                    .map(|e| e.name().to_string()),
            )
            .field("block_cache_policy", &self.block_cache_policy.is_some())
            .finish()
    }
}

impl OpenOptions {
    /// The SlateDB settings these options open `backend` with.
    pub fn resolve_settings(
        &self,
        backend: &Backend,
    ) -> Result<slatedb::config::Settings, slatedb::Error> {
        let base = match (&self.settings, &self.env_prefix) {
            (Some(settings), _) => settings.clone(),
            (None, Some(prefix)) => crate::settings::from_env(prefix, backend)?,
            (None, None) => crate::settings::tuned(backend),
        };
        let mut settings = slatedb::config::Settings {
            default_ttl_millis: self
                .default_ttl
                .map(|ttl| u64::try_from(ttl.as_millis()).unwrap_or(u64::MAX)),
            compactor_options: if self.disable_compactor {
                None
            } else {
                base.compactor_options.clone()
            },
            ..base
        };
        if let Some(bytes) = self.write_buffer_bytes {
            settings.max_unflushed_bytes = usize::try_from(bytes).unwrap_or(usize::MAX);
        }
        match (&self.object_store_cache, backend) {
            (Some(cache), Backend::S3 { .. }) => {
                let options = &mut settings.object_store_cache_options;
                options.root_folder = Some(cache.dir.clone());
                if cache.max_bytes.is_some() {
                    options.max_cache_size_bytes = cache.max_bytes;
                }
                // Values are often read back soon after they are written.
                options.cache_on_flush = true;
            }
            (Some(_), _) => warn!("object store cache ignored: the store is already local"),
            (None, _) => {}
        }
        Ok(settings)
    }
}

/// Open the database at `path` in `backend`. A local store's disk reserve
/// is watched on the current Tokio runtime.
pub async fn open(
    path: &str,
    backend: &Backend,
    options: OpenOptions,
) -> Result<DurableDb, slatedb::Error> {
    let settings = options.resolve_settings(backend)?;
    let object_store = backend.object_store()?;

    let db_cache = SplitCache::new()
        .with_block_cache(Some(Arc::new(QuickDbCache::new(
            options
                .block_cache_bytes
                .unwrap_or(DEFAULT_BLOCK_CACHE_BYTES),
        ))))
        .with_meta_cache(Some(Arc::new(QuickDbCache::new(
            options.meta_cache_bytes.unwrap_or(DEFAULT_META_CACHE_BYTES),
        ))))
        .build();

    // The cache is this database's alone, so its entries need no scope of
    // their own; and it lives in memory, so there is nothing for
    // `DbCache::close` to save when the database closes.
    const DB_CACHE_ID: u64 = 0;
    let mut builder = Db::builder(path, object_store)
        .with_settings(settings)
        .with_db_cache(Arc::new(db_cache), DB_CACHE_ID);
    if let Some(policy) = options.block_cache_policy {
        builder = builder.with_block_cache_policy(policy);
    }
    if let Some(extractor) = options.segment_extractor {
        builder = builder.with_segment_extractor(extractor);
    }
    if let Some(recorder) = options.metrics_recorder {
        builder = builder.with_metrics_recorder(recorder);
    }

    let disk = match (backend.local_dir(), options.disk_reserve_bytes) {
        (_, Some(0)) | (None, _) => None,
        (Some(dir), reserve) => {
            let disk = DiskReserve::watch(dir.to_path_buf(), reserve).map_err(|e| {
                slatedb::Error::unavailable(format!(
                    "measuring free space under {}: {e}",
                    dir.display()
                ))
            })?;
            info!(
                path = %dir.display(),
                reserve = disk.reserve(),
                "keeping a free disk space reserve"
            );
            Some(disk)
        }
    };
    let db = builder.build().await?;
    let admission = Admission::with_max_wait(
        disk,
        options.max_write_wait.unwrap_or(DEFAULT_MAX_WRITE_WAIT),
    );
    Ok(DurableDb::new(db, admission))
}
