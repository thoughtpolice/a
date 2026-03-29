// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git smart HTTP protocol client for fetching repository contents.
//!
//! This crate implements the subset of the Git smart HTTP protocol needed to
//! clone a repository at a specific ref. It is a pure-Rust implementation that
//! does not depend on libgit2 or gitoxide, making it easy to build and embed.
//!
//! # Protocol overview
//!
//! The Git smart HTTP transport uses two endpoints on the remote server:
//!
//! 1. **Ref discovery** (`GET /info/refs?service=git-upload-pack`): returns the
//!    list of refs (branches, tags, HEAD) and the server's capabilities, encoded
//!    as pkt-lines.
//!
//! 2. **Pack negotiation** (`POST /git-upload-pack`): the client sends a "want"
//!    request listing the commit(s) it needs, and the server responds with a
//!    packfile containing all reachable objects.
//!
//! # Clone flow
//!
//! [`clone_repo`] orchestrates the full sequence:
//!
//! ```text
//! 1. GET  /info/refs?service=git-upload-pack   → parse refs + capabilities
//! 2. Resolve target: branch name / commit SHA / HEAD
//! 3. POST /git-upload-pack  (want + done)      → receive packfile via side-band-64k
//! 4. Parse packfile: decompress objects, resolve OFS/REF deltas
//! 5. Return object map keyed by SHA-1, plus commit and tree hashes
//! ```
//!
//! The caller receives a [`CloneResult`] containing every object in the pack.
//! From there, use [`tree::parse_tree`] and [`walk_tree`] to traverse the
//! directory structure, or look up individual blobs by SHA-1 in the object map.
//!
//! # Modules
//!
//! | Module | Purpose |
//! |--------|---------|
//! | [`pktline`] | pkt-line framing (encode/decode) |
//! | [`refs`] | Ref discovery response parsing and ref resolution |
//! | [`transport`] | HTTP GET/POST over TCP + TLS (hyper + openssl) |
//! | [`objects`] | Git object types, SHA-1 hashing, hex parsing |
//! | [`packfile`] | Packfile parsing: header, objects, zlib, delta resolution |
//! | [`delta`] | Delta instruction decoding and application |
//! | [`tree`] | Git tree binary format + commit header parsing |
//!
//! # Limitations
//!
//! - Only supports the Git smart HTTP transport (not SSH or the legacy dumb
//!   HTTP protocol).
//! - Fetches the full object graph for the target commit (not a shallow clone).
//! - Follows at most one redirect, on the initial ref discovery request only
//!   (mirroring git's `http.followRedirects=initial` default).
//! - Submodule entries in trees are reported but not recursed into.
//! - [`clone_repo`] holds all objects in memory and caps the packfile at
//!   [`MAX_CLONE_SIZE`] (512 MiB). For large repositories use
//!   [`clone_repo_spooled`], which spools the pack to disk, memory-maps it,
//!   and serves objects on demand (capped at [`MAX_SPOOLED_CLONE_SIZE`]).

pub mod delta;
pub mod objects;
pub mod packfile;
pub mod packstore;
pub mod pktline;
pub mod refs;
pub mod sideband;
pub mod spool;
#[doc(hidden)]
pub mod testpack;
pub mod transport;
pub mod tree;

use std::collections::HashMap;
use std::fmt;
use std::time::Duration;

use dial9::Dial9TokioHandle;
use openssl::ssl::SslConnector;

use objects::GitObjectType;
use pktline::PktLine;

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

/// Maximum total size for fetched packfile data (512 MiB) on the in-memory
/// clone path ([`clone_repo`]).
pub const MAX_CLONE_SIZE: usize = 512 * 1024 * 1024;

/// Maximum decompressed size for a single Git object (2 GiB).
///
/// Declared object sizes come from attacker-controlled packfile headers, so
/// they must be bounded before any allocation. 2 GiB matches the largest blob
/// the cache-server storage layer will accept.
pub const MAX_GIT_OBJECT_SIZE: usize = 2 * 1024 * 1024 * 1024;

/// Default timeout for the overall clone operation.
pub const DEFAULT_TIMEOUT: Duration = Duration::from_secs(120);

/// Maximum number of objects allowed in a packfile on the in-memory clone
/// path ([`clone_repo`]).
pub const MAX_PACK_OBJECTS: u32 = 2_000_000;

/// Maximum on-disk pack size (32 GiB) for the spooled clone path
/// ([`clone_repo_spooled`]). Disk-backed, so far larger than
/// [`MAX_CLONE_SIZE`].
pub const MAX_SPOOLED_CLONE_SIZE: usize = 32 * 1024 * 1024 * 1024;

/// Maximum object count (64 M) for the spooled clone path. The pack index
/// costs ~36 bytes per object, so this bounds index memory at ~2.3 GiB;
/// full-history nixpkgs is around 20 M objects for scale.
pub const MAX_SPOOLED_PACK_OBJECTS: u32 = 64_000_000;

/// Default timeout for spooled clones: large packs take a while to both
/// download and index.
pub const DEFAULT_SPOOLED_TIMEOUT: Duration = Duration::from_secs(3600);

/// Maximum tree nesting depth accepted when walking a repository.
///
/// Real repositories stay far below this (Linux caps whole paths at 4096
/// bytes, so ~1000 single-character components); the limit exists so a
/// malicious pack cannot drive recursive tree walks into a stack overflow.
pub const MAX_TREE_DEPTH: usize = 1024;

// ---------------------------------------------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------------------------------------------

/// Errors from Git fetch operations.
#[derive(Debug)]
pub enum GitFetchError {
    /// The requested ref was not found.
    RefNotFound(String),
    /// Network or protocol error.
    RequestFailed(String),
    /// Non-success HTTP status.
    HttpStatus(u16, String),
    /// Operation timed out.
    Timeout,
    /// Response exceeds size limit.
    TooLarge(usize),
    /// Invalid packfile data.
    InvalidPackfile(String),
    /// Malformed URI.
    InvalidUri(String),
}

impl fmt::Display for GitFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RefNotFound(r) => write!(f, "ref not found: {r}"),
            Self::RequestFailed(msg) => write!(f, "request failed: {msg}"),
            Self::HttpStatus(code, msg) => write!(f, "HTTP {code}: {msg}"),
            Self::Timeout => write!(f, "operation timed out"),
            Self::TooLarge(size) => write!(
                f,
                "response too large: {size} bytes exceeds {MAX_CLONE_SIZE} byte limit"
            ),
            Self::InvalidPackfile(msg) => write!(f, "invalid packfile: {msg}"),
            Self::InvalidUri(msg) => write!(f, "invalid URI: {msg}"),
        }
    }
}

impl std::error::Error for GitFetchError {}

// ---------------------------------------------------------------------------------------------------------------
// Clone result
// ---------------------------------------------------------------------------------------------------------------

/// Result of a successful Git clone operation.
///
/// Contains every object from the packfile (commits, trees, blobs, tags) in a
/// flat map keyed by SHA-1. The `commit_sha` and `tree_sha` fields identify
/// the entry points for traversal.
///
/// Use [`walk_tree`] or [`tree::parse_tree`] to iterate the directory structure
/// starting from `tree_sha`.
pub struct CloneResult {
    /// All resolved objects keyed by their Git SHA-1. Values are
    /// `(object_type, raw_data)` pairs.
    pub objects: HashMap<[u8; 20], (GitObjectType, Vec<u8>)>,
    /// The SHA-1 of the target commit that was cloned.
    pub commit_sha: [u8; 20],
    /// The SHA-1 of the commit's root tree object.
    pub tree_sha: [u8; 20],
}

/// Result of a successful spooled Git clone.
///
/// Unlike [`CloneResult`], objects are not held in memory: the packfile
/// lives in an unlinked temporary file, and [`PackStore`](packstore::PackStore)
/// materializes objects on demand from the memory-mapped pack. This is the
/// path that scales to multi-gigabyte repositories.
pub struct ClonedPack {
    /// Random-access object store over the spooled pack.
    pub pack: packstore::PackStore,
    /// The SHA-1 of the target commit that was cloned (tags peeled).
    pub commit_sha: [u8; 20],
    /// The SHA-1 of the commit's root tree object.
    pub tree_sha: [u8; 20],
}

// ---------------------------------------------------------------------------------------------------------------
// Clone API
// ---------------------------------------------------------------------------------------------------------------

/// Clone a Git repository at a given ref via the smart HTTP protocol.
///
/// Performs a shallow clone (`deepen 1`) of the repository, fetching only the
/// objects reachable from the target commit's tree. The target is determined
/// by the following priority:
///
/// 1. `commit` -- if provided, use this 40-hex-char SHA-1 directly
/// 2. `branch` -- resolve via the server's advertised refs
/// 3. Default -- try HEAD, then `main`, then `master`
///
/// Returns all objects (resolved from the packfile) along with the target
/// commit and root tree SHA-1 hashes. The caller can then walk the tree
/// using [`tree::parse_tree`] and the object map.
///
/// The clone fetches the full object graph reachable from the target commit
/// (not a shallow clone). The packfile size is capped at [`MAX_CLONE_SIZE`].
///
/// The overall operation is subject to `timeout` (default: 120 seconds).
pub async fn clone_repo(
    ssl_connector: &SslConnector,
    uri: &str,
    branch: Option<&str>,
    commit: Option<&str>,
    timeout: Option<Duration>,
    handle: &Dial9TokioHandle,
) -> Result<CloneResult, GitFetchError> {
    let timeout = timeout.unwrap_or(DEFAULT_TIMEOUT);
    tokio::time::timeout(
        timeout,
        clone_repo_inner(ssl_connector, uri, branch, commit, handle),
    )
    .await
    .map_err(|_| GitFetchError::Timeout)?
}

async fn clone_repo_inner(
    ssl_connector: &SslConnector,
    uri: &str,
    branch: Option<&str>,
    commit: Option<&str>,
    handle: &Dial9TokioHandle,
) -> Result<CloneResult, GitFetchError> {
    let parsed_uri = transport::parse_git_uri(uri)?;

    // Step 1: Discover refs, following a single redirect (e.g. GitHub
    // rewriting /user/repo to /user/repo.git). A redirect rebases the
    // repository URL for the upload-pack POST below.
    let (ref_data, redirected) =
        transport::discover_refs(ssl_connector, &parsed_uri, handle).await?;
    let parsed_uri = redirected.unwrap_or(parsed_uri);
    let ref_info = refs::parse_ref_discovery(&ref_data)?;

    // Step 2: Resolve target commit
    let target_sha = resolve_target(&ref_info, branch, commit)?;
    let target_hex = hex::encode(target_sha);
    tracing::debug!(target = %target_hex, "resolved clone target");

    // Step 3: Build want request and send via streaming POST
    let want_request = build_want_request(&target_hex, &ref_info.capabilities);
    let body_reader = transport::git_post_streaming(
        ssl_connector,
        &parsed_uri,
        "/git-upload-pack",
        "application/x-git-upload-pack-request",
        want_request,
        MAX_CLONE_SIZE,
        handle,
    )
    .await?;

    // Step 4-5: Stream through pkt-line → sideband → packfile pipeline
    let pktline_reader = pktline::StreamingPktLineReader::new(body_reader);
    let sideband_reader = sideband::SidebandReader::new(pktline_reader);
    let objects_vec = packfile::parse_packfile_stream(sideband_reader).await?;

    // Step 6: Build object map and find the commit's tree
    let mut objects = HashMap::with_capacity(objects_vec.len());
    for obj in objects_vec {
        objects.insert(obj.sha, (obj.obj_type, obj.data));
    }

    let (commit_sha, tree_sha) = peel_target_to_commit(&target_sha, |sha| {
        Ok(objects.get(sha).map(|(t, d)| (*t, d.clone())))
    })?;

    Ok(CloneResult {
        objects,
        commit_sha,
        tree_sha,
    })
}

/// Clone a Git repository via the smart HTTP protocol, spooling the packfile
/// to disk instead of holding objects in memory.
///
/// This is the [`clone_repo`] variant for large repositories: the pack is
/// streamed into an unlinked temporary file under `spool_dir` (the system
/// temp directory when `None`), indexed in place via
/// [`packstore::PackStore`], and objects are served on demand from the
/// memory-mapped pack. Peak memory is bounded by the index (~36 bytes per
/// object) rather than the decompressed repository size.
///
/// Target resolution and limits differ from [`clone_repo`]:
/// [`MAX_SPOOLED_CLONE_SIZE`] bounds the on-disk pack,
/// [`MAX_SPOOLED_PACK_OBJECTS`] bounds the object count, and the default
/// timeout is [`DEFAULT_SPOOLED_TIMEOUT`].
///
/// On timeout the network transfer is cancelled promptly, but an indexing
/// phase already in progress runs to completion on a blocking thread before
/// its result is discarded.
pub async fn clone_repo_spooled(
    ssl_connector: &SslConnector,
    uri: &str,
    branch: Option<&str>,
    commit: Option<&str>,
    timeout: Option<Duration>,
    spool_dir: Option<&std::path::Path>,
    handle: &Dial9TokioHandle,
) -> Result<ClonedPack, GitFetchError> {
    let timeout = timeout.unwrap_or(DEFAULT_SPOOLED_TIMEOUT);
    tokio::time::timeout(
        timeout,
        clone_repo_spooled_inner(ssl_connector, uri, branch, commit, spool_dir, handle),
    )
    .await
    .map_err(|_| GitFetchError::Timeout)?
}

async fn clone_repo_spooled_inner(
    ssl_connector: &SslConnector,
    uri: &str,
    branch: Option<&str>,
    commit: Option<&str>,
    spool_dir: Option<&std::path::Path>,
    handle: &Dial9TokioHandle,
) -> Result<ClonedPack, GitFetchError> {
    let parsed_uri = transport::parse_git_uri(uri)?;

    // Step 1: Discover refs, following a single redirect (e.g. GitHub
    // rewriting /user/repo to /user/repo.git). A redirect rebases the
    // repository URL for the upload-pack POST below.
    let (ref_data, redirected) =
        transport::discover_refs(ssl_connector, &parsed_uri, handle).await?;
    let parsed_uri = redirected.unwrap_or(parsed_uri);
    let ref_info = refs::parse_ref_discovery(&ref_data)?;

    // Step 2: Resolve target commit
    let target_sha = resolve_target(&ref_info, branch, commit)?;
    tracing::debug!(target = %hex::encode(target_sha), "resolved clone target");

    // Step 3: Send want request, stream the response
    let want_request = build_want_request(&hex::encode(target_sha), &ref_info.capabilities);
    let body_reader = transport::git_post_streaming(
        ssl_connector,
        &parsed_uri,
        "/git-upload-pack",
        "application/x-git-upload-pack-request",
        want_request,
        MAX_SPOOLED_CLONE_SIZE,
        handle,
    )
    .await?;

    // Step 4: Demultiplex the sideband straight into the disk spool.
    let pktline_reader = pktline::StreamingPktLineReader::new(body_reader);
    let sideband_reader = sideband::SidebandReader::new(pktline_reader);
    let spool_dir = spool_dir
        .map(|p| p.to_path_buf())
        .unwrap_or_else(std::env::temp_dir);
    let spooled =
        spool::SpooledPack::spool(sideband_reader, &spool_dir, MAX_SPOOLED_CLONE_SIZE).await?;

    // Step 5: Index the pack on a blocking thread (pure CPU: decompression,
    // hashing, delta resolution).
    let pack = tokio::task::spawn_blocking(move || {
        packstore::PackStore::open(spooled, MAX_SPOOLED_PACK_OBJECTS)
    })
    .await
    .map_err(|e| GitFetchError::RequestFailed(format!("pack indexing task failed: {e}")))??;

    // Step 6: Find the target commit's tree, peeling annotated tags.
    let (commit_sha, tree_sha) = peel_target_to_commit(&target_sha, |sha| pack.get(sha))?;

    Ok(ClonedPack {
        pack,
        commit_sha,
        tree_sha,
    })
}

/// Follow the clone target to a commit, peeling annotated tags.
///
/// Refs like `refs/tags/v1.0` point at tag *objects*, not commits; the tag's
/// `object` header names its target (possibly another tag). Returns the final
/// commit SHA-1 and its root tree SHA-1. `lookup` resolves a SHA-1 to
/// `(type, data)` from the fetched pack.
pub(crate) fn peel_target_to_commit<F>(
    target_sha: &[u8; 20],
    mut lookup: F,
) -> Result<([u8; 20], [u8; 20]), GitFetchError>
where
    F: FnMut(&[u8; 20]) -> Result<Option<(GitObjectType, Vec<u8>)>, GitFetchError>,
{
    const MAX_TAG_DEPTH: usize = 10;

    let mut current = *target_sha;
    for _ in 0..=MAX_TAG_DEPTH {
        match lookup(&current)? {
            Some((GitObjectType::Commit, data)) => {
                let tree_sha = tree::commit_tree_sha(&data)?;
                return Ok((current, tree_sha));
            }
            Some((GitObjectType::Tag, data)) => {
                current = tree::tag_target_sha(&data)?;
            }
            Some((other, _)) => {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "object {} is a {other:?}, not a commit",
                    hex::encode(current)
                )));
            }
            None => {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "target object {} not found in packfile",
                    hex::encode(current)
                )));
            }
        }
    }

    Err(GitFetchError::InvalidPackfile(format!(
        "tag chain from {} exceeds {MAX_TAG_DEPTH} levels",
        hex::encode(target_sha)
    )))
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/// Resolve the target commit SHA-1 from branch/commit args and discovered refs.
fn resolve_target(
    ref_info: &refs::RefInfo,
    branch: Option<&str>,
    commit: Option<&str>,
) -> Result<[u8; 20], GitFetchError> {
    // If an explicit commit hash was provided, use it directly
    if let Some(commit_hex) = commit {
        return objects::parse_sha1_hex(commit_hex)
            .map_err(|_| GitFetchError::RefNotFound(format!("invalid commit hash: {commit_hex}")));
    }

    // If a branch was provided, resolve it
    if let Some(branch_name) = branch {
        return refs::resolve_ref(ref_info, branch_name)
            .ok_or_else(|| GitFetchError::RefNotFound(format!("ref not found: {branch_name}")));
    }

    // Default: try HEAD, then main, then master
    for name in &["HEAD", "main", "master"] {
        if let Some(sha) = refs::resolve_ref(ref_info, name) {
            return Ok(sha);
        }
    }

    Err(GitFetchError::RefNotFound(
        "no default ref found (tried HEAD, main, master)".into(),
    ))
}

/// Build the want request body for `POST /git-upload-pack`.
///
/// The request is a sequence of pkt-lines:
///
/// ```text
/// want <sha> <negotiated-capabilities>\n
/// 0000            ← flush
/// done\n
/// ```
///
/// Capabilities are filtered to only include those the server advertised.
///
/// Note: we intentionally do NOT use `deepen 1` (shallow clone). While it
/// reduces download size, it causes servers to send only objects that differ
/// from the parent commit rather than the complete tree. This results in
/// incomplete packfiles where tree/blob objects shared with parent commits
/// are missing.
fn build_want_request(sha_hex: &str, server_caps: &[String]) -> Vec<u8> {
    let mut buf = Vec::new();

    // Negotiate capabilities: only include ones the server supports
    let desired_caps = [
        "multi_ack_detailed",
        "side-band-64k",
        "ofs-delta",
        "no-progress",
        "allow-reachable-sha1-in-want",
    ];
    let negotiated: Vec<&str> = desired_caps
        .iter()
        .filter(|cap| server_caps.iter().any(|sc| sc.starts_with(*cap)))
        .copied()
        .collect();
    let caps_str = negotiated.join(" ");

    // want line with capabilities
    let want_line = format!("want {sha_hex} {caps_str}\n");
    buf.extend_from_slice(&pktline::encode_pkt_line(want_line.as_bytes()));

    // Flush
    buf.extend_from_slice(pktline::FLUSH_PKT);

    // done
    buf.extend_from_slice(&pktline::encode_pkt_line(b"done\n"));

    buf
}

/// Extract packfile data from a side-band-64k encoded response.
///
/// The server's response to a `git-upload-pack` POST is pkt-line encoded with
/// side-band multiplexing. After the initial `NAK` (or `ACK`) line, each
/// subsequent pkt-line's first byte is a channel indicator:
///
/// - **Channel 1** (`0x01`): packfile data (concatenated to form the pack)
/// - **Channel 2** (`0x02`): progress/status messages (logged at debug level)
/// - **Channel 3** (`0x03`): fatal error message from the server
///
/// Lines before the NAK may include `shallow`/`unshallow` notifications which
/// are skipped.
pub(crate) fn extract_packfile_from_sideband(response: &[u8]) -> Result<Vec<u8>, GitFetchError> {
    let pkt_lines = pktline::parse_pkt_lines(response)?;
    let mut pack_data = Vec::new();
    let mut saw_nak = false;

    for line in &pkt_lines {
        match line {
            PktLine::Flush => {}
            PktLine::Delimiter => {}
            PktLine::Data(data) => {
                if data.is_empty() {
                    continue;
                }

                // Look for NAK/ACK lines before side-band data starts
                if !saw_nak {
                    if let Ok(text) = std::str::from_utf8(data) {
                        let trimmed = text.trim();
                        if trimmed == "NAK" || trimmed.starts_with("ACK ") {
                            saw_nak = true;
                            continue;
                        }
                        // Check if the first byte looks like a shallow/unshallow line
                        if trimmed.starts_with("shallow ") || trimmed.starts_with("unshallow ") {
                            continue;
                        }
                        // Servers report failures (bad want, access denied)
                        // as an ERR line before any sideband data.
                        if let Some(msg) = trimmed.strip_prefix("ERR ") {
                            return Err(GitFetchError::RequestFailed(format!(
                                "remote error: {msg}"
                            )));
                        }
                    }
                    // If we haven't seen NAK yet but this looks like side-band data,
                    // treat the first byte as a channel indicator
                    if data[0] <= 3 {
                        saw_nak = true;
                        // Fall through to process as side-band
                    } else {
                        continue;
                    }
                }

                // Side-band: first byte is channel
                let channel = data[0];
                let payload = &data[1..];

                match channel {
                    1 => {
                        pack_data.extend_from_slice(payload);
                    }
                    2 => {
                        // Progress: log it
                        if let Ok(msg) = std::str::from_utf8(payload) {
                            tracing::debug!(target: "git_fetch", "remote: {}", msg.trim());
                        }
                    }
                    3 => {
                        let msg = std::str::from_utf8(payload)
                            .unwrap_or("unknown error")
                            .trim()
                            .to_string();
                        return Err(GitFetchError::RequestFailed(format!("remote error: {msg}")));
                    }
                    _ => {
                        // Unknown channel, skip
                    }
                }
            }
        }
    }

    if pack_data.is_empty() {
        return Err(GitFetchError::InvalidPackfile(
            "no packfile data in response".into(),
        ));
    }

    Ok(pack_data)
}

// ---------------------------------------------------------------------------------------------------------------
// Walk helpers
// ---------------------------------------------------------------------------------------------------------------

/// Walk a Git tree depth-first, calling a visitor for each entry.
///
/// The visitor receives `(full_path, entry)` for each tree entry. For
/// directories, the visitor is called with the directory entry first, then the
/// subtree is recursed into. Submodule entries (mode 160000) are visited but
/// not recursed -- the visitor can check [`tree::GitTreeEntry::is_submodule`]
/// to detect them.
///
/// `prefix` is prepended to entry names with a `/` separator (pass `""` for
/// the root).
pub fn walk_tree<F>(
    objects: &HashMap<[u8; 20], (GitObjectType, Vec<u8>)>,
    tree_sha: &[u8; 20],
    prefix: &str,
    visitor: &mut F,
) -> Result<(), GitFetchError>
where
    F: FnMut(&str, &tree::GitTreeEntry),
{
    walk_tree_inner(objects, tree_sha, prefix, visitor, 0)
}

fn walk_tree_inner<F>(
    objects: &HashMap<[u8; 20], (GitObjectType, Vec<u8>)>,
    tree_sha: &[u8; 20],
    prefix: &str,
    visitor: &mut F,
    depth: usize,
) -> Result<(), GitFetchError>
where
    F: FnMut(&str, &tree::GitTreeEntry),
{
    if depth >= MAX_TREE_DEPTH {
        return Err(GitFetchError::InvalidPackfile(format!(
            "tree nesting exceeds {MAX_TREE_DEPTH} levels"
        )));
    }

    let tree_data = objects.get(tree_sha).ok_or_else(|| {
        GitFetchError::InvalidPackfile(format!("tree object {} not found", hex::encode(tree_sha)))
    })?;

    if tree_data.0 != GitObjectType::Tree {
        return Err(GitFetchError::InvalidPackfile(format!(
            "expected tree object, got {:?} for {}",
            tree_data.0,
            hex::encode(tree_sha)
        )));
    }

    let entries = tree::parse_tree(&tree_data.1)?;

    for entry in &entries {
        let path = if prefix.is_empty() {
            entry.name.clone()
        } else {
            format!("{prefix}/{}", entry.name)
        };

        visitor(&path, entry);

        if entry.is_dir() {
            walk_tree_inner(objects, &entry.sha, &path, visitor, depth + 1)?;
        }
    }

    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    fn make_blob(data: &[u8]) -> (GitObjectType, Vec<u8>) {
        (GitObjectType::Blob, data.to_vec())
    }

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
        objects::git_sha1(obj_type, data)
    }

    #[test]
    fn walk_simple_tree() {
        let mut objects = HashMap::new();

        // Two blobs
        let blob1_data = b"file one content";
        let blob1_sha = sha1_of(GitObjectType::Blob, blob1_data);
        objects.insert(blob1_sha, make_blob(blob1_data));

        let blob2_data = b"file two content";
        let blob2_sha = sha1_of(GitObjectType::Blob, blob2_data);
        objects.insert(blob2_sha, make_blob(blob2_data));

        // Root tree with two files
        let tree_data =
            make_tree_data(&[(100644, "a.txt", blob1_sha), (100644, "b.txt", blob2_sha)]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);
        objects.insert(tree_sha, (GitObjectType::Tree, tree_data));

        let mut visited = Vec::new();
        walk_tree(&objects, &tree_sha, "", &mut |path, entry| {
            visited.push((path.to_string(), entry.name.clone()));
        })
        .unwrap();

        assert_eq!(
            visited,
            vec![
                ("a.txt".into(), "a.txt".into()),
                ("b.txt".into(), "b.txt".into()),
            ]
        );
    }

    #[test]
    fn walk_nested_tree() {
        let mut objects = HashMap::new();

        // Blob
        let blob_data = b"nested file";
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        objects.insert(blob_sha, make_blob(blob_data));

        // Subdirectory tree
        let sub_tree_data = make_tree_data(&[(100644, "nested.txt", blob_sha)]);
        let sub_tree_sha = sha1_of(GitObjectType::Tree, &sub_tree_data);
        objects.insert(sub_tree_sha, (GitObjectType::Tree, sub_tree_data));

        // Root tree with a file and a subdirectory
        let root_blob_data = b"root file";
        let root_blob_sha = sha1_of(GitObjectType::Blob, root_blob_data);
        objects.insert(root_blob_sha, make_blob(root_blob_data));

        let root_tree_data = make_tree_data(&[
            (100644, "README.md", root_blob_sha),
            (40000, "src", sub_tree_sha),
        ]);
        let root_tree_sha = sha1_of(GitObjectType::Tree, &root_tree_data);
        objects.insert(root_tree_sha, (GitObjectType::Tree, root_tree_data));

        let mut visited = Vec::new();
        walk_tree(&objects, &root_tree_sha, "", &mut |path, _entry| {
            visited.push(path.to_string());
        })
        .unwrap();

        assert_eq!(visited, vec!["README.md", "src", "src/nested.txt"]);
    }

    #[test]
    fn walk_tree_skips_submodules() {
        let mut objects = HashMap::new();

        let blob_data = b"file";
        let blob_sha = sha1_of(GitObjectType::Blob, blob_data);
        objects.insert(blob_sha, make_blob(blob_data));

        // Submodule entry points to a sha that isn't in our objects (expected)
        let submodule_sha = [0xFF; 20];

        let tree_data = make_tree_data(&[
            (100644, "file.txt", blob_sha),
            (160000, "vendor", submodule_sha),
        ]);
        let tree_sha = sha1_of(GitObjectType::Tree, &tree_data);
        objects.insert(tree_sha, (GitObjectType::Tree, tree_data));

        let mut visited = Vec::new();
        walk_tree(&objects, &tree_sha, "", &mut |path, entry| {
            // walk_tree visits the submodule entry but doesn't recurse
            visited.push((path.to_string(), entry.is_submodule()));
        })
        .unwrap();

        assert_eq!(
            visited,
            vec![("file.txt".into(), false), ("vendor".into(), true),]
        );
    }

    #[test]
    fn walk_tree_depth_capped() {
        // A chain of nested trees deeper than the recursion cap must error
        // rather than overflow the stack.
        let mut objects = HashMap::new();
        let blob_sha = sha1_of(GitObjectType::Blob, b"x");
        objects.insert(blob_sha, make_blob(b"x"));

        let tree_data = make_tree_data(&[(100644, "f", blob_sha)]);
        let mut tree_sha = sha1_of(GitObjectType::Tree, &tree_data);
        objects.insert(tree_sha, (GitObjectType::Tree, tree_data));

        for _ in 0..MAX_TREE_DEPTH + 8 {
            let t = make_tree_data(&[(40000, "d", tree_sha)]);
            tree_sha = sha1_of(GitObjectType::Tree, &t);
            objects.insert(tree_sha, (GitObjectType::Tree, t));
        }

        let err = walk_tree(&objects, &tree_sha, "", &mut |_, _| {}).unwrap_err();
        assert!(format!("{err}").contains("nesting"), "{err}");
    }

    fn make_commit(tree_sha: &[u8; 20]) -> Vec<u8> {
        format!(
            "tree {}\nauthor T <t@t> 0 +0000\ncommitter T <t@t> 0 +0000\n\nmsg\n",
            hex::encode(tree_sha)
        )
        .into_bytes()
    }

    fn make_tag(target_sha: &[u8; 20], target_type: &str) -> Vec<u8> {
        format!(
            "object {}\ntype {target_type}\ntag v1\ntagger T <t@t> 0 +0000\n\nmsg\n",
            hex::encode(target_sha)
        )
        .into_bytes()
    }

    #[test]
    fn peel_direct_commit() {
        let tree_sha = [0x11; 20];
        let commit_data = make_commit(&tree_sha);
        let commit_sha = sha1_of(GitObjectType::Commit, &commit_data);

        let mut objects = HashMap::new();
        objects.insert(commit_sha, (GitObjectType::Commit, commit_data));

        let (c, t) = peel_target_to_commit(&commit_sha, |sha| {
            Ok(objects.get(sha).map(|(ty, d)| (*ty, d.clone())))
        })
        .unwrap();
        assert_eq!(c, commit_sha);
        assert_eq!(t, tree_sha);
    }

    #[test]
    fn peel_annotated_tag_to_commit() {
        let tree_sha = [0x22; 20];
        let commit_data = make_commit(&tree_sha);
        let commit_sha = sha1_of(GitObjectType::Commit, &commit_data);
        let tag_data = make_tag(&commit_sha, "commit");
        let tag_sha = sha1_of(GitObjectType::Tag, &tag_data);

        let mut objects = HashMap::new();
        objects.insert(commit_sha, (GitObjectType::Commit, commit_data));
        objects.insert(tag_sha, (GitObjectType::Tag, tag_data));

        let (c, t) = peel_target_to_commit(&tag_sha, |sha| {
            Ok(objects.get(sha).map(|(ty, d)| (*ty, d.clone())))
        })
        .unwrap();
        assert_eq!(c, commit_sha);
        assert_eq!(t, tree_sha);
    }

    #[test]
    fn peel_nested_tag_chain() {
        let tree_sha = [0x33; 20];
        let commit_data = make_commit(&tree_sha);
        let commit_sha = sha1_of(GitObjectType::Commit, &commit_data);
        let inner_tag = make_tag(&commit_sha, "commit");
        let inner_sha = sha1_of(GitObjectType::Tag, &inner_tag);
        let outer_tag = make_tag(&inner_sha, "tag");
        let outer_sha = sha1_of(GitObjectType::Tag, &outer_tag);

        let mut objects = HashMap::new();
        objects.insert(commit_sha, (GitObjectType::Commit, commit_data));
        objects.insert(inner_sha, (GitObjectType::Tag, inner_tag));
        objects.insert(outer_sha, (GitObjectType::Tag, outer_tag));

        let (c, _) = peel_target_to_commit(&outer_sha, |sha| {
            Ok(objects.get(sha).map(|(ty, d)| (*ty, d.clone())))
        })
        .unwrap();
        assert_eq!(c, commit_sha);
    }

    #[test]
    fn peel_tag_cycle_errors() {
        // Two tags pointing at each other (impossible in real git, but the
        // pack is untrusted input).
        let sha_a = [0xAA; 20];
        let sha_b = [0xBB; 20];
        let tag_a = make_tag(&sha_b, "tag");
        let tag_b = make_tag(&sha_a, "tag");

        let mut objects = HashMap::new();
        objects.insert(sha_a, (GitObjectType::Tag, tag_a));
        objects.insert(sha_b, (GitObjectType::Tag, tag_b));

        let err = peel_target_to_commit(&sha_a, |sha| {
            Ok(objects.get(sha).map(|(ty, d)| (*ty, d.clone())))
        })
        .unwrap_err();
        assert!(format!("{err}").contains("tag chain"), "{err}");
    }

    #[test]
    fn peel_non_commit_target_errors() {
        let blob_sha = [0xCC; 20];
        let mut objects = HashMap::new();
        objects.insert(blob_sha, (GitObjectType::Blob, b"data".to_vec()));

        let err = peel_target_to_commit(&blob_sha, |sha| {
            Ok(objects.get(sha).map(|(ty, d)| (*ty, d.clone())))
        })
        .unwrap_err();
        assert!(format!("{err}").contains("not a commit"), "{err}");
    }

    #[test]
    fn peel_missing_target_errors() {
        let objects: HashMap<[u8; 20], (GitObjectType, Vec<u8>)> = HashMap::new();
        let err = peel_target_to_commit(&[0x01; 20], |sha| {
            Ok(objects.get(sha).map(|(ty, d)| (*ty, d.clone())))
        })
        .unwrap_err();
        assert!(format!("{err}").contains("not found"), "{err}");
    }

    #[test]
    fn resolve_target_with_commit() {
        let ref_info = refs::RefInfo {
            refs: HashMap::new(),
            capabilities: vec![],
        };
        let sha = resolve_target(
            &ref_info,
            None,
            Some("aabbccddee00112233445566778899aabbccddee"),
        )
        .unwrap();
        assert_eq!(hex::encode(sha), "aabbccddee00112233445566778899aabbccddee");
    }

    #[test]
    fn resolve_target_with_branch() {
        let ref_info = refs::RefInfo {
            refs: HashMap::from([("refs/heads/develop".into(), [0x42; 20])]),
            capabilities: vec![],
        };
        let sha = resolve_target(&ref_info, Some("develop"), None).unwrap();
        assert_eq!(sha, [0x42; 20]);
    }

    #[test]
    fn resolve_target_default_head() {
        let ref_info = refs::RefInfo {
            refs: HashMap::from([("HEAD".into(), [0x99; 20])]),
            capabilities: vec![],
        };
        let sha = resolve_target(&ref_info, None, None).unwrap();
        assert_eq!(sha, [0x99; 20]);
    }

    #[test]
    fn resolve_target_default_main() {
        let ref_info = refs::RefInfo {
            refs: HashMap::from([("refs/heads/main".into(), [0xAA; 20])]),
            capabilities: vec![],
        };
        let sha = resolve_target(&ref_info, None, None).unwrap();
        assert_eq!(sha, [0xAA; 20]);
    }

    #[test]
    fn resolve_target_not_found() {
        let ref_info = refs::RefInfo {
            refs: HashMap::new(),
            capabilities: vec![],
        };
        assert!(resolve_target(&ref_info, Some("nonexistent"), None).is_err());
    }

    #[test]
    fn build_want_request_with_caps() {
        let caps = vec![
            "multi_ack_detailed".into(),
            "side-band-64k".into(),
            "ofs-delta".into(),
            "no-progress".into(),
            "allow-reachable-sha1-in-want".into(),
        ];
        let sha = "aabbccddee00112233445566778899aabbccddee";
        let request = build_want_request(sha, &caps);

        let text = String::from_utf8_lossy(&request);
        assert!(text.contains("want aabbccddee00112233445566778899aabbccddee"));
        assert!(text.contains("multi_ack_detailed"));
        assert!(text.contains("side-band-64k"));
        assert!(text.contains("allow-reachable-sha1-in-want"));
        assert!(!text.contains("deepen"));
        assert!(text.contains("done"));
    }

    #[test]
    fn build_want_request_filters_unsupported_caps() {
        // Server only supports side-band-64k
        let caps = vec!["side-band-64k".into()];
        let sha = "0000000000000000000000000000000000000000";
        let request = build_want_request(sha, &caps);

        let text = String::from_utf8_lossy(&request);
        assert!(text.contains("side-band-64k"));
        assert!(!text.contains("multi_ack_detailed"));
        assert!(!text.contains("ofs-delta"));
    }

    #[test]
    fn extract_sideband_basic() {
        // Build a response: NAK line + side-band channel 1 with pack data
        let mut response = Vec::new();
        // NAK line
        response.extend_from_slice(&pktline::encode_pkt_line(b"NAK\n"));
        // Side-band channel 1: pack data
        let mut sideband_data = vec![1u8]; // channel 1
        sideband_data.extend_from_slice(b"PACK");
        response.extend_from_slice(&pktline::encode_pkt_line(&sideband_data));
        // Flush
        response.extend_from_slice(pktline::FLUSH_PKT);

        let pack = extract_packfile_from_sideband(&response).unwrap();
        assert_eq!(pack, b"PACK");
    }

    #[test]
    fn extract_sideband_with_progress() {
        let mut response = Vec::new();
        response.extend_from_slice(&pktline::encode_pkt_line(b"NAK\n"));

        // Progress message (channel 2)
        let mut progress = vec![2u8];
        progress.extend_from_slice(b"Counting objects: 42\n");
        response.extend_from_slice(&pktline::encode_pkt_line(&progress));

        // Pack data (channel 1)
        let mut pack = vec![1u8];
        pack.extend_from_slice(b"PACKDATA");
        response.extend_from_slice(&pktline::encode_pkt_line(&pack));

        response.extend_from_slice(pktline::FLUSH_PKT);

        let result = extract_packfile_from_sideband(&response).unwrap();
        assert_eq!(result, b"PACKDATA");
    }

    #[test]
    fn extract_sideband_error_channel() {
        let mut response = Vec::new();
        response.extend_from_slice(&pktline::encode_pkt_line(b"NAK\n"));

        // Error message (channel 3)
        let mut error = vec![3u8];
        error.extend_from_slice(b"upload-pack: not our ref\n");
        response.extend_from_slice(&pktline::encode_pkt_line(&error));

        response.extend_from_slice(pktline::FLUSH_PKT);

        let result = extract_packfile_from_sideband(&response);
        assert!(result.is_err());
        let err_msg = format!("{}", result.unwrap_err());
        assert!(err_msg.contains("not our ref"));
    }

    #[test]
    fn extract_sideband_err_line() {
        // "ERR <msg>" instead of NAK must surface the server's message.
        let mut response = Vec::new();
        response.extend_from_slice(&pktline::encode_pkt_line(b"ERR upload-pack: not our ref\n"));
        response.extend_from_slice(pktline::FLUSH_PKT);

        let err = extract_packfile_from_sideband(&response).unwrap_err();
        assert!(format!("{err}").contains("not our ref"), "{err}");
    }

    #[test]
    fn extract_sideband_no_pack_data() {
        let mut response = Vec::new();
        response.extend_from_slice(&pktline::encode_pkt_line(b"NAK\n"));
        response.extend_from_slice(pktline::FLUSH_PKT);

        let result = extract_packfile_from_sideband(&response);
        assert!(result.is_err());
    }

    #[test]
    fn full_object_map_from_synthetic_pack() {
        // Build a commit -> tree -> blob structure entirely in memory
        let blob_data = b"hello world\n";
        let blob_sha = objects::git_sha1(GitObjectType::Blob, blob_data);

        let tree_data = make_tree_data(&[(100644, "hello.txt", blob_sha)]);
        let tree_sha = objects::git_sha1(GitObjectType::Tree, &tree_data);

        let commit_data = format!(
            "tree {}\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\ntest commit\n",
            hex::encode(tree_sha)
        );
        let commit_sha = objects::git_sha1(GitObjectType::Commit, commit_data.as_bytes());

        // Insert into object map
        let mut objects = HashMap::new();
        objects.insert(blob_sha, (GitObjectType::Blob, blob_data.to_vec()));
        objects.insert(tree_sha, (GitObjectType::Tree, tree_data));
        objects.insert(
            commit_sha,
            (GitObjectType::Commit, commit_data.into_bytes()),
        );

        // Verify we can extract tree sha from commit
        let (_, commit_bytes) = &objects[&commit_sha];
        let extracted_tree_sha = tree::commit_tree_sha(commit_bytes).unwrap();
        assert_eq!(extracted_tree_sha, tree_sha);

        // Walk the tree
        let mut files = Vec::new();
        walk_tree(&objects, &tree_sha, "", &mut |path, entry| {
            files.push((path.to_string(), hex::encode(entry.sha)));
        })
        .unwrap();

        assert_eq!(files.len(), 1);
        assert_eq!(files[0].0, "hello.txt");
        assert_eq!(files[0].1, hex::encode(blob_sha));
    }

    #[tokio::test]
    async fn spooled_pipeline_end_to_end() {
        // Synthetic sideband response → sideband demux → disk spool →
        // PackStore, mirroring clone_repo_spooled's steps 4-6.
        use crate::testpack::PackBuilder;

        let mut b = PackBuilder::new();
        let base = b.blob(b"spooled pipeline base");
        b.ofs_delta(
            base,
            b"spooled pipeline base",
            b"spooled pipeline base+delta",
        );
        let pack = b.build();

        let mut response = Vec::new();
        response.extend_from_slice(&pktline::encode_pkt_line(b"NAK\n"));
        for chunk in pack.chunks(33) {
            let mut frame = vec![1u8];
            frame.extend_from_slice(chunk);
            response.extend_from_slice(&pktline::encode_pkt_line(&frame));
        }
        response.extend_from_slice(pktline::FLUSH_PKT);

        let pktline_reader = pktline::StreamingPktLineReader::new(std::io::Cursor::new(response));
        let sideband_reader = sideband::SidebandReader::new(pktline_reader);
        let spooled = spool::SpooledPack::spool(sideband_reader, &std::env::temp_dir(), 1 << 20)
            .await
            .unwrap();
        let store = packstore::PackStore::open(spooled, u32::MAX).unwrap();

        let reference = packfile::parse_packfile(&pack).unwrap();
        assert_eq!(store.object_count(), reference.len());
        for obj in &reference {
            let (ty, data) = store.get(&obj.sha).unwrap().unwrap();
            assert_eq!(ty, obj.obj_type);
            assert_eq!(data, obj.data);
        }
    }

    #[tokio::test]
    async fn streaming_pipeline_end_to_end() {
        // Build a synthetic sideband response containing a valid packfile,
        // then pipe it through the full streaming stack.
        use flate2::Compression;
        use flate2::write::ZlibEncoder;
        use std::io::Write;

        fn zlib_compress(data: &[u8]) -> Vec<u8> {
            let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
            encoder.write_all(data).unwrap();
            encoder.finish().unwrap()
        }

        fn encode_obj_header(buf: &mut Vec<u8>, type_bits: u8, size: usize) {
            let mut first_byte = (type_bits << 4) | ((size & 0x0f) as u8);
            let mut remaining = size >> 4;
            if remaining > 0 {
                first_byte |= 0x80;
            }
            buf.push(first_byte);
            while remaining > 0 {
                let mut byte = (remaining & 0x7f) as u8;
                remaining >>= 7;
                if remaining > 0 {
                    byte |= 0x80;
                }
                buf.push(byte);
            }
        }

        // Build a mini packfile with two blobs.
        let blob1 = b"streaming test blob 1";
        let blob2 = b"streaming test blob 2";

        let mut pack = Vec::new();
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&2u32.to_be_bytes());
        encode_obj_header(&mut pack, 3, blob1.len());
        pack.extend_from_slice(&zlib_compress(blob1));
        encode_obj_header(&mut pack, 3, blob2.len());
        pack.extend_from_slice(&zlib_compress(blob2));
        use sha1::Digest as _;
        let sha = sha1::Sha1::digest(&pack);
        pack.extend_from_slice(&sha);

        // Wrap in sideband: NAK + channel-1 chunks + flush.
        let mut response = Vec::new();
        response.extend_from_slice(&pktline::encode_pkt_line(b"NAK\n"));
        // Split pack into small chunks to test streaming.
        for chunk in pack.chunks(20) {
            let mut frame = vec![1u8];
            frame.extend_from_slice(chunk);
            response.extend_from_slice(&pktline::encode_pkt_line(&frame));
        }
        response.extend_from_slice(pktline::FLUSH_PKT);

        // Run through the streaming pipeline.
        let pktline_reader =
            pktline::StreamingPktLineReader::new(std::io::Cursor::new(response.clone()));
        let sideband_reader = sideband::SidebandReader::new(pktline_reader);
        let objects = packfile::parse_packfile_stream(sideband_reader)
            .await
            .unwrap();

        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].data, blob1);
        assert_eq!(objects[1].data, blob2);

        // Verify matches batch path.
        let batch_pack = extract_packfile_from_sideband(&response).unwrap();
        let batch_objects = packfile::parse_packfile(&batch_pack).unwrap();
        for (s, b) in objects.iter().zip(batch_objects.iter()) {
            assert_eq!(s.sha, b.sha);
            assert_eq!(s.data, b.data);
        }
    }
}
