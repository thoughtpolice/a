// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Pack indexing for random-access object reads.
//!
//! The streaming parser in [`crate::packfile`] materializes every
//! decompressed object in memory at once, which caps the size of repository
//! it can ingest. [`PackIndex`] takes the opposite approach, mirroring how
//! git itself works with packfiles on disk (`git index-pack`): scan the pack
//! once to learn *where* every object lives, compute every object's SHA-1,
//! and afterwards serve objects on demand by seeking back into the
//! (memory-mapped) pack.
//!
//! # Building
//!
//! [`PackIndex::build`] runs two phases over the raw pack bytes:
//!
//! 1. **Scan** (sequential): walk the object stream front to back. Each
//!    object's header yields its type and decompressed size; inflating (and
//!    discarding) its body yields the compressed extent, i.e. where the next
//!    object starts. Non-delta objects are hashed on the spot. Delta objects
//!    record their base: a prior pack offset (`OFS_DELTA`) or a SHA-1
//!    (`REF_DELTA`).
//!
//! 2. **Hash deltas** (parallel): delta objects form forests rooted at
//!    non-delta objects (`OFS_DELTA` bases always precede their deltas, so
//!    edges point strictly backwards and cycles are impossible). Each root's
//!    tree is walked depth-first, materializing objects transiently along
//!    the current chain only: apply the delta to the parent's data, hash the
//!    result, recurse, drop. Roots are processed in parallel with rayon.
//!    `REF_DELTA` children are attached to whichever object first resolves
//!    their base SHA-1, so chains may mix both delta kinds in any order.
//!
//! Peak memory is dominated by the index itself (tens of bytes per object)
//! plus the decompressed objects along a single delta chain per thread —
//! not, as before, the entire decompressed repository.

use std::collections::{HashMap, VecDeque};
use std::sync::{Arc, Mutex};

use flate2::Decompress;
use rayon::prelude::*;

use crate::GitFetchError;
use crate::delta::apply_delta;
use crate::objects::{GitObjectType, git_sha1};
use crate::packfile::{inflate_extent, parse_header, read_object_header, read_ofs_delta_offset};
use crate::spool::SpooledPack;

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

/// Maximum delta chain depth accepted while hashing.
///
/// git's own packers keep chains under ~50; the cap only exists so a
/// malicious pack cannot make the chain walk hold unbounded data alive.
const MAX_DELTA_CHAIN_DEPTH: usize = 4096;

/// Packfile trailer length.
const TRAILER_LEN: usize = 20;

/// Default byte budget for the delta-base cache (matches git's
/// `core.deltaBaseCacheLimit` default of 96 MiB).
pub const DEFAULT_BASE_CACHE_BYTES: usize = 96 * 1024 * 1024;

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/// One indexed pack object.
#[derive(Debug, Clone, Copy)]
pub struct PackEntry {
    /// Byte offset of the object's header in the pack.
    pub offset: u64,
    /// The object's Git SHA-1.
    pub sha: [u8; 20],
    /// The object's resolved type (never a delta type).
    pub obj_type: GitObjectType,
}

/// An index over every object in a packfile: offsets, resolved types, and
/// SHA-1s, with lookup by SHA-1 or by pack offset.
#[derive(Debug)]
pub struct PackIndex {
    /// Entries in pack order (strictly ascending offset).
    entries: Vec<PackEntry>,
    /// Entry indices sorted by SHA-1 for binary-search lookup.
    sha_order: Vec<u32>,
}

impl PackIndex {
    /// Number of indexed objects.
    pub fn len(&self) -> usize {
        self.entries.len()
    }

    /// Whether the pack holds no objects.
    pub fn is_empty(&self) -> bool {
        self.entries.is_empty()
    }

    /// The entry at `idx` (pack order).
    pub fn entry(&self, idx: u32) -> &PackEntry {
        &self.entries[idx as usize]
    }

    /// All entries in pack order.
    pub fn entries(&self) -> &[PackEntry] {
        &self.entries
    }

    /// Find an object by SHA-1.
    pub fn lookup(&self, sha: &[u8; 20]) -> Option<u32> {
        self.sha_order
            .binary_search_by(|&i| self.entries[i as usize].sha.cmp(sha))
            .ok()
            .map(|pos| self.sha_order[pos])
    }

    /// Find an object by the byte offset of its header.
    pub fn lookup_offset(&self, offset: u64) -> Option<u32> {
        self.entries
            .binary_search_by(|e| e.offset.cmp(&offset))
            .ok()
            .map(|i| i as u32)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Index construction
// ---------------------------------------------------------------------------------------------------------------

/// Scan-phase record of an OFS_DELTA edge: `(child, base)` entry indices.
type OfsEdge = (u32, u32);

impl PackIndex {
    /// Build an index over a complete packfile.
    ///
    /// `pack` must be the full pack including the 12-byte header and 20-byte
    /// trailer. The trailer checksum is assumed to have been verified by the
    /// caller (e.g. [`crate::spool::SpooledPack::spool`]); structural
    /// consistency (object extents, delta references) is fully validated
    /// here.
    ///
    /// `max_objects` bounds the declared object count before any allocation.
    pub fn build(pack: &[u8], max_objects: u32) -> Result<PackIndex, GitFetchError> {
        let (count, first_offset) = parse_header(pack)?;
        if count > max_objects {
            return Err(GitFetchError::InvalidPackfile(format!(
                "too many objects: {count} exceeds limit {max_objects}"
            )));
        }
        if pack.len() < first_offset + TRAILER_LEN {
            return Err(GitFetchError::InvalidPackfile(
                "packfile truncated: missing SHA-1 trailer".into(),
            ));
        }
        let count = count as usize;
        // Slice off the trailer so no object parse can wander into it.
        let body = &pack[..pack.len() - TRAILER_LEN];

        let mut entries: Vec<PackEntry> = Vec::with_capacity(count);
        // Resolved type bits per entry; 0 = delta not yet resolved. The
        // placeholder obj_type in `entries` is only trusted once the
        // corresponding tys[i] is non-zero.
        let mut tys: Vec<u8> = vec![0u8; count];
        let mut ofs_edges: Vec<OfsEdge> = Vec::new();
        // REF_DELTA children waiting for their base SHA-1 to resolve.
        let mut ref_pending: HashMap<[u8; 20], Vec<u32>> = HashMap::new();

        // Phase 1: sequential scan.
        let mut decomp = Decompress::new(true);
        let mut scratch: Vec<u8> = Vec::new();
        let mut offset = first_offset;

        for i in 0..count {
            let obj_offset = offset;
            if obj_offset >= body.len() {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "packfile truncated: expected {count} objects, found {i}"
                )));
            }

            let (type_bits, size, header_end) = read_object_header(body, obj_offset)?;
            let obj_type = GitObjectType::from_type_bits(type_bits)?;

            match obj_type {
                GitObjectType::OfsDelta => {
                    let (neg_offset, delta_start) = read_ofs_delta_offset(body, header_end)?;
                    if neg_offset == 0 || neg_offset > obj_offset {
                        return Err(GitFetchError::InvalidPackfile(format!(
                            "OFS_DELTA at offset {obj_offset} has invalid base distance \
                             {neg_offset}"
                        )));
                    }
                    let base_offset = (obj_offset - neg_offset) as u64;
                    let base_idx = entries
                        .binary_search_by(|e| e.offset.cmp(&base_offset))
                        .map_err(|_| {
                            GitFetchError::InvalidPackfile(format!(
                                "OFS_DELTA at offset {obj_offset} references unknown base \
                                 offset {base_offset}"
                            ))
                        })?;
                    let consumed = inflate_extent(&mut decomp, body, delta_start, size, None)?;
                    ofs_edges.push((i as u32, base_idx as u32));
                    offset = delta_start + consumed;
                }
                GitObjectType::RefDelta => {
                    if header_end + 20 > body.len() {
                        return Err(GitFetchError::InvalidPackfile(
                            "truncated REF_DELTA base hash".into(),
                        ));
                    }
                    let mut base_sha = [0u8; 20];
                    base_sha.copy_from_slice(&body[header_end..header_end + 20]);
                    let consumed = inflate_extent(&mut decomp, body, header_end + 20, size, None)?;
                    ref_pending.entry(base_sha).or_default().push(i as u32);
                    offset = header_end + 20 + consumed;
                }
                _ => {
                    let consumed =
                        inflate_extent(&mut decomp, body, header_end, size, Some(&mut scratch))?;
                    tys[i] = type_bits;
                    offset = header_end + consumed;
                }
            }

            let sha = if tys[i] != 0 {
                git_sha1(obj_type, &scratch)
            } else {
                [0u8; 20]
            };
            entries.push(PackEntry {
                offset: obj_offset as u64,
                sha,
                // Placeholder for deltas until phase 2 resolves them.
                obj_type: if tys[i] != 0 {
                    obj_type
                } else {
                    GitObjectType::Blob
                },
            });
        }

        if offset != body.len() {
            return Err(GitFetchError::InvalidPackfile(format!(
                "pack objects end at {offset} but trailer starts at {}",
                body.len()
            )));
        }

        // Phase 2: hash delta objects in parallel.
        if !ofs_edges.is_empty() || !ref_pending.is_empty() {
            hash_deltas(body, &mut entries, &mut tys, &ofs_edges, ref_pending)?;
        }

        let unresolved = tys.iter().filter(|&&t| t == 0).count();
        if unresolved > 0 {
            return Err(GitFetchError::InvalidPackfile(format!(
                "{unresolved} delta objects could not be resolved \
                 (possible thin pack — deltas against objects not in the pack)"
            )));
        }

        // Lookup table: entry indices sorted by SHA-1.
        let mut sha_order: Vec<u32> = (0..entries.len() as u32).collect();
        sha_order.sort_unstable_by_key(|&i| entries[i as usize].sha);

        Ok(PackIndex { entries, sha_order })
    }
}

/// Phase 2: walk every delta forest, hashing each object.
///
/// `entries[i].sha`/`entries[i].obj_type` are written (guarded by `tys[i]`)
/// as each delta resolves.
fn hash_deltas(
    body: &[u8],
    entries: &mut [PackEntry],
    tys: &mut [u8],
    ofs_edges: &[OfsEdge],
    ref_pending: HashMap<[u8; 20], Vec<u32>>,
) -> Result<(), GitFetchError> {
    // CSR adjacency for OFS children: children of entry b are
    // children[child_start[b]..child_start[b+1]].
    let n = entries.len();
    let mut child_start = vec![0u32; n + 1];
    for &(_, base) in ofs_edges {
        child_start[base as usize + 1] += 1;
    }
    for i in 0..n {
        child_start[i + 1] += child_start[i];
    }
    let mut children = vec![0u32; ofs_edges.len()];
    let mut cursor = child_start.clone();
    for &(child, base) in ofs_edges {
        children[cursor[base as usize] as usize] = child;
        cursor[base as usize] += 1;
    }
    drop(cursor);

    let has_ref_pending = !ref_pending.is_empty();

    // Roots: non-delta objects with at least one child (by offset edge or by
    // pending SHA-1 reference). Their type/SHA-1 snapshot travels with the
    // work item so workers never read another entry's mutable fields.
    let roots: Vec<(u32, [u8; 20], u8)> = (0..n)
        .filter(|&i| tys[i] != 0)
        .filter(|&i| {
            child_start[i] < child_start[i + 1]
                || (has_ref_pending && ref_pending.contains_key(&entries[i].sha))
        })
        .map(|i| (i as u32, entries[i].sha, tys[i]))
        .collect();

    let offsets: Vec<u64> = entries.iter().map(|e| e.offset).collect();
    let scatter = Mutex::new((entries, tys));
    let ref_pending = Mutex::new(ref_pending);

    let result = roots.par_iter().try_for_each_init(
        || (Decompress::new(true), Vec::<u8>::new()),
        |(decomp, instr_scratch), &(root, root_sha, root_ty)| {
            let resolved = walk_delta_tree(
                body,
                &offsets,
                &child_start,
                &children,
                &ref_pending,
                has_ref_pending,
                root,
                root_sha,
                root_ty,
                decomp,
                instr_scratch,
            )?;

            let mut guard = scatter.lock().expect("scatter lock poisoned");
            let (entries, tys) = &mut *guard;
            for (idx, sha, ty) in resolved {
                let e = &mut entries[idx as usize];
                e.sha = sha;
                e.obj_type = GitObjectType::from_type_bits(ty)?;
                tys[idx as usize] = ty;
            }
            Ok(())
        },
    );

    // Leftover pending refs mean unresolvable deltas; the caller reports
    // them via the tys[] sweep.
    result
}

/// A frame in the iterative depth-first walk of one delta tree.
struct Frame {
    /// Decompressed object data at this node.
    data: Vec<u8>,
    /// Resolved type bits (inherited down the chain).
    ty: u8,
    /// Remaining OFS children (range into the CSR `children` array).
    csr_next: u32,
    csr_end: u32,
    /// REF children adopted when this node's SHA-1 resolved.
    adopted: Vec<u32>,
    adopted_next: usize,
}

impl Frame {
    fn next_child(&mut self, children: &[u32]) -> Option<u32> {
        if self.csr_next < self.csr_end {
            let c = children[self.csr_next as usize];
            self.csr_next += 1;
            return Some(c);
        }
        if self.adopted_next < self.adopted.len() {
            let c = self.adopted[self.adopted_next];
            self.adopted_next += 1;
            return Some(c);
        }
        None
    }
}

/// Depth-first walk from one non-delta root, materializing each delta child
/// against its parent's data, hashing it, and descending. Only the current
/// chain's data is held in memory.
///
/// Returns `(entry_index, sha, type_bits)` for every delta resolved under
/// this root.
#[allow(clippy::too_many_arguments)]
fn walk_delta_tree(
    body: &[u8],
    offsets: &[u64],
    child_start: &[u32],
    children: &[u32],
    ref_pending: &Mutex<HashMap<[u8; 20], Vec<u32>>>,
    has_ref_pending: bool,
    root: u32,
    root_sha: [u8; 20],
    root_ty: u8,
    decomp: &mut Decompress,
    instr_scratch: &mut Vec<u8>,
) -> Result<Vec<(u32, [u8; 20], u8)>, GitFetchError> {
    let mut resolved: Vec<(u32, [u8; 20], u8)> = Vec::new();

    let root_data = read_object_body(body, offsets[root as usize] as usize, decomp)?;
    let mut stack = vec![make_frame(
        root,
        root_sha,
        root_data,
        root_ty,
        child_start,
        ref_pending,
        has_ref_pending,
    )];

    loop {
        // Advance the top frame's child cursor; the mutable borrow must end
        // before the frame data is read again below.
        let child = match stack.last_mut() {
            None => break,
            Some(frame) => match frame.next_child(children) {
                None => {
                    stack.pop();
                    continue;
                }
                Some(c) => c,
            },
        };

        if stack.len() >= MAX_DELTA_CHAIN_DEPTH {
            return Err(GitFetchError::InvalidPackfile(format!(
                "delta chain exceeds {MAX_DELTA_CHAIN_DEPTH} levels"
            )));
        }

        // Re-parse the child's header to find its delta instructions.
        let child_offset = offsets[child as usize] as usize;
        let (type_bits, size, header_end) = read_object_header(body, child_offset)?;
        let instr_start = match GitObjectType::from_type_bits(type_bits)? {
            GitObjectType::OfsDelta => read_ofs_delta_offset(body, header_end)?.1,
            GitObjectType::RefDelta => header_end + 20,
            other => {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "delta edge points at non-delta object ({other:?}) at offset \
                     {child_offset}"
                )));
            }
        };
        inflate_extent(decomp, body, instr_start, size, Some(instr_scratch))?;

        let parent = stack.last().expect("stack cannot be empty here");
        let ty = parent.ty;
        let data = apply_delta(&parent.data, instr_scratch)?;
        let obj_type = GitObjectType::from_type_bits(ty)?;
        let sha = git_sha1(obj_type, &data);
        resolved.push((child, sha, ty));

        stack.push(make_frame(
            child,
            sha,
            data,
            ty,
            child_start,
            ref_pending,
            has_ref_pending,
        ));
    }

    Ok(resolved)
}

/// Build a DFS frame for `idx`, adopting any REF_DELTA children that were
/// waiting for this object's SHA-1.
fn make_frame(
    idx: u32,
    sha: [u8; 20],
    data: Vec<u8>,
    ty: u8,
    child_start: &[u32],
    ref_pending: &Mutex<HashMap<[u8; 20], Vec<u32>>>,
    has_ref_pending: bool,
) -> Frame {
    let adopted = if has_ref_pending {
        ref_pending
            .lock()
            .expect("ref_pending lock poisoned")
            .remove(&sha)
            .unwrap_or_default()
    } else {
        Vec::new()
    };
    Frame {
        data,
        ty,
        csr_next: child_start[idx as usize],
        csr_end: child_start[idx as usize + 1],
        adopted,
        adopted_next: 0,
    }
}

/// Inflate the body of a non-delta object at `offset`.
fn read_object_body(
    body: &[u8],
    offset: usize,
    decomp: &mut Decompress,
) -> Result<Vec<u8>, GitFetchError> {
    let (type_bits, size, header_end) = read_object_header(body, offset)?;
    // Non-delta object headers are followed directly by the zlib stream.
    debug_assert!(!GitObjectType::from_type_bits(type_bits)?.is_delta());
    let mut out = Vec::new();
    inflate_extent(decomp, body, header_end, size, Some(&mut out))?;
    Ok(out)
}

// ---------------------------------------------------------------------------------------------------------------
// PackStore: random-access object reads
// ---------------------------------------------------------------------------------------------------------------

/// A spooled, indexed packfile serving random-access object reads by SHA-1.
///
/// Reads decompress straight out of the memory-mapped pack. Delta objects
/// are materialized by walking their chain down to a non-delta base and
/// applying deltas back up; intermediate bases are kept in a byte-budgeted
/// cache (like git's delta-base cache) so tree walks with locality don't
/// re-materialize the same chains repeatedly.
///
/// All methods take `&self`; the store is safe to share across threads.
#[derive(Debug)]
pub struct PackStore {
    pack: SpooledPack,
    index: PackIndex,
    cache: Mutex<BaseCache>,
}

/// A parsed object header, locating the object's payload in the pack.
enum Parsed {
    Base {
        obj_type: GitObjectType,
        data_start: usize,
        size: usize,
    },
    Delta {
        base_idx: u32,
        instr_start: usize,
        size: usize,
    },
}

impl PackStore {
    /// Index a spooled pack for random access, using the default delta-base
    /// cache budget.
    ///
    /// Indexing decompresses the entire pack once; for multi-gigabyte packs
    /// call this from a blocking-friendly context (`spawn_blocking`).
    pub fn open(pack: SpooledPack, max_objects: u32) -> Result<Self, GitFetchError> {
        Self::open_with_cache_budget(pack, max_objects, DEFAULT_BASE_CACHE_BYTES)
    }

    /// [`open`](Self::open) with an explicit delta-base cache byte budget.
    pub fn open_with_cache_budget(
        pack: SpooledPack,
        max_objects: u32,
        cache_budget: usize,
    ) -> Result<Self, GitFetchError> {
        let index = PackIndex::build(pack.data(), max_objects)?;
        Ok(Self {
            pack,
            index,
            cache: Mutex::new(BaseCache::new(cache_budget)),
        })
    }

    /// The underlying index.
    pub fn index(&self) -> &PackIndex {
        &self.index
    }

    /// Number of objects in the pack.
    pub fn object_count(&self) -> usize {
        self.index.len()
    }

    /// On-disk pack size in bytes (including header and trailer).
    pub fn pack_size(&self) -> usize {
        self.pack.data().len()
    }

    /// Whether an object with this SHA-1 exists in the pack.
    pub fn contains(&self, sha: &[u8; 20]) -> bool {
        self.index.lookup(sha).is_some()
    }

    /// Read an object by SHA-1, materializing it from the pack.
    pub fn get(&self, sha: &[u8; 20]) -> Result<Option<(GitObjectType, Vec<u8>)>, GitFetchError> {
        match self.index.lookup(sha) {
            Some(idx) => self.read(idx).map(Some),
            None => Ok(None),
        }
    }

    /// Read an object by index (pack order), materializing it from the pack.
    pub fn read(&self, idx: u32) -> Result<(GitObjectType, Vec<u8>), GitFetchError> {
        let body = self.body();
        let mut decomp = Decompress::new(true);

        // Walk down the delta chain until a cached base or a non-delta
        // object, recording the delta objects passed along the way.
        let mut chain: Vec<u32> = Vec::new();
        let mut cur = idx;
        let (base_type, mut data): (GitObjectType, Arc<Vec<u8>>) = loop {
            if chain.len() > MAX_DELTA_CHAIN_DEPTH {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "delta chain exceeds {MAX_DELTA_CHAIN_DEPTH} levels"
                )));
            }
            if !chain.is_empty() {
                // Only consult the cache for delta *bases*; the tip itself
                // is never cached.
                if let Some(hit) = self.cache.lock().expect("cache lock poisoned").get(cur) {
                    break hit;
                }
            }
            match self.parse_entry(cur)? {
                Parsed::Base {
                    obj_type,
                    data_start,
                    size,
                } => {
                    let mut out = Vec::new();
                    inflate_extent(&mut decomp, body, data_start, size, Some(&mut out))?;
                    break (obj_type, Arc::new(out));
                }
                Parsed::Delta { base_idx, .. } => {
                    chain.push(cur);
                    cur = base_idx;
                }
            }
        };

        // Apply deltas back up the chain. Every level that serves as a base
        // (everything except the final tip) is cached on the way.
        let mut instr = Vec::new();
        while let Some(delta_idx) = chain.pop() {
            let Parsed::Delta {
                instr_start, size, ..
            } = self.parse_entry(delta_idx)?
            else {
                unreachable!("chain entries are deltas by construction");
            };
            inflate_extent(&mut decomp, body, instr_start, size, Some(&mut instr))?;

            self.cache.lock().expect("cache lock poisoned").insert(
                cur,
                base_type,
                Arc::clone(&data),
            );

            let resolved = apply_delta(&data, &instr)?;
            cur = delta_idx;
            data = Arc::new(resolved);
        }

        let data = Arc::try_unwrap(data).unwrap_or_else(|arc| (*arc).clone());
        Ok((base_type, data))
    }

    /// Walk a Git tree depth-first, calling a visitor for each entry.
    ///
    /// The pack-backed equivalent of [`crate::walk_tree`]: the visitor
    /// receives `(full_path, entry)` for each tree entry, directories are
    /// recursed into, and submodules are visited but not entered. Nesting is
    /// bounded by [`crate::MAX_TREE_DEPTH`].
    pub fn walk_tree<F>(
        &self,
        tree_sha: &[u8; 20],
        prefix: &str,
        visitor: &mut F,
    ) -> Result<(), GitFetchError>
    where
        F: FnMut(&str, &crate::tree::GitTreeEntry),
    {
        self.walk_tree_inner(tree_sha, prefix, visitor, 0)
    }

    fn walk_tree_inner<F>(
        &self,
        tree_sha: &[u8; 20],
        prefix: &str,
        visitor: &mut F,
        depth: usize,
    ) -> Result<(), GitFetchError>
    where
        F: FnMut(&str, &crate::tree::GitTreeEntry),
    {
        if depth >= crate::MAX_TREE_DEPTH {
            return Err(GitFetchError::InvalidPackfile(format!(
                "tree nesting exceeds {} levels",
                crate::MAX_TREE_DEPTH
            )));
        }

        let (obj_type, tree_data) = self.get(tree_sha)?.ok_or_else(|| {
            GitFetchError::InvalidPackfile(format!(
                "tree object {} not found",
                hex::encode(tree_sha)
            ))
        })?;
        if obj_type != GitObjectType::Tree {
            return Err(GitFetchError::InvalidPackfile(format!(
                "expected tree object, got {obj_type:?} for {}",
                hex::encode(tree_sha)
            )));
        }

        for entry in crate::tree::parse_tree(&tree_data)? {
            let path = if prefix.is_empty() {
                entry.name.clone()
            } else {
                format!("{prefix}/{}", entry.name)
            };

            visitor(&path, &entry);

            if entry.is_dir() {
                self.walk_tree_inner(&entry.sha, &path, visitor, depth + 1)?;
            }
        }

        Ok(())
    }

    fn body(&self) -> &[u8] {
        let raw = self.pack.data();
        &raw[..raw.len() - TRAILER_LEN]
    }

    /// Parse the object header at `idx`, resolving delta base references to
    /// entry indices.
    fn parse_entry(&self, idx: u32) -> Result<Parsed, GitFetchError> {
        let body = self.body();
        let offset = self.index.entry(idx).offset as usize;
        let (type_bits, size, header_end) = read_object_header(body, offset)?;

        match GitObjectType::from_type_bits(type_bits)? {
            GitObjectType::OfsDelta => {
                let (neg_offset, instr_start) = read_ofs_delta_offset(body, header_end)?;
                let base_offset = (offset - neg_offset) as u64;
                let base_idx = self.index.lookup_offset(base_offset).ok_or_else(|| {
                    GitFetchError::InvalidPackfile(format!(
                        "OFS_DELTA at offset {offset} references unknown base offset \
                         {base_offset}"
                    ))
                })?;
                Ok(Parsed::Delta {
                    base_idx,
                    instr_start,
                    size,
                })
            }
            GitObjectType::RefDelta => {
                let mut base_sha = [0u8; 20];
                base_sha.copy_from_slice(&body[header_end..header_end + 20]);
                let base_idx = self.index.lookup(&base_sha).ok_or_else(|| {
                    GitFetchError::InvalidPackfile(format!(
                        "REF_DELTA base {} not present in pack",
                        hex::encode(base_sha)
                    ))
                })?;
                Ok(Parsed::Delta {
                    base_idx,
                    instr_start: header_end + 20,
                    size,
                })
            }
            obj_type => Ok(Parsed::Base {
                obj_type,
                data_start: header_end,
                size,
            }),
        }
    }
}

/// Byte-budgeted cache of materialized delta bases, keyed by entry index.
///
/// Eviction is insertion-ordered (FIFO): chain locality during tree walks
/// means recently inserted bases are the ones about to be reused, and FIFO
/// avoids per-hit bookkeeping.
#[derive(Debug)]
struct BaseCache {
    map: HashMap<u32, (GitObjectType, Arc<Vec<u8>>)>,
    order: VecDeque<u32>,
    bytes: usize,
    budget: usize,
}

impl BaseCache {
    fn new(budget: usize) -> Self {
        Self {
            map: HashMap::new(),
            order: VecDeque::new(),
            bytes: 0,
            budget,
        }
    }

    fn get(&self, idx: u32) -> Option<(GitObjectType, Arc<Vec<u8>>)> {
        self.map.get(&idx).cloned()
    }

    fn insert(&mut self, idx: u32, obj_type: GitObjectType, data: Arc<Vec<u8>>) {
        // Objects bigger than a quarter of the budget would evict everything
        // else for a single entry; skip them.
        if data.len() > self.budget / 4 {
            return;
        }
        if self.map.contains_key(&idx) {
            return;
        }
        self.bytes += data.len();
        self.map.insert(idx, (obj_type, data));
        self.order.push_back(idx);

        while self.bytes > self.budget {
            let Some(victim) = self.order.pop_front() else {
                break;
            };
            if let Some((_, evicted)) = self.map.remove(&victim) {
                self.bytes -= evicted.len();
            }
        }
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use crate::packfile::{GitObject, parse_packfile};
    use crate::testpack::PackBuilder;

    /// Index a pack and cross-check every entry against the reference
    /// in-memory parser.
    fn assert_index_matches_parse(pack: &[u8]) -> PackIndex {
        let index = PackIndex::build(pack, u32::MAX).unwrap();
        let reference: Vec<GitObject> = parse_packfile(pack).unwrap();

        assert_eq!(index.len(), reference.len());
        for obj in &reference {
            let idx = index
                .lookup(&obj.sha)
                .unwrap_or_else(|| panic!("sha {} missing from index", hex::encode(obj.sha)));
            let entry = index.entry(idx);
            assert_eq!(entry.sha, obj.sha);
            assert_eq!(entry.obj_type, obj.obj_type);
        }
        index
    }

    #[test]
    fn index_plain_objects() {
        let mut b = PackBuilder::new();
        b.blob(b"first blob");
        b.blob(b"second blob");
        b.blob(b"");
        let pack = b.build();
        let index = assert_index_matches_parse(&pack);
        assert_eq!(index.len(), 3);
    }

    #[test]
    fn index_empty_pack() {
        let pack = PackBuilder::new().build();
        let index = PackIndex::build(&pack, u32::MAX).unwrap();
        assert!(index.is_empty());
    }

    #[test]
    fn index_ofs_delta_chain() {
        let mut b = PackBuilder::new();
        let base = b.blob(b"hello world");
        let d1 = b.ofs_delta(base, b"hello world", b"hello world!");
        let _d2 = b.ofs_delta(d1, b"hello world!", b"hello world!?");
        let pack = b.build();
        assert_index_matches_parse(&pack);
    }

    #[test]
    fn index_ofs_delta_fan_out() {
        let mut b = PackBuilder::new();
        let base = b.blob(b"shared base content");
        for i in 0..32u8 {
            b.ofs_delta(
                base,
                b"shared base content",
                &[b"shared base content", &[i][..]].concat(),
            );
        }
        let pack = b.build();
        let index = assert_index_matches_parse(&pack);
        assert_eq!(index.len(), 33);
    }

    #[test]
    fn index_ref_delta() {
        let mut b = PackBuilder::new();
        b.blob(b"ref base data");
        b.ref_delta(b"ref base data", b"ref base data plus");
        let pack = b.build();
        assert_index_matches_parse(&pack);
    }

    #[test]
    fn index_ref_delta_before_base() {
        // REF_DELTA may appear before its base in the pack.
        let mut b = PackBuilder::new();
        b.ref_delta(b"late base", b"late base extended");
        b.blob(b"late base");
        let pack = b.build();
        assert_index_matches_parse(&pack);
    }

    #[test]
    fn index_ref_delta_chained_on_ofs_result() {
        // base --ofs--> mid --ref--> tip: the ref target is a delta result.
        let mut b = PackBuilder::new();
        let base = b.blob(b"chain base");
        b.ofs_delta(base, b"chain base", b"chain base mid");
        b.ref_delta(b"chain base mid", b"chain base mid tip");
        let pack = b.build();
        assert_index_matches_parse(&pack);
    }

    #[test]
    fn index_deep_chain() {
        let mut b = PackBuilder::new();
        let mut data = b"A".to_vec();
        let mut prev = b.blob(&data);
        for level in 0..64u8 {
            let mut next = data.clone();
            next.push(b'B' + (level % 24));
            prev = b.ofs_delta(prev, &data, &next);
            data = next;
        }
        let pack = b.build();
        assert_index_matches_parse(&pack);
    }

    #[test]
    fn index_mixed_types() {
        let mut b = PackBuilder::new();
        b.object(1, b"tree 0000000000000000000000000000000000000000\nauthor T <t@t> 0 +0000\ncommitter T <t@t> 0 +0000\n\nc\n");
        b.object(2, b"100644 f\0AAAAAAAAAAAAAAAAAAAA");
        b.blob(b"blob body");
        let pack = b.build();
        assert_index_matches_parse(&pack);
    }

    #[test]
    fn index_rejects_thin_pack() {
        // REF_DELTA against a sha that is not in the pack.
        let mut b = PackBuilder::new();
        b.blob(b"present");
        b.raw_ref_delta([0xEE; 20], b"absent base", b"absent base x");
        let pack = b.build();
        let err = PackIndex::build(&pack, u32::MAX).unwrap_err();
        assert!(format!("{err}").contains("thin pack"), "{err}");
    }

    #[test]
    fn index_rejects_too_many_objects() {
        let mut b = PackBuilder::new();
        b.blob(b"one");
        b.blob(b"two");
        let pack = b.build();
        let err = PackIndex::build(&pack, 1).unwrap_err();
        assert!(format!("{err}").contains("too many objects"), "{err}");
    }

    #[test]
    fn index_rejects_self_referencing_ofs_delta() {
        // Hand-build an OFS_DELTA whose base distance is zero (points at
        // itself).
        let mut b = PackBuilder::new();
        b.blob(b"x");
        let pack = b.build_with_self_ofs_delta();
        let err = PackIndex::build(&pack, u32::MAX).unwrap_err();
        assert!(format!("{err}").contains("invalid base distance"), "{err}");
    }

    #[test]
    fn index_lookup_offset() {
        let mut b = PackBuilder::new();
        b.blob(b"aa");
        b.blob(b"bb");
        let pack = b.build();
        let index = PackIndex::build(&pack, u32::MAX).unwrap();
        for (i, e) in index.entries().iter().enumerate() {
            assert_eq!(index.lookup_offset(e.offset), Some(i as u32));
        }
        assert_eq!(index.lookup_offset(1), None);
    }

    #[test]
    fn index_lookup_missing_sha() {
        let mut b = PackBuilder::new();
        b.blob(b"data");
        let pack = b.build();
        let index = PackIndex::build(&pack, u32::MAX).unwrap();
        assert_eq!(index.lookup(&[0x42; 20]), None);
    }

    // --- PackStore read tests ---

    async fn store_from(pack: &[u8]) -> PackStore {
        store_from_with_budget(pack, DEFAULT_BASE_CACHE_BYTES).await
    }

    async fn store_from_with_budget(pack: &[u8], budget: usize) -> PackStore {
        let spooled = SpooledPack::spool(
            std::io::Cursor::new(pack.to_vec()),
            &std::env::temp_dir(),
            pack.len(),
        )
        .await
        .unwrap();
        PackStore::open_with_cache_budget(spooled, u32::MAX, budget).unwrap()
    }

    /// Read every object out of the store and compare against the reference
    /// in-memory parser.
    fn assert_store_matches_parse(store: &PackStore, pack: &[u8]) {
        let reference = parse_packfile(pack).unwrap();
        assert_eq!(store.object_count(), reference.len());
        for obj in &reference {
            let (ty, data) = store
                .get(&obj.sha)
                .unwrap()
                .unwrap_or_else(|| panic!("sha {} missing", hex::encode(obj.sha)));
            assert_eq!(ty, obj.obj_type);
            assert_eq!(data, obj.data, "data mismatch for {}", hex::encode(obj.sha));
        }
    }

    fn delta_heavy_pack() -> Vec<u8> {
        let mut b = PackBuilder::new();
        // Chain under a shared base, plus fan-out, plus ref deltas.
        let base = b.blob(b"the quick brown fox jumps over the lazy dog");
        let mut data = b"the quick brown fox jumps over the lazy dog".to_vec();
        let mut prev = base;
        for i in 0..16u8 {
            let mut next = data.clone();
            next.extend_from_slice(&[i, i ^ 0x5A]);
            prev = b.ofs_delta(prev, &data, &next);
            data = next;
        }
        for i in 0..8u8 {
            b.ofs_delta(
                base,
                b"the quick brown fox jumps over the lazy dog",
                &[
                    b"the quick brown fox jumps over the lazy dog" as &[u8],
                    &[i],
                ]
                .concat(),
            );
        }
        b.blob(b"standalone");
        b.ref_delta(b"standalone", b"standalone-extended");
        b.build()
    }

    #[tokio::test]
    async fn store_reads_match_parse() {
        let pack = delta_heavy_pack();
        let store = store_from(&pack).await;
        assert_store_matches_parse(&store, &pack);
    }

    #[tokio::test]
    async fn store_reads_with_zero_cache_budget() {
        // Cache disabled: every read walks the full chain from the base.
        let pack = delta_heavy_pack();
        let store = store_from_with_budget(&pack, 0).await;
        assert_store_matches_parse(&store, &pack);
    }

    #[tokio::test]
    async fn store_reads_with_tiny_cache_budget() {
        // Constant eviction pressure.
        let pack = delta_heavy_pack();
        let store = store_from_with_budget(&pack, 256).await;
        assert_store_matches_parse(&store, &pack);
        // Read everything twice to exercise hit + evict paths.
        assert_store_matches_parse(&store, &pack);
    }

    #[tokio::test]
    async fn store_get_missing_sha() {
        let mut b = PackBuilder::new();
        b.blob(b"data");
        let pack = b.build();
        let store = store_from(&pack).await;
        assert!(store.get(&[0x42; 20]).unwrap().is_none());
        assert!(!store.contains(&[0x42; 20]));
    }

    /// Build a pack containing a chain of `depth` nested trees over a
    /// single-file leaf tree. Returns `(pack, root_tree_sha)`.
    fn nested_tree_pack(depth: usize) -> (Vec<u8>, [u8; 20]) {
        use crate::objects::git_sha1;

        let mut b = PackBuilder::new();
        b.blob(b"leaf");
        let blob_sha = git_sha1(GitObjectType::Blob, b"leaf");

        let mut tree_data = Vec::new();
        tree_data.extend_from_slice(b"100644 f\0");
        tree_data.extend_from_slice(&blob_sha);
        b.object(2, &tree_data);
        let mut tree_sha = git_sha1(GitObjectType::Tree, &tree_data);

        for _ in 0..depth {
            let mut t = Vec::new();
            t.extend_from_slice(b"40000 d\0");
            t.extend_from_slice(&tree_sha);
            b.object(2, &t);
            tree_sha = git_sha1(GitObjectType::Tree, &t);
        }
        (b.build(), tree_sha)
    }

    #[tokio::test]
    async fn walk_tree_depth_capped() {
        let (pack, root) = nested_tree_pack(crate::MAX_TREE_DEPTH + 8);
        let store = store_from(&pack).await;
        let err = store.walk_tree(&root, "", &mut |_, _| {}).unwrap_err();
        assert!(format!("{err}").contains("nesting"), "{err}");
    }

    #[tokio::test]
    async fn walk_tree_moderate_depth_ok() {
        let (pack, root) = nested_tree_pack(64);
        let store = store_from(&pack).await;
        let mut paths = Vec::new();
        store
            .walk_tree(&root, "", &mut |p, _| paths.push(p.to_string()))
            .unwrap();
        // 64 directory entries plus the leaf file.
        assert_eq!(paths.len(), 65);
        assert!(paths.last().unwrap().ends_with("/f"));
    }

    #[tokio::test]
    async fn store_concurrent_reads() {
        let pack = delta_heavy_pack();
        let store = store_from(&pack).await;
        let reference = parse_packfile(&pack).unwrap();

        std::thread::scope(|scope| {
            for _ in 0..4 {
                scope.spawn(|| {
                    for obj in &reference {
                        let (ty, data) = store.get(&obj.sha).unwrap().unwrap();
                        assert_eq!(ty, obj.obj_type);
                        assert_eq!(data, obj.data);
                    }
                });
            }
        });
    }
}
