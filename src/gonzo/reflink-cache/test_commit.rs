// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Group commit: ingests finishing together share a sync of the dirty
//! area, and none returns before its name is durable.

use std::io::Write as _;
use std::path::{Path, PathBuf};

use reapi_cas::Digest;

use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::test_support::*;
use crate::{FileCache, Held, Ingested, Options};

const BUILD: &str = "/builds";

fn outputs(fs: &SimFs, count: usize) -> Vec<(Digest, PathBuf)> {
    fs.create_dir(Path::new(BUILD)).unwrap();
    (0..count)
        .map(|i| {
            let data = format!("output {i}");
            let path = Path::new(BUILD).join(i.to_string());
            fs.create_new(&path)
                .unwrap()
                .write_all(data.as_bytes())
                .unwrap();
            (SHA256.digest(data.as_bytes()), path)
        })
        .collect()
}

async fn ingest_all(
    cache: &FileCache<SimFs>,
    files: &[(Digest, PathBuf)],
) -> Vec<std::io::Result<Ingested>> {
    futures::future::join_all(
        files
            .iter()
            .map(|(digest, path)| cache.ingest(SHA256, digest, path)),
    )
    .await
}

#[test]
fn ingests_finishing_together_share_a_directory_sync() {
    let fs = sim();
    let files = outputs(&fs, 8);
    let cache = open(&fs, Options::new(1 << 20)).unwrap();
    let before = fs.stats();
    let results = runtime().block_on(ingest_all(&cache, &files));
    for result in results {
        assert_eq!(result.unwrap(), Ingested::Added);
    }
    let after = fs.stats();
    assert_eq!(after.sync_data - before.sync_data, 8, "each file's data");
    assert_eq!(after.sync_dir - before.sync_dir, 1, "one sync for all");
    // And all of it is durable.
    drop(cache);
    fs.crash(&mut |_| 0);
    let cache = open(&fs, Options::new(1 << 20)).unwrap();
    assert_eq!(cache.dirty_files().len(), 8);
}

#[test]
fn ingests_of_one_blob_together_keep_one_file_and_both_wait() {
    let fs = sim();
    fs.create_dir(Path::new(BUILD)).unwrap();
    let mut files = Vec::new();
    for name in ["a", "b", "c"] {
        let path = Path::new(BUILD).join(name);
        fs.create_new(&path).unwrap().write_all(b"same").unwrap();
        files.push((SHA256.digest(b"same"), path));
    }
    let cache = open(&fs, Options::new(1 << 20)).unwrap();
    let mut results: Vec<Ingested> = runtime()
        .block_on(ingest_all(&cache, &files))
        .into_iter()
        .map(Result::unwrap)
        .collect();
    results.sort_by_key(|r| *r != Ingested::Added);
    assert_eq!(
        results,
        [
            Ingested::Added,
            Ingested::Already(Held::Dirty),
            Ingested::Already(Held::Dirty)
        ]
    );
    assert_eq!(cache.dirty_files().len(), 1);
    assert!(fs.read_dir(Path::new(BUILD)).unwrap().is_empty());
    // None returned before the one file was durable.
    drop(cache);
    fs.crash(&mut |_| 0);
    let cache = open(&fs, Options::new(1 << 20)).unwrap();
    assert_eq!(cache.dirty_files().len(), 1);
}

/// A crash at any call of a group of ingests loses none that returned.
#[test]
fn a_crash_anywhere_in_a_group_loses_nothing_acknowledged() {
    let probe = sim();
    let files = outputs(&probe, 4);
    let cache = open(&probe, Options::new(1 << 20)).unwrap();
    let start = probe.calls();
    runtime().block_on(ingest_all(&cache, &files));
    let calls = probe.calls() - start;
    drop(cache);
    for crash_at in 0..calls {
        let fs = sim();
        let files = outputs(&fs, 4);
        let cache = open(&fs, Options::new(1 << 20)).unwrap();
        fs.crash_after(crash_at);
        let results = runtime().block_on(ingest_all(&cache, &files));
        drop(cache);
        fs.crash(&mut |_| 0);
        let cache = open(&fs, Options::new(1 << 20)).unwrap();
        for ((digest, _), result) in files.iter().zip(results) {
            if result.is_ok() {
                assert_eq!(
                    cache.has(SHA256, digest),
                    Some(Held::Dirty),
                    "crash at call {crash_at}"
                );
            }
            if cache.has(SHA256, digest).is_some() {
                let data = copy_out(&cache, &fs, SHA256, digest).unwrap();
                assert_eq!(SHA256.digest(&data), *digest);
            }
        }
    }
}

/// On the real filesystem, with blocking threads and many tasks.
#[test]
fn many_ingests_on_threads_all_land() {
    let scratch = tempfile::tempdir().unwrap();
    let builds = scratch.path().join("builds");
    std::fs::create_dir(&builds).unwrap();
    let cache = FileCache::open(&scratch.path().join("files"), 1 << 20).unwrap();
    let cache = std::sync::Arc::new(cache);
    let runtime = tokio::runtime::Builder::new_multi_thread()
        .worker_threads(4)
        .build()
        .unwrap();
    let digests: Vec<Digest> = runtime.block_on(async {
        let mut tasks = tokio::task::JoinSet::new();
        for i in 0..64 {
            let data = format!("output {}", i % 48);
            let path = builds.join(i.to_string());
            std::fs::write(&path, &data).unwrap();
            let digest = SHA256.digest(data.as_bytes());
            let cache = cache.clone();
            tasks.spawn(async move {
                cache.ingest(SHA256, &digest, &path).await.unwrap();
                digest
            });
        }
        tasks.join_all().await
    });
    assert_eq!(digests.len(), 64);
    assert_eq!(cache.dirty_files().len(), 48);
    assert_eq!(std::fs::read_dir(&builds).unwrap().count(), 0);
    for digest in digests {
        assert_eq!(cache.has(SHA256, &digest), Some(Held::Dirty));
    }
}

/// A sync whose runtime shuts down before it runs does not stop later
/// ones.
#[test]
fn a_sync_lost_with_its_runtime_is_started_again() {
    let fs = sim();
    let files = outputs(&fs, 2);
    let cache = open(&fs, Options::new(1 << 20)).unwrap();
    let syncs = fs.stats().sync_dir;
    {
        let runtime = runtime();
        let (digest, path) = &files[0];
        let mut ingest = Box::pin(cache.ingest(SHA256, digest, path));
        // Poll until the file is renamed in and its sync spawned, then
        // drop both with the runtime.
        runtime.block_on(async {
            for _ in 0..2 {
                let _ = futures::poll!(&mut ingest);
                tokio::task::yield_now().await;
            }
        });
        assert_eq!(cache.has(SHA256, digest), Some(Held::Dirty));
    }
    assert_eq!(fs.stats().sync_dir, syncs, "the first sync never ran");
    let (digest, path) = &files[1];
    let ingested = runtime().block_on(cache.ingest(SHA256, digest, path));
    assert_eq!(ingested.unwrap(), Ingested::Added);
    assert_eq!(cache.dirty_files().len(), 2);
}
