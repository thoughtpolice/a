// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Uploads: written in pieces, hashed as they arrive, checked, and taken
//! in as dirty.

use std::io::Write as _;
use std::path::Path;

use hegel::TestCase;
use hegel::generators as gs;
use reapi_cas::{Digest, DigestFn};

use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::test_support::*;
use crate::{FileCache, Held, Ingested, Options};

fn partials(fs: &SimFs) -> usize {
    fs.read_dir(&Path::new(STORE).join("partial"))
        .unwrap()
        .len()
}

/// Upload `data` in pieces of `piece` bytes as `digest`.
async fn upload(
    cache: &FileCache<SimFs>,
    function: DigestFn,
    digest: &Digest,
    data: &[u8],
    piece: usize,
) -> std::io::Result<Option<Ingested>> {
    let Some(mut upload) = cache.upload(function, digest).await? else {
        return Ok(None);
    };
    for chunk in data.chunks(piece.max(1)) {
        upload.write(chunk)?;
    }
    assert_eq!(upload.written(), data.len() as u64);
    upload.finish().await.map(Some)
}

#[test]
fn an_upload_is_taken_in_dirty() {
    let fs = sim();
    let cache = open(&fs, Options::new(1000)).unwrap();
    let data = b"uploaded by a client";
    let digest = SHA256.digest(data);
    let uploaded = runtime().block_on(upload(&cache, SHA256, &digest, data, 3));
    assert_eq!(uploaded.unwrap(), Some(Ingested::Added));
    assert_eq!(cache.dirty_files(), [(SHA256, digest)]);
    assert_eq!(copy_out(&cache, &fs, SHA256, &digest).unwrap(), data);
    assert_eq!(partials(&fs), 0);
    // There is nothing to upload a second time.
    let again = runtime().block_on(upload(&cache, SHA256, &digest, data, 3));
    assert_eq!(again.unwrap(), None);
}

#[test]
fn an_upload_that_is_not_its_blob_is_refused_and_removed() {
    let fs = sim();
    let cache = open(&fs, Options::new(1000)).unwrap();
    let digest = SHA256.digest(b"the real thing");
    for data in [&b"the real thinG"[..], b"the real thin", b""] {
        let err = runtime()
            .block_on(upload(&cache, SHA256, &digest, data, 4))
            .unwrap_err();
        assert_eq!(err.kind(), std::io::ErrorKind::InvalidData);
    }
    let err = runtime()
        .block_on(upload(&cache, SHA256, &digest, b"the real thing!", 4))
        .unwrap_err();
    assert_eq!(err.kind(), std::io::ErrorKind::InvalidData, "too long");
    assert_eq!(cache.has(SHA256, &digest), None);
    assert_eq!(partials(&fs), 0);
}

#[test]
fn an_unfinished_upload_leaves_nothing() {
    let fs = sim();
    let cache = open(&fs, Options::new(1000)).unwrap();
    let digest = SHA256.digest(b"abandoned");
    let mut upload = runtime()
        .block_on(cache.upload(SHA256, &digest))
        .unwrap()
        .unwrap();
    upload.write(b"aban").unwrap();
    assert_eq!(partials(&fs), 1);
    drop(upload);
    assert_eq!(partials(&fs), 0);
    assert_eq!(cache.has(SHA256, &digest), None);
}

#[test]
fn an_upload_racing_an_ingest_of_its_blob_keeps_one() {
    let fs = sim();
    fs.create_dir(Path::new("/builds")).unwrap();
    let cache = open(&fs, Options::new(1000)).unwrap();
    let data = b"made twice";
    let digest = SHA256.digest(data);
    let path = Path::new("/builds/out");
    fs.create_new(path).unwrap().write_all(data).unwrap();
    let runtime = runtime();
    let mut upload = runtime
        .block_on(cache.upload(SHA256, &digest))
        .unwrap()
        .unwrap();
    upload.write(data).unwrap();
    let ingested = runtime.block_on(cache.ingest(SHA256, &digest, path));
    assert_eq!(ingested.unwrap(), Ingested::Added);
    let finished = runtime.block_on(upload.finish());
    assert_eq!(finished.unwrap(), Ingested::Already(Held::Dirty));
    assert_eq!(cache.dirty_files().len(), 1);
    assert_eq!(partials(&fs), 0);
}

/// A crash at any call of an upload: if it was acknowledged, it is there
/// whole after the crash; whatever is there is whole.
#[test]
fn a_crash_anywhere_in_an_upload_loses_nothing_acknowledged() {
    let data: Vec<u8> = (0..200).map(|i| i as u8).collect();
    let digest = SHA256.digest(&data);
    for crash_at in 0..12 {
        let fs = sim();
        let cache = open(&fs, Options::new(1000)).unwrap();
        fs.crash_after(crash_at);
        let uploaded = runtime().block_on(upload(&cache, SHA256, &digest, &data, 64));
        drop(cache);
        let crashed = fs.crashed();
        fs.crash(&mut keep_names_zero_data);
        let cache = open(&fs, Options::new(1000)).unwrap();
        if uploaded.is_ok() {
            assert_eq!(cache.has(SHA256, &digest), Some(Held::Dirty));
        } else {
            assert!(crashed, "only the crash fails it");
        }
        if cache.has(SHA256, &digest).is_some() {
            assert_eq!(copy_out(&cache, &fs, SHA256, &digest).unwrap(), data);
        }
    }
}

/// However a blob is cut into pieces, its digest comes out the same, for
/// every digest function: SHA256TREE's tree included, whose leaves the
/// pieces need not line up with.
#[hegel::test(test_cases = 100, database = None)]
fn uploads_in_any_pieces_check_out(tc: TestCase) {
    let function = tc.draw(gs::sampled_from(vec![
        DigestFn::Sha256,
        DigestFn::Blake3,
        DigestFn::Sha256Tree,
    ]));
    let len = tc.draw(gs::sampled_from(vec![
        0usize, 1, 1023, 1024, 1025, 3000, 4097,
    ]));
    let seed = tc.draw(gs::integers::<u8>());
    let data: Vec<u8> = (0..len)
        .map(|i| (i as u8).wrapping_mul(31).wrapping_add(seed))
        .collect();
    let digest = function.digest(&data);
    let fs = sim();
    let cache = open(&fs, Options::new(1 << 20)).unwrap();
    let runtime = runtime();
    let mut upload = runtime
        .block_on(cache.upload(function, &digest))
        .unwrap()
        .unwrap();
    let mut at = 0;
    while at < data.len() {
        let piece = tc.draw(gs::integers::<usize>().min_value(1).max_value(1500));
        let end = data.len().min(at.saturating_add(piece));
        upload.write(&data[at..end]).unwrap();
        at = end;
    }
    assert_eq!(runtime.block_on(upload.finish()).unwrap(), Ingested::Added);
    assert_eq!(copy_out(&cache, &fs, function, &digest).unwrap(), data);
}
