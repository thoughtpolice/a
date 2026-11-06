// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The store stamp: clean files are plain cache in a store they are not
//! vouched for in, until they are.

use std::io::Write as _;
use std::path::Path;

use reapi_cas::Digest;

use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::test_support::*;
use crate::{FileCache, Held, Ingested, Options};

const BUILD: &str = "/builds";

fn setup() -> (SimFs, FileCache<SimFs>) {
    let fs = sim();
    fs.create_dir(Path::new(BUILD)).unwrap();
    let cache = open(&fs, Options::new(1000)).unwrap();
    (fs, cache)
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

fn output(fs: &SimFs, data: &[u8]) -> (Digest, std::path::PathBuf) {
    let digest = SHA256.digest(data);
    let path = Path::new(BUILD).join(format!("{}-{}", digest.hex(), fs.calls()));
    fs.create_new(&path).unwrap().write_all(data).unwrap();
    (digest, path)
}

fn join(cache: &FileCache<SimFs>, store: &str) -> Vec<Digest> {
    let mut joined: Vec<Digest> = runtime()
        .block_on(cache.join(store))
        .unwrap()
        .into_iter()
        .map(|(_, digest)| digest)
        .collect();
    joined.sort_by_key(Digest::hex);
    joined
}

fn sorted(mut digests: Vec<Digest>) -> Vec<Digest> {
    digests.sort_by_key(Digest::hex);
    digests
}

#[test]
fn an_empty_cache_is_stamped_on_joining() {
    let (fs, cache) = setup();
    assert_eq!(cache.store_id(), None);
    assert_eq!(join(&cache, "store-1"), []);
    assert_eq!(cache.store_id().as_deref(), Some("store-1"));
    drop(cache);
    // Stamped durably.
    fs.crash(&mut |_| 0);
    let cache = open(&fs, Options::new(1000)).unwrap();
    assert_eq!(cache.store_id().as_deref(), Some("store-1"));
    assert_eq!(join(&cache, "store-1"), []);
}

#[test]
fn clean_files_are_plain_cache_in_another_store_until_vouched_for() {
    let (fs, cache) = setup();
    join(&cache, "store-1");
    let a = fetch(&fs, &cache, b"aaaa");
    let b = fetch(&fs, &cache, b"bbbb");
    let c = fetch(&fs, &cache, b"cccc");

    assert_eq!(join(&cache, "store-2"), sorted(vec![a, b, c]));
    assert_eq!(
        sorted(cache.unvouched().into_iter().map(|n| n.1).collect()),
        sorted(vec![a, b, c])
    );
    // Not yet stamped: store-1 still vouches for them all.
    assert_eq!(cache.store_id().as_deref(), Some("store-1"));
    // Still handed out.
    assert_eq!(copy_out(&cache, &fs, SHA256, &a).unwrap(), b"aaaa");
    // But not counted as held when taken in: the new file is dirty.
    let (digest, path) = output(&fs, b"aaaa");
    let ingested = runtime().block_on(cache.ingest(SHA256, &digest, &path));
    assert_eq!(ingested.unwrap(), Ingested::Added);
    assert_eq!(cache.has(SHA256, &a), Some(Held::Dirty));
    // Nor is an upload of one needless.
    assert!(
        runtime()
            .block_on(cache.upload(SHA256, &b))
            .unwrap()
            .is_some()
    );

    runtime().block_on(cache.vouch(SHA256, &[b])).unwrap();
    assert_eq!(cache.store_id().as_deref(), Some("store-1"));
    let (_, path) = output(&fs, b"bbbb");
    let ingested = runtime().block_on(cache.ingest(SHA256, &b, &path));
    assert_eq!(ingested.unwrap(), Ingested::Already(Held::Clean));
    runtime().block_on(cache.vouch(SHA256, &[c])).unwrap();
    assert_eq!(cache.store_id().as_deref(), Some("store-2"));
    assert_eq!(cache.unvouched(), []);
    drop(cache);
    let cache = open(&fs, Options::new(1000)).unwrap();
    assert_eq!(join(&cache, "store-2"), []);
}

#[test]
fn a_cache_stopped_before_vouching_registers_everything_again() {
    let (fs, cache) = setup();
    join(&cache, "store-1");
    let a = fetch(&fs, &cache, b"aaaa");
    assert_eq!(join(&cache, "store-2"), [a]);
    // Fetched from store-2, so vouched for in it.
    let b = fetch(&fs, &cache, b"bbbb");
    assert_eq!(cache.unvouched(), [(SHA256, a)]);
    drop(cache);
    let cache = open(&fs, Options::new(1000)).unwrap();
    assert_eq!(cache.store_id().as_deref(), Some("store-1"));
    // b is known to store-2, but nothing on disk says so.
    assert_eq!(join(&cache, "store-2"), sorted(vec![a, b]));
}

#[test]
fn evicting_what_is_unvouched_lets_the_stamp_be_written() {
    let fs = sim();
    let cache = open(&fs, Options::new(4)).unwrap();
    join(&cache, "store-1");
    let a = fetch(&fs, &cache, b"aaaa");
    assert_eq!(join(&cache, "store-2"), [a]);
    // Room for one: fetching another evicts a.
    fetch(&fs, &cache, b"bbbb");
    assert_eq!(cache.unvouched(), []);
    runtime().block_on(cache.vouch(SHA256, &[])).unwrap();
    assert_eq!(cache.store_id().as_deref(), Some("store-2"));
}

#[test]
fn a_store_id_must_be_one_line() {
    let (_, cache) = setup();
    for bad in ["", "two\nlines"] {
        assert!(runtime().block_on(cache.join(bad)).is_err());
    }
}

/// Taking a blob in over plain cache removes the clean file only once the
/// dirty one is durable: a crash anywhere in between keeps one of them.
/// (Found by fuzzing: the clean file was removed at once, and a crash
/// that kept the removal but not the rename lost both.)
#[test]
fn a_crash_while_replacing_plain_cache_keeps_a_copy() {
    let probe = || {
        let (fs, cache) = setup();
        join(&cache, "store-1");
        let a = fetch(&fs, &cache, b"aaaa");
        let b = fetch(&fs, &cache, b"bbbb");
        assert_eq!(join(&cache, "store-2").len(), 2);
        let (_, path) = output(&fs, b"aaaa");
        // Fetched files' names need not be durable; these must be, for a
        // crash to have something to lose.
        fs.sync_fs(Path::new("/")).unwrap();
        (fs, cache, a, b, path)
    };
    let (fs, cache, a, _, path) = probe();
    let start = fs.calls();
    let ingested = runtime().block_on(cache.ingest(SHA256, &a, &path));
    assert_eq!(ingested.unwrap(), Ingested::Added);
    let calls = fs.calls() - start;
    // Keeping nothing, everything, and every other change either way: one
    // of the last keeps a removal and drops the rename before it.
    for keep in 0..4u64 {
        for crash_at in 0..=calls {
            let (fs, cache, a, _, path) = probe();
            fs.crash_after(crash_at);
            let _ = runtime().block_on(cache.ingest(SHA256, &a, &path));
            drop(cache);
            let mut changes = 0;
            fs.crash(&mut |n| {
                changes += 1;
                match keep {
                    0 => 0,
                    1 => n - 1,
                    _ => (changes + keep) % 2,
                }
            });
            let cache = open(&fs, Options::new(1000)).unwrap();
            assert!(
                cache.has(SHA256, &a).is_some(),
                "keeping {keep}, crash at call {crash_at}"
            );
        }
    }
}
