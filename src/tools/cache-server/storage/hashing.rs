// SPDX-FileCopyrightText: © 2024-2026 Austin Seipp
// SPDX-License-Identifier: MIT OR Apache-2.0

//! Digest functions, content digests, and SHA256TREE implementation.

use std::fmt;
use std::str::FromStr;

use anyhow::Context as _;
use sha2::digest::generic_array::GenericArray;
use sha2::{Digest as _, Sha256};

// SHA256TREE: data at or below this size uses plain SHA-256
pub(crate) const SHA256TREE_LEAF_SIZE: usize = 1024;

// SHA256TREE custom IV for the combining step (per REAPI spec)
pub(crate) const SHA256TREE_IV: [u32; 8] = [
    0xcbbb9d5d, 0x629a292a, 0x9159015a, 0x152fecd8, 0x67332667, 0x8eb44a87, 0xdb0c2e0d, 0x47b5481d,
];

/// Digest function identifier for multi-hash support.
///
/// The `repr(u8)` values are internal storage discriminator bytes, not proto
/// enum values. Use `from_proto_i32` / `to_proto_i32` for proto conversion.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum DigestFn {
    Sha256 = 0,
    Blake3 = 1,
    Sha256Tree = 2,
}

impl DigestFn {
    /// Hash `data` using this digest function, returning a 32-byte digest.
    pub fn hash_data(&self, data: &[u8]) -> [u8; 32] {
        match self {
            DigestFn::Sha256 => Sha256::digest(data).into(),
            DigestFn::Blake3 => *blake3::hash(data).as_bytes(),
            DigestFn::Sha256Tree => sha256tree_hash(data),
        }
    }

    /// Convert from a proto `DigestFunction.Value` i32.
    ///
    /// Proto values: 1 = SHA256, 8 = SHA256TREE, 9 = BLAKE3.
    /// Returns `None` for unsupported values.
    pub fn from_proto_i32(v: i32) -> Option<Self> {
        match v {
            1 => Some(DigestFn::Sha256),
            8 => Some(DigestFn::Sha256Tree),
            9 => Some(DigestFn::Blake3),
            _ => None,
        }
    }

    /// Convert to the proto `DigestFunction.Value` i32.
    pub fn to_proto_i32(&self) -> i32 {
        match self {
            DigestFn::Sha256 => 1,
            DigestFn::Blake3 => 9,
            DigestFn::Sha256Tree => 8,
        }
    }

    /// Short lowercase name for use in ByteStream resource names.
    pub fn as_str(&self) -> &'static str {
        match self {
            DigestFn::Sha256 => "sha256",
            DigestFn::Blake3 => "blake3",
            DigestFn::Sha256Tree => "sha256tree",
        }
    }

    /// Parse from a string name (case-insensitive).
    pub fn from_str_name(s: &str) -> Option<Self> {
        match s.to_ascii_lowercase().as_str() {
            "sha256" => Some(DigestFn::Sha256),
            "blake3" => Some(DigestFn::Blake3),
            "sha256tree" => Some(DigestFn::Sha256Tree),
            _ => None,
        }
    }
}

impl fmt::Display for DigestFn {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(self.as_str())
    }
}

impl FromStr for DigestFn {
    type Err = anyhow::Error;

    fn from_str(s: &str) -> anyhow::Result<Self> {
        Self::from_str_name(s).context(format!("unknown digest function: {}", s))
    }
}

/// A typed digest that bundles a hash function with its 32-byte hash value.
///
/// This prevents misuse where a hash computed with one function (e.g. SHA-256)
/// is accidentally passed alongside a different function identifier (e.g. Blake3).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub struct ContentDigest {
    pub function: DigestFn,
    pub hash: [u8; 32],
}

impl ContentDigest {
    /// Create a new digest from a function and pre-computed hash.
    pub fn new(function: DigestFn, hash: [u8; 32]) -> Self {
        Self { function, hash }
    }

    /// Compute the digest of `data` using the given function.
    pub fn compute(function: DigestFn, data: &[u8]) -> Self {
        Self {
            function,
            hash: function.hash_data(data),
        }
    }

    /// Parse from `"function:hex"` format (e.g. `"sha256:e3b0c4..."`).
    pub fn parse(s: &str) -> Option<Self> {
        let (fn_str, hex_str) = s.split_once(':')?;
        let function = DigestFn::from_str_name(fn_str)?;
        let hash = parse_digest_hash(hex_str)?;
        Some(Self { function, hash })
    }
}

impl fmt::Display for ContentDigest {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "{}:{}", self.function, hex::encode(self.hash))
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// SHA256TREE implementation
// ---------------------------------------------------------------------------------------------------------------------

/// Raw SHA-256 block cipher: process one 64-byte block with state `h`.
/// Returns the new state without Davies-Meyer feedforward.
///
/// Uses `sha2::compress256` (which leverages SHA-NI/NEON when available)
/// and subtracts the IV to undo the Davies-Meyer feedforward that
/// `compress256` applies internally.
pub(crate) fn sha256_block_cipher(h: &[u32; 8], block: &[u8; 64]) -> [u32; 8] {
    let mut state = *h;
    let ga = *GenericArray::from_slice(block);
    sha2::compress256(&mut state, core::slice::from_ref(&ga));
    // Undo Davies-Meyer feedforward: compress256 computes state[i] += h[i]
    for i in 0..8 {
        state[i] = state[i].wrapping_sub(h[i]);
    }
    state
}

/// SHA256TREE hash per the REAPI spec.
pub(crate) fn sha256tree_hash(data: &[u8]) -> [u8; 32] {
    if data.len() <= SHA256TREE_LEAF_SIZE {
        Sha256::digest(data).into()
    } else {
        // Split at largest power-of-2 less than data.len()
        let m = 1usize << (usize::BITS - 1 - (data.len() - 1).leading_zeros());
        let left_hash = sha256tree_hash(&data[..m]);
        let right_hash = sha256tree_hash(&data[m..]);

        // Combine: one SHA-256 block cipher invocation with custom IV
        let mut block = [0u8; 64];
        block[..32].copy_from_slice(&left_hash);
        block[32..].copy_from_slice(&right_hash);

        let result = sha256_block_cipher(&SHA256TREE_IV, &block);
        let mut out = [0u8; 32];
        for (i, &word) in result.iter().enumerate() {
            out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
        }
        out
    }
}

// ---------------------------------------------------------------------------------------------------------------------
// Incremental hasher for streaming whole-blob hash computation
// ---------------------------------------------------------------------------------------------------------------------

/// Incremental hasher that avoids concatenating all chunk data just to compute a whole-blob hash.
/// SHA-256 and BLAKE3 support true streaming; SHA256TREE accumulates leaf hashes (one per 1 KiB
/// leaf) instead of the full data, reducing memory from O(blob_size) to O(blob_size / 1024 * 32).
pub(crate) enum IncrementalHasher {
    Sha256(Sha256),
    Blake3(blake3::Hasher),
    Sha256Tree {
        leaf_hashes: Vec<[u8; 32]>,
        partial_leaf: Vec<u8>,
        total_bytes: usize,
    },
}

impl IncrementalHasher {
    pub(crate) fn new(digest_fn: DigestFn, _size_hint: usize) -> Self {
        match digest_fn {
            DigestFn::Sha256 => IncrementalHasher::Sha256(Sha256::new()),
            DigestFn::Blake3 => IncrementalHasher::Blake3(blake3::Hasher::new()),
            DigestFn::Sha256Tree => IncrementalHasher::Sha256Tree {
                leaf_hashes: Vec::new(),
                partial_leaf: Vec::with_capacity(SHA256TREE_LEAF_SIZE),
                total_bytes: 0,
            },
        }
    }

    pub(crate) fn update(&mut self, data: &[u8]) {
        match self {
            IncrementalHasher::Sha256(h) => {
                h.update(data);
            }
            IncrementalHasher::Blake3(h) => {
                h.update(data);
            }
            IncrementalHasher::Sha256Tree {
                leaf_hashes,
                partial_leaf,
                total_bytes,
            } => {
                *total_bytes += data.len();
                let mut remaining = data;
                while !remaining.is_empty() {
                    let space = SHA256TREE_LEAF_SIZE - partial_leaf.len();
                    let take = remaining.len().min(space);
                    partial_leaf.extend_from_slice(&remaining[..take]);
                    remaining = &remaining[take..];
                    if partial_leaf.len() == SHA256TREE_LEAF_SIZE {
                        leaf_hashes.push(Sha256::digest(&partial_leaf).into());
                        partial_leaf.clear();
                    }
                }
            }
        }
    }

    pub(crate) fn finalize(self) -> [u8; 32] {
        match self {
            IncrementalHasher::Sha256(h) => h.finalize().into(),
            IncrementalHasher::Blake3(h) => *h.finalize().as_bytes(),
            IncrementalHasher::Sha256Tree {
                mut leaf_hashes,
                partial_leaf,
                total_bytes,
            } => {
                // Empty blob: return SHA-256 of empty data
                if total_bytes == 0 {
                    return Sha256::digest(&[]).into();
                }
                // Flush any remaining partial leaf
                if !partial_leaf.is_empty() {
                    leaf_hashes.push(Sha256::digest(&partial_leaf).into());
                }
                if total_bytes <= SHA256TREE_LEAF_SIZE {
                    return leaf_hashes[0];
                }
                combine_leaf_hashes(&leaf_hashes, total_bytes)
            }
        }
    }
}

/// Reconstruct the SHA256TREE hash from pre-computed leaf hashes.
///
/// Uses the same power-of-2 splitting logic as `sha256tree_hash`, but operates
/// on the leaf hash array instead of raw bytes. Since `m` (the split point) is
/// always a multiple of `SHA256TREE_LEAF_SIZE` when `total_bytes > SHA256TREE_LEAF_SIZE`,
/// the split always falls on a leaf boundary.
fn combine_leaf_hashes(leaves: &[[u8; 32]], total_bytes: usize) -> [u8; 32] {
    if leaves.len() == 1 {
        return leaves[0];
    }
    let m = 1usize << (usize::BITS - 1 - (total_bytes - 1).leading_zeros());
    let left_leaves = m / SHA256TREE_LEAF_SIZE;
    let left = combine_leaf_hashes(&leaves[..left_leaves], m);
    let right = combine_leaf_hashes(&leaves[left_leaves..], total_bytes - m);

    let mut block = [0u8; 64];
    block[..32].copy_from_slice(&left);
    block[32..].copy_from_slice(&right);
    let result = sha256_block_cipher(&SHA256TREE_IV, &block);
    let mut out = [0u8; 32];
    for (i, &word) in result.iter().enumerate() {
        out[i * 4..i * 4 + 4].copy_from_slice(&word.to_be_bytes());
    }
    out
}

/// Parse a hex-encoded digest hash string into a 32-byte array.
pub fn parse_digest_hash(hex_str: &str) -> Option<[u8; 32]> {
    if hex_str.len() != 64 {
        return None;
    }
    let mut arr = [0u8; 32];
    hex::decode_to_slice(hex_str, &mut arr).ok()?;
    Some(arr)
}
