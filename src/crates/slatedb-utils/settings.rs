// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! SlateDB settings derived from where the database lives, and overridden
//! from the environment.

use slatedb::config::Settings;

use crate::Backend;

/// SlateDB settings for `backend`, tuned for a write-heavy store answering
/// point lookups of random keys (content hashes), whose writers wait for
/// durability and which nothing reads by tailing its WAL.
///
/// SlateDB ships defaults tuned for S3, where a flush is a billable, ~100 ms
/// round trip. Two of those trades invert on a loopback store, so adjust them
/// rather than leaving the operator to discover the defaults the hard way.
/// The rest follow from the workload, and the measurements quoted are
/// gonzo's: a cache of build outputs, chunked into values of up to 2 MiB.
pub fn tuned(backend: &Backend) -> Settings {
    let mut settings = Settings::default();

    if backend.writes_land_locally() {
        // `flush_interval` is a WAL flush *tick*, and a write is not
        // acknowledged until the next one makes it durable (see
        // `DurableDb::commit`) —
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
    // 64 MiB SST of ~2 MiB values holds a few dozen, so stock
    // SSTs mostly go without, and since keys are random hashes, every SST's
    // key range covers every lookup: a miss (FindMissingBlobs on a new
    // key, say) then reads an index and a data block from every L0 SST and
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
        let poll = if backend.writes_land_locally() {
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
        // takes milliseconds, even against S3, so half a minute is ample;
        // uploading 40 GB to a local store with two minutes peaked at 220 GB
        // on disk, with half a minute at 140 GB.
        compactor.checkpoint_lifetime = std::time::Duration::from_secs(30);
        if let Some(worker) = compactor.worker.as_mut() {
            worker.compactions_poll_interval = poll;
            // SlateDB requires the worker's filter threshold to match the
            // writer's; otherwise compacted SSTs drop their filters.
            worker.min_filter_keys = settings.min_filter_keys;
        }
        // Size-tiered compaction merges 4 to 8 similar runs at a time by
        // default, so a byte is rewritten about log4(store / L0 SST) times:
        // with the WAL and the L0 flush, uploading 40 GB wrote 5.5 bytes to
        // disk per byte uploaded, and a store's upload rate is its disk's
        // write rate divided by that. Merging 8 to 32 at a time wrote 4.6,
        // and took uploads about a quarter faster. The cost is more sorted
        // runs, and a lookup checks each one's bloom filter, which the meta
        // cache holds.
        compactor
            .scheduler_options
            .insert("min_compaction_sources".into(), "8".into());
        compactor
            .scheduler_options
            .insert("max_compaction_sources".into(), "32".into());
    }

    if let Some(gc) = settings.garbage_collector_options.as_mut() {
        // Collection of replaced SSTs runs only every 10 minutes by default,
        // on top of the compactor's checkpoint lifetime (above) and the
        // 5-minute minimum age it keeps any SST for: under a stream of
        // uploads, replaced data waited up to 25 minutes to go, and was most
        // of the disk in use. Collect every half minute instead, as soon as
        // the checkpoint lets go. The minimum age is not what keeps a
        // compaction's or a flush's output safe before the manifest names
        // it: collection spares SSTs newer than the oldest compaction under
        // way and the newest L0 SST regardless. Flushed WAL is pinned by
        // nothing (this store has no readers tailing it), so it goes after a
        // minute, not five.
        let minute = std::time::Duration::from_secs(60);
        let half_minute = std::time::Duration::from_secs(30);
        if let Some(wal) = gc.wal_options.as_mut() {
            wal.interval = Some(minute);
            wal.min_age = minute;
        }
        if let Some(compacted) = gc.compacted_options.as_mut() {
            compacted.interval = Some(half_minute);
            compacted.min_age = half_minute;
        }

        // WAL fence collection ships dry-run, so it deletes nothing and logs a
        // paragraph explaining that it deleted nothing on every pass. Off is
        // what dry-run already means, minus the noise. Enabling it for real
        // risks data loss (see `wal_fence_options`), so off is also the safe
        // reading of the default.
        gc.wal_fence_options = None;

        if matches!(backend, Backend::LocalFs(_)) {
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

/// [`tuned`] settings for `backend`, overridden by any environment
/// variables starting with `prefix`: `{prefix}L0_SST_SIZE_BYTES=134217728`,
/// say, or with a `.` for a nested setting,
/// `{prefix}COMPACTOR_OPTIONS.MAX_CONCURRENT_COMPACTIONS=8`. Durations are
/// strings such as `100ms`.
pub fn from_env(prefix: &str, backend: &Backend) -> Result<Settings, slatedb::Error> {
    Settings::from_env_with_default(prefix, tuned(backend))
}
