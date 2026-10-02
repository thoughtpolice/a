// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Git repository cloning with REAPI Directory tree conversion.
//!
//! The target commit is fetched shallow by [`fetch_git::clone_repo`], which
//! spools the pack to disk and indexes it. The tree is then converted on
//! blocking threads, since every step is CPU work:
//!
//! 1. **List** the trees under the target: each distinct tree once,
//!    children before parents, and the blobs they name.
//! 2. **Store the blobs**, decoded and hashed on several threads at once.
//! 3. **Store the Directory protos**, built bottom-up from the blob digests.
//!
//! CAS writes are grouped into size-bounded batches, each one durable write,
//! and uploaded while the conversion carries on. A byte budget covers all
//! data decoded but not yet stored, so memory stays proportional to the pack
//! index and the tree listing rather than to the repository.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Condvar, Mutex};
use std::time::Duration;

use bytes::Bytes;
use dial9::Dial9TokioHandle;
use futures::stream::{FuturesUnordered, StreamExt as _};
use openssl::ssl::SslConnector;
use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{
    Digest, Directory, DirectoryNode, FileNode, SymlinkNode,
};

use fetch_git::pack::{GitPack, ObjectKind};
use fetch_git::tree::GitTreeEntry;
use fetch_git::{CloneOptions, GitFetchError};

use crate::store::{CacheStore, Compression, ContentDigest, DigestFn};

use super::helpers::{http_status_code, qualifier, rpc_status};

/// Read current VmRSS from /proc/self/status (Linux only).
fn rss_mib() -> Option<u64> {
    let status = std::fs::read_to_string("/proc/self/status").ok()?;
    for line in status.lines() {
        if let Some(rest) = line.strip_prefix("VmRSS:") {
            let kb: u64 = rest.trim().strip_suffix("kB")?.trim().parse().ok()?;
            return Some(kb / 1024);
        }
    }
    None
}

// ---------------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------------

/// Most entries, over all distinct trees, a conversion lists. Real trees
/// stay far below this (a few million files for the largest monorepos);
/// each entry costs ~100 bytes while the conversion runs.
const MAX_TREE_ENTRIES: usize = 10_000_000;

/// How a conversion batches, bounds, and spreads its work.
#[derive(Clone, Copy, Debug)]
struct ConvertSettings {
    /// Threads decoding and hashing blobs.
    threads: usize,
    /// A batch of CAS writes is sent for upload once it holds this many
    /// bytes. Each batch is one durable write.
    batch_bytes: usize,
    /// Batches uploading at once.
    uploads: usize,
    /// Blob and Directory bytes decoded but not yet stored, across all of
    /// the conversion's threads.
    budget_bytes: usize,
}

impl ConvertSettings {
    fn new(threads: usize) -> Self {
        Self {
            threads: threads.max(1),
            batch_bytes: 16 * 1024 * 1024,
            uploads: 4,
            budget_bytes: 256 * 1024 * 1024,
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug)]
pub(super) enum GitCloneError {
    /// Fetching or reading the repository failed.
    Fetch(GitFetchError),
    StoreError(String),
    SubdirectoryNotFound(String),
    /// The conversion was stopped: its uploads failed, or it was abandoned.
    Stopped,
}

impl fmt::Display for GitCloneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Fetch(e) => e.fmt(f),
            Self::StoreError(msg) => write!(f, "storage error: {msg}"),
            Self::SubdirectoryNotFound(path) => write!(f, "subdirectory not found: {path}"),
            Self::Stopped => write!(f, "conversion stopped"),
        }
    }
}

impl From<GitFetchError> for GitCloneError {
    fn from(e: GitFetchError) -> Self {
        Self::Fetch(e)
    }
}

impl GitCloneError {
    fn invalid_packfile(msg: String) -> Self {
        Self::Fetch(GitFetchError::InvalidPackfile(msg))
    }

    pub(super) fn to_rpc_status(&self) -> protos::google::rpc::Status {
        use tonic::Code;
        let (code, message) = match self {
            Self::Fetch(e) => match e {
                GitFetchError::RefNotFound(msg) => (Code::NotFound, msg.clone()),
                GitFetchError::RequestFailed(msg) => (Code::Unavailable, msg.clone()),
                GitFetchError::HttpStatus(status, msg) => {
                    (http_status_code(*status), format!("HTTP {status}: {msg}"))
                }
                GitFetchError::TooLarge { .. } => (
                    Code::ResourceExhausted,
                    format!("repository too large: {e}"),
                ),
                GitFetchError::InvalidPackfile(msg) => (Code::Internal, msg.clone()),
                GitFetchError::InvalidUri(msg) => (Code::InvalidArgument, msg.clone()),
                GitFetchError::BlockedAddress(msg) => (Code::PermissionDenied, msg.clone()),
            },
            Self::StoreError(msg) => (Code::Internal, msg.clone()),
            Self::SubdirectoryNotFound(path) => {
                (Code::NotFound, format!("subdirectory not found: {path}"))
            }
            Self::Stopped => (Code::Aborted, self.to_string()),
        };
        rpc_status(code as i32, message)
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Result type
// ---------------------------------------------------------------------------------------------------------------------

pub(super) struct GitCloneResult {
    pub root_digest_hash: [u8; 32],
    pub root_digest_size: i64,
}

// ---------------------------------------------------------------------------------------------------------------------
// Qualifier helpers
// ---------------------------------------------------------------------------------------------------------------------

/// Returns `true` if the URI points to a Git repository accessible via smart HTTP.
///
/// A URI is considered a Git repo if it uses `http://` or `https://` AND either
/// ends with `.git` or the `resource_type` qualifier is `application/x-git`.
pub(super) fn is_git_uri(uri: &str, qualifiers: &[(String, String)]) -> bool {
    fetch_http::is_http_uri(uri)
        && (uri.to_ascii_lowercase().ends_with(".git")
            || qualifier(qualifiers, "resource_type") == Some("application/x-git"))
}

/// Returns `true` if either `vcs.branch` or `vcs.commit` is present.
pub(super) fn has_vcs_qualifiers(qualifiers: &[(String, String)]) -> bool {
    qualifier(qualifiers, "vcs.branch").is_some() || qualifier(qualifiers, "vcs.commit").is_some()
}

// ---------------------------------------------------------------------------------------------------------------------
// Reading trees
// ---------------------------------------------------------------------------------------------------------------------

/// Read and parse the tree `sha`.
fn read_tree(pack: &GitPack, sha: &[u8; 20]) -> Result<Vec<GitTreeEntry>, GitCloneError> {
    match pack.get(sha)? {
        Some((ObjectKind::Tree, data)) => Ok(fetch_git::tree::parse_tree(&data)?),
        Some((kind, _)) => Err(GitCloneError::invalid_packfile(format!(
            "expected tree, got {kind} for {}",
            hex::encode(sha),
        ))),
        None => Err(GitCloneError::invalid_packfile(format!(
            "tree object {} not found in packfile",
            hex::encode(sha),
        ))),
    }
}

/// Walk down a git tree by path components to find a subtree SHA.
fn resolve_subdirectory(
    pack: &GitPack,
    root_tree_sha: &[u8; 20],
    path: &str,
) -> Result<[u8; 20], GitCloneError> {
    let mut current_sha = *root_tree_sha;

    for component in path.split('/').filter(|c| !c.is_empty()) {
        let entries = match pack.get(&current_sha)? {
            Some((ObjectKind::Tree, data)) => fetch_git::tree::parse_tree(&data)?,
            Some((kind, _)) => {
                return Err(GitCloneError::SubdirectoryNotFound(format!(
                    "expected tree at {}, got {kind}",
                    hex::encode(current_sha),
                )));
            }
            None => {
                return Err(GitCloneError::SubdirectoryNotFound(format!(
                    "tree {} not found while resolving '{path}'",
                    hex::encode(current_sha),
                )));
            }
        };
        let entry = entries
            .iter()
            .find(|e| e.name == component && e.is_dir())
            .ok_or_else(|| {
                GitCloneError::SubdirectoryNotFound(format!(
                    "directory '{component}' not found in tree {}",
                    hex::encode(current_sha),
                ))
            })?;

        current_sha = entry.sha;
    }

    Ok(current_sha)
}

/// Every distinct tree under a root, and the file blobs they name.
struct Listing {
    /// Trees in an order that puts every tree after all of its subtrees,
    /// so the root comes last.
    trees: Vec<([u8; 20], Vec<GitTreeEntry>)>,
    /// Distinct blobs named by regular and executable file entries.
    files: Vec<[u8; 20]>,
}

/// List the trees under `root`, each once however many paths reach it.
fn list_trees(pack: &GitPack, root: [u8; 20], stop: &AtomicBool) -> Result<Listing, GitCloneError> {
    enum Visit {
        Enter([u8; 20], usize),
        Leave([u8; 20], Vec<GitTreeEntry>),
    }

    let mut trees = Vec::new();
    let mut files = Vec::new();
    let mut seen_files = HashSet::new();
    let mut entered = HashSet::new();
    let mut entries_listed = 0usize;
    let mut stack = vec![Visit::Enter(root, 0)];
    while let Some(visit) = stack.pop() {
        let (sha, depth) = match visit {
            Visit::Leave(sha, entries) => {
                trees.push((sha, entries));
                continue;
            }
            Visit::Enter(sha, depth) => (sha, depth),
        };
        // A tree reached by several paths is listed (and left) once, the
        // first time; its later Enters are no-ops.
        if !entered.insert(sha) {
            continue;
        }
        if stop.load(Ordering::Relaxed) {
            return Err(GitCloneError::Stopped);
        }
        // Nesting this deep only occurs in adversarial packs.
        if depth >= fetch_git::MAX_TREE_DEPTH {
            return Err(GitCloneError::invalid_packfile(format!(
                "tree nesting exceeds {} levels",
                fetch_git::MAX_TREE_DEPTH
            )));
        }

        let entries = read_tree(pack, &sha)?;
        entries_listed += entries.len();
        if entries_listed > MAX_TREE_ENTRIES {
            return Err(GitFetchError::TooLarge {
                what: "tree entry count",
                size: entries_listed,
                limit: MAX_TREE_ENTRIES,
            }
            .into());
        }
        let subtrees: Vec<[u8; 20]> = entries
            .iter()
            .filter(|e| e.is_dir() && !entered.contains(&e.sha))
            .map(|e| e.sha)
            .collect();
        for entry in &entries {
            let is_file = !(entry.is_dir() || entry.is_submodule() || entry.is_symlink());
            if is_file && seen_files.insert(entry.sha) {
                files.push(entry.sha);
            }
        }
        // Subtrees go on the stack above this tree's Leave, so they are
        // all left before it is.
        stack.push(Visit::Leave(sha, entries));
        stack.extend(subtrees.into_iter().map(|t| Visit::Enter(t, depth + 1)));
    }
    Ok(Listing { trees, files })
}

// ---------------------------------------------------------------------------------------------------------------------
// Upload stream
// ---------------------------------------------------------------------------------------------------------------------

/// A pending CAS blob write.
type BlobWrite = (ContentDigest, Bytes, Compression);

/// Bytes decoded but not yet stored, shared by a conversion's threads.
struct Budget {
    available: Mutex<usize>,
    freed: Condvar,
    total: usize,
}

/// Budget bytes held, given back when dropped: once a batch is stored, or
/// abandoned.
struct Held {
    budget: Arc<Budget>,
    bytes: usize,
}

impl Budget {
    fn new(total: usize) -> Arc<Self> {
        Arc::new(Self {
            available: Mutex::new(total),
            freed: Condvar::new(),
            total,
        })
    }

    /// Take `bytes` (the whole budget, for anything larger) if that much is
    /// free now.
    fn try_take(&self, bytes: usize) -> Option<usize> {
        let want = bytes.min(self.total);
        let mut available = self.available.lock().expect("budget lock never poisoned");
        if *available < want {
            return None;
        }
        *available -= want;
        Some(want)
    }

    /// Wait until `bytes` (the whole budget, for anything larger) are free
    /// and take them, unless `stop` is set first.
    fn take(&self, bytes: usize, stop: &AtomicBool) -> Result<usize, GitCloneError> {
        let want = bytes.min(self.total);
        let mut available = self.available.lock().expect("budget lock never poisoned");
        while *available < want {
            if stop.load(Ordering::Relaxed) {
                return Err(GitCloneError::Stopped);
            }
            available = self
                .freed
                .wait_timeout(available, Duration::from_millis(50))
                .expect("budget lock never poisoned")
                .0;
        }
        *available -= want;
        Ok(want)
    }
}

impl Drop for Held {
    fn drop(&mut self) {
        if self.bytes > 0 {
            *self
                .budget
                .available
                .lock()
                .expect("budget lock never poisoned") += self.bytes;
            self.budget.freed.notify_all();
        }
    }
}

/// CAS writes on their way to storage, with the budget their data holds.
struct Batch {
    writes: Vec<BlobWrite>,
    bytes: usize,
    held: Held,
}

/// One thread's end of a conversion's upload stream: gathers its writes
/// into batches and sends them to [`upload_batches`].
struct Sink<'a> {
    tx: &'a tokio::sync::mpsc::Sender<Batch>,
    budget: &'a Arc<Budget>,
    stop: &'a AtomicBool,
    batch_bytes: usize,
    batch: Batch,
}

impl<'a> Sink<'a> {
    fn new(
        tx: &'a tokio::sync::mpsc::Sender<Batch>,
        budget: &'a Arc<Budget>,
        stop: &'a AtomicBool,
        batch_bytes: usize,
    ) -> Self {
        Self {
            tx,
            budget,
            stop,
            batch_bytes,
            batch: Self::empty(budget),
        }
    }

    fn empty(budget: &Arc<Budget>) -> Batch {
        Batch {
            writes: Vec::new(),
            bytes: 0,
            held: Held {
                budget: Arc::clone(budget),
                bytes: 0,
            },
        }
    }

    /// Reserve budget for `bytes` about to be decoded. A sink never waits
    /// while its own batch holds budget: the batch is sent first, so that
    /// budget comes back once it is stored, whatever the other threads do.
    fn reserve(&mut self, bytes: usize) -> Result<(), GitCloneError> {
        let taken = match self.budget.try_take(bytes) {
            Some(taken) => taken,
            None => {
                self.send()?;
                self.budget.take(bytes, self.stop)?
            }
        };
        self.batch.held.bytes += taken;
        Ok(())
    }

    /// Queue a write of `data`, whose budget was reserved.
    fn push(&mut self, digest: ContentDigest, data: Bytes) -> Result<(), GitCloneError> {
        self.batch.bytes += data.len();
        self.batch
            .writes
            .push((digest, data, Compression::Identity));
        if self.batch.bytes >= self.batch_bytes {
            self.send()?;
        }
        Ok(())
    }

    /// Send the batch so far, if it holds anything.
    fn send(&mut self) -> Result<(), GitCloneError> {
        if self.batch.writes.is_empty() {
            return Ok(());
        }
        let batch = std::mem::replace(&mut self.batch, Self::empty(self.budget));
        // Fails only once the uploader has given up.
        self.tx
            .blocking_send(batch)
            .map_err(|_| GitCloneError::Stopped)
    }
}

/// Store every batch `rx` delivers, `uploads` at a time, until every sender
/// is gone.
async fn upload_batches(
    store: &CacheStore,
    mut rx: tokio::sync::mpsc::Receiver<Batch>,
    uploads: usize,
) -> Result<(), GitCloneError> {
    let mut in_flight = FuturesUnordered::new();
    let mut open = true;
    while open || !in_flight.is_empty() {
        tokio::select! {
            batch = rx.recv(), if open && in_flight.len() < uploads => match batch {
                Some(Batch { writes, held, .. }) => in_flight.push(async move {
                    let stored = store.cas_put_blob_batch(writes).await;
                    drop(held);
                    stored
                }),
                None => open = false,
            },
            Some(stored) = in_flight.next() => {
                stored.map_err(|e| GitCloneError::StoreError(e.to_string()))?;
            }
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------------
// Tree-to-REAPI conversion
// ---------------------------------------------------------------------------------------------------------------------

/// Sets its flag when dropped, so threads still working for an abandoned
/// conversion stop.
struct StopOnDrop(Arc<AtomicBool>);

impl Drop for StopOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Convert the git tree `tree_sha` into REAPI Directories in CAS, returning
/// the root Directory's digest once it and everything it references are
/// stored.
async fn convert_tree(
    pack: Arc<GitPack>,
    store: &CacheStore,
    tree_sha: [u8; 20],
    digest_fn: DigestFn,
    settings: ConvertSettings,
) -> Result<([u8; 32], i64), GitCloneError> {
    let (tx, rx) = tokio::sync::mpsc::channel(settings.uploads);
    let stop = StopOnDrop(Arc::new(AtomicBool::new(false)));
    let flag = Arc::clone(&stop.0);
    let convert = tokio::task::spawn_blocking(move || {
        let budget = Budget::new(settings.budget_bytes);
        let converted = convert_blocking(&pack, tree_sha, digest_fn, settings, &tx, &budget, &flag);
        if converted.is_err() {
            flag.store(true, Ordering::Relaxed);
        }
        converted
    });
    let upload = async {
        let uploaded = upload_batches(store, rx, settings.uploads).await;
        if uploaded.is_err() {
            stop.0.store(true, Ordering::Relaxed);
        }
        uploaded
    };
    let (converted, uploaded) = tokio::join!(convert, upload);
    // An upload failure stops the conversion, so report it first.
    uploaded?;
    converted.map_err(|e| GitCloneError::StoreError(format!("conversion task failed: {e}")))?
}

/// The blocking side of [`convert_tree`].
fn convert_blocking(
    pack: &GitPack,
    tree_sha: [u8; 20],
    digest_fn: DigestFn,
    settings: ConvertSettings,
    tx: &tokio::sync::mpsc::Sender<Batch>,
    budget: &Arc<Budget>,
    stop: &AtomicBool,
) -> Result<([u8; 32], i64), GitCloneError> {
    let listing = list_trees(pack, tree_sha, stop)?;
    tracing::debug!(
        trees = listing.trees.len(),
        blobs = listing.files.len(),
        "listed git tree",
    );
    let blobs = store_blobs(pack, &listing.files, digest_fn, settings, tx, budget, stop)?;
    let mut sink = Sink::new(tx, budget, stop, settings.batch_bytes);
    let root = store_directories(pack, listing.trees, &blobs, digest_fn, &mut sink)?;
    sink.send()?;
    Ok(root)
}

/// Decode, hash, and store `files` on `settings.threads` threads, returning
/// each blob's digest.
fn store_blobs(
    pack: &GitPack,
    files: &[[u8; 20]],
    digest_fn: DigestFn,
    settings: ConvertSettings,
    tx: &tokio::sync::mpsc::Sender<Batch>,
    budget: &Arc<Budget>,
    stop: &AtomicBool,
) -> Result<HashMap<[u8; 20], ([u8; 32], i64)>, GitCloneError> {
    let next = AtomicUsize::new(0);
    let store_some = || -> Result<Vec<([u8; 20], ([u8; 32], i64))>, GitCloneError> {
        let mut sink = Sink::new(tx, budget, stop, settings.batch_bytes);
        let mut digests = Vec::new();
        while let Some(sha) = files.get(next.fetch_add(1, Ordering::Relaxed)) {
            if stop.load(Ordering::Relaxed) {
                return Err(GitCloneError::Stopped);
            }
            let missing = || {
                GitCloneError::invalid_packfile(format!(
                    "blob {} not found in packfile",
                    hex::encode(sha)
                ))
            };
            let not_blob = |kind: ObjectKind| {
                GitCloneError::invalid_packfile(format!(
                    "file entry {} references a {kind}, not a blob",
                    hex::encode(sha)
                ))
            };
            let (kind, size) = pack.header(sha)?.ok_or_else(missing)?;
            if kind != ObjectKind::Blob {
                return Err(not_blob(kind));
            }
            sink.reserve(usize::try_from(size).unwrap_or(usize::MAX))?;
            let (kind, data) = pack.get(sha)?.ok_or_else(missing)?;
            if kind != ObjectKind::Blob {
                return Err(not_blob(kind));
            }
            let hash = digest_fn.hash_data(&data);
            digests.push((*sha, (hash, data.len() as i64)));
            sink.push(ContentDigest::new(digest_fn, hash), Bytes::from(data))?;
        }
        sink.send()?;
        Ok(digests)
    };
    let worker = || {
        let stored = store_some();
        if stored.is_err() {
            stop.store(true, Ordering::Relaxed);
        }
        stored
    };

    let threads = settings.threads.min(files.len()).max(1);
    let results: Vec<_> = std::thread::scope(|scope| {
        let others: Vec<_> = (1..threads).map(|_| scope.spawn(worker)).collect();
        let mine = worker();
        std::iter::once(mine)
            .chain(
                others
                    .into_iter()
                    .map(|t| t.join().expect("blob thread panicked")),
            )
            .collect()
    });

    // A thread stopped by another's failure reports `Stopped`; report the
    // failure itself.
    let mut digests = HashMap::with_capacity(files.len());
    let mut stopped = false;
    for result in results {
        match result {
            Ok(stored) => digests.extend(stored),
            Err(GitCloneError::Stopped) => stopped = true,
            Err(e) => return Err(e),
        }
    }
    if stopped {
        return Err(GitCloneError::Stopped);
    }
    Ok(digests)
}

/// Build and store the Directory for each tree (subtrees first), returning
/// the last one's (the root's) digest.
fn store_directories(
    pack: &GitPack,
    trees: Vec<([u8; 20], Vec<GitTreeEntry>)>,
    blobs: &HashMap<[u8; 20], ([u8; 32], i64)>,
    digest_fn: DigestFn,
    sink: &mut Sink<'_>,
) -> Result<([u8; 32], i64), GitCloneError> {
    let digest = |(hash, size_bytes): ([u8; 32], i64)| Digest {
        hash: hex::encode(hash),
        size_bytes,
    };
    let mut directories_stored: HashMap<[u8; 20], ([u8; 32], i64)> =
        HashMap::with_capacity(trees.len());
    let mut symlink_targets: HashMap<[u8; 20], String> = HashMap::new();
    let mut root = None;

    for (tree_sha, entries) in trees {
        if sink.stop.load(Ordering::Relaxed) {
            return Err(GitCloneError::Stopped);
        }
        let mut dir = Directory::default();
        for entry in entries {
            if entry.is_submodule() {
                tracing::debug!(name = %entry.name, "skipping submodule entry");
            } else if entry.is_dir() {
                let subtree = directories_stored.get(&entry.sha).ok_or_else(|| {
                    GitCloneError::invalid_packfile(format!(
                        "tree {} is its own ancestor",
                        hex::encode(entry.sha)
                    ))
                })?;
                dir.directories.push(DirectoryNode {
                    name: entry.name,
                    digest: Some(digest(*subtree)),
                });
            } else if entry.is_symlink() {
                let target = match symlink_targets.get(&entry.sha) {
                    Some(target) => target.clone(),
                    None => {
                        let Some((_, data)) = pack.get(&entry.sha)? else {
                            return Err(GitCloneError::invalid_packfile(format!(
                                "symlink blob {} not found for '{}'",
                                hex::encode(entry.sha),
                                entry.name,
                            )));
                        };
                        let target = String::from_utf8_lossy(&data).into_owned();
                        symlink_targets.insert(entry.sha, target.clone());
                        target
                    }
                };
                dir.symlinks.push(SymlinkNode {
                    name: entry.name,
                    target,
                    node_properties: None,
                });
            } else {
                let blob = blobs.get(&entry.sha).expect("every file blob was stored");
                dir.files.push(FileNode {
                    is_executable: entry.is_executable(),
                    name: entry.name,
                    digest: Some(digest(*blob)),
                    node_properties: None,
                });
            }
        }

        // REAPI requires entries sorted by name within each category
        dir.files.sort_by(|a, b| a.name.cmp(&b.name));
        dir.directories.sort_by(|a, b| a.name.cmp(&b.name));
        dir.symlinks.sort_by(|a, b| a.name.cmp(&b.name));

        // REAPI also requires names to be unique across all three
        // categories. Git enforces the same invariant (fsck's
        // duplicateEntries), so duplicates only appear in hostile packs —
        // and would make the resulting Directory ambiguous to materialize.
        let mut names: Vec<&str> = dir
            .files
            .iter()
            .map(|f| f.name.as_str())
            .chain(dir.directories.iter().map(|d| d.name.as_str()))
            .chain(dir.symlinks.iter().map(|s| s.name.as_str()))
            .collect();
        names.sort_unstable();
        if let Some(pair) = names.windows(2).find(|w| w[0] == w[1]) {
            return Err(GitCloneError::invalid_packfile(format!(
                "duplicate entry name {:?} in tree {}",
                pair[0],
                hex::encode(tree_sha)
            )));
        }
        drop(names);

        let dir_bytes = dir.encode_to_vec();
        let stored = (digest_fn.hash_data(&dir_bytes), dir_bytes.len() as i64);
        sink.reserve(dir_bytes.len())?;
        sink.push(
            ContentDigest::new(digest_fn, stored.0),
            Bytes::from(dir_bytes),
        )?;
        directories_stored.insert(tree_sha, stored);
        root = Some(stored);
    }
    Ok(root.expect("the listing holds at least the root"))
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------

/// Clone a Git repository and convert its tree to REAPI Directory format.
///
/// Supports `vcs.branch` and `vcs.commit` qualifiers for ref targeting, and
/// the `directory` qualifier for subdirectory selection. `options` says
/// where the pack spools and how many threads indexing and conversion use.
pub(super) async fn fetch_git_directory(
    ssl_connector: &SslConnector,
    store: &Arc<CacheStore>,
    uri: &str,
    qualifiers: &[(String, String)],
    digest_fn: DigestFn,
    options: &CloneOptions,
    handle: &Dial9TokioHandle,
) -> Result<GitCloneResult, GitCloneError> {
    let branch = qualifier(qualifiers, "vcs.branch");
    let commit = qualifier(qualifiers, "vcs.commit");
    let subdir = qualifier(qualifiers, "directory").map(str::to_string);

    let rss_before = rss_mib();
    let cloned = fetch_git::clone_repo(ssl_connector, uri, branch, commit, options, handle).await?;
    let pack = Arc::new(cloned.pack);
    tracing::info!(
        uri,
        commit = %hex::encode(cloned.commit_sha),
        tree = %hex::encode(cloned.tree_sha),
        objects = pack.object_count(),
        pack_mib = pack.pack_size() / (1024 * 1024),
        rss_before_mib = rss_before.unwrap_or(0),
        rss_after_mib = rss_mib().unwrap_or(0),
        "cloned git repository",
    );

    let target_tree_sha = match subdir {
        Some(path) => {
            let pack = Arc::clone(&pack);
            let root = cloned.tree_sha;
            tokio::task::spawn_blocking(move || resolve_subdirectory(&pack, &root, &path))
                .await
                .map_err(|e| {
                    GitCloneError::StoreError(format!("subdirectory lookup failed: {e}"))
                })??
        }
        None => cloned.tree_sha,
    };

    let threads = match options.index_threads {
        0 => std::thread::available_parallelism().map_or(1, usize::from),
        n => n,
    };
    let converted = convert_tree(
        Arc::clone(&pack),
        store,
        target_tree_sha,
        digest_fn,
        ConvertSettings::new(threads),
    )
    .await;
    tracing::info!(
        ok = converted.is_ok(),
        rss_mib = rss_mib().unwrap_or(0),
        "tree-to-REAPI conversion complete",
    );
    // Unmapping a multi-GiB pack and closing its spool file frees all of it
    // synchronously, which would stall this worker thread.
    tokio::task::spawn_blocking(move || drop(pack));

    let (root_hash, root_size) = converted?;
    Ok(GitCloneResult {
        root_digest_hash: root_hash,
        root_digest_size: root_size,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::service::test_helpers::make_store;

    // --- is_git_uri ---

    #[test]
    fn is_git_uri_https_dot_git() {
        let q: Vec<(String, String)> = vec![];
        assert!(is_git_uri("https://github.com/foo/bar.git", &q));
    }

    #[test]
    fn is_git_uri_http_dot_git() {
        let q: Vec<(String, String)> = vec![];
        assert!(is_git_uri("http://example.com/repo.git", &q));
    }

    #[test]
    fn is_git_uri_resource_type_qualifier() {
        let q = vec![("resource_type".into(), "application/x-git".into())];
        assert!(is_git_uri("https://github.com/foo/bar", &q));
    }

    #[test]
    fn is_git_uri_not_http() {
        let q: Vec<(String, String)> = vec![];
        assert!(!is_git_uri("ssh://git@github.com/foo/bar.git", &q));
    }

    #[test]
    fn is_git_uri_no_git_extension_no_qualifier() {
        let q: Vec<(String, String)> = vec![];
        assert!(!is_git_uri("https://example.com/archive.tar.gz", &q));
    }

    #[test]
    fn is_git_uri_wrong_resource_type() {
        let q = vec![("resource_type".into(), "application/zip".into())];
        assert!(!is_git_uri("https://example.com/repo", &q));
    }

    #[test]
    fn is_git_uri_case_insensitive() {
        let q: Vec<(String, String)> = vec![];
        assert!(is_git_uri("HTTPS://GITHUB.COM/FOO/BAR.GIT", &q));
    }

    // --- has_vcs_qualifiers ---

    #[test]
    fn has_vcs_qualifiers_branch() {
        let q = vec![("vcs.branch".into(), "main".into())];
        assert!(has_vcs_qualifiers(&q));
    }

    #[test]
    fn has_vcs_qualifiers_commit() {
        let q = vec![("vcs.commit".into(), "abc123".into())];
        assert!(has_vcs_qualifiers(&q));
    }

    #[test]
    fn has_vcs_qualifiers_both() {
        let q = vec![
            ("vcs.branch".into(), "main".into()),
            ("vcs.commit".into(), "abc123".into()),
        ];
        assert!(has_vcs_qualifiers(&q));
    }

    #[test]
    fn has_vcs_qualifiers_none() {
        let q = vec![("checksum.sri".into(), "sha256-abc".into())];
        assert!(!has_vcs_qualifiers(&q));
    }

    #[test]
    fn has_vcs_qualifiers_empty() {
        let q: Vec<(String, String)> = vec![];
        assert!(!has_vcs_qualifiers(&q));
    }

    // --- qualifier lookup ---

    #[test]
    fn qualifier_lookup() {
        let q = vec![
            ("vcs.branch".into(), "develop".into()),
            ("directory".into(), "src/lib".into()),
        ];
        assert_eq!(qualifier(&q, "vcs.branch"), Some("develop"));
        assert_eq!(qualifier(&q, "directory"), Some("src/lib"));
        assert_eq!(qualifier(&q, "vcs.commit"), None);
    }

    // --- resolve_subdirectory ---

    fn make_tree_data(entries: &[(u32, &str, [u8; 20])]) -> Vec<u8> {
        let mut buf = Vec::new();
        for (mode, name, sha) in entries {
            buf.extend_from_slice(format!("{mode}").as_bytes());
            buf.push(b' ');
            buf.extend_from_slice(name.as_bytes());
            buf.push(0);
            buf.extend_from_slice(sha);
        }
        buf
    }

    fn sha1_of(kind: ObjectKind, data: &[u8]) -> [u8; 20] {
        fetch_git::pack::object_id(kind, data).unwrap()
    }

    /// Packfile type bits for test objects.
    const COMMIT: u8 = 1;
    const TREE: u8 = 2;
    const BLOB: u8 = 3;

    /// Index a synthetic pack holding the given objects.
    async fn test_pack(objects: &[(u8, Vec<u8>)]) -> Arc<GitPack> {
        let mut b = fetch_git::testpack::PackBuilder::new();
        for (type_bits, data) in objects {
            b.object(*type_bits, data);
        }
        let pack = b.build();
        let dir = std::env::temp_dir();
        let spooled = fetch_git::spool::SpooledPack::spool(&pack[..], &dir, pack.len())
            .await
            .unwrap();
        let limits = fetch_git::pack::PackLimits {
            max_objects: u32::MAX,
            max_object_size: usize::MAX,
        };
        Arc::new(GitPack::index(spooled, &dir, limits, 1, &AtomicBool::new(false)).unwrap())
    }

    /// Convert `tree_sha` with the default settings on four threads.
    async fn convert(
        pack: Arc<GitPack>,
        store: &Arc<CacheStore>,
        tree_sha: [u8; 20],
    ) -> Result<([u8; 32], i64), GitCloneError> {
        convert_tree(
            pack,
            store,
            tree_sha,
            DigestFn::Sha256,
            ConvertSettings::new(4),
        )
        .await
    }

    #[tokio::test]
    async fn resolve_subdirectory_single_level() {
        let blob_data = b"file content";
        let blob_sha = sha1_of(ObjectKind::Blob, blob_data);
        let sub_tree_data = make_tree_data(&[(100644, "file.txt", blob_sha)]);
        let sub_tree_sha = sha1_of(ObjectKind::Tree, &sub_tree_data);
        let root_tree_data = make_tree_data(&[(40000, "src", sub_tree_sha)]);
        let root_tree_sha = sha1_of(ObjectKind::Tree, &root_tree_data);

        let pack = test_pack(&[
            (BLOB, blob_data.to_vec()),
            (TREE, sub_tree_data),
            (TREE, root_tree_data),
        ])
        .await;

        let result = resolve_subdirectory(&pack, &root_tree_sha, "src").unwrap();
        assert_eq!(result, sub_tree_sha);
    }

    #[tokio::test]
    async fn resolve_subdirectory_nested() {
        let blob_data = b"data";
        let blob_sha = sha1_of(ObjectKind::Blob, blob_data);
        let inner_data = make_tree_data(&[(100644, "f.txt", blob_sha)]);
        let inner_sha = sha1_of(ObjectKind::Tree, &inner_data);
        let mid_data = make_tree_data(&[(40000, "inner", inner_sha)]);
        let mid_sha = sha1_of(ObjectKind::Tree, &mid_data);
        let root_data = make_tree_data(&[(40000, "outer", mid_sha)]);
        let root_sha = sha1_of(ObjectKind::Tree, &root_data);

        let pack = test_pack(&[
            (BLOB, blob_data.to_vec()),
            (TREE, inner_data),
            (TREE, mid_data),
            (TREE, root_data),
        ])
        .await;

        let result = resolve_subdirectory(&pack, &root_sha, "outer/inner").unwrap();
        assert_eq!(result, inner_sha);
    }

    #[tokio::test]
    async fn resolve_subdirectory_not_found() {
        let root_data = make_tree_data(&[]);
        let root_sha = sha1_of(ObjectKind::Tree, &root_data);
        let pack = test_pack(&[(TREE, root_data)]).await;

        let result = resolve_subdirectory(&pack, &root_sha, "nonexistent");
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(msg.contains("nonexistent"));
    }

    #[tokio::test]
    async fn resolve_subdirectory_empty_path() {
        let root_data = make_tree_data(&[]);
        let root_sha = sha1_of(ObjectKind::Tree, &root_data);
        let pack = test_pack(&[(TREE, root_data)]).await;

        let result = resolve_subdirectory(&pack, &root_sha, "").unwrap();
        assert_eq!(result, root_sha);
    }

    // --- error → gRPC status mapping ---

    #[test]
    fn error_to_rpc_status_ref_not_found() {
        let e = GitCloneError::Fetch(GitFetchError::RefNotFound("main".into()));
        assert_eq!(e.to_rpc_status().code, tonic::Code::NotFound as i32);
    }

    #[test]
    fn error_to_rpc_status_stopped() {
        assert_eq!(
            GitCloneError::Stopped.to_rpc_status().code,
            tonic::Code::Aborted as i32
        );
    }

    #[test]
    fn error_to_rpc_status_too_large() {
        let e = GitCloneError::Fetch(GitFetchError::TooLarge {
            what: "pack size",
            size: 999,
            limit: 10,
        });
        let status = e.to_rpc_status();
        assert_eq!(status.code, tonic::Code::ResourceExhausted as i32);
        assert!(
            status.message.contains("pack size of 999"),
            "{}",
            status.message
        );
    }

    #[test]
    fn error_to_rpc_status_http_404() {
        let e = GitCloneError::Fetch(GitFetchError::HttpStatus(404, "Not Found".into()));
        assert_eq!(e.to_rpc_status().code, tonic::Code::NotFound as i32);
    }

    #[test]
    fn error_to_rpc_status_http_403() {
        let e = GitCloneError::Fetch(GitFetchError::HttpStatus(403, "Forbidden".into()));
        assert_eq!(e.to_rpc_status().code, tonic::Code::PermissionDenied as i32);
    }

    #[test]
    fn error_to_rpc_status_invalid_uri() {
        let e = GitCloneError::Fetch(GitFetchError::InvalidUri("bad".into()));
        assert_eq!(e.to_rpc_status().code, tonic::Code::InvalidArgument as i32);
    }

    #[test]
    fn error_to_rpc_status_subdirectory_not_found() {
        let e = GitCloneError::SubdirectoryNotFound("foo/bar".into());
        assert_eq!(e.to_rpc_status().code, tonic::Code::NotFound as i32);
    }

    #[test]
    fn error_to_rpc_status_store_error() {
        let e = GitCloneError::StoreError("db fail".into());
        assert_eq!(e.to_rpc_status().code, tonic::Code::Internal as i32);
    }

    #[test]
    fn error_to_rpc_status_blocked_address() {
        let e: GitCloneError = GitFetchError::BlockedAddress("10.0.0.5".into()).into();
        assert_eq!(e.to_rpc_status().code, tonic::Code::PermissionDenied as i32);
    }

    #[test]
    fn error_from_git_fetch_error() {
        let e: GitCloneError = GitFetchError::RefNotFound("main".into()).into();
        assert!(matches!(
            e,
            GitCloneError::Fetch(GitFetchError::RefNotFound(_))
        ));
    }

    // --- convert_tree integration tests ---

    #[tokio::test]
    async fn convert_tree_single_file() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        let blob_data = b"hello world";
        let blob_sha = sha1_of(ObjectKind::Blob, blob_data);
        let tree_data = make_tree_data(&[(100644, "file.txt", blob_sha)]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob_data.to_vec()), (TREE, tree_data)]).await;

        let (root_hash, root_size) = convert(pack, &store, tree_sha).await.unwrap();

        // Root directory should be stored in CAS.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        assert_eq!(dir_bytes.len(), root_size as usize);

        // The blob should be stored in CAS.
        let blob_hash = digest_fn.hash_data(blob_data);
        let blob_cd = ContentDigest::new(digest_fn, blob_hash);
        let retrieved = store.cas_get_blob(&blob_cd).await.unwrap().unwrap();
        assert_eq!(&retrieved[..], blob_data);
    }

    #[tokio::test]
    async fn convert_tree_with_symlink() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        let target_blob = b"../target/file";
        let target_sha = sha1_of(ObjectKind::Blob, target_blob);
        let tree_data = make_tree_data(&[(120000, "link", target_sha)]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, target_blob.to_vec()), (TREE, tree_data)]).await;

        let (root_hash, _) = convert(pack, &store, tree_sha).await.unwrap();

        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.symlinks.len(), 1);
        assert_eq!(dir.symlinks[0].name, "link");
        assert_eq!(dir.symlinks[0].target, "../target/file");
        assert!(dir.files.is_empty());
    }

    #[tokio::test]
    async fn convert_tree_multiple_files() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        let mut pack_objects: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut tree_entries = Vec::new();
        let mut blob_contents: Vec<(&str, Vec<u8>)> = Vec::new();
        for i in 0u8..10 {
            let data = vec![i; 100 + i as usize];
            let sha = sha1_of(ObjectKind::Blob, &data);
            let name = format!("file_{i}.txt");
            pack_objects.push((BLOB, data.clone()));
            tree_entries.push((100644u32, name.clone(), sha));
            blob_contents.push((Box::leak(name.into_boxed_str()), data));
        }

        let entries_ref: Vec<(u32, &str, [u8; 20])> = tree_entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let tree_data = make_tree_data(&entries_ref);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree_data);
        pack_objects.push((TREE, tree_data));

        let pack = test_pack(&pack_objects).await;
        let (root_hash, _) = convert(pack, &store, tree_sha).await.unwrap();

        // All 10 blobs should be in CAS.
        for (_, data) in &blob_contents {
            let h = digest_fn.hash_data(data);
            let cd = ContentDigest::new(digest_fn, h);
            let retrieved = store.cas_get_blob(&cd).await.unwrap().unwrap();
            assert_eq!(&retrieved[..], &data[..]);
        }

        // Directory proto should have 10 sorted files.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.files.len(), 10);
        // Verify sorted order.
        for i in 0..9 {
            assert!(dir.files[i].name < dir.files[i + 1].name);
        }
    }

    #[tokio::test]
    async fn convert_tree_with_subtree() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        // Sub-tree: one file
        let child_blob = b"child content";
        let child_sha = sha1_of(ObjectKind::Blob, child_blob);
        let sub_tree_data = make_tree_data(&[(100644, "child.txt", child_sha)]);
        let sub_tree_sha = sha1_of(ObjectKind::Tree, &sub_tree_data);

        // Root: one file + one directory
        let root_blob = b"root content";
        let root_blob_sha = sha1_of(ObjectKind::Blob, root_blob);
        let root_tree_data = make_tree_data(&[
            (100644, "README.md", root_blob_sha),
            (40000, "src", sub_tree_sha),
        ]);
        let root_tree_sha = sha1_of(ObjectKind::Tree, &root_tree_data);

        let pack = test_pack(&[
            (BLOB, child_blob.to_vec()),
            (TREE, sub_tree_data),
            (BLOB, root_blob.to_vec()),
            (TREE, root_tree_data),
        ])
        .await;

        let (root_hash, _) = convert(pack, &store, root_tree_sha).await.unwrap();

        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.files.len(), 1);
        assert_eq!(dir.directories.len(), 1);
        assert_eq!(dir.files[0].name, "README.md");
        assert_eq!(dir.directories[0].name, "src");

        // Both blobs should be in CAS.
        for blob in &[&child_blob[..], &root_blob[..]] {
            let h = digest_fn.hash_data(blob);
            let cd = ContentDigest::new(digest_fn, h);
            assert!(store.cas_get_blob(&cd).await.unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn convert_tree_dedup_same_blob() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        // Same blob content referenced by two different file entries.
        let blob_data = b"shared content";
        let blob_sha = sha1_of(ObjectKind::Blob, blob_data);
        let tree_data = make_tree_data(&[
            (100644, "copy_a.txt", blob_sha),
            (100644, "copy_b.txt", blob_sha),
        ]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob_data.to_vec()), (TREE, tree_data)]).await;

        let (root_hash, _) = convert(pack, &store, tree_sha).await.unwrap();

        // Directory should have 2 files both pointing to the same digest.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.files.len(), 2);
        assert_eq!(dir.files[0].digest, dir.files[1].digest);

        // The blob should be in CAS.
        let blob_hash = digest_fn.hash_data(blob_data);
        let blob_cd = ContentDigest::new(digest_fn, blob_hash);
        assert!(store.cas_get_blob(&blob_cd).await.unwrap().is_some());
    }

    #[tokio::test]
    async fn convert_tree_parallel_subtrees() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        // Build 4 sibling subtrees, each with 3 unique blobs.
        let mut pack_objects: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut root_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
        let mut all_blob_data: Vec<Vec<u8>> = Vec::new();
        for dir_idx in 0u8..4 {
            let mut sub_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
            for file_idx in 0u8..3 {
                let data = vec![dir_idx * 10 + file_idx; 50 + file_idx as usize];
                let sha = sha1_of(ObjectKind::Blob, &data);
                let name = format!("file_{file_idx}.txt");
                pack_objects.push((BLOB, data.clone()));
                sub_entries.push((100644, name, sha));
                all_blob_data.push(data);
            }
            let sub_refs: Vec<(u32, &str, [u8; 20])> = sub_entries
                .iter()
                .map(|(m, n, s)| (*m, n.as_str(), *s))
                .collect();
            let sub_tree = make_tree_data(&sub_refs);
            let sub_sha = sha1_of(ObjectKind::Tree, &sub_tree);
            pack_objects.push((TREE, sub_tree));
            root_entries.push((40000, format!("dir_{dir_idx}"), sub_sha));
        }

        let root_refs: Vec<(u32, &str, [u8; 20])> = root_entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let root_tree = make_tree_data(&root_refs);
        let root_sha = sha1_of(ObjectKind::Tree, &root_tree);
        pack_objects.push((TREE, root_tree));

        let pack = test_pack(&pack_objects).await;
        let (root_hash, _) = convert(pack, &store, root_sha).await.unwrap();

        // Root should have 4 sorted subdirectories.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.directories.len(), 4);
        for i in 0..3 {
            assert!(dir.directories[i].name < dir.directories[i + 1].name);
        }

        // Each subdirectory should have 3 sorted files.
        for sub_dir in &dir.directories {
            let sub_cd = ContentDigest::new(
                digest_fn,
                crate::store::parse_digest_hash(&sub_dir.digest.as_ref().unwrap().hash).unwrap(),
            );
            let sub_bytes = store.cas_get_blob(&sub_cd).await.unwrap().unwrap();
            let sub = Directory::decode(sub_bytes).unwrap();
            assert_eq!(sub.files.len(), 3);
            for i in 0..2 {
                assert!(sub.files[i].name < sub.files[i + 1].name);
            }
        }

        // All 12 blobs should be in CAS.
        for data in &all_blob_data {
            let h = digest_fn.hash_data(data);
            let cd = ContentDigest::new(digest_fn, h);
            assert!(store.cas_get_blob(&cd).await.unwrap().is_some());
        }
    }

    #[tokio::test]
    async fn convert_tree_parallel_shared_blob() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        // Shared blob referenced by multiple sibling subtrees.
        let shared_data = b"shared across dirs";
        let shared_sha = sha1_of(ObjectKind::Blob, shared_data);
        let mut pack_objects: Vec<(u8, Vec<u8>)> = vec![(BLOB, shared_data.to_vec())];

        // Build 3 subtrees that each reference the shared blob plus a unique blob.
        let mut root_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
        let mut unique_blobs: Vec<Vec<u8>> = Vec::new();
        for i in 0u8..3 {
            let unique_data = vec![i + 100; 80];
            let unique_sha = sha1_of(ObjectKind::Blob, &unique_data);
            pack_objects.push((BLOB, unique_data.clone()));
            unique_blobs.push(unique_data);

            let sub_tree = make_tree_data(&[
                (100644, "shared.txt", shared_sha),
                (100644, "unique.txt", unique_sha),
            ]);
            let sub_sha = sha1_of(ObjectKind::Tree, &sub_tree);
            pack_objects.push((TREE, sub_tree));
            root_entries.push((40000, format!("dir_{i}"), sub_sha));
        }

        let root_refs: Vec<(u32, &str, [u8; 20])> = root_entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let root_tree = make_tree_data(&root_refs);
        let root_sha = sha1_of(ObjectKind::Tree, &root_tree);
        pack_objects.push((TREE, root_tree));

        let pack = test_pack(&pack_objects).await;
        let (root_hash, _) = convert(pack, &store, root_sha).await.unwrap();

        // Root should have 3 subdirectories.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.directories.len(), 3);

        // All subtrees should have 2 files with "shared.txt" pointing to the
        // same digest across all three.
        let mut shared_digests = Vec::new();
        for sub_dir in &dir.directories {
            let sub_cd = ContentDigest::new(
                digest_fn,
                crate::store::parse_digest_hash(&sub_dir.digest.as_ref().unwrap().hash).unwrap(),
            );
            let sub_bytes = store.cas_get_blob(&sub_cd).await.unwrap().unwrap();
            let sub = Directory::decode(sub_bytes).unwrap();
            assert_eq!(sub.files.len(), 2);
            let shared_file = sub.files.iter().find(|f| f.name == "shared.txt").unwrap();
            shared_digests.push(shared_file.digest.clone());
        }
        assert_eq!(shared_digests[0], shared_digests[1]);
        assert_eq!(shared_digests[1], shared_digests[2]);

        // Shared blob and all unique blobs should be in CAS.
        let shared_cd = ContentDigest::new(digest_fn, digest_fn.hash_data(shared_data));
        assert!(store.cas_get_blob(&shared_cd).await.unwrap().is_some());
        for data in &unique_blobs {
            let cd = ContentDigest::new(digest_fn, digest_fn.hash_data(data));
            assert!(store.cas_get_blob(&cd).await.unwrap().is_some());
        }
    }

    // --- Budget ---

    #[test]
    fn budget_takes_and_gives_back() {
        let budget = Budget::new(100);
        let stop = AtomicBool::new(false);
        assert_eq!(budget.try_take(60), Some(60));
        assert_eq!(budget.try_take(60), None);
        let held = Held {
            budget: Arc::clone(&budget),
            bytes: 60,
        };
        drop(held);
        // More than the whole budget takes the whole budget.
        assert_eq!(budget.take(1000, &stop).unwrap(), 100);
        assert_eq!(budget.try_take(1), None);
    }

    #[test]
    fn budget_waits_end_when_stopped() {
        let budget = Budget::new(10);
        assert_eq!(budget.try_take(10), Some(10));
        let stop = AtomicBool::new(true);
        assert!(matches!(budget.take(1, &stop), Err(GitCloneError::Stopped)));
    }

    /// Many threads, a budget smaller than the data, and tiny batches:
    /// threads must keep sending what they hold rather than wait on each
    /// other, and everything must still land in CAS. One blob is larger
    /// than the whole budget.
    #[tokio::test]
    async fn convert_tree_within_a_small_budget() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        let mut pack_objects: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut entries: Vec<(u32, String, [u8; 20])> = Vec::new();
        let mut blobs: Vec<Vec<u8>> = (0..200u32)
            .map(|i| format!("blob {i} ").repeat(40).into_bytes())
            .collect();
        blobs.push(vec![b'x'; 64 * 1024]);
        for (i, data) in blobs.iter().enumerate() {
            let sha = sha1_of(ObjectKind::Blob, data);
            pack_objects.push((BLOB, data.clone()));
            entries.push((100644, format!("f{i:03}"), sha));
        }
        let refs: Vec<(u32, &str, [u8; 20])> = entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let tree = make_tree_data(&refs);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree);
        pack_objects.push((TREE, tree));

        let pack = test_pack(&pack_objects).await;
        let settings = ConvertSettings {
            threads: 8,
            batch_bytes: 2 * 1024,
            uploads: 2,
            budget_bytes: 8 * 1024,
        };
        let (root_hash, _) = tokio::time::timeout(
            std::time::Duration::from_secs(60),
            convert_tree(pack, &store, tree_sha, digest_fn, settings),
        )
        .await
        .expect("conversion finished")
        .unwrap();

        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir = Directory::decode(store.cas_get_blob(&root_cd).await.unwrap().unwrap()).unwrap();
        assert_eq!(dir.files.len(), blobs.len());
        for data in &blobs {
            let cd = ContentDigest::new(digest_fn, digest_fn.hash_data(data));
            assert_eq!(
                &store.cas_get_blob(&cd).await.unwrap().unwrap()[..],
                &data[..]
            );
        }
    }

    #[tokio::test]
    async fn convert_tree_rejects_a_file_naming_a_tree() {
        let store = make_store().await;
        let inner = make_tree_data(&[]);
        let inner_sha = sha1_of(ObjectKind::Tree, &inner);
        let tree = make_tree_data(&[(100644, "not-a-blob", inner_sha)]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree);
        let pack = test_pack(&[(TREE, inner), (TREE, tree)]).await;
        let err = convert(pack, &store, tree_sha).await.unwrap_err();
        assert!(format!("{err}").contains("not a blob"), "{err}");
    }

    #[tokio::test]
    async fn convert_tree_rejects_a_missing_blob() {
        let store = make_store().await;
        let tree = make_tree_data(&[(100644, "gone", [0x42; 20])]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree);
        let pack = test_pack(&[(TREE, tree)]).await;
        let err = convert(pack, &store, tree_sha).await.unwrap_err();
        assert!(format!("{err}").contains("not found"), "{err}");
    }

    #[tokio::test]
    async fn a_stopped_conversion_ends() {
        let blob = b"never stored".to_vec();
        let blob_sha = sha1_of(ObjectKind::Blob, &blob);
        let tree = make_tree_data(&[(100644, "f", blob_sha)]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree);
        let pack = test_pack(&[(BLOB, blob), (TREE, tree)]).await;
        let (tx, _rx) = tokio::sync::mpsc::channel(1);
        let stop = AtomicBool::new(true);
        let err = convert_blocking(
            &pack,
            tree_sha,
            DigestFn::Sha256,
            ConvertSettings::new(2),
            &tx,
            &Budget::new(1024),
            &stop,
        )
        .unwrap_err();
        assert!(matches!(err, GitCloneError::Stopped), "{err}");
    }

    /// A tiny flush threshold forces multiple mid-walk uploads across
    /// sibling directories; everything must still land in CAS.
    #[tokio::test]
    async fn convert_tree_with_tiny_flush_threshold() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        let mut pack_objects: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut root_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
        let mut all_blobs: Vec<Vec<u8>> = Vec::new();
        for dir_idx in 0u8..4 {
            let mut sub_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
            for file_idx in 0u8..4 {
                let data = vec![dir_idx * 16 + file_idx; 40];
                let sha = sha1_of(ObjectKind::Blob, &data);
                pack_objects.push((BLOB, data.clone()));
                sub_entries.push((100644, format!("f{file_idx}"), sha));
                all_blobs.push(data);
            }
            let refs: Vec<(u32, &str, [u8; 20])> = sub_entries
                .iter()
                .map(|(m, n, s)| (*m, n.as_str(), *s))
                .collect();
            let sub_tree = make_tree_data(&refs);
            let sub_sha = sha1_of(ObjectKind::Tree, &sub_tree);
            pack_objects.push((TREE, sub_tree));
            root_entries.push((40000, format!("d{dir_idx}"), sub_sha));
        }
        let refs: Vec<(u32, &str, [u8; 20])> = root_entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let root_tree = make_tree_data(&refs);
        let root_sha = sha1_of(ObjectKind::Tree, &root_tree);
        pack_objects.push((TREE, root_tree));

        let pack = test_pack(&pack_objects).await;
        // 64-byte batches: every other blob is its own upload.
        let settings = ConvertSettings {
            batch_bytes: 64,
            ..ConvertSettings::new(4)
        };
        let (root_hash, _) = convert_tree(pack, &store, root_sha, digest_fn, settings)
            .await
            .unwrap();

        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.directories.len(), 4);
        for data in &all_blobs {
            let cd = ContentDigest::new(digest_fn, digest_fn.hash_data(data));
            let got = store.cas_get_blob(&cd).await.unwrap().unwrap();
            assert_eq!(&got[..], &data[..]);
        }
    }

    /// With the default (large) batches nothing is sent until the end; the
    /// final send must still deliver every blob to CAS.
    #[tokio::test]
    async fn convert_tree_root_drain_delivers_blobs() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        let blob = b"only flushed by the root drain".to_vec();
        let blob_sha = sha1_of(ObjectKind::Blob, &blob);
        let sub_tree = make_tree_data(&[(100644, "f", blob_sha)]);
        let sub_sha = sha1_of(ObjectKind::Tree, &sub_tree);
        let root_tree = make_tree_data(&[(40000, "d", sub_sha)]);
        let root_sha = sha1_of(ObjectKind::Tree, &root_tree);

        let pack = test_pack(&[(BLOB, blob.clone()), (TREE, sub_tree), (TREE, root_tree)]).await;
        let (root_hash, _) = convert(pack, &store, root_sha).await.unwrap();

        assert!(root_hash != [0u8; 32]);
        let cd = ContentDigest::new(digest_fn, digest_fn.hash_data(&blob));
        assert_eq!(
            &store.cas_get_blob(&cd).await.unwrap().unwrap()[..],
            &blob[..]
        );
    }

    #[tokio::test]
    async fn convert_tree_rejects_duplicate_file_names() {
        let store = make_store().await;

        let blob_a = b"content a".to_vec();
        let blob_b = b"content b".to_vec();
        let sha_a = sha1_of(ObjectKind::Blob, &blob_a);
        let sha_b = sha1_of(ObjectKind::Blob, &blob_b);
        let tree_data = make_tree_data(&[(100644, "dup.txt", sha_a), (100644, "dup.txt", sha_b)]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob_a), (BLOB, blob_b), (TREE, tree_data)]).await;
        let err = convert(pack, &store, tree_sha).await.unwrap_err();
        assert!(format!("{err}").contains("duplicate entry name"), "{err}");
    }

    #[tokio::test]
    async fn convert_tree_rejects_file_dir_name_collision() {
        let store = make_store().await;

        let blob = b"file content".to_vec();
        let blob_sha = sha1_of(ObjectKind::Blob, &blob);
        let sub_tree = make_tree_data(&[(100644, "inner.txt", blob_sha)]);
        let sub_sha = sha1_of(ObjectKind::Tree, &sub_tree);
        // A file and a directory with the same name.
        let tree_data = make_tree_data(&[(100644, "x", blob_sha), (40000, "x", sub_sha)]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob), (TREE, sub_tree), (TREE, tree_data)]).await;
        let err = convert(pack, &store, tree_sha).await.unwrap_err();
        assert!(format!("{err}").contains("duplicate entry name"), "{err}");
    }

    #[tokio::test]
    async fn convert_tree_rejects_file_symlink_name_collision() {
        let store = make_store().await;

        let blob = b"target".to_vec();
        let blob_sha = sha1_of(ObjectKind::Blob, &blob);
        let tree_data = make_tree_data(&[(100644, "x", blob_sha), (120000, "x", blob_sha)]);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob), (TREE, tree_data)]).await;
        let err = convert(pack, &store, tree_sha).await.unwrap_err();
        assert!(format!("{err}").contains("duplicate entry name"), "{err}");
    }

    #[tokio::test]
    async fn convert_tree_depth_capped() {
        let store = make_store().await;

        // A chain of nested trees deeper than the nesting cap must error.
        let blob = b"leaf".to_vec();
        let blob_sha = sha1_of(ObjectKind::Blob, &blob);
        let mut pack_objects: Vec<(u8, Vec<u8>)> = vec![(BLOB, blob)];

        let tree_data = make_tree_data(&[(100644, "f", blob_sha)]);
        let mut tree_sha = sha1_of(ObjectKind::Tree, &tree_data);
        pack_objects.push((TREE, tree_data));
        for _ in 0..fetch_git::MAX_TREE_DEPTH + 8 {
            let t = make_tree_data(&[(40000, "d", tree_sha)]);
            tree_sha = sha1_of(ObjectKind::Tree, &t);
            pack_objects.push((TREE, t));
        }

        let pack = test_pack(&pack_objects).await;
        let err = convert(pack, &store, tree_sha).await.unwrap_err();
        assert!(format!("{err}").contains("nesting"), "{err}");
    }

    /// Two sibling directories that reference the **same** subtree SHA:
    /// it is listed and stored once, and both refer to it.
    #[tokio::test]
    async fn convert_tree_shared_subtree_sha() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        // Build a single subtree with one file.
        let blob_data = b"shared subtree content";
        let blob_sha = sha1_of(ObjectKind::Blob, blob_data);
        let shared_tree_data = make_tree_data(&[(100644, "file.txt", blob_sha)]);
        let shared_tree_sha = sha1_of(ObjectKind::Tree, &shared_tree_data);

        // Root references the same subtree SHA under two different names.
        let root_tree_data = make_tree_data(&[
            (40000, "dir_a", shared_tree_sha),
            (40000, "dir_b", shared_tree_sha),
        ]);
        let root_tree_sha = sha1_of(ObjectKind::Tree, &root_tree_data);

        let pack = test_pack(&[
            (BLOB, blob_data.to_vec()),
            (TREE, shared_tree_data),
            (TREE, root_tree_data),
        ])
        .await;

        let (root_hash, _) = convert(pack, &store, root_tree_sha).await.unwrap();

        // Root should have 2 subdirectories with identical digests.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.directories.len(), 2);
        assert_eq!(dir.directories[0].name, "dir_a");
        assert_eq!(dir.directories[1].name, "dir_b");
        assert_eq!(dir.directories[0].digest, dir.directories[1].digest);

        // The blob should be in CAS.
        let blob_cd = ContentDigest::new(digest_fn, digest_fn.hash_data(blob_data));
        assert!(store.cas_get_blob(&blob_cd).await.unwrap().is_some());
    }

    /// Shared subtree SHA appears at different depths in the tree hierarchy:
    /// whichever path reaches it first, it is stored before both parents.
    #[tokio::test]
    async fn convert_tree_shared_subtree_cross_level() {
        let store = make_store().await;
        let digest_fn = DigestFn::Sha256;

        // Shared leaf subtree.
        let blob_data = b"leaf content";
        let blob_sha = sha1_of(ObjectKind::Blob, blob_data);
        let leaf_tree_data = make_tree_data(&[(100644, "leaf.txt", blob_sha)]);
        let leaf_tree_sha = sha1_of(ObjectKind::Tree, &leaf_tree_data);

        // dir_a: directly contains the shared subtree.
        let dir_a_data = make_tree_data(&[(40000, "shared", leaf_tree_sha)]);
        let dir_a_sha = sha1_of(ObjectKind::Tree, &dir_a_data);

        // dir_b > nested > shared: the shared subtree appears one level deeper.
        let nested_data = make_tree_data(&[(40000, "shared", leaf_tree_sha)]);
        let nested_sha = sha1_of(ObjectKind::Tree, &nested_data);

        let dir_b_data = make_tree_data(&[(40000, "nested", nested_sha)]);
        let dir_b_sha = sha1_of(ObjectKind::Tree, &dir_b_data);

        // Root has both dir_a and dir_b as siblings.
        let root_data = make_tree_data(&[(40000, "dir_a", dir_a_sha), (40000, "dir_b", dir_b_sha)]);
        let root_sha = sha1_of(ObjectKind::Tree, &root_data);

        let pack = test_pack(&[
            (BLOB, blob_data.to_vec()),
            (TREE, leaf_tree_data),
            (TREE, dir_a_data),
            (TREE, nested_data),
            (TREE, dir_b_data),
            (TREE, root_data),
        ])
        .await;

        let (root_hash, _) = convert(pack, &store, root_sha).await.unwrap();

        // Root should have 2 subdirectories.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.directories.len(), 2);

        // Both branches should resolve to directories containing the
        // shared subtree with the same digest.
        let dir_a_cd = ContentDigest::new(
            digest_fn,
            crate::store::parse_digest_hash(&dir.directories[0].digest.as_ref().unwrap().hash)
                .unwrap(),
        );
        let dir_a_bytes = store.cas_get_blob(&dir_a_cd).await.unwrap().unwrap();
        let dir_a = Directory::decode(dir_a_bytes).unwrap();
        assert_eq!(dir_a.directories.len(), 1);
        let shared_a_digest = &dir_a.directories[0].digest;

        let dir_b_cd = ContentDigest::new(
            digest_fn,
            crate::store::parse_digest_hash(&dir.directories[1].digest.as_ref().unwrap().hash)
                .unwrap(),
        );
        let dir_b_bytes = store.cas_get_blob(&dir_b_cd).await.unwrap().unwrap();
        let dir_b = Directory::decode(dir_b_bytes).unwrap();
        assert_eq!(dir_b.directories.len(), 1);
        // dir_b > nested > shared
        let nested_cd = ContentDigest::new(
            digest_fn,
            crate::store::parse_digest_hash(&dir_b.directories[0].digest.as_ref().unwrap().hash)
                .unwrap(),
        );
        let nested_bytes = store.cas_get_blob(&nested_cd).await.unwrap().unwrap();
        let nested = Directory::decode(nested_bytes).unwrap();
        assert_eq!(nested.directories.len(), 1);
        let shared_b_digest = &nested.directories[0].digest;

        // The shared subtree must produce the same REAPI digest in both branches.
        assert_eq!(shared_a_digest, shared_b_digest);
    }
}
