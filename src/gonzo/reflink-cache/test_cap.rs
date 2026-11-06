// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The cap on dirty bytes: reported exactly, and waited on.

use std::io::Write as _;
use std::path::Path;

use futures::FutureExt as _;
use hegel::TestCase;
use hegel::generators as gs;
use reapi_cas::Digest;

use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::test_support::*;
use crate::{FileCache, Options};

const BUILD: &str = "/builds";

fn ingest(fs: &SimFs, cache: &FileCache<SimFs>, data: &[u8]) -> Digest {
    let digest = SHA256.digest(data);
    let path = Path::new(BUILD).join(digest.hex());
    fs.create_new(&path).unwrap().write_all(data).unwrap();
    runtime()
        .block_on(cache.ingest(SHA256, &digest, &path))
        .unwrap();
    digest
}

fn setup(options: Options) -> (SimFs, FileCache<SimFs>) {
    let fs = sim();
    fs.create_dir(Path::new(BUILD)).unwrap();
    let cache = open(&fs, options).unwrap();
    (fs, cache)
}

#[test]
fn the_cap_is_a_quarter_of_the_size_unless_set() {
    let (_, cache) = setup(Options::new(1000));
    assert_eq!(cache.usage().dirty_cap, 250);
    let (_, cache) = setup(Options {
        dirty_cap: Some(10),
        ..Options::new(1000)
    });
    assert_eq!(cache.usage().dirty_cap, 10);
}

#[test]
fn waiting_for_room_ends_once_files_are_marked_clean() {
    let (fs, cache) = setup(Options {
        dirty_cap: Some(8),
        ..Options::new(1000)
    });
    let a = ingest(&fs, &cache, b"aaaa");
    let b = ingest(&fs, &cache, b"bbbb");
    // At the cap is not over it.
    assert!(!cache.usage().over_dirty_cap());
    assert!(cache.below_dirty_cap().now_or_never().is_some());
    let c = ingest(&fs, &cache, b"cccc");
    assert!(cache.usage().over_dirty_cap());
    let runtime = runtime();
    runtime.block_on(async {
        let mut waiting = Box::pin(cache.below_dirty_cap());
        assert!(futures::poll!(&mut waiting).is_pending());
        cache.mark_clean(SHA256, &[a]).await.unwrap();
        waiting.await;
    });
    assert!(!cache.usage().over_dirty_cap());
    // Reopening counts what it finds.
    drop(cache);
    let cache = open(
        &fs,
        Options {
            dirty_cap: Some(4),
            ..Options::new(1000)
        },
    )
    .unwrap();
    assert_eq!(cache.usage().dirty_bytes, 8);
    assert!(cache.usage().over_dirty_cap());
    assert!(cache.below_dirty_cap().now_or_never().is_none());
    runtime.block_on(cache.mark_clean(SHA256, &[b, c])).unwrap();
    assert!(cache.below_dirty_cap().now_or_never().is_some());
}

/// Ingests and marks in any order: the dirty bytes are exactly the sizes
/// of the dirty files, over the cap exactly when they exceed it, and a
/// wait for room is over exactly when they do not.
#[hegel::test(test_cases = 100, database = None)]
fn the_dirty_count_is_exact(tc: TestCase) {
    let cap = tc.draw(gs::integers::<u64>().max_value(40));
    let (fs, cache) = setup(Options {
        dirty_cap: Some(cap),
        ..Options::new(100)
    });
    let runtime = runtime();
    let steps = tc.draw(gs::integers::<usize>().max_value(20));
    for _ in 0..steps {
        if tc.draw(gs::booleans()) {
            let len = tc.draw(gs::integers::<usize>().max_value(12));
            let byte = tc.draw(gs::integers::<u8>().max_value(7));
            ingest(&fs, &cache, &vec![byte; len]);
        } else {
            let dirty = cache.dirty_files();
            if !dirty.is_empty() {
                let marked: Vec<Digest> = dirty
                    .iter()
                    .filter(|_| tc.draw(gs::booleans()))
                    .map(|(_, digest)| *digest)
                    .collect();
                runtime.block_on(cache.mark_clean(SHA256, &marked)).unwrap();
            }
        }
        let usage = cache.usage();
        let dirty = cache.dirty_files();
        assert_eq!(usage.dirty_files, dirty.len());
        assert_eq!(
            usage.dirty_bytes,
            dirty.iter().map(|(_, digest)| digest.size).sum::<u64>()
        );
        assert_eq!(usage.over_dirty_cap(), usage.dirty_bytes > cap);
        assert_eq!(
            cache.below_dirty_cap().now_or_never().is_some(),
            !usage.over_dirty_cap()
        );
    }
}
