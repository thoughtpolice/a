// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Fetched files are made durable before they are named in the cache, so
//! a power loss never leaves a torn file that `copy_to` would hand out.

use crate::test_support::*;
use crate::{Options, Recovery};

/// Fetch a blob and lose power, keeping every name but zeroing unsynced
/// data. Returns what was on disk then, what the reopened cache hands out
/// for it, if anything, and what reopening found.
fn fetched_then_crashed(durable: bool) -> (Vec<u8>, Option<Vec<u8>>, Recovery) {
    let fs = sim();
    let blobs = SimBlobs::new(&fs);
    let digest = blobs.put(b"a fetched file");
    let options = Options {
        durable,
        ..Options::new(1000)
    };
    let cache = open(&fs, options.clone()).unwrap();
    let pinned = runtime().block_on(cache.fetch(&blobs, SHA256, &[digest]));
    drop(pinned.unwrap());
    let path = cache.path(SHA256, &digest);
    drop(cache);
    fs.crash(&mut keep_names_zero_data);
    let on_disk = fs.read(&path).unwrap();
    let cache = open(&fs, options).unwrap();
    let served = copy_out(&cache, &fs, SHA256, &digest).ok();
    (on_disk, served, cache.recovery().clone())
}

#[test]
fn a_fetched_file_survives_a_power_loss_whole() {
    let (on_disk, served, recovery) = fetched_then_crashed(true);
    assert_eq!(on_disk, b"a fetched file");
    assert_eq!(served.as_deref(), Some(&b"a fetched file"[..]));
    assert!(recovery.unclean);
    assert_eq!(recovery.dropped, []);
}

/// Without durability the same crash tears the file, which shows the
/// test above can fail; opening again finds it torn and removes it.
#[test]
fn without_durability_the_same_power_loss_tears_it() {
    let (on_disk, served, recovery) = fetched_then_crashed(false);
    assert_eq!(on_disk, [0; 14]);
    assert_eq!(served, None);
    assert_eq!(recovery.dropped.len(), 1);
}

#[test]
fn fetched_files_are_synced_only_with_durability() {
    for durable in [true, false] {
        let fs = sim();
        let blobs = SimBlobs::new(&fs);
        let digests = [blobs.put(b"one"), blobs.put(b"two"), blobs.put(b"three")];
        let options = Options {
            durable,
            ..Options::new(1000)
        };
        let cache = open(&fs, options).unwrap();
        let before = fs.stats().sync_data;
        drop(
            runtime()
                .block_on(cache.fetch(&blobs, SHA256, &digests))
                .unwrap(),
        );
        let synced = fs.stats().sync_data - before;
        assert_eq!(synced, if durable { 3 } else { 0 });
        for digest in &digests {
            assert!(copy_out(&cache, &fs, SHA256, digest).is_ok());
        }
    }
}

#[test]
fn a_failed_seal_keeps_nothing() {
    let fs = sim();
    let blobs = SimBlobs::new(&fs);
    let digest = blobs.put(b"never kept");
    let cache = open(&fs, Options::new(1000)).unwrap();
    // The fetch writes the file (two calls), then the seal opens it, sets
    // its mode and syncs it: crash at the sync.
    fs.crash_after(4);
    let result = runtime().block_on(cache.fetch(&blobs, SHA256, &[digest]));
    assert!(result.is_err());
    assert!(fs.crashed());
    drop(cache);
    fs.crash(&mut |n| n - 1);
    let cache = open(&fs, Options::new(1000)).unwrap();
    assert!(copy_out(&cache, &fs, SHA256, &digest).is_err());
}
