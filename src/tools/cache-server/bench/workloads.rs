// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! The loads cache-bench applies. Every read is checked against the digest
//! it asked for, and every FindMissingBlobs answer against what is known to
//! be stored, so a run doubles as a correctness check under load.

use std::collections::HashSet;
use std::time::Instant;

use bytes::Bytes;
use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{
    ActionResult, Digest, Directory, DirectoryNode, FileNode, FindMissingBlobsRequest,
    GetActionResultRequest, GetTreeRequest, OutputFile, UpdateActionResultRequest,
};

use crate::data::{Blob, Contents, Rng, absent_digest, digest_of};
use crate::rpc::{BATCH_BYTES, Clients, batch_update};
use crate::run::{Recorder, Workload};

/// Ids of generated blobs: `tag` keeps the streams of different purposes
/// apart, `worker` those of different workers.
fn id(tag: u64, worker: usize, n: u64) -> u64 {
    (tag << 56) | ((worker as u64) << 36) | n
}

const TAG_UPLOAD: u64 = 1;
const TAG_BS_WRITE: u64 = 2;
const TAG_OUTPUT: u64 = 3;

// ---------------------------------------------------------------------------------------------------------------------

/// BatchUpdateBlobs of blobs never stored before.
pub struct Upload {
    pub clients: Clients,
    pub seed: u64,
    pub batch: usize,
    pub min_size: usize,
    pub max_size: usize,
    pub contents: Contents,
}

pub struct UploadState {
    worker: usize,
    rng: Rng,
    n: u64,
}

impl Workload for Upload {
    type State = UploadState;

    fn state(&self, worker: usize) -> UploadState {
        UploadState {
            worker,
            rng: Rng::keyed(&[self.seed, TAG_UPLOAD, worker as u64]),
            n: 0,
        }
    }

    async fn step(&self, st: &mut UploadState, rec: &mut Recorder) {
        let mut blobs: Vec<Blob> = Vec::with_capacity(self.batch);
        let mut batch_bytes = 0;
        while blobs.len() < self.batch {
            let size = st.rng.between(self.min_size as u64, self.max_size as u64) as usize;
            if batch_bytes + size > BATCH_BYTES && !blobs.is_empty() {
                break;
            }
            st.n += 1;
            batch_bytes += size;
            blobs.push(Blob::new(
                self.seed,
                id(TAG_UPLOAD, st.worker, st.n),
                size,
                self.contents,
            ));
        }
        let bytes: u64 = blobs.iter().map(|b| b.data.len() as u64).sum();
        let refs: Vec<&Blob> = blobs.iter().collect();
        let req = batch_update(&self.clients.instance, &refs);
        let t = Instant::now();
        let resp = self.clients.cas(st.worker).batch_update_blobs(req).await;
        match resp {
            Ok(resp) => {
                let bad = resp
                    .into_inner()
                    .responses
                    .into_iter()
                    .find(|r| r.status.as_ref().map_or(-1, |s| s.code) != 0);
                match bad {
                    None => rec.ok("BatchUpdateBlobs", t, bytes),
                    Some(r) => {
                        let s = r.status.unwrap_or_default();
                        rec.err(
                            "BatchUpdateBlobs",
                            t,
                            &tonic::Status::new(tonic::Code::from(s.code), s.message),
                        );
                    }
                }
            }
            Err(status) => rec.err("BatchUpdateBlobs", t, &status),
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// FindMissingBlobs over a stored corpus mixed with digests never stored,
/// checking the answer names exactly the latter.
pub struct FindMissing {
    pub clients: Clients,
    pub seed: u64,
    pub corpus: Vec<Digest>,
    pub batch: usize,
    pub hit_ratio: f64,
}

impl Workload for FindMissing {
    type State = (usize, Rng);

    fn state(&self, worker: usize) -> (usize, Rng) {
        (worker, Rng::keyed(&[self.seed, 0xf3, worker as u64]))
    }

    async fn step(&self, (worker, rng): &mut (usize, Rng), rec: &mut Recorder) {
        let hits = (self.batch as f64 * self.hit_ratio).round() as usize;
        let mut digests = Vec::with_capacity(self.batch);
        let mut absent = HashSet::new();
        for _ in 0..hits {
            digests.push(self.corpus[rng.below(self.corpus.len() as u64) as usize].clone());
        }
        for _ in hits..self.batch {
            let d = absent_digest(self.seed, rng.next_u64());
            absent.insert(d.hash.clone());
            digests.push(d);
        }
        let t = Instant::now();
        let resp = self
            .clients
            .cas(*worker)
            .find_missing_blobs(FindMissingBlobsRequest {
                instance_name: self.clients.instance.clone(),
                blob_digests: digests,
                digest_function: 0,
            })
            .await;
        rec.result("FindMissingBlobs", t, &resp, |_| 0);
        if let Ok(resp) = resp {
            let missing: HashSet<String> = resp
                .into_inner()
                .missing_blob_digests
                .into_iter()
                .map(|d| d.hash)
                .collect();
            rec.verify(missing == absent, || {
                format!(
                    "FindMissingBlobs: {} reported missing, {} absent, {} in common",
                    missing.len(),
                    absent.len(),
                    missing.intersection(&absent).count()
                )
            });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// BatchReadBlobs of a stored corpus, checking every blob.
pub struct BatchRead {
    pub clients: Clients,
    pub seed: u64,
    pub corpus: Vec<Digest>,
    pub batch: usize,
    pub zstd: bool,
}

impl Workload for BatchRead {
    type State = (usize, Rng);

    fn state(&self, worker: usize) -> (usize, Rng) {
        (worker, Rng::keyed(&[self.seed, 0xb7, worker as u64]))
    }

    async fn step(&self, (worker, rng): &mut (usize, Rng), rec: &mut Recorder) {
        let mut digests = Vec::with_capacity(self.batch);
        let mut bytes = 0;
        while digests.len() < self.batch {
            let d = &self.corpus[rng.below(self.corpus.len() as u64) as usize];
            if bytes + d.size_bytes as usize > BATCH_BYTES {
                break;
            }
            bytes += d.size_bytes as usize;
            digests.push(d.clone());
        }
        let n = digests.len();
        let t = Instant::now();
        let resp = self.clients.batch_read(*worker, digests, self.zstd).await;
        rec.result("BatchReadBlobs", t, &resp, |(wire, _)| *wire);
        if let Ok((_, bad)) = resp {
            for b in &bad {
                rec.verify(false, || format!("BatchReadBlobs: {b}"));
            }
            for _ in bad.len()..n {
                rec.verify(true, String::new);
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// ByteStream writes: of new blobs, or (`pool` > 0) again and again of the
/// same few, which a server may answer before taking them in.
pub struct BsWrite {
    pub clients: Clients,
    pub seed: u64,
    pub size: usize,
    pub contents: Contents,
    pub zstd: bool,
    pub pool: Vec<(Blob, Option<Bytes>)>,
}

pub struct BsWriteState {
    worker: usize,
    rng: Rng,
    n: u64,
}

impl Workload for BsWrite {
    type State = BsWriteState;

    fn state(&self, worker: usize) -> BsWriteState {
        BsWriteState {
            worker,
            rng: Rng::keyed(&[self.seed, TAG_BS_WRITE, worker as u64]),
            n: 0,
        }
    }

    async fn step(&self, st: &mut BsWriteState, rec: &mut Recorder) {
        let (blob, packed) = if self.pool.is_empty() {
            st.n += 1;
            let blob = Blob::new(
                self.seed,
                id(TAG_BS_WRITE, st.worker, st.n),
                self.size,
                self.contents,
            );
            let packed = self
                .zstd
                .then(|| Bytes::from(zstd::bulk::compress(&blob.data, 1).expect("zstd")));
            (blob, packed)
        } else {
            self.pool[st.rng.below(self.pool.len() as u64) as usize].clone()
        };
        let wire = packed.as_ref().map_or(blob.data.len(), Bytes::len) as u64;
        let t = Instant::now();
        let resp = self
            .clients
            .bs_write(st.worker, &blob, packed.as_ref(), &mut st.rng)
            .await;
        rec.result("ByteStream.Write", t, &resp, |_| wire);
        if let Ok(committed) = resp {
            let expected = if packed.is_some() {
                // A compressed upload reports the bytes sent, or -1 when the
                // server already had the blob.
                committed == -1 || committed == wire as i64
            } else {
                committed == blob.digest.size_bytes
            };
            rec.verify(expected, || {
                format!("ByteStream.Write: committed {committed} of {wire} bytes")
            });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// ByteStream reads of a stored corpus, checking every blob.
pub struct BsRead {
    pub clients: Clients,
    pub seed: u64,
    pub corpus: Vec<Digest>,
    pub zstd: bool,
    pub hold: Option<std::time::Duration>,
}

impl Workload for BsRead {
    type State = (usize, Rng);

    fn state(&self, worker: usize) -> (usize, Rng) {
        (worker, Rng::keyed(&[self.seed, 0xbe, worker as u64]))
    }

    async fn step(&self, (worker, rng): &mut (usize, Rng), rec: &mut Recorder) {
        let d = &self.corpus[rng.below(self.corpus.len() as u64) as usize];
        let t = Instant::now();
        let resp = self.clients.bs_read(*worker, d, self.zstd, self.hold).await;
        rec.result("ByteStream.Read", t, &resp, |(wire, _)| *wire);
        if let Ok((_, ok)) = resp {
            rec.verify(ok, || {
                format!("ByteStream.Read: {} did not check out", d.hash)
            });
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// The action digest of action `i`.
pub fn action_digest(seed: u64, i: u64) -> Digest {
    digest_of(format!("cache-bench action {seed} {i}").as_bytes())
}

/// The ActionResult action `i` gets: `outputs` files from `pool`.
pub fn action_result(i: u64, outputs: usize, pool: &[Digest]) -> ActionResult {
    ActionResult {
        output_files: (0..outputs)
            .map(|j| OutputFile {
                path: format!("out/{i}/{j}"),
                digest: Some(pool[((i as usize) * outputs + j) % pool.len()].clone()),
                is_executable: j == 0,
                ..Default::default()
            })
            .collect(),
        exit_code: 0,
        ..Default::default()
    }
}

/// GetActionResult over stored entries, with some UpdateActionResult.
pub struct ActionCache {
    pub clients: Clients,
    pub seed: u64,
    pub entries: u64,
    pub outputs: usize,
    pub pool: Vec<Digest>,
    pub write_ratio: f64,
}

impl Workload for ActionCache {
    type State = (usize, Rng);

    fn state(&self, worker: usize) -> (usize, Rng) {
        (worker, Rng::keyed(&[self.seed, 0xac, worker as u64]))
    }

    async fn step(&self, (worker, rng): &mut (usize, Rng), rec: &mut Recorder) {
        let i = rng.below(self.entries);
        let action = action_digest(self.seed, i);
        let expected = action_result(i, self.outputs, &self.pool);
        let mut ac = self.clients.ac(*worker);
        if rng.chance(self.write_ratio) {
            let t = Instant::now();
            let resp = ac
                .update_action_result(UpdateActionResultRequest {
                    instance_name: self.clients.instance.clone(),
                    action_digest: Some(action),
                    action_result: Some(expected),
                    results_cache_policy: None,
                    digest_function: 0,
                })
                .await;
            rec.result("UpdateActionResult", t, &resp, |_| 0);
        } else {
            let t = Instant::now();
            let resp = ac
                .get_action_result(GetActionResultRequest {
                    instance_name: self.clients.instance.clone(),
                    action_digest: Some(action),
                    inline_stdout: false,
                    inline_stderr: false,
                    inline_output_files: vec![],
                    digest_function: 0,
                })
                .await;
            rec.result("GetActionResult", t, &resp, |_| 0);
            if let Ok(resp) = resp {
                let got = resp.into_inner();
                rec.verify(got.output_files == expected.output_files, || {
                    format!("GetActionResult {i}: outputs differ")
                });
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// A build: each step runs an action the way a client with a remote cache
/// does. A hit downloads the action's outputs; a miss checks which inputs
/// the cache lacks, uploads them, "executes", uploads the outputs, and
/// records the result. The hit rate climbs as the run fills the cache.
pub struct Build {
    pub clients: Clients,
    pub seed: u64,
    pub actions: u64,
    pub inputs: usize,
    /// Input blob sizes, by pool index.
    pub pool_sizes: Vec<usize>,
    pub pool: Vec<Digest>,
    pub outputs: usize,
    pub min_size: usize,
    pub max_size: usize,
    pub contents: Contents,
}

impl Build {
    const TAG_INPUT: u64 = 4;

    fn input(&self, i: usize) -> Blob {
        Blob::new(
            self.seed,
            id(Self::TAG_INPUT, 0, i as u64),
            self.pool_sizes[i],
            self.contents,
        )
    }

    /// The inputs of action `a`: a skewed draw from the pool, so some
    /// inputs (headers, toolchains) are shared by most actions.
    fn inputs_of(&self, a: u64) -> Vec<usize> {
        let mut rng = Rng::keyed(&[self.seed, 0x1a, a]);
        let n = self.pool.len() as u64;
        (0..self.inputs)
            .map(|_| {
                // Squaring a uniform draw favors low indices.
                let u = rng.below(n);
                ((u * u) / n) as usize
            })
            .collect()
    }

    fn outputs_of(&self, a: u64) -> Vec<Blob> {
        let mut rng = Rng::keyed(&[self.seed, 0x0f, a]);
        (0..self.outputs)
            .map(|j| {
                let size = rng.between(self.min_size as u64, self.max_size as u64) as usize;
                Blob::new(
                    self.seed,
                    id(TAG_OUTPUT, 0, a * self.outputs as u64 + j as u64),
                    size,
                    self.contents,
                )
            })
            .collect()
    }

    /// Upload `blobs` in requests of at most [`BATCH_BYTES`]; whether all
    /// were stored.
    async fn upload(&self, worker: usize, blobs: &[Blob], rec: &mut Recorder) -> bool {
        let mut batch: Vec<&Blob> = Vec::new();
        let mut bytes = 0;
        let mut ok = true;
        for b in blobs {
            if bytes + b.data.len() > BATCH_BYTES && !batch.is_empty() {
                ok &= self.send(worker, &batch, rec).await;
                batch.clear();
                bytes = 0;
            }
            bytes += b.data.len();
            batch.push(b);
        }
        if !batch.is_empty() {
            ok &= self.send(worker, &batch, rec).await;
        }
        ok
    }

    async fn send(&self, worker: usize, batch: &[&Blob], rec: &mut Recorder) -> bool {
        let sent = batch.iter().map(|b| b.data.len() as u64).sum();
        let req = batch_update(&self.clients.instance, batch);
        let t = Instant::now();
        match self.clients.cas(worker).batch_update_blobs(req).await {
            Ok(r) => {
                let failed = r
                    .into_inner()
                    .responses
                    .into_iter()
                    .find(|r| r.status.as_ref().map_or(-1, |s| s.code) != 0);
                match failed {
                    None => {
                        rec.ok("BatchUpdateBlobs", t, sent);
                        true
                    }
                    Some(r) => {
                        let s = r.status.unwrap_or_default();
                        rec.err(
                            "BatchUpdateBlobs",
                            t,
                            &tonic::Status::new(tonic::Code::from(s.code), s.message),
                        );
                        false
                    }
                }
            }
            Err(status) => {
                rec.err("BatchUpdateBlobs", t, &status);
                false
            }
        }
    }
}

impl Workload for Build {
    type State = (usize, Rng);

    fn state(&self, worker: usize) -> (usize, Rng) {
        (worker, Rng::keyed(&[self.seed, 0xbd, worker as u64]))
    }

    async fn step(&self, (worker, rng): &mut (usize, Rng), rec: &mut Recorder) {
        let worker = *worker;
        let a = rng.below(self.actions);
        // Its own namespace: the `ac` workload's results have other outputs.
        let action = digest_of(format!("cache-bench build action {} {a}", self.seed).as_bytes());
        let started = Instant::now();

        let t = Instant::now();
        let got = self
            .clients
            .ac(worker)
            .get_action_result(GetActionResultRequest {
                instance_name: self.clients.instance.clone(),
                action_digest: Some(action.clone()),
                inline_stdout: false,
                inline_stderr: false,
                inline_output_files: vec![],
                digest_function: 0,
            })
            .await;
        match got {
            Ok(result) => {
                rec.ok("GetActionResult", t, 0);
                let digests: Vec<Digest> = result
                    .into_inner()
                    .output_files
                    .into_iter()
                    .filter_map(|f| f.digest)
                    .collect();
                let t = Instant::now();
                let n = digests.len();
                let resp = self.clients.batch_read(worker, digests, false).await;
                rec.result("BatchReadBlobs", t, &resp, |(wire, _)| *wire);
                if let Ok((_, bad)) = &resp {
                    rec.verify(bad.is_empty() && n == self.outputs, || {
                        format!("action {a}: outputs {bad:?}")
                    });
                    rec.ok("action.hit", started, 0);
                }
                return;
            }
            Err(status) if status.code() == tonic::Code::NotFound => {
                rec.ok("GetActionResult", t, 0);
            }
            Err(status) => {
                rec.err("GetActionResult", t, &status);
                return;
            }
        }

        let inputs = self.inputs_of(a);
        let t = Instant::now();
        let missing = self
            .clients
            .cas(worker)
            .find_missing_blobs(FindMissingBlobsRequest {
                instance_name: self.clients.instance.clone(),
                blob_digests: inputs.iter().map(|&i| self.pool[i].clone()).collect(),
                digest_function: 0,
            })
            .await;
        rec.result("FindMissingBlobs", t, &missing, |_| 0);
        let Ok(missing) = missing else { return };
        let missing: HashSet<String> = missing
            .into_inner()
            .missing_blob_digests
            .into_iter()
            .map(|d| d.hash)
            .collect();
        let mut seen = HashSet::new();
        let uploads: Vec<Blob> = inputs
            .iter()
            .filter(|&&i| missing.contains(&self.pool[i].hash) && seen.insert(i))
            .map(|&i| self.input(i))
            .collect();
        if !self.upload(worker, &uploads, rec).await {
            return;
        }

        let outputs = self.outputs_of(a);
        if !self.upload(worker, &outputs, rec).await {
            return;
        }
        let result = ActionResult {
            output_files: outputs
                .iter()
                .enumerate()
                .map(|(j, b)| OutputFile {
                    path: format!("out/{a}/{j}"),
                    digest: Some(b.digest.clone()),
                    ..Default::default()
                })
                .collect(),
            ..Default::default()
        };
        let t = Instant::now();
        let resp = self
            .clients
            .ac(worker)
            .update_action_result(UpdateActionResultRequest {
                instance_name: self.clients.instance.clone(),
                action_digest: Some(action),
                action_result: Some(result),
                results_cache_policy: None,
                digest_function: 0,
            })
            .await;
        rec.result("UpdateActionResult", t, &resp, |_| 0);
        if resp.is_ok() {
            rec.ok("action.miss", started, 0);
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------

/// A stored tree of Directories: `fanout` subdirectories per level down to
/// `depth`, each with `files` files.
pub struct TreeSpec {
    pub root: Digest,
    pub directories: usize,
    pub blobs: Vec<Blob>,
}

pub fn make_tree(seed: u64, depth: u32, fanout: usize, files: usize) -> TreeSpec {
    fn build(
        seed: u64,
        path: &str,
        level: u32,
        depth: u32,
        fanout: usize,
        files: usize,
        out: &mut Vec<Blob>,
    ) -> Digest {
        let directories = if level < depth {
            (0..fanout)
                .map(|i| {
                    let name = format!("d{i}");
                    let child = format!("{path}/{name}");
                    DirectoryNode {
                        name,
                        digest: Some(build(seed, &child, level + 1, depth, fanout, files, out)),
                    }
                })
                .collect()
        } else {
            Vec::new()
        };
        let files = (0..files)
            .map(|i| FileNode {
                name: format!("f{i}.rs"),
                digest: Some(digest_of(format!("{seed}{path}/f{i}").as_bytes())),
                is_executable: false,
                ..Default::default()
            })
            .collect();
        let dir = Directory {
            files,
            directories,
            ..Default::default()
        };
        let data = Bytes::from(dir.encode_to_vec());
        let digest = digest_of(&data);
        out.push(Blob {
            digest: digest.clone(),
            data,
        });
        digest
    }
    let mut blobs = Vec::new();
    let root = build(seed, "", 0, depth, fanout, files, &mut blobs);
    TreeSpec {
        root,
        directories: blobs.len(),
        blobs,
    }
}

/// GetTree of a stored tree, checking every Directory arrives.
pub struct Tree {
    pub clients: Clients,
    pub root: Digest,
    pub directories: usize,
}

impl Workload for Tree {
    type State = usize;

    fn state(&self, worker: usize) -> usize {
        worker
    }

    async fn step(&self, worker: &mut usize, rec: &mut Recorder) {
        let t = Instant::now();
        let result: Result<(usize, u64), tonic::Status> = async {
            let mut stream = self
                .clients
                .cas(*worker)
                .get_tree(GetTreeRequest {
                    instance_name: self.clients.instance.clone(),
                    root_digest: Some(self.root.clone()),
                    page_size: 0,
                    page_token: String::new(),
                    digest_function: 0,
                })
                .await?
                .into_inner();
            let mut dirs = 0;
            let mut bytes = 0;
            while let Some(page) = stream.message().await? {
                dirs += page.directories.len();
                bytes += page.encoded_len() as u64;
            }
            Ok((dirs, bytes))
        }
        .await;
        rec.result("GetTree", t, &result, |(_, bytes)| *bytes);
        if let Ok((dirs, _)) = result {
            rec.verify(dirs == self.directories, || {
                format!("GetTree: {dirs} of {} directories", self.directories)
            });
        }
    }
}
