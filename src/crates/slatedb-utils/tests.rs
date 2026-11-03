// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The backend-derived SlateDB settings, and opening a database with them.

use std::time::Duration;

use bytes::Bytes;

use crate::settings::{from_env, tuned};
use crate::*;

fn s3() -> Backend {
    Backend::S3 {
        bucket: "b".into(),
        prefix: None,
    }
}

/// The whole point of the local profile: SlateDB's 100 ms WAL tick is a
/// per-write latency floor that only pays for itself in S3 PUT charges.
#[test]
fn local_backends_shorten_the_wal_flush_tick() {
    let stock = slatedb::config::Settings::default().flush_interval;
    assert_eq!(stock, Some(std::time::Duration::from_millis(100)));

    for backend in [Backend::Memory, Backend::LocalFs("/tmp/x".into())] {
        let tuned = tuned(&backend).flush_interval.expect("interval");
        assert!(
            tuned < std::time::Duration::from_millis(100),
            "{backend:?} should not inherit the S3 flush tick, got {tuned:?}"
        );
    }
}

/// S3 is the backend SlateDB's defaults were chosen for, so leave the write
/// pipeline alone there — a short tick would multiply PUT costs.
#[test]
fn s3_keeps_the_stock_write_pipeline() {
    let tuned = tuned(&s3());
    let stock = slatedb::config::Settings::default();
    assert_eq!(tuned.flush_interval, stock.flush_interval);
    assert_eq!(tuned.l0_sst_size_bytes, stock.l0_sst_size_bytes);
    assert_eq!(tuned.max_unflushed_bytes, stock.max_unflushed_bytes);
}

/// `object_store`'s LocalFileSystem has no `PutMode::Update`, so the two
/// collectors that need a conditional put fail on every pass forever. They stay
/// off there and on everywhere else.
#[test]
fn cas_dependent_collectors_are_off_only_on_local_fs() {
    let local = tuned(&Backend::LocalFs("/tmp/x".into()));
    let gc = local.garbage_collector_options.expect("gc options");
    assert!(gc.manifest_options.is_none(), "manifest GC needs CAS");
    assert!(gc.compactions_options.is_none(), "compactions GC needs CAS");
    // These need no CAS and reclaim the bulk of the space, so they keep running.
    assert!(gc.wal_options.is_some());
    assert!(gc.compacted_options.is_some());

    let remote = tuned(&s3()).garbage_collector_options.expect("gc");
    assert!(remote.manifest_options.is_some());
    assert!(remote.compactions_options.is_some());
}

/// WAL fence collection ships dry-run, so it only ever logs a paragraph saying
/// it did nothing. Off everywhere.
#[test]
fn wal_fence_collection_is_off() {
    for backend in [Backend::Memory, Backend::LocalFs("/tmp/x".into()), s3()] {
        let gc = tuned(&backend)
            .garbage_collector_options
            .expect("gc options");
        assert!(gc.wal_fence_options.is_none(), "{backend:?}");
    }
}

/// The tuning is a default, not a mandate: an explicit override still wins.
#[tokio::test]
async fn overrides_replace_the_derived_settings() {
    let mut custom = slatedb::config::Settings::default();
    custom.flush_interval = Some(std::time::Duration::from_millis(37));

    let options = OpenOptions {
        settings: Some(custom),
        ..Default::default()
    };
    let settings = options
        .resolve_settings(&Backend::Memory)
        .expect("settings");
    assert_eq!(settings.flush_interval, Some(Duration::from_millis(37)));
    let db = open("db", &Backend::Memory, options).await.expect("open");
    db.close().await.expect("close");
}

/// The write buffer size reaches SlateDB, which refuses one no larger than
/// an L0 SST.
#[tokio::test]
async fn the_write_buffer_reaches_slatedb() {
    let open = |bytes| {
        open(
            "db",
            &Backend::Memory,
            OpenOptions {
                write_buffer_bytes: Some(bytes),
                ..Default::default()
            },
        )
    };
    let l0 = tuned(&Backend::Memory).l0_sst_size_bytes as u64;
    let err = open(l0)
        .await
        .expect_err("a buffer no larger than an L0 SST");
    assert!(err.to_string().contains("max_unflushed_bytes"), "{err}");
    open(l0 + 1)
        .await
        .expect("open")
        .close()
        .await
        .expect("close");
}

/// A write is acknowledged only once it is durable: with the WAL flush tick
/// an hour away, a put has nothing to make it durable and must still be
/// waiting, where SlateDB on its own would have answered at once.
#[tokio::test]
async fn writes_are_acknowledged_only_once_durable() {
    let mut never_flush = tuned(&Backend::Memory);
    never_flush.flush_interval = Some(std::time::Duration::from_secs(3600));
    let db = open(
        "db",
        &Backend::Memory,
        OpenOptions {
            settings: Some(never_flush),
            ..Default::default()
        },
    )
    .await
    .expect("open");

    // The flush ticker's first tick fires as the database opens, and may or
    // may not catch a write racing it. Let one write take that chance first.
    let put = |key: &'static [u8]| {
        let db = &db;
        async move {
            db.put(Bytes::from_static(key), Bytes::from_static(b"value"))
                .await
        }
    };
    let wait = std::time::Duration::from_millis(300);
    let _ = tokio::time::timeout(wait, put(b"warm-up")).await;

    let outcome = tokio::time::timeout(wait, put(b"not yet durable")).await;
    assert!(
        outcome.is_err(),
        "the put returned before anything made it durable: {outcome:?}"
    );
}

/// Keys are random hashes and SSTs hold few of them, so the stock 1000-key
/// floor would leave most SSTs without the bloom filter a miss needs.
#[test]
fn every_sst_gets_a_bloom_filter() {
    for backend in [Backend::Memory, Backend::LocalFs("/tmp/x".into()), s3()] {
        assert_eq!(tuned(&backend).min_filter_keys, 1, "{backend:?}");
    }
}

/// SlateDB requires the compaction worker's filter threshold to match the
/// writer's; left at its stock 1000, every compacted SST (all of the store
/// but the newest few hundred MiB) would lose its filter.
#[test]
fn compacted_ssts_keep_their_bloom_filters() {
    for backend in [Backend::Memory, Backend::LocalFs("/tmp/x".into()), s3()] {
        let settings = tuned(&backend);
        let compactor = settings.compactor_options.expect("compactor");
        let worker = compactor.worker.expect("embedded worker");
        assert_eq!(
            worker.min_filter_keys, settings.min_filter_keys,
            "{backend:?}"
        );
    }
}

/// A full L0 stops every flush, and so (once the memtables back up) every
/// write, until a compaction drains it. Stock polling found the work up to
/// 5 s late and claimed it up to 5 s after that, for a compaction that
/// takes well under a second.
#[test]
fn compactions_start_promptly() {
    for (backend, most) in [
        (Backend::Memory, 100),
        (Backend::LocalFs("/tmp/x".into()), 100),
        (s3(), 1000),
    ] {
        let settings = tuned(&backend);
        let most = std::time::Duration::from_millis(most);
        let compactor = settings.compactor_options.expect("compactor");
        assert!(compactor.poll_interval <= most, "{backend:?}");
        let worker = compactor.worker.expect("embedded worker");
        assert!(worker.compactions_poll_interval <= most, "{backend:?}");
        assert!(settings.l0_max_ssts >= 16, "{backend:?}");
        // With random keys every L0 SST covers every key, so the per-key
        // limit binds at the same count.
        assert!(
            settings.l0_max_ssts_per_key >= settings.l0_max_ssts,
            "{backend:?}"
        );
    }
}

/// Compactions merge many runs at once, so data is rewritten fewer times.
#[test]
fn compactions_merge_wide() {
    for backend in [Backend::Memory, Backend::LocalFs("/tmp/x".into()), s3()] {
        let compactor = tuned(&backend).compactor_options.expect("compactor");
        let option =
            |name: &str| -> usize { compactor.scheduler_options[name].parse().expect("a count") };
        assert!(option("min_compaction_sources") >= 8, "{backend:?}");
        assert!(option("max_compaction_sources") >= 32, "{backend:?}");
    }
}

/// Nested settings are reachable from the environment too, with a `.`
/// between the levels.
#[test]
fn environment_overrides_nested_settings() {
    let var = "SLATEDB_UTILS_TEST_COMPACTOR_OPTIONS.MAX_CONCURRENT_COMPACTIONS";
    // SAFETY: nothing else in this process reads or writes this variable.
    unsafe { std::env::set_var(var, "7") };
    let settings = from_env("SLATEDB_UTILS_TEST_", &Backend::Memory);
    // SAFETY: as above.
    unsafe { std::env::remove_var(var) };

    let compactor = settings
        .expect("settings")
        .compactor_options
        .expect("compactor");
    assert_eq!(compactor.max_concurrent_compactions, 7);
    // The rest of the derived compactor settings survive the merge.
    assert_eq!(
        compactor.poll_interval,
        tuned(&Backend::Memory)
            .compactor_options
            .expect("compactor")
            .poll_interval
    );
}

/// Operators tune SlateDB through the environment without a rebuild;
/// anything unset keeps the derived value.
#[test]
fn environment_overrides_the_derived_settings() {
    let var = "SLATEDB_UTILS_TEST_L0_SST_SIZE_BYTES";
    // SAFETY: nothing else in this process reads or writes this variable
    // concurrently; stores opened meanwhile would only pick up a valid size.
    unsafe { std::env::set_var(var, (128 * 1024 * 1024).to_string()) };
    let settings = from_env("SLATEDB_UTILS_TEST_", &Backend::Memory);
    // SAFETY: as above.
    unsafe { std::env::remove_var(var) };

    let settings = settings.expect("settings");
    assert_eq!(settings.l0_sst_size_bytes, 128 * 1024 * 1024);
    assert_eq!(settings.min_filter_keys, 1);
    assert_eq!(
        settings.flush_interval,
        tuned(&Backend::Memory).flush_interval
    );
}

/// A store whose data is already local has no use for a disk cache in front
/// of it; asking for one is not an error.
#[tokio::test]
async fn a_local_store_ignores_the_object_store_cache() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = open(
        "db",
        &Backend::Memory,
        OpenOptions {
            object_store_cache: Some(ObjectStoreCache {
                dir: dir.path().to_path_buf(),
                max_bytes: None,
            }),
            block_cache_bytes: Some(1024 * 1024),
            meta_cache_bytes: Some(1024 * 1024),
            ..Default::default()
        },
    )
    .await
    .expect("open");
    db.put(
        Bytes::from_static(b"key"),
        Bytes::from_static(b"cached or not"),
    )
    .await
    .expect("put");
    let read = db.get_live(b"key", &durable_reads()).await.expect("get");
    assert_eq!(
        read.map(|(value, _)| value),
        Some(Bytes::from_static(b"cached or not"))
    );
    db.close().await.expect("close");
}

/// Replaced SSTs are pinned for 15 minutes by SlateDB itself; they should
/// be pinned briefly, collection should follow soon after rather than up to
/// 10 minutes later, and flushed WAL should not linger at all.
#[test]
fn garbage_is_collected_promptly() {
    let minute = std::time::Duration::from_secs(60);
    for backend in [Backend::Memory, Backend::LocalFs("/tmp/x".into()), s3()] {
        let gc = tuned(&backend).garbage_collector_options.expect("gc");
        let wal = gc.wal_options.expect("wal gc");
        assert!(wal.interval.expect("interval") <= minute, "{backend:?}");
        assert!(wal.min_age <= minute, "{backend:?}");
        let compacted = gc.compacted_options.expect("compacted gc");
        assert!(
            compacted.interval.expect("interval") <= minute,
            "{backend:?}"
        );
        assert!(compacted.min_age <= minute, "{backend:?}");
        let compactor = tuned(&backend).compactor_options.expect("compactor");
        assert!(compactor.checkpoint_lifetime <= minute, "{backend:?}");
    }
}

/// Values past their expiry read as absent, though SlateDB still holds
/// them until compaction.
#[tokio::test]
async fn expired_values_read_as_absent() {
    let db = open(
        "db",
        &Backend::Memory,
        OpenOptions {
            default_ttl: Some(Duration::from_millis(50)),
            ..Default::default()
        },
    )
    .await
    .expect("open");
    db.put(Bytes::from_static(b"key"), Bytes::from_static(b"value"))
        .await
        .expect("put");
    let (_, expires) = db
        .get_live(b"key", &durable_reads())
        .await
        .expect("get")
        .expect("live");
    assert!(expires.is_some_and(|at| at > now_millis()));
    tokio::time::sleep(Duration::from_millis(100)).await;
    assert_eq!(
        db.get_live(b"key", &durable_reads()).await.expect("get"),
        None
    );
    db.close().await.expect("close");
}

/// A write the gate refuses never reaches SlateDB.
#[tokio::test]
async fn refused_writes_are_not_written() {
    let dir = tempfile::tempdir().expect("temp dir");
    let db = open(
        "db",
        &Backend::LocalFs(dir.path().to_path_buf()),
        OpenOptions {
            disk_reserve_bytes: Some(u64::MAX),
            ..Default::default()
        },
    )
    .await
    .expect("open");
    let refused = db
        .put(Bytes::from_static(b"key"), Bytes::from_static(b"value"))
        .await
        .expect_err("no disk has that much free");
    assert!(
        matches!(
            refused,
            Error::Refused(write_admission::Refused::DiskFull { .. })
        ),
        "{refused}"
    );
    assert_eq!(db.db().get(b"key").await.expect("get"), None);
    db.close().await.expect("close");
}

/// Each first byte of key gets a segment of its own.
#[tokio::test]
async fn first_bytes_split_segments() {
    let db = open(
        "db",
        &Backend::Memory,
        OpenOptions {
            segment_extractor: Some(std::sync::Arc::new(segments::FirstByteSegments::new(
                "test.first-byte.v1",
            ))),
            block_cache_policy: Some(segments::flush_cache_policy(&[b'a', 0xff])),
            ..Default::default()
        },
    )
    .await
    .expect("open");
    for key in [&b"a1"[..], b"a2", b"b1", b"\xff"] {
        db.put(Bytes::copy_from_slice(key), Bytes::from_static(b"v"))
            .await
            .expect("put");
    }
    let mut prefixes: Vec<Bytes> = db
        .db()
        .status()
        .list_segments()
        .into_iter()
        .map(|segment| segment.prefix)
        .collect();
    prefixes.sort();
    assert_eq!(prefixes, [&b"a"[..], b"b", b"\xff"]);
    db.close().await.expect("close");
}
