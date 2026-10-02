// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git smart HTTP client that fetches one commit and its tree.
//!
//! [`clone_repo`] does what `git clone --depth 1` does over HTTP: it asks
//! the server for a single commit, spools the pack it sends to disk, and
//! indexes it with gitoxide. The result is a [`pack::GitPack`] that decodes
//! objects on demand, so memory use is bounded by the pack index rather than
//! by the size of the repository.
//!
//! # Protocol
//!
//! ```text
//! 1. GET  /info/refs?service=git-upload-pack       (Git-Protocol: version=2)
//!         v2 server → its capabilities; v0 server → every ref + capabilities
//! 2. v2, unless fetching a commit by id:
//!    POST /git-upload-pack  command=ls-refs         → just the candidate refs
//! 3. Resolve the target: commit id, else branch or tag, else HEAD/main/master
//! 4. POST /git-upload-pack  want <id>, deepen 1     → pack on side-band 1,
//!                                                     spooled as it arrives
//! 5. Index the pack, peel tags to the commit, find its tree
//! ```
//!
//! Protocol v2 is preferred because v0 advertises every ref up front, which
//! for a busy repository on a large host (pull request refs included) runs to
//! hundreds of thousands of lines. `ls-refs` returns only the refs asked
//! for, and v2 servers accept any object id in a want, so a commit is
//! fetched by id whether or not a ref points at it.
//!
//! # Modules
//!
//! | Module | Purpose |
//! |--------|---------|
//! | [`transport`] | HTTP GET/POST over TCP + TLS (hyper + openssl) |
//! | [`pktline`] | pkt-line framing |
//! | [`refs`] | Ref advertisements, `ls-refs`, and ref resolution |
//! | [`sideband`] | Side-band demultiplexing of the pack stream |
//! | [`spool`] | Spooling the pack to an unlinked, memory-mapped file |
//! | [`pack`] | Indexing and reading the pack (gitoxide) |
//! | [`tree`] | Tree object parsing |
//!
//! # Limitations
//!
//! - Smart HTTP only (not SSH, `git://`, or the dumb HTTP protocol).
//! - SHA-1 repositories only.
//! - Follows at most one redirect, on the initial ref discovery request only
//!   (mirroring git's `http.followRedirects=initial` default).
//! - Submodule entries in trees are reported but not fetched.

pub mod pack;
pub mod pktline;
pub mod refs;
pub mod sideband;
pub mod spool;
#[doc(hidden)]
pub mod testpack;
pub mod transport;
pub mod tree;

use std::fmt;
use std::io;
use std::path::PathBuf;
use std::sync::Arc;
use std::sync::atomic::{AtomicBool, Ordering};

use dial9::Dial9TokioHandle;
use openssl::ssl::SslConnector;

use pack::{GitPack, ObjectKind, PackLimits};
use refs::{Protocol, RefInfo};

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

/// Maximum decompressed size for a single Git object (2 GiB).
///
/// Declared object sizes come from attacker-controlled packfile headers, so
/// they must be bounded before any allocation. 2 GiB matches the largest blob
/// the cache-server storage layer will accept.
pub const MAX_GIT_OBJECT_SIZE: usize = 2 * 1024 * 1024 * 1024;

/// Maximum pack size (32 GiB). Packs are spooled to disk, never held in
/// memory.
pub const MAX_PACK_SIZE: usize = 32 * 1024 * 1024 * 1024;

/// Maximum number of objects in a pack (20 M). Indexing needs about 80 bytes
/// per object, so about 1.6 GiB at the limit. A shallow fetch holds one
/// tree's worth of objects; even full-history fetches of very large
/// repositories stay within a few million.
pub const MAX_PACK_OBJECTS: u32 = 20_000_000;

/// Maximum size of a ref advertisement or `ls-refs` response (64 MiB). A v0
/// advertisement lists every ref in the repository.
pub const MAX_REF_ADVERTISEMENT_SIZE: usize = 64 * 1024 * 1024;

/// Maximum tree nesting depth accepted when walking a repository.
///
/// Real repositories stay far below this (Linux caps whole paths at 4096
/// bytes, so ~1000 single-character components); the limit exists so a
/// malicious pack cannot drive recursive tree walks into a stack overflow.
pub const MAX_TREE_DEPTH: usize = 1024;

/// The limits every fetched pack is indexed under.
const PACK_LIMITS: PackLimits = PackLimits {
    max_objects: MAX_PACK_OBJECTS,
    max_object_size: MAX_GIT_OBJECT_SIZE,
};

/// Side-band framing costs 5 bytes per frame (4 length + 1 channel), at most
/// 65520 bytes; servers send full frames, so a pack's response is under
/// 0.1% larger than the pack. Anything past that is refused at the HTTP
/// layer, before the spool refuses the pack itself.
const fn max_response_size(max_pack: usize) -> usize {
    max_pack + max_pack / 1024 + 1024 * 1024
}

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
    /// A response, pack, or object exceeds a limit. `what` names the measure
    /// (e.g. `"pack size"`, `"pack object count"`).
    TooLarge {
        what: &'static str,
        size: usize,
        limit: usize,
    },
    /// Invalid packfile data.
    InvalidPackfile(String),
    /// Malformed URI.
    InvalidUri(String),
    /// The host resolved to an internal address (loopback, private,
    /// link-local, ...), which server-side fetches must not reach.
    BlockedAddress(String),
}

impl fmt::Display for GitFetchError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::RefNotFound(r) => write!(f, "ref not found: {r}"),
            Self::RequestFailed(msg) => write!(f, "request failed: {msg}"),
            Self::HttpStatus(code, msg) => write!(f, "HTTP {code}: {msg}"),
            Self::TooLarge { what, size, limit } => {
                write!(f, "{what} of {size} exceeds the limit of {limit}")
            }
            Self::InvalidPackfile(msg) => write!(f, "invalid packfile: {msg}"),
            Self::InvalidUri(msg) => write!(f, "invalid URI: {msg}"),
            Self::BlockedAddress(msg) => write!(f, "blocked address: {msg}"),
        }
    }
}

impl std::error::Error for GitFetchError {}

impl GitFetchError {
    /// Recover a [`GitFetchError`] passed through an [`io::Error`] by one of
    /// this crate's readers, or describe any other I/O error as `context`.
    pub(crate) fn from_io(e: io::Error, context: &str) -> Self {
        if e.get_ref().is_some_and(|inner| inner.is::<Self>()) {
            let inner = e.into_inner().expect("checked above");
            return *inner.downcast::<Self>().expect("checked above");
        }
        Self::RequestFailed(format!("{context}: {e}"))
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Clone API
// ---------------------------------------------------------------------------------------------------------------

/// How [`clone_repo`] spools and indexes the pack.
#[derive(Clone, Debug, Default)]
pub struct CloneOptions {
    /// Directory for the spooled pack and its index; the system temporary
    /// directory when `None`. Large clones write multi-GiB files here.
    pub spool_dir: Option<PathBuf>,
    /// Threads indexing may use; zero means one per core.
    pub index_threads: usize,
}

/// A fetched commit: its pack, the commit, and the commit's root tree.
pub struct ClonedPack {
    /// The indexed pack, read by object id.
    pub pack: GitPack,
    /// The commit fetched, with tags peeled.
    pub commit_sha: [u8; 20],
    /// The commit's root tree.
    pub tree_sha: [u8; 20],
}

/// Fetch one commit of a Git repository and its tree via the smart HTTP
/// protocol.
///
/// The target is, in order of preference: `commit` (40 hex digits), the
/// branch or tag `branch`, or the default branch (`HEAD`, then `main`, then
/// `master`). Only the target commit is fetched (`deepen 1`) when the
/// server supports shallow fetches.
///
/// The pack is spooled under [`CloneOptions::spool_dir`] and indexed on a
/// blocking thread. The caller bounds the time this takes: dropping the
/// future stops indexing at its next object.
pub async fn clone_repo(
    ssl_connector: &SslConnector,
    uri: &str,
    branch: Option<&str>,
    commit: Option<&str>,
    options: &CloneOptions,
    handle: &Dial9TokioHandle,
) -> Result<ClonedPack, GitFetchError> {
    let parsed_uri = transport::parse_git_uri(uri)?;

    // Step 1: Discover the protocol and refs, following a single redirect
    // (e.g. GitHub rewriting /user/repo to /user/repo.git). A redirect
    // rebases the repository URL for the upload-pack POSTs below.
    let (ref_data, redirected) =
        transport::discover_refs(ssl_connector, &parsed_uri, handle).await?;
    let parsed_uri = redirected.unwrap_or(parsed_uri);
    let mut info = refs::parse_ref_discovery(&ref_data)?;
    drop(ref_data);
    check_object_format(&info.capabilities)?;
    let v2 = info.protocol == Protocol::V2;

    // Step 2: Under v2, list just the refs the target could name.
    if v2 && commit.is_none() {
        let names: Vec<&str> = match branch {
            Some(name) => vec![name],
            None => DEFAULT_REFS.to_vec(),
        };
        let request = refs::ls_refs_request(&names)?;
        let listing =
            transport::git_post(ssl_connector, &parsed_uri, request, true, handle).await?;
        info.refs = refs::parse_ls_refs(&listing)?;
    }

    // Step 3: Resolve the target commit.
    let target = resolve_target(&info, branch, commit)?;
    tracing::debug!(target = %hex::encode(target), v2, "resolved clone target");

    // Step 4: Ask for the target and spool the pack as it streams in.
    let request = if v2 {
        fetch_request_v2(&target, &info.capabilities)?
    } else {
        want_request_v0(&target, &info.capabilities)?
    };
    let body = transport::git_post_streaming(
        ssl_connector,
        &parsed_uri,
        request,
        v2,
        max_response_size(MAX_PACK_SIZE),
        handle,
    )
    .await?;
    let spool_dir = pack::spool_dir(options.spool_dir.as_deref());
    let spooled = spool::SpooledPack::spool(
        sideband::SidebandReader::from_reader(body),
        &spool_dir,
        MAX_PACK_SIZE,
    )
    .await?;

    // Step 5: Index the pack (decompression, hashing, delta resolution: all
    // CPU) on a blocking thread, and find the commit's tree.
    let interrupt = InterruptOnDrop(Arc::new(AtomicBool::new(false)));
    let flag = Arc::clone(&interrupt.0);
    let threads = options.index_threads;
    tokio::task::spawn_blocking(move || {
        let pack = GitPack::index(spooled, &spool_dir, PACK_LIMITS, threads, &flag)?;
        let (commit_sha, tree_sha) = peel_target_to_commit(&target, |id| pack.get(id))?;
        Ok(ClonedPack {
            pack,
            commit_sha,
            tree_sha,
        })
    })
    .await
    .map_err(|e| GitFetchError::RequestFailed(format!("pack indexing task failed: {e}")))?
}

/// Sets its flag when dropped, so a caller that gives up on [`clone_repo`]
/// also stops the indexing it left running on a blocking thread.
struct InterruptOnDrop(Arc<AtomicBool>);

impl Drop for InterruptOnDrop {
    fn drop(&mut self) {
        self.0.store(true, Ordering::Relaxed);
    }
}

/// Follow the clone target to a commit, peeling annotated tags.
///
/// Refs like `refs/tags/v1.0` point at tag *objects*, not commits; the tag's
/// `object` header names its target (possibly another tag). Returns the final
/// commit SHA-1 and its root tree SHA-1. `lookup` resolves a SHA-1 to
/// `(kind, data)` from the fetched pack.
pub(crate) fn peel_target_to_commit<F>(
    target_sha: &[u8; 20],
    mut lookup: F,
) -> Result<([u8; 20], [u8; 20]), GitFetchError>
where
    F: FnMut(&[u8; 20]) -> Result<Option<(ObjectKind, Vec<u8>)>, GitFetchError>,
{
    const MAX_TAG_DEPTH: usize = 10;

    let invalid = |what: &str, id: &[u8; 20], e: &dyn fmt::Display| {
        GitFetchError::InvalidPackfile(format!("{what} {}: {e}", hex::encode(id)))
    };
    let mut current = *target_sha;
    for _ in 0..=MAX_TAG_DEPTH {
        match lookup(&current)? {
            Some((ObjectKind::Commit, data)) => {
                let tree = gix_object::CommitRefIter::from_bytes(&data, gix_hash::Kind::Sha1)
                    .tree_id()
                    .map_err(|e| invalid("commit", &current, &e))?;
                return Ok((current, object_id_bytes(&tree)));
            }
            Some((ObjectKind::Tag, data)) => {
                let target = gix_object::TagRefIter::from_bytes(&data, gix_hash::Kind::Sha1)
                    .target_id()
                    .map_err(|e| invalid("tag", &current, &e))?;
                current = object_id_bytes(&target);
            }
            Some((other, _)) => {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "object {} is a {other}, not a commit",
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

fn object_id_bytes(id: &gix_hash::ObjectId) -> [u8; 20] {
    id.as_bytes().try_into().expect("SHA-1 ids are 20 bytes")
}

// ---------------------------------------------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------------------------------------------

/// Refs tried, in order, when the caller names no branch or commit.
const DEFAULT_REFS: [&str; 3] = ["HEAD", "main", "master"];

/// Parse a 40-digit hex object id.
pub(crate) fn parse_object_id(hex_id: &str) -> Result<[u8; 20], GitFetchError> {
    let mut id = [0u8; 20];
    hex::decode_to_slice(hex_id, &mut id).map_err(|e| {
        GitFetchError::InvalidPackfile(format!("invalid object id {hex_id:?}: {e}"))
    })?;
    Ok(id)
}

/// Resolve the target commit SHA-1 from branch/commit args and discovered refs.
fn resolve_target(
    ref_info: &RefInfo,
    branch: Option<&str>,
    commit: Option<&str>,
) -> Result<[u8; 20], GitFetchError> {
    // If an explicit commit hash was provided, use it directly
    if let Some(commit_hex) = commit {
        return parse_object_id(commit_hex)
            .map_err(|_| GitFetchError::RefNotFound(format!("invalid commit hash: {commit_hex}")));
    }

    // If a branch was provided, resolve it
    if let Some(branch_name) = branch {
        return refs::resolve_ref(ref_info, branch_name)
            .ok_or_else(|| GitFetchError::RefNotFound(format!("ref not found: {branch_name}")));
    }

    // Default: try HEAD, then main, then master
    for name in DEFAULT_REFS {
        if let Some(sha) = refs::resolve_ref(ref_info, name) {
            return Ok(sha);
        }
    }

    Err(GitFetchError::RefNotFound(
        "no default ref found (tried HEAD, main, master)".into(),
    ))
}

/// Refuse repositories whose objects are not named by SHA-1.
fn check_object_format(capabilities: &[String]) -> Result<(), GitFetchError> {
    for cap in capabilities {
        if let Some(format) = cap.strip_prefix("object-format=") {
            if format != "sha1" {
                return Err(GitFetchError::RequestFailed(format!(
                    "unsupported object format {format:?}"
                )));
            }
        }
    }
    Ok(())
}

/// Build the protocol v2 `fetch` request for `target`.
///
/// ```text
/// command=fetch
/// 0001            ← delimiter
/// ofs-delta
/// no-progress
/// deepen 1        ← when the server offers `fetch=shallow`
/// want <sha>
/// done
/// 0000            ← flush
/// ```
///
/// Sending `done` with no `have` lines skips negotiation: the server sends
/// the pack straight away, complete, since the client claims to have
/// nothing.
fn fetch_request_v2(target: &[u8; 20], capabilities: &[String]) -> Result<Vec<u8>, GitFetchError> {
    let features = refs::v2_capability(capabilities, "fetch").ok_or_else(|| {
        GitFetchError::RequestFailed("server does not offer the v2 fetch command".into())
    })?;
    let mut buf = pktline::encode_pkt_line(b"command=fetch\n");
    buf.extend_from_slice(pktline::DELIM_PKT);
    buf.extend_from_slice(&pktline::encode_pkt_line(b"ofs-delta\n"));
    buf.extend_from_slice(&pktline::encode_pkt_line(b"no-progress\n"));
    if features.split(' ').any(|f| f == "shallow") {
        buf.extend_from_slice(&pktline::encode_pkt_line(b"deepen 1\n"));
    }
    let want = format!("want {}\n", hex::encode(target));
    buf.extend_from_slice(&pktline::encode_pkt_line(want.as_bytes()));
    buf.extend_from_slice(&pktline::encode_pkt_line(b"done\n"));
    buf.extend_from_slice(pktline::FLUSH_PKT);
    Ok(buf)
}

/// Build the protocol v0 want request for `POST /git-upload-pack`.
///
/// ```text
/// want <sha> <negotiated-capabilities>\n
/// deepen 1\n      ← when the server advertises `shallow`
/// 0000            ← flush
/// done\n
/// ```
///
/// Capabilities are filtered to only include those the server advertised.
/// The pack must arrive side-band multiplexed, so a server without
/// `side-band-64k` is refused.
///
/// `deepen 1` asks for the target commit alone, not its history. Its tree
/// arrives complete: with no `have` lines the server cannot assume the
/// client holds anything, so it omits nothing.
fn want_request_v0(target: &[u8; 20], server_caps: &[String]) -> Result<Vec<u8>, GitFetchError> {
    let offers = |cap: &str| server_caps.iter().any(|c| c == cap);
    if !offers("side-band-64k") {
        return Err(GitFetchError::RequestFailed(
            "server does not offer side-band-64k".into(),
        ));
    }
    let shallow = offers("shallow");

    let mut caps: Vec<&str> = [
        "multi_ack_detailed",
        "side-band-64k",
        "ofs-delta",
        "no-progress",
    ]
    .into_iter()
    .filter(|cap| offers(cap))
    .collect();
    if shallow {
        caps.push("shallow");
    }

    let want = format!("want {} {}\n", hex::encode(target), caps.join(" "));
    let mut buf = pktline::encode_pkt_line(want.as_bytes());
    if shallow {
        buf.extend_from_slice(&pktline::encode_pkt_line(b"deepen 1\n"));
    }
    buf.extend_from_slice(pktline::FLUSH_PKT);
    buf.extend_from_slice(&pktline::encode_pkt_line(b"done\n"));
    Ok(buf)
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use std::collections::HashMap;

    use super::*;

    fn sha1_of(kind: ObjectKind, data: &[u8]) -> [u8; 20] {
        pack::object_id(kind, data).unwrap()
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

    type Objects = HashMap<[u8; 20], (ObjectKind, Vec<u8>)>;

    fn peel(objects: &Objects, target: &[u8; 20]) -> Result<([u8; 20], [u8; 20]), GitFetchError> {
        peel_target_to_commit(target, |sha| Ok(objects.get(sha).cloned()))
    }

    #[test]
    fn peel_direct_commit() {
        let tree_sha = [0x11; 20];
        let commit_data = make_commit(&tree_sha);
        let commit_sha = sha1_of(ObjectKind::Commit, &commit_data);

        let objects = Objects::from([(commit_sha, (ObjectKind::Commit, commit_data))]);
        assert_eq!(peel(&objects, &commit_sha).unwrap(), (commit_sha, tree_sha));
    }

    #[test]
    fn peel_annotated_tag_to_commit() {
        let tree_sha = [0x22; 20];
        let commit_data = make_commit(&tree_sha);
        let commit_sha = sha1_of(ObjectKind::Commit, &commit_data);
        let tag_data = make_tag(&commit_sha, "commit");
        let tag_sha = sha1_of(ObjectKind::Tag, &tag_data);

        let objects = Objects::from([
            (commit_sha, (ObjectKind::Commit, commit_data)),
            (tag_sha, (ObjectKind::Tag, tag_data)),
        ]);
        assert_eq!(peel(&objects, &tag_sha).unwrap(), (commit_sha, tree_sha));
    }

    #[test]
    fn peel_nested_tag_chain() {
        let tree_sha = [0x33; 20];
        let commit_data = make_commit(&tree_sha);
        let commit_sha = sha1_of(ObjectKind::Commit, &commit_data);
        let inner_tag = make_tag(&commit_sha, "commit");
        let inner_sha = sha1_of(ObjectKind::Tag, &inner_tag);
        let outer_tag = make_tag(&inner_sha, "tag");
        let outer_sha = sha1_of(ObjectKind::Tag, &outer_tag);

        let objects = Objects::from([
            (commit_sha, (ObjectKind::Commit, commit_data)),
            (inner_sha, (ObjectKind::Tag, inner_tag)),
            (outer_sha, (ObjectKind::Tag, outer_tag)),
        ]);
        assert_eq!(peel(&objects, &outer_sha).unwrap().0, commit_sha);
    }

    #[test]
    fn peel_tag_cycle_errors() {
        // Two tags pointing at each other (impossible in real git, but the
        // pack is untrusted input).
        let sha_a = [0xAA; 20];
        let sha_b = [0xBB; 20];
        let objects = Objects::from([
            (sha_a, (ObjectKind::Tag, make_tag(&sha_b, "tag"))),
            (sha_b, (ObjectKind::Tag, make_tag(&sha_a, "tag"))),
        ]);
        let err = peel(&objects, &sha_a).unwrap_err();
        assert!(format!("{err}").contains("tag chain"), "{err}");
    }

    #[test]
    fn peel_non_commit_target_errors() {
        let blob_sha = [0xCC; 20];
        let objects = Objects::from([(blob_sha, (ObjectKind::Blob, b"data".to_vec()))]);
        let err = peel(&objects, &blob_sha).unwrap_err();
        assert!(format!("{err}").contains("not a commit"), "{err}");
    }

    #[test]
    fn peel_missing_target_errors() {
        let err = peel(&Objects::new(), &[0x01; 20]).unwrap_err();
        assert!(format!("{err}").contains("not found"), "{err}");
    }

    #[test]
    fn peel_malformed_commit_errors() {
        let commit_sha = [0x44; 20];
        let objects = Objects::from([(
            commit_sha,
            (
                ObjectKind::Commit,
                b"author T <t@t> 0 +0000\n\nno tree\n".to_vec(),
            ),
        )]);
        assert!(peel(&objects, &commit_sha).is_err());
    }

    #[test]
    fn peel_ignores_tree_lines_in_the_message() {
        let tree_sha = [0x55; 20];
        let mut commit_data = make_commit(&tree_sha);
        commit_data.extend_from_slice(format!("tree {}\n", hex::encode([0x66; 20])).as_bytes());
        let commit_sha = sha1_of(ObjectKind::Commit, &commit_data);
        let objects = Objects::from([(commit_sha, (ObjectKind::Commit, commit_data))]);
        assert_eq!(peel(&objects, &commit_sha).unwrap().1, tree_sha);
    }

    #[test]
    fn peel_commit_with_non_utf8_headers() {
        // Latin-1 author names are common in pre-Unicode history.
        let tree_sha = [0x77; 20];
        let mut commit_data = format!("tree {}\n", hex::encode(tree_sha)).into_bytes();
        commit_data.extend_from_slice(
            b"author J\xF6rg <j> 0 +0000\ncommitter J <j> 0 +0000\n\nm\xE9ssage\n",
        );
        let commit_sha = sha1_of(ObjectKind::Commit, &commit_data);
        let objects = Objects::from([(commit_sha, (ObjectKind::Commit, commit_data))]);
        assert_eq!(peel(&objects, &commit_sha).unwrap().1, tree_sha);
    }

    #[test]
    fn peel_refuses_lookalike_headers() {
        // Neither a `treeish` header nor a `tree` line in the message is
        // the commit's tree, and an `object` line in a tag's message is not
        // its target.
        let id = "aabbccddee00112233445566778899aabbccddee";
        let cases = [
            (ObjectKind::Commit, format!("treeish {id}\n\nmsg\n")),
            (
                ObjectKind::Commit,
                format!("parent {id}\nauthor T <t> 0 +0000\n\ntree {id}\n"),
            ),
            (
                ObjectKind::Tag,
                format!("type commit\ntag v1\n\nobject {id}\n"),
            ),
        ];
        for (kind, data) in cases {
            let sha = sha1_of(kind, data.as_bytes());
            let objects = Objects::from([(sha, (kind, data.clone().into_bytes()))]);
            assert!(peel(&objects, &sha).is_err(), "{data:?}");
        }
    }

    fn ref_info(refs: &[(&str, [u8; 20])]) -> RefInfo {
        RefInfo {
            protocol: Protocol::V0,
            refs: refs.iter().map(|(n, s)| (n.to_string(), *s)).collect(),
            capabilities: vec![],
        }
    }

    #[test]
    fn resolve_target_with_commit() {
        let sha = resolve_target(
            &ref_info(&[]),
            None,
            Some("aabbccddee00112233445566778899aabbccddee"),
        )
        .unwrap();
        assert_eq!(hex::encode(sha), "aabbccddee00112233445566778899aabbccddee");
    }

    #[test]
    fn resolve_target_rejects_malformed_commit() {
        let info = ref_info(&[]);
        for bad in ["abc", "zzbbccddee00112233445566778899aabbccddee", ""] {
            assert!(
                matches!(
                    resolve_target(&info, None, Some(bad)),
                    Err(GitFetchError::RefNotFound(_))
                ),
                "{bad}"
            );
        }
    }

    #[test]
    fn resolve_target_with_branch() {
        let info = ref_info(&[("refs/heads/develop", [0x42; 20])]);
        assert_eq!(
            resolve_target(&info, Some("develop"), None).unwrap(),
            [0x42; 20]
        );
    }

    #[test]
    fn resolve_target_default_head() {
        let info = ref_info(&[("HEAD", [0x99; 20])]);
        assert_eq!(resolve_target(&info, None, None).unwrap(), [0x99; 20]);
    }

    #[test]
    fn resolve_target_default_main() {
        let info = ref_info(&[("refs/heads/main", [0xAA; 20])]);
        assert_eq!(resolve_target(&info, None, None).unwrap(), [0xAA; 20]);
    }

    #[test]
    fn resolve_target_not_found() {
        assert!(resolve_target(&ref_info(&[]), Some("nonexistent"), None).is_err());
    }

    fn caps(list: &[&str]) -> Vec<String> {
        list.iter().map(|s| s.to_string()).collect()
    }

    fn pkt_text(buf: &[u8]) -> Vec<String> {
        pktline::parse_pkt_lines(buf)
            .unwrap()
            .into_iter()
            .map(|line| match line {
                pktline::PktLine::Data(d) => String::from_utf8(d.to_vec()).unwrap(),
                pktline::PktLine::Flush => "0000".into(),
                pktline::PktLine::Delimiter => "0001".into(),
            })
            .collect()
    }

    const TARGET: [u8; 20] = [0xab; 20];

    #[test]
    fn v0_want_request_deepens_when_shallow_is_offered() {
        let server = caps(&[
            "multi_ack_detailed",
            "side-band-64k",
            "ofs-delta",
            "shallow",
            "allow-reachable-sha1-in-want",
        ]);
        let lines = pkt_text(&want_request_v0(&TARGET, &server).unwrap());
        assert_eq!(
            lines,
            [
                format!(
                    "want {} multi_ack_detailed side-band-64k ofs-delta shallow\n",
                    hex::encode(TARGET)
                ),
                "deepen 1\n".into(),
                "0000".into(),
                "done\n".into(),
            ]
        );
    }

    #[test]
    fn v0_want_request_without_shallow_fetches_history() {
        let lines = pkt_text(&want_request_v0(&TARGET, &caps(&["side-band-64k"])).unwrap());
        assert_eq!(
            lines[0],
            format!("want {} side-band-64k\n", hex::encode(TARGET))
        );
        assert!(!lines.iter().any(|l| l.starts_with("deepen")));
    }

    #[test]
    fn v0_requires_side_band_64k() {
        assert!(want_request_v0(&TARGET, &caps(&["ofs-delta", "side-band"])).is_err());
    }

    #[test]
    fn v2_fetch_request() {
        let server = caps(&[
            "agent=git/2.45",
            "ls-refs=unborn",
            "fetch=shallow wait-for-done filter",
        ]);
        let lines = pkt_text(&fetch_request_v2(&TARGET, &server).unwrap());
        assert_eq!(
            lines,
            [
                "command=fetch\n".to_string(),
                "0001".into(),
                "ofs-delta\n".into(),
                "no-progress\n".into(),
                "deepen 1\n".into(),
                format!("want {}\n", hex::encode(TARGET)),
                "done\n".into(),
                "0000".into(),
            ]
        );

        let plain = pkt_text(&fetch_request_v2(&TARGET, &caps(&["fetch"])).unwrap());
        assert!(!plain.iter().any(|l| l.starts_with("deepen")));
        assert!(fetch_request_v2(&TARGET, &caps(&["ls-refs"])).is_err());
    }

    #[test]
    fn sha256_repositories_are_refused() {
        check_object_format(&caps(&["object-format=sha1"])).unwrap();
        assert!(check_object_format(&caps(&["object-format=sha256"])).is_err());
    }

    #[test]
    fn errors_survive_a_trip_through_io() {
        let err = GitFetchError::from_io(
            io::Error::other(GitFetchError::TooLarge {
                what: "response size",
                size: 2,
                limit: 1,
            }),
            "read",
        );
        assert!(
            matches!(err, GitFetchError::TooLarge { size: 2, .. }),
            "{err}"
        );
        let err = GitFetchError::from_io(io::Error::other("boom"), "read");
        assert_eq!(err.to_string(), "request failed: read: boom");
    }

    #[test]
    fn response_allowance_covers_side_band_framing() {
        // Full 65520-byte frames carry 65515 pack bytes each.
        let pack = MAX_PACK_SIZE;
        let framed = pack + pack.div_ceil(65515) * 5 + 4;
        assert!(framed <= max_response_size(pack));
    }

    #[tokio::test]
    async fn streamed_pack_indexes_end_to_end() {
        // Synthetic v2 response → side-band demux → disk spool → index →
        // peel, mirroring clone_repo's steps 4 and 5.
        use crate::testpack::PackBuilder;

        let blob = b"spooled pipeline blob".to_vec();
        let blob_sha = sha1_of(ObjectKind::Blob, &blob);
        let mut tree = b"100644 file.txt\0".to_vec();
        tree.extend_from_slice(&blob_sha);
        let tree_sha = sha1_of(ObjectKind::Tree, &tree);
        let commit = make_commit(&tree_sha);
        let commit_sha = sha1_of(ObjectKind::Commit, &commit);

        let mut b = PackBuilder::new();
        let base = b.blob(&blob);
        b.ofs_delta(base, &blob, b"spooled pipeline blob, changed");
        b.object(2, &tree);
        b.object(1, &commit);
        let pack = b.build();

        let mut response = Vec::new();
        response.extend_from_slice(&pktline::encode_pkt_line(b"shallow-info\n"));
        let shallow = format!("shallow {}\n", hex::encode(commit_sha));
        response.extend_from_slice(&pktline::encode_pkt_line(shallow.as_bytes()));
        response.extend_from_slice(pktline::DELIM_PKT);
        response.extend_from_slice(&pktline::encode_pkt_line(b"packfile\n"));
        for chunk in pack.chunks(33) {
            let mut frame = vec![1u8];
            frame.extend_from_slice(chunk);
            response.extend_from_slice(&pktline::encode_pkt_line(&frame));
        }
        response.extend_from_slice(pktline::FLUSH_PKT);

        let dir = std::env::temp_dir();
        let sideband = sideband::SidebandReader::from_reader(std::io::Cursor::new(response));
        let spooled = spool::SpooledPack::spool(sideband, &dir, 1 << 20)
            .await
            .unwrap();
        let pack = GitPack::index(spooled, &dir, PACK_LIMITS, 1, &AtomicBool::new(false)).unwrap();

        assert_eq!(pack.object_count(), 4);
        let (c, t) = peel_target_to_commit(&commit_sha, |id| pack.get(id)).unwrap();
        assert_eq!((c, t), (commit_sha, tree_sha));
        assert_eq!(
            pack.get(&blob_sha).unwrap().unwrap(),
            (ObjectKind::Blob, blob)
        );
    }
}
