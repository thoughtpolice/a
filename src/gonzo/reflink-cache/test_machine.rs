// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! A cache on a simulated filesystem, driven through random operations,
//! power losses, kills, faults and reopenings, and checked against a
//! model of what it acknowledged. Hegel drives it in `test_crash`, and
//! fozzie in the `fuzz-machine` target, through [`Draw`].
//!
//! It checks that:
//!
//! - (a, e) every acknowledged dirty file survives any crash, whole, and
//!   is in the dirty list, unless it was marked clean since; a crash in
//!   a run without durability may lose what that run acknowledged;
//! - (b) no dirty file is ever evicted;
//! - (c) the cache is within its size, or every clean file is pinned;
//! - (d) everything the cache hands out or lists, before and after any
//!   reopening, is its blob, with durability on or off; and with only
//!   durable runs since the last sync, recovery finds nothing torn;
//! - (f) the dirty bytes are exactly the dirty files' sizes, over the cap
//!   exactly when they exceed it, and a wait for room is over exactly
//!   when they do not;
//! - and with no fault or crash armed, nothing fails.

#![allow(dead_code)]

use std::collections::{BTreeMap, BTreeSet};
use std::io::{Read as _, Write as _};
use std::path::{Path, PathBuf};

use futures::FutureExt as _;

use crate::faults::{FAULT_POINTS, Faulty};
use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::{Fetch, FileCache, Held, Ingested, Options, Pinned};

use faultline::{Action, Injector};
use reapi_cas::{Digest, DigestFn};

/// Where choices come from.
pub trait Draw {
    /// A number below `n`, which is at least 1.
    fn below(&mut self, n: u64) -> u64;

    fn chance(&mut self, one_in: u64) -> bool {
        self.below(one_in) == 0
    }
}

type Cache = FileCache<Faulty<SimFs>>;

const FUNCTION: DigestFn = DigestFn::Sha256;
const STORE: &str = "/store";
const BUILDS: &str = "/builds";
/// A filesystem of its own, so that taking files in from it copies them.
const OTHER: &str = "/other";
const OUT: &str = "/out";
const BLOBS: usize = 10;
/// A size the blobs overflow, so that clean files are evicted, and one
/// they never fill, in which nothing is.
const SIZES: [u64; 2] = [96, 1 << 20];
const STORES: [&str; 2] = ["store-1", "store-2"];

/// The blobs the machine uses, few and small so that operations collide
/// and the cache fills.
fn blob(i: usize) -> Vec<u8> {
    let len = (i * 7) % 29 + i % 2;
    (0..len).map(|j| (i * 31 + j * 7) as u8).collect()
}

/// The fetch source: every blob, written on the machine's filesystem.
struct Source {
    fs: SimFs,
    blobs: BTreeMap<Digest, Vec<u8>>,
}

impl Fetch for Source {
    async fn fetch_to_files(
        &self,
        _: DigestFn,
        blobs: Vec<(Digest, PathBuf)>,
    ) -> anyhow::Result<()> {
        for (digest, path) in blobs {
            self.fs.create_new(&path)?.write_all(&self.blobs[&digest])?;
        }
        Ok(())
    }
}

/// What the model expects of a blob.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Expect {
    /// Acknowledged dirty and not marked clean since: dirty while the
    /// cache is open, and after reopening if `durable`.
    Dirty { durable: bool },
    /// Marked clean, or a mark was tried: dirty or clean, unless evicted,
    /// and after reopening if `durable`: if the file was durable, and
    /// marked by a run with durability, which makes the directories it
    /// moves into durable. (A file kept elsewhere that is lost is only a
    /// copy lost.)
    Marked { durable: bool },
}

pub struct Machine {
    fs: SimFs,
    faults: Injector<i32>,
    cache: Option<Cache>,
    runtime: tokio::runtime::Runtime,
    source: Source,
    digests: Vec<Digest>,
    durable: bool,
    max_bytes: u64,
    pins: Vec<(Pinned<Faulty<SimFs>>, Vec<Digest>)>,
    expect: BTreeMap<Digest, Expect>,
    /// Whether a fault or a crash is armed, so that a call may fail.
    troubled: bool,
    /// Whether a run without durability has written since the last sync,
    /// so that a power loss may tear files.
    tearable: bool,
    /// Whether the power was lost since the last opening.
    lost_power: bool,
    next_file: u64,
    pub log: Vec<String>,
}

impl Machine {
    pub fn new(draw: &mut impl Draw) -> Self {
        let fs = SimFs::new();
        for dir in [BUILDS, OUT] {
            fs.create_dir(Path::new(dir)).unwrap();
        }
        fs.add_device(Path::new(OTHER)).unwrap();
        fs.sync_fs(Path::new("/")).unwrap();
        let digests: Vec<Digest> = (0..BLOBS).map(|i| FUNCTION.digest(&blob(i))).collect();
        let source = Source {
            fs: fs.clone(),
            blobs: (0..BLOBS).map(|i| (digests[i], blob(i))).collect(),
        };
        let mut machine = Machine {
            faults: Injector::new(),
            cache: None,
            runtime: tokio::runtime::Builder::new_current_thread()
                .enable_all()
                .build()
                .unwrap(),
            source,
            digests,
            durable: draw.below(4) != 0,
            max_bytes: SIZES[draw.below(2) as usize],
            pins: Vec::new(),
            expect: BTreeMap::new(),
            troubled: false,
            tearable: false,
            lost_power: false,
            next_file: 0,
            log: Vec::new(),
            fs,
        };
        machine.reopen(draw);
        machine
    }

    fn cache(&self) -> &Cache {
        self.cache
            .as_ref()
            .expect("the cache is open between steps")
    }

    fn options(&self) -> Options {
        let mut options = Options::new(self.max_bytes);
        options.durable = self.durable;
        options
    }

    fn data(&self, digest: &Digest) -> &[u8] {
        &self.source.blobs[digest]
    }

    fn pick_blob(&self, draw: &mut impl Draw) -> Digest {
        self.digests[draw.below(BLOBS as u64) as usize]
    }

    /// A call that failed, which only a fault or a crash may make fail.
    fn failed(&self, what: &str, error: &dyn std::fmt::Display) {
        assert!(self.troubled, "{what} failed untroubled: {error}");
    }

    /// One step: an operation, then the checks.
    pub fn step(&mut self, draw: &mut impl Draw) {
        match draw.below(16) {
            0..=3 => self.ingest(draw),
            4 => self.upload(draw),
            5 => self.bad_upload(draw),
            6 | 7 => self.fetch(draw),
            8 => self.unpin(draw),
            9 => self.mark_clean(draw),
            10 => self.join_or_vouch(draw),
            11 => self.arm_fault(draw),
            12 => self.arm_crash(draw),
            13 => self.power_loss(draw),
            14 => self.kill(draw),
            _ => self.close(draw),
        }
        if self.fs.crashed() {
            self.log.push("crashed mid-step".into());
            self.lose_power(draw);
        }
        self.check();
    }

    fn new_file(&mut self, dir: &str, data: &[u8]) -> Option<PathBuf> {
        self.next_file += 1;
        let path = Path::new(dir).join(self.next_file.to_string());
        // Making the file can crash too: then there is nothing to take in.
        let mut file = self.fs.create_new(&path).ok()?;
        file.write_all(data).ok()?;
        Some(path)
    }

    fn took(&mut self, digest: Digest, result: std::io::Result<Ingested>, unvouched: bool) {
        match result {
            Ok(Ingested::Added | Ingested::Already(Held::Dirty)) => {
                let durable = self.durable
                    || matches!(
                        self.expect.get(&digest),
                        Some(Expect::Dirty { durable: true })
                    );
                self.expect.insert(digest, Expect::Dirty { durable });
            }
            Ok(Ingested::Already(Held::Clean)) => {
                assert!(!unvouched, "{digest} is plain cache, yet counted as held");
            }
            Err(e) => self.failed("taking in", &e),
        }
    }

    /// A run without durability that takes in a blob marked clean, which
    /// may be plain cache, replaces it without making either durable: a
    /// crash may lose both.
    fn taking_in(&mut self, digest: &Digest) {
        if !self.durable
            && let Some(Expect::Marked { durable }) = self.expect.get_mut(digest)
        {
            *durable = false;
        }
    }

    fn unvouched(&self) -> BTreeSet<Digest> {
        self.cache()
            .unvouched()
            .into_iter()
            .map(|(_, digest)| digest)
            .collect()
    }

    fn ingest(&mut self, draw: &mut impl Draw) {
        let count = 1 + draw.below(3) as usize;
        let mut files = Vec::new();
        for _ in 0..count {
            let digest = self.pick_blob(draw);
            let dir = if draw.chance(4) { OTHER } else { BUILDS };
            let data = self.data(&digest).to_vec();
            if let Some(path) = self.new_file(dir, &data) {
                files.push((digest, path));
            }
        }
        self.log.push(format!("ingest {} files", files.len()));
        for (digest, _) in &files {
            self.taking_in(digest);
        }
        let unvouched = self.unvouched();
        let cache = self.cache.as_ref().unwrap();
        let results = self.runtime.block_on(futures::future::join_all(
            files
                .iter()
                .map(|(digest, path)| cache.ingest(FUNCTION, digest, path)),
        ));
        for ((digest, _), result) in files.into_iter().zip(results) {
            self.took(digest, result, unvouched.contains(&digest));
        }
    }

    fn upload(&mut self, draw: &mut impl Draw) {
        let digest = self.pick_blob(draw);
        let data = self.data(&digest).to_vec();
        let piece = 1 + draw.below(16) as usize;
        self.log
            .push(format!("upload {digest} in pieces of {piece}"));
        self.taking_in(&digest);
        let unvouched = self.unvouched().contains(&digest);
        let cache = self.cache.as_ref().unwrap();
        let result = self.runtime.block_on(async {
            let Some(mut upload) = cache.upload(FUNCTION, &digest).await? else {
                return Ok(None);
            };
            for chunk in data.chunks(piece) {
                upload.write(chunk)?;
            }
            upload.finish().await.map(Some)
        });
        match result {
            Ok(None) => {
                // Held already, durably; a dirty one stays expected.
                let held = self.cache().has(FUNCTION, &digest);
                assert!(held.is_some(), "an upload of {digest} was needless");
                assert!(!unvouched, "{digest} is plain cache, yet counted as held");
            }
            Ok(Some(ingested)) => self.took(digest, Ok(ingested), unvouched),
            Err(e) => self.failed("uploading", &e),
        }
    }

    fn bad_upload(&mut self, draw: &mut impl Draw) {
        let digest = self.pick_blob(draw);
        let mut data = self.data(&digest).to_vec();
        if data.is_empty() || draw.chance(2) {
            data.push(0);
        } else {
            data[0] ^= 1;
        }
        self.log.push(format!("bad upload of {digest}"));
        let held = self.cache().has(FUNCTION, &digest);
        let cache = self.cache.as_ref().unwrap();
        let result = self.runtime.block_on(async {
            let Some(mut upload) = cache.upload(FUNCTION, &digest).await? else {
                return Ok(None);
            };
            upload.write(&data)?;
            upload.finish().await.map(Some)
        });
        match result {
            Ok(None) => {}
            Ok(Some(ingested)) => panic!("a bad upload of {digest} was taken: {ingested:?}"),
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {}
            Err(e) => self.failed("a bad upload", &e),
        }
        assert_eq!(self.cache().has(FUNCTION, &digest), held);
    }

    fn fetch(&mut self, draw: &mut impl Draw) {
        let count = 1 + draw.below(4) as usize;
        let digests: Vec<Digest> = (0..count).map(|_| self.pick_blob(draw)).collect();
        let keep = draw.chance(2);
        self.log
            .push(format!("fetch {count}, keeping the pins: {keep}"));
        let cache = self.cache.as_ref().unwrap();
        let fetched = self
            .runtime
            .block_on(cache.fetch(&self.source, FUNCTION, &digests));
        match fetched {
            Ok(pinned) => {
                for digest in &digests {
                    self.served(digest);
                }
                if keep {
                    self.pins.push((pinned, digests));
                }
            }
            Err(e) => self.failed("fetching", &e),
        }
    }

    fn unpin(&mut self, draw: &mut impl Draw) {
        if !self.pins.is_empty() {
            let i = draw.below(self.pins.len() as u64) as usize;
            self.log.push(format!("unpin {i}"));
            drop(self.pins.remove(i));
        }
    }

    fn mark_clean(&mut self, draw: &mut impl Draw) {
        let mut digests: Vec<Digest> = self
            .expect
            .iter()
            .filter(|(_, expect)| matches!(expect, Expect::Dirty { .. }))
            .map(|(digest, _)| *digest)
            .filter(|_| draw.chance(2))
            .collect();
        if draw.chance(3) {
            digests.push(self.pick_blob(draw));
        }
        self.log.push(format!("mark {} clean", digests.len()));
        let cache = self.cache.as_ref().unwrap();
        let result = self.runtime.block_on(cache.mark_clean(FUNCTION, &digests));
        // Tried or done, the files may be either.
        for digest in &digests {
            if let Some(expected) = self.expect.get_mut(digest) {
                let durable = match *expected {
                    Expect::Dirty { durable } | Expect::Marked { durable } => durable,
                };
                *expected = Expect::Marked {
                    durable: durable && self.durable,
                };
            }
        }
        if let Err(e) = result {
            self.failed("marking clean", &e);
        }
    }

    fn join_or_vouch(&mut self, draw: &mut impl Draw) {
        let cache = self.cache.as_ref().unwrap();
        if draw.chance(2) {
            let store = STORES[draw.below(2) as usize];
            self.log.push(format!("join {store}"));
            match self.runtime.block_on(cache.join(store)) {
                // Joining another store takes back every clean file's
                // vouching; joining the same one again changes nothing.
                Ok(unvouched) if !unvouched.is_empty() => {
                    let unvouched: BTreeSet<Digest> =
                        unvouched.into_iter().map(|(_, digest)| digest).collect();
                    assert_eq!(unvouched, self.unvouched());
                    let clean = self.cache().clean_files().into_iter().map(|n| n.1);
                    assert_eq!(unvouched, clean.collect());
                }
                Ok(_) => {}
                Err(e) => self.failed("joining", &e),
            }
        } else {
            let vouched: Vec<Digest> = self
                .unvouched()
                .into_iter()
                .filter(|_| draw.chance(2))
                .collect();
            self.log.push(format!("vouch for {}", vouched.len()));
            let cache = self.cache.as_ref().unwrap();
            if let Err(e) = self.runtime.block_on(cache.vouch(FUNCTION, &vouched)) {
                self.failed("vouching", &e);
            }
        }
    }

    fn arm_fault(&mut self, draw: &mut impl Draw) {
        let point = FAULT_POINTS[draw.below(FAULT_POINTS.len() as u64) as usize];
        let errno = [libc::EIO, libc::ENOSPC][draw.below(2) as usize];
        let skip = draw.below(4);
        self.log
            .push(format!("fault {point} after {skip} with {errno}"));
        self.faults
            .point(point)
            .set(
                Action::Off
                    .times(skip)
                    .or_else(Action::Return(errno).times(1)),
            )
            .unwrap();
        self.troubled = true;
    }

    fn arm_crash(&mut self, draw: &mut impl Draw) {
        let calls = draw.below(40);
        self.log.push(format!("crash after {calls} calls"));
        self.fs.crash_after(calls);
        self.troubled = true;
    }

    fn power_loss(&mut self, draw: &mut impl Draw) {
        self.log.push("power loss".into());
        self.lose_power(draw);
    }

    /// Lose power now and come back: whatever was mid-way stops.
    fn lose_power(&mut self, draw: &mut impl Draw) {
        self.pins.clear();
        self.cache = None;
        self.crash(draw);
        self.reopen(draw);
    }

    /// Restart the simulated machine after a power loss. Choices made one
    /// by one rarely line up into the worst crashes, which keep every
    /// name and none of the data under it, so a strategy is drawn first.
    fn crash(&mut self, draw: &mut impl Draw) {
        let strategy = draw.below(5);
        self.log.push(format!("crash, strategy {strategy}"));
        self.fs.crash(&mut |n| match (strategy, n) {
            // Keep every name, and of each unsynced file, its size with
            // zeroes for data.
            (0, 2) => 1,
            (0, 4) => 3,
            (0, _) => 0,
            // Keep every name, and the data however it falls.
            (1, 2) => 1,
            // Keep nothing that was not durable.
            (2, _) => 0,
            // Keep everything.
            (3, _) => n - 1,
            _ => draw.below(n),
        });
        self.lost_power = true;
    }

    /// Kill the process: nothing is lost, but nothing was closed.
    fn kill(&mut self, draw: &mut impl Draw) {
        self.log.push("kill".into());
        self.pins.clear();
        self.cache = None;
        self.reopen(draw);
    }

    fn close(&mut self, draw: &mut impl Draw) {
        self.log.push("close".into());
        self.pins.clear();
        let cache = self.cache.take().unwrap();
        match self.runtime.block_on(cache.close()) {
            Ok(()) => self.tearable = false,
            Err(e) => self.failed("closing", &e),
        }
        // A closed cache refuses to write.
        assert!(
            self.runtime
                .block_on(cache.mark_clean(FUNCTION, &[]))
                .is_err()
        );
        drop(cache);
        if self.fs.crashed() {
            self.lose_power(draw);
        } else {
            self.reopen(draw);
        }
    }

    /// Open the cache again, maybe with the other durability, maybe
    /// crashing while it checks what it finds, then check what it found.
    fn reopen(&mut self, draw: &mut impl Draw) {
        self.faults.clear();
        self.troubled = false;
        if draw.chance(4) {
            self.durable = !self.durable;
        }
        if draw.chance(6) {
            let calls = draw.below(30);
            self.log
                .push(format!("crash reopening after {calls} calls"));
            self.fs.crash_after(calls);
        }
        let cache = loop {
            match FileCache::open_with(
                Faulty::new(self.fs.clone(), &self.faults),
                Path::new(STORE),
                self.options(),
            ) {
                Ok(cache) => break cache,
                Err(e) => {
                    assert!(self.fs.crashed(), "opening failed: {e}");
                    self.crash(draw);
                }
            }
        };
        self.fs.no_crash();
        let tearable = self.tearable && self.lost_power;
        self.log.push(format!("opened, durable {}", self.durable));
        let recovery = cache.recovery().clone();
        if !tearable {
            assert_eq!(recovery.dropped, [], "nothing could be torn");
        }
        self.cache = Some(cache);
        self.tearable = !self.durable;
        self.lost_power = false;

        let dirty: BTreeSet<Digest> = self
            .cache()
            .dirty_files()
            .into_iter()
            .map(|(_, digest)| digest)
            .collect();
        let expect = std::mem::take(&mut self.expect);
        for (digest, expected) in expect {
            let held = self.cache().has(FUNCTION, &digest);
            match (expected, held) {
                (Expect::Dirty { durable: true }, _) => {
                    assert_eq!(held, Some(Held::Dirty), "acknowledged {digest} was lost");
                    assert!(dirty.contains(&digest), "{digest} is not listed dirty");
                }
                (Expect::Marked { durable: true }, None) => {
                    assert!(self.max_bytes < SIZES[1], "marked {digest} was lost");
                    continue;
                }
                (_, None) => continue,
                // Taken in over a clean file that was plain cache, by a
                // run whose rename into the dirty area was lost.
                (Expect::Dirty { durable: false }, Some(Held::Clean)) => continue,
                _ => {}
            }
            // Opening synced it.
            let expected = match expected {
                Expect::Dirty { .. } => Expect::Dirty { durable: true },
                Expect::Marked { .. } => Expect::Marked { durable: true },
            };
            self.expect.insert(digest, expected);
        }
        self.audit();
    }

    /// Everything the cache holds is its blob, read every way it is.
    fn audit(&mut self) {
        let cache = self.cache();
        let mut held: Vec<Digest> = cache.dirty_files().into_iter().map(|n| n.1).collect();
        held.extend(cache.clean_files().into_iter().map(|n| n.1));
        for digest in held {
            assert!(
                self.source.blobs.contains_key(&digest),
                "{digest} is no blob"
            );
            self.served(&digest);
            let mut read = Vec::new();
            self.cache()
                .open_file(FUNCTION, &digest)
                .unwrap()
                .read_to_end(&mut read)
                .unwrap();
            assert_eq!(read, self.data(&digest), "{digest} reads torn");
        }
    }

    /// Check what `copy_to` hands out for `digest`, if the cache holds it.
    fn served(&mut self, digest: &Digest) {
        self.next_file += 1;
        let dest = Path::new(OUT).join(self.next_file.to_string());
        match self.cache().copy_to(FUNCTION, digest, false, &dest, || ()) {
            Ok(()) => assert_eq!(self.fs.read(&dest).unwrap(), self.data(digest)),
            Err(e) => {
                if !self.fs.crashed() {
                    self.failed("copying out", &e);
                }
            }
        }
    }

    /// The checks after every step.
    fn check(&self) {
        let cache = self.cache();
        for (digest, expected) in &self.expect {
            let held = cache.has(FUNCTION, digest);
            match expected {
                Expect::Dirty { .. } => {
                    assert_eq!(held, Some(Held::Dirty), "dirty {digest} was evicted")
                }
                Expect::Marked { .. } if self.max_bytes == SIZES[1] => {
                    assert!(
                        held.is_some(),
                        "marked {digest} went though nothing is evicted"
                    )
                }
                Expect::Marked { .. } => {}
            }
        }
        let usage = cache.usage();
        let dirty = cache.dirty_files();
        let clean = cache.clean_files();
        assert_eq!(usage.dirty_files, dirty.len());
        assert_eq!(usage.clean_files, clean.len());
        assert_eq!(
            usage.dirty_bytes,
            dirty.iter().map(|n| n.1.size).sum::<u64>()
        );
        assert_eq!(
            usage.clean_bytes,
            clean.iter().map(|n| n.1.size).sum::<u64>()
        );
        assert_eq!(usage.dirty_cap, self.max_bytes / 4);
        assert_eq!(usage.over_dirty_cap(), usage.dirty_bytes > usage.dirty_cap);
        assert_eq!(
            cache.below_dirty_cap().now_or_never().is_some(),
            !usage.over_dirty_cap()
        );
        if usage.clean_bytes + usage.dirty_bytes > self.max_bytes {
            let pinned: BTreeSet<&Digest> = self.pins.iter().flat_map(|(_, d)| d).collect();
            for (_, digest) in &clean {
                assert!(pinned.contains(digest), "over size, yet {digest} is kept");
            }
        }
    }

    /// The end: stop one way or another, and check once more.
    pub fn finish(&mut self, draw: &mut impl Draw) {
        match draw.below(3) {
            0 => self.close(draw),
            1 => self.kill(draw),
            _ => self.power_loss(draw),
        }
        self.check();
    }
}
