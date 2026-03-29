// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git packfile parsing: header validation, object extraction, zlib decompression,
//! and delta resolution.
//!
//! # Packfile format
//!
//! A packfile is Git's primary bulk-transfer format. It contains a set of
//! objects (commits, trees, blobs, tags) potentially delta-compressed against
//! each other.
//!
//! ## Layout
//!
//! ```text
//! ┌──────────────────────────────── Header (12 bytes) ─────────────────────┐
//! │ "PACK"  (4 bytes magic)                                                │
//! │ version (4 bytes, big-endian u32 — must be 2)                          │
//! │ count   (4 bytes, big-endian u32 — number of objects)                  │
//! ├──────────────────────────────── Objects ───────────────────────────────┤
//! │ object₁: header + zlib-compressed data                                 │
//! │ object₂: header + zlib-compressed data                                 │
//! │ ...                                                                    │
//! │ objectₙ: header + zlib-compressed data                                 │
//! ├──────────────────────────────── Trailer ───────────────────────────────┤
//! │ SHA-1 checksum of everything above (20 bytes)                          │
//! └────────────────────────────────────────────────────────────────────────┘
//! ```
//!
//! ## Object header encoding
//!
//! Each object starts with a variable-length header encoding the type and
//! decompressed size:
//!
//! ```text
//! First byte: [MSB][type₂][type₁][type₀][size₃][size₂][size₁][size₀]
//!              │     └──────────┘         └──────────────────────┘
//!              │      3-bit type           4-bit initial size
//!              └─ continuation flag
//!
//! Subsequent bytes (while MSB=1):
//!             [MSB][size₆][size₅][size₄][size₃][size₂][size₁][size₀]
//!                   └─────────────── 7 more size bits ──────────────┘
//! ```
//!
//! The size accumulates with increasing bit shifts: first byte contributes
//! bits 0-3, second byte bits 4-10, third byte bits 11-17, etc.
//!
//! ## Type values
//!
//! | Bits | Type | Content after header |
//! |------|------|---------------------|
//! | 1 | Commit | zlib-compressed commit data |
//! | 2 | Tree | zlib-compressed tree data |
//! | 3 | Blob | zlib-compressed blob data |
//! | 4 | Tag | zlib-compressed tag data |
//! | 6 | OFS_DELTA | negative offset (varint) + zlib-compressed delta |
//! | 7 | REF_DELTA | 20-byte base SHA-1 + zlib-compressed delta |
//!
//! ## OFS_DELTA offset encoding
//!
//! The negative offset for OFS_DELTA uses a variable-length encoding where
//! each continuation byte adds 1 before shifting, preventing ambiguity:
//!
//! ```text
//! byte₁: [MSB][bits 6..0]       value = bits
//! byte₂: [MSB][bits 6..0]       value = ((value + 1) << 7) | bits
//! byte₃: [MSB][bits 6..0]       value = ((value + 1) << 7) | bits
//! ...
//! ```
//!
//! The final value is subtracted from the current object's pack offset to
//! locate the base object.
//!
//! # Processing pipeline
//!
//! [`parse_packfile`] runs a three-phase pipeline:
//!
//! 1. **Extract**: read each object header, zlib-decompress the data, record
//!    pack offsets and delta base references.
//! 2. **Resolve deltas**: iteratively apply deltas against their base objects
//!    (which may themselves be deltas, requiring multiple passes for chains).
//! 3. **Hash**: compute `SHA-1("{type} {size}\0{data}")` for every resolved
//!    object.
//!
//! # References
//!
//! - <https://git-scm.com/docs/pack-format>
//! - <https://github.com/git/git/blob/master/Documentation/gitformat-pack.txt>

use std::collections::HashMap;

use bytes::{Buf as _, BytesMut};
use flate2::{Decompress, FlushDecompress, Status};
use rayon::prelude::*;
use sha1::{Digest as _, Sha1};
use tokio::io::{AsyncRead, AsyncReadExt as _};

use crate::GitFetchError;
use crate::delta::apply_delta;
use crate::objects::{GitObjectType, git_sha1};

// ---------------------------------------------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------------------------------------------

const PACK_SIGNATURE: &[u8; 4] = b"PACK";
const PACK_VERSION: u32 = 2;

// ---------------------------------------------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------------------------------------------

/// A fully resolved Git object from a packfile.
#[derive(Debug, Clone)]
pub struct GitObject {
    /// The object type (always a base type: Commit, Tree, Blob, or Tag).
    pub obj_type: GitObjectType,
    /// The decompressed object data.
    pub data: Vec<u8>,
    /// The Git SHA-1 hash of this object.
    pub sha: [u8; 20],
}

/// An intermediate object during packfile parsing, before delta resolution.
///
/// Returned by [`PackfileStream::next_object`]. Each object carries its
/// decompressed data (or delta instructions for delta objects) along with
/// packfile metadata needed for delta resolution.
#[derive(Debug)]
pub struct RawPackObject {
    /// Original type from the packfile header.
    pub obj_type: GitObjectType,
    /// Decompressed data (for base objects) or delta instructions (for delta objects).
    pub data: Vec<u8>,
    /// Byte offset of this object in the packfile (for OFS_DELTA resolution).
    pub pack_offset: usize,
    /// For OFS_DELTA: the absolute offset of the base object in the packfile.
    pub base_offset: Option<usize>,
    /// For REF_DELTA: the SHA-1 of the base object.
    pub base_ref: Option<[u8; 20]>,
    /// Pre-computed SHA-1, set during delta resolution to avoid re-hashing in Phase 3.
    pub sha: Option<[u8; 20]>,
}

// ---------------------------------------------------------------------------------------------------------------
// Header parsing
// ---------------------------------------------------------------------------------------------------------------

/// Parse and validate the packfile header. Returns the object count and the
/// offset past the header (12 bytes).
pub fn parse_header(data: &[u8]) -> Result<(u32, usize), GitFetchError> {
    if data.len() < 12 {
        return Err(GitFetchError::InvalidPackfile(
            "packfile too short for header".into(),
        ));
    }

    if &data[0..4] != PACK_SIGNATURE {
        return Err(GitFetchError::InvalidPackfile(format!(
            "invalid packfile signature: {:?}",
            &data[0..4]
        )));
    }

    let version = u32::from_be_bytes([data[4], data[5], data[6], data[7]]);
    if version != PACK_VERSION {
        return Err(GitFetchError::InvalidPackfile(format!(
            "unsupported packfile version: {version} (expected {PACK_VERSION})"
        )));
    }

    let count = u32::from_be_bytes([data[8], data[9], data[10], data[11]]);
    Ok((count, 12))
}

// ---------------------------------------------------------------------------------------------------------------
// Object header parsing
// ---------------------------------------------------------------------------------------------------------------

/// Read the variable-length type+size header of a pack object.
///
/// The first byte encodes both the 3-bit type (bits 6-4) and the low 4 bits
/// of the size (bits 3-0). If the MSB is set, subsequent bytes each contribute
/// 7 more size bits with increasing shift.
///
/// Returns `(type_bits, decompressed_size, new_offset)`.
pub fn read_object_header(data: &[u8], offset: usize) -> Result<(u8, usize, usize), GitFetchError> {
    if offset >= data.len() {
        return Err(GitFetchError::InvalidPackfile(
            "truncated object header".into(),
        ));
    }

    let byte = data[offset];
    let type_bits = (byte >> 4) & 0x07;
    let mut size = (byte & 0x0f) as usize;
    let mut shift = 4;
    let mut pos = offset + 1;

    if byte & 0x80 != 0 {
        loop {
            if pos >= data.len() {
                return Err(GitFetchError::InvalidPackfile(
                    "truncated object header size".into(),
                ));
            }
            // A valid size fits in far fewer bytes; reject before the shift
            // amount exceeds the bit width (which would panic).
            if shift >= usize::BITS as usize {
                return Err(GitFetchError::InvalidPackfile(
                    "object header size varint too long".into(),
                ));
            }
            let byte = data[pos];
            pos += 1;
            size |= ((byte & 0x7f) as usize) << shift;
            shift += 7;
            if byte & 0x80 == 0 {
                break;
            }
        }
    }

    if size > crate::MAX_GIT_OBJECT_SIZE {
        return Err(GitFetchError::InvalidPackfile(format!(
            "declared object size {size} exceeds limit {}",
            crate::MAX_GIT_OBJECT_SIZE
        )));
    }

    Ok((type_bits, size, pos))
}

// ---------------------------------------------------------------------------------------------------------------
// OFS_DELTA offset decoding
// ---------------------------------------------------------------------------------------------------------------

/// Read the variable-length negative offset for an OFS_DELTA object.
///
/// Unlike standard varints, this encoding adds 1 before each left-shift to
/// avoid ambiguity. The result is subtracted from the current object's pack
/// offset to locate the base object's position in the packfile.
pub fn read_ofs_delta_offset(data: &[u8], offset: usize) -> Result<(usize, usize), GitFetchError> {
    if offset >= data.len() {
        return Err(GitFetchError::InvalidPackfile(
            "truncated OFS_DELTA offset".into(),
        ));
    }

    let mut pos = offset;
    let mut byte = data[pos];
    pos += 1;
    let mut value = (byte & 0x7f) as usize;

    while byte & 0x80 != 0 {
        if pos >= data.len() {
            return Err(GitFetchError::InvalidPackfile(
                "truncated OFS_DELTA offset".into(),
            ));
        }
        // 10 bytes encode up to 67 bits; anything longer cannot be a valid
        // pack offset and would overflow the accumulator below.
        if pos - offset >= 10 {
            return Err(GitFetchError::InvalidPackfile(
                "OFS_DELTA offset varint too long".into(),
            ));
        }
        value += 1;
        byte = data[pos];
        pos += 1;
        value = (value << 7) | (byte & 0x7f) as usize;
    }

    Ok((value, pos))
}

// ---------------------------------------------------------------------------------------------------------------
// Zlib decompression
// ---------------------------------------------------------------------------------------------------------------

/// Decompress a zlib-compressed object from the packfile.
///
/// Returns `(decompressed_data, bytes_consumed_from_input)`.
fn decompress_object(
    data: &[u8],
    offset: usize,
    expected_size: usize,
) -> Result<(Vec<u8>, usize), GitFetchError> {
    let mut decompressor = Decompress::new(true); // zlib mode
    let mut output = vec![0u8; expected_size];
    let input = &data[offset..];

    let status = decompressor
        .decompress(input, &mut output, FlushDecompress::Finish)
        .map_err(|e| GitFetchError::InvalidPackfile(format!("zlib decompression failed: {e}")))?;

    // If we didn't get all the data in one shot, try streaming from scratch.
    // We restart with a fresh decompressor rather than trying to resume, since
    // the first decompressor's partial state cannot be continued.
    if status != Status::StreamEnd && decompressor.total_out() < expected_size as u64 {
        let mut out = Vec::with_capacity(expected_size);
        let mut decompressor2 = Decompress::new(true);
        let mut chunk = vec![0u8; 32768];
        let mut in_offset = 0;

        loop {
            let before_in = decompressor2.total_in();
            let before_out = decompressor2.total_out();
            let status = decompressor2
                .decompress(&input[in_offset..], &mut chunk, FlushDecompress::Sync)
                .map_err(|e| {
                    GitFetchError::InvalidPackfile(format!(
                        "zlib streaming decompression failed: {e}"
                    ))
                })?;
            let consumed = (decompressor2.total_in() - before_in) as usize;
            let produced = (decompressor2.total_out() - before_out) as usize;
            in_offset += consumed;
            out.extend_from_slice(&chunk[..produced]);

            if status == Status::StreamEnd {
                break;
            }
            if consumed == 0 && produced == 0 {
                return Err(GitFetchError::InvalidPackfile(
                    "zlib decompression stalled".into(),
                ));
            }
        }

        if out.len() != expected_size {
            return Err(GitFetchError::InvalidPackfile(format!(
                "decompressed size mismatch: expected {expected_size}, got {}",
                out.len()
            )));
        }
        return Ok((out, decompressor2.total_in() as usize));
    }

    // The stream must terminate exactly at expected_size. A stream that
    // decompresses to more data stops here with a full output buffer and a
    // non-StreamEnd status; accepting it would desync every later object
    // offset in the pack.
    if status != Status::StreamEnd {
        return Err(GitFetchError::InvalidPackfile(format!(
            "zlib stream longer than declared object size {expected_size}"
        )));
    }

    let consumed = decompressor.total_in() as usize;
    Ok((output, consumed))
}

/// Inflate a single zlib stream from `data[offset..]`.
///
/// Output is appended to `sink` when provided, or discarded when `None`
/// (used to find object extents without materializing them). The stream must
/// decompress to exactly `expected_size` bytes and terminate cleanly.
///
/// `decomp` is reset before use so callers can reuse one decompressor across
/// millions of objects without reallocating zlib state.
///
/// Returns the number of compressed bytes consumed.
pub(crate) fn inflate_extent(
    decomp: &mut Decompress,
    data: &[u8],
    offset: usize,
    expected_size: usize,
    mut sink: Option<&mut Vec<u8>>,
) -> Result<usize, GitFetchError> {
    decomp.reset(true);
    if let Some(v) = sink.as_deref_mut() {
        v.clear();
        v.reserve(expected_size);
    }

    let input = &data[offset..];
    let mut scratch = [0u8; 16384];
    let mut in_pos = 0usize;
    let mut total_out = 0usize;

    loop {
        let before_in = decomp.total_in();
        let before_out = decomp.total_out();

        let status = match sink.as_deref_mut() {
            Some(v) => decomp
                .decompress_vec(&input[in_pos..], v, FlushDecompress::Sync)
                .map_err(|e| {
                    GitFetchError::InvalidPackfile(format!("zlib decompression failed: {e}"))
                })?,
            None => decomp
                .decompress(&input[in_pos..], &mut scratch, FlushDecompress::Sync)
                .map_err(|e| {
                    GitFetchError::InvalidPackfile(format!("zlib decompression failed: {e}"))
                })?,
        };

        let consumed = (decomp.total_in() - before_in) as usize;
        let produced = (decomp.total_out() - before_out) as usize;
        in_pos += consumed;
        total_out += produced;

        if total_out > expected_size {
            return Err(GitFetchError::InvalidPackfile(format!(
                "zlib stream longer than declared object size {expected_size}"
            )));
        }

        match status {
            Status::StreamEnd => break,
            _ if consumed == 0 && produced == 0 => {
                return Err(GitFetchError::InvalidPackfile(if in_pos >= input.len() {
                    "unexpected EOF during zlib decompression".into()
                } else {
                    "zlib decompression stalled".into()
                }));
            }
            _ => {}
        }
    }

    if total_out != expected_size {
        return Err(GitFetchError::InvalidPackfile(format!(
            "decompressed size mismatch: expected {expected_size}, got {total_out}"
        )));
    }

    Ok(in_pos)
}

// ---------------------------------------------------------------------------------------------------------------
// Full packfile parsing
// ---------------------------------------------------------------------------------------------------------------

/// Parse a complete packfile into a list of fully resolved Git objects.
///
/// Runs the three-phase pipeline described in the [module docs](self):
///
/// 1. **Extract**: validate the PACK header, then for each object: read the
///    type+size header, zlib-decompress the body, and record delta base
///    references.
/// 2. **Resolve**: iteratively apply deltas until no unresolved delta objects
///    remain. Chained deltas (delta-of-delta) require multiple passes.
/// 3. **Hash**: compute `SHA-1("{type} {size}\0{data}")` for every object.
///
/// Returns an error if the packfile is malformed, truncated, or contains
/// unresolvable delta chains.
pub fn parse_packfile(data: &[u8]) -> Result<Vec<GitObject>, GitFetchError> {
    let (count, mut offset) = parse_header(data)?;

    if count as usize > crate::MAX_PACK_OBJECTS as usize {
        return Err(GitFetchError::InvalidPackfile(format!(
            "too many objects: {count} exceeds limit {}",
            crate::MAX_PACK_OBJECTS,
        )));
    }

    // Phase 1: extract all raw objects
    let mut raw_objects: Vec<RawPackObject> = Vec::with_capacity(count as usize);

    for _ in 0..count {
        let obj_offset = offset;
        let (type_bits, size, header_end) = read_object_header(data, offset)?;
        let obj_type = GitObjectType::from_type_bits(type_bits)?;

        match obj_type {
            GitObjectType::OfsDelta => {
                let (neg_offset, delta_start) = read_ofs_delta_offset(data, header_end)?;
                let (delta_data, consumed) = decompress_object(data, delta_start, size)?;
                offset = delta_start + consumed;

                if neg_offset > obj_offset {
                    return Err(GitFetchError::InvalidPackfile(format!(
                        "OFS_DELTA offset {neg_offset} exceeds object position {obj_offset}"
                    )));
                }
                let base_abs = obj_offset - neg_offset;

                raw_objects.push(RawPackObject {
                    obj_type,
                    data: delta_data,
                    pack_offset: obj_offset,
                    base_offset: Some(base_abs),
                    base_ref: None,
                    sha: None,
                });
            }
            GitObjectType::RefDelta => {
                if header_end + 20 > data.len() {
                    return Err(GitFetchError::InvalidPackfile(
                        "truncated REF_DELTA base hash".into(),
                    ));
                }
                let mut base_sha = [0u8; 20];
                base_sha.copy_from_slice(&data[header_end..header_end + 20]);
                let (delta_data, consumed) = decompress_object(data, header_end + 20, size)?;
                offset = header_end + 20 + consumed;

                raw_objects.push(RawPackObject {
                    obj_type,
                    data: delta_data,
                    pack_offset: obj_offset,
                    base_offset: None,
                    base_ref: Some(base_sha),
                    sha: None,
                });
            }
            _ => {
                let (obj_data, consumed) = decompress_object(data, header_end, size)?;
                offset = header_end + consumed;

                raw_objects.push(RawPackObject {
                    obj_type,
                    data: obj_data,
                    pack_offset: obj_offset,
                    base_offset: None,
                    base_ref: None,
                    sha: None,
                });
            }
        }
    }

    // Verify the SHA-1 trailer over everything before it. This catches both
    // corruption and truncation before any delta resolution work.
    verify_pack_trailer(data, offset)?;

    // Phase 2: resolve deltas
    resolve_deltas(&mut raw_objects)?;

    // Phase 3: build final objects, reusing SHA-1 computed during resolution
    let objects: Vec<GitObject> = raw_objects
        .into_iter()
        .map(|raw| {
            let sha = raw.sha.unwrap_or_else(|| git_sha1(raw.obj_type, &raw.data));
            GitObject {
                obj_type: raw.obj_type,
                data: raw.data,
                sha,
            }
        })
        .collect();

    Ok(objects)
}

/// Verify the 20-byte SHA-1 trailer of a complete in-memory packfile.
///
/// `objects_end` is the offset just past the last object. The trailer must be
/// exactly the last 20 bytes of the buffer and match SHA-1 of everything
/// before it.
fn verify_pack_trailer(data: &[u8], objects_end: usize) -> Result<(), GitFetchError> {
    if data.len() < objects_end + 20 {
        return Err(GitFetchError::InvalidPackfile(
            "packfile truncated: missing SHA-1 trailer".into(),
        ));
    }
    if data.len() > objects_end + 20 {
        return Err(GitFetchError::InvalidPackfile(format!(
            "{} bytes of trailing data after packfile trailer",
            data.len() - objects_end - 20
        )));
    }
    let expected = &data[objects_end..objects_end + 20];
    let actual: [u8; 20] = Sha1::digest(&data[..objects_end]).into();
    if expected != actual {
        return Err(GitFetchError::InvalidPackfile(format!(
            "packfile checksum mismatch: trailer {}, computed {}",
            hex::encode(expected),
            hex::encode(actual)
        )));
    }
    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Delta resolution
// ---------------------------------------------------------------------------------------------------------------

/// Resolve all delta objects in-place by applying delta instructions against
/// their base objects.
///
/// Uses rayon to apply independent deltas in parallel within each pass. Each
/// pass identifies all deltas whose bases are already resolved, then applies
/// them concurrently. Chained deltas (depth D) require D passes.
fn resolve_deltas(objects: &mut Vec<RawPackObject>) -> Result<(), GitFetchError> {
    // Build lookup: pack_offset -> index for OFS_DELTA
    let offset_to_idx: HashMap<usize, usize> = objects
        .iter()
        .enumerate()
        .map(|(i, o)| (o.pack_offset, i))
        .collect();

    // Pre-compute SHA-1 → index for non-delta objects (used by REF_DELTA).
    let mut sha_to_idx: HashMap<[u8; 20], usize> = HashMap::new();
    for (i, o) in objects.iter_mut().enumerate() {
        if !o.obj_type.is_delta() {
            let sha = git_sha1(o.obj_type, &o.data);
            sha_to_idx.insert(sha, i);
            o.sha = Some(sha);
        }
    }

    // Iteratively resolve deltas. Each pass resolves all deltas whose bases
    // are already resolved, applying them in parallel via rayon.
    let max_passes = 100;
    for pass in 0..max_passes {
        // Phase A: Collect resolvable (delta_idx, base_idx) pairs.
        let mut resolvable: Vec<(usize, usize)> = Vec::new();
        let mut pending = 0usize;

        for i in 0..objects.len() {
            if !objects[i].obj_type.is_delta() {
                continue;
            }
            pending += 1;

            let base_idx = if let Some(base_off) = objects[i].base_offset {
                offset_to_idx.get(&base_off).copied()
            } else if let Some(base_sha) = objects[i].base_ref {
                sha_to_idx.get(&base_sha).copied()
            } else {
                None
            };

            if let Some(base_idx) = base_idx {
                if !objects[base_idx].obj_type.is_delta() {
                    resolvable.push((i, base_idx));
                }
            }
        }

        if pending == 0 {
            break;
        }
        if resolvable.is_empty() {
            return Err(GitFetchError::InvalidPackfile(format!(
                "unresolvable delta chain: {pending} objects remain after {pass} passes \
                 (possible thin pack — server sent deltas against objects not in the pack)"
            )));
        }

        // Phase B: Snapshot base data for this batch. Clone each unique base
        // once so the parallel phase can read bases without borrowing `objects`.
        let mut bases: HashMap<usize, (GitObjectType, Vec<u8>)> = HashMap::new();
        for &(_, base_idx) in &resolvable {
            bases
                .entry(base_idx)
                .or_insert_with(|| (objects[base_idx].obj_type, objects[base_idx].data.clone()));
        }

        // Move delta instruction bytes out of objects so each parallel task
        // owns its delta data. The slots are refilled in the write-back phase.
        let work: Vec<(usize, Vec<u8>, usize)> = resolvable
            .iter()
            .map(|&(di, bi)| {
                let delta_instructions = std::mem::take(&mut objects[di].data);
                (di, delta_instructions, bi)
            })
            .collect();

        // Phase C: Apply deltas in parallel.
        let results: Result<Vec<_>, GitFetchError> = work
            .par_iter()
            .map(|(delta_idx, delta_instructions, base_idx)| {
                let (base_type, base_data) = bases.get(base_idx).expect("base must exist");
                let resolved = apply_delta(base_data, delta_instructions)?;
                let sha = git_sha1(*base_type, &resolved);
                Ok((*delta_idx, resolved, *base_type, sha))
            })
            .collect();
        let results = results?;

        // Phase D: Write results back sequentially.
        for (delta_idx, resolved_data, base_type, sha) in results {
            objects[delta_idx].obj_type = base_type;
            objects[delta_idx].data = resolved_data;
            objects[delta_idx].base_offset = None;
            objects[delta_idx].base_ref = None;
            objects[delta_idx].sha = Some(sha);
            sha_to_idx.insert(sha, delta_idx);
        }
    }

    // Final check: no deltas should remain after resolution
    let remaining: usize = objects.iter().filter(|o| o.obj_type.is_delta()).count();
    if remaining > 0 {
        return Err(GitFetchError::InvalidPackfile(format!(
            "{remaining} delta objects could not be resolved after {max_passes} passes"
        )));
    }

    Ok(())
}

// ---------------------------------------------------------------------------------------------------------------
// Streaming packfile parser
// ---------------------------------------------------------------------------------------------------------------

/// Streaming packfile parser that extracts objects one at a time from an
/// [`AsyncRead`] source.
///
/// Objects are yielded as [`RawPackObject`]s (before delta resolution). After
/// collecting all objects, pass them through [`resolve_deltas`] and then
/// compute SHA-1 hashes to produce the final [`GitObject`] list.
///
/// Use [`parse_packfile_stream`] for the full pipeline (extract + resolve +
/// hash) from a single async reader.
pub struct PackfileStream<R> {
    reader: R,
    buf: BytesMut,
    object_count: u32,
    objects_read: u32,
    pack_offset: usize,
    header_parsed: bool,
    eof: bool,
    /// Running SHA-1 over all consumed pack bytes, for trailer verification.
    hasher: Sha1,
}

impl<R: AsyncRead + Unpin> PackfileStream<R> {
    pub fn new(reader: R) -> Self {
        Self {
            reader,
            buf: BytesMut::with_capacity(65536),
            object_count: 0,
            objects_read: 0,
            pack_offset: 0,
            header_parsed: false,
            eof: false,
            hasher: Sha1::new(),
        }
    }

    /// Consume `n` buffered bytes: feed them to the trailer hasher and
    /// advance the pack offset.
    fn consume(&mut self, n: usize) {
        self.hasher.update(&self.buf[..n]);
        self.buf.advance(n);
        self.pack_offset += n;
    }

    /// Parse the 12-byte pack header. Must be called before [`next_object`].
    /// Returns the declared object count.
    pub async fn read_header(&mut self) -> Result<u32, GitFetchError> {
        self.ensure_buffered(12).await?;

        if &self.buf[..4] != PACK_SIGNATURE {
            return Err(GitFetchError::InvalidPackfile(format!(
                "invalid packfile signature: {:?}",
                &self.buf[..4]
            )));
        }

        let version = u32::from_be_bytes([self.buf[4], self.buf[5], self.buf[6], self.buf[7]]);
        if version != PACK_VERSION {
            return Err(GitFetchError::InvalidPackfile(format!(
                "unsupported packfile version: {version} (expected {PACK_VERSION})"
            )));
        }

        let count = u32::from_be_bytes([self.buf[8], self.buf[9], self.buf[10], self.buf[11]]);
        self.consume(12);
        self.object_count = count;
        self.header_parsed = true;
        Ok(count)
    }

    /// Verify the 20-byte SHA-1 trailer against everything consumed so far.
    ///
    /// Call after [`next_object`](Self::next_object) has returned `None`.
    /// Returns the verified pack checksum.
    pub async fn verify_trailer(&mut self) -> Result<[u8; 20], GitFetchError> {
        self.ensure_buffered(20).await?;
        let mut expected = [0u8; 20];
        expected.copy_from_slice(&self.buf[..20]);
        let actual: [u8; 20] = self.hasher.clone().finalize().into();
        if expected != actual {
            return Err(GitFetchError::InvalidPackfile(format!(
                "packfile checksum mismatch: trailer {}, computed {}",
                hex::encode(expected),
                hex::encode(actual)
            )));
        }
        self.buf.advance(20);
        self.pack_offset += 20;

        // The batch parser rejects bytes after the trailer; mirror that so
        // both parsers agree on what a well-formed pack is.
        while self.buf.is_empty() && !self.eof {
            self.buf.reserve(1024);
            let n = self
                .reader
                .read_buf(&mut self.buf)
                .await
                .map_err(|e| GitFetchError::RequestFailed(format!("read pack data: {e}")))?;
            if n == 0 {
                self.eof = true;
            }
        }
        if !self.buf.is_empty() {
            return Err(GitFetchError::InvalidPackfile(format!(
                "{} bytes of trailing data after packfile trailer",
                self.buf.len()
            )));
        }

        Ok(actual)
    }

    /// Extract the next object from the packfile stream.
    ///
    /// Returns `None` when all declared objects have been read.
    pub async fn next_object(&mut self) -> Result<Option<RawPackObject>, GitFetchError> {
        if !self.header_parsed {
            return Err(GitFetchError::InvalidPackfile(
                "pack header not yet parsed".into(),
            ));
        }
        if self.objects_read >= self.object_count {
            return Ok(None);
        }

        let obj_offset = self.pack_offset;

        // Read variable-length object header. Max header size is ~10 bytes.
        self.ensure_buffered(20).await?;
        let (type_bits, size, header_end) = read_object_header(&self.buf, 0)?;
        let obj_type = GitObjectType::from_type_bits(type_bits)?;
        self.consume(header_end);

        let (obj_data, base_offset, base_ref) = match obj_type {
            GitObjectType::OfsDelta => {
                // Read variable-length negative offset.
                self.ensure_buffered(10).await?;
                let (neg_offset, consumed) = read_ofs_delta_offset(&self.buf, 0)?;
                self.consume(consumed);

                if neg_offset > obj_offset {
                    return Err(GitFetchError::InvalidPackfile(format!(
                        "OFS_DELTA offset {neg_offset} exceeds object position {obj_offset}"
                    )));
                }
                let base_abs = obj_offset - neg_offset;
                let data = self.decompress_streaming(size).await?;
                (data, Some(base_abs), None)
            }
            GitObjectType::RefDelta => {
                self.ensure_buffered(20).await?;
                let mut base_sha = [0u8; 20];
                base_sha.copy_from_slice(&self.buf[..20]);
                self.consume(20);
                let data = self.decompress_streaming(size).await?;
                (data, None, Some(base_sha))
            }
            _ => {
                let data = self.decompress_streaming(size).await?;
                (data, None, None)
            }
        };

        self.objects_read += 1;

        Ok(Some(RawPackObject {
            obj_type,
            data: obj_data,
            pack_offset: obj_offset,
            base_offset,
            base_ref,
            sha: None,
        }))
    }

    /// Ensure at least `n` bytes are available in the internal buffer.
    async fn ensure_buffered(&mut self, n: usize) -> Result<(), GitFetchError> {
        while self.buf.len() < n {
            if self.eof {
                return Err(GitFetchError::InvalidPackfile(format!(
                    "unexpected EOF: need {n} bytes, have {}",
                    self.buf.len()
                )));
            }
            self.buf.reserve(n - self.buf.len());
            let bytes_read = self
                .reader
                .read_buf(&mut self.buf)
                .await
                .map_err(|e| GitFetchError::RequestFailed(format!("read pack data: {e}")))?;
            if bytes_read == 0 {
                self.eof = true;
            }
        }
        Ok(())
    }

    /// Incrementally decompress a zlib stream from the buffer/reader.
    ///
    /// Feeds bytes to `flate2::Decompress` as they become available, tracking
    /// exactly how many compressed bytes are consumed.
    async fn decompress_streaming(
        &mut self,
        expected_size: usize,
    ) -> Result<Vec<u8>, GitFetchError> {
        let mut decompressor = Decompress::new(true);
        let mut output = vec![0u8; expected_size];
        let mut out_pos = 0usize;

        loop {
            // Ensure we have some input bytes to feed the decompressor.
            if self.buf.is_empty() {
                if self.eof {
                    return Err(GitFetchError::InvalidPackfile(
                        "unexpected EOF during zlib decompression".into(),
                    ));
                }
                self.buf.reserve(8192);
                let n =
                    self.reader.read_buf(&mut self.buf).await.map_err(|e| {
                        GitFetchError::RequestFailed(format!("read pack data: {e}"))
                    })?;
                if n == 0 {
                    self.eof = true;
                    if self.buf.is_empty() {
                        return Err(GitFetchError::InvalidPackfile(
                            "unexpected EOF during zlib decompression".into(),
                        ));
                    }
                }
            }

            let before_in = decompressor.total_in();
            let before_out = decompressor.total_out();

            let status = decompressor
                .decompress(&self.buf, &mut output[out_pos..], FlushDecompress::Sync)
                .map_err(|e| {
                    GitFetchError::InvalidPackfile(format!("zlib decompression failed: {e}"))
                })?;

            let consumed = (decompressor.total_in() - before_in) as usize;
            let produced = (decompressor.total_out() - before_out) as usize;
            self.consume(consumed);
            out_pos += produced;

            if status == Status::StreamEnd {
                break;
            }
            if consumed == 0 && produced == 0 {
                return Err(GitFetchError::InvalidPackfile(
                    "zlib decompression stalled".into(),
                ));
            }
        }

        if out_pos != expected_size {
            return Err(GitFetchError::InvalidPackfile(format!(
                "decompressed size mismatch: expected {expected_size}, got {out_pos}"
            )));
        }

        Ok(output)
    }
}

/// Parse a complete packfile from an async reader, returning fully resolved
/// Git objects.
///
/// This is the streaming equivalent of [`parse_packfile`]. It reads objects
/// incrementally as bytes arrive, then resolves deltas and computes SHA-1
/// hashes using the same logic as the batch path.
pub async fn parse_packfile_stream<R: AsyncRead + Unpin>(
    reader: R,
) -> Result<Vec<GitObject>, GitFetchError> {
    let mut stream = PackfileStream::new(reader);
    let count = stream.read_header().await?;

    if count as usize > crate::MAX_PACK_OBJECTS as usize {
        return Err(GitFetchError::InvalidPackfile(format!(
            "too many objects: {count} exceeds limit {}",
            crate::MAX_PACK_OBJECTS,
        )));
    }

    let mut raw_objects: Vec<RawPackObject> = Vec::with_capacity(count as usize);
    while let Some(obj) = stream.next_object().await? {
        raw_objects.push(obj);
    }
    stream.verify_trailer().await?;

    resolve_deltas(&mut raw_objects)?;

    let objects: Vec<GitObject> = raw_objects
        .into_iter()
        .map(|raw| {
            let sha = raw.sha.unwrap_or_else(|| git_sha1(raw.obj_type, &raw.data));
            GitObject {
                obj_type: raw.obj_type,
                data: raw.data,
                sha,
            }
        })
        .collect();

    Ok(objects)
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;
    use flate2::Compression;
    use flate2::write::ZlibEncoder;
    use sha1::Sha1;
    use std::io::Write;

    fn zlib_compress(data: &[u8]) -> Vec<u8> {
        let mut encoder = ZlibEncoder::new(Vec::new(), Compression::default());
        encoder.write_all(data).unwrap();
        encoder.finish().unwrap()
    }

    /// Build a minimal packfile with the given objects.
    ///
    /// Each object is `(type_bits, uncompressed_data)`.
    fn build_packfile(objects: &[(u8, &[u8])]) -> Vec<u8> {
        let mut pack = Vec::new();

        // Header
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes()); // version
        pack.extend_from_slice(&(objects.len() as u32).to_be_bytes()); // count

        for &(type_bits, data) in objects {
            // Encode object header
            encode_object_header(&mut pack, type_bits, data.len());
            // Zlib-compress the data
            pack.extend_from_slice(&zlib_compress(data));
        }

        // SHA-1 trailer
        let sha = Sha1::digest(&pack);
        pack.extend_from_slice(&sha);

        pack
    }

    fn encode_object_header(buf: &mut Vec<u8>, type_bits: u8, size: usize) {
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

    // --- Header tests ---

    #[test]
    fn parse_valid_header() {
        let mut data = Vec::new();
        data.extend_from_slice(b"PACK");
        data.extend_from_slice(&2u32.to_be_bytes());
        data.extend_from_slice(&42u32.to_be_bytes());
        let (count, offset) = parse_header(&data).unwrap();
        assert_eq!(count, 42);
        assert_eq!(offset, 12);
    }

    #[test]
    fn parse_header_wrong_magic() {
        let data = b"PCAK\x00\x00\x00\x02\x00\x00\x00\x01";
        assert!(parse_header(data).is_err());
    }

    #[test]
    fn parse_header_wrong_version() {
        let mut data = Vec::new();
        data.extend_from_slice(b"PACK");
        data.extend_from_slice(&3u32.to_be_bytes());
        data.extend_from_slice(&1u32.to_be_bytes());
        assert!(parse_header(&data).is_err());
    }

    #[test]
    fn parse_header_too_short() {
        assert!(parse_header(b"PACK").is_err());
    }

    // --- Object header tests ---

    #[test]
    fn read_single_byte_header() {
        // Type=3 (blob), size=10
        // byte = (3 << 4) | 10 = 0x3A, no continuation
        let data = [0x3A];
        let (type_bits, size, offset) = read_object_header(&data, 0).unwrap();
        assert_eq!(type_bits, 3);
        assert_eq!(size, 10);
        assert_eq!(offset, 1);
    }

    #[test]
    fn read_multi_byte_header() {
        // Type=3 (blob), size=200
        // First byte: type=3, low 4 bits of size = 200 & 0xf = 8, continuation=1
        // -> (3 << 4) | 8 | 0x80 = 0xB8
        // Second byte: (200 >> 4) & 0x7f = 12, no continuation -> 0x0C
        let data = [0xB8, 0x0C];
        let (type_bits, size, offset) = read_object_header(&data, 0).unwrap();
        assert_eq!(type_bits, 3);
        assert_eq!(size, 200);
        assert_eq!(offset, 2);
    }

    #[test]
    fn read_large_size_header() {
        // Type=1 (commit), size=0x1234 = 4660
        // low 4: 0x4, shift=4
        // next 7 bits: (0x1234 >> 4) & 0x7f = 0x123 & 0x7f = 0x23, shift=11
        // next 7 bits: (0x1234 >> 11) & 0x7f = 0x2, no more
        let mut buf = Vec::new();
        let type_bits = 1u8;
        let size: usize = 0x1234;
        encode_object_header(&mut buf, type_bits, size);

        let (parsed_type, parsed_size, _) = read_object_header(&buf, 0).unwrap();
        assert_eq!(parsed_type, type_bits);
        assert_eq!(parsed_size, size);
    }

    #[test]
    fn read_header_rejects_overlong_size_varint() {
        // Continuation bit set on every byte — the shift would exceed the
        // bit width. Must error, not panic.
        let data = [
            0xB8u8, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF, 0xFF,
        ];
        assert!(read_object_header(&data, 0).is_err());
    }

    #[test]
    fn read_header_rejects_oversized_object() {
        // Declared size just above MAX_GIT_OBJECT_SIZE.
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 3, crate::MAX_GIT_OBJECT_SIZE + 1);
        assert!(read_object_header(&buf, 0).is_err());

        // The limit itself is accepted.
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 3, crate::MAX_GIT_OBJECT_SIZE);
        let (_, size, _) = read_object_header(&buf, 0).unwrap();
        assert_eq!(size, crate::MAX_GIT_OBJECT_SIZE);
    }

    // --- OFS_DELTA offset tests ---

    #[test]
    fn read_ofs_single_byte() {
        // Single byte, no continuation: value = 42
        let data = [42u8];
        let (val, pos) = read_ofs_delta_offset(&data, 0).unwrap();
        assert_eq!(val, 42);
        assert_eq!(pos, 1);
    }

    #[test]
    fn read_ofs_multi_byte() {
        // Two bytes: first = 0x80 | 1 = 0x81, second = 0x02
        // value = ((1 + 1) << 7) | 2 = (2 << 7) | 2 = 258
        let data = [0x81, 0x02];
        let (val, pos) = read_ofs_delta_offset(&data, 0).unwrap();
        assert_eq!(val, 258);
        assert_eq!(pos, 2);
    }

    #[test]
    fn read_ofs_rejects_overlong_varint() {
        // 12 continuation bytes — no valid pack offset is this long.
        let data = [0xFFu8; 12];
        assert!(read_ofs_delta_offset(&data, 0).is_err());
    }

    // --- Zlib decompression tests ---

    #[test]
    fn decompress_simple() {
        let original = b"hello world, this is a test of zlib decompression";
        let compressed = zlib_compress(original);
        let (result, consumed) = decompress_object(&compressed, 0, original.len()).unwrap();
        assert_eq!(result, original);
        assert_eq!(consumed, compressed.len());
    }

    #[test]
    fn decompress_empty() {
        let compressed = zlib_compress(b"");
        let (result, _) = decompress_object(&compressed, 0, 0).unwrap();
        assert!(result.is_empty());
    }

    #[test]
    fn decompress_rejects_stream_longer_than_declared() {
        // Compress 11 bytes but declare only 5. Accepting the truncated
        // output would leave the pack offset pointing mid-stream.
        let compressed = zlib_compress(b"hello world");
        assert!(decompress_object(&compressed, 0, 5).is_err());
    }

    // --- Full packfile tests ---

    #[test]
    fn parse_single_blob() {
        let blob_data = b"hello world";
        let pack = build_packfile(&[(3, blob_data)]);
        let objects = parse_packfile(&pack).unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].obj_type, GitObjectType::Blob);
        assert_eq!(objects[0].data, blob_data);
        let expected_sha = git_sha1(GitObjectType::Blob, blob_data);
        assert_eq!(objects[0].sha, expected_sha);
    }

    #[test]
    fn parse_empty_blob() {
        let pack = build_packfile(&[(3, b"")]);
        let objects = parse_packfile(&pack).unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].obj_type, GitObjectType::Blob);
        assert!(objects[0].data.is_empty());
        assert_eq!(objects[0].sha, crate::objects::EMPTY_BLOB_SHA1);
    }

    #[test]
    fn parse_multiple_objects() {
        let pack = build_packfile(&[
            (3, b"blob one" as &[u8]),
            (3, b"blob two"),
            (1, b"tree 0000000000000000000000000000000000000000\nauthor Test <test@example.com> 0 +0000\ncommitter Test <test@example.com> 0 +0000\n\ntest commit\n"),
        ]);
        let objects = parse_packfile(&pack).unwrap();
        assert_eq!(objects.len(), 3);
        assert_eq!(objects[0].obj_type, GitObjectType::Blob);
        assert_eq!(objects[1].obj_type, GitObjectType::Blob);
        assert_eq!(objects[2].obj_type, GitObjectType::Commit);
    }

    #[test]
    fn parse_packfile_with_ofs_delta() {
        // Manually build a packfile with a base blob and an OFS_DELTA
        let base_data = b"hello world";
        let base_compressed = zlib_compress(base_data);

        // Delta: base_size=11, result_size=6, copy 5 from offset 0 + insert "!"
        let mut delta_instructions = Vec::new();
        // base_size varint = 11
        delta_instructions.push(11u8);
        // result_size varint = 6
        delta_instructions.push(6u8);
        // copy 5 from offset 0: cmd = 0x91, offset=0, size=5
        delta_instructions.extend_from_slice(&[0x91, 0x00, 0x05]);
        // insert 1 byte: "!"
        delta_instructions.push(1);
        delta_instructions.push(b'!');

        let delta_compressed = zlib_compress(&delta_instructions);

        let mut pack = Vec::new();
        // Header
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&2u32.to_be_bytes()); // 2 objects

        // Base blob object at offset 12
        let base_offset = pack.len();
        encode_object_header(&mut pack, 3, base_data.len()); // type=3 (blob)
        pack.extend_from_slice(&base_compressed);

        // OFS_DELTA object
        let delta_offset = pack.len();
        let neg_offset = delta_offset - base_offset;
        encode_object_header(&mut pack, 6, delta_instructions.len()); // type=6 (ofs_delta)
        // Encode the negative offset
        encode_ofs_offset(&mut pack, neg_offset);
        pack.extend_from_slice(&delta_compressed);

        // SHA-1 trailer
        let sha = sha1::Sha1::digest(&pack);
        pack.extend_from_slice(&sha);

        let objects = parse_packfile(&pack).unwrap();
        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].data, b"hello world");
        assert_eq!(
            objects[0].sha,
            git_sha1(GitObjectType::Blob, b"hello world")
        );
        assert_eq!(objects[1].data, b"hello!");
        assert_eq!(objects[1].obj_type, GitObjectType::Blob);
        assert_eq!(objects[1].sha, git_sha1(GitObjectType::Blob, b"hello!"));
    }

    /// Encode an OFS_DELTA negative offset.
    fn encode_ofs_offset(buf: &mut Vec<u8>, mut value: usize) {
        // Encode in reverse order, then flip
        let mut bytes = Vec::new();
        bytes.push((value & 0x7f) as u8);
        value >>= 7;
        while value > 0 {
            value -= 1;
            bytes.push(0x80 | (value & 0x7f) as u8);
            value >>= 7;
        }
        bytes.reverse();
        buf.extend_from_slice(&bytes);
    }

    /// Build delta instructions that copy `copy_len` bytes from offset 0 of the
    /// base, then insert `suffix` literally.
    fn build_copy_then_insert_delta(base_len: usize, copy_len: usize, suffix: &[u8]) -> Vec<u8> {
        let result_len = copy_len + suffix.len();
        let mut delta = Vec::new();
        // base_size varint
        encode_delta_varint(&mut delta, base_len);
        // result_size varint
        encode_delta_varint(&mut delta, result_len);
        // copy copy_len from offset 0: cmd = 0x91, offset=0, size=copy_len
        delta.push(0x91);
        delta.push(0x00);
        delta.push(copy_len as u8);
        // insert suffix
        assert!(suffix.len() < 128);
        delta.push(suffix.len() as u8);
        delta.extend_from_slice(suffix);
        delta
    }

    fn encode_delta_varint(buf: &mut Vec<u8>, mut value: usize) {
        loop {
            let mut byte = (value & 0x7f) as u8;
            value >>= 7;
            if value > 0 {
                byte |= 0x80;
            }
            buf.push(byte);
            if value == 0 {
                break;
            }
        }
    }

    /// Helper to build a packfile with raw object entries. Each entry is
    /// already-encoded bytes (header + compressed data) to allow custom delta
    /// construction.
    fn build_packfile_raw(num_objects: u32, entries: &[&[u8]]) -> Vec<u8> {
        let mut pack = Vec::new();
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&num_objects.to_be_bytes());
        for entry in entries {
            pack.extend_from_slice(entry);
        }
        let sha = sha1::Sha1::digest(&pack);
        pack.extend_from_slice(&sha);
        pack
    }

    /// Encode a base blob object (type=3) into raw bytes.
    fn encode_blob_object(data: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 3, data.len());
        buf.extend_from_slice(&zlib_compress(data));
        buf
    }

    /// Encode an OFS_DELTA object (type=6) as raw bytes.
    /// `current_offset` is the byte offset where this object will sit in the pack.
    /// `base_offset` is the byte offset of the base object.
    fn encode_ofs_delta_object(
        current_offset: usize,
        base_offset: usize,
        delta_instructions: &[u8],
    ) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 6, delta_instructions.len());
        encode_ofs_offset(&mut buf, current_offset - base_offset);
        buf.extend_from_slice(&zlib_compress(delta_instructions));
        buf
    }

    /// Encode a REF_DELTA object (type=7) as raw bytes.
    fn encode_ref_delta_object(base_sha: &[u8; 20], delta_instructions: &[u8]) -> Vec<u8> {
        let mut buf = Vec::new();
        encode_object_header(&mut buf, 7, delta_instructions.len());
        buf.extend_from_slice(base_sha);
        buf.extend_from_slice(&zlib_compress(delta_instructions));
        buf
    }

    #[test]
    fn parse_packfile_with_chained_ofs_deltas() {
        // Chain: base("hello world") -> d1("hello!") -> d2("hello!?")
        let base_data = b"hello world";
        let d1_result = b"hello!";
        let d2_result = b"hello!?";

        // d1 delta: copy 5 from base, insert "!"
        let d1_delta = build_copy_then_insert_delta(base_data.len(), 5, b"!");
        // d2 delta: copy all 6 from d1_result, insert "?"
        let d2_delta = build_copy_then_insert_delta(d1_result.len(), 6, b"?");

        // Build pack manually to track offsets
        let header_len = 12;
        let base_entry = encode_blob_object(base_data);
        let d1_offset = header_len + base_entry.len();
        let d1_entry = encode_ofs_delta_object(d1_offset, header_len, &d1_delta);
        let d2_offset = d1_offset + d1_entry.len();
        let d2_entry = encode_ofs_delta_object(d2_offset, d1_offset, &d2_delta);

        let pack = build_packfile_raw(3, &[&base_entry, &d1_entry, &d2_entry]);
        let objects = parse_packfile(&pack).unwrap();

        assert_eq!(objects.len(), 3);
        assert_eq!(objects[0].data, base_data);
        assert_eq!(objects[1].data, d1_result.as_slice());
        assert_eq!(objects[1].obj_type, GitObjectType::Blob);
        assert_eq!(objects[2].data, d2_result.as_slice());
        assert_eq!(objects[2].obj_type, GitObjectType::Blob);
        assert_eq!(objects[2].sha, git_sha1(GitObjectType::Blob, d2_result));
    }

    #[test]
    fn parse_packfile_with_ref_delta() {
        // Base blob + REF_DELTA referencing it by SHA-1
        let base_data = b"hello world";
        let base_sha = git_sha1(GitObjectType::Blob, base_data);
        let expected = b"hello!";

        let delta = build_copy_then_insert_delta(base_data.len(), 5, b"!");

        let base_entry = encode_blob_object(base_data);
        let ref_delta_entry = encode_ref_delta_object(&base_sha, &delta);

        let pack = build_packfile_raw(2, &[&base_entry, &ref_delta_entry]);
        let objects = parse_packfile(&pack).unwrap();

        assert_eq!(objects.len(), 2);
        assert_eq!(objects[0].data, base_data);
        assert_eq!(objects[1].data, expected.as_slice());
        assert_eq!(objects[1].obj_type, GitObjectType::Blob);
        assert_eq!(objects[1].sha, git_sha1(GitObjectType::Blob, expected));
    }

    #[test]
    fn parse_packfile_with_multiple_deltas_same_base() {
        // One base, four independent OFS_DELTAs — fan-out pattern
        let base_data = b"hello world";

        let suffixes: [&[u8]; 4] = [b"!", b"?", b".", b"~"];
        let deltas: Vec<Vec<u8>> = suffixes
            .iter()
            .map(|s| build_copy_then_insert_delta(base_data.len(), 5, s))
            .collect();

        let header_len = 12;
        let base_entry = encode_blob_object(base_data);
        let base_offset = header_len;

        let mut entries: Vec<Vec<u8>> = vec![base_entry.clone()];
        let mut offset = base_offset + base_entry.len();
        for d in &deltas {
            let entry = encode_ofs_delta_object(offset, base_offset, d);
            offset += entry.len();
            entries.push(entry);
        }

        let entry_refs: Vec<&[u8]> = entries.iter().map(|e| e.as_slice()).collect();
        let pack = build_packfile_raw(5, &entry_refs);
        let objects = parse_packfile(&pack).unwrap();

        assert_eq!(objects.len(), 5);
        assert_eq!(objects[0].data, base_data);
        for (i, suffix) in suffixes.iter().enumerate() {
            let mut expected = b"hello".to_vec();
            expected.extend_from_slice(suffix);
            assert_eq!(objects[i + 1].data, expected, "delta {i} mismatch");
            assert_eq!(objects[i + 1].obj_type, GitObjectType::Blob);
        }
    }

    #[test]
    fn parse_packfile_with_deep_delta_chain() {
        // 10-level OFS_DELTA chain: each level appends one byte
        let base_data = b"A".to_vec();
        let depth = 10;

        let header_len = 12;
        let base_entry = encode_blob_object(&base_data);

        let mut entries: Vec<Vec<u8>> = vec![base_entry.clone()];
        let mut offsets = vec![header_len];
        let mut offset = header_len + base_entry.len();

        let mut prev_data = base_data.clone();
        for level in 0..depth {
            let suffix = [(b'B' + level as u8)];
            let delta = build_copy_then_insert_delta(prev_data.len(), prev_data.len(), &suffix);
            let entry = encode_ofs_delta_object(offset, offsets[level], &delta);
            offsets.push(offset);
            offset += entry.len();
            entries.push(entry);
            prev_data.push(suffix[0]);
        }

        let entry_refs: Vec<&[u8]> = entries.iter().map(|e| e.as_slice()).collect();
        let pack = build_packfile_raw((depth + 1) as u32, &entry_refs);
        let objects = parse_packfile(&pack).unwrap();

        assert_eq!(objects.len(), depth + 1);
        // Final object should be "ABCDEFGHIJK"
        let expected: Vec<u8> = (0..=depth).map(|i| b'A' + i as u8).collect();
        assert_eq!(objects[depth].data, expected);
        assert_eq!(objects[depth].sha, git_sha1(GitObjectType::Blob, &expected));
    }

    #[test]
    fn parse_packfile_with_mixed_delta_types() {
        // Pack with OFS_DELTA and REF_DELTA in the same packfile:
        // - base blob "hello world"
        // - ofs_delta against base -> "hello!"
        // - ref_delta against base (by SHA-1) -> "hello?"
        let base_data = b"hello world";
        let base_sha = git_sha1(GitObjectType::Blob, base_data);

        let ofs_delta = build_copy_then_insert_delta(base_data.len(), 5, b"!");
        let ref_delta = build_copy_then_insert_delta(base_data.len(), 5, b"?");

        let header_len = 12;
        let base_entry = encode_blob_object(base_data);
        let ofs_offset = header_len + base_entry.len();
        let ofs_entry = encode_ofs_delta_object(ofs_offset, header_len, &ofs_delta);
        let ref_entry = encode_ref_delta_object(&base_sha, &ref_delta);

        let pack = build_packfile_raw(3, &[&base_entry, &ofs_entry, &ref_entry]);
        let objects = parse_packfile(&pack).unwrap();

        assert_eq!(objects.len(), 3);
        assert_eq!(objects[0].data, base_data);
        assert_eq!(objects[1].data, b"hello!");
        assert_eq!(objects[1].obj_type, GitObjectType::Blob);
        assert_eq!(objects[2].data, b"hello?");
        assert_eq!(objects[2].obj_type, GitObjectType::Blob);
    }

    #[test]
    fn parse_empty_packfile() {
        let pack = build_packfile(&[]);
        let objects = parse_packfile(&pack).unwrap();
        assert!(objects.is_empty());
    }

    #[test]
    fn parse_packfile_stress_fan_out() {
        // 64 independent OFS_DELTAs from the same base — exercises rayon thread pool
        let base_data = vec![0u8; 64];
        let count = 64usize;

        let header_len = 12;
        let base_entry = encode_blob_object(&base_data);
        let base_offset = header_len;

        let mut entries: Vec<Vec<u8>> = vec![base_entry.clone()];
        let mut offset = base_offset + base_entry.len();

        for i in 0..count {
            let suffix = [i as u8];
            let delta = build_copy_then_insert_delta(base_data.len(), base_data.len(), &suffix);
            let entry = encode_ofs_delta_object(offset, base_offset, &delta);
            offset += entry.len();
            entries.push(entry);
        }

        let entry_refs: Vec<&[u8]> = entries.iter().map(|e| e.as_slice()).collect();
        let pack = build_packfile_raw((count + 1) as u32, &entry_refs);
        let objects = parse_packfile(&pack).unwrap();

        assert_eq!(objects.len(), count + 1);
        for i in 0..count {
            let mut expected = base_data.clone();
            expected.push(i as u8);
            assert_eq!(objects[i + 1].data, expected, "delta {i} mismatch");
            assert_eq!(objects[i + 1].obj_type, GitObjectType::Blob);
        }
    }

    #[test]
    fn parse_packfile_with_invalid_delta_in_batch() {
        // One valid delta + one malformed delta in the same batch.
        // The malformed delta has a copy instruction that reads out of bounds.
        let base_data = b"hello world";

        let valid_delta = build_copy_then_insert_delta(base_data.len(), 5, b"!");

        // Malformed: claims base_size=11 but copies from offset 100 (out of bounds)
        let mut bad_delta = Vec::new();
        encode_delta_varint(&mut bad_delta, base_data.len());
        encode_delta_varint(&mut bad_delta, 5);
        // copy 5 from offset 100: cmd=0x91, offset=100, size=5
        bad_delta.extend_from_slice(&[0x91, 100, 5]);

        let header_len = 12;
        let base_entry = encode_blob_object(base_data);
        let base_offset = header_len;
        let d1_offset = base_offset + base_entry.len();
        let d1_entry = encode_ofs_delta_object(d1_offset, base_offset, &valid_delta);
        let d2_offset = d1_offset + d1_entry.len();
        let d2_entry = encode_ofs_delta_object(d2_offset, base_offset, &bad_delta);

        let pack = build_packfile_raw(3, &[&base_entry, &d1_entry, &d2_entry]);
        assert!(parse_packfile(&pack).is_err());
    }

    #[test]
    fn reject_corrupt_trailer() {
        let mut pack = build_packfile(&[(3, b"hello world")]);
        let last = pack.len() - 1;
        pack[last] ^= 0xFF;
        let err = parse_packfile(&pack).unwrap_err();
        assert!(format!("{err}").contains("checksum mismatch"), "{err}");
    }

    #[test]
    fn reject_corrupt_object_body() {
        // Flip a bit inside the first object's compressed data. Either zlib
        // or the trailer check must reject it.
        let mut pack = build_packfile(&[(3, b"hello world")]);
        pack[14] ^= 0x01;
        assert!(parse_packfile(&pack).is_err());
    }

    #[test]
    fn reject_truncated_trailer() {
        let mut pack = build_packfile(&[(3, b"hello world")]);
        pack.truncate(pack.len() - 5);
        assert!(parse_packfile(&pack).is_err());
    }

    #[test]
    fn reject_trailing_junk() {
        let mut pack = build_packfile(&[(3, b"hello world")]);
        pack.extend_from_slice(b"junk");
        let err = parse_packfile(&pack).unwrap_err();
        assert!(format!("{err}").contains("trailing data"), "{err}");
    }

    #[test]
    fn reject_invalid_packfile_magic() {
        let mut data = Vec::new();
        data.extend_from_slice(b"NOTPACK");
        data.extend_from_slice(&2u32.to_be_bytes());
        data.extend_from_slice(&0u32.to_be_bytes());
        assert!(parse_packfile(&data).is_err());
    }

    // --- Streaming packfile tests ---

    use crate::pktline::test_util::ChunkedReader;

    #[tokio::test]
    async fn stream_single_blob() {
        let blob_data = b"hello world";
        let pack = build_packfile(&[(3, blob_data)]);
        let objects = parse_packfile_stream(std::io::Cursor::new(pack))
            .await
            .unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].obj_type, GitObjectType::Blob);
        assert_eq!(objects[0].data, blob_data);
        let expected_sha = git_sha1(GitObjectType::Blob, blob_data);
        assert_eq!(objects[0].sha, expected_sha);
    }

    #[tokio::test]
    async fn stream_empty_blob() {
        let pack = build_packfile(&[(3, b"")]);
        let objects = parse_packfile_stream(std::io::Cursor::new(pack))
            .await
            .unwrap();
        assert_eq!(objects.len(), 1);
        assert!(objects[0].data.is_empty());
    }

    #[tokio::test]
    async fn stream_multiple_objects() {
        let pack = build_packfile(&[
            (3, b"blob one" as &[u8]),
            (3, b"blob two"),
            (1, b"tree 0000000000000000000000000000000000000000\nauthor T <t@t> 0 +0000\ncommitter T <t@t> 0 +0000\n\nc\n"),
        ]);
        let objects = parse_packfile_stream(std::io::Cursor::new(pack))
            .await
            .unwrap();
        assert_eq!(objects.len(), 3);
        assert_eq!(objects[0].obj_type, GitObjectType::Blob);
        assert_eq!(objects[1].obj_type, GitObjectType::Blob);
        assert_eq!(objects[2].obj_type, GitObjectType::Commit);
    }

    #[tokio::test]
    async fn stream_empty_packfile() {
        let pack = build_packfile(&[]);
        let objects = parse_packfile_stream(std::io::Cursor::new(pack))
            .await
            .unwrap();
        assert!(objects.is_empty());
    }

    #[tokio::test]
    async fn stream_matches_batch() {
        // Build a packfile with various objects and verify streaming matches batch.
        let pack = build_packfile(&[
            (3, b"file content A" as &[u8]),
            (3, b"file content B"),
            (
                3,
                b"a longer blob with more data to exercise decompression paths",
            ),
        ]);

        let batch = parse_packfile(&pack).unwrap();
        let streaming = parse_packfile_stream(std::io::Cursor::new(pack.clone()))
            .await
            .unwrap();

        assert_eq!(batch.len(), streaming.len());
        for (b, s) in batch.iter().zip(streaming.iter()) {
            assert_eq!(b.obj_type, s.obj_type);
            assert_eq!(b.data, s.data);
            assert_eq!(b.sha, s.sha);
        }
    }

    #[tokio::test]
    async fn stream_chunked_delivery() {
        let blob_data = b"chunked test data with enough content to span chunks";
        let pack = build_packfile(&[(3, blob_data as &[u8])]);
        let objects = parse_packfile_stream(ChunkedReader::new(pack, 7))
            .await
            .unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].data, blob_data);
    }

    #[tokio::test]
    async fn stream_with_ofs_delta() {
        // Reuse the batch OFS_DELTA test's packfile.
        let base_data = b"hello world";
        let base_compressed = zlib_compress(base_data);

        let mut delta_instructions = Vec::new();
        delta_instructions.push(11u8); // base_size
        delta_instructions.push(6u8); // result_size
        delta_instructions.extend_from_slice(&[0x91, 0x00, 0x05]); // copy 5 from 0
        delta_instructions.push(1); // insert 1
        delta_instructions.push(b'!');
        let delta_compressed = zlib_compress(&delta_instructions);

        let mut pack = Vec::new();
        pack.extend_from_slice(b"PACK");
        pack.extend_from_slice(&2u32.to_be_bytes());
        pack.extend_from_slice(&2u32.to_be_bytes());

        let base_offset = pack.len();
        encode_object_header(&mut pack, 3, base_data.len());
        pack.extend_from_slice(&base_compressed);

        let delta_offset = pack.len();
        encode_object_header(&mut pack, 6, delta_instructions.len());
        let neg = delta_offset - base_offset;
        encode_ofs_delta_offset(&mut pack, neg);
        pack.extend_from_slice(&delta_compressed);

        let sha = Sha1::digest(&pack);
        pack.extend_from_slice(&sha);

        let batch = parse_packfile(&pack).unwrap();
        let streaming = parse_packfile_stream(std::io::Cursor::new(pack.clone()))
            .await
            .unwrap();

        assert_eq!(batch.len(), streaming.len());
        for (b, s) in batch.iter().zip(streaming.iter()) {
            assert_eq!(b.obj_type, s.obj_type);
            assert_eq!(b.data, s.data);
            assert_eq!(b.sha, s.sha);
        }

        // Verify the delta was resolved to "hello!"
        assert_eq!(streaming[1].data, b"hello!");
    }

    #[tokio::test]
    async fn stream_rejects_corrupt_trailer() {
        let mut pack = build_packfile(&[(3, b"hello world")]);
        let last = pack.len() - 1;
        pack[last] ^= 0xFF;
        let err = parse_packfile_stream(std::io::Cursor::new(pack))
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("checksum mismatch"), "{err}");
    }

    #[tokio::test]
    async fn stream_rejects_truncated_trailer() {
        let mut pack = build_packfile(&[(3, b"hello world")]);
        pack.truncate(pack.len() - 5);
        assert!(
            parse_packfile_stream(std::io::Cursor::new(pack))
                .await
                .is_err()
        );
    }

    #[tokio::test]
    async fn stream_rejects_trailing_data_after_trailer() {
        // The batch parser rejects junk after the trailer; the streaming
        // parser must agree.
        let mut pack = build_packfile(&[(3, b"hello world")]);
        pack.extend_from_slice(b"junk");
        let err = parse_packfile_stream(std::io::Cursor::new(pack))
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("trailing data"), "{err}");
    }

    #[tokio::test]
    async fn stream_rejects_trailing_data_chunked() {
        // Trailing junk that arrives in a later read must also be caught.
        let mut pack = build_packfile(&[(3, b"hello world")]);
        pack.extend_from_slice(&[0xEE; 64]);
        let err = parse_packfile_stream(ChunkedReader::new(pack, 7))
            .await
            .unwrap_err();
        assert!(format!("{err}").contains("trailing data"), "{err}");
    }

    #[tokio::test]
    async fn stream_large_object() {
        // Object larger than the 8KB read buffer to exercise multi-pass decompression.
        let large_data = vec![0x42u8; 100_000];
        let pack = build_packfile(&[(3, &large_data)]);
        let objects = parse_packfile_stream(ChunkedReader::new(pack, 4096))
            .await
            .unwrap();
        assert_eq!(objects.len(), 1);
        assert_eq!(objects[0].data, large_data);
    }

    fn encode_ofs_delta_offset(buf: &mut Vec<u8>, mut value: usize) {
        // Encode in reverse since we need MSB-first with continuation bits.
        let mut bytes = Vec::new();
        bytes.push((value & 0x7f) as u8);
        value >>= 7;
        while value > 0 {
            value -= 1;
            bytes.push(0x80 | (value & 0x7f) as u8);
            value >>= 7;
        }
        bytes.reverse();
        buf.extend_from_slice(&bytes);
    }
}
