// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Dirty files: taken in by rename or copy, never evicted, durable once
//! acknowledged, and moved to the clean files when marked.

use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use reapi_cas::Digest;

use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::test_support::*;
use crate::{FileCache, Held, Ingested, Options, Usage};

/// Where tests put files for the cache to take in.
const BUILD: &str = "/store-builds";

fn setup(max_bytes: u64) -> (SimFs, FileCache<SimFs>) {
    let fs = sim();
    fs.create_dir(Path::new(BUILD)).unwrap();
    fs.sync_fs(Path::new("/")).unwrap();
    let cache = open(&fs, Options::new(max_bytes)).unwrap();
    (fs, cache)
}

/// Write `data` to a new file in the build directory, as an action would.
fn output(fs: &SimFs, name: &str, data: &[u8]) -> (Digest, PathBuf) {
    let path = Path::new(BUILD).join(name);
    fs.create_new(&path).unwrap().write_all(data).unwrap();
    (SHA256.digest(data), path)
}

fn ingest(cache: &FileCache<SimFs>, digest: &Digest, path: &Path) -> std::io::Result<Ingested> {
    runtime().block_on(cache.ingest(SHA256, digest, path))
}

fn mark_clean(cache: &FileCache<SimFs>, digests: &[Digest]) {
    runtime()
        .block_on(cache.mark_clean(SHA256, digests))
        .unwrap();
}

#[test]
fn an_ingested_file_is_moved_in_dirty() {
    let (fs, cache) = setup(1000);
    let (digest, path) = output(&fs, "out", b"an output");
    assert_eq!(ingest(&cache, &digest, &path).unwrap(), Ingested::Added);
    assert!(fs.read(&path).is_err(), "the file was moved");
    assert_eq!(cache.has(SHA256, &digest), Some(Held::Dirty));
    assert_eq!(cache.dirty_files(), [(SHA256, digest)]);
    assert_eq!(
        cache.usage(),
        Usage {
            dirty_bytes: 9,
            dirty_files: 1,
            ..Usage::default()
        }
    );
    assert_eq!(
        copy_out(&cache, &fs, SHA256, &digest).unwrap(),
        b"an output"
    );
    let mut read = Vec::new();
    cache
        .open_file(SHA256, &digest)
        .unwrap()
        .read_to_end(&mut read)
        .unwrap();
    assert_eq!(read, b"an output");
}

#[test]
fn a_file_of_the_wrong_size_is_refused_and_left() {
    let (fs, cache) = setup(1000);
    let (_, path) = output(&fs, "out", b"an output");
    let digest = SHA256.digest(b"something else");
    let err = ingest(&cache, &digest, &path).unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidInput);
    assert_eq!(fs.read(&path).unwrap(), b"an output");
    assert_eq!(cache.has(SHA256, &digest), None);
}

#[test]
fn a_blob_held_already_is_kept_and_the_file_removed() {
    let (fs, cache) = setup(1000);
    let (digest, first) = output(&fs, "first", b"same");
    ingest(&cache, &digest, &first).unwrap();
    let (_, second) = output(&fs, "second", b"same");
    assert_eq!(
        ingest(&cache, &digest, &second).unwrap(),
        Ingested::Already(Held::Dirty)
    );
    assert!(fs.read(&second).is_err());
    assert_eq!(cache.dirty_files().len(), 1);

    let blobs = SimBlobs::new(&fs);
    let fetched = blobs.put(b"fetched");
    drop(
        runtime()
            .block_on(cache.fetch(&blobs, SHA256, &[fetched]))
            .unwrap(),
    );
    let (_, third) = output(&fs, "third", b"fetched");
    assert_eq!(
        ingest(&cache, &fetched, &third).unwrap(),
        Ingested::Already(Held::Clean)
    );
    assert!(fs.read(&third).is_err());
}

#[test]
fn dirty_files_are_never_evicted() {
    // Room for one file of four bytes.
    let (fs, cache) = setup(4);
    let blobs = SimBlobs::new(&fs);
    let clean = blobs.put(b"cccc");
    drop(
        runtime()
            .block_on(cache.fetch(&blobs, SHA256, &[clean]))
            .unwrap(),
    );
    let mut dirty = Vec::new();
    for (i, data) in [b"dddd", b"eeee", b"ffff"].iter().enumerate() {
        let (digest, path) = output(&fs, &i.to_string(), *data);
        ingest(&cache, &digest, &path).unwrap();
        dirty.push(digest);
    }
    // The clean file made room, and the dirty ones go over the size.
    assert_eq!(cache.has(SHA256, &clean), None);
    assert_eq!(cache.dirty_files().len(), 3);
    assert_eq!(cache.usage().dirty_bytes, 12);
    // A fetch over the size keeps its file only while it is pinned.
    let other = blobs.put(b"gggg");
    let pinned = runtime()
        .block_on(cache.fetch(&blobs, SHA256, &[other]))
        .unwrap();
    assert_eq!(cache.has(SHA256, &other), Some(Held::Clean));
    drop(pinned);
    mark_clean(&cache, &dirty[..1]);
    assert_eq!(cache.has(SHA256, &other), None);
    assert_eq!(cache.has(SHA256, &dirty[0]), None);
    assert_eq!(
        cache.dirty_files(),
        [(SHA256, dirty[1]), (SHA256, dirty[2])]
    );
}

#[test]
fn marked_files_are_clean_where_clean_files_are_kept() {
    let (fs, cache) = setup(1000);
    let (digest, path) = output(&fs, "out", b"offloaded");
    ingest(&cache, &digest, &path).unwrap();
    let pinned = runtime()
        .block_on(cache.fetch(&SimBlobs::new(&fs), SHA256, &[digest]))
        .unwrap();
    mark_clean(&cache, &[digest]);
    assert_eq!(cache.has(SHA256, &digest), Some(Held::Clean));
    assert_eq!(cache.dirty_files(), []);
    assert_eq!(fs.read(&cache.path(SHA256, &digest)).unwrap(), b"offloaded");
    assert_eq!(
        copy_out(&cache, &fs, SHA256, &digest).unwrap(),
        b"offloaded"
    );
    // Marking again, or marking what the cache lacks, does nothing.
    mark_clean(&cache, &[digest, SHA256.digest(b"absent")]);
    assert_eq!(cache.usage().clean_files, 1);
    drop(pinned);
}

#[test]
fn dirty_files_are_listed_oldest_first_across_reopening() {
    let (fs, cache) = setup(1000);
    let mut digests = Vec::new();
    for i in 0..5u8 {
        let (digest, path) = output(&fs, &i.to_string(), &[i; 3]);
        ingest(&cache, &digest, &path).unwrap();
        digests.push(digest);
    }
    mark_clean(&cache, &digests[1..2]);
    drop(cache);
    let cache = open(&fs, Options::new(1000)).unwrap();
    let expected: Vec<_> = [0, 2, 3, 4].map(|i| (SHA256, digests[i])).into();
    assert_eq!(cache.dirty_files(), expected);
    assert_eq!(cache.has(SHA256, &digests[1]), Some(Held::Clean));
    // New dirty files come after those an earlier run left.
    let (digest, path) = output(&fs, "later", b"later");
    ingest(&cache, &digest, &path).unwrap();
    assert_eq!(cache.dirty_files().last(), Some(&(SHA256, digest)));
}

#[test]
fn a_file_on_another_filesystem_is_copied_in() {
    let (fs, cache) = setup(1000);
    fs.add_device(Path::new("/elsewhere")).unwrap();
    for reflinks in [true, false] {
        fs.set_reflinks(reflinks);
        let data = format!("from elsewhere, reflinks {reflinks}");
        let path = Path::new("/elsewhere").join(reflinks.to_string());
        fs.create_new(&path)
            .unwrap()
            .write_all(data.as_bytes())
            .unwrap();
        let digest = SHA256.digest(data.as_bytes());
        assert_eq!(ingest(&cache, &digest, &path).unwrap(), Ingested::Added);
        assert!(fs.read(&path).is_err(), "the original was removed");
        assert_eq!(
            copy_out(&cache, &fs, SHA256, &digest).unwrap(),
            data.as_bytes()
        );
    }
    assert!(
        fs.read_dir(Path::new("/store/partial")).unwrap().is_empty(),
        "no copy is left behind"
    );
}

/// An acknowledged ingest survives a power loss that keeps nothing it
/// was not made to keep; a file marked clean is clean or dirty after
/// one, never lost.
#[test]
fn acknowledged_files_survive_power_loss() {
    let (fs, cache) = setup(1000);
    let (a, path) = output(&fs, "a", b"aaaa");
    ingest(&cache, &a, &path).unwrap();
    let (b, path) = output(&fs, "b", b"bbbb");
    ingest(&cache, &b, &path).unwrap();
    mark_clean(&cache, &[b]);
    drop(cache);
    for crash in [keep_names_lose_data as fn(u64) -> u64, |_| 0, |n| n - 1] {
        let fs = fs.clone();
        fs.crash(&mut { crash });
        let cache = open(&fs, Options::new(1000)).unwrap();
        assert_eq!(cache.has(SHA256, &a), Some(Held::Dirty));
        assert!(cache.has(SHA256, &b).is_some());
        for digest in [a, b] {
            let data = copy_out(&cache, &fs, SHA256, &digest).unwrap();
            assert_eq!(SHA256.digest(&data), digest);
        }
    }
}

/// Without durability nothing is synced, and an acknowledged file may be
/// lost.
#[test]
fn without_durability_ingests_sync_nothing() {
    let fs = sim();
    fs.create_dir(Path::new(BUILD)).unwrap();
    let options = Options {
        durable: false,
        ..Options::new(1000)
    };
    let cache = open(&fs, options.clone()).unwrap();
    let before = fs.stats();
    let (digest, path) = output(&fs, "out", b"volatile");
    ingest(&cache, &digest, &path).unwrap();
    assert_eq!(fs.stats(), before);
    drop(cache);
    fs.crash(&mut |_| 0);
    let cache = open(&fs, options).unwrap();
    assert_eq!(cache.has(SHA256, &digest), None);
}
