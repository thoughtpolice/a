// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

use std::collections::HashMap;
use std::os::unix::fs::PermissionsExt as _;
use std::path::PathBuf;
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::Result;
use reapi_cas::{Digest, DigestFn};

use crate::{Fetch, FileCache};

const SHA256: DigestFn = DigestFn::Sha256;

/// Blobs in memory, counting what is fetched from them.
#[derive(Default)]
struct Blobs {
    blobs: Mutex<HashMap<Digest, Vec<u8>>>,
    fetched: AtomicUsize,
}

/// What [`Blobs`] fails with, naming the blobs it lacks.
#[derive(Debug, thiserror::Error)]
#[error("missing {0:?}")]
struct Missing(Vec<Digest>);

impl Blobs {
    fn put(&self, data: &str) -> Digest {
        let digest = SHA256.digest(data.as_bytes());
        self.blobs
            .lock()
            .unwrap()
            .insert(digest, data.as_bytes().to_vec());
        digest
    }
}

impl Fetch for Blobs {
    async fn fetch_to_files(&self, _: DigestFn, blobs: Vec<(Digest, PathBuf)>) -> Result<()> {
        let mut missing = Vec::new();
        for (digest, path) in blobs {
            let data = self.blobs.lock().unwrap().get(&digest).cloned();
            match data {
                Some(data) => {
                    std::fs::write(path, data)?;
                    self.fetched.fetch_add(1, Ordering::Relaxed);
                }
                None => missing.push(digest),
            }
        }
        if !missing.is_empty() {
            return Err(Missing(missing).into());
        }
        Ok(())
    }
}

async fn fetched(cache: &FileCache, blobs: &Blobs, digest: &Digest) {
    drop(cache.fetch(blobs, SHA256, &[*digest]).await.expect("fetch"));
}

#[tokio::test]
async fn the_files_used_longest_ago_are_evicted() {
    let blobs = Blobs::default();
    let (a, b, c) = (blobs.put("aaaa"), blobs.put("bbbb"), blobs.put("cccc"));
    let scratch = tempfile::tempdir().unwrap();
    // Room for two.
    let cache = FileCache::open(scratch.path(), 8).unwrap();
    fetched(&cache, &blobs, &a).await;
    fetched(&cache, &blobs, &b).await;
    // Using a again leaves b the oldest.
    fetched(&cache, &blobs, &a).await;
    fetched(&cache, &blobs, &c).await;
    assert!(cache.path(SHA256, &a).exists());
    assert!(!cache.path(SHA256, &b).exists());
    assert!(cache.path(SHA256, &c).exists());
    // a was fetched once, used twice.
    assert_eq!(blobs.fetched.load(Ordering::Relaxed), 3);
}

#[tokio::test]
async fn pinned_files_are_kept() {
    let blobs = Blobs::default();
    let (a, b, c) = (blobs.put("aaaa"), blobs.put("bbbb"), blobs.put("cccc"));
    let scratch = tempfile::tempdir().unwrap();
    // Room for one.
    let cache = FileCache::open(scratch.path(), 4).unwrap();
    let holding_a = cache.fetch(&blobs, SHA256, &[a]).await.unwrap();
    let holding_b = cache.fetch(&blobs, SHA256, &[b]).await.unwrap();
    assert!(cache.path(SHA256, &a).exists() && cache.path(SHA256, &b).exists());

    drop((holding_a, holding_b));
    fetched(&cache, &blobs, &c).await;
    assert!(!cache.path(SHA256, &a).exists());
    assert!(!cache.path(SHA256, &b).exists());
    assert!(cache.path(SHA256, &c).exists());
}

#[tokio::test]
async fn a_reopened_cache_knows_its_files() {
    let blobs = Blobs::default();
    let (a, b) = (blobs.put("aaaa"), blobs.put("bbbb"));
    let scratch = tempfile::tempdir().unwrap();
    {
        let cache = FileCache::open(scratch.path(), 100).unwrap();
        fetched(&cache, &blobs, &a).await;
        fetched(&cache, &blobs, &b).await;
    }
    // A smaller cache keeps what fits.
    let cache = FileCache::open(scratch.path(), 4).unwrap();
    let kept = [&a, &b]
        .iter()
        .filter(|d| cache.path(SHA256, d).exists())
        .count();
    assert_eq!(kept, 1);
    // What it kept needs no fetching.
    let before = blobs.fetched.load(Ordering::Relaxed);
    let kept = if cache.path(SHA256, &a).exists() {
        a
    } else {
        b
    };
    fetched(&cache, &blobs, &kept).await;
    assert_eq!(blobs.fetched.load(Ordering::Relaxed), before);
}

#[tokio::test]
async fn a_failed_fetch_passes_its_error_on_and_keeps_nothing() {
    let blobs = Blobs::default();
    let a = blobs.put("aaaa");
    let absent = SHA256.digest(b"never stored");
    let scratch = tempfile::tempdir().unwrap();
    let cache = FileCache::open(scratch.path(), 100).unwrap();
    let err = cache
        .fetch(&blobs, SHA256, &[a, absent])
        .await
        .err()
        .expect("a blob is missing");
    assert_eq!(err.downcast_ref::<Missing>().unwrap().0, [absent]);
    assert!(!cache.path(SHA256, &absent).exists());
    let partial = std::fs::read_dir(scratch.path().join("partial")).unwrap();
    assert_eq!(partial.count(), 0, "partial downloads are removed");
}

#[tokio::test]
async fn copies_are_read_only_and_made_under_the_guard() {
    let blobs = Blobs::default();
    let a = blobs.put("#!/bin/sh\n");
    let scratch = tempfile::tempdir().unwrap();
    let cache = FileCache::open(&scratch.path().join("files"), 100).unwrap();
    let _pinned = cache.fetch(&blobs, SHA256, &[a]).await.unwrap();

    let guarded = std::cell::Cell::new(0);
    let copy = scratch.path().join("tool");
    cache
        .copy_to(SHA256, &a, true, &copy, || guarded.set(guarded.get() + 1))
        .unwrap();
    assert_eq!(guarded.get(), 1);
    assert_eq!(std::fs::read(&copy).unwrap(), b"#!/bin/sh\n");
    let mode = |p: &std::path::Path| std::fs::metadata(p).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&copy), 0o555);

    let data = scratch.path().join("data");
    cache.copy_to(SHA256, &a, false, &data, || ()).unwrap();
    assert_eq!(mode(&data), 0o444);
    // The destination must be new.
    assert!(cache.copy_to(SHA256, &a, false, &data, || ()).is_err());
}

#[test]
fn files_are_laid_out_by_function_and_digest() {
    let scratch = tempfile::tempdir().unwrap();
    let cache = FileCache::open(scratch.path(), 100).unwrap();
    let digest = DigestFn::Blake3.digest(b"x");
    let hex = digest.hex();
    assert_eq!(
        cache.path(DigestFn::Blake3, &digest),
        scratch
            .path()
            .join("blake3")
            .join(&hex[..2])
            .join(format!("{hex}-1"))
    );
}

#[test]
fn opening_removes_partial_downloads_and_strays() {
    let scratch = tempfile::tempdir().unwrap();
    let digest = SHA256.digest(b"kept");
    {
        let cache = FileCache::open(scratch.path(), 100).unwrap();
        let path = cache.path(SHA256, &digest);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(&path, b"kept").unwrap();
        std::fs::write(path.with_file_name("not-a-digest"), b"x").unwrap();
        std::fs::write(scratch.path().join("partial").join("7"), b"half").unwrap();
    }
    let cache = FileCache::open(scratch.path(), 100).unwrap();
    let path = cache.path(SHA256, &digest);
    assert_eq!(std::fs::read(&path).unwrap(), b"kept");
    assert!(!path.with_file_name("not-a-digest").exists());
    let partial = std::fs::read_dir(scratch.path().join("partial")).unwrap();
    assert_eq!(partial.count(), 0);
}

#[tokio::test]
async fn dropping_pins_evicts_what_they_held_over_the_size() {
    let blobs = Blobs::default();
    let (a, b) = (blobs.put("aaaa"), blobs.put("bbbb"));
    let scratch = tempfile::tempdir().unwrap();
    // Room for one.
    let cache = FileCache::open(scratch.path(), 4).unwrap();
    let holding = cache.fetch(&blobs, SHA256, &[a, b]).await.unwrap();
    assert_eq!(cache.usage().clean_bytes, 8);
    drop(holding);
    assert_eq!(cache.usage().clean_bytes, 4);
    let kept = [a, b]
        .iter()
        .filter(|d| cache.path(SHA256, d).exists())
        .count();
    assert_eq!(kept, 1);
}
