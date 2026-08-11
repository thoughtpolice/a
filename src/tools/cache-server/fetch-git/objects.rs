// SPDX-FileCopyrightText: © 2026 Austin Seipp
// SPDX-License-Identifier: Apache-2.0

//! Git object types and SHA-1 hashing.
//!
//! # Object identity
//!
//! Every Git object is identified by the SHA-1 hash of its "loose" encoding:
//!
//! ```text
//! SHA-1( "{type} {size_in_bytes}\0{data}" )
//! ```
//!
//! For example, the empty blob is `SHA-1("blob 0\0")` =
//! `e69de29bb2d1d6434b8b29ae775ad8c2e48c5391`.
//!
//! [`git_sha1`] computes this hash for any resolved (non-delta) object.
//!
//! # Object types
//!
//! Git has four base object types, plus two delta encodings used inside
//! packfiles:
//!
//! | Type      | Value | Description |
//! |-----------|-------|-------------|
//! | Commit    | 1     | Points to a tree + parent commits, carries author/message |
//! | Tree      | 2     | Directory listing: maps names to blob/tree/symlink SHAs |
//! | Blob      | 3     | Raw file content (opaque bytes) |
//! | Tag       | 4     | Annotated tag pointing to another object |
//! | OFS_DELTA | 6     | Delta encoded against an object at a packfile byte offset |
//! | REF_DELTA | 7     | Delta encoded against an object identified by SHA-1 |
//!
//! Delta types only appear inside packfiles and must be resolved against their
//! base object before a SHA-1 can be computed. See [`crate::delta`] and
//! [`crate::packfile`] for the resolution logic.

use sha1::{Digest as _, Sha1};

use crate::GitFetchError;

// ---------------------------------------------------------------------------------------------------------------
// Object types
// ---------------------------------------------------------------------------------------------------------------

/// Git object types as encoded in packfile headers.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
#[repr(u8)]
pub enum GitObjectType {
    Commit = 1,
    Tree = 2,
    Blob = 3,
    Tag = 4,
    OfsDelta = 6,
    RefDelta = 7,
}

impl GitObjectType {
    /// Parse a 3-bit type field from a packfile object header.
    pub fn from_type_bits(bits: u8) -> Result<Self, GitFetchError> {
        match bits {
            1 => Ok(Self::Commit),
            2 => Ok(Self::Tree),
            3 => Ok(Self::Blob),
            4 => Ok(Self::Tag),
            6 => Ok(Self::OfsDelta),
            7 => Ok(Self::RefDelta),
            _ => Err(GitFetchError::InvalidPackfile(format!(
                "unknown object type: {bits}"
            ))),
        }
    }

    /// The Git type name string used in loose object headers.
    pub fn type_name(&self) -> &'static str {
        match self {
            Self::Commit => "commit",
            Self::Tree => "tree",
            Self::Blob => "blob",
            Self::Tag => "tag",
            Self::OfsDelta | Self::RefDelta => {
                panic!("delta objects do not have a type name")
            }
        }
    }

    /// Returns true if this is a delta type.
    pub fn is_delta(&self) -> bool {
        matches!(self, Self::OfsDelta | Self::RefDelta)
    }
}

// ---------------------------------------------------------------------------------------------------------------
// SHA-1 hashing
// ---------------------------------------------------------------------------------------------------------------

/// The SHA-1 hash of the empty blob (`blob 0\0`).
pub const EMPTY_BLOB_SHA1: [u8; 20] = [
    0xe6, 0x9d, 0xe2, 0x9b, 0xb2, 0xd1, 0xd6, 0x43, 0x4b, 0x8b, 0x29, 0xae, 0x77, 0x5a, 0xd8, 0xc2,
    0xe4, 0x8c, 0x53, 0x91,
];

/// Compute the Git SHA-1 hash for an object: `SHA-1("{type} {size}\0{data}")`.
///
/// Called once per object while indexing packs (millions of times for large
/// repositories), so the loose-object header is formatted into a stack
/// buffer instead of allocating a `String` per call.
pub fn git_sha1(obj_type: GitObjectType, data: &[u8]) -> [u8; 20] {
    use std::io::Write as _;

    // Longest header: "commit " + 20 digits (u64 max) + NUL = 28 bytes.
    let mut header = [0u8; 32];
    let mut cursor = std::io::Cursor::new(&mut header[..]);
    write!(cursor, "{} {}\0", obj_type.type_name(), data.len()).expect("header fits in buffer");
    let len = cursor.position() as usize;

    let mut hasher = Sha1::new();
    hasher.update(&header[..len]);
    hasher.update(data);
    hasher.finalize().into()
}

/// Parse a 40-character hex SHA-1 string into 20 bytes.
pub fn parse_sha1_hex(hex_str: &str) -> Result<[u8; 20], GitFetchError> {
    if hex_str.len() != 40 {
        return Err(GitFetchError::InvalidPackfile(format!(
            "expected 40-char hex SHA-1, got {} chars",
            hex_str.len()
        )));
    }
    let bytes = hex::decode(hex_str)
        .map_err(|e| GitFetchError::InvalidPackfile(format!("invalid hex in SHA-1: {e}")))?;
    let mut sha = [0u8; 20];
    sha.copy_from_slice(&bytes);
    Ok(sha)
}

// ---------------------------------------------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------------------------------------------

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn empty_blob_hash() {
        let hash = git_sha1(GitObjectType::Blob, b"");
        assert_eq!(hash, EMPTY_BLOB_SHA1);
        assert_eq!(
            hex::encode(hash),
            "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391"
        );
    }

    #[test]
    fn hello_blob_hash() {
        // `printf 'hello' | git hash-object --stdin` = b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0
        let hash = git_sha1(GitObjectType::Blob, b"hello");
        assert_eq!(
            hex::encode(hash),
            "b6fc4c620b67d95f953a5c1c1230aaab5db5a1b0"
        );
    }

    #[test]
    fn hello_world_lf_blob_hash() {
        // `echo "hello world" | git hash-object --stdin` = 3b18e512dba79e4c8300dd08aeb37f8e728b8dad
        let hash = git_sha1(GitObjectType::Blob, b"hello world\n");
        assert_eq!(
            hex::encode(hash),
            "3b18e512dba79e4c8300dd08aeb37f8e728b8dad"
        );
    }

    #[test]
    fn git_sha1_matches_string_header() {
        // The stack-buffer header must hash identically to the naive
        // string-formatted header, including multi-digit sizes.
        for size in [0usize, 9, 10, 999, 1_234_567] {
            let data = vec![0x5A; size];
            let expected: [u8; 20] = {
                let mut h = Sha1::new();
                h.update(format!("blob {size}\0").as_bytes());
                h.update(&data);
                h.finalize().into()
            };
            assert_eq!(
                git_sha1(GitObjectType::Blob, &data),
                expected,
                "size {size}"
            );
        }
    }

    #[test]
    fn commit_type_name() {
        assert_eq!(GitObjectType::Commit.type_name(), "commit");
        assert_eq!(GitObjectType::Tree.type_name(), "tree");
        assert_eq!(GitObjectType::Blob.type_name(), "blob");
        assert_eq!(GitObjectType::Tag.type_name(), "tag");
    }

    #[test]
    fn type_from_bits() {
        assert_eq!(
            GitObjectType::from_type_bits(1).unwrap(),
            GitObjectType::Commit
        );
        assert_eq!(
            GitObjectType::from_type_bits(3).unwrap(),
            GitObjectType::Blob
        );
        assert_eq!(
            GitObjectType::from_type_bits(6).unwrap(),
            GitObjectType::OfsDelta
        );
        assert!(GitObjectType::from_type_bits(0).is_err());
        assert!(GitObjectType::from_type_bits(5).is_err());
    }

    #[test]
    fn is_delta() {
        assert!(!GitObjectType::Commit.is_delta());
        assert!(!GitObjectType::Blob.is_delta());
        assert!(GitObjectType::OfsDelta.is_delta());
        assert!(GitObjectType::RefDelta.is_delta());
    }

    #[test]
    fn parse_sha1_hex_valid() {
        let hex_str = "e69de29bb2d1d6434b8b29ae775ad8c2e48c5391";
        let sha = parse_sha1_hex(hex_str).unwrap();
        assert_eq!(sha, EMPTY_BLOB_SHA1);
    }

    #[test]
    fn parse_sha1_hex_wrong_length() {
        assert!(parse_sha1_hex("abcdef").is_err());
    }

    #[test]
    fn parse_sha1_hex_invalid_chars() {
        let bad = "zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz";
        assert!(parse_sha1_hex(bad).is_err());
    }
}
