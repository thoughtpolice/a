// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Content-addressable chunk storage backed by SlateDB with FastCDC chunking.

mod action_results;
mod compression;
mod db_cache;
mod error;
mod expiring;
mod hashing;
mod manifest;
mod manifest_cache;
mod presence;
mod small_blobs;
mod space;
mod writer;

// Re-export public API so the external interface is unchanged.
pub use action_results::DEFAULT_ACTION_RESULT_CACHE_BYTES;
pub use compression::{Compression, StreamingDecompressor};
pub use error::{Result, StoreError};
pub use hashing::{ContentDigest, DigestFn, IncrementalHasher, parse_digest_hash};
pub use manifest::{BlobManifest, ChunkInfo, INLINE_BLOB_MAX, MAX_MANIFEST_CHUNK_COUNT};
pub use manifest_cache::DEFAULT_MANIFEST_CACHE_BYTES;
pub use small_blobs::DEFAULT_SMALL_BLOB_CACHE_BYTES;
pub use space::{default_reserve, filesystem_space};
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
use futures::{Stream, StreamExt as _, TryStreamExt as _};
use slatedb::config::{DurabilityLevel, PutOptions, ReadOptions, Ttl};
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
    /// Local stores only: refuse writes while the disk under the store has
    /// less than this many bytes free. `None` keeps [`default_reserve`];
    /// `Some(0)` turns the check off.
    pub disk_reserve_bytes: Option<u64>,
    /// How many stored blobs to remember, so that checking for them again
    /// (FindMissingBlobs, mostly) skips the LSM. `None` keeps about a
    /// million, some 80 MiB.
    pub presence_cache_entries: Option<usize>,
    /// Bytes of small blobs (those stored in their manifests) to keep once
    /// read, so reading them again skips the LSM. `None` keeps
    /// [`DEFAULT_SMALL_BLOB_CACHE_BYTES`]; `Some(0)` keeps none.
    pub small_blob_cache_bytes: Option<u64>,
    /// Bytes of action cache entries to keep once read, so reading them
    /// again skips the LSM. `None` keeps
    /// [`DEFAULT_ACTION_RESULT_CACHE_BYTES`]; `Some(0)` keeps none.
    pub action_result_cache_bytes: Option<u64>,
    /// Bytes of blob manifests (of blobs not stored in them) to keep once
    /// read, so reading the blob again skips the manifest's lookup. `None`
    /// keeps [`DEFAULT_MANIFEST_CACHE_BYTES`]; `Some(0)` keeps none.
    pub manifest_cache_bytes: Option<u64>,
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
            .field("disk_reserve_bytes", &self.disk_reserve_bytes)
            .field("presence_cache_entries", &self.presence_cache_entries)
            .field("small_blob_cache_bytes", &self.small_blob_cache_bytes)
            .field("action_result_cache_bytes", &self.action_result_cache_bytes)
            .field("manifest_cache_bytes", &self.manifest_cache_bytes)
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
const PREFIX_GIT_BLOB: u8 = b'g';

// FastCDC parameters: avg 512 KiB, min = avg/4, max = avg*4
const CDC_AVG_SIZE: usize = 524_288; // 512 KiB
const CDC_MIN_SIZE: usize = CDC_AVG_SIZE / 4; // 128 KiB
const CDC_MAX_SIZE: usize = CDC_AVG_SIZE * 4; // 2 MiB

// Blobs below this size are stored as a single chunk (no CDC splitting)
const SMALL_BLOB_THRESHOLD: usize = CDC_MAX_SIZE;

/// Chunk reads a blob stream keeps in flight ahead of its consumer.
const STREAM_PREFETCH_CHUNKS: usize = 8;

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
        // Each compaction protects the SSTs it replaces with a checkpoint, so
        // reads that began before it can finish, and garbage collection
        // keeps them until it expires: 15 minutes by default, which under a
        // stream of uploads made replaced data most of the store (about five
        // times the live data on S3). Every read here is a point lookup that
        // takes milliseconds, even against S3, so two minutes is ample.
        compactor.checkpoint_lifetime = std::time::Duration::from_secs(120);
        if let Some(worker) = compactor.worker.as_mut() {
            worker.compactions_poll_interval = poll;
            // SlateDB requires the worker's filter threshold to match the
            // writer's; otherwise compacted SSTs drop their filters.
            worker.min_filter_keys = settings.min_filter_keys;
        }
    }

    if let Some(gc) = settings.garbage_collector_options.as_mut() {
        // Collection of replaced SSTs runs only every 10 minutes by default,
        // on top of the compactor's checkpoint lifetime (above) and the
        // 5-minute minimum age it keeps any SST for: under a stream of
        // uploads, replaced data waited up to 25 minutes to go, and was most
        // of the disk in use. Collect every minute instead. Flushed WAL is pinned by nothing (this store has no
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
        data(PREFIX_GIT_BLOB),
    ])
}

/// Splits the store into one LSM tree (an RFC-0024 segment) per kind of
/// key — chunks, manifests, action cache entries, assets — by the key's
/// first byte.
///
/// Metadata then never shares an SST, or a compaction, with megabytes of
/// chunk data: a manifest or action cache lookup probes only that kind's
/// SSTs, which are small, dense, and well covered by bloom filters and the
/// block cache, and compacting metadata rewrites no chunks. (Manifests also
/// hold blobs of up to [`INLINE_BLOB_MAX`], about a block each, which is
/// what lets one lookup read a small blob.)
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

/// Chunks at most this large are read through the block cache. Small
/// blobs are mostly Directory protos and small outputs, read over and over
/// (every GetTree of a tree reads each of its Directories); the block
/// holding one is a few KiB, where the block of a large chunk is the chunk.
const CACHED_CHUNK_BYTES: u64 = 64 * 1024;

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
    /// The TTL (ms) new values get, if any.
    default_ttl_ms: Option<i64>,
    /// A value with less than this long (ms) to live is due for a rewrite:
    /// half the default TTL, or `None` without one.
    refresh_window_ms: Option<i64>,
    /// Local stores: the free space writes need.
    disk: Option<Arc<space::DiskReserve>>,
    /// Blobs known durably stored, so existence checks skip the LSM.
    presence: presence::PresenceCache,
    /// Small blobs recently read, so reading them again skips the LSM.
    small_blobs: Option<small_blobs::SmallBlobCache>,
    /// Action cache entries recently read, dropped when written.
    action_results: Option<action_results::ActionResultCache>,
    /// Blob manifests recently read, so reading the blob again skips the
    /// manifest's lookup.
    manifests: Option<manifest_cache::ManifestCache>,
}

/// A blob's manifest, as read, and what keeping the blob once its data is
/// read takes.
struct ManifestRead {
    manifest: BlobManifest,
    compression: Compression,
    /// When the stored manifest expires (ms since the epoch; `None` never,
    /// or answered from memory).
    expires_at: Option<i64>,
    /// When the read began (ms since the epoch).
    read_at: i64,
    /// Whether the manifest cache answered, so that a chunk found missing
    /// may mean only that its entry is out of date.
    cached: bool,
}

impl ManifestRead {
    fn new(
        manifest: BlobManifest,
        compression: Compression,
        expires_at: Option<i64>,
        read_at: i64,
    ) -> Self {
        Self {
            manifest,
            compression,
            expires_at,
            read_at,
            cached: false,
        }
    }
}

/// Where a manifest read may be answered from.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ManifestSource {
    /// The caches of blobs and manifests read, else the store.
    Cached,
    /// The store alone.
    Store,
}

/// A blob's manifest, read to read the blob a chunk at a time with
/// [`CacheStore::cas_read_chunk`].
pub struct BlobChunks {
    digest: ContentDigest,
    read: ManifestRead,
}

impl BlobChunks {
    /// The blob's chunks, in order: for a blob stored in its manifest, one,
    /// the blob itself.
    pub fn chunks(&self) -> &[ChunkInfo] {
        &self.read.manifest.chunks
    }
}

/// A git blob's CAS digest, recorded when an ingest stores (or finds) the
/// blob, so a later ingest of the same blob — found by its git object id —
/// can skip decompressing and hashing it.
///
/// Git object ids are SHA-1, hashed (by gitoxide, as by git) with SHA-1
/// collision detection, so one repository cannot claim another's blob.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct GitBlobRecord {
    /// The blob's git object id.
    pub git_id: [u8; 20],
    /// The blob's CAS digest.
    pub digest: ContentDigest,
    /// The blob's size in bytes.
    pub size: u64,
    /// When the CAS blob expires (ms since the epoch; `None` never), as far
    /// as was known when this was recorded. A blob's expiry only ever moves
    /// later (when it is written again), so this never overstates it.
    pub blob_expires_at_ms: Option<i64>,
}

impl GitBlobRecord {
    fn key(digest_fn: DigestFn, git_id: &[u8; 20]) -> [u8; 22] {
        let mut key = [0u8; 22];
        key[0] = PREFIX_GIT_BLOB;
        key[1] = digest_fn as u8;
        key[2..].copy_from_slice(git_id);
        key
    }

    /// `[32-byte hash][u64 LE size][i64 LE expiry, i64::MAX for none]`
    fn value(&self) -> Bytes {
        let mut buf = BytesMut::with_capacity(48);
        buf.put_slice(&self.digest.hash);
        buf.put_u64_le(self.size);
        buf.put_i64_le(self.blob_expires_at_ms.unwrap_or(i64::MAX));
        buf.freeze()
    }

    fn decode(git_id: [u8; 20], digest_fn: DigestFn, mut value: Bytes) -> Result<Self> {
        if value.len() != 48 {
            return Err(StoreError::ManifestCorrupted(format!(
                "git blob record of {} bytes",
                value.len()
            )));
        }
        let mut hash = [0u8; 32];
        value.copy_to_slice(&mut hash);
        let size = value.get_u64_le();
        let expires = value.get_i64_le();
        Ok(Self {
            git_id,
            digest: ContentDigest::new(digest_fn, hash),
            size,
            blob_expires_at_ms: (expires != i64::MAX).then_some(expires),
        })
    }
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
            // Reads on threads of its own, one trip each, rather than two
            // trips through Tokio's blocking pool (see local-object-store).
            let threads = std::thread::available_parallelism().map_or(8, |n| n.get().clamp(4, 32));
            Arc::new(
                local_object_store::PooledLocalFileSystem::new_with_prefix(path, threads).map_err(
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

        let db_cache = SplitCache::new()
            .with_block_cache(Some(Arc::new(db_cache::QuickDbCache::new(
                settings
                    .block_cache_bytes
                    .unwrap_or(DEFAULT_BLOCK_CACHE_BYTES),
            ))))
            .with_meta_cache(Some(Arc::new(db_cache::QuickDbCache::new(
                settings
                    .meta_cache_bytes
                    .unwrap_or(DEFAULT_META_CACHE_BYTES),
            ))))
            .build();

        // The cache is this store's alone, so its entries need no scope of
        // their own; and it lives in memory, so there is nothing for
        // `DbCache::close` to save when the store closes.
        const DB_CACHE_ID: u64 = 0;
        let mut builder = Db::builder(DB_PATH, object_store)
            .with_settings(db_settings)
            .with_db_cache(Arc::new(db_cache), DB_CACHE_ID)
            .with_block_cache_policy(block_cache_policy())
            .with_segment_extractor(Arc::new(KeyKind));
        if let Some(recorder) = settings.metrics_recorder.clone() {
            builder = builder.with_metrics_recorder(recorder);
        }
        let disk = match (&backend, settings.disk_reserve_bytes) {
            (_, Some(0)) => None,
            (StoreBackend::LocalFs(path), reserve) => {
                let disk = space::DiskReserve::watch(path.into(), reserve).map_err(|e| {
                    StoreError::Database(slatedb::Error::unavailable(format!(
                        "measuring free space under {path}: {e}"
                    )))
                })?;
                tracing::info!(
                    path,
                    reserve = disk.reserve(),
                    "keeping a free disk space reserve"
                );
                Some(disk)
            }
            _ => None,
        };
        let db = builder.build().await?;
        let default_ttl_ms = default_ttl_ms.map(|ttl| i64::try_from(ttl).unwrap_or(i64::MAX));
        Ok(CacheStore {
            db,
            default_ttl_ms,
            refresh_window_ms: default_ttl_ms.map(|ttl| ttl / 2),
            disk,
            presence: presence::PresenceCache::new(
                settings
                    .presence_cache_entries
                    .unwrap_or(presence::DEFAULT_ENTRIES)
                    .max(1),
            ),
            small_blobs: small_blobs::SmallBlobCache::new(
                settings
                    .small_blob_cache_bytes
                    .unwrap_or(DEFAULT_SMALL_BLOB_CACHE_BYTES),
            ),
            action_results: action_results::ActionResultCache::new(
                settings
                    .action_result_cache_bytes
                    .unwrap_or(DEFAULT_ACTION_RESULT_CACHE_BYTES),
            ),
            manifests: manifest_cache::ManifestCache::new(
                settings
                    .manifest_cache_bytes
                    .unwrap_or(DEFAULT_MANIFEST_CACHE_BYTES),
            ),
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

    /// Fails while the disk under a local store is below its reserve.
    fn check_space(&self) -> Result<()> {
        self.disk.as_ref().map_or(Ok(()), |disk| disk.check())
    }

    /// `Db::put`, returning once the value is durable.
    async fn db_put(&self, key: &[u8], value: Bytes) -> Result<()> {
        self.check_space()?;
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
        self.check_space()?;
        self.db.write(batch).await?.await_durable().await?;
        Ok(())
    }

    /// Write `batch` without waiting for it to be durable. Writes become
    /// durable in order, so a later [`commit`](Self::commit) returning
    /// means this one is durable too.
    pub(crate) async fn write_ahead(&self, batch: WriteBatch) -> Result<()> {
        self.check_space()?;
        self.db.write(batch).await?;
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
        self.cas_put_batch(blobs, Vec::new()).await
    }

    /// [`cas_put_blob_batch`](Self::cas_put_blob_batch), also recording
    /// `git_blobs` in the same write.
    #[instrument(skip_all, fields(count = blobs.len(), git_blobs = git_blobs.len()))]
    pub async fn cas_put_batch(
        &self,
        blobs: Vec<(ContentDigest, Bytes, Compression)>,
        git_blobs: Vec<GitBlobRecord>,
    ) -> Result<()> {
        if blobs.is_empty() && git_blobs.is_empty() {
            return Ok(());
        }
        let digests: Vec<ContentDigest> = blobs.iter().map(|(digest, _, _)| *digest).collect();
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

        let mut batch = batch_of(puts);
        for record in &git_blobs {
            let key = GitBlobRecord::key(record.digest.function, &record.git_id);
            batch.put_bytes(Bytes::copy_from_slice(&key), record.value());
        }
        self.commit_blobs(batch, digests).await
    }

    /// Store `blobs`, each already checked against its digest, in a single
    /// write: one wait for durability however many there are. Blobs already
    /// stored with at least half their TTL left are skipped. Returns how many
    /// were written.
    pub async fn cas_put_verified_blobs(
        &self,
        blobs: Vec<(ContentDigest, Bytes)>,
    ) -> Result<usize> {
        let mut seen = std::collections::HashSet::new();
        let blobs: Vec<_> = blobs
            .into_iter()
            .filter(|(digest, _)| seen.insert(*digest))
            .map(|(digest, data)| (digest, data, None))
            .collect();
        let count = blobs.len();
        Ok(count - self.cas_put_git_blobs(blobs).await?)
    }

    /// What `git_id` was stored as, if a durable, unexpired record says.
    /// Only a blob with at least half its TTL left counts.
    pub async fn git_blob(
        &self,
        digest_fn: DigestFn,
        git_id: &[u8; 20],
    ) -> Result<Option<GitBlobRecord>> {
        let key = GitBlobRecord::key(digest_fn, git_id);
        let Some((value, _)) = self.get_live(&key, &durable_read_options()).await? else {
            return Ok(None);
        };
        let record = GitBlobRecord::decode(*git_id, digest_fn, value)?;
        Ok(self.is_fresh(record.blob_expires_at_ms).then_some(record))
    }

    /// The earliest a blob written from now on can expire (ms since the
    /// epoch), or `None` without a TTL.
    fn new_blob_expiry(&self) -> Option<i64> {
        self.default_ttl_ms
            .map(|ttl| now_millis().saturating_add(ttl))
    }

    /// Whether something expiring at `expires_at_ms` (ms since the epoch;
    /// `None` never) has at least half its TTL left: fresh enough to skip
    /// writing it again (see [`cas_blob_fresh`](Self::cas_blob_fresh)).
    fn is_fresh(&self, expires_at_ms: Option<i64>) -> bool {
        match (expires_at_ms, self.refresh_window_ms) {
            (None, _) | (_, None) => true,
            (Some(expires_at), Some(window)) => expires_at - now_millis() >= window,
        }
    }

    /// Store `blobs`, each already checked against its digest, in a single
    /// write, leaving out those already stored with at least half their TTL
    /// left, and record the git blob each given a git id came from (see
    /// [`git_blob`](Self::git_blob)), expiring with it. Returns how many
    /// were left out.
    pub async fn cas_put_git_blobs(
        &self,
        blobs: Vec<(ContentDigest, Bytes, Option<[u8; 20]>)>,
    ) -> Result<usize> {
        // Taken before the write, so it can only understate the new expiry.
        let written_expiry = self.new_blob_expiry();
        let total = blobs.len();
        let digests = blobs.iter().map(|(digest, _, _)| *digest).collect();
        let expiries = self.cas_blob_expiries(digests).await?;
        let mut writes = Vec::with_capacity(blobs.len());
        let mut records = Vec::new();
        for ((digest, data, git_id), expiry) in blobs.into_iter().zip(expiries) {
            let size = data.len() as u64;
            let blob_expires_at_ms = match expiry.filter(|expires| self.is_fresh(*expires)) {
                Some(expires) => expires,
                None => {
                    writes.push((digest, data, Compression::Identity));
                    written_expiry
                }
            };
            if let Some(git_id) = git_id {
                records.push(GitBlobRecord {
                    git_id,
                    digest,
                    size,
                    blob_expires_at_ms,
                });
            }
        }
        let skipped = total - writes.len();
        self.cas_put_batch(writes, records).await?;
        Ok(skipped)
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
        self.commit_blobs(batch_of(puts), [*digest]).await
    }

    /// Reassemble a blob from its manifest and chunks.
    /// Decompresses chunks transparently based on compression recorded in manifest.
    #[instrument(skip(self), fields(%digest))]
    pub async fn cas_get_blob(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        let Some(read) = self.read_manifest(digest, ManifestSource::Cached).await? else {
            return Ok(None);
        };
        if !read.cached {
            return self.assemble_blob(digest, read).await;
        }
        match self.assemble_blob(digest, read).await {
            // The kept manifest may name chunks the store no longer has
            // (see `manifest_cache`), and is dropped: read the store's.
            Err(StoreError::ChunkMissing { .. }) => {
                let Some(read) = self.read_manifest(digest, ManifestSource::Store).await? else {
                    return Ok(None);
                };
                self.assemble_blob(digest, read).await
            }
            other => other,
        }
    }

    /// The blob `read` describes, its chunks read and checked.
    async fn assemble_blob(
        &self,
        digest: &ContentDigest,
        read: ManifestRead,
    ) -> Result<Option<Bytes>> {
        if let Some(data) = &read.manifest.inline {
            return Ok(Some(data.clone()));
        }
        let chunks = &read.manifest.chunks;
        if let [chunk] = chunks[..] {
            // The blob is its one chunk, checked against the blob's hash.
            return Ok(Some(self.read_chunk(digest, &read, chunk).await?));
        }

        let total_size: u64 = chunks
            .iter()
            .try_fold(0u64, |acc, c| acc.checked_add(c.size))
            .ok_or_else(|| StoreError::ManifestCorrupted("total blob size overflows u64".into()))?;
        if total_size > MAX_BLOB_REASSEMBLE_SIZE as u64 {
            return Err(StoreError::BlobTooLarge {
                size: total_size as usize,
                limit: MAX_BLOB_REASSEMBLE_SIZE,
            });
        }
        // Chunks are copied into a buffer of the blob's size as they arrive,
        // in order, up to 32 in flight, so that each chunk's raw and
        // decompressed data can be dropped before the next is read: peak
        // memory stays near the blob's size rather than twice it.
        let mut buf = BytesMut::with_capacity(total_size as usize);
        let mut hasher = IncrementalHasher::new(digest.function, total_size as usize);
        let read = &read;
        let mut stream = futures::stream::iter(chunks.clone())
            .map(|chunk| self.read_chunk(digest, read, chunk))
            .buffered(32);
        while let Some(data) = stream.next().await {
            let data = data?;
            hasher.update(&data);
            buf.put(data.as_ref());
        }
        let computed = hasher.finalize();
        if computed != digest.hash {
            return Err(StoreError::DigestMismatch {
                expected: hex::encode(digest.hash),
                actual: hex::encode(computed),
            });
        }
        Ok(Some(buf.freeze()))
    }

    /// `chunk` of `digest`'s blob as `read` describes it, decompressed and
    /// checked against its hash; for a blob stored in its manifest, its
    /// data. A chunk missing from the store is [`StoreError::ChunkMissing`],
    /// and drops a kept manifest that named it (see `manifest_cache`), so
    /// the next read takes the store's. A blob of one chunk is kept once
    /// read (see `small_blobs`).
    async fn read_chunk(
        &self,
        digest: &ContentDigest,
        read: &ManifestRead,
        chunk: ChunkInfo,
    ) -> Result<Bytes> {
        if let Some(data) = &read.manifest.inline {
            return Ok(data.clone());
        }
        let Some((compression, compressed)) = self
            .cas_get_raw_chunk(digest.function, &chunk.hash, Some(chunk.size))
            .await?
        else {
            warn!(chunk_hash = %hex::encode(chunk.hash), "chunk missing from store");
            if read.cached {
                self.forget_manifest(digest);
            }
            return Err(StoreError::ChunkMissing {
                hash: hex::encode(chunk.hash),
            });
        };
        let data = compression
            .decompress_with_size_hint_async(compressed, chunk.size as usize)
            .await?;
        if data.len() != chunk.size as usize {
            return Err(StoreError::ChunkSizeMismatch {
                expected: chunk.size,
                actual: data.len(),
            });
        }
        verify_digest(&ContentDigest::new(digest.function, chunk.hash), &data)
            .inspect_err(|e| warn!(%e, "chunk digest mismatch"))?;
        if read.manifest.chunks.len() == 1 {
            self.keep_small_blob(digest, &data, read);
        }
        Ok(data)
    }

    /// Stream a blob's decompressed chunks in order.
    ///
    /// Peak memory is O(max_chunk_size × `STREAM_PREFETCH_CHUNKS`) instead
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
        let Some(blob) = self.cas_blob_chunks(digest).await? else {
            return Ok(None);
        };
        let chunks = blob.chunks().to_vec();
        let blob = Arc::new(blob);
        let stream = futures::stream::iter(chunks)
            .map(move |chunk| {
                let blob = blob.clone();
                async move { self.cas_read_chunk(&blob, chunk).await }
            })
            .buffered(STREAM_PREFETCH_CHUNKS);
        Ok(Some(stream))
    }

    /// `digest`'s manifest, to read its blob a chunk at a time, or `None` if
    /// the blob is not stored.
    pub async fn cas_blob_chunks(&self, digest: &ContentDigest) -> Result<Option<BlobChunks>> {
        let read = self.read_manifest(digest, ManifestSource::Cached).await?;
        Ok(read.map(|read| BlobChunks {
            digest: *digest,
            read,
        }))
    }

    /// `chunk`, one of `blob`'s chunks, decompressed and checked against its
    /// hash. Unlike a whole read, a stream of chunks does not check the
    /// blob's hash: a caller that needs it hashes what it reads.
    pub async fn cas_read_chunk(&self, blob: &BlobChunks, chunk: ChunkInfo) -> Result<Bytes> {
        self.read_chunk(&blob.digest, &blob.read, chunk).await
    }

    /// Whether a blob is stored, durably and unexpired (by its manifest).
    // TODO(perf): SlateDB lacks contains_key; this fetches the full value
    pub async fn cas_blob_exists(&self, digest: &ContentDigest) -> Result<bool> {
        Ok(self.cas_blob_expiry(digest).await?.is_some())
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
        Ok(match self.cas_blob_expiry(digest).await? {
            None => false,
            Some(expires_at) => self.is_fresh(expires_at),
        })
    }

    /// The expiry of each of `digests`, as
    /// [`cas_blob_expiry`](Self::cas_blob_expiry) gives it.
    async fn cas_blob_expiries(
        &self,
        digests: Vec<ContentDigest>,
    ) -> Result<Vec<Option<Option<i64>>>> {
        // An owned list: a stream over a borrowing iterator trips rustc's
        // higher-ranked lifetime limits (rust#100013) in boxed RPC futures.
        futures::stream::iter(digests)
            .map(|digest| async move { self.cas_blob_expiry(&digest).await })
            .buffered(64)
            .try_collect()
            .await
    }

    /// `None` if the blob is not durably stored (or has expired), else when
    /// it expires (ms since the epoch; `None` never).
    async fn cas_blob_expiry(&self, digest: &ContentDigest) -> Result<Option<Option<i64>>> {
        if digest.is_empty_blob() {
            return Ok(Some(None));
        }
        let now = now_millis();
        if let Some(expires_at) = self.presence.get(digest, now) {
            return Ok(Some(expires_at));
        }
        let found = self.stored_blob_expiry(digest).await?;
        if let Some(expires_at) = found {
            self.presence.insert(*digest, expires_at, now);
        }
        Ok(found)
    }

    /// When `digest`'s blob expires as stored, read past the presence cache:
    /// the cache notes expiries by this process's clock, and the store sets
    /// them by SlateDB's, which may run a few milliseconds apart.
    async fn stored_blob_expiry(&self, digest: &ContentDigest) -> Result<Option<Option<i64>>> {
        if digest.is_empty_blob() {
            return Ok(Some(None));
        }
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        Ok(self
            .get_live(&key, &durable_read_options())
            .await?
            .map(|(_, expires_at)| expires_at))
    }

    /// [`commit`](Self::commit) `batch`, which stores the blobs `digests`,
    /// and note them stored (see `presence`): they expire no earlier than a
    /// TTL after the write began.
    pub(crate) async fn commit_blobs(
        &self,
        batch: WriteBatch,
        digests: impl IntoIterator<Item = ContentDigest>,
    ) -> Result<()> {
        let written_at = now_millis();
        self.commit(batch).await?;
        let expires_at = self
            .default_ttl_ms
            .map(|ttl| written_at.saturating_add(ttl));
        let now = now_millis();
        for digest in digests {
            self.presence.insert(digest, expires_at, now);
        }
        Ok(())
    }

    // -----------------------------------------------------------------------------------------------------------------
    // Chunk-level CAS API (for SplitBlob/SpliceBlob)
    // -----------------------------------------------------------------------------------------------------------------

    /// Get the manifest (chunk list) for a blob, along with its compression.
    ///
    /// A blob stored in its manifest comes with its data, checked against
    /// its digest, and is its own one chunk. Small blobs are kept once read
    /// (see `small_blobs`), and come back the same way, data and all, so
    /// reading one again skips the LSM.
    pub async fn cas_get_manifest(
        &self,
        digest: &ContentDigest,
    ) -> Result<Option<(BlobManifest, Compression)>> {
        Ok(self
            .read_manifest(digest, ManifestSource::Cached)
            .await?
            .map(|read| (read.manifest, read.compression)))
    }

    /// Note that a read of `digest`'s blob found one of its chunks missing,
    /// so that the next read takes its manifest from the store.
    fn forget_manifest(&self, digest: &ContentDigest) {
        if let Some(cache) = &self.manifests {
            cache.remove(digest);
        }
    }

    /// [`cas_get_manifest`](Self::cas_get_manifest), from `source`, with what
    /// keeping the blob, once its chunk is read, takes.
    async fn read_manifest(
        &self,
        digest: &ContentDigest,
        source: ManifestSource,
    ) -> Result<Option<ManifestRead>> {
        let now = now_millis();
        if digest.is_empty_blob() {
            // Always stored, as REAPI requires: a blob of no chunks.
            let manifest = BlobManifest {
                chunks: Vec::new(),
                created_at: 0,
                inline: None,
            };
            return Ok(Some(ManifestRead::new(
                manifest,
                Compression::Identity,
                None,
                now,
            )));
        }
        if source == ManifestSource::Cached {
            if let Some((manifest, compression)) =
                self.small_blobs.as_ref().and_then(|c| c.get(digest, now))
            {
                return Ok(Some(ManifestRead::new(manifest, compression, None, now)));
            }
            if let Some((manifest, compression, expires_at)) =
                self.manifests.as_ref().and_then(|c| c.get(digest, now))
            {
                let mut read = ManifestRead::new(manifest, compression, expires_at, now);
                read.cached = true;
                return Ok(Some(read));
            }
        }
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        let Some((data, expires_at)) = self.get_live(&key, &ReadOptions::default()).await? else {
            return Ok(None);
        };
        let (mut manifest, compression) = BlobManifest::from_bytes(data)?;
        if let Some(data) = &manifest.inline {
            verify_digest(digest, data)
                .inspect_err(|e| warn!(%digest, %e, "inline blob digest mismatch"))?;
            manifest.chunks = vec![ChunkInfo {
                hash: digest.hash,
                size: data.len() as u64,
            }];
        }
        let read = ManifestRead::new(manifest, compression, expires_at, now);
        if let Some(data) = &read.manifest.inline {
            self.keep_small_blob(digest, data, &read);
        } else if let Some(cache) = &self.manifests {
            cache.insert(*digest, &read.manifest, compression, expires_at, now);
        }
        Ok(Some(read))
    }

    /// Keep `data`, the blob `read` describes, verified, if it is small
    /// enough (see `small_blobs`).
    fn keep_small_blob(&self, digest: &ContentDigest, data: &Bytes, read: &ManifestRead) {
        if let Some(cache) = &self.small_blobs {
            cache.insert(
                *digest,
                data,
                read.compression,
                read.manifest.created_at,
                read.expires_at,
                read.read_at,
            );
        }
    }

    /// The manifest of `digest`'s blob, as [`cas_get_manifest`] gives it,
    /// with each of its chunks made a CAS blob in its own right: a SplitBlob
    /// answer promises a client can fetch the chunks it lacks by their
    /// digests. `None` if the blob is not stored.
    ///
    /// A chunk becomes a blob through a manifest naming the chunk already
    /// stored, expiring with the blob (whose chunks were written with it, so
    /// expire with it too): when the store says the blob does, not when the
    /// presence cache does, so the manifest never outlives the chunk. A blob past half its TTL, which FindMissingBlobs
    /// would already call missing, is first renewed, its chunks rewritten as
    /// an upload of it would rewrite them: SplitBlob extends the life of the
    /// blob it splits, and of its chunks. A chunk already stored as a fresh
    /// blob needs no manifest, nor does a blob that is its own one chunk.
    ///
    /// [`cas_get_manifest`]: Self::cas_get_manifest
    pub async fn cas_split_blob(&self, digest: &ContentDigest) -> Result<Option<BlobManifest>> {
        let Some(expires_at) = self.stored_blob_expiry(digest).await? else {
            return Ok(None);
        };
        // From the store, not the caches: the chunk manifests written below
        // must name the chunks the stored manifest does, which a kept one
        // (see `manifest_cache`) may not.
        let Some(read) = self.read_manifest(digest, ManifestSource::Store).await? else {
            return Ok(None);
        };
        let (manifest, compression) = (read.manifest, read.compression);
        let mut seen = std::collections::HashSet::new();
        let chunks: Vec<(ContentDigest, u64)> = manifest
            .chunks
            .iter()
            .map(|c| (ContentDigest::new(digest.function, c.hash), c.size))
            .filter(|(chunk, _)| chunk != digest && seen.insert(*chunk))
            .collect();
        let digests = chunks.iter().map(|(chunk, _)| *chunk).collect();
        let expiries = self.cas_blob_expiries(digests).await?;
        let unnamed: Vec<(ContentDigest, u64)> = chunks
            .into_iter()
            .zip(expiries)
            .filter(|(_, expiry)| !expiry.is_some_and(|expires| self.is_fresh(expires)))
            .map(|(chunk, _)| chunk)
            .collect();

        if !self.is_fresh(expires_at) {
            self.renew_split_blob(digest, &manifest, compression, &unnamed)
                .await?;
        } else if !unnamed.is_empty() {
            let with_blob = PutOptions {
                ttl: match expires_at {
                    Some(at) => Ttl::ExpireAtMillis(at),
                    None => Ttl::NoExpiry,
                },
            };
            let mut batch = WriteBatch::new();
            for (chunk, size) in &unnamed {
                let key = prefixed_key(PREFIX_MANIFEST, chunk.function, &chunk.hash);
                batch.put_bytes_with_options(
                    Bytes::copy_from_slice(&key),
                    one_chunk_manifest(chunk, *size)?,
                    &with_blob,
                );
            }
            self.commit(batch).await?;
            let now = now_millis();
            for (chunk, _) in unnamed {
                self.presence.insert(chunk, expires_at, now);
            }
        }
        Ok(Some(manifest))
    }

    /// Write `digest`'s blob again, as an upload of it would, along with
    /// manifests naming each of `unnamed` (its chunks not yet blobs) as a
    /// blob. The chunks are copied as stored, a few MiB at a time, and the
    /// manifests committed after them all.
    async fn renew_split_blob(
        &self,
        digest: &ContentDigest,
        manifest: &BlobManifest,
        compression: Compression,
        unnamed: &[(ContentDigest, u64)],
    ) -> Result<()> {
        if manifest.inline.is_none() {
            let mut seen = std::collections::HashSet::new();
            let hashes: Vec<[u8; 32]> = manifest
                .chunks
                .iter()
                .map(|c| c.hash)
                .filter(|hash| seen.insert(*hash))
                .collect();
            let digest_fn = digest.function;
            let mut stored = futures::stream::iter(hashes)
                .map(|hash| async move {
                    let key = prefixed_key(PREFIX_CHUNK, digest_fn, &hash);
                    let value = self
                        .db
                        .get_with_options(&key, &chunk_read_options())
                        .await?;
                    Ok::<_, StoreError>((
                        key,
                        value.ok_or_else(|| StoreError::ChunkMissing {
                            hash: hex::encode(hash),
                        })?,
                    ))
                })
                .buffered(STREAM_PREFETCH_CHUNKS);
            let mut batch = WriteBatch::new();
            let mut pending = 0;
            while let Some(chunk) = stored.next().await {
                let (key, value) = chunk?;
                pending += value.len();
                batch.put_bytes(Bytes::copy_from_slice(&key), value);
                if pending >= writer::WRITE_AHEAD_BYTES {
                    self.write_ahead(std::mem::take(&mut batch)).await?;
                    pending = 0;
                }
            }
            self.write_ahead(batch).await?;
        }

        // Durable in order: once the manifests are, so are the chunks.
        let mut batch = WriteBatch::new();
        let key = prefixed_key(PREFIX_MANIFEST, digest.function, &digest.hash);
        batch.put_bytes(
            Bytes::copy_from_slice(&key),
            manifest.to_bytes(compression)?,
        );
        for (chunk, size) in unnamed {
            let key = prefixed_key(PREFIX_MANIFEST, chunk.function, &chunk.hash);
            batch.put_bytes(
                Bytes::copy_from_slice(&key),
                one_chunk_manifest(chunk, *size)?,
            );
        }
        let stored = std::iter::once(*digest).chain(unnamed.iter().map(|(chunk, _)| *chunk));
        self.commit_blobs(batch, stored).await
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
        let mut batch = WriteBatch::new();
        batch.put_bytes(
            Bytes::copy_from_slice(&key),
            manifest.to_bytes(compression)?,
        );
        self.commit_blobs(batch, [*digest]).await
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
            inline: None,
        };
        let manifest_key = prefixed_key(PREFIX_MANIFEST, digest_fn, &blob_digest.hash);
        batch.put_bytes(
            Bytes::copy_from_slice(&manifest_key),
            manifest.to_bytes(compression)?,
        );
        self.commit_blobs(batch, [*blob_digest]).await
    }

    /// Fetch a raw chunk without decompression, returning its compression tag.
    ///
    /// A chunk known to be small (`size`) is read through the block cache:
    /// see [`CACHED_CHUNK_BYTES`].
    async fn cas_get_raw_chunk(
        &self,
        digest_fn: DigestFn,
        hash: &[u8; 32],
        size: Option<u64>,
    ) -> Result<Option<(Compression, Bytes)>> {
        let key = prefixed_key(PREFIX_CHUNK, digest_fn, hash);
        let options = match size {
            Some(size) if size <= CACHED_CHUNK_BYTES => ReadOptions::default(),
            _ => chunk_read_options(),
        };
        match self.db.get_with_options(&key, &options).await? {
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
    ///
    /// The chunks a client names (SpliceBlob) are CAS blobs, which need not
    /// be stored as one chunk under their own hash: a small one is stored
    /// in its manifest, and a large one is split. Without a chunk under the
    /// digest, this reads the blob of that digest.
    pub async fn cas_get_chunk(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        match self
            .cas_get_raw_chunk(digest.function, &digest.hash, None)
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
            None => self.cas_get_blob(digest).await,
        }
    }

    /// Check if a chunk exists: [`cas_get_chunk`](Self::cas_get_chunk)
    /// would find it, as a chunk or as a blob.
    // TODO(perf): SlateDB lacks contains_key; this fetches the full value
    pub async fn cas_chunk_exists(&self, digest: &ContentDigest) -> Result<bool> {
        let key = prefixed_key(PREFIX_CHUNK, digest.function, &digest.hash);
        let result = self
            .db
            .get_with_options(&key, &chunk_read_options())
            .await?;
        Ok(result.is_some() || self.cas_blob_exists(digest).await?)
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
        let written = self.db_put(&key, data).await;
        // Whether or not the write went through, what was kept of the entry
        // may no longer be what the store holds.
        if let Some(cache) = &self.action_results {
            cache.invalidate(digest);
        }
        written
    }

    /// Fetch an action cache entry. Entries read are kept (see
    /// `action_results`), so reading one again skips the LSM.
    #[instrument(skip(self), fields(%digest))]
    pub async fn ac_get(&self, digest: &ContentDigest) -> Result<Option<Bytes>> {
        let key = prefixed_key(PREFIX_ACTION, digest.function, &digest.hash);
        let Some(cache) = &self.action_results else {
            return Ok(self
                .get_live(&key, &ReadOptions::default())
                .await?
                .map(|(data, _)| data));
        };
        let now = now_millis();
        if let Some(data) = cache.get(digest, now) {
            return Ok(Some(data));
        }
        let start = cache.read_start(digest);
        let Some((data, expires_at)) = self.get_live(&key, &ReadOptions::default()).await? else {
            return Ok(None);
        };
        cache.insert(*digest, start, data.clone(), expires_at, now);
        Ok(Some(data))
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

/// The manifest of a blob that is one chunk, `chunk` of `size` bytes, stored
/// under its own hash.
fn one_chunk_manifest(chunk: &ContentDigest, size: u64) -> Result<Bytes> {
    BlobManifest {
        chunks: vec![ChunkInfo {
            hash: chunk.hash,
            size,
        }],
        created_at: unix_now_secs(),
        inline: None,
    }
    .to_bytes(Compression::Identity)
}

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
/// (one for a small blob, FastCDC-split otherwise), then its manifest; or
/// for a blob of at most [`INLINE_BLOB_MAX`], a manifest holding it.
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
    let manifest_key = prefixed_key(PREFIX_MANIFEST, digest_fn, &digest.hash);
    if !data.is_empty() && data.len() <= INLINE_BLOB_MAX {
        let manifest = BlobManifest::inline(digest.hash, data.clone());
        return Ok(vec![(manifest_key, manifest.to_bytes(compression)?)]);
    }
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
        inline: None,
    };
    for (info, key, value) in chunks {
        manifest.chunks.push(info);
        puts.push((key, value));
    }
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
#[cfg(test_module_properties)]
mod test_properties;
#[cfg(test_module_streaming)]
mod test_streaming;
#[cfg(test_module_tuning)]
mod test_tuning;
