// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Git repository cloning with incremental REAPI Directory tree conversion.
//!
//! Clones a Git repository via the smart HTTP protocol with the packfile
//! spooled to disk and memory-mapped ([`fetch_git::clone_repo_spooled`]),
//! then walks the target tree, reading each object out of the pack on
//! demand: blobs stream into CAS in size-bounded batches, and Directory
//! protos are built from the resulting digests bottom-up. Peak memory stays
//! proportional to the pack index and the working set of the walk — not the
//! decompressed repository — so multi-gigabyte repositories can be ingested.

use std::fmt;
use std::future::Future;
use std::path::Path;
use std::pin::Pin;
use std::sync::Arc;
use std::time::Duration;

use bytes::Bytes;
use dashmap::DashMap;
use dial9::Dial9TokioHandle;
use openssl::ssl::SslConnector;
use prost::Message as _;

use protos::build::bazel::remote::execution::v2::{
    Digest, Directory, DirectoryNode, FileNode, SymlinkNode,
};

use fetch_git::objects::GitObjectType;
use fetch_git::packstore::PackStore;

use crate::store::{CacheStore, Compression, ContentDigest, DigestFn};

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

/// Default timeout for a full clone + ingest when the request doesn't set
/// one. Large repositories take minutes to download and index.
const DEFAULT_GIT_TIMEOUT: Duration = Duration::from_secs(1800);

/// Flush accumulated blob data to CAS once the walk-wide pending batch
/// reaches this size, bounding memory during the tree walk.
const BLOB_BATCH_FLUSH_BYTES: usize = 32 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------------------------------------------------

#[derive(Debug)]
pub(super) enum GitCloneError {
    RefNotFound(String),
    RequestFailed(String),
    HttpStatus(u16, String),
    Timeout,
    TooLarge(usize),
    InvalidPackfile(String),
    InvalidUri(String),
    StoreError(String),
    SubdirectoryNotFound(String),
}

impl fmt::Display for GitCloneError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RefNotFound(r) => write!(f, "ref not found: {r}"),
            Self::RequestFailed(msg) => write!(f, "request failed: {msg}"),
            Self::HttpStatus(code, msg) => write!(f, "HTTP {code}: {msg}"),
            Self::Timeout => write!(f, "git clone timed out"),
            Self::TooLarge(size) => write!(f, "repository too large: {size} bytes"),
            Self::InvalidPackfile(msg) => write!(f, "invalid packfile: {msg}"),
            Self::InvalidUri(msg) => write!(f, "invalid URI: {msg}"),
            Self::StoreError(msg) => write!(f, "storage error: {msg}"),
            Self::SubdirectoryNotFound(path) => write!(f, "subdirectory not found: {path}"),
        }
    }
}

impl From<fetch_git::GitFetchError> for GitCloneError {
    fn from(e: fetch_git::GitFetchError) -> Self {
        match e {
            fetch_git::GitFetchError::RefNotFound(s) => Self::RefNotFound(s),
            fetch_git::GitFetchError::RequestFailed(s) => Self::RequestFailed(s),
            fetch_git::GitFetchError::HttpStatus(code, msg) => Self::HttpStatus(code, msg),
            fetch_git::GitFetchError::Timeout => Self::Timeout,
            fetch_git::GitFetchError::TooLarge(s) => Self::TooLarge(s),
            fetch_git::GitFetchError::InvalidPackfile(s) => Self::InvalidPackfile(s),
            fetch_git::GitFetchError::InvalidUri(s) => Self::InvalidUri(s),
        }
    }
}

impl GitCloneError {
    pub(super) fn to_rpc_status(&self) -> protos::google::rpc::Status {
        let (code, message) = match self {
            Self::RefNotFound(msg) => (tonic::Code::NotFound as i32, msg.clone()),
            Self::RequestFailed(msg) => (tonic::Code::Unavailable as i32, msg.clone()),
            Self::HttpStatus(status, msg) => {
                let code = match *status {
                    404 => tonic::Code::NotFound,
                    401 | 403 => tonic::Code::PermissionDenied,
                    _ => tonic::Code::Unavailable,
                };
                (code as i32, format!("HTTP {status}: {msg}"))
            }
            Self::Timeout => (
                tonic::Code::DeadlineExceeded as i32,
                "git clone timed out".to_string(),
            ),
            Self::TooLarge(size) => (
                tonic::Code::ResourceExhausted as i32,
                format!("repository too large: {size} bytes"),
            ),
            Self::InvalidPackfile(msg) => (tonic::Code::Internal as i32, msg.clone()),
            Self::InvalidUri(msg) => (tonic::Code::InvalidArgument as i32, msg.clone()),
            Self::StoreError(msg) => (tonic::Code::Internal as i32, msg.clone()),
            Self::SubdirectoryNotFound(path) => (
                tonic::Code::NotFound as i32,
                format!("subdirectory not found: {path}"),
            ),
        };
        protos::google::rpc::Status {
            code,
            message,
            details: vec![],
        }
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

pub(super) fn find_vcs_branch<'a>(qualifiers: &'a [(String, String)]) -> Option<&'a str> {
    qualifiers
        .iter()
        .find(|(name, _)| name == "vcs.branch")
        .map(|(_, value)| value.as_str())
}

pub(super) fn find_vcs_commit<'a>(qualifiers: &'a [(String, String)]) -> Option<&'a str> {
    qualifiers
        .iter()
        .find(|(name, _)| name == "vcs.commit")
        .map(|(_, value)| value.as_str())
}

pub(super) fn find_directory_qualifier<'a>(qualifiers: &'a [(String, String)]) -> Option<&'a str> {
    qualifiers
        .iter()
        .find(|(name, _)| name == "directory")
        .map(|(_, value)| value.as_str())
}

fn find_resource_type<'a>(qualifiers: &'a [(String, String)]) -> Option<&'a str> {
    qualifiers
        .iter()
        .find(|(name, _)| name == "resource_type")
        .map(|(_, value)| value.as_str())
}

/// Returns `true` if the URI points to a Git repository accessible via smart HTTP.
///
/// A URI is considered a Git repo if it uses `http://` or `https://` AND either
/// ends with `.git` or the `resource_type` qualifier is `application/x-git`.
pub(super) fn is_git_uri(uri: &str, qualifiers: &[(String, String)]) -> bool {
    let lower = uri.to_ascii_lowercase();
    let is_http = lower.starts_with("http://") || lower.starts_with("https://");
    if !is_http {
        return false;
    }
    if lower.ends_with(".git") {
        return true;
    }
    matches!(find_resource_type(qualifiers), Some("application/x-git"))
}

/// Returns `true` if either `vcs.branch` or `vcs.commit` is present.
pub(super) fn has_vcs_qualifiers(qualifiers: &[(String, String)]) -> bool {
    qualifiers
        .iter()
        .any(|(name, _)| name == "vcs.branch" || name == "vcs.commit")
}

// ---------------------------------------------------------------------------------------------------------------------
// Subdirectory resolution
// ---------------------------------------------------------------------------------------------------------------------

/// Walk down a git tree by path components to find a subtree SHA.
fn resolve_subdirectory(
    pack: &PackStore,
    root_tree_sha: &[u8; 20],
    path: &str,
) -> Result<[u8; 20], GitCloneError> {
    let mut current_sha = *root_tree_sha;

    for component in path.split('/').filter(|c| !c.is_empty()) {
        let (obj_type, tree_data) = pack.get(&current_sha)?.ok_or_else(|| {
            GitCloneError::SubdirectoryNotFound(format!(
                "tree {} not found while resolving '{path}'",
                hex::encode(current_sha),
            ))
        })?;

        if obj_type != GitObjectType::Tree {
            return Err(GitCloneError::SubdirectoryNotFound(format!(
                "expected tree at {}, got {:?}",
                hex::encode(current_sha),
                obj_type,
            )));
        }

        let entries = fetch_git::tree::parse_tree(&tree_data)?;
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

// ---------------------------------------------------------------------------------------------------------------------
// Tree-to-REAPI conversion (incremental)
// ---------------------------------------------------------------------------------------------------------------------

/// A pending CAS blob write.
type BlobWrite = (ContentDigest, Bytes, Compression);

/// Accumulates blob writes across the entire tree walk, flushing to CAS in
/// size-bounded batches.
///
/// Shared by every directory conversion, so a repository of many small
/// directories issues a few large batch writes instead of one tiny write
/// per directory.
struct BlobBatcher {
    flush_bytes: usize,
    pending: std::sync::Mutex<(Vec<BlobWrite>, usize)>,
}

impl BlobBatcher {
    fn new(flush_bytes: usize) -> Self {
        Self {
            flush_bytes,
            pending: std::sync::Mutex::new((Vec::new(), 0)),
        }
    }

    /// Queue one blob write. Returns a full batch once the accumulated size
    /// crosses the flush threshold; the caller uploads it outside the lock.
    fn queue(&self, cd: ContentDigest, data: Bytes) -> Option<Vec<BlobWrite>> {
        let mut guard = self.pending.lock().expect("batcher lock poisoned");
        let (pending, bytes) = &mut *guard;
        *bytes += data.len();
        pending.push((cd, data, Compression::Identity));
        if *bytes >= self.flush_bytes {
            *bytes = 0;
            Some(std::mem::take(pending))
        } else {
            None
        }
    }

    /// Drain whatever remains. Called once when the walk completes.
    fn take_remaining(&self) -> Vec<BlobWrite> {
        let mut guard = self.pending.lock().expect("batcher lock poisoned");
        guard.1 = 0;
        std::mem::take(&mut guard.0)
    }
}

/// Shared state for one tree-to-REAPI conversion walk.
struct ConvertCtx {
    pack: Arc<PackStore>,
    store: Arc<CacheStore>,
    digest_fn: DigestFn,
    /// REAPI digests for git objects already stored or queued, avoiding
    /// redundant reads and CAS writes when the same blob or subtree appears
    /// at multiple paths.
    digest_cache: DashMap<[u8; 20], ([u8; 32], i64)>,
    batcher: BlobBatcher,
}

impl ConvertCtx {
    fn new(pack: Arc<PackStore>, store: Arc<CacheStore>, digest_fn: DigestFn) -> Arc<Self> {
        Self::with_flush_bytes(pack, store, digest_fn, BLOB_BATCH_FLUSH_BYTES)
    }

    fn with_flush_bytes(
        pack: Arc<PackStore>,
        store: Arc<CacheStore>,
        digest_fn: DigestFn,
        flush_bytes: usize,
    ) -> Arc<Self> {
        Arc::new(Self {
            pack,
            store,
            digest_fn,
            digest_cache: DashMap::new(),
            batcher: BlobBatcher::new(flush_bytes),
        })
    }

    async fn upload(&self, batch: Vec<BlobWrite>) -> Result<(), GitCloneError> {
        if batch.is_empty() {
            return Ok(());
        }
        self.store
            .cas_put_blob_batch(batch)
            .await
            .map_err(|e| GitCloneError::StoreError(e.to_string()))
    }
}

/// Convert a git tree into an REAPI Directory, storing blobs in CAS as the
/// walk encounters them.
///
/// Objects are read on demand from the memory-mapped pack, so nothing needs
/// to be claimed or freed: sibling subtrees convert concurrently against the
/// shared read-only [`PackStore`]. Blob writes accumulate in the shared
/// [`BlobBatcher`] and flush in size-bounded batches; the root call (depth 0)
/// drains the batcher before returning, so a returned root digest implies
/// every referenced blob is in CAS.
///
/// Digests become visible in `digest_cache` as soon as a blob is queued —
/// nothing reads blob content back during conversion, so visibility does not
/// require the write to have flushed. Two siblings racing on the same SHA
/// may both read and hash it, but only the entry-claim winner queues the
/// upload.
fn convert_tree_to_reapi(
    ctx: Arc<ConvertCtx>,
    tree_sha: [u8; 20],
    depth: usize,
) -> Pin<Box<dyn Future<Output = Result<([u8; 32], i64), GitCloneError>> + Send>> {
    Box::pin(async move {
        // Nesting this deep only occurs in adversarial packs; unbounded
        // recursion would eventually overflow the stack when polled.
        if depth >= fetch_git::MAX_TREE_DEPTH {
            return Err(GitCloneError::InvalidPackfile(format!(
                "tree nesting exceeds {} levels",
                fetch_git::MAX_TREE_DEPTH
            )));
        }

        // A subtree already converted elsewhere (shared SHA across paths).
        if let Some(cached) = ctx.digest_cache.get(&tree_sha) {
            return Ok(*cached.value());
        }

        let entries = match ctx.pack.get(&tree_sha)? {
            Some((GitObjectType::Tree, data)) => fetch_git::tree::parse_tree(&data)?,
            Some((obj_type, _)) => {
                return Err(GitCloneError::InvalidPackfile(format!(
                    "expected tree, got {:?} for {}",
                    obj_type,
                    hex::encode(tree_sha),
                )));
            }
            None => {
                return Err(GitCloneError::InvalidPackfile(format!(
                    "tree object {} not found in packfile",
                    hex::encode(tree_sha),
                )));
            }
        };

        let mut symlinks = Vec::new();
        let mut dir_entries = Vec::new();
        // (name, hash, size, is_executable) for each file entry
        let mut file_entries: Vec<(String, [u8; 32], i64, bool)> = Vec::new();

        // Phase A: classify entries, reading blobs out of the pack and
        // queueing them on the shared batcher.
        for entry in &entries {
            if entry.is_submodule() {
                tracing::debug!(name = %entry.name, "skipping submodule entry");
                continue;
            }

            if entry.is_symlink() {
                let Some((_, data)) = ctx.pack.get(&entry.sha)? else {
                    return Err(GitCloneError::InvalidPackfile(format!(
                        "symlink blob {} not found for '{}'",
                        hex::encode(entry.sha),
                        entry.name,
                    )));
                };
                symlinks.push(SymlinkNode {
                    name: entry.name.clone(),
                    target: String::from_utf8_lossy(&data).into_owned(),
                    node_properties: None,
                });
                continue;
            }

            if entry.is_dir() {
                dir_entries.push((entry.name.clone(), entry.sha));
                continue;
            }

            // Regular or executable file.
            let (h, s) = if let Some(cached) = ctx.digest_cache.get(&entry.sha) {
                *cached.value()
            } else {
                let Some((obj_type, data)) = ctx.pack.get(&entry.sha)? else {
                    return Err(GitCloneError::InvalidPackfile(format!(
                        "blob {} not found for file '{}'",
                        hex::encode(entry.sha),
                        entry.name,
                    )));
                };
                if obj_type != GitObjectType::Blob {
                    return Err(GitCloneError::InvalidPackfile(format!(
                        "file entry '{}' references a {obj_type:?}, not a blob",
                        entry.name,
                    )));
                }
                let h = ctx.digest_fn.hash_data(&data);
                let s = data.len() as i64;

                // Claim the SHA atomically: the winner queues the upload,
                // a racing loser reuses the winner's digest and drops its
                // copy. The full batch (if any) uploads outside the entry
                // guard so no DashMap shard lock is held across an await.
                let mut full_batch = None;
                let claimed = match ctx.digest_cache.entry(entry.sha) {
                    dashmap::mapref::entry::Entry::Occupied(e) => *e.get(),
                    dashmap::mapref::entry::Entry::Vacant(v) => {
                        v.insert((h, s));
                        let cd = ContentDigest::new(ctx.digest_fn, h);
                        full_batch = ctx.batcher.queue(cd, Bytes::from(data));
                        (h, s)
                    }
                };
                if let Some(batch) = full_batch {
                    ctx.upload(batch).await?;
                }
                claimed
            };
            file_entries.push((entry.name.clone(), h, s, entry.is_executable()));
        }

        // Phase B: process sibling subtrees concurrently.
        let mut directories = Vec::new();
        let mut subtree_futures = Vec::new();
        for (name, sha) in dir_entries {
            if let Some(cached) = ctx.digest_cache.get(&sha) {
                let (h, s) = *cached.value();
                directories.push(DirectoryNode {
                    name,
                    digest: Some(Digest {
                        hash: hex::encode(h),
                        size_bytes: s,
                    }),
                });
            } else {
                let fut_ctx = Arc::clone(&ctx);
                subtree_futures.push(async move {
                    // Spawned as a task so deeply nested trees suspend on
                    // the heap; awaiting the recursive future directly would
                    // poll the whole chain on one stack and overflow it.
                    let (hash, size) = tokio::spawn(convert_tree_to_reapi(fut_ctx, sha, depth + 1))
                        .await
                        .map_err(|e| {
                            GitCloneError::RequestFailed(format!("subtree conversion failed: {e}"))
                        })??;
                    Ok::<_, GitCloneError>(DirectoryNode {
                        name,
                        digest: Some(Digest {
                            hash: hex::encode(hash),
                            size_bytes: size,
                        }),
                    })
                });
            }
        }
        use futures::stream::{self, StreamExt as _, TryStreamExt as _};
        let concurrent_dirs: Vec<DirectoryNode> = stream::iter(subtree_futures)
            .buffer_unordered(64)
            .try_collect()
            .await?;
        directories.extend(concurrent_dirs);

        // At the root, every blob in the walk has been queued by now (files
        // are queued in Phase A of each node, and all descendants completed
        // in Phase B above). Drain the batcher so the root digest is only
        // returned once all referenced blobs are in CAS.
        if depth == 0 {
            let batch = ctx.batcher.take_remaining();
            ctx.upload(batch).await?;
        }

        // Phase C: build FileNode entries from pre-computed digests.
        let mut files = Vec::new();
        for (name, hash, size, is_exec) in file_entries {
            files.push(FileNode {
                name,
                digest: Some(Digest {
                    hash: hex::encode(hash),
                    size_bytes: size,
                }),
                is_executable: is_exec,
                node_properties: None,
            });
        }

        // REAPI requires entries sorted by name within each category
        files.sort_by(|a, b| a.name.cmp(&b.name));
        directories.sort_by(|a, b| a.name.cmp(&b.name));
        symlinks.sort_by(|a, b| a.name.cmp(&b.name));

        // REAPI also requires names to be unique across all three
        // categories. Git enforces the same invariant (fsck's
        // duplicateEntries), so duplicates only appear in hostile packs —
        // and would make the resulting Directory ambiguous to materialize.
        let mut names: Vec<&str> = files
            .iter()
            .map(|f| f.name.as_str())
            .chain(directories.iter().map(|d| d.name.as_str()))
            .chain(symlinks.iter().map(|s| s.name.as_str()))
            .collect();
        names.sort_unstable();
        if let Some(pair) = names.windows(2).find(|w| w[0] == w[1]) {
            return Err(GitCloneError::InvalidPackfile(format!(
                "duplicate entry name {:?} in tree {}",
                pair[0],
                hex::encode(tree_sha)
            )));
        }
        drop(names);

        let dir = Directory {
            files,
            directories,
            symlinks,
            node_properties: None,
        };
        let dir_bytes = dir.encode_to_vec();
        let dir_hash = ctx.digest_fn.hash_data(&dir_bytes);
        let dir_size = dir_bytes.len() as i64;

        let cd = ContentDigest::new(ctx.digest_fn, dir_hash);
        ctx.store
            .cas_put_blob_prehashed(&cd, Bytes::from(dir_bytes), Compression::Identity)
            .await
            .map_err(|e| GitCloneError::StoreError(e.to_string()))?;

        // Cache the tree digest so shared subtrees (same SHA in multiple
        // parent directories) don't fail on the second encounter.
        ctx.digest_cache.insert(tree_sha, (dir_hash, dir_size));

        Ok((dir_hash, dir_size))
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------------------------------------------------

/// Clone a Git repository and convert its tree to REAPI Directory format.
///
/// Supports `vcs.branch` and `vcs.commit` qualifiers for ref targeting, and
/// the `directory` qualifier for subdirectory selection. The packfile is
/// spooled to disk under `spool_dir` (system temp when `None`) and objects
/// are read on demand; blobs stream into CAS in bounded batches during the
/// tree walk.
pub(super) async fn fetch_git_directory(
    ssl_connector: &SslConnector,
    store: &Arc<CacheStore>,
    uri: &str,
    qualifiers: &[(String, String)],
    timeout: Option<Duration>,
    digest_fn: DigestFn,
    spool_dir: Option<&Path>,
    handle: &Dial9TokioHandle,
) -> Result<GitCloneResult, GitCloneError> {
    let branch = find_vcs_branch(qualifiers);
    let commit = find_vcs_commit(qualifiers);
    let subdir = find_directory_qualifier(qualifiers);

    let timeout = timeout.unwrap_or(DEFAULT_GIT_TIMEOUT);

    // Clone the repository: pack on disk, index in memory.
    let rss_before = rss_mib();
    let cloned = fetch_git::clone_repo_spooled(
        ssl_connector,
        uri,
        branch,
        commit,
        Some(timeout),
        spool_dir,
        handle,
    )
    .await?;
    let pack = Arc::new(cloned.pack);

    let mut tree_count = 0usize;
    let mut blob_count = 0usize;
    for entry in pack.index().entries() {
        match entry.obj_type {
            GitObjectType::Tree => tree_count += 1,
            GitObjectType::Blob => blob_count += 1,
            _ => {}
        }
    }
    tracing::info!(
        uri,
        commit = %hex::encode(cloned.commit_sha),
        tree = %hex::encode(cloned.tree_sha),
        total_objects = pack.object_count(),
        trees = tree_count,
        blobs = blob_count,
        pack_mib = pack.pack_size() / (1024 * 1024),
        rss_before_mib = rss_before.unwrap_or(0),
        rss_after_mib = rss_mib().unwrap_or(0),
        "cloned git repository (spooled)",
    );

    // Resolve subdirectory if requested
    let target_tree_sha = if let Some(path) = subdir {
        resolve_subdirectory(&pack, &cloned.tree_sha, path)?
    } else {
        cloned.tree_sha
    };

    // Convert the git tree to REAPI Directory format, reading objects from
    // the mapped pack and streaming blobs into CAS.
    let ctx = ConvertCtx::new(Arc::clone(&pack), Arc::clone(store), digest_fn);

    tracing::info!(
        rss_mib = rss_mib().unwrap_or(0),
        "starting tree-to-REAPI conversion",
    );

    let (root_hash, root_size) =
        convert_tree_to_reapi(Arc::clone(&ctx), target_tree_sha, 0).await?;

    tracing::info!(
        cached_digests = ctx.digest_cache.len(),
        rss_mib = rss_mib().unwrap_or(0),
        "tree-to-REAPI conversion complete",
    );

    Ok(GitCloneResult {
        root_digest_hash: root_hash,
        root_digest_size: root_size,
    })
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

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

    // --- qualifier finders ---

    #[test]
    fn find_vcs_branch_present() {
        let q = vec![("vcs.branch".into(), "develop".into())];
        assert_eq!(find_vcs_branch(&q), Some("develop"));
    }

    #[test]
    fn find_vcs_branch_absent() {
        let q: Vec<(String, String)> = vec![];
        assert_eq!(find_vcs_branch(&q), None);
    }

    #[test]
    fn find_vcs_commit_present() {
        let q = vec![(
            "vcs.commit".into(),
            "aabbccddee00112233445566778899aabbccddee".into(),
        )];
        assert_eq!(
            find_vcs_commit(&q),
            Some("aabbccddee00112233445566778899aabbccddee")
        );
    }

    #[test]
    fn find_directory_qualifier_present() {
        let q = vec![("directory".into(), "src/lib".into())];
        assert_eq!(find_directory_qualifier(&q), Some("src/lib"));
    }

    #[test]
    fn find_directory_qualifier_absent() {
        let q = vec![("vcs.branch".into(), "main".into())];
        assert_eq!(find_directory_qualifier(&q), None);
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

    fn sha1_of(obj_type: GitObjectType, data: &[u8]) -> [u8; 20] {
        fetch_git::objects::git_sha1(obj_type, data)
    }

    /// Packfile type bits for test objects.
    const COMMIT: u8 = 1;
    const TREE: u8 = 2;
    const BLOB: u8 = 3;

    /// Build a PackStore over a synthetic pack holding the given objects.
    async fn test_pack(objects: &[(u8, Vec<u8>)]) -> Arc<PackStore> {
        let mut b = fetch_git::testpack::PackBuilder::new();
        for (type_bits, data) in objects {
            b.object(*type_bits, data);
        }
        let pack = b.build();
        let spooled = fetch_git::spool::SpooledPack::spool(
            std::io::Cursor::new(pack.clone()),
            &std::env::temp_dir(),
            pack.len(),
        )
        .await
        .unwrap();
        Arc::new(PackStore::open(spooled, u32::MAX).unwrap())
    }

    /// Conversion context over a test pack and store, with the default
    /// flush threshold.
    fn make_ctx(pack: Arc<PackStore>, store: Arc<CacheStore>) -> Arc<ConvertCtx> {
        ConvertCtx::new(pack, store, DigestFn::Sha256)
    }

    #[tokio::test]
    async fn resolve_subdirectory_single_level() {
        let blob_data = b"file content";
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        let sub_tree_data = make_tree_data(&[(100644, "file.txt", blob_sha)]);
        let sub_tree_sha = sha1_of(GitObjectType::Tree, &sub_tree_data);
        let root_tree_data = make_tree_data(&[(40000, "src", sub_tree_sha)]);
        let root_tree_sha = sha1_of(GitObjectType::Tree, &root_tree_data);

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
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        let inner_data = make_tree_data(&[(100644, "f.txt", blob_sha)]);
        let inner_sha = sha1_of(GitObjectType::Tree, &inner_data);
        let mid_data = make_tree_data(&[(40000, "inner", inner_sha)]);
        let mid_sha = sha1_of(GitObjectType::Tree, &mid_data);
        let root_data = make_tree_data(&[(40000, "outer", mid_sha)]);
        let root_sha = sha1_of(GitObjectType::Tree, &root_data);

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
        let root_sha = sha1_of(GitObjectType::Tree, &root_data);
        let pack = test_pack(&[(TREE, root_data)]).await;

        let result = resolve_subdirectory(&pack, &root_sha, "nonexistent");
        assert!(result.is_err());
        let msg = format!("{}", result.unwrap_err());
        assert!(msg.contains("nonexistent"));
    }

    #[tokio::test]
    async fn resolve_subdirectory_empty_path() {
        let root_data = make_tree_data(&[]);
        let root_sha = sha1_of(GitObjectType::Tree, &root_data);
        let pack = test_pack(&[(TREE, root_data)]).await;

        let result = resolve_subdirectory(&pack, &root_sha, "").unwrap();
        assert_eq!(result, root_sha);
    }

    // --- error → gRPC status mapping ---

    #[test]
    fn error_to_rpc_status_ref_not_found() {
        let e = GitCloneError::RefNotFound("main".into());
        assert_eq!(e.to_rpc_status().code, tonic::Code::NotFound as i32);
    }

    #[test]
    fn error_to_rpc_status_timeout() {
        let e = GitCloneError::Timeout;
        assert_eq!(e.to_rpc_status().code, tonic::Code::DeadlineExceeded as i32);
    }

    #[test]
    fn error_to_rpc_status_too_large() {
        let e = GitCloneError::TooLarge(999);
        assert_eq!(
            e.to_rpc_status().code,
            tonic::Code::ResourceExhausted as i32
        );
    }

    #[test]
    fn error_to_rpc_status_http_404() {
        let e = GitCloneError::HttpStatus(404, "Not Found".into());
        assert_eq!(e.to_rpc_status().code, tonic::Code::NotFound as i32);
    }

    #[test]
    fn error_to_rpc_status_http_403() {
        let e = GitCloneError::HttpStatus(403, "Forbidden".into());
        assert_eq!(e.to_rpc_status().code, tonic::Code::PermissionDenied as i32);
    }

    #[test]
    fn error_to_rpc_status_invalid_uri() {
        let e = GitCloneError::InvalidUri("bad".into());
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
    fn error_from_git_fetch_error() {
        let e: GitCloneError = fetch_git::GitFetchError::Timeout.into();
        assert!(matches!(e, GitCloneError::Timeout));

        let e: GitCloneError = fetch_git::GitFetchError::RefNotFound("main".into()).into();
        assert!(matches!(e, GitCloneError::RefNotFound(_)));
    }

    // --- convert_tree_to_reapi integration tests ---

    async fn test_store() -> Arc<CacheStore> {
        Arc::new(
            CacheStore::open(
                crate::store::StoreBackend::Memory,
                crate::store::CacheStoreSettings::default(),
            )
            .await
            .unwrap(),
        )
    }

    #[tokio::test]
    async fn convert_tree_single_file() {
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        let blob_data = b"hello world";
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        let tree_data = make_tree_data(&[(100644, "file.txt", blob_sha)]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob_data.to_vec()), (TREE, tree_data)]).await;

        let (root_hash, root_size) =
            convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), tree_sha, 0)
                .await
                .unwrap();

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
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        let target_blob = b"../target/file";
        let target_sha = sha1_of(GitObjectType::Blob, target_blob);
        let tree_data = make_tree_data(&[(120000, "link", target_sha)]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, target_blob.to_vec()), (TREE, tree_data)]).await;

        let (root_hash, _) = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), tree_sha, 0)
            .await
            .unwrap();

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
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        let mut pack_objects: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut tree_entries = Vec::new();
        let mut blob_contents: Vec<(&str, Vec<u8>)> = Vec::new();
        for i in 0u8..10 {
            let data = vec![i; 100 + i as usize];
            let sha = sha1_of(GitObjectType::Blob, &data);
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
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);
        pack_objects.push((TREE, tree_data));

        let pack = test_pack(&pack_objects).await;
        let (root_hash, _) = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), tree_sha, 0)
            .await
            .unwrap();

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
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        // Sub-tree: one file
        let child_blob = b"child content";
        let child_sha = sha1_of(GitObjectType::Blob, child_blob);
        let sub_tree_data = make_tree_data(&[(100644, "child.txt", child_sha)]);
        let sub_tree_sha = sha1_of(GitObjectType::Tree, &sub_tree_data);

        // Root: one file + one directory
        let root_blob = b"root content";
        let root_blob_sha = sha1_of(GitObjectType::Blob, root_blob);
        let root_tree_data = make_tree_data(&[
            (100644, "README.md", root_blob_sha),
            (40000, "src", sub_tree_sha),
        ]);
        let root_tree_sha = sha1_of(GitObjectType::Tree, &root_tree_data);

        let pack = test_pack(&[
            (BLOB, child_blob.to_vec()),
            (TREE, sub_tree_data),
            (BLOB, root_blob.to_vec()),
            (TREE, root_tree_data),
        ])
        .await;

        let (root_hash, _) =
            convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), root_tree_sha, 0)
                .await
                .unwrap();

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
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        // Same blob content referenced by two different file entries.
        let blob_data = b"shared content";
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        let tree_data = make_tree_data(&[
            (100644, "copy_a.txt", blob_sha),
            (100644, "copy_b.txt", blob_sha),
        ]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob_data.to_vec()), (TREE, tree_data)]).await;

        let (root_hash, _) = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), tree_sha, 0)
            .await
            .unwrap();

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
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        // Build 4 sibling subtrees, each with 3 unique blobs.
        let mut pack_objects: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut root_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
        let mut all_blob_data: Vec<Vec<u8>> = Vec::new();
        for dir_idx in 0u8..4 {
            let mut sub_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
            for file_idx in 0u8..3 {
                let data = vec![dir_idx * 10 + file_idx; 50 + file_idx as usize];
                let sha = sha1_of(GitObjectType::Blob, &data);
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
            let sub_sha = sha1_of(GitObjectType::Tree, &sub_tree);
            pack_objects.push((TREE, sub_tree));
            root_entries.push((40000, format!("dir_{dir_idx}"), sub_sha));
        }

        let root_refs: Vec<(u32, &str, [u8; 20])> = root_entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let root_tree = make_tree_data(&root_refs);
        let root_sha = sha1_of(GitObjectType::Tree, &root_tree);
        pack_objects.push((TREE, root_tree));

        let pack = test_pack(&pack_objects).await;
        let (root_hash, _) = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), root_sha, 0)
            .await
            .unwrap();

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
                hex_to_hash(&sub_dir.digest.as_ref().unwrap().hash),
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
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        // Shared blob referenced by multiple sibling subtrees.
        let shared_data = b"shared across dirs";
        let shared_sha = sha1_of(GitObjectType::Blob, shared_data);
        let mut pack_objects: Vec<(u8, Vec<u8>)> = vec![(BLOB, shared_data.to_vec())];

        // Build 3 subtrees that each reference the shared blob plus a unique blob.
        let mut root_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
        let mut unique_blobs: Vec<Vec<u8>> = Vec::new();
        for i in 0u8..3 {
            let unique_data = vec![i + 100; 80];
            let unique_sha = sha1_of(GitObjectType::Blob, &unique_data);
            pack_objects.push((BLOB, unique_data.clone()));
            unique_blobs.push(unique_data);

            let sub_tree = make_tree_data(&[
                (100644, "shared.txt", shared_sha),
                (100644, "unique.txt", unique_sha),
            ]);
            let sub_sha = sha1_of(GitObjectType::Tree, &sub_tree);
            pack_objects.push((TREE, sub_tree));
            root_entries.push((40000, format!("dir_{i}"), sub_sha));
        }

        let root_refs: Vec<(u32, &str, [u8; 20])> = root_entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let root_tree = make_tree_data(&root_refs);
        let root_sha = sha1_of(GitObjectType::Tree, &root_tree);
        pack_objects.push((TREE, root_tree));

        let pack = test_pack(&pack_objects).await;
        let (root_hash, _) = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), root_sha, 0)
            .await
            .unwrap();

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
                hex_to_hash(&sub_dir.digest.as_ref().unwrap().hash),
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

    // --- BlobBatcher ---

    #[test]
    fn batcher_below_threshold_accumulates() {
        let b = BlobBatcher::new(100);
        let cd = ContentDigest::new(DigestFn::Sha256, [0u8; 32]);
        assert!(b.queue(cd, Bytes::from_static(b"12345")).is_none());
        assert!(b.queue(cd, Bytes::from_static(b"67890")).is_none());
        let remaining = b.take_remaining();
        assert_eq!(remaining.len(), 2);
        // Drained: nothing left.
        assert!(b.take_remaining().is_empty());
    }

    #[test]
    fn batcher_crossing_threshold_returns_batch() {
        let b = BlobBatcher::new(8);
        let cd = ContentDigest::new(DigestFn::Sha256, [0u8; 32]);
        assert!(b.queue(cd, Bytes::from_static(b"1234")).is_none());
        let batch = b.queue(cd, Bytes::from_static(b"5678")).unwrap();
        assert_eq!(batch.len(), 2);
        // Counter reset: the next small blob accumulates again.
        assert!(b.queue(cd, Bytes::from_static(b"a")).is_none());
        assert_eq!(b.take_remaining().len(), 1);
    }

    /// A tiny flush threshold forces multiple mid-walk uploads across
    /// sibling directories; everything must still land in CAS.
    #[tokio::test]
    async fn convert_tree_with_tiny_flush_threshold() {
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        let mut pack_objects: Vec<(u8, Vec<u8>)> = Vec::new();
        let mut root_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
        let mut all_blobs: Vec<Vec<u8>> = Vec::new();
        for dir_idx in 0u8..4 {
            let mut sub_entries: Vec<(u32, String, [u8; 20])> = Vec::new();
            for file_idx in 0u8..4 {
                let data = vec![dir_idx * 16 + file_idx; 40];
                let sha = sha1_of(GitObjectType::Blob, &data);
                pack_objects.push((BLOB, data.clone()));
                sub_entries.push((100644, format!("f{file_idx}"), sha));
                all_blobs.push(data);
            }
            let refs: Vec<(u32, &str, [u8; 20])> = sub_entries
                .iter()
                .map(|(m, n, s)| (*m, n.as_str(), *s))
                .collect();
            let sub_tree = make_tree_data(&refs);
            let sub_sha = sha1_of(GitObjectType::Tree, &sub_tree);
            pack_objects.push((TREE, sub_tree));
            root_entries.push((40000, format!("d{dir_idx}"), sub_sha));
        }
        let refs: Vec<(u32, &str, [u8; 20])> = root_entries
            .iter()
            .map(|(m, n, s)| (*m, n.as_str(), *s))
            .collect();
        let root_tree = make_tree_data(&refs);
        let root_sha = sha1_of(GitObjectType::Tree, &root_tree);
        pack_objects.push((TREE, root_tree));

        let pack = test_pack(&pack_objects).await;
        // 64-byte threshold: every other blob triggers a flush.
        let ctx = ConvertCtx::with_flush_bytes(pack, Arc::clone(&store), digest_fn, 64);
        let (root_hash, _) = convert_tree_to_reapi(ctx, root_sha, 0).await.unwrap();

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

    /// With the default (large) threshold nothing flushes mid-walk; the
    /// root-level drain must still deliver every blob to CAS.
    #[tokio::test]
    async fn convert_tree_root_drain_delivers_blobs() {
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        let blob = b"only flushed by the root drain".to_vec();
        let blob_sha = sha1_of(GitObjectType::Blob, &blob);
        let sub_tree = make_tree_data(&[(100644, "f", blob_sha)]);
        let sub_sha = sha1_of(GitObjectType::Tree, &sub_tree);
        let root_tree = make_tree_data(&[(40000, "d", sub_sha)]);
        let root_sha = sha1_of(GitObjectType::Tree, &root_tree);

        let pack = test_pack(&[(BLOB, blob.clone()), (TREE, sub_tree), (TREE, root_tree)]).await;
        let (root_hash, _) = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), root_sha, 0)
            .await
            .unwrap();

        assert!(root_hash != [0u8; 32]);
        let cd = ContentDigest::new(digest_fn, digest_fn.hash_data(&blob));
        assert_eq!(
            &store.cas_get_blob(&cd).await.unwrap().unwrap()[..],
            &blob[..]
        );
    }

    #[tokio::test]
    async fn convert_tree_rejects_duplicate_file_names() {
        let store = test_store().await;

        let blob_a = b"content a".to_vec();
        let blob_b = b"content b".to_vec();
        let sha_a = sha1_of(GitObjectType::Blob, &blob_a);
        let sha_b = sha1_of(GitObjectType::Blob, &blob_b);
        let tree_data = make_tree_data(&[(100644, "dup.txt", sha_a), (100644, "dup.txt", sha_b)]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob_a), (BLOB, blob_b), (TREE, tree_data)]).await;
        let err = convert_tree_to_reapi(make_ctx(pack, store), tree_sha, 0)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("duplicate entry name"), "{err}");
    }

    #[tokio::test]
    async fn convert_tree_rejects_file_dir_name_collision() {
        let store = test_store().await;

        let blob = b"file content".to_vec();
        let blob_sha = sha1_of(GitObjectType::Blob, &blob);
        let sub_tree = make_tree_data(&[(100644, "inner.txt", blob_sha)]);
        let sub_sha = sha1_of(GitObjectType::Tree, &sub_tree);
        // A file and a directory with the same name.
        let tree_data = make_tree_data(&[(100644, "x", blob_sha), (40000, "x", sub_sha)]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob), (TREE, sub_tree), (TREE, tree_data)]).await;
        let err = convert_tree_to_reapi(make_ctx(pack, store), tree_sha, 0)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("duplicate entry name"), "{err}");
    }

    #[tokio::test]
    async fn convert_tree_rejects_file_symlink_name_collision() {
        let store = test_store().await;

        let blob = b"target".to_vec();
        let blob_sha = sha1_of(GitObjectType::Blob, &blob);
        let tree_data = make_tree_data(&[(100644, "x", blob_sha), (120000, "x", blob_sha)]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);

        let pack = test_pack(&[(BLOB, blob), (TREE, tree_data)]).await;
        let err = convert_tree_to_reapi(make_ctx(pack, store), tree_sha, 0)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("duplicate entry name"), "{err}");
    }

    #[tokio::test]
    async fn convert_tree_depth_capped() {
        let store = test_store().await;

        // A chain of nested trees deeper than the recursion cap must error
        // rather than overflow the stack when the future tree is polled.
        let blob = b"leaf".to_vec();
        let blob_sha = sha1_of(GitObjectType::Blob, &blob);
        let mut pack_objects: Vec<(u8, Vec<u8>)> = vec![(BLOB, blob)];

        let tree_data = make_tree_data(&[(100644, "f", blob_sha)]);
        let mut tree_sha = sha1_of(GitObjectType::Tree, &tree_data);
        pack_objects.push((TREE, tree_data));
        for _ in 0..fetch_git::MAX_TREE_DEPTH + 8 {
            let t = make_tree_data(&[(40000, "d", tree_sha)]);
            tree_sha = sha1_of(GitObjectType::Tree, &t);
            pack_objects.push((TREE, t));
        }

        let pack = test_pack(&pack_objects).await;
        let err = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), tree_sha, 0)
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("nesting"), "{err}");
    }

    /// Two sibling directories that reference the **same** subtree SHA.
    /// Both concurrent tasks may convert it; digest_cache and idempotent
    /// CAS writes keep the result consistent.
    #[tokio::test]
    async fn convert_tree_shared_subtree_sha() {
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        // Build a single subtree with one file.
        let blob_data = b"shared subtree content";
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        let shared_tree_data = make_tree_data(&[(100644, "file.txt", blob_sha)]);
        let shared_tree_sha = sha1_of(GitObjectType::Tree, &shared_tree_data);

        // Root references the same subtree SHA under two different names.
        let root_tree_data = make_tree_data(&[
            (40000, "dir_a", shared_tree_sha),
            (40000, "dir_b", shared_tree_sha),
        ]);
        let root_tree_sha = sha1_of(GitObjectType::Tree, &root_tree_data);

        let pack = test_pack(&[
            (BLOB, blob_data.to_vec()),
            (TREE, shared_tree_data),
            (TREE, root_tree_data),
        ])
        .await;

        let (root_hash, _) =
            convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), root_tree_sha, 0)
                .await
                .unwrap();

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

    /// Shared subtree SHA appears at different depths in the tree hierarchy.
    /// One branch processes it first; a deeper branch encounters it later
    /// (or concurrently) and must use the cached result.
    #[tokio::test]
    async fn convert_tree_shared_subtree_cross_level() {
        let store = test_store().await;
        let digest_fn = DigestFn::Sha256;

        // Shared leaf subtree.
        let blob_data = b"leaf content";
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        let leaf_tree_data = make_tree_data(&[(100644, "leaf.txt", blob_sha)]);
        let leaf_tree_sha = sha1_of(GitObjectType::Tree, &leaf_tree_data);

        // dir_a: directly contains the shared subtree.
        let dir_a_data = make_tree_data(&[(40000, "shared", leaf_tree_sha)]);
        let dir_a_sha = sha1_of(GitObjectType::Tree, &dir_a_data);

        // dir_b > nested > shared: the shared subtree appears one level deeper.
        let nested_data = make_tree_data(&[(40000, "shared", leaf_tree_sha)]);
        let nested_sha = sha1_of(GitObjectType::Tree, &nested_data);

        let dir_b_data = make_tree_data(&[(40000, "nested", nested_sha)]);
        let dir_b_sha = sha1_of(GitObjectType::Tree, &dir_b_data);

        // Root has both dir_a and dir_b as siblings.
        let root_data = make_tree_data(&[(40000, "dir_a", dir_a_sha), (40000, "dir_b", dir_b_sha)]);
        let root_sha = sha1_of(GitObjectType::Tree, &root_data);

        let pack = test_pack(&[
            (BLOB, blob_data.to_vec()),
            (TREE, leaf_tree_data),
            (TREE, dir_a_data),
            (TREE, nested_data),
            (TREE, dir_b_data),
            (TREE, root_data),
        ])
        .await;

        let (root_hash, _) = convert_tree_to_reapi(make_ctx(pack, Arc::clone(&store)), root_sha, 0)
            .await
            .unwrap();

        // Root should have 2 subdirectories.
        let root_cd = ContentDigest::new(digest_fn, root_hash);
        let dir_bytes = store.cas_get_blob(&root_cd).await.unwrap().unwrap();
        let dir = Directory::decode(dir_bytes).unwrap();
        assert_eq!(dir.directories.len(), 2);

        // Both branches should resolve to directories containing the
        // shared subtree with the same digest.
        let dir_a_cd = ContentDigest::new(
            digest_fn,
            hex_to_hash(&dir.directories[0].digest.as_ref().unwrap().hash),
        );
        let dir_a_bytes = store.cas_get_blob(&dir_a_cd).await.unwrap().unwrap();
        let dir_a = Directory::decode(dir_a_bytes).unwrap();
        assert_eq!(dir_a.directories.len(), 1);
        let shared_a_digest = &dir_a.directories[0].digest;

        let dir_b_cd = ContentDigest::new(
            digest_fn,
            hex_to_hash(&dir.directories[1].digest.as_ref().unwrap().hash),
        );
        let dir_b_bytes = store.cas_get_blob(&dir_b_cd).await.unwrap().unwrap();
        let dir_b = Directory::decode(dir_b_bytes).unwrap();
        assert_eq!(dir_b.directories.len(), 1);
        // dir_b > nested > shared
        let nested_cd = ContentDigest::new(
            digest_fn,
            hex_to_hash(&dir_b.directories[0].digest.as_ref().unwrap().hash),
        );
        let nested_bytes = store.cas_get_blob(&nested_cd).await.unwrap().unwrap();
        let nested = Directory::decode(nested_bytes).unwrap();
        assert_eq!(nested.directories.len(), 1);
        let shared_b_digest = &nested.directories[0].digest;

        // The shared subtree must produce the same REAPI digest in both branches.
        assert_eq!(shared_a_digest, shared_b_digest);
    }

    fn hex_to_hash(hex_str: &str) -> [u8; 32] {
        let bytes = hex::decode(hex_str).unwrap();
        let mut hash = [0u8; 32];
        hash.copy_from_slice(&bytes);
        hash
    }
}
