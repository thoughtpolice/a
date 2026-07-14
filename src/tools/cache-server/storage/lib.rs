// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Content-addressable chunk storage backed by SlateDB with FastCDC chunking.

mod compression;
mod error;
mod hashing;
mod manifest;
mod writer;

// Re-export public API so the external interface is unchanged.
pub use compression::{Compression, StreamingDecompressor};
pub use error::{Result, StoreError};
pub use hashing::{ContentDigest, DigestFn, IncrementalHasher, parse_digest_hash};
pub use manifest::{BlobManifest, ChunkInfo, MAX_MANIFEST_CHUNK_COUNT};
pub use writer::CasBlobWriter;

// Crate-internal re-exports used by sibling modules and tests.
pub(crate) use compression::MAX_CHUNK_DECOMPRESSED_SIZE;
pub(crate) use hashing::{
    SHA256TREE_IV, SHA256TREE_LEAF_SIZE, sha256_block_cipher, sha256tree_hash,
};
pub use manifest::unix_now_secs;

// Re-export std types used by tests via `super::*`.
#[allow(unused_imports)]
pub(crate) use std::borrow::Cow;

use std::sync::Arc;

use bytes::{Buf, BufMut, Bytes, BytesMut};
use futures::{Stream, StreamExt as _};
use slatedb::config::{DurabilityLevel, ReadOptions};
use slatedb::db_cache::foyer::{FoyerCache, FoyerCacheOptions};
use slatedb::db_cache::{CacheTarget, SplitCache};
use slatedb::{BlockCachePolicy, Db, PrefixExtractor, PrefixTarget, WriteBatch};
use tracing::{debug, instrument, warn};

/// Re-export for callers that need to construct TTL durations.
pub use jiff::SignedDuration;
/// Re-export for [`CacheStore::failed`].
pub use slatedb::CloseReason;
/// Re-export for standalone compaction.
pub use slatedb::CompactorBuilder;
/// Re-export for [`CacheStoreSettings::metrics_recorder`].
pub use slatedb_common::metrics::MetricsRecorder;

/// Settings for opening a [`CacheStore`].
#[derive(Clone, Default)]
pub struct CacheStoreSettings {
    /// If `Some`, all new writes will expire after this duration
    /// (mapped to SlateDB's `Settings::default_ttl_millis`). `None` means no expiry.
    pub default_ttl: Option<jiff::SignedDuration>,
    /// When `true`, the embedded compactor is disabled. Use this when running
    /// a standalone compactor process via [`CompactorBuilder`].
    pub disable_compactor: bool,
    /// Overrides the SlateDB settings that [`CacheStore::open`] would
    /// otherwise derive ([`settings_for`]). Benchmarks use this to compare
    /// profiles; production leaves it `None`.
    pub slatedb_overrides: Option<slatedb::config::Settings>,
    /// In-memory cache of SST data blocks (holding everything but chunk
    /// data, see [`block_cache_policy`]). `None` keeps
    /// [`DEFAULT_BLOCK_CACHE_BYTES`].
    pub block_cache_bytes: Option<u64>,
    /// In-memory cache of SST indexes and bloom filters, which every point
    /// lookup consults. `None` keeps [`DEFAULT_META_CACHE_BYTES`].
    pub meta_cache_bytes: Option<u64>,
    /// Most bytes of writes held in memory before they are flushed to L0
    /// SSTs (SlateDB's `max_unflushed_bytes`); past it, writes wait for a
    /// flush. It must exceed the L0 SST size. `None` keeps SlateDB's 1 GiB,
    /// or what `CACHE_SERVER_SLATEDB_MAX_UNFLUSHED_BYTES` says.
    pub write_buffer_bytes: Option<u64>,
    /// A local disk cache of SST data read from S3. Ignored for other
    /// backends, whose data is already local.
    pub object_store_cache: Option<ObjectStoreCache>,
    /// Where SlateDB reports its metrics (and those of the embedded
    /// compactor and garbage collector); `None` discards them.
    pub metrics_recorder: Option<Arc<dyn MetricsRecorder>>,
}

impl std::fmt::Debug for CacheStoreSettings {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CacheStoreSettings")
            .field("default_ttl", &self.default_ttl)
            .field("disable_compactor", &self.disable_compactor)
            .field("slatedb_overrides", &self.slatedb_overrides)
            .field("block_cache_bytes", &self.block_cache_bytes)
            .field("meta_cache_bytes", &self.meta_cache_bytes)
            .field("write_buffer_bytes", &self.write_buffer_bytes)
            .field("object_store_cache", &self.object_store_cache)
            .field("metrics_recorder", &self.metrics_recorder.is_some())
            .finish()
    }
}

/// A local disk cache in front of the object store.
#[derive(Clone, Debug)]
pub struct ObjectStoreCache {
    /// Directory the cache lives in.
    pub dir: std::path::PathBuf,
    /// Most bytes it holds; `None` keeps SlateDB's default (16 GiB).
    pub max_bytes: Option<usize>,
}

/// Default size of the in-memory SST data block cache (512 MiB).
pub const DEFAULT_BLOCK_CACHE_BYTES: u64 = 512 * 1024 * 1024;

/// Default size of the in-memory SST index and filter cache (128 MiB).
pub const DEFAULT_META_CACHE_BYTES: u64 = 128 * 1024 * 1024;

/// Prefix of the environment variables that override SlateDB settings, e.g.
/// `CACHE_SERVER_SLATEDB_L0_SST_SIZE_BYTES=134217728`, or with a `.` for a
/// nested setting, `CACHE_SERVER_SLATEDB_COMPACTOR_OPTIONS.MAX_CONCURRENT_COMPACTIONS=8`.
/// Durations are strings such as `100ms`.
pub const SLATEDB_ENV_PREFIX: &str = "CACHE_SERVER_SLATEDB_";

/// The SlateDB database path used by the cache store.
pub const DB_PATH: &str = "cache";

// Key prefixes for the flat keyspace
const PREFIX_MANIFEST: u8 = b'm';
const PREFIX_CHUNK: u8 = b'c';
const PREFIX_ACTION: u8 = b'a';
const PREFIX_ASSET: u8 = b'r';

// FastCDC parameters: avg 512 KiB, min = avg/4, max = avg*4
const CDC_AVG_SIZE: usize = 524_288; // 512 KiB
const CDC_MIN_SIZE: usize = CDC_AVG_SIZE / 4; // 128 KiB
const CDC_MAX_SIZE: usize = CDC_AVG_SIZE * 4; // 2 MiB

// Blobs below this size are stored as a single chunk (no CDC splitting)
const SMALL_BLOB_THRESHOLD: usize = CDC_MAX_SIZE;

/// Chunk reads a blob stream keeps in flight ahead of its consumer.
pub const STREAM_PREFETCH_CHUNKS: usize = 8;

/// Maximum total blob size for reassembly (2 GiB).
pub const MAX_BLOB_REASSEMBLE_SIZE: usize = 2 * 1024 * 1024 * 1024;

// Maximum action cache entry size (16 MiB)
const MAX_ACTION_CACHE_ENTRY_SIZE: usize = 16 * 1024 * 1024;

/// Where to store SlateDB data.
#[derive(Debug)]
pub enum StoreBackend {
    /// In-memory object store (ephemeral, for testing).
    Memory,
    /// Local filesystem at the given path.
    LocalFs(String),
    /// S3 (or S3-compatible) bucket, optionally rooted at a key prefix.
    ///
    /// Credentials, region, and endpoint come from the standard `AWS_*`
    /// environment variables; see [`s3_store::S3StoreBuilder::from_env`].
    S3 {
        bucket: String,
        prefix: Option<String>,
    },
}

/// Whether a backend's writes land on local media rather than remote object
/// storage. This is the axis SlateDB's stock defaults are tuned against.
fn writes_land_locally(backend: &StoreBackend) -> bool {
    match backend {
        StoreBackend::Memory | StoreBackend::LocalFs(_) => true,
        StoreBackend::S3 { .. } => false,
    }
}

/// Derive SlateDB settings for `backend`.
///
/// SlateDB ships defaults tuned for S3, where a flush is a billable, ~100 ms
/// round trip. Two of those trades invert on a loopback store, so adjust them
/// rather than leaving the operator to discover the defaults the hard way.
pub fn tuned_settings(backend: &StoreBackend) -> slatedb::config::Settings {
    let mut settings = slatedb::config::Settings::default();

    if writes_land_locally(backend) {
        // `flush_interval` is a WAL flush *tick*, and a write is not
        // acknowledged until the next one makes it durable (see `commit`) —
        // so it is a hard floor on write latency, and a cap of
        // `concurrency / interval` on write throughput no matter how fast the
        // machine is. SlateDB picks 100 ms to bound S3 PUT charges (its own
        // docs quote ~$130/month at that rate); against memory or a local disk
        // a flush costs microseconds and nothing per call, so the 100 ms is
        // pure latency for no saving. Each tick with writes pending writes a
        // WAL object that lives until garbage collection, so the tick stays
        // a few milliseconds rather than one.
        settings.flush_interval = Some(std::time::Duration::from_millis(5));
    }

    // SlateDB writes a bloom filter only for SSTs of at least 1000 keys. A
    // 64 MiB SST of this cache's ~2 MiB chunks holds a few dozen, so stock
    // SSTs mostly go without, and since keys are random hashes, every SST's
    // key range covers every lookup: a miss (FindMissingBlobs on a new
    // blob, say) then reads an index and a data block from every L0 SST and
    // sorted run. With filters, a miss is answered from cached filters.
    settings.min_filter_keys = 1;

    // Each memtable flush adds one L0 SST to every segment it touches, and a
    // segment holding `l0_max_ssts` of them stops flushes until a compaction
    // takes them away; writes then stall once `max_unflushed_bytes` is
    // buffered. The stock 8 gives a stream of uploads only seconds of slack,
    // so allow twice that. Keys are random hashes, so every L0 SST spans the
    // whole key space and the per-key limit is reached at the same count:
    // it has to move too. A lookup consults every L0 SST of its segment,
    // but through bloom filters held in the meta cache.
    settings.l0_max_ssts = 16;
    settings.l0_max_ssts_per_key = 16;

    if let Some(compactor) = settings.compactor_options.as_mut() {
        // The compactor looks for work, and its worker for submitted jobs,
        // every 5 s by default — so a full L0 waited up to 10 s for a
        // compaction that then took under one, with every upload stalled
        // meanwhile. Each poll reads the manifest or the compactions file:
        // free on a local store, a LIST and a GET on S3.
        let poll = if writes_land_locally(backend) {
            std::time::Duration::from_millis(100)
        } else {
            std::time::Duration::from_secs(1)
        };
        compactor.poll_interval = poll;
        if let Some(worker) = compactor.worker.as_mut() {
            worker.compactions_poll_interval = poll;
            // SlateDB requires the worker's filter threshold to match the
            // writer's; otherwise compacted SSTs drop their filters.
            worker.min_filter_keys = settings.min_filter_keys;
        }
    }

    if let Some(gc) = settings.garbage_collector_options.as_mut() {
        // Every compaction keeps the SSTs it replaces for 15 minutes (SlateDB
        // writes a checkpoint of the old manifest before committing, with a
        // fixed lifetime), and collection then runs only every 10 minutes:
        // under a stream of uploads, the replaced data waited up to 25
        // minutes to go, and was most of the disk in use. Collect every
        // minute instead. Flushed WAL is pinned by nothing (this store has no
        // readers tailing it), so it goes after a minute too, not five.
        let every_minute = Some(std::time::Duration::from_secs(60));
        if let Some(wal) = gc.wal_options.as_mut() {
            wal.interval = every_minute;
            wal.min_age = std::time::Duration::from_secs(60);
        }
        if let Some(compacted) = gc.compacted_options.as_mut() {
            compacted.interval = every_minute;
        }

        // WAL fence collection ships dry-run, so it deletes nothing and logs a
        // paragraph explaining that it deleted nothing on every pass. Off is
        // what dry-run already means, minus the noise. Enabling it for real
        // risks data loss (see `wal_fence_options`), so off is also the safe
        // reading of the default.
        gc.wal_fence_options = None;

        if matches!(backend, StoreBackend::LocalFs(_)) {
            // Boundary advancement is the *only* thing in SlateDB that issues a
            // conditional overwrite (`PutMode::Update`, in the boundary object
            // behind the manifest and compactions stores), and object_store's
            // LocalFileSystem returns `NotImplemented` for it. So the manifest
            // and compactions collectors fail on every pass, forever, once per
            // interval.
            //
            // Turning those two collectors off trades reclaiming their metadata
            // for an error the operator cannot act on. The alternative is
            // `boundary_files_enabled = false`, which keeps them collecting but
            // lets a process suspended past `min_age` resurrect a deleted
            // metadata ID and report a stale update as successful — a
            // correctness risk on a workstation that sleeps. WAL and
            // compacted-SST collection need no CAS and keep reclaiming the bulk
            // of the space either way.
            gc.manifest_options = None;
            gc.compactions_options = None;
        }
    }

    settings
}

/// [`tuned_settings`] for `backend`, overridden by any
/// [`SLATEDB_ENV_PREFIX`] environment variables.
pub fn settings_for(backend: &StoreBackend) -> Result<slatedb::config::Settings> {
    Ok(slatedb::config::Settings::from_env_with_default(
        SLATEDB_ENV_PREFIX,
        tuned_settings(backend),
    )?)
}

/// What a memtable flush puts in the block cache: indexes, filters, and
/// the data blocks of everything but chunks.
///
/// Chunks are up to 2 MiB each, so the stock policy (every block of every
/// flushed SST) has each flush of uploads evict the small, hot manifest,
/// action cache, and asset blocks. Chunk reads skip the block cache too
/// ([`chunk_read_options`]); repeated chunk reads are served by the OS page
/// cache (local stores) or the object store disk cache (S3).
pub fn block_cache_policy() -> BlockCachePolicy {
    let data = |prefix: u8| CacheTarget::data([prefix]..[prefix + 1]);
    BlockCachePolicy::default().with_flush_targets(&[
        CacheTarget::Index,
        CacheTarget::Filters,
        data(PREFIX_ACTION),
        data(PREFIX_MANIFEST),
        data(PREFIX_ASSET),
    ])
}

/// Splits the store into one LSM tree (an RFC-0024 segment) per kind of
/// key — chunks, manifests, action cache entries, assets — by the key's
/// first byte.
///
/// Metadata then never shares an SST, or a compaction, with megabytes of
/// chunk data: a manifest or action cache lookup probes only that kind's
/// SSTs, which are small, dense, and well covered by bloom filters and the
/// block cache, and compacting metadata rewrites no chunks.
///
/// SlateDB stamps the extractor's name into the manifest of a new store and
/// refuses to open a store with a different one (or none), so the name and
/// the one-byte split must never change.
struct KeyKind;

impl PrefixExtractor for KeyKind {
    fn name(&self) -> &str {
        "cache-server.key-kind.v1"
    }

    fn prefix_len(&self, target: &PrefixTarget) -> Option<usize> {
        let (PrefixTarget::Point(bytes) | PrefixTarget::Prefix(bytes)) = target;
        (!bytes.is_empty()).then_some(1)
    }
}

/// Reads of chunk data, which must not displace metadata in the block cache
/// (see [`block_cache_policy`]).
fn chunk_read_options() -> ReadOptions {
    ReadOptions {
        cache_blocks: false,
        ..ReadOptions::default()
    }
}

/// Reads that decide whether something is stored, and so whether a write
/// can be skipped: they see only durable data. A write still in flight is
/// not yet stored as far as an upload that would rely on it is concerned —
/// skipping on its strength would acknowledge an upload before anything
/// made it durable.
fn durable_read_options() -> ReadOptions {
    ReadOptions {
        durability_filter: DurabilityLevel::Remote,
        ..ReadOptions::default()
    }
}

/// Milliseconds since the Unix epoch, the unit of SlateDB's expiry times.
fn now_millis() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| i64::try_from(d.as_millis()).unwrap_or(i64::MAX))
}

/// Main storage engine wrapping SlateDB with CDC-aware blob storage.
pub struct CacheStore {
    db: Db,
    /// A value with less than this long (ms) to live is due for a rewrite:
    /// half the default TTL, or `None` without one.
    refresh_window_ms: Option<i64>,
}

impl std::fmt::Debug for CacheStore {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("CacheStore").finish_non_exhaustive()
    }
}

/// Create the [`ObjectStore`](slatedb::object_store::ObjectStore) for a given backend.
///
/// Shared by [`CacheStore::open`] and standalone compaction so both use the
/// same object store construction logic.
pub fn create_object_store(
    backend: &StoreBackend,
) -> Result<Arc<dyn slatedb::object_store::ObjectStore>> {
    let object_store: Arc<dyn slatedb::object_store::ObjectStore> = match backend {
        StoreBackend::Memory => Arc::new(slatedb::object_store::memory::InMemory::new()),
        StoreBackend::LocalFs(path) => {
            // The store's root has to exist before LocalFileSystem will use it.
            std::fs::create_dir_all(path).map_err(|e| {
                StoreError::Database(slatedb::Error::unavailable(format!(
                    "create store directory {path}: {e}"
                )))
            })?;
            Arc::new(
                slatedb::object_store::local::LocalFileSystem::new_with_prefix(path).map_err(
                    |e| StoreError::Database(slatedb::Error::unavailable(e.to_string())),
                )?,
            )
        }
        StoreBackend::S3 { bucket, prefix } => {
            let store = s3_store::S3StoreBuilder::from_env()
                .with_bucket(bucket)
                .build()
                .map_err(|e| StoreError::Database(slatedb::Error::unavailable(e.to_string())))?;
            match prefix {
                Some(prefix) => Arc::new(slatedb::object_store::prefix::PrefixStore::new(
                    store,
                    prefix.as_str(),
                )),
                None => Arc::new(store),
            }
        }
    };
    Ok(object_store)
}

impl CacheStore {
    /// Open the store with the given backend and settings.
    pub async fn open(backend: StoreBackend, settings: CacheStoreSettings) -> Result<Self> {
        let object_store = create_object_store(&backend)?;

        let default_ttl_ms = settings
            .default_ttl
            .map(|d| u64::try_from(d.as_millis()).expect("default TTL overflows u64 milliseconds"));
        let base = match settings.slatedb_overrides.clone() {
            Some(overrides) => overrides,
            None => settings_for(&backend)?,
        };
        let mut db_settings = slatedb::config::Settings {
            default_ttl_millis: default_ttl_ms,
            compactor_options: if settings.disable_compactor {
                None
            } else {
                base.compactor_options.clone()
            },
            ..base
        };
        if let Some(bytes) = settings.write_buffer_bytes {
            db_settings.max_unflushed_bytes = usize::try_from(bytes).unwrap_or(usize::MAX);
        }
        match (&settings.object_store_cache, &backend) {
            (Some(cache), StoreBackend::S3 { .. }) => {
                let options = &mut db_settings.object_store_cache_options;
                options.root_folder = Some(cache.dir.clone());
                if cache.max_bytes.is_some() {
                    options.max_cache_size_bytes = cache.max_bytes;
                }
                // Blobs are often read back soon after they are uploaded.
                options.cache_on_flush = true;
            }
            (Some(_), _) => warn!("object store cache ignored: the store is already local"),
            (None, _) => {}
        }

        let cache_options = |bytes: Option<u64>, default| FoyerCacheOptions {
            max_capacity: bytes.unwrap_or(default),
            ..FoyerCacheOptions::default()
        };
        let db_cache = SplitCache::new()
            .with_block_cache(Some(Arc::new(FoyerCache::new_with_opts(cache_options(
                settings.block_cache_bytes,
                DEFAULT_BLOCK_CACHE_BYTES,
            )))))
            .with_meta_cache(Some(Arc::new(FoyerCache::new_with_opts(cache_options(
                settings.meta_cache_bytes,
                DEFAULT_META_CACHE_BYTES,
            )))))
            .build();

        let mut builder = Db::builder(DB_PATH, object_store)
            .with_settings(db_settings)
            .with_db_cache(Arc::new(db_cache))
            .with_block_cache_policy(block_cache_policy())
            .with_segment_extractor(Arc::new(KeyKind));
        if let Some(recorder) = settings.metrics_recorder.clone() {
            builder = builder.with_metrics_recorder(recorder);
        }
        let db = builder.build().await?;
        Ok(CacheStore {
            db,
            refresh_window_ms: default_ttl_ms.map(|ttl| i64::try_from(ttl / 2).unwrap_or(i64::MAX)),
        })
    }

    /// Resolves once the database has stopped for any reason but a clean
    /// close, with that reason: fenced by another writer that opened the
    /// store, or stopped by a failed background task (WAL upload, memtable
    /// flush, compaction, garbage collection). Every operation fails from
    /// then on. Never resolves otherwise.
    pub async fn failed(&self) -> CloseReason {
        let mut status = self.db.subscribe();
        loop {
            match status.borrow_and_update().close_reason {
                None => {}
                Some(CloseReason::Clean) => break,
                Some(reason) => return reason,
            }
            if status.changed().await.is_err() {
                break;
            }
        }
        std::future::pending().await
    }

    /// The key prefixes the store keeps separate LSM trees for, so far.
    #[cfg(test)]
    pub(crate) fn segments(&self) -> Vec<Bytes> {
        self.db
            .status()
            .list_segments()
            .into_iter()
            .map(|segment| segment.prefix)
            .collect()
    }

    /// Graceful shutdown.
    pub async fn close(&self) -> Result<()> {
        self.db.close().await.map_err(StoreError::from)
    }

    /// The value at `key` and when it expires (ms since the epoch), or `None`
    /// if it is absent or has expired.
    ///
    /// SlateDB drops an expired value only once compaction reaches it, and
    /// until then a plain read still returns it — so a blob would outlive
    /// its TTL by however long compaction takes, and worse, an upload of it
    /// would be skipped as already stored just before compaction removed it.
    async fn get_live(
        &self,
        key: &[u8],
        options: &ReadOptions,
    ) -> Result<Option<(Bytes, Option<i64>)>> {
        let Some(entry) = self.db.get_key_value_with_options(key, options).await? else {
            return Ok(None);
        };
        if entry.expire_ts.is_some_and(|at| at <= now_millis()) {
            return Ok(None);
        }
        Ok(Some((entry.value, entry.expire_ts)))
    }

    /// `Db::put`, returning once the value is durable.
    async fn db_put(&self, key: &[u8], value: Bytes) -> Result<()> {
        self.db
            .put_bytes(Bytes::copy_from_slice(key), value)
            .await?
            .await_durable()
            .await?;
        Ok(())
    }

    /// Write `batch`, returning once it is durable.
    ///
    /// SlateDB acknowledges a write as soon as it is in the in-memory WAL,
    /// and makes it durable on the next flush tick. A cache that answered
    /// then could lose an upload it had told the client succeeded, or report
    /// a blob present that a crash then takes away, so every write here
    /// waits. Concurrent waits are satisfied by the same flush.
    pub(crate) async fn commit(&self, batch: WriteBatch) -> Result<()> {
        self.db.write(batch).await?.await_durable().await?;
        Ok(())
    }

    // -----------------------------------------------------------------------------------------------------------------
    // High-level CAS blob API
    // -----------------------------------------------------------------------------------------------------------------

    /// Store a blob, chunking with FastCDC if large enough.
    ///
    /// All chunks and the manifest are written in a single WriteBatch
    /// so that the blob is either fully visible or not visible at all.
    /// Chunks are compressed with the given algorithm before storage.
    #[instrument(skip(self, data), fields(size = data.len(), %digest, %compression))]
    pub async fn cas_put_blob(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
    ) -> Result<()> {
        self.cas_put_blob_inner(digest, data, compression, true)
            .await
    }

    /// Store a blob whose digest was already computed by the caller.
    ///
    /// Identical to [`cas_put_blob`] but skips re-hashing the data for
    /// verification. The caller **must** guarantee that `digest` was
    /// computed from `data` — passing a mismatched pair is a logic error
    /// that will silently store garbage.
    #[instrument(skip(self, data), fields(size = data.len(), %digest, %compression))]
    pub async fn cas_put_blob_prehashed(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
    ) -> Result<()> {
        self.cas_put_blob_inner(digest, data, compression, false)
            .await
    }

    /// Store multiple blobs in a single batched write for amortized
    /// throughput: one `db.write()`, so one wait for durability, however
    /// many blobs and however large.
    ///
    /// **No existence checks** are performed — callers should use this on
    /// fresh-clone paths where duplicates are known to be absent or harmless
    /// (content-addressed writes are idempotent).
    ///
    /// **No hash re-verification** — callers **must** guarantee that each
    /// `digest` was computed from the corresponding `data`.
    #[instrument(skip(self, blobs), fields(count = blobs.len()))]
    pub async fn cas_put_blob_batch(
        &self,
        blobs: Vec<(ContentDigest, Bytes, Compression)>,
    ) -> Result<()> {
        if blobs.is_empty() {
            return Ok(());
        }
        let cheap = blobs_are_cheap(&blobs);
        let prepare_all = move || -> Result<Vec<([u8; 34], Bytes)>> {
            let mut puts = Vec::with_capacity(blobs.len() * 2);
            for (digest, data, compression) in &blobs {
                puts.extend(prepare_blob(digest, data, *compression)?);
            }
            Ok(puts)
        };
        let puts = if cheap {
            prepare_all()?
        } else {
            spawn_cpu(prepare_all).await?
        };

        self.commit(batch_of(puts)).await
    }

    async fn cas_put_blob_inner(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
        verify_hash: bool,
    ) -> Result<()> {
        if data.len() > MAX_BLOB_REASSEMBLE_SIZE {
            return Err(StoreError::BlobTooLarge {
                size: data.len(),
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            });
        }

        if verify_hash {
            // Verify hash first — never skip validation for untrusted
            // callers, to prevent accepting garbage data under a valid
            // digest.
            let check = {
                let (digest, data) = (*digest, data.clone());
                move || verify_digest(&digest, &data)
            };
            if data.len() < CPU_INLINE_BYTES {
                check()?;
            } else {
                spawn_cpu(check).await?;
            }
        }

        // Short-circuit: skip redundant write if blob already exists (with
        // enough of its TTL left; otherwise the write refreshes it).
        if self.cas_blob_fresh(digest).await? {
            debug!("blob already exists, skipping write");
            return Ok(());
        }

        // Chunks and manifest go in one WriteBatch, so the blob is either
        // fully visible or not at all. Content-addressed writes are
        // idempotent, so concurrent writers of the same hash need no
        // isolation from each other.
        let blob = [(*digest, data, compression)];
        let puts = if blobs_are_cheap(&blob) {
            prepare_blob(digest, &blob[0].1, compression)?
        } else {
            let [(digest, data, compression)] = blob;
            spawn_cpu(move || prepare_blob(&digest, &data, compression)).await?
        };
        debug!(chunk_count = puts.len() - 1, "blob prepared");
        self.commit(batch_of(puts)).await
    }

    /// Reassemble a blob from its manifest and chunks.
    /// Decompresses chunks transparently based on compression recorded in manifest.
    #[instrument(skip(self), fields(%digest))]
    pub async fn cas_get_blob(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        let digest_fn = digest.function;
        let hash = &digest.hash;

        let (manifest, _compression) = match self.cas_get_manifest(digest).await? {
            Some(m) => m,
            None => return Ok(None),
        };

        let total_size: u64 = manifest
            .chunks
            .iter()
            .try_fold(0u64, |acc, c| acc.checked_add(c.size))
            .ok_or_else(|| StoreError::ManifestCorrupted("total blob size overflows u64".into()))?;
        if total_size > MAX_BLOB_REASSEMBLE_SIZE as u64 {
            return Err(StoreError::BlobTooLarge {
                size: total_size as usize,
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            });
        }
        // Read chunks sequentially into a pre-allocated buffer so that each
        // chunk's raw + decompressed data can be dropped before the next iteration,
        // keeping peak memory at ~1x blob size instead of 2x.
        let mut buf = BytesMut::with_capacity(total_size as usize);
        let mut hasher = if manifest.chunks.len() != 1 {
            Some(IncrementalHasher::new(digest_fn, total_size as usize))
        } else {
            None
        };
        // Collect owned (hash, size) pairs so the stream closure captures
        // Copy values rather than &ChunkInfo references. This avoids a
        // Higher-Ranked Trait Bound (HRTB) issue that prevents the returned
        // future from being boxed (e.g. when called from #[tonic::async_trait]
        // methods).
        let chunk_specs: Vec<([u8; 32], u64)> = manifest
            .chunks
            .iter()
            .map(|ci| (ci.hash, ci.size))
            .collect();

        // Fetch chunks concurrently (up to 32 in-flight), yielded in order
        let mut stream = futures::stream::iter(chunk_specs)
            .map(|(chunk_hash, chunk_size)| async move {
                (
                    self.cas_get_raw_chunk(digest_fn, &chunk_hash).await,
                    chunk_hash,
                    chunk_size,
                )
            })
            .buffered(32);

        // Decompress, verify, and assemble as each chunk arrives
        while let Some((raw_result, chunk_hash, chunk_size)) = stream.next().await {
            let (chunk_compression, compressed) = match raw_result? {
                Some(c) => c,
                None => {
                    warn!(chunk_hash = %hex::encode(chunk_hash), "chunk missing from store");
                    return Err(StoreError::ChunkMissing {
                        hash: hex::encode(chunk_hash),
                    });
                }
            };
            let decompressed = chunk_compression
                .decompress_with_size_hint_async(compressed, chunk_size as usize)
                .await?;
            if decompressed.len() != chunk_size as usize {
                return Err(StoreError::ChunkSizeMismatch {
                    expected: chunk_size,
                    actual: decompressed.len(),
                });
            }
            let computed = digest_fn.hash_data(&decompressed);
            if computed != chunk_hash {
                warn!(
                    expected = %hex::encode(chunk_hash),
                    actual = %hex::encode(computed),
                    "chunk digest mismatch",
                );
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(chunk_hash),
                    actual: hex::encode(computed),
                });
            }
            if let Some(ref mut h) = hasher {
                h.update(&decompressed);
            }
            buf.put(decompressed.as_ref());
        }

        // For single-chunk blobs, the per-chunk hash check above already
        // verified the same hash, so skip the redundant whole-blob hash.
        if let Some(h) = hasher {
            let computed = h.finalize();
            if computed != *hash {
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(hash),
                    actual: hex::encode(computed),
                });
            }
        }
        Ok(Some(buf.freeze()))
    }

    /// Stream a blob's decompressed chunks in order.
    ///
    /// Peak memory is O(max_chunk_size × [`STREAM_PREFETCH_CHUNKS`]) instead
    /// of O(blob_size): that many chunk reads run ahead of the consumer, so a
    /// remote object store's latency is paid once per window rather than once
    /// per chunk. Returns `Ok(None)` if the blob does not exist. Each yielded
    /// `Bytes` is a verified, decompressed chunk.
    ///
    /// Note: unlike `cas_get_blob`, this does **not** verify the whole-blob
    /// hash (since chunks are yielded incrementally). Callers that need
    /// whole-blob integrity should hash the concatenated output themselves.
    #[instrument(skip(self), fields(%digest))]
    pub async fn cas_get_blob_stream(
        &self,
        digest: &ContentDigest,
    ) -> Result<Option<impl Stream<Item = Result<Bytes>> + '_>> {
        let digest_fn = digest.function;

        let (manifest, _compression) = match self.cas_get_manifest(digest).await? {
            Some(m) => m,
            None => return Ok(None),
        };

        // Owned (hash, size) pairs, as in `cas_get_blob`, keep the stream's
        // futures free of borrows from the manifest.
        let chunk_specs: Vec<([u8; 32], u64)> = manifest
            .chunks
            .iter()
            .map(|ci| (ci.hash, ci.size))
            .collect();
        let stream = futures::stream::iter(chunk_specs)
            .map(move |(chunk_hash, chunk_size)| async move {
                let (chunk_compression, compressed) = self
                    .cas_get_raw_chunk(digest_fn, &chunk_hash)
                    .await?
                    .ok_or_else(|| StoreError::ChunkMissing {
                        hash: hex::encode(chunk_hash),
                    })?;
                let decompressed = chunk_compression
                    .decompress_with_size_hint_async(compressed, chunk_size as usize)
                    .await?;
                if decompressed.len() != chunk_size as usize {
                    return Err(StoreError::ChunkSizeMismatch {
                        expected: chunk_size,
                        actual: decompressed.len(),
                    });
                }
                let computed = digest_fn.hash_data(&decompressed);
                if computed != chunk_hash {
                    return Err(StoreError::DigestMismatch {
                        expected: hex::encode(chunk_hash),
                        actual: hex::encode(computed),
                    });
                }
                Ok(decompressed)
            })
            .buffered(STREAM_PREFETCH_CHUNKS);
        Ok(Some(stream))
    }

    /// Whether a blob is stored, durably and unexpired (by its manifest).
    // TODO(perf): SlateDB lacks contains_key; this fetches the full value
    pub async fn cas_blob_exists(&self, digest: &ContentDigest) -> Result<bool> {
        Ok(self.blob_expiry(digest).await?.is_some())
    }

    /// Whether a blob is stored with at least half its TTL left: stored, as
    /// far as skipping an upload of it goes.
    ///
    /// Nothing else extends a blob's TTL, so a blob in its last half-life
    /// reads as missing here: FindMissingBlobs asks clients to upload it
    /// again, and the upload rewrites it with a fresh TTL. Blobs in use stay
    /// stored, at the cost of one re-upload per half-life; unused ones
    /// expire.
    pub async fn cas_blob_fresh(&self, digest: &ContentDigest) -> Result<bool> {
        Ok(match self.blob_expiry(digest).await? {
            None => false,
            Some(None) => true,
            Some(Some(expires_at)) => self
                .refresh_window_ms
                .is_none_or(|window| expires_at - now_millis() >= window),
        })
    }

    /// `None` if the blob is not durably stored (or has expired), else when
    /// it expires.
    async fn blob_expiry(&self, digest: &ContentDigest) -> Result<Option<Option<i64>>> {
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        Ok(self
            .get_live(&key, &durable_read_options())
            .await?
            .map(|(_, expires_at)| expires_at))
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Chunk-level CAS API (for SplitBlob/SpliceBlob)
    // -----------------------------------------------------------------------------------------------------------------

    /// Get the manifest (chunk list) for a blob, along with its compression.
    pub async fn cas_get_manifest(
        &self,
        digest: &ContentDigest,
    ) -> Result<Option<(BlobManifest, Compression)>> {
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        match self.get_live(&key, &ReadOptions::default()).await? {
            Some((data, _)) => Ok(Some(BlobManifest::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    /// Store a manifest for a blob (used by SpliceBlob).
    ///
    /// Note: this is a non-atomic write — use `cas_splice_blob` for atomic
    /// chunk+manifest writes.
    pub(crate) async fn cas_put_manifest(
        &self,
        digest: &ContentDigest,
        manifest: &BlobManifest,
        compression: Compression,
    ) -> Result<()> {
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        self.db_put(&key, manifest.to_bytes(compression)?).await
    }

    /// Atomically store a blob from pre-existing chunk data.
    ///
    /// All chunks are verified, compressed, and written along with the manifest
    /// in a single WriteBatch. This is the preferred path for SpliceBlob
    /// workflows where all chunk data is available upfront.
    #[instrument(skip(self, chunks), fields(%blob_digest, %compression))]
    pub async fn cas_splice_blob(
        &self,
        blob_digest: &ContentDigest,
        chunks: Vec<(ContentDigest, Bytes)>,
        compression: Compression,
    ) -> Result<()> {
        let digest_fn = blob_digest.function;

        let total_size: usize = chunks
            .iter()
            .try_fold(0usize, |acc, (_, d)| acc.checked_add(d.len()))
            .ok_or_else(|| StoreError::BlobTooLarge {
                size: usize::MAX,
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            })?;
        let mut hasher = IncrementalHasher::new(digest_fn, total_size);

        // Phase 1: verify per-chunk hashes and update incremental hasher
        // (sequential — hasher is order-dependent). Hashing is fast; this
        // fails early on corrupt chunks before expensive compression work.
        for (chunk_digest, chunk_data) in &chunks {
            let computed = digest_fn.hash_data(chunk_data);
            if computed != chunk_digest.hash {
                return Err(StoreError::DigestMismatch {
                    expected: hex::encode(chunk_digest.hash),
                    actual: hex::encode(computed),
                });
            }
            hasher.update(chunk_data);
        }

        // Verify whole-blob hash before doing compression work
        let computed_blob_hash = hasher.finalize();
        if computed_blob_hash != blob_digest.hash {
            return Err(StoreError::DigestMismatch {
                expected: hex::encode(blob_digest.hash),
                actual: hex::encode(computed_blob_hash),
            });
        }

        // Phase 2: compress chunks in parallel and batch write
        let mut batch = WriteBatch::new();
        let mut chunk_infos = Vec::with_capacity(chunks.len());
        let mut stream = futures::stream::iter(chunks)
            .map(|(chunk_digest, chunk_data)| async move {
                let chunk_len = chunk_data.len() as u64;
                let compressed = compression.compress_async(chunk_data).await?;
                let tagged = tagged_chunk(compression, &compressed);
                Ok::<_, StoreError>((chunk_digest.hash, chunk_len, tagged))
            })
            .buffered(32);

        while let Some(result) = stream.next().await {
            let (hash, chunk_len, tagged) = result?;
            let chunk_key = prefixed_key(PREFIX_CHUNK, digest_fn, &hash);
            batch.put_bytes(Bytes::copy_from_slice(&chunk_key), tagged);
            chunk_infos.push(ChunkInfo {
                hash,
                size: chunk_len,
            });
        }

        let manifest = BlobManifest {
            chunks: chunk_infos,
            created_at: unix_now_secs(),
        };
        let manifest_key = prefixed_key(PREFIX_MANIFEST, digest_fn, &blob_digest.hash);
        batch.put_bytes(
            Bytes::copy_from_slice(&manifest_key),
            manifest.to_bytes(compression)?,
        );
        self.commit(batch).await?;
        Ok(())
    }

    /// Fetch a raw chunk without decompression, returning its compression tag.
    async fn cas_get_raw_chunk(
        &self,
        digest_fn: DigestFn,
        hash: &[u8; 32],
    ) -> Result<Option<(Compression, Bytes)>> {
        let key = prefixed_key(PREFIX_CHUNK, digest_fn, hash);
        match self
            .db
            .get_with_options(&key, &chunk_read_options())
            .await?
        {
            Some(raw) => Ok(Some(parse_chunk_tag(raw)?)),
            None => Ok(None),
        }
    }

    /// Store a chunk, compressing it before storage.
    pub async fn cas_put_chunk(
        &self,
        digest: &ContentDigest,
        data: Bytes,
        compression: Compression,
    ) -> Result<()> {
        let computed = digest.function.hash_data(&data);
        if computed != digest.hash {
            return Err(StoreError::DigestMismatch {
                expected: hex::encode(digest.hash),
                actual: hex::encode(computed),
            });
        }

        let compressed = compression.compress_async(data).await?;
        let tagged = tagged_chunk(compression, &compressed);
        let key = prefixed_key(PREFIX_CHUNK, digest.function, &digest.hash);
        self.db_put(&key, tagged).await
    }

    /// Fetch a chunk, decompressing it after retrieval.
    ///
    /// The compression algorithm is auto-detected from the stored 1-byte header.
    pub async fn cas_get_chunk(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        match self
            .cas_get_raw_chunk(digest.function, &digest.hash)
            .await?
        {
            Some((compression, compressed)) => {
                let decompressed = compression.decompress_async(compressed).await?;
                let computed = digest.function.hash_data(&decompressed);
                if computed != digest.hash {
                    return Err(StoreError::DigestMismatch {
                        expected: hex::encode(digest.hash),
                        actual: hex::encode(computed),
                    });
                }
                Ok(Some(decompressed))
            }
            None => Ok(None),
        }
    }

    /// Check if a chunk exists.
    // TODO(perf): SlateDB lacks contains_key; this fetches the full value
    pub async fn cas_chunk_exists(&self, digest: &ContentDigest) -> Result<bool> {
        let key = prefixed_key(PREFIX_CHUNK, digest.function, &digest.hash);
        let result = self
            .db
            .get_with_options(&key, &chunk_read_options())
            .await?;
        Ok(result.is_some())
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Action cache API
    // -----------------------------------------------------------------------------------------------------------------

    /// Store an action cache entry (serialized ActionResult protobuf).
    ///
    /// The digest is an *action digest* — the hash of the Action proto (command +
    /// input root), NOT a content hash of `data`. The `data` is a serialized
    /// `ActionResult` proto (build outputs, exit codes, etc.) which is semantically
    /// unrelated to the action hash. Content-hash verification is therefore
    /// impossible and incorrect at this layer.
    ///
    /// # Security
    ///
    /// Because the hash is not verified against the stored data, any caller can
    /// write arbitrary results under any action key. In multi-tenant deployments,
    /// cache poisoning must be prevented at the gRPC service layer via
    /// authentication and authorization policies that gate which clients may
    /// write to which action keys.
    #[instrument(skip(self, data), fields(%digest, size = data.len()))]
    pub async fn ac_put(&self, digest: &ContentDigest, data: Bytes) -> Result<()> {
        if data.len() > MAX_ACTION_CACHE_ENTRY_SIZE {
            return Err(StoreError::BlobTooLarge {
                size: data.len(),
                limit: MAX_ACTION_CACHE_ENTRY_SIZE,
            });
        }
        let key = prefixed_key(PREFIX_ACTION, digest.function, &digest.hash);
        self.db_put(&key, data).await
    }

    /// Fetch an action cache entry.
    #[instrument(skip(self), fields(%digest))]
    pub async fn ac_get(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        let key = prefixed_key(PREFIX_ACTION, digest.function, &digest.hash);
        Ok(self
            .get_live(&key, &ReadOptions::default())
            .await?
            .map(|(data, _)| data))
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Asset mapping API (Remote Asset API)
    // -----------------------------------------------------------------------------------------------------------------

    /// Store an asset mapping entry for a (URI, qualifiers, digest_function) tuple.
    #[instrument(skip(self, entry), fields(%uri, %digest_fn))]
    pub async fn asset_put(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
        entry: &AssetEntry,
    ) -> Result<()> {
        let key = asset_key(digest_fn, uri, qualifiers);
        self.db_put(&key, entry.to_bytes()).await
    }

    /// Look up an asset mapping entry by (URI, qualifiers, digest_function).
    #[instrument(skip(self), fields(%uri, %digest_fn))]
    pub async fn asset_get(
        &self,
        digest_fn: DigestFn,
        uri: &str,
        qualifiers: &[(String, String)],
    ) -> Result<Option<AssetEntry>> {
        let key = asset_key(digest_fn, uri, qualifiers);
        match self.get_live(&key, &ReadOptions::default()).await? {
            Some((data, _)) => Ok(Some(AssetEntry::from_bytes(data)?)),
            None => Ok(None),
        }
    }

    // -----------------------------------------------------------------------------------------------------------------

    /// Create a streaming writer for building a CAS blob incrementally.
    ///
    /// Data can be fed in arbitrary-sized pieces via [`CasBlobWriter::write`].
    /// Call [`CasBlobWriter::finalize`] to flush remaining data, write the
    /// manifest, and return the whole-blob digest.
    pub fn cas_blob_writer(
        &self,
        digest_fn: DigestFn,
        compression: Compression,
    ) -> CasBlobWriter<'_> {
        CasBlobWriter::new(self, digest_fn, compression)
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// Prepend a 1-byte compression tag to compressed chunk data for self-describing storage.
pub(crate) fn tagged_chunk(compression: Compression, compressed: &[u8]) -> Bytes {
    let mut buf = BytesMut::with_capacity(1 + compressed.len());
    buf.put_u8(compression as u8);
    buf.put(compressed);
    buf.freeze()
}

/// Parse the 1-byte compression tag from stored chunk data.
/// Returns the compression algorithm and the remaining compressed bytes.
fn parse_chunk_tag(raw: Bytes) -> Result<(Compression, Bytes)> {
    if raw.is_empty() {
        return Err(StoreError::ManifestCorrupted(
            "chunk data is empty (missing compression tag)".into(),
        ));
    }
    let tag = raw[0];
    let compression = Compression::from_u8(tag).ok_or_else(|| {
        StoreError::ManifestCorrupted(format!("unknown chunk compression tag: {}", tag))
    })?;
    Ok((compression, raw.slice(1..)))
}

/// Build a 34-byte key: 1-byte prefix + 1-byte digest_fn discriminator + 32-byte hash.
pub(crate) fn prefixed_key(prefix: u8, digest_fn: DigestFn, hash: &[u8; 32]) -> [u8; 34] {
    let mut key = [0u8; 34];
    key[0] = prefix;
    key[1] = digest_fn as u8;
    key[2..34].copy_from_slice(hash);
    key
}

/// A write batch of `puts`, taking each value without a copy.
fn batch_of(puts: Vec<([u8; 34], Bytes)>) -> WriteBatch {
    let mut batch = WriteBatch::new();
    for (key, value) in puts {
        batch.put_bytes(Bytes::copy_from_slice(&key), value);
    }
    batch
}

/// Blobs below this size are hashed, chunked, and compressed inline; larger
/// ones on a blocking thread, so no async worker stalls on a multi-GiB blob.
pub const CPU_INLINE_BYTES: usize = 256 * 1024;

/// Whether preparing `blobs` is cheap enough to do on an async worker:
/// uncompressed, and small in total.
fn blobs_are_cheap(blobs: &[(ContentDigest, Bytes, Compression)]) -> bool {
    let mut total = 0;
    blobs.iter().all(|(_, data, compression)| {
        total += data.len();
        *compression == Compression::Identity && total < CPU_INLINE_BYTES
    })
}

/// Run CPU-bound `work` on a blocking thread.
async fn spawn_cpu<T: Send + 'static>(
    work: impl FnOnce() -> Result<T> + Send + 'static,
) -> Result<T> {
    tokio::task::spawn_blocking(work).await.map_err(|e| {
        StoreError::Database(slatedb::Error::unavailable(format!("blocking task: {e}")))
    })?
}

/// Check that `data` hashes to `digest`.
fn verify_digest(digest: &ContentDigest, data: &[u8]) -> Result<()> {
    let computed = digest.function.hash_data(data);
    if computed != digest.hash {
        return Err(StoreError::DigestMismatch {
            expected: hex::encode(digest.hash),
            actual: hex::encode(computed),
        });
    }
    Ok(())
}

/// The key-value pairs that store `data` as the blob `digest`: its chunks
/// (one for a small blob, FastCDC-split otherwise), then its manifest.
///
/// CPU-bound for large blobs (chunking, hashing, and compressing every
/// chunk), which it spreads over the rayon pool: call it from a blocking
/// context unless [`blobs_are_cheap`].
fn prepare_blob(
    digest: &ContentDigest,
    data: &Bytes,
    compression: Compression,
) -> Result<Vec<([u8; 34], Bytes)>> {
    if data.len() > MAX_BLOB_REASSEMBLE_SIZE {
        return Err(StoreError::BlobTooLarge {
            size: data.len(),
            limit: MAX_BLOB_REASSEMBLE_SIZE,
        });
    }
    let digest_fn = digest.function;
    let chunk = |hash: [u8; 32], piece: &[u8]| -> Result<(ChunkInfo, [u8; 34], Bytes)> {
        let tagged = tagged_chunk(compression, &compression.compress(piece)?);
        let info = ChunkInfo {
            hash,
            size: piece.len() as u64,
        };
        Ok((info, prefixed_key(PREFIX_CHUNK, digest_fn, &hash), tagged))
    };

    let chunks: Vec<_> = if data.is_empty() {
        Vec::new()
    } else if data.len() < SMALL_BLOB_THRESHOLD {
        // A single chunk: the blob itself, under its own hash.
        vec![chunk(digest.hash, data)?]
    } else {
        use rayon::prelude::*;
        let ranges: Vec<(usize, usize)> = cdc_ranges(data).collect();
        ranges
            .into_par_iter()
            .map(|(offset, length)| {
                let piece = &data[offset..offset + length];
                chunk(digest_fn.hash_data(piece), piece)
            })
            .collect::<Result<_>>()?
    };

    let mut puts = Vec::with_capacity(chunks.len() + 1);
    let mut manifest = BlobManifest {
        chunks: Vec::with_capacity(chunks.len()),
        created_at: unix_now_secs(),
    };
    for (info, key, value) in chunks {
        manifest.chunks.push(info);
        puts.push((key, value));
    }
    let manifest_key = prefixed_key(PREFIX_MANIFEST, digest_fn, &digest.hash);
    puts.push((manifest_key, manifest.to_bytes(compression)?));
    Ok(puts)
}

/// The chunks FastCDC cuts `data` into, as `(offset, length)`.
pub(crate) fn cdc_ranges(data: &[u8]) -> impl Iterator<Item = (usize, usize)> + '_ {
    fastcdc::v2020::FastCDC::with_level(
        data,
        CDC_MIN_SIZE,
        CDC_AVG_SIZE,
        CDC_MAX_SIZE,
        fastcdc::v2020::Normalization::Level2,
    )
    .map(|c| (c.offset, c.length))
}

/// Compress chunk ranges in parallel and write them to a WriteBatch.
///
/// Each range `(offset, length)` is sliced from `data`, hashed, compressed,
/// tagged, and added to the batch. Returns the chunk metadata.
pub(crate) async fn compress_and_batch_chunks(
    data: &Bytes,
    ranges: &[(usize, usize)],
    digest_fn: DigestFn,
    compression: Compression,
    batch: &mut WriteBatch,
) -> Result<Vec<ChunkInfo>> {
    let mut stream = futures::stream::iter(ranges.iter().copied())
        .map(|(offset, length)| {
            let chunk_data = data.slice(offset..offset + length);
            async move {
                let chunk_hash = digest_fn.hash_data(&chunk_data);
                let compressed = compression.compress_async(chunk_data).await?;
                let tagged = tagged_chunk(compression, &compressed);
                Ok::<_, StoreError>((chunk_hash, length, tagged))
            }
        })
        .buffered(32);

    let mut chunks = Vec::with_capacity(ranges.len());
    while let Some(result) = stream.next().await {
        let (chunk_hash, length, tagged) = result?;
        let chunk_key = prefixed_key(PREFIX_CHUNK, digest_fn, &chunk_hash);
        batch.put_bytes(Bytes::copy_from_slice(&chunk_key), tagged);
        chunks.push(ChunkInfo {
            hash: chunk_hash,
            size: length as u64,
        });
    }
    Ok(chunks)
}

// ---------------------------------------------------------------------------------------------------------------------
// Asset mapping types
// ---------------------------------------------------------------------------------------------------------------------

/// An asset mapping entry stored by the Remote Asset API.
///
/// Associates a (URI, qualifiers, digest_function) tuple with a CAS digest,
/// recording creation time, optional expiry, and content type (blob vs directory).
#[derive(Debug, Clone)]
pub struct AssetEntry {
    pub digest_hash: [u8; 32],
    pub digest_size_bytes: i64,
    pub created_at: u64,
    /// Unix timestamp after which the entry is considered expired. 0 = no expiry.
    pub expires_at: u64,
    pub is_directory: bool,
    pub qualifiers: Vec<(String, String)>,
}

impl AssetEntry {
    /// Serialize to binary format:
    /// `[32B hash][i64 LE size][u64 LE created][u64 LE expires][u8 is_dir][u32 LE num_quals]`
    /// followed by `[u32 LE name_len][name][u32 LE val_len][val]` per qualifier.
    pub fn to_bytes(&self) -> Bytes {
        let qual_size: usize = self
            .qualifiers
            .iter()
            .map(|(n, v)| 4 + n.len() + 4 + v.len())
            .sum();
        let len = 32 + 8 + 8 + 8 + 1 + 4 + qual_size;
        let mut buf = BytesMut::with_capacity(len);
        buf.put_slice(&self.digest_hash);
        buf.put_i64_le(self.digest_size_bytes);
        buf.put_u64_le(self.created_at);
        buf.put_u64_le(self.expires_at);
        buf.put_u8(u8::from(self.is_directory));
        buf.put_u32_le(self.qualifiers.len() as u32);
        for (name, value) in &self.qualifiers {
            buf.put_u32_le(name.len() as u32);
            buf.put_slice(name.as_bytes());
            buf.put_u32_le(value.len() as u32);
            buf.put_slice(value.as_bytes());
        }
        buf.freeze()
    }

    /// Deserialize from binary format.
    pub fn from_bytes(mut data: Bytes) -> Result<Self> {
        const MIN_SIZE: usize = 32 + 8 + 8 + 8 + 1 + 4;
        if data.len() < MIN_SIZE {
            return Err(StoreError::ManifestCorrupted(
                "asset entry too short".into(),
            ));
        }
        let mut digest_hash = [0u8; 32];
        data.copy_to_slice(&mut digest_hash);
        let digest_size_bytes = data.get_i64_le();
        let created_at = data.get_u64_le();
        let expires_at = data.get_u64_le();
        let is_directory = data.get_u8() != 0;
        let num_qualifiers = data.get_u32_le() as usize;
        let mut qualifiers = Vec::with_capacity(num_qualifiers.min(1024));
        for _ in 0..num_qualifiers {
            if data.remaining() < 4 {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier truncated".into(),
                ));
            }
            let name_len = data.get_u32_le() as usize;
            if data.remaining() < name_len {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier name truncated".into(),
                ));
            }
            let name = String::from_utf8(data.split_to(name_len).to_vec()).map_err(|_| {
                StoreError::ManifestCorrupted("invalid UTF-8 in qualifier name".into())
            })?;
            if data.remaining() < 4 {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier value length truncated".into(),
                ));
            }
            let value_len = data.get_u32_le() as usize;
            if data.remaining() < value_len {
                return Err(StoreError::ManifestCorrupted(
                    "asset entry qualifier value truncated".into(),
                ));
            }
            let value = String::from_utf8(data.split_to(value_len).to_vec()).map_err(|_| {
                StoreError::ManifestCorrupted("invalid UTF-8 in qualifier value".into())
            })?;
            qualifiers.push((name, value));
        }
        Ok(AssetEntry {
            digest_hash,
            digest_size_bytes,
            created_at,
            expires_at,
            is_directory,
            qualifiers,
        })
    }
}

/// Compute the storage key for an asset mapping.
///
/// Canonical form: `"{uri}\0{q1_name}={q1_value}\0..."` with qualifiers sorted
/// lexicographically by name. SHA-256 hashed into a fixed 32-byte key, then
/// prefixed with `PREFIX_ASSET` and the digest function discriminator.
fn asset_key(digest_fn: DigestFn, uri: &str, qualifiers: &[(String, String)]) -> [u8; 34] {
    let mut canonical = uri.to_string();
    let mut sorted_quals: Vec<(&String, &String)> =
        qualifiers.iter().map(|(n, v)| (n, v)).collect();
    sorted_quals.sort_by(|a, b| a.0.cmp(&b.0));
    for (name, value) in sorted_quals {
        canonical.push('\0');
        canonical.push_str(name);
        canonical.push('=');
        canonical.push_str(value);
    }
    let key_hash = DigestFn::Sha256.hash_data(canonical.as_bytes());
    prefixed_key(PREFIX_ASSET, digest_fn, &key_hash)
}

#[cfg(test)]
mod test_helpers;

#[cfg(test_module_action_cache)]
mod test_action_cache;
#[cfg(test_module_asset)]
mod test_asset;
#[cfg(test_module_cas)]
mod test_cas;
#[cfg(test_module_cas_batch)]
mod test_cas_batch;
#[cfg(test_module_chunking)]
mod test_chunking;
#[cfg(test_module_compression)]
mod test_compression;
#[cfg(test_module_concurrency)]
mod test_concurrency;
#[cfg(test_module_expiry)]
mod test_expiry;
#[cfg(test_module_hashing)]
mod test_hashing;
#[cfg(test_module_lifecycle)]
mod test_lifecycle;
#[cfg(test_module_manifest)]
mod test_manifest;
#[cfg(test_module_streaming)]
mod test_streaming;
#[cfg(test_module_tuning)]
mod test_tuning;
