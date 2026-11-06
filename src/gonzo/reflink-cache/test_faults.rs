// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! I/O errors from the filesystem, injected at every call: they reach the
//! caller, and nothing acknowledged is lost.

use std::path::PathBuf;

use anyhow::Result;
use faultline::{Action, Injector};
use reapi_cas::{Digest, DigestFn};

use crate::faults::{FAULT_POINTS, Faulty};
use crate::fs::RealFs;
use crate::test_support::{SHA256, runtime};
use crate::{Fetch, FileCache, Held, Ingested, Options};

type Cache = FileCache<Faulty<RealFs>>;

/// The blob a workload fetches, written with the standard library,
/// outside the cache's filesystem and its faults.
struct Blobs;

const FETCHED: &[u8] = b"a fetched blob";

impl Fetch for Blobs {
    async fn fetch_to_files(&self, _: DigestFn, blobs: Vec<(Digest, PathBuf)>) -> Result<()> {
        for (digest, path) in blobs {
            assert_eq!(digest, SHA256.digest(FETCHED));
            std::fs::write(path, FETCHED)?;
        }
        Ok(())
    }
}

struct Env {
    _scratch: tempfile::TempDir,
    store: PathBuf,
    builds: PathBuf,
}

impl Env {
    fn new() -> Self {
        let scratch = tempfile::tempdir().unwrap();
        let builds = scratch.path().join("builds");
        std::fs::create_dir(&builds).unwrap();
        Env {
            store: scratch.path().join("store"),
            builds,
            _scratch: scratch,
        }
    }

    fn open(&self, faults: &Injector<i32>) -> std::io::Result<Cache> {
        FileCache::open_with(
            Faulty::new(RealFs, faults),
            &self.store,
            Options::new(1 << 20),
        )
    }

    fn output(&self, name: &str, data: &[u8]) -> (Digest, PathBuf) {
        let path = self.builds.join(name);
        std::fs::write(&path, data).unwrap();
        (SHA256.digest(data), path)
    }
}

/// What a workload was told was done.
#[derive(Default)]
struct Acked {
    /// Blobs acknowledged as dirty.
    dirty: Vec<(Digest, Vec<u8>)>,
    /// Of those, the ones marked clean.
    marked: Vec<Digest>,
    failures: usize,
}

impl Acked {
    fn took(&mut self, data: &[u8], result: std::io::Result<Ingested>) {
        match result {
            Ok(Ingested::Added | Ingested::Already(Held::Dirty)) => {
                self.dirty.push((SHA256.digest(data), data.to_vec()))
            }
            Ok(Ingested::Already(Held::Clean)) => {}
            Err(_) => self.failures += 1,
        }
    }
}

/// Ingests, an upload, a fetch, a mark and reads, each tried whatever
/// became of the last.
fn workload(env: &Env, cache: &Cache) -> Acked {
    let runtime = runtime();
    let mut acked = Acked::default();
    let ingest = |name: &str, data: &[u8]| {
        let (digest, path) = env.output(name, data);
        runtime.block_on(cache.ingest(SHA256, &digest, &path))
    };
    let pair = runtime.block_on(async {
        let (a, a_path) = env.output("a", b"output a");
        let (b, b_path) = env.output("b", b"output b");
        futures::join!(
            cache.ingest(SHA256, &a, &a_path),
            cache.ingest(SHA256, &b, &b_path)
        )
    });
    acked.took(b"output a", pair.0);
    acked.took(b"output b", pair.1);
    acked.took(b"output c", ingest("c", b"output c"));

    let uploaded = runtime.block_on(async {
        let data = b"an upload in two pieces";
        let digest = SHA256.digest(data);
        let Some(mut upload) = cache.upload(SHA256, &digest).await? else {
            return Ok(Ingested::Already(Held::Dirty));
        };
        upload.write(&data[..10])?;
        upload.write(&data[10..])?;
        upload.finish().await
    });
    acked.took(b"an upload in two pieces", uploaded);

    let fetched = SHA256.digest(FETCHED);
    match runtime.block_on(cache.fetch(&Blobs, SHA256, &[fetched])) {
        Ok(pinned) => drop(pinned),
        Err(_) => acked.failures += 1,
    }

    let a = SHA256.digest(b"output a");
    if acked.dirty.iter().any(|(digest, _)| *digest == a) {
        match runtime.block_on(cache.mark_clean(SHA256, &[a])) {
            // Whether it moved or not, it is safe either way; it is
            // marked if the call says so.
            Ok(()) => acked.marked.push(a),
            Err(_) => acked.failures += 1,
        }
    }
    acked.took(b"output f", ingest("f", b"output f"));
    for (digest, data) in &acked.dirty {
        let copy = env.builds.join(format!("copy-{}", digest.hex()));
        match cache.copy_to(SHA256, digest, false, &copy, || ()) {
            Ok(()) => assert_eq!(std::fs::read(&copy).unwrap(), *data),
            Err(_) => acked.failures += 1,
        }
    }
    if runtime.block_on(cache.close()).is_err() {
        acked.failures += 1;
    }
    acked
}

/// Reopen without faults and check that everything acknowledged is held,
/// whole, and that nothing held is torn.
fn audit(env: &Env, acked: &Acked, context: &str) {
    let cache = env.open(&Injector::new()).unwrap();
    for (digest, data) in &acked.dirty {
        let held = cache.has(SHA256, digest);
        if acked.marked.contains(digest) {
            assert!(held.is_some(), "{context}: {digest} was lost");
        } else {
            assert_eq!(held, Some(Held::Dirty), "{context}: {digest} is not dirty");
        }
        let copy = env.builds.join(format!("audit-{}", digest.hex()));
        let _ = std::fs::remove_file(&copy);
        cache.copy_to(SHA256, digest, false, &copy, || ()).unwrap();
        assert_eq!(std::fs::read(&copy).unwrap(), *data, "{context}");
    }
    assert_eq!(cache.recovery().dropped, [], "{context}");
}

#[test]
fn every_fault_surfaces_and_loses_nothing_acknowledged() {
    let errnos = [libc::ENOSPC, libc::EIO];
    let mut reached = std::collections::BTreeSet::new();
    for point in FAULT_POINTS {
        for errno in errnos {
            for skip in 0..3 {
                let context = format!("{point} failing hit {skip} with errno {errno}");
                let env = Env::new();
                let faults = Injector::new();
                let cache = env.open(&faults).unwrap();
                let guard = faults
                    .point(point)
                    .scoped(
                        Action::Off
                            .times(skip)
                            .or_else(Action::Return(errno).times(1)),
                    )
                    .unwrap();
                let acked = workload(&env, &cache);
                // Selecting the skipping rule counts as triggering too.
                let fired = guard.snapshot().triggered > skip;
                if fired {
                    reached.insert(*point);
                }
                drop(guard);
                drop(cache);
                // Best-effort removals swallow their errors by design.
                if fired && *point != "fs.remove_file" {
                    assert!(acked.failures > 0, "{context}: the fault never surfaced");
                }
                audit(&env, &acked, &context);
            }
        }
    }
    // Directories are listed only on opening, which has its own test, and
    // files are read only where reflinks are not made.
    let unreached: Vec<&&str> = FAULT_POINTS
        .iter()
        .filter(|point| !reached.contains(*point))
        .filter(|point| !["fs.read_dir", "fs.metadata", "fs.read"].contains(point))
        .collect();
    assert_eq!(unreached, Vec::<&&str>::new());
}

#[test]
fn a_failed_data_sync_leaves_the_file_with_the_caller() {
    let env = Env::new();
    let faults = Injector::new();
    let cache = env.open(&faults).unwrap();
    let _guard = faults
        .point("fs.sync_data")
        .scoped(Action::Return(libc::ENOSPC).times(1))
        .unwrap();
    let (digest, path) = env.output("out", b"no room");
    let err = runtime()
        .block_on(cache.ingest(SHA256, &digest, &path))
        .unwrap_err();
    assert_eq!(err.raw_os_error(), Some(libc::ENOSPC));
    assert!(path.exists());
    assert_eq!(cache.has(SHA256, &digest), None);
    // And it can be tried again.
    let again = runtime().block_on(cache.ingest(SHA256, &digest, &path));
    assert_eq!(again.unwrap(), Ingested::Added);
}

#[test]
fn a_failed_directory_sync_fails_everything_until_reopened() {
    let env = Env::new();
    let faults = Injector::new();
    let cache = env.open(&faults).unwrap();
    let guard = faults
        .point("fs.sync_dir")
        .scoped(Action::Return(libc::EIO).times(1))
        .unwrap();
    let (digest, path) = env.output("out", b"unsure");
    let err = runtime()
        .block_on(cache.ingest(SHA256, &digest, &path))
        .unwrap_err();
    assert_eq!(
        err.kind(),
        std::io::Error::from_raw_os_error(libc::EIO).kind()
    );
    drop(guard);
    let (other, path) = env.output("other", b"later");
    let err = runtime()
        .block_on(cache.ingest(SHA256, &other, &path))
        .unwrap_err();
    assert!(err.to_string().contains("opened again"), "{err}");
    assert!(
        path.exists(),
        "a later ingest is refused before it moves its file"
    );
    assert!(runtime().block_on(cache.upload(SHA256, &other)).is_err());
    assert!(runtime().block_on(cache.close()).is_err());
    drop(cache);
    // Opening again syncs everything, so the first file, renamed in
    // before its sync failed, is durable and dirty now.
    let cache = env.open(&Injector::new()).unwrap();
    assert_eq!(cache.has(SHA256, &digest), Some(Held::Dirty));
    let again = runtime().block_on(cache.ingest(SHA256, &other, &path));
    assert_eq!(again.unwrap(), Ingested::Added);
}

#[test]
fn a_failed_write_fails_the_upload_and_leaves_nothing() {
    let env = Env::new();
    let faults = Injector::new();
    let cache = env.open(&faults).unwrap();
    let digest = SHA256.digest(b"too big");
    let mut upload = runtime()
        .block_on(cache.upload(SHA256, &digest))
        .unwrap()
        .unwrap();
    let _guard = faults
        .point("fs.write")
        .scoped(Action::Return(libc::ENOSPC).times(1))
        .unwrap();
    let err = upload.write(b"too big").unwrap_err();
    assert_eq!(err.raw_os_error(), Some(libc::ENOSPC));
    drop(upload);
    assert_eq!(
        std::fs::read_dir(env.store.join("partial"))
            .unwrap()
            .count(),
        0
    );
    assert_eq!(cache.has(SHA256, &digest), None);
}

#[test]
fn a_failed_open_can_be_tried_again() {
    for point in ["fs.read_dir", "fs.metadata", "fs.sync_fs", "fs.create_new"] {
        let env = Env::new();
        let cache = env.open(&Injector::new()).unwrap();
        let (digest, path) = env.output("out", b"kept");
        runtime()
            .block_on(cache.ingest(SHA256, &digest, &path))
            .unwrap();
        drop(cache);
        let faults = Injector::new();
        let _guard = faults
            .point(point)
            .scoped(Action::Return(libc::EIO).times(1))
            .unwrap();
        assert!(env.open(&faults).is_err(), "{point}");
        let cache = env.open(&faults).unwrap();
        assert_eq!(cache.has(SHA256, &digest), Some(Held::Dirty), "{point}");
    }
}

#[test]
fn every_fault_point_is_listed() {
    let faults = Injector::<i32>::new();
    let _ = Faulty::new(RealFs, &faults);
    assert_eq!(faults.points(), {
        let mut listed: Vec<String> = FAULT_POINTS.iter().map(|p| p.to_string()).collect();
        listed.sort();
        listed
    });
}
