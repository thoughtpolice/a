// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Opening after an unclean stop checks what the last run may have torn,
//! and closing cleanly lets the next run check nothing.

use std::io::Write as _;
use std::path::Path;

use futures::FutureExt as _;
use reapi_cas::Digest;

use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::test_support::*;
use crate::{FileCache, Held, Options};

const BUILD: &str = "/builds";

fn options(durable: bool) -> Options {
    Options {
        durable,
        ..Options::new(1000)
    }
}

fn setup(durable: bool) -> (SimFs, FileCache<SimFs>) {
    let fs = sim();
    fs.create_dir(Path::new(BUILD)).unwrap();
    let cache = open(&fs, options(durable)).unwrap();
    (fs, cache)
}

fn ingest(fs: &SimFs, cache: &FileCache<SimFs>, data: &[u8]) -> Digest {
    let digest = SHA256.digest(data);
    let path = Path::new(BUILD).join(digest.hex());
    fs.create_new(&path).unwrap().write_all(data).unwrap();
    runtime()
        .block_on(cache.ingest(SHA256, &digest, &path))
        .unwrap();
    digest
}

fn fetch(fs: &SimFs, cache: &FileCache<SimFs>, data: &[u8]) -> Digest {
    let blobs = SimBlobs::new(fs);
    let digest = blobs.put(data);
    drop(
        runtime()
            .block_on(cache.fetch(&blobs, SHA256, &[digest]))
            .unwrap(),
    );
    digest
}

/// Where the cache keeps the dirty file with `digest`.
fn dirty_path(fs: &SimFs, digest: &Digest) -> std::path::PathBuf {
    let dirty = Path::new(STORE).join("dirty");
    let entry = fs
        .read_dir(&dirty)
        .unwrap()
        .into_iter()
        .find(|e| e.name.to_str().unwrap().contains(&digest.hex()))
        .unwrap();
    dirty.join(entry.name)
}

#[test]
fn a_closed_cache_needs_no_checking() {
    let (fs, cache) = setup(true);
    ingest(&fs, &cache, b"dirty");
    fetch(&fs, &cache, b"clean");
    runtime().block_on(cache.close()).unwrap();
    drop(cache);
    let cache = open(&fs, options(true)).unwrap();
    assert!(!cache.recovery().unclean);
    assert_eq!(cache.recovery().rehashed, 0);
    // The run after that has to close again to say so.
    drop(cache);
    assert!(open(&fs, options(true)).unwrap().recovery().unclean);
}

#[test]
fn after_an_unclean_durable_run_only_dirty_files_are_checked() {
    let (fs, cache) = setup(true);
    ingest(&fs, &cache, b"one");
    ingest(&fs, &cache, b"two");
    fetch(&fs, &cache, b"clean");
    drop(cache);
    let cache = open(&fs, options(true)).unwrap();
    assert!(cache.recovery().unclean);
    assert_eq!(cache.recovery().rehashed, 2);
    assert_eq!(cache.recovery().dropped, []);
}

#[test]
fn after_an_unclean_run_without_durability_everything_is_checked() {
    let (fs, cache) = setup(false);
    ingest(&fs, &cache, b"one");
    fetch(&fs, &cache, b"clean");
    drop(cache);
    // Whatever this run's own durability.
    let cache = open(&fs, options(true)).unwrap();
    assert_eq!(cache.recovery().rehashed, 2);
}

#[test]
fn a_cache_without_a_state_is_checked_in_full() {
    let fs = sim();
    let digest = SHA256.digest(b"from before");
    let cache = open(&fs, options(true)).unwrap();
    let path = cache.path(SHA256, &digest);
    drop(cache);
    fs.remove_file(&Path::new(STORE).join("state")).unwrap();
    fs.create_dir(path.parent().unwrap().parent().unwrap())
        .unwrap();
    fs.create_dir(path.parent().unwrap()).unwrap();
    fs.write(&path, b"from bef0re").unwrap();
    let cache = open(&fs, options(true)).unwrap();
    assert_eq!(cache.recovery().dropped, [(SHA256, digest, Held::Clean)]);
    assert_eq!(cache.has(SHA256, &digest), None);
}

#[test]
fn files_that_are_not_their_blobs_are_removed_and_reported() {
    let (fs, cache) = setup(true);
    let changed = ingest(&fs, &cache, b"changed");
    let cut = ingest(&fs, &cache, b"cut short");
    let kept = ingest(&fs, &cache, b"kept");
    drop(cache);
    fs.write(&dirty_path(&fs, &changed), b"chanGed").unwrap();
    fs.write(&dirty_path(&fs, &cut), b"cut").unwrap();
    let cache = open(&fs, options(true)).unwrap();
    let mut dropped = cache.recovery().dropped.clone();
    dropped.sort_by_key(|(_, digest, _)| digest.size);
    assert_eq!(
        dropped,
        [(SHA256, changed, Held::Dirty), (SHA256, cut, Held::Dirty)]
    );
    assert_eq!(cache.dirty_files(), [(SHA256, kept)]);
}

#[test]
fn a_closed_cache_refuses_writes() {
    let (fs, cache) = setup(true);
    let digest = ingest(&fs, &cache, b"before");
    let runtime = runtime();
    runtime.block_on(cache.close()).unwrap();
    let path = Path::new(BUILD).join("after");
    fs.create_new(&path).unwrap().write_all(b"after").unwrap();
    let after = SHA256.digest(b"after");
    assert!(
        runtime
            .block_on(cache.ingest(SHA256, &after, &path))
            .is_err()
    );
    assert!(runtime.block_on(cache.upload(SHA256, &after)).is_err());
    assert!(
        runtime
            .block_on(cache.mark_clean(SHA256, &[digest]))
            .is_err()
    );
    let blobs = SimBlobs::new(&fs);
    blobs.put(b"after");
    assert!(
        runtime
            .block_on(cache.fetch(&blobs, SHA256, &[after]))
            .is_err()
    );
    // Reading still works, and closing again does nothing.
    assert_eq!(copy_out(&cache, &fs, SHA256, &digest).unwrap(), b"before");
    runtime.block_on(cache.close()).unwrap();
}

#[test]
fn closing_waits_for_an_upload() {
    let (_fs, cache) = setup(true);
    let digest = SHA256.digest(b"in flight");
    let runtime = runtime();
    let mut upload = runtime
        .block_on(cache.upload(SHA256, &digest))
        .unwrap()
        .unwrap();
    upload.write(b"in flight").unwrap();
    runtime.block_on(async {
        let mut closing = Box::pin(cache.close());
        assert!(futures::poll!(&mut closing).is_pending());
        upload.finish().await.unwrap();
        closing.await.unwrap();
    });
    assert_eq!(cache.has(SHA256, &digest), Some(Held::Dirty));
    assert!(cache.below_dirty_cap().now_or_never().is_some());
}

/// A run without durability tears files in a power loss. Whatever call
/// the next opening crashes at, and however often, the opening that
/// finally succeeds hands out nothing torn and keeps everything whole.
#[test]
fn a_crash_while_checking_is_checked_again() {
    let build = || {
        let (fs, cache) = setup(false);
        let digests = [
            ingest(&fs, &cache, b"one dirty file"),
            ingest(&fs, &cache, b"another"),
            fetch(&fs, &cache, b"a clean one"),
        ];
        drop(cache);
        fs.crash(&mut keep_names_zero_data);
        (fs, digests)
    };
    let (probe, _) = build();
    let start = probe.calls();
    drop(open(&probe, options(true)).unwrap());
    let calls = probe.calls() - start;
    for crash_at in 0..calls {
        let (fs, digests) = build();
        fs.crash_after(crash_at);
        assert!(open(&fs, options(true)).is_err());
        fs.crash(&mut |_| 0);
        let cache = open(&fs, options(true)).unwrap();
        for digest in &digests {
            if cache.has(SHA256, digest).is_some() {
                let data = copy_out(&cache, &fs, SHA256, digest).unwrap();
                assert_eq!(SHA256.digest(&data), *digest, "crash at {crash_at}");
            }
        }
    }
}
