// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! What the tests on the simulated filesystem share.

#![allow(dead_code)]

use std::collections::HashMap;
use std::io::Write as _;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

use anyhow::Result;
use reapi_cas::{Digest, DigestFn};

use crate::fs::Fs as _;
use crate::sim::SimFs;
use crate::{Fetch, FileCache, Options};

pub const SHA256: DigestFn = DigestFn::Sha256;

/// Where the store is on a simulated filesystem.
pub const STORE: &str = "/store";

/// Where tests copy files out of the store to.
pub const OUT: &str = "/out";

/// A runtime on this thread, so that runs on the simulated filesystem are
/// deterministic.
pub fn runtime() -> tokio::runtime::Runtime {
    tokio::runtime::Builder::new_current_thread()
        .enable_all()
        .build()
        .unwrap()
}

/// A simulated filesystem with an empty, durable `/out`.
pub fn sim() -> SimFs {
    let fs = SimFs::new();
    fs.create_dir(Path::new(OUT)).unwrap();
    fs.sync_fs(Path::new("/")).unwrap();
    fs
}

pub fn open(fs: &SimFs, options: Options) -> std::io::Result<FileCache<SimFs>> {
    FileCache::open_with(fs.clone(), Path::new(STORE), options)
}

/// Blobs in memory, written to files on a simulated filesystem.
pub struct SimBlobs {
    fs: SimFs,
    blobs: Mutex<HashMap<Digest, Vec<u8>>>,
    pub fetched: AtomicUsize,
}

impl SimBlobs {
    pub fn new(fs: &SimFs) -> Self {
        SimBlobs {
            fs: fs.clone(),
            blobs: Mutex::default(),
            fetched: AtomicUsize::new(0),
        }
    }

    pub fn put(&self, data: &[u8]) -> Digest {
        let digest = SHA256.digest(data);
        self.blobs.lock().unwrap().insert(digest, data.to_vec());
        digest
    }
}

impl Fetch for SimBlobs {
    async fn fetch_to_files(&self, _: DigestFn, blobs: Vec<(Digest, PathBuf)>) -> Result<()> {
        for (digest, path) in blobs {
            let data = self.blobs.lock().unwrap().get(&digest).cloned();
            let data = data.ok_or_else(|| anyhow::anyhow!("no blob {digest}"))?;
            self.fs.create_new(&path)?.write_all(&data)?;
            self.fetched.fetch_add(1, Ordering::Relaxed);
        }
        Ok(())
    }
}

/// The contents of the store's file with `digest`, as `copy_to` hands
/// them out.
pub fn copy_out(
    cache: &FileCache<SimFs>,
    fs: &SimFs,
    function: DigestFn,
    digest: &Digest,
) -> std::io::Result<Vec<u8>> {
    static NEXT: AtomicUsize = AtomicUsize::new(0);
    let dest = Path::new(OUT).join(NEXT.fetch_add(1, Ordering::Relaxed).to_string());
    cache.copy_to(function, digest, false, &dest, || ())?;
    fs.read(&dest)
}

/// A crash that keeps every directory change but no unsynced data.
pub fn keep_names_lose_data(n: u64) -> u64 {
    if n == 2 { 1 } else { 0 }
}
