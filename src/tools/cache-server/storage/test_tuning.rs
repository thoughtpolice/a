// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The backend-derived SlateDB settings.

use super::*;

fn s3() -> StoreBackend {
    StoreBackend::S3 {
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

    for backend in [StoreBackend::Memory, StoreBackend::LocalFs("/tmp/x".into())] {
        let tuned = tuned_settings(&backend).flush_interval.expect("interval");
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
    let tuned = tuned_settings(&s3());
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
    let local = tuned_settings(&StoreBackend::LocalFs("/tmp/x".into()));
    let gc = local.garbage_collector_options.expect("gc options");
    assert!(gc.manifest_options.is_none(), "manifest GC needs CAS");
    assert!(gc.compactions_options.is_none(), "compactions GC needs CAS");
    // These need no CAS and reclaim the bulk of the space, so they keep running.
    assert!(gc.wal_options.is_some());
    assert!(gc.compacted_options.is_some());

    let remote = tuned_settings(&s3()).garbage_collector_options.expect("gc");
    assert!(remote.manifest_options.is_some());
    assert!(remote.compactions_options.is_some());
}

/// WAL fence collection ships dry-run, so it only ever logs a paragraph saying
/// it did nothing. Off everywhere.
#[test]
fn wal_fence_collection_is_off() {
    for backend in [
        StoreBackend::Memory,
        StoreBackend::LocalFs("/tmp/x".into()),
        s3(),
    ] {
        let gc = tuned_settings(&backend)
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

    let store = CacheStore::open(
        StoreBackend::Memory,
        CacheStoreSettings {
            slatedb_overrides: Some(custom),
            ..Default::default()
        },
    )
    .await
    .expect("open");
    store.close().await.expect("close");
}
