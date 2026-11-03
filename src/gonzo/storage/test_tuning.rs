// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! The SlateDB settings the store opens with: gonzo's environment prefix,
//! and the settings that reach SlateDB. The tuning itself is
//! slatedb-utils', and tested there.

use super::*;

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

/// The write buffer size reaches SlateDB, which refuses one no larger than
/// an L0 SST.
#[tokio::test]
async fn the_write_buffer_reaches_slatedb() {
    let open = |bytes| {
        CacheStore::open(
            StoreBackend::Memory,
            CacheStoreSettings {
                write_buffer_bytes: Some(bytes),
                ..Default::default()
            },
        )
    };
    let l0 = tuned_settings(&StoreBackend::Memory).l0_sst_size_bytes as u64;
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
    let mut never_flush = tuned_settings(&StoreBackend::Memory);
    never_flush.flush_interval = Some(std::time::Duration::from_secs(3600));
    let store = CacheStore::open(
        StoreBackend::Memory,
        CacheStoreSettings {
            slatedb_overrides: Some(never_flush),
            ..Default::default()
        },
    )
    .await
    .expect("open");

    // The flush ticker's first tick fires as the database opens, and may or
    // may not catch a write racing it. Let one write take that chance first.
    let put = |data: &'static [u8]| {
        let data = bytes::Bytes::from_static(data);
        let digest = ContentDigest::compute(DigestFn::Sha256, &data);
        let store = &store;
        async move {
            store
                .cas_put_blob(&digest, data, Compression::Identity)
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

/// Nested settings are reachable from the environment too, with a `.`
/// between the levels.
#[test]
fn environment_overrides_nested_settings() {
    let var = "GONZO_SLATEDB_COMPACTOR_OPTIONS.MAX_CONCURRENT_COMPACTIONS";
    // SAFETY: nothing else in this process reads or writes this variable.
    unsafe { std::env::set_var(var, "7") };
    let settings = settings_for(&StoreBackend::Memory);
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
        tuned_settings(&StoreBackend::Memory)
            .compactor_options
            .expect("compactor")
            .poll_interval
    );
}

/// Operators tune SlateDB through `GONZO_SLATEDB_*` without a
/// rebuild; anything unset keeps the derived value.
#[test]
fn environment_overrides_the_derived_settings() {
    let var = "GONZO_SLATEDB_L0_SST_SIZE_BYTES";
    // SAFETY: nothing else in this process reads or writes this variable
    // concurrently; stores opened meanwhile would only pick up a valid size.
    unsafe { std::env::set_var(var, (128 * 1024 * 1024).to_string()) };
    let settings = settings_for(&StoreBackend::Memory);
    // SAFETY: as above.
    unsafe { std::env::remove_var(var) };

    let settings = settings.expect("settings");
    assert_eq!(settings.l0_sst_size_bytes, 128 * 1024 * 1024);
    assert_eq!(settings.min_filter_keys, 1);
    assert_eq!(
        settings.flush_interval,
        tuned_settings(&StoreBackend::Memory).flush_interval
    );
}

/// A store whose data is already local has no use for a disk cache in front
/// of it; asking for one is not an error.
#[tokio::test]
async fn a_local_store_ignores_the_object_store_cache() {
    let dir = tempfile::tempdir().expect("temp dir");
    let store = CacheStore::open(
        StoreBackend::Memory,
        CacheStoreSettings {
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
    let data = bytes::Bytes::from_static(b"cached or not");
    let digest = ContentDigest::compute(DigestFn::Sha256, &data);
    store
        .cas_put_blob(&digest, data.clone(), Compression::Identity)
        .await
        .expect("put");
    assert_eq!(store.cas_get_blob(&digest).await.expect("get"), Some(data));
    store.close().await.expect("close");
}
